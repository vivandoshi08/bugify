import { RPC_URL, SERVER_URL, BAZAAR_ADDRESS, requireKey, flag, sleep, compact } from "./env.ts";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createBazaar, explorerTx, DEMO, type Manifest, type Finding } from "@bugify/sdk";

const bz = createBazaar({ rpcUrl: RPC_URL, privateKey: requireKey("BUYER_KEY"), bazaarAddress: BAZAAR_ADDRESS, serverUrl: SERVER_URL });
const manifest: Manifest = JSON.parse(readFileSync(resolve(import.meta.dir, "../manifests/northwind.json"), "utf8"));
const outDir = resolve(import.meta.dir, "../redteam");
mkdirSync(outDir, { recursive: true });

console.log(`buyer ${bz.address}  balance ${await bz.balance()} ETH`);

// `--bounty <id>` skips posting and only pulls findings for an existing bounty.
const existing = process.argv.find((a, i, all) => all[i - 1] === "--bounty");
let bountyId: number;
if (existing !== undefined) {
  bountyId = Number(existing);
  console.log(`using existing bounty #${bountyId}`);
} else {
  console.log(`posting "${manifest.name}" (${manifest.invariants.length} invariants, reward ${DEMO.rewardEth} ETH × 2 slots, bond ${DEMO.minBondEth} ETH, k=${DEMO.k})`);
  const posted = await bz.postBounty(manifest, {
    rewardsEth: [DEMO.rewardEth, DEMO.rewardEth],
    slots: [1, 1],
    expiryHours: DEMO.expiryHours,
    minBondEth: DEMO.minBondEth,
    k: DEMO.k,
  });
  bountyId = Number(posted.bountyId);
  console.log(`\nbounty #${bountyId}  manifest ${posted.manifestHash}`);
  console.log(`tx ${explorerTx(posted.txHash)}\n`);
}

const seen = new Set<number>();
function report(f: Finding) {
  const file = resolve(outDir, `finding-${f.commitId}.json`);
  writeFileSync(file, JSON.stringify(f, null, 2));
  console.log(`\n★ finding commit #${f.commitId}  invariant ${f.invariant} (${manifest.invariants[f.invariant]?.label ?? "?"})  hits ${f.hits}/${f.k}  class ${f.class}${f.breaksControl ? "  breaksControl" : ""}`);
  console.log(`  attest ${explorerTx(f.attestTx)}`);
  console.log(`  saved  ${file}`);
  console.log(`  transcript:`);
  f.transcript.turns.forEach((t, i) => console.log(`    ${i + 1}. ${t}`));
  const trace = f.traces[0];
  if (trace) {
    console.log(`  trace (replay 1/${f.traces.length}, ${trace.model}):`);
    trace.turns.forEach((t, i) => {
      for (const tc of t.toolCalls) console.log(`    turn ${i + 1}  ${tc.name}(${compact(tc.input, 80)}) → ${compact(tc.result, 80)}`);
      console.log(`    turn ${i + 1}  assistant: ${t.assistant.replace(/\s+/g, " ").slice(0, 140)}`);
    });
  }
}

const once = flag("once");
console.log(once ? "pulling findings once…" : "polling findings every 10 s (Ctrl-C to stop)…");
for (;;) {
  try {
    const findings = await bz.getFindings(bountyId);
    for (const f of findings) if (!seen.has(f.commitId)) { seen.add(f.commitId); report(f); }
    if (once) { console.log(`${findings.length} finding(s)`); break; }
  } catch (e) {
    console.error(`findings poll failed: ${(e as Error).message}`);
    if (once) process.exit(1);
  }
  await sleep(10_000);
}
