// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IRigVoucher} from "../../src/interfaces/IXLayer.sol";
import {ICreditPolicy} from "../../src/interfaces/ICreditPolicy.sol";
import {TapePool} from "../../src/TapePool.sol";
import {AgentFactory} from "../../src/AgentFactory.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {MockBEM, MockVoucher, MockCreditPolicy} from "../mocks/Mocks.sol";

contract TapePoolTest is Base {
    event ParamQueued(TapePool.Param indexed key, uint256 value, uint64 eta);
    event ParamCancelled(TapePool.Param indexed key);
    event ParamLapsed(TapePool.Param indexed key);
    event PolicyQueued(address indexed policy, uint64 eta);
    event PolicyCancelled(address indexed policy);
    event PolicyLapsed(address indexed policy);
    event BorrowsPaused(address indexed by);

    // ───────────────────────── deployment

    function test_launch_values() public view {
        assertEq(pool.name(), "Tape Pool BEM");
        assertEq(pool.symbol(), "tpBEM");
        assertEq(pool.decimals(), 14, "8 + offset 6");
        assertEq(pool.asset(), address(bem));
        assertEq(address(pool.factory()), address(factory));
        assertEq(address(pool.policy()), address(policy));
        assertEq(pool.owner(), owner);
        assertEq(pool.guardian(), guardian);
        assertEq(pool.supplyCap(), 20 * BEM);
        assertEq(pool.borrowCapAbs(), 8 * BEM);
        assertEq(pool.borrowCapBps(), 7_000);
        assertEq(pool.perBorrowerBps(), 4_000);
        assertEq(pool.feeBps7d(), 25);
        assertEq(pool.feeBps14d(), 50);
        assertEq(pool.minFee(), 100_000);
        assertEq(pool.minAdvance(), 1_000_000);
        assertEq(pool.lateFeeBpsPerDay(), 0);
        assertEq(pool.reserveShareBps(), 2_000);
        assertEq(pool.reserveCapBps(), 500);
        assertFalse(pool.borrowsPaused());
        assertFalse(pool.feedDisabled());
    }

    function test_launch_values_are_within_bounds() public view {
        for (uint256 k; k <= uint256(TapePool.Param.PerBorrowerAbs); ++k) {
            TapePool.Param key = TapePool.Param(k);
            (uint256 lo, uint256 hi) = pool.bounds(key);
            uint256 v = pool.param(key);
            assertTrue(v >= lo && v <= hi, "launch value in bounds");
        }
    }

    function test_constructor_rejects_wrong_pool_prediction() public {
        AgentFactory f = new AgentFactory(address(0xDEAD), IRigVoucher(address(voucher)), IERC20(address(bem)), feed);
        vm.expectRevert(TapePool.FactoryMismatch.selector);
        new TapePool(IERC20(address(bem)), f, policy, owner, guardian, lp);
    }

    function test_constructor_rejects_other_asset() public {
        MockBEM other = new MockBEM();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        AgentFactory f = new AgentFactory(predicted, IRigVoucher(address(voucher)), IERC20(address(bem)), feed);
        vm.expectRevert(TapePool.AssetMismatch.selector);
        new TapePool(IERC20(address(other)), f, policy, owner, guardian, lp);
    }

    function test_factory_rejects_bem_the_voucher_does_not_pay() public {
        MockBEM other = new MockBEM();
        vm.expectRevert(AgentFactory.BemMismatch.selector);
        new AgentFactory(address(1), IRigVoucher(address(voucher)), IERC20(address(other)), feed);
    }

    function test_constructor_rejects_bad_initial_policy() public {
        MockCreditPolicy p = new MockCreditPolicy(feed, 1);
        p.setMode(MockCreditPolicy.Mode.RevertCheck);
        _expectBadDeploy(ICreditPolicy(address(p)));
        p.setMode(MockCreditPolicy.Mode.AllowEmpty);
        _expectBadDeploy(ICreditPolicy(address(p)));
        _expectBadDeploy(ICreditPolicy(makeAddr("eoa")));
    }

    function _expectBadDeploy(ICreditPolicy p) internal {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        AgentFactory f = new AgentFactory(predicted, IRigVoucher(address(voucher)), IERC20(address(bem)), feed);
        vm.expectRevert(TapePool.BadPolicy.selector);
        new TapePool(IERC20(address(bem)), f, p, owner, guardian, lp);
    }

    // ───────────────────────── deposits and withdrawals

    function test_deposit_up_to_supply_cap() public {
        assertEq(pool.maxDeposit(lp), 20 * BEM);
        _deposit(lp, 15 * BEM);
        assertEq(pool.maxDeposit(lp), 5 * BEM);
        assertEq(pool.maxMint(lp), pool.previewDeposit(5 * BEM));
        bem.mint(lp, 6 * BEM);
        vm.startPrank(lp);
        bem.approve(address(pool), 6 * BEM);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, lp, 6 * BEM, 5 * BEM));
        pool.deposit(6 * BEM, lp);
        uint256 maxShares = pool.maxMint(lp);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxMint.selector, lp, maxShares + 1, maxShares));
        pool.mint(maxShares + 1, lp);
        pool.mint(maxShares, lp);
        vm.stopPrank();
        assertEq(pool.totalAssets(), 20 * BEM);
        assertEq(pool.maxDeposit(lp), 0);
    }

    function test_withdraw_capped_to_idle() public {
        _queueExecute(TapePool.Param.PerBorrowerAbs, 8 * BEM);
        _deposit(lp, 20 * BEM);
        RigAgent a = _agent(alice, 0);
        vm.prank(address(a));
        pool.lend(8 * BEM);
        assertEq(pool.totalAssets(), 20 * BEM, "lending does not move the share price");
        assertEq(pool.idle(), 12 * BEM);
        assertEq(pool.maxWithdraw(lp), 12 * BEM);
        assertEq(pool.maxRedeem(lp), pool.convertToShares(12 * BEM));
        vm.startPrank(lp);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, lp, 13 * BEM, 12 * BEM));
        pool.withdraw(13 * BEM, lp, lp);
        pool.redeem(pool.maxRedeem(lp), lp, lp);
        vm.stopPrank();
        assertLe(pool.idle(), 1, "idle drained up to rounding");
    }

    // ───────────────────────── fee

    function test_fee_term_rates_and_minimum() public view {
        assertEq(pool.fee(0, 1 * BEM), 250_000, "0.25%");
        assertEq(pool.fee(1, 1 * BEM), 500_000, "0.5%");
        assertEq(pool.fee(0, 1_000_000), 100_000, "min fee on 0.01 BEM");
        assertEq(pool.fee(0, 40_000_000), 100_000, "exactly the min at 0.4 BEM");
        assertEq(pool.fee(0, 40_000_001), 100_001, "rate rounds up");
        assertEq(pool.fee(1, 20_000_001), 100_001);
    }

    function test_fee_rejects_other_terms() public {
        vm.expectRevert(abi.encodeWithSelector(TapePool.BadTerm.selector, 2));
        pool.fee(2, BEM);
        vm.expectRevert(abi.encodeWithSelector(TapePool.BadTerm.selector, 3));
        pool.fee(3, BEM);
    }

    function testFuzz_fee_rounds_up_and_respects_minimum(uint8 term, uint256 principal) public view {
        term = uint8(bound(term, 0, 1));
        principal = bound(principal, 0, 1_000_000 * BEM);
        uint256 bps = term == 0 ? 25 : 50;
        uint256 f = pool.fee(term, principal);
        assertGe(f, pool.minFee());
        assertGe(f * 10_000, principal * bps, "never below the rate");
        if (f > pool.minFee()) assertLt((f - 1) * 10_000, principal * bps, "rounds up by less than 1");
    }

    // ───────────────────────── agent-only entry points

    function test_agent_only_entry_points() public {
        vm.startPrank(alice);
        vm.expectRevert(TapePool.NotAgent.selector);
        pool.lend(BEM);
        vm.expectRevert(TapePool.NotAgent.selector);
        pool.repay(1, 1);
        vm.expectRevert(TapePool.NotAgent.selector);
        pool.markDoubtful();
        vm.expectRevert(TapePool.NotAgent.selector);
        pool.clearDoubtful();
        vm.expectRevert(TapePool.NotAgent.selector);
        pool.writeOff();
        vm.stopPrank();
    }

    function test_lend_pays_the_borrower_and_books() public {
        _deposit(lp, 20 * BEM);
        RigAgent a = _agent(alice, 0);
        vm.prank(address(a));
        pool.lend(3 * BEM);
        assertEq(bem.balanceOf(alice), 3 * BEM, "proceeds to the borrower");
        assertEq(bem.balanceOf(address(a)), 0, "never to the agent");
        assertEq(pool.outstandingPrincipal(), 3 * BEM);
        assertEq(pool.principalOf(alice), 3 * BEM);
        assertEq(pool.loanPrincipalOf(address(a)), 3 * BEM);
        assertEq(pool.totalAssets(), 20 * BEM);
    }

    function test_lend_borrow_cap_absolute() public {
        _queueExecute(TapePool.Param.BorrowCapAbs, 10 * BEM);
        _queueExecute(TapePool.Param.PerBorrowerAbs, 8 * BEM);
        _deposit(lp, 20 * BEM);
        RigAgent a = _agent(alice, 0);
        RigAgent b = _agent(bob, 0);
        RigAgent c = _agent(keeper, 0);
        vm.prank(address(a));
        pool.lend(8 * BEM);
        vm.prank(address(b));
        pool.lend(2 * BEM);
        assertEq(pool.maxLend(keeper), 0, "10 BEM absolute cap reached");
        vm.prank(address(c));
        vm.expectRevert(TapePool.ExceedsBorrowCap.selector);
        pool.lend(1);
    }

    function test_lend_borrow_cap_share_of_assets() public {
        _deposit(lp, 10 * BEM);
        RigAgent a = _agent(alice, 0);
        RigAgent b = _agent(bob, 0);
        vm.prank(address(a));
        pool.lend(4 * BEM);
        vm.prank(address(b));
        pool.lend(3 * BEM);
        assertEq(pool.maxLend(keeper), 0, "70% of 10 BEM reached");
        vm.prank(address(b));
        vm.expectRevert(TapePool.ExceedsBorrowCap.selector);
        pool.lend(1);
    }

    function test_lend_per_borrower_cap_sums_agents() public {
        _queueExecute(TapePool.Param.BorrowCapAbs, 10 * BEM);
        _queueExecute(TapePool.Param.PerBorrowerAbs, 8 * BEM);
        _deposit(lp, 20 * BEM);
        RigAgent a0 = _agent(alice, 0);
        RigAgent a1 = _agent(alice, 1);
        vm.prank(address(a0));
        pool.lend(5 * BEM);
        assertEq(pool.maxLend(alice), 3 * BEM, "40% of 20 BEM, less 5");
        vm.prank(address(a1));
        vm.expectRevert(TapePool.ExceedsBorrowerCap.selector);
        pool.lend(3 * BEM + 1);
        vm.prank(address(a1));
        pool.lend(3 * BEM);
        assertEq(pool.principalOf(alice), 8 * BEM);
    }

    /// `lend(p)` succeeds exactly when `p <= maxLend(borrower)`, and afterwards every cap still holds.
    function testFuzz_lend_respects_every_cap(uint256 dep, uint256 p1, uint256 p2, uint256 p3) public {
        dep = bound(dep, 1, 20 * BEM);
        _deposit(lp, dep);
        RigAgent a0 = _agent(alice, 0);
        RigAgent a1 = _agent(alice, 1);
        RigAgent b0 = _agent(bob, 0);
        _tryLend(a0, alice, bound(p1, 1, 20 * BEM));
        _tryLend(a1, alice, bound(p2, 1, 20 * BEM));
        _tryLend(b0, bob, bound(p3, 1, 20 * BEM));
        uint256 ta = pool.totalAssets();
        assertEq(ta, dep, "lending never moves the share price");
        uint256 cap = pool.borrowCapAbs() < ta * 7_000 / 10_000 ? pool.borrowCapAbs() : ta * 7_000 / 10_000;
        assertLe(pool.outstandingPrincipal(), cap, "borrow cap");
        assertLe(pool.principalOf(alice), ta * 4_000 / 10_000, "per-borrower cap, summed over agents");
        assertLe(pool.principalOf(bob), ta * 4_000 / 10_000, "per-borrower cap");
        assertEq(pool.outstandingPrincipal(), pool.principalOf(alice) + pool.principalOf(bob));
    }

    function _tryLend(RigAgent a, address borrower, uint256 p) internal {
        bool fits = p <= pool.maxLend(borrower);
        vm.prank(address(a));
        (bool ok,) = address(pool).call(abi.encodeCall(TapePool.lend, (p)));
        assertEq(ok, fits, "lend succeeds exactly within maxLend");
    }

    function test_lend_blocked_by_brakes() public {
        _deposit(lp, 20 * BEM);
        RigAgent a = _agent(alice, 0);
        vm.prank(guardian);
        pool.pauseBorrows();
        assertEq(pool.maxLend(alice), 0);
        vm.prank(address(a));
        vm.expectRevert(TapePool.BorrowsArePaused.selector);
        pool.lend(BEM);
        vm.prank(owner);
        pool.unpauseBorrows();
        vm.prank(guardian);
        pool.disableFeed();
        assertEq(pool.maxLend(alice), 0);
        vm.prank(address(a));
        vm.expectRevert(TapePool.FeedIsDisabled.selector);
        pool.lend(BEM);
    }

    function test_nothing_to_lend_from_an_empty_pool() public {
        RigAgent a = _agent(alice, 0);
        assertEq(pool.maxLend(alice), 0);
        vm.prank(address(a));
        vm.expectRevert(TapePool.ExceedsIdle.selector);
        pool.lend(1);
    }

    // ───────────────────────── repayments, reserve, write-off

    function _lent(address borrower, uint256 amount) internal returns (RigAgent a) {
        if (amount > pool.perBorrowerAbs()) _queueExecute(TapePool.Param.PerBorrowerAbs, amount);
        a = _agent(borrower, 0);
        vm.prank(address(a));
        pool.lend(amount);
    }

    function _agentPays(RigAgent a, uint256 feePart, uint256 principalPart) internal {
        bem.mint(address(a), feePart + principalPart);
        vm.startPrank(address(a));
        bem.approve(address(pool), feePart + principalPart);
        pool.repay(feePart, principalPart);
        vm.stopPrank();
    }

    function test_repay_splits_fee_into_reserve_and_lenders() public {
        _deposit(lp, 20 * BEM);
        RigAgent a = _lent(alice, 5 * BEM);
        _agentPays(a, 1_000_000, 2 * BEM);
        assertEq(pool.reserve(), 200_000, "20% of the fee");
        assertEq(pool.totalAssets(), 20 * BEM, "income has not released in this block");
        assertEq(pool.unvestedNow(), 800_000);
        assertEq(pool.outstandingPrincipal(), 3 * BEM);
        assertEq(pool.principalOf(alice), 3 * BEM);
        assertEq(pool.loanPrincipalOf(address(a)), 3 * BEM);
        assertEq(bem.balanceOf(address(pool)), 15 * BEM + 2 * BEM + 1_000_000);
        assertEq(pool.idle() + pool.reserve(), bem.balanceOf(address(pool)), "invariant 1");
    }

    function test_reserve_cap_is_measured_before_the_payment() public {
        _deposit(lp, 20 * BEM);
        _queueExecute(TapePool.Param.ReserveCapBps, 1); // 0.01% of 20 BEM = 200,000 raw
        RigAgent a = _lent(alice, 5 * BEM);
        _agentPays(a, 3_000_000, 0);
        assertEq(pool.reserve(), 200_000, "capped at 0.01% of the assets before this payment");
        vm.warp(pool.vestEnd());
        _agentPays(a, 3_000_000, 0);
        assertEq(pool.reserve(), 200_280, "room grew only by 0.01% of the fee lenders kept");
    }

    function test_repay_more_principal_than_lent_reverts() public {
        _deposit(lp, 20 * BEM);
        RigAgent a = _lent(alice, 1 * BEM);
        bem.mint(address(a), 2 * BEM);
        vm.startPrank(address(a));
        bem.approve(address(pool), 2 * BEM);
        vm.expectRevert(TapePool.RepayExceedsPrincipal.selector);
        pool.repay(0, 1 * BEM + 1);
        vm.stopPrank();
    }

    function test_reserve_is_never_withdrawable() public {
        _deposit(lp, 20 * BEM);
        RigAgent a = _lent(alice, 5 * BEM);
        _agentPays(a, 1_000_000, 5 * BEM);
        vm.warp(pool.vestEnd());
        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        uint256 out = pool.redeem(shares, lp, lp);
        assertApproxEqAbs(out, 20 * BEM + 800_000, 1);
        assertEq(bem.balanceOf(address(pool)) - pool.reserve(), pool.idle());
        assertGe(bem.balanceOf(address(pool)), 200_000, "reserve stays");
    }

    function test_doubtful_mark_closes_deposits_and_lowers_price() public {
        _deposit(lp, 10 * BEM);
        RigAgent a = _lent(alice, 2 * BEM);
        vm.prank(address(a));
        pool.markDoubtful();
        assertEq(pool.doubtful(), 2 * BEM);
        assertEq(pool.doubtfulOf(address(a)), 2 * BEM);
        assertEq(pool.totalAssets(), 8 * BEM);
        assertEq(pool.maxDeposit(lp), 0);
        assertEq(pool.maxMint(lp), 0);
        bem.mint(lp, BEM);
        vm.startPrank(lp);
        bem.approve(address(pool), BEM);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, lp, BEM, 0));
        pool.deposit(BEM, lp);
        vm.stopPrank();
        // marking again sets the mark to the remaining principal, it does not add
        vm.prank(address(a));
        pool.markDoubtful();
        assertEq(pool.doubtful(), 2 * BEM);
        // principal that comes back raises the price as it lands
        _agentPays(a, 0, BEM);
        assertEq(pool.doubtful(), BEM);
        assertEq(pool.totalAssets(), 9 * BEM);
        vm.prank(address(a));
        pool.clearDoubtful();
        assertEq(pool.doubtful(), 0);
        assertEq(pool.totalAssets(), 10 * BEM);
        assertEq(pool.maxDeposit(lp), 10 * BEM);
    }

    function test_writeOff_uses_reserve_then_lenders() public {
        _deposit(lp, 20 * BEM);
        RigAgent a = _lent(alice, 5 * BEM);
        _agentPays(a, 1_000_000, 0); // reserve 200,000
        vm.prank(address(a));
        pool.markDoubtful();
        uint256 marked = pool.totalAssets();
        assertEq(marked, 15 * BEM + 800_000);
        vm.prank(address(a));
        uint256 lost = pool.writeOff();
        assertEq(lost, 5 * BEM);
        assertEq(pool.reserve(), 0);
        assertEq(pool.doubtful(), 0);
        assertEq(pool.outstandingPrincipal(), 0);
        assertEq(pool.principalOf(alice), 0);
        assertEq(pool.loanPrincipalOf(address(a)), 0);
        assertEq(pool.totalAssets(), marked + 200_000, "reserve cover lands in the price at seize");
    }

    // ───────────────────────── brakes and keys

    function test_brakes_guardian_and_owner_only() public {
        vm.startPrank(alice);
        vm.expectRevert(TapePool.NotGuardianOrOwner.selector);
        pool.pauseBorrows();
        vm.expectRevert(TapePool.NotGuardianOrOwner.selector);
        pool.disableFeed();
        vm.stopPrank();

        vm.prank(owner);
        pool.pauseBorrows();
        assertTrue(pool.borrowsPaused());
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        pool.unpauseBorrows();
        vm.prank(owner);
        pool.unpauseBorrows();
        assertFalse(pool.borrowsPaused());
    }

    function test_feed_switch() public {
        vm.prank(owner);
        vm.expectRevert(TapePool.FeedNotDisabled.selector);
        pool.enableFeed();
        vm.prank(guardian);
        pool.disableFeed();
        assertTrue(pool.feedDisabled());
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        pool.enableFeed();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(owner);
        pool.enableFeed();
        assertFalse(pool.feedDisabled());
        assertEq(pool.frozenClock(), 1 hours);
    }

    function test_setGuardian_rotates_the_brake_key() public {
        address fresh = makeAddr("fresh");
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        pool.setGuardian(fresh);
        vm.prank(owner);
        pool.setGuardian(fresh);
        vm.prank(guardian);
        vm.expectRevert(TapePool.NotGuardianOrOwner.selector);
        pool.pauseBorrows();
        vm.prank(fresh);
        pool.pauseBorrows();
    }

    function test_renounce_disabled_and_transfer_two_step() public {
        vm.prank(owner);
        vm.expectRevert(TapePool.RenounceDisabled.selector);
        pool.renounceOwnership();
        address next = makeAddr("next");
        vm.prank(owner);
        pool.transferOwnership(next);
        assertEq(pool.owner(), owner, "not before accept");
        vm.prank(next);
        pool.acceptOwnership();
        assertEq(pool.owner(), next);
    }

    // ───────────────────────── parameter queue

    function test_queue_execute_cancel() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.queueParam(TapePool.Param.LateFeeBpsPerDay, 10);

        uint64 eta = uint64(block.timestamp + 48 hours);
        vm.expectEmit(address(pool));
        emit ParamQueued(TapePool.Param.LateFeeBpsPerDay, 10, eta);
        vm.prank(owner);
        pool.queueParam(TapePool.Param.LateFeeBpsPerDay, 10);

        vm.warp(eta - 1);
        vm.expectRevert(TapePool.TooEarly.selector);
        pool.executeParam(TapePool.Param.LateFeeBpsPerDay);
        vm.warp(eta);
        vm.prank(alice); // anyone executes
        pool.executeParam(TapePool.Param.LateFeeBpsPerDay);
        assertEq(pool.lateFeeBpsPerDay(), 10);
        vm.expectRevert(TapePool.NothingQueued.selector);
        pool.executeParam(TapePool.Param.LateFeeBpsPerDay);

        vm.prank(owner);
        pool.queueParam(TapePool.Param.MinFee, 500_000);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.cancelParam(TapePool.Param.MinFee);
        vm.prank(owner);
        pool.cancelParam(TapePool.Param.MinFee);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(TapePool.NothingQueued.selector);
        pool.executeParam(TapePool.Param.MinFee);
        assertEq(pool.minFee(), 100_000);
    }

    function test_queue_lapses_after_grace() public {
        vm.prank(owner);
        pool.queueParam(TapePool.Param.FeeBps7d, 100);
        (, uint64 eta) = pool.queued(TapePool.Param.FeeBps7d);
        vm.warp(uint256(eta) + 7 days + 1);
        vm.expectRevert(TapePool.QueueLapsed.selector);
        pool.executeParam(TapePool.Param.FeeBps7d);
        // a new queue on a lapsed slot reports the lapse, then queues
        vm.expectEmit(address(pool));
        emit ParamLapsed(TapePool.Param.FeeBps7d);
        vm.prank(owner);
        pool.queueParam(TapePool.Param.FeeBps7d, 120);
    }

    function test_queue_last_moment_of_grace_executes() public {
        vm.prank(owner);
        pool.queueParam(TapePool.Param.FeeBps7d, 100);
        (, uint64 eta) = pool.queued(TapePool.Param.FeeBps7d);
        vm.warp(uint256(eta) + 7 days);
        pool.executeParam(TapePool.Param.FeeBps7d);
        assertEq(pool.feeBps7d(), 100);
    }

    function test_requeue_overwrites_and_resets_eta() public {
        vm.prank(owner);
        pool.queueParam(TapePool.Param.SupplyCap, 30 * BEM);
        vm.warp(block.timestamp + 47 hours);
        vm.expectEmit(address(pool));
        emit ParamCancelled(TapePool.Param.SupplyCap);
        vm.expectEmit(address(pool));
        emit ParamQueued(TapePool.Param.SupplyCap, 25 * BEM, uint64(block.timestamp + 48 hours));
        vm.prank(owner);
        pool.queueParam(TapePool.Param.SupplyCap, 25 * BEM);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(TapePool.TooEarly.selector);
        pool.executeParam(TapePool.Param.SupplyCap);
        vm.warp(block.timestamp + 47 hours);
        pool.executeParam(TapePool.Param.SupplyCap);
        assertEq(pool.supplyCap(), 25 * BEM, "the stored, newest value");
    }

    function testFuzz_queue_enforces_bounds(uint8 k, uint256 value) public {
        TapePool.Param key = TapePool.Param(bound(k, 0, uint256(TapePool.Param.OpsFee14d)));
        (uint256 lo, uint256 hi) = pool.bounds(key);
        vm.prank(owner);
        if (value < lo || value > hi) {
            vm.expectRevert(abi.encodeWithSelector(TapePool.OutOfBounds.selector, key, value));
            pool.queueParam(key, value);
        } else {
            pool.queueParam(key, value);
            vm.warp(block.timestamp + 48 hours);
            pool.executeParam(key);
            assertEq(pool.param(key), value);
        }
    }

    function test_bounds_table() public view {
        _assertBounds(TapePool.Param.SupplyCap, 0, 1_000 * BEM);
        _assertBounds(TapePool.Param.BorrowCapAbs, 0, 500 * BEM);
        _assertBounds(TapePool.Param.BorrowCapBps, 0, 9_000);
        _assertBounds(TapePool.Param.PerBorrowerBps, 0, 5_000);
        _assertBounds(TapePool.Param.FeeBps7d, 25, 300);
        _assertBounds(TapePool.Param.FeeBps14d, 50, 600);
        _assertBounds(TapePool.Param.MinFee, 100_000, 10_000_000);
        _assertBounds(TapePool.Param.MinAdvance, 100_000, 100_000_000);
        _assertBounds(TapePool.Param.LateFeeBpsPerDay, 0, 30);
        _assertBounds(TapePool.Param.ReserveShareBps, 0, 5_000);
        _assertBounds(TapePool.Param.ReserveCapBps, 0, 2_000);
        _assertBounds(TapePool.Param.OpsFee7d, 0, 0.5 ether);
        _assertBounds(TapePool.Param.OpsFee14d, 0, 0.5 ether);
        _assertBounds(TapePool.Param.PerBorrowerAbs, 0, 500 * BEM);
    }

    function _assertBounds(TapePool.Param key, uint256 lo, uint256 hi) internal view {
        (uint256 l, uint256 h) = pool.bounds(key);
        assertEq(l, lo);
        assertEq(h, hi);
    }

    function test_lowerCap_is_instant_and_only_lowers_caps() public {
        vm.prank(owner);
        pool.lowerCap(TapePool.Param.SupplyCap, 0);
        assertEq(pool.supplyCap(), 0);
        assertEq(pool.maxDeposit(lp), 0, "owner stops deposits at once");
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(TapePool.NotLower.selector, TapePool.Param.SupplyCap, 1));
        pool.lowerCap(TapePool.Param.SupplyCap, 1);
        vm.expectRevert(abi.encodeWithSelector(TapePool.NotACap.selector, TapePool.Param.MinFee));
        pool.lowerCap(TapePool.Param.MinFee, 100_000);
        pool.lowerCap(TapePool.Param.BorrowCapAbs, 5 * BEM);
        pool.lowerCap(TapePool.Param.BorrowCapBps, 5_000);
        pool.lowerCap(TapePool.Param.PerBorrowerBps, 1_000);
        vm.stopPrank();
        assertEq(pool.borrowCapAbs(), 5 * BEM);
        assertEq(pool.borrowCapBps(), 5_000);
        assertEq(pool.perBorrowerBps(), 1_000);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.lowerCap(TapePool.Param.SupplyCap, 0);
    }

    // ───────────────────────── policy swap

    function _policy(uint16 version) internal returns (MockCreditPolicy p) {
        p = new MockCreditPolicy(feed, version);
    }

    function test_policy_swap_pauses_and_activates_after_seven_days() public {
        MockCreditPolicy p2 = _policy(2);
        uint64 eta = uint64(block.timestamp + 7 days);
        vm.expectEmit(address(pool));
        emit PolicyQueued(address(p2), eta);
        vm.expectEmit(address(pool));
        emit BorrowsPaused(owner);
        vm.prank(owner);
        pool.queuePolicy(p2);
        assertTrue(pool.borrowsPaused());
        assertTrue(pool.policySwapQueued());

        vm.prank(owner);
        vm.expectRevert(TapePool.SwapQueued.selector);
        pool.unpauseBorrows();

        vm.warp(eta - 1);
        vm.expectRevert(TapePool.TooEarly.selector);
        pool.activatePolicy();
        vm.warp(eta);
        vm.prank(alice); // anyone activates
        pool.activatePolicy();
        assertEq(address(pool.policy()), address(p2));
        assertTrue(pool.borrowsPaused(), "stays paused until the owner unpauses");
        assertFalse(pool.policySwapQueued());
        vm.prank(owner);
        pool.unpauseBorrows();
        assertFalse(pool.borrowsPaused());
    }

    function test_policy_sanity_checks() public {
        ICreditPolicy eoa = ICreditPolicy(makeAddr("eoa"));
        MockCreditPolicy same = _policy(1);
        MockCreditPolicy p = _policy(2);
        vm.startPrank(owner);
        vm.expectRevert(TapePool.BadPolicy.selector);
        pool.queuePolicy(eoa);
        vm.expectRevert(TapePool.BadPolicy.selector);
        pool.queuePolicy(same); // version must rise
        p.setMode(MockCreditPolicy.Mode.RevertCheck);
        vm.expectRevert(TapePool.BadPolicy.selector);
        pool.queuePolicy(p);
        p.setMode(MockCreditPolicy.Mode.AllowEmpty);
        vm.expectRevert(TapePool.BadPolicy.selector);
        pool.queuePolicy(p);
        vm.stopPrank();
        p.setMode(MockCreditPolicy.Mode.Normal);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.queuePolicy(p);
        assertFalse(pool.borrowsPaused(), "a rejected queue does not pause");
    }

    function test_policy_rechecked_at_activation() public {
        MockCreditPolicy p2 = _policy(2);
        vm.prank(owner);
        pool.queuePolicy(p2);
        p2.setMode(MockCreditPolicy.Mode.RevertCheck);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(TapePool.BadPolicy.selector);
        pool.activatePolicy();
    }

    function test_policy_cancel_keeps_borrows_paused() public {
        MockCreditPolicy p2 = _policy(2);
        vm.prank(owner);
        pool.queuePolicy(p2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.cancelPolicy();
        vm.expectEmit(address(pool));
        emit PolicyCancelled(address(p2));
        vm.prank(owner);
        pool.cancelPolicy();
        assertTrue(pool.borrowsPaused());
        assertFalse(pool.policySwapQueued());
        vm.expectRevert(TapePool.NothingQueued.selector);
        pool.activatePolicy();
        vm.prank(owner);
        pool.unpauseBorrows();
        assertFalse(pool.borrowsPaused());
    }

    function test_policy_lapse_counts_as_cancelled() public {
        MockCreditPolicy p2 = _policy(2);
        vm.prank(owner);
        pool.queuePolicy(p2);
        vm.warp(block.timestamp + 14 days + 1);
        assertFalse(pool.policySwapQueued());
        vm.expectRevert(TapePool.QueueLapsed.selector);
        pool.activatePolicy();
        vm.expectEmit(address(pool));
        emit PolicyLapsed(address(p2));
        vm.prank(owner);
        pool.unpauseBorrows();
        assertFalse(pool.borrowsPaused());
        assertEq(address(pool.pendingPolicy()), address(0));
    }

    function test_policy_requeue_overwrites() public {
        MockCreditPolicy p2 = _policy(2);
        MockCreditPolicy p3 = _policy(3);
        vm.prank(owner);
        pool.queuePolicy(p2);
        vm.warp(block.timestamp + 6 days);
        vm.expectEmit(address(pool));
        emit PolicyCancelled(address(p2));
        vm.prank(owner);
        pool.queuePolicy(p3);
        vm.warp(block.timestamp + 6 days);
        vm.expectRevert(TapePool.TooEarly.selector);
        pool.activatePolicy();
        vm.warp(block.timestamp + 1 days);
        pool.activatePolicy();
        assertEq(address(pool.policy()), address(p3));
    }

    // ───────────────────────── views

    function test_stats() public {
        _deposit(lp, 20 * BEM);
        _lent(alice, 5 * BEM);
        MockCreditPolicy p2 = _policy(2);
        vm.prank(owner);
        pool.queuePolicy(p2);
        TapePool.Stats memory s = pool.stats();
        assertEq(s.idle, 15 * BEM);
        assertEq(s.outstanding, 5 * BEM);
        assertEq(s.totalAssets, 20 * BEM);
        assertEq(s.utilizationBps, 2_500);
        assertEq(s.supplyCap, 20 * BEM);
        assertTrue(s.borrowsPaused);
        assertEq(s.pendingPolicy, address(p2));
        assertEq(s.pendingPolicyEta, uint64(block.timestamp + 7 days));
    }
}
