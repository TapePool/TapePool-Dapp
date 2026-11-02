// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BscRigReader} from "../../src/feed/BscRigReader.sol";
import {RigReporter} from "../../src/feed/RigReporter.sol";
import {RigFeedReceiver, Origin} from "../../src/feed/RigFeedReceiver.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {IRigVaultBsc, IPodMining, Miner} from "../../src/interfaces/IBsc.sol";

contract CustodyOwner {
    uint256 public mode;
    address public holder = address(0xCE11);

    function set(uint256 m) external {
        mode = m;
    }

    function ownerOf(uint256) external view returns (address) {
        uint256 m = mode;
        if (m == 1) revert();
        if (m == 3) while (true) {}
        assembly {
            if eq(m, 2) { return(0, 31) }
            if eq(m, 4) {
                mstore(0, not(0))
                return(0, 32)
            }
        }
        return m == 5 ? address(0xBAD) : holder;
    }
}

contract CustodyRecords {
    address public processor;
    address public cell = address(0xCE11);

    constructor(address p) {
        processor = p;
    }

    function set(address p, address c) external {
        processor = p;
        cell = c;
    }

    function rigs(uint256 id) external view returns (address, uint256) {
        return (processor, id);
    }

    function cellOf(bytes32) external view returns (address) {
        return cell;
    }

    function minerKey(address p, uint256 id) external pure returns (bytes32) {
        return keccak256(abi.encode(p, id));
    }

    function getMiner(bytes32) external pure returns (Miner memory m) {
        m.status = 1;
        m.verifWeight = 110;
        m.bonus = 10;
    }

    function totalVerifWeight() external pure returns (uint256) {
        return 1_000;
    }

    function pending(bytes32) external pure returns (uint256) {
        return 1;
    }
}

contract FeedEndpointStub {
    function setDelegate(address) external {}
}

contract ReaderHarness {
    function read(CustodyRecords records, uint256 id) external view returns (RigReport memory) {
        return BscRigReader.read(IRigVaultBsc(address(records)), IPodMining(address(records)), id);
    }
}

contract ReceiverHarness is RigFeedReceiver {
    constructor(address ep) RigFeedReceiver(ep, msg.sender, 30102, address(1)) {}

    function deliver(Origin calldata origin, bytes calldata data) external {
        _lzReceive(origin, bytes32(0), data, address(0), data[0:0]);
    }
}

contract RedeployFeedTest is Test {
    CustodyOwner processor;
    CustodyRecords records;
    ReaderHarness reader;
    RigReporter reporter;
    ReceiverHarness receiver;

    function setUp() public {
        vm.warp(1_800_000_000);
        processor = new CustodyOwner();
        records = new CustodyRecords(address(processor));
        reader = new ReaderHarness();
        FeedEndpointStub ep = new FeedEndpointStub();
        reporter = new RigReporter(
            address(ep), address(this), 30274, IRigVaultBsc(address(records)), IPodMining(address(records)), address(1)
        );
        receiver = new ReceiverHarness(address(ep));
        reporter.setPeer(30274, bytes32(uint256(uint160(address(receiver)))));
    }

    function test_RA14_eachFailedCustodyReadRevertsReaderQuoteAndPush() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        for (uint256 mode = 1; mode <= 4; ++mode) {
            processor.set(mode);
            vm.expectRevert(abi.encodeWithSelector(BscRigReader.CustodyUnreadable.selector, 1));
            reader.read(records, 1);
            vm.expectRevert(abi.encodeWithSelector(BscRigReader.CustodyUnreadable.selector, 1));
            reporter.quote(ids);
            vm.expectRevert(abi.encodeWithSelector(BscRigReader.CustodyUnreadable.selector, 1));
            reporter.push(ids);
        }
        records.set(address(0xC0DE1E55), address(0xCE11));
        vm.expectRevert(abi.encodeWithSelector(BscRigReader.CustodyUnreadable.selector, 1));
        reader.read(records, 1);
    }

    function test_RA14_successfulOtherOwnerAndMissingRigOrCellAreImpairment() public {
        assertTrue(reader.read(records, 1).custodied);
        processor.set(5);
        assertFalse(reader.read(records, 1).custodied);
        records.set(address(0), address(0xCE11));
        assertFalse(reader.read(records, 1).custodied);
        records.set(address(processor), address(0));
        processor.set(1); // Zero cell must not attempt the unreadable ownerOf.
        assertFalse(reader.read(records, 1).custodied);
    }

    function test_RA15_futureBoundaryAndMixedBatch() public {
        RigReport[] memory rs = new RigReport[](3);
        rs[0].rigId = 1;
        rs[0].observedAt = uint64(block.timestamp + 60);
        rs[1].rigId = 2;
        rs[1].observedAt = uint64(block.timestamp + 61);
        rs[2].rigId = 3;
        rs[2].observedAt = uint64(block.timestamp);
        receiver.deliver(Origin(30102, bytes32(uint256(1)), 1), abi.encode(rs));
        (, bool first) = receiver.latest(1);
        (, bool second) = receiver.latest(2);
        (, bool third) = receiver.latest(3);
        assertTrue(first && third);
        assertFalse(second);
        rs[0].observedAt += 1;
        receiver.deliver(Origin(30102, bytes32(uint256(1)), 2), abi.encode(rs));
        (RigReport memory kept,) = receiver.latest(1);
        assertEq(kept.observedAt, block.timestamp + 60);
    }
}
