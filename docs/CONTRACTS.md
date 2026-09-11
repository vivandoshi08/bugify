# Black Box Bazaar — Contract Specification

Written for a coding agent. Implement exactly this in Solidity ^0.8.24 with Foundry. Where the spec says "revert X", define a custom error `X`. Where it says "emit", define the event with the listed fields. Nothing here is optional unless marked *v2*.

Chain: Base Sepolia (chainId 84532). Currency: native ETH everywhere. No ERC20, no swaps.

---

## 1. What the contracts do

A buyer (usually an autonomous coding agent) posts a **bounty** against a **manifest hash** (an off-chain bundle describing an LLM agent under test) with a list of **invariants**, each with its own reward and slot count, and locks the full reward total in escrow. A seller (a red-team agent) that believes it has a transcript that breaks an invariant posts a **commit** (a hash of the transcript) with a bond. A **verifier** (off-chain service, allowlisted by `IVerifierSet`) replays the transcript and posts an **attestation**. After a **dispute window**, anyone calls **finalize** and the money moves: a PASS pays the seller, a FAIL slashes the bond to the treasury. The buyer never chooses whether to pay; it chose when it posted.

Three contracts:

| Contract | Responsibility | v1 |
|---|---|---|
| `Bazaar` | All escrow, commitments, attestations, disputes, settlement, ordering | required |
| `SingleVerifier` (implements `IVerifierSet`) | Says which address may attest/void | required |
| `BudgetVault` | Optional per-buyer spend cap; acts as the buyer from Bazaar's point of view | optional |

Deliberately **not** contracts: reputation (computed off-chain from events), treasury (an address), manifests/transcripts/traces (off-chain, referenced by hash).

---

## 2. Interfaces and types

```solidity
interface IVerifierSet {
    function canAttest(address who) external view returns (bool);
}

enum BountyStatus { OPEN, VOIDED, CLOSED }
enum Outcome      { NONE, PASS, PASS_NO_SLOT, FAIL, VOID, RECLAIMED }
enum DisputeState { NONE, OPEN, RESOLVED }

struct Invariant {
    uint96 reward;       // wei paid for one verified PASS on this invariant
    uint8  slots;        // how many PASSes are payable (default 1)
    uint8  slotsUsed;    // taken at attest, released only by resolve(PASS→FAIL)
    uint32 cursor;       // seq of the next commit that must be attested (FIFO)
    uint32 commitCount;  // next seq to assign
}

struct Bounty {
    address      buyer;
    bytes32      manifestHash;
    bytes32      controlHash;     // 0x0 if no control manifest
    uint64       expiry;          // unix seconds; commit allowed while now < expiry
    uint96       minBond;
    uint8        k;               // replays per verification (informational, ≥1)
    uint16       controlTierBps;  // payout bps when breaksControl (≤ 10000)
    uint128      escrow;          // remaining locked reward
    uint32       pending;         // commits not yet finalized/reclaimed
    BountyStatus status;
    Invariant[]  inv;
}

struct Commit {
    uint64       bountyId;
    uint8        inv;
    uint32       seq;             // position within (bountyId, inv)
    address      seller;
    bytes32      commitment;      // keccak256(abi.encodePacked(contentHash, salt))
    uint96       bond;
    uint64       committedAt;
    Outcome      outcome;
    uint8        hits;
    bool         breaksControl;
    bool         slotHeld;
    bytes32      contentHash;     // keccak256 of canonical transcript bytes (set at attest)
    bytes32      traceHash;       // keccak256 of canonical replay traces (set at attest)
    uint64       attestedAt;
    DisputeState dispute;
    address      disputer;
    uint96       disputeBond;
    bool         finalized;
}
```

Commitment scheme (must match the TypeScript SDK byte-for-byte):

```
contentHash = keccak256(utf8(stableStringify(transcript)))
commitment  = keccak256(abi.encodePacked(bytes32 contentHash, bytes32 salt))
```

---

## 3. `Bazaar` storage and config

```solidity
Bounty[] internal bounties;     // bountyId = index
Commit[] internal commits;      // commitId = index
mapping(address => uint256) public owed;   // pull-payment fallback (see §5)

address       public owner;
IVerifierSet  public verifierSet;
address       public arbiter;
address       public treasury;
uint64        public attestTimeout;   // seller may reclaim after committedAt + this
uint64        public disputeWindow;   // finalize allowed after attestedAt + this
uint96        public disputeBond;     // required msg.value for dispute()
uint64        public cancelGrace;     // cancel() sets expiry = min(expiry, now + this)
```

