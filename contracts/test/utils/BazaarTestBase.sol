// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IBazaar} from "../../src/interfaces/IBazaar.sol";
import {IVerifierSet} from "../../src/interfaces/IVerifierSet.sol";
import {Bazaar} from "../../src/Bazaar.sol";
import {MockVerifierSet} from "./MockVerifierSet.sol";

/// @notice Shared fixture: deploys MockVerifierSet + Bazaar with the demo timings and a set of named, funded actors.
abstract contract BazaarTestBase is Test {
    uint64 internal constant ATTEST_TIMEOUT = 10 minutes;
    uint64 internal constant DISPUTE_WINDOW = 60 seconds;
    uint96 internal constant DISPUTE_BOND = 0.005 ether;
    uint64 internal constant CANCEL_GRACE = 10 minutes;

    uint96 internal constant MIN_BOND = 0.002 ether;
    uint8 internal constant K = 3;
    bytes32 internal constant MANIFEST = keccak256("manifest");
    bytes32 internal constant CONTROL = keccak256("control");
    bytes32 internal constant TRACE = keccak256("trace");
    bytes32 internal constant CONTENT = keccak256("content");
    bytes32 internal constant SALT = keccak256("salt");

    uint256 internal constant T0 = 1_700_000_000;

    MockVerifierSet internal verifierSet;
    Bazaar internal bazaar;

    address internal buyer;
    address internal seller;
    address internal seller2;
    address internal verifier;
    address internal arbiter;
    address internal treasury;
    address internal rando;

    function setUp() public virtual {
        vm.warp(T0);

        buyer = makeAddr("buyer");
        seller = makeAddr("seller");
        seller2 = makeAddr("seller2");
        verifier = makeAddr("verifier");
        arbiter = makeAddr("arbiter");
        treasury = makeAddr("treasury");
        rando = makeAddr("rando");

        vm.deal(buyer, 10 ether);
        vm.deal(seller, 10 ether);
        vm.deal(seller2, 10 ether);
        vm.deal(verifier, 10 ether);
        vm.deal(arbiter, 10 ether);
        vm.deal(treasury, 10 ether);
        vm.deal(rando, 10 ether);

        verifierSet = new MockVerifierSet();
        verifierSet.set(verifier, true);

        bazaar = new Bazaar(
            IVerifierSet(address(verifierSet)),
            arbiter,
            treasury,
            ATTEST_TIMEOUT,
            DISPUTE_WINDOW,
            DISPUTE_BOND,
            CANCEL_GRACE
        );
    }

    // ---------------------------------------------------------------------
    // Posting
    // ---------------------------------------------------------------------

    function _single(uint96 reward, uint8 slots) internal pure returns (uint96[] memory r, uint8[] memory s) {
        r = new uint96[](1);
        s = new uint8[](1);
        r[0] = reward;
        s[0] = slots;
    }

    function _total(uint96[] memory rewards, uint8[] memory slots) internal pure returns (uint256 total) {
        for (uint256 i = 0; i < rewards.length; i++) {
            total += uint256(rewards[i]) * slots[i];
        }
    }

    function postAs(
        address who,
        uint96[] memory rewards,
        uint8[] memory slots,
        uint64 expiry,
        bytes32 controlHash,
        uint16 tierBps
    ) internal returns (uint256 bountyId) {
        vm.prank(who);
        bountyId = bazaar.postBounty{value: _total(rewards, slots)}(
            MANIFEST, controlHash, rewards, slots, expiry, MIN_BOND, K, tierBps
        );
    }

    /// @dev manifestHash keccak("manifest"), controlHash 0, minBond 0.002 ether, k 3, tier 0; posted by `buyer`.
    function postSimple(uint96 reward, uint8 slots, uint64 expiryDelta) internal returns (uint256 bountyId) {
        (uint96[] memory r, uint8[] memory s) = _single(reward, slots);
        bountyId = postAs(buyer, r, s, uint64(block.timestamp) + expiryDelta, bytes32(0), 0);
    }

    /// @dev Same as postSimple but with controlHash keccak("control") and the given tier.
    function postWithControl(uint96 reward, uint8 slots, uint64 expiryDelta, uint16 tierBps)
        internal
        returns (uint256 bountyId)
    {
        (uint96[] memory r, uint8[] memory s) = _single(reward, slots);
        bountyId = postAs(buyer, r, s, uint64(block.timestamp) + expiryDelta, CONTROL, tierBps);
    }

    // ---------------------------------------------------------------------
    // Committing
    // ---------------------------------------------------------------------

    function commitment(bytes32 contentHash, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(contentHash, salt));
    }

    function commitAs(address who, uint256 bountyId, uint8 inv, bytes32 contentHash, bytes32 salt, uint256 bond)
        internal
        returns (uint256 commitId)
    {
        vm.prank(who);
        commitId = bazaar.commit{value: bond}(bountyId, inv, commitment(contentHash, salt));
    }

    /// @dev Commit by `seller`.
    function commitFor(uint256 bountyId, uint8 inv, bytes32 contentHash, bytes32 salt, uint256 bond)
        internal
        returns (uint256 commitId)
    {
        commitId = commitAs(seller, bountyId, inv, contentHash, salt, bond);
    }

    // ---------------------------------------------------------------------
    // Attesting
    // ---------------------------------------------------------------------

    function attestPass(uint256 commitId, bytes32 contentHash, bytes32 salt) internal {
        vm.prank(verifier);
        bazaar.attest(commitId, IBazaar.Outcome.PASS, K, false, contentHash, salt, TRACE);
    }

    function attestPassControl(uint256 commitId, bytes32 contentHash, bytes32 salt) internal {
        vm.prank(verifier);
        bazaar.attest(commitId, IBazaar.Outcome.PASS, K, true, contentHash, salt, TRACE);
    }

    function attestFail(uint256 commitId) internal {
        vm.prank(verifier);
        bazaar.attest(commitId, IBazaar.Outcome.FAIL, 0, false, bytes32(0), bytes32(0), TRACE);
    }

    function attestVoid(uint256 commitId) internal {
        vm.prank(verifier);
        bazaar.attest(commitId, IBazaar.Outcome.VOID, 0, false, bytes32(0), bytes32(0), bytes32(0));
    }

    // ---------------------------------------------------------------------
    // Time
    // ---------------------------------------------------------------------

    function warpPastWindow() internal {
        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
    }

    function warpPastTimeout() internal {
        vm.warp(block.timestamp + ATTEST_TIMEOUT + 1);
    }

    function warpPastExpiry(uint256 bountyId) internal {
        vm.warp(uint256(bazaar.getBounty(bountyId).expiry) + 1);
    }

    // ---------------------------------------------------------------------
    // Accounting helper (spec §6 invariant 1)
    // ---------------------------------------------------------------------

    /// @dev address(bazaar).balance == Σ escrow + Σ unfinalized bonds + Σ open dispute bonds + Σ owed[extra ∪ actors].
    function assertConservation(address[] memory extra) internal view {
        uint256 expected;
        uint256 n = bazaar.bountyCount();
        for (uint256 i = 0; i < n; i++) {
            expected += bazaar.getBounty(i).escrow;
        }
        uint256 m = bazaar.commitCount();
        for (uint256 i = 0; i < m; i++) {
            IBazaar.Commit memory c = bazaar.getCommit(i);
            if (!c.finalized) expected += c.bond;
            if (c.dispute == IBazaar.DisputeState.OPEN) expected += c.disputeBond;
        }
        address[7] memory actors = [buyer, seller, seller2, verifier, arbiter, treasury, rando];
        for (uint256 i = 0; i < actors.length; i++) {
            expected += bazaar.owed(actors[i]);
        }
        for (uint256 i = 0; i < extra.length; i++) {
            expected += bazaar.owed(extra[i]);
        }
        assertEq(address(bazaar).balance, expected, "conservation");
    }

    function assertConservation() internal view {
        assertConservation(new address[](0));
    }
}
