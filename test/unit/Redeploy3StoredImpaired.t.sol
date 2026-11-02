// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";

/// Redeploy 3, R3-05: `clearExpiredFlag` reads rows H, B and VC of R3-00. A stored impaired report
/// (row B) counts at any age and without the enable floor; a healthy report (row H) still needs fresh,
/// sane and the enable floor. Mocks only.
contract Redeploy3StoredImpairedTest is Base {
    uint256 constant ID = 7;

    function _impairedAt(uint64 at) internal view returns (RigReport memory r) {
        r = _report(ID, 100);
        r.status = 2; // revoked
        r.observedAt = at;
    }

    function _healthyAt(uint64 at) internal view returns (RigReport memory r) {
        r = _report(ID, 100);
        r.observedAt = at;
    }

    /// A loan flagged on a no-base-power report and expired; returns the clear floor.
    function _expired() internal returns (RigAgent a, uint64 floor) {
        a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        vm.warp(block.timestamp + 1 hours);
        RigReport memory r = _report(ID, 100);
        r.verifWeight = r.bonus;
        feed.set(r);
        a.flagImpaired(ID);
        floor = a.seizeEvidenceFrom();
        vm.warp(pool.expiryOf(a.loanOf().impairedAt) + 1 hours);
        assertTrue(a.loanOf().expired);
    }

    function test_R3_05_rowB_anImpairedReportAt301SecondsStillBlocks() public {
        (RigAgent a, uint64 floor) = _expired();
        voucher.setRig(ID, floor, 110); // an older positive record
        feed.set(_impairedAt(uint64(block.timestamp - 301)));
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        feed.set(_impairedAt(floor + 1)); // about 25 hours old
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
    }

    function test_R3_05_aNewerPositiveRecordOvertakesRowB() public {
        (RigAgent a, uint64 floor) = _expired();
        uint64 at = floor + 1 hours;
        feed.set(_impairedAt(at));
        voucher.setRig(ID, at, 110); // a tie: impairment wins
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        voucher.setRig(ID, at + 1, 110);
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
    }

    function test_R3_05_aNewerFreshSaneHealthyReportOvertakesRowB() public {
        (RigAgent a, uint64 floor) = _expired();
        feed.set(_impairedAt(floor + 1 hours));
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        feed.set(_healthyAt(uint64(block.timestamp)));
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
    }

    function test_R3_05_rowB_floorAndBaseBoundaries() public {
        (RigAgent a, uint64 floor) = _expired();
        voucher.setRig(ID, floor, 110);
        feed.set(_impairedAt(floor - 1)); // before the floor: not a candidate, the record clears
        uint256 snap = vm.snapshotState();
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
        vm.revertToState(snap);
        feed.set(_impairedAt(uint64(block.timestamp + 61))); // dated too far ahead: no base(r)
        snap = vm.snapshotState();
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
        vm.revertToState(snap);
        feed.set(_impairedAt(floor)); // at the floor; a tie with the record: impairment wins
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
    }

    /// Row H keeps the age bound: a healthy report alone clears at age 300 and not at 301.
    function test_R3_05_rowH_keepsTheAgeBound() public {
        (RigAgent a,) = _expired();
        feed.set(_healthyAt(uint64(block.timestamp - 301)));
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        feed.set(_healthyAt(uint64(block.timestamp - 300)));
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
    }

    /// Row B has no enable floor: an impaired report observed during a brake keeps blocking after
    /// the re-enable, until a newer reading lands. Fail-closed and intended (R3-00).
    function test_R3_05_rowB_aBrakeTimeImpairedReportBlocksAfterReEnable() public {
        (RigAgent a, uint64 floor) = _expired();
        voucher.setRig(ID, floor, 110);
        vm.prank(guardian);
        pool.disableFeed();
        vm.warp(block.timestamp + 1 hours);
        feed.set(_impairedAt(uint64(block.timestamp))); // observed during the brake
        // while the feed is off no report row applies: the record decides
        uint256 snap = vm.snapshotState();
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
        vm.revertToState(snap);
        vm.warp(block.timestamp + 10 minutes);
        vm.prank(owner);
        pool.enableFeed();
        uint64 enableFloor = uint64(block.timestamp + 60);
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        feed.set(_impairedAt(enableFloor - 1)); // row B ignores the enable floor
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        // a newer reading overtakes it: a record synced after the report, or a row H report
        snap = vm.snapshotState();
        voucher.setRig(ID, enableFloor, 110);
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
        vm.revertToState(snap);
        feed.set(_healthyAt(enableFloor));
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
    }

    /// A dead feed: only a newer voucher record can clear; a rescued rig that never syncs stays
    /// doubtful.
    function test_R3_05_deadFeedOnlyANewerRecordClears() public {
        (RigAgent a, uint64 floor) = _expired();
        RigReport memory rescued = _rescuedReport(ID);
        rescued.observedAt = floor + 1 hours;
        feed.set(rescued);
        vm.warp(block.timestamp + 30 days); // no report since
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        voucher.setRig(ID, floor + 1 hours + 1, 110);
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
    }

    // ───────────────────────── row U, the brake-time mask (SPEC-REDEPLOY-3 v4)

    /// Brake after the flag expired, then re-enable; returns the enable floor.
    function _brakeAndEnable() internal returns (uint64 enableFloor) {
        vm.prank(guardian);
        pool.disableFeed();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(owner);
        pool.enableFeed();
        enableFloor = uint64(block.timestamp + 60);
    }

    /// The final audit's L-01: a stored impaired report blocks; a report observed during the brake that
    /// decodes as healthy overwrites it in the receiver; after re-enable the older positive record must
    /// not clear the flag. A row H report, or a record synced after the masking report, still clears.
    function test_R3_05_rowU_aBrakeTimeHealthyReportCannotUnmaskAnOlderPositiveRecord() public {
        (RigAgent a, uint64 floor) = _expired();
        voucher.setRig(ID, floor, 110); // an older positive record
        feed.set(_impairedAt(floor + 1 hours)); // the stored impaired report blocks
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        vm.prank(guardian);
        pool.disableFeed();
        vm.warp(block.timestamp + 30 minutes);
        uint64 masked = uint64(block.timestamp);
        feed.set(_healthyAt(masked)); // garbage that decodes as healthy, observed during the brake
        vm.warp(block.timestamp + 30 minutes);
        vm.prank(owner);
        pool.enableFeed();
        uint64 enableFloor = uint64(block.timestamp + 60);
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        assertEq(pool.doubtfulOf(address(a)), BEM, "the dead loan stays out of the share price");

        uint256 snap = vm.snapshotState();
        feed.set(_healthyAt(enableFloor)); // row H
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
        vm.revertToState(snap);
        voucher.setRig(ID, masked + 1, 110); // a record synced after the masking report
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
    }

    /// Row U against row H at the enable floor, over an older positive record.
    function test_R3_05_rowU_enableFloorBoundary() public {
        (RigAgent a, uint64 floor) = _expired();
        voucher.setRig(ID, floor, 110);
        uint64 enableFloor = _brakeAndEnable();
        feed.set(_healthyAt(enableFloor - 1));
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        feed.set(_healthyAt(enableFloor));
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
    }

    /// Row U with a record synced at the same second, and one second later. On the flagged rig a tie
    /// never clears; one second later the record decides.
    function test_R3_05_rowU_recordAtTheSameSecondAndOneLaterOnTheFlaggedRig() public {
        (RigAgent a,) = _expired();
        uint64 enableFloor = _brakeAndEnable();
        uint64 u = enableFloor - 1;
        feed.set(_healthyAt(u));
        voucher.setRig(ID, u, 110); // tie, positive: missing
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        voucher.setRig(ID, u, 0); // tie, power 0: impaired
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        voucher.setRig(ID, u + 1, 0); // newer, power 0: impaired
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        voucher.setRig(ID, u + 1, 110); // newer, positive: healthy
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
    }

    /// On a rig other than the flagged one, row U reads as missing and does not block, unless a
    /// power-0 record ties with it, is newer or is older (impaired: unknown masks only health, L-04).
    function test_R3_05_rowU_onAnotherRigBlocksOnlyWhenTheRecordIsImpaired() public {
        RigAgent a = _ready(alice, ID);
        _rig(alice, 8, 100);
        _pledge(a, alice, 8);
        _borrow(a, alice, 0, BEM);
        vm.warp(block.timestamp + 1 hours);
        feed.set(_impairedAt(uint64(block.timestamp)));
        a.flagImpaired(ID);
        vm.warp(pool.expiryOf(a.loanOf().impairedAt) + 1 hours);
        uint64 enableFloor = _brakeAndEnable();
        feed.set(_healthyAt(enableFloor)); // the flagged rig: row H
        RigReport memory other = _report(8, 100);
        uint64 u = enableFloor - 1;
        other.observedAt = u;
        feed.set(other); // rig 8: row U
        uint8[5] memory powers = [uint8(110), 0, 0, 110, 0];
        uint64[5] memory synced = [u, u, u + 1, u + 1, u - 1];
        bool[5] memory clears = [true, false, false, true, false];
        for (uint256 i; i < 5; ++i) {
            uint256 snap = vm.snapshotState();
            voucher.setRig(8, synced[i], powers[i]);
            if (clears[i]) {
                a.clearExpiredFlag();
                assertEq(pool.doubtful(), 0, vm.toString(i));
            } else {
                vm.expectRevert(RigAgent.NoHealthEvidence.selector);
                a.clearExpiredFlag();
            }
            vm.revertToState(snap);
        }
    }
}
