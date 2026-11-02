// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {PolicyV1} from "../../src/libraries/PolicyV1.sol";
import {NetlistBuilder} from "../../src/libraries/NetlistBuilder.sol";
import {NandCircuits} from "../mocks/NandCircuits.sol";

/// Policy circuit v1 (SPEC-PHASE3 §2): golden pins, structure, and the full truth table through a
/// Solidity NAND interpreter. The proof against the real `eval` is the X Layer fork test.
contract PolicyV1Test is Test {
    uint256 constant ALL_FLAGS = 31 << 7;

    function _v(uint256 t, uint256 b, uint256 flags) internal pure returns (uint256) {
        return t | (b << 2) | (flags << 7);
    }

    function test_golden_gate_count_and_hash() public pure {
        (bytes memory nl, uint32 gates) = PolicyV1.build();
        console2.log("PolicyV1 gates", gates);
        console2.logBytes32(keccak256(nl));
        assertEq(nl.length, uint256(gates) * 7, "NAND records only");
        assertEq(gates, PolicyV1.GATES, "golden gate count");
        assertEq(keccak256(nl), PolicyV1.NETLIST_HASH, "golden netlist hash");
    }

    /// The output is the last gate, and no record reads a constant signal (TAP-02 constants were never
    /// exercised on chain). Every operand is an input or an earlier gate.
    function test_output_is_a_gate_and_no_constants() public pure {
        (bytes memory nl, uint32 gates) = PolicyV1.build();
        uint256 firstGate = 2 + PolicyV1.N_IN;
        uint256 output = firstGate + gates - 1;
        assertGe(output, firstGate, "output is a gate");
        for (uint256 p; p < nl.length; p += 7) {
            assertEq(uint8(nl[p]), 0, "NAND opcode");
            uint256 a = (uint256(uint8(nl[p + 1])) << 16) | (uint256(uint8(nl[p + 2])) << 8) | uint8(nl[p + 3]);
            uint256 b = (uint256(uint8(nl[p + 4])) << 16) | (uint256(uint8(nl[p + 5])) << 8) | uint8(nl[p + 6]);
            uint256 self = firstGate + p / 7;
            assertGe(a, 2, "no constant operand");
            assertGe(b, 2, "no constant operand");
            assertLt(a, self, "earlier signal");
            assertLt(b, self, "earlier signal");
        }
    }

    function test_truth_table_through_interpreter() public {
        NandCircuits c = new NandCircuits();
        (bytes memory nl,) = PolicyV1.build();
        uint256 id = c.tapeout(nl, PolicyV1.N_IN, PolicyV1.N_OUT);
        uint256 allows;
        for (uint256 v; v < PolicyV1.VECTORS; v++) {
            bytes memory out = c.eval(id, PolicyV1.encode(v));
            assertEq(out.length, 1);
            bool got = uint8(out[0]) == 1;
            assertEq(got, PolicyV1.expected(v), "truth table");
            if (got) allows++;
        }
        // 7 d: buckets 0-17 (18 values), 14 d: buckets 0-16 (17 values), only with every flag set
        assertEq(allows, 35, "allow count");
    }

    function test_reference_model_points() public pure {
        assertTrue(PolicyV1.expected(_v(0, 17, 31)), "7 d at 85%");
        assertFalse(PolicyV1.expected(_v(0, 18, 31)), "7 d above 85%");
        assertTrue(PolicyV1.expected(_v(1, 16, 31)), "14 d at 80%");
        assertFalse(PolicyV1.expected(_v(1, 17, 31)), "14 d above 80%");
        assertTrue(PolicyV1.expected(_v(0, 0, 31)), "zero debt bucket");
        for (uint256 b; b < 32; b++) {
            assertFalse(PolicyV1.expected(_v(2, b, 31)), "term 2 reserved");
            assertFalse(PolicyV1.expected(_v(3, b, 31)), "term 3 invalid");
        }
        for (uint256 f; f < 5; f++) {
            // forge-lint: disable-next-line(incorrect-shift) one bit per flag
            assertFalse(PolicyV1.expected(_v(0, 0, 31 & ~(1 << f))), "every flag is required");
        }
        assertFalse(PolicyV1.expected(PolicyV1.VECTORS + ALL_FLAGS), "out of range");
        assertFalse(PolicyV1.expected(type(uint256).max), "out of range");
    }

    function test_encode_is_lsb_first_and_masks_high_bits() public pure {
        assertEq(PolicyV1.encode(0xABC), hex"bc0a");
        assertEq(PolicyV1.encode(0xFFFF), hex"ff0f", "byte 1 bits 4-7 always 0");
        assertEq(PolicyV1.encode(0), hex"0000");
    }

    function test_builder_rejects_future_signals() public {
        NetlistBuilder.Netlist memory n = NetlistBuilder.create(2);
        vm.expectRevert(abi.encodeWithSelector(NetlistBuilder.FutureSignal.selector, uint24(4), uint24(0), uint24(4)));
        this.callNand(n, 4, 0);
    }

    function callNand(NetlistBuilder.Netlist memory n, uint24 a, uint24 b) external pure returns (uint24) {
        return NetlistBuilder.nand(n, a, b);
    }
}
