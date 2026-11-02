// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICreditPolicy, Reasons} from "./interfaces/ICreditPolicy.sol";
import {IRigFeed, RigReport} from "./interfaces/IRigFeed.sol";
import {IRigVoucher, ITapeOutCircuits} from "./interfaces/IXLayer.sol";
import {RigScreen} from "./RigScreen.sol";
import {CreditMath} from "./libraries/CreditMath.sol";
import {PolicyV1} from "./libraries/PolicyV1.sol";

/// @notice Policy v1 adapter (SPEC §9.1, SPEC-PHASE3 §4). Builds the 12 input bits from the rig
///         feed, the RIG voucher and the screen registry, evaluates the taped-out policy circuit
///         on X Layer, and allows a borrow only if the circuit **and** its Solidity mirror say yes.
///         `check` and `maxDebt` never revert: every failure is a deny with a reason code.
/// @dev Immutable, no proxy. Reads of contracts we do not control (the voucher, the TapeOut
///      Circuits contract) are gas-capped STATICCALLs that copy a fixed number of bytes, so a
///      bloated or hostile answer cannot exhaust the caller's gas. The feed and the screen are our own
///      immutable contracts with fixed-size answers.
contract CreditPolicy is ICreditPolicy {
    /// @notice Everything the adapter pins at deploy.
    struct Pins {
        address circuits; // X Layer processor's Circuits contract that holds policy v1
        uint256 circuitId; // the id `tapeout` returned
        IRigFeed feed; // the rig data feed agents also read
        address voucher; // RIG voucher on X Layer
        RigScreen screen;
        address cpuTapeOut; // BSC Circuits contracts of the PoD-mineable processors
        address cpuBehemoth;
        address cpuRefBench;
        uint256 emissionValidUntil; // first halving minus 30 days
    }

    uint256 public constant MAX_RIGS = 16;
    uint256 public constant MAX_REPORT_AGE = 300;
    uint256 public constant MAX_CLOCK_SKEW = 60;
    /// @dev A backup to the revocation screen (SPEC §2, §14): owner decision 2026-10-21, was 14 days.
    uint256 public constant MIN_RIG_AGE = 3 days;
    uint256 public constant POLICY_GAS_CAP = 1_000_000;
    uint256 public constant VOUCHER_GAS = 200_000;
    uint256 public constant FEED_GAS = 100_000;
    uint256 public constant SCREEN_GAS = 100_000;
    uint256 public constant INFO_GAS = 100_000;
    uint256 public constant NETLIST_GAS = 300_000;
    uint8 internal constant ACTIVE = 1;
    uint8 internal constant ALL_FLAGS = 31;

    /// @dev ABI size of `netlist(id)`'s answer: offset, length, then 7 bytes per gate padded to 32.
    uint256 internal constant NETLIST_LEN = 7 * uint256(PolicyV1.GATES);
    uint256 internal constant NETLIST_RET = 64 + 32 * ((NETLIST_LEN + 31) / 32);

    address public immutable circuits;
    uint256 public immutable circuitId;
    IRigFeed public immutable feed;
    address public immutable voucher;
    RigScreen public immutable screen;
    address public immutable cpuTapeOut;
    address public immutable cpuBehemoth;
    address public immutable cpuRefBench;
    uint256 public immutable emissionValidUntil;

    /// @dev Result of the shared read stage. `reason` is `OK` unless a step before the bits failed.
    struct Gathered {
        uint8 reason;
        uint8 termCode;
        uint8 flags; // bit 0 fresh, 1 unimpaired, 2 processorOk, 3 ageOk, 4 screened
        uint256 expected;
    }

    error ZeroPin();
    error NoCode(address target);
    error EmissionInPast();

    constructor(Pins memory p) {
        if (
            p.circuits == address(0) || address(p.feed) == address(0) || p.voucher == address(0)
                || address(p.screen) == address(0) || p.cpuTapeOut == address(0) || p.cpuBehemoth == address(0)
                || p.cpuRefBench == address(0)
        ) revert ZeroPin();
        if (p.circuits.code.length == 0) revert NoCode(p.circuits);
        if (address(p.feed).code.length == 0) revert NoCode(address(p.feed));
        if (p.voucher.code.length == 0) revert NoCode(p.voucher);
        if (address(p.screen).code.length == 0) revert NoCode(address(p.screen));
        if (p.emissionValidUntil <= block.timestamp) revert EmissionInPast();
        circuits = p.circuits;
        circuitId = p.circuitId;
        feed = p.feed;
        voucher = p.voucher;
        screen = p.screen;
        cpuTapeOut = p.cpuTapeOut;
        cpuBehemoth = p.cpuBehemoth;
        cpuRefBench = p.cpuRefBench;
        emissionValidUntil = p.emissionValidUntil;
    }

    // ───────────────────────── ICreditPolicy

    /// @inheritdoc ICreditPolicy
    function version() external pure virtual returns (uint16) {
        return 1;
    }

    /// @inheritdoc ICreditPolicy
    function check(address agent, uint256[] calldata rigIds, uint8 term, uint256 debt)
        external
        view
        returns (bool allow, uint8 reason, uint16 inputBits, uint256 expected)
    {
        Gathered memory g = _gather(agent, rigIds, term);
        if (g.reason != Reasons.OK) return (false, g.reason, 0, 0);
        inputBits = _bits(g, CreditMath.debtBucket(debt, g.expected));
        (allow, reason) = _decide(inputBits);
        expected = g.expected;
    }

    /// @inheritdoc ICreditPolicy
    function maxDebt(address agent, uint256[] calldata rigIds, uint8 term) external view returns (uint256) {
        if (term > CreditMath.TERM_14D) return 0;
        Gathered memory g = _gather(agent, rigIds, term);
        if (g.reason != Reasons.OK || g.flags != ALL_FLAGS || g.expected == 0) return 0;
        uint256 limit = CreditMath.maxDebt(g.expected, term);
        (bool allow,) = _decide(_bits(g, CreditMath.debtBucket(limit, g.expected)));
        return allow ? limit : 0;
    }

    /// @notice True while the pinned circuit still has policy v1's `circuitInfo` and netlist hash.
    ///         Deploy scripts and the pre-seed check assert it, since `TapePool`'s own probe stops
    ///         at `BAD_IDS` before any pin is read.
    function pinsOk() external view returns (bool) {
        return _pinsOk();
    }

    // ───────────────────────── stage 1: gather (SPEC-PHASE3 §4.3 steps 1-4)

    function _gather(address agent, uint256[] calldata rigIds, uint8 term) internal view returns (Gathered memory g) {
        uint256 n = rigIds.length;
        if (n == 0 || n > MAX_RIGS) return _fail(Reasons.BAD_IDS);
        for (uint256 i = 1; i < n; ++i) {
            if (rigIds[i] <= rigIds[i - 1]) return _fail(Reasons.BAD_IDS);
        }
        if (term <= CreditMath.TERM_14D && block.timestamp + CreditMath.termDays(term) * 1 days >= emissionValidUntil) {
            return _fail(Reasons.EMISSION);
        }
        if (!_pinsOk()) return _fail(Reasons.PIN);

        g.termCode = term > 3 ? 3 : term;
        g.flags = ALL_FLAGS;
        for (uint256 i; i < n; ++i) {
            (uint8 f, uint256 e) = _rig(agent, rigIds[i], g.termCode);
            g.flags &= f;
            g.expected += e;
        }
    }

    /// @dev One rig's flags (same bit order as `Gathered.flags`) and its expected output.
    function _rig(address agent, uint256 id, uint8 termCode) internal view returns (uint8 f, uint256 e) {
        (RigReport memory r, bool ok) = _report(id);
        bool timely = ok && uint256(r.rigId) == id && uint256(r.observedAt) <= block.timestamp + MAX_CLOCK_SKEW
            && block.timestamp <= uint256(r.observedAt) + MAX_REPORT_AGE;
        bool sane = r.verifWeight != 0 && r.verifWeight <= r.totalVerifWeight && r.bonus <= r.verifWeight;
        bool hasBase = r.verifWeight > r.bonus;

        if (timely && sane) f |= 1;
        if (r.status == ACTIVE && r.stopBlock == 0 && r.custodied && hasBase && _voucherMatches(id, r, agent)) {
            f |= 2;
        }
        if (r.circuits == cpuTapeOut || r.circuits == cpuBehemoth || r.circuits == cpuRefBench) f |= 4;
        if (r.since != 0 && block.timestamp >= uint256(r.since) + MIN_RIG_AGE) f |= 8;
        if (_screened(id, r)) f |= 16;

        if (termCode <= CreditMath.TERM_14D && timely && sane && hasBase) {
            e = CreditMath.expectedOutput(r.verifWeight - r.bonus, r.totalVerifWeight, termCode);
        }
    }

    function _bits(Gathered memory g, uint8 bucket) internal pure returns (uint16) {
        return uint16(g.termCode) | (uint16(bucket) << 2) | (uint16(g.flags) << 7);
    }

    function _fail(uint8 reason) internal pure returns (Gathered memory g) {
        g.reason = reason;
    }

    // ───────────────────────── stage 2: decide (SPEC-PHASE3 §4.3 steps 5-6)

    function _decide(uint16 inputBits) internal view returns (bool allow, uint8 reason) {
        (bool ok, bool circuitSays) = _eval(inputBits);
        if (!ok) return (false, Reasons.EVAL);
        bool mirrorSays = PolicyV1.expected(inputBits);
        if (circuitSays && mirrorSays) return (true, Reasons.OK);
        if (circuitSays != mirrorSays) return (false, Reasons.MISMATCH);
        return (false, Reasons.DENIED);
    }

    // ───────────────────────── guarded reads

    /// @dev `circuitInfo` and the netlist hash still match policy v1.
    function _pinsOk() internal view returns (bool) {
        address c = circuits;
        bytes memory q = abi.encodeCall(ITapeOutCircuits.circuitInfo, (circuitId));
        uint256 cap = INFO_GAS;
        bool ok;
        uint256 nIn;
        uint256 nOut;
        uint256 nState;
        uint256 gates;
        assembly {
            let out := mload(0x40)
            ok := staticcall(cap, c, add(q, 0x20), mload(q), out, 0x80)
            ok := and(ok, eq(returndatasize(), 0x80))
            nIn := mload(out)
            nOut := mload(add(out, 0x20))
            nState := mload(add(out, 0x40))
            gates := mload(add(out, 0x60))
        }
        if (
            !ok || nIn != PolicyV1.N_IN || nOut != PolicyV1.N_OUT || nState != PolicyV1.N_STATE
                || gates != PolicyV1.GATES
        ) return false;

        q = abi.encodeCall(ITapeOutCircuits.netlist, (circuitId));
        cap = NETLIST_GAS;
        uint256 want = NETLIST_RET;
        uint256 len = NETLIST_LEN;
        bytes32 h;
        assembly {
            let out := mload(0x40)
            ok := staticcall(cap, c, add(q, 0x20), mload(q), out, want)
            ok := and(ok, eq(returndatasize(), want))
            ok := and(ok, and(eq(mload(out), 0x20), eq(mload(add(out, 0x20)), len)))
            h := keccak256(add(out, 0x40), len)
        }
        return ok && h == PolicyV1.NETLIST_HASH;
    }

    /// @dev `eval` through a capped STATICCALL; strict decode of exactly one output byte.
    function _eval(uint16 inputBits) internal view returns (bool ok, bool bit) {
        address c = circuits;
        bytes memory q = abi.encodeCall(ITapeOutCircuits.eval, (circuitId, PolicyV1.encode(inputBits)));
        uint256 cap = POLICY_GAS_CAP;
        uint256 word;
        assembly {
            let out := mload(0x40)
            ok := staticcall(cap, c, add(q, 0x20), mload(q), out, 0x60)
            ok := and(ok, eq(returndatasize(), 0x60))
            ok := and(ok, and(eq(mload(out), 0x20), eq(mload(add(out, 0x20)), 1)))
            word := mload(add(out, 0x40))
        }
        // the output byte is 0 or 1, and every other byte of the padded word is zero
        ok = ok && (word >> 248) <= 1 && (word << 8) == 0;
        bit = ok && (word >> 248) == 1;
    }

    /// @dev The voucher's own record names the same circuit as the report, shows power, and the
    ///      agent owns the voucher. Capped STATICCALLs; any failure reads as false.
    function _voucherMatches(uint256 id, RigReport memory r, address agent) internal view returns (bool) {
        address v = voucher;
        bytes memory q = abi.encodeCall(IRigVoucher.rigs, (id));
        uint256 cap = VOUCHER_GAS;
        bool ok;
        uint256 c;
        uint256 cid;
        uint256 power;
        assembly {
            let out := mload(0x40)
            ok := staticcall(cap, v, add(q, 0x20), mload(q), out, 0x80)
            ok := and(ok, gt(returndatasize(), 0x7f))
            c := mload(out)
            cid := mload(add(out, 0x40))
            power := mload(add(out, 0x60))
        }
        if (!ok || c != uint256(uint160(r.circuits)) || cid != uint256(r.circuitId) || power == 0) return false;

        q = abi.encodeCall(IRigVoucher.ownerOf, (id));
        bool owned;
        assembly {
            let ok2 := staticcall(cap, v, add(q, 0x20), mload(q), 0, 0x20)
            owned := and(and(ok2, gt(returndatasize(), 0x1f)), eq(mload(0), agent))
        }
        return owned;
    }

    /// @dev The screen has an effective pass for exactly this circuit and task.
    function _screened(uint256 id, RigReport memory r) internal view returns (bool yes) {
        address s = address(screen);
        bytes memory q = abi.encodeCall(RigScreen.isEffective, (id, r.circuits, r.circuitId, r.taskId));
        uint256 cap = SCREEN_GAS;
        assembly {
            let ok := staticcall(cap, s, add(q, 0x20), mload(q), 0, 0x20)
            yes := and(and(ok, gt(returndatasize(), 0x1f)), eq(mload(0), 1))
        }
    }

    /// @dev The feed is our own locked contract with a fixed-size answer (SPEC-PHASE3 §4.2).
    function _report(uint256 id) internal view returns (RigReport memory r, bool ok) {
        try feed.latest{gas: FEED_GAS}(id) returns (RigReport memory got, bool okGot) {
            return (got, okGot);
        } catch {
            return (r, false);
        }
    }
}
