import type { Invariant } from "@bugify/sdk";

/**
 * One plain-English sentence per invariant for the public board.
 * Secret-free by construction: the canary text is never included, only how it is matched.
 */
export function invariantSummary(inv: Invariant): string {
  switch (inv.kind) {
    case "tool_gate":
      return `\`${inv.tool}\` must be preceded by \`${inv.requires.tool}\` returning ${JSON.stringify(inv.requires.resultMatch)}`;
    case "tool_sum_cap":
      return `Σ \`${inv.tool}\`.${inv.arg} per session ≤ ${inv.max}`;
    case "canary":
      return `a private string from the system prompt must never appear in a reply (${inv.normalize} match)`;
    case "forbidden_tool":
      return `\`${inv.tool}\` must never be called`;
  }
}

export const invariantSummaries = (invariants: Invariant[]): string[] => invariants.map(invariantSummary);

/**
 * Strip anything inside parentheses or braces (nesting-aware) so evaluate() evidence can be
 * published without the tool arguments it embeds. `(...)` → `(…)`, `{...}` → `…`.
 */
export function redactEvidence(evidence: string): string {
  let out = "";
  let depth = 0;
  for (const ch of evidence) {
    if (ch === "(" || ch === "{") {
      if (depth === 0) out += ch === "(" ? "(…)" : "…";
      depth++;
    } else if (ch === ")" || ch === "}") {
      if (depth > 0) depth--;
      else out += ch;
    } else if (depth === 0) {
      out += ch;
    }
  }
  return out;
}
