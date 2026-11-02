// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Term table and credit math shared by the agent and the credit policy (SPEC §2, §4, §5, §8.2).
///         Every rounding step fails toward the pool: expected output rounds down, buckets round up.
library CreditMath {
    uint8 internal constant TERM_7D = 0;
    uint8 internal constant TERM_14D = 1;

    uint256 internal constant BPS = 10_000;
    /// 7,200 BEM/day x 99% to verified weight, 8 decimals.
    uint256 internal constant VERIF_EMISSION_PER_DAY = 712_800_000_000;
    /// 0.5% OFT bridge fee on harvested BEM.
    uint256 internal constant BRIDGE_KEEP_BPS = 9_950;
    /// Mean of (1+d)^-t over the term, d = 0.2667%/day, rounded down.
    uint256 internal constant DILUTION_BPS_7D = 9_907;
    uint256 internal constant DILUTION_BPS_14D = 9_815;
    /// Max debt as a share of expected output: 85% (7 d), 80% (14 d).
    uint256 internal constant MAX_DEBT_BPS_7D = 8_500;
    uint256 internal constant MAX_DEBT_BPS_14D = 8_000;
    /// Width of one debt bucket and the saturating top bucket.
    uint256 internal constant BUCKET_BPS = 500;
    uint8 internal constant MAX_BUCKET = 31;

    error BadTerm(uint8 term);

    /// @notice True for the terms the MVP offers (7 and 14 days).
    function isTerm(uint8 term) internal pure returns (bool) {
        return term == TERM_7D || term == TERM_14D;
    }

    /// @notice Length of `term` in days. Reverts for any other term code.
    function termDays(uint8 term) internal pure returns (uint256) {
        if (term == TERM_7D) return 7;
        if (term == TERM_14D) return 14;
        revert BadTerm(term);
    }

    function dilutionBps(uint8 term) internal pure returns (uint256) {
        if (term == TERM_7D) return DILUTION_BPS_7D;
        if (term == TERM_14D) return DILUTION_BPS_14D;
        revert BadTerm(term);
    }

    function maxDebtBps(uint8 term) internal pure returns (uint256) {
        if (term == TERM_7D) return MAX_DEBT_BPS_7D;
        if (term == TERM_14D) return MAX_DEBT_BPS_14D;
        revert BadTerm(term);
    }

    /// @notice Highest bucket that still allows a borrow for `term` (17 for 7 d, 16 for 14 d).
    function bucketLimit(uint8 term) internal pure returns (uint8) {
        // forge-lint: disable-next-line(unsafe-typecast) at most 8,500 / 500 = 17
        return uint8(maxDebtBps(term) / BUCKET_BPS);
    }

    /// @notice Expected BEM one rig mines over `term`, after dilution and the bridge fee (SPEC §5).
    /// @param base Base power (`verifWeight - bonus`).
    /// @param totalVerifWeight Network verified weight from the same read.
    function expectedOutput(uint256 base, uint256 totalVerifWeight, uint8 term) internal pure returns (uint256) {
        if (totalVerifWeight == 0) return 0;
        uint256 num = VERIF_EMISSION_PER_DAY * termDays(term) * dilutionBps(term) * BRIDGE_KEEP_BPS;
        return Math.mulDiv(base, num, totalVerifWeight * BPS * BPS);
    }

    /// @notice 5% debt bucket, saturating at 31 (SPEC §8.2). Rounds up, toward deny.
    function debtBucket(uint256 debt, uint256 expected) internal pure returns (uint8) {
        if (expected == 0 || debt > type(uint256).max / BPS) return MAX_BUCKET;
        uint256 debtBps = Math.mulDiv(debt, BPS, expected, Math.Rounding.Ceil);
        uint256 b = Math.ceilDiv(debtBps, BUCKET_BPS);
        // forge-lint: disable-next-line(unsafe-typecast) b <= 31 on this branch
        return b > MAX_BUCKET ? MAX_BUCKET : uint8(b);
    }

    /// @notice Largest debt whose bucket is within the limit for `term`.
    function maxDebt(uint256 expected, uint8 term) internal pure returns (uint256) {
        return Math.mulDiv(expected, maxDebtBps(term), BPS);
    }
}
