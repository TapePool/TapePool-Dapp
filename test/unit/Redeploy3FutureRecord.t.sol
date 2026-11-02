// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {RigAgent} from "../../src/RigAgent.sol";

/// Redeploy 3, R3-03: a voucher record with `syncedAt > now + MAX_CLOCK_SKEW` is unknown (R3-00
/// known), for path (b) evidence (row VE) and for the clear (row VC). Mocks only.
contract Redeploy3FutureRecordTest is Base {
    uint256 constant ID = 7;

    function _loan() internal returns (RigAgent a) {
        a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        vm.warp(block.timestamp + 1 hours);
        feed.clear(ID); // no report: path (b) decides alone
    }

    function test_R3_03_rowVE_recordAtNowPlus60IsKnownAndAtNowPlus61IsNot() public {
        RigAgent a = _loan();
        voucher.setRig(ID, uint64(block.timestamp + 61), 0);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
        voucher.setRig(ID, uint64(block.timestamp + 60), 0);
        a.flagImpaired(ID);
        assertEq(pool.doubtfulOf(address(a)), BEM);
    }

    function test_R3_03_rowVC_futureRecordIsMissingNotHealth() public {
        RigAgent a = _loan();
        voucher.setRig(ID, uint64(block.timestamp), 0);
        a.flagImpaired(ID);
        vm.warp(pool.expiryOf(a.loanOf().impairedAt));
        voucher.setRig(ID, uint64(block.timestamp + 61), 110);
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        voucher.setRig(ID, uint64(block.timestamp + 60), 110);
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
    }

    /// A record dated four days ahead flags only once its date is within the skew, as a record synced
    /// then, and it cannot also be the seize evidence of that flag.
    function test_R3_03_recordFourDaysAheadFlagsOnlyWhenItsDateArrivesAndDoesNotSeize() public {
        RigAgent a = _loan();
        uint64 dated = uint64(block.timestamp + 4 days);
        voucher.setRig(ID, dated, 0);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
        vm.warp(uint256(dated) - 61);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
        vm.warp(uint256(dated) - 60);
        a.flagImpaired(ID);
        uint64 t = a.loanOf().impairedAt;
        vm.warp(a.seizeEvidenceFrom());
        assertGt(a.seizeEvidenceFrom(), dated);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.seize();
        vm.warp(a.loanOf().deadline);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.seize();
        assertEq(voucher.ownerOf(ID), address(a));
        assertEq(t, dated - 60);
    }

    /// The accepted residual (O3-2, case 2): a record dated into the seize window and written during
    /// the cure window becomes admissible inside that window and then serves as seize evidence for a
    /// flag set on other evidence. Writing it needs a voucher upgrade (B9).
    function test_R3_03_residual_recordDatedIntoTheSeizeWindowCountsOnceItsDateArrives() public {
        RigAgent a = _loan();
        feed.set(_rescuedReport(ID));
        a.flagImpaired(ID); // flagged on a report
        feed.clear(ID);
        vm.warp(block.timestamp + 1 days); // inside the cure window
        uint64 dated = a.seizeEvidenceFrom() + 1 hours;
        voucher.setRig(ID, dated, 0);
        vm.warp(a.seizeEvidenceFrom());
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.seize(); // still more than 60 s ahead
        vm.warp(uint256(dated) - 60);
        a.seize();
        assertTrue(a.closed());
    }
}
