// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {XLayerBase, console2} from "../spike/XLayerBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITapeOutTransistors, ITapeOutCircuits} from "../../src/interfaces/IXLayer.sol";
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
import {MockRigFeed} from "../mocks/Mocks.sol";

/// Shared X Layer fork setup: policy v1 taped out through the REAL TapeOut factory (SPEC-PHASE3 §2.3),
/// exactly as the tape-out script does. LOCAL FORK ONLY: prank and deal never leave this process.
abstract contract PolicyForkBase is XLayerBase {
    // BSC Circuits contracts of the PoD-mineable processors (SPEC-PHASE3 P1)
    address constant CPU_TAPEOUT = 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C;
    address constant CPU_BEHEMOTH = 0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C;
    address constant CPU_REFBENCH = 0xF4412C52ec3DDf7CAf5f518B6662F77B02Bde28E;
    uint256 constant EMISSION_END = 1_910_726_132;

    TapeOutPolicy script;
    address circuits;
    uint256 circuitId;

    function _tapeOut() internal {
        script = new TapeOutPolicy();
        address deployer = makeAddr("deployer");
        vm.deal(deployer, 1 ether);
        (bytes memory nl, uint32 gates) = PolicyV1.build();
        uint256 deployFee = script.FACTORY().deployFee();
        (string memory name, string memory symbol, string memory story) =
            (script.NAME(), script.SYMBOL(), script.STORY());
        (uint256 supply, uint256 price) = (script.TRANSISTOR_SUPPLY(), script.MINT_PRICE());
        uint256 b0 = deployer.balance;
        vm.startPrank(deployer);
        (address transistors, address c) =
            script.FACTORY().createCPU{value: deployFee}(name, symbol, story, supply, price);
        ITapeOutTransistors t = ITapeOutTransistors(transistors);
        t.mint{value: uint256(gates) * t.mintPrice() + t.protocolFee()}(t.NAND(), gates);
        circuitId =
            ITapeOutCircuits(c).tapeout{value: ITapeOutCircuits(c).TAPEOUT_FEE()}(nl, PolicyV1.N_IN, PolicyV1.N_OUT);
        vm.stopPrank();
        circuits = c;
        console2.log("tape-out cost (wei OKB)", b0 - deployer.balance);
    }
}

/// The real `eval` on X Layer agrees with the reference model on all 4,096 vectors, in 16 chunks.
contract PolicyCircuitForkTest is PolicyForkBase {
    function setUp() public {
        _fork();
        _tapeOut();
    }

    function test_shape_and_pins() public {
        script.verifyShape(circuits, circuitId);
        assertEq(ITapeOutCircuits(circuits).ownerOf(circuitId), makeAddr("deployer"));
    }

    function _chunk(uint256 i) internal view {
        script.verifyVectors(circuits, circuitId, i * 256, (i + 1) * 256);
    }

    function test_vectors_00() public view {
        _chunk(0);
    }

    function test_vectors_01() public view {
        _chunk(1);
    }

    function test_vectors_02() public view {
        _chunk(2);
    }

    function test_vectors_03() public view {
        _chunk(3);
    }

    function test_vectors_04() public view {
        _chunk(4);
    }

    function test_vectors_05() public view {
        _chunk(5);
    }

    function test_vectors_06() public view {
        _chunk(6);
    }

    function test_vectors_07() public view {
        _chunk(7);
    }

    function test_vectors_08() public view {
        _chunk(8);
    }

    function test_vectors_09() public view {
        _chunk(9);
    }

    function test_vectors_10() public view {
        _chunk(10);
    }

    function test_vectors_11() public view {
        _chunk(11);
    }

    function test_vectors_12() public view {
        _chunk(12);
    }

    function test_vectors_13() public view {
        _chunk(13);
    }

    function test_vectors_14() public view {
        _chunk(14);
    }

    function test_vectors_15() public view {
        _chunk(15);
    }

    function test_eval_gas() public view {
        uint256 v = 31 << 7; // every flag, 7 days, bucket 0: allow
        uint256 g = gasleft();
        bytes memory out = ITapeOutCircuits(circuits).eval(circuitId, PolicyV1.encode(v));
        console2.log("policy v1 eval gas", g - gasleft());
        assertEq(uint8(out[0]), 1);
    }
}

/// After the mainnet tape-out: the same checks against the LIVE circuit. Set POLICY_CIRCUITS and
/// POLICY_CIRCUIT_ID (and optionally POLICY_VERIFY_BLOCK); skipped while they are unset.
contract PolicyLiveCircuitForkTest is XLayerBase {
    function test_live_mainnet_circuit() public {
        address c = vm.envOr("POLICY_CIRCUITS", address(0));
        uint256 id = vm.envOr("POLICY_CIRCUIT_ID", uint256(0));
        if (c == address(0) || id == 0) vm.skip(true);
        uint256 blockNo = vm.envOr("POLICY_VERIFY_BLOCK", uint256(0));
        if (blockNo == 0) vm.createSelectFork("xlayer");
        else vm.createSelectFork("xlayer", blockNo);
        TapeOutPolicy s = new TapeOutPolicy();
        s.verifyShape(c, id);
        for (uint256 i; i < 16; i++) {
            s.verifyVectors(c, id, i * 256, (i + 1) * 256);
        }
    }
}

