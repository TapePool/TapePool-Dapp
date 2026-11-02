// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {XLayerBase, console2} from "../spike/XLayerBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {TapePool} from "../../src/TapePool.sol";
import {AgentFactory} from "../../src/AgentFactory.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {TapeLens} from "../../src/TapeLens.sol";
import {MockRigFeed, MockCreditPolicy} from "../mocks/Mocks.sol";

/// Phase 2 exit on an X Layer fork: the full loan lifecycle with MVP terms, on the REAL BEM OFT,
/// the REAL RIG voucher and harvests delivered through the real LayerZero receive and compose path
/// (spike T2 harness). The data feed and the credit policy are Phase 3; mocks stand in for them.
/// LOCAL FORK ONLY: prank and deal never leave this process.
contract ForkLifecycleTest is XLayerBase {
    address constant BIG_HOLDER = 0x571d447f4f24688eC35Ccf07f1D6993655F6aF15;
    uint256 constant ID = 4; // 107 H base power at the snapshot, held by HOLDER_C905
    uint64 constant BASE = 107;
    uint64 constant NETWORK = 1_579_201;

    IERC20 bem = IERC20(address(BEM));
    MockRigFeed feed;
    MockCreditPolicy policy;
    AgentFactory factory;
    TapePool pool;
    TapeLens lens;
    RigAgent agent;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address lp = makeAddr("lp");
    address keeper = makeAddr("keeper");
    address borrower = HOLDER_C905;
    /// The operating fee every borrow carries at launch (SPEC-PHASE3-OPSFEE D-O2).
    uint256 constant OPS = 0;

    function setUp() public {
        _fork();
        feed = new MockRigFeed();
        policy = new MockCreditPolicy(feed, 1);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        factory = new AgentFactory(predicted, VOUCHER, bem, feed);
        pool = new TapePool(bem, factory, policy, owner, guardian, lp);
        vm.startPrank(owner);
        pool.unpauseBorrows();
        pool.queueParam(TapePool.Param.FeeBps7d, 75);
        pool.queueParam(TapePool.Param.FeeBps14d, 150);
        pool.queueParam(TapePool.Param.MinFee, 300_000);
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours);
        pool.executeParam(TapePool.Param.FeeBps7d);
        pool.executeParam(TapePool.Param.FeeBps14d);
        pool.executeParam(TapePool.Param.MinFee);
        lens = new TapeLens();
        vm.deal(borrower, borrower.balance + 1 ether); // OKB for the operating fee

        vm.prank(BIG_HOLDER);
        bem.transfer(lp, 20e8);
        vm.startPrank(lp);
        bem.approve(address(pool), type(uint256).max);
        pool.deposit(20e8, lp); // the whole MVP supply cap
        vm.stopPrank();

        vm.prank(borrower);
        agent = RigAgent(factory.create(0));
        vm.warp(block.timestamp + 60);
        vm.prank(borrower);
        VOUCHER.safeTransferFrom(borrower, address(agent), ID);
        feed.set(_report(ID, BASE));
    }

    function _report(uint256 id, uint64 base) internal view returns (RigReport memory r) {
        (address circuits,, uint256 circuitId,) = VOUCHER.rigs(id);
        r.rigId = uint64(id);
        r.circuitId = uint64(circuitId);
        r.circuits = circuits;
        r.since = uint64(block.timestamp - 30 days);
        r.observedAt = uint64(block.timestamp + 60);
        r.status = 1;
        r.custodied = true;
        r.verifWeight = base;
        r.totalVerifWeight = NETWORK;
        r.taskId = 4;
    }

    function _rescued(uint256 id) internal view returns (RigReport memory r) {
        r.rigId = uint64(id);
        r.observedAt = uint64(block.timestamp + 60);
    }

    function _harvest(uint64 amountSD, uint64 sendTime) internal {
        (,,, uint256 power) = VOUCHER.rigs(ID);
        _deliverHarvest(ID, amountSD, sendTime, power);
    }

    function _assertBooks() internal view {
        assertEq(bem.balanceOf(address(pool)), pool.idle() + pool.reserve(), "balance = idle + reserve");
        assertEq(pool.loanPrincipalOf(address(agent)), agent.loanOf().principal, "pool and agent agree");
        assertEq(pool.outstandingPrincipal(), agent.loanOf().principal, "one loan in the pool");
    }

    function test_fork_7_day_loan_repaid_by_mined_bem() public {
        assertEq(agent.collateralOf()[0], ID, "real voucher registered through the hook");
        TapeLens.Quote memory q = lens.quote(agent, 0);
        assertEq(q.reason, 0);
        console2.log("quote: max principal for 107 H over 7 days (raw BEM)", q.maxPrincipal);

        assertEq(q.opsFee, OPS, "the quote shows the operating fee");
        uint256 before = bem.balanceOf(borrower);
        uint256 ownerOkb = owner.balance;
        uint256 g = gasleft();
        vm.prank(borrower);
        agent.borrow{value: OPS}(0, 2e8, type(uint256).max, type(uint16).max);
        console2.log("gas borrow", g - gasleft());
        assertEq(bem.balanceOf(borrower) - before, 2e8, "advance to the borrower");
        assertEq(owner.balance - ownerOkb, OPS, "the operating fee reached the owner");
        assertEq(address(agent).balance, 0, "the agent keeps no OKB");
        RigAgent.LoanView memory v = agent.loanOf();
        assertEq(v.feeLeft, 1_500_000, "0.75% of 2 BEM");
        assertEq(v.maturity, block.timestamp + 7 days);

        vm.warp(block.timestamp + 3 days);
        _harvest(1_000_000, uint64(block.timestamp - 1 hours)); // 1 BEM mined during the loan
        assertEq(bem.balanceOf(address(agent)), 1e8, "harvest pays the agent");
        g = gasleft();
        vm.prank(keeper);
        agent.sweep();
        console2.log("gas sweep", g - gasleft());
        v = agent.loanOf();
        assertEq(v.feeLeft, 0, "fee first");
        assertEq(v.principal, 2e8 - (1e8 - 1_500_000));
        assertEq(pool.reserve(), 300_000, "20% of the fee");
        _assertBooks();

        vm.warp(block.timestamp + 3 days);
        _harvest(1_500_000, uint64(block.timestamp - 1 hours));
        before = bem.balanceOf(borrower);
        vm.prank(keeper);
        agent.sweep();
        assertFalse(agent.hasLoan(), "repaid before maturity");
        assertEq(bem.balanceOf(borrower) - before, 1.5e8 - v.principal, "leftover to the borrower");
        _assertBooks();

        vm.prank(borrower);
        agent.release();
        assertEq(VOUCHER.ownerOf(ID), borrower, "voucher back to the miner");

        vm.warp(pool.vestEnd());
        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        uint256 out = pool.redeem(shares, lp, lp);
        console2.log("LP redeemed (raw BEM) for 20e8 deposited", out);
        assertApproxEqAbs(out, 20e8 + 1_200_000, 1, "lenders earned 80% of the fee");
    }

    function test_fork_14_day_shortfall_is_not_a_default() public {
        vm.prank(borrower);
        agent.borrow{value: OPS}(1, 4e8, type(uint256).max, type(uint16).max);
        vm.warp(block.timestamp + 15 days);
        _harvest(1_000_000, uint64(block.timestamp - 1 days));
        agent.sweep();
        assertTrue(agent.hasLoan(), "still owes after maturity");
        feed.set(_report(ID, BASE));
        vm.expectRevert(RigAgent.NoEvidence.selector);
        agent.flagImpaired(ID);
        vm.expectRevert(RigAgent.NoFlag.selector);
        agent.seize();
        assertEq(agent.loanOf().lateFeeDue, 0, "late fee 0 at launch");

        vm.warp(block.timestamp + 5 days);
        _harvest(4_000_000, uint64(block.timestamp - 1 days));
        agent.sweep();
        assertFalse(agent.hasLoan(), "the live rig repaid it late");
        _assertBooks();
    }

    function test_fork_rescued_rig_flagged_then_seized() public {
        vm.prank(borrower);
        agent.borrow{value: OPS}(0, 2e8, type(uint256).max, type(uint16).max);
        vm.warp(block.timestamp + 1 days);
        feed.set(_rescued(ID));
        agent.flagImpaired(ID);
        assertEq(pool.totalAssets(), 18e8, "marked doubtful at the flag");
        uint64 lateSend = uint64(block.timestamp + 1 hours); // sent while the agent still holds it

        vm.warp(block.timestamp + 72 hours);
        feed.set(_rescued(ID));
        uint256 g = gasleft();
        vm.prank(keeper);
        agent.seize();
        console2.log("gas seize (real voucher transfer)", g - gasleft());
        assertEq(VOUCHER.ownerOf(ID), address(pool), "the real voucher moved within the gas cap");
        assertTrue(agent.closed());
        assertEq(pool.outstandingPrincipal(), 0);
        assertEq(pool.doubtful(), 0);

        // sent before the seize, landing after: paid to the agent, forwarded to the pool
        uint256 idle = pool.idle();
        _harvest(500_000, lateSend);
        agent.sweep();
        pool.sync();
        assertEq(pool.idle() - idle, 0.5e8);
        // sent after the seize: the pool is the holder and mines for itself
        vm.warp(block.timestamp + 1 days);
        idle = pool.idle();
        _harvest(300_000, uint64(block.timestamp - 1));
        pool.sync();
        assertEq(pool.idle() - idle, 0.3e8, "seized rig keeps paying the pool");
    }

    function test_fork_power_zero_harvest_is_evidence() public {
        vm.prank(borrower);
        agent.borrow{value: OPS}(0, 1e8, type(uint256).max, type(uint16).max);
        vm.warp(block.timestamp + 1 days);
        uint64 sent = uint64(block.timestamp - 10);
        _deliverHarvest(ID, 10_000, sent, 0); // a stopped or revoked rig syncs power 0
        (, uint64 syncedAt,, uint256 power) = VOUCHER.rigs(ID);
        assertEq(power, 0, "the real voucher records power 0");
        assertEq(syncedAt, sent);
        agent.flagImpaired(ID);
        uint64 flaggedAt = agent.loanOf().impairedAt;

        vm.warp(uint256(flaggedAt) + 72 hours + 90);
        _deliverHarvest(ID, 10_000, uint64(block.timestamp - 30), 0);
        agent.seize();
        assertEq(VOUCHER.ownerOf(ID), address(pool));
    }

    function test_fork_late_fee_after_a_timelocked_raise() public {
        vm.prank(owner);
        pool.queueParam(TapePool.Param.LateFeeBpsPerDay, 10);
        vm.warp(block.timestamp + 48 hours);
        pool.executeParam(TapePool.Param.LateFeeBpsPerDay);
        feed.set(_report(ID, BASE));
        vm.prank(borrower);
        agent.borrow{value: OPS}(0, 1e8, type(uint256).max, type(uint16).max);
        vm.warp(block.timestamp + 8 days);
        assertEq(agent.loanOf().lateFeeDue, 100_000, "0.1% per day on the remaining principal");
        _harvest(2_000_000, uint64(block.timestamp - 1 hours));
        agent.sweep();
        assertFalse(agent.hasLoan());
    }
}
