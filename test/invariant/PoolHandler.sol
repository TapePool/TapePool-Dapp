// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {TapePool} from "../../src/TapePool.sol";
import {AgentFactory} from "../../src/AgentFactory.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {MockBEM, MockVoucher, MockRigFeed, MockCreditPolicy} from "../mocks/Mocks.sol";

/// Stateful fuzz handler for the pool and its agents (SPEC §15). The fuzzer calls the action
/// functions in any order; every action then checks what cannot be read from state afterwards:
/// an exit that must not revert, a price that must not fall, BEM that must go to the right place,
/// and the whole impairment lifecycle against a small model written from SPEC §7.2 and §10.5
/// (a flag, a seize or a clear is allowed exactly when the model says so, not before and not after).
/// A broken property bumps `violations` and records the first label in `firstViolation`.
contract PoolHandler is Test {
    enum Health {
        Healthy,
        Stopped,
        NoCustody,
        Rescued,
        ZeroPower,
        NoReport
    }

    /// What this handler knows about the flag on an agent's loan, from its own successful calls.
    struct FlagModel {
        bool live;
        uint64 flaggedAt;
        uint256 rig;
    }

    struct Bals {
        uint256 agent;
        uint256 borrower;
        uint256 pool;
        uint256 keeper;
    }

    uint256 internal constant BEM = 1e8;
    uint256 internal constant N_RIGS = 8;
    uint256 internal constant N_LENDERS = 2;
    uint256 internal constant N_BORROWERS = 3;
    uint256 internal constant N_INDEX = 3;
    /// The operating fee every borrow carries at launch (SPEC-PHASE3-OPSFEE D-O2).
    uint256 internal constant OPS = 0.031 ether;
    uint64 internal constant NETWORK_WEIGHT = 1_579_201;
    // timeline constants, from SPEC §7.2 and §10.5 (not read from the contracts)
    uint256 internal constant CURE = 72 hours;
    uint256 internal constant EVIDENCE = 24 hours;
    uint256 internal constant REPORT_AGE = 300;
    uint256 internal constant CLOCK_SKEW = 60;

    MockBEM internal bem;
    MockVoucher internal voucher;
    MockRigFeed internal feed;
    AgentFactory internal factory;
    TapePool internal pool;
    address internal owner;
    address internal guardian;
    address internal keeper = makeAddr("handler.keeper");

    address[] internal lenders;
    address[] internal borrowers;
    RigAgent[] internal agentList;
    uint256[] internal touched; // every voucher id ever minted
    mapping(uint256 => Health) internal health; // what the handler wants a rig to look like
    mapping(uint256 => uint64) internal baseOf;
    mapping(uint256 => bool) internal minted;
    uint16 internal policyVersion = 1;

    // what is actually posted, which is what the model judges evidence by
    mapping(uint256 => Health) internal postedHealth;
    mapping(uint256 => uint64) internal postedAt;
    mapping(uint256 => uint64) internal recSyncedAt; // the voucher's `rigs(id)` record, moves on a harvest
    mapping(uint256 => uint256) internal recPower;
    mapping(address => FlagModel) internal flagOf;
    mapping(address => uint64) internal borrowedAt;

    struct Brake {
        uint64 from;
        uint64 to;
    }
    Brake[] internal brakes;
    mapping(address => uint64) internal evidenceFloor;
    /// The time of this handler's last successful `enableFeed` (R3-01), 0 before any.
    uint64 internal enabledAt;
    mapping(address => uint16) internal loanShare;
    mapping(address => uint16) internal loanCap;
    uint256 internal expectedOwnerEth;

    uint256 public violations;
    string public firstViolation;
    /// True while the voucher mock may have listed a token the agent does not hold (see `breakVoucher`).
    bool public lied;
    mapping(bytes32 => uint256) internal hits;
    string[] internal hitLabels;

    /// Redeploy 3 R3-02: the third party the TapeOut Safe can move a voucher to (an accepted holder),
    /// every voucher id that was collateral of an agent at its seize with that agent, and the ids whose
    /// `ownerOf` misreports during the current action.
    address public safeHolder = makeAddr("handler.safe-holder");
    RigAgent[] internal seizedAgent;
    uint256[] internal seizedId;
    mapping(address => mapping(uint256 => bool)) internal seizedBy;
    mapping(uint256 => bool) internal misreported;

    constructor(
        MockBEM bem_,
        MockVoucher voucher_,
        MockRigFeed feed_,
        AgentFactory factory_,
        TapePool pool_,
        address owner_,
        address guardian_
    ) {
        bem = bem_;
        voucher = voucher_;
        feed = feed_;
        factory = factory_;
        pool = pool_;
        owner = owner_;
        guardian = guardian_;
        for (uint256 i; i < N_LENDERS; ++i) {
            lenders.push(makeAddr(string.concat("handler.lender", vm.toString(i))));
        }
        for (uint256 i; i < N_BORROWERS; ++i) {
            borrowers.push(makeAddr(string.concat("handler.borrower", vm.toString(i))));
        }
    }

    // ───────────────────────── views for the invariant contract

    function agentCount() external view returns (uint256) {
        return agentList.length;
    }

    function agentAt(uint256 i) external view returns (RigAgent) {
        return agentList[i];
    }

    function borrowerAt(uint256 i) external view returns (address) {
        return borrowers[i];
    }

    function borrowerCount() external view returns (uint256) {
        return borrowers.length;
    }

    function touchedCount() external view returns (uint256) {
        return touched.length;
    }

    function touchedAt(uint256 i) external view returns (uint256) {
        return touched[i];
    }

    function hitLabelCount() external view returns (uint256) {
        return hitLabels.length;
    }

    function hitLabelAt(uint256 i) external view returns (string memory) {
        return hitLabels[i];
    }

    function hitsOf(string memory label) external view returns (uint256) {
        return hits[keccak256(bytes(label))];
    }

    function seizedCount() external view returns (uint256) {
        return seizedId.length;
    }

    function seizedAt(uint256 i) external view returns (RigAgent, uint256) {
        return (seizedAgent[i], seizedId[i]);
    }

    // ───────────────────────── plumbing

    function _violate(string memory what) internal {
        if (violations == 0) firstViolation = what;
        violations++;
    }

    function _hit(string memory what) internal {
        bytes32 k = keccak256(bytes(what));
        if (hits[k] == 0) hitLabels.push(what);
        hits[k]++;
    }

    /// Call `target` as `from`. On a revert, the selector must be one of `okSel`; anything else is
    /// a violation (most of all a revert caused by a brake).
    function _try(string memory label, address from, address target, bytes memory data, bytes4[] memory okSel)
        internal
        returns (bool success)
    {
        if (from != address(0)) vm.prank(from);
        (bool s, bytes memory ret) = target.call(data);
        if (s) {
            _hit(label);
            return true;
        }
        bytes4 sel = ret.length >= 4 ? bytes4(ret) : bytes4(0);
        for (uint256 i; i < okSel.length; ++i) {
            if (okSel[i] == sel) return false;
        }
        _violate(string.concat("unexpected revert: ", label));
        return false;
    }

    function _one(bytes4 a) internal pure returns (bytes4[] memory r) {
        r = new bytes4[](1);
        r[0] = a;
    }

    function _four(bytes4 a, bytes4 b, bytes4 c, bytes4 d) internal pure returns (bytes4[] memory r) {
        r = new bytes4[](4);
        r[0] = a;
        r[1] = b;
        r[2] = c;
        r[3] = d;
    }

    function _min(uint256 x, uint256 y) internal pure returns (uint256) {
        return x < y ? x : y;
    }

    function _pick(uint256 seed) internal view returns (RigAgent a, bool ok) {
        if (agentList.length == 0) return (a, false);
        return (agentList[seed % agentList.length], true);
    }

    /// Pick an agent, preferring one in the state an action needs so that the fuzzer reaches the
    /// deep paths. When none matches it falls back to any agent, so the refusals are exercised too.
    /// kind: 0 any, 1 open loan, 2 can borrow (open, no loan, has collateral), 3 flagged loan, 4 closed.
    function _pickFor(uint256 seed, uint8 kind) internal view returns (RigAgent a, bool ok) {
        uint256 n = agentList.length;
        if (n == 0) return (a, false);
        for (uint256 j; j < n; ++j) {
            RigAgent c = agentList[(seed % n + j) % n];
            if (kind == 0) return (c, true);
            if (kind == 1 && c.hasLoan()) return (c, true);
            if (kind == 2 && _canBorrow(c)) return (c, true);
            if (kind == 3 && c.hasLoan() && c.loanOf().impairedAt != 0) return (c, true);
            if (kind == 4 && c.closed()) return (c, true);
        }
        return (agentList[seed % n], true);
    }

    /// The mock really moves voucher `id` on a transfer, and the agent reads its holder truly (an id
    /// whose `ownerOf` misreports is kept for retry, R3-02).
    function _moves(uint256 id) internal view returns (bool) {
        return voucher.mode() == MockVoucher.Mode.Normal && !voucher.blocked(id) && !misreported[id];
    }

    /// A transfer of voucher `id` does not revert (the lying mode returns without moving it).
    function _callable(uint256 id) internal view returns (bool) {
        MockVoucher.Mode m = voucher.mode();
        return (m == MockVoucher.Mode.Normal || m == MockVoucher.Mode.Lie) && !voucher.blocked(id);
    }

    function _allCallable(uint256[] memory ids) internal view returns (bool) {
        for (uint256 i; i < ids.length; ++i) {
            if (!_callable(ids[i])) return false;
        }
        return true;
    }

    function _canBorrow(RigAgent c) internal view returns (bool) {
        return !c.closed() && !c.hasLoan() && c.collateralOf().length != 0;
    }

    /// A minted voucher held by `holder`, found by scanning from `seed`.
    function _rigOf(address holder, uint256 seed) internal view returns (uint256 id, bool found) {
        for (uint256 j; j < N_RIGS; ++j) {
            uint256 c = 1 + (seed % N_RIGS + j) % N_RIGS;
            if (minted[c] && voucher.ownerOf(c) == holder) return (c, true);
        }
    }

    function _inCollateral(RigAgent a, uint256 id) internal view returns (bool) {
        uint256[] memory ids = a.collateralOf();
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] == id) return true;
        }
        return false;
    }

    function _bals(RigAgent a) internal view returns (Bals memory b) {
        b.agent = bem.balanceOf(address(a));
        b.borrower = bem.balanceOf(a.borrower());
        b.pool = bem.balanceOf(address(pool));
        b.keeper = bem.balanceOf(keeper);
    }

    /// Everything an admin call must leave alone: pool BEM and reserve, share balances, every agent's
    /// BEM and loan terms, every voucher's holder (SPEC §15 invariant 6).
    function _adminFingerprint() internal view returns (bytes32 h) {
        h = keccak256(
            abi.encode(bem.balanceOf(address(pool)), pool.outstandingPrincipal(), pool.doubtful(), pool.totalSupply())
        );
        for (uint256 i; i < lenders.length; ++i) {
            h = keccak256(abi.encode(h, pool.balanceOf(lenders[i])));
        }
        for (uint256 i; i < agentList.length; ++i) {
            RigAgent a = agentList[i];
            RigAgent.LoanView memory v = a.loanOf();
            h = keccak256(
                abi.encode(h, address(a), bem.balanceOf(address(a)), pool.loanPrincipalOf(address(a)), a.closed())
            );
            h = keccak256(abi.encode(h, v.open, v.principal, v.feeLeft, v.maturity, v.impairedAt, v.term, v.doubtful));
        }
        for (uint256 i; i < touched.length; ++i) {
            h = keccak256(abi.encode(h, touched[i], voucher.ownerOf(touched[i])));
        }
    }

    modifier admin() {
        bytes32 before = _adminFingerprint();
        _;
        if (_adminFingerprint() != before) _violate("admin call moved funds, vouchers or a loan");
    }

    /// The vault never gives value away: the share price (virtual-shares form) does not fall.
    modifier priced() {
        uint256 ta0 = pool.totalAssets();
        uint256 s0 = pool.totalSupply();
        _;
        _checkPrice(ta0, s0);
    }

    function _checkPrice(uint256 ta0, uint256 s0) internal {
        uint256 ta1 = pool.totalAssets();
        uint256 s1 = pool.totalSupply();
        if ((ta1 + 1) * (s0 + 1e6) < (ta0 + 1) * (s1 + 1e6)) _violate("share price fell");
    }

    // ───────────────────────── report posting

    function _post(uint256 id) internal {
        _postAt(id, uint64(block.timestamp + CLOCK_SKEW));
    }

    /// Post the rig as the handler wants it, with the report observed at `at` (a little ahead of now
    /// is allowed: the agents tolerate a clock skew of up to 60 seconds).
    function _postAt(uint256 id, uint64 at) internal {
        _postAt(id, at, true);
    }

    /// With `harvested` false the voucher record stays as it is, as for a rig whose newer report lands
    /// before any harvest syncs the record (R3-04, row S).
    function _postAt(uint256 id, uint64 at, bool harvested) internal {
        if (!minted[id]) return;
        Health h = health[id];
        uint64 base = baseOf[id];
        postedHealth[id] = h;
        postedAt[id] = at;
        if (h == Health.NoReport) {
            feed.clear(id);
        } else if (h == Health.Rescued) {
            RigReport memory r;
            r.rigId = uint64(id);
            r.observedAt = at;
            r.bscBlock = 2;
            feed.set(r);
        } else {
            RigReport memory r;
            r.rigId = uint64(id);
            r.circuitId = uint64(id + 1000);
            r.since = uint64(block.timestamp - 30 days);
            r.circuits = address(0xC1C);
            r.observedAt = at;
            r.status = h == Health.Stopped ? 2 : 1;
            r.custodied = h != Health.NoCustody;
            r.verifWeight = base + 10;
            r.bonus = 10;
            r.totalVerifWeight = NETWORK_WEIGHT;
            r.bscBlock = 1;
            r.taskId = 4;
            feed.set(r);
        }
        // The voucher record only moves when the rig is harvested, which a stopped, rescued or
        // unreported rig is not; it moves for a rig that mines (power) or one that has none.
        if (harvested && (h == Health.Healthy || h == Health.ZeroPower)) {
            uint256 power = h == Health.Healthy ? uint256(base) + 10 : 0;
            voucher.setRig(id, at, power);
            recSyncedAt[id] = at;
            recPower[id] = power;
        }
    }

    function _refreshAll() internal {
        for (uint256 id = 1; id <= N_RIGS; ++id) {
            _post(id);
        }
    }

    /// Most evidence calls follow a fresh post; one in four sees whatever age the reports have.
    function _maybeRefresh(uint256 seed) internal {
        if (seed % 4 != 0) _refreshAll();
    }

    // ───────────────────────── the impairment model (SPEC §7.2, §10.5, redeploy 3 R3-00)

    /// R3-00 base(r): a stored report while the feed is on, about the rig, not dated too far ahead.
    function _reportBase(uint256 id) internal view returns (bool) {
        return !pool.feedDisabled() && !feed.broken() && postedHealth[id] != Health.NoReport
            && postedAt[id] <= block.timestamp + CLOCK_SKEW;
    }

    function _fresh(uint256 id) internal view returns (bool) {
        return block.timestamp <= uint256(postedAt[id]) + REPORT_AGE;
    }

    /// The handler's own enable floor: its last successful `enableFeed` plus skew (R3-01).
    function _enableFloor() internal view returns (uint256) {
        return uint256(enabledAt) + CLOCK_SKEW;
    }

    function _badReport(uint256 id) internal view returns (bool) {
        Health h = postedHealth[id];
        return h == Health.Stopped || h == Health.NoCustody || h == Health.Rescued;
    }

    /// R3-00 known: a readable record not dated more than the skew ahead (R3-03).
    function _recordKnown(uint256 id) internal view returns (bool) {
        return !voucher.badRigs() && recSyncedAt[id] <= block.timestamp + CLOCK_SKEW;
    }

    /// Impairment evidence for rig `id`: a fresh bad report seen at or after `from` and the enable
    /// floor (row E), or a voucher record with power 0 synced at or after `syncedFrom` (row VE) that no
    /// newer good report at or after the enable floor shields, whatever its age (row S). Every good
    /// report this handler posts is sane.
    function _impairedModel(uint256 id, uint256 from, uint256 syncedFrom) internal view returns (bool) {
        bool admitted = _reportBase(id) && postedAt[id] >= _enableFloor();
        if (admitted && _fresh(id) && postedAt[id] >= from && _badReport(id)) return true;
        bool shield = admitted && !_badReport(id) && postedAt[id] > recSyncedAt[id];
        return _recordKnown(id) && recPower[id] == 0 && recSyncedAt[id] >= syncedFrom && !shield;
    }

    /// The newest reading at or after `from`: a bad report of any age, even from before the enable
    /// floor (row B); a good report from before the enable floor, which may hide what it overwrote, so
    /// it reads as unknown (row U); a fresh good report at or after the enable floor (row H); or the
    /// voucher record (row VC). The newest wins; on a tie impairment wins, then the report. Unknown
    /// masks only health: a power-0 record under row U is impaired at any age (L-04). Unknown and no
    /// reading both mean missing (0).
    function _verdictModel(uint256 id, uint256 from) internal view returns (uint8) {
        uint8 rep = 3; // no report candidate
        if (_reportBase(id) && postedAt[id] >= from) {
            if (_badReport(id)) rep = 2;
            else if (postedAt[id] < _enableFloor()) rep = 0;
            else if (_fresh(id)) rep = 1;
        }
        bool rec = _recordKnown(id) && recSyncedAt[id] >= from;
        uint8 recV = recPower[id] == 0 ? 2 : 1;
        if (rep == 3) return rec ? recV : 0;
        if (rep == 0 && rec && recV == 2) return 2;
        if (!rec || postedAt[id] > recSyncedAt[id]) return rep;
        if (recSyncedAt[id] > postedAt[id]) return recV;
        return rep == 2 || recV == 2 ? 2 : rep;
    }

    function _deadline(FlagModel storage m) internal view returns (uint256) {
        uint256 end = uint256(m.flaggedAt) + CURE + EVIDENCE + 1;
        for (uint256 i; i < brakes.length; ++i) {
            Brake memory f = brakes[i];
            if (f.to <= m.flaggedAt) continue;
            if (f.from >= end) break;
            if (f.to == type(uint64).max) return type(uint64).max;
            uint256 start = f.from > m.flaggedAt ? f.from : m.flaggedAt;
            end += f.to - start;
        }
        return end - 1;
    }

    function _expired(FlagModel storage m) internal view returns (bool) {
        return m.live && block.timestamp > _deadline(m);
    }

    function _flagFloor(RigAgent a) internal view returns (uint256) {
        FlagModel storage m = flagOf[address(a)];
        if (!m.live) return uint256(evidenceFloor[address(a)]) + CLOCK_SKEW;
        return _expired(m) ? _deadline(m) + 1 + CLOCK_SKEW : type(uint64).max;
    }

    function _disableFeed() internal {
        if (!pool.feedDisabled()) {
            uint256 n = brakes.length;
            if (n != 0 && brakes[n - 1].to >= block.timestamp) brakes[n - 1].to = type(uint64).max;
            else brakes.push(Brake(uint64(block.timestamp), type(uint64).max));
        }
        vm.prank(guardian);
        pool.disableFeed();
    }

    function _anyImpaired(RigAgent a, uint256 from) internal view returns (bool) {
        uint256[] memory ids = a.collateralOf();
        for (uint256 i; i < ids.length; ++i) {
            if (_impairedModel(ids[i], from, from)) return true;
        }
        return false;
    }

    function _sync(RigAgent a) internal {
        if (!a.hasLoan()) flagOf[address(a)].live = false;
    }

    function _flagCall(RigAgent a, uint256 id) internal returns (bool success) {
        _sync(a);
        FlagModel storage m = flagOf[address(a)];
        bool eligible = a.hasLoan() && _inCollateral(a, id) && (!m.live || _expired(m));
        bool closes = eligible && bem.balanceOf(address(a)) >= a.loanOf().debt;
        uint256 floor = _flagFloor(a);
        bool justified = eligible && (closes || _impairedModel(id, floor, floor));
        bytes4[] memory allowed = _four(
            RigAgent.NoLoan.selector,
            RigAgent.NotCollateral.selector,
            RigAgent.FlagLive.selector,
            RigAgent.NoEvidence.selector
        );
        success = _try("flagImpaired", keeper, address(a), abi.encodeCall(RigAgent.flagImpaired, (id)), allowed);
        if (success) {
            if (!justified) _violate("a flag was raised without evidence, or over a live flag");
            if (!a.hasLoan()) {
                m.live = false;
                return success;
            }
            m.live = true;
            m.flaggedAt = uint64(block.timestamp);
            m.rig = id;
            if (a.loanOf().impairedAt != block.timestamp) _violate("the flag time was not recorded");
        } else if (justified) {
            _violate("a flag was refused despite evidence");
        }
    }

    function _clearCall(RigAgent a) internal returns (bool success) {
        _sync(a);
        FlagModel storage m = flagOf[address(a)];
        bool justified;
        if (a.hasLoan() && m.live) {
            uint256 from = uint256(m.flaggedAt) + CURE + CLOCK_SKEW;
            justified = _expired(m);
            uint256[] memory ids = a.collateralOf();
            for (uint256 i; i < ids.length; ++i) {
                uint8 v = _verdictModel(ids[i], from);
                if (v == 2 || (ids[i] == m.rig && v != 1)) justified = false;
            }
        }
        bytes4[] memory allowed = _four(
            RigAgent.NoLoan.selector,
            RigAgent.NoFlag.selector,
            RigAgent.FlagNotExpired.selector,
            RigAgent.NoHealthEvidence.selector
        );
        uint256 ta0 = pool.totalAssets();
        uint256 s0 = pool.totalSupply();
        success = _try("clearExpiredFlag", keeper, address(a), abi.encodeCall(RigAgent.clearExpiredFlag, ()), allowed);
        if (success) {
            if (!justified) {
                _violate("a flag was cleared before it expired, with the feed off, or without health evidence");
            }
            m.live = false;
            evidenceFloor[address(a)] = uint64(block.timestamp);
            _checkPrice(ta0, s0);
        } else if (justified) {
            _violate("an expired flag with health evidence was not cleared");
        }
    }

    function _seize(RigAgent a) internal returns (bool success) {
        _sync(a);
        FlagModel storage m = flagOf[address(a)];
        bool justified;
        if (a.hasLoan() && m.live) {
            uint256 from = uint256(m.flaggedAt) + CURE;
            justified = block.timestamp >= from && !_expired(m) && _anyImpaired(a, from + CLOCK_SKEW);
        }
        bytes4[] memory allowed = new bytes4[](6);
        allowed[0] = RigAgent.NoLoan.selector;
        allowed[1] = RigAgent.NoFlag.selector;
        allowed[2] = RigAgent.CureWindow.selector;
        allowed[3] = RigAgent.FlagExpired.selector;
        allowed[4] = RigAgent.NoEvidence.selector;
        allowed[5] = RigAgent.NoDebt.selector;
        uint256 reserveBefore = pool.reserve();
        uint256 principalBefore = pool.loanPrincipalOf(address(a));
        uint256 agentBal = bem.balanceOf(address(a));
        uint256 debt0 = a.hasLoan() ? a.loanOf().debt : 0;
        uint256[] memory ids0 = a.collateralOf();
        uint256 ta0 = pool.totalAssets();
        uint256 s0 = pool.totalSupply();
        success = _try("seize", keeper, address(a), abi.encodeCall(RigAgent.seize, ()), allowed);
        if (success) {
            if (!justified) {
                _violate("a seize happened without a live flag, inside the cure window, or on no evidence");
            }
            m.live = false;
            if (!a.closed() || a.hasLoan()) _violate("seize left the agent open");
            if (pool.loanPrincipalOf(address(a)) != 0 || pool.doubtfulOf(address(a)) != 0) {
                _violate("seize left pool books for the agent");
            }
            // the loss reserve absorbs what it can of the write-off (SPEC §11)
            if (agentBal == 0 && pool.reserve() != reserveBefore - _min(principalBefore, reserveBefore)) {
                _violate("write-off did not draw the reserve");
            }
            // every collateral voucher goes to the pool, unless the voucher refuses to move it
            for (uint256 i; i < ids0.length; ++i) {
                if (_moves(ids0[i]) && (voucher.ownerOf(ids0[i]) != address(pool) || _inCollateral(a, ids0[i]))) {
                    _violate("seize left a collateral voucher behind");
                }
                // R3-02: every collateral id is recorded as seized, moved or kept
                if (!a.wasSeized(ids0[i])) _violate("seize did not record a collateral id");
                seizedAgent.push(a);
                seizedId.push(ids0[i]);
                seizedBy[address(a)][ids0[i]] = true;
            }
            _checkPrice(ta0, s0);
            _checkSeizeReserve(a, reserveBefore, ta0);
        } else if (justified && agentBal < debt0) {
            _violate("a seize was refused despite a live flag, an open window and evidence");
        }
    }

    // ───────────────────────── lenders

    function deposit(uint256 who, uint256 amt) external priced {
        address l = lenders[who % N_LENDERS];
        amt = bound(amt, 1, 30 * BEM);
        bem.mint(l, amt);
        uint256 doubtfulBefore = pool.doubtful();
        uint256 maxBefore = pool.maxDeposit(l);
        vm.startPrank(l);
        bem.approve(address(pool), amt);
        try pool.deposit(amt, l) {
            _hit("deposit");
            if (doubtfulBefore != 0) _violate("deposit succeeded while doubtful");
            if (amt > maxBefore) _violate("deposit above the supply cap");
            // judged against the cap itself, not against what `maxDeposit` claims
            if (pool.totalAssets() > pool.supplyCap()) _violate("deposit pushed assets above the supply cap");
        } catch {}
        vm.stopPrank();
    }

    /// `mint` is the share-denominated entry; it must obey the same doubtful lock and cap.
    function mint(uint256 who, uint256 shares) external priced {
        address l = lenders[who % N_LENDERS];
        shares = bound(shares, 1, 30 * BEM * 1e6);
        uint256 need = pool.previewMint(shares);
        bem.mint(l, need);
        uint256 doubtfulBefore = pool.doubtful();
        vm.startPrank(l);
        bem.approve(address(pool), need);
        try pool.mint(shares, l) {
            _hit("mint");
            if (doubtfulBefore != 0) _violate("mint succeeded while doubtful");
            if (pool.totalAssets() > pool.supplyCap()) _violate("mint pushed assets above the supply cap");
        } catch {}
        vm.stopPrank();
    }

    function withdraw(uint256 who, uint256 amt) external priced {
        address l = lenders[who % N_LENDERS];
        uint256 max = pool.maxWithdraw(l);
        if (max == 0) return;
        amt = bound(amt, 1, max);
        vm.prank(l);
        try pool.withdraw(amt, l, l) {
            _hit("withdraw");
        } catch {
            _violate("withdraw reverted within maxWithdraw");
        }
    }

    function redeem(uint256 who, uint256 shares) external priced {
        address l = lenders[who % N_LENDERS];
        uint256 max = pool.maxRedeem(l);
        if (max == 0) return;
        shares = bound(shares, 1, max);
        vm.prank(l);
        try pool.redeem(shares, l, l) {
            _hit("redeem");
        } catch {
            _violate("redeem reverted within maxRedeem");
        }
    }

    /// Deposit and redeem at once: rounding must never pay the lender more than they put in.
    function roundTrip(uint256 who, uint256 amt) external priced {
        address l = lenders[who % N_LENDERS];
        amt = bound(amt, 1, 5 * BEM);
        bem.mint(l, amt);
        vm.startPrank(l);
        bem.approve(address(pool), amt);
        try pool.deposit(amt, l) returns (uint256 sh) {
            try pool.redeem(sh, l, l) returns (uint256 out) {
                _hit("roundTrip");
                if (out > amt) _violate("deposit then redeem paid more than deposited");
            } catch {}
        } catch {}
        vm.stopPrank();
    }

    function donate(uint256 target, uint256 amt) external priced {
        amt = bound(amt, 1, 2 * BEM);
        if (target % 3 == 0 || agentList.length == 0) {
            bem.mint(address(pool), amt);
        } else {
            bem.mint(address(agentList[target % agentList.length]), amt);
        }
        _hit("donate");
    }

    // ───────────────────────── borrowers: rigs, agents, collateral

    function newRig(uint256 b, uint256 idSeed, uint256 base) external {
        uint256 id;
        for (uint256 j; j < N_RIGS; ++j) {
            uint256 c = 1 + (idSeed % N_RIGS + j) % N_RIGS;
            if (!minted[c]) {
                id = c;
                break;
            }
        }
        if (id == 0) return;
        minted[id] = true;
        touched.push(id);
        baseOf[id] = uint64(bound(base, 1, 300));
        health[id] = Health.Healthy;
        voucher.mint(borrowers[b % N_BORROWERS], id, uint256(baseOf[id]) + 10);
        recSyncedAt[id] = uint64(block.timestamp);
        recPower[id] = uint256(baseOf[id]) + 10;
        _post(id);
        _hit("newRig");
    }

    /// Mint a rig for a borrower, give them an agent and pledge the rig, in one move, so that
    /// the borrow paths are reached often instead of by luck.
    function bootstrap(uint256 b, uint256 seed, uint256 base) external {
        this.newRig(b, seed, base);
        this.makeAgent(b, seed);
        address borrower = borrowers[b % N_BORROWERS];
        address a = factory.predictAgent(borrower, seed % N_INDEX);
        if (!factory.isAgent(a)) return;
        (uint256 id, bool found) = _rigOf(borrower, seed);
        if (!found) return;
        vm.prank(borrower);
        try voucher.safeTransferFrom(borrower, a, id) {
            _hit("bootstrap");
        } catch {}
    }

    function makeAgent(uint256 b, uint256 index) external {
        address borrower = borrowers[b % N_BORROWERS];
        uint256 i = index % N_INDEX;
        if (factory.isAgent(factory.predictAgent(borrower, i))) return;
        vm.prank(borrower);
        agentList.push(RigAgent(factory.create(i)));
        _hit("makeAgent");
    }

    function pledge(uint256 aSeed, uint256 idSeed) external {
        (RigAgent a, bool ok) = _pick(aSeed);
        if (!ok) return;
        address borrower = a.borrower();
        (uint256 id, bool found) = _rigOf(borrower, idSeed);
        if (!found) return;
        bool closed0 = a.closed();
        vm.prank(borrower);
        try voucher.safeTransferFrom(borrower, address(a), id) {
            _hit("pledge");
            if (closed0) _violate("a closed agent accepted collateral");
        } catch {}
    }

    /// A plain transfer (no hook), as a bridge mint or `transferFrom` would do, then `register`.
    function plainSendAndRegister(uint256 aSeed, uint256 idSeed) external {
        (RigAgent a, bool ok) = _pick(aSeed);
        if (!ok) return;
        address borrower = a.borrower();
        (uint256 id, bool found) = _rigOf(borrower, idSeed);
        if (!found) return;
        bool open0 =
            !a.closed() && !a.hasLoan() && !_inCollateral(a, id) && a.collateralOf().length < a.MAX_COLLATERAL();
        vm.prank(borrower);
        try voucher.transferFrom(borrower, address(a), id) {
            bool shouldPass = open0 && voucher.ownerOf(id) == address(a);
            vm.prank(borrower);
            try a.register(id) {
                _hit("register");
            } catch (bytes memory ret) {
                _notBrake("register", ret);
                if (shouldPass) _violate("register refused a voucher the agent holds");
            }
        } catch {}
    }

    /// A voucher holder who is not the agent's borrower: the hook path must refuse, and a plain
    /// transfer must not make the voucher collateral (invariant 11).
    function strangerSend(uint256 aSeed, uint256 idSeed, bool viaHook) external {
        (RigAgent a, bool ok) = _pick(aSeed);
        uint256 id = 1 + idSeed % N_RIGS;
        if (!ok || !minted[id]) return;
        address holder = voucher.ownerOf(id);
        if (holder == a.borrower()) return;
        bool isUser;
        for (uint256 i; i < borrowers.length; ++i) {
            if (borrowers[i] == holder) isUser = true;
        }
        if (!isUser) return;
        uint256 lenBefore = a.collateralOf().length;
        vm.prank(holder);
        if (viaHook) {
            try voucher.safeTransferFrom(holder, address(a), id) {
                _violate("a non-borrower added collateral through the hook");
            } catch {}
        } else {
            try voucher.transferFrom(holder, address(a), id) {} catch {}
        }
        if (a.collateralOf().length != lenBefore) _violate("collateral set changed without the borrower");
    }

    function release(uint256 aSeed) external {
        (RigAgent a, bool ok) = _pick(aSeed);
        if (!ok) return;
        // an agent that could borrow keeps its collateral most of the time, so loans get opened
        if (aSeed % 6 != 0 && _canBorrow(a)) return;
        bool shouldPass = !a.hasLoan() && !a.closed() && _allCallable(a.collateralOf());
        address borrower = a.borrower();
        vm.prank(borrower);
        try a.release() {
            _hit("release");
            if (shouldPass && voucher.mode() == MockVoucher.Mode.Normal && a.collateralOf().length != 0) {
                _violate("release left movable collateral");
            }
        } catch (bytes memory ret) {
            _notBrake("release", ret);
            if (shouldPass) _violate("release refused an agent with no loan");
        }
        _checkSeizedVouchers("release");
    }

    function withdrawVoucher(uint256 aSeed, uint256 idSeed) external {
        (RigAgent a, bool ok) = _pick(aSeed);
        uint256 id = 1 + idSeed % N_RIGS;
        if (!ok || !minted[id]) return;
        // R3-02: a voucher that was collateral at a seize never leaves, listed or not
        bool shouldPass = voucher.ownerOf(id) == address(a) && (!_inCollateral(a, id) || (!a.hasLoan() && !a.closed()))
            && _callable(id) && !seizedBy[address(a)][id];
        address borrower = a.borrower();
        vm.prank(borrower);
        try a.withdrawVoucher(id) {
            _hit("withdrawVoucher");
        } catch (bytes memory ret) {
            _notBrake("withdrawVoucher", ret);
            if (shouldPass) _violate("withdrawVoucher refused a voucher it could hand out");
        }
        _checkSeizedVouchers("withdrawVoucher");
    }

    /// SPEC §15 invariant 21 (redeploy 3 R3-02): no voucher that was collateral of an agent at its
    /// seize is ever sent to that agent's borrower. Only agent functions could send it there: neither
    /// this handler nor its Safe moves ever do.
    function _checkSeizedVouchers(string memory label) internal {
        for (uint256 i; i < seizedId.length; ++i) {
            if (voucher.ownerOf(seizedId[i]) == seizedAgent[i].borrower()) {
                _violate(string.concat("a seized voucher reached its borrower after ", label));
            }
        }
    }

    /// Releasing, withdrawing and registering stay open under every brake (invariant 7): a brake
    /// error is a bug.
    function _notBrake(string memory label, bytes memory ret) internal {
        bytes4 sel = ret.length >= 4 ? bytes4(ret) : bytes4(0);
        if (
            sel == RigAgent.BorrowsArePaused.selector || sel == RigAgent.FeedIsDisabled.selector
                || sel == TapePool.SwapQueued.selector
        ) _violate(string.concat("a brake blocked ", label));
    }

    // ───────────────────────── borrowing and repayment

    /// Lending moves BEM from idle to outstanding, so it must not lower the share price (Q7).
    function borrow(uint256 aSeed, uint256 termSeed, uint256 pSeed) external priced {
        (RigAgent a, bool ok) = _pickFor(aSeed, 2);
        if (!ok) return;
        _maybeRefresh(termSeed);
        // three borrows in four see a sound policy, feed and voucher record; the rest see whatever is set
        if (termSeed % 4 != 0) _healInputs();
        // term 2 does not exist and must be refused
        uint8 term = termSeed % 8 == 0 ? 2 : uint8(termSeed % 2);
        uint256 principal = _principalFor(a, term, pSeed);
        bool braked = pool.borrowsPaused() || pool.feedDisabled() || _settling();
        address payer = a.borrower();
        Bals memory b0 = _bals(a);
        uint256 ops = pool.opsFee(term > 1 ? 0 : term);
        expectedOwnerEth = owner.balance + ops;
        vm.deal(payer, payer.balance + ops);
        vm.prank(payer);
        try a.borrow{value: ops}(term, principal, type(uint256).max, type(uint16).max) {
            _hit("borrow");
            borrowedAt[address(a)] = uint64(block.timestamp);
            evidenceFloor[address(a)] = uint64(block.timestamp);
            loanShare[address(a)] = uint16(pool.reserveShareBps());
            loanCap[address(a)] = uint16(pool.reserveCapBps());
            flagOf[address(a)].live = false;
            if (term > 1) _violate("borrow accepted a bad term");
            if (braked) _violate("borrow succeeded under a brake");
            _checkBorrow(a, term, principal, b0);
        } catch {}
    }

    /// Most of the time a principal the rig can carry (so loans get opened), now and then a wild one.
    function _principalFor(RigAgent a, uint8 term, uint256 pSeed) internal view returns (uint256) {
        uint256 minAdv = pool.minAdvance();
        if (pSeed % 5 == 0) return minAdv;
        if (pSeed % 5 == 4 || term > 1) return bound(pSeed, minAdv, minAdv + 8 * BEM);
        uint256 cap;
        try MockCreditPolicy(address(pool.policy())).maxDebt(address(a), a.collateralOf(), term) returns (uint256 m) {
            cap = m;
        } catch {}
        uint256 room = cap > pool.minFee() ? (cap - pool.minFee()) * 95 / 100 : 0;
        return bound(pSeed, minAdv, room > minAdv ? _min(room, 8 * BEM) : minAdv);
    }

    function _checkBorrow(RigAgent a, uint8 term, uint256 principal, Bals memory b0) internal {
        uint256[] memory ids = a.collateralOf();
        if (ids.length == 0) _violate("borrow with no collateral");
        for (uint256 i; i < ids.length; ++i) {
            if (voucher.ownerOf(ids[i]) != address(a)) _violate("borrow with collateral the agent does not hold");
        }
        RigAgent.LoanView memory v = a.loanOf();
        uint256 bps = term == 0 ? pool.feeBps7d() : pool.feeBps14d();
        if (!v.open || v.principal != principal || v.principal0 != principal) _violate("loan principal mismatch");
        if (v.feeLeft * 10_000 < principal * bps || v.feeLeft < pool.minFee()) _violate("fee rounded down");
        if (v.maturity != v.start + (term == 0 ? 7 days : 14 days)) _violate("maturity not derived from the term");
        if (v.lateBpsPerDay != pool.lateFeeBpsPerDay()) _violate("the loan did not take the current late fee rate");
        if (v.lateAccruedTo != v.maturity || v.lateFeeDue != 0) {
            _violate("late fees must start at the maturity, at zero");
        }
        MockCreditPolicy p = MockCreditPolicy(address(pool.policy()));
        MockCreditPolicy.Mode mode = p.mode();
        if (mode == MockCreditPolicy.Mode.Normal) {
            if (principal + v.feeLeft > p.maxDebt(address(a), ids, term)) _violate("debt above the policy limit");
        } else if (mode != MockCreditPolicy.Mode.AllowEmpty) {
            _violate("borrow accepted a policy that did not clearly allow it");
        }
        uint256 ta = pool.totalAssets();
        if (pool.outstandingPrincipal() > _min(pool.borrowCapAbs(), ta * pool.borrowCapBps() / 10_000)) {
            _violate("borrow above the borrow cap");
        }
        if (pool.principalOf(a.borrower()) > _min(pool.perBorrowerAbs(), ta * pool.perBorrowerBps() / 10_000)) {
            _violate("borrow above the borrower cap");
        }
        if (pool.outstandingPrincipal() > pool.convertToAssets(pool.balanceOf(pool.backstop()))) {
            _violate("borrow above backstop");
        }
        // the proceeds go to the borrower (not the agent, not the caller), the fee to the owner, once
        Bals memory b1 = _bals(a);
        if (b1.borrower != b0.borrower + principal + b0.agent) _violate("the advance did not reach the borrower");
        if (b1.pool + principal != b0.pool) _violate("the pool did not pay exactly the advance");
        if (b1.agent != 0) _violate("BEM left in the agent after borrow");
        if (owner.balance != expectedOwnerEth) _violate("the operating fee did not reach the owner exactly");
    }

    /// A harvest pays the agent while it holds the voucher.
    function harvest(uint256 aSeed, uint256 amt) external {
        (RigAgent a, bool ok) = _pickFor(aSeed, 1);
        if (!ok) return;
        bem.mint(address(a), bound(amt, 1, 4 * BEM));
        _hit("harvest");
    }

    struct SweepPre {
        uint256 outstanding;
        uint256 reserve;
        uint256 totalAssets;
        uint16 shareBps;
        uint16 capBps;
    }

    function sweep(uint256 aSeed) external priced {
        (RigAgent a, bool ok) = _pickFor(aSeed, 1);
        if (!ok) return;
        bool closed0 = a.closed();
        Bals memory b0 = _bals(a);
        RigAgent.LoanView memory v0 = a.loanOf();
        SweepPre memory pre = SweepPre(
            pool.outstandingPrincipal(), pool.reserve(), pool.totalAssets(), loanShare[address(a)], loanCap[address(a)]
        );
        if (!closed0 && v0.open) _checkLateModel(v0);
        bool success =
            _try("sweep", keeper, address(a), abi.encodeCall(RigAgent.sweep, ()), _one(RigAgent.NoLoan.selector));
        if (!success) return;
        _sync(a);
        Bals memory b1 = _bals(a);
        if (b1.borrower < b0.borrower || b1.pool < b0.pool) {
            _violate("sweep took BEM from the borrower or the pool");
            return;
        }
        if (b1.agent != 0) _violate("BEM stranded in the agent after sweep");
        if (b1.keeper != b0.keeper) _violate("sweep paid the caller");
        if ((b1.borrower - b0.borrower) + (b1.pool - b0.pool) != b0.agent) _violate("sweep lost or created BEM");
        // the borrower only ever gets what is left once the loan is paid off; a closed agent pays the pool
        if ((closed0 || a.hasLoan()) && b1.borrower != b0.borrower) {
            _violate("sweep paid the borrower while debt remained");
        }
        if (!closed0 && v0.open) _checkWaterfall(v0, b0, b1, pre);
    }

    /// The late fee: the loan rate times the remaining principal times the days late, rounded up
    /// (SPEC §4.4). Judged only while nothing has accrued since maturity, when the whole fee is the
    /// not-yet-booked part.
    function _checkLateModel(RigAgent.LoanView memory v0) internal {
        if (block.timestamp <= v0.maturity && v0.lateFeeDue != 0) _violate("a late fee accrued before the maturity");
        if (block.timestamp > v0.maturity && v0.lateBpsPerDay != 0 && v0.lateAccruedTo == v0.maturity) {
            uint256 num = v0.principal * v0.lateBpsPerDay * (block.timestamp - v0.maturity);
            uint256 den = 10_000 * 1 days;
            if (v0.lateFeeDue > (num + den - 1) / den) {
                _violate("the late fee is not rate x principal x days late, rounded up");
            }
        }
    }

    /// Debt is paid late fee first, then the flat fee, then principal; the borrower only gets what is
    /// left once the principal is paid; the fee is split to the reserve by share, up to its cap
    /// (SPEC §10.4, §11).
    function _checkWaterfall(RigAgent.LoanView memory v0, Bals memory b0, Bals memory b1, SweepPre memory pre)
        internal
    {
        uint256 feePart;
        uint256 prin;
        {
            uint256 late = _min(b0.agent, v0.lateFeeDue);
            uint256 flat = _min(b0.agent - late, v0.feeLeft);
            prin = _min(b0.agent - late - flat, v0.principal);
            feePart = late + flat;
            if (b1.pool - b0.pool != feePart + prin) {
                _violate("sweep did not pay late fee, fee and principal in order");
            }
            uint256 leftover = prin == v0.principal ? b0.agent - feePart - prin : 0;
            if (b1.borrower - b0.borrower != leftover) _violate("sweep sent the wrong leftover to the borrower");
        }
        if (pre.outstanding - pool.outstandingPrincipal() != prin) _violate("sweep booked the wrong principal");
        uint256 toReserve = feePart * pre.shareBps / 10_000;
        uint256 cap = pre.totalAssets * pre.capBps / 10_000;
        uint256 room = cap > pre.reserve ? cap - pre.reserve : 0;
        if (toReserve > room) toReserve = room;
        if (pool.reserve() != pre.reserve + toReserve) _violate("the fee was not split to the reserve as specified");
    }

    function repay(uint256 aSeed, uint256 amt) external priced {
        (RigAgent a, bool ok) = _pickFor(aSeed, 1);
        if (!ok) return;
        amt = bound(amt, 0, 4 * BEM);
        address payer = borrowers[aSeed % N_BORROWERS];
        bem.mint(payer, amt);
        vm.prank(payer);
        bem.approve(address(a), amt);
        uint256 keeperBefore = bem.balanceOf(keeper);
        SweepPre memory pre = SweepPre(
            pool.outstandingPrincipal(), pool.reserve(), pool.totalAssets(), loanShare[address(a)], loanCap[address(a)]
        );
        bool success =
            _try("repay", payer, address(a), abi.encodeCall(RigAgent.repay, (amt)), _one(RigAgent.NoLoan.selector));
        if (!success) return;
        _sync(a);
        if (bem.balanceOf(address(a)) != 0) _violate("BEM stranded in the agent after repay");
        if (bem.balanceOf(keeper) != keeperBefore) _violate("repay paid a third party");
        _checkReserveCap(pre);
    }

    /// Q10: a repayment grows the reserve only up to the cap measured on `totalAssets` before it. Not a
    /// global invariant: `markDoubtful` lowers `totalAssets` later without touching the reserve.
    function _checkSeizeReserve(RigAgent a, uint256 reserveBefore, uint256 ta0) internal {
        _checkReserveCap(SweepPre(0, reserveBefore, ta0, loanShare[address(a)], loanCap[address(a)]));
    }

    function _checkReserveCap(SweepPre memory pre) internal {
        uint256 cap = pre.totalAssets * pre.capBps / 10_000;
        if (pool.reserve() > pre.reserve && pool.reserve() > cap) {
            _violate("a repayment grew the reserve past its cap");
        }
    }

    function claimLate(uint256 aSeed) external priced {
        (RigAgent a, bool ok) = _pick(aSeed);
        if (!ok) return;
        bool closed0 = a.closed();
        Bals memory b0 = _bals(a);
        bool success = _try(
            "claimLate", keeper, address(a), abi.encodeCall(RigAgent.claimLate, ()), _one(RigAgent.LoanOpen.selector)
        );
        if (!success) return;
        Bals memory b1 = _bals(a);
        if (b1.agent != 0) _violate("BEM stranded in the agent after claimLate");
        // late BEM goes to the borrower, or to the pool once the agent is closed
        if (closed0) {
            if (b1.pool != b0.pool + b0.agent || b1.borrower != b0.borrower) {
                _violate("a closed agent did not forward to the pool");
            }
        } else {
            if (b1.borrower != b0.borrower + b0.agent || b1.pool != b0.pool) {
                _violate("late BEM did not reach the borrower");
            }
        }
    }

    // ───────────────────────── impairment

    function setHealth(uint256 idSeed, uint256 modeSeed) external {
        uint256 id = 1 + idSeed % N_RIGS;
        if (!minted[id]) return;
        health[id] = Health(modeSeed % 6);
        _post(id);
        _hit("setHealth");
    }

    /// A rig mines again after a power-0 harvest: a newer healthy report lands before any harvest
    /// syncs the voucher record, so an older power-0 record is no longer evidence (R3-04, row S).
    function reviveReport(uint256 idSeed) external {
        uint256 id = 1 + idSeed % N_RIGS;
        if (!minted[id]) return;
        health[id] = Health.Healthy;
        _postAt(id, uint64(block.timestamp + CLOCK_SKEW), false);
        _hit("reviveReport");
    }

    /// Change the health of one of an agent's collateral rigs (mostly back to healthy).
    function impair(uint256 aSeed, uint256 modeSeed) external {
        (RigAgent a, bool ok) = _pickFor(aSeed, 1);
        if (!ok) return;
        uint256[] memory ids = a.collateralOf();
        if (ids.length == 0) return;
        uint256 id = ids[aSeed % ids.length];
        uint256 r = modeSeed % 16;
        health[id] = r < 6 ? Health.Healthy : Health(r % 6);
        _post(id);
        _hit("impair");
    }

    function flagImpaired(uint256 aSeed, uint256 idSeed) external {
        (RigAgent a, bool ok) = _pickFor(aSeed, 1);
        if (!ok) return;
        uint256[] memory ids = a.collateralOf();
        if (ids.length == 0) return;
        _maybeRefresh(idSeed);
        _flagCall(a, ids[idSeed % ids.length]);
    }

    /// Impair a borrowing agent's collateral and flag it; with `finish`, wait out the cure window
    /// and seize. Without it the loan is left flagged and doubtful for the other actions.
    function driveToSeize(uint256 aSeed, uint256 modeSeed, bool finish) external {
        (RigAgent a, bool ok) = _pickFor(aSeed, 1);
        if (!ok || !a.hasLoan()) return;
        uint256[] memory ids = a.collateralOf();
        if (ids.length == 0) return;
        uint256 id = ids[aSeed % ids.length];
        if (a.loanOf().impairedAt == 0) {
            health[id] = Health(1 + modeSeed % 5);
            _refreshAll();
            _flagCall(a, id);
        }
        RigAgent.LoanView memory v = a.loanOf();
        if (!v.open || v.impairedAt == 0) return;
        _hit("driveToSeize");
        if (!finish) return;
        if (block.timestamp < v.seizeStart) vm.warp(v.seizeStart + 1);
        _refreshAll();
        _seize(a);
    }

    /// Let a flag run out on healthy evidence: the doubtful mark must come back, and only then.
    /// With `feedOff` the guardian switches the feed off first: then the flag must NOT expire, however
    /// late it is (SPEC §10.5, invariant 16). The feed is switched back on afterwards.
    function healAndExpire(uint256 aSeed, bool feedOff) external {
        (RigAgent a, bool ok) = _pickFor(aSeed, 3);
        if (!ok) return;
        RigAgent.LoanView memory v = a.loanOf();
        if (!v.open || v.impairedAt == 0) return;
        uint256[] memory ids = a.collateralOf();
        for (uint256 i; i < ids.length; ++i) {
            health[ids[i]] = Health.Healthy;
        }
        if (feedOff) {
            _disableFeed();
        }
        if (v.deadline != type(uint64).max && block.timestamp <= v.deadline) vm.warp(uint256(v.deadline) + 1);
        _hit("healAndExpire");
        _maybeRefresh(aSeed);
        _clearCall(a);
        if (feedOff) _enableFeed();
    }

    function clearExpiredFlag(uint256 aSeed) external {
        (RigAgent a, bool ok) = _pickFor(aSeed, 3);
        if (!ok) return;
        _maybeRefresh(aSeed);
        _clearCall(a);
    }

    function warpToSeizeWindow(uint256 aSeed) external {
        (RigAgent a, bool ok) = _pickFor(aSeed, 3);
        if (!ok) return;
        RigAgent.LoanView memory v = a.loanOf();
        if (!v.open || v.impairedAt == 0) return;
        if (block.timestamp < v.seizeStart) vm.warp(v.seizeStart + 1);
        _hit("warpToSeizeWindow");
    }

    function seize(uint256 aSeed) external {
        (RigAgent a, bool ok) = _pickFor(aSeed, 3);
        if (!ok) return;
        _maybeRefresh(aSeed);
        _seize(a);
    }

    /// Just before the cure window ends, with every report stamped a few seconds ahead of the clock
    /// (the agents accept up to 60 seconds of skew): the window itself must still hold (SPEC §10.5).
    function seizeJustBefore(uint256 aSeed, uint256 secs) external {
        (RigAgent a, bool ok) = _pickFor(aSeed, 3);
        if (!ok) return;
        RigAgent.LoanView memory v = a.loanOf();
        if (!v.open || v.impairedAt == 0) return;
        uint256 lead = bound(secs, 1, CLOCK_SKEW - 1);
        uint256 target = uint256(v.seizeStart) - lead;
        if (block.timestamp > target) return; // already inside or past the window
        vm.warp(target);
        for (uint256 id = 1; id <= N_RIGS; ++id) {
            _postAt(id, uint64(block.timestamp + CLOCK_SKEW));
        }
        _hit("seizeJustBefore");
        _seize(a);
    }

    function forwardVouchers(uint256 aSeed) external {
        (RigAgent a, bool ok) = _pickFor(aSeed, 4);
        if (!ok) return;
        _try(
            "forwardVouchers",
            keeper,
            address(a),
            abi.encodeCall(RigAgent.forwardVouchers, ()),
            _one(RigAgent.NotClosed.selector)
        );
        _checkSeizedVouchers("forwardVouchers");
    }

    // ───────────────────────── seized vouchers (redeploy 3 R3-02)

    /// A voucher that misreports `ownerOf` for one listed id, as the zero address or as a third party,
    /// for up to three agent calls: a seize (moved into the seize window first), a retry and the
    /// borrower's withdrawal on a closed agent, or a release on an open agent with no loan.
    function misreport(uint256 aSeed, uint256 idSeed, bool asZero, uint256 calls) external {
        (RigAgent a, bool ok) = _pickFor(aSeed, aSeed % 2 == 0 ? 3 : 4);
        if (!ok) return;
        uint256[] memory ids = a.collateralOf();
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        calls = bound(calls, 1, 3);
        bool flagged = a.hasLoan() && a.loanOf().impairedAt != 0;
        if (flagged && block.timestamp < a.loanOf().seizeStart) {
            vm.warp(uint256(a.loanOf().seizeStart) + 1);
            _refreshAll();
        }
        misreported[id] = true;
        vm.mockCall(
            address(voucher),
            abi.encodeWithSelector(voucher.ownerOf.selector, id),
            abi.encode(asZero ? address(0) : safeHolder)
        );
        uint256 made;
        if (flagged) {
            _seize(a);
            ++made;
        } else if (!a.closed() && !a.hasLoan()) {
            vm.prank(a.borrower());
            try a.release() {} catch {}
            ++made;
        }
        if (a.closed() && made < calls) {
            _try(
                "forwardVouchers (misreport)",
                keeper,
                address(a),
                abi.encodeCall(RigAgent.forwardVouchers, ()),
                _one(RigAgent.NotClosed.selector)
            );
            ++made;
        }
        if (a.closed() && made < calls && seizedBy[address(a)][id]) {
            if (_try(
                    "withdrawVoucher (misreport)",
                    a.borrower(),
                    address(a),
                    abi.encodeCall(RigAgent.withdrawVoucher, (id)),
                    _one(RigAgent.SeizedVoucher.selector)
                )) _violate("withdrawVoucher released a seized voucher");
        }
        vm.clearMockedCalls();
        misreported[id] = false;
        _hit("misreport");
        _checkSeizedVouchers("misreport");
    }

    /// The TapeOut Safe moves a seized voucher: from the closed agent to a third party and back, or from
    /// the pool back into the closed agent (a voucher upgrade bypasses the mock's transfer modes).
    function safeMove(uint256 seed) external {
        uint256 n = seizedId.length;
        if (n == 0) return;
        uint256 i = seed % n;
        address agent = address(seizedAgent[i]);
        uint256 id = seizedId[i];
        address holder = voucher.ownerOf(id);
        address to;
        if (holder == agent) to = safeHolder;
        else if (holder == safeHolder) to = agent;
        else if (holder == address(pool)) to = agent;
        else return;
        MockVoucher.Mode mode = voucher.mode();
        bool wasBlocked = voucher.blocked(id);
        voucher.setMode(MockVoucher.Mode.Normal);
        voucher.setBlocked(id, false);
        vm.prank(holder);
        voucher.transferFrom(holder, to, id);
        voucher.setMode(mode);
        voucher.setBlocked(id, wasBlocked);
        _hit(holder == address(pool) ? "safeMove pool -> agent" : "safeMove agent <-> third party");
        _checkSeizedVouchers("safeMove");
    }

    /// The borrower of a closed agent asks for a seized voucher, wherever it sits: it must refuse with
    /// `SeizedVoucher`. Then anyone retries the kept ids.
    function withdrawSeized(uint256 seed) external {
        uint256 n = seizedId.length;
        if (n == 0) return;
        RigAgent a = seizedAgent[seed % n];
        uint256 id = seizedId[seed % n];
        if (_try(
                "withdrawSeized",
                a.borrower(),
                address(a),
                abi.encodeCall(RigAgent.withdrawVoucher, (id)),
                _one(RigAgent.SeizedVoucher.selector)
            )) _violate("withdrawVoucher released a seized voucher");
        _hit("withdrawSeized refused");
        _try(
            "forwardVouchers",
            keeper,
            address(a),
            abi.encodeCall(RigAgent.forwardVouchers, ()),
            _one(RigAgent.NotClosed.selector)
        );
        _checkSeizedVouchers("withdrawSeized");
    }

    /// Mostly heals the voucher; one call in four breaks it, so transfers fail only part of the time.
    function breakVoucher(uint256 modeSeed, uint256 idSeed, bool blockOne) external {
        if (modeSeed % 4 != 0) {
            voucher.setMode(MockVoucher.Mode.Normal);
            for (uint256 id = 1; id <= N_RIGS; ++id) {
                voucher.setBlocked(id, false);
            }
            // the ownership invariant applies again once no agent lists a voucher it does not hold
            if (lied && _allCollateralHeld()) lied = false;
        } else if (blockOne) {
            voucher.setBlocked(1 + idSeed % N_RIGS, true);
        } else {
            MockVoucher.Mode m = MockVoucher.Mode(1 + (modeSeed / 4) % 3);
            // A voucher that reports success without moving the token still fires the receiver hook,
            // so an agent can list a voucher it does not hold. Only `borrow` checks `ownerOf`, which
            // is the guard.
            if (m == MockVoucher.Mode.Lie) lied = true;
            voucher.setMode(m);
        }
        _hit("breakVoucher");
    }

    function _allCollateralHeld() internal view returns (bool) {
        for (uint256 i; i < agentList.length; ++i) {
            uint256[] memory ids = agentList[i].collateralOf();
            for (uint256 j; j < ids.length; ++j) {
                if (voucher.ownerOf(ids[j]) != address(agentList[i])) return false;
            }
        }
        return true;
    }

    /// What the policy, the feed and the voucher record answer: mostly well, sometimes wrongly. Every
    /// wrong answer must fail closed, whatever the policy returns (invariant 14).
    function _healInputs() internal {
        MockCreditPolicy(address(pool.policy())).setMode(MockCreditPolicy.Mode.Normal);
        feed.setBroken(false);
        voucher.setBadRigs(false);
    }

    function breakInputs(uint256 seed) external {
        MockCreditPolicy p = MockCreditPolicy(address(pool.policy()));
        uint256 r = seed % 16;
        if (r < 11) {
            _healInputs();
        } else if (r == 11 || r == 12) {
            p.setMode(MockCreditPolicy.Mode(1 + (seed / 16) % 5));
        } else if (r == 13) {
            feed.setBroken(true);
        } else {
            voucher.setBadRigs(true);
        }
        _hit("breakInputs");
    }

    // ───────────────────────── strangers at the pool (invariant 12)

    /// A caller that is not an agent can use none of the pool's agent entry points.
    function strangerPool(uint256 seed) external {
        address who = seed % 2 == 0 ? keeper : lenders[0];
        uint256 k = (seed / 2) % 5;
        bytes memory data;
        if (k == 0) data = abi.encodeCall(TapePool.lend, (pool.minAdvance()));
        else if (k == 1) data = abi.encodeCall(TapePool.repay, (0, 0));
        else if (k == 2) data = abi.encodeCall(TapePool.markDoubtful, ());
        else if (k == 3) data = abi.encodeCall(TapePool.clearDoubtful, ());
        else data = abi.encodeCall(TapePool.writeOff, ());
        vm.prank(who);
        (bool s, bytes memory ret) = address(pool).call(data);
        if (s || bytes4(ret) != TapePool.NotAgent.selector) _violate("a non-agent used a pool entry point");
        _hit("strangerPool");
    }

    /// R3-01: `lend` waits 360 s after the handler's last `enableFeed`.
    function _settling() internal view returns (bool) {
        return block.timestamp < uint256(enabledAt) + CLOCK_SKEW + REPORT_AGE;
    }

    /// The pool's own brake, not the agent's mirror of it: `lend` called as an agent while a brake is on
    /// or while the feed settles after a re-enable.
    function poolLendUnderBrake(uint256 aSeed) external {
        (RigAgent a, bool ok) = _pick(aSeed);
        if (!ok) return;
        if (!pool.borrowsPaused() && !pool.feedDisabled() && !_settling()) return;
        uint256 amt = pool.minAdvance();
        vm.prank(address(a));
        try pool.lend(amt) {
            _violate("pool.lend succeeded under a brake");
        } catch {}
        _hit("poolLendUnderBrake");
    }

    // ───────────────────────── owner and guardian (invariants 6, 7, 13)

    /// One admin move out of many, mostly doing nothing, so the brakes are not on all the time.
    function adminStep(uint256 seed, uint256 value) external {
        uint256 r = seed % 16;
        uint256 s = seed / 16;
        if (r == 0) this.guardianPause();
        else if (r == 1) this.guardianDisableFeed();
        else if (r < 6) this.ownerUnpause();
        else if (r < 8) this.ownerEnableFeed();
        else if (r == 8) this.ownerLowerCap(s, value);
        else if (r == 9) this.ownerQueueParam(s, value);
        else if (r == 10) this.executeParam(s);
        else if (r == 11) this.ownerQueuePolicy();
        else if (r == 12) this.activatePolicy();
        else if (r == 13) this.ownerCancelPolicy();
        else if (r == 14) this.queueAndExecuteParam(s, value);
        else this.queueAndActivatePolicy();
    }

    function guardianPause() external admin {
        vm.prank(guardian);
        pool.pauseBorrows();
        _hit("guardianPause");
    }

    function guardianDisableFeed() external admin {
        _disableFeed();
        _hit("guardianDisableFeed");
    }

    function _enableFeed() internal {
        vm.prank(owner);
        try pool.enableFeed() {
            brakes[brakes.length - 1].to = uint64(block.timestamp + EVIDENCE);
            enabledAt = uint64(block.timestamp);
            _hit("ownerEnableFeed");
        } catch {}
    }

    function ownerEnableFeed() external admin {
        _enableFeed();
    }

    function ownerUnpause() external admin {
        bool queued = pool.policySwapQueued();
        vm.prank(owner);
        try pool.unpauseBorrows() {
            _hit("ownerUnpause");
            if (queued) _violate("unpause succeeded while a policy swap was queued");
        } catch {}
    }

    function ownerLowerCap(uint256 keySeed, uint256 value) external admin {
        TapePool.Param key = TapePool.Param(keySeed % 4);
        uint256 cur = pool.param(key);
        vm.prank(owner);
        try pool.lowerCap(key, bound(value, cur / 2, cur)) {
            _hit("ownerLowerCap");
        } catch {}
    }

    function ownerQueueParam(uint256 keySeed, uint256 value) external admin {
        TapePool.Param key = TapePool.Param(keySeed % 14);
        (uint256 lo, uint256 hi) = pool.bounds(key);
        vm.prank(owner);
        try pool.queueParam(key, bound(value, lo, hi)) {
            _hit("ownerQueueParam");
        } catch {}
    }

    function executeParam(uint256 keySeed) external admin {
        try pool.executeParam(TapePool.Param(keySeed % 14)) {
            _hit("executeParam");
        } catch {}
    }

    /// Queue a change, wait out the timelock, apply it: parameters (a late fee, other fees) really move.
    function queueAndExecuteParam(uint256 keySeed, uint256 value) external admin {
        TapePool.Param key = keySeed % 2 == 0 ? TapePool.Param.LateFeeBpsPerDay : TapePool.Param((keySeed / 2) % 14);
        (uint256 lo, uint256 hi) = pool.bounds(key);
        vm.prank(owner);
        try pool.queueParam(key, bound(value, lo, hi)) {
            vm.warp(block.timestamp + pool.TIMELOCK());
            try pool.executeParam(key) {
                _hit("queueAndExecuteParam");
            } catch {}
        } catch {}
    }

    function ownerQueuePolicy() external admin {
        MockCreditPolicy p = new MockCreditPolicy(feed, ++policyVersion);
        vm.prank(owner);
        try pool.queuePolicy(p) {
            _hit("ownerQueuePolicy");
            if (!pool.borrowsPaused()) _violate("queueing a policy swap did not pause borrows");
        } catch {}
    }

    function activatePolicy() external admin {
        try pool.activatePolicy() {
            _hit("activatePolicy");
        } catch {}
    }

    /// Queue a new policy, wait out its delay and install it: borrows stay paused until the owner unpauses.
    function queueAndActivatePolicy() external admin {
        MockCreditPolicy p = new MockCreditPolicy(feed, ++policyVersion);
        vm.prank(owner);
        try pool.queuePolicy(p) {
            vm.warp(block.timestamp + pool.POLICY_TIMELOCK());
            try pool.activatePolicy() {
                _hit("queueAndActivatePolicy");
                if (address(pool.policy()) != address(p)) _violate("the queued policy was not installed");
                if (!pool.borrowsPaused()) _violate("a policy swap left borrows open");
            } catch {}
        } catch {}
    }

    function ownerCancelPolicy() external admin {
        vm.prank(owner);
        try pool.cancelPolicy() {
            _hit("ownerCancelPolicy");
        } catch {}
    }

    // ───────────────────────── time

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 6 days));
        _hit("warp");
    }
}

