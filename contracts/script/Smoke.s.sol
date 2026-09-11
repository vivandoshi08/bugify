// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Counter} from "../src/Counter.sol";

/// Deploys Counter and bumps it once. Used as an end-to-end smoke test of deployer + RPC + verification.
contract SmokeScript is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        Counter c = new Counter();
        c.increment();
        vm.stopBroadcast();
        console.log("Counter deployed at", address(c));
        console.log("Counter value", c.number());
    }
}
