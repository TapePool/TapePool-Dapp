// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IRigVoucher} from "../../src/interfaces/IXLayer.sol";
import {IRigVaultBsc, IPodMining} from "../../src/interfaces/IBsc.sol";
import {RigReport} from "../../src/spike/feed/RigReport.sol";
import {RigReporter} from "../../src/spike/feed/RigReporter.sol";
import {RigReportReceiver} from "../../src/spike/feed/RigReportReceiver.sol";
import {FeedGate} from "../../src/spike/feed/FeedGate.sol";
import {ILzEndpointSend, IUlnConfigReader, SetConfigParam, UlnConfig} from "../../src/interfaces/ILayerZero.sol";

/// One real LayerZero message from BSC to X Layer with the push-feed prototype (DERISK Q1).
/// Throwaway probe contracts: they hold no funds, and after `lock` their owner has no power left.
///
/// Dry-run by default. Only `--broadcast`, signed by the owner's own wallet, sends anything.
/// Steps, in this order (each prints what the next one needs):
///   1. BSC:      --sig "deployReporter()"
///   2. X Layer:  --sig "setupReceiver(address)" <reporter>
///   3. BSC:      --sig "finishAndPush(address,address)" <reporter> <receiver>
///   4. X Layer:  --sig "status(address,address)" <receiver> <gate>   (read only, run ~1 min later)
contract FeedProbe is Script {
    ILzEndpointSend constant EP = ILzEndpointSend(0x1a44076050125825900e736c501f859c50fE728c);
    IRigVaultBsc constant VAULT = IRigVaultBsc(0x48D43345656f0f9510dC3c06CBa99dFf597617C2);
    IPodMining constant POD = IPodMining(0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46);
    IRigVoucher constant VOUCHER = IRigVoucher(0x9cfc959cd42B2e1d39a0d850c528210E818AE520);
    address constant BEM_ADAPTER_BSC = 0xa84B8D3893De6e9922f2B29bE1e1b115845F5E72;
    address constant BEM_OFT_XLAYER = 0x60e62Efa9405d6873C5deaBD4E6CC91c25363952;
    uint32 constant BSC_EID = 30102;
    uint32 constant XLAYER_EID = 30274;
    uint32 constant ULN_CONFIG = 2;
    uint256 constant N_RIGS = 16;

    /// Step 1, BSC: deploy the reporter. The broadcaster becomes its owner and LayerZero delegate.
    function deployReporter() external {
        require(block.chainid == 56, "step 1 runs on BSC");
        vm.startBroadcast();
        (, address me,) = vm.readCallers();
        RigReporter reporter = new RigReporter(EP, VAULT, POD, XLAYER_EID, me);
        vm.stopBroadcast();
        console2.log("REPORTER (BSC)", address(reporter));
    }

    /// Step 2, X Layer: deploy receiver + gate, trust only `reporter`, mirror the BEM bridge's
    /// receive DVN config, then lock (pin library, drop delegate, freeze peer).
    function setupReceiver(address reporter) external {
        require(block.chainid == 196, "step 2 runs on X Layer");
        UlnConfig memory cfg = IUlnConfigReader(_recvLibDefault()).getUlnConfig(BEM_OFT_XLAYER, BSC_EID);
        vm.startBroadcast();
        (, address me,) = vm.readCallers();
        RigReportReceiver receiver = new RigReportReceiver(EP, BSC_EID, me);
        FeedGate gate = new FeedGate(receiver, VOUCHER);
        receiver.setPeer(_b32(reporter));
        (address recvLib,) = EP.getReceiveLibrary(address(receiver), BSC_EID);
        EP.setConfig(address(receiver), recvLib, _one(BSC_EID, cfg));
        receiver.lock(recvLib);
        vm.stopBroadcast();
        require(EP.delegates(address(receiver)) == address(0), "delegate not removed");
        console2.log("RECEIVER (X Layer)", address(receiver));
        console2.log("GATE (X Layer)", address(gate));
    }

    /// Step 3, BSC: point the reporter at `receiver`, mirror the BEM bridge's send DVN config,
    /// lock, then push all bridged rigs in one message (fee + 10% headroom, the rest is refunded).
    function finishAndPush(address reporterAddr, address receiver) external {
        require(block.chainid == 56, "step 3 runs on BSC");
        RigReporter reporter = RigReporter(reporterAddr);
        address sendLib = EP.getSendLibrary(reporterAddr, XLAYER_EID);
        UlnConfig memory cfg = IUlnConfigReader(sendLib).getUlnConfig(BEM_ADAPTER_BSC, XLAYER_EID);
        uint256[] memory ids = new uint256[](N_RIGS);
        for (uint256 i; i < N_RIGS; i++) {
            ids[i] = i + 1;
        }
        vm.startBroadcast();
        reporter.setPeer(_b32(receiver));
        EP.setConfig(reporterAddr, sendLib, _one(XLAYER_EID, cfg));
        reporter.lock(sendLib);
        uint256 fee = reporter.quote(ids);
        bytes32 guid = reporter.push{value: fee + fee / 10}(ids);
        vm.stopBroadcast();
        require(EP.delegates(reporterAddr) == address(0), "delegate not removed");
        console2.log("LayerZero fee (wei BNB)", fee);
        console2.log("GUID");
        console2.logBytes32(guid);
        console2.log("Track: https://layerzeroscan.com/tx/<step 3 push tx hash>");
    }

    /// Step 4, X Layer, read only: did the message land, and does the gate accept it?
    function status(address receiverAddr, address gateAddr) external {
        require(block.chainid == 196, "step 4 runs on X Layer");
        RigReportReceiver receiver = RigReportReceiver(receiverAddr);
        RigReport memory r = receiver.latest(16);
        if (r.observedAt == 0) {
            console2.log("NOT LANDED YET: no report stored. Check LayerZero Scan and retry in a minute.");
            return;
        }
        console2.log("LANDED. BSC block of the read", r.bscBlock);
        console2.log("age (s)", block.timestamp - r.observedAt);
        for (uint256 id = 1; id <= N_RIGS; id++) {
            RigReport memory x = receiver.latest(id);
            console2.log("rig", id, "base power", x.verifWeight - x.bonus);
        }
        if (block.timestamp <= r.observedAt + 5 minutes) {
            console2.log("gate.check(5) (simulated) =", FeedGate(gateAddr).check(5, ""));
        } else {
            console2.log("report older than 5 min: the gate would deny it (fail closed), as designed");
        }
    }

    function _recvLibDefault() private view returns (address lib) {
        (lib,) = EP.getReceiveLibrary(BEM_OFT_XLAYER, BSC_EID);
    }

    function _one(uint32 eid, UlnConfig memory cfg) private pure returns (SetConfigParam[] memory ps) {
        ps = new SetConfigParam[](1);
        ps[0] = SetConfigParam(eid, ULN_CONFIG, abi.encode(cfg));
    }

    function _b32(address a) private pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
