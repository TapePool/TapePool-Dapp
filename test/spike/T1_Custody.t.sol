// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {XLayerBase, console2} from "./XLayerBase.sol";
import {TestAgent} from "../../src/spike/TestAgent.sol";

/// T1: a per-borrower agent contract can take custody of a REAL RIG voucher and act as its holder.
contract T1_CustodyTest is XLayerBase {
    TestAgent agent;
    address borrower;

    function setUp() public {
        _fork();
        borrower = HOLDER_C905; // real holder of vouchers 4..13 (an EOA)
        agent = new TestAgent(VOUCHER, borrower);
    }

    function test_T1_safeTransferFrom_hook() public {
        uint256 id = 4;
        assertEq(VOUCHER.ownerOf(id), borrower);
        uint256 marksBefore = VOUCHER.marksOf(id);
        (,,, uint256 power) = VOUCHER.rigs(id);
        uint256 heldBefore = VOUCHER.powerHeld(borrower);

        uint256 g = gasleft();
        vm.prank(borrower);
        VOUCHER.safeTransferFrom(borrower, address(agent), id);
        console2.log("gas safeTransferFrom -> agent (incl. hook)", g - gasleft());

        assertEq(VOUCHER.ownerOf(id), address(agent));
        assertTrue(agent.holding());
        assertEq(agent.rigId(), id);
        assertEq(VOUCHER.marksOf(id), marksBefore + 1, "a Mark is appended");
        assertEq(VOUCHER.holderAt(id, block.timestamp), address(agent));
        assertEq(VOUCHER.payeeAt(id, block.timestamp), address(agent));
        assertEq(VOUCHER.holderAt(id, block.timestamp - 1), borrower, "history keeps old holder");
        assertEq(VOUCHER.powerHeld(address(agent)), power);
        assertEq(VOUCHER.powerHeld(borrower), heldBefore - power);
    }

    function test_T1_transferFrom_then_register() public {
        uint256 id = 5;
        uint256 g = gasleft();
        vm.prank(borrower);
        VOUCHER.transferFrom(borrower, address(agent), id);
        console2.log("gas transferFrom -> agent", g - gasleft());
        assertEq(VOUCHER.ownerOf(id), address(agent));
        assertFalse(agent.holding(), "no hook on plain transferFrom");
        agent.register(id);
        assertTrue(agent.holding());
        assertEq(VOUCHER.holderAt(id, block.timestamp), address(agent));
    }

    function test_T1_register_rejects_unheld() public {
        vm.expectRevert(TestAgent.NotHeld.selector);
        agent.register(6); // still owned by borrower
    }

    function test_T1_agent_transfers_back() public {
        uint256 id = 4;
        vm.prank(borrower);
        VOUCHER.safeTransferFrom(borrower, address(agent), id);
        vm.warp(block.timestamp + 1 days);
        uint256 g = gasleft();
        vm.prank(borrower);
        agent.release(borrower);
        console2.log("gas agent.release (safeTransferFrom back)", g - gasleft());
        assertEq(VOUCHER.ownerOf(id), borrower);
        assertEq(VOUCHER.holderAt(id, block.timestamp), borrower);
        assertEq(VOUCHER.holderAt(id, block.timestamp - 1), address(agent));
        // non-owner cannot release
        vm.prank(borrower);
        VOUCHER.safeTransferFrom(borrower, address(agent), id);
        vm.prank(address(0xBAD));
        vm.expectRevert(TestAgent.NotOwner.selector);
        agent.release(address(0xBAD));
    }

    function test_T1_agent_redeem_simulated() public {
        uint256 id = 4;
        vm.prank(borrower);
        VOUCHER.safeTransferFrom(borrower, address(agent), id);
        uint256 fee = VOUCHER.quoteRedeem();
        console2.log("quoteRedeem (wei OKB)", fee);
        uint256 bond = VOUCHER.bonds(id);
        console2.log("bond (raw BEM) sent back with redeem", bond);
        vm.deal(borrower, 1 ether);

        // BadRecipient: vault / voucher / OFT cannot be the BSC recipient
        vm.prank(borrower);
        vm.expectRevert(bytes4(keccak256("BadRecipient()")));
        agent.redeem{value: fee}(RIG_VAULT_BSC);

        // NotHolder: someone else's voucher
        vm.prank(borrower);
        vm.expectRevert(bytes4(keccak256("NotHolder()")));
        VOUCHER.redeem{value: fee}(14, borrower);

        uint256 vBemBefore = BEM.balanceOf(address(VOUCHER));
        uint256 g = gasleft();
        vm.prank(borrower);
        bytes32 guid = agent.redeem{value: fee}(borrower); // to = borrower's BSC address
        console2.log("gas agent.redeem (burn + OFT send via LZ endpoint)", g - gasleft());
        assertTrue(guid != bytes32(0), "guid");
        vm.expectRevert(); // burned
        VOUCHER.ownerOf(id);
        assertEq(VOUCHER.redeemer(id), address(agent));
        assertEq(VOUCHER.payeeAt(id, block.timestamp + 1), address(agent), "post-redeem yield -> redeemer (agent)");
        assertEq(vBemBefore - BEM.balanceOf(address(VOUCHER)), bond, "bond burned/sent by OFT");
    }

    /// Overpaying the LZ fee: the excess is refunded to the redeem caller (the agent) -> agent needs receive().
    function test_T1_redeem_overpay_refund_to_agent() public {
        vm.prank(borrower);
        VOUCHER.safeTransferFrom(borrower, address(agent), 4);
        uint256 fee = VOUCHER.quoteRedeem();
        vm.deal(borrower, 1 ether);
        uint256 a0 = address(agent).balance;
        vm.prank(borrower);
        agent.redeem{value: fee * 2}(borrower);
        console2.log("refund to agent (wei OKB)", address(agent).balance - a0);
        assertEq(address(agent).balance - a0, fee, "excess LZ fee refunded to agent");
    }
}
