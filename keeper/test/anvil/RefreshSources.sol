// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Miner} from "../../../src/interfaces/IBsc.sol";

// Local Anvil only: deterministic BSC sources and a delivered harvest sync, for keeper state tests.
contract RefreshSources {
    address constant CELL = address(0xCe11);
    address constant CIRCUITS = 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C;
    address constant VOUCHER = 0x9cfc959cd42B2e1d39a0d850c528210E818AE520;
    bool public stopped;

    function setStopped(bool value) external { stopped = value; }
    function rigs(uint256 id) external pure returns (address, uint256) { return (CIRCUITS, id); }
    function ownerOf(uint256) external pure returns (address) { return CELL; }
    function cellOf(bytes32) external pure returns (address) { return CELL; }
    function pending(bytes32) external pure returns (uint256) { return 50_000; }
    function quoteHarvest(uint256) external pure returns (uint256) { return 1000; }
    function getMiner(bytes32) external view returns (Miner memory m) {
        m.status = stopped ? 3 : 1;
        m.verifWeight = stopped ? 0 : 500;
    }
    function harvest(uint256[] calldata ids) external payable returns (uint256) {
        for (uint256 i; i < ids.length; ++i) {
            IRecord(VOUCHER).setRig(ids[i], uint64(block.timestamp), 500);
        }
        return 0;
    }
}

interface IRecord { function setRig(uint256 id, uint64 at, uint256 power) external; }
