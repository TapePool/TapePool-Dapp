// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICreditPolicy} from "./ICreditPolicy.sol";

/// @notice The part of `TapePool` that agents and the lens call.
interface ITapePool {
    /// @notice Current credit policy.
    function policy() external view returns (ICreditPolicy);
    /// @notice Whether admission is paused.
    function borrowsPaused() external view returns (bool);
    /// @notice Whether report evidence is disabled.
    function feedDisabled() external view returns (bool);
    /// @notice Time of the last `enableFeed`, 0 until the first (R3-01).
    function feedEnabledAt() external view returns (uint64);
    /// @notice Seconds after `enableFeed` during which `lend` reverts (R3-01).
    function FEED_SETTLE() external view returns (uint256);
    /// @notice Book newly arrived BEM as unreleased income.
    function sync() external;
    /// @notice BEM booked in the pool.
    function tracked() external view returns (uint256);
    /// @notice Income not yet released to shareholders.
    function unvestedNow() external view returns (uint256);
    /// @notice Current income release end.
    function vestEnd() external view returns (uint64);
    /// @notice Monotonic feed-brake clock.
    function frozenClock() external view returns (uint256);
    /// @notice Frozen seconds inside [a,b).
    function frozenBetween(uint64 a, uint64 b) external view returns (uint256);
    /// @notice First expired second of a flag.
    function expiryOf(uint64 impairedAt) external view returns (uint64);
    /// @notice Number of freeze intervals.
    function frozenCount() external view returns (uint256);
    /// @notice Freeze interval endpoints.
    function frozenAt(uint256 i) external view returns (uint64 from, uint64 to);
    /// @notice Absolute admission cap per borrower.
    function perBorrowerAbs() external view returns (uint256);
    /// @notice Immutable seed-share holder.
    function backstop() external view returns (address);
    /// @notice Income absorbed by an agent's doubtful principal.
    function absorbedOf(address agent) external view returns (uint256);
    /// @notice Reserve terms fixed for the agent's current loan.
    function loanReserveTerms(address agent) external view returns (uint16 shareBps, uint16 capBps);
    /// @notice Current admission limit and the lowest-numbered binding constraint.
    function lendLimit(address borrower) external view returns (uint256 amount, uint8 binding);
    /// @notice Whether a policy swap is queued and live.
    function policySwapQueued() external view returns (bool);
    /// @notice Minimum principal for a new loan.
    function minAdvance() external view returns (uint256);
    /// @notice Minimum BEM fee.
    function minFee() external view returns (uint256);
    /// @notice Seven-day flat fee rate.
    function feeBps7d() external view returns (uint256);
    /// @notice Fourteen-day flat fee rate.
    function feeBps14d() external view returns (uint256);
    /// @notice Late fee rate for new loans.
    function lateFeeBpsPerDay() external view returns (uint256);
    /// @notice Computed flat fee for the requested principal.
    function fee(uint8 term, uint256 principal) external view returns (uint256);
    /// @notice Exact native operating fee for a term.
    function opsFee(uint8 term) external view returns (uint256);
    /// @notice Current owner and operating fee recipient.
    function owner() external view returns (address);
    /// @notice Current admission limit for a borrower.
    function maxLend(address borrower) external view returns (uint256);

    /// @notice Lend principal to the registered agent borrower.
    function lend(uint256 principal) external;
    /// @notice Pull and book fees and principal from a registered agent.
    function repay(uint256 feePart, uint256 principalPart) external;
    /// @notice Mark the calling agent remaining principal doubtful.
    function markDoubtful() external;
    /// @notice Restore the calling agent doubtful principal.
    function clearDoubtful() external;
    /// @notice Write off the calling agent principal and apply reserve cover.
    function writeOff() external returns (uint256 amount);
}

/// @notice The part of `AgentFactory` that the pool calls.
interface IAgentFactory {
    /// @notice Pool this factory creates agents for.
    function pool() external view returns (address);
    /// @notice BEM token the agents use.
    function bem() external view returns (address);
    /// @notice Registered borrower of an agent, or zero.
    function borrowerOf(address agent) external view returns (address);
}
