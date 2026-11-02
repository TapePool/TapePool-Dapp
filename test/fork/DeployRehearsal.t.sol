// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RigFeedReceiver} from "../../src/feed/RigFeedReceiver.sol";
import {ILzEndpointSend} from "../../src/interfaces/ILayerZero.sol";
import {FeedConfig} from "../../script/feed/FeedConfig.sol";
import {DeployPool} from "../../script/deploy/DeployPool.s.sol";
import {Addresses as A} from "../../script/Addresses.sol";
import {PolicyForkBase} from "./PolicyFork.t.sol";

/// Rehearsal of the pool deploy script (SPEC-PHASE3 §6 steps 3–7) on an X Layer fork, on top of a
/// real tape-out and a receiver. LOCAL FORK ONLY.
contract DeployPoolRehearsalTest is PolicyForkBase {
    DeployPool s;
    RigFeedReceiver receiver;

    function setUp() public {
        _fork();
        _tapeOut();
        receiver = new RigFeedReceiver(A.ENDPOINT, address(this), A.BSC_EID, A.BEM_OFT_XLAYER);
        // lock the X Layer side as the feed session does (peer: a stand-in reporter address)
        ILzEndpointSend ep = ILzEndpointSend(A.ENDPOINT);
        (address lib,) = ep.getReceiveLibrary(A.BEM_OFT_XLAYER, A.BSC_EID);
        receiver.setPeer(A.BSC_EID, bytes32(uint256(uint160(address(0xBEEF)))));
        FeedConfig.mirror(ep, address(receiver), lib, A.BSC_EID, A.BEM_OFT_XLAYER);
        receiver.lock(lib);
        s = new DeployPool();
    }

    function test_deploy_script_wires_the_stack() public {
        DeployPool.Deployed memory d = s.deployAll(address(s), circuits, circuitId, address(receiver));
        s.check(d, address(receiver));
        assertTrue(d.credit.pinsOk());
        assertEq(d.pool.owner(), A.OWNER);
        assertEq(d.pool.guardian(), A.KEEPER_GUARDIAN);
    }

    function test_check_refuses_an_unlocked_feed() public {
        RigFeedReceiver open = new RigFeedReceiver(A.ENDPOINT, address(this), A.BSC_EID, A.BEM_OFT_XLAYER);
        DeployPool.Deployed memory d = s.deployAll(address(s), circuits, circuitId, address(open));
        vm.expectRevert(bytes("feed not locked"));
        s.check(d, address(open));
    }

    function test_check_catches_a_wrong_circuit_id() public {
        DeployPool.Deployed memory d = s.deployAll(address(s), circuits, circuitId + 1, address(receiver));
        assertFalse(d.credit.pinsOk(), "the pool would accept it, every borrow would fail with PIN");
        vm.expectRevert(bytes("policy pins do not match the circuit"));
        s.check(d, address(receiver));
    }
}

/// The deploy script's halving check against the live PodMining record on a BSC fork.
contract DeployPoolEmissionTest is Test {
    function test_emission_end_matches_bsc() public {
        string memory bscRpc = vm.envOr("BSC_RPC", string(""));
        if (bytes(bscRpc).length == 0) vm.skip(true);
        vm.createSelectFork(bscRpc, 128_369_002);
        assertEq(new DeployPool().emissionEnd(), A.EMISSION_VALID_UNTIL);
    }
}
