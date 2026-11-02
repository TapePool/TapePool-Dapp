// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {XLayerBase, console2} from "./XLayerBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SpikePool} from "../../src/spike/SpikePool.sol";

/// T4: the live BEM OFT behaves as a plain ERC-20 vault asset.
contract T4_BemVaultTest is XLayerBase {
    IERC20 bem = IERC20(address(BEM));
    address constant BIG_HOLDER = 0x571d447f4f24688eC35Ccf07f1D6993655F6aF15; // ~413 BEM at the pinned block
    SpikePool pool;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        _fork();
        pool = new SpikePool(bem);
    }

    function test_T4_metadata() public view {
        assertEq(IERC20Metadata(address(bem)).decimals(), 8);
        assertEq(BEM.sharedDecimals(), 6);
        assertEq(IERC20Metadata(address(bem)).symbol(), "BEM");
        console2.log("OFT feeBps (bridge send only)", BEM.feeBps());
        console2.log("BEM totalSupply on X Layer (raw, 8 dp)", BEM.totalSupply());
        assertEq(pool.decimals(), 8 + 6, "iBEM decimals = asset + offset");
    }

    function test_T4_no_fee_on_transfer_real_holder() public {
        uint256 amt = 12_345_678_9; // 1.23456789 BEM
        uint256 a0 = bem.balanceOf(BIG_HOLDER);
        uint256 s0 = bem.totalSupply();
        vm.prank(BIG_HOLDER);
        assertTrue(bem.transfer(alice, amt));
        assertEq(bem.balanceOf(alice), amt, "recipient gets exact amount");
        assertEq(a0 - bem.balanceOf(BIG_HOLDER), amt, "sender debited exact amount");
        assertEq(bem.totalSupply(), s0, "no burn on transfer");
        // transferFrom by a third party (agent-style pull)
        vm.prank(alice);
        bem.approve(bob, amt);
        vm.prank(bob);
        assertTrue(bem.transferFrom(alice, bob, amt));
        assertEq(bem.balanceOf(bob), amt);
        assertEq(bem.allowance(alice, bob), 0);
    }

    function test_T4_deal_works() public {
        deal(address(bem), alice, 50e8);
        assertEq(bem.balanceOf(alice), 50e8, "forge deal finds the OFT balance slot");
    }

    function test_T4_erc4626_deposit_redeem_preview() public {
        vm.prank(BIG_HOLDER);
        bem.transfer(alice, 100e8);
        vm.startPrank(alice);
        bem.approve(address(pool), type(uint256).max);
        uint256 previewShares = pool.previewDeposit(100e8);
        uint256 g = gasleft();
        uint256 shares = pool.deposit(100e8, alice);
        console2.log("gas ERC4626 deposit (first)", g - gasleft());
        assertEq(shares, previewShares);
        assertEq(pool.totalAssets(), 100e8);
        assertEq(pool.previewRedeem(shares), 100e8);
        g = gasleft();
        uint256 assets = pool.redeem(shares / 2, alice, alice);
        console2.log("gas ERC4626 redeem", g - gasleft());
        assertEq(assets, 50e8);
        assertEq(bem.balanceOf(alice), 50e8);
        vm.stopPrank();
    }

    function test_T4_donation_inflation_bounded_by_offset() public {
        // attacker deposits 1 wei then donates 10 BEM; victim deposits 1 BEM
        deal(address(bem), bob, 20e8);
        deal(address(bem), alice, 1e8);
        vm.startPrank(bob);
        bem.approve(address(pool), type(uint256).max);
        pool.deposit(1, bob);
        bem.transfer(address(pool), 10e8);
        vm.stopPrank();
        vm.startPrank(alice);
        bem.approve(address(pool), type(uint256).max);
        uint256 s = pool.deposit(1e8, alice);
        assertGt(s, 0, "victim still gets shares");
        uint256 back = pool.previewRedeem(s);
        vm.stopPrank();
        console2.log("victim deposit 1e8 -> redeemable", back);
        assertGt(back, 1e8 * 99 / 100, "loss < 1% thanks to decimals offset 6");
    }
}
