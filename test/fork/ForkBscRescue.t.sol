// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FeedBase} from "../spike/FeedBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {RigReport as SpikeReport} from "../../src/spike/feed/RigReport.sol";
import {TapePool} from "../../src/TapePool.sol";
import {AgentFactory} from "../../src/AgentFactory.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {MockRigFeed, MockCreditPolicy} from "../mocks/Mocks.sol";

interface IPodTotals {
    function totalVerifWeight() external view returns (uint256);
}

/// SPEC §7.2 fork test on two forks: a REAL rescue by the TapeOut Safe on BSC, read on-chain by the
/// spike reader, carried to X Layer in the production report shape, flags the loan and leads to a
/// seize of the REAL voucher. Only the LayerZero hop is skipped (proven in T8 and the real probe).
/// Skips without `BSC_RPC`.
contract ForkBscRescueTest is FeedBase {
    /// The operating fee every borrow carries at launch (SPEC-PHASE3-OPSFEE D-O2).
    uint256 constant OPS = 0;
    address constant HOLDER = 0xC9059E0F59F40920E5BD24307eaa4DeFd81Df145; // holds voucher #5
    address constant BIG_HOLDER = 0x571d447f4f24688eC35Ccf07f1D6993655F6aF15;
    IERC20 constant BEM = IERC20(0x60e62Efa9405d6873C5deaBD4E6CC91c25363952);

    MockRigFeed feed;
    TapePool pool;
    RigAgent agent;
    uint256 t;

    function setUp() public {
        _forks();
        // line the two clocks up so reports are fresh on arrival
        vm.selectFork(bscFork);
        uint256 tb = block.timestamp;
        vm.selectFork(xFork);
        t = (block.timestamp > tb ? block.timestamp : tb) + 60;

        feed = new MockRigFeed();
        MockCreditPolicy policy = new MockCreditPolicy(feed, 1);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        AgentFactory factory = new AgentFactory(predicted, VOUCHER, BEM, feed);
        pool = new TapePool(BEM, factory, policy, makeAddr("owner"), makeAddr("guardian"), address(this));
        vm.prank(makeAddr("owner"));
        pool.unpauseBorrows();
        vm.prank(BIG_HOLDER);
        BEM.transfer(address(this), 20e8);
        BEM.approve(address(pool), 20e8);
        pool.deposit(20e8, address(this));
        vm.prank(HOLDER);
        agent = RigAgent(factory.create(0));
        vm.prank(HOLDER);
        VOUCHER.safeTransferFrom(HOLDER, address(agent), RIG);
    }

    /// Read rig `RIG` on BSC at time `at` and post it to the X Layer feed at `at + 30`.
    function _push(uint256 at) internal returns (RigReport memory r) {
        vm.selectFork(bscFork);
        vm.warp(at);
        SpikeReport memory s = _read(RIG);
        uint256 total = IPodTotals(address(POD)).totalVerifWeight();
        r = RigReport({
            rigId: s.rigId,
            circuitId: s.circuitId,
            since: s.since,
            stopBlock: s.stopBlock,
            circuits: s.circuits,
            observedAt: s.observedAt,
            status: s.status,
            custodied: s.custodied,
            verifWeight: SafeCast.toUint64(s.verifWeight),
            bonus: SafeCast.toUint64(s.bonus),
            totalVerifWeight: SafeCast.toUint64(total),
            bscBlock: s.bscBlock,
            pending: s.pending,
            taskId: s.taskId
        });
        vm.selectFork(xFork);
        vm.warp(at + 30);
        feed.set(r);
    }

    function test_fork_real_bsc_rescue_flags_and_seizes() public {
        RigReport memory healthy = _push(t);
        assertEq(healthy.verifWeight - healthy.bonus, _snapshotBase(RIG), "base power from BSC");
        assertGt(healthy.totalVerifWeight, 1_000_000, "network weight read on BSC");
        vm.deal(HOLDER, HOLDER.balance + 1 ether); // OKB for the operating fee
        vm.prank(HOLDER);
        agent.borrow{value: OPS}(0, 0.5e8, type(uint256).max, type(uint16).max);

        vm.selectFork(bscFork);
        _rescueOnBsc(RIG);
        RigReport memory rescued = _push(t + 120);
        assertFalse(rescued.custodied, "the reader sees the rescue");
        agent.flagImpaired(RIG);
        assertEq(pool.doubtful(), 0.5e8);

        uint256 later = t + 150 + 72 hours + 60;
        _push(later);
        agent.seize();
        assertEq(VOUCHER.ownerOf(RIG), address(pool), "voucher seized by the pool");
        assertTrue(agent.closed());
        assertEq(pool.outstandingPrincipal(), 0);
    }
}
