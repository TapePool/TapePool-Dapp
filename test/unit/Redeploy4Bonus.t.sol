// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Miner} from "../../src/interfaces/IBsc.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {Reasons} from "../../src/interfaces/ICreditPolicy.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {TapeLens} from "../../src/TapeLens.sol";
import {BscRigReaderHarness, ReaderVault} from "../mocks/BscRigReaderHarness.sol";
import {PolicyBase} from "./PolicyBase.t.sol";

contract BonusMinerRecords is ReaderVault {
    Miner internal _miner;
    uint256 public totalVerifWeight;

    function setMiner(Miner memory m, uint256 total) external {
        _miner = m;
        totalVerifWeight = total;
    }

    function minerKey(address c, uint256 id) external pure returns (bytes32) {
        return keccak256(abi.encode(c, id));
    }

    function getMiner(bytes32) external view returns (Miner memory) {
        return _miner;
    }

    function pending(bytes32) external pure returns (uint256) {
        return 123;
    }
}

contract BonusCellOwner {
    function ownerOf(uint256) external pure returns (address) {
        return address(0xCE11);
    }
}

/// R4-01: the reader normalizes bonus units before any policy, lens or agent consumes the report.
contract Redeploy4BonusTest is PolicyBase {
    uint256 constant ID = 17;
    BscRigReaderHarness reader;
    BonusMinerRecords records;

    function setUp() public override {
        super.setUp();
        reader = new BscRigReaderHarness();
        records = new BonusMinerRecords();
        records.set(CPU_TAPEOUT, ID + 1000, address(0xCE11));
        vm.etch(CPU_TAPEOUT, address(new BonusCellOwner()).code);
    }

    function _miner(uint32 mult, uint64 bstar, uint64 rawBonus, uint128 weight) internal view returns (Miner memory m) {
        m.circuits = CPU_TAPEOUT;
        m.circuitId = uint64(ID + 1000);
        m.taskId = 4;
        m.since = uint64(block.timestamp - 30 days);
        m.status = 1;
        m.mult = mult;
        m.bstar = bstar;
        m.bonus = rawBonus;
        m.verifWeight = weight;
    }

    function _read(Miner memory m) internal returns (RigReport memory r) {
        records.setMiner(m, NETWORK_WEIGHT);
        return reader.read(address(records), address(records), ID);
    }

    function test_R4_01_mult1KeepsTapeOutBonus() public {
        RigReport memory r = _read(_miner(1, 58, 248, 306));
        assertEq(r.verifWeight, 306);
        assertEq(r.bonus, 248);
        assertEq(r.verifWeight - r.bonus, 58);
    }

    function test_R4_01_mult6ScalesBehemothBonus() public {
        RigReport memory r = _read(_miner(6, 4, 4, 48));
        assertEq(r.verifWeight, 48);
        assertEq(r.bonus, 24);
        assertEq(r.verifWeight - r.bonus, 24);
        r = _read(_miner(6, 4, 72, 456));
        assertEq(r.bonus, 432);
        assertEq(r.verifWeight - r.bonus, 24);
    }

    function test_R4_01_mult0HasNoBase() public {
        RigReport memory r = _read(_miner(0, 4, 4, 0));
        assertEq(r.verifWeight, 0);
        assertEq(r.bonus, 0);
        r = _read(_miner(0, 4, 4, 48));
        assertEq(r.bonus, 48, "all weight above a zero base is bonus");
        assertEq(r.verifWeight - r.bonus, 0);
    }

    function test_R4_01_zeroBstarWithBonusHasNoBase() public {
        RigReport memory r = _read(_miner(6, 0, 4, 24));
        assertEq(r.bonus, 24);
        assertEq(r.verifWeight - r.bonus, 0);
    }

    function test_R4_01_revoked1965HasZeroBonusWeight() public {
        Miner memory m = _miner(6, 79, 3752, 0);
        m.status = 2;
        RigReport memory r = _read(m);
        assertEq(r.status, 2);
        assertEq(r.verifWeight, 0);
        assertEq(r.bonus, 0);
    }

    function test_R4_01_weightBelowBaseHasZeroBonus() public {
        RigReport memory r = _read(_miner(6, 4, 72, 12));
        assertEq(r.verifWeight, 12);
        assertEq(r.bonus, 0);
        assertEq(r.verifWeight - r.bonus, 12);
    }

    function test_R4_01_forgottenRigKeepsZeroFieldsWithoutReadingMiner() public {
        records.set(address(0), ID + 1000, address(0xCE11));
        vm.expectCall(address(records), abi.encodePacked(BonusMinerRecords.getMiner.selector), 0);
        RigReport memory r = reader.read(address(records), address(records), ID);
        RigReport memory want;
        want.rigId = uint64(ID);
        want.observedAt = uint64(block.timestamp);
        want.bscBlock = uint64(block.number);
        assertEq(abi.encode(r), abi.encode(want));
    }

    function test_R4_01_maximumBonusFitsAfterWeightCast() public {
        RigReport memory r = _read(_miner(0, 0, type(uint64).max, type(uint64).max));
        assertEq(r.verifWeight, type(uint64).max);
        assertEq(r.bonus, type(uint64).max);
    }

    function test_R4_01_weightOverflowRevertsBeforeBonusCast() public {
        uint128 weight = uint128(type(uint64).max) + 1;
        records.setMiner(_miner(0, 0, 0, weight), NETWORK_WEIGHT);
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 64, weight));
        reader.read(address(records), address(records), ID);
    }

    function testFuzz_R4_01_reportBaseIsMinimumWeight(uint64 weight, uint64 bstar, uint32 mult, uint64 rawBonus)
        public
    {
        RigReport memory r = _read(_miner(mult, bstar, rawBonus, weight));
        uint256 base = uint256(bstar) * mult;
        uint256 want = weight < base ? weight : base;
        assertEq(r.verifWeight - r.bonus, want);
        assertLe(r.bonus, r.verifWeight, "bonus cannot overflow after weight fits uint64");
    }

    function _onboard(Miner memory m) internal returns (RigAgent a) {
        _deposit(lp, 20 * BEM);
        a = _agent(alice, 0);
        voucher.mint(alice, ID, m.verifWeight == 0 ? 1 : m.verifWeight);
        _pledge(a, alice, ID);
        vm.prank(owner);
        screen.recordPass(ID, CPU_TAPEOUT, uint64(ID + 1000), 4, ARTIFACT);
        vm.warp(block.timestamp + screen.DELAY());
        feed.set(_read(m));
    }

    function _path(Miner memory m, bool forgotten, uint256 base, uint256 flags) internal {
        RigAgent a = _onboard(m);
        if (forgotten) {
            records.set(address(0), 0, address(0));
            feed.set(reader.read(address(records), address(records), ID));
        }
        for (uint8 term; term < 2; ++term) {
            uint256 snap = vm.snapshotState();
            _checkTerm(a, term, base, flags);
            vm.revertToState(snap);
        }
    }

    function _checkPolicy(RigAgent a, uint8 term, uint256 base, uint256 flags)
        internal
        view
        returns (uint256 expected, uint256 limit)
    {
        expected = base * 712_800_000_000 * (term == 0 ? 7 : 14) * (term == 0 ? 9907 : 9815) * 9950
            / (uint256(NETWORK_WEIGHT) * 1e8);
        limit = expected * (term == 0 ? 8500 : 8000) / 10_000;
        bool healthy = flags == 31;
        assertEq(credit.maxDebt(address(a), _ids(ID), term), healthy ? limit : 0);
        (bool allow, uint8 reason, uint16 bits, uint256 got) = credit.check(address(a), _ids(ID), term, limit);
        assertEq(allow, healthy);
        assertEq(reason, healthy ? Reasons.OK : Reasons.DENIED);
        assertEq(_flags(bits), flags);
        assertEq(bits & 3, term);
        assertEq((bits >> 2) & 31, base == 0 ? 31 : (term == 0 ? 17 : 16));
        assertEq(got, expected);
    }

    function _checkTerm(RigAgent a, uint8 term, uint256 base, uint256 flags) internal {
        (uint256 expected, uint256 limit) = _checkPolicy(a, term, base, flags);
        TapeLens.Quote memory q = lens.quote(a, term);
        assertEq(q.expected, expected);
        assertEq(_flags(q.inputBits), flags);
        assertEq(q.reason, flags == 31 ? Reasons.OK : Reasons.DENIED);
        if (flags == 31) {
            _borrowQuote(a, term, q, limit);
        } else {
            assertEq(q.maxPrincipal, 0);
            uint256 principal = pool.minAdvance();
            (,,, bool allowed, uint8 why,) = lens.quoteFor(a, term, principal);
            assertFalse(allowed);
            assertEq(why, Reasons.DENIED);
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(RigAgent.PolicyDenied.selector, Reasons.DENIED));
            a.borrow(term, principal, type(uint256).max, type(uint16).max);
        }
    }

    function _borrowQuote(RigAgent a, uint8 term, TapeLens.Quote memory q, uint256 limit) internal {
        assertGe(q.maxPrincipal, pool.minAdvance());
        assertEq(q.fee, pool.fee(term, q.maxPrincipal));
        assertLe(q.maxPrincipal + q.fee, limit);
        assertGt(q.maxPrincipal + 1 + pool.fee(term, q.maxPrincipal + 1), limit);
        (,,, bool allowed, uint8 why,) = lens.quoteFor(a, term, q.maxPrincipal);
        assertTrue(allowed);
        assertEq(why, Reasons.OK);
        (,,, allowed, why,) = lens.quoteFor(a, term, q.maxPrincipal + 1);
        assertFalse(allowed);
        assertEq(why, Reasons.DENIED);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RigAgent.PolicyDenied.selector, Reasons.DENIED));
        a.borrow(term, q.maxPrincipal + 1, type(uint256).max, type(uint16).max);
        _borrow(a, alice, term, q.maxPrincipal);
        assertEq(a.loanOf().principal, q.maxPrincipal);
    }

    function test_R4_01_policyAndLensBothTerms_mult1() public {
        _path(_miner(1, 4, 4, 8), false, 4, 31);
    }

    function test_R4_01_policyAndLensBothTerms_mult6() public {
        _path(_miner(6, 4, 72, 456), false, 24, 31);
    }

    function test_R4_01_policyAndLensBothTerms_belowBase() public {
        _path(_miner(6, 4, 72, 12), false, 12, 31);
    }

    function test_R4_01_policyAndLensBothTerms_mult0() public {
        _path(_miner(0, 4, 4, 0), false, 0, 28);
    }

    function test_R4_01_policyAndLensBothTerms_mult0WithWeight() public {
        _path(_miner(0, 4, 4, 48), false, 0, 29);
    }

    function test_R4_01_policyAndLensBothTerms_zeroBstarWithBonus() public {
        _path(_miner(6, 0, 4, 24), false, 0, 29);
    }

    function test_R4_01_policyAndLensBothTerms_zeroWeightWithRawBonus() public {
        Miner memory m = _miner(6, 79, 3752, 0);
        m.status = 2;
        _path(m, false, 0, 28);
    }

    function test_R4_01_policyAndLensBothTerms_forgotten() public {
        _path(_miner(6, 4, 4, 48), true, 0, 0);
    }

    function test_R4_01_zeroBaseIsReportImpairmentOnAnOpenLoan() public {
        RigAgent a = _onboard(_miner(6, 4, 4, 48));
        _borrow(a, alice, 0, pool.minAdvance());
        vm.warp(a.flagEvidenceFrom());
        for (uint256 i; i < 3; ++i) {
            uint256 snap = vm.snapshotState();
            Miner memory m = i == 0 ? _miner(0, 4, 4, 48) : _miner(6, 0, 4, 24);
            if (i == 2) m = _miner(6, 79, 3752, 0); // active but unverified: weight alone proves no base
            feed.set(_read(m));
            a.flagImpaired(ID);
            assertEq(a.loanOf().impairedAt, block.timestamp);
            assertEq(pool.doubtfulOf(address(a)), a.loanOf().principal);
            vm.revertToState(snap);
        }
    }
}
