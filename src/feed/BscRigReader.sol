// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {RigReport} from "../interfaces/IRigFeed.sol";
import {IRigVaultBsc, IPodMining, IERC721OwnerOf, Miner} from "../interfaces/IBsc.sol";

/// @notice Reads one rig's state on BSC into a `RigReport` (SPEC §6, SPEC-PHASE3 §5.2). Used on-chain
///         by `RigReporter`. A rig the vault no longer knows (after a Safe rescue) comes back with
///         `custodied = false` and zero weights, which is impairment evidence (SPEC §7.2 path (a)).
/// @dev Every narrowing cast is checked: a value that does not fit reverts the whole push.
library BscRigReader {
    using SafeCast for uint256;

    uint256 internal constant OWNER_OF_GAS = 100_000;
    error CustodyUnreadable(uint256 rigId);

    function read(IRigVaultBsc vault, IPodMining pod, uint256 rigId) internal view returns (RigReport memory r) {
        r.rigId = rigId.toUint64();
        r.observedAt = block.timestamp.toUint64();
        r.bscBlock = block.number.toUint64();

        (address circuits, uint256 circuitId) = vault.rigs(rigId);
        if (circuits == address(0)) return r; // the vault forgot the rig: impaired

        r.circuits = circuits;
        r.circuitId = circuitId.toUint64();
        bytes32 key = pod.minerKey(circuits, circuitId);
        Miner memory m = pod.getMiner(key);
        r.status = m.status;
        r.stopBlock = m.stopBlock;
        r.since = m.since;
        r.taskId = m.taskId;
        r.verifWeight = uint256(m.verifWeight).toUint64();
        r.bonus = m.bonus;
        r.totalVerifWeight = pod.totalVerifWeight().toUint64();
        r.pending = pod.pending(key).toUint128();

        address cell = vault.cellOf(key);
        if (cell != address(0)) r.custodied = _owns(circuits, circuitId, cell, rigId);
    }

    /// @dev A failed or malformed custody read cannot become impairment evidence.
    function _owns(address circuits, uint256 circuitId, address cell, uint256 rigId) private view returns (bool) {
        bytes memory q = abi.encodeCall(IERC721OwnerOf.ownerOf, (circuitId));
        uint256 cap = OWNER_OF_GAS;
        bool ok;
        uint256 word;
        assembly {
            ok := staticcall(cap, circuits, add(q, 0x20), mload(q), 0, 0x20)
            ok := and(ok, gt(returndatasize(), 0x1f))
            word := mload(0)
        }
        if (!ok || word > type(uint160).max) revert CustodyUnreadable(rigId);
        return address(uint160(word)) == cell;
    }
}
