// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FeedBase} from "./FeedBase.sol";
import {console2} from "forge-std/console2.sol";
import {RigReport} from "../../src/spike/feed/RigReport.sol";
import {IERC721OwnerOf} from "../../src/interfaces/IBsc.sol";

/// T6 (DERISK Q10): a contract on BSC can read everything the feed needs for every bridged rig,
///    and the unverified PodMining layout decodes to the same values as the off-chain snapshot.
contract T6_BscReaderTest is FeedBase {
    function setUp() public {
        _forks();
        vm.selectFork(bscFork);
    }

    function test_T6_reader_matches_snapshot_for_all_rigs() public view {
        uint256 total;
        for (uint256 id = 1; id <= N_RIGS; id++) {
            uint256 g = gasleft();
            RigReport memory r = _read(id);
            uint256 used = g - gasleft();
            assertEq(r.rigId, id);
            assertEq(r.status, 1, "active");
            assertEq(r.stopBlock, 0, "not stopped");
            assertTrue(r.custodied, "cell owns the circuit");
            assertEq(r.verifWeight - r.bonus, _snapshotBase(id), "base power matches snapshot");
            assertEq(r.observedAt, block.timestamp);
            assertEq(r.bscBlock, BSC_BLOCK);
            assertGt(r.since, 0);
            total += used;
            if (id == 1) console2.log("gas to read one rig", used);
        }
        console2.log("gas to read 16 rigs", total);
    }

    function test_T6_rig5_bonus_is_excluded() public view {
        RigReport memory r = _read(RIG);
        assertEq(r.verifWeight, 306);
        assertEq(r.bonus, 248);
        assertEq(r.verifWeight - r.bonus, 58);
    }

    function test_T6_rig_ids_match_x_layer_voucher() public {
        RigReport[] memory rs = new RigReport[](N_RIGS);
        for (uint256 id = 1; id <= N_RIGS; id++) {
            rs[id - 1] = _read(id);
        }
        vm.selectFork(xFork);
        for (uint256 id = 1; id <= N_RIGS; id++) {
            (address circuits,, uint256 circuitId,) = VOUCHER.rigs(id);
            assertEq(rs[id - 1].circuits, circuits, "same processor");
            assertEq(rs[id - 1].circuitId, circuitId, "same circuit id");
        }
    }

    function test_T6_unknown_rig_reads_as_impaired() public view {
        RigReport memory r = _read(999);
        assertFalse(r.custodied);
        assertEq(r.status, 0);
        assertEq(r.circuits, address(0));
    }

    /// The Safe can pull a rig out of the vault. The reader must notice, from BSC state alone.
    function test_T6_rescue_is_detected() public {
        RigReport memory before = _read(RIG);
        assertTrue(before.custodied);
        _rescueOnBsc(RIG);
        RigReport memory r = _read(RIG);
        assertFalse(r.custodied, "rescued rig is no longer custodied");
        console2.log("after rescue: circuits", r.circuits);
        console2.log("after rescue: status", r.status);
        console2.log("circuit owner now", IERC721OwnerOf(before.circuits).ownerOf(before.circuitId));
    }
}
