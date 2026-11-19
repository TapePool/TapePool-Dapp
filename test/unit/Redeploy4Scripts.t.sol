// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployPool} from "../../script/deploy/DeployPool.s.sol";
import {CheckStack} from "../../script/deploy/CheckStack.s.sol";
import {Addresses as A} from "../../script/Addresses.sol";
import {Base} from "./Base.t.sol";
import {ReceiverStub} from "./Redeploy3Scripts.t.sol";
import {BonusMinerRecords} from "./Redeploy4Bonus.t.sol";
import {CustodyEndpoint} from "./Redeploy4Custody.t.sol";
import {MockBEM, MockVoucher, MockRigFeed} from "../mocks/Mocks.sol";
import {NandCircuits} from "../mocks/NandCircuits.sol";
import {BscRigReaderHarness} from "../mocks/BscRigReaderHarness.sol";
import {RigReporter} from "../../src/feed/RigReporter.sol";
import {IRigVaultBsc, IPodMining, Miner} from "../../src/interfaces/IBsc.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {PolicyV1} from "../../src/libraries/PolicyV1.sol";

/// Deployment placeholders must fail before RPC access or broadcast setup.
contract Redeploy4ScriptsTest is Test {
    function test_R4_06_deployRefusesTheUndeployedReceiver() public {
        vm.chainId(A.XLAYER_CHAIN_ID);
        DeployPool deploy = new DeployPool();
        vm.expectRevert(bytes("redeploy 4 receiver not deployed"));
        deploy.run(A.POLICY_CIRCUITS, A.POLICY_CIRCUIT_ID, A.FEED_RECEIVER_XLAYER_4);
    }

    function test_R4_06_deployRefusesTheRetiredReceiver() public {
        vm.chainId(A.XLAYER_CHAIN_ID);
        DeployPool deploy = new DeployPool();
        vm.expectRevert(bytes("redeploy 4 receiver not deployed"));
        deploy.run(A.POLICY_CIRCUITS, A.POLICY_CIRCUIT_ID, A.FEED_RECEIVER_XLAYER_2);
    }

    function test_R4_06_deployRequiresCircuitOne() public {
        vm.chainId(A.XLAYER_CHAIN_ID);
        DeployPool deploy = new DeployPool();
        vm.expectRevert(bytes("redeploy 4 circuit"));
        deploy.run(A.POLICY_CIRCUITS, 2, address(1));
    }

    function test_R4_06_checkRefusesUndeployedStackBeforeForking() public {
        CheckStack check = new CheckStack();
        vm.expectRevert(bytes("stack not deployed"));
        check.run(A.TAPE_POOL_4, A.TAPE_LENS_4, A.FEED_REPORTER_BSC_4);
    }

    function test_R4_06_checkRefusesUndeployedReporterBeforeForking() public {
        CheckStack check = new CheckStack();
        vm.expectRevert(bytes("feed not deployed"));
        check.run(address(1), address(2), A.FEED_REPORTER_BSC_4);
    }

    function test_R4_06_runRefusesTheRetiredPairBeforeForking() public {
        CheckStack check = new CheckStack();
        vm.expectRevert(bytes("not the redeploy 4 reporter"));
        check.run(A.TAPE_POOL_3, A.TAPE_LENS_3, A.FEED_REPORTER_BSC_2);
    }
}

