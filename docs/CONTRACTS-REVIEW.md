# Contract spec review

Review of `CONTRACTS.md` / `contract-flows.html` against the product goal (buyer commits money to an
outcome, never to a seller's claim; seller commits a hash before anyone sees anything; a verifier
replays and a contract settles). Verdict first, then what was changed in the implementation, then
what was deliberately left alone.

## Verdict

The design is sound and small. The three decisions that make it work are all present:

1. **Escrow before evidence.** `postBounty` locks `Σ reward·slots` and `expire` cannot return it while
   `pending > 0`. The buyer has no "see then decide" step anywhere.
2. **Commit-reveal with FIFO per invariant.** `commitment = keccak(contentHash ‖ salt)` is posted
   before reveal, and `attest` must consume commits in `seq` order. A verifier cannot reorder who was
   first, and a seller whose reveal does not match the commit gets `FAIL` (bond slashed), never a
   payout.
3. **Payout is a function of the attestation, not of the buyer.** `finalize` is permissionless and
   the only path that pays a seller. The buyer's sole lever is `dispute`, which costs a bond and is
   decided by the arbiter.

Everything with money or ordering is in one contract, everything trust-shaped (verifier, arbiter) is
an address behind an interface, and reputation/manifests/transcripts are off-chain. That is the right
split for v1.

## Changes made while implementing (all additive, none change the spec'd flows)

| Change | Why |
|---|---|
| Error `BountyExpired` renamed to `PastExpiry` | Solidity forbids an error and an event with the same name; the event is what the indexer reads, so the event kept the name. |
| `BondTooHigh` on `commit` / `dispute` when `msg.value > uint96.max` | Both bonds are stored as `uint96`. Without the check the contract would silently truncate and the conservation invariant (§6.1) would break. |
| `NoControl` on `attest` when `breaksControl == true` but `controlHash == 0x0` | A tiered payout on a bounty that has no control manifest is a verifier bug; cheaper to reject on-chain than to pay a wrong tier. |
| `NoSuchBounty` checked in `cancel`, `voidBounty`, `expire`, `getBounty` | Spec only lists it for `commit`; array out-of-bounds would otherwise surface as a panic. |
| `ZeroAddress` on constructor and setters | A zero arbiter or treasury would brick disputes / burn slashed bonds. |
| Config-change events (`VerifierSetUpdated`, `ArbiterUpdated`, `TreasuryUpdated`, `TimingsUpdated`, `OwnershipTransferred`) | The indexer needs to know when trust roots rotate. |
| `getBounty` returns a `BountyInfo` struct (scalars + `invariantCount`) | Spec says "all scalar fields"; a struct is easier for viem than a 10-tuple. |
| `Finalized.paidToSeller` is the reward portion only (0 for PASS_NO_SLOT / VOID / FAIL) | §4 defines `paid` separately from the bond and §7 `test_HappyPath` asserts `Finalized(paid=0.02)` with a 0.002 bond. The bond is already known from `Committed`. §6.6 (`paidToSeller - bond ≤ reward`) reads as if the bond were included; the tests treat §7 as authoritative. |
| `via_ir = true` in `foundry.toml` | `postBounty` (8 params + a 10-field event) is stack-too-deep under the legacy pipeline. |

## Deployment (Base Sepolia, 2026-09-11)

| Contract | Address |
|---|---|
| Bazaar | `0x1F49d4C3473FB7Ee51A79FbAa0CBb6165c408839` |
| SingleVerifier | `0xe3789C8bdb4D698A13ceF60C929478936b8A3257` |

Verifier, arbiter and treasury are all the platform deployer key for v1. Demo timings: 10 min attest
timeout, 60 s dispute window, 0.005 ETH dispute bond, 10 min cancel grace.

## Things worth knowing that the spec does not say out loud

- **Commit squatting is bounded by bond, not prevented.** Anyone watching the mempool can copy a
  seller's `commitment` and land first. They cannot reveal, so they get `FAIL` and lose the bond, and
  the honest seller is next in the queue. Cost to the attacker is one bond and the delay is one
  `attest`. If this becomes a problem, bind the seller into the commitment
  (`keccak(contentHash ‖ salt ‖ seller)`); that needs the SDK to change in lockstep, so it is not done
  here.
- **`setTimings` applies to in-flight commits.** A window change mid-dispute moves the goalposts for
  existing commits. Acceptable for v1 (single operator); a v2 should snapshot timings onto the bounty.
- **`attest` on a VOIDED bounty can still pay from escrow.** Intentional: a seller whose exploit was
  verified before the model vanished is still owed. The verifier is trusted not to attest PASS after
  it has voided.
- **Tiered payouts round down.** `reward · bps / 10000` truncates; a 3-wei reward at 3333 bps pays 0.
  Irrelevant at real reward sizes, covered by a test so nobody is surprised.
- **Dispute griefing costs the griefer.** A buyer who disputes every PASS pays `disputeBond` to the
  seller each time the arbiter upholds. A seller who disputes every FAIL pays it to the buyer.
- **Owner is a single key that can rotate the verifier and arbiter.** Same operator as the verifier
  in v1. The flows doc is honest about this; nothing on-chain enforces independence yet.

## Accepted edges (kept exactly as specified, §12)

- A `PASS_NO_SLOT` that was finalized before a later dispute frees a slot is not retroactively paid.
- Priority does not carry across reposted bounties.
- `attest` ignores `attestTimeout`; a late verifier can still attest until the seller reclaims.
- Reputation is off-chain.
