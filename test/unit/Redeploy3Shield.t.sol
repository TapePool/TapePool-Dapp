// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";

/// Redeploy 3, R3-04: path (b) yields to a newer healthy report. A power-0 record is not row VE
/// evidence while a sane healthy report with base(r), observed at or after the enable floor and
/// strictly after the record's `syncedAt`, is stored (R3-00 row S, of any age, O3-5). Mocks only.
contract Redeploy3ShieldTest is Base {
    uint256 constant ID = 7;

    event ImpairmentFlagged(address indexed agent, uint256 indexed rigId, uint8 evidenceKind, uint64 impairedAt);

    function _loan() internal returns (RigAgent a) {
        a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        vm.warp(block.timestamp + 1 days);
    }

    function _healthyAt(uint64 at) internal view returns (RigReport memory r) {
        r = _report(ID, 100);
        r.observedAt = at;
    }

    /// A power-0 record synced at `synced` and a sane healthy report observed at `observed`.
    function _set(uint64 synced, uint64 observed) internal {
        voucher.setRig(ID, synced, 0);
        feed.set(_healthyAt(observed));
    }

    function test_R3_04_rowS_oneSecondNewerShieldsAndATieDoesNot() public {
        RigAgent a = _loan();
        uint64 t = uint64(block.timestamp);
        _set(t - 10, t - 9);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
        _set(t - 10, t - 10); // a tie: impairment wins
        vm.expectEmit(address(a));
        emit ImpairmentFlagged(address(a), ID, 2, t);
        a.flagImpaired(ID);
    }

    function test_R3_04_rowS_anInsaneHealthyReportDoesNotShield() public {
        RigAgent a = _loan();
        uint64 t = uint64(block.timestamp);
        _set(t - 10, t);
        RigReport memory r = _healthyAt(t);
        r.totalVerifWeight = r.verifWeight - 1; // insane, otherwise healthy
        feed.set(r);
        a.flagImpaired(ID);
        assertEq(pool.doubtfulOf(address(a)), BEM);
    }

    /// O3-5: a stale sane healthy report newer than the record still shields.
    function test_R3_04_rowS_aStaleHealthyReportNewerThanTheRecordShields() public {
        RigAgent a = _loan();
        uint64 t = uint64(block.timestamp);
        _set(t - 2 hours, t - 1 hours); // the report is 3,600 s old, far past MAX_REPORT_AGE
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
    }

    /// A newer power-0 record (synced after the report) is evidence again.
    function test_R3_04_rowS_aNewerPowerZeroRecordIsEvidenceAgain() public {
        RigAgent a = _loan();
        uint64 t = uint64(block.timestamp);
        _set(t - 10, t - 5);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
        voucher.setRig(ID, t - 4, 0);
        a.flagImpaired(ID);
        assertEq(pool.doubtfulOf(address(a)), BEM);
    }

    /// R3-00 last bullet: the enable floor applies to row S, so a shield resets at every re-enable.
    function test_R3_04_rowS_aReportBelowTheEnableFloorDoesNotShield() public {
        RigAgent a = _loan();
        vm.prank(guardian);
        pool.disableFeed();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(owner);
        pool.enableFeed();
        uint64 enableFloor = uint64(block.timestamp + 60);
        uint64 synced = uint64(block.timestamp - 30 minutes);
        _set(synced, enableFloor - 1);
        uint256 snap = vm.snapshotState();
        a.flagImpaired(ID); // the shield observed before the floor does not count
        assertEq(pool.doubtfulOf(address(a)), BEM);
        vm.revertToState(snap);
        feed.set(_healthyAt(enableFloor));
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
    }

    /// A shield set before a brake stops counting at the re-enable, until a newer report lands.
    function test_R3_04_rowS_shieldResetsAtReEnable() public {
        RigAgent a = _loan();
        uint64 t = uint64(block.timestamp);
        _set(t - 10, t);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
        vm.prank(guardian);
        pool.disableFeed();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(owner);
        pool.enableFeed();
        uint256 snap = vm.snapshotState();
        a.flagImpaired(ID); // the record counts again from the enableFeed block
        assertEq(pool.doubtfulOf(address(a)), BEM);
        vm.revertToState(snap);
        feed.set(_healthyAt(uint64(block.timestamp + 60)));
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
    }

    /// While the feed is disabled, path (b) is unchanged: no report shields.
    function test_R3_04_feedDisabledPathBIsUnchanged() public {
        RigAgent a = _loan();
        uint64 t = uint64(block.timestamp);
        _set(t - 10, t);
        vm.prank(guardian);
        pool.disableFeed();
        a.flagImpaired(ID);
        assertEq(pool.doubtfulOf(address(a)), BEM);
    }

    /// Kind 1 is checked first, and a positive record never shields a path (a) report (R3-00).
    function test_R3_04_rowE_isCheckedFirstAndAPositiveRecordDoesNotShieldIt() public {
        RigAgent a = _loan();
        uint64 t = uint64(block.timestamp);
        RigReport memory bad = _rescuedReport(ID);
        bad.observedAt = t;
        feed.set(bad);
        voucher.setRig(ID, t + 30, 110); // newer, positive
        vm.expectEmit(address(a));
        emit ImpairmentFlagged(address(a), ID, 1, t);
        a.flagImpaired(ID);
    }

    /// An impaired report that fails row E (here stale) is not a shield either: the record decides.
    function test_R3_04_aStaleImpairedReportDoesNotShield() public {
        RigAgent a = _loan();
        uint64 t = uint64(block.timestamp);
        voucher.setRig(ID, t - 2 hours, 0);
        RigReport memory bad = _rescuedReport(ID);
        bad.observedAt = t - 1 hours;
        feed.set(bad);
        vm.expectEmit(address(a));
        emit ImpairmentFlagged(address(a), ID, 2, t);
        a.flagImpaired(ID);
    }

    /// Seize: a power-0 record at the seize floor yields to a newer healthy report; a newer power-0
    /// record or fresh report evidence seizes.
    function test_R3_04_seizeYieldsToANewerHealthyReport() public {
        RigAgent a = _loan();
        RigReport memory bad = _rescuedReport(ID);
        feed.set(bad);
        a.flagImpaired(ID);
        uint64 floor = a.seizeEvidenceFrom();
        vm.warp(uint256(floor) + 60);
        _set(floor, floor + 1);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.seize();
        voucher.setRig(ID, floor + 2, 0);
        a.seize();
        assertEq(voucher.ownerOf(ID), address(pool));
    }
}
