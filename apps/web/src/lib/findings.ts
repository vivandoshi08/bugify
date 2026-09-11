import type { Hex, Outcome, Trace, Transcript } from "@bugify/sdk";
import { env } from "@/lib/env";

/** Invariant definition as served by the demo route: everything except the canary text. */
export type InvariantSpec =
  | { kind: "tool_gate"; label: string; tool: string; requires: { tool: string; resultMatch: Record<string, unknown> } }
  | { kind: "tool_sum_cap"; label: string; tool: string; arg: string; max: number }
  | { kind: "canary"; label: string; normalize: "exact" | "digits" | "alnum" }
  | { kind: "forbidden_tool"; label: string; tool: string };

/** GET /commits/:cid/finding (DEMO_PUBLIC_FINDINGS only). */
export type DemoFinding = {
  commitId: number;
  bountyId: number;
  invariant: number;
  label: string | null;
  summary: string | null;
  spec: InvariantSpec | null;
  transcript: Transcript;
  traces: Trace[];
  evaluations: Array<{ violated: boolean; evidence: string }>;
  hits: number;
  k: number;
  breaksControl: boolean;
  outcome: Outcome | null;
  seller: Hex | null;
  attestTx: string | null;
  class: "feature" | "base-model";
  demo: true;
};

export type FindingResult =
  | { status: "ok"; finding: DemoFinding }
  | { status: "private" }
  | { status: "error"; message: string };

/** 404 (flag off, or no finding row) → "private": the board never distinguishes the two. */
export async function fetchFinding(commitId: number): Promise<FindingResult> {
  let res: Response;
  try {
    res = await fetch(`${env.serverUrl}/commits/${commitId}/finding`, { cache: "no-store" });
  } catch {
    return { status: "error", message: `server unreachable at ${env.serverUrl}` };
  }
  if (res.status === 404) return { status: "private" };
  if (!res.ok) return { status: "error", message: `${res.status} ${await res.text().catch(() => "")}`.trim() };
  return { status: "ok", finding: (await res.json()) as DemoFinding };
}
