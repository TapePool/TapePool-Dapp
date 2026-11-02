// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {Reasons} from "../../src/interfaces/ICreditPolicy.sol";
import {TapePool} from "../../src/TapePool.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {CreditMath} from "../../src/libraries/CreditMath.sol";
import {MockVoucher, MockCreditPolicy} from "../mocks/Mocks.sol";

contract RigAgentTest is Base {
    function setUp() public override {
        super.setUp();
        _legacyEconomics();
    }

    uint256 constant ID = 7;

    event Borrowed(
        address indexed agent,
        address indexed borrower,
        uint8 term,
        uint256 principal,
        uint256 fee,
        uint64 maturity,
        uint256[] ids
    );
    event Swept(address indexed agent, uint256 lateFeePaid, uint256 feePaid, uint256 principalPaid, uint256 leftover);
    event ImpairmentFlagged(address indexed agent, uint256 indexed rigId, uint8 evidenceKind, uint64 impairedAt);

    // ───────────────────────── books check (SPEC §15 invariants 1-3)

    function _checkBooks(RigAgent[] memory agents) internal view {
        uint256 bal = bem.balanceOf(address(pool));
        assertEq(bal, pool.idle() + pool.reserve(), "inv 1: balance = idle + reserve");
        assertEq(
            pool.totalAssets(),
            pool.idle() + pool.outstandingPrincipal() - pool.doubtful() - pool.unvestedNow(),
            "inv 1: assets"
        );
        assertLe(pool.doubtful(), pool.outstandingPrincipal(), "inv 1: doubtful <= outstanding");
        uint256 sum;
        uint256 doubt;
        for (uint256 i; i < agents.length; ++i) {
            RigAgent.LoanView memory v = agents[i].loanOf();
            assertEq(pool.loanPrincipalOf(address(agents[i])), v.principal, "pool and agent agree");
            assertEq(pool.doubtfulOf(address(agents[i])), v.doubtful ? v.principal : 0, "doubtful = remaining");
            sum += v.principal;
            doubt += pool.doubtfulOf(address(agents[i]));
        }
        assertEq(pool.outstandingPrincipal(), sum, "inv 2");
        assertEq(pool.doubtful(), doubt, "inv 1: doubtful sum");
    }

    function _check(RigAgent a) internal view {
        RigAgent[] memory list = new RigAgent[](1);
        list[0] = a;
        _checkBooks(list);
    }

    // ───────────────────────── factory and initialization

    function test_factory_create_and_predict() public {
        address predicted = factory.predictAgent(alice, 3);
        RigAgent a = _agent(alice, 3);
        assertEq(address(a), predicted);
        assertEq(a.borrower(), alice);
        assertEq(factory.borrowerOf(address(a)), alice);
        assertTrue(factory.isAgent(address(a)));
        assertFalse(a.closed());
        RigAgent b = _agent(alice, 4);
        address[] memory list = factory.agentsOf(alice);
        assertEq(list.length, 2);
        assertEq(list[1], address(b));
        vm.prank(alice);
        vm.expectRevert();
        factory.create(3); // same (borrower, index)
    }

    function test_initialize_only_factory_once() public {
        RigAgent a = _agent(alice, 0);
        vm.expectRevert(RigAgent.NotFactory.selector);
        a.initialize(bob);
        vm.prank(address(factory));
        vm.expectRevert(RigAgent.AlreadyInitialized.selector);
        a.initialize(bob);
    }

    function test_implementation_is_closed() public {
        RigAgent impl = factory.implementation();
        assertTrue(impl.closed());
        vm.prank(address(factory));
        vm.expectRevert(RigAgent.AlreadyInitialized.selector);
        impl.initialize(alice);
    }

    // ───────────────────────── collateral

    function test_pledge_keeps_the_set_ascending() public {
        RigAgent a = _agent(alice, 0);
        _rig(alice, 7, 10);
        _rig(alice, 3, 10);
        _rig(alice, 5, 10);
        _pledge(a, alice, 7);
        _pledge(a, alice, 3);
        _pledge(a, alice, 5);
        uint256[] memory ids = a.collateralOf();
        assertEq(ids.length, 3);
        assertEq(ids[0], 3);
        assertEq(ids[1], 5);
        assertEq(ids[2], 7);
    }

    function test_only_the_borrower_adds_collateral() public {
        RigAgent a = _agent(alice, 0);
        _rig(bob, 9, 10);
        vm.prank(bob);
        vm.expectRevert(RigAgent.NotFromBorrower.selector);
        voucher.safeTransferFrom(bob, address(a), 9);
        vm.expectRevert(RigAgent.NotVoucher.selector);
        a.onERC721Received(alice, alice, 9, "");

        // a stranger's plain transfer lands but is not collateral
        vm.prank(bob);
        voucher.transferFrom(bob, address(a), 9);
        assertEq(a.collateralOf().length, 0);
        vm.prank(bob);
        vm.expectRevert(RigAgent.NotBorrower.selector);
        a.register(9);
        // the borrower may withdraw it
        vm.prank(alice);
        a.withdrawVoucher(9);
        assertEq(voucher.ownerOf(9), alice);
    }

    function test_register_after_a_bridge_mint() public {
        RigAgent a = _agent(alice, 0);
        voucher.mint(address(a), 11, 50); // bridged straight to the agent: no hook
        assertEq(a.collateralOf().length, 0);
        vm.prank(alice);
        a.register(11);
        assertEq(a.collateralOf()[0], 11);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.AlreadyCollateral.selector, 11));
        a.register(11);
        _rig(alice, 12, 10);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.NotOwned.selector, 12));
        a.register(12);
        vm.stopPrank();
    }

    function test_collateral_is_capped_at_16() public {
        RigAgent a = _agent(alice, 0);
        for (uint256 i = 1; i <= 16; ++i) {
            _rig(alice, i, 1);
            _pledge(a, alice, i);
        }
        _rig(alice, 17, 1);
        vm.prank(alice);
        vm.expectRevert(RigAgent.CollateralFull.selector);
        voucher.safeTransferFrom(alice, address(a), 17);
        voucher.mint(address(a), 18, 1);
        vm.prank(alice);
        vm.expectRevert(RigAgent.CollateralFull.selector);
        a.register(18);
    }

    function test_withdraw_and_release_need_no_open_loan() public {
        RigAgent a = _ready(alice, ID);
        _rig(alice, 8, 10);
        _pledge(a, alice, 8);
        _borrow(a, alice, 0, BEM);
        vm.startPrank(alice);
        vm.expectRevert(RigAgent.LoanOpen.selector);
        a.withdrawVoucher(ID);
        vm.expectRevert(RigAgent.LoanOpen.selector);
        a.release();
        vm.stopPrank();
        // a non-collateral voucher can leave during a loan
        voucher.mint(address(a), 30, 1);
        vm.prank(alice);
        a.withdrawVoucher(30);

        _harvest(address(a), 2 * BEM);
        a.sweep();
        assertFalse(a.hasLoan());
        vm.prank(bob);
        vm.expectRevert(RigAgent.NotBorrower.selector);
        a.release();
        vm.prank(alice);
        a.withdrawVoucher(8);
        assertEq(voucher.ownerOf(8), alice);
        vm.prank(alice);
        a.release();
        assertEq(voucher.ownerOf(ID), alice);
        assertEq(a.collateralOf().length, 0);
    }

    // ───────────────────────── borrow

    function test_borrow_books_the_loan_and_pays_the_borrower() public {
        RigAgent a = _ready(alice, ID);
        uint256[] memory ids = new uint256[](1);
        ids[0] = ID;
        uint64 maturity = uint64(block.timestamp + 7 days);
        vm.expectEmit(address(a));
        emit Borrowed(address(a), alice, 0, BEM, 750_000, maturity, ids);
        _borrow(a, alice, 0, BEM);

        RigAgent.LoanView memory v = a.loanOf();
        assertTrue(v.open);
        assertEq(v.start, block.timestamp);
        assertEq(v.maturity, maturity, "maturity from the term code");
        assertEq(v.term, 0);
        assertEq(v.principal, BEM);
        assertEq(v.principal0, BEM);
        assertEq(v.feeLeft, 750_000);
        assertEq(v.lateBpsPerDay, 0);
        assertEq(v.lateAccruedTo, maturity);
        assertEq(v.debt, BEM + 750_000);
        assertEq(bem.balanceOf(alice), BEM, "proceeds to the borrower");
        assertEq(bem.balanceOf(address(a)), 0);
        _check(a);
    }

    function test_borrow_14_days() public {
        RigAgent a = _ready(alice, ID);
        _borrow(a, alice, 1, 2 * BEM);
        RigAgent.LoanView memory v = a.loanOf();
        assertEq(v.maturity, block.timestamp + 14 days);
        assertEq(v.feeLeft, 3_000_000, "1.5%");
    }

    function test_borrow_forwards_bem_that_predates_the_loan() public {
        RigAgent a = _ready(alice, ID);
        _harvest(address(a), BEM / 2);
        _borrow(a, alice, 0, BEM);
        assertEq(bem.balanceOf(alice), BEM + BEM / 2);
        assertEq(bem.balanceOf(address(a)), 0);
        assertEq(a.loanOf().principal, BEM, "old BEM does not repay the new loan");
    }

    function test_borrow_checks() public {
        RigAgent a = _agent(alice, 0);
        _deposit(lp, 20 * BEM);
        vm.prank(bob);
        vm.expectRevert(RigAgent.NotBorrower.selector);
        a.borrow{value: OPS}(0, BEM, type(uint256).max, type(uint16).max);
        vm.prank(alice);
        vm.expectRevert(RigAgent.NoCollateral.selector);
        a.borrow{value: OPS}(0, BEM, type(uint256).max, type(uint16).max);

        _rig(alice, ID, 100);
        _pledge(a, alice, ID);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.BadTerm.selector, 2));
        a.borrow{value: OPS}(2, BEM, type(uint256).max, type(uint16).max);
        vm.expectRevert(RigAgent.BelowMinAdvance.selector);
        a.borrow{value: OPS}(0, 1_000_000 - 1, type(uint256).max, type(uint16).max);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.PolicyDenied.selector, Reasons.DENIED));
        a.borrow{value: OPS}(0, 3 * BEM, type(uint256).max, type(uint16).max); // over 85% of expected output
        vm.stopPrank();

        vm.prank(guardian);
        pool.pauseBorrows();
        vm.prank(alice);
        vm.expectRevert(RigAgent.BorrowsArePaused.selector);
        a.borrow{value: OPS}(0, BEM, type(uint256).max, type(uint16).max);
        vm.prank(owner);
        pool.unpauseBorrows();

        vm.prank(guardian);
        pool.disableFeed();
        vm.prank(alice);
        vm.expectRevert(RigAgent.FeedIsDisabled.selector);
        a.borrow{value: OPS}(0, BEM, type(uint256).max, type(uint16).max);
        vm.prank(owner);
        pool.enableFeed();
        // R3-01: lend waits FEED_SETTLE after enableFeed
        vm.prank(alice);
        vm.expectRevert(TapePool.FeedSettling.selector);
        a.borrow{value: OPS}(0, BEM, type(uint256).max, type(uint16).max);
        vm.warp(block.timestamp + pool.FEED_SETTLE());
        _refresh(ID, 100);

        _borrow(a, alice, 0, BEM);
        vm.prank(alice);
        vm.expectRevert(RigAgent.LoanOpen.selector);
        a.borrow{value: OPS}(0, BEM, type(uint256).max, type(uint16).max);
    }

    function test_borrow_needs_every_collateral_voucher_owned() public {
        RigAgent a = _ready(alice, ID);
        vm.prank(address(a)); // the voucher leaves without going through the agent (e.g. a Safe action)
        voucher.transferFrom(address(a), bob, ID);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.NotOwned.selector, ID));
        a.borrow{value: OPS}(0, BEM, type(uint256).max, type(uint16).max);
    }

    function test_borrow_denied_on_stale_report() public {
        RigAgent a = _ready(alice, ID);
        vm.warp(block.timestamp + 361);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.PolicyDenied.selector, Reasons.DENIED));
        a.borrow{value: OPS}(0, BEM, type(uint256).max, type(uint16).max);
    }

    function test_borrow_allow_without_ok_reason_is_denied() public {
        RigAgent a = _ready(alice, ID);
        policy.setMode(MockCreditPolicy.Mode.AllowWithReason);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.PolicyDenied.selector, Reasons.MISMATCH));
        a.borrow{value: OPS}(0, BEM, type(uint256).max, type(uint16).max);
    }

    function test_borrow_debt_cap_boundary() public {
        RigAgent a = _ready(alice, ID);
        uint256 expected = CreditMath.expectedOutput(100, NETWORK_WEIGHT, 0);
        uint256 maxP = lens.principalFor(pool, 0, CreditMath.maxDebt(expected, 0));
        assertGt(maxP, BEM);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.PolicyDenied.selector, Reasons.DENIED));
        a.borrow{value: OPS}(0, maxP + 1, type(uint256).max, type(uint16).max);
        vm.revertToState(snap);
        _borrow(a, alice, 0, maxP);
        assertEq(a.loanOf().principal, maxP);
    }

    function test_borrower_with_delegated_code_and_other_origin() public {
        // EIP-7702 style account: code at the borrower address, tx.origin elsewhere (DERISK Q13)
        address wallet = makeAddr("agentic");
        vm.etch(wallet, abi.encodePacked(hex"ef0100", address(0x1234567890123456789012345678901234567890)));
        address relayer = makeAddr("relayer");
        _deposit(lp, 20 * BEM);
        vm.prank(wallet, relayer);
        RigAgent a = RigAgent(factory.create(0));
        voucher.mint(wallet, ID, 110);
        feed.set(_report(ID, 100));
        vm.prank(wallet, relayer);
        voucher.transferFrom(wallet, address(a), ID); // a contract wallet may skip the hook
        vm.prank(wallet, relayer);
        a.register(ID);
        vm.deal(wallet, OPS); // the wallet pays the operating fee in OKB
        vm.prank(wallet, relayer);
        a.borrow{value: OPS}(0, BEM, type(uint256).max, type(uint16).max);
        assertEq(bem.balanceOf(wallet), BEM);
        vm.startPrank(wallet, relayer);
        bem.approve(address(a), 2 * BEM);
        bem.mint(wallet, BEM);
        a.repay(2 * BEM);
        a.release();
        vm.stopPrank();
        assertEq(voucher.ownerOf(ID), wallet);
    }

    // ───────────────────────── repayment

    function test_sweep_pays_fee_first_then_principal() public {
        RigAgent a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        _harvest(address(a), BEM / 2);
        vm.expectEmit(address(a));
        emit Swept(address(a), 0, 750_000, BEM / 2 - 750_000, 0);
        vm.prank(keeper); // permissionless
        a.sweep();
        RigAgent.LoanView memory v = a.loanOf();
        assertEq(v.feeLeft, 0);
        assertEq(v.principal, BEM - (BEM / 2 - 750_000));
        assertEq(pool.reserve(), 150_000, "20% of the fee");
        _check(a);
    }

    function test_sweep_closes_and_returns_leftover() public {
        RigAgent a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        uint256 before = bem.balanceOf(alice);
        _harvest(address(a), 2 * BEM);
        a.sweep();
        assertFalse(a.hasLoan());
        assertEq(bem.balanceOf(alice) - before, 2 * BEM - BEM - 750_000, "leftover to the borrower");
        assertEq(bem.balanceOf(address(a)), 0);
        assertEq(voucher.ownerOf(ID), address(a), "vouchers stay until release");
        assertEq(pool.totalAssets(), 20 * BEM);
        assertEq(pool.unvestedNow(), 600_000);
        _check(a);
        vm.expectRevert(RigAgent.NoLoan.selector);
        a.sweep();
    }

    function test_sweep_with_nothing_to_pay() public {
        RigAgent a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        a.sweep();
        assertEq(a.loanOf().debt, BEM + 750_000);
    }

    function test_third_party_repay_pulls_only_what_is_unpaid() public {
        RigAgent a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        _harvest(address(a), BEM / 4);
        bem.mint(bob, 5 * BEM);
        vm.startPrank(bob);
        bem.approve(address(a), 5 * BEM);
        a.repay(5 * BEM);
        vm.stopPrank();
        assertEq(bem.balanceOf(bob), 5 * BEM - (BEM + 750_000 - BEM / 4));
        assertFalse(a.hasLoan());
        assertEq(bem.balanceOf(alice), BEM, "no leftover from a third party's payment");
        vm.expectRevert(RigAgent.NoLoan.selector);
        a.repay(1);
    }

    function test_partial_repay() public {
        RigAgent a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        vm.startPrank(alice);
        bem.approve(address(a), BEM / 2);
        a.repay(BEM / 2);
        vm.stopPrank();
        assertEq(a.loanOf().debt, BEM + 750_000 - BEM / 2);
        _check(a);
    }

    function test_claimLate() public {
        RigAgent a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        vm.expectRevert(RigAgent.LoanOpen.selector);
        a.claimLate();
        _harvest(address(a), 2 * BEM);
        a.sweep();
        vm.prank(alice);
        a.release();
        // a harvest sent while the agent held the voucher lands after release
        _harvest(address(a), BEM / 10);
        uint256 before = bem.balanceOf(alice);
        vm.prank(keeper);
        a.claimLate();
        assertEq(bem.balanceOf(alice) - before, BEM / 10);
    }

    function test_late_fee_after_maturity_on_remaining_principal() public {
        _queueExecute(TapePool.Param.LateFeeBpsPerDay, 10);
        RigAgent a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        assertEq(a.loanOf().lateBpsPerDay, 10);
        vm.warp(block.timestamp + 7 days);
        assertEq(a.loanOf().lateFeeDue, 0, "nothing at maturity");
        vm.warp(block.timestamp + 1 days);
        assertEq(a.loanOf().lateFeeDue, 100_000, "0.1% of 1 BEM for one day");
        vm.warp(block.timestamp + 1);
        assertEq(a.loanOf().lateFeeDue, 100_002, "rounds up");
        // the late fee is paid first, then the flat fee, then principal
        _harvest(address(a), 500_000);
        a.sweep();
        RigAgent.LoanView memory v = a.loanOf();
        assertEq(v.lateFeeDue, 0);
        assertEq(v.feeLeft, 750_000 - (500_000 - 100_002));
        assertEq(v.principal, BEM);
        // and checkpointed: the next day accrues on the same principal from now
        vm.warp(block.timestamp + 1 days);
        assertEq(a.loanOf().lateFeeDue, 100_000);
    }

    function test_late_fee_rate_is_fixed_at_borrow() public {
        RigAgent a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        _queueExecute(TapePool.Param.LateFeeBpsPerDay, 30);
        vm.warp(block.timestamp + 30 days);
        assertEq(a.loanOf().lateFeeDue, 0, "opened at 0, stays 0");
    }

    function test_a_slow_rig_is_never_seized() public {
        RigAgent a = _ready(alice, ID);
        _borrow(a, alice, 0, BEM);
        vm.warp(block.timestamp + 60 days);
        _refresh(ID, 100);
        vm.expectRevert(RigAgent.NoFlag.selector);
        a.seize();
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
        assertTrue(a.hasLoan());
    }

    function testFuzz_late_fee(uint256 principal, uint16 bps, uint32 dt) public {
        principal = bound(principal, 1_000_000, 2 * BEM);
        bps = uint16(bound(bps, 1, 30));
        dt = uint32(bound(dt, 1, 400 days));
        _queueExecute(TapePool.Param.LateFeeBpsPerDay, bps);
        RigAgent a = _ready(alice, ID);
        _borrow(a, alice, 0, principal);
        vm.warp(block.timestamp + 7 days + dt);
        uint256 due = a.loanOf().lateFeeDue;
        uint256 exact = principal * bps * dt;
        uint256 den = 10_000 * 1 days;
        assertGe(due * den, exact, "never below the exact amount");
        assertLt((due - 1) * den, exact, "rounds up by less than 1");
    }

    // ───────────────────────── impairment: flag

    function _loanOn(uint256 id) internal returns (RigAgent a) {
        a = _ready(alice, id);
        _borrow(a, alice, 0, BEM);
    }

    function test_flag_on_a_rescued_report_marks_doubtful() public {
        RigAgent a = _loanOn(ID);
        vm.warp(block.timestamp + 1 days);
        feed.set(_rescuedReport(ID)); // insane too (verifWeight 0): sane is not required for evidence
        vm.expectEmit(address(a));
        emit ImpairmentFlagged(address(a), ID, 1, uint64(block.timestamp));
        vm.prank(keeper);
        a.flagImpaired(ID);
        RigAgent.LoanView memory v = a.loanOf();
        assertEq(v.impairedAt, block.timestamp);
        assertEq(v.impairedRig, ID);
        assertTrue(v.doubtful);
        assertEq(v.seizeStart, block.timestamp + 72 hours);
        assertEq(v.deadline, block.timestamp + 96 hours);
        assertEq(pool.doubtful(), BEM);
        assertEq(pool.totalAssets(), 19 * BEM, "price moves at the flag");
        assertEq(pool.maxDeposit(lp), 0, "deposits closed");
        _check(a);
    }

    function test_flag_each_report_condition_is_evidence() public {
        RigAgent a = _loanOn(ID);
        for (uint256 c; c < 5; ++c) {
            uint256 snap = vm.snapshotState();
            RigReport memory r = _report(ID, 100);
            if (c == 0) r.status = 2;
            if (c == 1) r.stopBlock = 123;
            if (c == 2) r.custodied = false;
            if (c == 3) r.verifWeight = r.bonus;
            if (c == 4) r.verifWeight = 0;
            feed.set(r);
            a.flagImpaired(ID);
            assertEq(a.loanOf().impairedRig, ID);
            vm.revertToState(snap);
        }
        feed.set(_report(ID, 100));
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
    }

    function test_flag_stale_or_future_report_is_not_evidence() public {
        RigAgent a = _loanOn(ID);
        RigReport memory r = _rescuedReport(ID);
        vm.warp(block.timestamp + 1 hours);
        r.observedAt = uint64(block.timestamp - 301);
        feed.set(r);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
        r.observedAt = uint64(block.timestamp + 61);
        feed.set(r);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
        r.observedAt = uint64(block.timestamp + 60);
        feed.set(r);
        a.flagImpaired(ID);
    }

    function test_flag_wrong_rig_report_is_not_evidence() public {
        RigAgent a = _loanOn(ID);
        RigReport memory r = _rescuedReport(ID);
        r.rigId = uint64(ID + 1);
        feed.setAt(ID, r); // a report about another rig, served for ID
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
    }

    function test_flag_needs_collateral_and_a_loan() public {
        RigAgent a = _ready(alice, ID);
        feed.set(_rescuedReport(ID));
        vm.expectRevert(RigAgent.NoLoan.selector);
        a.flagImpaired(ID);
        _refresh(ID, 100);
        _borrow(a, alice, 0, BEM);
        voucher.mint(address(a), 40, 0); // not collateral
        feed.set(_rescuedReport(40));
        vm.expectRevert(abi.encodeWithSelector(RigAgent.NotCollateral.selector, 40));
        a.flagImpaired(40);
    }

    function test_flag_path_b_voucher_record() public {
        RigAgent a = _loanOn(ID);
        uint64 start = uint64(block.timestamp);
        voucher.setRig(ID, start, 0); // synced at the loan start: not later than it
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
        vm.warp(block.timestamp + 1 days);
        voucher.setRig(ID, start + 60, 0);
        vm.expectEmit(address(a));
        emit ImpairmentFlagged(address(a), ID, 2, uint64(block.timestamp));
        a.flagImpaired(ID);
    }

    function test_flag_with_feed_disabled_uses_path_b_only() public {
        RigAgent a = _loanOn(ID);
        vm.warp(block.timestamp + 1 hours);
        feed.set(_rescuedReport(ID));
        vm.prank(guardian);
        pool.disableFeed();
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
        voucher.setRig(ID, uint64(block.timestamp), 0);
        a.flagImpaired(ID);
        assertEq(a.loanOf().impairedAt, block.timestamp);
    }

    function test_flag_survives_a_broken_feed() public {
        RigAgent a = _loanOn(ID);
        vm.warp(block.timestamp + 1 hours);
        feed.setBroken(true);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.flagImpaired(ID);
        voucher.setRig(ID, uint64(block.timestamp), 0);
        a.flagImpaired(ID);
    }

    function test_a_live_flag_cannot_be_extended() public {
        RigAgent a = _loanOn(ID);
        feed.set(_rescuedReport(ID));
        a.flagImpaired(ID);
        uint64 first = a.loanOf().impairedAt;
        vm.warp(block.timestamp + 90 hours);
        feed.set(_rescuedReport(ID));
        vm.expectRevert(RigAgent.FlagLive.selector);
        a.flagImpaired(ID);
        assertEq(a.loanOf().impairedAt, first);
    }

    // ───────────────────────── impairment: seize

    function _flagged() internal returns (RigAgent a, uint256 flaggedAt) {
        a = _loanOn(ID);
        vm.warp(block.timestamp + 1 days);
        feed.set(_rescuedReport(ID));
        a.flagImpaired(ID);
        flaggedAt = block.timestamp;
    }

    function test_seize_after_cure_on_new_evidence() public {
        (RigAgent a, uint256 t) = _flagged();
        vm.warp(t + 72 hours - 1);
        feed.set(_rescuedReport(ID));
        vm.expectRevert(RigAgent.CureWindow.selector);
        a.seize();
        vm.warp(t + 72 hours);
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.seize(); // the report is from inside the cure window
        feed.set(_rescuedReport(ID));
        uint256 marked = pool.totalAssets();
        vm.prank(keeper);
        a.seize();
        assertTrue(a.closed());
        assertFalse(a.hasLoan());
        assertEq(voucher.ownerOf(ID), address(pool), "voucher to the pool");
        assertEq(a.collateralOf().length, 0);
        assertEq(pool.outstandingPrincipal(), 0);
        assertEq(pool.doubtful(), 0);
        assertEq(pool.principalOf(alice), 0);
        assertEq(pool.totalAssets(), marked, "the loss was already in the price");
        _check(a);
    }

    function test_seize_after_the_deadline_reverts() public {
        (RigAgent a, uint256 t) = _flagged();
        vm.warp(t + 96 hours + 1);
        feed.set(_rescuedReport(ID));
        vm.expectRevert(RigAgent.FlagExpired.selector);
        a.seize();
        assertTrue(a.loanOf().expired);
        assertEq(pool.doubtful(), BEM, "a lapse keeps the mark");
        // new evidence starts a new flag
        a.flagImpaired(ID);
        assertEq(a.loanOf().impairedAt, block.timestamp);
    }

    function test_seize_last_second_of_the_window() public {
        (RigAgent a, uint256 t) = _flagged();
        vm.warp(t + 96 hours);
        feed.set(_rescuedReport(ID));
        a.seize();
        assertTrue(a.closed());
    }

    function test_seize_runs_the_waterfall_first() public {
        (RigAgent a, uint256 t) = _flagged();
        _harvest(address(a), BEM / 2);
        vm.warp(t + 72 hours);
        feed.set(_rescuedReport(ID));
        a.seize();
        assertEq(pool.reserve(), 0, "the fee's reserve share covered part of the write-off");
        assertEq(pool.outstandingPrincipal(), 0);
        _check(a);
    }

    function test_seize_reverts_when_the_waterfall_clears_the_debt() public {
        (RigAgent a, uint256 t) = _flagged();
        _harvest(address(a), 2 * BEM);
        vm.warp(t + 72 hours);
        feed.set(_rescuedReport(ID));
        vm.expectRevert(RigAgent.NoDebt.selector);
        a.seize();
        a.sweep();
        assertFalse(a.hasLoan());
        assertFalse(a.closed());
        assertEq(pool.doubtful(), 0, "repaid in full clears the mark");
    }

    function test_repaying_in_the_cure_window_ends_the_flag() public {
        (RigAgent a,) = _flagged();
        vm.startPrank(alice);
        bem.approve(address(a), 2 * BEM);
        bem.mint(alice, BEM);
        a.repay(2 * BEM);
        vm.stopPrank();
        assertFalse(a.hasLoan());
        assertEq(pool.doubtful(), 0, "deposits are no longer closed by the mark");
        vm.prank(alice);
        a.release();
        assertEq(voucher.ownerOf(ID), alice);
    }

    function test_feed_disabled_flag_never_expires_and_seize_uses_path_b() public {
        (RigAgent a, uint256 t) = _flagged();
        vm.prank(guardian);
        pool.disableFeed();
        vm.warp(t + 30 days);
        assertFalse(a.loanOf().expired, "no expiry while the feed is off");
        feed.set(_rescuedReport(ID));
        vm.expectRevert(RigAgent.NoEvidence.selector);
        a.seize(); // report evidence ignored
        vm.expectRevert(RigAgent.FlagNotExpired.selector);
        a.clearExpiredFlag();
        voucher.setRig(ID, uint64(block.timestamp), 0);
        a.seize();
        assertEq(voucher.ownerOf(ID), address(pool));
    }

    function test_enabling_the_feed_gives_every_flag_24h_of_seize_window() public {
        (RigAgent a, uint256 t) = _flagged();
        vm.warp(t + 1 hours);
        vm.prank(guardian);
        pool.disableFeed();
        vm.warp(t + 95 hours);
        vm.prank(owner);
        pool.enableFeed();
        RigAgent.LoanView memory v = a.loanOf();
        assertEq(v.deadline, t + 214 hours);
        vm.warp(t + 110 hours);
        assertFalse(a.loanOf().expired);
        feed.set(_rescuedReport(ID));
        a.seize();
        assertTrue(a.closed());
    }

    function test_seize_with_a_blocked_voucher_then_forward() public {
        (RigAgent a, uint256 t) = _flagged();
        vm.warp(t + 72 hours);
        feed.set(_rescuedReport(ID));
        voucher.setMode(MockVoucher.Mode.Revert);
        a.seize();
        assertTrue(a.closed(), "the close never depends on the voucher");
        assertEq(pool.outstandingPrincipal(), 0);
        assertEq(voucher.ownerOf(ID), address(a));
        assertEq(a.collateralOf()[0], ID, "stuck voucher stays as collateral");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.SeizedVoucher.selector, ID)); // R3-02: checked first
        a.withdrawVoucher(ID);
        voucher.setMode(MockVoucher.Mode.Normal);
        vm.prank(keeper);
        a.forwardVouchers();
        assertEq(voucher.ownerOf(ID), address(pool));
        assertEq(a.collateralOf().length, 0);
    }

    function test_seize_with_a_gas_burning_voucher() public {
        (RigAgent a, uint256 t) = _flagged();
        vm.warp(t + 72 hours);
        feed.set(_rescuedReport(ID));
        voucher.setMode(MockVoucher.Mode.BurnGas);
        a.seize{gas: 2_000_000}();
        assertTrue(a.closed());
        assertEq(voucher.ownerOf(ID), address(a));
    }

    function test_seize_does_not_trust_a_transfer_that_reports_success() public {
        (RigAgent a, uint256 t) = _flagged();
        vm.warp(t + 72 hours);
        feed.set(_rescuedReport(ID));
        voucher.setMode(MockVoucher.Mode.Lie);
        a.seize();
        assertEq(voucher.ownerOf(ID), address(a));
        assertEq(a.collateralOf()[0], ID, "kept, so the borrower cannot withdraw it");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.SeizedVoucher.selector, ID)); // R3-02: checked first
        a.withdrawVoucher(ID);
    }

    function test_seize_cannot_be_starved_of_gas() public {
        (RigAgent a, uint256 t) = _flagged();
        vm.warp(t + 72 hours);
        feed.set(_rescuedReport(ID));
        uint256 failed;
        uint256 succeeded;
        for (uint256 g = 100_000; g <= 800_000; g += 20_000) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = address(a).call{gas: g}(abi.encodeCall(RigAgent.seize, ()));
            if (ok) {
                assertEq(voucher.ownerOf(ID), address(pool), "a successful seize moved the voucher");
                ++succeeded;
            } else {
                assertEq(voucher.ownerOf(ID), address(a));
                ++failed;
            }
            vm.revertToState(snap);
        }
        assertGt(failed, 0, "some budgets are too small");
        assertGt(succeeded, 0, "some budgets are enough");
    }

    function test_seize_takes_every_collateral_voucher() public {
        RigAgent a = _ready(alice, ID);
        _rig(alice, 3, 50);
        _pledge(a, alice, 3);
        _borrow(a, alice, 0, BEM);
        vm.warp(block.timestamp + 1 hours);
        feed.set(_rescuedReport(ID));
        a.flagImpaired(ID);
        vm.warp(block.timestamp + 72 hours);
        voucher.setRig(3, uint64(block.timestamp + 60), 0); // new evidence on another collateral rig counts
        a.seize();
        assertEq(voucher.ownerOf(ID), address(pool));
        assertEq(voucher.ownerOf(3), address(pool), "healthy vouchers go too");
    }

    function test_closed_agent() public {
        (RigAgent a, uint256 t) = _flagged();
        vm.warp(t + 72 hours);
        feed.set(_rescuedReport(ID));
        a.seize();
        // a harvest sent before the seize lands afterwards: it goes to the pool
        _harvest(address(a), BEM / 10);
        uint256 idle = pool.idle();
        a.sweep();
        pool.sync();
        assertEq(pool.idle() - idle, BEM / 10);
        _harvest(address(a), BEM / 10);
        a.claimLate();
        pool.sync();
        assertEq(pool.idle() - idle, BEM / 5);

        _rig(alice, 50, 10);
        vm.startPrank(alice);
        vm.expectRevert(RigAgent.AgentClosed.selector);
        voucher.safeTransferFrom(alice, address(a), 50);
        voucher.transferFrom(alice, address(a), 50);
        vm.expectRevert(RigAgent.AgentClosed.selector);
        a.register(50);
        vm.expectRevert(RigAgent.AgentClosed.selector);
        a.borrow{value: OPS}(0, BEM, type(uint256).max, type(uint16).max);
        vm.expectRevert(RigAgent.AgentClosed.selector);
        a.release();
        a.withdrawVoucher(50); // not collateral: always withdrawable
        vm.stopPrank();
        assertEq(voucher.ownerOf(50), alice);
        vm.expectRevert(RigAgent.NoLoan.selector);
        a.seize();
    }

    function test_forwardVouchers_needs_a_closed_agent() public {
        RigAgent a = _ready(alice, ID);
        vm.expectRevert(RigAgent.NotClosed.selector);
        a.forwardVouchers();
    }

    function test_seized_rig_harvest_pays_the_pool() public {
        (RigAgent a, uint256 t) = _flagged();
        vm.warp(t + 72 hours);
        feed.set(_rescuedReport(ID));
        a.seize();
        uint256 ta = pool.totalAssets();
        _harvest(address(pool), BEM / 3); // the pool is now the holder
        assertEq(pool.totalAssets(), ta);
        pool.sync();
        assertEq(pool.totalAssets(), ta);
        vm.warp(pool.vestEnd());
        assertEq(pool.totalAssets() - ta, BEM / 3);
    }

    // ───────────────────────── impairment: clear an expired flag

    function test_clear_expired_flag_on_a_healthy_report() public {
        (RigAgent a, uint256 t) = _flagged();
        vm.expectRevert(RigAgent.FlagNotExpired.selector);
        a.clearExpiredFlag();
        vm.warp(t + 96 hours + 1);
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag(); // the old report is stale
        RigReport memory insane = _report(ID, 100);
        insane.totalVerifWeight = 1; // verifWeight above the network weight
        feed.set(insane);
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        _refresh(ID, 100);
        a.clearExpiredFlag();
        RigAgent.LoanView memory v = a.loanOf();
        assertEq(v.impairedAt, 0);
        assertFalse(v.doubtful);
        assertEq(pool.doubtful(), 0);
        assertEq(pool.totalAssets(), 20 * BEM);
        _check(a);
    }

    function test_clear_expired_flag_on_the_voucher_record() public {
        (RigAgent a, uint256 t) = _flagged();
        vm.warp(t + 96 hours + 1);
        voucher.setRig(ID, uint64(t - 1), 110);
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag(); // synced before the flag
        // a harvest sent on BSC just before a rescue can carry a send time a little after the
        // flag when the BSC clock runs ahead: inside the cure window it is not health evidence
        voucher.setRig(ID, uint64(t + 30), 110);
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        voucher.setRig(ID, uint64(t + 72 hours - 1), 110);
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        voucher.setRig(ID, uint64(t + 72 hours + 60), 110); // synced from seizeStart on
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
    }

    function test_clear_needs_a_flag() public {
        RigAgent a = _loanOn(ID);
        vm.expectRevert(RigAgent.NoFlag.selector);
        a.clearExpiredFlag();
        RigAgent b = _ready(bob, 9);
        vm.expectRevert(RigAgent.NoLoan.selector);
        b.clearExpiredFlag();
    }

    // ───────────────────────── invariant 7: brakes never block exits

    function test_brakes_never_block_exits() public {
        _deposit(lp, 20 * BEM);
        RigAgent a = _ready(alice, ID); // loan to sweep and repay
        _borrow(a, alice, 0, BEM);
        RigAgent b = _ready(bob, 9); // loan to flag and seize
        _borrow(b, bob, 0, BEM);
        RigAgent c = _ready(keeper, 20); // no loan: claim, register, withdraw, release
        voucher.mint(address(c), 21, 10);

        // every brake on at once
        vm.startPrank(owner);
        pool.queuePolicy(new MockCreditPolicy(feed, 2));
        pool.lowerCap(TapePool.Param.SupplyCap, 0);
        pool.lowerCap(TapePool.Param.BorrowCapAbs, 0);
        pool.lowerCap(TapePool.Param.BorrowCapBps, 0);
        pool.lowerCap(TapePool.Param.PerBorrowerBps, 0);
        pool.disableFeed();
        vm.stopPrank();
        assertTrue(pool.borrowsPaused());

        _harvest(address(a), BEM / 2);
        a.sweep();
        vm.startPrank(alice);
        bem.approve(address(a), 2 * BEM);
        a.repay(2 * BEM);
        a.release();
        vm.stopPrank();

        _harvest(address(c), BEM / 10);
        c.claimLate();
        vm.startPrank(keeper);
        c.register(21);
        c.withdrawVoucher(21);
        c.release();
        vm.stopPrank();

        vm.warp(block.timestamp + 1 hours);
        voucher.setRig(9, uint64(block.timestamp + 60), 0);
        b.flagImpaired(9); // path (b) while the feed is off
        vm.warp(block.timestamp + 72 hours);
        voucher.setRig(9, uint64(block.timestamp + 60), 0);
        b.seize();
        b.forwardVouchers();

        uint256 shares = pool.maxRedeem(lp);
        assertGt(shares, 0);
        vm.prank(lp);
        pool.redeem(shares / 2, lp, lp);
        uint256 w = pool.maxWithdraw(lp);
        vm.prank(lp);
        pool.withdraw(w / 2, lp, lp);

        RigAgent[] memory list = new RigAgent[](3);
        list[0] = a;
        list[1] = b;
        list[2] = c;
        _checkBooks(list);
    }

    function test_brakes_never_block_clearing_an_expired_flag() public {
        (RigAgent a, uint256 t) = _flagged();
        vm.startPrank(owner);
        pool.queuePolicy(new MockCreditPolicy(feed, 2));
        pool.lowerCap(TapePool.Param.SupplyCap, 0);
        pool.lowerCap(TapePool.Param.BorrowCapAbs, 0);
        vm.stopPrank();
        vm.warp(t + 96 hours + 1);
        _refresh(ID, 100);
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
    }

    // ───────────────────────── several agents, one borrower

    function test_per_borrower_cap_across_agents() public {
        _deposit(lp, 20 * BEM);
        RigAgent a0 = _agent(alice, 0);
        RigAgent a1 = _agent(alice, 1);
        _rig(alice, 1, 500);
        _rig(alice, 2, 500);
        _pledge(a0, alice, 1);
        _pledge(a1, alice, 2);
        _borrow(a0, alice, 0, 6 * BEM);
        vm.prank(alice);
        vm.expectRevert(TapePool.ExceedsBorrowerCap.selector);
        a1.borrow{value: OPS}(0, 3 * BEM, type(uint256).max, type(uint16).max);
        _borrow(a1, alice, 0, 2 * BEM);
        assertEq(pool.principalOf(alice), 8 * BEM);
        RigAgent[] memory list = new RigAgent[](2);
        list[0] = a0;
        list[1] = a1;
        _checkBooks(list);
    }

    function test_deposits_closed_while_a_loan_is_flagged() public {
        _flagged();
        bem.mint(lp, BEM);
        vm.startPrank(lp);
        bem.approve(address(pool), BEM);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, lp, BEM, 0));
        pool.deposit(BEM, lp);
        vm.stopPrank();
    }
}
