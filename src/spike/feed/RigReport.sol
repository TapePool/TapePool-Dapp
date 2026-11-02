// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice SPIKE ONLY. The rig state a borrow needs from BSC, as one fixed-size record.
/// Packed into 4 storage slots so the push feed can store it cheaply.
struct RigReport {
    uint64 rigId; // voucher id on X Layer == rig id in the BSC vault
    uint64 circuitId;
    uint64 since; // PodMining registration time (rig age)
    uint64 stopBlock; // 0 while the rig mines
    address circuits;
    uint64 observedAt; // BSC block.timestamp when the state was read
    uint8 status; // 1 = active
    bool custodied; // the vault's cell still owns the circuit NFT (false after a rescue)
    uint128 verifWeight;
    uint128 bonus; // design bonus, lost easily; never lent against
    uint128 pending; // BEM claimable on BSC, 8 decimals
    uint64 bscBlock;
    uint32 taskId;
}

/// @notice A source of authentic rig reports on X Layer. Each feed proves authenticity its own way;
///         the checks that do not depend on the source live in `RigReportCheck`.
interface IRigFeed {
    /// @notice Return an authentic report for `rigId`, or revert.
    /// @param rigId Voucher id.
    /// @param proof Feed-specific proof (a signature for the signed feed, empty for the push feed).
    function consume(uint256 rigId, bytes calldata proof) external returns (RigReport memory);
}

/// @notice SPIKE ONLY. Source-independent checks on a report. Every failure reverts (fail closed).
library RigReportCheck {
    uint256 internal constant MAX_AGE = 5 minutes;
    uint256 internal constant MAX_SKEW = 1 minutes; // BSC clock may run slightly ahead of X Layer
    uint8 internal constant ACTIVE = 1;

    error WrongRig();
    error RigMismatch();
    error Impaired();
    error Stale();
    error BadReport();

    /// @notice Validate `r` for `rigId` against the voucher's own record and return base power.
    function basePower(RigReport memory r, uint256 rigId, address circuitsX, uint256 circuitIdX, uint256 nowTs)
        internal
        pure
        returns (uint256)
    {
        if (r.rigId != rigId) revert WrongRig();
        // impairment first: after a rescue the vault forgets the rig, so its circuit fields are empty
        if (r.status != ACTIVE || r.stopBlock != 0 || !r.custodied) revert Impaired();
        if (r.circuits != circuitsX || r.circuitId != circuitIdX) revert RigMismatch();
        if (r.observedAt + MAX_AGE < nowTs || r.observedAt > nowTs + MAX_SKEW) revert Stale();
        if (r.bonus > r.verifWeight) revert BadReport();
        return r.verifWeight - r.bonus;
    }
}
