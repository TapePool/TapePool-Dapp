// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CircuitGate} from "./CircuitGate.sol";

/// @notice SPIKE ONLY. A contract that consumes TapeOut circuits via a gas-capped STATICCALL.
contract CircuitConsumer {
    function evalCapped(address circuits, uint256 id, bytes calldata inputs, uint256 gasCap, uint256 nOut)
        external
        view
        returns (bool ok, bytes memory out, uint256 gasUsed)
    {
        return CircuitGate.evalCapped(circuits, id, inputs, gasCap, nOut);
    }

    function allow(address circuits, uint256 id, bytes calldata inputs, uint256 gasCap) external view returns (bool) {
        return CircuitGate.allow(circuits, id, inputs, gasCap);
    }
}
