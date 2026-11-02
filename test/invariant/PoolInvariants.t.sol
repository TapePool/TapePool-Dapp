// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/console.sol";
import {Base} from "../unit/Base.t.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {PoolHandler, RedeployHandler} from "./PoolHandler.sol";

/// Stateful invariants for the pool, the agent factory and the agents (SPEC §15), on the mocks.
/// `PoolHandler` drives lenders, borrowers, the keeper, the owner and the guardian in any order;
/// these functions check the books after every call. Invariants that depend on how a call ended
/// (exits never blocked, BEM never stranded or misdirected, the share price never falling, brakes
/// holding, the impairment lifecycle against its model) are checked inside the handler and summed up
/// by `_handlerClean`.
///
/// Campaign size comes from `[invariant]` in foundry.toml (64 runs x 200 calls). For a deeper pass
/// before a deploy: `FOUNDRY_INVARIANT_RUNS=256 FOUNDRY_INVARIANT_DEPTH=250 forge test --match-path
/// "test/invariant/*" --match-test invariant_`.
///
/// Not covered here, on purpose:
/// - invariant 9 (the policy netlist is checked against `PolicyV1.expected` in its own tests);
/// - invariant 10 (checks, effects, interactions: it needs a re-entering voucher mock);
/// - the 16-voucher collateral cap (`CollateralFull`, unit-tested in RigAgent.t.sol; this handler has 8 rigs);
/// - timelock edges (a queued change executed after its grace, a lapsed policy swap, `cancelParam`);
/// - ERC-4626 calls with a receiver or owner other than the caller (the allowance path);
/// - the real credit circuit (the policy adapter has its own tests; here the policy is a mock).
contract PoolInvariants is Base {
    PoolHandler internal handler;

    function setUp() public override {
        super.setUp();
        _deposit(lp, 10 * BEM);
        handler = new PoolHandler(bem, voucher, feed, factory, pool, owner, guardian);

        bytes4[] memory s = new bytes4[](38);
        uint256 i;
        s[i++] = PoolHandler.deposit.selector;
        s[i++] = PoolHandler.mint.selector;
        s[i++] = PoolHandler.withdraw.selector;
        s[i++] = PoolHandler.redeem.selector;
        s[i++] = PoolHandler.roundTrip.selector;
        s[i++] = PoolHandler.donate.selector;
        s[i++] = PoolHandler.newRig.selector;
        s[i++] = PoolHandler.makeAgent.selector;
        s[i++] = PoolHandler.bootstrap.selector;
        s[i++] = PoolHandler.pledge.selector;
        s[i++] = PoolHandler.plainSendAndRegister.selector;
        s[i++] = PoolHandler.strangerSend.selector;
        s[i++] = PoolHandler.release.selector;
        s[i++] = PoolHandler.withdrawVoucher.selector;
        s[i++] = PoolHandler.borrow.selector;
        s[i++] = PoolHandler.harvest.selector;
        s[i++] = PoolHandler.sweep.selector;
        s[i++] = PoolHandler.repay.selector;
        s[i++] = PoolHandler.claimLate.selector;
        s[i++] = PoolHandler.impair.selector;
        s[i++] = PoolHandler.flagImpaired.selector;
        s[i++] = PoolHandler.clearExpiredFlag.selector;
        s[i++] = PoolHandler.warpToSeizeWindow.selector;
        s[i++] = PoolHandler.seize.selector;
        s[i++] = PoolHandler.seizeJustBefore.selector;
        s[i++] = PoolHandler.forwardVouchers.selector;
        s[i++] = PoolHandler.breakVoucher.selector;
        s[i++] = PoolHandler.breakInputs.selector;
        s[i++] = PoolHandler.strangerPool.selector;
        s[i++] = PoolHandler.poolLendUnderBrake.selector;
        s[i++] = PoolHandler.adminStep.selector;
        s[i++] = PoolHandler.driveToSeize.selector;
        s[i++] = PoolHandler.healAndExpire.selector;
        s[i++] = PoolHandler.reviveReport.selector;
        s[i++] = PoolHandler.misreport.selector;
        s[i++] = PoolHandler.safeMove.selector;
        s[i++] = PoolHandler.withdrawSeized.selector;
        s[i++] = PoolHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: s}));
        // Only the handler is fuzzed. Agents and policies are created while the fuzzer runs, so they
        // cannot be excluded by address; naming the target keeps them out of the target set.
        targetContract(address(handler));
    }

    // ───────────────────────── books (invariants 1, 2, 3)

    function _books() internal view {
        uint256 bal = bem.balanceOf(address(pool));
        assertGe(bal, pool.reserve(), "pool BEM is below the loss reserve");
        assertLe(pool.tracked(), bal, "tracked exceeds pool BEM");
        assertEq(pool.idle() + pool.reserve(), pool.tracked(), "idle + reserve != tracked");
        assertLe(pool.unvestedNow(), pool.idle() + pool.outstandingPrincipal() - pool.doubtful());
        assertEq(
            pool.totalAssets(),
            pool.idle() + pool.outstandingPrincipal() - pool.doubtful() - pool.unvestedNow(),
            "totalAssets mismatch"
        );
        assertLe(pool.doubtful(), pool.outstandingPrincipal(), "doubtful above outstanding");

        uint256 sumPrincipal;
        uint256 sumDoubtful;
        uint256 n = handler.agentCount();
        for (uint256 i; i < n; ++i) {
            RigAgent a = handler.agentAt(i);
            RigAgent.LoanView memory v = a.loanOf();
            uint256 poolSide = pool.loanPrincipalOf(address(a));
            uint256 dbt = pool.doubtfulOf(address(a));
            if (v.open) {
                assertEq(poolSide, v.principal, "pool and agent disagree on remaining principal");
                assertEq(dbt, v.doubtful ? v.principal : 0, "doubtful is not the flagged remaining principal");
            } else {
                assertEq(poolSide, 0, "pool carries principal for an agent with no loan");
                assertEq(dbt, 0, "pool carries doubtful for an agent with no loan");
            }
            sumPrincipal += poolSide;
            sumDoubtful += dbt;
        }
        assertEq(pool.outstandingPrincipal(), sumPrincipal, "outstanding != sum of open loans");
        assertEq(pool.doubtful(), sumDoubtful, "doubtful != sum of doubtfulOf");

        for (uint256 b; b < handler.borrowerCount(); ++b) {
            address borrower = handler.borrowerAt(b);
            uint256 sum;
            for (uint256 i; i < n; ++i) {
                RigAgent a = handler.agentAt(i);
                if (a.borrower() == borrower) sum += pool.loanPrincipalOf(address(a));
            }
            assertEq(pool.principalOf(borrower), sum, "principalOf != sum over the borrower's agents");
        }
    }

    // ───────────────────────── vouchers (invariants 4 and 21)

    function _collateral() internal view {
        uint256 n = handler.agentCount();
        address safeHolder = handler.safeHolder();
        for (uint256 i; i < n; ++i) {
            RigAgent a = handler.agentAt(i);
            uint256[] memory ids = a.collateralOf();
            assertLe(ids.length, a.MAX_COLLATERAL(), "collateral above the cap");
            if (a.hasLoan()) assertGt(ids.length, 0, "an open loan with no collateral");
            for (uint256 j; j < ids.length; ++j) {
                if (j != 0) assertGt(ids[j], ids[j - 1], "collateral not strictly ascending");
                address holder = voucher.ownerOf(ids[j]);
                if (a.closed()) {
                    // amended invariant 4 (R3-02): a closed agent keeps an id listed until the pool holds
                    // it, also while the Safe has moved it to a third party
                    assertTrue(
                        holder == address(a) || holder == safeHolder || holder == address(pool),
                        "a closed agent lists a voucher held by its borrower or a stranger"
                    );
                } else if (!handler.lied()) {
                    // not after a lying voucher: it lets the hook list a token that never moved
                    assertEq(holder, address(a), "collateral voucher not held by its agent");
                }
            }
        }
        for (uint256 k; k < handler.touchedCount(); ++k) {
            address holder = voucher.ownerOf(handler.touchedAt(k));
            bool known = holder == address(pool) || factory.isAgent(holder) || holder == safeHolder;
            for (uint256 b; b < handler.borrowerCount() && !known; ++b) {
                known = holder == handler.borrowerAt(b);
            }
            assertTrue(known, "a voucher sits somewhere other than an agent, a borrower, the pool or the Safe's holder");
        }
        // invariant 21 (R3-02): no voucher that was collateral at a seize is held by that agent's borrower
        for (uint256 k; k < handler.seizedCount(); ++k) {
            (RigAgent a, uint256 id) = handler.seizedAt(k);
            assertTrue(voucher.ownerOf(id) != a.borrower(), "a seized voucher went back to its borrower");
        }
    }

    // ───────────────────────── brakes (invariants 13, 15)

    function _brakes() internal view {
        if (pool.policySwapQueued()) assertTrue(pool.borrowsPaused(), "swap queued but borrows not paused");
        if (pool.doubtful() != 0) {
            assertEq(pool.maxDeposit(lp), 0, "deposits open while a loan is doubtful");
            assertEq(pool.maxMint(lp), 0, "mints open while a loan is doubtful");
        }
        assertLe(pool.reserve(), bem.balanceOf(address(pool)), "reserve above pool BEM");
    }

    /// Everything the handler checks while it acts (invariants 5, 6, 7, 8, 11, 12, 14, 15, 16).
    function _handlerClean() internal view {
        assertEq(handler.violations(), 0, handler.firstViolation());
    }

    /// One invariant, so the whole campaign runs once instead of once per check.
    function invariant_poolAndAgents() public view {
        _handlerClean();
        _books();
        _collateral();
        _brakes();
        _allowances();
    }

    /// Q11: `_waterfall` approves exactly what the pool pulls, so no agent leaves an allowance behind.
    function _allowances() internal view {
        for (uint256 i; i < handler.agentCount(); ++i) {
            address a = address(handler.agentAt(i));
            assertEq(bem.allowance(a, address(pool)), 0, "an agent left a BEM allowance to the pool");
        }
    }

    function afterInvariant() public view {
        for (uint256 i; i < handler.hitLabelCount(); ++i) {
            string memory label = handler.hitLabelAt(i);
            console.log(label, handler.hitsOf(label));
        }
    }

    // ───────────────────────── scripted paths: the handler really reaches these
    // Seeds: `borrow(a, 2, 0)` is a 7-day term at the minimum advance. An odd seed on an evidence action
    // posts fresh reports first (`_maybeRefresh`); a seed divisible by four leaves them as they are.

    function _openAgent() internal returns (RigAgent a) {
        handler.newRig(0, 0, 100); // rig 1 for borrower 0
        handler.makeAgent(0, 0);
        handler.pledge(0, 0);
        a = handler.agentAt(0);
    }

    function _seedLoan() internal returns (RigAgent a) {
        a = _openAgent();
        handler.borrow(0, 2, 0);
        assertTrue(a.hasLoan(), "scripted borrow did not open a loan");
    }

    function _flagged() internal returns (RigAgent a) {
        a = _seedLoan();
        handler.setHealth(0, 3); // rig 1 is rescued
        handler.flagImpaired(1, 0);
        assertGt(pool.doubtful(), 0, "flag did not mark the loan doubtful");
    }

    function _clean() internal view {
        assertEq(handler.violations(), 0, handler.firstViolation());
    }

    function test_scriptedRepayCloses() public {
        RigAgent a = _seedLoan();
        handler.harvest(0, 4 * BEM);
        handler.sweep(0);
        assertFalse(a.hasLoan(), "a full sweep did not close the loan");
        assertEq(pool.outstandingPrincipal(), 0);
        _clean();
    }

    function test_scriptedSeizeWritesOff() public {
        RigAgent a = _flagged();
        assertEq(pool.maxDeposit(lp), 0, "deposits stay open while doubtful");
        handler.warpToSeizeWindow(0);
        handler.seize(1);
        assertTrue(a.closed(), "scripted seize did not close the agent");
        assertEq(pool.doubtful(), 0);
        assertEq(pool.outstandingPrincipal(), 0);
        assertEq(voucher.ownerOf(1), address(pool), "the voucher did not reach the pool");
        _clean();
    }

    function test_scriptedHealthyRigIsNotFlagged() public {
        _seedLoan();
        handler.flagImpaired(1, 0);
        handler.seize(1);
        assertEq(pool.doubtful(), 0, "a healthy rig was flagged");
        _clean();
    }

    function test_scriptedNoSeizeInsideTheCureWindow() public {
        RigAgent a = _flagged();
        handler.seize(1);
        assertFalse(a.closed(), "seized inside the cure window");
        _clean();
    }

    function test_scriptedSkewedReportsDoNotOpenTheCureWindow() public {
        RigAgent a = _flagged();
        handler.seizeJustBefore(0, 30); // reports stamped 60 s ahead, 30 s before the window opens
        assertFalse(a.closed(), "a skewed report opened the cure window early");
        _clean();
    }

    function test_scriptedSeizeMovesEveryVoucher() public {
        handler.newRig(0, 0, 100); // rig 1
        handler.newRig(0, 1, 100); // rig 2, same borrower
        handler.makeAgent(0, 0);
        handler.pledge(0, 0);
        handler.pledge(0, 0); // the second call finds the borrower's remaining rig
        RigAgent a = handler.agentAt(0);
        assertEq(a.collateralOf().length, 2, "two rigs should be pledged");
        handler.borrow(0, 2, 0);
        assertTrue(a.hasLoan());
        handler.setHealth(0, 3); // one rig is rescued, which is enough to flag the loan
        handler.flagImpaired(1, 0);
        handler.warpToSeizeWindow(0);
        handler.seize(1);
        assertTrue(a.closed(), "the seize did not close the agent");
        assertEq(voucher.ownerOf(1), address(pool));
        assertEq(voucher.ownerOf(2), address(pool), "the healthy rig must follow the impaired one to the pool");
        assertEq(a.collateralOf().length, 0);
        _clean();
    }

    function test_scriptedOperatingFeeChangesAreFollowed() public {
        handler.queueAndExecuteParam(23, 0.01 ether); // key 11, OpsFee7d
        assertEq(pool.opsFee(0), 0.01 ether, "the operating fee was not changed");
        _seedLoan(); // the handler pays the pool's current fee, and the owner must receive exactly that
        _clean();
    }

    function test_scriptedReserveCapHolds() public {
        handler.queueAndExecuteParam(21, 0); // key 10, ReserveCapBps = 0: the reserve may not grow
        assertEq(pool.reserveCapBps(), 0);
        _seedLoan();
        handler.harvest(0, 4 * BEM);
        handler.sweep(0);
        assertEq(pool.reserve(), 0, "the reserve grew past its cap");
        _clean();
    }

    function test_scriptedExpiredFlagClearsOnHealth() public {
        RigAgent a = _flagged();
        handler.healAndExpire(1, false);
        assertEq(pool.doubtful(), 0, "an expired flag with health evidence stayed");
        assertTrue(a.hasLoan() && !a.closed(), "the loan should stay open");
        _clean();
    }

    function test_scriptedFlagNeverExpiresWithTheFeedOff() public {
        _flagged();
        handler.healAndExpire(1, true);
        assertGt(pool.doubtful(), 0, "a flag expired while the feed was off");
        _clean();
    }

    function test_scriptedStaleHealthDoesNotClearAFlag() public {
        _flagged();
        handler.healAndExpire(4, false); // seed divisible by four: no fresh reports before the call
        assertGt(pool.doubtful(), 0, "stale reports cleared a flag");
        _clean();
    }

    /// R3-04: a newer healthy report shields an older power-0 record; a tie does not.
    function test_scriptedNewerHealthyReportShieldsAnOlderPowerZeroRecord() public {
        _seedLoan();
        handler.setHealth(0, 4); // rig 1: a power-0 harvest, with a healthy report at the same second
        handler.warp(1);
        handler.reviveReport(0); // a newer healthy report, no new harvest
        handler.flagImpaired(0, 0); // a seed divisible by four keeps the reports as they are
        assertEq(pool.doubtful(), 0, "an older power-0 record flagged a rig a newer report shows healthy");
        handler.setHealth(0, 4); // a new power-0 harvest at the same second as its report: a tie
        handler.flagImpaired(0, 0);
        assertGt(pool.doubtful(), 0, "a tie does not shield");
        _clean();
    }

    /// R3-02: a seize while `ownerOf` misreports keeps the voucher listed; the borrower cannot take it,
    /// and a retry sends it to the pool once the reads are true again.
    function test_scriptedMisreportedSeizeKeepsTheVoucherFromTheBorrower() public {
        RigAgent a = _flagged();
        handler.misreport(0, 0, true, 3); // a zero holder read during the seize, a retry and a withdrawal
        assertTrue(a.closed(), "seized under the misreport");
        assertEq(voucher.ownerOf(1), address(a), "kept, not dropped");
        assertEq(a.collateralOf().length, 1);
        handler.withdrawSeized(0); // refused with SeizedVoucher, then a retry with true reads
        assertEq(voucher.ownerOf(1), address(pool));
        _clean();
    }

    /// R3-02: the Safe returns a seized voucher from the pool into the closed agent, then moves it to a
    /// third party and back. It never reaches the borrower.
    function test_scriptedSafeMovesOfASeizedVoucher() public {
        RigAgent a = _flagged();
        handler.warpToSeizeWindow(0);
        handler.seize(1);
        assertEq(voucher.ownerOf(1), address(pool));
        handler.safeMove(0); // pool -> closed agent
        assertEq(voucher.ownerOf(1), address(a));
        handler.withdrawSeized(0);
        assertEq(voucher.ownerOf(1), address(a), "unlisted and seized: it stays where the Safe put it");
        handler.safeMove(0); // closed agent -> third party
        assertEq(voucher.ownerOf(1), handler.safeHolder());
        handler.safeMove(0); // and back
        handler.withdrawSeized(0);
        assertEq(voucher.ownerOf(1), address(a));
        _clean();
    }

    function test_scriptedStuckVoucherIsForwardedLater() public {
        RigAgent a = _flagged();
        handler.warpToSeizeWindow(0);
        handler.breakVoucher(0, 0, true); // voucher 1 cannot move
        handler.seize(1);
        assertTrue(a.closed(), "a stuck voucher stopped the seize");
        assertEq(voucher.ownerOf(1), address(a), "the stuck voucher should still be in the agent");
        handler.breakVoucher(1, 0, false); // heal
        handler.forwardVouchers(0);
        assertEq(voucher.ownerOf(1), address(pool), "the voucher was not forwarded");
        _clean();
    }

    function test_scriptedBrakesDoNotBlockExits() public {
        RigAgent a = _seedLoan();
        handler.deposit(0, BEM);
        handler.guardianPause();
        handler.guardianDisableFeed();
        handler.ownerQueuePolicy();
        handler.harvest(0, 4 * BEM);
        handler.sweep(0);
        handler.claimLate(0);
        handler.withdraw(0, 1);
        assertFalse(a.hasLoan());
        handler.poolLendUnderBrake(0);
        handler.release(0);
        _clean();
    }

    function test_scriptedStrangersCannotUseThePool() public {
        _seedLoan();
        for (uint256 k; k < 10; ++k) {
            handler.strangerPool(k);
        }
        _clean();
    }

    function test_scriptedPolicyAnswersFailClosed() public {
        RigAgent a = _openAgent();
        handler.breakInputs(11); // the policy denies everything
        handler.borrow(0, 4, 0); // a term seed divisible by four does not heal the inputs first
        assertFalse(a.hasLoan(), "a denying policy let a borrow through");
        handler.breakInputs(13); // the feed is down
        handler.borrow(0, 4, 0);
        assertFalse(a.hasLoan(), "a dead feed let a borrow through");
        handler.breakInputs(0); // everything healthy again
        handler.borrow(0, 2, 0);
        assertTrue(a.hasLoan(), "a healthy policy and feed did not allow the borrow");
        _clean();
    }

    function test_scriptedParamAndPolicySwapsApply() public {
        handler.queueAndExecuteParam(8, 30); // LateFeeBpsPerDay
        assertEq(pool.lateFeeBpsPerDay(), 30, "the queued parameter was not applied");
        address before = address(pool.policy());
        handler.queueAndActivatePolicy();
        assertTrue(address(pool.policy()) != before, "the queued policy was not installed");
        assertTrue(pool.borrowsPaused(), "a policy swap must leave borrows paused");
        _clean();
    }

    function test_scriptedLateFeeAccruesAndIsPaidFirst() public {
        handler.queueAndExecuteParam(8, 30);
        RigAgent a = _seedLoan();
        handler.warp(6 days);
        handler.warp(6 days); // past the 7-day maturity
        assertGt(a.loanOf().lateFeeDue, 0, "no late fee accrued after maturity");
        handler.harvest(0, 4 * BEM);
        handler.sweep(0);
        assertFalse(a.hasLoan(), "the sweep did not clear the late debt");
        _clean();
    }
}

