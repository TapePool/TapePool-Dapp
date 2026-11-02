// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IRigVoucher, ITapeOutFactory, ITapeOutCircuits, ITapeOutTransistors} from "../../src/interfaces/IXLayer.sol";
import {IRigVaultBsc, IPodMining} from "../../src/interfaces/IBsc.sol";
import {IRigFeed} from "../../src/interfaces/IRigFeed.sol";
import {ILzEndpointSend} from "../../src/interfaces/ILayerZero.sol";
import {PolicyV1} from "../../src/libraries/PolicyV1.sol";
import {RigReporter} from "../../src/feed/RigReporter.sol";
import {RigFeedReceiver} from "../../src/feed/RigFeedReceiver.sol";
import {RigScreen, IPoolAuthority} from "../../src/RigScreen.sol";
import {CreditPolicy} from "../../src/CreditPolicy.sol";
import {AgentFactory} from "../../src/AgentFactory.sol";
import {TapePool} from "../../src/TapePool.sol";
import {Addresses as A} from "../Addresses.sol";
import {FeedConfig} from "../feed/FeedConfig.sol";

/// LOCAL ANVIL FORKS ONLY. Deploys the Phase 3 part A stack with test roles so the keeper's
/// integration test (keeper/test/anvil.int.test.ts) can drive it with auto-impersonated accounts.
/// Never point this at a real chain: it uses test owner and guardian addresses.
///   BSC anvil:     --sig "bsc()"
///   X Layer anvil: --sig "xlayer(address,address,address)" <reporter> <poolOwner> <guardian>
///   BSC anvil:     --sig "finishBsc(address,address)" <reporter> <receiver>
contract AnvilStack is Script {
    ILzEndpointSend constant EP = ILzEndpointSend(A.ENDPOINT);

    /// @dev Reverts on any node that is not anvil (real RPCs reject `anvil_nodeInfo`), so the test roles
    ///      below can never be deployed to a real chain even though the chain ids are the real ones.
    modifier onlyAnvil() {
        vm.rpc("anvil_nodeInfo", "[]");
        _;
    }

    function bsc() external onlyAnvil {
        require(block.chainid == A.BSC_CHAIN_ID, "BSC anvil fork");
        vm.startBroadcast();
        (, address me,) = vm.readCallers();
        RigReporter reporter = new RigReporter(
            A.ENDPOINT, me, A.XLAYER_EID, IRigVaultBsc(A.RIG_VAULT), IPodMining(A.POD_MINING), A.BEM_ADAPTER_BSC
        );
        vm.stopBroadcast();
        console2.log("ANVIL_REPORTER", address(reporter));
    }

    function xlayer(address reporter, address poolOwner, address guardian) external onlyAnvil {
        require(block.chainid == A.XLAYER_CHAIN_ID, "X Layer anvil fork");
        vm.startBroadcast();
        (, address me,) = vm.readCallers();
        (address circuits, uint256 circuitId) = _tapeOut();
        RigFeedReceiver receiver = _feed(reporter, me);
        uint256 factoryBlock = block.number;
        (RigScreen screen, CreditPolicy credit, AgentFactory factory, TapePool pool) =
            _pool(me, circuits, circuitId, address(receiver), poolOwner, guardian);
        vm.stopBroadcast();

        require(credit.pinsOk(), "pins");
        console2.log("ANVIL_RECEIVER", address(receiver));
        console2.log("ANVIL_SCREEN", address(screen));
        console2.log("ANVIL_POLICY", address(credit));
        console2.log("ANVIL_FACTORY", address(factory));
        console2.log("ANVIL_POOL", address(pool));
        console2.log("ANVIL_FACTORY_BLOCK", factoryBlock);
    }

    function _tapeOut() internal returns (address circuits, uint256 circuitId) {
        (bytes memory nl, uint32 gates) = PolicyV1.build();
        ITapeOutFactory f = ITapeOutFactory(0x1f09DAeFA827f02CBb40967cc91b259763760761);
        address transistors;
        (transistors, circuits) = f.createCPU{value: f.deployFee()}("Anvil Policy", "ANVIL", "local test", 10_000, 1e13);
        ITapeOutTransistors tr = ITapeOutTransistors(transistors);
        tr.mint{value: uint256(gates) * tr.mintPrice() + tr.protocolFee()}(tr.NAND(), gates);
        ITapeOutCircuits c = ITapeOutCircuits(circuits);
        circuitId = c.tapeout{value: c.TAPEOUT_FEE()}(nl, PolicyV1.N_IN, PolicyV1.N_OUT);
    }

    function _feed(address reporter, address me) internal returns (RigFeedReceiver receiver) {
        (address recvLib,) = EP.getReceiveLibrary(A.BEM_OFT_XLAYER, A.BSC_EID);
        receiver = new RigFeedReceiver(A.ENDPOINT, me, A.BSC_EID, A.BEM_OFT_XLAYER);
        receiver.setPeer(A.BSC_EID, bytes32(uint256(uint160(reporter))));
        FeedConfig.mirror(EP, address(receiver), recvLib, A.BSC_EID, A.BEM_OFT_XLAYER);
        receiver.lock(recvLib);
    }

    function _pool(
        address me,
        address circuits,
        uint256 circuitId,
        address receiver,
        address poolOwner,
        address guardian
    ) internal returns (RigScreen screen, CreditPolicy credit, AgentFactory factory, TapePool pool) {
        address predicted = vm.computeCreateAddress(me, vm.getNonce(me) + 3);
        screen = new RigScreen(IPoolAuthority(predicted));
        credit = new CreditPolicy(
            CreditPolicy.Pins({
                circuits: circuits,
                circuitId: circuitId,
                feed: IRigFeed(receiver),
                voucher: A.RIG_VOUCHER,
                screen: screen,
                cpuTapeOut: A.CPU_TAPEOUT,
                cpuBehemoth: A.CPU_BEHEMOTH,
                cpuRefBench: A.CPU_REFBENCH,
                emissionValidUntil: A.EMISSION_VALID_UNTIL
            })
        );
        factory = new AgentFactory(predicted, IRigVoucher(A.RIG_VOUCHER), IERC20(A.BEM_OFT_XLAYER), IRigFeed(receiver));
        pool = new TapePool(IERC20(A.BEM_OFT_XLAYER), factory, credit, poolOwner, guardian, poolOwner);
        require(address(pool) == predicted, "pool address prediction");
    }

    function finishBsc(address reporter, address receiver) external onlyAnvil {
        require(block.chainid == A.BSC_CHAIN_ID, "BSC anvil fork");
        address sendLib = EP.getSendLibrary(A.BEM_ADAPTER_BSC, A.XLAYER_EID);
        vm.startBroadcast();
        RigReporter(reporter).setPeer(A.XLAYER_EID, bytes32(uint256(uint160(receiver))));
        FeedConfig.mirror(EP, reporter, sendLib, A.XLAYER_EID, A.BEM_ADAPTER_BSC);
        RigReporter(reporter).lock(sendLib);
        vm.stopBroadcast();
        console2.log("ANVIL_REPORTER_LOCKED", reporter);
    }
}
