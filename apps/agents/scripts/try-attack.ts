// Local harness check (no chain, no server): replay an attack file against a manifest with the
// server's own runSession/evaluate and print the trace + VIOLATED / not violated.
//
//   bun run try --manifest manifests/northwind.json --attack attacks/generic.json [--k 2]
//
// Loads apps/server/.env so ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL, if set) are picked up.
import { config } from "dotenv";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { Manifest } from "@bugify/sdk";
import { runSession } from "../../server/src/harness/runSession.ts";
import { evaluate } from "../../server/src/harness/evaluate.ts";

config({ path: resolve(import.meta.dir, "../../server/.env") });
config({ path: resolve(import.meta.dir, "../.env") });

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const manifestPath = opt("manifest");
const attackPath = opt("attack");
if (!manifestPath || !attackPath) {
  console.error("usage: bun run try --manifest <path> --attack <path> [--k <n>]");
  process.exit(2);
}
const k = Math.max(1, Number(opt("k") ?? 1));
const fromCwd = (p: string) => resolve(process.cwd(), p);
const manifest: Manifest = JSON.parse(readFileSync(fromCwd(manifestPath), "utf8"));
const attack: { invariant: number; turns: string[] } = JSON.parse(readFileSync(fromCwd(attackPath), "utf8"));
const inv = manifest.invariants[attack.invariant];
if (!inv) { console.error(`manifest has no invariant ${attack.invariant}`); process.exit(2); }
if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY not set (expected in apps/server/.env)"); process.exit(2); }

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
});
const compact = (v: unknown, max = 200) => { const s = JSON.stringify(v); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

console.log(`manifest "${manifest.name}" (${manifest.model})  attack ${attackPath}  invariant ${attack.invariant} (${inv.label})  k=${k}\n`);
let hits = 0;
for (let run = 1; run <= k; run++) {
  if (k > 1) console.log(`=== replay ${run}/${k}`);
  const trace = await runSession(manifest, attack.turns, { anthropic });
  for (const [i, t] of trace.turns.entries()) {
    console.log(`── turn ${i + 1}/${trace.turns.length}`);
    console.log(`user      > ${t.user.replace(/\s+/g, " ").slice(0, 220)}${t.user.length > 220 ? "…" : ""}`);
    for (const tc of t.toolCalls) console.log(`  tool    · ${tc.name}(${compact(tc.input)}) → ${compact(tc.result)}`);
    console.log(`assistant < ${t.assistant.replace(/\s+/g, " ").trim()}`);
  }
  const r = evaluate(inv, trace);
  if (r.violated) hits++;
  console.log(`\n${r.violated ? "VIOLATED" : "not violated"}  invariant ${attack.invariant} — ${r.evidence}\n`);
}
console.log(`result: ${hits}/${k} replays violated invariant ${attack.invariant}`);
process.exit(hits >= 1 ? 0 : 1);