/// Separate accounting campaign: every book and admission is compared with an independent model.
contract RedeployInvariants is Base {
    RedeployHandler internal model;

    function setUp() public override {
        super.setUp();
        _deposit(address(0xdead), BEM / 100);
        _deposit(lp, 10 * BEM);
        model = new RedeployHandler(pool, bem, factory, owner, guardian, lp);
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = RedeployHandler.income.selector;
        selectors[1] = RedeployHandler.liquidity.selector;
        selectors[2] = RedeployHandler.lend.selector;
        selectors[3] = RedeployHandler.repay.selector;
        selectors[4] = RedeployHandler.loss.selector;
        selectors[5] = RedeployHandler.parameter.selector;
        selectors[6] = RedeployHandler.brake.selector;
        selectors[7] = RedeployHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(model), selectors: selectors}));
        targetContract(address(model));
    }

    function invariant_redeployBooksAndClocks() public view {
        model.check();
    }

    function test_independentModelExercisesLossRecoveryAndBrakes() public {
        model.lend(0, 2 * BEM);
        model.income(2 * BEM, true);
        model.loss(0, 0);
        model.repay(0, 10_000, BEM);
        model.loss(0, 1);
        model.brake();
        model.warp(1 days);
        model.brake();
        model.warp(2 days);
        model.loss(0, 0);
        model.loss(0, 2);
        model.check();
    }
}
