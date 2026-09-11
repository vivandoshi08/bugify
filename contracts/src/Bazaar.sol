// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBazaar} from "./interfaces/IBazaar.sol";
import {IVerifierSet} from "./interfaces/IVerifierSet.sol";

/// @title Bazaar
/// @notice Escrow, commitments, attestations, disputes and settlement for LLM-agent exploit bounties.
/// @dev Native ETH only. Trusts exactly two things: whoever `verifierSet` says may attest, and `arbiter`.
///      Every payout goes through `_pay`, which never reverts on a rejecting recipient (falls back to `owed`).
///      See docs/CONTRACTS.md for the full specification.
contract Bazaar is IBazaar {
    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    struct Bounty {
        address buyer;
        bytes32 manifestHash;
        bytes32 controlHash;
        uint64 expiry;
        uint96 minBond;
        uint8 k;
        uint16 controlTierBps;
        uint128 escrow;
        uint32 pending;
        BountyStatus status;
        Invariant[] inv;
    }

    uint256 private constant BPS = 10_000;
    uint256 private constant MAX_INVARIANTS = 32;

    Bounty[] internal bounties; // bountyId = index
    Commit[] internal commits; // commitId = index
    mapping(address => uint256) public override owed; // pull-payment fallback

    address public override owner;
    IVerifierSet internal _verifierSet;
    address public override arbiter;
    address public override treasury;
    uint64 public override attestTimeout; // seller may reclaim after committedAt + this
    uint64 public override disputeWindow; // finalize allowed after attestedAt + this
    uint96 public override disputeBond; // required msg.value for dispute()
    uint64 public override cancelGrace; // cancel() sets expiry = min(expiry, now + this)

    uint256 private _lock = 1;

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyVerifier() {
        if (!_verifierSet.canAttest(msg.sender)) revert NotVerifier();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(
        IVerifierSet verifierSet_,
        address arbiter_,
        address treasury_,
        uint64 attestTimeout_,
        uint64 disputeWindow_,
        uint96 disputeBond_,
        uint64 cancelGrace_
    ) {
        if (address(verifierSet_) == address(0) || arbiter_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        owner = msg.sender;
        _verifierSet = verifierSet_;
        arbiter = arbiter_;
        treasury = treasury_;
        attestTimeout = attestTimeout_;
        disputeWindow = disputeWindow_;
        disputeBond = disputeBond_;
        cancelGrace = cancelGrace_;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function verifierSet() external view override returns (address) {
        return address(_verifierSet);
    }

    function bountyCount() external view override returns (uint256) {
        return bounties.length;
    }

    function commitCount() external view override returns (uint256) {
        return commits.length;
    }

    function getBounty(uint256 bountyId) external view override returns (BountyInfo memory info) {
        Bounty storage b = _bounty(bountyId);
        info = BountyInfo({
            buyer: b.buyer,
            manifestHash: b.manifestHash,
            controlHash: b.controlHash,
            expiry: b.expiry,
            minBond: b.minBond,
            k: b.k,
            controlTierBps: b.controlTierBps,
            escrow: b.escrow,
            pending: b.pending,
            status: b.status,
            invariantCount: uint8(b.inv.length)
        });
    }

    function invariantCount(uint256 bountyId) external view override returns (uint256) {
        return _bounty(bountyId).inv.length;
    }

    function getInvariant(uint256 bountyId, uint8 inv) external view override returns (Invariant memory) {
        Bounty storage b = _bounty(bountyId);
        if (inv >= b.inv.length) revert NoSuchInvariant();
        return b.inv[inv];
    }

    function getCommit(uint256 commitId) external view override returns (Commit memory) {
        return _commit(commitId);
    }

    // ---------------------------------------------------------------------
    // Buyer
    // ---------------------------------------------------------------------

    /// @inheritdoc IBazaar
    function postBounty(
        bytes32 manifestHash,
        bytes32 controlHash,
        uint96[] calldata rewards,
        uint8[] calldata slots,
        uint64 expiry,
        uint96 minBond,
        uint8 k,
        uint16 controlTierBps
    ) external payable override returns (uint256 bountyId) {
        uint256 n = rewards.length;
        if (n != slots.length || n == 0 || n > MAX_INVARIANTS) revert BadInvariants();
        uint256 total;
        for (uint256 i; i < n; ++i) {
            if (slots[i] == 0 || rewards[i] == 0) revert BadInvariants();
            total += uint256(rewards[i]) * slots[i];
        }
        if (expiry <= block.timestamp) revert BadExpiry();
        if (controlTierBps > BPS) revert BadTier();
        if (k == 0) revert BadK();
        if (msg.value != total) revert WrongValue();

        bountyId = bounties.length;
        Bounty storage b = bounties.push();
        b.buyer = msg.sender;
        b.manifestHash = manifestHash;
        b.controlHash = controlHash;
        b.expiry = expiry;
        b.minBond = minBond;
        b.k = k;
        b.controlTierBps = controlTierBps;
        b.escrow = uint128(total); // 32 * 255 * 2^96 < 2^128
        b.status = BountyStatus.OPEN;
        for (uint256 i; i < n; ++i) {
            b.inv.push(Invariant({reward: rewards[i], slots: slots[i], slotsUsed: 0, cursor: 0, commitCount: 0}));
        }

        emit BountyPosted(
            bountyId, msg.sender, manifestHash, controlHash, expiry, minBond, k, controlTierBps, rewards, slots
        );
    }

    /// @inheritdoc IBazaar
    function cancel(uint256 bountyId) external override {
        Bounty storage b = _bounty(bountyId);
        if (msg.sender != b.buyer) revert NotParty();
        if (b.status != BountyStatus.OPEN) revert BountyNotOpen();
        uint64 soft = uint64(block.timestamp) + cancelGrace;
        if (soft < b.expiry) b.expiry = soft;
        emit BountyCancelling(bountyId, b.expiry);
    }

    // ---------------------------------------------------------------------
    // Seller
    // ---------------------------------------------------------------------

    /// @inheritdoc IBazaar
    function commit(uint256 bountyId, uint8 inv, bytes32 commitment)
        external
        payable
        override
        returns (uint256 commitId)
    {
        Bounty storage b = _bounty(bountyId);
        if (b.status != BountyStatus.OPEN) revert BountyNotOpen();
        if (block.timestamp >= b.expiry) revert PastExpiry();
        if (inv >= b.inv.length) revert NoSuchInvariant();
        if (commitment == bytes32(0)) revert BadCommitment();
        if (msg.value < b.minBond) revert BondTooLow();
        if (msg.value > type(uint96).max) revert BondTooHigh();

        Invariant storage iv = b.inv[inv];
        uint32 seq = iv.commitCount++;
        b.pending++;

        commitId = commits.length;
        Commit storage c = commits.push();
        c.bountyId = uint64(bountyId);
        c.inv = inv;
        c.seq = seq;
        c.seller = msg.sender;
        c.commitment = commitment;
        c.bond = uint96(msg.value);
        c.committedAt = uint64(block.timestamp);
        // outcome = NONE, dispute = NONE, everything else zero.

        emit Committed(commitId, bountyId, inv, seq, msg.sender, commitment, uint96(msg.value));
    }

    /// @inheritdoc IBazaar
    function reclaimBond(uint256 commitId) external override nonReentrant {
        Commit storage c = _commit(commitId);
        if (msg.sender != c.seller) revert NotParty();
        if (c.outcome != Outcome.NONE) revert AlreadyAttested();
        Bounty storage b = bounties[c.bountyId];
        Invariant storage iv = b.inv[c.inv];
        if (c.seq != iv.cursor) revert NotNextInQueue();
        bool timedOut = block.timestamp > uint256(c.committedAt) + attestTimeout;
        if (!timedOut && b.status != BountyStatus.VOIDED) revert TooEarly();

        c.outcome = Outcome.RECLAIMED;
        c.finalized = true;
        iv.cursor++;
        b.pending--;

        emit Reclaimed(commitId);
        _pay(c.seller, c.bond);
    }

    // ---------------------------------------------------------------------
    // Verifier
    // ---------------------------------------------------------------------

    /// @inheritdoc IBazaar
    function attest(
        uint256 commitId,
        Outcome outcome,
        uint8 hits,
        bool breaksControl,
        bytes32 contentHash,
        bytes32 salt,
        bytes32 traceHash
    ) external override onlyVerifier {
        Commit storage c = _commit(commitId);
        if (c.outcome != Outcome.NONE) revert AlreadyAttested();
        if (outcome != Outcome.PASS && outcome != Outcome.FAIL && outcome != Outcome.VOID) revert BadOutcome();
        Bounty storage b = bounties[c.bountyId];
        Invariant storage iv = b.inv[c.inv];
        if (c.seq != iv.cursor) revert NotNextInQueue();
        if (outcome == Outcome.PASS && keccak256(abi.encodePacked(contentHash, salt)) != c.commitment) {
            revert CommitmentMismatch();
        }
        if (breaksControl && b.controlHash == bytes32(0)) revert NoControl();

        Outcome stored = outcome;
        if (outcome == Outcome.PASS) {
            if (iv.slotsUsed < iv.slots) {
                iv.slotsUsed++;
                c.slotHeld = true;
            } else {
                stored = Outcome.PASS_NO_SLOT;
            }
        }
        c.outcome = stored;
        c.hits = hits;
        c.breaksControl = breaksControl;
        c.contentHash = contentHash;
        c.traceHash = traceHash;
        c.attestedAt = uint64(block.timestamp);
        iv.cursor++;

        emit Attested(commitId, c.bountyId, c.inv, c.seller, stored, hits, breaksControl, contentHash, salt, traceHash);
    }

    /// @inheritdoc IBazaar
    function voidBounty(uint256 bountyId) external override onlyVerifier {
        Bounty storage b = _bounty(bountyId);
        if (b.status != BountyStatus.OPEN) revert BountyNotOpen();
        b.status = BountyStatus.VOIDED;
        emit BountyVoided(bountyId);
    }

    // ---------------------------------------------------------------------
    // Disputes
    // ---------------------------------------------------------------------

    /// @inheritdoc IBazaar
    function dispute(uint256 commitId) external payable override {
        Commit storage c = _commit(commitId);
        Bounty storage b = bounties[c.bountyId];
        address party;
        if (c.outcome == Outcome.PASS) party = b.buyer;
        else if (c.outcome == Outcome.FAIL) party = c.seller;
        else revert NotDisputable();
        if (msg.sender != party) revert NotParty();
        if (c.finalized) revert AlreadyFinalized();
        if (c.dispute != DisputeState.NONE) revert AlreadyDisputed();
        if (block.timestamp >= uint256(c.attestedAt) + disputeWindow) revert WindowClosed();
        if (msg.value < disputeBond) revert BondTooLow();
        if (msg.value > type(uint96).max) revert BondTooHigh();

        c.dispute = DisputeState.OPEN;
        c.disputer = msg.sender;
        c.disputeBond = uint96(msg.value);

        emit Disputed(commitId, msg.sender, uint96(msg.value));
    }

    /// @inheritdoc IBazaar
    function resolve(uint256 commitId, Outcome finalOutcome) external override nonReentrant {
        if (msg.sender != arbiter) revert NotArbiter();
        Commit storage c = _commit(commitId);
        if (c.dispute != DisputeState.OPEN) revert NoOpenDispute();
        if (finalOutcome != Outcome.PASS && finalOutcome != Outcome.FAIL) revert BadOutcome();

        Bounty storage b = bounties[c.bountyId];
        Invariant storage iv = b.inv[c.inv];
        Outcome prev = c.outcome;

        if (prev == Outcome.PASS && finalOutcome == Outcome.FAIL) {
            iv.slotsUsed--;
            c.slotHeld = false;
            c.outcome = Outcome.FAIL;
        } else if (prev == Outcome.FAIL && finalOutcome == Outcome.PASS) {
            if (iv.slotsUsed < iv.slots) {
                iv.slotsUsed++;
                c.slotHeld = true;
                c.outcome = Outcome.PASS;
            } else {
                c.outcome = Outcome.PASS_NO_SLOT;
            }
        }

        bool changed = c.outcome != prev;
        address disputer = c.disputer;
        uint256 bond = c.disputeBond;
        address recipient;
        if (changed) recipient = disputer;
        else recipient = disputer == b.buyer ? c.seller : b.buyer;

        c.disputeBond = 0;
        c.dispute = DisputeState.RESOLVED;

        emit Resolved(commitId, c.outcome, changed);
        _pay(recipient, bond);
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    /// @inheritdoc IBazaar
    function finalize(uint256 commitId) external override nonReentrant {
        Commit storage c = _commit(commitId);
        if (c.outcome == Outcome.NONE || c.outcome == Outcome.RECLAIMED) revert NotAttested();
        if (c.finalized) revert AlreadyFinalized();
        if (c.dispute == DisputeState.OPEN) revert DisputeOpen();
        if (c.dispute == DisputeState.NONE && block.timestamp < uint256(c.attestedAt) + disputeWindow) {
            revert WindowOpen();
        }

        Bounty storage b = bounties[c.bountyId];
        c.finalized = true;
        b.pending--;

        uint256 paid;
        address to;
        uint256 amount;
        Outcome outcome = c.outcome;
        if (outcome == Outcome.PASS) {
            paid = b.inv[c.inv].reward;
            if (c.breaksControl) paid = (paid * b.controlTierBps) / BPS;
            b.escrow -= uint128(paid);
            to = c.seller;
            amount = paid + c.bond;
        } else if (outcome == Outcome.FAIL) {
            to = treasury;
            amount = c.bond;
        } else {
            // PASS_NO_SLOT or VOID: bond back, no reward.
            to = c.seller;
            amount = c.bond;
        }

        emit Finalized(commitId, outcome, paid);
        _pay(to, amount);
    }

    /// @inheritdoc IBazaar
    function expire(uint256 bountyId) external override nonReentrant {
        Bounty storage b = _bounty(bountyId);
        if (b.status == BountyStatus.CLOSED) revert BountyClosed();
        if (block.timestamp < b.expiry && b.status != BountyStatus.VOIDED) revert NotExpired();
        if (b.pending != 0) revert PendingCommits();

        b.status = BountyStatus.CLOSED;
        uint256 refund = b.escrow;
        b.escrow = 0;

        emit BountyExpired(bountyId, refund);
        _pay(b.buyer, refund);
    }

    /// @inheritdoc IBazaar
    function withdraw() external override nonReentrant {
        uint256 amt = owed[msg.sender];
        if (amt == 0) return;
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------

    function setVerifierSet(address verifierSet_) external override onlyOwner {
        if (verifierSet_ == address(0)) revert ZeroAddress();
        _verifierSet = IVerifierSet(verifierSet_);
        emit VerifierSetUpdated(verifierSet_);
    }

    function setArbiter(address arbiter_) external override onlyOwner {
        if (arbiter_ == address(0)) revert ZeroAddress();
        arbiter = arbiter_;
        emit ArbiterUpdated(arbiter_);
    }

    function setTreasury(address treasury_) external override onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setTimings(uint64 attestTimeout_, uint64 disputeWindow_, uint96 disputeBond_, uint64 cancelGrace_)
        external
        override
        onlyOwner
    {
        attestTimeout = attestTimeout_;
        disputeWindow = disputeWindow_;
        disputeBond = disputeBond_;
        cancelGrace = cancelGrace_;
        emit TimingsUpdated(attestTimeout_, disputeWindow_, disputeBond_, cancelGrace_);
    }

    function transferOwnership(address newOwner) external override onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _bounty(uint256 bountyId) internal view returns (Bounty storage b) {
        if (bountyId >= bounties.length) revert NoSuchBounty();
        b = bounties[bountyId];
    }

    function _commit(uint256 commitId) internal view returns (Commit storage c) {
        if (commitId >= commits.length) revert NoSuchCommit();
        c = commits[commitId];
    }

    /// @dev Push payment with pull fallback. Never reverts because of the recipient, so a seller or buyer
    ///      contract that rejects ETH cannot block `resolve`, `finalize`, `reclaimBond` or `expire`.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) owed[to] += amount;
    }
}
