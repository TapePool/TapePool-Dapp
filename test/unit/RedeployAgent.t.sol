// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {TapePool} from "../../src/TapePool.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {Reasons} from "../../src/interfaces/ICreditPolicy.sol";
import {console2} from "forge-std/console2.sol";

contract RedeployAgentTest is Base {
    function _loan() internal returns (RigAgent a) {
        a = _ready(alice, 1);
        _borrow(a, alice, 0, BEM);
    }

    function _bad(uint256 id, uint64 at, bool voucherPath) internal {
        if (voucherPath) {
            feed.clear(id);
            voucher.setRig(id, at, 0);
        } else {
            RigReport memory r = _rescuedReport(id);
            r.observedAt = at;
            feed.set(r);
        }
    }

    function _flag(RigAgent a) internal {
        vm.warp(a.flagEvidenceFrom());
        _bad(1, uint64(block.timestamp), false);
        a.flagImpaired(1);
    }

    function test_RA04_operatorAndOpenLoanCannotGrowCollateralAndPlainTransferIsIgnored() public {
        RigAgent a = _ready(alice, 1);
        _rig(alice, 2, 100);
        vm.prank(alice);
        voucher.setApprovalForAll(bob, true);
        vm.prank(bob);
        vm.expectRevert(RigAgent.NotFromBorrower.selector);
        voucher.safeTransferFrom(alice, address(a), 2);
        _borrow(a, alice, 0, BEM);
        vm.prank(bob);
        vm.expectRevert(RigAgent.NotFromBorrower.selector);
        voucher.safeTransferFrom(alice, address(a), 2);
        vm.prank(alice);
        vm.expectRevert(RigAgent.LoanOpen.selector);
        voucher.safeTransferFrom(alice, address(a), 2);
        vm.prank(alice);
        voucher.transferFrom(alice, address(a), 2);
        vm.prank(alice);
        vm.expectRevert(RigAgent.LoanOpen.selector);
        a.register(2);
        _bad(2, uint64(block.timestamp + 60), false);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.NotCollateral.selector, 2));
        a.flagImpaired(2);
        _flag(a);
        vm.warp(pool.expiryOf(a.loanOf().impairedAt));
        _refresh(1, 100);
        a.clearExpiredFlag(); // The impaired unregistered voucher is not evidence against clearing.
        _flag(a);
        vm.warp(a.seizeEvidenceFrom());
        _bad(1, uint64(block.timestamp), false);
        a.seize();
        assertEq(voucher.ownerOf(2), address(a));
        vm.prank(alice);
        a.withdrawVoucher(2);
        assertEq(voucher.ownerOf(2), alice);
    }

    function testFuzz_RA06_initialReplacementAndClearFloorsOnBothPaths(bool voucherPath) public {
        RigAgent a = _loan();
        uint64 from = a.flagEvidenceFrom();
        vm.warp(from);
        _bad(1, from - 1, voucherPath);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(1);
        _bad(1, from, voucherPath);
        a.flagImpaired(1);
        assertEq(a.flagEvidenceFrom(), type(uint64).max);
        uint64 seizeFloor = a.seizeEvidenceFrom();
        vm.warp(seizeFloor);
        _bad(1, seizeFloor - 1, voucherPath);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.seize();
        uint256 snap = vm.snapshotState();
        _bad(1, seizeFloor, voucherPath);
        a.seize();
        assertTrue(a.closed());
        vm.revertToState(snap);
        uint64 expiry = pool.expiryOf(a.loanOf().impairedAt);
        vm.warp(expiry + 60);
        assertEq(a.flagEvidenceFrom(), expiry + 60);
        _bad(1, expiry + 59, voucherPath);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(1);
        _bad(1, expiry + 60, voucherPath);
        a.flagImpaired(1);
        vm.warp(pool.expiryOf(a.loanOf().impairedAt));
        voucher.setRig(1, uint64(block.timestamp), 110);
        _refresh(1, 100);
        a.clearExpiredFlag();
        from = a.flagEvidenceFrom();
        assertEq(from, block.timestamp + 60);
        _bad(1, from - 1, voucherPath);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(1);
        _bad(1, from, voucherPath);
        a.flagImpaired(1);
    }

    function test_RA06_roundThreeBrakeBoundaryAndLateVoucherDelivery() public {
        RigAgent a = _loan();
        _flag(a);
        uint64 f = a.loanOf().impairedAt;
        vm.warp(f + 1 hours);
        vm.prank(guardian);
        pool.disableFeed();
        vm.warp(f + 169 hours);
        vm.prank(owner);
        pool.enableFeed();
        uint64 expiry = pool.expiryOf(f);
        assertEq(expiry, f + 288 hours + 1);
        vm.warp(expiry + 5 hours);
        _bad(1, expiry - 120, true);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(1);
        _bad(1, expiry + 59, true);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(1);
        _bad(1, expiry + 60, true);
        a.flagImpaired(1);
        assertEq(a.loanOf().impairedAt, block.timestamp);
    }

    function test_RA05_expiryBoundaryAndDisableAgreeAcrossAgentPaths() public {
        RigAgent a = _loan();
        _flag(a);
        uint64 f = a.loanOf().impairedAt;
        uint64 e = pool.expiryOf(f);
        for (uint256 i; i < 3; ++i) {
            uint256 snap = vm.snapshotState();
            vm.warp(uint256(e) - 1 + i);
            _bad(1, uint64(block.timestamp), false);
            assertEq(a.loanOf().expired, i != 0);
            if (i != 0) {
                vm.expectRevert(RigAgent.FlagExpired.selector);
                a.seize();
            } else {
                vm.expectRevert(RigAgent.FlagNotExpired.selector);
                a.clearExpiredFlag();
                vm.expectRevert(RigAgent.FlagLive.selector);
                a.flagImpaired(1);
            }
            vm.prank(guardian);
            pool.disableFeed();
            assertEq(a.loanOf().expired, i != 0);
            if (i == 0) {
                assertEq(a.loanOf().deadline, type(uint64).max);
            } else {
                vm.expectRevert(RigAgent.FlagExpired.selector);
                a.seize();
            }
            vm.revertToState(snap);
        }
    }

    function test_RA05_seizeWith200IntervalsAndOldExpiredFlag() public {
        RigAgent a = _loan();
        _flag(a);
        uint64 oldFlag = a.loanOf().impairedAt;
        vm.warp(uint256(oldFlag) + 100 hours);
        for (uint256 i; i < 200; ++i) {
            vm.prank(guardian);
            pool.disableFeed();
            vm.warp(block.timestamp + 1 hours);
            vm.prank(owner);
            pool.enableFeed();
            vm.warp(block.timestamp + 25 hours);
        }
        uint256 g = gasleft();
        (bool ok, bytes memory result) = address(a).call(abi.encodeCall(RigAgent.seize, ()));
        uint256 used = g - gasleft();
        assertFalse(ok);
        assertEq(bytes4(result), RigAgent.FlagExpired.selector);
        assertLt(used, 100_000);
        console2.log("gas expired seize after 200 later brakes", used);
        assertEq(pool.expiryOf(oldFlag), oldFlag + 96 hours + 1);
        _bad(1, uint64(block.timestamp + 60), false);
        a.flagImpaired(1);
        vm.warp(a.seizeEvidenceFrom());
        _bad(1, uint64(block.timestamp), false);
        g = gasleft();
        a.seize();
        used = g - gasleft();
        assertLt(used, 4_000_000);
        console2.log("gas seize with 200 historical brakes", used);
    }

    function _twoRigFlag() internal returns (RigAgent a) {
        a = _ready(alice, 1);
        _rig(alice, 2, 100);
        _pledge(a, alice, 2);
        _borrow(a, alice, 0, BEM);
        _flag(a);
        vm.warp(pool.expiryOf(a.loanOf().impairedAt));
        _refresh(1, 100);
    }

    function test_RA07_everyRigNewestVerdictAndEqualTimeImpairment() public {
        RigAgent a = _twoRigFlag();
        uint64 at = uint64(block.timestamp);
        _bad(2, at, true);
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        RigReport memory r = _report(2, 100);
        r.observedAt = at;
        feed.set(r);
        vm.expectRevert(RigAgent.NoHealthEvidence.selector); // equal: power-zero record wins
        a.clearExpiredFlag();
        r.observedAt = at + 1;
        r.totalVerifWeight = 1; // insane, otherwise healthy: ignored
        feed.set(r);
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        r.totalVerifWeight = NETWORK_WEIGHT;
        r.verifWeight = 110;
        r.bonus = 100; // bonus larger than the remaining base power still counts as healthy
        feed.set(r);
        uint256 snap = vm.snapshotState();
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
        vm.revertToState(snap);
        voucher.setRig(2, at + 2, 0); // newer voucher impairment beats the report
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        voucher.setRig(2, at + 2, 110);
        _bad(2, at + 3, false); // rescued, zero-weight report counts without sanity
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        _refresh(2, 100);
        a.clearExpiredFlag();
    }

    function test_RA07_missingOtherRigDoesNotBlockButMissingFlaggedRigDoes() public {
        RigAgent a = _twoRigFlag();
        feed.clear(2);
        a.clearExpiredFlag();
        _flag(a);
        vm.warp(pool.expiryOf(a.loanOf().impairedAt));
        feed.clear(1);
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
    }

    function test_RA08_partialFundsReduceMarkAndFullFundsCloseWithoutEvidence() public {
        RigAgent a = _loan();
        uint256 flat = a.loanOf().feeLeft;
        _harvest(address(a), flat + BEM / 2);
        _flag(a);
        assertEq(pool.doubtful(), BEM / 2);
        assertEq(a.loanOf().principal, BEM / 2);
        RigAgent b = _ready(bob, 2);
        _borrow(b, bob, 0, BEM);
        _harvest(address(b), b.loanOf().debt);
        feed.clear(2);
        b.flagImpaired(2);
        assertFalse(b.hasLoan());
        assertEq(pool.doubtfulOf(address(b)), 0);
    }

    function testFuzz_RA09_feeOnlyPaymentsAndPrincipalIntervals(
        uint32 secondsLate,
        uint8 calls,
        uint256 principal,
        uint16 bps
    ) public {
        principal = bound(principal, BEM / 100, 2 * BEM);
        bps = uint16(bound(bps, 1, 30));
        _queueExecute(TapePool.Param.LateFeeBpsPerDay, bps);
        RigAgent a = _ready(alice, 1);
        _borrow(a, alice, 0, principal);
        uint256 dt = bound(secondsLate, 1, 30 days);
        uint256 n = bound(calls, 1, 32);
        uint64 maturity = a.loanOf().maturity;
        for (uint256 i = 1; i <= n; ++i) {
            vm.warp(uint256(maturity) + dt * i / n);
            a.sweep();
        }
        uint256 expected = (principal * bps * dt + 10_000 * 1 days - 1) / (10_000 * 1 days);
        assertEq(a.loanOf().lateFeeDue, expected);
        _harvest(address(a), expected);
        a.sweep();
        assertEq(a.loanOf().lateAccruedTo, maturity);
        assertEq(a.loanOf().lateFeeDue, 0);
        _harvest(address(a), a.loanOf().feeLeft + principal / 2);
        a.sweep();
        assertEq(a.loanOf().lateAccruedTo, block.timestamp);
        vm.warp(block.timestamp + 1 days);
        assertEq(a.loanOf().lateFeeDue, ((principal - principal / 2) * bps + 9_999) / 10_000);
    }

    function test_RA10_feeBoundsIncludeMinimumAndLateRate() public {
        RigAgent a = _ready(alice, 1);
        uint256 p = BEM / 100;
        uint256 quoted = pool.fee(0, p);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.FeeAboveBound.selector, quoted, uint16(0)));
        a.borrow(0, p, quoted - 1, 0);
        _queueExecute(TapePool.Param.LateFeeBpsPerDay, 1);
        _refresh(1, 100);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.FeeAboveBound.selector, quoted, uint16(1)));
        a.borrow(0, p, quoted, 0);
        vm.prank(alice);
        a.borrow(0, p, quoted, 1);
    }

    function test_RA03_lateFeePaymentUsesBorrowTimeReserveTerms() public {
        _queueExecute(TapePool.Param.LateFeeBpsPerDay, 1);
        RigAgent a = _loan();
        _queueExecute(TapePool.Param.ReserveShareBps, 5_000);
        _queueExecute(TapePool.Param.ReserveCapBps, 0);
        vm.warp(uint256(a.loanOf().maturity) + 1 days);
        assertEq(a.loanOf().lateFeeDue, 10_000);
        _harvest(address(a), 10_000);
        a.sweep();
        assertEq(pool.reserve(), 2_000);
        assertEq(pool.unvestedNow(), 8_000);
        assertEq(a.loanOf().lateFeeDue, 0);
    }

    function test_RA16_releaseRetriesAndForgetPermissions() public {
        RigAgent a = _ready(alice, 1);
        _rig(alice, 2, 100);
        _pledge(a, alice, 2);
        voucher.setBlocked(2, true);
        vm.prank(alice);
        a.release();
        assertEq(voucher.ownerOf(1), alice);
        assertEq(a.collateralOf().length, 1);
        vm.prank(bob);
        vm.expectRevert(RigAgent.NotBorrower.selector);
        a.forget(2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.NotCollateral.selector, 3));
        a.forget(3);
        voucher.setBlocked(2, false);
        vm.prank(alice);
        a.release();
        assertEq(a.collateralOf().length, 0);
        assertEq(voucher.ownerOf(2), alice);
        _pledge(a, alice, 1);
        _borrow(a, alice, 0, BEM);
        vm.prank(alice);
        vm.expectRevert(RigAgent.LoanOpen.selector);
        a.forget(1);
        _flag(a);
        vm.warp(a.seizeEvidenceFrom());
        _bad(1, uint64(block.timestamp), false);
        a.seize();
        vm.prank(alice);
        vm.expectRevert(RigAgent.AgentClosed.selector);
        a.forget(1);
    }

    function test_RA19_quoteForFeeAndBlockerPrecedenceAndLimitBinding() public {
        RigAgent a = _ready(alice, 1);
        (uint256 fee, uint16 late, uint256 debt, bool allowed, uint8 reason, uint8 binding) = lens.quoteFor(a, 0, BEM);
        assertEq(fee, pool.fee(0, BEM));
        assertEq(late, 0);
        assertEq(debt, BEM + fee);
        assertTrue(allowed);
        assertEq(reason, Reasons.OK);
        assertEq(binding, 0);
        (,,, allowed, reason, binding) = lens.quoteFor(a, 0, 1);
        assertFalse(allowed);
        assertEq(reason, Reasons.BELOW_MIN_ADVANCE);
        vm.prank(owner);
        pool.lowerCap(TapePool.Param.PerBorrowerAbs, BEM / 2);
        (,,, allowed, reason, binding) = lens.quoteFor(a, 0, BEM);
        assertFalse(allowed);
        assertEq(reason, Reasons.ABOVE_LEND_LIMIT);
        assertEq(binding, 3);
        vm.prank(guardian);
        pool.pauseBorrows();
        (fee, late, debt, allowed, reason, binding) = lens.quoteFor(a, 0, BEM);
        assertEq(fee, pool.fee(0, BEM));
        assertEq(reason, Reasons.PAUSED);
        assertEq(binding, 0);
        (fee,, debt,, reason,) = lens.quoteFor(a, 2, BEM);
        assertEq(fee, 0);
        assertEq(debt, 0);
        assertEq(reason, Reasons.BAD_TERM);
    }

    function test_RA19_poolLensAndBorrowAgreeAtEveryReachablePositiveLimit() public {
        RigAgent a = _ready(alice, 1);
        for (uint8 constraint = 2; constraint <= 4; ++constraint) {
            uint256 snap = vm.snapshotState();
            if (constraint == 2) {
                vm.prank(owner);
                pool.lowerCap(TapePool.Param.BorrowCapAbs, BEM);
            } else if (constraint == 3) {
                vm.prank(owner);
                pool.lowerCap(TapePool.Param.PerBorrowerAbs, BEM);
            } else {
                vm.prank(lp);
                pool.transfer(bob, 19 * BEM * 1e6);
            }
            (uint256 limit, uint8 binding) = pool.lendLimit(alice);
            assertEq(limit, BEM);
            assertEq(binding, constraint);
            (,,, bool allowed, uint8 reason,) = lens.quoteFor(a, 0, limit);
            assertTrue(allowed);
            assertEq(reason, Reasons.OK);
            (,,, allowed, reason, binding) = lens.quoteFor(a, 0, limit + 1);
            assertFalse(allowed);
            assertEq(reason, Reasons.ABOVE_LEND_LIMIT);
            assertEq(binding, constraint);
            bytes4 errorSelector = constraint == 2
                ? TapePool.ExceedsBorrowCap.selector
                : constraint == 3 ? TapePool.ExceedsBorrowerCap.selector : TapePool.ExceedsBackstop.selector;
            vm.prank(alice);
            vm.expectRevert(errorSelector);
            a.borrow(0, limit + 1, type(uint256).max, 0);
            _borrow(a, alice, 0, limit);
            vm.revertToState(snap);
        }
        vm.prank(guardian);
        pool.pauseBorrows();
        (, uint8 pausedBinding) = pool.lendLimit(alice);
        assertEq(pausedBinding, 5);
        vm.prank(owner);
        pool.unpauseBorrows();
        vm.prank(guardian);
        pool.disableFeed();
        (, pausedBinding) = pool.lendLimit(alice);
        assertEq(pausedBinding, 5);
    }
}
