// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IRigVoucher} from "../../src/interfaces/IXLayer.sol";
import {Reasons} from "../../src/interfaces/ICreditPolicy.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {RigReporter} from "../../src/feed/RigReporter.sol";
import {RigFeedReceiver} from "../../src/feed/RigFeedReceiver.sol";
import {RigScreen} from "../../src/RigScreen.sol";
import {AgentFactory} from "../../src/AgentFactory.sol";
import {TapePool} from "../../src/TapePool.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {TapeLens} from "../../src/TapeLens.sol";
import {Addresses as A} from "../../script/Addresses.sol";
import {FeedForkBase} from "./FeedForkBase.sol";

/// Rehearsal of the first test loan on the LIVE deployment (2026-10-21): the real pool, factory,
/// policy, screen and the real locked feed, with the real actors (the owner wallet and the holder
/// of voucher #16), on forks of today's BSC and X Layer. Only the DVN step is simulated and time
/// is moved past the screen pass. Opt-in: LIVE_REHEARSAL=1 and BSC_RPC. LOCAL FORKS ONLY.
interface ILegacyRigAgent {
    function borrow(uint8 term, uint256 principal) external payable;
}

contract LiveRehearsalTest is FeedForkBase {
    IRigVoucher constant VOUCHER = IRigVoucher(A.RIG_VOUCHER);
    IERC20 constant BEM = IERC20(A.BEM_OFT_XLAYER);
    address constant BIG_HOLDER = 0x571d447f4f24688eC35Ccf07f1D6993655F6aF15; // BEM on X Layer
    uint256 constant RIG = 16;
    uint256 constant PRINCIPAL = 1_000_000; // 0.01 BEM, the planned test loan
    uint256 constant SEED = 99_500_000; // the owner's 0.995 BEM
    uint256 constant INTRINSIC = 21_000; // per transaction, on top of the measured execution gas

    TapePool pool = TapePool(A.TAPE_POOL);
    AgentFactory factory = AgentFactory(A.AGENT_FACTORY);
    RigScreen screen = RigScreen(A.RIG_SCREEN);

    address holder;
    RigAgent agent;
    uint256 t; // loan time
    uint256 okbBefore; // the holder's OKB on X Layer before the run
    uint256 xGas; // the holder's X Layer execution gas, summed

    function test_rig16_test_loan_on_the_live_deployment() public {
        string memory bscRpc = vm.envOr("BSC_RPC", string(""));
        if (!vm.envOr("LIVE_REHEARSAL", false) || bytes(bscRpc).length == 0) vm.skip(true);
        bscFork = vm.createFork(bscRpc);
        xFork = vm.createFork("xlayer");
        reporter = RigReporter(payable(A.FEED_REPORTER_BSC));
        receiver = RigFeedReceiver(A.FEED_RECEIVER_XLAYER);

        _start();
        _seedAndOpenAgent();
        _freshReport();
        _quote();
        _borrow();
        _repayAndRelease();

        console2.log("holder OKB on X Layer before (wei)", okbBefore);
        // fee + gas at 0.02 gwei, gas doubled as a margin for wallet estimates
        console2.log("holder OKB needed (wei)", pool.opsFee(0) + 2 * xGas * 0.02 gwei);
    }

    /// The loan time: one minute after rig #16's pass takes effect (or now, if later).
    function _start() internal {
        vm.selectFork(xFork);
        holder = VOUCHER.ownerOf(RIG);
        if (factory.isAgent(holder)) holder = RigAgent(holder).borrower(); // already inside an agent
        okbBefore = holder.balance;
        (RigScreen.Pass memory pass, bool suspended) = screen.passOf(RIG);
        assertFalse(suspended, "pass suspended");
        t = block.timestamp > pass.effectiveAt + 60 ? block.timestamp : pass.effectiveAt + 60;
        console2.log("holder of voucher 16", holder);
        console2.log("loan time (unix)", t);
        vm.warp(t);
    }

    /// The owner deposits again (the allowance left from the first deposit covers it); the holder
    /// opens an agent and moves voucher #16 into it.
    function _seedAndOpenAgent() internal {
        // each step runs only if the live chain has not done it yet
        uint256 g;
        if (pool.totalAssets() == 0) {
            g = gasleft();
            vm.prank(A.OWNER);
            pool.deposit(SEED, A.OWNER);
            _gas("owner: deposit 0.995 BEM (X Layer)", g);
        }
        console2.log("pool totalAssets (raw BEM)", pool.totalAssets());

        address predicted = factory.predictAgent(holder, 0);
        if (predicted.code.length == 0) {
            g = gasleft();
            vm.prank(holder);
            factory.create(0);
            xGas += _gas("holder: factory.create(0) (X Layer)", g) + INTRINSIC;
        }
        agent = RigAgent(predicted);
        console2.log("agent", address(agent));

        if (VOUCHER.ownerOf(RIG) == holder) {
            g = gasleft();
            vm.prank(holder);
            VOUCHER.safeTransferFrom(holder, address(agent), RIG);
            xGas += _gas("holder: voucher.safeTransferFrom to the agent (X Layer)", g) + INTRINSIC;
        }
        assertEq(VOUCHER.ownerOf(RIG), address(agent), "voucher in the agent");
    }

    /// A fresh report: pushed on BSC at the loan time by the holder, landed on X Layer 40 s later.
    function _freshReport() internal {
        vm.selectFork(bscFork);
        vm.warp(t);
        uint256[] memory ids = _ids(RIG, RIG);
        uint256 fee = reporter.quote(ids);
        console2.log("push fee (wei BNB)", fee);
        console2.log("holder BNB on BSC now (wei)", holder.balance);
        if (holder.balance < fee + 0.0002 ether) vm.deal(holder, fee + 0.0002 ether); // fork only
        vm.recordLogs();
        uint256 g = gasleft();
        vm.prank(holder);
        reporter.push{value: fee}(ids);
        _gas("holder: reporter.push([16]) (BSC)", g);
        Packet memory p = _packet();
        vm.selectFork(xFork);
        vm.warp(t + 40);
        _deliver(p);
        (RigReport memory r, bool ok) = receiver.latest(RIG);
        assertTrue(ok, "report landed");
        console2.log("report base power (verifWeight - bonus)", r.verifWeight - r.bonus);
        console2.log("report totalVerifWeight", r.totalVerifWeight);
    }

    /// The quote the app would show (TapeLens is a view helper, deployed on the fork only).
    function _quote() internal {
        TapeLens lens = new TapeLens();
        uint256 limit = pool.policy().maxDebt(address(agent), agent.collateralOf(), 0);
        uint256 principal = lens.principalFor(pool, 0, limit);
        uint256 room = pool.maxLend(holder); // The archived pool predates lendLimit.
        if (principal > room) principal = room;
        uint256 fee = pool.fee(0, principal);
        (bool allow, uint8 reason,, uint256 expected) =
            pool.policy().check(address(agent), agent.collateralOf(), 0, principal + fee);
        assertTrue(allow);
        assertEq(reason, Reasons.OK, "quote reason");
        console2.log("7-day max principal (raw BEM, 8 dp)", principal);
        console2.log("fee at max principal (raw BEM)", fee);
        console2.log("expected base output over 7 days (raw BEM)", expected);
        console2.log("operating fee (wei OKB)", pool.opsFee(0));
        assertGe(principal, PRINCIPAL, "0.01 BEM fits");
    }

    /// 0.01 BEM for 7 days, carrying exactly the operating fee.
    function _borrow() internal {
        uint256 ops = pool.opsFee(0);
        if (holder.balance < ops + 0.001 ether) vm.deal(holder, ops + 0.001 ether); // fork only
        uint256 bem0 = BEM.balanceOf(holder);
        uint256 ownerOkb0 = A.OWNER.balance;
        uint256 g = gasleft();
        vm.prank(holder);
        ILegacyRigAgent(address(agent)).borrow{value: ops}(0, PRINCIPAL);
        xGas += _gas("holder: agent.borrow(0, 0.01 BEM) + 0.031 OKB (X Layer)", g) + INTRINSIC;
        RigAgent.LoanView memory l = agent.loanOf();
        assertTrue(l.open, "loan open");
        assertEq(BEM.balanceOf(holder) - bem0, PRINCIPAL, "advance paid to the holder");
        assertEq(A.OWNER.balance - ownerOkb0, ops, "operating fee to the owner");
        console2.log("debt (raw BEM)", l.debt);
        console2.log("fee (raw BEM)", l.feeLeft);
        console2.log("maturity (unix)", l.maturity);
        console2.log("pool idle after (raw BEM)", pool.idle());
        console2.log("pool outstanding (raw BEM)", pool.outstandingPrincipal());
    }

    /// Repayment as a harvest would make it: BEM reaches the agent, anyone sweeps, the holder takes
    /// the voucher back; then what the owner could withdraw.
    function _repayAndRelease() internal {
        uint256 debt = agent.loanOf().debt;
        vm.prank(BIG_HOLDER);
        BEM.transfer(address(agent), debt);
        agent.sweep();
        assertFalse(agent.loanOf().open, "loan repaid");
        uint256 g = gasleft();
        vm.prank(holder);
        agent.release();
        _gas("holder: agent.release() (X Layer)", g);
        assertEq(VOUCHER.ownerOf(RIG), holder, "voucher back with the holder");
        console2.log("pool reserve after repayment (raw BEM)", pool.reserve());
        console2.log("pool totalAssets after repayment (raw BEM)", pool.totalAssets());
        console2.log("owner can withdraw (raw BEM)", pool.maxWithdraw(A.OWNER));
    }

    function _packet() internal returns (Packet memory p) {
        bytes memory packet;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(EP) && logs[i].topics[0] == PACKET_SENT) {
                (packet,,) = abi.decode(logs[i].data, (bytes, bytes, address));
            }
        }
        require(packet.length > 113, "no PacketSent");
        p.nonce = uint64(bytes8(_slice(packet, 1, 8)));
        p.srcEid = uint32(bytes4(_slice(packet, 9, 4)));
        p.sender = bytes32(_slice(packet, 13, 32));
        p.guid = bytes32(_slice(packet, 81, 32));
        p.message = _slice(packet, 113, packet.length - 113);
    }

    function _gas(string memory what, uint256 before) internal view returns (uint256 used) {
        used = before - gasleft();
        console2.log(what, used);
    }
}
