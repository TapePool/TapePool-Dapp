// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RigScreen, IPoolAuthority} from "../../src/RigScreen.sol";
import {PolicyBase} from "./PolicyBase.t.sol";

/// `RigScreen` (SPEC §7.3, SPEC-PHASE3 §3): authority read from the pool, the 48 h delay,
/// suspension, revocation and field matching.
contract RigScreenTest is PolicyBase {
    uint256 constant RIG = 5;
    uint64 constant CID = 1005;
    uint32 constant TASK = 4;
    address stranger = makeAddr("stranger");

    function _record() internal {
        vm.prank(owner);
        screen.recordPass(RIG, CPU_TAPEOUT, CID, TASK, ARTIFACT);
    }

    function _effective() internal view returns (bool) {
        return screen.isEffective(RIG, CPU_TAPEOUT, CID, TASK);
    }

    function test_authority() public {
        vm.prank(stranger);
        vm.expectRevert(RigScreen.NotOwner.selector);
        screen.recordPass(RIG, CPU_TAPEOUT, CID, TASK, ARTIFACT);
        vm.prank(guardian);
        vm.expectRevert(RigScreen.NotOwner.selector);
        screen.recordPass(RIG, CPU_TAPEOUT, CID, TASK, ARTIFACT);

        vm.prank(stranger);
        vm.expectRevert(RigScreen.NotGuardianOrOwner.selector);
        screen.suspendPass(RIG);
        vm.prank(guardian);
        screen.suspendPass(RIG);
        vm.prank(owner);
        screen.suspendPass(RIG);

        vm.prank(guardian);
        vm.expectRevert(RigScreen.NotOwner.selector);
        screen.liftSuspension(RIG);
        vm.prank(guardian);
        vm.expectRevert(RigScreen.NotOwner.selector);
        screen.revokePass(RIG);
    }

    function test_roles_follow_the_pool() public {
        address newGuardian = makeAddr("newGuardian");
        vm.prank(owner);
        pool.setGuardian(newGuardian);
        vm.prank(guardian);
        vm.expectRevert(RigScreen.NotGuardianOrOwner.selector);
        screen.suspendPass(RIG);
        vm.prank(newGuardian);
        screen.suspendPass(RIG);

        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        pool.transferOwnership(newOwner);
        vm.prank(newOwner);
        pool.acceptOwnership();
        vm.prank(owner);
        vm.expectRevert(RigScreen.NotOwner.selector);
        screen.liftSuspension(RIG);
        vm.prank(newOwner);
        screen.liftSuspension(RIG);
    }

    function test_delay_boundary_and_event() public {
        uint64 eta = uint64(block.timestamp + 48 hours);
        vm.expectEmit(address(screen));
        emit RigScreen.ScreenPassAdded(RIG, CPU_TAPEOUT, CID, TASK, ARTIFACT, eta);
        _record();
        vm.warp(eta - 1);
        assertFalse(_effective(), "one second early");
        vm.warp(eta);
        assertTrue(_effective(), "at effectiveAt");
    }

    function test_rerecord_resets_the_delay_and_keeps_a_suspension() public {
        _record();
        vm.warp(block.timestamp + 48 hours);
        assertTrue(_effective());
        _record();
        assertFalse(_effective(), "delay reset");
        vm.warp(block.timestamp + 48 hours);
        vm.prank(guardian);
        screen.suspendPass(RIG);
        _record();
        vm.warp(block.timestamp + 48 hours);
        assertFalse(_effective(), "suspension survives re-recording");
        vm.prank(owner);
        screen.liftSuspension(RIG);
        assertTrue(_effective());
    }

    function test_revoke_clears_the_pass_and_the_suspension() public {
        _record();
        vm.prank(guardian);
        screen.suspendPass(RIG);
        vm.prank(owner);
        screen.revokePass(RIG);
        (RigScreen.Pass memory p, bool isSuspended) = screen.passOf(RIG);
        assertEq(p.effectiveAt, 0);
        assertFalse(isSuspended);
        vm.warp(block.timestamp + 48 hours);
        assertFalse(_effective(), "no pass");
        _record();
        assertFalse(_effective(), "a new record waits the full delay");
        vm.warp(block.timestamp + 48 hours);
        assertTrue(_effective());
    }

    function test_suspend_before_record_then_lift() public {
        vm.prank(guardian);
        screen.suspendPass(RIG);
        _record();
        vm.warp(block.timestamp + 48 hours);
        assertFalse(_effective(), "born suspended");
        vm.prank(owner);
        screen.liftSuspension(RIG);
        assertTrue(_effective());
    }

    function test_fields_must_match() public {
        _record();
        vm.warp(block.timestamp + 48 hours);
        assertFalse(screen.isEffective(RIG, CPU_BEHEMOTH, CID, TASK));
        assertFalse(screen.isEffective(RIG, CPU_TAPEOUT, CID + 1, TASK));
        assertFalse(screen.isEffective(RIG, CPU_TAPEOUT, CID, TASK + 1));
        assertFalse(screen.isEffective(RIG + 1, CPU_TAPEOUT, CID, TASK));
    }

    function test_bad_pass_rejected() public {
        vm.startPrank(owner);
        vm.expectRevert(RigScreen.BadPass.selector);
        screen.recordPass(RIG, address(0), CID, TASK, ARTIFACT);
        vm.expectRevert(RigScreen.BadPass.selector);
        screen.recordPass(RIG, CPU_TAPEOUT, CID, TASK, bytes32(0));
        vm.stopPrank();
    }

    function test_setters_revert_until_the_pool_has_code() public {
        RigScreen early = new RigScreen(IPoolAuthority(makeAddr("not-yet-deployed")));
        vm.prank(owner);
        vm.expectRevert();
        early.recordPass(RIG, CPU_TAPEOUT, CID, TASK, ARTIFACT);
        vm.prank(guardian);
        vm.expectRevert();
        early.suspendPass(RIG);
        assertFalse(early.isEffective(RIG, CPU_TAPEOUT, CID, TASK), "views never read the pool");
    }

    function test_constructor_rejects_zero_pool() public {
        vm.expectRevert(RigScreen.ZeroAddress.selector);
        new RigScreen(IPoolAuthority(address(0)));
    }
}
