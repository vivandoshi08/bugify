// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifierSet} from "../../src/interfaces/IVerifierSet.sol";

/// @notice Minimal allowlist used by the unit tests so they do not depend on SingleVerifier.
contract MockVerifierSet is IVerifierSet {
    mapping(address => bool) public allowed;

    function set(address who, bool ok) external {
        allowed[who] = ok;
    }

    function canAttest(address who) external view returns (bool) {
        return allowed[who];
    }
}
