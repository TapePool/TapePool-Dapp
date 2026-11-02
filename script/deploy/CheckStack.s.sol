// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TapePool} from "../../src/TapePool.sol";
import {TapeLens} from "../../src/TapeLens.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {AgentFactory} from "../../src/AgentFactory.sol";
import {CreditPolicy} from "../../src/CreditPolicy.sol";
import {RigFeedReceiver} from "../../src/feed/RigFeedReceiver.sol";
import {RigReporter} from "../../src/feed/RigReporter.sol";
import {FeedLock} from "../../src/feed/FeedLock.sol";
import {ILzEndpointSend} from "../../src/interfaces/ILayerZero.sol";
import {Addresses as A} from "../Addresses.sol";

/// @notice Read-only gates for the new stack, including both chains' feed configuration: `run` before
///         the seed, `runSeeded` after it (SPEC-REDEPLOY-3 R3-07, RD3-04 and RD3-07).
contract CheckStack is Script {
    /// @notice The dead-seed holder and the least share balance it gets for 0.01 BEM at the launch
    ///         price (decimals offset 6).
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant DEAD_SEED_SHARES = 1e12;

    /// @notice Pre-seed gate: check X Layer, then use a read-only BSC fork to check the reporter. No broadcast.
    function run(address poolAddress, address lensAddress, address reporterAddress) external {
        _run(poolAddress, lensAddress, reporterAddress, false);
    }

    /// @notice The same checks after the seed (RD3-07), with the seeded state instead of the pre-seed gate.
    function runSeeded(address poolAddress, address lensAddress, address reporterAddress) external {
        _run(poolAddress, lensAddress, reporterAddress, true);
    }

    function _run(address poolAddress, address lensAddress, address reporterAddress, bool seeded) internal {
        require(block.chainid == A.XLAYER_CHAIN_ID, "X Layer only");
        TapePool pool = TapePool(poolAddress);
        if (seeded) checkPoolSeeded(pool, TapeLens(lensAddress));
        else checkPool(pool, TapeLens(lensAddress));
        checkReusedFeed(pool);
        require(reporterAddress == A.FEED_REPORTER_BSC_2, "reused reporter");
        address receiverAddress = address(CreditPolicy(address(pool.policy())).feed());
        RigFeedReceiver receiver = RigFeedReceiver(receiverAddress);
        ILzEndpointSend ep = ILzEndpointSend(A.ENDPOINT);
        require(receiver.srcEid() == A.BSC_EID && receiver.bemRef() == A.BEM_OFT_XLAYER, "receiver pins");
        require(address(receiver.endpoint()) == A.ENDPOINT && receiver.locked(), "receiver lock");
        require(receiver.peers(A.BSC_EID) == bytes32(uint256(uint160(reporterAddress))), "receiver peer");
        (address lib, bool isDefault) = ep.getReceiveLibrary(receiverAddress, A.BSC_EID);
        (address bemLib,) = ep.getReceiveLibrary(A.BEM_OFT_XLAYER, A.BSC_EID);
        require(!isDefault && lib == bemLib, "receiver library");
        FeedLock.requireMirrored(lib, receiverAddress, A.BEM_OFT_XLAYER, A.BSC_EID);
        console2.log("receiver / receive library", receiverAddress, lib);
        uint256 home = vm.activeFork();
        vm.selectFork(vm.createFork("bsc"));
        RigReporter reporter = RigReporter(reporterAddress);
        require(address(reporter.endpoint()) == A.ENDPOINT && reporter.locked(), "reporter lock");
        require(reporter.dstEid() == A.XLAYER_EID && reporter.bemRef() == A.BEM_ADAPTER_BSC, "reporter pins");
        require(address(reporter.vault()) == A.RIG_VAULT && address(reporter.pod()) == A.POD_MINING, "BSC pins");
        require(reporter.peers(A.XLAYER_EID) == bytes32(uint256(uint160(receiverAddress))), "reporter peer");
        lib = ep.getSendLibrary(reporterAddress, A.XLAYER_EID);
        require(!reporter.endpoint().isDefaultSendLibrary(reporterAddress, A.XLAYER_EID), "default send library");
        require(lib == ep.getSendLibrary(A.BEM_ADAPTER_BSC, A.XLAYER_EID), "reporter library");
        FeedLock.requireMirrored(lib, reporterAddress, A.BEM_ADAPTER_BSC, A.XLAYER_EID);
        console2.log("reporter / send library", reporterAddress, lib);
        vm.selectFork(home);
        console2.log("PASS: new stack pins, locks, roles, bounds and launch state");
    }

    /// @notice Pre-seed gate: every pool launch value and wiring pin, and an empty pool; callable
    ///         against a local rehearsal.
    function checkPool(TapePool pool, TapeLens lens) public view {
        _checkLaunch(pool, lens);
        require(pool.totalSupply() == 0 && pool.idle() == 0 && pool.unvestedNow() == 0, "pre-seed accounting");
        require(pool.unvested() == 0 && pool.vestUpdatedAt() == 0 && pool.vestEnd() == 0, "initial vesting state");
        require(pool.outstandingPrincipal() == 0 && pool.doubtful() == 0 && pool.frozenCount() == 0, "pre-seed state");
        _log(pool, lens);
    }

    /// @notice Post-seed variant (after RD3-07): the same launch values and pins, then the dead seed,
    ///         the backstop's shares and no loan, mark or brake yet.
    function checkPoolSeeded(TapePool pool, TapeLens lens) public view {
        _checkLaunch(pool, lens);
        require(pool.balanceOf(DEAD) >= DEAD_SEED_SHARES, "dead seed");
        require(pool.balanceOf(pool.backstop()) != 0, "backstop shares");
        require(pool.outstandingPrincipal() == 0 && pool.doubtful() == 0 && pool.frozenCount() == 0, "post-seed state");
        console2.log("dead seed shares / total supply", pool.balanceOf(DEAD), pool.totalSupply());
        console2.log("backstop shares / total assets", pool.balanceOf(pool.backstop()), pool.totalAssets());
        _log(pool, lens);
    }

    /// @notice The reused feed (O3-4): the policy, the factory and the agent implementation all read
    ///         the 2026-10-31 receiver, which is still locked and still peers the 2026-10-31 reporter.
    function checkReusedFeed(TapePool pool) public view {
        AgentFactory factory = AgentFactory(address(pool.factory()));
        address receiver = address(CreditPolicy(address(pool.policy())).feed());
        require(
            receiver == A.FEED_RECEIVER_XLAYER_2 && address(factory.feed()) == receiver
                && address(factory.implementation().feed()) == receiver,
            "reused receiver"
        );
        require(RigFeedReceiver(receiver).locked(), "receiver lock");
        require(
            RigFeedReceiver(receiver).peers(A.BSC_EID) == bytes32(uint256(uint160(A.FEED_REPORTER_BSC_2))),
            "receiver peer"
        );
    }

    /// @dev Every launch value, bound and pin shared by both gates.
    function _checkLaunch(TapePool pool, TapeLens lens) internal view {
        AgentFactory factory = AgentFactory(address(pool.factory()));
        CreditPolicy credit = CreditPolicy(address(pool.policy()));
        RigAgent impl = factory.implementation();
        require(
            pool.owner() == A.OWNER && pool.guardian() == A.KEEPER_GUARDIAN && pool.pendingOwner() == address(0),
            "roles"
        );
        require(pool.backstop() == A.OWNER, "backstop");
        require(pool.borrowsPaused() && !pool.feedDisabled() && !pool.policySwapQueued(), "launch brakes");
        require(address(pool.pendingPolicy()) == address(0) && pool.pendingPolicyEta() == 0, "pending policy");
        require(pool.asset() == A.BEM_OFT_XLAYER && factory.bem() == A.BEM_OFT_XLAYER, "BEM pins");
        require(factory.pool() == address(pool) && address(impl.pool()) == address(pool), "pool pins");
        require(address(factory.voucher()) == A.RIG_VOUCHER && address(impl.voucher()) == A.RIG_VOUCHER, "voucher pins");
        require(
            address(impl.bem()) == pool.asset() && impl.factory() == address(factory) && impl.closed(), "implementation"
        );
        require(
            address(factory.feed()) == address(credit.feed()) && address(impl.feed()) == address(credit.feed()),
            "feed pins"
        );
        require(credit.voucher() == A.RIG_VOUCHER && address(credit.screen().pool()) == address(pool), "policy pins");
        require(
            credit.circuits() == A.POLICY_CIRCUITS && credit.circuitId() == A.POLICY_CIRCUIT_ID && credit.pinsOk(),
            "circuit pin and hash"
        );
        require(
            credit.cpuTapeOut() == A.CPU_TAPEOUT && credit.cpuBehemoth() == A.CPU_BEHEMOTH
                && credit.cpuRefBench() == A.CPU_REFBENCH,
            "processors"
        );
        require(
            credit.emissionValidUntil() == A.EMISSION_VALID_UNTIL && credit.version() == 1
                && credit.screen().DELAY() == 48 hours,
            "policy constants"
        );
        require(
            pool.TIMELOCK() == 48 hours && pool.POLICY_TIMELOCK() == 7 days && pool.QUEUE_GRACE() == 7 days
                && pool.VEST() == 7 days,
            "pool constants"
        );
        require(
            impl.OWNER_READ_GAS() == 100_000 && impl.VOUCHER_GAS() == 200_000 && impl.MAX_CLOCK_SKEW() == 60,
            "agent constants"
        );
        // redeploy 3 (R3-01): no re-enable yet, and the borrow wait after one is 360 s
        require(pool.feedEnabledAt() == 0, "feed record");
        require(pool.FEED_SETTLE() == 360, "feed settle");
        require(address(lens).codehash == keccak256(type(TapeLens).runtimeCode), "lens bytecode");
        uint256[14] memory values =
            [uint256(20e8), 8e8, 7_000, 4_000, 25, 50, 100_000, 1_000_000, 0, 2_000, 500, 0, 0, 4e8];
        uint256[14] memory lows = [uint256(0), 0, 0, 0, 25, 50, 100_000, 100_000, 0, 0, 0, 0, 0, 0];
        uint256[14] memory highs = [
            uint256(1_000e8),
            500e8,
            9_000,
            5_000,
            300,
            600,
            10_000_000,
            100_000_000,
            30,
            5_000,
            2_000,
            0.5 ether,
            0.5 ether,
            500e8
        ];
        for (uint256 i; i < values.length; ++i) {
            TapePool.Param key = TapePool.Param(i);
            (uint256 low, uint256 high) = pool.bounds(key);
            require(low == lows[i] && high == highs[i], "parameter bounds");
            require(pool.param(key) == values[i], "initial value");
            (, uint64 eta) = pool.queued(key);
            require(eta == 0, "queued parameter");
            console2.log("parameter / value", i, values[i]);
            console2.log("hard lower / upper bound", low, high);
        }
    }

    function _log(TapePool pool, TapeLens lens) internal view {
        AgentFactory factory = AgentFactory(address(pool.factory()));
        CreditPolicy credit = CreditPolicy(address(pool.policy()));
        RigAgent impl = factory.implementation();
        console2.log("reserve / tracked", pool.reserve(), pool.tracked());
        console2.log("pool / lens", address(pool), address(lens));
        console2.log("factory / implementation", address(factory), address(impl));
        console2.log("policy / screen", address(credit), address(credit.screen()));
        console2.log("owner / guardian", pool.owner(), pool.guardian());
        console2.log("backstop", pool.backstop());
        console2.log("BEM / voucher", pool.asset(), address(factory.voucher()));
        console2.log("feed / endpoint", address(credit.feed()), A.ENDPOINT);
        console2.log("circuit / id", credit.circuits(), credit.circuitId());
        console2.log("TapeOut / Behemoth", credit.cpuTapeOut(), credit.cpuBehemoth());
        console2.log("RefBench / emission end", credit.cpuRefBench(), credit.emissionValidUntil());
    }
}
