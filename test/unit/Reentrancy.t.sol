// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
    MessagingParams,
    MessagingReceipt,
    MessagingFee
} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {IRigVoucher} from "../../src/interfaces/IXLayer.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {IRigVaultBsc, IPodMining} from "../../src/interfaces/IBsc.sol";
import {TapePool} from "../../src/TapePool.sol";
import {AgentFactory} from "../../src/AgentFactory.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {TapeLens} from "../../src/TapeLens.sol";
import {Reasons} from "../../src/interfaces/ICreditPolicy.sol";
import {RigReporter} from "../../src/feed/RigReporter.sol";
import {MockRigFeed, MockCreditPolicy} from "../mocks/Mocks.sol";
import {Probe, HookBEM, HostileVoucher} from "../mocks/Hostile.sol";

/// The real pool, factory and agents on hostile BEM and a hostile voucher (Phase 4 part A, §4.4).
abstract contract HostileBase is Test {
    uint256 constant BEM = 1e8;
    uint256 constant OPS = 0.031 ether;
    uint64 constant NETWORK_WEIGHT = 1_579_201;
    uint256 constant ID = 7;
    uint256 constant ID2 = 8;
    uint256 constant ID3 = 9;

    HookBEM bem;
    HostileVoucher voucher;
    MockRigFeed feed;
    MockCreditPolicy policy;
    AgentFactory factory;
    TapePool pool;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address lp = makeAddr("lp");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");

    bytes4 internal LOCKED = ReentrancyGuard.ReentrancyGuardReentrantCall.selector;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        bem = new HookBEM();
        voucher = new HostileVoucher(address(bem));
        feed = new MockRigFeed();
        policy = new MockCreditPolicy(feed, 1);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        factory = new AgentFactory(predicted, IRigVoucher(address(voucher)), IERC20(address(bem)), feed);
        pool = new TapePool(IERC20(address(bem)), factory, policy, owner, guardian, lp);
        vm.prank(owner);
        pool.unpauseBorrows();
        assertEq(address(pool), predicted, "pool address prediction");
        vm.startPrank(owner);
        pool.queueParam(TapePool.Param.OpsFee7d, OPS);
        pool.queueParam(TapePool.Param.OpsFee14d, OPS);
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours);
        pool.executeParam(TapePool.Param.OpsFee7d);
        pool.executeParam(TapePool.Param.OpsFee14d);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    // ───────────────────────── helpers

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        bem.mint(who, amount);
        vm.startPrank(who);
        bem.approve(address(pool), amount);
        shares = pool.deposit(amount, who);
        vm.stopPrank();
    }

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

    /// A report showing a rig the Safe rescued: the vault no longer knows it.
    function _rescued(uint256 id) internal view returns (RigReport memory r) {
        r.rigId = uint64(id);
        r.observedAt = uint64(block.timestamp + 60);
        r.bscBlock = 2;
    }

    function _agent(address borrower, uint256 index) internal returns (RigAgent a) {
        vm.prank(borrower);
        a = RigAgent(factory.create(index));
    }

    /// Agent of `borrower` with one 100 H rig pledged. Pool funded with 20 BEM.
    function _ready(address borrower, uint256 id) internal returns (RigAgent a) {
        if (pool.totalAssets() == 0) _deposit(lp, 20 * BEM);
        a = _agent(borrower, id);
        voucher.mint(borrower, id, 110);
        feed.set(_report(id, 100));
        vm.prank(borrower);
        voucher.safeTransferFrom(borrower, address(a), id);
    }

    function _borrow(RigAgent a, address borrower, uint8 term, uint256 principal) internal {
        vm.prank(borrower);
        a.borrow{value: OPS}(term, principal, type(uint256).max, type(uint16).max);
    }

    /// A probe that is the pool's owner.
    function _probeOwner() internal returns (Probe p) {
        p = new Probe();
        vm.prank(owner);
        pool.transferOwnership(address(p));
        p.exec(address(pool), abi.encodeWithSignature("acceptOwnership()"));
        assertEq(pool.owner(), address(p));
    }

    /// A probe that is a borrower, with its own agent and voucher `id` pledged through the hook.
    function _probeBorrower(uint256 id) internal returns (Probe p, RigAgent a) {
        p = new Probe();
        if (pool.totalAssets() == 0) _deposit(lp, 20 * BEM);
        a = RigAgent(abi.decode(p.exec(address(factory), abi.encodeCall(AgentFactory.create, (0))), (address)));
        voucher.mint(address(p), id, 110);
        feed.set(_report(id, 100));
        p.exec(
            address(voucher),
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", address(p), address(a), id)
        );
        p.watch(a, pool);
    }

    function _probeBorrow(Probe p, RigAgent a, uint256 principal) internal {
        p.exec{value: OPS}(
            address(a), abi.encodeCall(RigAgent.borrow, (0, principal, type(uint256).max, type(uint16).max))
        );
    }

    /// Flag `a` on rescue evidence for `id`, then open the seize window with fresh evidence.
    function _toSeizeWindow(RigAgent a, uint256 id) internal {
        feed.set(_rescued(id));
        a.flagImpaired(id);
        vm.warp(block.timestamp + a.CURE_WINDOW() + 1);
        feed.set(_rescued(id));
    }

    function _sel(bytes memory r) internal pure returns (bytes4 s) {
        if (r.length >= 4) {
            assembly {
                s := mload(add(r, 0x20))
            }
        }
    }

    function _assertFailedWith(Probe p, uint256 i, bytes4 sel, string memory what) internal view {
        assertFalse(p.okAt(i), string.concat(what, ": the re-entrant call succeeded"));
        assertEq(_sel(p.resultAt(i)), sel, what);
    }

    /// SPEC §15 accounting equalities 1 to 3, over the given agents.
    function _books(RigAgent[] memory agents) internal view {
        assertLe(pool.reserve(), bem.balanceOf(address(pool)), "reserve above pool BEM");
        assertEq(bem.balanceOf(address(pool)), pool.idle() + pool.reserve(), "pool BEM != idle + reserve");
        assertEq(
            pool.totalAssets(),
            pool.idle() + pool.outstandingPrincipal() - pool.doubtful() - pool.unvestedNow(),
            "totalAssets"
        );
        uint256 sumLoans;
        uint256 sumDoubt;
        for (uint256 i; i < agents.length; ++i) {
            uint256 lp_ = agents[i].loanOf().principal;
            sumLoans += lp_;
            sumDoubt += pool.doubtfulOf(address(agents[i]));
            assertEq(pool.loanPrincipalOf(address(agents[i])), lp_, "pool and agent disagree on principal");
            uint256 byBorrower;
            for (uint256 j; j < agents.length; ++j) {
                if (agents[j].borrower() == agents[i].borrower()) byBorrower += agents[j].loanOf().principal;
            }
            assertEq(pool.principalOf(agents[i].borrower()), byBorrower, "principalOf");
        }
        assertEq(pool.outstandingPrincipal(), sumLoans, "outstanding != sum of loans");
        assertEq(pool.doubtful(), sumDoubt, "doubtful != sum of marks");
        assertLe(pool.doubtful(), pool.outstandingPrincipal(), "doubtful above outstanding");
    }

    function _two(RigAgent a, RigAgent b) internal pure returns (RigAgent[] memory r) {
        r = new RigAgent[](2);
        r[0] = a;
        r[1] = b;
    }
}

