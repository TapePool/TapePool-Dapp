// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The credit rule an agent asks before every borrow (SPEC §9.1).
interface ICreditPolicy {
    /// @notice Policy version. A replacement must report a higher one (SPEC §9.2).
    function version() external view returns (uint16);

    /// @notice Decide whether `agent` may owe `debt` against `rigIds` for `term`.
    ///         Never reverts on bad data; returns allow = false and a reason instead.
    /// @param agent The borrowing agent.
    /// @param rigIds The agent's collateral, strictly ascending.
    /// @param term Term code (0 = 7 days, 1 = 14 days).
    /// @param debt Principal plus flat fee, in raw BEM.
    /// @return allow True only if the borrow is allowed.
    /// @return reason A `Reasons` code; `Reasons.OK` when allowed.
    /// @return inputBits The 12-bit circuit input that was evaluated.
    /// @return expected Expected base output over the term, in raw BEM.
    function check(address agent, uint256[] calldata rigIds, uint8 term, uint256 debt)
        external
        view
        returns (bool allow, uint8 reason, uint16 inputBits, uint256 expected);

    /// @notice Largest debt `check` would allow for `term` right now (0 if any flag fails).
    /// @param agent The borrowing agent.
    /// @param rigIds The agent's collateral, strictly ascending.
    /// @param term Term code.
    /// @return The largest allowed debt in raw BEM.
    function maxDebt(address agent, uint256[] calldata rigIds, uint8 term) external view returns (uint256);
}

/// @notice Reason codes. 0-6 come from `ICreditPolicy.check` (SPEC §9.1). 7 and above are reported
///         only by `TapeLens.quote`, before the policy is asked (SPEC §13).
library Reasons {
    uint8 internal constant OK = 0;
    uint8 internal constant BAD_IDS = 1;
    uint8 internal constant EMISSION = 2;
    uint8 internal constant PIN = 3;
    uint8 internal constant EVAL = 4;
    uint8 internal constant MISMATCH = 5;
    uint8 internal constant DENIED = 6;
    uint8 internal constant PAUSED = 7;
    uint8 internal constant FEED_OFF = 8;
    uint8 internal constant SWAP_QUEUED = 9;
    uint8 internal constant NO_COLLATERAL = 10;
    uint8 internal constant LOAN_OPEN = 11;
    uint8 internal constant CLOSED = 12;
    uint8 internal constant BAD_TERM = 13;
    uint8 internal constant NO_ROOM = 14; // the policy allows a loan, but the pool has no room for `minAdvance`
    uint8 internal constant BELOW_MIN_ADVANCE = 15;
    uint8 internal constant ABOVE_LEND_LIMIT = 16;
}
