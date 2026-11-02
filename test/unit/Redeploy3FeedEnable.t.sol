// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {PolicyBase} from "./PolicyBase.t.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {TapePool} from "../../src/TapePool.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";

/// Redeploy 3, R3-01: reports observed before `feedEnabledAt + MAX_CLOCK_SKEW` are not evidence or
/// health (R3-00 rows E and H), and `lend` waits `FEED_SETTLE` after `enableFeed`. Mocks only.
contract Redeploy3FeedEnableTest is Base {
    uint256 constant ID = 7;

    event FeedEnabled(address indexed by, uint64 extensionEnd);

    function _loan() internal returns (RigAgent a) {
        a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
    }

    function _brake() internal {
        vm.prank(guardian);
        pool.disableFeed();
    }

    function _enable() internal returns (uint64 at) {
        vm.prank(owner);
        pool.enableFeed();
        at = uint64(block.timestamp);
    }

    function _rescuedAt(uint64 at) internal view returns (RigReport memory r) {
        r = _rescuedReport(ID);
        r.observedAt = at;
    }

    function _healthyAt(uint64 at) internal view returns (RigReport memory r) {
        r = _report(ID, 100);
        r.observedAt = at;
    }

    // ───────────────────────── the pool's record and the settling window

    function test_R3_01_feedEnabledAtIsZeroBeforeAnyBrakeAndLaunchBehaviourIsUnchanged() public {
        assertEq(pool.feedEnabledAt(), 0);
        RigAgent a = _ready(alice, ID);
        (uint256 limit, uint8 binding) = pool.lendLimit(alice);
        assertGt(limit, 0);
        assertTrue(binding != 5, "no settling window before the first enableFeed");
        _borrow(a, alice, 0, BEM);
        // the enable floor is 0 + 60, so a report at the flag floor is row E evidence
        vm.warp(a.flagEvidenceFrom());
        feed.set(_rescuedAt(uint64(block.timestamp)));
        a.flagImpaired(ID);
        assertTrue(a.loanOf().doubtful);
    }

    function test_R3_01_onlyEnableFeedWritesFeedEnabledAt() public {
        _brake();
        assertEq(pool.feedEnabledAt(), 0, "disableFeed does not write it");
        vm.warp(block.timestamp + 1 hours);
        uint64 end = uint64(block.timestamp + 24 hours);
        vm.expectEmit(address(pool));
        emit FeedEnabled(owner, end); // the event keeps its signature
        uint64 t1 = _enable();
        assertEq(pool.feedEnabledAt(), t1);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(guardian);
        pool.pauseBorrows();
        vm.prank(owner);
        pool.unpauseBorrows();
        _brake();
        assertEq(pool.feedEnabledAt(), t1, "brakes and pauses leave it");
        vm.warp(block.timestamp + 1 hours);
        uint64 t2 = _enable();
        assertEq(pool.feedEnabledAt(), t2);
    }

    function test_R3_01_lendRevertsAt359AndSucceedsAt360() public {
        RigAgent a = _ready(alice, ID);
        _brake();
        vm.warp(block.timestamp + 1 hours);
        uint64 t = _enable();
        vm.warp(uint256(t) + pool.FEED_SETTLE() - 1);
        (uint256 limit, uint8 binding) = pool.lendLimit(alice);
        assertEq(limit, 0);
        assertEq(binding, 5, "the brake binding while the feed settles");
        assertEq(pool.maxLend(alice), 0);
        vm.prank(address(a));
        vm.expectRevert(TapePool.FeedSettling.selector);
        pool.lend(BEM);
        _refresh(ID, 100);
        vm.prank(alice);
        vm.expectRevert(TapePool.FeedSettling.selector);
        a.borrow{value: OPS}(0, BEM, type(uint256).max, type(uint16).max);

        vm.warp(uint256(t) + pool.FEED_SETTLE());
        (limit, binding) = pool.lendLimit(alice);
        assertGt(limit, 0);
        assertTrue(binding != 5);
        _refresh(ID, 100);
        _borrow(a, alice, 0, BEM);
        assertTrue(a.hasLoan());
    }

    // ───────────────────────── R3-00 row E at the enable floor

    function test_R3_01_rowE_reportAtEnableFloorMinusOneIsNotFlagEvidence() public {
        RigAgent a = _loan();
        vm.warp(block.timestamp + 1 hours);
        _brake();
        vm.warp(block.timestamp + 1 days);
        uint64 t = _enable();
        uint64 enableFloor = t + 60;
        feed.set(_rescuedAt(enableFloor - 1));
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
        feed.set(_rescuedAt(enableFloor));
        a.flagImpaired(ID);
        assertEq(pool.doubtfulOf(address(a)), BEM);
    }

    /// A flag live at the brake keeps at least 24 h of seize time after re-enable; seize evidence
    /// observed at or after the enable floor works inside it, and a report below it does not.
    function test_R3_01_rowE_liveFlagKeeps24hAndSeizeNeedsEvidenceFromTheEnableFloor() public {
        RigAgent a = _loan();
        vm.warp(block.timestamp + 1 hours);
        feed.set(_rescuedAt(uint64(block.timestamp)));
        a.flagImpaired(ID);
        uint64 f = a.loanOf().impairedAt;
        vm.warp(uint256(f) + 1 hours);
        _brake();
        vm.warp(uint256(f) + 100 hours); // the cure window ended during the brake
        feed.set(_rescuedAt(uint64(block.timestamp))); // garbage observed during the brake
        uint64 t = _enable();
        assertGe(a.loanOf().deadline, uint256(t) + 24 hours - 1, "at least 24 h of seize time");
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.seize();
        feed.set(_rescuedAt(t + 59));
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.seize();
        // the last seize second, with evidence observed at the enable floor and still fresh
        uint256 snap = vm.snapshotState();
        feed.set(_rescuedAt(t + 60));
        a.seize();
        assertEq(voucher.ownerOf(ID), address(pool));
        vm.revertToState(snap);
        vm.warp(a.loanOf().deadline);
        feed.set(_rescuedAt(uint64(block.timestamp)));
        a.seize();
        assertTrue(a.closed());
    }

    // ───────────────────────── R3-00 row H at the enable floor

    function test_R3_01_rowH_healthyReportBelowTheEnableFloorDoesNotClear() public {
        RigAgent a = _loan();
        vm.warp(block.timestamp + 1 hours);
        feed.set(_rescuedAt(uint64(block.timestamp)));
        a.flagImpaired(ID);
        vm.warp(pool.expiryOf(a.loanOf().impairedAt) + 1 hours);
        assertTrue(a.loanOf().expired);
        _brake();
        vm.warp(block.timestamp + 10 minutes);
        uint64 t = _enable();
        assertTrue(a.loanOf().expired, "an expired flag stays expired");
        feed.set(_healthyAt(t + 59));
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        feed.set(_healthyAt(t + 60));
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
    }
}

/// R3-01: `FEED_SETTLE` equals `MAX_CLOCK_SKEW + MAX_REPORT_AGE` of both `RigAgent` and the real
/// `CreditPolicy`.
contract Redeploy3FeedSettleConstantTest is PolicyBase {
    function test_R3_01_feedSettleEqualsSkewPlusAgeOfAgentAndPolicy() public view {
        RigAgent impl = factory.implementation();
        assertEq(pool.FEED_SETTLE(), 360);
        assertEq(pool.FEED_SETTLE(), impl.MAX_CLOCK_SKEW() + impl.MAX_REPORT_AGE(), "agent");
        assertEq(pool.FEED_SETTLE(), credit.MAX_CLOCK_SKEW() + credit.MAX_REPORT_AGE(), "policy");
    }
}
