import type { Hex, Outcome, PublicBounty } from "@bugify/sdk";
import { supabase } from "@/lib/supabase";

/** Row from the `public_bounties` view (bounties ⋈ manifests). */
export type BountyRow = PublicBounty & {
  pending: boolean | null;
  block: number | null;
};

export type DisputeState = "NONE" | "OPEN" | "RESOLVED";

/** Row from `commits`. Wei as decimal strings; tx columns are hashes or null. */
export type CommitRow = {
  id: number;
  bounty_id: number;
  invariant: number;
  seq: number;
  seller: Hex;
  commitment: string;
  bond_wei: string;
  outcome: Outcome;
  hits: number | null;
  breaks_control: boolean | null;
  content_hash: string | null;
  trace_hash: string | null;
  attested_at: string | null;
  attest_tx: string | null;
  dispute: DisputeState;
  disputer: string | null;
  dispute_tx: string | null;
  resolve_tx: string | null;
  finalized: boolean;
  finalize_tx: string | null;
  reclaim_tx: string | null;
  paid_wei: string | null;
  commit_tx: string | null;
  created_at: string;
};

/** Row from `events`. */
export type EventRow = {
  id: number;
  block: number | null;
  tx_hash: string | null;
  log_index: number | null;
  name: string;
  args: Record<string, unknown> | null;
  created_at: string;
};

export const EVENT_LIMIT = 100;

export async function fetchBounties(): Promise<BountyRow[]> {
  const { data, error } = await supabase.from("public_bounties").select("*");
  if (error) throw error;
  return (data ?? []) as BountyRow[];
}

export async function fetchCommits(): Promise<CommitRow[]> {
  const { data, error } = await supabase
    .from("commits")
    .select("*")
    .order("bounty_id", { ascending: true })
    .order("seq", { ascending: true });
  if (error) throw error;
  return (data ?? []) as CommitRow[];
}

export async function fetchEvents(): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .order("id", { ascending: false })
    .limit(EVENT_LIMIT);
  if (error) throw error;
  return (data ?? []) as EventRow[];
}
