// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifierSet} from "./interfaces/IVerifierSet.sol";

/// @notice v1 verifier set: exactly one address may attest and void bounties. See docs/CONTRACTS.md §8.
contract SingleVerifier is IVerifierSet {
    address public owner;
    address public verifier;

    error NotOwner();
    error ZeroAddress();

    event VerifierSet(address indexed verifier);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address verifier_) {
        if (verifier_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        verifier = verifier_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit VerifierSet(verifier_);
    }

    /// @inheritdoc IVerifierSet
    function canAttest(address who) external view returns (bool) {
        return who == verifier;
    }

    function setVerifier(address verifier_) external onlyOwner {
        if (verifier_ == address(0)) revert ZeroAddress();
        verifier = verifier_;
        emit VerifierSet(verifier_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }
}
