// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TapeOutHelper, console2} from "./TapeOutHelper.sol";
import {ITapeOutCircuits, ITapeOutTransistors} from "../../src/interfaces/IXLayer.sol";
import {CircuitConsumer} from "../../src/spike/CircuitConsumer.sol";
import {CreditPolicyNetlist} from "../../src/spike/CreditPolicyNetlist.sol";

/// T3: a contract can consume a TapeOut circuit (gas-capped, fail-closed), and a credit-policy
///     circuit can be created / minted / taped out on X Layer and gives the right truth table.
contract T3_CircuitTest is TapeOutHelper {
    address constant CPU0 = 0x839bdD6fa7A66416A609A735e11DE5411B98574e; // "OnlyTestXLayer", circuit #1 = 4-NAND XOR
    address constant CEREBR = 0xB04EB79D1A5EECaabAAfF7B77d7c27578EE693FF; // circuit #16: 590 NAND, 18 in / 9 out
    CircuitConsumer consumer;

    function setUp() public {
        _fork();
        consumer = new CircuitConsumer();
    }

    function test_T3a_eval_existing_xor_from_contract() public view {
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gc) = ITapeOutCircuits(CPU0).circuitInfo(1);
        assertEq(nIn, 2);
        assertEq(nOut, 1);
        assertEq(nState, 0);
        assertEq(gc, 4);
        bytes1[4] memory want = [bytes1(0x00), 0x01, 0x01, 0x00];
        uint256 maxGas;
        for (uint8 v; v < 4; v++) {
            (bool ok, bytes memory out, uint256 gasUsed) = consumer.evalCapped(CPU0, 1, abi.encodePacked(v), 200_000, 1);
            assertTrue(ok, "eval ok");
            assertEq(out.length, 1);
            assertEq(out[0], want[v], "xor truth table");
            if (gasUsed > maxGas) maxGas = gasUsed;
        }
        console2.log("XOR (4 gates) eval gas inside staticcall, max over 4 vectors", maxGas);
    }

    function test_T3a_gas_cap_fails_closed() public view {
        (bool ok,,) = consumer.evalCapped(CPU0, 1, hex"03", 5_000, 1);
        assertFalse(ok, "too-low cap => ok=false, no revert bubbles up");
        assertFalse(consumer.allow(CPU0, 1, hex"01", 5_000));
        // nonexistent circuit => fail closed
        (ok,,) = consumer.evalCapped(CPU0, 10_000_000, hex"00", 200_000, 1);
        assertFalse(ok);
        // wrong nOut expectation => strict decode rejects
        (ok,,) = consumer.evalCapped(CPU0, 1, hex"01", 200_000, 9);
        assertFalse(ok);
    }

    function test_T3a_eval_cerebr_590_gates_gas() public view {
        (uint32 nIn, uint32 nOut,, uint32 gc) = ITapeOutCircuits(CEREBR).circuitInfo(16);
        (bool ok, bytes memory out, uint256 gasUsed) = consumer.evalCapped(CEREBR, 16, hex"000000", 5_000_000, nOut);
        assertTrue(ok);
        assertEq(out.length, 2);
        console2.log("Cerebr #16 nIn/nOut", nIn, nOut);
        console2.log("Cerebr #16 gates", gc);
        console2.log("Cerebr #16 eval gas", gasUsed);
    }

    function test_T3b_create_mint_tapeout_policy_and_truth_table() public {
        Launch memory L = _launchPolicy(1e13); // 0.00001 OKB per transistor
        assertTrue(FACTORY.isCPU(L.circuits), "registered CPU");
        ITapeOutCircuits C = ITapeOutCircuits(L.circuits);
        assertEq(C.ownerOf(L.circuitId), L.creator);
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gc) = C.circuitInfo(L.circuitId);
        assertEq(nIn, 9);
        assertEq(nOut, 1);
        assertEq(nState, 0);
        assertEq(gc, L.gates);
        assertEq(keccak256(C.netlist(L.circuitId)), keccak256(L.netlist), "stored netlist == submitted");
        assertEq(ITapeOutTransistors(L.transistors).balanceOf(L.creator, 0), 0, "all NAND burned");

        console2.log("policy gates", L.gates);
        console2.log("policy netlist bytes", L.netlist.length);
        console2.log("circuit id", L.circuitId);
        console2.log("fee createCPU (wei OKB)", L.feeCreate);
        console2.log("fee mint (wei OKB)", L.feeMint);
        console2.log("fee tapeout (wei OKB)", L.feeTapeout);
        console2.log("gas createCPU", L.gasCreate);
        console2.log("gas mint", L.gasMint);
        console2.log("gas tapeout", L.gasTapeout);

        uint256 maxGas;
        uint256 allows;
        for (uint256 v; v < 512; v++) {
            (bool ok, bytes memory out, uint256 gasUsed) =
                consumer.evalCapped(L.circuits, L.circuitId, CreditPolicyNetlist.encode(v), 1_000_000, 1);
            assertTrue(ok, "eval ok");
            bool got = (uint8(out[0]) & 1) == 1;
            assertEq(got, CreditPolicyNetlist.expected(v), "truth table mismatch");
            if (got) allows++;
            if (gasUsed > maxGas) maxGas = gasUsed;
        }
        console2.log("all 512 vectors match; allow count", allows);
        console2.log("policy eval gas (max, inside staticcall)", maxGas);
    }

    function test_T3b_tapeout_fee_must_be_exact() public {
        Launch memory L = _launchPolicy(1e13);
        ITapeOutCircuits C = ITapeOutCircuits(L.circuits);
        uint256 tf = C.TAPEOUT_FEE();
        vm.deal(L.creator, 1 ether);
        vm.prank(L.creator);
        vm.expectRevert(bytes("tapeout fee"));
        C.tapeout{value: tf + 1}(L.netlist, 9, 1);
    }
}