/// T1–T6: re-entry through the owner's OKB hook, a hooked voucher and hooked BEM.
contract ReentrancyTest is HostileBase {
    // ───────────────────────── T1: the owner's receive hook during borrow's fee call

    function test_T1_owner_hook_meets_the_lock_or_the_borrower_check() public {
        _deposit(lp, 10 * BEM); // below the 20 BEM supply cap, so the hook's deposit has room
        RigAgent a = _ready(alice, ID);
        RigAgent a2 = _agent(alice, 1);
        RigAgent b = _ready(bob, ID2);
        _borrow(b, bob, 0, BEM);
        Probe p = _probeOwner();
        p.watch(a, pool);
        bem.mint(address(p), 2 * BEM);
        p.exec(address(bem), abi.encodeCall(IERC20.approve, (address(pool), type(uint256).max)));

        // the same agent: locked, or onlyBorrower first
        p.arm(address(a), abi.encodeCall(RigAgent.sweep, ()));
        p.arm(address(a), abi.encodeCall(RigAgent.repay, (0)));
        p.arm(address(a), abi.encodeCall(RigAgent.claimLate, ()));
        p.arm(address(a), abi.encodeCall(RigAgent.flagImpaired, (ID)));
        p.arm(address(a), abi.encodeCall(RigAgent.clearExpiredFlag, ()));
        p.arm(address(a), abi.encodeCall(RigAgent.seize, ()));
        p.arm(address(a), abi.encodeCall(RigAgent.forwardVouchers, ()));
        p.arm(address(a), abi.encodeCall(RigAgent.register, (ID)));
        p.arm(address(a), abi.encodeCall(RigAgent.withdrawVoucher, (ID)));
        p.arm(address(a), abi.encodeCall(RigAgent.release, ()));
        p.arm(address(a), abi.encodeCall(RigAgent.borrow, (0, BEM, type(uint256).max, type(uint16).max)));
        // other agents, the pool, the factory
        p.arm(address(b), abi.encodeCall(RigAgent.sweep, ())); // 11
        p.arm(address(a2), abi.encodeCall(RigAgent.claimLate, ())); // 12
        p.arm(address(pool), abi.encodeCall(TapePool.lend, (1))); // 13
        p.arm(address(pool), abi.encodeCall(TapePool.repay, (0, 0))); // 14
        p.arm(address(pool), abi.encodeCall(TapePool.markDoubtful, ())); // 15
        p.arm(address(pool), abi.encodeCall(TapePool.clearDoubtful, ())); // 16
        p.arm(address(pool), abi.encodeCall(TapePool.writeOff, ())); // 17
        p.arm(address(pool), abi.encodeWithSignature("deposit(uint256,address)", BEM, address(p))); // 18
        p.arm(address(factory), abi.encodeCall(AgentFactory.create, (5))); // 19

        _borrow(a, alice, 0, BEM);

        assertEq(p.fired(), 1, "the hook ran once");
        for (uint256 i; i < 7; ++i) {
            _assertFailedWith(p, i, LOCKED, "permissionless entry point");
        }
        for (uint256 i = 7; i < 11; ++i) {
            _assertFailedWith(p, i, RigAgent.NotBorrower.selector, "borrower-only entry point");
        }
        assertTrue(p.okAt(11), "another borrower's agent can be swept");
        assertTrue(p.okAt(12), "another agent of the same borrower is usable");
        for (uint256 i = 13; i < 18; ++i) {
            _assertFailedWith(p, i, TapePool.NotAgent.selector, "pool agent entry point");
        }
        assertTrue(p.okAt(18), "the pool takes a deposit from the hook");
        assertTrue(p.okAt(19), "the factory makes an agent from the hook");

        // the fee call is the last external call: the pool already knows the loan
        Probe.Views memory v = p.seen();
        assertTrue(v.hasLoan);
        assertEq(v.loanPrincipal, BEM);
        assertEq(v.poolLoanPrincipal, BEM, "pool.lend ran before the fee call");

        RigAgent probeAgent = RigAgent(factory.predictAgent(address(p), 5));
        RigAgent[] memory all = new RigAgent[](4);
        all[0] = a;
        all[1] = a2;
        all[2] = b;
        all[3] = probeAgent;
        _books(all);
    }

    function test_T1_owner_who_is_the_borrower_meets_the_lock() public {
        Probe p = _probeOwner();
        _deposit(lp, 20 * BEM);
        RigAgent a = RigAgent(abi.decode(p.exec(address(factory), abi.encodeCall(AgentFactory.create, (0))), (address)));
        voucher.mint(address(p), ID, 110);
        voucher.mint(address(p), ID2, 110);
        feed.set(_report(ID, 100));
        p.exec(
            address(voucher),
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", address(p), address(a), ID)
        );
        // ID2 arrives by plain transfer, so `register` has something to add
        p.exec(address(voucher), abi.encodeCall(IRigVoucher.transferFrom, (address(p), address(a), ID2)));
        p.watch(a, pool);
        p.arm(address(a), abi.encodeCall(RigAgent.register, (ID2)));
        p.arm(address(a), abi.encodeCall(RigAgent.withdrawVoucher, (ID)));
        p.arm(address(a), abi.encodeCall(RigAgent.release, ()));
        p.arm(address(a), abi.encodeCall(RigAgent.borrow, (0, BEM, type(uint256).max, type(uint16).max)));

        _probeBorrow(p, a, BEM);

        for (uint256 i; i < 4; ++i) {
            _assertFailedWith(p, i, LOCKED, "borrower-only entry point, caller is the borrower");
        }
        assertTrue(a.hasLoan());
        assertEq(address(p).balance, OPS, "the owner got the fee");
    }

    // ───────────────────────── T2: a voucher with a transfer hook

    function test_T2_release_hook_sees_an_empty_set_and_meets_the_lock() public {
        (Probe p, RigAgent a) = _probeBorrower(ID);
        p.primeLight();
        voucher.setHook(p, ID, address(a));
        p.arm(address(a), abi.encodeCall(RigAgent.release, ()));
        p.exec(address(a), abi.encodeCall(RigAgent.release, ()));
        assertEq(p.fired(), 2);
        assertFalse(p.lightOk());
        assertEq(p.lightSel(), LOCKED);
        assertEq(p.lightCollateralLen(), 1, "empty collateral plus one");
        assertEq(voucher.ownerOf(ID), address(p));
        assertEq(a.collateralOf().length, 0);
    }

    function test_T2_withdrawVoucher_hook_meets_the_lock() public {
        (Probe p, RigAgent a) = _probeBorrower(ID);
        voucher.setHook(p, ID, address(a));
        p.arm(address(a), abi.encodeCall(RigAgent.release, ()));
        p.arm(address(a), abi.encodeCall(RigAgent.withdrawVoucher, (ID)));
        p.exec(address(a), abi.encodeCall(RigAgent.withdrawVoucher, (ID)));
        _assertFailedWith(p, 0, LOCKED, "release during withdrawVoucher");
        _assertFailedWith(p, 1, LOCKED, "withdrawVoucher during withdrawVoucher");
        assertEq(p.seen().collateralLen, 0, "the id left the set before the transfer");
        assertEq(voucher.ownerOf(ID), address(p));
        assertEq(voucher.moves(ID), 2);
    }

    struct SeizeOutcome {
        uint256 totalAssets;
        uint256 reserve;
        uint256 outstanding;
        uint256 doubtful;
        address holder;
        uint256 collateralLen;
        bool closed;
    }

    function _seizeOutcome(RigAgent a) internal view returns (SeizeOutcome memory o) {
        o.totalAssets = pool.totalAssets();
        o.reserve = pool.reserve();
        o.outstanding = pool.outstandingPrincipal();
        o.doubtful = pool.doubtful();
        o.holder = voucher.ownerOf(ID);
        o.collateralLen = a.collateralOf().length;
        o.closed = a.closed();
    }

    function test_T2_seize_hook_sees_a_closed_agent_and_matches_a_run_without_hook() public {
        (Probe p, RigAgent a) = _probeBorrower(ID);
        _probeBorrow(p, a, BEM);
        bem.mint(address(a), BEM / 10); // part of the debt is in the agent at the seize
        _toSeizeWindow(a, ID);

        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        a.seize();
        SeizeOutcome memory plain = _seizeOutcome(a);
        vm.revertToState(snap);

        // each transfer try has 200,000 gas, so the hook is a light one: one re-entrant call per run
        bytes[4] memory calls = [
            abi.encodeCall(RigAgent.forwardVouchers, ()),
            abi.encodeCall(RigAgent.sweep, ()),
            abi.encodeCall(RigAgent.claimLate, ()),
            abi.encodeCall(RigAgent.withdrawVoucher, (ID))
        ];
        for (uint256 i; i < 4; ++i) {
            vm.revertToState(snap);
            p.primeLight();
            voucher.setHook(p, ID, address(a));
            p.arm(address(a), calls[i]);
            vm.prank(keeper);
            a.seize();
            assertEq(p.fired(), 2, "the hook ran inside the transfer");
            assertTrue(p.lightClosed(), "closed before the voucher moves");
            assertFalse(p.lightHasLoan(), "the loan is gone before the voucher moves");
            assertEq(p.lightCollateralLen(), 1, "empty set during the voucher call, plus one");
            assertEq(p.lightPoolLoan(), 1, "written off before the voucher moves"); // 0 + 1
            assertFalse(p.lightOk(), "the re-entrant call failed");
            assertEq(p.lightSel(), LOCKED, "agent call during seize");
            SeizeOutcome memory hooked = _seizeOutcome(a);
            assertEq(abi.encode(hooked), abi.encode(plain), "seize with a hook = seize without");
            assertEq(hooked.holder, address(pool));
            assertEq(voucher.moves(ID), 2, "pledged once, seized once");
        }
    }

    /// A hook that needs more than the 200,000 gas of a transfer try makes that try fail: `seize`
    /// still finishes and the voucher waits in the closed agent for `forwardVouchers`.
    function test_T2_a_hook_above_the_gas_cap_only_leaves_the_voucher_for_forwardVouchers() public {
        (Probe p, RigAgent a) = _probeBorrower(ID);
        _probeBorrow(p, a, BEM);
        _toSeizeWindow(a, ID);
        voucher.setHook(p, ID, address(a)); // full mode: writes a fresh snapshot, far above 200,000
        p.arm(address(a), abi.encodeCall(RigAgent.forwardVouchers, ()));
        vm.prank(keeper);
        a.seize();
        assertTrue(a.closed(), "seize finished");
        assertEq(pool.loanPrincipalOf(address(a)), 0, "written off");
        assertEq(voucher.ownerOf(ID), address(a), "the heavy hook made the try fail");
        assertEq(a.collateralOf().length, 1, "kept for forwardVouchers");
        voucher.clearHook();
        vm.prank(keeper);
        a.forwardVouchers();
        assertEq(voucher.ownerOf(ID), address(pool));
        assertEq(a.collateralOf().length, 0);
    }

    function test_T2_forwardVouchers_hook_meets_the_lock_and_moves_once() public {
        (Probe p, RigAgent a) = _probeBorrower(ID);
        _probeBorrow(p, a, BEM);
        _toSeizeWindow(a, ID);
        voucher.setBlocked(ID, true);
        vm.prank(keeper);
        a.seize();
        assertEq(voucher.ownerOf(ID), address(a), "stuck at the seize");
        voucher.setBlocked(ID, false);
        p.primeLight();
        voucher.setHook(p, ID, address(a));
        p.arm(address(a), abi.encodeCall(RigAgent.forwardVouchers, ()));
        vm.prank(keeper);
        a.forwardVouchers();
        assertEq(p.fired(), 2, "the hook ran inside the transfer");
        assertFalse(p.lightOk());
        assertEq(p.lightSel(), LOCKED, "forwardVouchers during forwardVouchers");
        assertEq(voucher.ownerOf(ID), address(pool));
        assertEq(a.collateralOf().length, 0);
        assertEq(voucher.moves(ID), 2);
    }

    // ───────────────────────── T3: BEM with transfer hooks

    function test_T3_agent_reentry_meets_the_lock_on_every_bem_transfer() public {
        (Probe p, RigAgent a) = _probeBorrower(ID);

        // borrow: the advance reaches the borrower (after the balance change)
        bem.setHook(p, address(p), HookBEM.When.AfterTo);
        p.arm(address(a), abi.encodeCall(RigAgent.sweep, ()));
        p.arm(address(a), abi.encodeCall(RigAgent.repay, (0)));
        _probeBorrow(p, a, BEM);
        _assertFailedWith(p, 0, LOCKED, "sweep during borrow");
        _assertFailedWith(p, 1, LOCKED, "repay during borrow");

        // repay: the borrower pays the agent (before the balance change)
        p.exec(address(bem), abi.encodeCall(IERC20.approve, (address(a), type(uint256).max)));
        bem.setHook(p, address(p), HookBEM.When.BeforeFrom);
        p.arm(address(a), abi.encodeCall(RigAgent.sweep, ()));
        p.exec(address(a), abi.encodeCall(RigAgent.repay, (BEM / 2)));
        _assertFailedWith(p, 2, LOCKED, "sweep during repay");

        // sweep: the pool pulls from the agent (before), then the leftover reaches the borrower (after)
        bem.mint(address(a), 2 * BEM);
        bem.setHook(p, address(a), HookBEM.When.BeforeFrom);
        p.arm(address(a), abi.encodeCall(RigAgent.claimLate, ()));
        vm.prank(keeper);
        a.sweep();
        _assertFailedWith(p, 3, LOCKED, "claimLate during sweep");
        assertFalse(a.hasLoan(), "the loan closed");

        // claimLate: late BEM reaches the borrower (after)
        bem.mint(address(a), BEM / 3);
        bem.setHook(p, address(p), HookBEM.When.AfterTo);
        p.arm(address(a), abi.encodeCall(RigAgent.sweep, ()));
        vm.prank(keeper);
        a.claimLate();
        _assertFailedWith(p, 4, LOCKED, "sweep during claimLate");
        assertEq(bem.balanceOf(address(a)), 0);
    }

    function test_T3_agent_reentry_meets_the_lock_during_seize() public {
        (Probe p, RigAgent a) = _probeBorrower(ID);
        _probeBorrow(p, a, BEM);
        _toSeizeWindow(a, ID);
        bem.mint(address(a), BEM / 10);
        bem.observeSettlement(a);
        bem.setHook(p, address(a), HookBEM.When.BeforeFrom); // the pool's pull in the waterfall
        p.arm(address(a), abi.encodeCall(RigAgent.forwardVouchers, ()));
        p.arm(address(a), abi.encodeCall(RigAgent.sweep, ()));
        vm.prank(keeper);
        a.seize();
        _assertFailedWith(p, 0, LOCKED, "forwardVouchers during seize");
        _assertFailedWith(p, 1, LOCKED, "sweep during seize");
        assertTrue(a.closed());
        assertTrue(p.seen().closed);
        assertFalse(p.seen().hasLoan);
        assertEq(p.seen().collateralLen, 0);
    }

    /// A loan whose agent holds enough BEM to close it, and a probe with BEM to deposit.
    function _repayableLoan() internal returns (RigAgent a, Probe p) {
        _deposit(lp, 10 * BEM);
        a = _ready(alice, ID);
        _borrow(a, alice, 0, 2 * BEM);
        bem.mint(address(a), 3 * BEM);
        p = new Probe();
        p.watch(a, pool);
        bem.mint(address(p), 5 * BEM);
        p.exec(address(bem), abi.encodeCall(IERC20.approve, (address(pool), type(uint256).max)));
    }

    /// W1: inside `pool.repay`, before the pull, the pool's books are final but the BEM has not
    /// arrived, so `totalAssets` is low by the fee and the principal being paid.
    function test_T3_W1_repay_window_deposit_mints_more_shares() public {
        (RigAgent a, Probe p) = _repayableLoan();
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        a.sweep();
        uint256 sharesAfter =
            abi.decode(p.exec(address(pool), abi.encodeCall(pool.deposit, (BEM, address(p)))), (uint256));
        vm.revertToState(snap);

        uint256 taBefore = pool.totalAssets();
        bem.setHook(p, address(a), HookBEM.When.BeforeFrom);
        p.arm(address(pool), abi.encodeCall(pool.deposit, (BEM, address(p))));
        vm.prank(keeper);
        a.sweep();
        _assertFailedWith(p, 0, LOCKED, "pool deposit during repay");
        uint256 sharesIn = sharesAfter;
        Probe.Views memory v = p.seen();
        console.log("W1 totalAssets before / in window / after:", taBefore, v.totalAssets, pool.totalAssets());
        console.log("W1 shares for 1 BEM in window / after the call:", sharesIn, sharesAfter);
        assertLt(v.totalAssets, taBefore, "totalAssets is low inside the window");
        assertEq(sharesIn, sharesAfter);
    }

    /// W2: inside `pool.lend`, before the BEM leaves, `totalAssets` is high by the principal.
    function test_T3_W2_lend_window_redeem_pays_more() public {
        _deposit(lp, 10 * BEM);
        RigAgent a = _ready(alice, ID);
        Probe p = new Probe();
        p.watch(a, pool);
        bem.mint(address(p), 4 * BEM);
        p.exec(address(bem), abi.encodeCall(IERC20.approve, (address(pool), type(uint256).max)));
        uint256 shares =
            abi.decode(p.exec(address(pool), abi.encodeCall(pool.deposit, (4 * BEM, address(p)))), (uint256));

        uint256 snap = vm.snapshotState();
        _borrow(a, alice, 0, 2 * BEM);
        uint256 assetsAfter = pool.previewRedeem(shares);
        vm.revertToState(snap);

        bem.setHook(p, address(pool), HookBEM.When.BeforeFrom);
        p.arm(address(pool), abi.encodeCall(pool.redeem, (shares, address(p), address(p))));
        _borrow(a, alice, 0, 2 * BEM);
        _assertFailedWith(p, 0, LOCKED, "pool redeem during lend");
        uint256 assetsIn = assetsAfter;
        console.log("W2 assets for the probe's shares in window / after the call:", assetsIn, assetsAfter);
        assertEq(assetsIn, assetsAfter);
    }

    /// W3 and W4: OZ's deposit moves the BEM before it mints, and withdraw burns before it pays.
    function test_T3_W3_W4_vault_windows_redeem_pays_more() public {
        _deposit(lp, 10 * BEM);
        Probe p = new Probe();
        p.watch(RigAgent(address(0)), pool);
        bem.mint(address(p), 4 * BEM);
        p.exec(address(bem), abi.encodeCall(IERC20.approve, (address(pool), type(uint256).max)));
        uint256 shares =
            abi.decode(p.exec(address(pool), abi.encodeCall(pool.deposit, (4 * BEM, address(p)))), (uint256));
        bem.mint(bob, 4 * BEM);
        vm.prank(bob);
        bem.approve(address(pool), type(uint256).max);

        // W3: bob deposits; the hook fires after the BEM reaches the pool, before the mint
        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        pool.deposit(4 * BEM, bob);
        uint256 w3After = pool.previewRedeem(shares);
        vm.revertToState(snap);
        bem.setHook(p, address(pool), HookBEM.When.AfterTo);
        p.arm(address(pool), abi.encodeCall(pool.redeem, (shares, address(p), address(p))));
        vm.prank(bob);
        pool.deposit(4 * BEM, bob);
        _assertFailedWith(p, 0, LOCKED, "redeem during deposit");
        uint256 w3In = w3After;
        console.log("W3 assets for the probe's shares in window / after the call:", w3In, w3After);
        assertEq(w3In, w3After);
        vm.revertToState(snap);

        // W4: lp withdraws; the hook fires after the burn, before the BEM leaves
        bem.setHook(p, address(0), HookBEM.When.Off);
        uint256 snap2 = vm.snapshotState();
        vm.prank(lp);
        pool.withdraw(5 * BEM, lp, lp);
        uint256 w4After = pool.previewRedeem(shares);
        vm.revertToState(snap2);
        bem.setHook(p, address(pool), HookBEM.When.BeforeFrom);
        p.disarm();
        p.arm(address(pool), abi.encodeCall(pool.redeem, (shares, address(p), address(p))));
        vm.prank(lp);
        pool.withdraw(5 * BEM, lp, lp);
        _assertFailedWith(p, 0, LOCKED, "redeem during withdraw");
        uint256 w4In = w4After; // the revert dropped the W3 result
        console.log("W4 assets for the probe's shares in window / after the call:", w4In, w4After);
        assertEq(w4In, w4After);
    }

    /// W5: inside `borrow`, between the loan write and `pool.lend`, the agent shows a loan the pool
    /// does not know yet. The agent is locked, so no agent call can use it.
    function test_T3_W5_borrow_window_shows_a_loan_the_pool_does_not_know() public {
        RigAgent a = _ready(alice, ID);
        bem.mint(address(a), BEM / 4); // BEM mined before the loan goes back to the borrower first
        Probe p = new Probe();
        p.watch(a, pool);
        bem.setHook(p, address(a), HookBEM.When.BeforeFrom);
        p.arm(address(a), abi.encodeCall(RigAgent.sweep, ()));
        uint256 outBefore = pool.outstandingPrincipal();
        _borrow(a, alice, 0, BEM);
        Probe.Views memory v = p.seen();
        assertTrue(v.hasLoan, "the agent shows the loan");
        assertEq(v.loanPrincipal, BEM);
        assertEq(v.poolLoanPrincipal, 0, "the pool does not know it yet");
        assertEq(v.outstanding, outBefore);
        _assertFailedWith(p, 0, LOCKED, "sweep inside the window");
    }

    struct PoolState {
        uint256 totalAssets;
        uint256 totalSupply;
        uint256 reserve;
        uint256 outstanding;
        uint256 probeShares;
        uint256 aliceBem;
    }

    function _poolState(Probe p) internal view returns (PoolState memory s) {
        s.totalAssets = pool.totalAssets();
        s.totalSupply = pool.totalSupply();
        s.reserve = pool.reserve();
        s.outstanding = pool.outstandingPrincipal();
        s.probeShares = pool.balanceOf(address(p));
        s.aliceBem = bem.balanceOf(alice);
    }

    /// After the balance change the books are final: a re-entrant call that succeeds leaves the same
    /// state as the call made on its own afterwards, and one that reverts leaves nothing.
    function test_T3_after_balance_hooks_equal_the_plain_runs() public {
        (RigAgent a, Probe p) = _repayableLoan();
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        a.sweep();
        PoolState memory sweepOnly = _poolState(p);
        p.exec(address(pool), abi.encodeCall(pool.deposit, (BEM, address(p))));
        PoolState memory sweepThenDeposit = _poolState(p);
        vm.revertToState(snap);

        // the leftover reaching alice is the last transfer of the sweep
        uint256 snap2 = vm.snapshotState();
        bem.setHook(p, alice, HookBEM.When.AfterTo);
        p.arm(address(pool), abi.encodeCall(pool.deposit, (BEM, address(p))));
        vm.prank(keeper);
        a.sweep();
        assertTrue(p.okAt(0));
        assertEq(abi.encode(_poolState(p)), abi.encode(sweepThenDeposit), "deposit inside = deposit after");
        vm.revertToState(snap2);

        p.disarm();
        bem.setHook(p, alice, HookBEM.When.AfterTo);
        p.arm(address(a), abi.encodeCall(RigAgent.sweep, ()));
        vm.prank(keeper);
        a.sweep();
        _assertFailedWith(p, 0, LOCKED, "sweep inside the leftover transfer"); // the revert dropped the first result
        assertEq(abi.encode(_poolState(p)), abi.encode(sweepOnly), "a reverted re-entry changes nothing");
    }

    // ───────────────────────── T4: an EIP-7702-style borrower (code on an EOA)

    function test_T4_borrower_with_delegated_code_meets_the_lock() public {
        RigAgent a = _ready(alice, ID);
        vm.etch(alice, address(new Probe()).code);
        Probe pa = Probe(payable(alice));
        pa.watch(a, pool);
        pa.arm(address(a), abi.encodeCall(RigAgent.sweep, ()));
        pa.arm(address(a), abi.encodeCall(RigAgent.release, ()));
        bem.setHook(pa, alice, HookBEM.When.AfterTo);
        _borrow(a, alice, 0, BEM);
        _assertFailedWith(pa, 0, LOCKED, "sweep from the borrower's code during borrow");
        _assertFailedWith(pa, 1, LOCKED, "release from the borrower's code during borrow");
        assertTrue(a.hasLoan());
    }

    // ───────────────────────── T5: the first locked call of a fresh clone

    function test_T5_first_call_of_a_fresh_clone_is_locked() public {
        Probe p = new Probe();
        RigAgent a = RigAgent(abi.decode(p.exec(address(factory), abi.encodeCall(AgentFactory.create, (0))), (address)));
        assertEq(uint256(vm.load(address(a), bytes32(0))), 0, "the clone's guard slot starts at 0");
        voucher.mint(address(p), ID, 110);
        p.exec(address(voucher), abi.encodeCall(IRigVoucher.transferFrom, (address(p), address(a), ID)));
        assertEq(uint256(vm.load(address(a), bytes32(0))), 0, "a plain transfer runs no agent code");
        p.watch(a, pool);
        voucher.setHook(p, ID, address(a));
        p.arm(address(a), abi.encodeCall(RigAgent.withdrawVoucher, (ID)));
        p.arm(address(a), abi.encodeCall(RigAgent.release, ()));
        p.exec(address(a), abi.encodeCall(RigAgent.withdrawVoucher, (ID))); // the clone's first locked call
        _assertFailedWith(p, 0, LOCKED, "re-entry on the first locked call");
        _assertFailedWith(p, 1, LOCKED, "re-entry on the first locked call");
        assertEq(voucher.ownerOf(ID), address(p));
        assertEq(uint256(vm.load(address(a), bytes32(0))), 1, "the guard is released to NOT_ENTERED");
    }

    // ───────────────────────── T6: gas

    function test_T6_needGas_threshold() public pure {
        uint256 cap = 200_000;
        assertEq(cap + cap / 63 + 10_000, 213_174, "VOUCHER_GAS + VOUCHER_GAS / 63 + 10_000");
    }

    /// The smallest gas budget that lets `seize` finish moves every voucher; one gas less reverts the
    /// whole seize. There is no budget at which a seize half happens.
    function test_T6_seize_gas_boundary_is_atomic() public {
        (Probe p, RigAgent a) = _probeBorrower(ID);
        for (uint256 id = 20; id < 23; ++id) {
            voucher.mint(address(p), id, 110);
            feed.set(_report(id, 100));
            p.exec(
                address(voucher),
                abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", address(p), address(a), id)
            );
        }
        _probeBorrow(p, a, BEM);
        _toSeizeWindow(a, ID);
        bytes memory call_ = abi.encodeCall(RigAgent.seize, ());
        uint256 lo = 100_000;
        uint256 hi = 3_000_000;
        uint256 snap = vm.snapshotState();
        (bool okHi,) = address(a).call{gas: hi}(call_);
        assertTrue(okHi, "seize finishes with 3M gas");
        vm.revertToState(snap);
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            uint256 s = vm.snapshotState();
            (bool ok,) = address(a).call{gas: mid}(call_);
            vm.revertToState(s);
            if (ok) hi = mid;
            else lo = mid;
        }
        console.log("seize of 4 vouchers: smallest budget that finishes", hi);
        (bool okLess, bytes memory ret) = address(a).call{gas: hi - 1}(call_);
        assertFalse(okLess);
        assertTrue(ret.length == 0 || _sel(ret) == RigAgent.InsufficientGas.selector, "out of gas or InsufficientGas");
        assertTrue(a.hasLoan(), "nothing happened");
        assertEq(voucher.ownerOf(ID), address(a));
        (bool okAt,) = address(a).call{gas: hi}(call_);
        assertTrue(okAt);
        assertEq(a.collateralOf().length, 0, "every voucher moved");
        for (uint256 id = 20; id < 23; ++id) {
            assertEq(voucher.ownerOf(id), address(pool));
        }
    }

    /// Candidate N3: the transfer works, then `ownerOf` burns its 200,000. The pool holds the voucher
    /// but the closed agent still lists it, and `forwardVouchers` cannot clear it.
    function test_T6_N3_owner_of_that_burns_gas_leaves_a_stale_list() public {
        (Probe p, RigAgent a) = _probeBorrower(ID);
        _probeBorrow(p, a, BEM);
        _toSeizeWindow(a, ID);
        voucher.setBurnOwnerOf(address(pool));
        vm.prank(keeper);
        a.seize();
        assertEq(voucher.ownerUnsafe(ID), address(pool), "the pool holds the voucher");
        uint256[] memory listed = a.collateralOf();
        assertEq(listed.length, 1, "the closed agent still lists it");
        assertEq(listed[0], ID);
        vm.prank(keeper);
        a.forwardVouchers();
        assertEq(a.collateralOf().length, 1, "forwardVouchers cannot clear it");
        assertEq(voucher.moves(ID), 2, "no second move");
        assertEq(pool.loanPrincipalOf(address(a)), 0, "the write-off happened");
        voucher.setBurnOwnerOf(address(0));
        a.forwardVouchers();
        assertEq(a.collateralOf().length, 0, "a readable destination is pruned on retry");
    }

    function test_RA16_releasePostReadFailureThenForgetAndLensGasCap() public {
        (Probe p, RigAgent a) = _probeBorrower(ID);
        voucher.setBurnOwnerOf(address(p));
        p.exec(address(a), abi.encodeCall(RigAgent.release, ()));
        assertEq(voucher.ownerUnsafe(ID), address(p));
        assertEq(a.collateralOf().length, 1);
        TapeLens lens = new TapeLens();
        assertEq(lens.quote{gas: 1_000_000}(a, 0).reason, Reasons.NO_COLLATERAL);
        voucher.setBurnOwnerOf(address(0));
        vm.expectRevert(abi.encodeWithSelector(RigAgent.NotOwned.selector, ID));
        p.exec{value: OPS}(address(a), abi.encodeCall(RigAgent.borrow, (0, BEM, type(uint256).max, uint16(0))));
        vm.recordLogs();
        p.exec(address(a), abi.encodeCall(RigAgent.forget, (ID)));
        assertEq(vm.getRecordedLogs().length, 1, "forget emits only its collateral event");
        assertEq(a.collateralOf().length, 0);
    }

    function test_RA16_aboveOwnerReadCapKeepsIdsUntilReadRecovers() public {
        uint256[3] memory burns = [uint256(150_000), 180_000, 190_000];
        for (uint256 i; i < burns.length; ++i) {
            uint256 id = ID + i * 10;
            (Probe p, RigAgent a) = _probeBorrower(id);
            _probeBorrow(p, a, BEM / 10);
            _toSeizeWindow(a, id);
            voucher.setBurnOwnerOf(address(pool));
            voucher.setOwnerOfBurnGas(burns[i]);
            a.seize();
            assertEq(a.collateralOf().length, 1);
            a.forwardVouchers();
            assertEq(a.collateralOf().length, 1);
            voucher.setBurnOwnerOf(address(0));
            a.forwardVouchers();
            assertEq(a.collateralOf().length, 0);
        }
    }

    function test_RA16_adversarial16VoucherGasBound() public {
        _deposit(lp, 20 * BEM);
        RigAgent a = _agent(alice, 90);
        for (uint256 id = 1; id <= 16; ++id) {
            voucher.mint(alice, id, 110);
            feed.set(_report(id, 100));
            vm.prank(alice);
            voucher.safeTransferFrom(alice, address(a), id);
        }
        _borrow(a, alice, 0, BEM);
        _toSeizeWindow(a, 1);
        voucher.setBurnOwnerOf(address(a));
        voucher.setOwnerOfBurnGas(90_000);
        voucher.setBurnTransfers(true);
        uint256 g = gasleft();
        a.seize{gas: 8_000_000}();
        uint256 used = g - gasleft();
        console.log("gas adversarial seize, 16 vouchers", used);
        assertLt(used, 16 * (2 * a.OWNER_READ_GAS() + a.VOUCHER_GAS()) + 800_000);
        assertGt(used, 16 * 350_000);
        assertEq(a.collateralOf().length, 16);
        assertTrue(a.closed());
    }

    /// The second `_needGas` in `_tryMove`: an `ownerOf` that needs most of its 100,000 cap still gets
    /// all of it. Over every gas budget near the smallest that lets `seize` finish, a finished seize
    /// never lists a voucher the pool already holds.
    function test_T6_a_heavy_owner_of_check_is_never_starved_into_a_wrong_list() public {
        // burns that fit the cap with the mock's own overhead (two cold reads and the owner lookup,
        // about 5,000 gas); an ownerOf above 100,000 needs a retry after reads recover
        uint256[3] memory burns = [uint256(70_000), 80_000, 90_000];
        for (uint256 k; k < burns.length; ++k) {
            (Probe p, RigAgent a) = _probeBorrower(ID + 10 * k);
            _probeBorrow(p, a, BEM / 10);
            _toSeizeWindow(a, ID + 10 * k);
            voucher.setBurnOwnerOf(address(pool));
            voucher.setOwnerOfBurnGas(burns[k]);
            bytes memory call_ = abi.encodeCall(RigAgent.seize, ());
            uint256 lo = 100_000;
            uint256 hi = 2_000_000;
            while (lo + 1 < hi) {
                uint256 mid = (lo + hi) / 2;
                uint256 s = vm.snapshotState();
                (bool ok,) = address(a).call{gas: mid}(call_);
                vm.revertToState(s);
                if (ok) hi = mid;
                else lo = mid;
            }
            uint256 finished;
            for (uint256 g = hi; g < hi + 40_000; g += 61) {
                uint256 s = vm.snapshotState();
                (bool ok,) = address(a).call{gas: g}(call_);
                if (ok) {
                    ++finished;
                    assertEq(voucher.ownerUnsafe(ID + 10 * k), address(pool), "the voucher moved");
                    assertEq(a.collateralOf().length, 0, "a finished seize lists a moved voucher");
                }
                vm.revertToState(s);
            }
            assertGt(finished, 0);
            voucher.setBurnOwnerOf(address(0));
        }
    }

    function test_T6_large_return_payload_from_the_voucher_does_not_stop_seize() public {
        (Probe p, RigAgent a) = _probeBorrower(ID);
        _probeBorrow(p, a, BEM);
        _toSeizeWindow(a, ID);
        voucher.setReturnSize(128 * 1024);
        vm.prank(keeper);
        a.seize();
        assertEq(voucher.ownerOf(ID), address(pool));
        assertEq(a.collateralOf().length, 0);
    }

    function test_T6_an_owner_that_burns_gas_or_returns_a_bomb_only_blocks_borrow() public {
        RigAgent b = _ready(bob, ID2);
        _borrow(b, bob, 0, BEM);
        RigAgent a = _ready(alice, ID);
        Probe p = _probeOwner();

        p.setReceive(Probe.Receive.BurnGas, 0);
        vm.prank(alice);
        (bool ok1,) = address(a).call{value: OPS, gas: 3_000_000}(
            abi.encodeCall(RigAgent.borrow, (0, BEM, type(uint256).max, type(uint16).max))
        );
        assertFalse(ok1, "borrow fails when the owner burns the gas");
        assertFalse(a.hasLoan());

        p.setReceive(Probe.Receive.Bomb, 4 * 1024 * 1024);
        vm.prank(alice);
        (bool ok2,) = address(a).call{value: OPS, gas: 3_000_000}(
            abi.encodeCall(RigAgent.borrow, (0, BEM, type(uint256).max, type(uint16).max))
        );
        assertFalse(ok2, "borrow fails when the owner returns a 4 MB payload");
        assertFalse(a.hasLoan());

        // nothing else calls the owner: repayment and exits keep working
        bem.mint(address(b), 2 * BEM);
        vm.prank(keeper);
        b.sweep();
        assertFalse(b.hasLoan());
        vm.prank(bob);
        b.release();
        vm.startPrank(lp);
        pool.withdraw(BEM, lp, lp);
        vm.stopPrank();
    }
}

