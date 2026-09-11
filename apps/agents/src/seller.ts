import { RPC_URL, SERVER_URL, BAZAAR_ADDRESS, requireKey, opt } from "./env.ts";
import { createBazaar, explorerTx } from "@bugify/sdk";
import { formatEther } from "viem";
import { loadAttack, pickBounty, playAttack } from "./play.ts";

const bz = createBazaar({ rpcUrl: RPC_URL, privateKey: requireKey("SELLER_KEY"), bazaarAddress: BAZAAR_ADDRESS, serverUrl: SERVER_URL });
const attack = loadAttack("ref-ticket.json");

const before = await bz.balance();
console.log(`seller ${bz.address}  balance ${before} ETH`);
const b = pickBounty(await bz.listBounties(), opt("bounty"));
const bountyId = BigInt(b.id);
console.log(`target: bounty #${b.id} "${b.name}"\n`);

await playAttack(bz, bountyId, attack);

console.log(`\ncommitting transcript on chain (bond ${formatEther(BigInt(b.min_bond_wei))} ETH)…`);
const r = await bz.submitFinding(bountyId, attack.invariant, attack.turns);
console.log(`commit #${r.commitId}  ${explorerTx(r.commitTx)}`);
console.log(`revealed → outcome ${r.outcome}  hits ${r.hits}${r.breaksControl ? "  breaksControl" : ""}`);
console.log(`attest   ${explorerTx(r.attestTx)}`);
if (r.outcome !== "PASS" && r.outcome !== "PASS_NO_SLOT") {
  console.log(`outcome ${r.outcome}: nothing to settle. Bond was ${r.outcome === "FAIL" ? "forfeited" : "returned"}.`);
  process.exit(r.outcome === "FAIL" ? 1 : 0);
}

console.log(`\nwaiting for the dispute window…`);
let lastShown = -1;
const s = await bz.settle(r.commitId, {
  onWait: (left) => { if (left !== lastShown && left % 10 === 0) { console.log(`  ${left}s left`); lastShown = left; } },
});
const after = await bz.balance();
console.log(`finalize ${explorerTx(s.finalizeTx)}`);
console.log(`paid ${formatEther(s.paidWei)} ETH reward (+ bond returned)`);
console.log(`balance before ${before} ETH → after ${after} ETH`);
