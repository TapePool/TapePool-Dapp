// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {Reasons} from "../../src/interfaces/ICreditPolicy.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {TapeLens} from "../../src/TapeLens.sol";
import {CreditPolicy} from "../../src/CreditPolicy.sol";
import {PolicyBase} from "./PolicyBase.t.sol";

/// A policy v2 stand-in: the same adapter reporting a higher version.
contract CreditPolicyV2 is CreditPolicy {
    constructor(Pins memory p) CreditPolicy(p) {}

    function version() external pure override returns (uint16) {
        return 2;
    }
}

/// The Phase 2 consumers (`TapePool`, `TapeLens`, `RigAgent`) with the real `CreditPolicy`
/// (SPEC-PHASE3 §7, review finding F6). Until now they only ever saw `MockCreditPolicy`.
contract PolicyIntegrationTest is PolicyBase {
    function setUp() public override {
        super.setUp();
        _legacyEconomics();
    }

    /// The pool's constructor ran its sanity probe (`check` on an empty list) in `setUp`.
    function test_pool_accepts_the_real_policy() public view {
        assertEq(address(pool.policy()), address(credit));
        (bool allow, uint8 reason,,) = credit.check(address(0), new uint256[](0), 0, 0);
        assertFalse(allow);
        assertEq(reason, Reasons.BAD_IDS);
    }

    function test_policy_swap_to_a_higher_version() public {
        CreditPolicyV2 v2 = new CreditPolicyV2(_pins(address(screen)));
        vm.prank(owner);
        pool.queuePolicy(v2);
        assertTrue(pool.borrowsPaused(), "a queued swap pauses borrows");
        vm.warp(block.timestamp + pool.POLICY_TIMELOCK());
        pool.activatePolicy();
        assertEq(address(pool.policy()), address(v2));
    }

    function test_same_version_is_rejected() public {
        CreditPolicy again = new CreditPolicy(_pins(address(screen)));
        vm.prank(owner);
        vm.expectRevert();
        pool.queuePolicy(again);
    }

    /// SPEC §8.2 numbers through the lens and a real borrow: 1 H rig, 7 days.
    function test_quote_max_principal_borrows_exactly_and_one_more_is_denied() public {
        _deposit(lp, 20 * BEM);
        RigAgent a = _agent(alice, 0);
        voucher.mint(alice, 16, 11);
        _pledge(a, alice, 16);
        RigAgent b = _agent(bob, 0);
        voucher.mint(bob, 17, 11);
        _pledge(b, bob, 17);
        vm.startPrank(owner);
        screen.recordPass(16, CPU_TAPEOUT, 1016, 4, ARTIFACT);
        screen.recordPass(17, CPU_TAPEOUT, 1017, 4, ARTIFACT);
        vm.stopPrank();
        vm.warp(block.timestamp + 2 days);
        feed.set(_report(16, 1));
        feed.set(_report(17, 1));

        TapeLens.Quote memory q = lens.quote(a, 0);
        assertEq(q.reason, Reasons.OK);
        assertEq(q.expected, 3_114_537);
        assertEq(q.maxPrincipal, 2_347_356, "debt limit 2,647,356 minus the 0.003 BEM minimum fee");

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.PolicyDenied.selector, Reasons.DENIED));
        b.borrow{value: OPS}(0, q.maxPrincipal + 1, type(uint256).max, type(uint16).max);

        _borrow(a, alice, 0, q.maxPrincipal);
        assertEq(bem.balanceOf(alice), q.maxPrincipal, "proceeds to the borrower");
        assertEq(lens.quote(a, 0).reason, Reasons.LOAN_OPEN);
    }

    function test_borrow_denied_without_a_screen_pass() public {
        RigAgent a = _ready(alice, 9);
        uint256 minAdvance = pool.minAdvance();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.PolicyDenied.selector, Reasons.DENIED));
        a.borrow{value: OPS}(0, minAdvance, type(uint256).max, type(uint16).max);
        assertEq(lens.quote(a, 0).maxPrincipal, 0);
    }

    function test_RA16_borrow16VouchersUnderFiveMillionGas() public {
        _deposit(lp, 20 * BEM);
        RigAgent a = _agent(alice, 99);
        for (uint256 id = 80; id < 96; ++id) {
            _rig(alice, id, 10);
            _pledge(a, alice, id);
            _screen(id, 10);
        }
        for (uint256 id = 80; id < 96; ++id) {
            _refresh(id, 10);
        }
        uint256 g = gasleft();
        _borrow(a, alice, 0, BEM);
        uint256 used = g - gasleft();
        console2.log("gas borrow, 16 vouchers, real policy", used);
        assertLt(used, 5_000_000);
    }
}
