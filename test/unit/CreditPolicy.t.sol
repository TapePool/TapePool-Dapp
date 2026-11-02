// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Reasons} from "../../src/interfaces/ICreditPolicy.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {RigScreen} from "../../src/RigScreen.sol";
import {CreditPolicy} from "../../src/CreditPolicy.sol";
import {CreditMath} from "../../src/libraries/CreditMath.sol";
import {PolicyV1} from "../../src/libraries/PolicyV1.sol";
import {NandCircuits} from "../mocks/NandCircuits.sol";
import {IRigVoucher} from "../../src/interfaces/IXLayer.sol";
import {PolicyBase} from "./PolicyBase.t.sol";

/// `CreditPolicy` (SPEC-PHASE3 §4) on the NAND interpreter: reason order, each flag, fail-closed
/// reads, the maxDebt/check boundary and fuzzing that it never reverts.
contract CreditPolicyTest is PolicyBase {
    RigAgent agent;
    uint256 constant ID = 7;

    function setUp() public override {
        super.setUp();
        agent = _ready(alice, ID);
        _screen(ID, 100);
    }

    function _check(uint8 term, uint256 debt)
        internal
        view
        returns (bool allow, uint8 reason, uint16 bits, uint256 expected)
    {
        return credit.check(address(agent), _ids(ID), term, debt);
    }

    function _assertDenied(uint8 reason, uint256 flagBit) internal view {
        (bool allow, uint8 r, uint16 bits,) = _check(0, 1);
        assertFalse(allow);
        assertEq(r, reason);
        if (flagBit < 5) assertEq((_flags(bits) >> flagBit) & 1, 0, "flag cleared");
    }

    // ───────────────────────── happy path and boundary

    function test_allows_up_to_maxDebt_and_denies_one_above() public view {
        for (uint8 term; term <= 1; term++) {
            uint256 limit = credit.maxDebt(address(agent), _ids(ID), term);
            assertGt(limit, 0);
            (bool allow, uint8 reason, uint16 bits, uint256 expected) = _check(term, limit);
            assertTrue(allow);
            assertEq(reason, Reasons.OK);
            assertEq(_flags(bits), 31, "every flag set");
            assertEq(limit, CreditMath.maxDebt(expected, term));
            (allow, reason,,) = _check(term, limit + 1);
            assertFalse(allow);
            assertEq(reason, Reasons.DENIED);
        }
    }

    /// SPEC §8.2: rig #16-like, 1 H base, network 1,579,201, 7 d.
    function test_spec_example_one_h_rig() public {
        RigAgent a = _agent(bob, 0);
        voucher.mint(bob, 16, 11);
        _pledge(a, bob, 16);
        vm.prank(owner);
        screen.recordPass(16, CPU_TAPEOUT, 1016, 4, ARTIFACT);
        vm.warp(block.timestamp + 2 days);
        feed.set(_report(16, 1));
        (bool allow,,, uint256 expected) = credit.check(address(a), _ids(16), 0, 2_647_356);
        assertEq(expected, 3_114_537, "expected output");
        assertTrue(allow, "exact maximum");
        (allow,,,) = credit.check(address(a), _ids(16), 0, 2_647_357);
        assertFalse(allow, "one raw above");
        assertEq(credit.maxDebt(address(a), _ids(16), 0), 2_647_356);
    }

    function test_two_rigs_sum_expected_and_share_boundary() public {
        voucher.mint(alice, ID + 1, 60);
        _pledge(agent, alice, ID + 1);
        vm.prank(owner);
        screen.recordPass(ID + 1, CPU_TAPEOUT, uint64(ID + 1001), 4, ARTIFACT);
        vm.warp(block.timestamp + 2 days);
        _refresh(ID, 100);
        _refresh(ID + 1, 50);
        uint256[] memory ids = new uint256[](2);
        ids[0] = ID;
        ids[1] = ID + 1;
        uint256 limit = credit.maxDebt(address(agent), ids, 1);
        (bool allow,,, uint256 expected) = credit.check(address(agent), ids, 1, limit);
        assertTrue(allow);
        assertEq(
            expected,
            CreditMath.expectedOutput(100, NETWORK_WEIGHT, 1) + CreditMath.expectedOutput(50, NETWORK_WEIGHT, 1)
        );
        (allow,,,) = credit.check(address(agent), ids, 1, limit + 1);
        assertFalse(allow);

        // one bad rig fails the whole set
        RigReport memory r = _report(ID + 1, 50);
        r.status = 2;
        feed.set(r);
        (allow,,,) = credit.check(address(agent), ids, 1, 1);
        assertFalse(allow);
        assertEq(credit.maxDebt(address(agent), ids, 1), 0);
    }

    // ───────────────────────── reasons 1-3 come first and in order

    function test_bad_ids() public view {
        uint256[] memory empty = new uint256[](0);
        (bool allow, uint8 reason, uint16 bits, uint256 expected) = credit.check(address(agent), empty, 0, 1);
        assertFalse(allow);
        assertEq(reason, Reasons.BAD_IDS);
        assertEq(bits, 0);
        assertEq(expected, 0);

        uint256[] memory many = new uint256[](17);
        for (uint256 i; i < 17; i++) {
            many[i] = i + 1;
        }
        (, reason,,) = credit.check(address(agent), many, 0, 1);
        assertEq(reason, Reasons.BAD_IDS);

        uint256[] memory unsorted = new uint256[](2);
        unsorted[0] = 9;
        unsorted[1] = 8;
        (, reason,,) = credit.check(address(agent), unsorted, 0, 1);
        assertEq(reason, Reasons.BAD_IDS);

        uint256[] memory dup = new uint256[](2);
        dup[0] = ID;
        dup[1] = ID;
        (, reason,,) = credit.check(address(agent), dup, 0, 1);
        assertEq(reason, Reasons.BAD_IDS);
        assertEq(credit.maxDebt(address(agent), dup, 0), 0);
    }

    function test_emission_window() public {
        vm.warp(EMISSION_END - 7 days);
        _refresh(ID, 100);
        (, uint8 reason,,) = _check(0, 1);
        assertEq(reason, Reasons.EMISSION, "7 d reaches the end");
        vm.warp(EMISSION_END - 7 days - 1);
        _refresh(ID, 100);
        (, reason,,) = _check(0, 1);
        assertEq(reason, Reasons.OK, "7 d ends just before");
        (, reason,,) = _check(1, 1);
        assertEq(reason, Reasons.EMISSION, "14 d does not fit");
        (, reason,,) = _check(2, 1);
        assertEq(reason, Reasons.DENIED, "term 2 skips the emission step");
    }

    function test_pin_mismatch() public {
        NandCircuits.Mode[3] memory modes =
            [NandCircuits.Mode.ChangedNetlist, NandCircuits.Mode.ChangedInfo, NandCircuits.Mode.ShortInfo];
        for (uint256 i; i < modes.length; i++) {
            circuits.setMode(modes[i]);
            (bool allow, uint8 reason, uint16 bits,) = _check(0, 1);
            assertFalse(allow);
            assertEq(reason, Reasons.PIN);
            assertEq(bits, 0);
            assertEq(credit.maxDebt(address(agent), _ids(ID), 0), 0);
        }
    }

    function test_eval_failures_fail_closed() public {
        NandCircuits.Mode[7] memory modes = [
            NandCircuits.Mode.Revert,
            NandCircuits.Mode.BurnGas,
            NandCircuits.Mode.Empty,
            NandCircuits.Mode.Huge,
            NandCircuits.Mode.LongOutput,
            NandCircuits.Mode.PaddingBits,
            NandCircuits.Mode.BadOffset
        ];
        for (uint256 i; i < modes.length; i++) {
            circuits.setMode(modes[i]);
            (bool allow, uint8 reason,,) = _check(0, 1);
            assertFalse(allow);
            assertEq(reason, Reasons.EVAL);
            assertEq(credit.maxDebt(address(agent), _ids(ID), 0), 0);
        }
    }

    function test_mismatch_both_ways() public {
        circuits.setMode(NandCircuits.Mode.Invert);
        (bool allow, uint8 reason,,) = _check(0, 1);
        assertFalse(allow);
        assertEq(reason, Reasons.MISMATCH, "circuit says no, mirror says yes");
        (allow, reason,,) = _check(0, type(uint256).max);
        assertFalse(allow);
        assertEq(reason, Reasons.MISMATCH, "circuit says yes, mirror says no");
        assertEq(credit.maxDebt(address(agent), _ids(ID), 0), 0);
    }

    function test_reason_precedence_with_two_failures() public {
        vm.warp(EMISSION_END - 7 days);
        _refresh(ID, 100);
        (, uint8 reason,,) = credit.check(address(agent), new uint256[](0), 0, 1);
        assertEq(reason, Reasons.BAD_IDS, "BAD_IDS before EMISSION");
        circuits.setMode(NandCircuits.Mode.ChangedNetlist);
        (, reason,,) = _check(0, 1);
        assertEq(reason, Reasons.EMISSION, "EMISSION before PIN");
        vm.warp(EMISSION_END - 7 days - 1);
        _refresh(ID, 100);
        (, reason,,) = _check(0, 1);
        assertEq(reason, Reasons.PIN, "PIN before EVAL and the flags");
    }

    function test_reverting_voucher_or_screen_reads_as_a_cleared_flag() public {
        vm.mockCallRevert(address(voucher), abi.encodeWithSelector(IRigVoucher.rigs.selector), "upgraded");
        _assertDenied(Reasons.DENIED, 1);
        vm.clearMockedCalls();
        vm.mockCallRevert(address(voucher), abi.encodeWithSelector(IRigVoucher.ownerOf.selector), "upgraded");
        _assertDenied(Reasons.DENIED, 1);
        vm.clearMockedCalls();
        vm.mockCallRevert(address(screen), abi.encodeWithSelector(RigScreen.isEffective.selector), "broken");
        _assertDenied(Reasons.DENIED, 4);
        vm.clearMockedCalls();
        (bool allow,,,) = _check(0, 1);
        assertTrue(allow, "healthy again once the reads work");
    }

    // ───────────────────────── flags, one at a time

    function test_fresh_flag() public {
        vm.warp(block.timestamp + 361);
        _assertDenied(Reasons.DENIED, 0);

        RigReport memory r = _report(ID, 100);
        r.observedAt = uint64(block.timestamp + 61);
        feed.set(r);
        _assertDenied(Reasons.DENIED, 0);

        r = _report(ID, 100);
        r.rigId = uint64(ID + 99);
        feed.setAt(ID, r);
        _assertDenied(Reasons.DENIED, 0);

        r = _report(ID, 100);
        r.totalVerifWeight = r.verifWeight - 1;
        feed.set(r);
        _assertDenied(Reasons.DENIED, 0);

        r = _report(ID, 100);
        r.bonus = r.verifWeight + 1;
        feed.set(r);
        _assertDenied(Reasons.DENIED, 0);

        feed.clear(ID);
        _assertDenied(Reasons.DENIED, 0);

        _refresh(ID, 100);
        feed.setBroken(true);
        _assertDenied(Reasons.DENIED, 0);
    }

    function test_unimpaired_flag() public {
        RigReport memory r = _report(ID, 100);
        r.status = 2;
        feed.set(r);
        _assertDenied(Reasons.DENIED, 1);

        r = _report(ID, 100);
        r.stopBlock = 1;
        feed.set(r);
        _assertDenied(Reasons.DENIED, 1);

        r = _report(ID, 100);
        r.custodied = false;
        feed.set(r);
        _assertDenied(Reasons.DENIED, 1);

        r = _report(ID, 100);
        r.bonus = r.verifWeight;
        feed.set(r);
        _assertDenied(Reasons.DENIED, 1);

        r = _report(ID, 100);
        r.circuitId += 1; // report names another circuit than the voucher's record
        feed.set(r);
        _assertDenied(Reasons.DENIED, 1);

        _refresh(ID, 100);
        voucher.setRig(ID, uint64(block.timestamp), 0);
        _assertDenied(Reasons.DENIED, 1);
        voucher.setRig(ID, uint64(block.timestamp), 110);

        voucher.setBadRigs(true);
        _assertDenied(Reasons.DENIED, 1);
        voucher.setBadRigs(false);

        (bool allow,, uint16 bits,) = credit.check(bob, _ids(ID), 0, 1); // agent does not own it
        assertFalse(allow);
        assertEq((_flags(bits) >> 1) & 1, 0);
    }

    function test_processor_flag() public {
        CreditPolicy.Pins memory p = _pins(address(screen));
        p.cpuTapeOut = address(0x1234);
        CreditPolicy other = new CreditPolicy(p);
        (bool allow, uint8 reason, uint16 bits,) = other.check(address(agent), _ids(ID), 0, 1);
        assertFalse(allow);
        assertEq(reason, Reasons.DENIED);
        assertEq(_flags(bits), 31 & ~uint256(4), "only processorOk cleared");
    }

    function test_age_flag() public {
        // keeper/src/push.ts MIN_RIG_AGE must stay equal (pinned in keeper/test/keeper.test.ts)
        assertEq(credit.MIN_RIG_AGE(), 3 days, "owner decision 2026-10-21");
        RigReport memory r = _report(ID, 100);
        r.since = uint64(block.timestamp - 3 days + 1);
        feed.set(r);
        _assertDenied(Reasons.DENIED, 3);

        r.since = uint64(block.timestamp - 3 days);
        feed.set(r);
        (bool allow,,,) = _check(0, 1);
        assertTrue(allow, "exactly 3 days");

        r.since = 0;
        feed.set(r);
        _assertDenied(Reasons.DENIED, 3);
    }

    function test_screen_flag() public {
        vm.prank(guardian);
        screen.suspendPass(ID);
        _assertDenied(Reasons.DENIED, 4);
        vm.prank(owner);
        screen.liftSuspension(ID);
        (bool allow,,,) = _check(0, 1);
        assertTrue(allow);

        vm.prank(owner);
        screen.recordPass(ID, CPU_TAPEOUT, uint64(ID + 1000), 5, ARTIFACT); // another task, delay reset
        _assertDenied(Reasons.DENIED, 4);

        vm.prank(owner);
        screen.revokePass(ID);
        _assertDenied(Reasons.DENIED, 4);
    }

    // ───────────────────────── never reverts

    function testFuzz_term_never_reverts_and_only_0_1_allow(uint8 term, uint256 debt) public view {
        (bool allow, uint8 reason, uint16 bits,) = _check(term, debt);
        if (term > 1) {
            assertFalse(allow);
            assertEq(reason, Reasons.DENIED);
            assertEq(bits & 3, term > 3 ? 3 : term, "never truncated into 2 bits");
            assertEq(credit.maxDebt(address(agent), _ids(ID), term), 0);
        }
    }

    function testFuzz_debt_allowed_iff_within_limit(uint256 debt) public view {
        uint256 limit = credit.maxDebt(address(agent), _ids(ID), 0);
        (bool allow,,,) = _check(0, debt);
        assertEq(allow, debt <= limit);
    }

    function testFuzz_hostile_report_never_reverts(RigReport memory r) public {
        r.rigId = uint64(ID);
        feed.set(r);
        (bool allow,,,) = _check(0, 1);
        credit.maxDebt(address(agent), _ids(ID), 0);
        if (allow) assertEq(r.status, 1);
    }

    function test_extreme_timestamps_do_not_overflow() public {
        RigReport memory r = _report(ID, 100);
        r.observedAt = type(uint64).max;
        r.since = type(uint64).max;
        feed.set(r);
        (bool allow,,,) = _check(0, 1);
        assertFalse(allow);
    }

    function test_sixteen_rigs_gas() public {
        uint256[] memory ids = new uint256[](16);
        ids[0] = ID;
        for (uint256 i = 1; i < 16; i++) {
            uint256 id = 100 + i;
            ids[i] = id;
            voucher.mint(alice, id, 110);
            _pledge(agent, alice, id);
            vm.prank(owner);
            screen.recordPass(id, CPU_TAPEOUT, uint64(id + 1000), 4, ARTIFACT);
        }
        vm.warp(block.timestamp + 2 days);
        for (uint256 i; i < 16; i++) {
            _refresh(ids[i], 100);
        }
        uint256 g = gasleft();
        uint256 limit = credit.maxDebt(address(agent), ids, 0);
        uint256 gMax = g - gasleft();
        g = gasleft();
        (bool allow,,,) = credit.check(address(agent), ids, 0, limit);
        uint256 gCheck = g - gasleft();
        assertTrue(allow);
        (bool above,,,) = credit.check(address(agent), ids, 0, limit + 1);
        assertFalse(above, "16 rigs: one raw above the limit");
        emit log_named_uint("check gas, 16 rigs", gCheck);
        emit log_named_uint("maxDebt gas, 16 rigs", gMax);
        assertLt(gCheck, 1_500_000);
    }

    // ───────────────────────── constructor and version

    function test_constructor_rejects_bad_pins() public {
        CreditPolicy.Pins memory p = _pins(address(screen));
        p.cpuRefBench = address(0);
        vm.expectRevert(CreditPolicy.ZeroPin.selector);
        new CreditPolicy(p);

        p = _pins(address(screen));
        p.circuits = address(0xDEAD);
        vm.expectRevert(abi.encodeWithSelector(CreditPolicy.NoCode.selector, address(0xDEAD)));
        new CreditPolicy(p);

        p = _pins(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(CreditPolicy.NoCode.selector, address(0xBEEF)));
        new CreditPolicy(p);

        p = _pins(address(screen));
        p.emissionValidUntil = block.timestamp;
        vm.expectRevert(CreditPolicy.EmissionInPast.selector);
        new CreditPolicy(p);
    }

    function test_version() public view {
        assertEq(credit.version(), 1);
    }
}
