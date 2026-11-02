// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {XLayerBase} from "../spike/XLayerBase.sol";
import {TestAgent} from "../../src/spike/TestAgent.sol";

/// Pins the tie rule behind "harvest first" (SPEC-PHASE5-PRELOAN P2, FINDINGS F6/F8): a harvest pays
/// `payeeAt(id, T)`, where T is the BSC time of the harvest transaction, and `holderAt` returns the holder of the LAST
/// transfer mark with `mark.time <= T`. So a transfer whose mark is the same second as the harvest pays the NEW holder,
/// and one second later it pays the OLD holder. The app's move gate (head later than T + 2) exists because of this tie.
/// Runs on a fork of X Layer against the real voucher implementation; `vm.warp` only moves the local EVM's clock.
contract PayeeTieTest is XLayerBase {
    address borrower = HOLDER_C905;
    uint256 constant ID = 4;
    uint256 constant AMOUNT_SD = 250_000; // 0.25 BEM at 6 shared decimals
    uint256 constant AMOUNT_LD = AMOUNT_SD * 100; // 8 local decimals

    function setUp() public {
        _fork();
    }

    /// Hand the voucher to a fresh agent in a block whose timestamp is `at`.
    function _handOver(uint256 at) internal returns (TestAgent agent) {
        agent = new TestAgent(VOUCHER, borrower);
        vm.warp(at);
        vm.prank(borrower);
        VOUCHER.safeTransferFrom(borrower, address(agent), ID);
    }

    /// A transfer whose mark equals the harvest time pays the NEW holder: the agent.
    function test_transfer_at_the_harvest_second_pays_the_new_holder() public {
        uint256 t = block.timestamp + 1 hours;
        TestAgent agent = _handOver(t);

        assertEq(VOUCHER.holderAt(ID, t), address(agent), "the mark at T already counts");
        assertEq(VOUCHER.payeeAt(ID, t), address(agent), "payeeAt(T) is the new holder");
        assertEq(VOUCHER.payeeAt(ID, t - 1), borrower, "one second before the mark it is the old holder");

        // the same through the real delivery path: the endpoint's lzReceive and lzCompose, voucher._payYield
        uint256 borrowerBefore = BEM.balanceOf(borrower);
        _deliverHarvest(ID, uint64(AMOUNT_SD), uint64(t), 107);
        assertEq(BEM.balanceOf(address(agent)), AMOUNT_LD, "the agent is paid");
        assertEq(BEM.balanceOf(borrower), borrowerBefore, "the wallet is not");
    }

    /// A transfer one second AFTER the harvest pays the OLD holder: the wallet.
    function test_transfer_one_second_after_the_harvest_pays_the_old_holder() public {
        uint256 t = block.timestamp + 1 hours;
        TestAgent agent = _handOver(t + 1);

        assertEq(VOUCHER.payeeAt(ID, t), borrower, "payeeAt(T) is the old holder");
        assertEq(VOUCHER.payeeAt(ID, t + 1), address(agent), "from the mark on it is the new holder");

        uint256 borrowerBefore = BEM.balanceOf(borrower);
        _deliverHarvest(ID, uint64(AMOUNT_SD), uint64(t), 107);
        assertEq(BEM.balanceOf(borrower) - borrowerBefore, AMOUNT_LD, "the wallet is paid");
        assertEq(BEM.balanceOf(address(agent)), 0, "the agent is not");
    }

    /// The gate of the app: the voucher moves only when X Layer's head is later than T + 2, so the mark of the move is
    /// after T and the wallet is the payee. The mark of a move at T + 3 is therefore on the safe side of the tie.
    function test_a_move_after_t_plus_two_leaves_the_wallet_the_payee() public {
        uint256 t = block.timestamp + 1 hours;
        TestAgent agent = _handOver(t + 3);
        assertEq(VOUCHER.payeeAt(ID, t), borrower);
        assertEq(VOUCHER.payeeAt(ID, t + 2), borrower);
        assertEq(VOUCHER.payeeAt(ID, t + 3), address(agent));
    }
}