/// The active gate accepts a new deployment pair, with all three receiver pins agreeing.
contract Redeploy4FeedPinsTest is Base {
    function _checkRetiredFeed(address receiver, address reporter) internal {
        vm.chainId(A.XLAYER_CHAIN_ID);
        CheckStack check = new CheckStack();
        vm.mockCall(address(pool.policy()), abi.encodeWithSignature("feed()"), abi.encode(receiver));
        vm.expectRevert(bytes("retired feed"));
        check.checkOnForks(address(pool), address(lens), reporter, 0, false);
    }

    function test_R4_06_checkOnForksRefusesTheFirstReceiver() public {
        _checkRetiredFeed(A.FEED_RECEIVER_XLAYER, address(0x4444));
    }

    function test_R4_06_checkOnForksRefusesTheSecondReceiver() public {
        _checkRetiredFeed(A.FEED_RECEIVER_XLAYER_2, address(0x4444));
    }

    function test_R4_06_checkOnForksRefusesTheFirstReporter() public {
        _checkRetiredFeed(address(feed), A.FEED_REPORTER_BSC);
    }

    function test_R4_06_checkOnForksRefusesTheSecondReporter() public {
        _checkRetiredFeed(address(feed), A.FEED_REPORTER_BSC_2);
    }

    function test_R4_06_checkPinsTheSuppliedNewFeedPair() public {
        CheckStack check = new CheckStack();
        vm.etch(address(feed), address(new ReceiverStub()).code);
        ReceiverStub receiver = ReceiverStub(address(feed));
        address reporter = address(0x4444);
        receiver.setLocked(true);
        receiver.setPeer(A.BSC_EID, bytes32(uint256(uint160(reporter))));
        check.checkFeedPins(pool, address(receiver), reporter);
        vm.expectRevert(bytes("feed not deployed"));
        check.checkFeedPins(pool, address(0), reporter);
        vm.expectRevert(bytes("receiver pins"));
        check.checkFeedPins(pool, address(0x5555), reporter);
        vm.expectRevert(bytes("receiver peer"));
        check.checkFeedPins(pool, address(receiver), A.FEED_REPORTER_BSC_2);
        receiver.setLocked(false);
        vm.expectRevert(bytes("receiver lock"));
        check.checkFeedPins(pool, address(receiver), reporter);
    }
}

