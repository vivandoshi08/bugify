import type { BountyRow, CommitRow } from "@/lib/queries";

/** "Northwind support agent · PR #42" → { family: "Northwind support agent", pr: 42 }. */
export function splitName(name: string): { family: string; pr: number | null } {
  const m = /^(.*?)\s*·\s*PR\s*#\s*(\d+)\s*$/u.exec(name);
  if (!m) return { family: name.trim(), pr: null };
  return { family: m[1].trim(), pr: Number(m[2]) };
}

/** Backticked identifiers in invariant summaries are the tool names the agent exposes. */
export function toolsFromSummaries(summaries: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const s of summaries) {
    if (!s) continue;
    for (const m of s.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) out.add(m[1]);
  }
  return [...out].sort();
}

export const isFinding = (c: CommitRow): boolean => c.outcome === "PASS" || c.outcome === "PASS_NO_SLOT";

export type InvariantStat = { index: number; label: string; summary: string | null; reward: string; slotsUsed: number; slots: number; passes: number };

export type Version = {
  bounty: BountyRow;
  pr: number | null;
  commits: CommitRow[];
  findings: number; // PASS + PASS_NO_SLOT
  passes: number; // PASS only (paid slots)
  invariants: InvariantStat[];
  /** A newer build than one the Bazaar already broke: the deployer shipped a fix. */
  patched: boolean;
};

export type Family = {
  name: string;
  versions: Version[]; // newest first
  tools: string[];
  latest: Version;
  openFindings: number; // latest version's PASS count
};

/** Newest first: PR number desc, then bounty id desc (bounty id breaks ties for repeated PRs). */
const newerFirst = (a: Version, b: Version) => (b.pr ?? -1) - (a.pr ?? -1) || b.bounty.id - a.bounty.id;

export function groupFamilies(bounties: BountyRow[], commits: CommitRow[]): Family[] {
  const byBounty = new Map<number, CommitRow[]>();
  for (const c of commits) byBounty.set(c.bounty_id, [...(byBounty.get(c.bounty_id) ?? []), c]);

  const groups = new Map<string, Version[]>();
  for (const b of bounties) {
    const { family, pr } = splitName(b.name);
    const cs = byBounty.get(b.id) ?? [];
    const invariants: InvariantStat[] = b.rewards_wei.map((reward, i) => {
      const passes = cs.filter((c) => c.invariant === i && c.outcome === "PASS").length;
      const slots = b.slots[i] ?? 0;
      return { index: i, label: b.invariant_labels[i] ?? `#${i}`, summary: b.invariant_summaries?.[i] ?? null, reward, slotsUsed: Math.min(passes, slots), slots, passes };
    });
    const v: Version = {
      bounty: b, pr, commits: cs,
      findings: cs.filter(isFinding).length,
      passes: cs.filter((c) => c.outcome === "PASS").length,
      invariants, patched: false,
    };
    groups.set(family, [...(groups.get(family) ?? []), v]);
  }

  const families: Family[] = [];
  for (const [name, versions] of groups) {
    versions.sort(newerFirst);
    // "patched": any version newer than a version that has at least one PASS.
    for (let i = 0; i < versions.length; i++) versions[i].patched = versions.slice(i + 1).some((older) => older.passes > 0);
    const latest = versions[0];
    families.push({
      name, versions, latest,
      tools: toolsFromSummaries(versions.flatMap((v) => v.bounty.invariant_summaries ?? [])),
      openFindings: latest.passes,
    });
  }
  return families.sort((a, b) => a.name.localeCompare(b.name));
}

/** What each Northwind agent does, keyed by family name (static: manifests' system prompts are private). */
export const FAMILY_BLURBS: Record<string, string> = {
  "Northwind support agent":
    "Live-chat support for meal-kit subscribers: looks up orders, handles cancellations and issues refunds for missed or damaged boxes.",
  "Northwind billing agent":
    "Billing support: explains invoices, applies goodwill credits and updates the payment method on file.",
  "Northwind delivery agent":
    "Delivery support: looks up upcoming boxes, changes the delivery address and reschedules drop-offs.",
};

const BLURB_HINTS: Array<[RegExp, string]> = [
  [/support/i, FAMILY_BLURBS["Northwind support agent"]],
  [/billing/i, FAMILY_BLURBS["Northwind billing agent"]],
  [/deliver|booking/i, FAMILY_BLURBS["Northwind delivery agent"]],
];

export function blurbFor(family: string): string {
  if (FAMILY_BLURBS[family]) return FAMILY_BLURBS[family];
  for (const [re, text] of BLURB_HINTS) if (re.test(family)) return text;
  return "A production LLM agent Northwind runs behind its customer chat.";
}
