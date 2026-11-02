// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {TapePool} from "../../src/TapePool.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {Reasons} from "../../src/interfaces/ICreditPolicy.sol";
import {console2} from "forge-std/console2.sol";
import {Vm} from "forge-std/Vm.sol";

/// Approved redeploy accounting, admission, governance and clock boundaries.
contract RedeployPoolTest is Base {
    event Synced(uint256 amount, uint256 unvested, uint64 vestEnd);

    function test_N04_syncWithoutSurplusEmitsNothingAndKeepsVesting() public {
        vm.recordLogs();
        pool.sync();
        assertEq(vm.getRecordedLogs().length, 0);

        _deposit(lp, 10 * BEM);
        _income(BEM);
        uint256 unvested = pool.unvested();
        uint64 updatedAt = pool.vestUpdatedAt();
        uint64 end = pool.vestEnd();
        vm.warp(block.timestamp + 1 days);
        vm.recordLogs();
        pool.sync();
        pool.approve(bob, 1);
        vm.prank(owner);
        pool.pauseBorrows();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != Synced.selector, "no zero-amount Synced at checkpoints");
        }
        assertEq(pool.unvested(), unvested);
        assertEq(pool.vestUpdatedAt(), updatedAt);
        assertEq(pool.vestEnd(), end);
        assertEq(pool.tracked(), 11 * BEM);
    }

    function test_N04_syncEmitsPositiveAmountForReserveAndVesting() public {
        bem.mint(address(pool), 1);
        vm.expectEmit(address(pool));
        emit Synced(1, 0, 0);
        pool.sync();
        assertEq(pool.reserve(), 1);

        _deposit(lp, 10 * BEM);
        bem.mint(address(pool), BEM);
        vm.expectEmit(address(pool));
        emit Synced(BEM, BEM, uint64(block.timestamp + 7 days));
        pool.sync();
        assertEq(pool.unvestedNow(), BEM);
    }

    function _lend(address who, uint256 index, uint256 amount) internal returns (RigAgent a) {
        a = _agent(who, index);
        vm.prank(address(a));
        pool.lend(amount);
    }

    function _pay(RigAgent a, uint256 fees, uint256 principal) internal {
        bem.mint(address(a), fees + principal);
        vm.startPrank(address(a));
        bem.approve(address(pool), fees + principal);
        pool.repay(fees, principal);
        vm.stopPrank();
    }

    function _income(uint256 amount) internal {
        bem.mint(address(pool), amount);
        pool.sync();
    }

    function _backed() internal view {
        assertLe(pool.tracked(), bem.balanceOf(address(pool)));
        assertLe(pool.unvestedNow(), pool.idle() + pool.outstandingPrincipal() - pool.doubtful());
        assertEq(pool.totalAssets(), pool.idle() + pool.outstandingPrincipal() - pool.doubtful() - pool.unvestedNow());
    }

    function test_RA01_firstIncomeAndNoSurplusAndEndedSchedule() public {
        _deposit(lp, 10 * BEM);
        _income(BEM);
        assertEq(pool.totalAssets(), 10 * BEM);
        assertEq(pool.unvestedNow(), BEM);
        uint64 end = pool.vestEnd();
        pool.sync();
        assertEq(pool.vestEnd(), end);
        vm.warp(end);
        assertEq(pool.totalAssets(), 11 * BEM);
        _income(BEM);
        assertEq(pool.unvestedNow(), BEM);
        assertEq(pool.vestEnd(), block.timestamp + 7 days);
        assertEq(pool.totalAssets(), 11 * BEM);
        _backed();
    }

    function test_RA01_incomeWithoutSharesGoesToReserve() public {
        _income(BEM);
        assertEq(pool.reserve(), BEM);
        assertEq(pool.tracked(), BEM);
        assertEq(pool.totalAssets(), 0);
        _deposit(lp, BEM);
        assertEq(pool.totalAssets(), BEM);
    }

    function test_RA01_smallAdditionDoesNotExtendSchedule() public {
        _deposit(lp, 10 * BEM);
        _income(5 * BEM);
        uint64 end = pool.vestEnd();
        vm.warp(block.timestamp + 1 days);
        uint256 before = pool.totalAssets();
        _income(1);
        assertEq(pool.vestEnd(), end);
        assertEq(pool.totalAssets(), before);
    }

    function test_RA01_previewsAgreeBeforeSyncAndAllVaultCalls() public {
        _deposit(lp, 10 * BEM);
        bem.mint(address(pool), BEM);
        uint256 preview = pool.previewDeposit(BEM);
        assertEq(_deposit(bob, BEM), preview);
        bem.mint(bob, BEM);
        vm.startPrank(bob);
        bem.approve(address(pool), BEM);
        uint256 shares = pool.previewDeposit(BEM);
        uint256 cost = pool.previewMint(shares);
        assertEq(pool.mint(shares, bob), cost);
        preview = pool.previewWithdraw(BEM);
        assertEq(pool.withdraw(BEM, bob, bob), preview);
        shares = pool.balanceOf(bob);
        preview = pool.previewRedeem(shares);
        assertEq(pool.redeem(shares, bob, bob), preview);
        vm.stopPrank();
        _backed();
    }

    function test_RA01_roundOneWithdrawalFlagAndWriteOff() public {
        _deposit(lp, 10 * BEM);
        _income(5 * BEM);
        RigAgent a = _lend(alice, 0, 4 * BEM);
        vm.prank(lp);
        pool.withdraw(950_000_000, lp, lp);
        vm.prank(address(a));
        pool.markDoubtful();
        assertEq(pool.absorbedOf(address(a)), 4 * BEM);
        assertEq(pool.totalAssets(), BEM / 2);
        _backed();
        vm.prank(address(a));
        pool.writeOff();
        assertEq(pool.absorbedOf(address(a)), 0);
        _backed();
    }

    function test_RA01_sameBlockFlagAndRecoveryCannotReleaseAbsorbedIncome() public {
        _deposit(lp, 10 * BEM);
        _income(5 * BEM);
        RigAgent a = _lend(alice, 0, 4 * BEM);
        uint256 before = pool.totalAssets();
        vm.prank(address(a));
        pool.markDoubtful();
        assertEq(pool.totalAssets(), before);
        _pay(a, 0, 4 * BEM);
        assertEq(pool.totalAssets(), before);
        assertEq(pool.unvestedNow(), 5 * BEM);
        assertEq(pool.absorbedOf(address(a)), 0);
        uint256 shares = _deposit(bob, BEM);
        vm.prank(bob);
        assertLe(pool.redeem(shares, bob, bob), BEM);
        _backed();
    }

    function test_RA01_partialRecoveryClearRepeatedFlagAndFullAbsorption() public {
        _deposit(lp, 10 * BEM);
        RigAgent a = _lend(alice, 0, 4 * BEM);
        _income(2 * BEM);
        vm.prank(address(a));
        pool.markDoubtful();
        assertEq(pool.unvestedNow(), 0);
        _income(BEM);
        assertEq(pool.vestEnd(), block.timestamp + 7 days);
        _pay(a, 0, BEM);
        assertEq(pool.absorbedOf(address(a)), BEM);
        assertEq(pool.maxDeposit(bob), 0, "a partial doubtful repayment still blocks entry");
        vm.prank(address(a));
        pool.clearDoubtful();
        assertEq(pool.absorbedOf(address(a)), 0);
        assertEq(pool.unvestedNow(), 3 * BEM);
        for (uint256 i; i < 3; ++i) {
            uint256 before = pool.totalAssets();
            vm.prank(address(a));
            pool.markDoubtful();
            vm.prank(address(a));
            pool.clearDoubtful();
            assertEq(pool.totalAssets(), before);
            uint256 shares = _deposit(bob, BEM);
            vm.prank(bob);
            assertLe(pool.redeem(shares, bob, bob), BEM);
        }
        _backed();
    }

    function test_RA01_deadSeedOwnsIncomeAndResidualRecoveryIsSharedAfterVesting() public {
        address dead = address(0xdead);
        _deposit(dead, BEM / 100);
        _income(BEM);
        vm.warp(pool.vestEnd());
        assertEq(pool.convertToAssets(pool.balanceOf(dead)), 101_000_000 - 100);
        uint256 before = pool.convertToAssets(pool.balanceOf(dead));
        uint256 shares = _deposit(bob, BEM);
        assertLe(pool.convertToAssets(shares), BEM);
        assertGe(pool.convertToAssets(pool.balanceOf(dead)), before);
        _income(BEM); // A recovery received after entry is shared by those who hold through VEST.
        assertLe(pool.convertToAssets(shares), BEM);
        vm.warp(pool.vestEnd());
        assertGt(pool.convertToAssets(shares), BEM);
        vm.prank(bob);
        pool.redeem(shares, bob, bob);
        assertGt(pool.totalSupply(), 0);
        _backed();
    }

    function test_RA02_absoluteCapBoundaryLowerAndDelayedRaise() public {
        _deposit(lp, 20 * BEM);
        RigAgent a = _agent(alice, 0);
        (uint256 limit, uint8 binding) = pool.lendLimit(alice);
        assertEq(limit, 4 * BEM);
        assertEq(binding, 3);
        assertEq(pool.maxLend(alice), limit);
        vm.prank(address(a));
        vm.expectRevert(TapePool.ExceedsBorrowerCap.selector);
        pool.lend(limit + 1);
        vm.prank(address(a));
        pool.lend(limit);
        vm.prank(owner);
        pool.lowerCap(TapePool.Param.PerBorrowerAbs, BEM);
        assertEq(pool.principalOf(alice), 4 * BEM);
        assertEq(pool.maxLend(alice), 0);
        vm.prank(owner);
        pool.queueParam(TapePool.Param.PerBorrowerAbs, 5 * BEM);
        vm.expectRevert(TapePool.TooEarly.selector);
        pool.executeParam(TapePool.Param.PerBorrowerAbs);
        vm.warp(block.timestamp + 48 hours);
        pool.executeParam(TapePool.Param.PerBorrowerAbs);
        assertEq(pool.maxLend(alice), BEM);
        _pay(a, 0, 4 * BEM);
    }

    function test_RA02_lowerBorrowCapBelowExposureDoesNotBlockRepaymentOrWithdrawal() public {
        _deposit(lp, 20 * BEM);
        RigAgent a = _lend(alice, 0, 4 * BEM);
        vm.prank(owner);
        pool.lowerCap(TapePool.Param.BorrowCapAbs, 0);
        assertEq(pool.outstandingPrincipal(), 4 * BEM);
        assertEq(pool.maxLend(bob), 0);
        vm.prank(lp);
        pool.withdraw(BEM, lp, lp);
        _pay(a, 0, 4 * BEM);
    }

    function test_RA03_termsPersistForPartialFlatAndLatePaymentsAndRefreshAfterClose() public {
        _deposit(lp, 20 * BEM);
        RigAgent a = _lend(alice, 0, BEM);
        _queueExecute(TapePool.Param.ReserveShareBps, 5_000);
        _queueExecute(TapePool.Param.ReserveCapBps, 0);
        _pay(a, 1_000_000, 0);
        _pay(a, 1_000_000, BEM / 2);
        assertEq(pool.reserve(), 400_000);
        (uint16 share, uint16 cap) = pool.loanReserveTerms(address(a));
        assertEq(share, 2_000);
        assertEq(cap, 500);
        _pay(a, 0, BEM / 2);
        (share, cap) = pool.loanReserveTerms(address(a));
        assertEq(share, 0);
        assertEq(cap, 0);
        vm.prank(address(a));
        pool.lend(BEM);
        (share, cap) = pool.loanReserveTerms(address(a));
        assertEq(share, 5_000);
        assertEq(cap, 0);
        _pay(a, 1_000_000, BEM);
        assertEq(pool.reserve(), 400_000);
    }

    function test_RA05_brakesMergeAndClockNeverDropsAndOldExpiryStays() public {
        uint64 f = uint64(block.timestamp);
        assertEq(pool.expiryOf(f), f + 96 hours + 1);
        vm.warp(f + 1 hours);
        vm.prank(guardian);
        pool.disableFeed();
        assertEq(pool.expiryOf(f), type(uint64).max);
        vm.warp(f + 169 hours);
        assertEq(pool.frozenClock(), 168 hours);
        vm.prank(owner);
        pool.enableFeed();
        assertEq(pool.frozenClock(), 168 hours);
        assertEq(pool.expiryOf(f), f + 288 hours + 1);
        vm.warp(f + 170 hours);
        vm.prank(guardian);
        pool.disableFeed();
        assertEq(pool.frozenCount(), 1);
        vm.warp(f + 171 hours);
        vm.prank(owner);
        pool.enableFeed();
        assertEq(pool.expiryOf(f), f + 290 hours + 1);
        uint64 expiry = pool.expiryOf(f);
        vm.warp(expiry);
        vm.prank(guardian);
        pool.disableFeed();
        assertEq(pool.expiryOf(f), expiry);
        assertEq(pool.frozenBetween(f, f + 195 hours), 194 hours);
        assertEq(pool.frozenBetween(f + 1, f), 0);
    }

    function test_RA05_historyOf200IntervalsHasBoundedLookupAndCannotReviveOldFlag() public {
        uint64 oldFlag = uint64(block.timestamp);
        vm.warp(block.timestamp + 100 hours);
        uint64 flag;
        for (uint256 i; i < 200; ++i) {
            if (i == 199) flag = uint64(block.timestamp);
            vm.prank(guardian);
            pool.disableFeed();
            vm.warp(block.timestamp + 1 hours);
            vm.prank(owner);
            pool.enableFeed();
            vm.warp(block.timestamp + 25 hours);
        }
        uint256 g = gasleft();
        uint64 expiry = pool.expiryOf(flag);
        uint256 used = g - gasleft();
        console2.log("gas expiryOf with 200 intervals", used);
        assertLt(used, 100_000);
        assertEq(expiry, flag + 121 hours + 1);
        assertEq(pool.expiryOf(oldFlag), oldFlag + 96 hours + 1);
        assertEq(pool.frozenClock(), 200 * 25 hours);
    }

    function test_RA11_lowerCancelsLargerQueueButPreservesEqualAndSmaller() public {
        vm.startPrank(owner);
        pool.queueParam(TapePool.Param.PerBorrowerAbs, 5 * BEM);
        pool.lowerCap(TapePool.Param.PerBorrowerAbs, 3 * BEM);
        vm.expectRevert(TapePool.NothingQueued.selector);
        pool.cancelParam(TapePool.Param.PerBorrowerAbs);
        pool.queueParam(TapePool.Param.PerBorrowerAbs, 2 * BEM);
        pool.lowerCap(TapePool.Param.PerBorrowerAbs, 3 * BEM);
        (, uint64 eta) = pool.queued(TapePool.Param.PerBorrowerAbs);
        assertGt(eta, 0);
        pool.queueParam(TapePool.Param.PerBorrowerAbs, 3 * BEM);
        pool.lowerCap(TapePool.Param.PerBorrowerAbs, 3 * BEM);
        (, eta) = pool.queued(TapePool.Param.PerBorrowerAbs);
        assertGt(eta, 0);
        vm.stopPrank();
    }

    function test_RA12_roleRotationCannotMergeKeysInEitherOrder() public {
        vm.startPrank(owner);
        vm.expectRevert(TapePool.GuardianIsOwner.selector);
        pool.transferOwnership(guardian);
        pool.transferOwnership(bob);
        vm.expectRevert(TapePool.GuardianIsOwner.selector);
        pool.setGuardian(bob);
        pool.transferOwnership(address(0));
        pool.setGuardian(bob);
        vm.expectRevert(TapePool.GuardianIsOwner.selector);
        pool.transferOwnership(bob);
        vm.stopPrank();
    }

    function test_N02_guardianCanBeClearedWithOrWithoutPendingOwner() public {
        assertEq(pool.pendingOwner(), address(0));
        vm.startPrank(owner);
        pool.setGuardian(address(0));
        assertEq(pool.guardian(), address(0));
        pool.setGuardian(guardian);
        pool.transferOwnership(bob);
        pool.setGuardian(address(0));
        assertEq(pool.guardian(), address(0));
        assertEq(pool.pendingOwner(), bob);
        vm.stopPrank();
    }

    function test_N02_pendingOwnerCanBeCancelledWithoutGuardian() public {
        vm.startPrank(owner);
        pool.setGuardian(address(0));
        pool.transferOwnership(bob);
        assertEq(pool.pendingOwner(), bob);
        pool.transferOwnership(address(0));
        assertEq(pool.pendingOwner(), address(0));
        assertEq(pool.owner(), owner);
        vm.stopPrank();
    }

    function test_N02_nonzeroGuardianCannotBeOwnerOrPendingOwner() public {
        vm.startPrank(owner);
        vm.expectRevert(TapePool.GuardianIsOwner.selector);
        pool.setGuardian(owner);
        pool.transferOwnership(bob);
        vm.expectRevert(TapePool.GuardianIsOwner.selector);
        pool.setGuardian(owner);
        vm.expectRevert(TapePool.GuardianIsOwner.selector);
        pool.setGuardian(bob);
        pool.setGuardian(alice);
        assertEq(pool.guardian(), alice);
        vm.stopPrank();
    }

    function test_RA17_launchAndParamOrdinals() public view {
        assertEq(uint256(TapePool.Param.PerBorrowerAbs), 13);
        assertEq(pool.borrowCapAbs(), 8 * BEM);
        assertEq(pool.perBorrowerAbs(), 4 * BEM);
        assertEq(pool.feeBps7d(), 25);
        assertEq(pool.feeBps14d(), 50);
        assertEq(pool.minFee(), BEM / 1_000);
        assertEq(pool.opsFee(0), 0);
        assertEq(pool.opsFee(1), 0);
        for (uint256 i; i < 14; ++i) {
            TapePool.Param key = TapePool.Param(i);
            (uint256 low, uint256 high) = pool.bounds(key);
            assertGe(pool.param(key), low);
            assertLe(pool.param(key), high);
        }
    }

    function test_RA18_backstopBoundaryAndOrdinaryLenderExit() public {
        _deposit(lp, BEM);
        _deposit(bob, 19 * BEM);
        RigAgent a = _agent(alice, 0);
        (uint256 limit, uint8 binding) = pool.lendLimit(alice);
        assertEq(limit, BEM);
        assertEq(binding, 4);
        vm.prank(address(a));
        vm.expectRevert(TapePool.ExceedsBackstop.selector);
        pool.lend(BEM + 1);
        vm.prank(address(a));
        pool.lend(BEM);
        vm.prank(bob);
        pool.withdraw(19 * BEM, bob, bob);
        assertEq(pool.outstandingPrincipal(), BEM);
        assertGt(pool.outstandingPrincipal() * 10_000, pool.totalAssets() * pool.borrowCapBps());
        assertEq(pool.maxLend(alice), 0);
        assertEq(pool.backstop(), lp);
    }

    function test_RA18_roomAfterWriteOffUsesCurrentShareValue() public {
        _deposit(lp, 10 * BEM);
        _deposit(bob, 10 * BEM);
        RigAgent a = _lend(alice, 0, 4 * BEM);
        _lend(bob, 0, 4 * BEM);
        vm.prank(address(a));
        pool.markDoubtful();
        vm.prank(address(a));
        pool.writeOff();
        assertEq(pool.totalAssets(), 16 * BEM);
        assertEq(pool.convertToAssets(pool.balanceOf(lp)), 8 * BEM);
        assertEq(pool.maxLend(alice), 4 * BEM);
        // Admission does not lock the backstop's shares; withdrawals use ordinary liquidity rules.
        vm.prank(lp);
        pool.withdraw(BEM, lp, lp);
        assertEq(pool.convertToAssets(pool.balanceOf(lp)), 7 * BEM);
        assertEq(pool.maxLend(alice), 3 * BEM);
    }
}
