// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Types, errors and events shared by Bazaar, BudgetVault, the SDK and the tests.
/// @dev Keep this in sync with docs/CONTRACTS.md. The indexer reads exactly these events.
interface IBazaar {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum BountyStatus {
        OPEN,
        VOIDED,
        CLOSED
    }

    enum Outcome {
        NONE,
        PASS,
        PASS_NO_SLOT,
        FAIL,
        VOID,
        RECLAIMED
    }

    enum DisputeState {
        NONE,
        OPEN,
        RESOLVED
    }

    struct Invariant {
        uint96 reward; // wei paid for one verified PASS on this invariant
        uint8 slots; // how many PASSes are payable
        uint8 slotsUsed; // taken at attest, released only by resolve(PASS -> FAIL)
        uint32 cursor; // seq of the next commit that must be attested (FIFO)
        uint32 commitCount; // next seq to assign
    }

    /// @dev Scalar view of a bounty; invariants are read with `getInvariant`.
    struct BountyInfo {
        address buyer;
        bytes32 manifestHash;
        bytes32 controlHash; // 0x0 if no control manifest
        uint64 expiry; // unix seconds; commit allowed while now < expiry
        uint96 minBond;
        uint8 k; // replays per verification (informational, >= 1)
        uint16 controlTierBps; // payout bps when breaksControl (<= 10000)
        uint128 escrow; // remaining locked reward
        uint32 pending; // commits not yet finalized/reclaimed
        BountyStatus status;
        uint8 invariantCount;
    }

    struct Commit {
        uint64 bountyId;
        uint8 inv;
        uint32 seq; // position within (bountyId, inv)
        address seller;
        bytes32 commitment; // keccak256(abi.encodePacked(contentHash, salt))
        uint96 bond;
        uint64 committedAt;
        Outcome outcome;
        uint8 hits;
        bool breaksControl;
        bool slotHeld;
        bytes32 contentHash; // keccak256 of canonical transcript bytes (set at attest)
        bytes32 traceHash; // keccak256 of canonical replay traces (set at attest)
        uint64 attestedAt;
        DisputeState dispute;
        address disputer;
        uint96 disputeBond;
        bool finalized;
    }

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner();
    error NotVerifier();
    error NotArbiter();
    error NotParty();
    error ZeroAddress();
    error Reentrancy();

    error BadInvariants();
    error BadExpiry();
    error BadTier();
    error BadK();
    error WrongValue();
    error BondTooLow();
    error BondTooHigh();
    error BadCommitment();
    error BadOutcome();

    error NoSuchBounty();
    error NoSuchInvariant();
    error NoSuchCommit();
    error BountyNotOpen();
    error PastExpiry(); // spec: "BountyExpired"; renamed because the event of that name exists
    error BountyClosed();
    error NotExpired();
    error PendingCommits();

    error AlreadyAttested();
    error NotNextInQueue();
    error CommitmentMismatch();
    error NoControl();
    error NotAttested();
    error AlreadyFinalized();
    error NotDisputable();
    error AlreadyDisputed();
    error WindowClosed();
    error WindowOpen();
    error DisputeOpen();
    error NoOpenDispute();
    error TooEarly();
    error TransferFailed();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event BountyPosted(
        uint256 indexed bountyId,
        address indexed buyer,
        bytes32 manifestHash,
        bytes32 controlHash,
        uint64 expiry,
        uint96 minBond,
        uint8 k,
        uint16 controlTierBps,
        uint96[] rewards,
        uint8[] slots
    );
    event Committed(
        uint256 indexed commitId,
        uint256 indexed bountyId,
        uint8 inv,
        uint32 seq,
        address indexed seller,
        bytes32 commitment,
        uint96 bond
    );
    event Attested(
        uint256 indexed commitId,
        uint256 indexed bountyId,
        uint8 inv,
        address indexed seller,
        Outcome outcome,
        uint8 hits,
        bool breaksControl,
        bytes32 contentHash,
        bytes32 salt,
        bytes32 traceHash
    );
    event Disputed(uint256 indexed commitId, address indexed disputer, uint96 bond);
    event Resolved(uint256 indexed commitId, Outcome outcome, bool changed);
    event Finalized(uint256 indexed commitId, Outcome outcome, uint256 paidToSeller);
    event Reclaimed(uint256 indexed commitId);
    event BountyVoided(uint256 indexed bountyId);
    event BountyCancelling(uint256 indexed bountyId, uint64 newExpiry);
    event BountyExpired(uint256 indexed bountyId, uint256 refund);

    event VerifierSetUpdated(address indexed verifierSet);
    event ArbiterUpdated(address indexed arbiter);
    event TreasuryUpdated(address indexed treasury);
    event TimingsUpdated(uint64 attestTimeout, uint64 disputeWindow, uint96 disputeBond, uint64 cancelGrace);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ---------------------------------------------------------------------
    // Config views
    // ---------------------------------------------------------------------

    function owner() external view returns (address);
    function verifierSet() external view returns (address);
    function arbiter() external view returns (address);
    function treasury() external view returns (address);
    function attestTimeout() external view returns (uint64);
    function disputeWindow() external view returns (uint64);
    function disputeBond() external view returns (uint96);
    function cancelGrace() external view returns (uint64);
    function owed(address who) external view returns (uint256);

    // ---------------------------------------------------------------------
    // Data views
    // ---------------------------------------------------------------------

    function bountyCount() external view returns (uint256);
    function commitCount() external view returns (uint256);
    function getBounty(uint256 bountyId) external view returns (BountyInfo memory);
    function invariantCount(uint256 bountyId) external view returns (uint256);
    function getInvariant(uint256 bountyId, uint8 inv) external view returns (Invariant memory);
    function getCommit(uint256 commitId) external view returns (Commit memory);

    // ---------------------------------------------------------------------
    // Buyer
    // ---------------------------------------------------------------------

    function postBounty(
        bytes32 manifestHash,
        bytes32 controlHash,
        uint96[] calldata rewards,
        uint8[] calldata slots,
        uint64 expiry,
        uint96 minBond,
        uint8 k,
        uint16 controlTierBps
    ) external payable returns (uint256 bountyId);

    function cancel(uint256 bountyId) external;

    // ---------------------------------------------------------------------
    // Seller
    // ---------------------------------------------------------------------

    function commit(uint256 bountyId, uint8 inv, bytes32 commitment) external payable returns (uint256 commitId);
    function reclaimBond(uint256 commitId) external;

    // ---------------------------------------------------------------------
    // Verifier / arbiter
    // ---------------------------------------------------------------------

    function attest(
        uint256 commitId,
        Outcome outcome,
        uint8 hits,
        bool breaksControl,
        bytes32 contentHash,
        bytes32 salt,
        bytes32 traceHash
    ) external;

    function voidBounty(uint256 bountyId) external;
    function resolve(uint256 commitId, Outcome finalOutcome) external;

    // ---------------------------------------------------------------------
    // Either party / anyone
    // ---------------------------------------------------------------------

    function dispute(uint256 commitId) external payable;
    function finalize(uint256 commitId) external;
    function expire(uint256 bountyId) external;
    function withdraw() external;

    // ---------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------

    function setVerifierSet(address verifierSet_) external;
    function setArbiter(address arbiter_) external;
    function setTreasury(address treasury_) external;
    function setTimings(uint64 attestTimeout_, uint64 disputeWindow_, uint96 disputeBond_, uint64 cancelGrace_) external;
    function transferOwnership(address newOwner) external;
}
