import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { verifyMessage, type Hex } from "viem";
import { z } from "zod";
import { manifestHash, type Invariant, type Manifest, type Trace, type Transcript } from "@bugify/sdk";
import { env } from "./env.ts";
import { account, bazaar, getBounty, getChainId } from "./chain.ts";
import * as sb from "./supabase.ts";
import { lastIndexedBlock } from "./indexer.ts";
import { evaluate } from "./harness/evaluate.ts";
import { invariantSummary } from "./harness/summaries.ts";
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
const AgentLogSchema = z.object({
  agent: z.enum(["buyer", "seller", "verifier"]), level: z.enum(["info", "tx", "warn"]).default("info"),
  line: z.string().min(1).max(2000), ts: z.string().datetime({ offset: true }).optional(),
});

const WEB_ORIGIN = "http://localhost:3000";

/** Invariant definition minus anything secret: the canary text is dropped, everything else is already public via the summary. */
function publicInvariantSpec(inv: Invariant) {
  switch (inv.kind) {
    case "tool_gate": return { kind: inv.kind, label: inv.label, tool: inv.tool, requires: inv.requires };
    case "tool_sum_cap": return { kind: inv.kind, label: inv.label, tool: inv.tool, arg: inv.arg, max: inv.max };
    case "canary": return { kind: inv.kind, label: inv.label, normalize: inv.normalize };
    case "forbidden_tool": return { kind: inv.kind, label: inv.label, tool: inv.tool };
  }
}

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


/**
 * Public test data for the practice replica: which account the identity mock accepts and which record
 * ids the fixture mocks know. A seller attacking a sandbox needs the sandbox's test records the same way
 * a pentester gets a test account; this exposes ids and emails only, never the system prompt or rules.
 */
function sandboxHints(m: Manifest): { accounts: { email: string }[]; records: { tool: string; ids: string[] }[] } {
  const accounts: { email: string }[] = [];
  const records: { tool: string; ids: string[] }[] = [];
  for (const [tool, mock] of Object.entries(m.mocks)) {
    if (mock.type === "identity") accounts.push({ email: mock.customerEmail });
    if (mock.type === "fixture") records.push({ tool, ids: Object.keys(mock.rows) });
  }
  return { accounts, records };
}

export function createApp(deps: Deps) {
  const runner = createSessionRunner(deps);
  const app = new Hono();

  // Browser access: any origin may GET (board data is public or demo-gated); mutations only from the local web app.
  app.use("*", cors({
    origin: (origin, c) => {
      const method = c.req.method === "OPTIONS" ? c.req.header("access-control-request-method") ?? "" : c.req.method;
      if (method === "GET") return "*";
      return origin === WEB_ORIGIN ? origin : null;
    },
    allowHeaders: ["Content-Type", "X-Address", "X-Signature"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }));

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

  // Live agent console: the autonomous agents (apps/agents/src/log.ts) POST each log line here; the board streams agent_logs via Realtime.
  app.post("/agent-logs", async (c) => {
    const p = AgentLogSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) throw bad(p.error);
    await sb.insertAgentLog(p.data);
    return c.body(null, 204);
  });

  app.get("/bounties", async (c) => c.json(await sb.listPublicBounties()));

  app.get("/bounties/:id", async (c) => {
    const bid = id(c.req.param("id"));
    const bounty = await sb.getBountyRow(bid);
    if (!bounty) throw new HTTPException(404, { message: "bounty not found" });
    const m = await sb.getManifest(bounty.manifest_hash);
    return c.json({
      ...bounty,
      name: m?.name ?? null,
      model: m?.model ?? null,
      invariant_labels: m?.invariants.map((i) => i.label) ?? [],
      tools: m?.tools.map((t) => ({ name: t.name, description: t.description })) ?? [],
      sandbox: m ? sandboxHints(m) : null,
      commits: await sb.listCommitsForBounty(bid),
    });
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
    const received = `commit ${cid}: reveal received (${p.data.transcript.turns.length} turns)`;
    console.log(`[verifier] ${received}`);
    sb.insertAgentLog({ agent: "verifier", level: "info", line: received }).catch(() => {});
    return c.json(await verify(BigInt(cid), p.data.transcript as Transcript, p.data.salt as Hex, deps));
  });

  // Demo only (DEMO_PUBLIC_FINDINGS=true): the finding behind one commit, no buyer signature.
  // In production this is a 404: transcripts and traces are buyer-private (see /bounties/:id/findings).
  app.get("/commits/:cid/finding", async (c) => {
    if (!env.DEMO_PUBLIC_FINDINGS) throw new HTTPException(404, { message: "not found" });
    const cid = id(c.req.param("cid"));
    const f = await sb.getFinding(cid);
    if (!f) throw new HTTPException(404, { message: "no finding for this commit" });
    const cm = await sb.getCommitRow(cid);
    const bounty = cm ? await sb.getBountyRow(cm.bounty_id) : null;
    const m = bounty ? await sb.getManifest(bounty.manifest_hash) : null;
    const invIndex: number = cm?.invariant ?? (f.transcript as Transcript).invariant;
    const inv = m?.invariants[invIndex] ?? null;
    const traces = f.traces as Trace[];
    return c.json({
      commitId: f.commit_id, bountyId: f.bounty_id, invariant: invIndex,
      label: inv?.label ?? null, summary: inv ? invariantSummary(inv) : null, spec: inv ? publicInvariantSpec(inv) : null,
      transcript: f.transcript, traces,
      evaluations: inv ? traces.map((t) => evaluate(inv, t)) : traces.map(() => ({ violated: false, evidence: "" })),
      hits: cm?.hits ?? 0, k: bounty?.k ?? traces.length, breaksControl: Boolean(cm?.breaks_control),
      outcome: cm?.outcome ?? null, seller: cm?.seller ?? null, attestTx: cm?.attest_tx ?? null,
      class: cm?.breaks_control ? "base-model" : "feature", demo: true,
    });
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
