// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IBazaar} from "../../src/interfaces/IBazaar.sol";
import {IVerifierSet} from "../../src/interfaces/IVerifierSet.sol";
import {Bazaar} from "../../src/Bazaar.sol";
import {MockVerifierSetInv} from "./MockVerifierSetInv.sol";
import {BazaarHandler} from "./BazaarHandler.sol";

/// @notice CONTRACTS.md section 6 invariants, driven by `BazaarHandler`.
contract BazaarInvariantTest is Test {
    MockVerifierSetInv internal verifierSet;
    Bazaar internal bazaar;
    BazaarHandler internal handler;

    address internal verifier = makeAddr("verifier");
    address internal arbiter = makeAddr("arbiter");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(1_700_000_000);

        verifierSet = new MockVerifierSetInv();
        verifierSet.setAllowed(verifier, true);
        bazaar = new Bazaar(
            IVerifierSet(address(verifierSet)), arbiter, treasury, 10 minutes, 60 seconds, 0.005 ether, 10 minutes
        );
        handler = new BazaarHandler(IBazaar(address(bazaar)), verifier, arbiter, treasury);

        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = BazaarHandler.postBounty.selector;
        selectors[1] = BazaarHandler.commit.selector;
        selectors[2] = BazaarHandler.attest.selector;
        selectors[3] = BazaarHandler.dispute.selector;
        selectors[4] = BazaarHandler.resolve.selector;
        selectors[5] = BazaarHandler.finalize.selector;
        selectors[6] = BazaarHandler.reclaim.selector;
        selectors[7] = BazaarHandler.voidBounty.selector;
        selectors[8] = BazaarHandler.cancel.selector;
        selectors[9] = BazaarHandler.expire.selector;
        selectors[10] = BazaarHandler.withdraw.selector;
        selectors[11] = BazaarHandler.warp.selector;

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ------------------------------------------------------------------
    // 1. balance == sum escrow + sum bond[!finalized] + sum disputeBond[dispute == OPEN] + sum owed
    // ------------------------------------------------------------------

    function invariant_Conservation() public view {
        uint256 expected;

        uint256 nb = bazaar.bountyCount();
        for (uint256 i; i < nb; i++) {
            expected += bazaar.getBounty(i).escrow;
        }

        uint256 nc = bazaar.commitCount();
        for (uint256 i; i < nc; i++) {
            IBazaar.Commit memory c = bazaar.getCommit(i);
            if (!c.finalized) expected += c.bond;
            if (c.dispute == IBazaar.DisputeState.OPEN) expected += c.disputeBond;
        }

        address[] memory actors = handler.actors();
        for (uint256 i; i < actors.length; i++) {
            expected += bazaar.owed(actors[i]);
        }
        expected += bazaar.owed(address(handler));
        expected += bazaar.owed(address(this));

        assertEq(address(bazaar).balance, expected, "conservation: balance != escrow + bonds + disputeBonds + owed");
    }

    // ------------------------------------------------------------------
    // 2. slotsUsed <= slots, and slotsUsed == number of commits on (bounty, inv) holding a slot
    // ------------------------------------------------------------------

    function invariant_SlotsBounded() public view {
        uint256 nb = bazaar.bountyCount();
        uint256 nc = bazaar.commitCount();

        // held[bountyId * 32 + inv] = count of commits with slotHeld
        uint256[] memory held = new uint256[](nb * 32);
        for (uint256 i; i < nc; i++) {
            IBazaar.Commit memory c = bazaar.getCommit(i);
            if (c.slotHeld) {
                assertEq(uint8(c.outcome), uint8(IBazaar.Outcome.PASS), "slotHeld on a non-PASS commit");
                held[uint256(c.bountyId) * 32 + c.inv]++;
            } else {
                assertTrue(c.outcome != IBazaar.Outcome.PASS, "PASS commit without slotHeld");
            }
        }

        for (uint256 b; b < nb; b++) {
            uint256 ni = bazaar.invariantCount(b);
            for (uint8 i; i < ni; i++) {
                IBazaar.Invariant memory inv = bazaar.getInvariant(b, i);
                assertLe(inv.slotsUsed, inv.slots, "slotsUsed > slots");
                assertEq(inv.slotsUsed, held[b * 32 + i], "slotsUsed != count(slotHeld)");
            }
        }
    }

    // ------------------------------------------------------------------
    // 3. cursor <= commitCount; seq < cursor => attested; seq >= cursor => NONE
    // ------------------------------------------------------------------

    function invariant_Fifo() public view {
        uint256 nb = bazaar.bountyCount();
        uint256 nc = bazaar.commitCount();

        // seen[bountyId * 32 + inv] = number of commits observed on that queue
        uint256[] memory seen = new uint256[](nb * 32);
        for (uint256 i; i < nc; i++) {
            IBazaar.Commit memory c = bazaar.getCommit(i);
            IBazaar.Invariant memory inv = bazaar.getInvariant(c.bountyId, c.inv);
            assertLt(c.seq, inv.commitCount, "seq >= commitCount");
            if (c.seq < inv.cursor) {
                assertTrue(c.outcome != IBazaar.Outcome.NONE, "commit behind cursor still NONE");
            } else {
                assertEq(uint8(c.outcome), uint8(IBazaar.Outcome.NONE), "commit at/after cursor already attested");
            }
            seen[uint256(c.bountyId) * 32 + c.inv]++;
        }

        for (uint256 b; b < nb; b++) {
            uint256 ni = bazaar.invariantCount(b);
            for (uint8 i; i < ni; i++) {
                IBazaar.Invariant memory inv = bazaar.getInvariant(b, i);
                assertLe(inv.cursor, inv.commitCount, "cursor > commitCount");
                assertEq(inv.commitCount, seen[b * 32 + i], "commitCount != number of commits on queue");
            }
        }
    }

    // ------------------------------------------------------------------
    // 4. bounty.pending == count(commits of bounty where !finalized)
    // ------------------------------------------------------------------

    function invariant_PendingExact() public view {
        uint256 nb = bazaar.bountyCount();
        uint256 nc = bazaar.commitCount();

        uint256[] memory unfinalized = new uint256[](nb);
        for (uint256 i; i < nc; i++) {
            IBazaar.Commit memory c = bazaar.getCommit(i);
            if (!c.finalized) unfinalized[c.bountyId]++;
            if (c.outcome == IBazaar.Outcome.RECLAIMED) assertTrue(c.finalized, "RECLAIMED but not finalized");
            if (c.finalized) assertTrue(c.dispute != IBazaar.DisputeState.OPEN, "finalized with an OPEN dispute");
        }
        for (uint256 b; b < nb; b++) {
            assertEq(bazaar.getBounty(b).pending, unfinalized[b], "pending != count(!finalized)");
        }
    }

    // ------------------------------------------------------------------
    // 5. status == CLOSED => escrow == 0 && pending == 0
    // ------------------------------------------------------------------

    function invariant_ClosedIsEmpty() public view {
        uint256 nb = bazaar.bountyCount();
        for (uint256 b; b < nb; b++) {
            IBazaar.BountyInfo memory info = bazaar.getBounty(b);
            if (info.status == IBazaar.BountyStatus.CLOSED) {
                assertEq(info.escrow, 0, "CLOSED bounty with escrow");
                assertEq(info.pending, 0, "CLOSED bounty with pending commits");
            }
        }
    }

    // ------------------------------------------------------------------
    // 6. For any finalized PASS, paidToSeller - bond <= reward
    // ------------------------------------------------------------------

    function invariant_PaidNeverExceedsReward() public view {
        assertEq(handler.ghostUnderpaid(), 0, "PASS finalize returned less than the bond");
        uint256 nc = bazaar.commitCount();
        for (uint256 i; i < nc; i++) {
            IBazaar.Commit memory c = bazaar.getCommit(i);
            if (!c.finalized) continue;
            uint256 paid = handler.ghostPaid(i);
            if (c.outcome == IBazaar.Outcome.RECLAIMED) {
                assertTrue(handler.ghostReclaimedByHandler(i), "RECLAIMED commit not reclaimed via handler");
                assertEq(paid, c.bond, "reclaim paid != bond");
                continue;
            }
            assertTrue(handler.ghostFinalizedByHandler(i), "finalized commit not finalized via handler");
            uint96 reward = bazaar.getInvariant(c.bountyId, c.inv).reward;
            if (c.outcome == IBazaar.Outcome.PASS) {
                assertGe(paid, c.bond, "PASS paid < bond");
                assertLe(paid - c.bond, reward, "PASS paid - bond > reward");
            } else if (c.outcome == IBazaar.Outcome.FAIL) {
                assertEq(paid, 0, "FAIL paid seller");
            } else {
                // PASS_NO_SLOT / VOID
                assertEq(paid, c.bond, "non-paying outcome paid != bond");
            }
        }
    }

    /// Stricter than 6: the PASS payout is exactly reward (or the control tier of it) plus the bond.
    function invariant_PayoutExact() public view {
        uint256 nc = bazaar.commitCount();
        for (uint256 i; i < nc; i++) {
            IBazaar.Commit memory c = bazaar.getCommit(i);
            if (!c.finalized || c.outcome != IBazaar.Outcome.PASS) continue;
            uint256 paid = handler.ghostPaid(i);
            assertGe(paid, c.bond, "PASS paid < bond");
            assertEq(paid - c.bond, _expectedReward(c), "PASS payout != expected reward");
        }
    }

    // ------------------------------------------------------------------
    // 7. escrow accounting against what was posted
    // ------------------------------------------------------------------

    function invariant_EscrowNeverExceedsPosted() public view {
        uint256 nb = bazaar.bountyCount();
        uint256 nc = bazaar.commitCount();

        // Reward released from escrow by finalized PASS commits, computed purely from views.
        uint256[] memory released = new uint256[](nb);
        for (uint256 i; i < nc; i++) {
            IBazaar.Commit memory c = bazaar.getCommit(i);
            if (c.finalized && c.outcome == IBazaar.Outcome.PASS) released[c.bountyId] += _expectedReward(c);
        }

        uint256 totalEscrow;
        for (uint256 b; b < nb; b++) {
            IBazaar.BountyInfo memory info = bazaar.getBounty(b);
            uint256 posted = handler.ghostPosted(b);
            uint256 refund = handler.ghostRefund(b);
            totalEscrow += info.escrow;

            assertLe(info.escrow, posted, "escrow > posted");
            // Exact: escrow + released rewards + refund == posted (view-based and ghost-based).
            assertEq(info.escrow + released[b] + refund, posted, "escrow + released + refund != posted (views)");
            assertEq(info.escrow + handler.ghostPaidRewards(b) + refund, posted, "escrow + paid + refund != posted");
            if (info.status == IBazaar.BountyStatus.CLOSED) {
                assertTrue(handler.ghostExpiredByHandler(b), "CLOSED bounty not expired via handler");
            } else {
                assertEq(refund, 0, "refund recorded on a non-CLOSED bounty");
                // Lower bound: every finalized PASS holds a slot, so at most reward * slotsUsed has left escrow.
                uint256 floor;
                uint256 ni = info.invariantCount;
                for (uint8 i; i < ni; i++) {
                    IBazaar.Invariant memory inv = bazaar.getInvariant(b, i);
                    floor += uint256(inv.reward) * (inv.slots - inv.slotsUsed);
                }
                assertGe(info.escrow, floor, "escrow < sum reward * (slots - slotsUsed)");
            }
        }
        assertLe(totalEscrow, handler.ghostTotalPosted(), "total escrow > total posted");
    }

    // ------------------------------------------------------------------
    // Extra: attest(PASS) with a wrong salt must always revert (CommitmentMismatch)
    // ------------------------------------------------------------------

    function invariant_CommitmentEnforced() public view {
        assertEq(handler.ghostWrongSaltAccepted(), 0, "attest PASS accepted a wrong salt");
    }

    // ------------------------------------------------------------------
    // Coverage summary
    // ------------------------------------------------------------------

    function invariant_CallSummary() public view {
        handler.callSummary();
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _expectedReward(IBazaar.Commit memory c) internal view returns (uint256) {
        IBazaar.BountyInfo memory info = bazaar.getBounty(c.bountyId);
        uint256 reward = bazaar.getInvariant(c.bountyId, c.inv).reward;
        return c.breaksControl ? reward * info.controlTierBps / 10_000 : reward;
    }
}
