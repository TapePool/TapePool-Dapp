// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ILzEndpointSend} from "../../src/interfaces/ILayerZero.sol";
import {RigReporter} from "../../src/feed/RigReporter.sol";
import {RigFeedReceiver} from "../../src/feed/RigFeedReceiver.sol";
import {FeedLock} from "../../src/feed/FeedLock.sol";
import {Addresses as A} from "../Addresses.sol";

interface IDefaultSendLibrary {
    function isDefaultSendLibrary(address sender, uint32 eid) external view returns (bool);
}

/// Read-only pre-seed check of the feed (SPEC-PHASE3 §5.6). Run on both chains before any pool is
/// seeded; it reverts on the first problem and prints PASS otherwise. It compares our pinned library
/// with the BEM bridge's CURRENT one: right for the pre-seed run, but after a future library migration
/// of the bridge it fails although our feed is unchanged (pinned by design).
///   BSC:      --rpc-url bsc    --sig "checkReporter(address,address)" <reporter> <receiver>
///   X Layer:  --rpc-url xlayer --sig "checkReceiver(address,address)" <receiver> <reporter>
contract CheckFeed is Script {
    ILzEndpointSend constant EP = ILzEndpointSend(A.ENDPOINT);

    function checkReporter(address reporter, address receiver) external view {
        RigReporter r = RigReporter(reporter);
        require(r.owner() == address(0), "reporter still has an owner");
        require(EP.delegates(reporter) == address(0), "reporter still has a delegate");
        require(r.peers(A.XLAYER_EID) == bytes32(uint256(uint160(receiver))), "reporter peer");
        require(
            !IDefaultSendLibrary(address(EP)).isDefaultSendLibrary(reporter, A.XLAYER_EID), "send library not pinned"
        );
        address lib = EP.getSendLibrary(reporter, A.XLAYER_EID);
        require(lib == EP.getSendLibrary(A.BEM_ADAPTER_BSC, A.XLAYER_EID), "not the BEM bridge's send library");
        FeedLock.requireMirrored(lib, reporter, A.BEM_ADAPTER_BSC, A.XLAYER_EID);
        require(r.locked(), "locked()");
        console2.log("PASS: reporter locked, peer, library and DVN config mirror the BEM bridge", reporter);
    }

    function checkReceiver(address receiver, address reporter) external view {
        RigFeedReceiver r = RigFeedReceiver(receiver);
        require(r.owner() == address(0), "receiver still has an owner");
        require(EP.delegates(receiver) == address(0), "receiver still has a delegate");
        require(r.peers(A.BSC_EID) == bytes32(uint256(uint160(reporter))), "receiver peer");
        (address lib, bool isDefault) = EP.getReceiveLibrary(receiver, A.BSC_EID);
        require(!isDefault, "receive library not pinned");
        (address bemLib,) = EP.getReceiveLibrary(A.BEM_OFT_XLAYER, A.BSC_EID);
        require(lib == bemLib, "not the BEM bridge's receive library");
        FeedLock.requireMirrored(lib, receiver, A.BEM_OFT_XLAYER, A.BSC_EID);
        require(r.locked(), "locked()");
        console2.log("PASS: receiver locked, peer, library and DVN config mirror the BEM bridge", receiver);
    }
}