Constructor: `(IVerifierSet verifierSet, address arbiter, address treasury, uint64 attestTimeout, uint64 disputeWindow, uint96 disputeBond, uint64 cancelGrace)`; `owner = msg.sender`.

Owner setters: `setVerifierSet`, `setArbiter`, `setTreasury`, `setTimings(attestTimeout, disputeWindow, disputeBond, cancelGrace)`, `transferOwnership`. All `onlyOwner` (revert `NotOwner`).

Demo timings: `attestTimeout = 10 min`, `disputeWindow = 60 s`, `disputeBond = 0.005 ether`, `cancelGrace = 10 min`. Production: 24 h / 24 h / 0.05 / 1 h.

Views (return memory copies): `bountyCount()`, `commitCount()`, `getBounty(id)` (all scalar fields), `invariantCount(id)`, `getInvariant(id, i)`, `getCommit(id)`.

---

## 4. `Bazaar` functions

Every function below lists **who**, **requires** (in order; each failure is a custom error), **effects**, **emits**. "now" is `block.timestamp`.

### `postBounty(bytes32 manifestHash, bytes32 controlHash, uint96[] rewards, uint8[] slots, uint64 expiry, uint96 minBond, uint8 k, uint16 controlTierBps) payable → uint256 bountyId`
- who: anyone. `msg.sender` becomes `buyer` (a BudgetVault may be the sender).
- requires: `rewards.length == slots.length` and `1 ≤ length ≤ 32` (`BadInvariants`); every `slots[i] ≥ 1` and `rewards[i] > 0` (`BadInvariants`); `expiry > now` (`BadExpiry`); `controlTierBps ≤ 10000` (`BadTier`); `k ≥ 1` (`BadK`); `msg.value == Σ rewards[i] * slots[i]` (`WrongValue`).
- effects: push Bounty with `escrow = msg.value`, `status = OPEN`, invariants initialized with `slotsUsed = cursor = commitCount = 0`.
- emits: `BountyPosted(uint256 indexed bountyId, address indexed buyer, bytes32 manifestHash, bytes32 controlHash, uint64 expiry, uint96 minBond, uint8 k, uint16 controlTierBps, uint96[] rewards, uint8[] slots)`.

### `commit(uint256 bountyId, uint8 inv, bytes32 commitment) payable → uint256 commitId`
- who: seller.
- requires: bounty exists (`NoSuchBounty`); `status == OPEN` (`BountyNotOpen`); `now < expiry` (`BountyExpired`); `inv < inv.length` (`NoSuchInvariant`); `commitment != 0` (`BadCommitment`); `msg.value ≥ minBond` (`BondTooLow`).
- effects: `seq = invariant.commitCount++`; `bounty.pending++`; push Commit with `bond = msg.value`, `committedAt = now`, `outcome = NONE`.
- emits: `Committed(uint256 indexed commitId, uint256 indexed bountyId, uint8 inv, uint32 seq, address indexed seller, bytes32 commitment, uint96 bond)`.

### `attest(uint256 commitId, Outcome outcome, uint8 hits, bool breaksControl, bytes32 contentHash, bytes32 salt, bytes32 traceHash)`
- who: `verifierSet.canAttest(msg.sender)` (`NotVerifier`).
- requires: commit exists (`NoSuchCommit`); `c.outcome == NONE` (`AlreadyAttested`); `outcome ∈ {PASS, FAIL, VOID}` (`BadOutcome`); `c.seq == invariant.cursor` (`NotNextInQueue`); if `outcome == PASS`: `keccak256(abi.encodePacked(contentHash, salt)) == c.commitment` (`CommitmentMismatch`).
- effects: if `PASS`: if `slotsUsed < slots` → `slotsUsed++`, `c.slotHeld = true`, store `PASS`; else store `PASS_NO_SLOT`. Store `hits`, `breaksControl`, `contentHash`, `traceHash`, `attestedAt = now`. `invariant.cursor++`. **No ETH moves.** Attest is allowed on a VOIDED bounty (commits already in flight still settle) and after expiry (expiry only gates `commit`).
- emits: `Attested(uint256 indexed commitId, uint256 indexed bountyId, uint8 inv, address indexed seller, Outcome outcome, uint8 hits, bool breaksControl, bytes32 contentHash, bytes32 salt, bytes32 traceHash)` — `outcome` is the stored one (may be `PASS_NO_SLOT`).

