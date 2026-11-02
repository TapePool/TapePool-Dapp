// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IRigVoucher} from "../../src/interfaces/IXLayer.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {TapePool} from "../../src/TapePool.sol";
import {AgentFactory} from "../../src/AgentFactory.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {TapeLens} from "../../src/TapeLens.sol";
import {MockBEM, MockVoucher, MockRigFeed, MockCreditPolicy} from "../mocks/Mocks.sol";

/// Shared setup for the unit tests: the real contracts on mock BEM, voucher, feed and policy.
/// No fork, no network.
abstract contract Base is Test {
    uint256 constant BEM = 1e8;
    uint64 constant NETWORK_WEIGHT = 1_579_201; // snapshot 2026-10-18

    MockBEM bem;
    MockVoucher voucher;
    MockRigFeed feed;
    MockCreditPolicy policy;
    AgentFactory factory;
    TapePool pool;
    TapeLens lens;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address lp = makeAddr("lp");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");

    /// The operating fee every borrow carries at launch (SPEC-PHASE3-OPSFEE D-O2).
    uint256 internal constant OPS = 0;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        bem = new MockBEM();
        voucher = new MockVoucher(address(bem));
        feed = new MockRigFeed();
        policy = new MockCreditPolicy(feed, 1);
        (factory, pool) = _deploy(policy);
        lens = new TapeLens();
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    /// Factory first with the pool's predicted address, then the pool (it checks the prediction).
    function _deploy(MockCreditPolicy p) internal returns (AgentFactory f, TapePool tp) {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        f = new AgentFactory(predicted, IRigVoucher(address(voucher)), IERC20(address(bem)), feed);
        tp = new TapePool(IERC20(address(bem)), f, p, owner, guardian, lp);
        vm.prank(owner);
        tp.unpauseBorrows();
        assertEq(address(tp), predicted, "pool address prediction");
    }

    // ───────────────────────── helpers

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        bem.mint(who, amount);
        vm.startPrank(who);
        bem.approve(address(pool), amount);
        shares = pool.deposit(amount, who);
        vm.stopPrank();
    }

    function _agent(address borrower, uint256 index) internal returns (RigAgent a) {
        vm.prank(borrower);
        a = RigAgent(factory.create(index));
    }

    /// A healthy, fresh report: base power `base`, bonus 10, active, custodied, 30 days old.
    function _report(uint256 id, uint64 base) internal view returns (RigReport memory r) {
        r.rigId = uint64(id);
        r.circuitId = uint64(id + 1000);
        r.since = uint64(block.timestamp - 30 days);
        r.circuits = address(0xC1C);
        r.observedAt = uint64(block.timestamp + 60);
        r.status = 1;
        r.custodied = true;
        r.verifWeight = base + 10;
        r.bonus = 10;
        r.totalVerifWeight = NETWORK_WEIGHT;
        r.bscBlock = 1;
        r.taskId = 4;
    }

    /// Mint voucher `id` to `borrower` (bridge-style, no hook) and post a fresh report.
    function _rig(address borrower, uint256 id, uint64 base) internal {
        voucher.mint(borrower, id, base + 10);
        feed.set(_report(id, base));
    }

    /// Re-post a fresh healthy report for `id` at the current time.
    function _refresh(uint256 id, uint64 base) internal {
        feed.set(_report(id, base));
    }

    function _pledge(RigAgent a, address borrower, uint256 id) internal {
        vm.prank(borrower);
        voucher.safeTransferFrom(borrower, address(a), id);
    }

    /// Agent with one 100 H rig pledged, ready to borrow. Pool funded with 20 BEM.
    function _ready(address borrower, uint256 id) internal returns (RigAgent a) {
        if (pool.totalAssets() == 0) _deposit(lp, 20 * BEM);
        a = _agent(borrower, id);
        _rig(borrower, id, 100);
        _pledge(a, borrower, id);
    }

    function _borrow(RigAgent a, address borrower, uint8 term, uint256 principal) internal {
        uint256 ops = pool.opsFee(term);
        vm.prank(borrower);
        a.borrow{value: ops}(term, principal, type(uint256).max, type(uint16).max);
    }

    /// Simulate a harvest paying `amount` BEM to `to`.
    function _harvest(address to, uint256 amount) internal {
        bem.mint(to, amount);
    }

    /// Preserve the original economic examples by explicitly scheduling their fee and cap settings.
    function _legacyEconomics() internal {
        vm.startPrank(owner);
        pool.queueParam(TapePool.Param.FeeBps7d, 75);
        pool.queueParam(TapePool.Param.FeeBps14d, 150);
        pool.queueParam(TapePool.Param.MinFee, 300_000);
        pool.queueParam(TapePool.Param.PerBorrowerAbs, 500 * BEM);
        pool.queueParam(TapePool.Param.BorrowCapAbs, 10 * BEM);
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours);
        pool.executeParam(TapePool.Param.FeeBps7d);
        pool.executeParam(TapePool.Param.FeeBps14d);
        pool.executeParam(TapePool.Param.MinFee);
        pool.executeParam(TapePool.Param.PerBorrowerAbs);
        pool.executeParam(TapePool.Param.BorrowCapAbs);
    }

    function _queueExecute(TapePool.Param key, uint256 value) internal {
        vm.prank(owner);
        pool.queueParam(key, value);
        vm.warp(block.timestamp + pool.TIMELOCK());
        pool.executeParam(key);
    }

    /// A report for `id` that shows a rig the Safe rescued (what `BscRigReader` returns then).
    function _rescuedReport(uint256 id) internal view returns (RigReport memory r) {
        r.rigId = uint64(id);
        r.observedAt = uint64(block.timestamp + 60);
        r.bscBlock = 2;
    }
}
