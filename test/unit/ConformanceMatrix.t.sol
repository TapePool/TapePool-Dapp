// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {TapePool} from "../../src/TapePool.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";

/// Phase 4 part B conformance matrix (docs/security-audits/2026-10-25-full-review/round-1.md, Appendix A):
/// tests for rule rows that had no direct evidence. Each name starts with the row id.
// Redeploy conformance rows (approved SPEC-REDEPLOY section 4):
// RA-01: RedeployPoolTest.test_RA01_*; Repro20261025.test_M01_*; ReproFullReview20261025.test_H03_*.
// RA-02: RedeployPoolTest.test_RA02_*; TapePoolTest.testFuzz_lend_respects_every_cap.
// RA-03: RedeployPoolTest.test_RA03_*; ReserveVerificationTest; R1ReserveVerify.
// RA-04: RedeployAgentTest.test_RA04_*; ReproFullReview20261025.test_H02_*.
// RA-05: RedeployPoolTest.test_RA05_*; RedeployAgentTest.test_RA05_*; both invariant campaigns.
// RA-06: RedeployAgentTest.testFuzz_RA06_* and test_RA06_roundThreeBrakeBoundaryAndLateVoucherDelivery.
// RA-07: RedeployAgentTest.test_RA07_*.
// RA-08: RedeployAgentTest.test_RA08_*; BatchDVerification.test_C10_*.
// RA-09: RedeployAgentTest.testFuzz_RA09_*; VerifyLateFeeTest; Repro20261025.test_L01_*.
// RA-10: RedeployAgentTest.test_RA10_*; R3FeeRaceVerify; MultiTxPoC.test_F6_*.
// RA-11: RedeployPoolTest.test_RA11_*; CReportsVerify.test_C12_*.
// RA-12: RedeployPoolTest.test_RA12_*.
// RA-13: ReentrancyTest.test_T3_agent_reentry_meets_the_lock_during_seize and test_T2_seize_hook_*.
// RA-14: RedeployFeedTest.test_RA14_*; CustodyVerificationTest; ReviewAccountingTest.
// RA-15: RedeployFeedTest.test_RA15_futureBoundaryAndMixedBatch.
// RA-16: ReentrancyTest.test_RA16_*; EdgeCasesTest.test_seize_of_16_vouchers_gas.
// RA-17: RedeployPoolTest.test_RA17_launchAndParamOrdinals; TapePoolTest.test_launch_values.
// RA-18: RedeployPoolTest.test_RA18_*; RedeployInvariants.invariant_redeployBooksAndClocks.
contract ConformanceMatrixTest is Base {
    uint256 internal constant ID = 7;

    /// A013, A130: a fee change after a borrow keeps the open loan's fee.
    function test_A013_fee_change_after_borrow_keeps_the_loan_fee() public {
        RigAgent a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        uint256 feeAtBorrow = a.loanOf().feeLeft;
        uint256 debtAtBorrow = a.loanOf().debt;
        _queueExecute(TapePool.Param.FeeBps7d, 300);
        assertEq(pool.fee(0, BEM), 3 * BEM / 100, "new loans pay the new fee");
        assertEq(a.loanOf().feeLeft, feeAtBorrow, "open loan keeps its fee");
        assertEq(a.loanOf().debt, debtAtBorrow, "open loan keeps its debt");
    }

    /// A013, A130: changing the reserve share preserves an open loan's stored allocation.
    function test_A013_reserve_share_change_keeps_open_loan_terms() public {
        RigAgent a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        uint256 feeLeft = a.loanOf().feeLeft;
        _queueExecute(TapePool.Param.ReserveShareBps, 0);
        _harvest(address(a), a.loanOf().debt);
        a.sweep();
        assertFalse(a.hasLoan(), "repaid");
        assertGt(feeLeft, 0);
        assertEq(pool.reserve(), feeLeft * 2_000 / 10_000, "open loan keeps its stored split");
    }

    /// A016: the operating fee goes to the owner and is not part of the BEM debt.
    function test_A016_operating_fee_is_not_part_of_the_debt() public {
        RigAgent a = _ready(alice, ID);
        uint256 ownerBefore = pool.owner().balance;
        _borrow(a, alice, 0, BEM);
        assertEq(pool.owner().balance - ownerBefore, OPS, "fee forwarded to the owner");
        assertEq(address(a).balance, 0, "nothing stays in the agent");
        assertEq(a.loanOf().debt, BEM + pool.fee(0, BEM), "debt is principal plus the BEM fee only");
        _harvest(address(a), BEM + pool.fee(0, BEM));
        a.sweep();
        assertFalse(a.hasLoan(), "BEM alone clears the loan");
    }

    /// A142 (holds in part, [L-06]): while the feed is off, `loanOf` reports a deadline that has passed,
    /// yet `seize` still succeeds because no deadline applies.
    function test_A142_loanOf_deadline_does_not_bind_while_the_feed_is_off() public {
        RigAgent a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        vm.warp(block.timestamp + 1 hours);
        RigReport memory r = _report(ID, 100);
        r.status = 2; // revoked
        feed.set(r);
        a.flagImpaired(ID);
        vm.prank(guardian);
        pool.disableFeed();
        vm.warp(block.timestamp + 5 days);
        voucher.setRig(ID, uint64(block.timestamp), 0); // path (b) evidence after the seize start
        assertEq(a.loanOf().deadline, type(uint64).max, "the deadline is paused");
        assertFalse(a.loanOf().expired, "the flag is not expired");
        a.seize();
        assertTrue(a.closed(), "seized after the reported deadline");
    }
}
