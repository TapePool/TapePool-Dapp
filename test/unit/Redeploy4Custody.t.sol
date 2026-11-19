// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {
    MessagingParams,
    MessagingFee,
    MessagingReceipt
} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {BscRigReader} from "../../src/feed/BscRigReader.sol";
import {RigReporter} from "../../src/feed/RigReporter.sol";
import {IRigVaultBsc, IPodMining, IERC721OwnerOf, Miner} from "../../src/interfaces/IBsc.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {BscRigReaderHarness} from "../mocks/BscRigReaderHarness.sol";

contract ZeroCustodyOwner {
    mapping(uint256 => address) public ownerOf;

    function set(uint256 id, address holder) external {
        ownerOf[id] = holder;
    }
}

contract ZeroCustodyRecords {
    address public immutable processor;
    mapping(bytes32 => address) public cellOf;

    constructor(address p) {
        processor = p;
    }

    function setCell(uint256 id, address cell) external {
        cellOf[minerKey(processor, id)] = cell;
    }

    function rigs(uint256 id) external view returns (address, uint256) {
        return (processor, id);
    }

    function minerKey(address p, uint256 id) public pure returns (bytes32) {
        return keccak256(abi.encode(p, id));
    }

    function getMiner(bytes32) external view returns (Miner memory m) {
        m.status = 1;
        m.since = uint64(block.timestamp - 30 days);
        m.verifWeight = 110;
        m.bstar = 100;
        m.mult = 1;
        m.bonus = 10;
    }

    function totalVerifWeight() external pure returns (uint256) {
        return 1_000;
    }

    function pending(bytes32) external pure returns (uint256) {
        return 1;
    }
}

/// Captures messages sent by the real reporter, so a separate healthy batch must actually send.
contract CustodyEndpoint {
    uint256 public constant FEE = 1e12;
    uint64 public sends;
    bytes public message;

    function setDelegate(address) external {}

    function quote(MessagingParams calldata, address) external pure returns (MessagingFee memory) {
        return MessagingFee(FEE, 0);
    }

    function send(MessagingParams calldata params, address) external payable returns (MessagingReceipt memory) {
        require(msg.value == FEE, "exact fee");
        message = params.message;
        ++sends;
        return MessagingReceipt(bytes32(uint256(sends)), sends, MessagingFee(msg.value, 0));
    }
}

/// R4-02: zero owner is unreadable; a valid other owner or zero cell is known not custodied.
contract Redeploy4CustodyTest is Test {
    address constant CELL = address(0xCE11);
    ZeroCustodyOwner processor;
    ZeroCustodyRecords records;
    BscRigReaderHarness reader;
    CustodyEndpoint endpoint;
    RigReporter reporter;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.deal(address(this), 1 ether);
        processor = new ZeroCustodyOwner();
        processor.set(1, CELL);
        processor.set(3, address(0xBAD)); // a valid third-party holder
        records = new ZeroCustodyRecords(address(processor));
        for (uint256 id = 1; id <= 3; ++id) {
            records.setCell(id, CELL);
        }
        reader = new BscRigReaderHarness();
        endpoint = new CustodyEndpoint();
        reporter = new RigReporter(
            address(endpoint),
            address(this),
            30274,
            IRigVaultBsc(address(records)),
            IPodMining(address(records)),
            address(1)
        );
        reporter.setPeer(30274, bytes32(uint256(1)));
    }

    function _ids(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function _push(uint256[] memory ids) internal {
        uint256 fee = reporter.quote(ids);
        assertEq(fee, endpoint.FEE());
        assertEq(reporter.push{value: fee}(ids), bytes32(uint256(1)));
        assertEq(endpoint.sends(), 1);
        assertEq(address(endpoint).balance, fee);
    }

    function test_R4_02_zeroOwnerRevertsReader() public {
        vm.expectRevert(abi.encodeWithSelector(BscRigReader.CustodyUnreadable.selector, 2));
        reader.read(address(records), address(records), 2);
    }

    function test_R4_02_zeroOwnerRevertsQuoteAndPush() public {
        uint256[] memory ids = _ids(2);
        uint256 fee = endpoint.FEE();
        vm.expectRevert(abi.encodeWithSelector(BscRigReader.CustodyUnreadable.selector, 2));
        reporter.quote(ids);
        vm.expectRevert(abi.encodeWithSelector(BscRigReader.CustodyUnreadable.selector, 2));
        reporter.push{value: fee}(ids);
        assertEq(endpoint.sends(), 0);
        assertEq(address(endpoint).balance, 0);
    }

    function test_R4_02_mixedBatchRevertsButOtherRigsPushSeparately() public {
        uint256[] memory ids = new uint256[](3);
        ids[0] = 1;
        ids[1] = 2;
        ids[2] = 3;
        uint256 fee = endpoint.FEE();
        vm.expectRevert(abi.encodeWithSelector(BscRigReader.CustodyUnreadable.selector, 2));
        reporter.quote(ids);
        vm.expectRevert(abi.encodeWithSelector(BscRigReader.CustodyUnreadable.selector, 2));
        reporter.push{value: fee}(ids);
        assertEq(endpoint.sends(), 0);
        assertEq(endpoint.message().length, 0);
        assertEq(address(endpoint).balance, 0);

        ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 3;
        _push(ids);
        RigReport[] memory rs = abi.decode(endpoint.message(), (RigReport[]));
        assertEq(rs.length, 2);
        assertEq(rs[0].rigId, 1);
        assertTrue(rs[0].custodied);
        assertEq(rs[1].rigId, 3);
        assertFalse(rs[1].custodied);
    }

    function test_R4_02_thirdPartyOwnerIsNotCustodiedAndStillPushes() public {
        RigReport memory r = reader.read(address(records), address(records), 3);
        assertFalse(r.custodied);
        assertEq(r.verifWeight, 110);
        assertEq(r.bonus, 10);
        _push(_ids(3));
        RigReport[] memory rs = abi.decode(endpoint.message(), (RigReport[]));
        assertEq(rs.length, 1);
        assertEq(abi.encode(rs[0]), abi.encode(r));
    }

    function test_R4_02_zeroCellSkipsOwnerReadAndStillPushes() public {
        records.setCell(2, address(0));
        vm.expectCall(address(processor), abi.encodeCall(IERC721OwnerOf.ownerOf, (2)), 0);
        RigReport memory r = reader.read(address(records), address(records), 2);
        assertFalse(r.custodied);
        assertEq(r.circuits, address(processor));
        assertEq(r.circuitId, 2);
        assertEq(r.status, 1);
        assertEq(r.verifWeight, 110);
        assertEq(r.bonus, 10);
        _push(_ids(2));
        RigReport[] memory rs = abi.decode(endpoint.message(), (RigReport[]));
        assertEq(rs.length, 1);
        assertEq(abi.encode(rs[0]), abi.encode(r));
    }
}
