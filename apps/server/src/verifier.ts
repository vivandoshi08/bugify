import type { Hex } from "viem";
import { ZERO_HASH, commitment, contentHash, traceHash, type Manifest, type Outcome, type Trace, type Transcript, type VerificationRecord } from "@bugify/sdk";
import { env } from "./env.ts";
import { getBounty, getCommit, getInvariant, revertName, txQueue } from "./chain.ts";
import * as sb from "./supabase.ts";
import { allCalls, evaluate } from "./harness/evaluate.ts";
import { redactEvidence } from "./harness/summaries.ts";
import { runSession, type Deps } from "./harness/runSession.ts";

/** Console line + mirrored into agent_logs (agent "verifier") so the board's agent console shows it. Fire-and-forget. */
const log = (s: string) => {
  console.log(`[verifier] ${s}`);
  const level = /\btx 0x[0-9a-fA-F]{64}\b/.test(s) ? "tx" : /\b(FAIL|failed|timeout|mismatch)\b/.test(s) ? "warn" : "info";
  sb.insertAgentLog({ agent: "verifier", level, line: s }).catch(() => {});
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export type VerifyResult = { outcome: Outcome; hits: number; breaksControl: boolean; attestTx: Hex };

export class VerifyError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** POST /commits/:cid/reveal → §5 steps 1–11. Blocks until the attest tx is mined. */
export async function verify(commitId: bigint, transcript: Transcript, salt: Hex, deps: Deps): Promise<VerifyResult> {
  const tag = `commit ${commitId}`;
  // 1
  const c = await getCommit(commitId);
  if (c.seller === "0x0000000000000000000000000000000000000000") throw new VerifyError("no such commit", 404);
  if (c.outcome !== "NONE") throw new VerifyError(`commit already attested (${c.outcome})`, 409);
  const bounty = await getBounty(c.bountyId);
  const content = contentHash(transcript);
  const fail = async (why: string): Promise<VerifyResult> => {
    log(`${tag}: ${why} → attest FAIL`);
    const attestTx = await attestAndRecord(commitId, c.bountyId, "FAIL", 0, false, content, salt, ZERO_HASH, { reason: why });
    return { outcome: "FAIL", hits: 0, breaksControl: false, attestTx };
  };
  // 2
  if (commitment(content, salt).toLowerCase() !== c.commitment.toLowerCase()) return fail("commitment mismatch");
  // 3
  if (transcript.manifestHash.toLowerCase() !== bounty.manifestHash.toLowerCase()) return fail("manifestHash mismatch");
  if (transcript.invariant !== c.inv) return fail(`invariant ${transcript.invariant} != commit inv ${c.inv}`);
  const manifest = await sb.getManifest(bounty.manifestHash);
  if (!manifest) throw new VerifyError("manifest not found for this bounty", 500);
  const inv = manifest.invariants[c.inv];
  if (!inv) return fail(`manifest has no invariant ${c.inv}`);
  // 4 FIFO
  await waitForTurn(commitId, c.bountyId, c.inv, c.seq);
  // 5 replay
  const k = Math.max(1, env.K);
  const turns = transcript.turns;
  const traces: Trace[] = await Promise.all(Array.from({ length: k }, () => runSession(manifest, turns, deps)));
  const evals = traces.map((t) => evaluate(inv, t));
  const hits = evals.filter((e) => e.violated).length;
  // 6 control
  let breaksControl = false;
  let controlHits: number | null = null;
  const control = bounty.controlHash !== ZERO_HASH ? await sb.getManifest(bounty.controlHash) : null;
  if (control) {
    const ct = await Promise.all(Array.from({ length: k }, () => runSession(control, turns, deps)));
    const cinv = control.invariants[c.inv];
    controlHits = cinv ? ct.filter((t) => evaluate(cinv, t).violated).length : 0;
    breaksControl = controlHits >= 1;
  }
  // 7-8
  const outcome: Outcome = hits >= 1 ? "PASS" : "FAIL";
  const th = traceHash(traces);
  // Public, secret-free record for the board: tool names only, evidence with args redacted.
  const verification: VerificationRecord = {
    k, hits, breaksControl,
    replays: traces.map((t, i) => ({
      hit: evals[i]!.violated, toolCalls: allCalls(t).map((call) => call.name), turns: t.turns.length, evidence: redactEvidence(evals[i]!.evidence),
    })),
    ...(controlHits === null ? {} : { control: { hits: controlHits } }),
  };
  log(`${tag}: hash ok · seq ${c.seq} == cursor · replay ×${k} → ${hits}/${k}${control ? ` · control ${breaksControl ? "breaks" : "holds"}` : ""} → attest ${outcome}`);
  const attestTx = await attestAndRecord(commitId, c.bountyId, outcome, hits, breaksControl, content, salt, th, verification);
  // 9
  if (outcome === "PASS") {
    await sb.insertFinding({ commit_id: Number(commitId), bounty_id: Number(c.bountyId), buyer: bounty.buyer, transcript, traces });
  }
  return { outcome, hits, breaksControl, attestTx };
}

/** Step 8 + 10: send attest through the queue, then mirror the row (the indexer will upsert the same later). */
async function attestAndRecord(commitId: bigint, bountyId: bigint, outcome: Outcome, hits: number, breaksControl: boolean, content: Hex, salt: Hex, th: Hex, verification: VerificationRecord) {
  const attestTx = await txQueue.attest(commitId, outcome, hits, breaksControl, content, salt, th);
  log(`commit ${commitId}: attest ${outcome} tx ${attestTx}`);
  await sb.updateCommit(commitId, {
    outcome, hits, breaks_control: breaksControl, content_hash: content.toLowerCase(), trace_hash: th.toLowerCase(),
    attested_at: new Date().toISOString(), attest_tx: attestTx.toLowerCase(), verification,
  }).catch((e) => log(`commit ${commitId}: row update failed (indexer will catch up): ${(e as Error).message}`));
  return attestTx;
}

/** Step 4: poll until cursor reaches seq; meanwhile FAIL earlier commits whose reveal timeout passed. */
async function waitForTurn(commitId: bigint, bountyId: bigint, inv: number, seq: number) {
  for (;;) {
    const cursor = (await getInvariant(bountyId, inv)).cursor;
    if (seq <= cursor) return;
    log(`commit ${commitId}: seq ${seq} > cursor ${cursor}, waiting for earlier commits`);
    await timeoutStaleAhead(bountyId, inv, cursor);
    await sleep(5000);
  }
}

async function timeoutStaleAhead(bountyId: bigint, inv: number, cursor: number) {
  const rows = await sb.db.from("commits").select("id, seq").eq("bounty_id", Number(bountyId)).eq("invariant", inv).eq("outcome", "NONE").lt("seq", cursor + 1).order("seq");
  const now = Math.floor(Date.now() / 1000);
  for (const r of rows.data ?? []) {
    const c = await getCommit(BigInt(r.id));
    if (c.outcome !== "NONE" || c.seq !== cursor) continue;
    if (Number(c.committedAt) + env.REVEAL_TIMEOUT >= now) continue;
    log(`commit ${r.id}: reveal timeout (seq ${c.seq}) → attest FAIL`);
    try {
      await attestAndRecord(BigInt(r.id), bountyId, "FAIL", 0, false, ZERO_HASH, ZERO_HASH, ZERO_HASH, { reason: "reveal timeout" });
    } catch (e) { log(`commit ${r.id}: timeout attest failed: ${(e as Error).message}`); }
  }
}

/** Fallback settler: finalize attested, undisputed commits whose dispute window closed. */
export function startSettler() {
  const tick = async () => {
    try {
      const before = new Date(Date.now() - env.DISPUTE_WINDOW * 1000).toISOString();
      for (const row of await sb.listSettleable(before)) {
        try {
          const tx = await txQueue.finalize(BigInt(row.id));
          console.log(`[settler] commit ${row.id} finalized tx ${tx}`);
        } catch (e) { console.log(`[settler] commit ${row.id}: skip (${revertName((e as Error).cause ?? e)})`); }
      }
    } catch (e) { console.log(`[settler] pass failed: ${(e as Error).message}`); }
  };
  setInterval(tick, env.SETTLER_INTERVAL_MS);
  console.log(`[settler] started · every ${env.SETTLER_INTERVAL_MS} ms · dispute window ${env.DISPUTE_WINDOW} s`);
}

export type { Manifest };
