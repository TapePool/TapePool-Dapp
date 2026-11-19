// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {TableFeedState, TableFeed, TableVoucher, TableAgent} from "./Redeploy3EvidenceTable.t.sol";
import {VecAgent} from "../../script/app/ParityVectors.s.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {ITapePool} from "../../src/interfaces/ITapePool.sol";
import {IRigFeed, RigReport} from "../../src/interfaces/IRigFeed.sol";
import {IRigVoucher} from "../../src/interfaces/IXLayer.sol";

/// R4-00 and R4-03: B and U survive every brake, and unknown blocks every collateral rig.
contract Redeploy4EvidenceTest is Base {
    uint256 constant F = 7;
    uint256 constant G = 8;
    TableFeedState state;
    TableFeed reports;
    TableVoucher records;
    TableAgent agent;

    function setUp() public override {
        super.setUp();
        state = new TableFeedState();
        reports = new TableFeed();
        records = new TableVoucher();
        agent = new TableAgent(ITapePool(address(state)), IRigVoucher(address(records)), IRigFeed(address(reports)));
    }

    function _tableReport(uint64 at, bool impaired) internal view returns (RigReport memory r) {
        r = _report(F, 100);
        r.observedAt = at;
        if (impaired) r.status = 2;
    }

    function _matrix(bool unknown, bool disabled) internal {
        uint64 floor = uint64(block.timestamp - 2_000);
        uint64 at = uint64(block.timestamp - 1_000); // stale: neither B nor U needs freshness
        state.set(disabled, unknown ? at - 59 : 0);
        reports.set(_tableReport(at, !unknown), true, false);
        uint64[5] memory times = [floor - 1, floor, at - 1, at, at + 1];
        for (uint256 i; i < times.length; ++i) {
            for (uint256 j; j < 2; ++j) {
                uint256 power = j == 0 ? 110 : 0;
                records.set(true, times[i], power);
                uint8 want = unknown ? 3 : 2;
                if (times[i] >= floor && power == 0) want = 2;
                if (times[i] > at && power > 0) want = 1;
                assertEq(agent.verdict(F, floor), want, string.concat(vm.toString(i), "/", vm.toString(j)));
                assertEq(agent.evidenceKind(F, floor), times[i] >= floor && power == 0 ? 2 : 0);
            }
        }
        records.set(false, at + 1, 110);
        assertEq(agent.verdict(F, floor), unknown ? 3 : 2, "no readable record");
        records.set(true, uint64(block.timestamp + 61), 110);
        assertEq(agent.verdict(F, floor), unknown ? 3 : 2, "future record is not known");
    }

    function test_R4_03_rowBRecordMatrixFeedOn() public {
        _matrix(false, false);
    }

    function test_R4_03_rowBRecordMatrixFeedOff() public {
        _matrix(false, true);
    }

    function test_R4_03_rowURecordMatrixFeedOn() public {
        _matrix(true, false);
    }

    function test_R4_03_rowURecordMatrixFeedOff() public {
        _matrix(true, true);
    }

    function test_R4_00_floorEnableFreshnessAndFutureBoundaries() public {
        uint64 now_ = uint64(block.timestamp);
        uint64 floor = now_ - 1_000;
        records.set(false, 0, 0);
        state.set(false, now_ - 60);
        reports.set(_tableReport(now_ - 1, false), true, false);
        assertEq(agent.verdict(F, floor), 3, "below enableFloor is unknown");
        reports.set(_tableReport(now_, false), true, false);
        assertEq(agent.verdict(F, floor), 1, "at enableFloor is health");
        state.set(false, 0);
        reports.set(_tableReport(now_ - 300, false), true, false);
        assertEq(agent.verdict(F, floor), 1, "age 300");
        reports.set(_tableReport(now_ - 301, false), true, false);
        assertEq(agent.verdict(F, floor), 3, "age 301 is row N");
        state.set(true, 0);
        assertEq(agent.verdict(F, floor), 3, "age 301 during a brake is still U");
        reports.set(_tableReport(floor - 1, true), true, false);
        assertEq(agent.verdict(F, floor), 0, "below floor");
        reports.set(_tableReport(floor, true), true, false);
        assertEq(agent.verdict(F, floor), 2, "at floor");
        reports.set(_tableReport(now_ + 60, true), true, false);
        assertEq(agent.verdict(F, floor), 2, "future +60");
        reports.set(_tableReport(now_ + 61, true), true, false);
        assertEq(agent.verdict(F, floor), 0, "future +61");
        RigReport memory r = _tableReport(now_, false);
        r.totalVerifWeight = 1; // insane but not impaired: still U during a brake
        reports.set(r, true, false);
        assertEq(agent.verdict(F, floor), 3);
        r.rigId = uint64(G);
        reports.set(r, true, false);
        assertEq(agent.verdict(F, floor), 0, "wrong rig");
    }

    function test_R4_00_EHandSStillRequireFeedOn() public {
        uint64 now_ = uint64(block.timestamp);
        uint64 floor = now_ - 1_000;
        records.set(false, 0, 0);
        reports.set(_tableReport(now_, true), true, false);
        assertEq(agent.evidenceKind(F, floor), 1);
        state.set(true, 0);
        assertEq(agent.evidenceKind(F, floor), 0, "E is off");
        assertEq(agent.verdict(F, floor), 2, "B stays on");
        reports.set(_tableReport(now_, false), true, false);
        assertEq(agent.verdict(F, floor), 3, "H is off, U applies");
        records.set(true, floor, 0);
        assertEq(agent.evidenceKind(F, floor), 2, "S is off: VE decides");
        state.set(false, 0);
        assertEq(agent.evidenceKind(F, floor), 0, "S shields while feed is on");
        assertEq(agent.verdict(F, floor), 1, "H supplies newer health");
    }

    function test_R4_00_vectorAdapterReturnsAllFourRealCodes() public {
        VecAgent vec =
            new VecAgent(ITapePool(address(state)), IRigVoucher(address(records)), IRigFeed(address(reports)));
        uint64 floor = uint64(block.timestamp - 1_000);
        records.set(false, 0, 0);
        RigReport memory r = _tableReport(uint64(block.timestamp), false);
        reports.set(r, false, false);
        assertEq(vec.verdict(F, floor), 0);
        reports.set(r, true, false);
        assertEq(vec.verdict(F, floor), 1);
        r.status = 2;
        reports.set(r, true, false);
        assertEq(vec.verdict(F, floor), 2);
        state.set(true, 0);
        r.status = 1;
        reports.set(r, true, false);
        assertEq(vec.verdict(F, floor), 3);
    }

    function _expiredLoan() internal returns (RigAgent a, uint64 floor) {
        a = _ready(alice, F);
        _rig(alice, G, 100);
        _pledge(a, alice, G);
        _borrow(a, alice, 0, BEM);
        vm.warp(block.timestamp + 1 hours);
        RigReport memory r = _report(F, 100);
        r.verifWeight = r.bonus;
        feed.set(r);
        a.flagImpaired(F);
        floor = a.seizeEvidenceFrom();
        vm.warp(pool.expiryOf(a.loanOf().impairedAt));
        voucher.setRig(F, floor, 110);
        voucher.setRig(G, floor, 110);
    }

    function _blocked(RigAgent a) internal {
        uint256 assets = pool.totalAssets();
        uint256 doubtful = pool.doubtful();
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), doubtful);
        assertEq(pool.totalAssets(), assets);
        assertEq(pool.maxDeposit(lp), 0);
    }

    function test_R4_03_otherRigStoredImpairmentBlocksInEveryBrakeState() public {
        (RigAgent a, uint64 floor) = _expiredLoan();
        RigReport memory r = _report(G, 100);
        r.status = 2;
        r.observedAt = floor + 1;
        feed.set(r);
        _blocked(a);
        vm.prank(guardian);
        pool.pauseBorrows();
        _blocked(a);
        vm.prank(guardian);
        pool.disableFeed();
        _blocked(a);
        vm.prank(owner);
        pool.enableFeed();
        _blocked(a);
    }

    function test_R4_03_overwriteOnOtherRigWaitsForNewerRecordOrRowH() public {
        (RigAgent a, uint64 floor) = _expiredLoan();
        RigReport memory r = _report(G, 100);
        r.status = 2;
        r.observedAt = floor + 1;
        feed.set(r);
        _blocked(a);
        vm.prank(guardian);
        pool.disableFeed();
        _blocked(a);
        vm.warp(block.timestamp + 1);
        uint64 masked = uint64(block.timestamp);
        r.status = 1;
        r.observedAt = masked;
        feed.set(r); // B is overwritten, but U still blocks on the other rig
        _blocked(a);
        uint256 snap = vm.snapshotState();
        voucher.setRig(G, masked + 1, 110);
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
        vm.revertToState(snap);
        vm.prank(owner);
        pool.enableFeed();
        _blocked(a); // re-enable alone does not resolve U
        r.observedAt = uint64(block.timestamp + 60);
        feed.set(r);
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
    }

    function test_R4_03_unreadableFeedDiffersFromStoppedFeedForBandU() public {
        (RigAgent a, uint64 floor) = _expiredLoan();
        vm.prank(guardian);
        pool.disableFeed();
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            RigReport memory r = _report(G, 100);
            r.observedAt = floor + 1;
            if (i == 0) r.status = 2;
            feed.set(r);
            vm.warp(block.timestamp + 30 days); // delivery stops; stored B or U remains readable
            _blocked(a);
            feed.setBroken(true); // no report row applies when latest itself is unreadable
            a.clearExpiredFlag();
            assertEq(pool.doubtful(), 0);
            vm.revertToState(snap);
        }
    }
}
