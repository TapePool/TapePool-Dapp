// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {Reasons} from "../../src/interfaces/ICreditPolicy.sol";
import {RigReport as RigReportView} from "../../src/interfaces/IRigFeed.sol";
import {TapePool} from "../../src/TapePool.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {TapeLens} from "../../src/TapeLens.sol";
import {CreditMath} from "../../src/libraries/CreditMath.sol";
import {MockCreditPolicy} from "../mocks/Mocks.sol";

contract TapeLensTest is Base {
    uint256 constant ID = 7;

    function test_quote_is_the_largest_allowed_borrow() public {
        RigAgent a = _ready(alice, ID);
        TapeLens.Quote memory q = lens.quote(a, 0);
        assertEq(q.reason, Reasons.OK);
        uint256 expected = CreditMath.expectedOutput(100, NETWORK_WEIGHT, 0);
        assertEq(q.expected, expected);
        assertEq(q.fee, pool.fee(0, q.maxPrincipal));
        assertLe(q.maxPrincipal + q.fee, CreditMath.maxDebt(expected, 0));
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        vm.expectRevert();
        a.borrow{value: OPS}(0, q.maxPrincipal + 1, type(uint256).max, type(uint16).max);
        vm.revertToState(snap);
        _borrow(a, alice, 0, q.maxPrincipal);
        assertEq(lens.loanOf(a).principal, q.maxPrincipal);
        assertEq(lens.collateralOf(a)[0], ID);
    }

    function test_quote_capped_by_pool_room() public {
        _deposit(lp, 2 * BEM); // per-borrower cap 0.8 BEM
        RigAgent a = _ready(alice, ID);
        TapeLens.Quote memory q = lens.quote(a, 0);
        assertEq(q.reason, Reasons.OK);
        assertEq(q.maxPrincipal, 80_000_000);
        _borrow(a, alice, 0, q.maxPrincipal);
    }

    function test_quote_reports_pending() public {
        RigAgent a = _ready(alice, ID);
        feed.set(_withPending(ID, uint128(9 * BEM)));
        assertEq(lens.quote(a, 0).pending, 9 * BEM);
    }

    function _withPending(uint256 id, uint128 pending) internal view returns (RigReportView memory) {
        RigReportView memory r = _report(id, 100);
        r.pending = pending;
        return r;
    }

    function test_quote_reasons() public {
        RigAgent empty = _agent(bob, 0);
        _deposit(lp, 20 * BEM);
        assertEq(lens.quote(empty, 0).reason, Reasons.NO_COLLATERAL);

        RigAgent a = _ready(alice, ID);
        assertEq(lens.quote(a, 2).reason, Reasons.BAD_TERM);

        vm.warp(block.timestamp + 361); // stale report
        TapeLens.Quote memory q = lens.quote(a, 0);
        assertEq(q.reason, Reasons.DENIED);
        assertEq(q.maxPrincipal, 0);
        _refresh(ID, 100);

        vm.prank(guardian);
        pool.pauseBorrows();
        assertEq(lens.quote(a, 0).reason, Reasons.PAUSED);
        vm.prank(owner);
        pool.unpauseBorrows();

        vm.prank(guardian);
        pool.disableFeed();
        assertEq(lens.quote(a, 0).reason, Reasons.FEED_OFF);
        vm.prank(owner);
        pool.enableFeed();

        MockCreditPolicy p2 = new MockCreditPolicy(feed, 2);
        vm.prank(owner);
        pool.queuePolicy(p2);
        assertEq(lens.quote(a, 0).reason, Reasons.SWAP_QUEUED);
        vm.prank(owner);
        pool.cancelPolicy();
        vm.prank(owner);
        pool.unpauseBorrows();

        vm.prank(owner);
        pool.lowerCap(TapePool.Param.BorrowCapAbs, 0);
        assertEq(lens.quote(a, 0).reason, Reasons.FEED_OFF);
        vm.warp(uint256(pool.feedEnabledAt()) + pool.FEED_SETTLE());
        _refresh(ID, 100);
        assertEq(lens.quote(a, 0).reason, Reasons.NO_ROOM);
        vm.prank(owner);
        pool.queueParam(TapePool.Param.BorrowCapAbs, 10 * BEM);
        vm.warp(block.timestamp + 48 hours);
        pool.executeParam(TapePool.Param.BorrowCapAbs);
        _refresh(ID, 100);

        _borrow(a, alice, 0, BEM);
        assertEq(lens.quote(a, 0).reason, Reasons.LOAN_OPEN);

        RigAgent c = _ready(keeper, 9);
        vm.prank(address(c));
        voucher.transferFrom(address(c), bob, 9);
        assertEq(lens.quote(c, 0).reason, Reasons.NO_COLLATERAL, "a voucher the agent no longer owns");
    }

    function _checkQuotes(RigAgent a, uint8 term, uint8 expectedReason) internal view {
        TapeLens.Quote memory q = lens.quote(a, term);
        assertEq(q.reason, expectedReason);
        (uint256 fee, uint16 lateBps, uint256 debt, bool allowed, uint8 reason, uint8 binding) =
            lens.quoteFor(a, term, BEM);
        assertEq(reason, expectedReason);
        assertEq(fee, pool.fee(term, BEM));
        assertEq(debt, BEM + fee);
        assertEq(lateBps, pool.lateFeeBpsPerDay());
        assertEq(allowed, expectedReason == Reasons.OK);
        assertEq(binding, 0);
        if (expectedReason == Reasons.OK) assertGt(q.maxPrincipal, 0);
        else assertEq(q.maxPrincipal, 0);
    }

    function test_R4_05_quotesNameSettlingAt359AndAllowAt360() public {
        RigAgent a = _ready(alice, ID);
        vm.prank(guardian);
        pool.disableFeed();
        vm.prank(owner);
        pool.enableFeed();
        uint256 enabledAt = pool.feedEnabledAt();
        vm.warp(enabledAt + 359);
        _refresh(ID, 100);
        for (uint8 term; term < 2; ++term) {
            _checkQuotes(a, term, Reasons.FEED_OFF);
        }
        vm.warp(enabledAt + 360);
        for (uint8 term; term < 2; ++term) {
            _checkQuotes(a, term, Reasons.OK);
        }
    }

    function test_R4_05_pausePrecedesSettlingForBothQuotes() public {
        RigAgent a = _ready(alice, ID);
        vm.prank(guardian);
        pool.disableFeed();
        vm.prank(owner);
        pool.enableFeed();
        vm.warp(uint256(pool.feedEnabledAt()) + 359);
        _refresh(ID, 100);
        vm.prank(guardian);
        pool.pauseBorrows();
        for (uint8 term; term < 2; ++term) {
            _checkQuotes(a, term, Reasons.PAUSED);
        }
    }

    function test_R4_05_zeroEnabledAtDoesNotBlockAtRealTimestamp() public {
        RigAgent a = _ready(alice, ID);
        assertEq(pool.feedEnabledAt(), 0);
        assertGt(block.timestamp, 360);
        for (uint8 term; term < 2; ++term) {
            _checkQuotes(a, term, Reasons.OK);
        }
    }

    function test_quote_on_a_closed_agent() public {
        RigAgent a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        vm.warp(block.timestamp + 1 hours);
        feed.set(_rescuedReport(ID));
        a.flagImpaired(ID);
        vm.warp(block.timestamp + 72 hours);
        feed.set(_rescuedReport(ID));
        a.seize();
        assertEq(lens.quote(a, 0).reason, Reasons.CLOSED);
    }

    function test_quote_with_a_rig_too_small_for_the_minimum() public {
        _deposit(lp, 20 * BEM);
        RigAgent a = _agent(alice, 0);
        voucher.mint(alice, ID, 1);
        RigReportView memory r = _report(ID, 0);
        r.verifWeight = 11;
        r.bonus = 10;
        r.totalVerifWeight = 50_000_000; // 1 H on a huge network: below 0.01 BEM of debt room
        feed.set(r);
        _pledge(a, alice, ID);
        TapeLens.Quote memory q = lens.quote(a, 0);
        assertEq(q.reason, Reasons.DENIED);
        assertEq(q.maxPrincipal, 0);
    }

    /// `principalFor` returns the largest principal whose debt fits, under any fee setting.
    function testFuzz_principalFor(uint256 limit, bool longTerm, uint256 bps, uint256 minFee_) public {
        uint8 term = longTerm ? 1 : 0;
        if (longTerm) _queueSet(TapePool.Param.FeeBps14d, bound(bps, 50, 600));
        else _queueSet(TapePool.Param.FeeBps7d, bound(bps, 25, 300));
        _queueSet(TapePool.Param.MinFee, bound(minFee_, 100_000, 10_000_000));
        limit = bound(limit, 0, 1_000_000 * BEM);
        uint256 p = lens.principalFor(pool, term, limit);
        if (p == 0) {
            assertGt(1 + pool.fee(term, 1), limit, "not even 1 raw fits");
        } else {
            assertLe(p + pool.fee(term, p), limit, "fits");
            assertGt(p + 1 + pool.fee(term, p + 1), limit, "largest");
        }
    }

    function _queueSet(TapePool.Param key, uint256 value) internal {
        vm.prank(owner);
        pool.queueParam(key, value);
        vm.warp(block.timestamp + 48 hours);
        pool.executeParam(key);
    }
}

