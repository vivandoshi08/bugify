// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Answers "may this address attest and void bounties?". The Bazaar never stores a verifier of its own.
interface IVerifierSet {
    function canAttest(address who) external view returns (bool);
}
