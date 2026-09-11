// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifierSet} from "../../src/interfaces/IVerifierSet.sol";

/// @notice Minimal IVerifierSet for invariant tests: a settable allowlist, no ownership.
contract MockVerifierSetInv is IVerifierSet {
    mapping(address => bool) public allowed;

    function setAllowed(address who, bool ok) external {
        allowed[who] = ok;
    }

    function canAttest(address who) external view returns (bool) {
        return allowed[who];
    }
}
