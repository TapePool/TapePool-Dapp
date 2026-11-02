// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RigReport, IRigFeed, RigReportCheck} from "./RigReport.sol";
import {IRigVoucher} from "../../interfaces/IXLayer.sol";

/// @notice SPIKE ONLY. Stand-in for the borrow path: takes a report from a feed, checks it against
///         the voucher on X Layer and returns the base power an advance may be sized on.
///         Both feed prototypes are tested through this one contract.
contract FeedGate {
    IRigFeed public immutable feed;
    IRigVoucher public immutable voucher;

    event Checked(uint256 indexed rigId, uint256 basePower, uint64 observedAt);

    constructor(IRigFeed feed_, IRigVoucher voucher_) {
        feed = feed_;
        voucher = voucher_;
    }

    /// @notice Revert unless a fresh, authentic, unimpaired report exists for `rigId`.
    /// @return base Base power (`verifWeight - bonus`).
    function check(uint256 rigId, bytes calldata proof) external returns (uint256 base) {
        RigReport memory r = feed.consume(rigId, proof);
        (address circuits,, uint256 circuitId,) = voucher.rigs(rigId);
        base = RigReportCheck.basePower(r, rigId, circuits, circuitId, block.timestamp);
        emit Checked(rigId, base, r.observedAt);
    }
}
