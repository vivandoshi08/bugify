import { parseEventLogs, type Hex, type Log } from "viem";
import { bazaarAbi, outcomeName } from "@bugify/sdk";
import { BAZAAR_DEPLOY_BLOCK, env } from "./env.ts";
import { bazaar, getBounty, publicClient } from "./chain.ts";
import * as sb from "./supabase.ts";

const CHUNK = 2000n;
const META_KEY = "lastIndexedBlock";
const log = (s: string) => console.log(`[indexer] ${s}`);
const n = (v: unknown) => Number(v);
const h = (v: unknown) => String(v).toLowerCase();

type Decoded = { eventName: string; args: Record<string, unknown>; blockNumber: bigint; transactionHash: Hex; logIndex: number };

/** Map one decoded Bazaar event to its row writes (§6). */
export async function applyEvent(e: Decoded): Promise<string> {
  const a = e.args;
  const tx = e.transactionHash.toLowerCase();
  switch (e.eventName) {
    case "BountyPosted": {
      const id = n(a.bountyId);
      const rewards = (a.rewards as bigint[]).map(sb.wei);
      const slots = (a.slots as number[]).map(Number);
      const escrow = (a.rewards as bigint[]).reduce((s, r, i) => s + r * BigInt(slots[i] ?? 0), 0n);
      const manifest_hash = h(a.manifestHash);
      if (!(await sb.getManifest(manifest_hash))) log(`warning: bounty #${id} references unknown manifest ${manifest_hash} (hidden from public_bounties until POST /manifests)`);
      await sb.upsertBounty({
        id, buyer: h(a.buyer), manifest_hash, control_hash: h(a.controlHash), rewards_wei: rewards, slots,
        expiry: sb.iso(a.expiry as bigint), min_bond_wei: sb.wei(a.minBond as bigint), k: n(a.k), control_tier_bps: n(a.controlTierBps),
        status: "OPEN", escrow_wei: escrow.toString(), pending: 0, tx_hash: tx, block: n(e.blockNumber),
      });
      return `#${id} buyer ${h(a.buyer)} escrow ${escrow} wei`;
    }
    case "Committed": {
      const id = n(a.commitId);
      await sb.upsertCommit({
        id, bounty_id: n(a.bountyId), invariant: n(a.inv), seq: n(a.seq), seller: h(a.seller),
        commitment: h(a.commitment), bond_wei: sb.wei(a.bond as bigint), commit_tx: tx,
      });
      await sb.updateBounty(n(a.bountyId), { pending: (await getBounty(a.bountyId as bigint)).pending });
      return `commit ${id} bounty #${n(a.bountyId)} inv ${n(a.inv)} seq ${n(a.seq)}`;
    }
    case "Attested": {
      const outcome = outcomeName(n(a.outcome));
      const block = await publicClient.getBlock({ blockNumber: e.blockNumber });
      await sb.updateCommit(n(a.commitId), {
        outcome, hits: n(a.hits), breaks_control: Boolean(a.breaksControl), content_hash: h(a.contentHash),
        trace_hash: h(a.traceHash), attested_at: sb.iso(block.timestamp), attest_tx: tx,
      });
      return `commit ${n(a.commitId)} → ${outcome} hits ${n(a.hits)}`;
    }
    case "Disputed":
      await sb.updateCommit(n(a.commitId), { dispute: "OPEN", disputer: h(a.disputer), dispute_tx: tx });
      return `commit ${n(a.commitId)} disputed by ${h(a.disputer)}`;
    case "Resolved":
      await sb.updateCommit(n(a.commitId), { dispute: "RESOLVED", outcome: outcomeName(n(a.outcome)), resolve_tx: tx });
      return `commit ${n(a.commitId)} resolved → ${outcomeName(n(a.outcome))}`;
    case "Finalized": {
      const id = n(a.commitId);
      await sb.updateCommit(id, { finalized: true, outcome: outcomeName(n(a.outcome)), paid_wei: sb.wei(a.paidToSeller as bigint), finalize_tx: tx });
      await refreshBounty(id);
      return `commit ${id} finalized → ${outcomeName(n(a.outcome))} paid ${a.paidToSeller} wei`;
    }
    case "Reclaimed": {
      const id = n(a.commitId);
      await sb.updateCommit(id, { outcome: "RECLAIMED", finalized: true, reclaim_tx: tx });
      await refreshBounty(id);
      return `commit ${id} bond reclaimed`;
    }
    case "BountyVoided":
      await sb.updateBounty(n(a.bountyId), await chainBountyPatch(a.bountyId as bigint));
      return `#${n(a.bountyId)} voided`;
    case "BountyCancelling":
      await sb.updateBounty(n(a.bountyId), { expiry: sb.iso(a.newExpiry as bigint) });
      return `#${n(a.bountyId)} cancelling, new expiry ${sb.iso(a.newExpiry as bigint)}`;
    case "BountyExpired":
      await sb.updateBounty(n(a.bountyId), await chainBountyPatch(a.bountyId as bigint));
      return `#${n(a.bountyId)} expired, refund ${a.refund} wei`;
    default:
      return "(config event)";
  }
}

async function chainBountyPatch(bountyId: bigint) {
  const b = await getBounty(bountyId);
  return { escrow_wei: b.escrow.toString(), pending: b.pending, status: b.status };
}
async function refreshBounty(commitId: number) {
  const row = await sb.db.from("commits").select("bounty_id").eq("id", commitId).maybeSingle();
  const bountyId = row.data?.bounty_id;
  if (bountyId != null) await sb.updateBounty(bountyId, await chainBountyPatch(BigInt(bountyId)));
}

let last: bigint | null = null;
let running = false;

export const lastIndexedBlock = () => last;

async function startBlock(): Promise<bigint> {
  const stored = await sb.getMeta(META_KEY);
  if (stored) return BigInt(stored);
  return (env.INDEXER_START_BLOCK ?? BAZAAR_DEPLOY_BLOCK) - 1n;
}

/** One indexer pass: scan (last, latest] in ≤2000-block chunks, apply every log, persist the cursor. */
export async function indexOnce(): Promise<void> {
  let cursor: bigint = last ?? (await startBlock());
  const latest = await publicClient.getBlockNumber();
  while (cursor < latest) {
    const from: bigint = cursor + 1n;
    const to: bigint = latest - from >= CHUNK ? from + CHUNK - 1n : latest;
    const raw: Log[] = await publicClient.getLogs({ address: bazaar, fromBlock: from, toBlock: to });
    const logs = parseEventLogs({ abi: bazaarAbi, logs: raw }) as unknown as Decoded[];
    for (const e of logs) {
      try {
        const summary = await applyEvent(e);
        await sb.upsertEvent({ name: e.eventName, args: sb.jsonSafe(e.args), block: n(e.blockNumber), tx_hash: e.transactionHash, log_index: e.logIndex });
        log(`${e.eventName} ${summary} · block ${e.blockNumber} tx ${e.transactionHash.slice(0, 10)}…`);
      } catch (err) {
        log(`error on ${e.eventName} tx ${e.transactionHash} idx ${e.logIndex}: ${(err as Error).message}`);
      }
    }
    cursor = last = to;
    await sb.setMeta(META_KEY, cursor.toString());
  }
}

export function startIndexer() {
  const tick = async () => {
    if (running) return;
    running = true;
    try { await indexOnce(); } catch (err) { log(`pass failed: ${(err as Error).message}`); }
    finally { running = false; }
  };
  void tick();
  setInterval(tick, env.INDEXER_INTERVAL_MS);
  log(`started · bazaar ${bazaar} · every ${env.INDEXER_INTERVAL_MS} ms`);
}
