// Autonomous buyer (docs/ARCHITECTURE.md §9, case 2: findings become regression tests).
//
//   bun run buyer-agent [--targets <dir>] [--bounty <id>] [--manifest <file>] [--once] [--no-post]
//                       [--interval <s>] [--k <n>] [--reset]
//
// Manages a catalogue of target agents (every <base>.json under --targets, default manifests/targets). Each pass,
// per target: make sure an OPEN bounty by this buyer exists for the target's current manifest hash (post one if
// not) → poll its findings → for each new finding: log it, save redteam/finding-<commitId>.json, ask the patcher
// for a new system prompt, write <targets>/<base>-v<N>.json, replay the same transcript against the patch through
// the server's own harness, and adopt the patch only if the invariant now holds. The next pass then posts a fresh
// bounty for the patched manifest ("repost after patch"). Seen commitIds and the adopted manifest per target live
// in .state/buyer-agent.json so restarts don't re-patch.
import { config as loadDotenv } from "dotenv";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Finding, Invariant, Manifest, Trace } from "@bugify/sdk";

// --- prelude: must run before env.ts (dotenv/config) and @bugify/sdk (DEMO reads BUGIFY_DEMO_SCALE) ---
process.env.DOTENV_CONFIG_QUIET ??= "true";
const agentsDir = resolve(import.meta.dir, "..");
loadDotenv({ path: resolve(agentsDir, ".env"), quiet: true });
// The Anthropic key lives in apps/server/.env; load that file into a private object so nothing else leaks in.
const serverEnv: Record<string, string> = {};
loadDotenv({ path: resolve(agentsDir, "../server/.env"), processEnv: serverEnv, quiet: true });
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || serverEnv.ANTHROPIC_API_KEY;
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || serverEnv.ANTHROPIC_BASE_URL;
process.env.AGENT_NAME ??= "buyer";

// Static imports are hoisted, so the load order above is only guaranteed with dynamic imports here.
const { RPC_URL, SERVER_URL, BAZAAR_ADDRESS, requireKey, flag, opt, sleep, compact } = await import("./env.ts");
const { createBazaar, explorerTx, manifestHash, DEMO } = await import("@bugify/sdk");
const { runSession } = await import("../../server/src/harness/runSession.ts");
const { evaluate } = await import("../../server/src/harness/evaluate.ts");
const { patchManifest, patcherModel } = await import("./patcher.ts");
const { emit } = await import("./log.ts");

const log = (line: string, level: "info" | "tx" | "warn" = "info") => emit(line, { agent: "buyer", level });

// ---------------------------------------------------------------------------
// Options and paths
// ---------------------------------------------------------------------------
const once = flag("once");
const noPost = flag("no-post");
const intervalMs = Math.max(1, Number(opt("interval") ?? 15)) * 1000;
const k = Math.max(1, Number(opt("k") ?? 1));
const targetsDir = resolve(agentsDir, opt("targets") ?? "manifests/targets");
const legacyDir = resolve(agentsDir, "manifests");
const redteamDir = resolve(agentsDir, "redteam");
const stateDir = resolve(agentsDir, ".state");
const stateFile = resolve(stateDir, "buyer-agent.json");
mkdirSync(redteamDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });

const rel = (p: string) => relative(agentsDir, p);
const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8"));
const jsonFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []);
/** "northwind-v3.json" → "northwind"; "northwind.json" → "northwind". */
const baseOf = (file: string) => basename(file).replace(/(?:-v\d+)?\.json$/, "");
const sameHash = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type State = { seen: number[]; targets: Record<string, { manifest: string }> };
function loadState(): State {
  if (flag("reset") || !existsSync(stateFile)) return { seen: [], targets: {} };
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf8")) as Partial<State>;
    return {
      seen: Array.isArray(s.seen) ? s.seen.filter((n) => Number.isInteger(n)) : [],
      targets: s.targets && typeof s.targets === "object" ? s.targets : {},
    };
  } catch {
    return { seen: [], targets: {} };
  }
}
const state = loadState();
const seen = new Set<number>(state.seen);
const saveState = () => writeFileSync(stateFile, JSON.stringify({ seen: [...seen].sort((a, b) => a - b), targets: state.targets }, null, 2));

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
const bz = createBazaar({ rpcUrl: RPC_URL, privateKey: requireKey("BUYER_KEY"), bazaarAddress: BAZAAR_ADDRESS, serverUrl: SERVER_URL });
const anthropic = ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: ANTHROPIC_API_KEY, ...(ANTHROPIC_BASE_URL ? { baseURL: ANTHROPIC_BASE_URL } : {}) })
  : undefined;
