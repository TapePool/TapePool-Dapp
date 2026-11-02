// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One rig's state, read on BSC by the reporter and stored on X Layer (SPEC §6).
/// The three weights are `uint64` so the record packs into 4 storage slots.
struct RigReport {
    uint64 rigId; // voucher id on X Layer == rig id in the BSC vault
    uint64 circuitId;
    uint64 since; // PodMining registration time
    uint64 stopBlock; // 0 while mining
    address circuits; // BSC processor (Circuits contract); zero if the vault forgot the rig
    uint64 observedAt; // BSC block.timestamp of the read
    uint8 status; // 1 = active
    bool custodied; // the vault cell still owns the circuit NFT (false after a rescue)
    uint64 verifWeight;
    uint64 bonus;
    uint64 totalVerifWeight; // PodMining total verified weight at the same read
    uint64 bscBlock;
    uint128 pending; // BEM claimable on BSC; informational, never used for sizing
    uint32 taskId;
}

/// @notice The rig data feed on X Layer. Agents read impairment evidence from it, and
///         `CreditPolicy` reads borrow-time flags from it.
interface IRigFeed {
    /// @notice Newest report stored for `rigId`.
    /// @param rigId Voucher id.
    /// @return report The newest report (all zero if none).
    /// @return ok False if no report was ever received for `rigId`.
    function latest(uint256 rigId) external view returns (RigReport memory report, bool ok);
}