// ───────────────────────── T7: the reporter's refund re-entry (BSC side)

/// LayerZero endpoint stand-in: charges a fixed fee and refunds the rest to the refund address.
contract RefundingEndpoint {
    uint256 public constant FEE = 0.001 ether;
    uint256 public sends;
    address public delegate;

    function setDelegate(address d) external {
        delegate = d;
    }

    function send(MessagingParams calldata, address refund) external payable returns (MessagingReceipt memory r) {
        require(msg.value >= FEE, "fee");
        ++sends;
        uint256 extra = msg.value - FEE;
        if (extra != 0) {
            (bool ok,) = refund.call{value: extra}("");
            require(ok, "refund");
        }
        r.guid = bytes32(sends);
        r.nonce = uint64(sends);
        r.fee = MessagingFee(FEE, 0);
    }
}

/// A vault that has forgotten every rig, so the reader returns early.
contract EmptyVault {
    function rigs(uint256) external pure returns (address, uint256) {
        return (address(0), 0);
    }
}

/// A caller whose refund hook pushes again, once.
contract RefundReenterer {
    RigReporter public reporter;
    uint256[] internal _ids;
    uint256 public reentries;

    constructor(RigReporter r) {
        reporter = r;
        _ids.push(16);
    }

    function go(uint256 value) external {
        reporter.push{value: value}(_ids);
    }

    receive() external payable {
        if (reentries == 0) {
            ++reentries;
            reporter.push{value: 0.001 ether}(_ids);
        }
    }
}

contract ReporterRefundTest is Test {
    function test_T7_refund_hook_can_only_push_again() public {
        RefundingEndpoint ep = new RefundingEndpoint();
        EmptyVault vault = new EmptyVault();
        RigReporter r = new RigReporter(
            address(ep), address(this), 30274, IRigVaultBsc(address(vault)), IPodMining(address(0xB0D)), address(0xBE7)
        );
        r.setPeer(30274, bytes32(uint256(0xFEED)));
        RefundReenterer c = new RefundReenterer(r);
        vm.deal(address(c), 1 ether);
        c.go(0.003 ether); // fee 0.001, refund 0.002, the hook pushes again with 0.001
        assertEq(ep.sends(), 2, "the hook made one more push");
        assertEq(c.reentries(), 1);
        assertEq(address(r).balance, 0, "the reporter keeps no value");
        assertEq(address(ep).balance, 0.002 ether, "two fees, nothing else");
        assertEq(address(c).balance, 1 ether - 0.002 ether, "the caller paid two fees and got the rest back");
    }
}
