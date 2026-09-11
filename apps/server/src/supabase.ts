import { createClient } from "@supabase/supabase-js";
import type { Manifest } from "@bugify/sdk";
import { env } from "./env.ts";
import { invariantSummaries } from "./harness/summaries.ts";

export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

export const lower = (s: string) => s.toLowerCase();
export const wei = (v: bigint | number | string) => BigInt(v).toString();
export const iso = (unix: bigint | number) => new Date(Number(unix) * 1000).toISOString();
/** JSON.stringify replacer: bigint → decimal string. */
export const jsonSafe = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

function check<T>(label: string, r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(`[supabase] ${label}: ${r.error.message}`);
  return r.data;
}

// ---- manifests ----
export async function upsertManifest(hash: string, m: Manifest) {
  check("manifests upsert", await db.from("manifests").upsert({
    hash: lower(hash), name: m.name, model: m.model, body: m, invariant_labels: m.invariants.map((i) => i.label),
    invariant_summaries: invariantSummaries(m.invariants),
  }));
}
export async function getManifest(hash: string): Promise<Manifest | null> {
  const row = check("manifests get", await db.from("manifests").select("body").eq("hash", lower(hash)).maybeSingle());
  return (row?.body as Manifest) ?? null;
}

// ---- bounties ----
export type BountyRow = Record<string, unknown> & { id: number };
export const upsertBounty = async (row: BountyRow) => { check("bounties upsert", await db.from("bounties").upsert(row)); };
export const updateBounty = async (id: number | bigint, patch: Record<string, unknown>) => {
  check("bounties update", await db.from("bounties").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", Number(id)));
};
export const getBountyRow = async (id: number) =>
  check("bounties get", await db.from("bounties").select("*").eq("id", id).maybeSingle());
export const listPublicBounties = async () =>
  check("public_bounties list", await db.from("public_bounties").select("*").order("id", { ascending: false })) ?? [];

// ---- commits ----
export const upsertCommit = async (row: Record<string, unknown> & { id: number }) => { check("commits upsert", await db.from("commits").upsert(row)); };
export const updateCommit = async (id: number | bigint, patch: Record<string, unknown>) => {
  check("commits update", await db.from("commits").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", Number(id)));
};
export const getCommitRow = async (id: number) =>
  check("commits get", await db.from("commits").select("*").eq("id", id).maybeSingle());
export const listCommitsForBounty = async (bountyId: number) =>
  check("commits list", await db.from("commits").select("*").eq("bounty_id", bountyId).order("id", { ascending: true })) ?? [];
/** Attested, undisputed, unfinalized commits whose dispute window closed before `before` (ISO). */
export const listSettleable = async (before: string) =>
  check("commits settleable", await db.from("commits").select("id, outcome, attested_at")
    .eq("finalized", false).eq("dispute", "NONE").in("outcome", ["PASS", "PASS_NO_SLOT", "FAIL", "VOID"]).lt("attested_at", before)) ?? [];

// ---- findings ----
export const insertFinding = async (row: { commit_id: number; bounty_id: number; buyer: string; transcript: unknown; traces: unknown }) => {
  check("findings upsert", await db.from("findings").upsert({ ...row, buyer: lower(row.buyer) }));
};
export const getFinding = async (commitId: number) =>
  check("findings get", await db.from("findings").select("*").eq("commit_id", commitId).maybeSingle());
export const listFindings = async (bountyId: number) =>
  check("findings list", await db.from("findings").select("*").eq("bounty_id", bountyId).order("commit_id")) ?? [];

// ---- events / meta ----
export const upsertEvent = async (row: { name: string; args: unknown; block: number; tx_hash: string; log_index: number }) => {
  check("events upsert", await db.from("events").upsert({ ...row, tx_hash: lower(row.tx_hash) }, { onConflict: "tx_hash,log_index" }));
};
export const getMeta = async (key: string): Promise<string | null> =>
  (check("meta get", await db.from("meta").select("value").eq("key", key).maybeSingle()))?.value ?? null;
export const setMeta = async (key: string, value: string) => { check("meta set", await db.from("meta").upsert({ key, value })); };

// ---- agent_logs (live agent console) ----
export type AgentLogLevel = "info" | "tx" | "warn";
export type AgentLogRow = { agent: string; level: AgentLogLevel; line: string; ts?: string };
export const insertAgentLog = async (row: AgentLogRow) => {
  check("agent_logs insert", await db.from("agent_logs").insert({ agent: row.agent, level: row.level, line: row.line, ...(row.ts ? { ts: row.ts } : {}) }));
};
/** Delete console lines older than `hours` (called once on boot). */
export const pruneAgentLogs = async (hours = 24) => {
  const before = new Date(Date.now() - hours * 3600_000).toISOString();
  check("agent_logs prune", await db.from("agent_logs").delete().lt("ts", before));
};
