// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TapeOutHelper, console2} from "./TapeOutHelper.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SpikePool} from "../../src/spike/SpikePool.sol";
import {SpikeRigAgent} from "../../src/spike/SpikeRigAgent.sol";

/// T5: tiny end-to-end on the X Layer fork:
///   LP deposits BEM -> borrower moves a REAL voucher into its agent -> borrow checked by a freshly
///   taped-out TapeOut policy circuit -> harvest BEM (real LZ receive/compose path) lands in agent ->
///   permissionless sweep repays interest then principal -> release voucher; or seize after maturity.
contract T5_EndToEndTest is TapeOutHelper {
    IERC20 bem = IERC20(address(BEM));
    address constant BIG_HOLDER = 0x571d447f4f24688eC35Ccf07f1D6993655F6aF15;
    uint256 constant ID = 5; // power 306 (81% design bonus, see research)

    SpikePool pool;
    SpikeRigAgent agent;
    address lp = makeAddr("lp");
    address keeper = makeAddr("keeper");
    address borrower = HOLDER_C905;
    Launch L;

    function setUp() public {
        _fork();
        L = _launchPolicy(1e13);
        pool = new SpikePool(bem);
        agent = new SpikeRigAgent(VOUCHER, pool, borrower, L.circuits, L.circuitId);
        pool.setAgent(address(agent), true);

        vm.prank(BIG_HOLDER);
        bem.transfer(lp, 50e8);
        vm.startPrank(lp);
        bem.approve(address(pool), type(uint256).max);
        pool.deposit(50e8, lp);
        vm.stopPrank();

        vm.prank(borrower);
        VOUCHER.safeTransferFrom(borrower, address(agent), ID);
        assertTrue(agent.holding());
    }

    function _harvest(uint64 amountSD, uint64 sendTime) internal {
        (,,, uint256 power) = VOUCHER.rigs(ID);
        _deliverHarvest(ID, amountSD, sendTime, power);
    }

    function test_T5_policy_gates_borrow() public {
        uint64 mat = uint64(block.timestamp + 30 days);
        // flags missing (processor not allowlisted) -> circuit says no
        vm.prank(borrower);
        vm.expectRevert(SpikeRigAgent.PolicyDenied.selector);
        agent.borrow(10e8, 0, 3);
        // too much debt for a 30d term: 40 BEM / 1.383 BEM/day = 28 days -> bucket 7 > 6
        assertEq(agent.dtoBucket(40e8), 7);
        vm.prank(borrower);
        vm.expectRevert(SpikeRigAgent.PolicyDenied.selector);
        agent.borrow(40e8, 0, 7);
        // invalid term code 3
        vm.prank(borrower);
        vm.expectRevert(SpikeRigAgent.PolicyDenied.selector);
        agent.borrow(1e8, 3, 7);
        // only borrower
        vm.prank(keeper);
        vm.expectRevert(SpikeRigAgent.NotBorrower.selector);
        agent.borrow(1e8, 0, 7);
        // maturity is bound to the term code
        uint256 t0 = block.timestamp;
        vm.prank(borrower);
        agent.borrow(1e8, 1, 7); // 60d term, small amount -> allowed
        assertEq(agent.maturity(), t0 + 60 days, "maturity derived from term");
    }

    function test_T5_borrow_harvest_sweep_release() public {
        uint256 bBefore = bem.balanceOf(borrower);
        uint256 g = gasleft();
        vm.prank(borrower);
        agent.borrow(10e8, 0, 7);
        console2.log("gas borrow (incl. policy circuit eval + pool.lend)", g - gasleft());
        assertEq(bem.balanceOf(borrower) - bBefore, 10e8, "proceeds to borrower EOA");
        assertEq(bem.balanceOf(address(agent)), 0, "nothing parked in agent");
        assertEq(pool.outstanding(), 10e8);
        assertEq(pool.totalAssets(), 50e8, "lending does not move share price");

        // cannot take the voucher back while owing
        vm.expectRevert(SpikeRigAgent.StillOwed.selector);
        agent.release();

        vm.warp(block.timestamp + 10 days);
        uint256 acc = agent.accrued();
        console2.log("accrued after 10 days (raw BEM)", acc);
        _harvest(6_000_000, uint64(block.timestamp - 1 hours)); // 6 BEM harvested during the loan
        assertEq(bem.balanceOf(address(agent)), 6e8, "harvest landed in agent");

        g = gasleft();
        vm.prank(keeper); // permissionless
        agent.sweep();
        console2.log("gas sweep", g - gasleft());
        assertEq(pool.interestEarned(), acc, "interest paid first");
        assertEq(agent.principal(), 10e8 - (6e8 - acc), "rest to principal");
        assertEq(agent.accrued(), 0);

        vm.warp(block.timestamp + 5 days);
        _harvest(6_000_000, uint64(block.timestamp - 1 hours));
        uint256 acc2 = agent.accrued();
        uint256 p = agent.principal();
        uint256 bBeforeRelease = bem.balanceOf(borrower);
        g = gasleft();
        vm.prank(keeper);
        agent.release(); // sweeps, then releases
        console2.log("gas release (sweep + voucher back + leftover)", g - gasleft());
        assertEq(agent.principal(), 0);
        assertEq(pool.outstanding(), 0);
        assertEq(VOUCHER.ownerOf(ID), borrower, "voucher back to borrower");
        assertEq(bem.balanceOf(borrower) - bBeforeRelease, 6e8 - acc2 - p, "leftover harvest to borrower");
        assertEq(pool.totalAssets(), 50e8 + acc + acc2, "LP earned the interest");

        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        uint256 out = pool.redeem(shares, lp, lp);
        console2.log("LP redeemed (raw BEM) for 50e8 deposited", out);
        assertGt(out, 50e8);
    }

    function test_T5_seize_after_maturity() public {
        uint64 mat = uint64(block.timestamp + 30 days);
        vm.prank(borrower);
        agent.borrow(10e8, 0, 7); // term 0 -> maturity = now + 30d
        assertEq(agent.maturity(), mat);
        vm.warp(block.timestamp + 20 days);
        _harvest(2_000_000, uint64(block.timestamp - 1)); // only 2 BEM
        agent.sweep();

        vm.expectRevert(SpikeRigAgent.NotMatured.selector);
        agent.seize();

        vm.warp(mat + 1);
        uint64 lateSend = uint64(block.timestamp - 10); // sent while agent still holds
        uint256 p = agent.principal(); // before seize (seize sweeps first; agent has 0 BEM now)
        uint256 assetsBefore = pool.totalAssets();
        uint256 g = gasleft();
        vm.prank(keeper);
        agent.seize();
        console2.log("gas seize", g - gasleft());
        assertEq(VOUCHER.ownerOf(ID), address(pool), "pool now holds the voucher");
        assertEq(pool.writtenOff(), p);
        assertEq(pool.totalAssets(), assetsBefore - p, "loss recognised");

        // a harvest sent before seize but landing after -> agent -> sweep forwards to pool
        _harvest(1_000_000, lateSend);
        assertEq(bem.balanceOf(address(agent)), 1e8);
        agent.sweep();
        assertEq(bem.balanceOf(address(agent)), 0);

        // a harvest sent after seize pays the pool directly (pool is the holder) -> recovery
        vm.warp(block.timestamp + 1 days);
        uint256 a1 = pool.totalAssets();
        _harvest(3_000_000, uint64(block.timestamp - 1));
        assertEq(pool.totalAssets() - a1, 3e8, "pool mines for itself after default");
    }
}
