// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IRigVoucher} from "../../src/interfaces/IXLayer.sol";
import {IRigFeed, RigReport} from "../../src/interfaces/IRigFeed.sol";
import {TapePool} from "../../src/TapePool.sol";
import {AgentFactory} from "../../src/AgentFactory.sol";
import {RigScreen, IPoolAuthority} from "../../src/RigScreen.sol";
import {CreditPolicy} from "../../src/CreditPolicy.sol";
import {PolicyV1} from "../../src/libraries/PolicyV1.sol";
import {NandCircuits} from "../mocks/NandCircuits.sol";
import {Base} from "./Base.t.sol";

/// Base with the real `CreditPolicy` and `RigScreen` instead of the mock policy: the circuit runs in
/// a Solidity NAND interpreter (`NandCircuits`), the feed and voucher are the Phase 2 mocks.
abstract contract PolicyBase is Base {
    address constant CPU_TAPEOUT = address(0xC1C); // the circuits address the mocks report
    address constant CPU_BEHEMOTH = address(0xBE11);
    address constant CPU_REFBENCH = address(0xBEEC);
    uint256 constant EMISSION_END = 1_910_726_132; // first halving − 30 days (SPEC-PHASE3 §4.1)
    bytes32 constant ARTIFACT = keccak256("proof bundle");

    NandCircuits circuits;
    uint256 circuitId;
    RigScreen screen;
    CreditPolicy credit;

    function setUp() public virtual override {
        super.setUp(); // mock BEM, voucher, feed, lens (and a mock-policy pool we replace below)
        circuits = new NandCircuits();
        (bytes memory nl,) = PolicyV1.build();
        circuitId = circuits.tapeout(nl, PolicyV1.N_IN, PolicyV1.N_OUT);
        (screen, credit, factory, pool) = _deployReal(_pins(address(0)));
    }

    function _pins(address screenAddr) internal view returns (CreditPolicy.Pins memory p) {
        p.circuits = address(circuits);
        p.circuitId = circuitId;
        p.feed = IRigFeed(address(feed));
        p.voucher = address(voucher);
        p.screen = RigScreen(screenAddr);
        p.cpuTapeOut = CPU_TAPEOUT;
        p.cpuBehemoth = CPU_BEHEMOTH;
        p.cpuRefBench = CPU_REFBENCH;
        p.emissionValidUntil = EMISSION_END;
    }

    /// Screen and factory first with the pool's predicted address, then the policy, then the pool.
    function _deployReal(CreditPolicy.Pins memory p)
        internal
        returns (RigScreen s, CreditPolicy c, AgentFactory f, TapePool tp)
    {
        uint256 n = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), n + 3);
        s = new RigScreen(IPoolAuthority(predicted));
        p.screen = s;
        c = new CreditPolicy(p);
        f = new AgentFactory(predicted, IRigVoucher(address(voucher)), IERC20(address(bem)), feed);
        tp = new TapePool(IERC20(address(bem)), f, c, owner, guardian, lp);
        vm.prank(owner);
        tp.unpauseBorrows();
        assertEq(address(tp), predicted, "pool address prediction");
    }

    /// Record a pass for `id` matching the mock report, let it become effective, and refresh the
    /// report (time moved by 48 h).
    function _screen(uint256 id, uint64 base) internal {
        vm.prank(owner);
        screen.recordPass(id, CPU_TAPEOUT, uint64(id + 1000), 4, ARTIFACT);
        vm.warp(block.timestamp + screen.DELAY());
        _refresh(id, base);
    }

    function _ids(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }

    function _flags(uint16 inputBits) internal pure returns (uint256) {
        return (inputBits >> 7) & 31;
    }
}
