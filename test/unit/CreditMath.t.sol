// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CreditMath} from "../../src/libraries/CreditMath.sol";

/// Term math against the worked checks in SPEC §5 and §8.2, plus fuzzing.
contract CreditMathTest is Test {
    uint256 constant NETWORK = 1_579_201; // snapshot 2026-10-18

    function test_spec_section5_per_hash() public pure {
        assertEq(CreditMath.expectedOutput(1, NETWORK, 0), 3_114_537, "0.03114537 BEM over 7 d");
        assertEq(CreditMath.expectedOutput(1, NETWORK, 1), 6_171_229, "0.06171229 BEM over 14 d");
        assertEq(CreditMath.maxDebt(3_114_537, 0), 2_647_356, "0.02647356 BEM");
        assertEq(CreditMath.maxDebt(6_171_229, 1), 4_936_983, "0.04936983 BEM");
    }

    function test_spec_section82_bucket_boundary() public pure {
        assertEq(CreditMath.debtBucket(2_647_356, 3_114_537), 17, "the exact maximum");
        assertEq(CreditMath.debtBucket(2_647_357, 3_114_537), 18, "one raw unit more");
        assertEq(CreditMath.bucketLimit(0), 17);
        assertEq(CreditMath.bucketLimit(1), 16);
    }

    function test_spec_min_base_power_for_half_a_bem() public pure {
        uint256 debt7 = 50_000_000 + 375_000; // 0.5 BEM + 0.75%
        assertGe(CreditMath.maxDebt(CreditMath.expectedOutput(20, NETWORK, 0), 0), debt7, "20 H is enough");
        assertLt(CreditMath.maxDebt(CreditMath.expectedOutput(19, NETWORK, 0), 0), debt7, "19 H is not");
        uint256 debt14 = 50_000_000 + 750_000;
        assertGe(CreditMath.maxDebt(CreditMath.expectedOutput(11, NETWORK, 1), 1), debt14, "11 H is enough");
        assertLt(CreditMath.maxDebt(CreditMath.expectedOutput(10, NETWORK, 1), 1), debt14, "10 H is not");
    }

    function test_spec_demo_rig_takes_a_7_day_loan() public pure {
        // 1 H at the snapshot and at the Nov 24 projection, debt = principal + 0.003 BEM
        uint256 max7 = CreditMath.maxDebt(CreditMath.expectedOutput(1, NETWORK, 0), 0) - 300_000;
        assertEq(max7, 2_347_356, "0.02347356 BEM");
        uint256 maxNov = CreditMath.maxDebt(CreditMath.expectedOutput(1, 1_740_000, 0), 0) - 300_000;
        assertGe(maxNov, 1_000_000, "above the 0.01 BEM minimum");
        assertApproxEqAbs(maxNov, 2_100_000, 5_000, "about 0.0210 BEM");
    }

    function test_no_output_means_top_bucket() public pure {
        assertEq(CreditMath.expectedOutput(100, 0, 0), 0);
        assertEq(CreditMath.debtBucket(1, 0), 31);
        assertEq(CreditMath.debtBucket(type(uint256).max, 1), 31);
        assertEq(CreditMath.debtBucket(0, 1), 0);
    }

    function test_bad_terms_revert() public {
        vm.expectRevert(abi.encodeWithSelector(CreditMath.BadTerm.selector, 2));
        this.days_(2);
        vm.expectRevert(abi.encodeWithSelector(CreditMath.BadTerm.selector, 3));
        this.expected_(1, 1, 3);
        assertFalse(CreditMath.isTerm(2));
        assertTrue(CreditMath.isTerm(0));
        assertTrue(CreditMath.isTerm(1));
    }

    function days_(uint8 term) external pure returns (uint256) {
        return CreditMath.termDays(term);
    }

    function expected_(uint256 base, uint256 total, uint8 term) external pure returns (uint256) {
        return CreditMath.expectedOutput(base, total, term);
    }

    /// One floor over the whole product, as SPEC §5 writes it.
    function testFuzz_expected_matches_the_formula(uint64 base, uint64 total, bool longTerm) public pure {
        vm.assume(total != 0);
        uint8 term = longTerm ? 1 : 0;
        uint256 d = longTerm ? 14 : 7;
        uint256 dil = longTerm ? 9_815 : 9_907;
        uint256 ref = uint256(base) * 712_800_000_000 * d * dil * 9_950 / (uint256(total) * 1e8);
        assertEq(CreditMath.expectedOutput(base, total, term), ref);
    }

    /// The bucket rule and `maxDebt` agree: debt is allowed exactly up to `maxDebt`.
    function testFuzz_bucket_limit_matches_max_debt(uint256 expected, uint256 debt, bool longTerm) public pure {
        expected = bound(expected, 1, 1e18);
        debt = bound(debt, 0, 2e18);
        uint8 term = longTerm ? 1 : 0;
        bool allowed = CreditMath.debtBucket(debt, expected) <= CreditMath.bucketLimit(term);
        assertEq(allowed, debt <= CreditMath.maxDebt(expected, term));
    }

    function testFuzz_bucket_is_monotonic(uint256 expected, uint256 a, uint256 b) public pure {
        expected = bound(expected, 1, 1e18);
        a = bound(a, 0, 1e20);
        b = bound(b, a, 1e20);
        assertLe(CreditMath.debtBucket(a, expected), CreditMath.debtBucket(b, expected));
    }
}
