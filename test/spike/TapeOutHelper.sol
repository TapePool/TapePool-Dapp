// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {XLayerBase, console2} from "./XLayerBase.sol";
import {ITapeOutFactory, ITapeOutTransistors, ITapeOutCircuits} from "../../src/interfaces/IXLayer.sol";
import {CreditPolicyNetlist} from "../../src/spike/CreditPolicyNetlist.sol";

abstract contract TapeOutHelper is XLayerBase {
    ITapeOutFactory constant FACTORY = ITapeOutFactory(0x1f09DAeFA827f02CBb40967cc91b259763760761);

    struct Launch {
        address creator;
        address transistors;
        address circuits;
        uint256 circuitId;
        uint32 gates;
        bytes netlist;
        uint256 feeCreate;
        uint256 feeMint;
        uint256 feeTapeout;
        uint256 gasCreate;
        uint256 gasMint;
        uint256 gasTapeout;
    }

    /// createCPU -> mint NAND -> tapeout the credit-policy netlist, all from a fresh funded EOA (local fork only).
    function _launchPolicy(uint256 mintPrice) internal returns (Launch memory L) {
        L.creator = makeAddr("spike-processor-creator");
        vm.deal(L.creator, 1 ether);
        (L.netlist, L.gates) = CreditPolicyNetlist.build();

        uint256 deployFee = FACTORY.deployFee();
        uint256 b0 = L.creator.balance;
        uint256 g = gasleft();
        vm.prank(L.creator);
        (L.transistors, L.circuits) =
            FACTORY.createCPU{value: deployFee}("TapePoolSpike", "TPS", "fork-only spike", 10_000, mintPrice);
        L.gasCreate = g - gasleft();
        L.feeCreate = b0 - L.creator.balance;

        ITapeOutTransistors T = ITapeOutTransistors(L.transistors);
        uint256 mintValue = uint256(L.gates) * T.mintPrice() + T.protocolFee();
        uint256 nandId = T.NAND(); // evaluate before vm.prank (prank applies to the next call only)
        b0 = L.creator.balance;
        g = gasleft();
        vm.prank(L.creator);
        T.mint{value: mintValue}(nandId, L.gates);
        L.gasMint = g - gasleft();
        L.feeMint = b0 - L.creator.balance;

        ITapeOutCircuits C = ITapeOutCircuits(L.circuits);
        uint256 tf = C.TAPEOUT_FEE();
        b0 = L.creator.balance;
        g = gasleft();
        vm.prank(L.creator);
        L.circuitId = C.tapeout{value: tf}(L.netlist, CreditPolicyNetlist.N_IN, CreditPolicyNetlist.N_OUT);
        L.gasTapeout = g - gasleft();
        L.feeTapeout = b0 - L.creator.balance;
    }
}
