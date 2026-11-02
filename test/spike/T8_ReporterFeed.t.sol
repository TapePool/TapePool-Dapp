// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FeedBase} from "./FeedBase.sol";
import {console2} from "forge-std/console2.sol";
import {Vm} from "forge-std/Vm.sol";
import {Origin} from "../../src/interfaces/IXLayer.sol";
import {RigReport, RigReportCheck} from "../../src/spike/feed/RigReport.sol";
import {RigReporter} from "../../src/spike/feed/RigReporter.sol";
import {RigReportReceiver} from "../../src/spike/feed/RigReportReceiver.sol";
import {FeedGate} from "../../src/spike/feed/FeedGate.sol";
import {ILzEndpointSend, IUlnConfigReader, SetConfigParam, UlnConfig} from "../../src/interfaces/ILayerZero.sol";

/// T8 (DERISK Q1, option A): a reporter on BSC reads the rig on-chain and pushes it over LayerZero;
///    the receiver on X Layer keeps the newest report and the borrow path checks it.
///    Everything runs as real code on two forks except the DVN step: delivery is simulated by
///    pranking the receive library's `verify`, as in T2. Real DVN delivery needs one real message.
contract T8_ReporterFeedTest is FeedBase {
    ILzEndpointSend constant EP = ILzEndpointSend(ENDPOINT);
    address constant BEM_ADAPTER_BSC = 0xa84B8D3893De6e9922f2B29bE1e1b115845F5E72;
    address constant BEM_OFT_XLAYER = 0x60e62Efa9405d6873C5deaBD4E6CC91c25363952;
    address constant DEAD_DVN = 0x000000000000000000000000000000000000dEaD;
    uint32 constant ULN_CONFIG = 2;
    bytes32 constant PACKET_SENT = keccak256("PacketSent(bytes,bytes,address)");

    RigReporter reporter; // on BSC
    RigReportReceiver receiver; // on X Layer
    FeedGate gate; // on X Layer

    struct Packet {
        uint64 nonce;
        uint32 srcEid;
        bytes32 sender;
        uint32 dstEid;
        bytes32 receiver;
        bytes32 guid;
        bytes message;
    }

    function setUp() public {
        _forks();
        vm.selectFork(xFork);
        receiver = new RigReportReceiver(EP, BSC_EID, address(this));
        gate = new FeedGate(receiver, VOUCHER);

        vm.selectFork(bscFork);
        reporter = new RigReporter(EP, VAULT, POD, XLAYER_EID, address(this));
        reporter.setPeer(_b32(address(receiver)));
        vm.deal(address(this), 1 ether);

        vm.selectFork(xFork);
        receiver.setPeer(_b32(address(reporter)));
    }

    // ───────────────────────── config

    /// B13 on a fork: with LayerZero's default config the pathway uses the dead DVN, so a new
    /// OApp cannot even get a fee quote, let alone send.
    function test_T8_default_config_uses_dead_dvn_and_cannot_send() public {
        vm.selectFork(bscFork);
        address lib = EP.getSendLibrary(address(reporter), XLAYER_EID);
        UlnConfig memory c = IUlnConfigReader(lib).getUlnConfig(address(reporter), XLAYER_EID);
        assertEq(c.requiredDVNs.length, 1);
        assertEq(c.requiredDVNs[0], DEAD_DVN);
        vm.expectRevert();
        reporter.quote(_ids(RIG));
    }

    /// Mirror the BEM bridge's own DVN set (it delivers on this pathway every day) on both sides.
    function test_T8_mirrored_dvn_config_on_both_chains() public {
        _configure();
        vm.selectFork(bscFork);
        address sendLib = EP.getSendLibrary(address(reporter), XLAYER_EID);
        UlnConfig memory s = IUlnConfigReader(sendLib).getUlnConfig(address(reporter), XLAYER_EID);
        assertEq(s.requiredDVNCount, 2, "Nethermind + LayerZero Labs");
        assertEq(s.optionalDVNThreshold, 1, "1 of Horizen / Canary");
        vm.selectFork(xFork);
        (address recvLib,) = EP.getReceiveLibrary(address(receiver), BSC_EID);
        UlnConfig memory r = IUlnConfigReader(recvLib).getUlnConfig(address(receiver), BSC_EID);
        assertEq(r.requiredDVNs[0], 0x9C061c9A4782294eeF65ef28Cb88233A987F4bdD, "LayerZero Labs on X Layer");
        assertEq(r.optionalDVNThreshold, 2, "2 of Canary / Nethermind / Horizen");
    }

    function test_T8_fee_quote() public {
        _configure();
        vm.selectFork(bscFork);
        uint256 one = reporter.quote(_ids(RIG));
        uint256[] memory all = new uint256[](N_RIGS);
        for (uint256 i; i < N_RIGS; i++) {
            all[i] = i + 1;
        }
        uint256 sixteen = reporter.quote(all);
        console2.log("LayerZero fee, 1 rig (wei BNB)", one);
        console2.log("LayerZero fee, 16 rigs (wei BNB)", sixteen);
        console2.log("harvest quote, 1 rig (wei BNB)", VAULT.quoteHarvest(1));
        assertGt(one, 0);
        assertLt(one, 0.01 ether, "below 0.01 BNB");
    }

    // ───────────────────────── end to end

    /// The production flow: configure, lock, then push and deliver.
    function test_T8_push_deliver_check() public {
        _configure();
        _lock();
        vm.selectFork(bscFork);
        uint256 fee = reporter.quote(_ids(RIG));
        uint256 balBefore = address(this).balance;
        uint256 g = gasleft();
        Packet memory p = _push(_ids(RIG), fee * 2);
        console2.log("gas: push on BSC (read + LayerZero send)", g - gasleft());
        assertEq(balBefore - address(this).balance, fee, "overpayment refunded");
        assertEq(p.srcEid, BSC_EID);
        assertEq(p.dstEid, XLAYER_EID);
        assertEq(p.sender, _b32(address(reporter)));
        assertEq(p.receiver, _b32(address(receiver)));

        RigReport memory sent = abi.decode(p.message, (RigReport[]))[0];
        _arriveOnXLayer(sent, 35);
        uint256 used = _deliver(p);
        console2.log("gas: lzReceive on X Layer, 1 rig", used);
        assertEq(gate.check(RIG, ""), 58, "base power, bonus excluded");
    }

    function test_T8_lzReceive_gas_fits_options_for_16_rigs() public {
        _configure();
        vm.selectFork(bscFork);
        uint256[] memory all = new uint256[](N_RIGS);
        for (uint256 i; i < N_RIGS; i++) {
            all[i] = i + 1;
        }
        uint256 budget = reporter.BASE_GAS() + reporter.GAS_PER_RIG() * N_RIGS;
        Packet memory p = _push(all, reporter.quote(all));
        _arriveOnXLayer(abi.decode(p.message, (RigReport[]))[0], 35);
        uint256 used = _deliver(p);
        console2.log("gas: lzReceive on X Layer, 16 rigs", used);
        console2.log("gas budget in options", budget);
        assertLt(used, budget);
        for (uint256 id = 1; id <= N_RIGS; id++) {
            assertEq(gate.check(id, ""), _snapshotBase(id));
        }
    }

    function test_T8_stale_report_denied() public {
        _configure();
        Packet memory p = _pushOne(RIG);
        _arriveOnXLayer(abi.decode(p.message, (RigReport[]))[0], 35);
        _deliver(p);
        vm.warp(block.timestamp + RigReportCheck.MAX_AGE);
        vm.expectRevert(RigReportCheck.Stale.selector);
        gate.check(RIG, "");
    }

    function test_T8_no_report_denied() public {
        vm.selectFork(xFork);
        vm.expectRevert(RigReportReceiver.NoReport.selector);
        gate.check(RIG, "");
    }

    function test_T8_older_report_never_replaces_newer() public {
        _configure();
        Packet memory older = _pushOne(RIG);
        vm.selectFork(bscFork);
        vm.warp(block.timestamp + 120);
        Packet memory newer = _pushOne(RIG);
        RigReport memory n = abi.decode(newer.message, (RigReport[]))[0];
        _arriveOnXLayer(n, 35);
        // both verified; the endpoint lets the executor run them in any order
        _verify(older);
        _deliver(newer);
        _execute(older); // lands late, out of order
        assertEq(receiver.latest(RIG).observedAt, n.observedAt, "kept the newer report");
    }

    function test_T8_rescued_rig_denied() public {
        _configure();
        vm.selectFork(bscFork);
        _rescueOnBsc(RIG);
        Packet memory p = _pushOne(RIG);
        _arriveOnXLayer(abi.decode(p.message, (RigReport[]))[0], 35);
        _deliver(p);
        vm.expectRevert(RigReportCheck.Impaired.selector);
        gate.check(RIG, "");
    }

    // ───────────────────────── forgery

    function test_T8_direct_lzReceive_denied() public {
        vm.selectFork(xFork);
        RigReport[] memory fake = new RigReport[](1);
        vm.expectRevert(RigReportReceiver.NotEndpoint.selector);
        receiver.lzReceive(Origin(BSC_EID, _b32(address(reporter)), 1), bytes32(0), abi.encode(fake), address(0), "");
    }

    function test_T8_message_from_another_sender_never_verifies() public {
        vm.selectFork(xFork);
        (address lib,) = EP.getReceiveLibrary(address(receiver), BSC_EID);
        vm.prank(lib);
        vm.expectRevert(); // path not initializable: the receiver only trusts its peer
        EP.verify(Origin(BSC_EID, _b32(address(0xBAD)), 1), address(receiver), keccak256("x"));
    }

    function test_T8_message_from_another_chain_never_verifies() public {
        vm.selectFork(xFork);
        (address lib,) = EP.getReceiveLibrary(address(receiver), 30101);
        vm.prank(lib);
        vm.expectRevert();
        EP.verify(Origin(30101, _b32(address(reporter)), 1), address(receiver), keccak256("x"));
    }

    // ───────────────────────── trust setup

    /// The honest counterpart of T7's leaked-key test: until `lock`, the owner (or whoever holds
    /// its key) can repoint the peer to a contract it controls and get any report accepted.
    function test_T8_unlocked_owner_can_forge_power() public {
        vm.selectFork(xFork);
        vm.warp(block.timestamp + 1 hours);
        address attacker = address(0xBAD);
        receiver.setPeer(_b32(attacker));
        (address circuits,, uint256 circuitId,) = VOUCHER.rigs(RIG);
        RigReport[] memory fake = new RigReport[](1);
        fake[0].rigId = uint64(RIG);
        fake[0].circuits = circuits;
        fake[0].circuitId = uint64(circuitId);
        fake[0].status = 1;
        fake[0].custodied = true;
        fake[0].verifWeight = 1_000_000;
        fake[0].observedAt = uint64(block.timestamp);
        Packet memory p = Packet(
            1, BSC_EID, _b32(attacker), XLAYER_EID, _b32(address(receiver)), keccak256("fake"), abi.encode(fake)
        );
        _deliver(p);
        assertEq(gate.check(RIG, ""), 1_000_000, "before lock, the owner key is a trust point");
    }

    /// After `lock` nobody can change the peer, the DVN config or the library on either chain.
    function test_T8_lock_freezes_peer_config_and_library() public {
        _configure();
        _lock();
        SetConfigParam[] memory ps = new SetConfigParam[](0);

        vm.selectFork(bscFork);
        address sendLib = EP.getSendLibrary(address(reporter), XLAYER_EID);
        assertEq(EP.delegates(address(reporter)), address(0), "no delegate on BSC");
        vm.expectRevert(RigReporter.IsLocked.selector);
        reporter.setPeer(_b32(address(0xBAD)));
        vm.expectRevert();
        EP.setConfig(address(reporter), sendLib, ps);
        vm.expectRevert();
        EP.setSendLibrary(address(reporter), XLAYER_EID, address(0x1234));
        UlnConfig memory s = IUlnConfigReader(sendLib).getUlnConfig(address(reporter), XLAYER_EID);
        assertEq(s.requiredDVNCount, 2, "pinned library keeps our DVN config");

        vm.selectFork(xFork);
        (address recvLib, bool isDefault) = EP.getReceiveLibrary(address(receiver), BSC_EID);
        assertFalse(isDefault, "receive library pinned, not following the default");
        assertEq(EP.delegates(address(receiver)), address(0), "no delegate on X Layer");
        vm.expectRevert(RigReportReceiver.IsLocked.selector);
        receiver.setPeer(_b32(address(0xBAD)));
        vm.expectRevert();
        EP.setConfig(address(receiver), recvLib, ps);
        vm.expectRevert();
        EP.setReceiveLibrary(address(receiver), BSC_EID, address(0x1234), 0);
    }

    // ───────────────────────── helpers

    receive() external payable {} // LayerZero refunds overpaid fees to the caller

    function _lock() internal {
        vm.selectFork(bscFork);
        reporter.lock(EP.getSendLibrary(address(reporter), XLAYER_EID));
        vm.selectFork(xFork);
        (address recvLib,) = EP.getReceiveLibrary(address(receiver), BSC_EID);
        receiver.lock(recvLib);
    }

    function _configure() internal {
        vm.selectFork(bscFork);
        address sendLib = EP.getSendLibrary(address(reporter), XLAYER_EID);
        UlnConfig memory s = IUlnConfigReader(sendLib).getUlnConfig(BEM_ADAPTER_BSC, XLAYER_EID);
        SetConfigParam[] memory ps = new SetConfigParam[](1);
        ps[0] = SetConfigParam(XLAYER_EID, ULN_CONFIG, abi.encode(s));
        EP.setConfig(address(reporter), sendLib, ps);

        vm.selectFork(xFork);
        (address recvLib,) = EP.getReceiveLibrary(address(receiver), BSC_EID);
        UlnConfig memory r = IUlnConfigReader(recvLib).getUlnConfig(BEM_OFT_XLAYER, BSC_EID);
        ps[0] = SetConfigParam(BSC_EID, ULN_CONFIG, abi.encode(r));
        EP.setConfig(address(receiver), recvLib, ps);
    }

    function _pushOne(uint256 id) internal returns (Packet memory) {
        vm.selectFork(bscFork);
        return _push(_ids(id), reporter.quote(_ids(id)));
    }

    /// Send on the BSC fork and capture the packet the endpoint emits for the DVNs.
    function _push(uint256[] memory ids, uint256 value) internal returns (Packet memory p) {
        vm.selectFork(bscFork);
        vm.recordLogs();
        reporter.push{value: value}(ids);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes memory packet;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == ENDPOINT && logs[i].topics[0] == PACKET_SENT) {
                (packet,,) = abi.decode(logs[i].data, (bytes, bytes, address));
            }
        }
        require(packet.length > 113, "no PacketSent");
        // PacketV1: version(1) nonce(8) srcEid(4) sender(32) dstEid(4) receiver(32) guid(32) message
        p.nonce = uint64(bytes8(_slice(packet, 1, 8)));
        p.srcEid = uint32(bytes4(_slice(packet, 9, 4)));
        p.sender = bytes32(_slice(packet, 13, 32));
        p.dstEid = uint32(bytes4(_slice(packet, 45, 4)));
        p.receiver = bytes32(_slice(packet, 49, 32));
        p.guid = bytes32(_slice(packet, 81, 32));
        p.message = _slice(packet, 113, packet.length - 113);
    }

    /// Land a packet on the X Layer fork: the receive library verifies (simulated DVN step), then
    /// anyone executes `lzReceive` through the real endpoint.
    function _deliver(Packet memory p) internal returns (uint256 gasUsed) {
        _verify(p);
        gasUsed = _execute(p);
    }

    function _verify(Packet memory p) internal {
        vm.selectFork(xFork);
        (address lib,) = EP.getReceiveLibrary(address(receiver), p.srcEid);
        vm.prank(lib);
        EP.verify(
            Origin(p.srcEid, p.sender, p.nonce), address(receiver), keccak256(abi.encodePacked(p.guid, p.message))
        );
    }

    function _execute(Packet memory p) internal returns (uint256 gasUsed) {
        vm.selectFork(xFork);
        uint256 g = gasleft();
        vm.prank(address(0xE7EC));
        EP.lzReceive(Origin(p.srcEid, p.sender, p.nonce), address(receiver), p.guid, p.message, "");
        gasUsed = g - gasleft();
    }

    function _ids(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
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
}
