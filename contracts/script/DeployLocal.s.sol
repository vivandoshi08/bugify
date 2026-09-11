// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Bazaar} from "../src/Bazaar.sol";
import {SingleVerifier} from "../src/SingleVerifier.sol";
import {Deploy} from "./Deploy.s.sol";

/// @notice Same as Deploy but for a local anvil: anvil account 0 is deployer, verifier, arbiter and treasury.
///
///   anvil &
///   forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract DeployLocal is Deploy {
    /// @dev Default anvil account 0 (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266).
    uint256 internal constant ANVIL_KEY_0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external override returns (SingleVerifier verifierSet, Bazaar bazaar) {
        address deployer = vm.addr(ANVIL_KEY_0);

        vm.startBroadcast(ANVIL_KEY_0);
        (verifierSet, bazaar) = _deploy(deployer, deployer, deployer);
        vm.stopBroadcast();

        _log(verifierSet, bazaar, deployer, deployer, deployer);
    }
}
