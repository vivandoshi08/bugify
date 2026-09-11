// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {IBazaar} from "../../src/interfaces/IBazaar.sol";

/// @notice Seller actor whose `receive` rejects ETH unless `accept` is set. Exercises the `owed` fallback in `_pay`.
contract RejectingReceiver {
    bool public accept;

    function setAccept(bool a) external {
        accept = a;
    }

    receive() external payable {
        require(accept, "RejectingReceiver: reject");
    }
}

/// @notice Invariant handler for `Bazaar`. Every action computes its preconditions from Bazaar views and wraps
///         the call in try/catch, so the handler itself (almost) never reverts under `fail_on_revert = true`.
///         Ghost state records what the invariant tests cannot observe through views (per-commit payouts,
///         posted totals, refunds).
contract BazaarHandler is Test {
    IBazaar public immutable bazaar;
    address public immutable verifier;
    address public immutable arbiter;
    address public immutable treasury;
    RejectingReceiver public immutable rejecter;

    address[3] public buyers;
    address[4] public sellers;
    address[] internal _actors;

    // ------------------------------------------------------------------
    // Ghost state
    // ------------------------------------------------------------------

    uint256[] internal _bountyIds;
    uint256[] internal _commitIds;

    /// commitId => (contentHash, salt) behind the on-chain commitment.
    mapping(uint256 => bytes32) public ghostContentHash;
    mapping(uint256 => bytes32) public ghostSalt;

    /// commitId => ETH the seller received (balance + owed delta) when the handler finalized / reclaimed it.
    mapping(uint256 => uint256) public ghostPaid;
    mapping(uint256 => bool) public ghostFinalizedByHandler;
    mapping(uint256 => bool) public ghostReclaimedByHandler;
    /// Number of PASS finalizations where the seller received less than its bond back (should stay 0).
    uint256 public ghostUnderpaid;

    /// bountyId => sum(reward * slots) locked at post.
    mapping(uint256 => uint256) public ghostPosted;
    /// bountyId => sum over PASS finalizations of (paid - bond), i.e. reward actually released from escrow.
    mapping(uint256 => uint256) public ghostPaidRewards;
    /// bountyId => escrow refunded to the buyer by `expire`.
    mapping(uint256 => uint256) public ghostRefund;
    mapping(uint256 => bool) public ghostExpiredByHandler;
    uint256 public ghostTotalPosted;

    /// PASS attestations with a deliberately wrong salt that did NOT revert (should stay 0).
    uint256 public ghostWrongSaltAccepted;

    // ------------------------------------------------------------------
    // Call accounting
    // ------------------------------------------------------------------

    string[] internal _actionNames;
    mapping(string => uint256) public calls; // action entered
    mapping(string => uint256) public noops; // no eligible target, nothing called
    mapping(string => uint256) public reverts; // call made and reverted unexpectedly
    mapping(string => bytes4) public lastRevert; // selector of the last unexpected revert
    uint256 public wrongSaltReverted; // expected reverts (CommitmentMismatch probes)

    constructor(IBazaar bazaar_, address verifier_, address arbiter_, address treasury_) {
        bazaar = bazaar_;
        verifier = verifier_;
        arbiter = arbiter_;
        treasury = treasury_;

        buyers[0] = makeAddr("buyer0");
        buyers[1] = makeAddr("buyer1");
        buyers[2] = makeAddr("buyer2");
        sellers[0] = makeAddr("seller0");
        sellers[1] = makeAddr("seller1");
        sellers[2] = makeAddr("seller2");
        rejecter = new RejectingReceiver();
        sellers[3] = address(rejecter);
        vm.label(sellers[3], "sellerRejecting");

        for (uint256 i; i < 3; i++) {
            vm.deal(buyers[i], 10_000 ether);
            _actors.push(buyers[i]);
        }
        for (uint256 i; i < 4; i++) {
            vm.deal(sellers[i], 10_000 ether);
            _actors.push(sellers[i]);
        }
        _actors.push(arbiter_);
        _actors.push(treasury_);
        _actors.push(verifier_);

        _actionNames = [
            "postBounty",
            "commit",
            "attest",
            "dispute",
            "resolve",
            "finalize",
            "reclaim",
            "voidBounty",
            "cancel",
            "expire",
            "withdraw",
            "warp"
        ];
    }

    // ------------------------------------------------------------------
    // Views for the invariant test
    // ------------------------------------------------------------------

    function bountyIds() external view returns (uint256[] memory) {
        return _bountyIds;
    }

    function commitIds() external view returns (uint256[] memory) {
        return _commitIds;
    }

    function actors() external view returns (address[] memory) {
        return _actors;
    }

    function callSummary() external view {
        console.log("---- BazaarHandler call summary ----");
        for (uint256 i; i < _actionNames.length; i++) {
            string memory n = _actionNames[i];
            console.log(
                string.concat(
                    n,
                    ": calls=",
                    vm.toString(calls[n]),
                    " noops=",
                    vm.toString(noops[n]),
                    " reverts=",
                    vm.toString(reverts[n]),
                    reverts[n] > 0 ? string.concat(" last=", vm.toString(lastRevert[n])) : ""
                )
            );
        }
        console.log("bounties:", _bountyIds.length, "commits:", _commitIds.length);
        console.log("wrongSalt probes reverted:", wrongSaltReverted, "accepted:", ghostWrongSaltAccepted);
        console.log("total posted (wei):", ghostTotalPosted);
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    function postBounty(uint256 seed) external {
        calls["postBounty"]++;
        uint256 n = _bound(_rand(seed, 1), 1, 3);
        uint96[] memory rewards = new uint96[](n);
        uint8[] memory slots = new uint8[](n);
        uint256 total;
        for (uint256 i; i < n; i++) {
            rewards[i] = uint96(_bound(_rand(seed, 10 + i), 1e15, 1e17));
            slots[i] = uint8(_bound(_rand(seed, 20 + i), 1, 3));
            total += uint256(rewards[i]) * slots[i];
        }
        uint64 expiry = uint64(block.timestamp + _bound(_rand(seed, 2), 1 hours, 3 days));
        uint8 k = uint8(_bound(_rand(seed, 3), 1, 3));
        uint16 tier = uint16(_bound(_rand(seed, 4), 0, 10_000));
        bytes32 controlHash = _rand(seed, 5) % 2 == 0 ? bytes32(0) : keccak256(abi.encode("control", seed));
        bytes32 manifestHash = keccak256(abi.encode("manifest", seed));
        address buyer = buyers[_rand(seed, 6) % 3];
        if (buyer.balance < total) {
            noops["postBounty"]++;
            return;
        }

        vm.prank(buyer);
        try bazaar.postBounty{value: total}(manifestHash, controlHash, rewards, slots, expiry, 1e14, k, tier) returns (
            uint256 id
        ) {
            _bountyIds.push(id);
            ghostPosted[id] = total;
            ghostTotalPosted += total;
        } catch (bytes memory err) {
            _unexpected("postBounty", err);
        }
    }

    function commit(uint256 seed) external {
        calls["commit"]++;
        uint256[] memory open = _eligibleBounties(_isCommittable);
        if (open.length == 0) {
            noops["commit"]++;
            return;
        }
        uint256 bid = open[_rand(seed, 1) % open.length];
        IBazaar.BountyInfo memory b = bazaar.getBounty(bid);
        uint8 inv = uint8(_rand(seed, 2) % b.invariantCount);
        address seller = sellers[_rand(seed, 3) % 4];
        uint96 bond = uint96(_bound(_rand(seed, 4), b.minBond, uint256(b.minBond) * 3));
        bytes32 contentHash = keccak256(abi.encode("content", seed));
        bytes32 salt = keccak256(abi.encode("salt", seed));
        bytes32 commitment = keccak256(abi.encodePacked(contentHash, salt));

        vm.prank(seller);
        try bazaar.commit{value: bond}(bid, inv, commitment) returns (uint256 cid) {
            _commitIds.push(cid);
            ghostContentHash[cid] = contentHash;
            ghostSalt[cid] = salt;
        } catch (bytes memory err) {
            _unexpected("commit", err);
        }
    }

    function attest(uint256 seed) external {
        calls["attest"]++;
        uint256[] memory el = _eligibleCommits(_isAttestable);
        if (el.length == 0) {
            noops["attest"]++;
            return;
        }
        uint256 cid = el[_rand(seed, 1) % el.length];
        IBazaar.Commit memory c = bazaar.getCommit(cid);
        IBazaar.BountyInfo memory b = bazaar.getBounty(c.bountyId);

        uint256 r = _rand(seed, 2) % 10;
        IBazaar.Outcome o = r < 5 ? IBazaar.Outcome.PASS : (r < 8 ? IBazaar.Outcome.FAIL : IBazaar.Outcome.VOID);
        uint8 hits = uint8(_bound(_rand(seed, 3), 0, b.k));
        bool breaks = b.controlHash != bytes32(0) && _rand(seed, 4) % 2 == 0;
        bytes32 contentHash = ghostContentHash[cid];
        bytes32 salt = ghostSalt[cid];
        bool wrongSalt;
        if (o == IBazaar.Outcome.PASS && _rand(seed, 5) % 8 == 0) {
            wrongSalt = true;
            salt = keccak256(abi.encode("wrong-salt", seed));
        }
        bytes32 traceHash = keccak256(abi.encode("trace", seed));

        vm.prank(verifier);
        try bazaar.attest(cid, o, hits, breaks, contentHash, salt, traceHash) {
            if (wrongSalt) ghostWrongSaltAccepted++;
        } catch (bytes memory err) {
            if (wrongSalt) wrongSaltReverted++;
            else _unexpected("attest", err);
        }
    }

    function dispute(uint256 seed) external {
        calls["dispute"]++;
        uint256[] memory el = _eligibleCommits(_isDisputable);
        if (el.length == 0) {
            noops["dispute"]++;
            return;
        }
        uint256 cid = el[_rand(seed, 1) % el.length];
        IBazaar.Commit memory c = bazaar.getCommit(cid);
        address caller = c.outcome == IBazaar.Outcome.PASS ? bazaar.getBounty(c.bountyId).buyer : c.seller;
        uint96 db = bazaar.disputeBond();
        if (caller.balance < db) {
            noops["dispute"]++;
            return;
        }

        vm.prank(caller);
        try bazaar.dispute{value: db}(cid) {}
        catch (bytes memory err) {
            _unexpected("dispute", err);
        }
    }

    function resolve(uint256 seed) external {
        calls["resolve"]++;
        uint256[] memory el = _eligibleCommits(_hasOpenDispute);
        if (el.length == 0) {
            noops["resolve"]++;
            return;
        }
        uint256 cid = el[_rand(seed, 1) % el.length];
        IBazaar.Outcome o = _rand(seed, 2) % 2 == 0 ? IBazaar.Outcome.PASS : IBazaar.Outcome.FAIL;

        vm.prank(arbiter);
        try bazaar.resolve(cid, o) {}
        catch (bytes memory err) {
            _unexpected("resolve", err);
        }
    }

    function finalize(uint256 seed) external {
        calls["finalize"]++;
        uint256[] memory el = _eligibleCommits(_isFinalizable);
        if (el.length == 0) {
            noops["finalize"]++;
            return;
        }
        uint256 cid = el[_rand(seed, 1) % el.length];
        IBazaar.Commit memory c = bazaar.getCommit(cid);
        uint256 before = c.seller.balance + bazaar.owed(c.seller);

        // Called from the handler itself: it is never a payee, so the seller delta is exactly the payout.
        try bazaar.finalize(cid) {
            uint256 paid = c.seller.balance + bazaar.owed(c.seller) - before;
            ghostPaid[cid] = paid;
            ghostFinalizedByHandler[cid] = true;
            if (bazaar.getCommit(cid).outcome == IBazaar.Outcome.PASS) {
                if (paid >= c.bond) ghostPaidRewards[c.bountyId] += paid - c.bond;
                else ghostUnderpaid++;
            }
        } catch (bytes memory err) {
            _unexpected("finalize", err);
        }
    }

    function reclaim(uint256 seed) external {
        calls["reclaim"]++;
        uint256[] memory el = _eligibleCommits(_isReclaimable);
        if (el.length == 0) {
            noops["reclaim"]++;
            return;
        }
        uint256 cid = el[_rand(seed, 1) % el.length];
        IBazaar.Commit memory c = bazaar.getCommit(cid);
        uint256 before = c.seller.balance + bazaar.owed(c.seller);

        vm.prank(c.seller);
        try bazaar.reclaimBond(cid) {
            ghostPaid[cid] = c.seller.balance + bazaar.owed(c.seller) - before;
            ghostReclaimedByHandler[cid] = true;
        } catch (bytes memory err) {
            _unexpected("reclaim", err);
        }
    }

    function voidBounty(uint256 seed) external {
        calls["voidBounty"]++;
        // Throttled to ~1 in 4 so bounties survive long enough for the commit/attest/dispute pipeline.
        uint256[] memory el = _rand(seed, 0) % 4 == 0 ? _eligibleBounties(_isOpen) : new uint256[](0);
        if (el.length == 0) {
            noops["voidBounty"]++;
            return;
        }
        uint256 bid = el[_rand(seed, 1) % el.length];

        vm.prank(verifier);
        try bazaar.voidBounty(bid) {}
        catch (bytes memory err) {
            _unexpected("voidBounty", err);
        }
    }

    function cancel(uint256 seed) external {
        calls["cancel"]++;
        // Throttled to ~1 in 4 (see voidBounty).
        uint256[] memory el = _rand(seed, 0) % 4 == 0 ? _eligibleBounties(_isOpen) : new uint256[](0);
        if (el.length == 0) {
            noops["cancel"]++;
            return;
        }
        uint256 bid = el[_rand(seed, 1) % el.length];
        address buyer = bazaar.getBounty(bid).buyer;

        vm.prank(buyer);
        try bazaar.cancel(bid) {}
        catch (bytes memory err) {
            _unexpected("cancel", err);
        }
    }

    function expire(uint256 seed) external {
        calls["expire"]++;
        uint256[] memory el = _eligibleBounties(_isExpirable);
        if (el.length == 0) {
            noops["expire"]++;
            return;
        }
        uint256 bid = el[_rand(seed, 1) % el.length];
        uint256 escrowBefore = bazaar.getBounty(bid).escrow;

        try bazaar.expire(bid) {
            ghostRefund[bid] = escrowBefore;
            ghostExpiredByHandler[bid] = true;
        } catch (bytes memory err) {
            _unexpected("expire", err);
        }
    }

    function withdraw(uint256 seed) external {
        calls["withdraw"]++;
        uint256 n;
        address[] memory cands = new address[](_actors.length);
        for (uint256 i; i < _actors.length; i++) {
            if (bazaar.owed(_actors[i]) > 0) cands[n++] = _actors[i];
        }
        if (n == 0) {
            noops["withdraw"]++;
            return;
        }
        address who = cands[_rand(seed, 1) % n];
        bool isRejecter = who == address(rejecter);
        if (isRejecter) rejecter.setAccept(true);

        vm.prank(who);
        try bazaar.withdraw() {}
        catch (bytes memory err) {
            _unexpected("withdraw", err);
        }

        if (isRejecter) rejecter.setAccept(false);
    }

    function warp(uint256 seed) external {
        calls["warp"]++;
        // Half the warps stay inside the 60s dispute window / 10 min attest timeout so those paths get reached;
        // the rest jump anywhere up to 2 days (past expiry, timeouts, windows).
        uint256 max = _rand(seed, 2) % 2 == 0 ? 5 minutes : 2 days;
        vm.warp(block.timestamp + _bound(_rand(seed, 1), 1, max));
    }

    // ------------------------------------------------------------------
    // Eligibility predicates (computed purely from Bazaar views)
    // ------------------------------------------------------------------

    function _isOpen(uint256 bid) internal view returns (bool) {
        return bazaar.getBounty(bid).status == IBazaar.BountyStatus.OPEN;
    }

    function _isCommittable(uint256 bid) internal view returns (bool) {
        IBazaar.BountyInfo memory b = bazaar.getBounty(bid);
        return b.status == IBazaar.BountyStatus.OPEN && block.timestamp < b.expiry;
    }

    function _isExpirable(uint256 bid) internal view returns (bool) {
        IBazaar.BountyInfo memory b = bazaar.getBounty(bid);
        if (b.status == IBazaar.BountyStatus.CLOSED) return false;
        if (b.pending != 0) return false;
        return block.timestamp >= b.expiry || b.status == IBazaar.BountyStatus.VOIDED;
    }

    function _isAttestable(uint256 cid) internal view returns (bool) {
        IBazaar.Commit memory c = bazaar.getCommit(cid);
        if (c.outcome != IBazaar.Outcome.NONE) return false;
        return c.seq == bazaar.getInvariant(c.bountyId, c.inv).cursor;
    }

    function _isDisputable(uint256 cid) internal view returns (bool) {
        IBazaar.Commit memory c = bazaar.getCommit(cid);
        if (c.finalized || c.dispute != IBazaar.DisputeState.NONE) return false;
        if (c.outcome != IBazaar.Outcome.PASS && c.outcome != IBazaar.Outcome.FAIL) return false;
        return block.timestamp < uint256(c.attestedAt) + bazaar.disputeWindow();
    }

    function _hasOpenDispute(uint256 cid) internal view returns (bool) {
        return bazaar.getCommit(cid).dispute == IBazaar.DisputeState.OPEN;
    }

    function _isFinalizable(uint256 cid) internal view returns (bool) {
        IBazaar.Commit memory c = bazaar.getCommit(cid);
        if (c.outcome == IBazaar.Outcome.NONE || c.outcome == IBazaar.Outcome.RECLAIMED) return false;
        if (c.finalized || c.dispute == IBazaar.DisputeState.OPEN) return false;
        if (c.dispute == IBazaar.DisputeState.NONE) {
            return block.timestamp >= uint256(c.attestedAt) + bazaar.disputeWindow();
        }
        return true;
    }

    function _isReclaimable(uint256 cid) internal view returns (bool) {
        IBazaar.Commit memory c = bazaar.getCommit(cid);
        if (c.outcome != IBazaar.Outcome.NONE) return false;
        if (c.seq != bazaar.getInvariant(c.bountyId, c.inv).cursor) return false;
        if (bazaar.getBounty(c.bountyId).status == IBazaar.BountyStatus.VOIDED) return true;
        return block.timestamp > uint256(c.committedAt) + bazaar.attestTimeout();
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _eligibleBounties(function(uint256) internal view returns (bool) pred)
        internal
        view
        returns (uint256[] memory out)
    {
        uint256 total = bazaar.bountyCount();
        out = new uint256[](total);
        uint256 n;
        for (uint256 i; i < total; i++) {
            if (pred(i)) out[n++] = i;
        }
        assembly {
            mstore(out, n)
        }
    }

    function _eligibleCommits(function(uint256) internal view returns (bool) pred)
        internal
        view
        returns (uint256[] memory out)
    {
        uint256 total = bazaar.commitCount();
        out = new uint256[](total);
        uint256 n;
        for (uint256 i; i < total; i++) {
            if (pred(i)) out[n++] = i;
        }
        assembly {
            mstore(out, n)
        }
    }

    function _rand(uint256 seed, uint256 salt) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, salt)));
    }

    function _unexpected(string memory action, bytes memory err) internal {
        reverts[action]++;
        lastRevert[action] = err.length >= 4 ? bytes4(err) : bytes4(0);
    }
}