### `dispute(uint256 commitId) payable`
- who: `bounty.buyer` if `c.outcome == PASS`; `c.seller` if `c.outcome == FAIL`; otherwise revert `NotDisputable`. Wrong caller → `NotParty`.
- requires: `!c.finalized` (`AlreadyFinalized`); `c.dispute == NONE` (`AlreadyDisputed`); `now < attestedAt + disputeWindow` (`WindowClosed`); `msg.value ≥ disputeBond` (`BondTooLow`).
- effects: `dispute = OPEN`, `disputer = msg.sender`, `disputeBond = msg.value`.
- emits: `Disputed(uint256 indexed commitId, address indexed disputer, uint96 bond)`.

### `resolve(uint256 commitId, Outcome finalOutcome)`
- who: `arbiter` (`NotArbiter`).
- requires: `c.dispute == OPEN` (`NoOpenDispute`); `finalOutcome ∈ {PASS, FAIL}` (`BadOutcome`).
- effects: `prev = c.outcome`.
  - `prev == PASS && final == FAIL`: `slotsUsed--`, `slotHeld = false`, `outcome = FAIL`.
  - `prev == FAIL && final == PASS`: if `slotsUsed < slots` → `slotsUsed++`, `slotHeld = true`, `outcome = PASS`; else `outcome = PASS_NO_SLOT`.
  - otherwise unchanged.
  - `changed = (c.outcome != prev)`. Dispute bond: if `changed` → pay `disputer`; else pay the counterparty (`seller` if disputer is buyer, `buyer` if disputer is seller). `disputeBond = 0`, `dispute = RESOLVED`.
- emits: `Resolved(uint256 indexed commitId, Outcome outcome, bool changed)`.

### `finalize(uint256 commitId)`
- who: anyone.
- requires: `c.outcome ∉ {NONE, RECLAIMED}` (`NotAttested`); `!c.finalized` (`AlreadyFinalized`); `c.dispute != OPEN` (`DisputeOpen`); if `c.dispute == NONE`: `now ≥ attestedAt + disputeWindow` (`WindowOpen`).
- effects (state first, then pay): `finalized = true`; `bounty.pending--`.
  - `PASS`: `paid = reward`; if `breaksControl` → `paid = reward * controlTierBps / 10000`. `bounty.escrow -= paid`. Pay seller `paid + bond`.
  - `PASS_NO_SLOT` or `VOID`: pay seller `bond`. `paid = 0`.
  - `FAIL`: pay treasury `bond`. `paid = 0`.
- emits: `Finalized(uint256 indexed commitId, Outcome outcome, uint256 paidToSeller)`.

### `reclaimBond(uint256 commitId)`
- who: `c.seller` (`NotParty`).
- requires: `c.outcome == NONE` (`AlreadyAttested`); `c.seq == invariant.cursor` (`NotNextInQueue`); `now > committedAt + attestTimeout` **or** `bounty.status == VOIDED` (`TooEarly`).
- effects: `outcome = RECLAIMED`, `finalized = true`, `invariant.cursor++`, `bounty.pending--`. Pay seller `bond`.
- emits: `Reclaimed(uint256 indexed commitId)`.
- note: in-order reclaim is what stops a dead verifier from wedging later commits; because earlier commits time out earlier, ordering is natural.

### `voidBounty(uint256 bountyId)`
- who: `verifierSet.canAttest(msg.sender)` (`NotVerifier`).
- requires: `status == OPEN` (`BountyNotOpen`).
- effects: `status = VOIDED`. (No new commits; unattested commits reclaim immediately; attested commits settle normally; `expire` allowed at once.)
- emits: `BountyVoided(uint256 indexed bountyId)`.

### `cancel(uint256 bountyId)`
- who: `bounty.buyer` (`NotParty`).
- requires: `status == OPEN` (`BountyNotOpen`).
- effects: `expiry = min(expiry, now + cancelGrace)`. Status stays OPEN.
- emits: `BountyCancelling(uint256 indexed bountyId, uint64 newExpiry)`.

### `expire(uint256 bountyId)`
- who: anyone.
- requires: `status != CLOSED` (`BountyClosed`); `now ≥ expiry || status == VOIDED` (`NotExpired`); `pending == 0` (`PendingCommits`).
- effects: `status = CLOSED`; `refund = escrow`; `escrow = 0`; pay buyer `refund`.
- emits: `BountyExpired(uint256 indexed bountyId, uint256 refund)`.

### `withdraw()`
- who: anyone with `owed[msg.sender] > 0`.
- effects: `amt = owed[msg.sender]; owed[msg.sender] = 0;` then `call{value: amt}`; revert `TransferFailed` if it fails.

---

## 5. Payment rule

