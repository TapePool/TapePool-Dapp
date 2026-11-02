// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Base} from "./Base.t.sol";
import {HostileBase} from "./Reentrancy.t.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {IRigVoucher} from "../../src/interfaces/IXLayer.sol";
import {Probe, HookBEM} from "../mocks/Hostile.sol";

/// Redeploy 3, R3-02: a seized voucher never returns to the borrower. A zero holder reads as unknown;
/// toward the pool an id is removed only when the pool holds it; `seize` records `wasSeized` for every
/// collateral id before any external call; `withdrawVoucher` refuses a seized id. Mocks only.
contract Redeploy3SeizedVoucherTest is Base {
    uint256 constant ID = 7;

    enum Read {
        Unreadable, // a short answer
        Zero,
        Third,
        Pool,
        Agent,
        Borrower
    }

    enum Path {
        Seize,
        Forward,
        Release
    }

    uint8 constant KEEP = 0;
    uint8 constant MOVED = 1;
    uint8 constant REMOVED = 2;

    address third = makeAddr("third party");

    bytes32 constant REMOVED_SIG = keccak256("CollateralRemoved(address,uint256)");
    bytes32 constant SEIZED_SIG = keccak256("Seized(address,uint256[],uint256[],uint256)");
    bytes32 constant FORWARDED_SIG = keccak256("VouchersForwarded(address,uint256[])");
    bytes32 constant RELEASED_SIG = keccak256("Released(address,uint256[])");

    function _flagged(RigAgent a) internal {
        vm.warp(block.timestamp + 1 hours);
        feed.set(_rescuedReport(ID));
        a.flagImpaired(ID);
        vm.warp(a.seizeEvidenceFrom());
        feed.set(_rescuedReport(ID));
    }

    function _word(Read r, RigAgent a) internal view returns (bytes memory) {
        if (r == Read.Unreadable) return hex"";
        if (r == Read.Zero) return abi.encode(address(0));
        if (r == Read.Third) return abi.encode(third);
        if (r == Read.Pool) return abi.encode(address(pool));
        if (r == Read.Agent) return abi.encode(address(a));
        return abi.encode(alice);
    }

    /// The agent at the point where `path` will try voucher `ID`: a loan in the seize window, a closed
    /// agent that kept the id after a blocked transfer, or an open agent with no loan.
    function _setup(Path path) internal returns (RigAgent a) {
        a = _ready(alice, ID);
        if (path == Path.Release) return a;
        _borrow(a, alice, 0, BEM);
        _flagged(a);
        if (path == Path.Seize) return a;
        voucher.setBlocked(ID, true);
        a.seize();
        voucher.setBlocked(ID, false);
        assertEq(a.collateralOf().length, 1, "kept after the blocked transfer");
    }

    /// Run `path` with the first `ownerOf` read answering `first` and, if the agent then tries the
    /// transfer (a real one, to its real destination), the second read answering `second`.
    function _run(Path path, RigAgent a, Read first, Read second) internal returns (uint8 result) {
        bytes memory q = abi.encodeCall(IRigVoucher.ownerOf, (ID));
        if (first == Read.Agent) {
            bytes[] memory answers = new bytes[](2);
            answers[0] = _word(first, a);
            answers[1] = _word(second, a);
            vm.mockCalls(address(voucher), q, answers);
        } else {
            vm.mockCall(address(voucher), q, _word(first, a));
        }
        vm.recordLogs();
        if (path == Path.Seize) a.seize();
        else if (path == Path.Forward) a.forwardVouchers();
        else _releaseAsBorrower(a);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        vm.clearMockedCalls();
        result = _outcome(a, logs);
    }

    function _releaseAsBorrower(RigAgent a) internal {
        vm.prank(alice);
        a.release();
    }

    function _outcome(RigAgent a, Vm.Log[] memory logs) internal view returns (uint8) {
        uint256 removals;
        bool moved;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(a)) continue;
            bytes32 sig = logs[i].topics[0];
            if (sig == REMOVED_SIG && uint256(logs[i].topics[2]) == ID) ++removals;
            if (sig == SEIZED_SIG) {
                (uint256[] memory m,,) = abi.decode(logs[i].data, (uint256[], uint256[], uint256));
                moved = m.length == 1 && m[0] == ID;
            } else if (sig == FORWARDED_SIG || sig == RELEASED_SIG) {
                uint256[] memory m = abi.decode(logs[i].data, (uint256[]));
                moved = m.length == 1 && m[0] == ID;
            }
        }
        bool listed = a.collateralOf().length == 1;
        if (listed) {
            assertEq(removals, 0, "a kept id emits no removal");
            assertFalse(moved, "a kept id is not listed as moved");
            return KEEP;
        }
        if (moved) {
            assertEq(removals, 0, "a moved id emits no removal");
            return MOVED;
        }
        assertEq(removals, 1, "a removed id emits CollateralRemoved");
        return REMOVED;
    }

    /// R3-02 toward the pool (`seize` and `forwardVouchers`).
    function _expectedToPool(Read first, Read second) internal pure returns (uint8) {
        if (first == Read.Pool) return REMOVED;
        if (first != Read.Agent) return KEEP;
        return second == Read.Pool ? MOVED : KEEP;
    }

    /// R3-02 toward the borrower (`release`): unchanged, except that a zero holder is unknown.
    function _expectedToBorrower(Read first, Read second) internal pure returns (uint8) {
        if (first == Read.Unreadable || first == Read.Zero) return KEEP;
        if (first != Read.Agent) return REMOVED;
        if (second == Read.Borrower) return MOVED;
        if (second == Read.Unreadable || second == Read.Zero || second == Read.Agent) return KEEP;
        return REMOVED;
    }

    function _matrix(Path path) internal {
        RigAgent a = _setup(path);
        uint256 snap = vm.snapshotState();
        for (uint256 f; f <= uint256(type(Read).max); ++f) {
            uint256 secondMax = Read(f) == Read.Agent ? uint256(type(Read).max) : 0;
            for (uint256 s; s <= secondMax; ++s) {
                vm.revertToState(snap);
                uint8 got = _run(path, a, Read(f), Read(s));
                uint8 want =
                    path == Path.Release ? _expectedToBorrower(Read(f), Read(s)) : _expectedToPool(Read(f), Read(s));
                assertEq(got, want, string.concat("first ", vm.toString(f), ", second ", vm.toString(s)));
                if (path != Path.Release) assertTrue(voucher.ownerOf(ID) != alice, "never to the borrower");
            }
        }
    }

    function test_R3_02_readMatrixTowardThePool_seize() public {
        _matrix(Path.Seize);
    }

    function test_R3_02_readMatrixTowardThePool_forwardVouchers() public {
        _matrix(Path.Forward);
    }

    function test_R3_02_readMatrixTowardTheBorrower_release() public {
        _matrix(Path.Release);
    }

    /// Other unreadable forms of the first read toward the pool: a revert and a non-canonical word.
    function test_R3_02_revertingAndNonCanonicalReadsKeepTheId() public {
        RigAgent a = _setup(Path.Forward);
        bytes memory q = abi.encodeCall(IRigVoucher.ownerOf, (ID));
        vm.mockCallRevert(address(voucher), q, "");
        a.forwardVouchers();
        assertEq(a.collateralOf().length, 1);
        vm.clearMockedCalls();
        vm.mockCall(address(voucher), q, abi.encode(uint256(type(uint160).max) + 1));
        a.forwardVouchers();
        assertEq(a.collateralOf().length, 1);
        vm.clearMockedCalls();
        a.forwardVouchers();
        assertEq(a.collateralOf().length, 0);
        assertEq(voucher.ownerOf(ID), address(pool));
    }

    // ───────────────────────── the seized-id record

    function test_R3_02_seizeRecordsEveryCollateralId() public {
        RigAgent a = _ready(alice, ID);
        _rig(alice, 8, 100);
        _pledge(a, alice, 8);
        _rig(alice, 9, 100);
        vm.prank(alice);
        voucher.transferFrom(alice, address(a), 9); // never registered
        _borrow(a, alice, 0, BEM);
        _flagged(a);
        assertFalse(a.wasSeized(ID));
        voucher.setBlocked(8, true);
        a.seize();
        assertTrue(a.wasSeized(ID), "moved id");
        assertTrue(a.wasSeized(8), "kept id");
        assertFalse(a.wasSeized(9), "an id that was never collateral");
        assertEq(voucher.ownerOf(ID), address(pool));
        assertEq(voucher.ownerOf(8), address(a));
        vm.prank(alice);
        a.withdrawVoucher(9); // not seized, so it can be withdrawn (SPEC §10.2)
        assertEq(voucher.ownerOf(9), alice);
    }

    function test_R3_02_withdrawVoucherOnAClosedAgent() public {
        RigAgent a = _ready(alice, ID);
        _rig(alice, 8, 100);
        _pledge(a, alice, 8);
        _borrow(a, alice, 0, BEM);
        _flagged(a);
        voucher.setBlocked(8, true);
        a.seize();
        // 1. a listed seized id: SeizedVoucher, before AgentClosed
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.SeizedVoucher.selector, 8));
        a.withdrawVoucher(8);
        // 2. a seized id the Safe moves from the pool back into the closed agent: unlisted, still refused
        vm.prank(address(pool));
        voucher.transferFrom(address(pool), address(a), ID);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.SeizedVoucher.selector, ID));
        a.withdrawVoucher(ID);
        a.forwardVouchers(); // retries only listed ids, so the returned voucher stays where the Safe put it
        assertEq(voucher.ownerOf(ID), address(a));
        // 3. a voucher sent by plain transfer after the seize was never collateral: it can be withdrawn
        _rig(alice, 9, 100);
        vm.prank(alice);
        voucher.transferFrom(alice, address(a), 9);
        vm.prank(alice);
        a.withdrawVoucher(9);
        assertEq(voucher.ownerOf(9), alice);
        // the kept id still reaches the pool once it can move
        voucher.setBlocked(8, false);
        a.forwardVouchers();
        assertEq(voucher.ownerOf(8), address(pool));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.SeizedVoucher.selector, 8));
        a.withdrawVoucher(8);
    }

    /// The Safe moves a kept seized voucher from the closed agent to a third party and back: it stays
    /// listed throughout and reaches the pool on the retry after it returns.
    function test_R3_02_keptIdSurvivesARoundTripThroughAThirdParty() public {
        RigAgent a = _setup(Path.Forward);
        vm.prank(address(a));
        voucher.transferFrom(address(a), third, ID);
        a.forwardVouchers();
        assertEq(a.collateralOf().length, 1, "held elsewhere: kept for retry");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.SeizedVoucher.selector, ID));
        a.withdrawVoucher(ID);
        vm.prank(third);
        voucher.transferFrom(third, address(a), ID);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.SeizedVoucher.selector, ID));
        a.withdrawVoucher(ID);
        a.forwardVouchers();
        assertEq(voucher.ownerOf(ID), address(pool));
        assertEq(a.collateralOf().length, 0);
    }

    /// An open agent is unaffected: no id is ever marked seized, so collateral and other vouchers can
    /// be withdrawn as before.
    function test_R3_02_openAgentWithdrawalsAreUnchanged() public {
        RigAgent a = _ready(alice, ID);
        assertFalse(a.wasSeized(ID));
        vm.prank(alice);
        a.withdrawVoucher(ID);
        assertEq(voucher.ownerOf(ID), alice);
    }
}