if (!anthropic) log("ANTHROPIC_API_KEY not found (apps/server/.env): findings will be logged but not patched", "warn");

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------
/** One target agent: `path` is the currently adopted manifest file; patches are written next to it as <base>-v<N>.json. */
type Target = { base: string; path: string; manifest: Manifest; bountyId?: number };

function targetFromPath(path: string, bountyId?: number): Target {
  return { base: baseOf(path), path, manifest: readManifest(path), bountyId };
}

/** The adopted file for a base name from state (if it still exists), else the original <base>.json. */
function adoptedPath(base: string): string {
  const remembered = state.targets[base]?.manifest;
  if (remembered && existsSync(resolve(targetsDir, remembered))) return resolve(targetsDir, remembered);
  return resolve(targetsDir, `${base}.json`);
}

async function discoverTargets(): Promise<Target[]> {
  const explicit = opt("manifest");
  const pinned = opt("bounty");
  if (explicit) {
    const candidates = [resolve(process.cwd(), explicit), resolve(agentsDir, explicit), resolve(targetsDir, explicit), resolve(legacyDir, explicit)];
    const path = candidates.find((p) => existsSync(p));
    if (!path) throw new Error(`--manifest ${explicit} not found`);
    return [targetFromPath(path)];
  }
  if (pinned !== undefined) {
    // Pin one target to the bounty we were told to watch: whichever manifest file hashes to its manifest_hash.
    const bountyId = Number(pinned);
    if (!Number.isInteger(bountyId)) throw new Error(`--bounty must be an integer, got ${pinned}`);
    const row = await bz.getBountyPublic(bountyId);
    const search = [...jsonFiles(targetsDir).map((f) => resolve(targetsDir, f)), ...jsonFiles(legacyDir).map((f) => resolve(legacyDir, f))];
    const path = search.find((p) => sameHash(manifestHash(readManifest(p)), row.manifest_hash));
    if (!path) throw new Error(`no manifest under ${rel(targetsDir)}/ or ${rel(legacyDir)}/ hashes to bounty #${bountyId}'s manifest ${row.manifest_hash}`);
    return [targetFromPath(path, bountyId)];
  }
  const bases = [...new Set(jsonFiles(targetsDir).filter((f) => !/-v\d+\.json$/.test(f)).map(baseOf))];
  if (bases.length === 0) throw new Error(`no target manifests under ${rel(targetsDir)}/ (pass --targets <dir> or --manifest <file>)`);
  return bases.map((b) => targetFromPath(adoptedPath(b)));
}

const targets = await discoverTargets();
for (const t of targets) {
  state.targets[t.base] = { manifest: basename(t.path) };
}
saveState();

