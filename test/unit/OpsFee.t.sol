// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Base} from "./Base.t.sol";
import {Reasons} from "../../src/interfaces/ICreditPolicy.sol";
import {TapePool} from "../../src/TapePool.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {TapeLens} from "../../src/TapeLens.sol";

/// An owner contract that refuses OKB.
contract RejectingOwner {
    function accept(TapePool pool) external {
        pool.acceptOwnership();
    }
}

/// An owner contract whose receive hook tries to re-enter the agent through its permissionless
/// functions, records each revert, and accepts the OKB.
contract ReenteringOwner {
    RigAgent public agent;
    uint256 public rigId;
    bytes[] public reasons;

    function accept(TapePool pool, RigAgent agent_, uint256 rigId_) external {
        agent = agent_;
        rigId = rigId_;
        pool.acceptOwnership();
    }

    receive() external payable {
        try agent.sweep() {}
        catch (bytes memory r) {
            reasons.push(r);
        }
        try agent.repay(0) {}
        catch (bytes memory r) {
            reasons.push(r);
        }
        try agent.flagImpaired(rigId) {}
        catch (bytes memory r) {
            reasons.push(r);
        }
    }

    function reasonCount() external view returns (uint256) {
        return reasons.length;
    }
}

/// The operating fee in OKB that `borrow` carries (SPEC-PHASE3-OPSFEE §4, §7).
contract OpsFeeTest is Base {
    uint256 constant ID = 7;
    uint256 constant PAID_OPS = 0.031 ether;

    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        pool.queueParam(TapePool.Param.OpsFee7d, PAID_OPS);
        pool.queueParam(TapePool.Param.OpsFee14d, PAID_OPS);
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours);
        pool.executeParam(TapePool.Param.OpsFee7d);
        pool.executeParam(TapePool.Param.OpsFee14d);
    }

    event OpsFeePaid(address indexed agent, uint8 term, uint256 amount, address indexed to);

    function test_queued_fee_and_term_codes() public {
        assertEq(pool.opsFee(0), PAID_OPS);
        assertEq(pool.opsFee(1), PAID_OPS);
        assertEq(pool.MAX_OPS_FEE(), 0.5 ether);
        vm.expectRevert(abi.encodeWithSelector(TapePool.BadTerm.selector, uint8(2)));
        pool.opsFee(2);
    }

    function test_only_the_exact_fee_borrows() public {
        RigAgent a = _ready(alice, ID);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.WrongOpsFee.selector, PAID_OPS));
        a.borrow{value: PAID_OPS - 1}(0, BEM, type(uint256).max, type(uint16).max);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.WrongOpsFee.selector, PAID_OPS));
        a.borrow{value: PAID_OPS + 1}(0, BEM, type(uint256).max, type(uint16).max);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.WrongOpsFee.selector, PAID_OPS));
        a.borrow(0, BEM, type(uint256).max, type(uint16).max);
    }

    function test_fee_goes_to_the_owner_and_nothing_stays_in_the_agent() public {
        RigAgent a = _ready(alice, ID);
        uint256 ownerBefore = owner.balance;
        uint256 aliceBefore = alice.balance;
        vm.expectEmit(true, true, true, true, address(a));
        emit OpsFeePaid(address(a), 1, PAID_OPS, owner);
        _borrow(a, alice, 1, BEM);
        assertEq(owner.balance - ownerBefore, PAID_OPS, "owner received the fee");
        assertEq(aliceBefore - alice.balance, PAID_OPS, "borrower paid exactly the fee");
        assertEq(address(a).balance, 0, "agent keeps no OKB");
        assertEq(address(pool).balance, 0, "pool keeps no OKB");
    }

    function test_a_revert_after_the_value_check_returns_the_fee() public {
        RigAgent a = _ready(alice, ID);
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.PolicyDenied.selector, Reasons.DENIED));
        a.borrow{value: PAID_OPS}(0, 3 * BEM, type(uint256).max, type(uint16).max); // over 85% of expected output
        assertEq(alice.balance, aliceBefore, "nothing taken");
        assertEq(owner.balance, 0, "nothing sent");
    }

    function test_zero_fee_makes_no_call_and_no_event() public {
        _queueExecute(TapePool.Param.OpsFee7d, 0);
        RigAgent a = _ready(alice, ID);
        uint256 aliceBefore = alice.balance;
        vm.recordLogs();
        vm.prank(alice);
        a.borrow(0, BEM, type(uint256).max, type(uint16).max);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertGt(logs.length, 0, "the borrow emitted its usual events");
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != RigAgent.OpsFeePaid.selector, "no OpsFeePaid");
        }
        assertEq(owner.balance, 0, "no OKB moved");
        assertEq(alice.balance, aliceBefore);
    }

    function test_new_owner_receives_the_next_fee() public {
        address next = makeAddr("next-owner");
        vm.prank(owner);
        pool.transferOwnership(next);
        vm.prank(next);
        pool.acceptOwnership();
        RigAgent a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        assertEq(next.balance, PAID_OPS);
        assertEq(owner.balance, 0);
    }

    function test_an_owner_that_rejects_okb_blocks_borrows() public {
        RejectingOwner r = new RejectingOwner();
        vm.prank(owner);
        pool.transferOwnership(address(r));
        r.accept(pool);
        RigAgent a = _ready(alice, ID);
        vm.prank(alice);
        vm.expectRevert(RigAgent.OpsFeeTransferFailed.selector);
        a.borrow{value: PAID_OPS}(0, BEM, type(uint256).max, type(uint16).max);
    }

    function test_the_owner_cannot_reenter_the_agent_from_its_receive_hook() public {
        RigAgent a = _ready(alice, ID);
        ReenteringOwner r = new ReenteringOwner();
        vm.prank(owner);
        pool.transferOwnership(address(r));
        r.accept(pool, a, ID);
        _borrow(a, alice, 0, BEM);
        // the hook ran inside borrow: every permissionless entry point hit the reentrancy lock
        assertEq(r.reasonCount(), 3);
        bytes memory locked = abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        for (uint256 i; i < 3; ++i) {
            assertEq(r.reasons(i), locked);
        }
        assertEq(address(r).balance, PAID_OPS);
        assertTrue(a.loanOf().open);
    }

    function test_force_sent_okb_does_not_change_what_borrow_forwards() public {
        RigAgent a = _ready(alice, ID);
        vm.deal(address(a), 1 ether); // like a selfdestruct send
        _borrow(a, alice, 0, BEM);
        assertEq(owner.balance, PAID_OPS, "exactly the fee");
        assertEq(address(a).balance, 1 ether, "the forced balance stays where it was sent");
    }

    function test_fee_changes_go_through_the_queue_within_bounds() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TapePool.OutOfBounds.selector, TapePool.Param.OpsFee14d, 0.5 ether + 1));
        pool.queueParam(TapePool.Param.OpsFee14d, 0.5 ether + 1);
        vm.prank(owner);
        pool.queueParam(TapePool.Param.OpsFee14d, 0.2 ether);
        assertEq(pool.opsFee(1), PAID_OPS, "not before the delay");
        vm.warp(block.timestamp + pool.TIMELOCK());
        pool.executeParam(TapePool.Param.OpsFee14d);
        assertEq(pool.opsFee(1), 0.2 ether);
        assertEq(pool.opsFee(0), PAID_OPS, "the other term is untouched");
        assertEq(pool.reserveCapBps(), 500, "no other parameter written");
    }

    function test_lens_reports_the_fee_for_every_reason_and_never_reverts_on_a_bad_term() public {
        RigAgent a = _ready(alice, ID);
        TapeLens.Quote memory ok = lens.quote(a, 1);
        assertEq(ok.reason, Reasons.OK);
        assertEq(ok.opsFee, PAID_OPS);
        vm.prank(guardian);
        pool.pauseBorrows();
        TapeLens.Quote memory paused = lens.quote(a, 0);
        assertTrue(paused.reason != Reasons.OK);
        assertEq(paused.opsFee, PAID_OPS, "shown even when the borrow is blocked");
        TapeLens.Quote memory bad = lens.quote(a, 2);
        assertEq(bad.reason, Reasons.BAD_TERM);
        assertEq(bad.opsFee, 0);
    }
}
