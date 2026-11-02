// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IRigVoucher} from "../../src/interfaces/IXLayer.sol";
import {Reasons} from "../../src/interfaces/ICreditPolicy.sol";
import {TapePool} from "../../src/TapePool.sol";
import {AgentFactory} from "../../src/AgentFactory.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {TapeLens} from "../../src/TapeLens.sol";
import {MockCreditPolicy} from "../mocks/Mocks.sol";

/// Cases added after audit round 1: lost collateral, a voucher with a changed `rigs` answer,
/// partial seizes, re-borrowing, lender exits while a loan is doubtful, and lens robustness.
contract EdgeCasesTest is Base {
    uint256 constant ID = 7;

    event CollateralRemoved(address indexed agent, uint256 indexed id);
    event Released(address indexed agent, uint256[] ids);
    event VouchersForwarded(address indexed agent, uint256[] ids);

    function _loan(address who, uint256 id, uint256 principal) internal returns (RigAgent a) {
        a = _ready(who, id);
        _borrow(a, who, 0, principal);
    }

    function _flagAndWait(RigAgent a, uint256 id) internal {
        vm.warp(block.timestamp + 1 hours);
        feed.set(_rescuedReport(id));
        a.flagImpaired(id);
        vm.warp(block.timestamp + 72 hours);
        feed.set(_rescuedReport(id));
    }

    // ───────────────────────── round 1, finding 1: collateral the agent lost

    function test_withdraw_prunes_an_id_the_agent_no_longer_owns() public {
        RigAgent a = _ready(alice, ID);
        _rig(alice, 8, 10);
        _pledge(a, alice, 8);
        vm.prank(address(a)); // a voucher-side action moves id 8 out
        voucher.transferFrom(address(a), bob, 8);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.NotOwned.selector, 8));
        a.borrow{value: OPS}(0, BEM, type(uint256).max, type(uint16).max);

        vm.prank(alice);
        a.withdrawVoucher(8); // only drops it from the set
        assertEq(voucher.ownerOf(8), bob);
        assertEq(a.collateralOf().length, 1);
        _borrow(a, alice, 0, BEM); // the agent works again
        assertTrue(a.hasLoan());
    }

    function test_release_skips_an_id_the_agent_no_longer_owns() public {
        RigAgent a = _ready(alice, ID);
        _rig(alice, 8, 10);
        _pledge(a, alice, 8);
        voucher.burn(8); // gone entirely: ownerOf reverts
        uint256[] memory sent = new uint256[](1);
        sent[0] = ID;
        vm.expectEmit(address(a));
        emit Released(address(a), sent);
        vm.prank(alice);
        a.release();
        assertEq(voucher.ownerOf(ID), alice);
        assertEq(a.collateralOf().length, 1);
        vm.prank(alice);
        a.forget(8);
        assertEq(a.collateralOf().length, 0);
    }

    function test_N03_releaseEmitsRemovalForIdAlreadyAtBorrower() public {
        RigAgent a = _ready(alice, ID);
        _rig(alice, 8, 10);
        _pledge(a, alice, 8);
        vm.prank(address(a));
        voucher.transferFrom(address(a), alice, ID);

        uint256[] memory sent = new uint256[](1);
        sent[0] = 8;
        vm.expectEmit(address(a));
        emit CollateralRemoved(address(a), ID);
        vm.expectEmit(address(a));
        emit Released(address(a), sent);
        vm.prank(alice);
        a.release();

        assertEq(a.collateralOf().length, 0);
        assertEq(voucher.ownerOf(ID), alice);
        assertEq(voucher.ownerOf(8), alice);
    }

    function test_N03_forwardVouchersEmitsRemovalForIdAlreadyAtPool() public {
        RigAgent a = _loan(alice, ID, BEM);
        _flagAndWait(a, ID);
        voucher.setBlocked(ID, true);
        a.seize();
        assertTrue(a.closed());
        assertEq(a.collateralOf().length, 1);
        voucher.setBlocked(ID, false);
        vm.prank(address(a));
        voucher.transferFrom(address(a), address(pool), ID);

        vm.expectEmit(address(a));
        emit CollateralRemoved(address(a), ID);
        vm.expectEmit(address(a));
        emit VouchersForwarded(address(a), new uint256[](0));
        a.forwardVouchers();

        assertEq(a.collateralOf().length, 0);
        assertEq(voucher.ownerOf(ID), address(pool));
    }

    // ───────────────────────── round 1, finding 2: a changed `rigs` answer

    function test_broken_voucher_record_reads_as_unknown() public {
        RigAgent a = _loan(alice, ID, BEM);
        vm.warp(block.timestamp + 1 hours);
        voucher.setBadRigs(true);
        _refresh(ID, 100);
        vm.expectRevert(RigAgent.NoEvidence.selector); // not a decoding revert
        a.flagImpaired(ID);
        vm.prank(guardian);
        pool.disableFeed();
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
        vm.prank(owner);
        pool.enableFeed();
        // report evidence still works while the voucher answers garbage
        feed.set(_rescuedReport(ID));
        a.flagImpaired(ID);
        vm.warp(block.timestamp + 72 hours);
        feed.set(_rescuedReport(ID));
        a.seize();
        assertEq(voucher.ownerOf(ID), address(pool));
    }

    function test_broken_voucher_record_does_not_block_clearing_a_flag() public {
        RigAgent a = _loan(alice, ID, BEM);
        feed.set(_rescuedReport(ID));
        a.flagImpaired(ID);
        voucher.setBadRigs(true);
        vm.warp(block.timestamp + 96 hours + 1);
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        _refresh(ID, 100);
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
    }

    // ───────────────────────── round 1, finding 5: coverage

    function test_reborrow_on_the_same_agent_after_repayment() public {
        RigAgent a = _loan(alice, ID, BEM);
        _harvest(address(a), 2 * BEM);
        a.sweep();
        assertFalse(a.hasLoan());
        vm.warp(block.timestamp + 1 days);
        _refresh(ID, 100);
        _borrow(a, alice, 1, 2 * BEM);
        RigAgent.LoanView memory v = a.loanOf();
        assertEq(v.term, 1);
        assertEq(v.principal, 2 * BEM);
        assertEq(v.impairedAt, 0);
        assertEq(pool.loanPrincipalOf(address(a)), 2 * BEM);
    }

    function test_lender_exits_at_the_marked_price_while_doubtful() public {
        RigAgent a = _loan(alice, ID, 2 * BEM);
        feed.set(_rescuedReport(ID));
        a.flagImpaired(ID);
        assertEq(pool.totalAssets(), 18 * BEM);
        uint256 half = pool.balanceOf(lp) / 2;
        vm.prank(lp);
        uint256 out = pool.redeem(half, lp, lp);
        assertApproxEqAbs(out, 9 * BEM, 1, "half the shares buy half the marked assets");
        assertApproxEqAbs(pool.maxWithdraw(lp), 9 * BEM, 1, "the rest is withdrawable at the same price");
        assertLe(pool.maxWithdraw(lp), pool.idle());
    }

    function test_partial_seize_keeps_order_then_forward() public {
        RigAgent a = _ready(alice, 2);
        _rig(alice, 1, 10);
        _rig(alice, 3, 10);
        _pledge(a, alice, 1);
        _pledge(a, alice, 3);
        _borrow(a, alice, 0, BEM);
        _flagAndWait(a, 2);
        voucher.setBlocked(1, true);
        voucher.setBlocked(3, true);
        a.seize();
        uint256[] memory left = a.collateralOf();
        assertEq(left.length, 2);
        assertEq(left[0], 1);
        assertEq(left[1], 3);
        assertEq(voucher.ownerOf(2), address(pool));
        voucher.setBlocked(3, false);
        a.forwardVouchers();
        left = a.collateralOf();
        assertEq(left.length, 1);
        assertEq(left[0], 1);
        assertEq(voucher.ownerOf(3), address(pool));
        voucher.setBlocked(1, false);
        a.forwardVouchers();
        assertEq(a.collateralOf().length, 0);
        assertEq(voucher.ownerOf(1), address(pool));
    }

    function test_seize_of_16_vouchers_gas() public {
        _deposit(lp, 20 * BEM);
        RigAgent a = _agent(alice, 0);
        for (uint256 i = 1; i <= 16; ++i) {
            _rig(alice, i, 10);
            _pledge(a, alice, i);
        }
        _borrow(a, alice, 0, BEM);
        _flagAndWait(a, 1);
        uint256 g = gasleft();
        a.seize();
        uint256 used = g - gasleft();
        console2.log("gas seize, 16 vouchers (mock voucher)", used);
        assertLt(used, 4_000_000);
        for (uint256 i = 1; i <= 16; ++i) {
            assertEq(voucher.ownerOf(i), address(pool));
        }
    }

    /// SPEC §10.5 as written: re-enabling the feed gives every earlier flag at least 24 h of seize
    /// window, even a flag that had already expired. Seize still needs new evidence.
    function test_enable_feed_keeps_an_expired_flag_expired() public {
        RigAgent a = _loan(alice, ID, BEM);
        feed.set(_rescuedReport(ID));
        a.flagImpaired(ID);
        uint256 t = block.timestamp;
        vm.warp(t + 100 hours);
        assertTrue(a.loanOf().expired);
        vm.prank(guardian);
        pool.disableFeed();
        vm.prank(owner);
        pool.enableFeed();
        assertTrue(a.loanOf().expired);
        assertEq(a.loanOf().deadline, t + 96 hours);
    }

    // ───────────────────────── round 1, finding 6: deny with an OK reason

    function test_deny_with_ok_reason_reports_mismatch() public {
        RigAgent a = _ready(alice, ID);
        policy.setMode(MockCreditPolicy.Mode.DenyWithOk);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.PolicyDenied.selector, Reasons.MISMATCH));
        a.borrow{value: OPS}(0, BEM, type(uint256).max, type(uint16).max);
        assertEq(lens.quote(a, 0).reason, Reasons.MISMATCH);
    }

    // ───────────────────────── round 1, finding 4: the lens never reverts on bad parts

    function test_quote_survives_a_burned_voucher_and_a_broken_feed() public {
        RigAgent a = _ready(alice, ID);
        _rig(alice, 8, 10);
        _pledge(a, alice, 8);
        voucher.burn(8);
        assertEq(lens.quote(a, 0).reason, Reasons.NO_COLLATERAL);

        RigAgent b = _ready(bob, 9);
        feed.setBroken(true); // the mock policy reads the feed too, so it reverts
        TapeLens.Quote memory q = lens.quote(b, 0);
        assertEq(q.reason, Reasons.EVAL);
        assertEq(q.pending, 0);
        assertEq(q.maxPrincipal, 0);
    }

    // ───────────────────────── round 1, finding 16: separate keys

    function test_pool_rejects_guardian_equal_to_owner() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        AgentFactory f = new AgentFactory(predicted, IRigVoucher(address(voucher)), IERC20(address(bem)), feed);
        vm.expectRevert(TapePool.GuardianIsOwner.selector);
        new TapePool(IERC20(address(bem)), f, policy, owner, owner, lp);
        vm.prank(owner);
        vm.expectRevert(TapePool.GuardianIsOwner.selector);
        pool.setGuardian(owner);
    }
}
