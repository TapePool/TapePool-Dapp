// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {Origin} from "../../src/interfaces/IXLayer.sol";
import {IRigVaultBsc, IPodMining} from "../../src/interfaces/IBsc.sol";
import {ILzEndpointSend, IUlnConfigReader, SetConfigParam, UlnConfig} from "../../src/interfaces/ILayerZero.sol";
import {RigReporter} from "../../src/feed/RigReporter.sol";
import {RigFeedReceiver} from "../../src/feed/RigFeedReceiver.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {FeedConfig} from "../../script/feed/FeedConfig.sol";

/// Two forks for the production feed (SPEC-PHASE3 §5): BSC for the reporter, X Layer for the
/// receiver, both on the REAL LayerZero endpoints and libraries. DVN verification is simulated by
/// pranking the receive library, as in spike T8. LOCAL FORKS ONLY; skipped without `BSC_RPC`.
abstract contract FeedForkBase is Test {
    IRigVaultBsc constant VAULT = IRigVaultBsc(0x48D43345656f0f9510dC3c06CBa99dFf597617C2);
    IPodMining constant POD = IPodMining(0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46);
    address constant TAPEOUT_SAFE = 0xB3D85b42A045c1A88D800CAD0F55d2566a4D3138;
    address constant BEM_ADAPTER_BSC = 0xa84B8D3893De6e9922f2B29bE1e1b115845F5E72;
    address constant BEM_OFT_XLAYER = 0x60e62Efa9405d6873C5deaBD4E6CC91c25363952;
    ILzEndpointSend constant EP = ILzEndpointSend(0x1a44076050125825900e736c501f859c50fE728c);
    uint32 constant BSC_EID = 30102;
    uint32 constant XLAYER_EID = 30274;
    uint32 constant ULN_CONFIG = 2;
    uint256 constant BSC_BLOCK = 128_369_002; // snapshot-2026-10-18
    uint256 constant XLAYER_BLOCK = 73_558_380;
    bytes32 constant PACKET_SENT = keccak256("PacketSent(bytes,bytes,address)");

    uint256 internal bscFork;
    uint256 internal xFork;
    RigReporter reporter;
    RigFeedReceiver receiver;

    struct Packet {
        uint64 nonce;
        uint32 srcEid;
        bytes32 sender;
        bytes32 guid;
        bytes message;
    }

    function _forks() internal {
        string memory bscRpc = vm.envOr("BSC_RPC", string(""));
        if (bytes(bscRpc).length == 0) vm.skip(true);
        bscFork = vm.createFork(bscRpc, BSC_BLOCK);
        xFork = vm.createFork("xlayer", XLAYER_BLOCK);
    }

    /// Deploy both contracts with this test as owner and delegate, and point them at each other.
    function _deploy() internal {
        vm.selectFork(xFork);
        receiver = new RigFeedReceiver(address(EP), address(this), BSC_EID, BEM_OFT_XLAYER);
        vm.selectFork(bscFork);
        reporter = new RigReporter(address(EP), address(this), XLAYER_EID, VAULT, POD, BEM_ADAPTER_BSC);
        reporter.setPeer(XLAYER_EID, _b32(address(receiver)));
        vm.deal(address(this), 1 ether);
        vm.selectFork(xFork);
        receiver.setPeer(BSC_EID, _b32(address(reporter)));
    }

    function _sendLib() internal returns (address) {
        vm.selectFork(bscFork);
        return EP.getSendLibrary(BEM_ADAPTER_BSC, XLAYER_EID);
    }

    function _recvLib() internal returns (address lib) {
        vm.selectFork(xFork);
        (lib,) = EP.getReceiveLibrary(BEM_OFT_XLAYER, BSC_EID);
    }

    /// The deploy script's config step: copy the BEM bridge's effective config, NIL for zero fields.
    function _mirror(UlnConfig memory c) internal pure returns (UlnConfig memory) {
        return FeedConfig.nil(c); // the same translation the feed session script uses
    }

    function _setConfig(address oapp, address lib, uint32 eid, UlnConfig memory c) internal {
        SetConfigParam[] memory ps = new SetConfigParam[](1);
        ps[0] = SetConfigParam(eid, ULN_CONFIG, abi.encode(c));
        EP.setConfig(oapp, lib, ps);
    }

    function _configureBoth() internal {
        address s = _sendLib();
        _setConfig(
            address(reporter), s, XLAYER_EID, _mirror(IUlnConfigReader(s).getUlnConfig(BEM_ADAPTER_BSC, XLAYER_EID))
        );
        address r = _recvLib();
        _setConfig(address(receiver), r, BSC_EID, _mirror(IUlnConfigReader(r).getUlnConfig(BEM_OFT_XLAYER, BSC_EID)));
    }

    function _lockBoth() internal {
        address s = _sendLib();
        reporter.lock(s);
        address r = _recvLib();
        receiver.lock(r);
    }

    /// Push on the BSC fork and capture the packet the endpoint emits for the DVNs.
    function _push(uint256[] memory ids, uint256 value) internal returns (Packet memory p) {
        vm.selectFork(bscFork);
        vm.recordLogs();
        reporter.push{value: value}(ids);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes memory packet;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(EP) && logs[i].topics[0] == PACKET_SENT) {
                (packet,,) = abi.decode(logs[i].data, (bytes, bytes, address));
            }
        }
        require(packet.length > 113, "no PacketSent");
        // PacketV1: version(1) nonce(8) srcEid(4) sender(32) dstEid(4) receiver(32) guid(32) message
        p.nonce = uint64(bytes8(_slice(packet, 1, 8)));
        p.srcEid = uint32(bytes4(_slice(packet, 9, 4)));
        p.sender = bytes32(_slice(packet, 13, 32));
        p.guid = bytes32(_slice(packet, 81, 32));
        p.message = _slice(packet, 113, packet.length - 113);
    }

    function _verify(Packet memory p) internal {
        vm.selectFork(xFork);
        (address lib,) = EP.getReceiveLibrary(address(receiver), p.srcEid);
        vm.prank(lib);
        EP.verify(_origin(p), address(receiver), keccak256(abi.encodePacked(p.guid, p.message)));
    }

    function _execute(Packet memory p) internal returns (uint256 gasUsed) {
        vm.selectFork(xFork);
        RigReport[] memory reports = abi.decode(p.message, (RigReport[]));
        uint256 arrival = block.timestamp;
        for (uint256 i; i < reports.length; ++i) {
            if (uint256(reports[i].observedAt) + 30 > arrival) arrival = uint256(reports[i].observedAt) + 30;
        }
        vm.warp(arrival);
        uint256 g = gasleft();
        vm.prank(address(0xE7EC));
        EP.lzReceive(_origin(p), address(receiver), p.guid, p.message, "");
        gasUsed = g - gasleft();
    }

    function _deliver(Packet memory p) internal returns (uint256) {
        _verify(p);
        return _execute(p);
    }

    function _origin(Packet memory p) internal pure returns (Origin memory) {
        return Origin(p.srcEid, p.sender, p.nonce);
    }

    function _ids(uint256 from, uint256 to) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](to - from + 1);
        for (uint256 i; i < ids.length; i++) {
            ids[i] = from + i;
        }
    }

    function _b32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _slice(bytes memory b, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; i++) {
            out[i] = b[start + i];
        }
    }

    receive() external payable {} // LayerZero refunds overpaid fees to the caller
}