/// R3-02: `wasSeized` is written in the effects step, before the first external call of `seize`.
contract Redeploy3SeizedRecordOrderTest is HostileBase {
    function test_R3_02_wasSeizedIsSetBeforeTheFirstInteraction() public {
        (Probe p, RigAgent a) = _probeBorrower(ID);
        voucher.mint(address(p), ID2, 110);
        feed.set(_report(ID2, 100));
        p.exec(
            address(voucher),
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", address(p), address(a), ID2)
        );
        _probeBorrow(p, a, BEM);
        _toSeizeWindow(a, ID);
        bem.mint(address(a), BEM / 10); // so seize pays the pool before the write-off and the moves
        bem.observeSettlement(a);
        bem.setHook(p, address(a), HookBEM.When.BeforeFrom); // the pool's pull, the first transfer
        p.arm(address(a), abi.encodeWithSignature("wasSeized(uint256)", ID));
        p.arm(address(a), abi.encodeWithSignature("wasSeized(uint256)", ID2));
        vm.prank(keeper);
        a.seize();
        assertTrue(p.okAt(0) && p.okAt(1));
        assertTrue(abi.decode(p.resultAt(0), (bool)), "first id recorded before the pool call");
        assertTrue(abi.decode(p.resultAt(1), (bool)), "second id recorded before the pool call");
        assertTrue(p.seen().closed);
        assertEq(p.seen().collateralLen, 0);
    }
}