/// `CreditPolicy` with the REAL RIG voucher and the REAL taped-out circuit; reports are injected
/// through a mock feed (the real feed path is covered by the two-fork tests).
contract PolicyAdapterForkTest is PolicyForkBase {
    /// The operating fee every borrow carries at launch (SPEC-PHASE3-OPSFEE D-O2).
    uint256 constant OPS = 0;
    address constant BIG_HOLDER = 0x571d447f4f24688eC35Ccf07f1D6993655F6aF15;
    uint256 constant RIG = 5; // 306 verified, 248 of it bonus: base 58
    uint64 constant NETWORK = 1_579_201;
    bytes32 constant ARTIFACT = keccak256("proof bundle");

    IERC20 bem = IERC20(address(BEM));
    MockRigFeed feed;
    RigScreen screen;
    CreditPolicy credit;
    AgentFactory factory;
    TapePool pool;
    TapeLens lens;
    RigAgent agent;
    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address lp = makeAddr("lp");

    function setUp() public {
        _fork();
        _tapeOut();
        feed = new MockRigFeed();
        uint256 n = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), n + 3);
        screen = new RigScreen(IPoolAuthority(predicted));
        credit = new CreditPolicy(
            CreditPolicy.Pins({
                circuits: circuits,
                circuitId: circuitId,
                feed: IRigFeed(address(feed)),
                voucher: address(VOUCHER),
                screen: screen,
                cpuTapeOut: CPU_TAPEOUT,
                cpuBehemoth: CPU_BEHEMOTH,
                cpuRefBench: CPU_REFBENCH,
                emissionValidUntil: EMISSION_END
            })
        );
        factory = new AgentFactory(predicted, VOUCHER, bem, feed);
        pool = new TapePool(bem, factory, credit, owner, guardian, lp);
        assertEq(address(pool), predicted);
        vm.prank(owner);
        pool.unpauseBorrows();
        lens = new TapeLens();

        vm.prank(BIG_HOLDER);
        bem.transfer(lp, 20e8);
        vm.startPrank(lp);
        bem.approve(address(pool), type(uint256).max);
        pool.deposit(20e8, lp);
        vm.stopPrank();

        vm.prank(HOLDER_C905);
        agent = RigAgent(factory.create(0));
        vm.warp(block.timestamp + 60);
        vm.prank(HOLDER_C905);
        VOUCHER.safeTransferFrom(HOLDER_C905, address(agent), RIG);

        (address c,, uint256 cid,) = VOUCHER.rigs(RIG);
        vm.prank(owner);
        screen.recordPass(RIG, c, uint64(cid), 151, ARTIFACT);
        vm.warp(block.timestamp + 48 hours);
        feed.set(_report());
    }

    function _report() internal view returns (RigReport memory r) {
        (address c,, uint256 cid,) = VOUCHER.rigs(RIG);
        r.rigId = uint64(RIG);
        r.circuitId = uint64(cid);
        r.circuits = c;
        r.since = uint64(block.timestamp - 40 days);
        r.observedAt = uint64(block.timestamp);
        r.status = 1;
        r.custodied = true;
        r.verifWeight = 306;
        r.bonus = 248;
        r.totalVerifWeight = NETWORK;
        r.taskId = 151;
    }

    function _ids() internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = RIG;
    }

    function test_borrow_gated_by_the_real_circuit() public {
        TapeLens.Quote memory q = lens.quote(agent, 0);
        assertEq(q.reason, Reasons.OK);
        uint256 g = gasleft();
        (bool allow, uint8 reason, uint16 bits,) = credit.check(address(agent), _ids(), 0, q.maxPrincipal + q.fee);
        console2.log("CreditPolicy.check gas, 1 rig, real circuit", g - gasleft());
        assertTrue(allow);
        assertEq(reason, Reasons.OK);
        assertEq((bits >> 7) & 31, 31);
        g = gasleft();
        lens.quote(agent, 0);
        console2.log("TapeLens.quote gas, 1 rig, real circuit", g - gasleft());

        vm.deal(HOLDER_C905, HOLDER_C905.balance + 1 ether); // OKB for the operating fee
        vm.prank(HOLDER_C905);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.PolicyDenied.selector, Reasons.DENIED));
        agent.borrow{value: OPS}(0, q.maxPrincipal + 1, type(uint256).max, type(uint16).max);
        vm.prank(HOLDER_C905);
        agent.borrow{value: OPS}(0, q.maxPrincipal, type(uint256).max, type(uint16).max);
        assertEq(agent.loanOf().principal, q.maxPrincipal);
    }

    function test_changed_netlist_is_pin() public {
        vm.mockCall(
            circuits, abi.encodeCall(ITapeOutCircuits.netlist, (circuitId)), abi.encode(bytes("another netlist"))
        );
        (bool allow, uint8 reason,,) = credit.check(address(agent), _ids(), 0, 1);
        assertFalse(allow);
        assertEq(reason, Reasons.PIN);
    }

    function test_upgraded_eval_that_inverts_is_mismatch() public {
        (bool ok,, uint16 v,) = credit.check(address(agent), _ids(), 0, 1); // the bits check builds here
        assertTrue(ok);
        vm.mockCall(
            circuits, abi.encodeCall(ITapeOutCircuits.eval, (circuitId, PolicyV1.encode(v))), abi.encode(hex"00")
        );
        (bool allow, uint8 reason, uint16 bits,) = credit.check(address(agent), _ids(), 0, 1);
        assertEq(bits, v);
        assertFalse(allow);
        assertEq(reason, Reasons.MISMATCH);
    }

    function test_reverting_eval_is_eval() public {
        vm.mockCallRevert(circuits, abi.encodeWithSelector(ITapeOutCircuits.eval.selector), "upgraded away");
        (bool allow, uint8 reason,,) = credit.check(address(agent), _ids(), 0, 1);
        assertFalse(allow);
        assertEq(reason, Reasons.EVAL);
    }
}
