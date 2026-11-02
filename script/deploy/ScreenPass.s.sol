// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RigScreen} from "../../src/RigScreen.sol";

/// @notice Record a reviewed proof on the new screen. Dry-run unless forge receives --broadcast.
contract ScreenPass is Script {
    /// @notice Record one pass as the owner; the 48-hour delay is enforced by RigScreen.
    function run(address screen, uint256 rigId, address circuits, uint64 circuitId, uint32 taskId, bytes32 artifactHash)
        external
    {
        vm.startBroadcast();
        RigScreen(screen).recordPass(rigId, circuits, circuitId, taskId, artifactHash);
        vm.stopBroadcast();
        (RigScreen.Pass memory pass,) = RigScreen(screen).passOf(rigId);
        console2.log("rig / effective at", rigId, pass.effectiveAt);
        console2.logBytes32(artifactHash);
    }
}
