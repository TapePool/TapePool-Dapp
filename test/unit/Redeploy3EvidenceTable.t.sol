// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base} from "./Base.t.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {ITapePool} from "../../src/interfaces/ITapePool.sol";
import {IRigFeed, RigReport} from "../../src/interfaces/IRigFeed.sol";
import {IRigVoucher} from "../../src/interfaces/IXLayer.sol";

/// Plumbing for the table test: a pool's feed state, one stored report and one `rigs(id)` answer.
contract TableFeedState {
    bool public feedDisabled;
    uint64 public feedEnabledAt;

    function set(bool disabled, uint64 enabledAt) external {
        feedDisabled = disabled;
        feedEnabledAt = enabledAt;
    }
}

contract TableFeed is IRigFeed {
    RigReport internal _r;
    bool internal _ok;
    bool internal _reverts;

    function set(RigReport memory r, bool ok, bool reverts) external {
        _r = r;
        _ok = ok;
        _reverts = reverts;
    }

    function latest(uint256) external view returns (RigReport memory, bool) {
        require(!_reverts, "feed down");
        return (_r, _ok);
    }
}

contract TableVoucher {
    bool internal _readable;
    uint64 internal _syncedAt;
    uint256 internal _power;

    function set(bool readable, uint64 syncedAt, uint256 power) external {
        _readable = readable;
        _syncedAt = syncedAt;
        _power = power;
    }

    function rigs(uint256) external view returns (address, uint64, uint256, uint256) {
        if (!_readable) {
            assembly {
                mstore(0, 1)
                return(0, 0x20)
            }
        }
        return (address(0xC1C), _syncedAt, 0, _power);
    }
}

/// The real `RigAgent` evidence code, exposed so the test can drive any floor.
contract TableAgent is RigAgent {
    constructor(ITapePool pool_, IRigVoucher voucher_, IRigFeed feed_)
        RigAgent(pool_, voucher_, IERC20(address(0)), feed_)
    {}

    function evidenceKind(uint256 id, uint256 floor) external view returns (uint8) {
        return _impairment(id, floor, _feedState());
    }

    function verdict(uint256 id, uint256 floor) external view returns (uint8) {
        return _verdict(id, floor, _feedState());
    }
}

