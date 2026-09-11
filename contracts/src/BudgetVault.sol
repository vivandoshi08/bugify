// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBazaar} from "./interfaces/IBazaar.sol";

/// @notice Per-owner spend cap that acts as the buyer from the Bazaar's point of view. See docs/CONTRACTS.md §9.
/// @dev Refunds from `expire` and returned dispute bonds are paid by the Bazaar to `address(this)` and land in
///      `receive()`. The owner is implicitly a spender.
contract BudgetVault {
    IBazaar public immutable bazaar;
    address public owner;
    mapping(address => bool) public spenders;

    uint96 public perBountyCap;
    uint96 public epochCap;
    uint64 public epochLength;
    uint96 public spentThisEpoch;
    uint64 public epochStart;

    error NotOwner();
    error NotSpender();
    error PerBountyCapExceeded();
    error EpochCapExceeded();
    error InsufficientVaultBalance();
    error TransferFailed();
    error ZeroAddress();

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event SpenderSet(address indexed spender, bool ok);
    event CapsSet(uint96 perBountyCap, uint96 epochCap, uint64 epochLength);
    event EpochRolled(uint64 epochStart);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlySpender() {
        if (msg.sender != owner && !spenders[msg.sender]) revert NotSpender();
        _;
    }

    constructor(IBazaar bazaar_, uint96 perBountyCap_, uint96 epochCap_, uint64 epochLength_) {
        if (address(bazaar_) == address(0)) revert ZeroAddress();
        bazaar = bazaar_;
        owner = msg.sender;
        perBountyCap = perBountyCap_;
        epochCap = epochCap_;
        epochLength = epochLength_;
        epochStart = uint64(block.timestamp);
        emit CapsSet(perBountyCap_, epochCap_, epochLength_);
    }

    // ---------------------------------------------------------------------
    // Funding
    // ---------------------------------------------------------------------

    /// @dev Refunds from `Bazaar.expire`, dispute-bond returns and `Bazaar.withdraw` land here.
    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function deposit() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external onlyOwner {
        if (address(this).balance < amount) revert InsufficientVaultBalance();
        (bool ok,) = owner.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(owner, amount);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setSpender(address spender, bool ok) external onlyOwner {
        if (spender == address(0)) revert ZeroAddress();
        spenders[spender] = ok;
        emit SpenderSet(spender, ok);
    }

    function setCaps(uint96 perBountyCap_, uint96 epochCap_, uint64 epochLength_) external onlyOwner {
        perBountyCap = perBountyCap_;
        epochCap = epochCap_;
        epochLength = epochLength_;
        emit CapsSet(perBountyCap_, epochCap_, epochLength_);
    }

    // ---------------------------------------------------------------------
    // Buyer actions (forwarded to the Bazaar with the vault as buyer)
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
    ) external onlySpender returns (uint256 bountyId) {
        _rollEpoch();

        uint256 total;
        uint256 n = rewards.length < slots.length ? rewards.length : slots.length;
        for (uint256 i; i < n; ++i) {
            total += uint256(rewards[i]) * uint256(slots[i]);
        }

        if (total > perBountyCap) revert PerBountyCapExceeded();
        if (uint256(spentThisEpoch) + total > epochCap) revert EpochCapExceeded();
        if (address(this).balance < total) revert InsufficientVaultBalance();

        spentThisEpoch += uint96(total);
        bountyId = bazaar.postBounty{value: total}(
            manifestHash, controlHash, rewards, slots, expiry, minBond, k, controlTierBps
        );
    }

    /// @notice Disputes a PASS attestation on one of the vault's bounties, funding the bond from the vault balance.
    function dispute(uint256 commitId) external onlySpender {
        uint256 bond = bazaar.disputeBond();
        if (address(this).balance < bond) revert InsufficientVaultBalance();
        bazaar.dispute{value: bond}(commitId);
    }

    function cancel(uint256 bountyId) external onlySpender {
        bazaar.cancel(bountyId);
    }

    /// @notice Pulls any ETH the Bazaar could not push to the vault (see the `owed` fallback in the Bazaar).
    function withdrawOwed() external onlySpender {
        if (bazaar.owed(address(this)) > 0) {
            bazaar.withdraw();
        }
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _rollEpoch() internal {
        if (block.timestamp >= uint256(epochStart) + uint256(epochLength)) {
            spentThisEpoch = 0;
            epochStart = uint64(block.timestamp);
            emit EpochRolled(epochStart);
        }
    }
}
