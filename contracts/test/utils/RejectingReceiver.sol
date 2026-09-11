// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBazaar} from "../../src/interfaces/IBazaar.sol";

/// @notice A seller whose receive() always reverts, so every payout to it lands in `owed`.
contract RejectingReceiver {
    receive() external payable {
        revert("RejectingReceiver: no ETH");
    }

    function commitTo(IBazaar bazaar, uint256 bountyId, uint8 inv, bytes32 commitment)
        external
        payable
        returns (uint256)
    {
        return bazaar.commit{value: msg.value}(bountyId, inv, commitment);
    }

    /// @dev Will revert with TransferFailed because this contract cannot receive ETH.
    function pullOwed(address bazaar) external {
        IBazaar(bazaar).withdraw();
    }
}

/// @notice A seller that accepts ETH only if it can forward it to `sink`.
/// Point `sink` at a RejectingReceiver to make payouts fail (accruing `owed`), then re-point it at an EOA and
/// call `pullOwed` to show `withdraw()` works once the recipient can receive.
contract ForwardingWrapper {
    address public sink;

    constructor(address sink_) {
        sink = sink_;
    }

    function setSink(address sink_) external {
        sink = sink_;
    }

    receive() external payable {
        (bool ok,) = sink.call{value: msg.value}("");
        require(ok, "ForwardingWrapper: forward failed");
    }

    function commitTo(IBazaar bazaar, uint256 bountyId, uint8 inv, bytes32 commitment)
        external
        payable
        returns (uint256)
    {
        return bazaar.commit{value: msg.value}(bountyId, inv, commitment);
    }

    function pullOwed(address bazaar) external {
        IBazaar(bazaar).withdraw();
    }
}

/// @notice A seller that tries to re-enter `finalize` from its receive() hook.
contract ReentrantSeller {
    IBazaar public immutable bazaar;
    uint256 public target;
    bool public armed;

    constructor(IBazaar bazaar_) {
        bazaar = bazaar_;
    }

    function commitTo(uint256 bountyId, uint8 inv, bytes32 commitment) external payable returns (uint256) {
        return bazaar.commit{value: msg.value}(bountyId, inv, commitment);
    }

    function arm(uint256 commitId) external {
        target = commitId;
        armed = true;
    }

    function disarm() external {
        armed = false;
    }

    receive() external payable {
        if (armed) {
            armed = false;
            bazaar.finalize(target);
        }
    }
}