All payouts go through one internal `_pay(address to, uint256 amount)`:
1. If `amount == 0` return.
2. `(ok,) = to.call{value: amount}("")` with all gas.
3. If `!ok`: `owed[to] += amount` (never revert on a recipient that rejects ETH; a seller contract must not be able to block `resolve`/`finalize`).

Every function that pays updates all state **before** calling `_pay` (checks-effects-interactions). Add a simple `nonReentrant` modifier to `finalize`, `resolve`, `reclaimBond`, `expire`, `withdraw`.

---

## 6. Invariants (write these as Foundry invariant tests with a handler)

1. `address(bazaar).balance == Σ bounties.escrow + Σ commits[!finalized].bond + Σ commits[dispute==OPEN].disputeBond + Σ owed[*]`
2. `inv.slotsUsed ≤ inv.slots`
3. `inv.cursor ≤ inv.commitCount`, and every commit with `seq < cursor` has `outcome != NONE`
4. `bounty.pending == count(commits of bounty where !finalized)` (RECLAIMED sets finalized)
5. `status == CLOSED ⇒ escrow == 0 ∧ pending == 0`
6. For any finalized PASS, `paidToSeller - bond ≤ reward`

---

## 7. Test matrix (one Foundry test each; names map to DESIGN.md cases)

| Test | Sequence | Assert |
|---|---|---|
| `test_HappyPath` (1) | post 0.02 → commit 0.002 → attest PASS 3/3 → warp 61 → finalize → warp past expiry → expire | seller net +0.020; escrow 0; status CLOSED; `Finalized(paid=0.02)` |
| `test_FailSlashesToTreasury` (3, 12) | post → commit → attest FAIL → warp → finalize → expire | treasury +0.002; buyer refunded 0.02 |
| `test_SecondPassBecomesNoSlot` (10) | post slots=1 → commit A, B → attest A PASS → attest B PASS | B stored `PASS_NO_SLOT`; finalize B pays only bond |
| `test_FifoGuard` (11) | commit A, B → `attest(B)` | reverts `NotNextInQueue`; then attest A FAIL, attest B PASS succeed |
| `test_PassNeedsCommitmentMatch` (12) | attest PASS with wrong salt | reverts `CommitmentMismatch`; attest FAIL with anything succeeds |
| `test_BuyerDisputeOverturned` (16, 21) | attest PASS → buyer dispute → resolve FAIL | slotsUsed 0; buyer gets dispute bond; finalize sends seller bond to treasury; finalize allowed before window ends |
| `test_BuyerDisputeUpheld` | attest PASS → buyer dispute → resolve PASS | seller receives dispute bond; finalize pays reward |
| `test_SellerDisputeOverturned` (20) | attest FAIL → seller dispute → resolve PASS | slot taken; seller paid reward + bond + dispute bond back |
| `test_DisputeWindowAndParties` | dispute after window; dispute by wrong party; dispute twice | `WindowClosed`, `NotParty`, `AlreadyDisputed` |
| `test_ReclaimAfterTimeout` (22) | commit → warp attestTimeout+1 → reclaim | bond back; cursor 1; pending 0; later `attest` reverts `AlreadyAttested`; expire works |
| `test_ReclaimTooEarlyAndOutOfOrder` | reclaim before timeout; reclaim B before A | `TooEarly`, `NotNextInQueue` |
| `test_VoidBounty` (6) | commit A (sent), commit B → attest A VOID → voidBounty → B reclaim immediately → finalize A → expire immediately | no slashes; escrow refunded; expire succeeds before expiry |
| `test_ExpireBlockedByPending` (26) | commit at expiry−60 → warp past expiry → expire | reverts `PendingCommits`; after attest+finalize, expire succeeds |
| `test_TieredPayout` (7) | post tier 2500 → attest PASS breaksControl → finalize → expire | seller +0.005; buyer refunded 0.015 |
| `test_CancelGrace` (31) | post exp 48h → cancel → commit at +5 min ok → warp +11 min → commit | second commit reverts `BountyExpired`; expiry == cancel time + grace |
| `test_PostValidation` | wrong msg.value; empty invariants; tier > 10000; expiry in past | each reverts with its error |
| `test_PayFallbackOwed` | seller is a contract that reverts on receive → finalize | `owed[seller] == amount`; `withdraw` from a forwarding wrapper works; invariant 1 holds |
| `test_BudgetVault` (18) | deposit 0.1, caps 0.02/0.05 → postBounty ×2 ok → ×3 reverts `EpochCapExceeded` → expire → refund lands in vault → owner withdraw | vault balance arithmetic |
| `invariant_Conservation` | handler with random post/commit/attest/dispute/resolve/finalize/reclaim/expire/warp | §6 invariants hold |

