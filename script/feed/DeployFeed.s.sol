// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IRigVaultBsc, IPodMining} from "../../src/interfaces/IBsc.sol";
import {ILzEndpointSend} from "../../src/interfaces/ILayerZero.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {RigReporter} from "../../src/feed/RigReporter.sol";
import {BscRigReader} from "../../src/feed/BscRigReader.sol";
import {RigFeedReceiver} from "../../src/feed/RigFeedReceiver.sol";
import {Addresses as A} from "../Addresses.sol";
import {FeedConfig} from "./FeedConfig.sol";
import {CheckFeed} from "./CheckFeed.s.sol";

/// The production feed session (SPEC-PHASE3 §5.6): deploy, mirror the BEM bridge's DVN config, lock,
/// and push once. Signed by the deployer keystore; the deployer has no power once each side is locked.
///
/// Dry-run by default. Only `--broadcast`, after the owner's go-ahead in chat, sends anything.
/// Run the steps in this order (each prints what the next one needs):
///   1. BSC:      --rpc-url bsc    --sig "deployReporter()"
///   2. X Layer:  --rpc-url xlayer --sig "setupReceiver(address)" <reporter>
///   3. BSC:      --rpc-url bsc    --sig "finishReporter(address,address)" <reporter> <receiver>
///   4. BSC:      --rpc-url bsc    --sig "pushAll(address)" <reporter>
///   5. X Layer:  --rpc-url xlayer --sig "status(address)" <receiver>   (read only, about a minute later)
/// Then run script/feed/CheckFeed.s.sol on both chains before any pool is seeded.
contract DeployFeed is Script {
    ILzEndpointSend constant EP = ILzEndpointSend(A.ENDPOINT);

    /// Step 1, BSC: deploy the reporter. The broadcaster is its owner and LayerZero delegate.
    function deployReporter() external returns (RigReporter reporter) {
        require(block.chainid == A.BSC_CHAIN_ID, "step 1 runs on BSC");
        vm.startBroadcast();
        (, address me,) = vm.readCallers();
        reporter = new RigReporter(
            A.ENDPOINT, me, A.XLAYER_EID, IRigVaultBsc(A.RIG_VAULT), IPodMining(A.POD_MINING), A.BEM_ADAPTER_BSC
        );
        vm.stopBroadcast();
        console2.log("REPORTER (BSC)", address(reporter));
    }

    /// Step 2, X Layer: deploy the receiver, trust only `reporter`, mirror the BEM OFT's receive
    /// config, then lock (pin the library, drop the delegate, end ownership).
    function setupReceiver(address reporter) external returns (RigFeedReceiver receiver) {
        require(block.chainid == A.XLAYER_CHAIN_ID, "step 2 runs on X Layer");
        require(reporter != address(0), "reporter");
        // cross-check the reporter on a read-only BSC fork before locking it in as the peer for good
        (, address me,) = vm.readCallers();
        uint256 home = vm.activeFork();
        vm.selectFork(vm.createFork("bsc"));
        RigReporter rep = RigReporter(reporter);
        require(rep.dstEid() == A.XLAYER_EID && address(rep.vault()) == A.RIG_VAULT, "not our reporter");
        require(rep.owner() == me && rep.bemRef() == A.BEM_ADAPTER_BSC, "reporter owner or reference");
        vm.selectFork(home);
        (address recvLib,) = EP.getReceiveLibrary(A.BEM_OFT_XLAYER, A.BSC_EID);
        vm.startBroadcast();
        receiver = new RigFeedReceiver(A.ENDPOINT, me, A.BSC_EID, A.BEM_OFT_XLAYER);
        receiver.setPeer(A.BSC_EID, bytes32(uint256(uint160(reporter))));
        FeedConfig.mirror(EP, address(receiver), recvLib, A.BSC_EID, A.BEM_OFT_XLAYER);
        receiver.lock(recvLib);
        vm.stopBroadcast();
        new CheckFeed().checkReceiver(address(receiver), reporter);
        console2.log("RECEIVER (X Layer), locked", address(receiver));
    }

    /// Step 3, BSC: point the reporter at `receiver`, mirror the BEM adapter's send config, lock.
    function finishReporter(address reporter, address receiver) external {
        require(block.chainid == A.BSC_CHAIN_ID, "step 3 runs on BSC");
        require(receiver != address(0), "receiver");
        // cross-check the receiver on a read-only X Layer fork: locked, and trusting this reporter
        uint256 home = vm.activeFork();
        vm.selectFork(vm.createFork("xlayer"));
        RigFeedReceiver rcv = RigFeedReceiver(receiver);
        require(
            rcv.locked() && rcv.peers(A.BSC_EID) == bytes32(uint256(uint160(reporter))),
            "receiver not locked on this reporter"
        );
        vm.selectFork(home);
        address sendLib = EP.getSendLibrary(A.BEM_ADAPTER_BSC, A.XLAYER_EID);
        vm.startBroadcast();
        RigReporter(reporter).setPeer(A.XLAYER_EID, bytes32(uint256(uint160(receiver))));
        FeedConfig.mirror(EP, reporter, sendLib, A.XLAYER_EID, A.BEM_ADAPTER_BSC);
        RigReporter(reporter).lock(sendLib);
        vm.stopBroadcast();
        new CheckFeed().checkReporter(reporter, receiver);
        console2.log("REPORTER locked", reporter);
    }

    /// @notice Quote each manifest rig alone, skip unreadable custody, then push readable rigs in batches.
    function pushAll(address reporter) external {
        require(block.chainid == A.BSC_CHAIN_ID, "step 4 runs on BSC");
        uint256[] memory manifest = _rigs();
        uint256[] memory ids = new uint256[](1);
        uint256[] memory readable = new uint256[](manifest.length);
        uint256 count;
        for (uint256 i; i < manifest.length; ++i) {
            ids[0] = manifest[i];
            try RigReporter(reporter).quote(ids) returns (uint256 fee) {
                readable[count++] = ids[0];
                console2.log("readable rig / single-rig quote", ids[0], fee);
            } catch (bytes memory reason) {
                if (reason.length < 4 || bytes4(reason) != BscRigReader.CustodyUnreadable.selector) {
                    assembly { revert(add(reason, 32), mload(reason)) }
                }
                console2.log("SKIPPED: custody unreadable", ids[0]);
            }
        }
        for (uint256 offset; offset < count; offset += 16) {
            uint256 n = count - offset > 16 ? 16 : count - offset;
            uint256[] memory batch = new uint256[](n);
            for (uint256 i; i < n; ++i) {
                batch[i] = readable[offset + i];
            }
            uint256 fee = RigReporter(reporter).quote(batch);
            vm.startBroadcast();
            bytes32 guid = RigReporter(reporter).push{value: fee}(batch);
            vm.stopBroadcast();
            console2.log("pushed rigs / batch fee", n, fee);
            console2.logBytes32(guid);
        }
    }

    /// Step 5, X Layer, read only: did the reports land?
    function status(address receiver) external view {
        require(block.chainid == A.XLAYER_CHAIN_ID, "step 5 runs on X Layer");
        uint256[] memory ids = _rigs();
        for (uint256 i; i < ids.length; i++) {
            uint256 id = ids[i];
            (RigReport memory r, bool ok) = RigFeedReceiver(receiver).latest(id);
            if (!ok) {
                console2.log("rig not landed yet", id);
                continue;
            }
            console2.log("rig", id, "base power", r.verifWeight > r.bonus ? r.verifWeight - r.bonus : 0);
        }
    }

    function _rigs() internal view returns (uint256[] memory) {
        return vm.parseJsonUintArray(vm.readFile("script/feed/rigs.json"), ".rigIds");
    }
}
