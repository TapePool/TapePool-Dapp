// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base} from "./Base.t.sol";
import {TableFeedState, TableFeed, TableVoucher, TableAgent} from "./Redeploy3EvidenceTable.t.sol";
import {FeedEndpointStub} from "./RedeployFeed.t.sol";
import {MockCreditPolicy} from "../mocks/Mocks.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {TapePool} from "../../src/TapePool.sol";
import {AgentFactory} from "../../src/AgentFactory.sol";
import {RigFeedReceiver, Origin} from "../../src/feed/RigFeedReceiver.sol";
import {IRigFeed, RigReport} from "../../src/interfaces/IRigFeed.sol";
import {ITapePool} from "../../src/interfaces/ITapePool.sol";
import {IRigVoucher} from "../../src/interfaces/IXLayer.sol";

/// R4-08: a stale or insane non-impaired report masks older health on every collateral rig.
contract Redeploy4RowNTest is Base {
    uint256 constant A = 7;
    uint256 constant B = 8;
    bytes32 constant PEER = bytes32(uint256(1));
    RigFeedReceiver receiver;
    FeedEndpointStub endpoint;
    TableFeedState state;
    TableFeed reports;
    TableVoucher records;
    TableAgent table;

    function setUp() public override {
        super.setUp();
        endpoint = new FeedEndpointStub();
        receiver = new RigFeedReceiver(address(endpoint), address(this), 30102, address(bem));
        receiver.setPeer(30102, PEER);
        policy = new MockCreditPolicy(receiver, 1);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        factory = new AgentFactory(predicted, IRigVoucher(address(voucher)), IERC20(address(bem)), receiver);
        pool = new TapePool(IERC20(address(bem)), factory, policy, owner, guardian, lp);
        vm.prank(owner);
        pool.unpauseBorrows();
        state = new TableFeedState();
        reports = new TableFeed();
        records = new TableVoucher();
        table = new TableAgent(ITapePool(address(state)), IRigVoucher(address(records)), IRigFeed(address(reports)));
    }

    function _post(RigReport memory r) internal {
        RigReport[] memory batch = new RigReport[](1);
        batch[0] = r;
        vm.prank(address(endpoint));
        receiver.lzReceive(Origin(30102, PEER, 1), bytes32(0), abi.encode(batch), address(0), "");
        (RigReport memory stored, bool ok) = receiver.latest(r.rigId);
        assertTrue(ok);
        assertEq(abi.encode(stored), abi.encode(r), "receiver stored the replacement");
    }

    function _loan(bool pair) internal returns (RigAgent a) {
        _deposit(lp, 10 * BEM);
        a = _agent(alice, 0);
        _rig(alice, A, 100);
        _pledge(a, alice, A);
        _post(_report(A, 100));
        if (pair) {
            _rig(alice, B, 100);
            _pledge(a, alice, B);
            _post(_report(B, 100));
        }
        _borrow(a, alice, 0, BEM);
        vm.warp(block.timestamp + 61);
        RigReport memory r = _report(A, 100);
        r.observedAt = uint64(block.timestamp);
        r.custodied = false;
        _post(r);
        a.flagImpaired(A);
    }

    function _blocked(RigAgent a) internal {
        assertTrue(a.loanOf().expired, "row N clear checks only use expired flags");
        uint256 assets = pool.totalAssets();
        uint256 doubtful = pool.doubtful();
        uint256 room = pool.maxDeposit(lp);
        assertGt(doubtful, 0);
        assertEq(room, 0);
        vm.expectRevert(RigAgent.NoHealthEvidence.selector);
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), doubtful);
        assertEq(pool.totalAssets(), assets);
        assertEq(pool.maxDeposit(lp), room);
    }

    function _twoRig(bool insane) internal returns (RigAgent a, uint64 floor, RigReport memory r) {
        a = _loan(true);
        floor = a.seizeEvidenceFrom();
        voucher.setRig(A, floor, 110);
        vm.warp(floor + 1);
        r = _report(B, 100);
        r.observedAt = floor + 1;
        r.custodied = false;
        _post(r);
        r.observedAt = floor + 2;
        r.custodied = true;
        if (insane) {
            vm.warp(floor + 2); // fresh at delivery, but not sane
            r.totalVerifWeight = 0;
            _post(r);
        }
        vm.warp(pool.expiryOf(a.loanOf().impairedAt));
        if (!insane) {
            assertGt(block.timestamp, uint256(r.observedAt) + 300);
            _post(r); // stale at delivery; replaces B in the actual receiver
        }
    }

    function _recordMatrix(bool insane) internal {
        (RigAgent a, uint64 floor, RigReport memory r) = _twoRig(insane);
        if (insane) {
            _blocked(a);
            r.observedAt = uint64(block.timestamp);
            _post(r); // also isolate insanity while fresh at the expired clear
        }
        uint64[5] memory times = [floor - 1, floor, r.observedAt - 1, r.observedAt, r.observedAt + 1];
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < times.length; ++i) {
            if (i == 0) vm.mockCallRevert(address(voucher), abi.encodeCall(IRigVoucher.rigs, (B)), "");
            else voucher.setRig(B, times[i], 110);
            if (i == 0) {
                _blocked(a);
                vm.clearMockedCalls(); // A's positive record remains readable throughout
                voucher.setRig(B, floor - 1, 110);
                _blocked(a);
            } else if (times[i] <= r.observedAt) {
                _blocked(a);
            } else {
                a.clearExpiredFlag();
                assertEq(pool.doubtful(), 0, "strictly newer record resolves N");
            }
            vm.revertToState(snap);
            snap = vm.snapshotState();
        }
        _blocked(a);
        vm.warp(block.timestamp + 1);
        r.observedAt = uint64(block.timestamp);
        r.totalVerifWeight = NETWORK_WEIGHT;
        _post(r);
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0, "row H resolves N");
        assertGt(pool.maxDeposit(lp), 0);
    }

    function test_R4_08_twoRigStaleReplacementRecordMatrixAndRowHRecovery() public {
        _recordMatrix(false);
    }

    function test_R4_08_twoRigInsaneReplacementRecordMatrixAndRowHRecovery() public {
        _recordMatrix(true);
    }

    function _flagged(bool insane, bool tie, bool zero) internal {
        RigAgent a = _loan(false);
        uint64 floor = a.seizeEvidenceFrom();
        vm.warp(pool.expiryOf(a.loanOf().impairedAt));
        RigReport memory r = _report(A, 100);
        r.observedAt = insane ? uint64(block.timestamp) : floor + 2;
        if (insane) r.totalVerifWeight = 0;
        _post(r);
        voucher.setRig(A, tie ? r.observedAt : floor, zero ? 0 : 110);
        _blocked(a);
        voucher.setRig(A, r.observedAt + 1, 110);
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
    }

    function test_R4_08_flaggedStaleOverOlderPositiveRecord() public {
        _flagged(false, false, false);
    }

    function test_R4_08_flaggedStaleOverEqualPositiveRecord() public {
        _flagged(false, true, false);
    }

    function test_R4_08_flaggedInsaneOverOlderPositiveRecord() public {
        _flagged(true, false, false);
    }

    function test_R4_08_flaggedOlderZeroPowerRecordStillBlocks() public {
        _flagged(false, false, true);
    }

    function test_R4_08_rowNBoundariesAndRecordPrecedence() public {
        uint64 at = uint64(block.timestamp);
        uint64 floor = at - 1_000;
        RigReport memory r = _report(A, 100);
        r.observedAt = at;
        reports.set(r, true, false);
        records.set(false, 0, 0);
        vm.warp(uint256(at) + table.MAX_REPORT_AGE());
        assertEq(table.verdict(A, floor), 1, "H at age 300");
        vm.warp(block.timestamp + 1);
        assertEq(table.verdict(A, floor), 3, "N at age 301");
        state.set(false, at - 59);
        assertEq(table.verdict(A, floor), 3, "enableFloor - 1 stays U");
        state.set(true, 0);
        assertEq(table.verdict(A, floor), 3, "feed off stays U");
        state.set(false, 0);
        r.observedAt = uint64(block.timestamp + 60);
        r.totalVerifWeight = 0;
        reports.set(r, true, false);
        assertEq(table.verdict(A, floor), 3, "N at future +60 is admitted");
        r.observedAt++;
        reports.set(r, true, false);
        assertEq(table.verdict(A, floor), 0, "future +61 is no candidate");
        r.observedAt = floor - 1;
        reports.set(r, true, false);
        assertEq(table.verdict(A, floor), 0, "floor - 1 is no candidate");
        r.observedAt = floor;
        reports.set(r, true, false);
        assertEq(table.verdict(A, floor), 3, "N at floor");
        r.observedAt = at;
        reports.set(r, true, false);
        records.set(true, floor, 0);
        assertEq(table.verdict(A, floor), 2, "older zero record decides impaired");
        records.set(true, at, 110);
        assertEq(table.verdict(A, floor), 3, "positive tie leaves N");
        records.set(true, at + 1, 110);
        assertEq(table.verdict(A, floor), 1, "positive +1 resolves N");
    }

    function test_R4_08_staleSaneNShieldsButInsaneNDoesNot() public {
        uint64 floor = uint64(block.timestamp - 1_000);
        RigReport memory r = _report(A, 100);
        r.observedAt = floor + 2;
        records.set(true, floor, 0);
        reports.set(r, true, false);
        assertEq(table.verdict(A, floor), 2, "VC beats N");
        assertEq(table.evidenceKind(A, floor), 0, "stale sane N remains S");
        r.totalVerifWeight = 0;
        reports.set(r, true, false);
        assertEq(table.evidenceKind(A, floor), 2, "insane N is no shield");
        records.set(false, 0, 0);
        assertEq(table.evidenceKind(A, floor), 0, "N never flags or seizes");
    }

    function test_R4_08_expiredBeforeBrakeInsaneNDuringSettling() public {
        RigAgent a = _loan(false);
        uint64 floor = a.seizeEvidenceFrom();
        vm.warp(pool.expiryOf(a.loanOf().impairedAt));
        voucher.setRig(A, floor, 110);
        vm.prank(guardian);
        pool.disableFeed();
        vm.prank(owner);
        pool.enableFeed();
        uint64 enabled = pool.feedEnabledAt();
        vm.warp(uint256(enabled) + 60);
        RigReport memory r = _report(A, 100);
        r.observedAt = enabled + 60;
        r.totalVerifWeight = 0;
        _post(r);
        _blocked(a);
        vm.warp(uint256(enabled) + pool.FEED_SETTLE() - 1);
        assertLe(block.timestamp, uint256(r.observedAt) + a.MAX_REPORT_AGE(), "cannot be stale in settling");
        _blocked(a);
        r.observedAt = uint64(block.timestamp);
        r.totalVerifWeight = NETWORK_WEIGHT;
        _post(r);
        a.clearExpiredFlag();
        assertEq(pool.doubtful(), 0);
    }

    function test_R4_08_liveFlagCannotExpireDuringBrake() public {
        RigAgent a = _loan(false);
        vm.prank(guardian);
        pool.disableFeed();
        vm.warp(block.timestamp + 30 days);
        assertFalse(a.loanOf().expired);
        vm.expectRevert(RigAgent.FlagNotExpired.selector);
        a.clearExpiredFlag();
        vm.prank(owner);
        pool.enableFeed();
        assertFalse(a.loanOf().expired);
        vm.warp(pool.expiryOf(a.loanOf().impairedAt));
        assertTrue(a.loanOf().expired);
    }
}
