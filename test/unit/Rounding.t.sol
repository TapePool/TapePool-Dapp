// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {PolicyBase} from "./PolicyBase.t.sol";
import {TapePool} from "../../src/TapePool.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {CreditMath} from "../../src/libraries/CreditMath.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";

/// Rounding properties Q1–Q9 and Q12 (docs/SPEC-PHASE4-REENTRANCY-ROUNDING.md §5.2). Every bound is
/// checked against an exact fraction computed in the test, never against the contract's own math.
contract RoundingTest is Base {
    uint256 constant ID = 7;

    // ───────────────────────── Q1: the fee rounds up and never falls as the principal grows

    function testFuzz_Q1_fee_rounds_up_and_is_monotone(uint256 p, bool longTerm) public view {
        uint8 term = longTerm ? 1 : 0;
        p = bound(p, pool.minAdvance(), 1_000 * BEM);
        uint256 bps = longTerm ? pool.feeBps14d() : pool.feeBps7d();
        uint256 f = pool.fee(term, p);
        assertGe(f * 10_000, p * bps, "fee below p x bps / 10,000");
        assertGe(f, pool.minFee(), "fee below the minimum");
        assertLe(f * 10_000, p * bps + 10_000 + pool.minFee() * 10_000, "fee rounds up by less than 1 raw BEM");
        assertGe(pool.fee(term, p + 1), f, "fee fell as the principal grew");
    }

    // ───────────────────────── Q2: checkpointed late fee vs the exact fraction

    function testFuzz_Q2_late_fee_checkpoints_stay_within_one_raw_bem_each(uint256 seed, uint8 k) public {
        _queueExecute(TapePool.Param.LateFeeBpsPerDay, 30);
        RigAgent a = _ready(alice, ID);
        uint256 p = BEM + (seed % BEM); // within the 100 H rig's 7-day limit (about 2.65 BEM)
        _borrow(a, alice, 0, p);
        RigAgent.LoanView memory v0 = a.loanOf();
        vm.warp(v0.maturity);
        uint256 n = bound(k, 1, 24);
        uint256 t0 = block.timestamp;
        for (uint256 i; i < n; ++i) {
            vm.warp(block.timestamp + 1 + uint256(keccak256(abi.encode(seed, i))) % 3 days);
            vm.prank(keeper);
            a.sweep(); // the agent holds no BEM: a checkpoint, principal unchanged
        }
        vm.warp(block.timestamp + 1 + seed % 1 days);
        uint256 elapsed = block.timestamp - t0;
        uint256 due = a.loanOf().lateFeeDue; // the view adds one more rounded-up step
        uint256 num = p * 30 * elapsed;
        uint256 den = 10_000 * 1 days;
        assertEq(a.loanOf().principal, p, "principal unchanged");
        assertGe(due * den, num, "late fee below the exact fraction");
        assertLe(due * den, num + (n + 1) * den, "more than 1 raw BEM per checkpoint above the exact fraction");
    }

    // ───────────────────────── Q3: expected output rounds down, per rig and summed

    function testFuzz_Q3_expected_output_rounds_down(uint256 total, uint256 seed, bool longTerm) public pure {
        uint8 term = longTerm ? 1 : 0;
        total = bound(total, 1, type(uint64).max);
        uint256 num = CreditMath.VERIF_EMISSION_PER_DAY * CreditMath.termDays(term) * CreditMath.dilutionBps(term)
            * CreditMath.BRIDGE_KEEP_BPS;
        uint256 den = total * 1e8;
        uint256 sum;
        uint256 sumBase;
        for (uint256 i; i < 16; ++i) {
            uint256 base = uint256(keccak256(abi.encode(seed, i))) % (total + 1);
            uint256 e = CreditMath.expectedOutput(base, total, term);
            assertLe(e * den, base * num, "expected output above the exact fraction");
            assertGt((e + 1) * den, base * num, "expected output more than 1 raw BEM below the fraction");
            sum += e;
            sumBase += base;
        }
        assertLe(sum * den, sumBase * num, "summed expected output above the exact fraction");
    }

    // ───────────────────────── Q4: the debt bucket rounds up

    function testFuzz_Q4_debt_bucket_rounds_up(uint256 d, uint256 e, bool longTerm) public pure {
        uint8 term = longTerm ? 1 : 0;
        d = bound(d, 0, type(uint128).max);
        e = bound(e, 1, type(uint128).max);
        uint8 b = CreditMath.debtBucket(d, e);
        if (b < CreditMath.MAX_BUCKET) {
            assertGe(uint256(b) * 500 * e, d * 10_000, "bucket below the exact debt share");
        }
        if (b <= CreditMath.bucketLimit(term)) {
            assertLe(d * 10_000, e * CreditMath.maxDebtBps(term), "an allowed bucket with debt above the limit");
        }
        assertEq(CreditMath.debtBucket(d, 0), CreditMath.MAX_BUCKET, "no expected output saturates");
    }

    // ───────────────────────── Q5 (sizing): principalFor is the largest principal that fits

    function testFuzz_Q5_principalFor_is_the_largest_fit(uint256 limit, bool longTerm) public view {
        uint8 term = longTerm ? 1 : 0;
        limit = bound(limit, 0, 1_000 * BEM);
        uint256 p = lens.principalFor(pool, term, limit);
        if (p != 0) assertLe(p + pool.fee(term, p), limit, "the principal does not fit");
        assertGt(p + 1 + pool.fee(term, p + 1), limit, "a larger principal would fit");
    }

    // ───────────────────────── Q6: ERC-4626 round trips over random pool states

    /// A pool with idle BEM, an open loan, a reserve from a repayment and maybe a donation.
    function _state(uint256 s) internal returns (RigAgent a) {
        _deposit(lp, 4 * BEM + s % (8 * BEM));
        a = _agent(alice, ID);
        _rig(alice, ID, 100);
        _pledge(a, alice, ID);
        _borrow(a, alice, uint8(s % 2), pool.minAdvance() + s % BEM);
        _harvest(address(a), (s >> 64) % (BEM / 2));
        vm.prank(keeper);
        a.sweep(); // part of the debt: fee to the reserve and lenders
        if ((s >> 128) % 2 == 0) bem.mint(address(pool), (s >> 136) % BEM); // a donation
    }

    function testFuzz_Q6_round_trips_never_pay_more(uint256 s, uint256 amt) public {
        _state(s);
        uint256 room = pool.maxDeposit(bob);
        vm.assume(room > 2);
        uint256 a = bound(amt, 1, room);
        bem.mint(bob, a);
        vm.startPrank(bob);
        bem.approve(address(pool), a);
        uint256 shares = pool.deposit(a, bob);
        vm.stopPrank();
        assertLe(pool.previewRedeem(shares), a, "redeem pays more than the deposit");
        assertGe(pool.previewWithdraw(a), shares, "withdrawing the deposit burns fewer shares than it minted");
        uint256 s2 = shares / 3 + 1;
        assertGe(pool.previewMint(s2), pool.convertToAssets(s2), "mint costs less than the shares are worth");
        // the whole trip: deposit, then take out everything bob can
        uint256 out = pool.maxRedeem(bob);
        vm.prank(bob);
        uint256 got = pool.redeem(out, bob, bob);
        assertLe(got, a, "the account ends with more BEM than it put in");
    }

    function testFuzz_Q6_max_values_hold_by_their_effects(uint256 s) public {
        _state(s);
        uint256 snap = vm.snapshotState();

        uint256 m = pool.maxMint(bob);
        if (m != 0) {
            bem.mint(bob, pool.previewMint(m));
            vm.startPrank(bob);
            bem.approve(address(pool), type(uint256).max);
            pool.mint(m, bob);
            vm.stopPrank();
            assertLe(pool.totalAssets(), pool.supplyCap(), "mint(maxMint) passed the supply cap");
        }
        vm.revertToState(snap);

        uint256 d = pool.maxDeposit(bob);
        if (d != 0) {
            bem.mint(bob, d);
            vm.startPrank(bob);
            bem.approve(address(pool), d);
            pool.deposit(d, bob);
            vm.stopPrank();
            assertLe(pool.totalAssets(), pool.supplyCap(), "deposit(maxDeposit) passed the supply cap");
        }
        vm.revertToState(snap);

        uint256 idle0 = pool.idle();
        uint256 r = pool.maxRedeem(lp);
        vm.prank(lp);
        uint256 paid = pool.redeem(r, lp, lp);
        assertGe(bem.balanceOf(address(pool)), pool.reserve(), "redeem(maxRedeem) dipped into the reserve");
        assertLe(paid, idle0, "redeem(maxRedeem) paid more than idle BEM");
        vm.revertToState(snap);

        uint256 w = pool.maxWithdraw(lp);
        vm.prank(lp);
        pool.withdraw(w, lp, lp);
        assertGe(bem.balanceOf(address(pool)), pool.reserve(), "withdraw(maxWithdraw) dipped into the reserve");
        assertLe(w, idle0, "withdraw(maxWithdraw) paid more than idle BEM");
    }

    // ───────────────────────── Q7 (unit): the share price only falls at the flag

    function _price() internal view returns (uint256) {
        return pool.convertToAssets(1e20);
    }

    function test_Q7_share_price_falls_only_at_the_flag() public {
        _deposit(lp, 10 * BEM);
        uint256 p0 = _price();
        RigAgent a = _agent(alice, ID);
        _rig(alice, ID, 100);
        _pledge(a, alice, ID);
        _borrow(a, alice, 0, 2 * BEM);
        uint256 p1 = _price();
        assertGe(p1, p0, "lend lowered the price");
        _harvest(address(a), BEM / 2);
        vm.prank(keeper);
        a.sweep();
        uint256 p2 = _price();
        assertEq(p2, p1, "income is not released in the booking block");
        vm.warp(pool.vestEnd());
        p2 = _price();
        assertGt(p2, p1, "released fee income raises the price");
        feed.set(_rescuedReport(ID));
        a.flagImpaired(ID);
        uint256 p3 = _price();
        assertLt(p3, p2, "the flag did not mark the loan down");
        vm.warp(block.timestamp + a.CURE_WINDOW() + 1);
        feed.set(_rescuedReport(ID));
        vm.prank(keeper);
        a.seize();
        uint256 p4 = _price();
        assertGe(p4, p3, "writeOff lowered the price (the loss was already marked)");
        console.log("Q7 price (assets per 1e20 shares): start, lend, fee, flag, seize", p0, p1);
        console.log("   ", p2, p3, p4);
    }

    // ───────────────────────── Q8: first-depositor attack with offset 6

    function testFuzz_Q8_first_depositor_attack_costs_the_attacker_more(uint256 x, uint256 donation, uint256 v) public {
        address attacker = makeAddr("attacker");
        x = bound(x, 1, 1e6);
        uint256 attackerShares = _deposit(attacker, x);
        donation = bound(donation, 0, 20 * BEM);
        bem.mint(address(pool), donation);
        uint256 room = pool.maxDeposit(bob);
        vm.assume(room >= pool.minAdvance());
        v = bound(v, pool.minAdvance(), room);
        uint256 ta = pool.totalAssets();
        uint256 supply = pool.totalSupply();
        uint256 victimShares = _deposit(bob, v);
        uint256 victimValue = pool.convertToAssets(victimShares);
        uint256 victimLoss = v - victimValue;
        uint256 shareWorth = (ta + 1 + supply + 1e6 - 1) / (supply + 1e6); // one share, rounded up
        assertGt(victimShares, 0, "the victim got no shares");
        assertLe(victimLoss, shareWorth + 1, "the victim lost more than one share plus 1 raw BEM");
        uint256 attackerValue = pool.convertToAssets(attackerShares);
        assertLe(attackerValue, x + donation, "the attacker profited");
        // the inflation-attack shape: a tiny first deposit, then a donation far above it
        if (donation >= 1_000 && donation >= 1_000 * x) {
            assertGt(x + donation - attackerValue, victimLoss, "the attack paid off");
        }
    }

    function test_Q8_numbers_at_the_mvp_caps() public {
        address attacker = makeAddr("attacker");
        uint256 attackerShares = _deposit(attacker, 1);
        bem.mint(address(pool), 19 * BEM);
        uint256 v = pool.maxDeposit(bob);
        uint256 victimShares = _deposit(bob, v);
        uint256 victimLoss = v - pool.convertToAssets(victimShares);
        uint256 attackerLoss = 1 + 19 * BEM - pool.convertToAssets(attackerShares);
        console.log("Q8 (1 raw BEM, then a 19 BEM donation): victim deposit, victim loss, attacker loss");
        console.log("   ", v, victimLoss, attackerLoss);
        assertLe(victimLoss, 1_000, "the victim loses at most 1,000 raw BEM (0.00001 BEM)");
        assertGt(attackerLoss, 9 * BEM, "the attacker loses about half the donation");
    }

    // ───────────────────────── Q9: wipeout and fresh deposits

    function test_Q9_after_an_uncovered_write_off_new_money_is_not_shared_with_the_loss() public {
        _deposit(lp, 10 * BEM);
        uint256 lpShares = pool.balanceOf(lp);
        RigAgent a = _agent(alice, ID);
        _rig(alice, ID, 100);
        _pledge(a, alice, ID);
        _borrow(a, alice, 0, 2 * BEM);
        feed.set(_rescuedReport(ID));
        a.flagImpaired(ID);
        vm.warp(block.timestamp + a.CURE_WINDOW() + 1);
        feed.set(_rescuedReport(ID));
        vm.prank(keeper);
        a.seize();
        assertEq(pool.doubtful(), 0, "the seize closed the mark");
        uint256 taPostLoss = pool.totalAssets();
        assertLt(taPostLoss, 10 * BEM, "the loss was not covered");
        uint256 bobShares = _deposit(bob, 5 * BEM);
        vm.prank(bob);
        uint256 bobGot = pool.redeem(bobShares, bob, bob);
        assertLe(bobGot, 5 * BEM, "the new depositor took old money");
        assertGe(bobGot + 1, 5 * BEM, "the new depositor paid for the old loss");
        uint256 lpMax = pool.maxRedeem(lp);
        vm.prank(lp);
        uint256 lpGot = pool.redeem(lpMax, lp, lp);
        assertLe(lpGot, taPostLoss, "the old holders took the new depositor's BEM");
        // the virtual shares keep a dust remainder in the vault: the shares left are worth < 1 raw BEM
        assertEq(pool.convertToAssets(lpShares - lpMax), 0, "the old holder cannot leave but for dust");
        assertGe(lpGot + 1, taPostLoss, "the old holder got its post-loss share");
    }

    // ───────────────────────── Q12: lend(maxLend) always fits, maxLend + 1 never does

    function testFuzz_Q12_maxLend_is_borrowable_and_tight(uint256 s, uint256 other) public {
        _state(s);
        RigAgent b = _agent(alice, 99); // a second agent of the same borrower
        if (other % 2 == 0) {
            RigAgent c = _agent(bob, 1);
            uint256 half = pool.maxLend(bob) / 2;
            vm.prank(address(c));
            pool.lend(half);
        }
        uint256 m = pool.maxLend(alice);
        uint256 snap = vm.snapshotState();
        vm.prank(address(b));
        pool.lend(m);
        vm.revertToState(snap);
        vm.prank(address(b));
        (bool ok,) = address(pool).call(abi.encodeCall(TapePool.lend, (m + 1)));
        assertFalse(ok, "maxLend is not the largest loan");
    }
}

/// Q5 with the real policy: for a rig set that passes every flag, `maxDebt` is the exact limit.
contract PolicyRoundingTest is PolicyBase {
    uint256 constant ID = 7;

    function testFuzz_Q5_maxDebt_is_the_exact_limit_and_passes(uint64 base, bool longTerm) public {
        uint8 term = longTerm ? 1 : 0;
        base = uint64(bound(base, 1, 400_000));
        RigAgent a = _agent(alice, 0);
        _rig(alice, ID, base);
        _pledge(a, alice, ID);
        _screen(ID, base);
        uint256[] memory ids = _ids(ID);
        uint256 expected = CreditMath.expectedOutput(base, NETWORK_WEIGHT, term);
        vm.assume(expected > 0);
        uint256 limit = credit.maxDebt(address(a), ids, term);
        assertEq(limit, CreditMath.maxDebt(expected, term), "maxDebt is not the exact limit");
        assertGt(limit, 0);
        (bool allow,,,) = credit.check(address(a), ids, term, limit);
        assertTrue(allow, "the limit itself is denied");
        assertLe(limit * 10_000, expected * CreditMath.maxDebtBps(term), "the limit is above the term share");
    }
}