/// R4-09: the launch gate accepts clamped base power and rejects a wrong base or share decimals.
contract Redeploy4GateTest is Test {
    CheckStack check;
    BonusMinerRecords records;
    RigReporter reporter;

    function setUp() public {
        vm.warp(1_800_000_000);
        check = new CheckStack();
        records = new BonusMinerRecords();
        records.set(A.CPU_TAPEOUT, 1005, address(0));
        vm.etch(A.ENDPOINT, address(new CustodyEndpoint()).code);
        reporter = new RigReporter(
            A.ENDPOINT,
            address(this),
            A.XLAYER_EID,
            IRigVaultBsc(address(records)),
            IPodMining(address(records)),
            A.BEM_ADAPTER_BSC
        );
        reporter.setPeer(A.XLAYER_EID, bytes32(uint256(1)));
    }

    function _miner(uint128 weight) internal pure returns (Miner memory m) {
        m.circuits = A.CPU_TAPEOUT;
        m.circuitId = 1005;
        m.status = weight == 0 ? 2 : 1;
        m.bstar = 4;
        m.mult = 6;
        m.bonus = 72;
        m.verifWeight = weight;
    }

    function test_R4_09_inactiveTapeOutSamplePassesTheClampedGate() public {
        records.setMiner(_miner(0), 1_000);
        RigReport memory r = check.readTapeOut(reporter);
        assertEq(r.verifWeight, 0);
        assertEq(r.bonus, 0);
        assertEq(r.status, 2);
        assertEq(r.rigId, 5);
    }

    function test_R4_09_underweightTapeOutSamplePassesTheClampedGate() public {
        records.setMiner(_miner(12), 1_000);
        RigReport memory r = check.readTapeOut(reporter);
        assertEq(r.verifWeight, 12);
        assertEq(r.bonus, 0);
        assertEq(r.verifWeight - r.bonus, 12);
    }

    function test_R4_09_mult6SampleKeepsTheCorrectBase() public {
        records.setMiner(_miner(456), 1_000);
        RigReport memory r = check.readTapeOut(reporter);
        assertEq(r.verifWeight, 456);
        assertEq(r.bonus, 432);
        assertEq(r.verifWeight - r.bonus, 24);
    }

    function test_R4_09_rawBonusBaseAtMult6FailsTheGate() public {
        Miner memory m = _miner(456);
        Miner memory wrong = _miner(456);
        wrong.bstar = 64; // materialize weight 456 - raw bonus 72 = base 384 in the reader answer
        records.setMiner(wrong, 1_000);
        RigReport memory r = new BscRigReaderHarness().read(address(records), address(records), 5);
        assertEq(r.bonus, m.bonus, "raw bonus instead of weight bonus");
        assertEq(r.verifWeight - r.bonus, 384);
        bytes[] memory answers = new bytes[](2);
        answers[0] = abi.encode(m); // the independent miner read still says bstar 4, mult 6
        answers[1] = abi.encode(wrong); // inject the wrong base into the subsequent reader result
        vm.mockCalls(
            address(records), abi.encodeCall(IPodMining.getMiner, (records.minerKey(A.CPU_TAPEOUT, 1005))), answers
        );
        vm.expectRevert(bytes("normalized TapeOut base"));
        check.readTapeOut(reporter);
    }

    function test_R4_11_baseBelowTheClampedBaseFailsTheGate() public {
        Miner memory m = _miner(456);
        Miner memory wrong = _miner(456);
        wrong.bstar = 2; // materialize base 12 instead of the independently read base 24
        records.setMiner(wrong, 1_000);
        RigReport memory r = new BscRigReaderHarness().read(address(records), address(records), 5);
        assertEq(r.bonus, 444);
        assertEq(r.verifWeight - r.bonus, 12);
        bytes[] memory answers = new bytes[](2);
        answers[0] = abi.encode(m);
        answers[1] = abi.encode(wrong);
        vm.mockCalls(
            address(records), abi.encodeCall(IPodMining.getMiner, (records.minerKey(A.CPU_TAPEOUT, 1005))), answers
        );
        vm.expectRevert(bytes("normalized TapeOut base"));
        check.readTapeOut(reporter);
    }

    function test_R4_11_launchRejectsEightShareDecimals() public {
        vm.etch(A.BEM_OFT_XLAYER, address(new MockBEM()).code);
        vm.etch(A.RIG_VOUCHER, address(new MockVoucher(A.BEM_OFT_XLAYER)).code);
        vm.etch(A.POLICY_CIRCUITS, address(new NandCircuits()).code);
        (bytes memory netlist,) = PolicyV1.build();
        NandCircuits(A.POLICY_CIRCUITS).tapeout(netlist, PolicyV1.N_IN, PolicyV1.N_OUT);
        DeployPool deploy = new DeployPool();
        DeployPool.Deployed memory d =
            deploy.deployAll(address(deploy), A.POLICY_CIRCUITS, A.POLICY_CIRCUIT_ID, address(new MockRigFeed()));
        assertEq(d.pool.decimals(), 14);
        check.checkPool(d.pool, d.lens);
        vm.mockCall(address(d.pool), abi.encodeWithSignature("decimals()"), abi.encode(uint8(8)));
        vm.expectRevert(bytes("share decimals"));
        check.checkPool(d.pool, d.lens);
        vm.expectRevert(bytes("share decimals"));
        check.checkPoolSeeded(d.pool, d.lens);
    }

    function test_R4_09_launchRejectsTwentyFourShareDecimals() public {
        vm.etch(A.BEM_OFT_XLAYER, address(new MockBEM()).code);
        vm.etch(A.RIG_VOUCHER, address(new MockVoucher(A.BEM_OFT_XLAYER)).code);
        vm.etch(A.POLICY_CIRCUITS, address(new NandCircuits()).code);
        (bytes memory netlist,) = PolicyV1.build();
        NandCircuits(A.POLICY_CIRCUITS).tapeout(netlist, PolicyV1.N_IN, PolicyV1.N_OUT);
        DeployPool deploy = new DeployPool();
        DeployPool.Deployed memory d =
            deploy.deployAll(address(deploy), A.POLICY_CIRCUITS, A.POLICY_CIRCUIT_ID, address(new MockRigFeed()));
        assertEq(d.pool.decimals(), 14);
        check.checkPool(d.pool, d.lens);
        vm.mockCall(address(d.pool), abi.encodeWithSignature("decimals()"), abi.encode(uint8(24)));
        vm.expectRevert(bytes("share decimals"));
        check.checkPool(d.pool, d.lens);
        vm.expectRevert(bytes("share decimals"));
        check.checkPoolSeeded(d.pool, d.lens);
    }
}