/// Independent books for the redeploy's income, losses, reserve snapshots and admission rules.
/// These actions use factory-registered agents directly so accounting is exercised independently
/// of the lifecycle handler above. No model value is copied from a pool accounting getter.
contract RedeployHandler is Test {
    struct Interval {
        uint64 from;
        uint64 to;
    }
    TapePool internal pool;
    MockBEM internal bem;
    address internal owner;
    address internal guardian;
    address internal seedHolder;
    address internal ordinary = makeAddr("model ordinary lender");
    RigAgent[3] internal agents;
    address[3] internal borrowers;
    uint256 public modelTracked = 1_001_000_000;
    uint256 public modelReserve;
    uint256 public modelUntracked;
    uint256 public modelUnvested;
    uint64 public modelUpdated;
    uint64 public modelEnd;
    uint256 public modelSupply = 1_001_000_000 * 1e6;
    uint256 public seedShares = 10e8 * 1e6;
    uint256 public ordinaryShares;
    uint256[3] public principal;
    uint256[3] public marked;
    uint256[3] public absorbed;
    uint16[3] internal shareTerms;
    uint16[3] internal capTerms;
    uint16 internal shareRate = 2_000;
    uint16 internal capRate = 500;
    uint256 internal absoluteCap = 8e8;
    uint256 internal borrowerCap = 4e8;
    bool internal disabled;
    /// The time of this model's last `enableFeed` (R3-01: `lendLimit` is (0, 5) for 360 s after it).
    uint64 internal enabledAt;
    Interval[] internal intervals;
    uint64 internal origin;
    uint256 public lastClock;

    constructor(TapePool p, MockBEM token, AgentFactory factory, address o, address g, address backstop) {
        pool = p;
        bem = token;
        owner = o;
        guardian = g;
        seedHolder = backstop;
        origin = uint64(block.timestamp);
        borrowers = [makeAddr("model borrower a"), makeAddr("model borrower b"), makeAddr("model borrower a")];
        for (uint256 i; i < 3; ++i) {
            vm.prank(borrowers[i]);
            agents[i] = RigAgent(factory.create(i));
        }
    }

    function _remaining() internal view returns (uint256) {
        if (modelUnvested == 0 || block.timestamp >= modelEnd) return 0;
        return modelUnvested * (modelEnd - block.timestamp) / (modelEnd - modelUpdated);
    }

    function _totals() internal view returns (uint256 outstanding, uint256 doubtful) {
        for (uint256 i; i < 3; ++i) {
            outstanding += principal[i];
            doubtful += marked[i];
        }
    }

    function _assets() internal view returns (uint256) {
        (uint256 outstanding, uint256 doubtful) = _totals();
        return modelTracked - modelReserve + outstanding - doubtful - _remaining();
    }

    function _book(uint256 amount) internal {
        if (amount == 0) return;
        uint256 u = _remaining();
        uint256 duration = u == 0 ? 7 days : (u * (modelEnd - block.timestamp) + amount * 7 days) / (u + amount);
        modelUnvested = u + amount;
        modelUpdated = uint64(block.timestamp);
        modelEnd = uint64(block.timestamp + duration);
    }

    function _syncModel() internal {
        modelTracked += modelUntracked;
        _book(modelUntracked);
        modelUntracked = 0;
    }

    function _restore(uint256 i, uint256 amount) internal {
        uint256 r = _min(absorbed[i], amount);
        absorbed[i] -= r;
        _book(r);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _room(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    /// @notice Add untracked income and optionally book it now.
    function income(uint256 amount, bool bookNow) external {
        amount = bound(amount, 0, 2e8);
        bem.mint(address(pool), amount);
        modelUntracked += amount;
        if (bookNow) {
            _syncModel();
            pool.sync();
        }
        _clock();
    }

    /// @notice Deposit or withdraw through an independently priced share balance.
    function liquidity(uint256 amount, bool backstop, bool withdraw_) external {
        address who = backstop ? seedHolder : ordinary;
        uint256 shares = backstop ? seedShares : ordinaryShares;
        uint256 assets = _assets();
        if (withdraw_) {
            uint256 maximum = _min(shares * (assets + 1) / (modelSupply + 1e6), modelTracked - modelReserve);
            if (maximum == 0) return;
            amount = bound(amount, 1, maximum);
            uint256 burned = (amount * (modelSupply + 1e6) + assets) / (assets + 1);
            _syncModel();
            vm.prank(who);
            assertEq(pool.withdraw(amount, who, who), burned);
            modelTracked -= amount;
            modelSupply -= burned;
            if (backstop) seedShares -= burned;
            else ordinaryShares -= burned;
        } else {
            (, uint256 doubtful) = _totals();
            if (doubtful != 0 || assets >= 20e8) return;
            amount = bound(amount, 1, _min(2e8, 20e8 - assets));
            uint256 mintedShares = amount * (modelSupply + 1e6) / (assets + 1);
            _syncModel();
            bem.mint(who, amount);
            vm.startPrank(who);
            bem.approve(address(pool), amount);
            assertEq(pool.deposit(amount, who), mintedShares);
            vm.stopPrank();
            modelTracked += amount;
            modelSupply += mintedShares;
            if (backstop) seedShares += mintedShares;
            else ordinaryShares += mintedShares;
        }
        _clock();
    }

    function _limit(uint256 i) internal view returns (uint256 amount, uint8 binding) {
        if (disabled || block.timestamp < uint256(enabledAt) + 360) return (0, 5);
        uint256 assets = _assets();
        (uint256 outstanding,) = _totals();
        uint256 used;
        for (uint256 j; j < 3; ++j) {
            if (borrowers[j] == borrowers[i]) used += principal[j];
        }
        amount = modelTracked - modelReserve;
        binding = 1;
        uint256 room = _room(_min(absoluteCap, assets * 7_000 / 10_000), outstanding);
        if (room < amount) {
            amount = room;
            binding = 2;
        }
        room = _room(_min(borrowerCap, assets * 4_000 / 10_000), used);
        if (room < amount) {
            amount = room;
            binding = 3;
        }
        room = _room(seedShares * (assets + 1) / (modelSupply + 1e6), outstanding);
        if (room < amount) {
            amount = room;
            binding = 4;
        }
    }

    /// @notice Exercise both accepted and refused admissions, including lowered caps.
    function lend(uint256 seed, uint256 amount) external {
        uint256 i = seed % 3;
        if (principal[i] != 0) return;
        (uint256 limit, uint8 binding) = _limit(i);
        (uint256 actual, uint8 constraint) = pool.lendLimit(borrowers[i]);
        assertEq(actual, limit);
        assertEq(constraint, binding);
        amount = bound(amount, 1, 5e8);
        if (amount > limit) {
            vm.prank(address(agents[i]));
            vm.expectRevert();
            pool.lend(amount);
        } else {
            _syncModel();
            vm.prank(address(agents[i]));
            pool.lend(amount);
            modelTracked -= amount;
            principal[i] = amount;
            shareTerms[i] = shareRate;
            capTerms[i] = capRate;
            (uint256 outstanding,) = _totals();
            assertLe(outstanding, seedShares * (_assets() + 1) / (modelSupply + 1e6));
        }
        _clock();
    }

    /// @notice Repay fees and principal using each loan's modelled reserve snapshot.
    function repay(uint256 seed, uint256 fees, uint256 amount) external {
        uint256 i = seed % 3;
        fees = bound(fees, 0, 1e8);
        amount = bound(amount, 0, principal[i]);
        _syncModel();
        uint256 toReserve = _min(fees * shareTerms[i] / 10_000, _room(_assets() * capTerms[i] / 10_000, modelReserve));
        uint256 cut = _min(marked[i], amount);
        marked[i] -= cut;
        principal[i] -= amount;
        _restore(i, cut);
        bem.mint(address(agents[i]), fees + amount);
        vm.startPrank(address(agents[i]));
        bem.approve(address(pool), fees + amount);
        pool.repay(fees, amount);
        vm.stopPrank();
        modelTracked += fees + amount;
        modelReserve += toReserve;
        _book(fees - toReserve);
        if (principal[i] == 0) {
            shareTerms[i] = 0;
            capTerms[i] = 0;
        }
        _clock();
    }

    /// @notice Mark, clear or write off one agent; unreleased income absorbs losses first.
    function loss(uint256 seed, uint256 action) external {
        uint256 i = seed % 3;
        if (action % 3 == 2 && marked[i] != principal[i]) return;
        _syncModel();
        vm.prank(address(agents[i]));
        if (action % 3 == 0) {
            pool.markDoubtful();
            if (principal[i] > marked[i]) {
                uint256 cut = _min(_remaining(), principal[i] - marked[i]);
                modelUnvested = _remaining() - cut;
                modelUpdated = uint64(block.timestamp);
                absorbed[i] += cut;
            }
            marked[i] = principal[i];
        } else if (action % 3 == 1) {
            pool.clearDoubtful();
            uint256 back = marked[i];
            marked[i] = 0;
            _restore(i, back);
        } else {
            pool.writeOff();
            modelReserve -= _min(modelReserve, principal[i]);
            principal[i] = 0;
            marked[i] = 0;
            absorbed[i] = 0;
            shareTerms[i] = 0;
            capTerms[i] = 0;
        }
        _clock();
    }

    /// @notice Mutate reserve terms or admission caps through their real governance paths.
    function parameter(uint256 seed, uint256 value) external {
        _syncModel();
        if (seed % 4 < 2) {
            bool share = seed % 4 == 0;
            value = bound(value, 0, share ? 5_000 : 2_000);
            TapePool.Param key = share ? TapePool.Param.ReserveShareBps : TapePool.Param.ReserveCapBps;
            vm.prank(owner);
            pool.queueParam(key, value);
            vm.warp(block.timestamp + 48 hours);
            pool.executeParam(key);
            if (share) shareRate = uint16(value);
            else capRate = uint16(value);
        } else {
            bool global = seed % 4 == 2;
            value = bound(value, 0, global ? absoluteCap : borrowerCap);
            vm.prank(owner);
            pool.lowerCap(global ? TapePool.Param.BorrowCapAbs : TapePool.Param.PerBorrowerAbs, value);
            if (global) absoluteCap = value;
            else borrowerCap = value;
        }
        _clock();
    }

    /// @notice Toggle feed trust and build an independent union of freeze intervals.
    function brake() external {
        _syncModel();
        uint256 n = intervals.length;
        if (disabled) {
            vm.prank(owner);
            pool.enableFeed();
            intervals[n - 1].to = uint64(block.timestamp + 24 hours);
            enabledAt = uint64(block.timestamp);
        } else {
            vm.prank(guardian);
            pool.disableFeed();
            if (n != 0 && intervals[n - 1].to >= block.timestamp) intervals[n - 1].to = type(uint64).max;
            else intervals.push(Interval(uint64(block.timestamp), type(uint64).max));
        }
        disabled = !disabled;
        _clock();
    }

    /// @notice Advance wall time and check the monotonic frozen clock.
    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 8 days));
        _clock();
    }

    function _clock() internal {
        uint256 clock;
        for (uint256 i; i < intervals.length; ++i) {
            uint256 end = _min(block.timestamp, intervals[i].to);
            if (end > intervals[i].from) clock += end - intervals[i].from;
        }
        assertGe(clock, lastClock);
        assertEq(pool.frozenClock(), clock);
        lastClock = clock;
    }

    function _expiry(uint64 flag) internal view returns (uint256 end) {
        end = uint256(flag) + 96 hours + 1;
        for (uint256 i; i < intervals.length; ++i) {
            Interval memory f = intervals[i];
            if (f.to <= flag) continue;
            if (f.from >= end) break;
            if (f.to == type(uint64).max) return type(uint64).max;
            end += f.to - (f.from > flag ? f.from : flag);
        }
    }

    /// @notice Assert all independently modelled books and the public admission and expiry views.
    function check() external view {
        assertEq(pool.tracked(), modelTracked);
        assertEq(bem.balanceOf(address(pool)), modelTracked + modelUntracked);
        assertEq(pool.reserve(), modelReserve);
        assertEq(pool.unvestedNow(), _remaining());
        assertEq(pool.vestEnd(), modelEnd);
        assertEq(pool.totalAssets(), _assets());
        assertEq(pool.totalSupply(), modelSupply);
        assertEq(pool.balanceOf(seedHolder), seedShares);
        (uint256 outstanding, uint256 doubtful) = _totals();
        assertEq(pool.outstandingPrincipal(), outstanding);
        assertEq(pool.doubtful(), doubtful);
        assertLe(_remaining(), modelTracked - modelReserve + outstanding - doubtful);
        for (uint256 i; i < 3; ++i) {
            address agent = address(agents[i]);
            assertEq(pool.loanPrincipalOf(agent), principal[i]);
            assertEq(pool.doubtfulOf(agent), marked[i]);
            assertEq(pool.absorbedOf(agent), absorbed[i]);
            assertLe(absorbed[i], marked[i]);
            (uint16 share, uint16 cap) = pool.loanReserveTerms(agent);
            assertEq(share, shareTerms[i]);
            assertEq(cap, capTerms[i]);
            (uint256 limit, uint8 binding) = _limit(i);
            (uint256 actual, uint8 constraint) = pool.lendLimit(borrowers[i]);
            assertEq(actual, limit);
            assertEq(constraint, binding);
        }
        assertEq(pool.expiryOf(origin), _expiry(origin));
        assertEq(pool.expiryOf(uint64(block.timestamp)), _expiry(uint64(block.timestamp)));
        assertGt(pool.totalSupply(), 0);
    }
}
