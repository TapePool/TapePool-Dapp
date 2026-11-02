// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IRigVoucher} from "../../src/interfaces/IXLayer.sol";
import {IRigFeed} from "../../src/interfaces/IRigFeed.sol";
import {IPodMining} from "../../src/interfaces/IBsc.sol";
import {RigScreen, IPoolAuthority} from "../../src/RigScreen.sol";
import {CreditPolicy} from "../../src/CreditPolicy.sol";
import {AgentFactory} from "../../src/AgentFactory.sol";
import {TapePool} from "../../src/TapePool.sol";
import {TapeLens} from "../../src/TapeLens.sol";
import {RigFeedReceiver} from "../../src/feed/RigFeedReceiver.sol";
import {Addresses as A} from "../Addresses.sol";

/// Deploy the pool stack on X Layer (SPEC-PHASE3 §6 steps 3–7) on top of a taped-out policy circuit
/// and a locked feed. Rehearsed on forks in Phase 3, broadcast in Phase 6 after the owner's go-ahead.
///   forge script script/deploy/DeployPool.s.sol --sig "run(address,uint256,address)" \
///     <policyCircuits> <policyCircuitId> <feedReceiver> --account tapepool-probe   (add --broadcast to send)
/// The deployer keeps no power: the pool's owner and guardian are passed to the constructor.
/// Redeploy 3 (SPEC-REDEPLOY-3 R3-07, O3-4) passes the reused receiver `Addresses.FEED_RECEIVER_XLAYER_2`
/// and policy circuit id 1, unchanged: it deploys a new screen, policy, factory with its agent
/// implementation, pool and lens, and no feed. The pool's constructor sets the launch values (O3-7);
/// `CheckStack` asserts them.
contract DeployPool is Script {
    struct Deployed {
        RigScreen screen;
        CreditPolicy credit;
        AgentFactory factory;
        TapePool pool;
        TapeLens lens;
    }

    /// @notice Simulate deployment by default; only forge's explicit --broadcast sends transactions.
    function run(address circuits, uint256 circuitId, address feed) external returns (Deployed memory d) {
        // broadcast goes to the chain given by --rpc-url; BSC is only read, on a separate fork
        uint256 home = vm.activeFork();
        require(block.chainid == A.XLAYER_CHAIN_ID, "X Layer only");
        vm.selectFork(vm.createFork("bsc"));
        require(emissionEnd() == A.EMISSION_VALID_UNTIL, "first halving moved: review emissionValidUntil");
        vm.selectFork(home);

        vm.startBroadcast();
        (, address me,) = vm.readCallers();
        d = deployAll(me, circuits, circuitId, feed);
        vm.stopBroadcast();
        check(d, feed);
        console2.log("RIG SCREEN", address(d.screen));
        console2.log("CREDIT POLICY", address(d.credit));
        console2.log("AGENT FACTORY", address(d.factory));
        console2.log("TAPE POOL", address(d.pool));
        console2.log("TAPE LENS", address(d.lens));
    }

    /// @notice First halving minus 30 days, read from PodMining (call on a BSC fork).
    function emissionEnd() public view returns (uint256) {
        IPodMining pod = IPodMining(A.POD_MINING);
        return pod.startTime() + pod.HALVING_PERIOD() - 30 days;
    }

    /// @notice Steps 3–7: screen and factory with the pool's predicted address, then the policy and
    ///         the pool. `deployer` is whoever creates the contracts (the broadcaster in `run`).
    function deployAll(address deployer, address circuits, uint256 circuitId, address feed)
        public
        returns (Deployed memory d)
    {
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 3);
        d.screen = new RigScreen(IPoolAuthority(predicted));
        d.credit = new CreditPolicy(
            CreditPolicy.Pins({
                circuits: circuits,
                circuitId: circuitId,
                feed: IRigFeed(feed),
                voucher: A.RIG_VOUCHER,
                screen: d.screen,
                cpuTapeOut: A.CPU_TAPEOUT,
                cpuBehemoth: A.CPU_BEHEMOTH,
                cpuRefBench: A.CPU_REFBENCH,
                emissionValidUntil: A.EMISSION_VALID_UNTIL
            })
        );
        d.factory = new AgentFactory(predicted, IRigVoucher(A.RIG_VOUCHER), IERC20(A.BEM_OFT_XLAYER), IRigFeed(feed));
        d.pool = new TapePool(IERC20(A.BEM_OFT_XLAYER), d.factory, d.credit, A.OWNER, A.KEEPER_GUARDIAN, A.OWNER);
        require(address(d.pool) == predicted, "pool address prediction");
        d.lens = new TapeLens();
    }

    /// @notice Read-only checks of a deployed stack; reverts on the first problem.
    function check(Deployed memory d, address feed) public view {
        require(d.credit.pinsOk(), "policy pins do not match the circuit");
        require(address(d.pool.policy()) == address(d.credit), "pool policy");
        require(address(d.screen.pool()) == address(d.pool), "screen pool");
        require(d.factory.pool() == address(d.pool), "factory pool");
        require(address(d.factory.feed()) == feed && address(d.credit.feed()) == feed, "one feed everywhere");
        require(
            RigFeedReceiver(feed).locked() && RigFeedReceiver(feed).peers(A.BSC_EID) != bytes32(0), "feed not locked"
        );
        require(d.pool.owner() == A.OWNER && d.pool.guardian() == A.KEEPER_GUARDIAN, "roles");
        require(d.pool.backstop() == A.OWNER && d.pool.borrowsPaused(), "launch brakes and backstop");
        require(address(d.lens).code.length != 0, "lens not deployed");
        require(d.credit.emissionValidUntil() == A.EMISSION_VALID_UNTIL, "emission end");
    }
}
