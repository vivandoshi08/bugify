// Shared: play an attack file against a practice session and print the trace.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Bazaar, PublicBounty } from "@bugify/sdk";
import { compact } from "./env.ts";

export type Attack = { invariant: number; turns: string[] };
export const attacksDir = resolve(import.meta.dir, "../attacks");
export const loadAttack = (file: string): Attack => JSON.parse(readFileSync(resolve(attacksDir, file), "utf8"));

export async function playAttack(bz: Bazaar, bountyId: bigint, attack: Attack) {
  const session = await bz.openSession(bountyId);
  console.log(`session ${session.sessionId} on bounty ${bountyId}, invariant ${attack.invariant}\n`);
  const violated = new Set<number>();
  for (const [i, text] of attack.turns.entries()) {
    console.log(`── turn ${i + 1}/${attack.turns.length}`);
    console.log(`user      > ${text}`);
    const r = await session.say(text);
    for (const tc of r.toolCalls) console.log(`  tool    · ${tc.name}(${compact(tc.input)}) → ${compact(tc.result)}`);
    console.log(`assistant < ${r.assistant.replace(/\s+/g, " ").trim()}`);
    console.log(`violations: ${JSON.stringify(r.violations)}\n`);
    for (const v of r.violations) violated.add(v);
  }
  const hit = violated.has(attack.invariant);
  console.log(hit ? `practice: invariant ${attack.invariant} violated ✔` : `practice: invariant ${attack.invariant} NOT violated (submitting anyway)`);
  return { hit, violated: [...violated] };
}

export function pickBounty(bounties: PublicBounty[], wanted?: string) {
  if (wanted) {
    const b = bounties.find((x) => String(x.id) === wanted);
    if (!b) throw new Error(`bounty ${wanted} not found on server`);
    return b;
  }
  const open = bounties.filter((b) => b.status === "OPEN" && new Date(b.expiry).getTime() > Date.now()).sort((a, b) => b.id - a.id);
  if (!open[0]) throw new Error("no OPEN bounty on the server; run `bun run buyer` first");
  return open[0];
}
