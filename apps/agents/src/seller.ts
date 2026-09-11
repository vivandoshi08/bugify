import { RPC_URL, SERVER_URL, BAZAAR_ADDRESS, requireKey, opt } from "./env.ts";
import { createBazaar, explorerTx } from "@bugify/sdk";
import { formatEther } from "viem";
import { loadAttack, pickBounty, playAttack } from "./play.ts";

const bz = createBazaar({ rpcUrl: RPC_URL, privateKey: requireKey("SELLER_KEY"), bazaarAddress: BAZAAR_ADDRESS, serverUrl: SERVER_URL });
// `--attack <name>` picks attacks/<name>.json (default ref-ticket); the invariant index comes from the file.
const attackName = (opt("attack") ?? "ref-ticket").replace(/\.json$/, "");
const attack = loadAttack(`${attackName}.json`);

const before = await bz.balance();
console.log(`seller ${bz.address}  balance ${before} ETH`);
const b = pickBounty(await bz.listBounties(), opt("bounty"));
const bountyId = BigInt(b.id);
const fullReward = BigInt(b.rewards_wei[attack.invariant] ?? "0");
const hasControl = !!b.control_hash && !/^0x0+$/.test(b.control_hash);
console.log(`target: bounty #${b.id} "${b.name}"`);
console.log(`attack: ${attackName}.json → invariant ${attack.invariant} (${b.invariant_labels[attack.invariant] ?? "?"}), reward ${formatEther(fullReward)} ETH${hasControl ? `, control attached (tier ${b.control_tier_bps / 100}% if it breaks the control too)` : ""}\n`);

await playAttack(bz, bountyId, attack);

console.log(`\ncommitting transcript on chain (bond ${formatEther(BigInt(b.min_bond_wei))} ETH)…`);
const r = await bz.submitFinding(bountyId, attack.invariant, attack.turns);
console.log(`commit #${r.commitId}  ${explorerTx(r.commitTx)}`);
console.log(`revealed → outcome ${r.outcome}  hits ${r.hits}/${b.k}  breaksControl ${r.breaksControl}${r.breaksControl ? "  (also breaks the generic control → base-model jailbreak, tiered payout)" : hasControl ? "  (control holds → product bug, full reward)" : ""}`);
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
const pct = fullReward > 0n ? Number((s.paidWei * 10000n) / fullReward) / 100 : 0;
console.log(`paid ${formatEther(s.paidWei)} ETH of the ${formatEther(fullReward)} ETH reward (${pct}%${r.breaksControl ? `, control tier ${b.control_tier_bps / 100}%` : ""}) + bond returned`);
console.log(`balance before ${before} ETH → after ${after} ETH`);
