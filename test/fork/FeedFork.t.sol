// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {BscRigReader} from "../../src/feed/BscRigReader.sol";

import {console2} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IOAppCore} from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppCore.sol";
import {OAppReceiver} from "@layerzerolabs/oapp-evm/contracts/oapp/OAppReceiver.sol";
import {Origin as LzOrigin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {Origin} from "../../src/interfaces/IXLayer.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {IPodMining, Miner} from "../../src/interfaces/IBsc.sol";
import {IUlnConfigReader, UlnConfig} from "../../src/interfaces/ILayerZero.sol";
import {BscRigReader} from "../../src/feed/BscRigReader.sol";
import {FeedLock} from "../../src/feed/FeedLock.sol";
import {RigReporter} from "../../src/feed/RigReporter.sol";
import {RigFeedReceiver} from "../../src/feed/RigFeedReceiver.sol";
import {FeedForkBase} from "./FeedForkBase.sol";
import {CheckFeed} from "../../script/feed/CheckFeed.s.sol";

interface IEndpointConfig {
    function getConfig(address oapp, address lib, uint32 eid, uint32 configType) external view returns (bytes memory);
}

/// Production feed on the real endpoints (SPEC-PHASE3 §5, §7): lock rules, the frozen state after
/// lock, a 16-rig delivery against the gas budget and the message-size limit, ordering, and casts.
contract FeedForkTest is FeedForkBase {
    uint256 constant RIG = 5;

    function setUp() public {
        _forks();
        _deploy();
    }

    // ───────────────────────── lock preconditions

    function test_lock_rejects_zero_library() public {
        vm.selectFork(bscFork);
        vm.expectRevert(RigReporter.ZeroAddress.selector);
        reporter.lock(address(0));
    }

    function test_lock_requires_a_peer() public {
        vm.selectFork(bscFork);
        RigReporter fresh = new RigReporter(address(EP), address(this), XLAYER_EID, VAULT, POD, BEM_ADAPTER_BSC);
        address lib = EP.getSendLibrary(BEM_ADAPTER_BSC, XLAYER_EID);
        vm.expectRevert(abi.encodeWithSelector(IOAppCore.NoPeer.selector, XLAYER_EID));
        fresh.lock(lib);
    }

    function test_lock_requires_the_bem_library() public {
        vm.selectFork(bscFork);
        vm.expectRevert(RigReporter.NotBemLibrary.selector);
        reporter.lock(address(0xBEEF));
        vm.selectFork(xFork);
        vm.expectRevert(RigFeedReceiver.NotBemLibrary.selector);
        receiver.lock(address(0xBEEF));
    }

    function test_lock_rejects_the_default_config() public {
        address s = _sendLib();
        vm.expectRevert(FeedLock.ConfigMismatch.selector);
        reporter.lock(s);
        address r = _recvLib();
        vm.expectRevert(FeedLock.ConfigMismatch.selector);
        receiver.lock(r);
    }

    /// Same counts, one different optional DVN: the effective configs differ.
    function test_lock_rejects_one_different_dvn() public {
        address r = _recvLib();
        UlnConfig memory c = _mirror(IUlnConfigReader(r).getUlnConfig(BEM_OFT_XLAYER, BSC_EID));
        uint256 last = c.optionalDVNs.length - 1;
        c.optionalDVNs[last] = address(uint160(c.optionalDVNs[last]) + 1); // still sorted, not BEM's
        _setConfig(address(receiver), r, BSC_EID, c);
        vm.expectRevert(FeedLock.ConfigMismatch.selector);
        receiver.lock(r);
    }

    /// X Layer's default confirmations (20) equal BEM's, so an app config that leaves confirmations
    /// at DEFAULT has the right effective config but would follow a future default change.
    function test_lock_rejects_a_default_field() public {
        address r = _recvLib();
        UlnConfig memory c = _mirror(IUlnConfigReader(r).getUlnConfig(BEM_OFT_XLAYER, BSC_EID));
        c.confirmations = 0;
        _setConfig(address(receiver), r, BSC_EID, c);
        vm.expectRevert(FeedLock.ConfigNotExplicit.selector);
        receiver.lock(r);
    }

    /// A session that pinned the library before `lock` stopped half way: `lock` reverts with the
    /// endpoint's same-value error, the delegate unpins, and `lock` then succeeds.
    function test_lock_after_a_library_was_already_pinned() public {
        _configureBoth();
        address r = _recvLib();
        EP.setReceiveLibrary(address(receiver), BSC_EID, r, 0);
        vm.expectRevert();
        receiver.lock(r);
        EP.setReceiveLibrary(address(receiver), BSC_EID, address(0), 0);
        receiver.lock(r);
        assertTrue(receiver.locked());
    }

    /// If BEM ran with no optional DVNs, our app config carries NIL there and still mirrors it.
    function test_lock_with_nil_for_a_zero_bem_field() public {
        address r = _recvLib();
        UlnConfig memory bem = IUlnConfigReader(r).getUlnConfig(BEM_OFT_XLAYER, BSC_EID);
        bem.confirmations = 0;
        bem.optionalDVNCount = 0;
        bem.optionalDVNThreshold = 0;
        bem.optionalDVNs = new address[](0);
        vm.mockCall(r, abi.encodeCall(IUlnConfigReader.getUlnConfig, (BEM_OFT_XLAYER, BSC_EID)), abi.encode(bem));
        _setConfig(address(receiver), r, BSC_EID, _mirror(bem));
        UlnConfig memory app = IUlnConfigReader(r).getAppUlnConfig(address(receiver), BSC_EID);
        assertEq(app.optionalDVNCount, type(uint8).max);
        assertEq(app.confirmations, type(uint64).max);
        receiver.lock(r);
        assertTrue(receiver.locked());
    }

    function test_set_peer_only_for_its_own_eid() public {
        vm.selectFork(bscFork);
        vm.expectRevert(abi.encodeWithSelector(RigReporter.WrongEid.selector, uint32(30101)));
        reporter.setPeer(30101, _b32(address(1)));
        vm.selectFork(xFork);
        vm.expectRevert(abi.encodeWithSelector(RigFeedReceiver.WrongEid.selector, uint32(30101)));
        receiver.setPeer(30101, _b32(address(1)));
    }

    function test_renounce_is_disabled_before_and_after_lock() public {
        vm.selectFork(bscFork);
        vm.expectRevert(RigReporter.RenounceDisabled.selector);
        reporter.renounceOwnership();
        _configureBoth();
        _lockBoth();
        vm.selectFork(bscFork);
        vm.expectRevert(RigReporter.RenounceDisabled.selector);
        reporter.renounceOwnership();
        vm.selectFork(xFork);
        vm.expectRevert(RigFeedReceiver.RenounceDisabled.selector);
        receiver.renounceOwnership();
    }

    // ───────────────────────── after lock

    function test_lock_freezes_peer_library_config_and_delegate() public {
        _configureBoth();
        _lockBoth();

        vm.selectFork(bscFork);
        assertTrue(reporter.locked());
        assertEq(reporter.owner(), address(0));
        assertEq(EP.delegates(address(reporter)), address(0));
        address s = EP.getSendLibrary(address(reporter), XLAYER_EID);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        reporter.setPeer(XLAYER_EID, _b32(address(0xBAD)));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        reporter.setDelegate(address(this));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        reporter.lock(s);
        UlnConfig memory other = IUlnConfigReader(s).getUlnConfig(address(0xdead), XLAYER_EID);
        vm.expectRevert(); // the former delegate can no longer touch the endpoint config
        _setConfig(address(reporter), s, XLAYER_EID, other);
        vm.expectRevert();
        EP.setSendLibrary(address(reporter), XLAYER_EID, address(0));

        vm.selectFork(xFork);
        assertTrue(receiver.locked());
        assertEq(EP.delegates(address(receiver)), address(0));
        (address r, bool isDefault) = EP.getReceiveLibrary(address(receiver), BSC_EID);
        assertFalse(isDefault, "receive library pinned");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        receiver.setPeer(BSC_EID, _b32(address(0xBAD)));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        receiver.setDelegate(address(this));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        receiver.lock(r);
        vm.expectRevert();
        EP.setReceiveLibrary(address(receiver), BSC_EID, address(0), 0);
        assertEq(r, _recvLib());
    }

    function test_pre_seed_check_script() public {
        _configureBoth();
        vm.selectFork(bscFork);
        CheckFeed check = new CheckFeed();
        vm.expectRevert(bytes("reporter still has an owner"));
        check.checkReporter(address(reporter), address(receiver));
        _lockBoth();
        vm.selectFork(bscFork);
        check = new CheckFeed();
        check.checkReporter(address(reporter), address(receiver));
        vm.expectRevert(bytes("reporter peer"));
        check.checkReporter(address(reporter), address(0xBAD));
        vm.selectFork(xFork);
        check = new CheckFeed();
        check.checkReceiver(address(receiver), address(reporter));
    }

    // ───────────────────────── delivery

    function test_push_16_rigs_deliver_gas_and_message_size() public {
        _configureBoth();
        _lockBoth();
        vm.selectFork(bscFork);
        uint256[] memory ids = _ids(1, 16);
        uint256 fee = reporter.quote(ids);
        vm.txGasPrice(0);
        uint256 b0 = address(this).balance;
        Packet memory p = _push(ids, fee * 2);
        assertEq(b0 - address(this).balance, fee, "excess refunded");
        RigReport[] memory direct = new RigReport[](16);
        for (uint256 i; i < 16; i++) {
            direct[i] = BscRigReader.read(VAULT, POD, ids[i]);
        }

        uint256 budget = reporter.BASE_GAS() + reporter.GAS_PER_RIG() * 16;
        bytes memory exec = IEndpointConfig(address(EP)).getConfig(address(reporter), _sendLib(), XLAYER_EID, 1);
        (uint32 maxMessageSize,) = abi.decode(exec, (uint32, address));
        console2.log("16-rig message bytes", p.message.length);
        console2.log("executor maxMessageSize", maxMessageSize);
        assertLe(p.message.length, maxMessageSize, "fits the executor limit");

        uint256 used = _deliver(p);
        console2.log("lzReceive gas, 16 rigs", used);
        console2.log("options budget", budget);
        assertLe(used * 125 / 100, budget, "25% headroom");

        for (uint256 i; i < 16; i++) {
            (RigReport memory got, bool ok) = receiver.latest(ids[i]);
            assertTrue(ok);
            assertEq(keccak256(abi.encode(got)), keccak256(abi.encode(direct[i])), "stored == direct BSC read");
        }
        (RigReport memory r5,) = receiver.latest(RIG);
        assertEq(r5.verifWeight - r5.bonus, 58, "rig #5 base power");
        assertGt(r5.totalVerifWeight, 1_000_000, "network weight travels with the report");
    }

    function test_older_or_equal_report_never_replaces_newer() public {
        _configureBoth();
        _lockBoth();
        uint256[] memory one = _ids(RIG, RIG);
        vm.selectFork(bscFork);
        Packet memory a = _push(one, reporter.quote(one));
        vm.warp(block.timestamp + 60);
        vm.roll(block.number + 20);
        Packet memory b = _push(one, reporter.quote(one));
        Packet memory c = _push(one, reporter.quote(one)); // same block as b: equal observedAt

        // all three verified first (the endpoint executes a nonce only once every earlier one is
        // verified, SPEC-PHASE3 §5.4), then executed out of order
        _verify(a);
        _verify(b);
        _verify(c);
        _execute(b);
        (RigReport memory got,) = receiver.latest(RIG);
        uint64 newest = got.observedAt;
        vm.expectEmit(address(receiver));
        emit RigFeedReceiver.Reported(RIG, newest - 60, false);
        _execute(a);
        vm.expectEmit(address(receiver));
        emit RigFeedReceiver.Reported(RIG, newest, false);
        _execute(c);
        (got,) = receiver.latest(RIG);
        assertEq(got.observedAt, newest);
    }

    function test_only_the_endpoint_and_the_peer_are_accepted() public {
        _configureBoth();
        _lockBoth();
        vm.selectFork(xFork);
        RigReport[] memory fake = new RigReport[](1);
        fake[0].rigId = uint64(RIG);
        fake[0].observedAt = uint64(block.timestamp);
        fake[0].verifWeight = 1_000_000;
        vm.expectRevert(abi.encodeWithSelector(OAppReceiver.OnlyEndpoint.selector, address(this)));
        receiver.lzReceive(LzOrigin(BSC_EID, _b32(address(reporter)), 1), bytes32(0), abi.encode(fake), address(0), "");

        (address lib,) = EP.getReceiveLibrary(address(receiver), BSC_EID);
        vm.prank(lib);
        vm.expectRevert();
        EP.verify(Origin(BSC_EID, _b32(address(0xBAD)), 1), address(receiver), keccak256("x"));
    }

    function test_bad_batches_and_checked_casts_revert_the_push() public {
        _configureBoth();
        _lockBoth();
        vm.selectFork(bscFork);
        vm.expectRevert(RigReporter.BadBatch.selector);
        reporter.push{value: 1 ether}(new uint256[](0));
        vm.expectRevert(RigReporter.BadBatch.selector);
        reporter.push{value: 1 ether}(_ids(1, 17));

        uint256[] memory huge = new uint256[](1);
        huge[0] = uint256(type(uint64).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 64, huge[0]));
        reporter.push{value: 1 ether}(huge);

        (address c, uint256 cid) = VAULT.rigs(RIG);
        bytes32 key = POD.minerKey(c, cid);
        Miner memory m = POD.getMiner(key);
        m.verifWeight = uint128(type(uint64).max) + 1;
        vm.mockCall(address(POD), abi.encodeCall(IPodMining.getMiner, (key)), abi.encode(m));
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 64, m.verifWeight));
        reporter.push{value: 1 ether}(_ids(RIG, RIG));
    }

    /// A failed custody read rejects the push instead of manufacturing impairment evidence.
    function test_broken_processor_reverts_quote_and_push() public {
        _configureBoth();
        _lockBoth();
        vm.selectFork(bscFork);
        (address c, uint256 cid) = VAULT.rigs(RIG);
        uint256[] memory one = _ids(RIG, RIG);
        bytes memory ownerOfCall = abi.encodeWithSignature("ownerOf(uint256)", cid);

        vm.mockCallRevert(c, ownerOfCall, "upgraded");
        vm.expectRevert(abi.encodeWithSelector(BscRigReader.CustodyUnreadable.selector, RIG));
        reporter.quote(one);
        vm.expectRevert(abi.encodeWithSelector(BscRigReader.CustodyUnreadable.selector, RIG));
        reporter.push(one);

        vm.selectFork(bscFork);
        vm.clearMockedCalls();
        vm.mockCall(c, ownerOfCall, hex"01");
        vm.warp(block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(BscRigReader.CustodyUnreadable.selector, RIG));
        reporter.quote(one);

        vm.selectFork(bscFork);
        vm.clearMockedCalls();
        vm.etch(c, "");
        vm.warp(block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(BscRigReader.CustodyUnreadable.selector, RIG));
        reporter.quote(one);
    }

    function test_rescued_rig_is_reported_impaired() public {
        _configureBoth();
        _lockBoth();
        vm.selectFork(bscFork);
        vm.prank(TAPEOUT_SAFE);
        VAULT.rescue(RIG, address(0xBEEF));
        uint256[] memory one = _ids(RIG, RIG);
        _deliver(_push(one, reporter.quote(one)));
        (RigReport memory r, bool ok) = receiver.latest(RIG);
        assertTrue(ok);
        assertFalse(r.custodied);
        assertEq(r.circuits, address(0));
        assertEq(r.verifWeight, 0);
    }
}
