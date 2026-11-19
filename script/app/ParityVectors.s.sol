// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICreditPolicy, Reasons} from "../../src/interfaces/ICreditPolicy.sol";
import {ITapePool, IAgentFactory} from "../../src/interfaces/ITapePool.sol";
import {IRigFeed, RigReport} from "../../src/interfaces/IRigFeed.sol";
import {IRigVoucher} from "../../src/interfaces/IXLayer.sol";
import {TapePool} from "../../src/TapePool.sol";
import {TapeLens} from "../../src/TapeLens.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {CreditMath} from "../../src/libraries/CreditMath.sol";
import {BscRigReader} from "../../src/feed/BscRigReader.sol";
import {IRigVaultBsc, IPodMining, Miner} from "../../src/interfaces/IBsc.sol";

/// Stand-ins for the contracts the pool's constructor probes. They hold no logic the vectors depend on.
contract VecBem is ERC20 {
    constructor() ERC20("BEM", "BEM") {}

    function decimals() public pure override returns (uint8) {
        return 8;
    }
}

contract VecFactory is IAgentFactory {
    address public bem;

    constructor(address bem_) {
        bem = bem_;
    }

    /// Called by the pool from its own constructor, so the caller is the pool.
    function pool() external view returns (address) {
        return msg.sender;
    }

    function borrowerOf(address) external pure returns (address) {
        return address(0);
    }
}

contract VecPolicy is ICreditPolicy {
    function version() external pure returns (uint16) {
        return 1;
    }

    function check(address, uint256[] calldata, uint8, uint256) external pure returns (bool, uint8, uint16, uint256) {
        return (false, Reasons.BAD_IDS, 0, 0);
    }

    function maxDebt(address, uint256[] calldata, uint8) external pure returns (uint256) {
        return 0;
    }
}

/// Stand-ins for the evidence vectors (SPEC-REDEPLOY-3 R3-00): a pool's feed state, one stored report and one
/// `rigs(id)` answer, each set per vector.
contract VecFeedState {
    function expiryOf(uint64) external pure returns (uint64) {
        return 1;
    }
    function clearDoubtful() external pure {}
    bool public feedDisabled;
    uint64 public feedEnabledAt;

    function set(bool disabled, uint64 enabledAt) external {
        feedDisabled = disabled;
        feedEnabledAt = enabledAt;
    }
}

