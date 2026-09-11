// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {Bazaar} from "../src/Bazaar.sol";
import {SingleVerifier} from "../src/SingleVerifier.sol";
import {IVerifierSet} from "../src/interfaces/IVerifierSet.sol";

/// @notice Deploys SingleVerifier + Bazaar with the demo timings from docs/CONTRACTS.md §11.
/// @dev Env: VERIFIER, ARBITER, TREASURY (addresses), PRIVATE_KEY (uint). Writes deployments/<chainid>.json.
///
///   forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org --chain-id 84532 --broadcast \
///     --verify --etherscan-api-key $BASESCAN_API_KEY
contract Deploy is Script {
    uint64 internal constant ATTEST_TIMEOUT = 10 minutes;
    uint64 internal constant DISPUTE_WINDOW = 60 seconds;
    uint96 internal constant DISPUTE_BOND = 0.005 ether;
    uint64 internal constant CANCEL_GRACE = 10 minutes;

    function run() external virtual returns (SingleVerifier verifierSet, Bazaar bazaar) {
        address verifier = vm.envAddress("VERIFIER");
        address arbiter = vm.envAddress("ARBITER");
        address treasury = vm.envAddress("TREASURY");
        uint256 key = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(key);
        (verifierSet, bazaar) = _deploy(verifier, arbiter, treasury);
        vm.stopBroadcast();

        _log(verifierSet, bazaar, verifier, arbiter, treasury);
    }

    function _deploy(address verifier, address arbiter, address treasury)
        internal
        returns (SingleVerifier verifierSet, Bazaar bazaar)
    {
        verifierSet = new SingleVerifier(verifier);
        bazaar = new Bazaar(
            IVerifierSet(address(verifierSet)),
            arbiter,
            treasury,
            ATTEST_TIMEOUT,
            DISPUTE_WINDOW,
            DISPUTE_BOND,
            CANCEL_GRACE
        );
    }

    function _log(SingleVerifier verifierSet, Bazaar bazaar, address verifier, address arbiter, address treasury)
        internal
    {
        console2.log("chainId       :", block.chainid);
        console2.log("SingleVerifier:", address(verifierSet));
        console2.log("Bazaar        :", address(bazaar));
        console2.log("verifier      :", verifier);
        console2.log("arbiter       :", arbiter);
        console2.log("treasury      :", treasury);

        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "SingleVerifier", address(verifierSet));
        vm.serializeAddress(obj, "Bazaar", address(bazaar));
        vm.serializeAddress(obj, "verifier", verifier);
        vm.serializeAddress(obj, "arbiter", arbiter);
        string memory json = vm.serializeAddress(obj, "treasury", treasury);

        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("wrote         :", path);
    }
}