/// Redeploy 3, R3-08 item 2: table conformance. Fuzzes report and record fields, times, `feedDisabled`
/// and `feedEnabledAt`, and compares the agent's evidence kind and clear verdict with a reference model
/// written below from the R3-00 table alone. The harness exposes the agent's own internal functions;
/// two end-to-end fuzzes check that `flagImpaired` and `clearExpiredFlag` decide by the same rows.
contract Redeploy3EvidenceTableTest is Base {
    uint256 constant RIG = 7;
    uint256 constant MAX_REPORT_AGE = 300;
    uint256 constant MAX_CLOCK_SKEW = 60;

    /// One reading of rig `RIG` at time `now_`, with the caller's `floor`.
    struct In {
        uint64 now_;
        bool feedDisabled;
        uint64 feedEnabledAt;
        uint64 floor;
        bool ok;
        bool reverts;
        RigReport r;
        bool readable;
        uint64 syncedAt;
        uint256 power;
    }

    TableFeedState internal state;
    TableFeed internal tfeed;
    TableVoucher internal tvoucher;
    TableAgent internal agent;

    function setUp() public override {
        super.setUp();
        state = new TableFeedState();
        tfeed = new TableFeed();
        tvoucher = new TableVoucher();
        agent = new TableAgent(ITapePool(address(state)), IRigVoucher(address(tvoucher)), IRigFeed(address(tfeed)));
    }

    // ───────────────────────── the reference model (R3-00, nothing else)

    function _sat64(uint256 t) internal pure returns (uint256) {
        return t > type(uint64).max ? type(uint64).max : t;
    }

    /// base(r): ok (a revert reads as not ok), feed not disabled, the report is about the rig, and it is
    /// observed no later than now + MAX_CLOCK_SKEW.
    function _base(In memory x) internal pure returns (bool) {
        return x.ok && !x.reverts && !x.feedDisabled && x.r.rigId == RIG
            && uint256(x.r.observedAt) <= uint256(x.now_) + MAX_CLOCK_SKEW;
    }

    function _enableFloor(In memory x) internal pure returns (uint256) {
        return _sat64(uint256(x.feedEnabledAt) + MAX_CLOCK_SKEW);
    }

    function _impairedR(In memory x) internal pure returns (bool) {
        return x.r.status != 1 || x.r.stopBlock != 0 || !x.r.custodied || x.r.verifWeight <= x.r.bonus;
    }

    function _saneR(In memory x) internal pure returns (bool) {
        return x.r.verifWeight != 0 && x.r.verifWeight <= x.r.totalVerifWeight && x.r.bonus <= x.r.verifWeight;
    }

    function _freshR(In memory x) internal pure returns (bool) {
        return uint256(x.now_) <= uint256(x.r.observedAt) + MAX_REPORT_AGE;
    }

    function _known(In memory x) internal pure returns (bool) {
        return x.readable && uint256(x.syncedAt) <= uint256(x.now_) + MAX_CLOCK_SKEW;
    }

    function _rowE(In memory x) internal pure returns (bool) {
        return _base(x) && x.r.observedAt >= _enableFloor(x) && x.r.observedAt >= x.floor && _freshR(x) && _impairedR(x);
    }

    function _rowS(In memory x) internal pure returns (bool) {
        return
            _base(x) && x.r.observedAt >= _enableFloor(x) && x.r.observedAt > x.syncedAt && _saneR(x) && !_impairedR(x);
    }

    function _rowVE(In memory x) internal pure returns (bool) {
        return _known(x) && x.power == 0 && x.syncedAt >= x.floor && !_rowS(x);
    }

    function _rowH(In memory x) internal pure returns (bool) {
        return _base(x) && x.r.observedAt >= _enableFloor(x) && x.r.observedAt >= x.floor && _freshR(x) && _saneR(x)
            && !_impairedR(x);
    }

    function _rowB(In memory x) internal pure returns (bool) {
        return _base(x) && x.r.observedAt >= x.floor && _impairedR(x);
    }

    /// Row U (v4): a report that is not impaired, at or after the floor, below the enable floor.
    function _rowU(In memory x) internal pure returns (bool) {
        return _base(x) && x.r.observedAt >= x.floor && x.r.observedAt < _enableFloor(x) && !_impairedR(x);
    }

    function _rowVC(In memory x) internal pure returns (bool) {
        return _known(x) && x.syncedAt >= x.floor;
    }

    /// Flag and seize: kind 1 for row E (checked first), kind 2 for row VE, else 0.
    function _refKind(In memory x) internal pure returns (uint8) {
        if (_rowE(x)) return 1;
        if (_rowVE(x)) return 2;
        return 0;
    }

    /// Clear: the newest candidate among the report (row H healthy, row B impaired, row U unknown) and
    /// the record (row VC); impairment wins a tie; no candidate is missing (0). Unknown masks only
    /// health: under row U a power-0 record is impaired at any age (v5, L-04), a positive record decides
    /// only when synced after the report, and otherwise the rig reads as missing.
    function _refVerdict(In memory x) internal pure returns (uint8) {
        if (_rowU(x)) {
            if (x.power == 0 && _rowVC(x)) return 2;
            if (!_rowVC(x) || x.syncedAt < x.r.observedAt) return 0;
            if (x.syncedAt > x.r.observedAt) return x.power == 0 ? 2 : 1;
            return x.power == 0 ? 2 : 0;
        }
        bool rep = _rowH(x) || _rowB(x);
        bool rec = _rowVC(x);
        uint8 repV = _rowB(x) ? 2 : 1;
        uint8 recV = x.power == 0 ? 2 : 1;
        if (!rep && !rec) return 0;
        if (!rec) return repV;
        if (!rep) return recV;
        if (x.r.observedAt > x.syncedAt) return repV;
        if (x.syncedAt > x.r.observedAt) return recV;
        return repV == 2 || recV == 2 ? 2 : 1;
    }

    // ───────────────────────── input generator, biased to the row boundaries

    function _next(uint256 x) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(x)));
    }

    function _clamp(int256 t) internal pure returns (uint64) {
        if (t < 0) return 0;
        if (t > int256(uint256(type(uint64).max))) return type(uint64).max;
        return uint64(uint256(t));
    }

    function _pick(uint256 x, int256[8] memory anchors) internal pure returns (uint64) {
        int256 jitter = int256(_next(x) % 5) - 2; // -2 .. +2
        if (_next(x + 1) % 6 == 0) jitter = int256(_next(x + 2) % 100_000) - 50_000;
        return _clamp(anchors[x % 8] + jitter);
    }

    /// Fill the report and the record around `x.now_`, `x.floor` and the enable floor.
    function _fill(In memory x, uint256 seed) internal pure {
        uint256 s = _next(seed);
        int256 nowI = int256(uint256(x.now_));
        int256 fl = int256(uint256(x.floor));
        int256 ef = int256(_enableFloor(x));
        x.ok = s % 8 != 0;
        s = _next(s);
        x.reverts = s % 16 == 0;
        s = _next(s);
        x.readable = s % 8 != 0;
        s = _next(s);
        x.power = s % 2 == 0 ? 0 : 1 + _next(s) % 1_000;
        s = _next(s);
        x.syncedAt = _pick(s, [fl, fl - 1, nowI + 60, nowI + 61, ef, nowI - 300, nowI, nowI - 3_600]);
        s = _next(s);
        int256 sy = int256(uint256(x.syncedAt));
        x.r.observedAt = _pick(s, [fl, ef, nowI + 60, nowI - 300, sy + 1, sy, nowI, nowI - 3_600]);
        s = _next(s);
        if (s % 4 == 0) x.syncedAt = _clamp(int256(uint256(x.r.observedAt)) + int256(_next(s) % 3) - 1);
        s = _next(s);
        x.r.rigId = uint64(s % 10 == 0 ? RIG + 1 : RIG);
        s = _next(s);
        uint8[5] memory statuses = [uint8(1), 1, 1, 2, 0];
        x.r.status = statuses[s % 5];
        s = _next(s);
        x.r.stopBlock = s % 6 == 0 ? uint64(1 + _next(s) % 1_000) : 0;
        s = _next(s);
        x.r.custodied = s % 6 != 0;
        s = _next(s);
        x.r.bonus = uint64(s % 20);
        s = _next(s);
        uint64[5] memory weights = [uint64(0), x.r.bonus, x.r.bonus + 1, x.r.bonus + 100, uint64(_next(s) % 2_000)];
        x.r.verifWeight = weights[s % 5];
        s = _next(s);
        uint64[4] memory totals = [x.r.verifWeight, x.r.verifWeight == 0 ? 0 : x.r.verifWeight - 1, 1_579_201, 5];
        x.r.totalVerifWeight = totals[s % 4];
        x.r.circuits = address(0xC1C);
    }

    function _harnessCase(uint256 seed) internal pure returns (In memory x) {
        uint256 s = _next(seed);
        x.now_ = uint64(1_800_000_000 + s % 1_000_000);
        s = _next(s);
        x.feedDisabled = s % 5 == 0;
        s = _next(s);
        uint256 e = s % 4;
        s = _next(s);
        if (e == 1) x.feedEnabledAt = uint64(x.now_ - s % 400);
        else if (e == 2) x.feedEnabledAt = uint64(x.now_ - s % 1_000_000);
        else if (e == 3) x.feedEnabledAt = uint64(x.now_ + s % 120);
        s = _next(s);
        uint256 f = s % 5;
        s = _next(s);
        if (f == 0) x.floor = uint64(x.now_ - s % 400);
        else if (f == 1) x.floor = uint64(x.now_ - 1 days + s % 600);
        else if (f == 2) x.floor = uint64(x.now_ + s % 120);
        else if (f == 3) x.floor = uint64(s % (uint256(x.now_) + 1));
        _fill(x, s);
    }

    function _load(In memory x) internal {
        vm.warp(x.now_);
        state.set(x.feedDisabled, x.feedEnabledAt);
        tfeed.set(x.r, x.ok, x.reverts);
        tvoucher.set(x.readable, x.syncedAt, x.power);
    }

    /// forge-config: default.fuzz.runs = 5000
    function testFuzz_R3_08_harnessMatchesTheTable(uint256 seed) public {
        In memory x = _harnessCase(seed);
        _load(x);
        assertEq(agent.evidenceKind(RIG, x.floor), _refKind(x), "evidence kind");
        assertEq(agent.verdict(RIG, x.floor), _refVerdict(x), "clear verdict");
    }

    /// Which parts of the table a fixed set of cases reaches.
    struct Seen {
        uint256[3] kinds;
        uint256[3] verdicts;
        uint256 shield; // row S stops an otherwise valid row VE
        uint256 staleB; // row B older than MAX_REPORT_AGE
        uint256 brakeB; // row B below the enable floor
        uint256 tie; // a report candidate and a record candidate at the same second
        uint256 enableEdge; // observedAt at the enable floor or one below, with base(r)
        uint256 floorEdge; // observedAt or syncedAt at the floor or one below
        uint256 futureRecord; // syncedAt one or more seconds past now + MAX_CLOCK_SKEW
        uint256 maskOlder; // row U over an older positive row VC record: missing
        uint256 maskOlderZero; // row U over an older power-0 row VC record: impaired (L-04)
        uint256 maskTie; // row U and a row VC record at the same second
        uint256 maskNewer; // row U and a row VC record synced after it: the record decides
    }

    function _see(Seen memory c, In memory x, uint8 kind, uint8 v) internal pure {
        ++c.kinds[kind];
        ++c.verdicts[v];
        if (_rowS(x) && _known(x) && x.power == 0 && x.syncedAt >= x.floor) ++c.shield;
        if (_rowB(x) && !_freshR(x)) ++c.staleB;
        if (_rowB(x) && x.r.observedAt < _enableFloor(x)) ++c.brakeB;
        if ((_rowH(x) || _rowB(x)) && _rowVC(x) && x.r.observedAt == x.syncedAt) ++c.tie;
        uint256 ef = _enableFloor(x);
        if (_base(x) && (x.r.observedAt == ef || uint256(x.r.observedAt) + 1 == ef)) ++c.enableEdge;
        if (
            x.r.observedAt == x.floor || uint256(x.r.observedAt) + 1 == x.floor || x.syncedAt == x.floor
                || uint256(x.syncedAt) + 1 == x.floor
        ) ++c.floorEdge;
        if (x.readable && uint256(x.syncedAt) > uint256(x.now_) + MAX_CLOCK_SKEW) ++c.futureRecord;
        if (_rowU(x) && _rowVC(x)) {
            if (x.syncedAt < x.r.observedAt && x.power == 0) ++c.maskOlderZero;
            else if (x.syncedAt < x.r.observedAt) ++c.maskOlder;
            else if (x.syncedAt == x.r.observedAt) ++c.maskTie;
            else ++c.maskNewer;
        }
    }

    /// The model and the harness agree on 2,000 fixed cases, and those cases reach every outcome and
    /// every boundary class of the table.
    function test_R3_08_harnessMatchesTheTableOnFixedCases() public {
        Seen memory c;
        for (uint256 i; i < 2_000; ++i) {
            In memory x = _harnessCase(uint256(keccak256(abi.encode("r3-00 table", i))));
            _load(x);
            uint8 kind = agent.evidenceKind(RIG, x.floor);
            uint8 v = agent.verdict(RIG, x.floor);
            assertEq(kind, _refKind(x), string.concat("kind, case ", vm.toString(i)));
            assertEq(v, _refVerdict(x), string.concat("verdict, case ", vm.toString(i)));
            _see(c, x, kind, v);
        }
        for (uint256 k; k < 3; ++k) {
            assertGt(c.kinds[k], 20, "every evidence kind is reached");
            assertGt(c.verdicts[k], 20, "every verdict is reached");
        }
        assertGt(c.shield, 5, "row S shields");
        assertGt(c.staleB, 5, "stale row B");
        assertGt(c.brakeB, 5, "row B below the enable floor");
        assertGt(c.tie, 5, "ties");
        assertGt(c.enableEdge, 5, "enable floor edges");
        assertGt(c.floorEdge, 20, "floor edges");
        assertGt(c.futureRecord, 5, "future-dated records");
        assertGt(c.maskOlder, 5, "row U masks an older positive record");
        assertGt(c.maskOlderZero, 2, "an older power-0 record blocks under row U");
        assertGt(c.maskTie, 2, "row U ties with a record");
        assertGt(c.maskNewer, 5, "a record newer than row U decides");
    }

    // ───────────────────────── end to end: flagImpaired and clearExpiredFlag

    bytes32 constant FLAGGED_SIG = keccak256("ImpairmentFlagged(address,uint256,uint8,uint64)");

    /// Put the generated reading into the real mock feed and voucher of the Base stack.
    function _post(In memory x) internal {
        if (x.ok) feed.setAt(RIG, x.r);
        else feed.clear(RIG);
        feed.setBroken(x.reverts);
        voucher.setBadRigs(!x.readable);
        voucher.setRig(RIG, x.syncedAt, x.power);
    }

    /// The live stack's feed state as the model's input.
    function _live(In memory x, uint64 floor) internal view {
        x.now_ = uint64(block.timestamp);
        x.feedDisabled = pool.feedDisabled();
        x.feedEnabledAt = pool.feedEnabledAt();
        x.floor = floor;
    }

    /// An optional brake before the loan, so `feedEnabledAt` moves; the loan opens after the settle.
    function _loanAfterOptionalBrake(uint256 seed) internal returns (RigAgent a) {
        a = _ready(alice, RIG);
        if (seed % 2 == 0) {
            vm.prank(guardian);
            pool.disableFeed();
            vm.warp(block.timestamp + 1 + seed % 1 days);
            vm.prank(owner);
            pool.enableFeed();
            vm.warp(block.timestamp + pool.FEED_SETTLE() + (seed >> 8) % 600);
        }
        _refresh(RIG, 100);
        _borrow(a, alice, 0, BEM);
        vm.warp(block.timestamp + (seed >> 16) % 2 hours);
    }

    function testFuzz_R3_08_flagImpairedMatchesTheTable(uint256 seed) public {
        RigAgent a = _loanAfterOptionalBrake(seed);
        if ((seed >> 32) % 6 == 0) {
            vm.prank(guardian);
            pool.disableFeed();
        }
        In memory x;
        _live(x, a.flagEvidenceFrom());
        _fill(x, seed);
        _post(x);
        uint8 want = _refKind(x);
        vm.recordLogs();
        (bool ok,) = address(a).call(abi.encodeCall(RigAgent.flagImpaired, (RIG)));
        assertEq(ok, want != 0, "flag allowed exactly when the table finds evidence");
        if (ok) {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            uint8 kind;
            for (uint256 i; i < logs.length; ++i) {
                if (logs[i].emitter == address(a) && logs[i].topics[0] == FLAGGED_SIG) {
                    (kind,) = abi.decode(logs[i].data, (uint8, uint64));
                }
            }
            assertEq(kind, want, "evidence kind");
        }
    }

    function testFuzz_R3_08_clearExpiredFlagMatchesTheTable(uint256 seed) public {
        RigAgent a = _ready(alice, RIG);
        _borrow(a, alice, 0, BEM);
        vm.warp(block.timestamp + 1 hours);
        feed.set(_rescuedReport(RIG));
        a.flagImpaired(RIG);
        vm.warp(pool.expiryOf(a.loanOf().impairedAt) + seed % 3 days);
        uint256 brake = (seed >> 8) % 3;
        if (brake != 0) {
            vm.prank(guardian);
            pool.disableFeed(); // an expired flag stays expired
            vm.warp(block.timestamp + 1 + (seed >> 16) % 1 hours);
            if (brake == 2) {
                vm.prank(owner);
                pool.enableFeed();
                vm.warp(block.timestamp + (seed >> 24) % 900);
            }
        }
        assertTrue(a.loanOf().expired);
        In memory x;
        _live(x, a.seizeEvidenceFrom());
        _fill(x, seed);
        _post(x);
        uint8 want = _refVerdict(x);
        (bool ok,) = address(a).call(abi.encodeCall(RigAgent.clearExpiredFlag, ()));
        assertEq(ok, want == 1, "clear allowed exactly when the flagged rig's newest candidate is healthy");
        assertEq(pool.doubtful() == 0, want == 1);
    }
}
