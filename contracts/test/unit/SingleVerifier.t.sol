// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {SingleVerifier} from "../../src/SingleVerifier.sol";

contract SingleVerifierTest is Test {
    SingleVerifier internal sv;

    address internal owner = makeAddr("owner");
    address internal verifier = makeAddr("verifier");
    address internal other = makeAddr("other");

    event VerifierSet(address indexed verifier);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function setUp() public {
        vm.prank(owner);
        sv = new SingleVerifier(verifier);
    }

    // ------------------------------------------------------------------ constructor

    function test_Constructor() public view {
        assertEq(sv.owner(), owner, "owner");
        assertEq(sv.verifier(), verifier, "verifier");
    }

    function test_ConstructorEmits() public {
        vm.expectEmit(true, true, true, true);
        emit OwnershipTransferred(address(0), owner);
        vm.expectEmit(true, true, true, true);
        emit VerifierSet(verifier);
        vm.prank(owner);
        new SingleVerifier(verifier);
    }

    function test_ConstructorRejectsZeroVerifier() public {
        vm.expectRevert(SingleVerifier.ZeroAddress.selector);
        new SingleVerifier(address(0));
    }

    // ------------------------------------------------------------------ canAttest

    function test_CanAttest() public view {
        assertTrue(sv.canAttest(verifier), "verifier can attest");
        assertFalse(sv.canAttest(other), "other cannot attest");
        assertFalse(sv.canAttest(owner), "owner cannot attest");
        assertFalse(sv.canAttest(address(0)), "zero cannot attest");
    }

    function testFuzz_CanAttestOnlyVerifier(address who) public view {
        assertEq(sv.canAttest(who), who == verifier);
    }

    // ------------------------------------------------------------------ setVerifier

    function test_SetVerifierByOwner() public {
        address next = makeAddr("next");

        vm.expectEmit(true, true, true, true);
        emit VerifierSet(next);
        vm.prank(owner);
        sv.setVerifier(next);

        assertEq(sv.verifier(), next);
        assertTrue(sv.canAttest(next));
        assertFalse(sv.canAttest(verifier), "old verifier revoked");
    }

    function test_SetVerifierByNonOwnerReverts() public {
        vm.prank(other);
        vm.expectRevert(SingleVerifier.NotOwner.selector);
        sv.setVerifier(other);
        assertEq(sv.verifier(), verifier, "unchanged");
    }

    function test_SetVerifierByVerifierReverts() public {
        vm.prank(verifier);
        vm.expectRevert(SingleVerifier.NotOwner.selector);
        sv.setVerifier(other);
    }

    function test_SetVerifierZeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(SingleVerifier.ZeroAddress.selector);
        sv.setVerifier(address(0));
    }

    // ------------------------------------------------------------------ transferOwnership

    function test_TransferOwnership() public {
        address newOwner = makeAddr("newOwner");

        vm.expectEmit(true, true, true, true);
        emit OwnershipTransferred(owner, newOwner);
        vm.prank(owner);
        sv.transferOwnership(newOwner);

        assertEq(sv.owner(), newOwner);

        // Old owner is locked out; new owner can administer.
        vm.prank(owner);
        vm.expectRevert(SingleVerifier.NotOwner.selector);
        sv.setVerifier(other);

        vm.prank(newOwner);
        sv.setVerifier(other);
        assertEq(sv.verifier(), other);
    }

    function test_TransferOwnershipByNonOwnerReverts() public {
        vm.prank(other);
        vm.expectRevert(SingleVerifier.NotOwner.selector);
        sv.transferOwnership(other);
        assertEq(sv.owner(), owner, "unchanged");
    }

    function test_TransferOwnershipZeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(SingleVerifier.ZeroAddress.selector);
        sv.transferOwnership(address(0));
    }
}
