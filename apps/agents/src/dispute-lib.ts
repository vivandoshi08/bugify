// Shared bits for the dispute demo scripts (buyer-dispute, seller-dispute, arbiter). See docs/CONTRACTS.md §4.
import { RPC_URL, SERVER_URL, BAZAAR_ADDRESS, requireKey, flag, opt, sleep, short } from "./env.ts";
import {
  createBazaar,
  disputeSide,
  disputeStateName,
  explorerTx,
  outcomeName,
  type Bazaar,
  type OnChainCommit,
} from "@bugify/sdk";
import { formatEther } from "viem";

export const iso = (unixSeconds: bigint) => (unixSeconds === 0n ? "—" : new Date(Number(unixSeconds) * 1000).toISOString());
export const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

export function requireCommitId(): bigint {
  const raw = opt("commit");
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error("usage: --commit <id> (non-negative integer)");
  return BigInt(raw);
}

export function makeBazaar(key: "BUYER_KEY" | "SELLER_KEY" | "PLATFORM_KEY"): Bazaar {
  return createBazaar({ rpcUrl: RPC_URL, privateKey: requireKey(key), bazaarAddress: BAZAAR_ADDRESS, serverUrl: SERVER_URL });
}

/** Print the on-chain view of a commit: outcome, hits, attest time, dispute window end and dispute state. */
export function printCommit(commitId: bigint, c: OnChainCommit, window: bigint) {
  const windowEnd = c.attestedAt === 0n ? 0n : c.attestedAt + window;
  const left = windowEnd - nowSec();
  console.log(`commit #${commitId}  bounty #${c.bountyId}  inv ${c.inv}  seq ${c.seq}  seller ${short(c.seller)}`);
  console.log(`  outcome     ${outcomeName(c.outcome)}  hits ${c.hits}${c.breaksControl ? "  breaksControl" : ""}${c.slotHeld ? "  slotHeld" : ""}`);
  console.log(`  bond        ${formatEther(c.bond)} ETH`);
  console.log(`  attestedAt  ${iso(c.attestedAt)}`);
  console.log(`  window end  ${iso(windowEnd)}${windowEnd ? (left > 0n ? `  (${left}s left)` : "  (closed)") : ""}`);
  const ds = disputeStateName(c.dispute);
  console.log(
    `  dispute     ${ds}${ds === "NONE" ? "" : `  by ${short(c.disputer)}  bond ${formatEther(c.disputeBond)} ETH`}${c.finalized ? "  FINALIZED" : ""}`,
  );
  const side = disputeSide(c);
  console.log(`  disputable  ${side ? `by ${side}` : "no"}`);
}

/** Poll getCommit every `pollMs` until the dispute is RESOLVED (state 2). Returns the resolved commit. */
export async function waitForResolution(bz: Bazaar, commitId: bigint, pollMs = 3000): Promise<OnChainCommit> {
  let ticks = 0;
  for (;;) {
    const c = await bz.getCommit(commitId);
    if (disputeStateName(c.dispute) === "RESOLVED") return c;
    if (disputeStateName(c.dispute) === "NONE") throw new Error(`commit ${commitId} has no dispute (state NONE)`);
    if (ticks++ % 10 === 0) console.log(`  waiting for the arbiter… (dispute OPEN, ${new Date().toISOString()})`);
    await sleep(pollMs);
  }
}

/**
 * Whole party-side flow: print → dispute → wait for resolve → finalize. `--dry` prints only.
 * `role` decides which key signs and which outcome is disputable (buyer: PASS, seller: FAIL).
 */
export async function runPartyDispute(role: "buyer" | "seller") {
  const key = role === "buyer" ? "BUYER_KEY" : "SELLER_KEY";
  const bz = makeBazaar(key);
  const commitId = requireCommitId();
  const dry = flag("dry");

  const before = await bz.balance();
  console.log(`${role} ${bz.address}  balance ${before} ETH\n`);

  const [c, window, bond] = await Promise.all([bz.getCommit(commitId), bz.disputeWindow(), bz.disputeBond()]);
  printCommit(commitId, c, window);
  console.log(`  dispute bond required: ${formatEther(bond)} ETH`);

  const prev = outcomeName(c.outcome);
  const side = disputeSide(c);
  if (dry) {
    console.log(`\n--dry: would ${side === role ? `dispute as ${role}` : `NOT dispute (${side ? `only the ${side} may dispute a ${prev}` : `${prev} is not disputable`})`}.`);
    return;
  }
  if (c.finalized) throw new Error(`commit ${commitId} is already finalized`);

  const state = disputeStateName(c.dispute);
  if (state === "NONE") {
    if (side !== role) throw new Error(side ? `only the ${side} may dispute a ${prev} (you are the ${role})` : `${prev} is not disputable`);
    if (role === "buyer") {
      const b = await bz.getBounty(c.bountyId);
      if (b.buyer.toLowerCase() !== bz.address.toLowerCase()) throw new Error(`bounty #${c.bountyId} buyer is ${b.buyer}, not ${bz.address}`);
    } else if (c.seller.toLowerCase() !== bz.address.toLowerCase()) {
      throw new Error(`commit ${commitId} seller is ${c.seller}, not ${bz.address}`);
    }
    if (c.attestedAt + window <= nowSec()) throw new Error(`dispute window closed at ${iso(c.attestedAt + window)}`);

    console.log(`\ndisputing ${prev} as ${role} with a ${formatEther(bond)} ETH bond…`);
    const d = await bz.dispute(commitId);
    console.log(`dispute  ${explorerTx(d.txHash)}`);
    console.log(`bond     ${formatEther(d.bondWei)} ETH (returned if the arbiter changes the outcome, else paid to the counterparty)`);
  } else if (state === "OPEN") {
    console.log(`\ndispute already OPEN by ${short(c.disputer)}; skipping to the wait.`);
  } else {
    console.log(`\ndispute already RESOLVED; skipping to finalize.`);
  }

  console.log(`\npolling getCommit every 3 s until the arbiter resolves (run \`bun run arbiter --commit ${commitId} --outcome PASS|FAIL\`)…`);
  const r = await waitForResolution(bz, commitId);
  const final = outcomeName(r.outcome);
  const changed = final !== prev;
  console.log(`resolved → ${final}  ${changed ? `CHANGED from ${prev}` : `upheld (${prev})`}`);
  console.log(`dispute bond → ${changed ? "disputer (you)" : role === "buyer" ? "seller" : "buyer"}`);

  if (r.finalized) {
    console.log(`\ncommit already finalized by someone else.`);
  } else {
    console.log(`\nfinalizing now (dispute RESOLVED: no need to wait out the window)…`);
    const f = await bz.finalize(commitId);
    console.log(`finalize ${explorerTx(f.txHash)}`);
    console.log(`paid to seller ${formatEther(f.paidWei)} ETH reward${final === "FAIL" ? " (seller bond → treasury)" : final === "PASS" ? " (+ seller bond returned)" : " (seller bond returned)"}`);
  }
  const after = await bz.balance();
  console.log(`balance before ${before} ETH → after ${after} ETH`);
}
