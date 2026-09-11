// Shared types for manifests, transcripts, traces and findings. Keep in sync with docs/ARCHITECTURE.md §2.

export type Hex = `0x${string}`;

/** Anthropic tool schema. */
export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };

/** Mocks are named behaviours with parameters, never code from the manifest. */
export type MockSpec =
  | { type: "static"; result: unknown }
  | { type: "identity"; customerEmail: string } // verify_identity: ok iff input.email === customerEmail
  | { type: "refund_ledger" } // issue_refund: records amount, returns { ok, refundId }
  | { type: "fixture"; rows: Record<string, unknown> }; // lookup_order: returns rows[input.id] or { error }

export type Invariant =
  | {
      kind: "tool_gate";
      label: string;
      tool: string;
      requires: { tool: string; resultMatch: Record<string, unknown> };
    }
  | { kind: "tool_sum_cap"; label: string; tool: string; arg: string; max: number }
  | { kind: "canary"; label: string; canary: string; normalize: "exact" | "digits" | "alnum" }
  | { kind: "forbidden_tool"; label: string; tool: string };

export type Manifest = {
  version: 1;
  name: string; // "Northwind support agent · PR #42"
  model: string; // pinned model id
  system: string; // PRIVATE
  tools: ToolDef[];
  mocks: Record<string, MockSpec>;
  invariants: Invariant[];
  maxTurns: number;
  buyerPubKey?: string; // v2 encryption
};

/** User turns only in v1. */
export type Transcript = { version: 1; manifestHash: Hex; invariant: number; turns: string[] };

export type ToolCall = { name: string; input: unknown; result: unknown };
export type Trace = { model: string; turns: Array<{ user: string; assistant: string; toolCalls: ToolCall[] }> };

export type Finding = {
  commitId: number;
  bountyId: number;
  invariant: number;
  transcript: Transcript;
  traces: Trace[];
  hits: number;
  k: number;
  breaksControl: boolean;
  attestTx: Hex;
  class: "feature" | "base-model";
};

// On-chain enums, mirrored from contracts/src/interfaces/IBazaar.sol. Order matters.
export const OUTCOMES = ["NONE", "PASS", "PASS_NO_SLOT", "FAIL", "VOID", "RECLAIMED"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const BOUNTY_STATUSES = ["OPEN", "VOIDED", "CLOSED"] as const;
export type BountyStatus = (typeof BOUNTY_STATUSES)[number];
export const DISPUTE_STATES = ["NONE", "OPEN", "RESOLVED"] as const;
export type DisputeState = (typeof DISPUTE_STATES)[number];

export const outcomeIndex = (o: Outcome): number => OUTCOMES.indexOf(o);
export const outcomeName = (i: number): Outcome => OUTCOMES[i] ?? "NONE";
export const bountyStatusName = (i: number): BountyStatus => BOUNTY_STATUSES[i] ?? "OPEN";
export const disputeStateName = (i: number): DisputeState => DISPUTE_STATES[i] ?? "NONE";

/** Row shape served by GET /bounties (from the public_bounties view). Wei as decimal strings. */
export type PublicBounty = {
  id: number;
  buyer: Hex;
  manifest_hash: Hex;
  control_hash: Hex | null;
  name: string;
  model: string;
  invariant_labels: string[];
  rewards_wei: string[];
  slots: number[];
  expiry: string; // ISO
  min_bond_wei: string;
  k: number;
  control_tier_bps: number;
  status: BountyStatus;
  escrow_wei: string | null;
  tx_hash: Hex | null;
};
