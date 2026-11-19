// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Base} from "./Base.t.sol";
import {TapePool} from "../../src/TapePool.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {ITapePool} from "../../src/interfaces/ITapePool.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";

/// R4-04: each loan's reserve cap uses lender assets captured at lend, independently of later flows.
contract Redeploy4ReserveTest is Base {
    bytes32 constant REPAID = keccak256("RepaymentReceived(address,uint256,uint256,uint256)");

    function _assets() internal view returns (uint256) {
        return pool.idle() + pool.outstandingPrincipal() - pool.doubtful() - pool.unvestedNow();
    }

    function _lend(RigAgent a, uint256 amount) internal returns (uint256 base) {
        base = _assets();
        vm.prank(address(a));
        pool.lend(amount);
        assertEq(ITapePool(address(pool)).reserveBaseOf(address(a)), base);
    }

    function _pay(RigAgent a, uint256 fees, uint256 principal) internal {
        bem.mint(address(a), fees + principal);
        vm.startPrank(address(a));
        bem.approve(address(pool), fees + principal);
        pool.repay(fees, principal);
        vm.stopPrank();
    }

    function _smallCap() internal {
        _queueExecute(TapePool.Param.ReserveCapBps, 1);
        _queueExecute(TapePool.Param.ReserveShareBps, 5_000);
    }

    function test_R4_04_baseIsNetOfReserveDoubtfulAndUnreleasedIncome() public {
        bem.mint(address(pool), BEM);
        pool.sync(); // no shares: reserve, never part of the base
        _deposit(lp, 10 * BEM);
        RigAgent first = _agent(alice, 0);
        _lend(first, BEM);
        vm.prank(address(first));
        pool.markDoubtful();
        bem.mint(address(pool), 2 * BEM);
        pool.sync();
        RigAgent second = _agent(bob, 0);
        uint256 base = _lend(second, BEM);
        assertEq(base, 9 * BEM);
        assertEq(pool.reserve(), BEM);
        assertEq(pool.doubtful(), BEM);
        assertEq(pool.unvestedNow(), 2 * BEM);
    }

    function test_R4_04_baseSurvivesDepositRedeemPartialRepaymentAndIncome() public {
        _deposit(lp, 10 * BEM);
        RigAgent a = _agent(alice, 0);
        uint256 base = _lend(a, BEM);
        uint256 shares = _deposit(bob, 3 * BEM);
        assertEq(pool.reserveBaseOf(address(a)), base);
        vm.prank(bob);
        pool.redeem(shares, bob, bob);
        assertEq(pool.reserveBaseOf(address(a)), base);
        _pay(a, 10_000, BEM / 4);
        assertEq(pool.reserveBaseOf(address(a)), base);
        bem.mint(address(pool), 2 * BEM);
        pool.sync();
        assertEq(pool.reserveBaseOf(address(a)), base);
        vm.warp(pool.vestEnd());
        assertGt(_assets(), base);
        assertEq(pool.reserveBaseOf(address(a)), base);
        _pay(a, 0, 3 * BEM / 4);
        assertEq(pool.reserveBaseOf(address(a)), 0);
    }

    function test_R4_04_vestingCannotWidenTheCap() public {
        _smallCap();
        _deposit(lp, 10 * BEM);
        RigAgent a = _agent(alice, 0);
        uint256 base = _lend(a, BEM);
        bem.mint(address(pool), 10 * BEM);
        pool.sync();
        vm.warp(pool.vestEnd());
        assertEq(_assets(), 20 * BEM);
        _pay(a, BEM, 0);
        assertEq(pool.reserve(), base / 10_000);
    }

    function test_R4_04_withdrawalCannotNarrowTheCap() public {
        _smallCap();
        _deposit(lp, 10 * BEM);
        RigAgent a = _agent(alice, 0);
        uint256 base = _lend(a, BEM);
        vm.prank(lp);
        pool.withdraw(3 * BEM, lp, lp);
        assertEq(_assets(), 7 * BEM);
        _pay(a, BEM, 0);
        assertEq(pool.reserve(), base / 10_000);
    }

    function test_R4_04_depositBeforeLendRaisesTheNextBase() public {
        _deposit(lp, 10 * BEM);
        RigAgent a = _agent(alice, 0);
        assertEq(pool.reserveBaseOf(address(a)), 0);
        _deposit(bob, 3 * BEM);
        assertEq(_lend(a, BEM), 13 * BEM);
    }

    function test_R4_04_untrackedIncomeIsCheckpointedWithoutInflatingBase() public {
        _deposit(lp, 10 * BEM);
        bem.mint(address(pool), 2 * BEM);
        RigAgent a = _agent(alice, 0);
        assertEq(_lend(a, BEM), 10 * BEM);
        assertEq(pool.unvestedNow(), 2 * BEM);
    }

    function test_R4_04_twoAgentsUseDifferentStoredBases() public {
        _smallCap();
        _deposit(lp, 10 * BEM);
        RigAgent a = _agent(alice, 0);
        uint256 first = _lend(a, BEM);
        _deposit(bob, 3 * BEM);
        RigAgent b = _agent(bob, 0);
        uint256 second = _lend(b, BEM);
        assertEq(first, 10 * BEM);
        assertEq(second, 13 * BEM);
        _pay(a, BEM, 0);
        assertEq(pool.reserve(), first / 10_000);
        _pay(b, BEM, 0);
        assertEq(pool.reserve(), second / 10_000);
        assertEq(pool.reserveBaseOf(address(a)), first);
        assertEq(pool.reserveBaseOf(address(b)), second);
    }

    function test_R4_04_secondLoanOnSameAgentStoresANewBase() public {
        _deposit(lp, 10 * BEM);
        RigAgent a = _agent(alice, 0);
        assertEq(_lend(a, BEM), 10 * BEM);
        _pay(a, 0, BEM);
        assertEq(pool.reserveBaseOf(address(a)), 0);
        _deposit(bob, 3 * BEM);
        assertEq(_lend(a, BEM), 13 * BEM);
    }

    function test_R4_04_feeOnlyPaymentsUseZeroCappedAndUncappedTerms() public {
        uint256[4] memory shares = [uint256(0), 5_000, 5_000, 5_000];
        uint256[4] memory caps = [uint256(500), 0, 1, 2_000];
        for (uint256 i; i < shares.length; ++i) {
            uint256 snap = vm.snapshotState();
            _queueExecute(TapePool.Param.ReserveShareBps, shares[i]);
            _queueExecute(TapePool.Param.ReserveCapBps, caps[i]);
            _deposit(lp, 10 * BEM);
            RigAgent a = _agent(alice, 0);
            uint256 base = _lend(a, BEM);
            uint256 want = BEM * shares[i] / 10_000;
            uint256 cap = base * caps[i] / 10_000;
            if (want > cap) want = cap;
            _pay(a, BEM, 0);
            assertEq(pool.reserve(), want);
            assertEq(pool.loanPrincipalOf(address(a)), BEM);
            assertEq(pool.reserveBaseOf(address(a)), base);
            vm.revertToState(snap);
        }
    }

    function test_R4_04_reserveAboveStoredCapIsNotReducedOrIncreased() public {
        _smallCap();
        bem.mint(address(pool), BEM);
        pool.sync();
        _deposit(lp, 10 * BEM);
        RigAgent a = _agent(alice, 0);
        uint256 base = _lend(a, BEM);
        assertGt(pool.reserve(), base / 10_000);
        _pay(a, BEM, 0);
        assertEq(pool.reserve(), BEM);
    }

    function test_R4_04_laterTermsDoNotChangeStoredBaseOrSplit() public {
        _smallCap();
        _deposit(lp, 10 * BEM);
        RigAgent a = _agent(alice, 0);
        uint256 base = _lend(a, BEM);
        _queueExecute(TapePool.Param.ReserveShareBps, 0);
        _queueExecute(TapePool.Param.ReserveCapBps, 2_000);
        _pay(a, BEM, 0);
        assertEq(pool.reserve(), base / 10_000);
        assertEq(pool.reserveBaseOf(address(a)), base);
    }

    function test_R4_04_finalPaymentUsesBaseBeforeDeletingIt() public {
        _smallCap();
        _deposit(lp, 10 * BEM);
        RigAgent a = _agent(alice, 0);
        uint256 base = _lend(a, BEM);
        _pay(a, BEM, BEM);
        assertEq(pool.reserve(), base / 10_000);
        assertEq(pool.reserveBaseOf(address(a)), 0);
        (uint16 share, uint16 cap) = pool.loanReserveTerms(address(a));
        assertEq(share, 0);
        assertEq(cap, 0);
    }

    function test_R4_04_writeOffDeletesBase() public {
        _deposit(lp, 10 * BEM);
        RigAgent a = _agent(alice, 0);
        _lend(a, BEM);
        vm.prank(address(a));
        pool.writeOff();
        assertEq(pool.reserveBaseOf(address(a)), 0);
    }

    function _seizePayment(bool principalPayment) internal {
        _smallCap();
        _deposit(lp, 10 * BEM);
        RigAgent a = _agent(alice, 0);
        _rig(alice, 7, 100);
        _pledge(a, alice, 7);
        uint256 base = _assets();
        _borrow(a, alice, 0, 2 * BEM);
        assertEq(pool.reserveBaseOf(address(a)), base);
        uint256 fees = a.loanOf().feeLeft;
        vm.warp(block.timestamp + 1 hours);
        RigReport memory r = _report(7, 100);
        r.status = 2;
        feed.set(r);
        a.flagImpaired(7);
        vm.warp(a.seizeEvidenceFrom());
        r.observedAt = uint64(block.timestamp);
        feed.set(r);
        uint256 paidPrincipal = principalPayment ? BEM / 2 : 0;
        _harvest(address(a), fees + paidPrincipal);
        assertLt(_assets(), base, "the impairment mark must not narrow the stored cap");
        vm.recordLogs();
        a.seize();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 repayments;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pool) || logs[i].topics[0] != REPAID) continue;
            (uint256 gotFees, uint256 reservePart, uint256 principalPart) =
                abi.decode(logs[i].data, (uint256, uint256, uint256));
            assertEq(gotFees, fees);
            assertEq(reservePart, base / 10_000);
            assertEq(principalPart, paidPrincipal);
            ++repayments;
        }
        assertEq(repayments, 1);
        assertTrue(a.closed());
        assertEq(pool.loanPrincipalOf(address(a)), 0);
        assertEq(pool.reserveBaseOf(address(a)), 0);
    }

    function test_R4_04_seizeFeeOnlyUsesStoredBase() public {
        _seizePayment(false);
    }

    function test_R4_04_seizePartialPrincipalUsesStoredBase() public {
        _seizePayment(true);
    }
}
