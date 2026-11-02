// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TapePool} from "../../src/TapePool.sol";
import {DeployPool} from "../../script/deploy/DeployPool.s.sol";
import {CheckStack} from "../../script/deploy/CheckStack.s.sol";
import {ParityVectors} from "../../script/app/ParityVectors.s.sol";
import {Addresses as A} from "../../script/Addresses.sol";
import {PolicyV1} from "../../src/libraries/PolicyV1.sol";
import {MockBEM, MockVoucher, MockRigFeed} from "../mocks/Mocks.sol";
import {NandCircuits} from "../mocks/NandCircuits.sol";

/// A feed stand-in with the two receiver views `CheckStack` reads.
contract ReceiverStub is MockRigFeed {
    bool public locked;
    mapping(uint32 => bytes32) public peers;

    function setLocked(bool l) external {
        locked = l;
    }

    function setPeer(uint32 eid, bytes32 peer) external {
        peers[eid] = peer;
    }
}

/// Redeploy 3, R3-07: the deploy and check scripts on local mocks, without RPC calls or broadcasts.
contract Redeploy3ScriptsTest is Test {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    CheckStack check = new CheckStack();

    function _deployOn(address feed) internal returns (DeployPool.Deployed memory d) {
        vm.warp(1_800_000_000);
        MockBEM bem = new MockBEM();
        vm.etch(A.BEM_OFT_XLAYER, address(bem).code);
        MockVoucher voucher = new MockVoucher(A.BEM_OFT_XLAYER);
        vm.etch(A.RIG_VOUCHER, address(voucher).code);
        NandCircuits circuits = new NandCircuits();
        vm.etch(A.POLICY_CIRCUITS, address(circuits).code);
        (bytes memory netlist,) = PolicyV1.build();
        NandCircuits(A.POLICY_CIRCUITS).tapeout(netlist, PolicyV1.N_IN, PolicyV1.N_OUT);
        DeployPool deployer = new DeployPool();
        d = deployer.deployAll(address(deployer), A.POLICY_CIRCUITS, A.POLICY_CIRCUIT_ID, feed);
    }

    /// The reused receiver stand-in at its live address: locked, peering the reused reporter.
    function _reusedReceiver() internal returns (ReceiverStub r) {
        vm.etch(A.FEED_RECEIVER_XLAYER_2, address(new ReceiverStub()).code);
        r = ReceiverStub(A.FEED_RECEIVER_XLAYER_2);
        r.setLocked(true);
        r.setPeer(A.BSC_EID, bytes32(uint256(uint160(A.FEED_REPORTER_BSC_2))));
    }

    function test_R3_07_checkStackPinsTheReusedFeed() public {
        ReceiverStub r = _reusedReceiver();
        DeployPool.Deployed memory d = _deployOn(address(r));
        check.checkPool(d.pool, d.lens);
        check.checkReusedFeed(d.pool);
        r.setLocked(false);
        vm.expectRevert(bytes("receiver lock"));
        check.checkReusedFeed(d.pool);
        r.setLocked(true);
        r.setPeer(A.BSC_EID, bytes32(uint256(uint160(A.FEED_REPORTER_BSC))));
        vm.expectRevert(bytes("receiver peer"));
        check.checkReusedFeed(d.pool);

        DeployPool.Deployed memory other = _deployOn(address(new MockRigFeed()));
        check.checkPool(other.pool, other.lens);
        vm.expectRevert(bytes("reused receiver"));
        check.checkReusedFeed(other.pool);
    }

    function test_R3_07_checkPoolRequiresNoReEnableYet() public {
        DeployPool.Deployed memory d = _deployOn(address(_reusedReceiver()));
        assertEq(d.pool.feedEnabledAt(), 0);
        assertEq(d.pool.FEED_SETTLE(), 360);
        vm.prank(A.KEEPER_GUARDIAN);
        d.pool.disableFeed();
        vm.prank(A.OWNER);
        d.pool.enableFeed();
        vm.expectRevert(bytes("feed record"));
        check.checkPool(d.pool, d.lens);
    }

    function test_R3_07_checkPoolSeededAfterTheSeed() public {
        DeployPool.Deployed memory d = _deployOn(address(_reusedReceiver()));
        vm.expectRevert(bytes("dead seed"));
        check.checkPoolSeeded(d.pool, d.lens);
        MockBEM bem = MockBEM(A.BEM_OFT_XLAYER);
        // RD3-07: 0.01 BEM to the dead address, then the owner's backstop
        bem.mint(address(this), 1_000_000);
        bem.approve(address(d.pool), 1_000_000);
        d.pool.deposit(1_000_000, DEAD);
        vm.expectRevert(bytes("backstop shares"));
        check.checkPoolSeeded(d.pool, d.lens);
        bem.mint(A.OWNER, 14_000_000);
        vm.startPrank(A.OWNER);
        bem.approve(address(d.pool), 14_000_000);
        d.pool.deposit(14_000_000, A.OWNER);
        vm.stopPrank();
        assertEq(d.pool.balanceOf(DEAD), 1e12);
        vm.expectRevert(bytes("pre-seed accounting"));
        check.checkPool(d.pool, d.lens);
        check.checkPoolSeeded(d.pool, d.lens);
        check.checkReusedFeed(d.pool);
    }

    /// The parity vector script, with its R3-00 evidence vectors, runs to the end.
    function test_R3_07_parityVectorsRun() public {
        new ParityVectors().run();
    }
}
