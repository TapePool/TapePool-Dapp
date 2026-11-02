// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {XLayerBase, console2} from "./XLayerBase.sol";
import {Vm} from "forge-std/Vm.sol";
import {TestAgent} from "../../src/spike/TestAgent.sol";

/// T2: harvest BEM sent while the agent holds the voucher is paid to the agent; harvest sent
///     before the hand-over is paid to the previous holder (send-time attribution).
contract T2_YieldRoutingTest is XLayerBase {
    event Paid(uint256 indexed id, address indexed to, uint256 amount);

    TestAgent agent;
    address borrower = HOLDER_C905;
    uint256 constant ID = 4;
    uint256 tTransfer;

    function setUp() public {
        _fork();
        agent = new TestAgent(VOUCHER, borrower);
        vm.warp(block.timestamp + 60);
        tTransfer = block.timestamp;
        vm.prank(borrower);
        VOUCHER.safeTransferFrom(borrower, address(agent), ID);
        vm.warp(block.timestamp + 3 days); // time passes, loan runs
    }

    /// The compose message we build is byte-identical to the real compose of rig #14
    /// (X Layer tx 0xfcf32848..8e2d, LZ nonce 1463) when fed the same fields.
    function test_T2_encoding_matches_real_compose_tx() public pure {
        bytes memory real =
            hex"00000000000005b7000075960000000000000000000000000000000000000000000000000000000000a4739c00000000000000000000000048d43345656f0f9510dc3c06cba99dff597617c20000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000006ad2cf6600000000000000000000000025f7e8568e018fd9f3f58a325b911fa81cb7610d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000a547540000000000000000000000000000000c";
        bytes memory body = _yieldBody(0x6ad2cf66, 0x25f7E8568e018fD9F3F58a325b911Fa81Cb7610d, 14, 0xa54754, 12);
        bytes memory mine =
            abi.encodePacked(uint64(1463), BSC_EID, uint256(0xa4739c), bytes32(uint256(uint160(RIG_VAULT_BSC))), body);
        assertEq(mine, real);
    }

    function test_T2_harvest_after_transfer_pays_agent() public {
        uint64 amountSD = 1_000_000; // 1 BEM (6 shared decimals) -> 1e8 raw
        uint256 amountLD = uint256(amountSD) * 100;
        uint256 vBefore = BEM.balanceOf(address(VOUCHER));
        uint256 supplyBefore = BEM.totalSupply();
        uint64 sendTime = uint64(block.timestamp - 1 hours); // BSC harvest sent during the loan

        vm.recordLogs();
        HarvestResult memory r = _deliverHarvest(ID, amountSD, sendTime, 107);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawPaid;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(VOUCHER) && logs[i].topics[0] == Paid.selector) {
                assertEq(logs[i].topics[1], bytes32(ID));
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(address(agent)))));
                assertEq(abi.decode(logs[i].data, (uint256)), amountLD);
                sawPaid = true;
            }
        }
        assertTrue(sawPaid, "Paid(id, agent, amount) emitted by voucher");

        assertEq(BEM.balanceOf(address(agent)), amountLD, "agent got the harvest");
        assertEq(BEM.balanceOf(address(VOUCHER)), vBefore, "voucher passes it through (bonds untouched)");
        assertEq(BEM.totalSupply(), supplyBefore + amountLD, "OFT minted on receive (no receive-side fee)");
        (, uint64 syncedAt,, uint256 power) = VOUCHER.rigs(ID);
        assertEq(syncedAt, sendTime, "syncedAt updated");
        assertEq(power, 107);
        console2.log("level (1 = real verify/lzReceive/lzCompose path)", r.level);
        console2.log("gas endpoint.lzReceive (OFT mint + sendCompose)", r.gasReceive);
        console2.log("gas endpoint.lzCompose (voucher _payYield) [real tx used 120,682 incl. intrinsic]", r.gasCompose);
    }

    function test_T2_harvest_sent_before_transfer_pays_old_holder() public {
        uint64 amountSD = 500_000;
        uint256 amountLD = uint256(amountSD) * 100;
        uint256 oldBal = BEM.balanceOf(borrower);
        uint64 sendTime = uint64(tTransfer - 1); // sent on BSC 1s before the hand-over, lands later
        _deliverHarvest(ID, amountSD, sendTime, 107);
        assertEq(BEM.balanceOf(borrower) - oldBal, amountLD, "old holder paid");
        assertEq(BEM.balanceOf(address(agent)), 0, "agent got nothing");
    }

    function test_T2_harvest_at_exact_transfer_second_pays_agent() public {
        uint64 amountSD = 250_000;
        _deliverHarvest(ID, amountSD, uint64(tTransfer), 107);
        assertEq(BEM.balanceOf(address(agent)), uint256(amountSD) * 100, "holderAt uses mark.time <= t");
    }

    /// Harvest sent while the agent held the voucher but landing after it was released still pays the agent.
    function test_T2_late_landing_after_release_still_pays_agent() public {
        uint64 sendTime = uint64(block.timestamp - 10);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(borrower);
        agent.release(borrower);
        _deliverHarvest(ID, 100_000, sendTime, 107);
        assertEq(BEM.balanceOf(address(agent)), 100_000 * 100, "late BEM lands in the (former) agent");
    }

    function test_T2_forged_compose_rejected() public {
        // a compose not coming through the endpoint is rejected by the voucher
        vm.expectRevert(bytes4(keccak256("UntrustedCompose()")));
        VOUCHER.lzCompose(address(BEM), bytes32(0), hex"", address(0), hex"");
    }
}