contract VecFeed is IRigFeed {
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

contract VecVoucher {
    bool internal _readable;
    uint64 internal _syncedAt;
    uint256 internal _power;

    function set(bool readable, uint64 syncedAt, uint256 power) external {
        _readable = readable;
        _syncedAt = syncedAt;
        _power = power;
    }

    /// An unreadable record answers with one word, like a voucher whose ABI changed.
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

/// The real `RigAgent` evidence code (`_impairment` and `_verdict`), exposed for the vectors only.
contract VecAgent is RigAgent {
    constructor(ITapePool pool_, IRigVoucher voucher_, IRigFeed feed_)
        RigAgent(pool_, voucher_, IERC20(address(0)), feed_)
    {}

    /// Seed an expired two-rig flag; the production clear predicate still decides its outcome.
    function preparePair(uint64 flaggedAt) external {
        delete _collateral;
        _collateral.push(7);
        _collateral.push(8);
        _loan.start = flaggedAt;
        _loan.impairedAt = flaggedAt;
        _loan.impairedRig = 8;
    }

    /// Evidence kind for a flag or a seize with the caller's floor: 0 none, 1 row E, 2 row VE.
    function evidenceKind(uint256 id, uint256 floor) external view returns (uint8) {
        return _impairment(id, floor, _feedState());
    }

    /// Clear verdict with the clear floor: 0 missing, 1 healthy, 2 impaired, 3 unknown (R4-00).
    function verdict(uint256 id, uint256 floor) external view returns (uint8) {
        return _verdict(id, floor, _feedState());
    }
}

/// @notice Parity vectors for the app's TypeScript ports (SPEC-PHASE5-APP §5.3). Computes cases from the real
///         `CreditMath` library, the real `TapePool.fee` and the real `TapeLens.principalFor`, and prints one JSON
///         object per line behind a `VEC ` marker. `app/scripts/gen-vectors.mjs` runs it and stores the lines as
///         app/test/vectors/*.json. It reads no chain and sends nothing:
///
///             forge script script/app/ParityVectors.s.sol:ParityVectors
///
///         Redeploy 3 (R3-07) appends `evidence` vectors: one per boundary of each R3-00 row, computed by the real
///         `RigAgent` evidence code, for the keeper's and the app's mirrors (Parts B and C).
contract ParityVectors is Script {
    uint256 internal constant BPS = 10_000;
    uint256 internal seed = uint256(keccak256("tapepool-parity-v1"));
    uint256 internal n;

    TapePool internal pool;
    TapeLens internal lens;
    address internal owner = address(0x0A11CE);
    address internal guardian = address(0x0B0B);

    function run() external {
        VecBem bem = new VecBem();
        VecFactory factory = new VecFactory(address(bem));
        VecPolicy policy = new VecPolicy();
        pool = new TapePool(
            IERC20(address(bem)),
            IAgentFactory(address(factory)),
            ICreditPolicy(address(policy)),
            owner,
            guardian,
            owner
        );
        lens = new TapeLens();

        _expectedOutput();
        _maxDebt();
        _debtBucket();

        // the launch values first, then the bounds of each parameter, then some values between
        _fees(75, 150, 300_000);
        _fees(25, 50, 100_000);
        _fees(300, 600, 10_000_000);
        _fees(100, 200, 150_000);
        _fees(250, 333, 9_999_999);

        // appended last, so every earlier vector stays byte for byte as before
        _evidence();
        _brakeVectors();
        _bonusVectors();
        _rowN();
        _rowNPairs();
    }

    // ───────────────────────── CreditMath

    function _expectedOutput() internal {
        for (uint8 term; term < 2; ++term) {
            _eo(0, 0, term);
            _eo(0, 1_000, term);
            _eo(1, 1, term);
            _eo(1, 0, term);
            _eo(1_579_201, 1_579_201, term); // the whole network
            _eo(1, 1_579_201, term);
            _eo(20, 1_579_201, term); // a 20 H rig
            _eo(type(uint64).max, type(uint64).max, term);
            _eo(type(uint64).max, 1, term);
            _eo(1, type(uint64).max, term);
            // the rounding edges: for an output of k raw units, the smallest base that reaches it and the one below
            uint256[5] memory totals = [uint256(1_579_201), 1, 1_000_000_007, 2 ** 40 + 1, type(uint64).max];
            uint256[5] memory ks = [uint256(1), 2, 1_000, 123_456_789, 4_900_000_000_000];
            uint256 num = CreditMath.VERIF_EMISSION_PER_DAY * CreditMath.termDays(term) * CreditMath.dilutionBps(term)
                * CreditMath.BRIDGE_KEEP_BPS;
            for (uint256 j; j < totals.length; ++j) {
                uint256 denom = totals[j] * BPS * BPS;
                for (uint256 k; k < ks.length; ++k) {
                    uint256 base = (ks[k] * denom + num - 1) / num; // ceil(k x denom / num)
                    if (base > 1) _eo(base - 1, totals[j], term);
                    _eo(base, totals[j], term);
                }
            }
            for (uint256 i; i < 20; ++i) {
                uint256 total = 1 + _rnd(2 ** (8 + _rnd(40)));
                _eo(_rnd(total + 1), total, term);
            }
        }
    }

    function _eo(uint256 base, uint256 total, uint8 term) internal {
        _emit(
            string.concat(
                '{"k":"expectedOutput","base":"',
                vm.toString(base),
                '","total":"',
                vm.toString(total),
                '","term":',
                vm.toString(uint256(term)),
                ',"out":"',
                vm.toString(CreditMath.expectedOutput(base, total, term)),
                '"}'
            )
        );
    }

    function _maxDebt() internal {
        uint256[12] memory fixedExpected =
            [uint256(0), 1, 2, 3, 9_999, 10_000, 10_001, 12_345_678, 1e12, 2 ** 64, 2 ** 128, 2 ** 200];
        for (uint8 term; term < 2; ++term) {
            for (uint256 i; i < fixedExpected.length; ++i) {
                _md(fixedExpected[i], term);
            }
            for (uint256 i; i < 10; ++i) {
                _md(_rnd(2 ** (4 + _rnd(60))), term);
            }
        }
    }

    function _md(uint256 expected, uint8 term) internal {
        _emit(
            string.concat(
                '{"k":"maxDebt","expected":"',
                vm.toString(expected),
                '","term":',
                vm.toString(uint256(term)),
                ',"out":"',
                vm.toString(CreditMath.maxDebt(expected, term)),
                '"}'
            )
        );
    }

    function _debtBucket() internal {
        _db(0, 0);
        _db(1, 0);
        _db(0, 1);
        _db(1, 1);
        _db(type(uint256).max, 1);
        _db(type(uint256).max, type(uint256).max);
        // the overflow guard: one above max/BPS saturates whatever `expected` is
        uint256 guard = type(uint256).max / BPS;
        _db(guard, type(uint256).max);
        _db(guard + 1, type(uint256).max);
        _db(guard, 2 ** 255);
        _db(guard + 1, 2 ** 255);
        // exact multiples of 5% of expected, the unit above and the unit below
        uint256[2] memory exps = [uint256(20_000), 7_777_777_777];
        for (uint256 e; e < exps.length; ++e) {
            for (uint256 k; k <= 33; ++k) {
                uint256 edge = exps[e] * 500 * k / BPS; // k x 5%
                _db(edge, exps[e]);
                if (edge > 0) _db(edge - 1, exps[e]);
                _db(edge + 1, exps[e]);
            }
        }
        for (uint256 i; i < 20; ++i) {
            uint256 expected = 1 + _rnd(2 ** (6 + _rnd(50)));
            _db(_rnd(expected * 2), expected);
        }
    }

    function _db(uint256 debt, uint256 expected) internal {
        _emit(
            string.concat(
                '{"k":"debtBucket","debt":"',
                vm.toString(debt),
                '","expected":"',
                vm.toString(expected),
                '","out":',
                vm.toString(uint256(CreditMath.debtBucket(debt, expected))),
                "}"
            )
        );
    }

    // ───────────────────────── TapePool.fee and TapeLens.principalFor

    function _fees(uint256 bps7, uint256 bps14, uint256 minFee_) internal {
        _setParams(bps7, bps14, minFee_);
        for (uint8 term; term < 2; ++term) {
            uint256 bps = term == 0 ? bps7 : bps14;
            uint256 cross = minFee_ * BPS / bps; // about where the rate overtakes the minimum fee
            uint256[16] memory ps = [
                uint256(0),
                1,
                999,
                1_000_000,
                10_000_000,
                100_000_000,
                1_000_000_000,
                123_456_789_012,
                cross == 0 ? 1 : cross - 1,
                cross,
                cross + 1,
                cross + BPS / bps,
                minFee_ - 1,
                minFee_,
                minFee_ + 1,
                2 ** 100
            ];
            for (uint256 i; i < ps.length; ++i) {
                _fee(term, ps[i]);
            }
            for (uint256 i; i < 4; ++i) {
                _fee(term, _rnd(2 ** (8 + _rnd(40))));
            }
            uint256[12] memory ls = [
                uint256(0),
                1,
                minFee_ - 1,
                minFee_,
                minFee_ + 1,
                minFee_ + 2,
                cross + minFee_,
                cross + minFee_ + 1,
                cross + minFee_ - 1,
                1_000_000_000,
                123_456_789_012,
                10 ** 15
            ];
            for (uint256 i; i < ls.length; ++i) {
                _pf(term, ls[i]);
            }
            for (uint256 i; i < 6; ++i) {
                _pf(term, _rnd(2 ** (6 + _rnd(44))));
            }
        }
    }

    function _setParams(uint256 bps7, uint256 bps14, uint256 minFee_) internal {
        vm.startPrank(owner);
        pool.queueParam(TapePool.Param.FeeBps7d, bps7);
        pool.queueParam(TapePool.Param.FeeBps14d, bps14);
        pool.queueParam(TapePool.Param.MinFee, minFee_);
        vm.stopPrank();
        vm.warp(block.timestamp + pool.TIMELOCK());
        pool.executeParam(TapePool.Param.FeeBps7d);
        pool.executeParam(TapePool.Param.FeeBps14d);
        pool.executeParam(TapePool.Param.MinFee);
        require(pool.feeBps7d() == bps7 && pool.feeBps14d() == bps14 && pool.minFee() == minFee_, "params not applied");
    }

    function _fee(uint8 term, uint256 principal) internal {
        _emit(
            string.concat(
                '{"k":"fee","feeBps7d":',
                vm.toString(pool.feeBps7d()),
                ',"feeBps14d":',
                vm.toString(pool.feeBps14d()),
                ',"minFee":"',
                vm.toString(pool.minFee()),
                '","term":',
                vm.toString(uint256(term)),
                ',"principal":"',
                vm.toString(principal),
                '","out":"',
                vm.toString(pool.fee(term, principal)),
                '"}'
            )
        );
    }

    function _pf(uint8 term, uint256 debtLimit) internal {
        _emit(
            string.concat(
                '{"k":"principalFor","feeBps7d":',
                vm.toString(pool.feeBps7d()),
                ',"feeBps14d":',
                vm.toString(pool.feeBps14d()),
                ',"minFee":"',
                vm.toString(pool.minFee()),
                '","term":',
                vm.toString(uint256(term)),
                ',"debtLimit":"',
                vm.toString(debtLimit),
                '","out":"',
                vm.toString(lens.principalFor(ITapePool(address(pool)), term, debtLimit)),
                '"}'
            )
        );
    }

    // ───────────────────────── R3-00 evidence admissibility (redeploy 3)

    struct Case {
        string row;
        string name;
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

    uint256 internal constant RIG = 7;
    uint64 internal constant T = 1_800_000_000;
    uint64 internal constant F = T - 1 days;

    VecFeedState internal state;
    VecFeed internal feed;
    VecVoucher internal voucher;
    VecAgent internal agent;

    /// A healthy, sane, fresh report of rig 7, observed 10 s ago, with no brake and the caller's floor a day
    /// back; the voucher record is positive and older than the floor (not a candidate).
    function _dflt(string memory row, string memory name) internal pure returns (Case memory c) {
        c.row = row;
        c.name = name;
        c.now_ = T;
        c.floor = F;
        c.ok = true;
        c.r.rigId = uint64(RIG);
        c.r.circuitId = uint64(RIG + 1000);
        c.r.circuits = address(0xC1C);
        c.r.observedAt = T - 10;
        c.r.status = 1;
        c.r.custodied = true;
        c.r.verifWeight = 110;
        c.r.bonus = 10;
        c.r.totalVerifWeight = 1_579_201;
        c.r.bscBlock = 1;
        c.r.taskId = 4;
        c.readable = true;
        c.syncedAt = F - 1 days;
        c.power = 110;
    }

    function _impaired(Case memory c) internal pure returns (Case memory) {
        c.r.status = 2; // revoked
        return c;
    }

    function _evidence() internal {
        state = new VecFeedState();
        feed = new VecFeed();
        voucher = new VecVoucher();
        agent = new VecAgent(ITapePool(address(state)), IRigVoucher(address(voucher)), IRigFeed(address(feed)));
        _rowE();
        _rowVE();
        _rowS();
        _rowH();
        _rowB();
        _rowVC();
        _rowU(); // SPEC-REDEPLOY-3 v4, appended so the earlier evidence vectors keep their order
    }

    /// Row U: a report that is not impaired, observed below the enable floor, masks every older healthy
    /// reading in a clear; an older power-0 record still blocks (v5, L-04). The enable floor is `T - 40`;
    /// the record is positive and at the floor unless stated.
    function _rowU() internal {
        Case memory c = _dflt("U", "healthy report at enableFloor - 1 over an older positive record");
        c.feedEnabledAt = T - 100;
        c.syncedAt = F;
        c.r.observedAt = T - 41;
        _ev(c);
        c.name = "healthy report at enableFloor over an older positive record (row H)";
        c.r.observedAt = T - 40;
        _ev(c);
        c.name = "insane report at enableFloor - 1 (still row U)";
        c.r.observedAt = T - 41;
        c.r.totalVerifWeight = 1;
        _ev(c);
        c = _dflt("U", "positive record at the report's second (tie)");
        c.feedEnabledAt = T - 100;
        c.r.observedAt = T - 41;
        c.syncedAt = T - 41;
        _ev(c);
        c.name = "power-0 record at the report's second (tie)";
        c.power = 0;
        _ev(c);
        c.name = "power-0 record one second after the report";
        c.syncedAt = T - 40;
        _ev(c);
        c.name = "positive record one second after the report";
        c.power = 110;
        _ev(c);
        c = _dflt("U", "no record candidate");
        c.feedEnabledAt = T - 100;
        c.r.observedAt = T - 41;
        _ev(c);
        c.name = "report before the floor is no candidate";
        c.floor = T - 40;
        c.syncedAt = T - 40;
        c.r.observedAt = T - 41;
        _ev(c);
        c = _dflt("U", "feed disabled: row U masks the older positive record");
        c.feedDisabled = true;
        c.feedEnabledAt = T - 100;
        c.syncedAt = F;
        c.r.observedAt = T - 41;
        _ev(c);
        // v5 (L-04), appended so every earlier vector keeps its order
        c = _dflt("U", "power-0 record older than the report");
        c.feedEnabledAt = T - 100;
        c.syncedAt = F;
        c.power = 0;
        c.r.observedAt = T - 41;
        _ev(c);
    }

    /// Row E: flag or seize evidence from an impaired report.
    function _rowE() internal {
        Case memory c = _impaired(_dflt("E", "impaired fresh report"));
        _ev(c);
        c = _impaired(_dflt("E", "observedAt = enableFloor - 1"));
        c.feedEnabledAt = T - 100;
        c.r.observedAt = T - 41;
        _ev(c);
        c.name = "observedAt = enableFloor";
        c.r.observedAt = T - 40;
        _ev(c);
        c = _impaired(_dflt("E", "observedAt = floor - 1"));
        c.floor = T - 100;
        c.r.observedAt = T - 101;
        _ev(c);
        c.name = "observedAt = floor";
        c.r.observedAt = T - 100;
        _ev(c);
        c = _impaired(_dflt("E", "age 300"));
        c.r.observedAt = T - 300;
        _ev(c);
        c.name = "age 301";
        c.r.observedAt = T - 301;
        _ev(c);
        c = _impaired(_dflt("E", "observedAt = now + 60"));
        c.r.observedAt = T + 60;
        _ev(c);
        c.name = "observedAt = now + 61";
        c.r.observedAt = T + 61;
        _ev(c);
        c = _impaired(_dflt("E", "report of another rig"));
        c.r.rigId = uint64(RIG + 1);
        _ev(c);
        c = _impaired(_dflt("E", "no report (ok false)"));
        c.ok = false;
        _ev(c);
        c = _impaired(_dflt("E", "feed reverts"));
        c.reverts = true;
        _ev(c);
        c = _impaired(_dflt("E", "feed disabled"));
        c.feedDisabled = true;
        _ev(c);
        c = _dflt("E", "stopBlock != 0");
        c.r.stopBlock = 5;
        _ev(c);
        c = _dflt("E", "not custodied");
        c.r.custodied = false;
        _ev(c);
        c = _dflt("E", "verifWeight = bonus");
        c.r.verifWeight = 10;
        _ev(c);
        c = _dflt("E", "verifWeight = bonus + 1 (healthy)");
        c.r.verifWeight = 11;
        _ev(c);
        c = _dflt("E", "rescued rig (zero fields)");
        c.r = RigReport({
            rigId: uint64(RIG),
            circuitId: 0,
            since: 0,
            stopBlock: 0,
            circuits: address(0),
            observedAt: T - 10,
            status: 0,
            custodied: false,
            verifWeight: 0,
            bonus: 0,
            totalVerifWeight: 0,
            bscBlock: 2,
            pending: 0,
            taskId: 0
        });
        _ev(c);
        c = _impaired(_dflt("E", "insane impaired report (sane not required)"));
        c.r.totalVerifWeight = 1;
        _ev(c);
    }

    /// Row VE: flag or seize evidence from a power-0 voucher record; the feed has no report.
    function _rowVE() internal {
        Case memory c = _dflt("VE", "syncedAt = floor");
        c.ok = false;
        c.syncedAt = F;
        c.power = 0;
        _ev(c);
        c.name = "syncedAt = floor - 1";
        c.syncedAt = F - 1;
        _ev(c);
        c.name = "syncedAt = now + 60 (known)";
        c.syncedAt = T + 60;
        _ev(c);
        c.name = "syncedAt = now + 61 (unknown)";
        c.syncedAt = T + 61;
        _ev(c);
        c.name = "unreadable record";
        c.syncedAt = F;
        c.readable = false;
        _ev(c);
        c = _dflt("VE", "feed disabled: a newer healthy report does not shield");
        c.feedDisabled = true;
        c.syncedAt = T - 100;
        c.power = 0;
        _ev(c);
    }

    /// Row S: a newer sane healthy report keeps a power-0 record from counting.
    function _rowS() internal {
        uint64 s0 = T - 100;
        Case memory c = _dflt("S", "observedAt = syncedAt + 1");
        c.syncedAt = s0;
        c.power = 0;
        c.r.observedAt = s0 + 1;
        _ev(c);
        c.name = "observedAt = syncedAt (tie)";
        c.r.observedAt = s0;
        _ev(c);
        c.name = "insane healthy report";
        c.r.observedAt = s0 + 1;
        c.r.totalVerifWeight = 1;
        _ev(c);
        c = _dflt("S", "observedAt = enableFloor - 1");
        c.syncedAt = s0;
        c.power = 0;
        c.feedEnabledAt = s0;
        c.r.observedAt = s0 + 59;
        _ev(c);
        c.name = "observedAt = enableFloor";
        c.r.observedAt = s0 + 60;
        _ev(c);
        c = _dflt("S", "stale healthy report newer than the record");
        c.syncedAt = T - 2 hours;
        c.power = 0;
        c.r.observedAt = T - 1 hours;
        _ev(c);
        c = _impaired(_dflt("S", "stale impaired report newer than the record"));
        c.syncedAt = T - 2 hours;
        c.power = 0;
        c.r.observedAt = T - 1 hours;
        _ev(c);
        c = _dflt("S", "healthy report dated now + 61");
        c.syncedAt = s0;
        c.power = 0;
        c.r.observedAt = T + 61;
        _ev(c);
        c = _dflt("S", "healthy report of another rig");
        c.syncedAt = s0;
        c.power = 0;
        c.r.rigId = uint64(RIG + 1);
        _ev(c);
        c = _dflt("S", "feed reverts");
        c.syncedAt = s0;
        c.power = 0;
        c.reverts = true;
        _ev(c);
    }

    /// Row H: clear health from a fresh, sane, healthy report; the record is no candidate.
    function _rowH() internal {
        Case memory c = _dflt("H", "healthy fresh sane report");
        _ev(c);
        c = _dflt("H", "observedAt = enableFloor - 1");
        c.feedEnabledAt = T - 100;
        c.r.observedAt = T - 41;
        _ev(c);
        c.name = "observedAt = enableFloor";
        c.r.observedAt = T - 40;
        _ev(c);
        c = _dflt("H", "observedAt = floor - 1");
        c.floor = T - 100;
        c.r.observedAt = T - 101;
        _ev(c);
        c.name = "observedAt = floor";
        c.r.observedAt = T - 100;
        _ev(c);
        c = _dflt("H", "age 300");
        c.r.observedAt = T - 300;
        _ev(c);
        c.name = "age 301";
        c.r.observedAt = T - 301;
        _ev(c);
        c = _dflt("H", "insane healthy report");
        c.r.totalVerifWeight = 1;
        _ev(c);
        c = _dflt("H", "observedAt = now + 60");
        c.r.observedAt = T + 60;
        _ev(c);
        c.name = "observedAt = now + 61";
        c.r.observedAt = T + 61;
        _ev(c);
        c = _dflt("H", "feed disabled");
        c.feedDisabled = true;
        _ev(c);
    }

    /// Row B: a stored impaired report blocks a clear at any age and without the enable floor; the record
    /// is positive and synced at the floor.
    function _rowB() internal {
        Case memory c = _impaired(_dflt("B", "impaired report one hour old"));
        c.syncedAt = F;
        c.r.observedAt = T - 1 hours;
        _ev(c);
        c.name = "impaired report below the enable floor";
        c.feedEnabledAt = T - 100;
        c.r.observedAt = T - 50;
        _ev(c);
        c = _impaired(_dflt("B", "observedAt = floor - 1"));
        c.syncedAt = F;
        c.r.observedAt = F - 1;
        _ev(c);
        c.name = "observedAt = floor (tie with the record)";
        c.r.observedAt = F;
        _ev(c);
        c.name = "observedAt = now + 61";
        c.r.observedAt = T + 61;
        _ev(c);
        c.name = "feed disabled";
        c.r.observedAt = T - 10;
        c.feedDisabled = true;
        _ev(c);
        c = _impaired(_dflt("B", "impaired report older than the record"));
        c.syncedAt = F + 20;
        c.r.observedAt = F + 10;
        _ev(c);
    }

    /// Row VC: the voucher record as a clear reading, and its ties with a report.
    function _rowVC() internal {
        Case memory c = _dflt("VC", "positive record at the floor, no report");
        c.ok = false;
        c.syncedAt = F;
        _ev(c);
        c.name = "positive record at floor - 1";
        c.syncedAt = F - 1;
        _ev(c);
        c.name = "power-0 record at the floor";
        c.syncedAt = F;
        c.power = 0;
        _ev(c);
        c.name = "record dated now + 61";
        c.syncedAt = T + 61;
        c.power = 110;
        _ev(c);
        c.name = "unreadable record";
        c.syncedAt = F;
        c.readable = false;
        _ev(c);
        c = _impaired(_dflt("VC", "tie: impaired report, positive record"));
        c.syncedAt = T - 10;
        _ev(c);
        c = _dflt("VC", "tie: healthy report, power-0 record");
        c.syncedAt = T - 10;
        c.power = 0;
        _ev(c);
        c = _impaired(_dflt("VC", "positive record newer than an impaired report"));
        c.syncedAt = T - 9;
        _ev(c);
        c = _dflt("VC", "healthy report newer than a power-0 record");
        c.syncedAt = T - 10;
        c.power = 0;
        c.r.observedAt = T - 9;
        _ev(c);
    }

    function _ev(Case memory c) internal {
        vm.warp(c.now_);
        state.set(c.feedDisabled, c.feedEnabledAt);
        feed.set(c.r, c.ok, c.reverts);
        voucher.set(c.readable, c.syncedAt, c.power);
        string memory outputs = string.concat(
            ',"kind":',
            vm.toString(uint256(agent.evidenceKind(RIG, c.floor))),
            ',"verdict":',
            vm.toString(uint256(agent.verdict(RIG, c.floor))),
            "}"
        );
        _emit(string.concat(_evInputs(c), ',"report":', _evReport(c), ',"record":', _evRecord(c), outputs));
    }

    function _evInputs(Case memory c) internal pure returns (string memory) {
        string memory head =
            string.concat('{"k":"evidence","row":"', c.row, '","case":"', c.name, '","id":"', vm.toString(RIG));
        return string.concat(
            head,
            '","now":"',
            vm.toString(c.now_),
            '","feedDisabled":',
            vm.toString(c.feedDisabled),
            ',"feedEnabledAt":"',
            vm.toString(c.feedEnabledAt),
            '","floor":"',
            vm.toString(c.floor),
            '"'
        );
    }

    function _evRecord(Case memory c) internal pure returns (string memory) {
        return string.concat(
            '{"readable":',
            vm.toString(c.readable),
            ',"syncedAt":"',
            vm.toString(c.syncedAt),
            '","power":"',
            vm.toString(c.power),
            '"}'
        );
    }

    function _evReport(Case memory c) internal pure returns (string memory) {
        string memory head = string.concat(
            '{"ok":',
            vm.toString(c.ok),
            ',"reverts":',
            vm.toString(c.reverts),
            ',"rigId":"',
            vm.toString(c.r.rigId),
            '","observedAt":"',
            vm.toString(c.r.observedAt),
            '","status":',
            vm.toString(uint256(c.r.status))
        );
        return string.concat(
            head,
            ',"stopBlock":"',
            vm.toString(c.r.stopBlock),
            '","custodied":',
            vm.toString(c.r.custodied),
            ',"verifWeight":"',
            vm.toString(c.r.verifWeight),
            '","bonus":"',
            vm.toString(c.r.bonus),
            '","totalVerifWeight":"',
            vm.toString(c.r.totalVerifWeight),
            '"}'
        );
    }

    // ───────────────────────── plumbing

    /// R4-00: appended brake-time B/U cases leave historical vector order intact.
    function _brakeVectors() internal {
        for (uint256 row; row < 2; ++row) {
            Case memory c = _dflt(row == 0 ? "B" : "U", "feed off");
            c.feedDisabled = true;
            c.syncedAt = F;
            if (row == 0) c = _impaired(c);
            for (uint256 reading; reading < 4; ++reading) {
                if (reading == 1) c.syncedAt = c.r.observedAt;
                if (reading == 2) c.syncedAt = c.r.observedAt + 1;
                if (reading == 3) c.syncedAt = F;
                c.power = reading == 3 ? 0 : 110;
                c.name = string.concat("feed off: record variant ", vm.toString(reading));
                _ev(c);
                uint8 expected = reading == 2 ? 1 : (row == 0 || reading == 3 ? 2 : 3);
                require(agent.verdict(RIG, c.floor) == expected, "brake vector verdict");
            }
        }
        Case memory c = _dflt("U", "unknown on the other rig blocks a clear");
        c.feedDisabled = true;
        c.syncedAt = F;
        vm.warp(T);
        state.set(true, 0);
        feed.set(c.r, true, false);
        voucher.set(true, F, 110);
        // Rig 8 has no matching report; its positive record decides alone.
        agent.preparePair(F - 72 hours - 60);
        uint8 flagged = agent.verdict(8, F);
        uint8 other = agent.verdict(7, F);
        (bool allowed, bytes memory reason) = address(agent).call(abi.encodeCall(RigAgent.clearExpiredFlag, ()));
        require(flagged == 1 && other == 3 && !allowed, "unknown other rig must block");
        require(bytes4(reason) == RigAgent.NoHealthEvidence.selector, "clear failed for another reason");
        _emit(
            string.concat(
                '{"k":"clearPair","case":"feed off: unknown other rig","flaggedVerdict":',
                vm.toString(uint256(flagged)),
                ',"otherVerdict":',
                vm.toString(uint256(other)),
                ',"allowed":',
                vm.toString(allowed),
                ',"id":"7","flaggedId":"8","now":"1800000000","floor":"1799913600","feedDisabled":true,"feedEnabledAt":"0","report":',
                _evReport(c),
                ',"record":',
                _evRecord(c),
                "}"
            )
        );
    }

    /// R4-08: N has U's record precedence; every earlier vector retains its order.
    function _rowN() internal {
        for (uint256 mode; mode < 2; ++mode) {
            for (uint256 reading; reading < 7; ++reading) {
                Case memory c = _dflt("N", "");
                c.name = string.concat(mode == 0 ? "stale" : "insane", ": record variant ", vm.toString(reading));
                c.r.observedAt = mode == 0 ? F + 2 : T;
                if (mode == 1) c.r.totalVerifWeight = 0;
                c.readable = reading != 0;
                if (reading == 1) c.syncedAt = F - 1;
                if (reading == 2 || reading == 6) c.syncedAt = F;
                if (reading == 3) c.syncedAt = c.r.observedAt - 1;
                if (reading == 4) c.syncedAt = c.r.observedAt;
                if (reading == 5) c.syncedAt = c.r.observedAt + 1;
                if (reading == 6) c.power = 0;
                uint8 want = reading == 5 ? 1 : (reading == 6 ? 2 : 3);
                _nEv(c, want, mode == 1 && reading == 6 ? 2 : 0);
            }
        }
        Case memory c = _dflt("N", "age 300 is H");
        c.r.observedAt = T - 300;
        _nEv(c, 1, 0);
        c.name = "age 301 is N";
        c.r.observedAt = T - 301;
        _nEv(c, 3, 0);
        c.name = "enableFloor - 1 stays U";
        c.feedEnabledAt = c.r.observedAt - 59;
        _nEv(c, 3, 0);
        c.name = "feed off stays U";
        c.feedEnabledAt = 0;
        c.feedDisabled = true;
        _nEv(c, 3, 0);
        c = _dflt("N", "insane at now + 60 admitted");
        c.r.totalVerifWeight = 0;
        c.r.observedAt = T + 60;
        _nEv(c, 3, 0);
        c.name = "insane at now + 61 is no candidate";
        c.r.observedAt = T + 61;
        _nEv(c, 0, 0);
        c.name = "floor - 1 is no candidate";
        c.r.observedAt = F - 1;
        _nEv(c, 0, 0);
        c.name = "at floor is N";
        c.r.observedAt = F;
        _nEv(c, 3, 0);
    }

    function _nEv(Case memory c, uint8 verdict, uint8 kind) internal {
        _ev(c);
        require(agent.verdict(RIG, c.floor) == verdict, "row N verdict");
        require(agent.evidenceKind(RIG, c.floor) == kind, "row N evidence");
    }

    /// The same two-rig clear before and after a record newer than N arrives on the other rig.
    function _rowNPairs() internal {
        for (uint256 reading; reading < 2; ++reading) {
            Case memory c = _dflt("N", reading == 0 ? "stale N on other rig" : "newer record resolves N on other rig");
            c.r.observedAt = F + 2;
            c.syncedAt = reading == 0 ? F : F + 3;
            vm.warp(T);
            state.set(false, 0);
            feed.set(c.r, true, false);
            voucher.set(true, c.syncedAt, 110);
            agent.preparePair(F - 72 hours - 60);
            uint8 flagged = agent.verdict(8, F);
            uint8 other = agent.verdict(7, F);
            (bool allowed, bytes memory reason) = address(agent).call(abi.encodeCall(RigAgent.clearExpiredFlag, ()));
            require(flagged == 1 && other == (reading == 0 ? 3 : 1) && allowed == (reading == 1), "row N pair");
            if (!allowed) require(bytes4(reason) == RigAgent.NoHealthEvidence.selector, "row N clear reason");
            _emit(
                string.concat(
                    '{"k":"clearPair","case":"',
                    c.name,
                    '","flaggedVerdict":',
                    vm.toString(uint256(flagged)),
                    ',"otherVerdict":',
                    vm.toString(uint256(other)),
                    ',"allowed":',
                    vm.toString(allowed),
                    ',"id":"7","flaggedId":"8","now":"1800000000","floor":"1799913600","feedDisabled":false,"feedEnabledAt":"0","report":',
                    _evReport(c),
                    ',"record":',
                    _evRecord(c),
                    "}"
                )
            );
        }
    }

    /// R4-01: export raw miner inputs alongside production reader outputs.
    function _bonusVectors() internal {
        VecMiner miner = new VecMiner();
        uint32[6] memory mults = [uint32(1), 6, 0, 6, 6, 6];
        uint64[6] memory bases = [uint64(24), 4, 4, 0, 79, 4];
        uint128[6] memory weights = [uint128(48), 456, 456, 456, 0, 12];
        for (uint256 i; i < mults.length; ++i) {
            miner.set(mults[i], bases[i], weights[i]);
            RigReport memory r = BscRigReader.read(IRigVaultBsc(address(miner)), IPodMining(address(miner)), 7);
            _emit(
                string.concat(
                    '{"k":"bonus","mult":"',
                    vm.toString(mults[i]),
                    '","bstar":"',
                    vm.toString(bases[i]),
                    '","rawBonus":"3752","verifWeight":"',
                    vm.toString(weights[i]),
                    '","bonus":"',
                    vm.toString(r.bonus),
                    '","base":"',
                    vm.toString(r.verifWeight - r.bonus),
                    '"}'
                )
            );
        }
    }

    function _emit(string memory line) internal {
        ++n;
        console.log(string.concat("VEC ", line));
    }

    /// A reproducible pseudo-random number in `[0, mod)`.
    function _rnd(uint256 mod) internal returns (uint256) {
        seed = uint256(keccak256(abi.encode(seed, n)));
        return mod == 0 ? 0 : seed % mod;
    }
}

/// Raw miner answers only; report normalization uses the production reader.
contract VecMiner {
    Miner internal m;

    function set(uint32 mult, uint64 base, uint128 weight) external {
        m.mult = mult;
        m.bstar = base;
        m.verifWeight = weight;
        m.bonus = 3752;
    }

    function rigs(uint256) external pure returns (address, uint256) {
        return (address(0xC1C), 1007);
    }

    function cellOf(bytes32) external pure returns (address) {
        return address(0);
    }

    function minerKey(address, uint256) external pure returns (bytes32) {
        return bytes32(0);
    }

    function getMiner(bytes32) external view returns (Miner memory) {
        return m;
    }

    function totalVerifWeight() external pure returns (uint256) {
        return 1_579_201;
    }

    function pending(bytes32) external pure returns (uint256) {
        return 0;
    }
}
