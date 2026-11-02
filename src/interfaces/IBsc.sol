// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Interfaces for the live BSC (chain 56) contracts the rig data feed reads.
/// RigVault: Sourcify-verified implementation 0xeB3F0614e37d995a96fA41908de8D47A57F56463
/// (proxy 0x48D43345656f0f9510dC3c06CBa99dFf597617C2).
/// PodMining (proxy 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46) is NOT verified; the `Miner`
/// layout below comes from the tapeout.net client ABI and is checked against live reads in T6.

interface IRigVaultBsc {
    function rigs(uint256 id) external view returns (address circuits, uint256 circuitId);
    function cellOf(bytes32 key) external view returns (address);
    function quoteHarvest(uint256 n) external view returns (uint256);
    function harvest(uint256[] calldata ids) external payable returns (uint256 total);
    function rescue(uint256 id, address to) external;
    function owner() external view returns (address);
}

struct Miner {
    address circuits;
    uint64 circuitId;
    uint32 taskId;
    uint32 gateCount;
    uint32 stateCount;
    uint32 depth;
    uint64 area;
    uint32 mult;
    uint64 since;
    uint8 status;
    address registrant;
    uint32 nandBurn;
    uint32 latchBurn;
    uint64 bstar;
    uint64 bonus;
    bool optimal;
    uint64 commitBlock;
    uint64 firstUnusedId;
    uint64 stopBlock;
    uint128 verifWeight;
    uint128 unverWeight;
    uint256 debt;
}

interface IPodMining {
    function minerKey(address circuits, uint256 circuitId) external pure returns (bytes32);
    function getMiner(bytes32 key) external view returns (Miner memory);
    function pending(bytes32 key) external view returns (uint256);
    function totalVerifWeight() external view returns (uint256);
    function startTime() external view returns (uint256);
    function HALVING_PERIOD() external view returns (uint256);
}

interface IERC721OwnerOf {
    function ownerOf(uint256 id) external view returns (address);
}
