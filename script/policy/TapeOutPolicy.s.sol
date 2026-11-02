// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ITapeOutFactory, ITapeOutTransistors, ITapeOutCircuits} from "../../src/interfaces/IXLayer.sol";
import {PolicyV1} from "../../src/libraries/PolicyV1.sol";

/// Tape out credit policy v1 on X Layer (SPEC-PHASE3 §2.3), then verify the live circuit.
///
/// Dry-run by default. Only `--broadcast`, signed by the deployer keystore after the owner's go-ahead
/// in chat, sends anything (about 0.009 OKB):
///   forge script script/policy/TapeOutPolicy.s.sol --rpc-url xlayer --account tapepool-probe
/// Then, against the live chain and WITHOUT `--broadcast` (reads only):
///   forge script script/policy/TapeOutPolicy.s.sol --rpc-url xlayer --sig "verify(address,uint256)" <circuits> <id>
/// A forge script simulates `run()` before broadcasting, so checks inside `run()` would only see the
/// simulated tape-out; `verify` is the check that sees the real one.
contract TapeOutPolicy is Script {
    ITapeOutFactory public constant FACTORY = ITapeOutFactory(0x1f09DAeFA827f02CBb40967cc91b259763760761);
    string public constant NAME = "Tape Pool Policy";
    string public constant SYMBOL = "TPPOL";
    string public constant STORY = "Tape Pool credit policy v1: the public rule for BEM advances against TapeOut rigs.";
    uint256 public constant TRANSISTOR_SUPPLY = 10_000;
    uint256 public constant MINT_PRICE = 1e13; // wei OKB per transistor, as in spike T3b
    /// @notice Refuse to broadcast if the factory's fees add up to more than this (expected ≈ 0.009 OKB).
    uint256 public constant MAX_TOTAL_FEE = 0.02 ether;

    function run() external returns (address circuits, uint256 circuitId) {
        require(block.chainid == 196, "X Layer only");
        (bytes memory nl, uint32 gates) = PolicyV1.build();
        require(gates == PolicyV1.GATES && keccak256(nl) == PolicyV1.NETLIST_HASH, "netlist differs from golden pins");

        uint256 deployFee = FACTORY.deployFee();
        require(
            deployFee + _otherFeesUpperBound(gates) <= MAX_TOTAL_FEE, "factory fees changed: review before broadcasting"
        );
        vm.startBroadcast();
        address transistors;
        (transistors, circuits) =
            FACTORY.createCPU{value: deployFee}(NAME, SYMBOL, STORY, TRANSISTOR_SUPPLY, MINT_PRICE);
        ITapeOutTransistors t = ITapeOutTransistors(transistors);
        ITapeOutCircuits c = ITapeOutCircuits(circuits);
        uint256 mintValue = uint256(gates) * t.mintPrice() + t.protocolFee();
        uint256 tapeoutFee = c.TAPEOUT_FEE();
        // forge simulates the whole run before broadcasting, so this stops the session before any send
        require(deployFee + mintValue + tapeoutFee <= MAX_TOTAL_FEE, "actual fees above the bound");
        t.mint{value: mintValue}(t.NAND(), gates);
        circuitId = c.tapeout{value: tapeoutFee}(nl, PolicyV1.N_IN, PolicyV1.N_OUT);
        vm.stopBroadcast();

        console2.log("POLICY CIRCUITS (X Layer)", circuits);
        console2.log("POLICY CIRCUIT ID", circuitId);
        console2.log("Next, once mined: --sig \"verify(address,uint256)\" <circuits> <id>, no --broadcast");
        console2.log("and --sig \"verifyHolder(address,uint256,address)\" <circuits> <id> <deployer>");
    }

    /// @dev The transistor and tape-out fees are only known after `createCPU`; bound them by the
    ///      fees of the processor the TapeOut team runs on the same factory, plus our own mint price.
    function _otherFeesUpperBound(uint32 gates) internal view returns (uint256) {
        return uint256(gates) * MINT_PRICE + FACTORY.protocolFee() + 0.002 ether; // TAPEOUT_FEE is 0.0013 OKB
    }

    /// @notice Read-only proof that the live circuit is policy v1: registered processor, pinned shape
    ///         and netlist hash, and all 4,096 vectors through the real `eval`, in 16 logged chunks.
    ///         About 555M gas of simulation in total; if the RPC's call gas limit is lower, run
    ///         `verifyChunk(address,uint256,uint256)` for chunks 0 to 15 instead.
    function verify(address circuits, uint256 circuitId) external view {
        verifyShape(circuits, circuitId);
        for (uint256 i; i < 16; i++) {
            verifyChunk(circuits, circuitId, i);
            console2.log("chunk ok", i);
        }
        console2.log("VERIFIED: shape, netlist hash and all 4,096 vectors match policy v1");
    }

    /// @notice The circuit belongs to `holder` (the deployer), so the tape-out landed where `run`
    ///         printed, not on a processor another `createCPU` won in the same block.
    function verifyHolder(address circuits, uint256 circuitId, address holder) external view {
        require(ITapeOutCircuits(circuits).ownerOf(circuitId) == holder, "circuit not held by the deployer");
        console2.log("VERIFIED: the circuit is held by", holder);
    }

    /// @notice Check vectors `[256 × chunk, 256 × (chunk + 1))`.
    function verifyChunk(address circuits, uint256 circuitId, uint256 chunk) public view {
        require(chunk < 16, "chunk");
        verifyVectors(circuits, circuitId, chunk * 256, (chunk + 1) * 256);
    }

    function verifyShape(address circuits, uint256 circuitId) public view {
        require(FACTORY.isCPU(circuits), "not a registered processor");
        ITapeOutCircuits c = ITapeOutCircuits(circuits);
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gates) = c.circuitInfo(circuitId);
        require(nIn == PolicyV1.N_IN && nOut == PolicyV1.N_OUT && nState == PolicyV1.N_STATE, "circuitInfo");
        require(gates == PolicyV1.GATES, "gate count");
        require(keccak256(c.netlist(circuitId)) == PolicyV1.NETLIST_HASH, "netlist hash");
    }

    /// @notice Check vectors `[from, to)` through the real `eval`; reverts on the first mismatch.
    function verifyVectors(address circuits, uint256 circuitId, uint256 from, uint256 to) public view {
        ITapeOutCircuits c = ITapeOutCircuits(circuits);
        for (uint256 v = from; v < to; v++) {
            bytes memory out = c.eval(circuitId, PolicyV1.encode(v));
            require(out.length == 1 && uint8(out[0]) <= 1, "output shape");
            require((uint8(out[0]) == 1) == PolicyV1.expected(v), "truth table mismatch");
        }
    }
}
