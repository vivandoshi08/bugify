// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Bazaar} from "../../src/Bazaar.sol";
import {BudgetVault} from "../../src/BudgetVault.sol";
import {SingleVerifier} from "../../src/SingleVerifier.sol";
import {IBazaar} from "../../src/interfaces/IBazaar.sol";
import {IVerifierSet} from "../../src/interfaces/IVerifierSet.sol";

contract BudgetVaultTest is Test {
    // Bazaar demo timings (docs/CONTRACTS.md §3).
    uint64 internal constant ATTEST_TIMEOUT = 10 minutes;
    uint64 internal constant DISPUTE_WINDOW = 60 seconds;
    uint96 internal constant DISPUTE_BOND = 0.005 ether;
    uint64 internal constant CANCEL_GRACE = 10 minutes;

    // Vault caps for the spec's case 18.
    uint96 internal constant PER_BOUNTY_CAP = 0.02 ether;
    uint96 internal constant EPOCH_CAP = 0.05 ether;
    uint64 internal constant EPOCH_LENGTH = 1 days;
    uint256 internal constant DEPOSIT = 0.1 ether;

    uint96 internal constant REWARD = 0.02 ether;
    uint96 internal constant MIN_BOND = 0.002 ether;
    uint64 internal constant BOUNTY_TTL = 1 hours;

    SingleVerifier internal sv;
    Bazaar internal bazaar;
    BudgetVault internal vault;

    address internal deployer = makeAddr("deployer");
    address internal verifier = makeAddr("verifier");
    address internal arbiter = makeAddr("arbiter");
    address internal treasury = makeAddr("treasury");
    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal seller = makeAddr("seller");
    address internal stranger = makeAddr("stranger");

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event SpenderSet(address indexed spender, bool ok);
    event CapsSet(uint96 perBountyCap, uint96 epochCap, uint64 epochLength);
    event EpochRolled(uint64 epochStart);

    function setUp() public {
        // Start at a non-zero timestamp so "expiry in the past" style arithmetic is meaningful.
        vm.warp(1_700_000_000);

        vm.startPrank(deployer);
        sv = new SingleVerifier(verifier);
        bazaar = new Bazaar(
            IVerifierSet(address(sv)), arbiter, treasury, ATTEST_TIMEOUT, DISPUTE_WINDOW, DISPUTE_BOND, CANCEL_GRACE
        );
        vm.stopPrank();

        vm.startPrank(owner);
        vault = new BudgetVault(IBazaar(address(bazaar)), PER_BOUNTY_CAP, EPOCH_CAP, EPOCH_LENGTH);
        vault.setSpender(agent, true);
        vm.stopPrank();

        vm.deal(owner, 1 ether);
        vm.deal(agent, 1 ether);
        vm.deal(seller, 1 ether);
        vm.deal(stranger, 1 ether);

        vm.prank(owner);
        vault.deposit{value: DEPOSIT}();
    }

    // ------------------------------------------------------------------ helpers

    function _post(address as_, uint96 reward, uint8 slots) internal returns (uint256 bountyId) {
        uint96[] memory rewards = new uint96[](1);
        uint8[] memory slotArr = new uint8[](1);
        rewards[0] = reward;
        slotArr[0] = slots;
        vm.prank(as_);
        bountyId = vault.postBounty(
            keccak256("manifest"),
            bytes32(0),
            rewards,
            slotArr,
            uint64(block.timestamp) + BOUNTY_TTL,
            MIN_BOND,
            1,
            10_000
        );
    }

    function _post(uint96 reward) internal returns (uint256) {
        return _post(agent, reward, 1);
    }

    function _commitment(bytes32 contentHash, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(contentHash, salt));
    }

    /// @dev Vault posts a bounty, seller commits, verifier attests PASS with a matching commitment.
    function _postCommitAttestPass() internal returns (uint256 bountyId, uint256 commitId) {
        bountyId = _post(REWARD);

        bytes32 contentHash = keccak256("transcript");
        bytes32 salt = keccak256("salt");
        vm.prank(seller);
        commitId = bazaar.commit{value: MIN_BOND}(bountyId, 0, _commitment(contentHash, salt));

        vm.prank(verifier);
        bazaar.attest(commitId, IBazaar.Outcome.PASS, 3, false, contentHash, salt, keccak256("trace"));
    }

    // ------------------------------------------------------------------ constructor / admin

    function test_Constructor() public view {
        assertEq(address(vault.bazaar()), address(bazaar));
        assertEq(vault.owner(), owner);
        assertEq(vault.perBountyCap(), PER_BOUNTY_CAP);
        assertEq(vault.epochCap(), EPOCH_CAP);
        assertEq(vault.epochLength(), EPOCH_LENGTH);
        assertEq(vault.spentThisEpoch(), 0);
        assertEq(vault.epochStart(), uint64(block.timestamp));
        assertTrue(vault.spenders(agent));
        assertFalse(vault.spenders(stranger));
        assertEq(address(vault).balance, DEPOSIT);
    }

    function test_ConstructorRejectsZeroBazaar() public {
        vm.expectRevert(BudgetVault.ZeroAddress.selector);
        new BudgetVault(IBazaar(address(0)), PER_BOUNTY_CAP, EPOCH_CAP, EPOCH_LENGTH);
    }

    function test_DepositAndReceive() public {
        vm.expectEmit(true, true, true, true);
        emit Deposited(stranger, 0.01 ether);
        vm.prank(stranger);
        vault.deposit{value: 0.01 ether}();
        assertEq(address(vault).balance, DEPOSIT + 0.01 ether);

        vm.expectEmit(true, true, true, true);
        emit Deposited(stranger, 0.02 ether);
        vm.prank(stranger);
        (bool ok,) = address(vault).call{value: 0.02 ether}("");
        assertTrue(ok, "receive");
        assertEq(address(vault).balance, DEPOSIT + 0.03 ether);
    }

    function test_SetSpender() public {
        vm.expectEmit(true, true, true, true);
        emit SpenderSet(stranger, true);
        vm.prank(owner);
        vault.setSpender(stranger, true);
        assertTrue(vault.spenders(stranger));

        vm.prank(owner);
        vault.setSpender(stranger, false);
        assertFalse(vault.spenders(stranger));

        vm.prank(agent);
        vm.expectRevert(BudgetVault.NotOwner.selector);
        vault.setSpender(stranger, true);

        vm.prank(owner);
        vm.expectRevert(BudgetVault.ZeroAddress.selector);
        vault.setSpender(address(0), true);
    }

    function test_SetCaps() public {
        vm.expectEmit(true, true, true, true);
        emit CapsSet(1 ether, 2 ether, 2 days);
        vm.prank(owner);
        vault.setCaps(1 ether, 2 ether, 2 days);
        assertEq(vault.perBountyCap(), 1 ether);
        assertEq(vault.epochCap(), 2 ether);
        assertEq(vault.epochLength(), 2 days);

        vm.prank(agent);
        vm.expectRevert(BudgetVault.NotOwner.selector);
        vault.setCaps(1, 2, 3);
    }

    function test_WithdrawEmitsAndChecksBalance() public {
        uint256 before = owner.balance;
        vm.expectEmit(true, true, true, true);
        emit Withdrawn(owner, 0.01 ether);
        vm.prank(owner);
        vault.withdraw(0.01 ether);
        assertEq(owner.balance, before + 0.01 ether);
        assertEq(address(vault).balance, DEPOSIT - 0.01 ether);

        vm.prank(owner);
        vm.expectRevert(BudgetVault.InsufficientVaultBalance.selector);
        vault.withdraw(DEPOSIT);
    }

    // ------------------------------------------------------------------ spec case 18

    function test_BudgetVault() public {
        // deposit 0.1 already done in setUp; caps 0.02 / 0.05 / 1 day; agent is a spender.
        assertEq(address(vault).balance, 0.1 ether);

        uint256 b1 = _post(REWARD);
        assertEq(vault.spentThisEpoch(), 0.02 ether);
        assertEq(address(vault).balance, 0.08 ether);
        assertEq(bazaar.getBounty(b1).buyer, address(vault), "vault is the buyer");
        assertEq(bazaar.getBounty(b1).escrow, REWARD);

        uint256 b2 = _post(REWARD);
        assertEq(b2, b1 + 1);
        assertEq(vault.spentThisEpoch(), 0.04 ether);
        assertEq(address(vault).balance, 0.06 ether);

        // Third post would take the epoch to 0.06 > 0.05.
        uint96[] memory rewards = new uint96[](1);
        uint8[] memory slots = new uint8[](1);
        rewards[0] = REWARD;
        slots[0] = 1;
        vm.prank(agent);
        vm.expectRevert(BudgetVault.EpochCapExceeded.selector);
        vault.postBounty(
            keccak256("manifest"), bytes32(0), rewards, slots, uint64(block.timestamp) + BOUNTY_TTL, MIN_BOND, 1, 10_000
        );
        assertEq(vault.spentThisEpoch(), 0.04 ether, "failed post does not count");
        assertEq(address(vault).balance, 0.06 ether);

        // Bounty #1 expires with no commits; the refund lands in the vault via receive().
        vm.warp(bazaar.getBounty(b1).expiry);
        uint256 bazaarBefore = address(bazaar).balance;
        bazaar.expire(b1);
        assertEq(address(vault).balance, 0.08 ether, "refund landed in vault");
        assertEq(address(bazaar).balance, bazaarBefore - REWARD);
        assertEq(bazaar.owed(address(vault)), 0, "no pull-payment fallback needed");
        assertEq(uint8(bazaar.getBounty(b1).status), uint8(IBazaar.BountyStatus.CLOSED));
        assertEq(bazaar.getBounty(b1).escrow, 0);

        // Owner withdraws the whole free balance.
        uint256 ownerBefore = owner.balance;
        vm.prank(owner);
        vault.withdraw(0.08 ether);
        assertEq(owner.balance, ownerBefore + 0.08 ether);
        assertEq(address(vault).balance, 0);

        // Non-owner (even a spender) cannot withdraw.
        vm.prank(agent);
        vm.expectRevert(BudgetVault.NotOwner.selector);
        vault.withdraw(1);
        vm.prank(stranger);
        vm.expectRevert(BudgetVault.NotOwner.selector);
        vault.withdraw(1);
    }

    // ------------------------------------------------------------------ cap checks

    function test_PerBountyCapExceeded() public {
        uint96[] memory rewards = new uint96[](1);
        uint8[] memory slots = new uint8[](1);
        rewards[0] = REWARD + 1;
        slots[0] = 1;
        vm.prank(agent);
        vm.expectRevert(BudgetVault.PerBountyCapExceeded.selector);
        vault.postBounty(
            keccak256("manifest"), bytes32(0), rewards, slots, uint64(block.timestamp) + BOUNTY_TTL, MIN_BOND, 1, 10_000
        );

        // Cap is on reward * slots, not on the single reward.
        rewards[0] = 0.011 ether;
        slots[0] = 2;
        vm.prank(agent);
        vm.expectRevert(BudgetVault.PerBountyCapExceeded.selector);
        vault.postBounty(
            keccak256("manifest"), bytes32(0), rewards, slots, uint64(block.timestamp) + BOUNTY_TTL, MIN_BOND, 1, 10_000
        );

        // Summed over invariants too.
        uint96[] memory rewards2 = new uint96[](2);
        uint8[] memory slots2 = new uint8[](2);
        rewards2[0] = 0.01 ether;
        rewards2[1] = 0.011 ether;
        slots2[0] = 1;
        slots2[1] = 1;
        vm.prank(agent);
        vm.expectRevert(BudgetVault.PerBountyCapExceeded.selector);
        vault.postBounty(
            keccak256("manifest"),
            bytes32(0),
            rewards2,
            slots2,
            uint64(block.timestamp) + BOUNTY_TTL,
            MIN_BOND,
            1,
            10_000
        );

        // Exactly at the cap is fine.
        rewards2[1] = 0.01 ether;
        vm.prank(agent);
        vault.postBounty(
            keccak256("manifest"),
            bytes32(0),
            rewards2,
            slots2,
            uint64(block.timestamp) + BOUNTY_TTL,
            MIN_BOND,
            1,
            10_000
        );
        assertEq(vault.spentThisEpoch(), 0.02 ether);
    }

    function test_InsufficientVaultBalance() public {
        // Drain the vault so the caps pass but the balance does not.
        vm.prank(owner);
        vault.withdraw(DEPOSIT - 0.01 ether);
        assertEq(address(vault).balance, 0.01 ether);

        uint96[] memory rewards = new uint96[](1);
        uint8[] memory slots = new uint8[](1);
        rewards[0] = REWARD;
        slots[0] = 1;
        vm.prank(agent);
        vm.expectRevert(BudgetVault.InsufficientVaultBalance.selector);
        vault.postBounty(
            keccak256("manifest"), bytes32(0), rewards, slots, uint64(block.timestamp) + BOUNTY_TTL, MIN_BOND, 1, 10_000
        );
        assertEq(vault.spentThisEpoch(), 0);
    }

    function test_EpochRollsAfterEpochLength() public {
        uint64 start = vault.epochStart();
        _post(REWARD);
        _post(REWARD);

        uint96[] memory rewards = new uint96[](1);
        uint8[] memory slots = new uint8[](1);
        rewards[0] = REWARD;
        slots[0] = 1;

        // One second before the epoch ends: still capped.
        vm.warp(uint256(start) + EPOCH_LENGTH - 1);
        vm.prank(agent);
        vm.expectRevert(BudgetVault.EpochCapExceeded.selector);
        vault.postBounty(
            keccak256("manifest"), bytes32(0), rewards, slots, uint64(block.timestamp) + BOUNTY_TTL, MIN_BOND, 1, 10_000
        );
        assertEq(vault.epochStart(), start, "epoch not rolled early");

        // At exactly epochStart + epochLength the epoch rolls and the third post succeeds.
        // (Use a local for the expected timestamp: the optimizer may cache block.timestamp across vm.warp.)
        uint64 rolledAt = start + EPOCH_LENGTH;
        vm.warp(rolledAt);
        vm.expectEmit(true, true, true, true);
        emit EpochRolled(rolledAt);
        uint256 b3 = _post(REWARD);
        assertEq(b3, 2);
        assertEq(vault.epochStart(), rolledAt);
        assertEq(vault.spentThisEpoch(), REWARD, "spend reset then counted");
        assertEq(address(vault).balance, DEPOSIT - 3 * REWARD);
    }

    function test_OwnerIsImplicitSpender() public {
        uint256 id = _post(owner, REWARD, 1);
        assertEq(bazaar.getBounty(id).buyer, address(vault));
    }

    function test_NonSpenderPostReverts() public {
        uint96[] memory rewards = new uint96[](1);
        uint8[] memory slots = new uint8[](1);
        rewards[0] = REWARD;
        slots[0] = 1;
        vm.prank(stranger);
        vm.expectRevert(BudgetVault.NotSpender.selector);
        vault.postBounty(
            keccak256("manifest"), bytes32(0), rewards, slots, uint64(block.timestamp) + BOUNTY_TTL, MIN_BOND, 1, 10_000
        );

        // Revoked spender is also rejected.
        vm.prank(owner);
        vault.setSpender(agent, false);
        vm.prank(agent);
        vm.expectRevert(BudgetVault.NotSpender.selector);
        vault.postBounty(
            keccak256("manifest"), bytes32(0), rewards, slots, uint64(block.timestamp) + BOUNTY_TTL, MIN_BOND, 1, 10_000
        );
    }

    function test_NonSpenderOtherActionsRevert() public {
        vm.startPrank(stranger);
        vm.expectRevert(BudgetVault.NotSpender.selector);
        vault.dispute(0);
        vm.expectRevert(BudgetVault.NotSpender.selector);
        vault.cancel(0);
        vm.expectRevert(BudgetVault.NotSpender.selector);
        vault.withdrawOwed();
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ dispute / cancel / withdrawOwed

    function test_DisputeForwardsBond() public {
        (, uint256 commitId) = _postCommitAttestPass();
        uint256 vaultBefore = address(vault).balance;
        uint256 bazaarBefore = address(bazaar).balance;
        assertEq(uint8(bazaar.getCommit(commitId).outcome), uint8(IBazaar.Outcome.PASS));

        vm.prank(agent);
        vault.dispute(commitId);

        IBazaar.Commit memory c = bazaar.getCommit(commitId);
        assertEq(uint8(c.dispute), uint8(IBazaar.DisputeState.OPEN));
        assertEq(c.disputer, address(vault), "vault is the disputer");
        assertEq(c.disputeBond, DISPUTE_BOND);
        assertEq(address(vault).balance, vaultBefore - DISPUTE_BOND);
        assertEq(address(bazaar).balance, bazaarBefore + DISPUTE_BOND);

        // Arbiter overturns the PASS: the dispute bond comes back to the vault (receive()).
        vm.prank(arbiter);
        bazaar.resolve(commitId, IBazaar.Outcome.FAIL);

        c = bazaar.getCommit(commitId);
        assertEq(uint8(c.outcome), uint8(IBazaar.Outcome.FAIL));
        assertEq(uint8(c.dispute), uint8(IBazaar.DisputeState.RESOLVED));
        assertEq(c.disputeBond, 0);
        assertFalse(c.slotHeld);
        assertEq(address(vault).balance, vaultBefore, "dispute bond returned to vault");
        assertEq(bazaar.owed(address(vault)), 0);
        assertEq(bazaar.getInvariant(c.bountyId, 0).slotsUsed, 0, "slot released");
    }

    function test_DisputeUpheldSendsBondToSeller() public {
        (, uint256 commitId) = _postCommitAttestPass();
        uint256 vaultBefore = address(vault).balance;
        uint256 sellerBefore = seller.balance;

        vm.prank(agent);
        vault.dispute(commitId);
        vm.prank(arbiter);
        bazaar.resolve(commitId, IBazaar.Outcome.PASS);

        assertEq(address(vault).balance, vaultBefore - DISPUTE_BOND, "vault loses the bond");
        assertEq(seller.balance, sellerBefore + DISPUTE_BOND, "seller receives the bond");
    }

    function test_DisputeInsufficientVaultBalance() public {
        (, uint256 commitId) = _postCommitAttestPass();
        // Leave less than the dispute bond in the vault.
        vm.prank(owner);
        vault.withdraw(address(vault).balance - (DISPUTE_BOND - 1));

        vm.prank(agent);
        vm.expectRevert(BudgetVault.InsufficientVaultBalance.selector);
        vault.dispute(commitId);
    }

    function test_DisputeBubblesBazaarRevert() public {
        // Unattested commit: Bazaar rejects with NotDisputable, and the vault bubbles it up.
        uint256 bountyId = _post(REWARD);
        vm.prank(seller);
        uint256 commitId = bazaar.commit{value: MIN_BOND}(bountyId, 0, keccak256("c"));

        vm.prank(agent);
        vm.expectRevert(IBazaar.NotDisputable.selector);
        vault.dispute(commitId);
    }

    function test_CancelForwards() public {
        uint256 bountyId = _post(REWARD);
        uint64 originalExpiry = bazaar.getBounty(bountyId).expiry;
        assertGt(originalExpiry, block.timestamp + CANCEL_GRACE, "test setup: grace is shorter than ttl");

        uint64 cancelledAt = uint64(block.timestamp);
        vm.prank(agent);
        vault.cancel(bountyId);

        IBazaar.BountyInfo memory b = bazaar.getBounty(bountyId);
        assertEq(b.expiry, cancelledAt + CANCEL_GRACE, "expiry pulled in to now + grace");
        assertEq(uint8(b.status), uint8(IBazaar.BountyStatus.OPEN), "status stays OPEN");

        // Only the vault (as buyer) may cancel; the agent calling the Bazaar directly is NotParty.
        vm.prank(agent);
        vm.expectRevert(IBazaar.NotParty.selector);
        bazaar.cancel(bountyId);

        // After the grace period the escrow is refunded to the vault.
        vm.warp(b.expiry);
        uint256 before = address(vault).balance;
        bazaar.expire(bountyId);
        assertEq(address(vault).balance, before + REWARD);
    }

    function test_WithdrawOwedNoOpWhenNothingOwed() public {
        assertEq(bazaar.owed(address(vault)), 0);
        uint256 before = address(vault).balance;

        vm.prank(agent);
        vault.withdrawOwed();
        vm.prank(owner);
        vault.withdrawOwed();

        assertEq(address(vault).balance, before, "no-op");
    }
}
