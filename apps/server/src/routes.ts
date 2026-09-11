import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { verifyMessage, type Hex } from "viem";
import { z } from "zod";
import { manifestHash, type Manifest, type Transcript } from "@bugify/sdk";
import { env } from "./env.ts";
import { account, bazaar, getBounty, getChainId } from "./chain.ts";
import * as sb from "./supabase.ts";
import { lastIndexedBlock } from "./indexer.ts";
import { SessionError, createSessionRunner, type Deps } from "./harness/runSession.ts";
import { VerifyError, verify } from "./verifier.ts";

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const ToolDef = z.object({ name: z.string().min(1), description: z.string(), input_schema: z.record(z.string(), z.unknown()) });
const MockSpec = z.discriminatedUnion("type", [
  z.object({ type: z.literal("static"), result: z.unknown() }),
  z.object({ type: z.literal("identity"), customerEmail: z.string() }),
  z.object({ type: z.literal("refund_ledger") }),
  z.object({ type: z.literal("fixture"), rows: z.record(z.string(), z.unknown()) }),
]);
const Invariant = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool_gate"), label: z.string(), tool: z.string(), requires: z.object({ tool: z.string(), resultMatch: z.record(z.string(), z.unknown()) }) }),
  z.object({ kind: z.literal("tool_sum_cap"), label: z.string(), tool: z.string(), arg: z.string(), max: z.number() }),
  z.object({ kind: z.literal("canary"), label: z.string(), canary: z.string(), normalize: z.enum(["exact", "digits", "alnum"]) }),
  z.object({ kind: z.literal("forbidden_tool"), label: z.string(), tool: z.string() }),
]);
export const ManifestSchema = z.object({
  version: z.literal(1), name: z.string().min(1), model: z.string().min(1), system: z.string(),
  tools: z.array(ToolDef), mocks: z.record(z.string(), MockSpec), invariants: z.array(Invariant).min(1),
  maxTurns: z.number().int().min(1).max(50), buyerPubKey: z.string().optional(),
});
const TranscriptSchema = z.object({ version: z.literal(1), manifestHash: hex32, invariant: z.number().int().min(0), turns: z.array(z.string()).min(1) });

const id = (s: string) => { const n = Number(s); if (!Number.isInteger(n) || n < 0) throw new HTTPException(400, { message: "bad id" }); return n; };
const bad = (e: z.ZodError) => new HTTPException(400, { message: z.prettifyError(e) });

// 60 turns / 10 min per IP, in memory
const rl = new Map<string, number[]>();
function rateLimit(ip: string) {
  const now = Date.now(), win = now - 10 * 60 * 1000;
  const hits = (rl.get(ip) ?? []).filter((t) => t > win);
  if (hits.length >= 60) throw new HTTPException(429, { message: "rate limit: 60 turns / 10 min" });
  hits.push(now); rl.set(ip, hits);
}

export function createApp(deps: Deps) {
  const runner = createSessionRunner(deps);
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof SessionError || err instanceof VerifyError) return c.json({ error: err.message }, err.status as 400);
    console.error("[http]", err);
    return c.json({ error: err.message || "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.get("/health", async (c) => c.json({
    chain: await getChainId().catch(() => null), lastIndexedBlock: lastIndexedBlock()?.toString() ?? null,
    verifier: account.address, bazaar, model: env.TARGET_MODEL,
  }));

  app.post("/manifests", async (c) => {
    const p = ManifestSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) throw bad(p.error);
    const m = p.data as Manifest;
    const hash = manifestHash(m);
    await sb.upsertManifest(hash, m);
    console.log(`[manifests] upserted ${hash} "${m.name}" (${m.invariants.length} invariants)`);
    return c.json({ manifestHash: hash });
  });

  app.get("/bounties", async (c) => c.json(await sb.listPublicBounties()));

  app.get("/bounties/:id", async (c) => {
    const bid = id(c.req.param("id"));
    const bounty = await sb.getBountyRow(bid);
    if (!bounty) throw new HTTPException(404, { message: "bounty not found" });
    const m = await sb.getManifest(bounty.manifest_hash);
    return c.json({ ...bounty, name: m?.name ?? null, model: m?.model ?? null, invariant_labels: m?.invariants.map((i) => i.label) ?? [], commits: await sb.listCommitsForBounty(bid) });
  });

  app.post("/bounties/:id/sessions", async (c) => {
    const bounty = await sb.getBountyRow(id(c.req.param("id")));
    if (!bounty) throw new HTTPException(404, { message: "bounty not found" });
    const m = await sb.getManifest(bounty.manifest_hash);
    if (!m) throw new HTTPException(404, { message: "manifest not found for bounty" });
    const sessionId = runner.open(m);
    console.log(`[session] ${sessionId} opened on bounty #${bounty.id}`);
    return c.json({ sessionId });
  });

  app.post("/sessions/:sid/turn", async (c) => {
    rateLimit(c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local");
    const p = z.object({ text: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
    if (!p.success) throw bad(p.error);
    const r = await runner.turn(c.req.param("sid"), p.data.text);
    console.log(`[session] ${c.req.param("sid").slice(0, 8)} turn · ${r.toolCalls.length} tool calls · violations [${r.violations.join(",")}]`);
    return c.json(r);
  });

  app.post("/commits/:cid/reveal", async (c) => {
    const cid = id(c.req.param("cid"));
    const p = z.object({ transcript: TranscriptSchema, salt: hex32 }).safeParse(await c.req.json().catch(() => null));
    if (!p.success) throw bad(p.error);
    console.log(`[verifier] commit ${cid}: reveal received (${p.data.transcript.turns.length} turns)`);
    return c.json(await verify(BigInt(cid), p.data.transcript as Transcript, p.data.salt as Hex, deps));
  });

  app.get("/bounties/:id/findings", async (c) => {
    const bid = id(c.req.param("id"));
    const address = c.req.header("x-address"), signature = c.req.header("x-signature");
    if (!hex.safeParse(address).success || !hex.safeParse(signature).success) throw new HTTPException(401, { message: "X-Address and X-Signature required" });
    const minute = Math.floor(Date.now() / 60000);
    let ok = false;
    for (const m of [minute, minute - 1]) {
      ok = await verifyMessage({ address: address as Hex, message: `bazaar:findings:${bid}:${m}`, signature: signature as Hex }).catch(() => false);
      if (ok) break;
    }
    if (!ok) throw new HTTPException(401, { message: "bad signature" });
    const bounty = await getBounty(BigInt(bid));
    if (bounty.buyer.toLowerCase() !== address!.toLowerCase()) throw new HTTPException(403, { message: "not the buyer of this bounty" });
    const rows = await sb.listFindings(bid);
    const commits = await sb.listCommitsForBounty(bid);
    const byId = new Map(commits.map((r) => [r.id, r]));
    return c.json(rows.map((f) => {
      const cm = byId.get(f.commit_id);
      return {
        commitId: f.commit_id, bountyId: f.bounty_id, invariant: cm?.invariant ?? (f.transcript as Transcript).invariant,
        transcript: f.transcript, traces: f.traces, hits: cm?.hits ?? 0, k: bounty.k, breaksControl: Boolean(cm?.breaks_control),
        attestTx: cm?.attest_tx ?? null, class: cm?.breaks_control ? "base-model" : "feature",
      };
    }));
  });

  return app;
}
