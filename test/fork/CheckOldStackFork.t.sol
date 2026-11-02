// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CheckOldStack} from "../../script/deploy/CheckOldStack.s.sol";
import {TapePool} from "../../src/TapePool.sol";
import {Addresses as A} from "../../script/Addresses.sol";

/// The RD-02 log scan against X Layer's own `eth_getLogs` (read-only fork). The 2026-10-21 factory created
/// agent 0xAAD2…0f1E at block 73,887,334 (FINDINGS §6, 2026-10-22).
contract CheckOldStackForkTest is Test {
    address constant KNOWN_AGENT = 0xAAD24D50c7FdFaFbA8e40a1fEDE6D08E6FC40f1E;
    uint256 constant CREATED_AT = 73_887_334;

    CheckOldStack check;

    function setUp() public {
        vm.createSelectFork("xlayer", CREATED_AT + 200);
        check = new CheckOldStack();
    }

    function test_RA17_scanFindsTheAgentAcrossPageBoundaries() public {
        address[] memory agents = check.scanAgents(A.AGENT_FACTORY, CREATED_AT - 84, CREATED_AT + 116);
        assertEq(agents.length, 1);
        assertEq(agents[0], KNOWN_AGENT);
    }

    function test_RA17_scanIncludesBothEndsOfTheRange() public {
        address[] memory agents = check.scanAgents(A.AGENT_FACTORY, CREATED_AT, CREATED_AT);
        assertEq(agents.length, 1);
        assertEq(agents[0], KNOWN_AGENT);
        assertEq(check.scanAgents(A.AGENT_FACTORY, CREATED_AT - 100, CREATED_AT - 1).length, 0);
        assertEq(check.scanAgents(A.AGENT_FACTORY, CREATED_AT + 1, CREATED_AT + 100).length, 0);
    }
}

/// RD3-05 and RD3-06 on the 2026-10-31 pool, then the RD3-06 gate. LOCAL FORK ONLY: `prank` acts inside the
/// fork. The agent scan covers only the fork block here; the full scan runs on X Layer at RD3-06.
contract CheckOldStackRetireForkTest is Test {
    /// 2026-11-02, before RD3-05: 0.10 tpBEM with the owner, 0.05 with 0x5F68…9fb6, 0.01 with 0x…dEaD;
    /// supply cap 20 BEM, borrows paused.
    uint256 constant FORK_BLOCK = 74_857_898;
    address constant SECOND_WALLET = 0x5F68f040cE9C7E4980b3a4D3A5DDe17eA9db9fb6;
    uint256 constant DEAD_SEED_SHARES = 1e12;

    TapePool pool = TapePool(A.TAPE_POOL_2);
    CheckOldStack check;

    function setUp() public {
        vm.createSelectFork("xlayer", FORK_BLOCK);
        check = new CheckOldStack();
    }

    function test_RD3_06_gatePassesWithOnlyTheDeadSeedLeft() public {
        vm.expectRevert(bytes("old admission still open"));
        check.check(A.TAPE_POOL_2, A.AGENT_FACTORY_2, block.number);

        _redeemAll(A.OWNER);
        _redeemAll(SECOND_WALLET);
        _closeAdmission();
        check.check(A.TAPE_POOL_2, A.AGENT_FACTORY_2, block.number);
        assertEq(pool.totalSupply(), DEAD_SEED_SHARES);
    }

    function test_RD3_06_gateFailsWhileAnotherHolderRemains() public {
        _redeemAll(A.OWNER);
        _closeAdmission();
        vm.expectRevert(bytes("old shares beyond the dead seed"));
        check.check(A.TAPE_POOL_2, A.AGENT_FACTORY_2, block.number);
    }

    /// The gate walks every parameter up to `PerBorrowerAbs`, the last one; the 2026-10-21 gate stopped
    /// before it.
    function test_RD3_06_gateFailsWithTheLastParameterQueued() public {
        _redeemAll(A.OWNER);
        _redeemAll(SECOND_WALLET);
        _closeAdmission();
        vm.prank(A.OWNER);
        pool.queueParam(TapePool.Param.PerBorrowerAbs, 5e8);
        vm.expectRevert(bytes("old parameter queued"));
        check.check(A.TAPE_POOL_2, A.AGENT_FACTORY_2, block.number);
    }

    function _redeemAll(address holder) internal {
        uint256 shares = pool.balanceOf(holder);
        assertGt(shares, 0);
        vm.prank(holder);
        pool.redeem(shares, holder, holder);
    }

    function _closeAdmission() internal {
        vm.startPrank(A.OWNER);
        pool.pauseBorrows();
        pool.lowerCap(TapePool.Param.SupplyCap, 0);
        vm.stopPrank();
    }
}
