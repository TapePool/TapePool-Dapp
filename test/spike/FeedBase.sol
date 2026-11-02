// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IRigVoucher} from "../../src/interfaces/IXLayer.sol";
import {IRigVaultBsc, IPodMining} from "../../src/interfaces/IBsc.sol";
import {RigReport} from "../../src/spike/feed/RigReport.sol";
import {BscRigReader} from "../../src/spike/feed/BscRigReader.sol";

/// Two-fork setup for the rig data feed bake-off (T6-T8): BSC for the rig state, X Layer for the borrow.
/// LOCAL FORKS ONLY. Needs `BSC_RPC` (an archive endpoint) in `.env`; the tests skip without it.
abstract contract FeedBase is Test {
    // ── BSC (56)
    IRigVaultBsc constant VAULT = IRigVaultBsc(0x48D43345656f0f9510dC3c06CBa99dFf597617C2);
    IPodMining constant POD = IPodMining(0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46);
    address constant TAPEOUT_SAFE = 0xB3D85b42A045c1A88D800CAD0F55d2566a4D3138;
    // block of research/data/snapshot-2026-10-18.json, so reads can be checked against it
    uint256 constant BSC_BLOCK = 128_369_002;

    // ── X Layer (196)
    IRigVoucher constant VOUCHER = IRigVoucher(0x9cfc959cd42B2e1d39a0d850c528210E818AE520);
    uint256 constant XLAYER_BLOCK = 73_558_380;

    // ── LayerZero
    address constant ENDPOINT = 0x1a44076050125825900e736c501f859c50fE728c; // same on both chains
    uint32 constant BSC_EID = 30102;
    uint32 constant XLAYER_EID = 30274;

    uint256 constant N_RIGS = 16;
    uint256 constant RIG = 5; // 306 verified power, 248 of it design bonus

    uint256 internal bscFork;
    uint256 internal xFork;

    function _forks() internal {
        string memory bscRpc = vm.envOr("BSC_RPC", string(""));
        if (bytes(bscRpc).length == 0) vm.skip(true);
        bscFork = vm.createFork(bscRpc, BSC_BLOCK);
        xFork = vm.createFork("xlayer", XLAYER_BLOCK);
    }

    /// Base power of every bridged rig at BSC_BLOCK, from snapshot-2026-10-18.json (id 1..16).
    function _snapshotBase(uint256 id) internal pure returns (uint256) {
        uint8[16] memory base = [2, 16, 2, 107, 58, 50, 48, 47, 67, 64, 52, 72, 22, 12, 3, 1];
        return base[id - 1];
    }

    function _read(uint256 id) internal view returns (RigReport memory) {
        return BscRigReader.read(VAULT, POD, id);
    }

    /// Simulate the TapeOut Safe pulling a rig out of the vault (admin risk B9). BSC fork only.
    function _rescueOnBsc(uint256 id) internal {
        vm.prank(TAPEOUT_SAFE);
        VAULT.rescue(id, address(0xBEEF));
    }

    /// Move X Layer time to just after the BSC read, as if the data had travelled for `delay` seconds.
    function _arriveOnXLayer(RigReport memory r, uint256 delay) internal {
        vm.selectFork(xFork);
        vm.warp(r.observedAt + delay);
    }
}
