import { RPC_URL, SERVER_URL, BAZAAR_ADDRESS, requireKey, opt, flag, sleep } from "./env.ts";
import { createBazaar, explorerTx, PLATFORM_ADDRESS } from "@bugify/sdk";
import { formatEther } from "viem";
import { loadAttack, pickBounty, playAttack } from "./play.ts";

const bz = createBazaar({ rpcUrl: RPC_URL, privateKey: requireKey("SELLER_KEY"), bazaarAddress: BAZAAR_ADDRESS, serverUrl: SERVER_URL });
const attack = loadAttack("mimic.json");
const treasury = async () => formatEther(await bz.publicClient.getBalance({ address: PLATFORM_ADDRESS }));

const sellerBefore = await bz.balance();
const treasuryBefore = await treasury();
console.log(`seller ${bz.address}  balance ${sellerBefore} ETH`);
console.log(`treasury ${PLATFORM_ADDRESS}  balance ${treasuryBefore} ETH`);
const b = pickBounty(await bz.listBounties(), opt("bounty"));
const bountyId = BigInt(b.id);
console.log(`target: bounty #${b.id} "${b.name}"\n`);

await playAttack(bz, bountyId, attack);

console.log(`\ncommitting transcript on chain (bond ${formatEther(BigInt(b.min_bond_wei))} ETH)…`);
const r = await bz.submitFinding(bountyId, attack.invariant, attack.turns);
console.log(`commit #${r.commitId}  ${explorerTx(r.commitTx)}`);
console.log(`attest   ${explorerTx(r.attestTx)}`);
console.log(`\n${r.outcome === "FAIL" ? "✖ FAIL" : `outcome ${r.outcome}`}  hits ${r.hits} — the text mimic is not a real tool call, so the harness records no issue_refund.`);
console.log(`not settling: the server's settler finalizes FAIL commits and the bond goes to the treasury.`);

if (flag("wait")) {
  console.log(`\nwaiting 90 s for the server to finalize…`);
  await sleep(90_000);
  const treasuryAfter = await treasury();
  console.log(`treasury before ${treasuryBefore} ETH → after ${treasuryAfter} ETH  (Δ ${(Number(treasuryAfter) - Number(treasuryBefore)).toFixed(6)})`);
  console.log(`seller   before ${sellerBefore} ETH → after ${await bz.balance()} ETH`);
}
