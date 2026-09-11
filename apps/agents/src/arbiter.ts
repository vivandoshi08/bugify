// Arbiter (v1: PLATFORM_KEY). `--list` prints commits with an OPEN dispute; `--commit <id> --outcome PASS|FAIL` resolves one.
import { flag, opt, short } from "./env.ts";
import { disputeStateName, explorerTx, outcomeName } from "@bugify/sdk";
import { formatEther } from "viem";
import { iso, makeBazaar, printCommit, requireCommitId } from "./dispute-lib.ts";

const bz = makeBazaar("PLATFORM_KEY");
const arbiter = await bz.arbiter();
console.log(`arbiter key ${bz.address}  on-chain arbiter ${arbiter}${arbiter.toLowerCase() === bz.address.toLowerCase() ? "" : "  (MISMATCH: resolve will revert NotArbiter)"}`);

if (flag("list")) {
  const n = await bz.commitCount();
  console.log(`scanning ${n} commits for OPEN disputes…\n`);
  let open = 0;
  for (let i = 0n; i < n; i++) {
    const c = await bz.getCommit(i);
    if (disputeStateName(c.dispute) !== "OPEN") continue;
    open++;
    console.log(
      `commit #${i}  bounty #${c.bountyId}  inv ${c.inv}  outcome ${outcomeName(c.outcome)}  hits ${c.hits}  disputed by ${short(c.disputer)}  bond ${formatEther(c.disputeBond)} ETH  attested ${iso(c.attestedAt)}`,
    );
  }
  console.log(open ? `\n${open} open dispute(s). Resolve with --commit <id> --outcome PASS|FAIL` : "no open disputes.");
  process.exit(0);
}

const commitId = requireCommitId();
const outcomeArg = opt("outcome")?.toUpperCase();
if (outcomeArg !== "PASS" && outcomeArg !== "FAIL") throw new Error("usage: --commit <id> --outcome PASS|FAIL   (or --list)");

const [c, window] = await Promise.all([bz.getCommit(commitId), bz.disputeWindow()]);
console.log();
printCommit(commitId, c, window);
const state = disputeStateName(c.dispute);
if (state !== "OPEN") throw new Error(`commit ${commitId} dispute state is ${state}; resolve needs OPEN`);

const prev = outcomeName(c.outcome);
console.log(`\nresolving ${prev} → ${outcomeArg}…`);
const r = await bz.resolve(commitId, outcomeArg);
console.log(`resolve  ${explorerTx(r.txHash)}`);
console.log(`changed  ${r.changed}`);
console.log(`final    ${r.outcome}${r.outcome === "PASS_NO_SLOT" ? "  (FAIL→PASS but no slot left: bond back, no reward)" : ""}`);
console.log(`bond     ${formatEther(c.disputeBond)} ETH → ${r.changed ? `disputer ${short(c.disputer)}` : "counterparty"}`);
console.log(`\nfinalize is now allowed immediately: \`bun run ${prev === "PASS" ? "buyer" : "seller"}-dispute --commit ${commitId}\` (already polling) or anyone can call finalize.`);
