import { RPC_URL, SERVER_URL, BAZAAR_ADDRESS, requireKey, flag, sleep, compact } from "./env.ts";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createBazaar, explorerTx, DEMO, type Manifest, type Finding } from "@bugify/sdk";

const bz = createBazaar({ rpcUrl: RPC_URL, privateKey: requireKey("BUYER_KEY"), bazaarAddress: BAZAAR_ADDRESS, serverUrl: SERVER_URL });
const loadManifest = (file: string): Manifest => JSON.parse(readFileSync(resolve(import.meta.dir, "../manifests", file), "utf8"));
const manifest = loadManifest("northwind.json");
const outDir = resolve(import.meta.dir, "../redteam");
mkdirSync(outDir, { recursive: true });

/** Tier paid (in bps of the reward) when a finding also breaks the control manifest — a base-model jailbreak, not a product bug. */
const CONTROL_TIER_BPS = 2500;

console.log(`buyer ${bz.address}  balance ${await bz.balance()} ETH`);

// `--bounty <id>` skips posting and only pulls findings for an existing bounty.
const existing = process.argv.find((a, i, all) => all[i - 1] === "--bounty");
let bountyId: number;
if (existing !== undefined) {
  bountyId = Number(existing);
  console.log(`using existing bounty #${bountyId}`);
} else {
  // `--all` funds every invariant (one slot each); default funds the first two, as in the original demo.
  const funded = flag("all") ? manifest.invariants.length : 2;
  const rewardsEth = Array.from({ length: funded }, () => DEMO.rewardEth);
  const slots = rewardsEth.map(() => 1);
  // `--control` attaches the generic control manifest: the verifier replays every finding against it too,
  // and a finding that breaks the control pays CONTROL_TIER_BPS / 10000 of the reward (docs/ARCHITECTURE.md §5 step 6).
  let control: Manifest | undefined;
  if (flag("control")) {
    control = loadManifest("control.json");
    const same = JSON.stringify(control.invariants) === JSON.stringify(manifest.invariants);
    if (!same) throw new Error("control.json must declare the same invariants (same order) as northwind.json: the verifier evaluates control.invariants[inv]");
    if (control.model !== manifest.model) throw new Error("control.json must pin the same model as northwind.json");
  }
  console.log(`posting "${manifest.name}" (${funded}/${manifest.invariants.length} invariants funded, reward ${DEMO.rewardEth} ETH × 1 slot each, bond ${DEMO.minBondEth} ETH, k=${DEMO.k})`);
  if (control) console.log(`control "${control.name}" attached · tier ${CONTROL_TIER_BPS} bps (${CONTROL_TIER_BPS / 100}% of the reward when a finding also breaks the control)`);
  const posted = await bz.postBounty(manifest, {
    rewardsEth,
    slots,
    expiryHours: DEMO.expiryHours,
    minBondEth: DEMO.minBondEth,
    k: DEMO.k,
    ...(control ? { control, controlTierBps: CONTROL_TIER_BPS } : {}),
  });
  bountyId = Number(posted.bountyId);
  console.log(`\nbounty #${bountyId}  manifest ${posted.manifestHash}`);
  console.log(`tx ${explorerTx(posted.txHash)}\n`);
}

const seen = new Set<number>();
function report(f: Finding) {
  const file = resolve(outDir, `finding-${f.commitId}.json`);
  writeFileSync(file, JSON.stringify(f, null, 2));
  console.log(`\n★ finding commit #${f.commitId}  invariant ${f.invariant} (${manifest.invariants[f.invariant]?.label ?? "?"})  hits ${f.hits}/${f.k}  class ${f.class}${f.breaksControl ? `  breaksControl (pays ${CONTROL_TIER_BPS / 100}% tier)` : ""}`);
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
