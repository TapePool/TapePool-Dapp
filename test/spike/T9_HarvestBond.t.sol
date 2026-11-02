// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console2} from "forge-std/Test.sol";
import {FeedBase} from "./FeedBase.sol";

interface IRigVaultBond {
    function BOND() external view returns (uint256);
    function MAX_BATCH() external view returns (uint256);
    function quoteHarvest(uint256 n) external view returns (uint256);
    function harvest(uint256[] calldata ids) external payable returns (uint256 total);
}

/// T9 (DERISK Q9): the BSC side of `harvest(ids)` from a fresh caller, and when the caller must front
/// a BEM bond. Verified vault source: a caller fronts `BOND` (0.0001 BEM) only when the whole batch
/// harvests less than `BOND`; unknown ids are filtered out; the LayerZero fee is `msg.value` and the
/// excess is refunded to the caller. BSC fork only; skips without `BSC_RPC`.
contract T9_HarvestBondTest is FeedBase {
    IERC20 constant BEM_BSC = IERC20(0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a);
    IRigVaultBond vault = IRigVaultBond(address(VAULT));
    address keeper;

    function setUp() public {
        _forks();
        vm.selectFork(bscFork);
        keeper = makeAddr("fresh-keeper");
        vm.deal(keeper, 1 ether);
        vm.txGasPrice(0); // so BNB spent == LayerZero fee exactly
    }

    function _ids(uint256 from, uint256 to) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](to - from + 1);
        for (uint256 i; i < ids.length; i++) {
            ids[i] = from + i;
        }
    }

    function test_T9_fresh_caller_harvests_with_bnb_only() public {
        uint256[] memory ids = _ids(RIG, RIG);
        uint256 fee = vault.quoteHarvest(1);
        assertEq(BEM_BSC.balanceOf(keeper), 0, "fresh caller holds no BEM");
        vm.prank(keeper);
        uint256 total = vault.harvest{value: fee}(ids);
        assertGe(total, vault.BOND(), "rig #5 backlog is far above the bond");
        assertEq(BEM_BSC.balanceOf(keeper), 0, "no bond taken");
        assertEq(keeper.balance, 1 ether - fee, "paid exactly the quoted fee");
        console2.log("harvest(1) fee (wei BNB)", fee);
        console2.log("harvested (raw BEM)", total);
    }

    function test_T9_batch_of_all_bridged_rigs() public {
        uint256[] memory ids = _ids(1, N_RIGS);
        uint256 fee = vault.quoteHarvest(N_RIGS);
        vm.prank(keeper);
        uint256 g = gasleft();
        uint256 total = vault.harvest{value: fee}(ids);
        console2.log("harvest(16) gas on BSC", g - gasleft());
        console2.log("harvest(16) fee (wei BNB)", fee);
        console2.log("harvested (raw BEM)", total);
        assertEq(BEM_BSC.balanceOf(keeper), 0, "no bond taken");
        assertLe(N_RIGS, vault.MAX_BATCH(), "one batch covers every bridged rig");
    }

    function test_T9_excess_fee_is_refunded() public {
        uint256[] memory ids = _ids(RIG, RIG);
        uint256 fee = vault.quoteHarvest(1);
        vm.prank(keeper);
        vault.harvest{value: fee * 2}(ids);
        assertEq(keeper.balance, 1 ether - fee, "excess refunded on BSC");
    }

    function test_T9_fee_below_quote_reverts() public {
        uint256[] memory ids = _ids(RIG, RIG);
        uint256 fee = vault.quoteHarvest(1);
        vm.prank(keeper);
        vm.expectRevert();
        vault.harvest{value: fee - 1}(ids);
    }

    /// The second harvest in the same block finds nothing, so the batch total is below `BOND`.
    function test_T9_bond_required_when_batch_total_below_bond() public {
        uint256[] memory ids = _ids(16, 16); // the 1 H demo rig
        uint256 fee = vault.quoteHarvest(1);
        vm.prank(keeper);
        vault.harvest{value: fee}(ids);

        // no BEM: the vault's transferFrom of the bond fails
        vm.prank(keeper);
        vm.expectRevert();
        vault.harvest{value: fee}(ids);

        // with BEM and an approval, the caller fronts exactly BOND
        uint256 bond = vault.BOND();
        deal(address(BEM_BSC), keeper, bond);
        vm.prank(keeper);
        BEM_BSC.approve(address(vault), bond);
        vm.prank(keeper);
        uint256 total = vault.harvest{value: fee}(ids);
        assertLt(total, bond, "batch below the bond");
        assertEq(BEM_BSC.balanceOf(keeper), 0, "bond taken from the caller");
        console2.log("bond (raw BEM)", bond);
    }

    function test_T9_unknown_ids_are_filtered() public {
        uint256[] memory mixed = new uint256[](2);
        mixed[0] = RIG;
        mixed[1] = 9_999;
        uint256 fee = vault.quoteHarvest(2);
        vm.prank(keeper);
        assertGt(vault.harvest{value: fee}(mixed), 0, "known id harvested, unknown id skipped");

        uint256[] memory unknown = _ids(9_999, 9_999);
        vm.prank(keeper);
        vm.expectRevert();
        vault.harvest{value: fee}(unknown);
    }
}