log(`buyer ${bz.address}  balance ${await bz.balance()} ETH  server ${SERVER_URL}`);
log(`${targets.length} target(s) under ${rel(dirname(targets[0]!.path))}/  patcher ${patcherModel()}  regression k=${k}  interval ${intervalMs / 1000}s${once ? "  --once" : ""}${noPost ? "  --no-post" : ""}`);
for (const t of targets) {
  log(`[${t.base}] ${rel(t.path)} "${t.manifest.name}" (${t.manifest.model}, ${t.manifest.invariants.length} invariants)  hash ${manifestHash(t.manifest)}${t.bountyId !== undefined ? `  bounty #${t.bountyId}` : ""}`);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** (a) Find an OPEN bounty by this buyer for the target's current manifest hash, or post one. */
async function ensureBounty(t: Target): Promise<number | undefined> {
  const hash = manifestHash(t.manifest);
  const rows = await bz.listBounties();
  const open = rows.find((r) => r.status === "OPEN" && sameHash(r.manifest_hash, hash) && sameHash(r.buyer, bz.address));
  if (open) {
    log(`[${t.base}] OPEN bounty #${open.id} already covers manifest ${hash} ("${open.name}")`);
    return open.id;
  }
  if (noPost) {
    log(`[${t.base}] no OPEN bounty for manifest ${hash} and --no-post is set; nothing to poll`, "warn");
    return undefined;
  }
  const rewardsEth = t.manifest.invariants.map(() => DEMO.rewardEth);
  const slots = rewardsEth.map(() => 1);
  log(`[${t.base}] posting bounty for "${t.manifest.name}": ${rewardsEth.length} invariants × ${DEMO.rewardEth} ETH × 1 slot, bond ${DEMO.minBondEth} ETH, k=${DEMO.k}, expiry ${DEMO.expiryHours}h`);
  const posted = await bz.postBounty(t.manifest, { rewardsEth, slots, expiryHours: DEMO.expiryHours, minBondEth: DEMO.minBondEth, k: DEMO.k });
  log(`[${t.base}] bounty #${posted.bountyId} posted  manifest ${posted.manifestHash}  tx ${explorerTx(posted.txHash)}`, "tx");
  return Number(posted.bountyId);
}

const invLabel = (m: Manifest, i: number) => m.invariants[i]?.label ?? "?";

function logFinding(t: Target, f: Finding) {
  const p = `[${t.base}]`;
  log(`${p} ★ new finding commit #${f.commitId} on bounty #${f.bountyId}: invariant ${f.invariant} (${invLabel(t.manifest, f.invariant)})  hits ${f.hits}/${f.k}  class ${f.class}${f.breaksControl ? "  breaksControl" : ""}`);
  log(`${p}   attest ${explorerTx(f.attestTx)}`, "tx");
  log(`${p}   transcript (${f.transcript.turns.length} turns):`);
  f.transcript.turns.forEach((turn, i) => log(`${p}     ${i + 1}. ${turn}`));
  const trace = f.traces[0];
  if (!trace) return;
  log(`${p}   trace (replay 1/${f.traces.length}, ${trace.model}):`);
  trace.turns.forEach((turn, i) => {
    for (const tc of turn.toolCalls) log(`${p}     turn ${i + 1}  ${tc.name}(${compact(tc.input, 100)}) → ${compact(tc.result, 80)}`);
    log(`${p}     turn ${i + 1}  assistant: ${turn.assistant.replace(/\s+/g, " ").trim().slice(0, 160)}`);
  });
}

/** Replay the finding's transcript k times against `m` with the server harness; holds iff no replay violates. */
async function regression(t: Target, m: Manifest, f: Finding, client: Anthropic): Promise<{ holds: boolean; hits: number; traces: Trace[] }> {
  const inv: Invariant | undefined = m.invariants[f.invariant];
  if (!inv) throw new Error(`manifest has no invariant ${f.invariant}`);
  let hits = 0;
  const traces: Trace[] = [];
  for (let run = 1; run <= k; run++) {
    const trace = await runSession(m, f.transcript.turns, { anthropic: client });
    traces.push(trace);
    const r = evaluate(inv, trace);
    if (r.violated) hits++;
    const calls = trace.turns.flatMap((turn, i) => turn.toolCalls.map((tc) => `t${i + 1}:${tc.name}(${compact(tc.input, 60)})`));
    log(`[${t.base}]     replay ${run}/${k}: ${r.violated ? "VIOLATED" : "held"} — ${r.evidence}${calls.length ? `  [${calls.join(", ")}]` : "  [no tool calls]"}`);
  }
  return { holds: hits === 0, hits, traces };
}

/** Next patched path next to `path`: northwind.json → northwind-v2.json, northwind-v2.json → northwind-v3.json (skipping existing). */
function nextManifestPath(path: string): string {
  const dir = dirname(path);
  const m = /-v(\d+)\.json$/.exec(basename(path));
  let n = m ? Number(m[1]) + 1 : 2;
  while (existsSync(resolve(dir, `${baseOf(path)}-v${n}.json`))) n++;
  return resolve(dir, `${baseOf(path)}-v${n}.json`);
}

/** (c) One new finding: log → save → patch → regression-check → adopt or reject. */
async function handleFinding(t: Target, f: Finding): Promise<void> {
  const p = `[${t.base}]`;
  logFinding(t, f);
  const file = resolve(redteamDir, `finding-${f.commitId}.json`);
  writeFileSync(file, JSON.stringify(f, null, 2));
  log(`${p}   saved ${rel(file)}`);
  if (!anthropic) return;
  const label = invLabel(t.manifest, f.invariant);

  // A finding against an older manifest may already be fixed by the current one: check before patching again.
  if (!sameHash(f.transcript.manifestHash, manifestHash(t.manifest))) {
    log(`${p}   finding targets manifest ${f.transcript.manifestHash}, current is ${manifestHash(t.manifest)}: checking whether the current prompt already resists it`);
    const r = await regression(t, t.manifest, f, anthropic);
    if (r.holds) { log(`${p}   regression: invariant ${f.invariant} (${label}) already HOLDS on ${rel(t.path)}; no patch needed`); return; }
  }

  log(`${p}   patching ${rel(t.path)} with ${patcherModel()}…`);
  let patched: Manifest, diff: string, summary: string;
  try {
    ({ manifest: patched, diff, summary } = await patchManifest({ anthropic, manifest: t.manifest, finding: f }));
  } catch (e) {
    log(`${p}   patcher failed: ${(e as Error).message}`, "warn");
    return;
  }
  const outPath = nextManifestPath(t.path);
  writeFileSync(outPath, JSON.stringify(patched, null, 2) + "\n");
  log(`${p}   patch written to ${rel(outPath)} "${patched.name}"  hash ${manifestHash(patched)}`);
  log(`${p}   patch summary: ${summary}`);
  for (const line of diff.split("\n")) log(`${p}   | ${line}`);

  log(`${p}   regression check: replaying the ${f.transcript.turns.length}-turn exploit against ${rel(outPath)} (k=${k})…`);
  const r = await regression(t, patched, f, anthropic);
  if (r.holds) {
    log(`${p}   regression: invariant ${f.invariant} (${label}) now HOLDS on ${rel(outPath)} (0/${k} replays violated) — adopting it as the current manifest`);
    t.manifest = patched;
    t.path = outPath;
    state.targets[t.base] = { manifest: basename(outPath) };
    saveState();
    if (noPost) log(`${p}   --no-post: a new bounty for ${manifestHash(patched)} will not be posted; keep polling bounty #${t.bountyId}`, "warn");
    else { log(`${p}   a new bounty for the patched manifest will be posted on the next pass`); t.bountyId = undefined; }
  } else {
    log(`${p}   regression: invariant ${f.invariant} (${label}) still breaks on ${rel(outPath)} (${r.hits}/${k} replays violated) — patch rejected, keeping ${rel(t.path)}`, "warn");
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
for (;;) {
  let failed = false;
  for (const t of targets) {
    try {
      if (t.bountyId === undefined) t.bountyId = await ensureBounty(t);
      if (t.bountyId === undefined) continue;
      const findings = await bz.getFindings(t.bountyId);
      const fresh = findings.filter((f) => !seen.has(f.commitId)).sort((a, b) => a.commitId - b.commitId);
      log(`[${t.base}] bounty #${t.bountyId}: ${findings.length} finding(s), ${fresh.length} new`);
      for (const f of fresh) {
        seen.add(f.commitId);
        saveState();
        await handleFinding(t, f);
      }
    } catch (e) {
      failed = true;
      log(`[${t.base}] pass failed: ${(e as Error).message}`, "warn");
    }
  }
  if (once) process.exit(failed ? 1 : 0);
  await sleep(intervalMs);
}
