import type { Outcome } from "@bugify/sdk";

/** One source for every hover tooltip on the board. Keep each entry to one or two sentences. */
export const GLOSSARY = {
  escrow:
    "Reward × slots for every invariant, locked in the Bazaar contract when the bounty is posted. Paid out per PASS; whatever is left is refunded to the buyer at expiry.",
  slashed: "Bonds forfeited by sellers whose commits attested FAIL. They go to the treasury, not to the buyer.",
  invariants:
    "Machine-checkable rules the target agent must keep: tool ordering, per-session spend caps, forbidden tools, secret canaries. Each has its own reward and slot count, and is checked by a trace predicate, not an LLM judge.",
  slots:
    "How many findings per invariant get paid. Once the paid slots are used, further valid findings settle PASS_NO_SLOT: bond back, no reward.",
  commits:
    "Seller submissions. Each is a bond plus keccak(transcript ‖ salt) posted on chain before the transcript is revealed, so nobody can front-run or edit it.",
  hitsK:
    "Of the k independent replays the verifier ran, how many reproduced the violation. PASS needs at least one hit; the bar is grey on FAIL.",
  bond: "Stake the seller posts with each commit (≥ the bounty's min bond). Returned on PASS, PASS_NO_SLOT and VOID; slashed to the treasury on FAIL.",
  seq: "Position in the FIFO queue for this invariant. Reveals are verified strictly in commit order, so a later seller can't jump ahead of an earlier one.",
  progress: "commit → attest → dispute (optional) → settle. A lit dot links to that step's transaction.",
  controlTier:
    "If a control manifest (the base model with no product prompt) also breaks the invariant, the bug is in the model, not the buyer's feature: the seller is paid this share of the reward (in basis points) instead of the full amount.",
  minBond: "Smallest bond a seller may post on this bounty. Set high enough that spam reveals cost more than they could win.",
  k: "How many independent replays the verifier runs per reveal, each with fresh mock state at temperature 0. More replays, fewer flukes.",
  outcome: {
    NONE: "Committed but not yet attested. The bond and commitment hash are on chain; the verifier is waiting for the reveal.",
    PASS: "Verified: at least one of the k replays reproduced the violation. After the dispute window the seller gets the reward plus their bond back.",
    PASS_NO_SLOT: "Valid but all paid slots were taken; bond returned, no reward.",
    FAIL: "No replay reproduced the violation, or the reveal did not match the commitment. The bond is slashed to the treasury.",
    VOID: "Target unrunnable, no slash. The bond is returned and nothing is paid.",
    RECLAIMED: "Verifier never attested; seller took the bond back.",
  } satisfies Record<Outcome, string>,
} as const;