---

## 8. `SingleVerifier`

```solidity
contract SingleVerifier is IVerifierSet {
    address public owner; address public verifier;
    constructor(address verifier_)            // owner = msg.sender
    function canAttest(address who) view → who == verifier
    function setVerifier(address) onlyOwner
    function transferOwnership(address) onlyOwner
    event VerifierSet(address indexed verifier);
}
```

*v2*: `StakedVerifierSet` with `threshold()`; `attest` gains a signature-bundle variant. Not needed for v1.

---

## 9. `BudgetVault` (optional)

Acts as the buyer. Deploy one per human owner.

```solidity
contract BudgetVault {
    Bazaar public immutable bazaar;
    address public owner;
    mapping(address => bool) public spenders;
    uint96 public perBountyCap; uint96 public epochCap; uint64 public epochLength;
    uint96 public spentThisEpoch; uint64 public epochStart;

    constructor(Bazaar bazaar_, uint96 perBountyCap_, uint96 epochCap_, uint64 epochLength_)
    receive() external payable {}                       // refunds from expire land here
    function deposit() external payable
    function withdraw(uint256 amount) external onlyOwner
    function setSpender(address, bool) external onlyOwner
    function setCaps(uint96 perBountyCap_, uint96 epochCap_, uint64 epochLength_) external onlyOwner

    function postBounty(...same params as Bazaar.postBounty...) external onlySpender returns (uint256) {
        _rollEpoch();                                   // if now ≥ epochStart + epochLength: spent = 0, epochStart = now
        uint256 total = Σ rewards[i] * slots[i];
        if (total > perBountyCap) revert PerBountyCapExceeded();
        if (spentThisEpoch + total > epochCap) revert EpochCapExceeded();
        if (address(this).balance < total) revert InsufficientVaultBalance();
        spentThisEpoch += uint96(total);
        return bazaar.postBounty{value: total}(...);
    }
    function dispute(uint256 commitId) external onlySpender   // forwards bazaar.disputeBond() from vault balance
    function cancel(uint256 bountyId) external onlySpender
    function withdrawOwed() external onlySpender               // calls bazaar.withdraw() if owed[vault] > 0
}
```

Errors: `NotOwner`, `NotSpender`, `PerBountyCapExceeded`, `EpochCapExceeded`, `InsufficientVaultBalance`, `TransferFailed`.

---

## 10. Events summary (the indexer reads exactly these)

```
BountyPosted(bountyId, buyer, manifestHash, controlHash, expiry, minBond, k, controlTierBps, rewards[], slots[])
Committed(commitId, bountyId, inv, seq, seller, commitment, bond)
Attested(commitId, bountyId, inv, seller, outcome, hits, breaksControl, contentHash, salt, traceHash)
Disputed(commitId, disputer, bond)
Resolved(commitId, outcome, changed)
Finalized(commitId, outcome, paidToSeller)
Reclaimed(commitId)
BountyVoided(bountyId)
BountyCancelling(bountyId, newExpiry)
BountyExpired(bountyId, refund)
```

---

## 11. Deployment

`script/Deploy.s.sol`: read `VERIFIER`, `ARBITER`, `TREASURY` from env (v1: all the same platform address), deploy `SingleVerifier(VERIFIER)`, then `Bazaar(verifierSet, ARBITER, TREASURY, 10 minutes, 60 seconds, 0.005 ether, 10 minutes)`. Log both addresses.

```bash
forge script script/Deploy.s.sol \
  --rpc-url https://sepolia.base.org --chain-id 84532 \
  --private-key $PLATFORM_KEY --broadcast \
  --verify --etherscan-api-key $BASESCAN_API_KEY
# if verification is not picked up automatically:
forge verify-contract <BAZAAR_ADDR> src/Bazaar.sol:Bazaar --chain-id 84532 \
  --etherscan-api-key $BASESCAN_API_KEY --constructor-args $(cast abi-encode "constructor(address,address,address,uint64,uint64,uint96,uint64)" ...)
```

Export the ABI for the SDK: `forge inspect Bazaar abi > ../sdk/abi/Bazaar.json`.

---

## 12. Accepted edges (do not "fix" these)

- If a dispute overturns a PASS and releases its slot, a commit already finalized as `PASS_NO_SLOT` is not retroactively paid.
- Priority does not carry across bounty versions; a reposted bounty starts a fresh queue.
- `attest` does not check `attestTimeout`; a late-but-live verifier can still attest until the seller reclaims. First to act wins.
- Reputation is entirely off-chain.
