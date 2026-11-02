// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IRigVoucher, ITapeOutFactory, ITapeOutTransistors, ITapeOutCircuits} from "../../src/interfaces/IXLayer.sol";
import {Reasons} from "../../src/interfaces/ICreditPolicy.sol";
import {IRigFeed, RigReport} from "../../src/interfaces/IRigFeed.sol";
import {PolicyV1} from "../../src/libraries/PolicyV1.sol";
import {RigScreen, IPoolAuthority} from "../../src/RigScreen.sol";
import {CreditPolicy} from "../../src/CreditPolicy.sol";
import {AgentFactory} from "../../src/AgentFactory.sol";
import {TapePool} from "../../src/TapePool.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {TapeLens} from "../../src/TapeLens.sol";
import {TapeOutPolicy} from "../../script/policy/TapeOutPolicy.s.sol";
import {FeedForkBase} from "./FeedForkBase.sol";

/// Phase 3 exit criterion (ROADMAP, SPEC-PHASE3 §7): on forks of BSC and X Layer, a borrow against
/// the demo rig #16 is gated by the REAL taped-out policy circuit and by rig data delivered through
/// the REAL production feed (locked, BEM bridge DVN config, real endpoints). Only the DVN step is
/// simulated. LOCAL FORKS ONLY: prank, deal and warp never leave this process.
contract ExitCriterionTest is FeedForkBase {
    IRigVoucher constant VOUCHER = IRigVoucher(0x9cfc959cd42B2e1d39a0d850c528210E818AE520);
    IERC20 constant BEM = IERC20(0x60e62Efa9405d6873C5deaBD4E6CC91c25363952);
    address constant BIG_HOLDER = 0x571d447f4f24688eC35Ccf07f1D6993655F6aF15;
    address constant OWNER = 0x19a953e83C4CFDffFf2Fd336f3857c52D99045ba; // the pool owner wallet
    /// The operating fee every borrow carries at launch (SPEC-PHASE3-OPSFEE D-O2).
    uint256 constant OPS = 0;
    address constant KEEPER = 0xB61e09c96B66c02D9518e8f0f9Ce645b8589dBC8; // keeper / guardian
    address constant CPU_TAPEOUT = 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C;
    address constant CPU_BEHEMOTH = 0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C;
    address constant CPU_REFBENCH = 0xF4412C52ec3DDf7CAf5f518B6662F77B02Bde28E;
    uint256 constant EMISSION_END = 1_910_726_132;
    uint256 constant DEMO_RIG = 16; // 1 H base power, mining since 2026-10-16 13:44 UTC, task 4
    uint32 constant DEMO_TASK = 4;
    uint256 constant LOAN_TIME = 1_793_368_800; // 2026-10-30 14:00 UTC, well past the 3-day age rule
    bytes32 constant ARTIFACT = keccak256("rig 16 equivalence proof bundle");

    address circuits;
    uint256 circuitId;
    RigScreen screen;
    CreditPolicy credit;
    AgentFactory factory;
    TapePool pool;
    TapeLens lens;
    RigAgent agent;
    address borrower;

    function setUp() public {
        _forks();
        _deploy();
        _configureBoth();
        _lockBoth();

        vm.selectFork(xFork);
        vm.warp(LOAN_TIME - 3 days);
        _tapeOut();
        uint256 n = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), n + 3);
        screen = new RigScreen(IPoolAuthority(predicted));
        credit = new CreditPolicy(
            CreditPolicy.Pins({
                circuits: circuits,
                circuitId: circuitId,
                feed: IRigFeed(address(receiver)),
                voucher: address(VOUCHER),
                screen: screen,
                cpuTapeOut: CPU_TAPEOUT,
                cpuBehemoth: CPU_BEHEMOTH,
                cpuRefBench: CPU_REFBENCH,
                emissionValidUntil: EMISSION_END
            })
        );
        factory = new AgentFactory(predicted, VOUCHER, BEM, IRigFeed(address(receiver)));
        address lp = makeAddr("lp");
        pool = new TapePool(BEM, factory, credit, OWNER, KEEPER, lp);
        vm.prank(OWNER);
        pool.unpauseBorrows();
        assertEq(address(pool), predicted);
        lens = new TapeLens();

        vm.prank(BIG_HOLDER);
        BEM.transfer(lp, 20e8);
        vm.startPrank(lp);
        BEM.approve(address(pool), type(uint256).max);
        pool.deposit(20e8, lp);
        vm.stopPrank();

        borrower = VOUCHER.ownerOf(DEMO_RIG);
        vm.deal(borrower, borrower.balance + 1 ether); // OKB for the operating fee
        vm.prank(borrower);
        agent = RigAgent(factory.create(0));
        vm.prank(borrower);
        VOUCHER.safeTransferFrom(borrower, address(agent), DEMO_RIG);
    }

    function _tapeOut() internal {
        TapeOutPolicy s = new TapeOutPolicy();
        ITapeOutFactory f = s.FACTORY();
        address deployer = makeAddr("deployer");
        vm.deal(deployer, 1 ether);
        (bytes memory nl, uint32 gates) = PolicyV1.build();
        uint256 deployFee = f.deployFee();
        (string memory name, string memory symbol, string memory story) = (s.NAME(), s.SYMBOL(), s.STORY());
        (uint256 supply, uint256 price) = (s.TRANSISTOR_SUPPLY(), s.MINT_PRICE());
        vm.startPrank(deployer);
        (address transistors, address c) = f.createCPU{value: deployFee}(name, symbol, story, supply, price);
        ITapeOutTransistors t = ITapeOutTransistors(transistors);
        t.mint{value: uint256(gates) * t.mintPrice() + t.protocolFee()}(t.NAND(), gates);
        circuitId =
            ITapeOutCircuits(c).tapeout{value: ITapeOutCircuits(c).TAPEOUT_FEE()}(nl, PolicyV1.N_IN, PolicyV1.N_OUT);
        vm.stopPrank();
        circuits = c;
    }

    /// The owner records the screen pass at least 48 h before the loan (SPEC §7.3).
    function _recordPass() internal {
        vm.selectFork(xFork);
        (address c,, uint256 cid,) = VOUCHER.rigs(DEMO_RIG);
        vm.prank(OWNER);
        screen.recordPass(DEMO_RIG, c, uint64(cid), DEMO_TASK, ARTIFACT);
    }

    /// Push rig #16 on BSC at the loan time and land it on X Layer 30 s later.
    function _pushAndDeliver() internal returns (RigReport memory r) {
        vm.selectFork(bscFork);
        vm.warp(LOAN_TIME);
        uint256[] memory ids = _ids(DEMO_RIG, DEMO_RIG);
        Packet memory p = _push(ids, reporter.quote(ids));
        vm.selectFork(xFork);
        vm.warp(LOAN_TIME + 30);
        _deliver(p);
        bool ok;
        (r, ok) = receiver.latest(DEMO_RIG);
        assertTrue(ok, "report landed");
    }

    function _ids1() internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = DEMO_RIG;
    }

    function test_exit_borrow_gated_by_real_circuit_and_real_feed() public {
        _recordPass();
        RigReport memory r = _pushAndDeliver();
        console2.log("rig 16 base power from the feed", r.verifWeight - r.bonus);
        console2.log("network weight from the feed", r.totalVerifWeight);
        assertEq(r.taskId, DEMO_TASK);
        assertGe(LOAN_TIME, uint256(r.since) + credit.MIN_RIG_AGE(), "age rule met");

        TapeLens.Quote memory q = lens.quote(agent, 0);
        assertEq(q.reason, Reasons.OK, "quote OK");
        console2.log("7-day max principal (raw BEM)", q.maxPrincipal);
        console2.log("fee (raw BEM)", q.fee);
        assertGe(q.maxPrincipal, pool.minAdvance(), "the demo rig can take the minimum advance");

        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.PolicyDenied.selector, Reasons.DENIED));
        agent.borrow{value: OPS}(0, q.maxPrincipal + 1, type(uint256).max, type(uint16).max);

        uint256 before = BEM.balanceOf(borrower);
        uint256 ownerBefore = OWNER.balance;
        vm.prank(borrower);
        agent.borrow{value: OPS}(0, q.maxPrincipal, type(uint256).max, type(uint16).max);
        assertEq(BEM.balanceOf(borrower) - before, q.maxPrincipal, "advance paid out");
        assertEq(OWNER.balance - ownerBefore, OPS, "the operating fee reached the real owner wallet");
        assertEq(agent.loanOf().maturity, block.timestamp + 7 days);
    }

    function test_exit_denied_without_a_screen_pass() public {
        _pushAndDeliver();
        uint256 minAdvance = pool.minAdvance();
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.PolicyDenied.selector, Reasons.DENIED));
        agent.borrow{value: OPS}(0, minAdvance, type(uint256).max, type(uint16).max);
        assertEq(lens.quote(agent, 0).maxPrincipal, 0);
    }

    function test_exit_denied_with_a_wrong_netlist_pin() public {
        _recordPass();
        _pushAndDeliver();
        CreditPolicy wrongPin = new CreditPolicy(
            CreditPolicy.Pins({
                circuits: circuits,
                circuitId: circuitId + 1, // no such circuit on our processor
                feed: IRigFeed(address(receiver)),
                voucher: address(VOUCHER),
                screen: screen,
                cpuTapeOut: CPU_TAPEOUT,
                cpuBehemoth: CPU_BEHEMOTH,
                cpuRefBench: CPU_REFBENCH,
                emissionValidUntil: EMISSION_END
            })
        );
        (bool allow, uint8 reason,,) = wrongPin.check(address(agent), _ids1(), 0, 1);
        assertFalse(allow);
        assertEq(reason, Reasons.PIN);
    }

    function test_exit_denied_when_the_report_is_stale() public {
        _recordPass();
        _pushAndDeliver();
        vm.warp(LOAN_TIME + 301);
        uint256 minAdvance = pool.minAdvance();
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.PolicyDenied.selector, Reasons.DENIED));
        agent.borrow{value: OPS}(0, minAdvance, type(uint256).max, type(uint16).max);
    }
}
