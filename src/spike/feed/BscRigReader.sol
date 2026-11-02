// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RigReport} from "./RigReport.sol";
import {IRigVaultBsc, IPodMining, IERC721OwnerOf, Miner} from "../../interfaces/IBsc.sol";

/// @notice SPIKE ONLY. Reads one rig's state on BSC into a `RigReport`.
/// Used on-chain by the push feed's BSC reporter, and as the reference for what an off-chain
/// signer must read. A rig the vault no longer knows comes back with `custodied = false`.
library BscRigReader {
    error RigIdTooLarge();

    function read(IRigVaultBsc vault, IPodMining pod, uint256 rigId) internal view returns (RigReport memory r) {
        if (rigId > type(uint64).max) revert RigIdTooLarge();
        r.rigId = uint64(rigId);
        r.observedAt = uint64(block.timestamp);
        r.bscBlock = uint64(block.number);

        (address circuits, uint256 circuitId) = vault.rigs(rigId);
        if (circuits == address(0) || circuitId > type(uint64).max) return r; // unknown rig: impaired

        r.circuits = circuits;
        r.circuitId = uint64(circuitId);
        bytes32 key = pod.minerKey(circuits, circuitId);
        Miner memory m = pod.getMiner(key);
        r.status = m.status;
        r.stopBlock = m.stopBlock;
        r.since = m.since;
        r.taskId = m.taskId;
        r.verifWeight = m.verifWeight;
        r.bonus = m.bonus;
        r.pending = uint128(pod.pending(key));

        address cell = vault.cellOf(key);
        if (cell != address(0)) {
            try IERC721OwnerOf(circuits).ownerOf(circuitId) returns (address o) {
                r.custodied = o == cell;
            } catch {}
        }
    }
}
