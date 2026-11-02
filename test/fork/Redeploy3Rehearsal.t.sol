// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeployPool} from "../../script/deploy/DeployPool.s.sol";
import {CheckStack} from "../../script/deploy/CheckStack.s.sol";
import {Addresses as A} from "../../script/Addresses.sol";

/// Redeploy 3, R3-07: the deploy script on an X Layer fork on top of the reused receiver and the live
/// policy circuit (id 1), then every `CheckStack` gate, before and after a seed like RD3-07. LOCAL FORK
/// ONLY: nothing is broadcast; `deal` and `prank` act inside the fork.
contract Redeploy3RehearsalTest is Test {
    /// 2026-11-01, after the reused receiver was locked (X Layer block 74,684,262).
    uint256 constant FORK_BLOCK = 74_779_162;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    DeployPool s;
    CheckStack check;
    DeployPool.Deployed d;

    function setUp() public {
        vm.createSelectFork("xlayer", FORK_BLOCK);
        s = new DeployPool();
        check = new CheckStack();
        d = s.deployAll(address(s), A.POLICY_CIRCUITS, A.POLICY_CIRCUIT_ID, A.FEED_RECEIVER_XLAYER_2);
    }

    function test_R3_07_deployOnTheReusedFeedPassesTheChecksBeforeAndAfterTheSeed() public {
        s.check(d, A.FEED_RECEIVER_XLAYER_2);
        check.checkPool(d.pool, d.lens);
        check.checkReusedFeed(d.pool);
        assertEq(d.pool.feedEnabledAt(), 0);

        IERC20 bem = IERC20(A.BEM_OFT_XLAYER);
        deal(A.BEM_OFT_XLAYER, address(this), 1_000_000);
        bem.approve(address(d.pool), 1_000_000);
        d.pool.deposit(1_000_000, DEAD);
        deal(A.BEM_OFT_XLAYER, A.OWNER, bem.balanceOf(A.OWNER) + 14_000_000);
        vm.startPrank(A.OWNER);
        bem.approve(address(d.pool), 14_000_000);
        d.pool.deposit(14_000_000, A.OWNER);
        vm.stopPrank();
        vm.expectRevert(bytes("pre-seed accounting"));
        check.checkPool(d.pool, d.lens);
        check.checkPoolSeeded(d.pool, d.lens);
    }

    /// The full pre-seed gate, which also checks the reporter on a BSC fork. Skips without BSC_RPC.
    function test_R3_07_checkStackRunOnTheReusedFeed() public {
        if (bytes(vm.envOr("BSC_RPC", string(""))).length == 0) vm.skip(true);
        check.run(address(d.pool), address(d.lens), A.FEED_REPORTER_BSC_2);
    }
}
