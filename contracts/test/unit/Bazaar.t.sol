// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBazaar} from "../../src/interfaces/IBazaar.sol";
import {BazaarTestBase} from "../utils/BazaarTestBase.sol";
import {RejectingReceiver, ForwardingWrapper, ReentrantSeller} from "../utils/RejectingReceiver.sol";

contract BazaarTest is BazaarTestBase {
    uint96 internal constant REWARD = 0.02 ether;
    uint96 internal constant BOND = 0.002 ether;
    uint64 internal constant DAY = 1 days;

    /// @dev Expected `Finalized.paidToSeller`. Spec §4 defines `paid` as the reward portion only (0 for
    /// FAIL / VOID / PASS_NO_SLOT) and §7 asserts `Finalized(paid=0.02)` for a 0.02-reward, 0.002-bond commit,
    /// so the event does NOT include the returned bond. (§6 invariant 6 reads `paidToSeller - bond`, which is
    /// the one place the spec leans the other way; the implementation currently emits `paid + bond`.)
    function paidEvt(
        uint256 paid,
        uint256 /*bond*/
    )
        internal
        pure
        returns (uint256)
    {
        return paid;
    }

    // =====================================================================
    // §7 test matrix
    // =====================================================================

    function test_HappyPath() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 sellerBefore = seller.balance;

        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        attestPass(c, CONTENT, SALT);

        IBazaar.Commit memory cm = bazaar.getCommit(c);
        assertEq(uint8(cm.outcome), uint8(IBazaar.Outcome.PASS));
        assertEq(cm.hits, 3);
        assertTrue(cm.slotHeld);
        assertEq(cm.contentHash, CONTENT);
        assertEq(cm.traceHash, TRACE);
        assertEq(cm.attestedAt, uint64(block.timestamp));

        vm.warp(block.timestamp + 61);
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Finalized(c, IBazaar.Outcome.PASS, paidEvt(REWARD, BOND));
        bazaar.finalize(c);

        assertEq(seller.balance - sellerBefore, REWARD, "seller net +0.020");
        assertEq(bazaar.getBounty(b).escrow, 0, "escrow 0");
        assertTrue(bazaar.getCommit(c).finalized);
        assertEq(bazaar.getBounty(b).pending, 0);

        warpPastExpiry(b);
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.BountyExpired(b, 0);
        bazaar.expire(b);
        assertEq(uint8(bazaar.getBounty(b).status), uint8(IBazaar.BountyStatus.CLOSED), "status CLOSED");
        assertConservation();
    }

    function test_FailSlashesToTreasury() public {
        uint256 buyerBefore = buyer.balance;
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 treasuryBefore = treasury.balance;
        uint256 sellerBefore = seller.balance;

        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        attestFail(c);
        warpPastWindow();

        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Finalized(c, IBazaar.Outcome.FAIL, 0);
        bazaar.finalize(c);

        assertEq(treasury.balance - treasuryBefore, BOND, "treasury +0.002");
        assertEq(sellerBefore - seller.balance, BOND, "seller lost bond");
        assertEq(bazaar.getBounty(b).escrow, REWARD, "escrow untouched");

        warpPastExpiry(b);
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.BountyExpired(b, REWARD);
        bazaar.expire(b);
        assertEq(buyer.balance, buyerBefore, "buyer refunded 0.02");
        assertConservation();
    }

    function test_SecondPassBecomesNoSlot() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        bytes32 salt2 = keccak256("salt2");
        uint256 a = commitFor(b, 0, CONTENT, SALT, BOND);
        uint256 c = commitAs(seller2, b, 0, CONTENT, salt2, BOND);

        attestPass(a, CONTENT, SALT);
        assertEq(bazaar.getInvariant(b, 0).slotsUsed, 1);

        vm.expectEmit(true, true, true, true, address(bazaar));
        emit IBazaar.Attested(c, b, 0, seller2, IBazaar.Outcome.PASS_NO_SLOT, K, false, CONTENT, salt2, TRACE);
        attestPass(c, CONTENT, salt2);

        IBazaar.Commit memory cm = bazaar.getCommit(c);
        assertEq(uint8(cm.outcome), uint8(IBazaar.Outcome.PASS_NO_SLOT), "B stored PASS_NO_SLOT");
        assertFalse(cm.slotHeld);
        assertEq(bazaar.getInvariant(b, 0).slotsUsed, 1);

        warpPastWindow();
        uint256 s2Before = seller2.balance;
        uint256 escrowBefore = bazaar.getBounty(b).escrow;
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Finalized(c, IBazaar.Outcome.PASS_NO_SLOT, paidEvt(0, BOND));
        bazaar.finalize(c);
        assertEq(seller2.balance - s2Before, BOND, "finalize B pays only bond");
        assertEq(bazaar.getBounty(b).escrow, escrowBefore, "escrow unchanged by no-slot");
        assertConservation();
    }

    function test_FifoGuard() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 a = commitFor(b, 0, CONTENT, SALT, BOND);
        uint256 c = commitAs(seller2, b, 0, CONTENT, SALT, BOND);

        vm.prank(verifier);
        vm.expectRevert(IBazaar.NotNextInQueue.selector);
        bazaar.attest(c, IBazaar.Outcome.PASS, K, false, CONTENT, SALT, TRACE);

        attestFail(a);
        assertEq(bazaar.getInvariant(b, 0).cursor, 1);
        attestPass(c, CONTENT, SALT);
        assertEq(bazaar.getInvariant(b, 0).cursor, 2);
        assertEq(uint8(bazaar.getCommit(a).outcome), uint8(IBazaar.Outcome.FAIL));
        assertEq(uint8(bazaar.getCommit(c).outcome), uint8(IBazaar.Outcome.PASS));
    }

    function test_PassNeedsCommitmentMatch() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);

        vm.prank(verifier);
        vm.expectRevert(IBazaar.CommitmentMismatch.selector);
        bazaar.attest(c, IBazaar.Outcome.PASS, K, false, CONTENT, keccak256("wrong"), TRACE);

        // FAIL does not check the commitment.
        vm.prank(verifier);
        bazaar.attest(c, IBazaar.Outcome.FAIL, 1, false, keccak256("garbage"), keccak256("more"), TRACE);
        assertEq(uint8(bazaar.getCommit(c).outcome), uint8(IBazaar.Outcome.FAIL));
    }

    function test_BuyerDisputeOverturned() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        attestPass(c, CONTENT, SALT);
        assertEq(bazaar.getInvariant(b, 0).slotsUsed, 1);

        uint256 buyerBefore = buyer.balance;
        vm.prank(buyer);
        vm.expectEmit(true, true, false, true, address(bazaar));
        emit IBazaar.Disputed(c, buyer, DISPUTE_BOND);
        bazaar.dispute{value: DISPUTE_BOND}(c);
        assertEq(uint8(bazaar.getCommit(c).dispute), uint8(IBazaar.DisputeState.OPEN));
        assertEq(bazaar.getCommit(c).disputer, buyer);
        assertEq(bazaar.getCommit(c).disputeBond, DISPUTE_BOND);

        vm.prank(arbiter);
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Resolved(c, IBazaar.Outcome.FAIL, true);
        bazaar.resolve(c, IBazaar.Outcome.FAIL);

        IBazaar.Commit memory cm = bazaar.getCommit(c);
        assertEq(uint8(cm.outcome), uint8(IBazaar.Outcome.FAIL));
        assertFalse(cm.slotHeld);
        assertEq(uint8(cm.dispute), uint8(IBazaar.DisputeState.RESOLVED));
        assertEq(cm.disputeBond, 0);
        assertEq(bazaar.getInvariant(b, 0).slotsUsed, 0, "slotsUsed 0");
        assertEq(buyer.balance, buyerBefore, "buyer gets dispute bond back");

        // Finalize allowed before the window ends because the dispute is RESOLVED.
        assertLt(block.timestamp, cm.attestedAt + DISPUTE_WINDOW);
        uint256 treasuryBefore = treasury.balance;
        uint256 sellerBefore = seller.balance;
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Finalized(c, IBazaar.Outcome.FAIL, 0);
        bazaar.finalize(c);
        assertEq(treasury.balance - treasuryBefore, BOND, "seller bond to treasury");
        assertEq(seller.balance, sellerBefore);
        assertEq(bazaar.getBounty(b).escrow, REWARD);
        assertConservation();
    }

    function test_BuyerDisputeUpheld() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 sellerBefore = seller.balance;
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        attestPass(c, CONTENT, SALT);

        vm.prank(buyer);
        bazaar.dispute{value: DISPUTE_BOND}(c);

        vm.prank(arbiter);
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Resolved(c, IBazaar.Outcome.PASS, false);
        bazaar.resolve(c, IBazaar.Outcome.PASS);

        assertEq(seller.balance, sellerBefore - BOND + DISPUTE_BOND, "seller receives dispute bond");
        assertEq(bazaar.getInvariant(b, 0).slotsUsed, 1);
        assertTrue(bazaar.getCommit(c).slotHeld);

        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Finalized(c, IBazaar.Outcome.PASS, paidEvt(REWARD, BOND));
        bazaar.finalize(c);
        assertEq(seller.balance, sellerBefore + DISPUTE_BOND + REWARD, "finalize pays reward");
        assertEq(bazaar.getBounty(b).escrow, 0);
        assertConservation();
    }

    function test_SellerDisputeOverturned() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 sellerBefore = seller.balance;
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        attestFail(c);
        assertEq(bazaar.getInvariant(b, 0).slotsUsed, 0);

        vm.prank(seller);
        bazaar.dispute{value: DISPUTE_BOND}(c);

        vm.prank(arbiter);
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Resolved(c, IBazaar.Outcome.PASS, true);
        bazaar.resolve(c, IBazaar.Outcome.PASS);

        IBazaar.Commit memory cm = bazaar.getCommit(c);
        assertEq(uint8(cm.outcome), uint8(IBazaar.Outcome.PASS));
        assertTrue(cm.slotHeld, "slot taken");
        assertEq(bazaar.getInvariant(b, 0).slotsUsed, 1, "slot taken");
        assertEq(seller.balance, sellerBefore - BOND, "dispute bond returned on resolve");

        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Finalized(c, IBazaar.Outcome.PASS, paidEvt(REWARD, BOND));
        bazaar.finalize(c);
        assertEq(seller.balance, sellerBefore + REWARD, "seller paid reward + bond + dispute bond back");
        assertConservation();
    }

    function test_DisputeWindowAndParties() public {
        uint256 b = postSimple(REWARD, 2, DAY);

        // dispute after window
        uint256 a = commitFor(b, 0, CONTENT, SALT, BOND);
        attestPass(a, CONTENT, SALT);
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        vm.prank(buyer);
        vm.expectRevert(IBazaar.WindowClosed.selector);
        bazaar.dispute{value: DISPUTE_BOND}(a);

        // dispute by wrong party
        uint256 c = commitAs(seller2, b, 0, CONTENT, SALT, BOND);
        attestPass(c, CONTENT, SALT);
        vm.prank(seller2);
        vm.expectRevert(IBazaar.NotParty.selector);
        bazaar.dispute{value: DISPUTE_BOND}(c);
        vm.prank(rando);
        vm.expectRevert(IBazaar.NotParty.selector);
        bazaar.dispute{value: DISPUTE_BOND}(c);

        // dispute twice
        vm.prank(buyer);
        bazaar.dispute{value: DISPUTE_BOND}(c);
        vm.prank(buyer);
        vm.expectRevert(IBazaar.AlreadyDisputed.selector);
        bazaar.dispute{value: DISPUTE_BOND}(c);
    }

    function test_ReclaimAfterTimeout() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 sellerBefore = seller.balance;
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        assertEq(bazaar.getBounty(b).pending, 1);

        warpPastTimeout();
        vm.prank(seller);
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Reclaimed(c);
        bazaar.reclaimBond(c);

        assertEq(seller.balance, sellerBefore, "bond back");
        assertEq(bazaar.getInvariant(b, 0).cursor, 1, "cursor 1");
        assertEq(bazaar.getBounty(b).pending, 0, "pending 0");
        IBazaar.Commit memory cm = bazaar.getCommit(c);
        assertEq(uint8(cm.outcome), uint8(IBazaar.Outcome.RECLAIMED));
        assertTrue(cm.finalized);

        vm.prank(verifier);
        vm.expectRevert(IBazaar.AlreadyAttested.selector);
        bazaar.attest(c, IBazaar.Outcome.PASS, K, false, CONTENT, SALT, TRACE);

        warpPastExpiry(b);
        bazaar.expire(b);
        assertEq(uint8(bazaar.getBounty(b).status), uint8(IBazaar.BountyStatus.CLOSED));
        assertConservation();
    }

    function test_ReclaimTooEarlyAndOutOfOrder() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 a = commitFor(b, 0, CONTENT, SALT, BOND);
        uint256 c = commitAs(seller2, b, 0, CONTENT, SALT, BOND);

        vm.prank(seller);
        vm.expectRevert(IBazaar.TooEarly.selector);
        bazaar.reclaimBond(a);

        warpPastTimeout();
        vm.prank(seller2);
        vm.expectRevert(IBazaar.NotNextInQueue.selector);
        bazaar.reclaimBond(c);

        vm.prank(seller);
        bazaar.reclaimBond(a);
        vm.prank(seller2);
        bazaar.reclaimBond(c);
        assertEq(bazaar.getInvariant(b, 0).cursor, 2);
        assertEq(bazaar.getBounty(b).pending, 0);
    }

    function test_VoidBounty() public {
        uint256 buyerBefore = buyer.balance;
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 sellerBefore = seller.balance;
        uint256 seller2Before = seller2.balance;
        uint256 treasuryBefore = treasury.balance;

        uint256 a = commitFor(b, 0, CONTENT, SALT, BOND);
        uint256 c = commitAs(seller2, b, 0, CONTENT, SALT, BOND);

        attestVoid(a);
        assertEq(uint8(bazaar.getCommit(a).outcome), uint8(IBazaar.Outcome.VOID));

        vm.prank(verifier);
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.BountyVoided(b);
        bazaar.voidBounty(b);
        assertEq(uint8(bazaar.getBounty(b).status), uint8(IBazaar.BountyStatus.VOIDED));

        // B reclaims immediately (no timeout needed on a VOIDED bounty).
        vm.prank(seller2);
        bazaar.reclaimBond(c);
        assertEq(seller2.balance, seller2Before);

        warpPastWindow();
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Finalized(a, IBazaar.Outcome.VOID, paidEvt(0, BOND));
        bazaar.finalize(a);
        assertEq(seller.balance, sellerBefore, "VOID returns bond");
        assertEq(treasury.balance, treasuryBefore, "no slashes");

        // expire succeeds before expiry because the bounty is VOIDED.
        assertLt(block.timestamp, bazaar.getBounty(b).expiry);
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.BountyExpired(b, REWARD);
        bazaar.expire(b);
        assertEq(buyer.balance, buyerBefore, "escrow refunded");
        assertEq(bazaar.getBounty(b).escrow, 0);
        assertEq(uint8(bazaar.getBounty(b).status), uint8(IBazaar.BountyStatus.CLOSED));
        assertConservation();
    }

    function test_ExpireBlockedByPending() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint64 expiry = bazaar.getBounty(b).expiry;
        vm.warp(expiry - 60);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);

        vm.warp(expiry + 1);
        vm.expectRevert(IBazaar.PendingCommits.selector);
        bazaar.expire(b);

        attestPass(c, CONTENT, SALT); // attest is allowed after expiry
        warpPastWindow();
        bazaar.finalize(c);
        bazaar.expire(b);
        assertEq(uint8(bazaar.getBounty(b).status), uint8(IBazaar.BountyStatus.CLOSED));
    }

    function test_TieredPayout() public {
        uint256 buyerBefore = buyer.balance;
        uint256 b = postWithControl(REWARD, 1, DAY, 2500);
        uint256 sellerBefore = seller.balance;
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);

        vm.prank(verifier);
        vm.expectEmit(true, true, true, true, address(bazaar));
        emit IBazaar.Attested(c, b, 0, seller, IBazaar.Outcome.PASS, K, true, CONTENT, SALT, TRACE);
        bazaar.attest(c, IBazaar.Outcome.PASS, K, true, CONTENT, SALT, TRACE);
        assertTrue(bazaar.getCommit(c).breaksControl);

        warpPastWindow();
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Finalized(c, IBazaar.Outcome.PASS, paidEvt(0.005 ether, BOND));
        bazaar.finalize(c);
        assertEq(seller.balance - sellerBefore, 0.005 ether, "seller +0.005");
        assertEq(bazaar.getBounty(b).escrow, 0.015 ether);

        warpPastExpiry(b);
        bazaar.expire(b);
        assertEq(buyerBefore - buyer.balance, 0.005 ether, "buyer refunded 0.015");
        assertConservation();
    }

    function test_CancelGrace() public {
        uint256 b = postSimple(REWARD, 3, 48 hours);
        uint64 cancelTime = uint64(block.timestamp);

        vm.prank(buyer);
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.BountyCancelling(b, cancelTime + CANCEL_GRACE);
        bazaar.cancel(b);

        assertEq(bazaar.getBounty(b).expiry, cancelTime + CANCEL_GRACE, "expiry == cancel time + grace");
        assertEq(uint8(bazaar.getBounty(b).status), uint8(IBazaar.BountyStatus.OPEN));

        vm.warp(cancelTime + 5 minutes);
        commitFor(b, 0, CONTENT, SALT, BOND);

        vm.warp(cancelTime + 11 minutes);
        vm.prank(seller2);
        vm.expectRevert(IBazaar.PastExpiry.selector);
        bazaar.commit{value: BOND}(b, 0, commitment(CONTENT, SALT));
    }

    function test_PostValidation() public {
        (uint96[] memory r, uint8[] memory s) = _single(REWARD, 1);
        uint64 expiry = uint64(block.timestamp) + DAY;

        // wrong msg.value
        vm.prank(buyer);
        vm.expectRevert(IBazaar.WrongValue.selector);
        bazaar.postBounty{value: REWARD - 1}(MANIFEST, bytes32(0), r, s, expiry, MIN_BOND, K, 0);

        // empty invariants
        vm.prank(buyer);
        vm.expectRevert(IBazaar.BadInvariants.selector);
        bazaar.postBounty{value: 0}(MANIFEST, bytes32(0), new uint96[](0), new uint8[](0), expiry, MIN_BOND, K, 0);

        // tier > 10000
        vm.prank(buyer);
        vm.expectRevert(IBazaar.BadTier.selector);
        bazaar.postBounty{value: REWARD}(MANIFEST, CONTROL, r, s, expiry, MIN_BOND, K, 10_001);

        // expiry in past
        vm.prank(buyer);
        vm.expectRevert(IBazaar.BadExpiry.selector);
        bazaar.postBounty{value: REWARD}(MANIFEST, bytes32(0), r, s, uint64(block.timestamp) - 1, MIN_BOND, K, 0);

        assertEq(bazaar.bountyCount(), 0);
    }

    function test_PayFallbackOwed() public {
        RejectingReceiver rejecting = new RejectingReceiver();
        ForwardingWrapper wrapper = new ForwardingWrapper(address(rejecting));
        vm.deal(address(wrapper), 1 ether);
        vm.deal(address(rejecting), 1 ether);
        address[] memory extra = new address[](2);
        extra[0] = address(wrapper);
        extra[1] = address(rejecting);

        uint256 b = postSimple(REWARD, 2, DAY);

        // Seller 1: the wrapper (currently forwarding into a rejecting sink, so it cannot receive).
        uint256 c1 = wrapper.commitTo{value: BOND}(bazaar, b, 0, commitment(CONTENT, SALT));
        // Seller 2: the plain rejecting contract.
        uint256 c2 = rejecting.commitTo{value: BOND}(bazaar, b, 0, commitment(CONTENT, SALT));
        assertConservation(extra);

        attestPass(c1, CONTENT, SALT);
        attestPass(c2, CONTENT, SALT);
        warpPastWindow();

        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Finalized(c1, IBazaar.Outcome.PASS, paidEvt(REWARD, BOND));
        bazaar.finalize(c1);
        assertEq(bazaar.owed(address(wrapper)), REWARD + BOND, "owed[seller] == amount");
        assertTrue(bazaar.getCommit(c1).finalized);
        assertConservation(extra);

        bazaar.finalize(c2);
        assertEq(bazaar.owed(address(rejecting)), REWARD + BOND);
        assertConservation(extra);

        // A recipient that still cannot receive gets TransferFailed and keeps its owed balance.
        vm.expectRevert(IBazaar.TransferFailed.selector);
        rejecting.pullOwed(address(bazaar));
        assertEq(bazaar.owed(address(rejecting)), REWARD + BOND);

        // Re-point the wrapper at an EOA and withdraw: ETH flows bazaar -> wrapper -> seller.
        wrapper.setSink(seller);
        uint256 sellerBefore = seller.balance;
        wrapper.pullOwed(address(bazaar));
        assertEq(seller.balance - sellerBefore, REWARD + BOND, "withdraw via forwarding wrapper");
        assertEq(bazaar.owed(address(wrapper)), 0);
        assertConservation(extra);
    }

    // =====================================================================
    // Error coverage
    // =====================================================================

    function test_Revert_NoSuchBounty() public {
        uint256 missing = 99;
        vm.prank(seller);
        vm.expectRevert(IBazaar.NoSuchBounty.selector);
        bazaar.commit{value: BOND}(missing, 0, commitment(CONTENT, SALT));

        vm.prank(buyer);
        vm.expectRevert(IBazaar.NoSuchBounty.selector);
        bazaar.cancel(missing);

        vm.prank(verifier);
        vm.expectRevert(IBazaar.NoSuchBounty.selector);
        bazaar.voidBounty(missing);

        vm.expectRevert(IBazaar.NoSuchBounty.selector);
        bazaar.expire(missing);
    }

    function test_Revert_NoSuchCommit() public {
        vm.prank(verifier);
        vm.expectRevert(IBazaar.NoSuchCommit.selector);
        bazaar.attest(99, IBazaar.Outcome.PASS, K, false, CONTENT, SALT, TRACE);
    }

    function test_Revert_NoSuchInvariant() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        vm.prank(seller);
        vm.expectRevert(IBazaar.NoSuchInvariant.selector);
        bazaar.commit{value: BOND}(b, 1, commitment(CONTENT, SALT));
    }

    function test_Revert_BadCommitment() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        vm.prank(seller);
        vm.expectRevert(IBazaar.BadCommitment.selector);
        bazaar.commit{value: BOND}(b, 0, bytes32(0));
    }

    function test_Revert_BondTooLow() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        vm.prank(seller);
        vm.expectRevert(IBazaar.BondTooLow.selector);
        bazaar.commit{value: MIN_BOND - 1}(b, 0, commitment(CONTENT, SALT));

        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        attestPass(c, CONTENT, SALT);
        vm.prank(buyer);
        vm.expectRevert(IBazaar.BondTooLow.selector);
        bazaar.dispute{value: DISPUTE_BOND - 1}(c);
    }

    function test_Revert_BondTooHigh() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 tooMuch = uint256(type(uint96).max) + 1;
        vm.deal(seller, tooMuch);
        vm.prank(seller);
        vm.expectRevert(IBazaar.BondTooHigh.selector);
        bazaar.commit{value: tooMuch}(b, 0, commitment(CONTENT, SALT));
    }

    function test_Revert_BountyNotOpen() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        vm.prank(verifier);
        bazaar.voidBounty(b);

        vm.prank(seller);
        vm.expectRevert(IBazaar.BountyNotOpen.selector);
        bazaar.commit{value: BOND}(b, 0, commitment(CONTENT, SALT));

        vm.prank(buyer);
        vm.expectRevert(IBazaar.BountyNotOpen.selector);
        bazaar.cancel(b);

        vm.prank(verifier);
        vm.expectRevert(IBazaar.BountyNotOpen.selector);
        bazaar.voidBounty(b);

        // CLOSED is not open either.
        bazaar.expire(b);
        vm.prank(seller);
        vm.expectRevert(IBazaar.BountyNotOpen.selector);
        bazaar.commit{value: BOND}(b, 0, commitment(CONTENT, SALT));
    }

    function test_Revert_PastExpiry() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        vm.warp(bazaar.getBounty(b).expiry);
        vm.prank(seller);
        vm.expectRevert(IBazaar.PastExpiry.selector);
        bazaar.commit{value: BOND}(b, 0, commitment(CONTENT, SALT));
    }

    function test_Revert_NotVerifier() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);

        vm.prank(rando);
        vm.expectRevert(IBazaar.NotVerifier.selector);
        bazaar.attest(c, IBazaar.Outcome.PASS, K, false, CONTENT, SALT, TRACE);

        vm.prank(rando);
        vm.expectRevert(IBazaar.NotVerifier.selector);
        bazaar.voidBounty(b);

        // The set is consulted live: removing the verifier revokes it.
        verifierSet.set(verifier, false);
        vm.prank(verifier);
        vm.expectRevert(IBazaar.NotVerifier.selector);
        bazaar.attest(c, IBazaar.Outcome.PASS, K, false, CONTENT, SALT, TRACE);
    }

    function test_Revert_AlreadyAttested() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        attestPass(c, CONTENT, SALT);

        vm.prank(verifier);
        vm.expectRevert(IBazaar.AlreadyAttested.selector);
        bazaar.attest(c, IBazaar.Outcome.FAIL, 0, false, bytes32(0), bytes32(0), TRACE);

        warpPastTimeout();
        vm.prank(seller);
        vm.expectRevert(IBazaar.AlreadyAttested.selector);
        bazaar.reclaimBond(c);
    }

    function test_Revert_NotNextInQueue() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        commitFor(b, 0, CONTENT, SALT, BOND);
        uint256 c = commitAs(seller2, b, 0, CONTENT, SALT, BOND);

        vm.prank(verifier);
        vm.expectRevert(IBazaar.NotNextInQueue.selector);
        bazaar.attest(c, IBazaar.Outcome.FAIL, 0, false, bytes32(0), bytes32(0), TRACE);

        warpPastTimeout();
        vm.prank(seller2);
        vm.expectRevert(IBazaar.NotNextInQueue.selector);
        bazaar.reclaimBond(c);
    }

    function test_Revert_CommitmentMismatch() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        vm.prank(verifier);
        vm.expectRevert(IBazaar.CommitmentMismatch.selector);
        bazaar.attest(c, IBazaar.Outcome.PASS, K, false, keccak256("other"), SALT, TRACE);
    }

    function test_Revert_BadOutcome() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);

        vm.prank(verifier);
        vm.expectRevert(IBazaar.BadOutcome.selector);
        bazaar.attest(c, IBazaar.Outcome.NONE, K, false, CONTENT, SALT, TRACE);
        vm.prank(verifier);
        vm.expectRevert(IBazaar.BadOutcome.selector);
        bazaar.attest(c, IBazaar.Outcome.PASS_NO_SLOT, K, false, CONTENT, SALT, TRACE);
        vm.prank(verifier);
        vm.expectRevert(IBazaar.BadOutcome.selector);
        bazaar.attest(c, IBazaar.Outcome.RECLAIMED, K, false, CONTENT, SALT, TRACE);

        attestPass(c, CONTENT, SALT);
        vm.prank(buyer);
        bazaar.dispute{value: DISPUTE_BOND}(c);

        vm.prank(arbiter);
        vm.expectRevert(IBazaar.BadOutcome.selector);
        bazaar.resolve(c, IBazaar.Outcome.VOID);
        vm.prank(arbiter);
        vm.expectRevert(IBazaar.BadOutcome.selector);
        bazaar.resolve(c, IBazaar.Outcome.NONE);
        vm.prank(arbiter);
        vm.expectRevert(IBazaar.BadOutcome.selector);
        bazaar.resolve(c, IBazaar.Outcome.PASS_NO_SLOT);
        vm.prank(arbiter);
        vm.expectRevert(IBazaar.BadOutcome.selector);
        bazaar.resolve(c, IBazaar.Outcome.RECLAIMED);
    }

    function test_Revert_NoControl() public {
        uint256 b = postSimple(REWARD, 1, DAY); // controlHash == 0x0
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        vm.prank(verifier);
        vm.expectRevert(IBazaar.NoControl.selector);
        bazaar.attest(c, IBazaar.Outcome.PASS, K, true, CONTENT, SALT, TRACE);
    }

    function test_Revert_NotArbiter() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        attestPass(c, CONTENT, SALT);
        vm.prank(buyer);
        bazaar.dispute{value: DISPUTE_BOND}(c);

        vm.prank(rando);
        vm.expectRevert(IBazaar.NotArbiter.selector);
        bazaar.resolve(c, IBazaar.Outcome.FAIL);
    }

    function test_Revert_NoOpenDispute() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        attestPass(c, CONTENT, SALT);

        vm.prank(arbiter);
        vm.expectRevert(IBazaar.NoOpenDispute.selector);
        bazaar.resolve(c, IBazaar.Outcome.FAIL);

        vm.prank(buyer);
        bazaar.dispute{value: DISPUTE_BOND}(c);
        vm.prank(arbiter);
        bazaar.resolve(c, IBazaar.Outcome.PASS);

        vm.prank(arbiter);
        vm.expectRevert(IBazaar.NoOpenDispute.selector);
        bazaar.resolve(c, IBazaar.Outcome.FAIL);
    }

    function test_Revert_NotDisputable() public {
        uint256 b = postSimple(REWARD, 1, DAY);

        // NONE
        uint256 a = commitFor(b, 0, CONTENT, SALT, BOND);
        vm.prank(buyer);
        vm.expectRevert(IBazaar.NotDisputable.selector);
        bazaar.dispute{value: DISPUTE_BOND}(a);

        // VOID
        attestVoid(a);
        vm.prank(buyer);
        vm.expectRevert(IBazaar.NotDisputable.selector);
        bazaar.dispute{value: DISPUTE_BOND}(a);
        vm.prank(seller);
        vm.expectRevert(IBazaar.NotDisputable.selector);
        bazaar.dispute{value: DISPUTE_BOND}(a);

        // PASS_NO_SLOT
        uint256 p = commitFor(b, 0, CONTENT, SALT, BOND);
        uint256 q = commitAs(seller2, b, 0, CONTENT, SALT, BOND);
        attestPass(p, CONTENT, SALT);
        attestPass(q, CONTENT, SALT);
        assertEq(uint8(bazaar.getCommit(q).outcome), uint8(IBazaar.Outcome.PASS_NO_SLOT));
        vm.prank(buyer);
        vm.expectRevert(IBazaar.NotDisputable.selector);
        bazaar.dispute{value: DISPUTE_BOND}(q);
        vm.prank(seller2);
        vm.expectRevert(IBazaar.NotDisputable.selector);
        bazaar.dispute{value: DISPUTE_BOND}(q);
    }

    function test_Revert_NotParty() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);

        // reclaim by non-seller
        warpPastTimeout();
        vm.prank(rando);
        vm.expectRevert(IBazaar.NotParty.selector);
        bazaar.reclaimBond(c);

        // cancel by non-buyer
        vm.prank(rando);
        vm.expectRevert(IBazaar.NotParty.selector);
        bazaar.cancel(b);

        // dispute PASS by the seller / FAIL by the buyer
        attestPass(c, CONTENT, SALT);
        vm.prank(seller);
        vm.expectRevert(IBazaar.NotParty.selector);
        bazaar.dispute{value: DISPUTE_BOND}(c);

        uint256 d = commitAs(seller2, b, 0, CONTENT, SALT, BOND);
        attestFail(d);
        vm.prank(buyer);
        vm.expectRevert(IBazaar.NotParty.selector);
        bazaar.dispute{value: DISPUTE_BOND}(d);
    }

    function test_Revert_AlreadyDisputed() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        attestPass(c, CONTENT, SALT);
        vm.prank(buyer);
        bazaar.dispute{value: DISPUTE_BOND}(c);
        vm.prank(buyer);
        vm.expectRevert(IBazaar.AlreadyDisputed.selector);
        bazaar.dispute{value: DISPUTE_BOND}(c);
    }

    function test_Revert_WindowClosed() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        attestPass(c, CONTENT, SALT);
        vm.warp(block.timestamp + DISPUTE_WINDOW); // now == attestedAt + window is already closed
        vm.prank(buyer);
        vm.expectRevert(IBazaar.WindowClosed.selector);
        bazaar.dispute{value: DISPUTE_BOND}(c);
    }

    function test_Revert_NotAttested() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);

        vm.expectRevert(IBazaar.NotAttested.selector);
        bazaar.finalize(c);

        warpPastTimeout();
        vm.prank(seller);
        bazaar.reclaimBond(c);
        vm.expectRevert(IBazaar.NotAttested.selector);
        bazaar.finalize(c);
    }

    function test_Revert_AlreadyFinalized() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        attestPass(c, CONTENT, SALT);
        warpPastWindow();
        bazaar.finalize(c);

        vm.expectRevert(IBazaar.AlreadyFinalized.selector);
        bazaar.finalize(c);

        vm.prank(buyer);
        vm.expectRevert(IBazaar.AlreadyFinalized.selector);
        bazaar.dispute{value: DISPUTE_BOND}(c);
    }

    function test_Revert_DisputeOpen() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        attestPass(c, CONTENT, SALT);
        vm.prank(buyer);
        bazaar.dispute{value: DISPUTE_BOND}(c);

        vm.expectRevert(IBazaar.DisputeOpen.selector);
        bazaar.finalize(c);
        warpPastWindow();
        vm.expectRevert(IBazaar.DisputeOpen.selector);
        bazaar.finalize(c);
    }

    function test_Revert_WindowOpen() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        attestPass(c, CONTENT, SALT);
        vm.expectRevert(IBazaar.WindowOpen.selector);
        bazaar.finalize(c);
        vm.warp(block.timestamp + DISPUTE_WINDOW - 1);
        vm.expectRevert(IBazaar.WindowOpen.selector);
        bazaar.finalize(c);
        vm.warp(block.timestamp + 1); // now == attestedAt + window is allowed
        bazaar.finalize(c);
    }

    function test_Revert_TooEarly() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        vm.warp(block.timestamp + ATTEST_TIMEOUT); // now == committedAt + timeout is still too early (strict >)
        vm.prank(seller);
        vm.expectRevert(IBazaar.TooEarly.selector);
        bazaar.reclaimBond(c);
        vm.warp(block.timestamp + 1);
        vm.prank(seller);
        bazaar.reclaimBond(c);
    }

    function test_Revert_BountyClosed() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        warpPastExpiry(b);
        bazaar.expire(b);
        vm.expectRevert(IBazaar.BountyClosed.selector);
        bazaar.expire(b);
    }

    function test_Revert_NotExpired() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        vm.expectRevert(IBazaar.NotExpired.selector);
        bazaar.expire(b);
        vm.warp(bazaar.getBounty(b).expiry - 1);
        vm.expectRevert(IBazaar.NotExpired.selector);
        bazaar.expire(b);
        vm.warp(bazaar.getBounty(b).expiry); // now >= expiry is enough
        bazaar.expire(b);
    }

    function test_Revert_PendingCommits() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        commitFor(b, 0, CONTENT, SALT, BOND);
        warpPastExpiry(b);
        vm.expectRevert(IBazaar.PendingCommits.selector);
        bazaar.expire(b);
    }

    function test_Revert_NotOwner() public {
        vm.startPrank(rando);
        vm.expectRevert(IBazaar.NotOwner.selector);
        bazaar.setVerifierSet(address(verifierSet));
        vm.expectRevert(IBazaar.NotOwner.selector);
        bazaar.setArbiter(rando);
        vm.expectRevert(IBazaar.NotOwner.selector);
        bazaar.setTreasury(rando);
        vm.expectRevert(IBazaar.NotOwner.selector);
        bazaar.setTimings(1, 2, 3, 4);
        vm.expectRevert(IBazaar.NotOwner.selector);
        bazaar.transferOwnership(rando);
        vm.stopPrank();
    }

    function test_Revert_ZeroAddress() public {
        vm.expectRevert(IBazaar.ZeroAddress.selector);
        bazaar.setVerifierSet(address(0));
        vm.expectRevert(IBazaar.ZeroAddress.selector);
        bazaar.setArbiter(address(0));
        vm.expectRevert(IBazaar.ZeroAddress.selector);
        bazaar.setTreasury(address(0));
        vm.expectRevert(IBazaar.ZeroAddress.selector);
        bazaar.transferOwnership(address(0));
    }

    function test_Revert_BadInvariants() public {
        uint64 expiry = uint64(block.timestamp) + DAY;
        vm.startPrank(buyer);

        // empty
        vm.expectRevert(IBazaar.BadInvariants.selector);
        bazaar.postBounty{value: 0}(MANIFEST, bytes32(0), new uint96[](0), new uint8[](0), expiry, MIN_BOND, K, 0);

        // > 32
        uint96[] memory r33 = new uint96[](33);
        uint8[] memory s33 = new uint8[](33);
        for (uint256 i = 0; i < 33; i++) {
            r33[i] = 1;
            s33[i] = 1;
        }
        vm.expectRevert(IBazaar.BadInvariants.selector);
        bazaar.postBounty{value: 33}(MANIFEST, bytes32(0), r33, s33, expiry, MIN_BOND, K, 0);

        // mismatched lengths
        uint96[] memory r2 = new uint96[](2);
        r2[0] = REWARD;
        r2[1] = REWARD;
        uint8[] memory s1 = new uint8[](1);
        s1[0] = 1;
        vm.expectRevert(IBazaar.BadInvariants.selector);
        bazaar.postBounty{value: 2 * uint256(REWARD)}(MANIFEST, bytes32(0), r2, s1, expiry, MIN_BOND, K, 0);

        // zero reward
        (uint96[] memory r0, uint8[] memory s0) = _single(0, 1);
        vm.expectRevert(IBazaar.BadInvariants.selector);
        bazaar.postBounty{value: 0}(MANIFEST, bytes32(0), r0, s0, expiry, MIN_BOND, K, 0);

        // zero slots
        (uint96[] memory rz, uint8[] memory sz) = _single(REWARD, 0);
        vm.expectRevert(IBazaar.BadInvariants.selector);
        bazaar.postBounty{value: 0}(MANIFEST, bytes32(0), rz, sz, expiry, MIN_BOND, K, 0);

        vm.stopPrank();

        // exactly 32 is fine
        uint96[] memory r32 = new uint96[](32);
        uint8[] memory s32 = new uint8[](32);
        for (uint256 i = 0; i < 32; i++) {
            r32[i] = 1;
            s32[i] = 1;
        }
        uint256 b = postAs(buyer, r32, s32, expiry, bytes32(0), 0);
        assertEq(bazaar.invariantCount(b), 32);
    }

    function test_Revert_BadExpiry() public {
        (uint96[] memory r, uint8[] memory s) = _single(REWARD, 1);
        vm.startPrank(buyer);
        vm.expectRevert(IBazaar.BadExpiry.selector);
        bazaar.postBounty{value: REWARD}(MANIFEST, bytes32(0), r, s, uint64(block.timestamp), MIN_BOND, K, 0);
        vm.expectRevert(IBazaar.BadExpiry.selector);
        bazaar.postBounty{value: REWARD}(MANIFEST, bytes32(0), r, s, uint64(block.timestamp) - 1, MIN_BOND, K, 0);
        vm.stopPrank();
    }

    function test_Revert_BadTier() public {
        (uint96[] memory r, uint8[] memory s) = _single(REWARD, 1);
        vm.prank(buyer);
        vm.expectRevert(IBazaar.BadTier.selector);
        bazaar.postBounty{value: REWARD}(MANIFEST, CONTROL, r, s, uint64(block.timestamp) + DAY, MIN_BOND, K, 10_001);

        // 10000 exactly is allowed
        uint256 b = postWithControl(REWARD, 1, DAY, 10_000);
        assertEq(bazaar.getBounty(b).controlTierBps, 10_000);
    }

    function test_Revert_BadK() public {
        (uint96[] memory r, uint8[] memory s) = _single(REWARD, 1);
        vm.prank(buyer);
        vm.expectRevert(IBazaar.BadK.selector);
        bazaar.postBounty{value: REWARD}(MANIFEST, bytes32(0), r, s, uint64(block.timestamp) + DAY, MIN_BOND, 0, 0);
    }

    function test_Revert_WrongValue() public {
        (uint96[] memory r, uint8[] memory s) = _single(REWARD, 2);
        uint64 expiry = uint64(block.timestamp) + DAY;
        vm.startPrank(buyer);
        vm.expectRevert(IBazaar.WrongValue.selector);
        bazaar.postBounty{value: 2 * uint256(REWARD) - 1}(MANIFEST, bytes32(0), r, s, expiry, MIN_BOND, K, 0);
        vm.expectRevert(IBazaar.WrongValue.selector);
        bazaar.postBounty{value: 2 * uint256(REWARD) + 1}(MANIFEST, bytes32(0), r, s, expiry, MIN_BOND, K, 0);
        vm.expectRevert(IBazaar.WrongValue.selector);
        bazaar.postBounty{value: REWARD}(MANIFEST, bytes32(0), r, s, expiry, MIN_BOND, K, 0);
        vm.stopPrank();
    }

    function test_Revert_TransferFailed() public {
        RejectingReceiver rejecting = new RejectingReceiver();
        vm.deal(address(rejecting), 1 ether);
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = rejecting.commitTo{value: BOND}(bazaar, b, 0, commitment(CONTENT, SALT));
        attestPass(c, CONTENT, SALT);
        warpPastWindow();
        bazaar.finalize(c);
        assertEq(bazaar.owed(address(rejecting)), REWARD + BOND);
        vm.expectRevert(IBazaar.TransferFailed.selector);
        rejecting.pullOwed(address(bazaar));
    }

    function test_ReentrantFinalizeBlocked() public {
        ReentrantSeller attacker = new ReentrantSeller(bazaar);
        vm.deal(address(attacker), 1 ether);
        address[] memory extra = new address[](1);
        extra[0] = address(attacker);

        uint256 b = postSimple(REWARD, 2, DAY);
        uint256 a = attacker.commitTo{value: BOND}(b, 0, commitment(CONTENT, SALT));
        uint256 c = attacker.commitTo{value: BOND}(b, 0, commitment(CONTENT, SALT));
        attestPass(a, CONTENT, SALT);
        attestPass(c, CONTENT, SALT);
        warpPastWindow();

        attacker.arm(c);
        bazaar.finalize(a);

        // The nested finalize(c) reverted (Reentrancy), so the payout fell back to owed and c is untouched.
        assertTrue(bazaar.getCommit(a).finalized);
        assertFalse(bazaar.getCommit(c).finalized, "re-entered finalize must not succeed");
        assertEq(bazaar.owed(address(attacker)), REWARD + BOND);
        assertEq(bazaar.getBounty(b).escrow, REWARD);
        assertEq(bazaar.getBounty(b).pending, 1);
        assertConservation(extra);

        attacker.disarm();
        bazaar.finalize(c);
        // the test contract funded both bonds via commitTo, so the attacker only ever gains.
        assertEq(address(attacker).balance, 1 ether + REWARD + BOND);
        assertConservation(extra);
    }

    // =====================================================================
    // Behaviour
    // =====================================================================

    function test_AttestAllowedAfterExpiryAndOnVoided() public {
        // after expiry
        uint256 b1 = postSimple(REWARD, 1, DAY);
        uint256 c1 = commitFor(b1, 0, CONTENT, SALT, BOND);
        warpPastExpiry(b1);
        attestPass(c1, CONTENT, SALT);
        assertEq(uint8(bazaar.getCommit(c1).outcome), uint8(IBazaar.Outcome.PASS));

        // on a VOIDED bounty
        uint256 b2 = postSimple(REWARD, 1, DAY);
        uint256 c2 = commitFor(b2, 0, CONTENT, SALT, BOND);
        vm.prank(verifier);
        bazaar.voidBounty(b2);
        attestPass(c2, CONTENT, SALT);
        assertEq(uint8(bazaar.getCommit(c2).outcome), uint8(IBazaar.Outcome.PASS));

        // and both still settle normally
        warpPastWindow();
        uint256 sellerBefore = seller.balance;
        bazaar.finalize(c1);
        bazaar.finalize(c2);
        assertEq(seller.balance - sellerBefore, 2 * (uint256(REWARD) + BOND));
    }

    function test_ResolveUpheldPaysCounterparty() public {
        uint256 b = postSimple(REWARD, 2, DAY);

        // PASS disputed by buyer, resolve PASS -> seller gets the dispute bond.
        uint256 a = commitFor(b, 0, CONTENT, SALT, BOND);
        attestPass(a, CONTENT, SALT);
        vm.prank(buyer);
        bazaar.dispute{value: DISPUTE_BOND}(a);
        uint256 sellerBefore = seller.balance;
        uint256 buyerBefore = buyer.balance;
        vm.prank(arbiter);
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Resolved(a, IBazaar.Outcome.PASS, false);
        bazaar.resolve(a, IBazaar.Outcome.PASS);
        assertEq(seller.balance - sellerBefore, DISPUTE_BOND);
        assertEq(buyer.balance, buyerBefore);

        // FAIL disputed by seller, resolve FAIL -> buyer gets the dispute bond.
        uint256 c = commitAs(seller2, b, 0, CONTENT, SALT, BOND);
        attestFail(c);
        vm.prank(seller2);
        bazaar.dispute{value: DISPUTE_BOND}(c);
        uint256 seller2Before = seller2.balance;
        buyerBefore = buyer.balance;
        vm.prank(arbiter);
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Resolved(c, IBazaar.Outcome.FAIL, false);
        bazaar.resolve(c, IBazaar.Outcome.FAIL);
        assertEq(buyer.balance - buyerBefore, DISPUTE_BOND);
        assertEq(seller2.balance, seller2Before);
        assertEq(uint8(bazaar.getCommit(c).outcome), uint8(IBazaar.Outcome.FAIL));
        assertConservation();
    }

    function test_ResolveFailToPassNoSlotWhenFull() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 a = commitFor(b, 0, CONTENT, SALT, BOND);
        uint256 c = commitAs(seller2, b, 0, CONTENT, SALT, BOND);
        attestPass(a, CONTENT, SALT);
        attestFail(c);
        assertEq(bazaar.getInvariant(b, 0).slotsUsed, 1);

        vm.prank(seller2);
        bazaar.dispute{value: DISPUTE_BOND}(c);
        uint256 seller2Before = seller2.balance;

        vm.prank(arbiter);
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Resolved(c, IBazaar.Outcome.PASS_NO_SLOT, true);
        bazaar.resolve(c, IBazaar.Outcome.PASS);

        IBazaar.Commit memory cm = bazaar.getCommit(c);
        assertEq(uint8(cm.outcome), uint8(IBazaar.Outcome.PASS_NO_SLOT));
        assertFalse(cm.slotHeld);
        assertEq(bazaar.getInvariant(b, 0).slotsUsed, 1, "slot still held by A");
        assertEq(seller2.balance - seller2Before, DISPUTE_BOND, "disputer refunded because outcome changed");

        bazaar.finalize(c);
        assertEq(seller2.balance - seller2Before, DISPUTE_BOND + BOND, "no-slot pays only bond");
        assertEq(bazaar.getBounty(b).escrow, REWARD);
    }

    function test_MultiInvariantIndependentQueues() public {
        uint96[] memory r = new uint96[](2);
        uint8[] memory s = new uint8[](2);
        r[0] = 0.01 ether;
        r[1] = 0.02 ether;
        s[0] = 1;
        s[1] = 2;
        uint256 b = postAs(buyer, r, s, uint64(block.timestamp) + DAY, bytes32(0), 0);
        assertEq(bazaar.getBounty(b).escrow, 0.01 ether + 2 * 0.02 ether, "escrow = sum reward*slots");
        assertEq(bazaar.invariantCount(b), 2);

        uint256 a0 = commitFor(b, 0, CONTENT, SALT, BOND); // inv0 seq0
        uint256 b0 = commitAs(seller2, b, 1, CONTENT, SALT, BOND); // inv1 seq0
        uint256 a1 = commitAs(seller2, b, 0, CONTENT, SALT, BOND); // inv0 seq1
        uint256 b1 = commitFor(b, 1, CONTENT, SALT, BOND); // inv1 seq1
        assertEq(bazaar.getCommit(a0).seq, 0);
        assertEq(bazaar.getCommit(b0).seq, 0);
        assertEq(bazaar.getCommit(a1).seq, 1);
        assertEq(bazaar.getCommit(b1).seq, 1);
        assertEq(bazaar.getInvariant(b, 0).commitCount, 2);
        assertEq(bazaar.getInvariant(b, 1).commitCount, 2);
        assertEq(bazaar.getBounty(b).pending, 4);

        // inv1's head can be attested regardless of inv0's queue.
        attestPass(b0, CONTENT, SALT);
        assertEq(bazaar.getInvariant(b, 1).cursor, 1);
        assertEq(bazaar.getInvariant(b, 0).cursor, 0);

        // inv0's second commit is still blocked by its own head.
        vm.prank(verifier);
        vm.expectRevert(IBazaar.NotNextInQueue.selector);
        bazaar.attest(a1, IBazaar.Outcome.PASS, K, false, CONTENT, SALT, TRACE);

        attestPass(a0, CONTENT, SALT);
        attestPass(a1, CONTENT, SALT); // no slot on inv0
        attestPass(b1, CONTENT, SALT); // second slot on inv1
        assertEq(uint8(bazaar.getCommit(a1).outcome), uint8(IBazaar.Outcome.PASS_NO_SLOT));
        assertEq(uint8(bazaar.getCommit(b1).outcome), uint8(IBazaar.Outcome.PASS));
        assertEq(bazaar.getInvariant(b, 0).slotsUsed, 1);
        assertEq(bazaar.getInvariant(b, 1).slotsUsed, 2);

        warpPastWindow();
        bazaar.finalize(a0);
        bazaar.finalize(a1);
        bazaar.finalize(b0);
        bazaar.finalize(b1);
        assertEq(bazaar.getBounty(b).escrow, 0);
        assertEq(bazaar.getBounty(b).pending, 0);
        assertConservation();
    }

    function test_TieredPayoutRounding() public {
        uint256 b = postWithControl(3, 1, DAY, 3333);
        uint256 sellerBefore = seller.balance;
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        attestPassControl(c, CONTENT, SALT);
        warpPastWindow();

        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.Finalized(c, IBazaar.Outcome.PASS, paidEvt(0, BOND));
        bazaar.finalize(c);
        assertEq(seller.balance, sellerBefore, "paid 0 (3 * 3333 / 10000 rounds to 0)");
        assertEq(bazaar.getBounty(b).escrow, 3, "escrow untouched");

        uint256 buyerBefore = buyer.balance;
        warpPastExpiry(b);
        bazaar.expire(b);
        assertEq(buyer.balance - buyerBefore, 3);
    }

    function test_SlotsMultiple() public {
        uint256 b = postSimple(REWARD, 2, DAY);
        assertEq(bazaar.getBounty(b).escrow, 2 * uint256(REWARD));
        uint256 a = commitFor(b, 0, CONTENT, SALT, BOND);
        uint256 c = commitAs(seller2, b, 0, CONTENT, SALT, BOND);
        uint256 d = commitAs(rando, b, 0, CONTENT, SALT, BOND);

        attestPass(a, CONTENT, SALT);
        attestPass(c, CONTENT, SALT);
        attestPass(d, CONTENT, SALT);
        assertEq(uint8(bazaar.getCommit(a).outcome), uint8(IBazaar.Outcome.PASS));
        assertEq(uint8(bazaar.getCommit(c).outcome), uint8(IBazaar.Outcome.PASS));
        assertEq(uint8(bazaar.getCommit(d).outcome), uint8(IBazaar.Outcome.PASS_NO_SLOT));
        assertEq(bazaar.getInvariant(b, 0).slotsUsed, 2);

        warpPastWindow();
        uint256 sBefore = seller.balance;
        uint256 s2Before = seller2.balance;
        uint256 rBefore = rando.balance;
        bazaar.finalize(a);
        bazaar.finalize(c);
        bazaar.finalize(d);
        assertEq(seller.balance - sBefore, uint256(REWARD) + BOND);
        assertEq(seller2.balance - s2Before, uint256(REWARD) + BOND);
        assertEq(rando.balance - rBefore, BOND);
        assertEq(bazaar.getBounty(b).escrow, 0);
    }

    function test_CancelDoesNotExtendExpiry() public {
        uint256 b = postSimple(REWARD, 1, 5 minutes);
        uint64 original = bazaar.getBounty(b).expiry;
        assertLt(original, block.timestamp + CANCEL_GRACE);

        vm.prank(buyer);
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.BountyCancelling(b, original);
        bazaar.cancel(b);
        assertEq(bazaar.getBounty(b).expiry, original, "expiry sooner than now+grace stays");
    }

    function test_VoidedExpireWaitsForPending() public {
        uint256 b = postSimple(REWARD, 1, DAY);
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        vm.prank(verifier);
        bazaar.voidBounty(b);

        vm.expectRevert(IBazaar.PendingCommits.selector);
        bazaar.expire(b);

        vm.prank(seller);
        bazaar.reclaimBond(c);
        bazaar.expire(b);
        assertEq(uint8(bazaar.getBounty(b).status), uint8(IBazaar.BountyStatus.CLOSED));
    }

    function test_WithdrawZeroIsNoop() public {
        assertEq(bazaar.owed(rando), 0);
        uint256 before = rando.balance;
        vm.prank(rando);
        bazaar.withdraw();
        assertEq(rando.balance, before);
        assertEq(bazaar.owed(rando), 0);
    }

    function test_OwedAccruesAcrossMultiplePayments() public {
        RejectingReceiver rejecting = new RejectingReceiver();
        ForwardingWrapper wrapper = new ForwardingWrapper(address(rejecting));
        vm.deal(address(wrapper), 1 ether);
        address[] memory extra = new address[](1);
        extra[0] = address(wrapper);

        uint256 b = postSimple(REWARD, 2, DAY);
        uint256 a = wrapper.commitTo{value: BOND}(bazaar, b, 0, commitment(CONTENT, SALT));
        uint256 c = wrapper.commitTo{value: BOND}(bazaar, b, 0, commitment(CONTENT, SALT));
        attestPass(a, CONTENT, SALT);
        attestPass(c, CONTENT, SALT);
        warpPastWindow();

        bazaar.finalize(a);
        assertEq(bazaar.owed(address(wrapper)), uint256(REWARD) + BOND);
        bazaar.finalize(c);
        assertEq(bazaar.owed(address(wrapper)), 2 * (uint256(REWARD) + BOND), "owed accumulates");
        assertConservation(extra);

        wrapper.setSink(seller2);
        uint256 before = seller2.balance;
        wrapper.pullOwed(address(bazaar));
        assertEq(seller2.balance - before, 2 * (uint256(REWARD) + BOND));
        assertEq(bazaar.owed(address(wrapper)), 0);
        assertConservation(extra);
    }

    function test_SetTimingsAndOwnership() public {
        assertEq(bazaar.owner(), address(this));
        assertEq(address(bazaar.verifierSet()), address(verifierSet));
        assertEq(bazaar.arbiter(), arbiter);
        assertEq(bazaar.treasury(), treasury);
        assertEq(bazaar.attestTimeout(), ATTEST_TIMEOUT);
        assertEq(bazaar.disputeWindow(), DISPUTE_WINDOW);
        assertEq(bazaar.disputeBond(), DISPUTE_BOND);
        assertEq(bazaar.cancelGrace(), CANCEL_GRACE);

        address newVs = makeAddr("newVerifierSet");
        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.VerifierSetUpdated(newVs);
        bazaar.setVerifierSet(newVs);
        assertEq(address(bazaar.verifierSet()), newVs);
        bazaar.setVerifierSet(address(verifierSet));

        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.ArbiterUpdated(rando);
        bazaar.setArbiter(rando);
        assertEq(bazaar.arbiter(), rando);

        vm.expectEmit(true, false, false, true, address(bazaar));
        emit IBazaar.TreasuryUpdated(rando);
        bazaar.setTreasury(rando);
        assertEq(bazaar.treasury(), rando);

        vm.expectEmit(false, false, false, true, address(bazaar));
        emit IBazaar.TimingsUpdated(1 days, 2 days, 0.05 ether, 1 hours);
        bazaar.setTimings(1 days, 2 days, 0.05 ether, 1 hours);
        assertEq(bazaar.attestTimeout(), 1 days);
        assertEq(bazaar.disputeWindow(), 2 days);
        assertEq(bazaar.disputeBond(), 0.05 ether);
        assertEq(bazaar.cancelGrace(), 1 hours);

        vm.expectEmit(true, true, false, true, address(bazaar));
        emit IBazaar.OwnershipTransferred(address(this), rando);
        bazaar.transferOwnership(rando);
        assertEq(bazaar.owner(), rando);

        // old owner is locked out; new owner works
        vm.expectRevert(IBazaar.NotOwner.selector);
        bazaar.setArbiter(arbiter);
        vm.prank(rando);
        bazaar.setArbiter(arbiter);
        assertEq(bazaar.arbiter(), arbiter);
    }

    function test_Views() public {
        assertEq(bazaar.bountyCount(), 0);
        assertEq(bazaar.commitCount(), 0);

        uint96[] memory r = new uint96[](2);
        uint8[] memory s = new uint8[](2);
        r[0] = 0.01 ether;
        r[1] = 0.02 ether;
        s[0] = 1;
        s[1] = 3;
        uint64 expiry = uint64(block.timestamp) + DAY;

        vm.prank(buyer);
        vm.expectEmit(true, true, false, true, address(bazaar));
        emit IBazaar.BountyPosted(0, buyer, MANIFEST, CONTROL, expiry, MIN_BOND, K, 1234, r, s);
        uint256 b = bazaar.postBounty{value: 0.07 ether}(MANIFEST, CONTROL, r, s, expiry, MIN_BOND, K, 1234);
        assertEq(b, 0);
        assertEq(bazaar.bountyCount(), 1);
        assertEq(bazaar.invariantCount(b), 2);

        IBazaar.BountyInfo memory info = bazaar.getBounty(b);
        assertEq(info.buyer, buyer);
        assertEq(info.manifestHash, MANIFEST);
        assertEq(info.controlHash, CONTROL);
        assertEq(info.expiry, expiry);
        assertEq(info.minBond, MIN_BOND);
        assertEq(info.k, K);
        assertEq(info.controlTierBps, 1234);
        assertEq(info.escrow, 0.07 ether);
        assertEq(info.pending, 0);
        assertEq(uint8(info.status), uint8(IBazaar.BountyStatus.OPEN));
        assertEq(info.invariantCount, 2);

        IBazaar.Invariant memory i1 = bazaar.getInvariant(b, 1);
        assertEq(i1.reward, 0.02 ether);
        assertEq(i1.slots, 3);
        assertEq(i1.slotsUsed, 0);
        assertEq(i1.cursor, 0);
        assertEq(i1.commitCount, 0);

        bytes32 cmt = commitment(CONTENT, SALT);
        vm.prank(seller);
        vm.expectEmit(true, true, true, true, address(bazaar));
        emit IBazaar.Committed(0, b, 1, 0, seller, cmt, BOND);
        uint256 c = bazaar.commit{value: BOND}(b, 1, cmt);
        assertEq(c, 0);
        assertEq(bazaar.commitCount(), 1);
        assertEq(bazaar.getBounty(b).pending, 1);
        assertEq(bazaar.getInvariant(b, 1).commitCount, 1);

        IBazaar.Commit memory cm = bazaar.getCommit(c);
        assertEq(cm.bountyId, b);
        assertEq(cm.inv, 1);
        assertEq(cm.seq, 0);
        assertEq(cm.seller, seller);
        assertEq(cm.commitment, cmt);
        assertEq(cm.bond, BOND);
        assertEq(cm.committedAt, uint64(block.timestamp));
        assertEq(uint8(cm.outcome), uint8(IBazaar.Outcome.NONE));
        assertEq(cm.hits, 0);
        assertFalse(cm.breaksControl);
        assertFalse(cm.slotHeld);
        assertEq(cm.contentHash, bytes32(0));
        assertEq(cm.traceHash, bytes32(0));
        assertEq(cm.attestedAt, 0);
        assertEq(uint8(cm.dispute), uint8(IBazaar.DisputeState.NONE));
        assertEq(cm.disputer, address(0));
        assertEq(cm.disputeBond, 0);
        assertFalse(cm.finalized);

        // a second bounty gets id 1
        uint256 b2 = postSimple(REWARD, 1, DAY);
        assertEq(b2, 1);
        assertEq(bazaar.bountyCount(), 2);
    }

    function test_EscrowConservation_HappyAndFail() public {
        assertConservation();
        uint256 b = postSimple(REWARD, 2, DAY);
        assertConservation();

        uint256 a = commitFor(b, 0, CONTENT, SALT, BOND);
        assertConservation();
        uint256 c = commitAs(seller2, b, 0, CONTENT, SALT, BOND);
        assertConservation();

        attestPass(a, CONTENT, SALT);
        assertConservation();
        attestFail(c);
        assertConservation();

        vm.prank(buyer);
        bazaar.dispute{value: DISPUTE_BOND}(a);
        assertConservation();
        vm.prank(seller2);
        bazaar.dispute{value: DISPUTE_BOND}(c);
        assertConservation();

        vm.prank(arbiter);
        bazaar.resolve(a, IBazaar.Outcome.PASS);
        assertConservation();
        vm.prank(arbiter);
        bazaar.resolve(c, IBazaar.Outcome.FAIL);
        assertConservation();

        bazaar.finalize(a);
        assertConservation();
        bazaar.finalize(c);
        assertConservation();

        warpPastExpiry(b);
        bazaar.expire(b);
        assertConservation();
        assertEq(address(bazaar).balance, 0);
    }

    // =====================================================================
    // Fuzz
    // =====================================================================

    function testFuzz_PostValueMustMatch(uint96 reward, uint8 slots, uint256 value) public {
        reward = uint96(bound(reward, 1, type(uint96).max));
        slots = uint8(bound(slots, 1, type(uint8).max));
        value = bound(value, 0, type(uint128).max);
        uint256 total = uint256(reward) * slots;
        (uint96[] memory r, uint8[] memory s) = _single(reward, slots);
        uint64 expiry = uint64(block.timestamp) + DAY;

        vm.deal(buyer, total + value);

        vm.prank(buyer);
        if (value != total) vm.expectRevert(IBazaar.WrongValue.selector);
        bazaar.postBounty{value: value}(MANIFEST, bytes32(0), r, s, expiry, MIN_BOND, K, 0);

        // the exact total always succeeds
        vm.prank(buyer);
        uint256 b = bazaar.postBounty{value: total}(MANIFEST, bytes32(0), r, s, expiry, MIN_BOND, K, 0);
        assertEq(bazaar.getBounty(b).escrow, total);
        assertEq(address(bazaar).balance, value == total ? 2 * total : total);
    }

    function testFuzz_TieredPayoutNeverExceedsReward(uint96 reward, uint16 bps) public {
        reward = uint96(bound(reward, 1, type(uint96).max));
        bps = uint16(bound(bps, 0, 10_000));
        vm.deal(buyer, reward);

        uint256 b = postWithControl(reward, 1, DAY, bps);
        uint256 sellerBefore = seller.balance;
        uint256 c = commitFor(b, 0, CONTENT, SALT, BOND);
        attestPassControl(c, CONTENT, SALT);
        warpPastWindow();
        bazaar.finalize(c);

        uint256 expectedPaid = uint256(reward) * bps / 10_000;
        uint256 paid = seller.balance - sellerBefore; // bond came back, so this is exactly paidToSeller
        assertLe(paid, reward, "paid never exceeds reward");
        assertEq(paid, expectedPaid);
        assertEq(bazaar.getBounty(b).escrow, uint256(reward) - expectedPaid);
        assertConservation();
    }
}
