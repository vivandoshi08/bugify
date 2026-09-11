import type { Hex, Outcome, Trace, Transcript } from "@bugify/sdk";
import { env } from "@/lib/env";
import { supabase } from "@/lib/supabase";

/**
 * The verifier API base URL. The demo launcher publishes its tunnel URL to `meta.serverUrl` so the
 * public board finds the server at runtime; NEXT_PUBLIC_SERVER_URL is the build-time fallback.
 */
let serverUrlCache: { value: string; at: number } | null = null;
export async function serverUrl(): Promise<string> {
  if (serverUrlCache && Date.now() - serverUrlCache.at < 30_000) return serverUrlCache.value;
  let value = env.serverUrl;
  try {
    const { data } = await supabase.from("meta").select("value").eq("key", "serverUrl").maybeSingle();
    if (data?.value && /^https?:\/\//.test(data.value)) value = data.value.replace(/\/$/, "");
  } catch {
    /* fall back to env */
  }
  serverUrlCache = { value, at: Date.now() };
  return value;
}

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
  const base = await serverUrl();
  try {
    res = await fetch(`${base}/commits/${commitId}/finding`, { cache: "no-store" });
  } catch {
    return { status: "error", message: `server unreachable at ${base}` };
  }
  if (res.status === 404) return { status: "private" };
  if (!res.ok) return { status: "error", message: `${res.status} ${await res.text().catch(() => "")}`.trim() };
  return { status: "ok", finding: (await res.json()) as DemoFinding };
}
