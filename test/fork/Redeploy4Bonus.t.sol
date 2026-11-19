// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IPodMining, IERC721OwnerOf, Miner} from "../../src/interfaces/IBsc.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";
import {BscRigReaderHarness, ReaderVault} from "../mocks/BscRigReaderHarness.sol";

/// R4-01: real PodMining miners at the same pinned snapshot as the H-01 reproduction.
/// The synthetic vault lets the reader inspect unbridged miners; it does not simulate a loan.
/// LOCAL FORK ONLY. Skipped without BSC_RPC; never broadcasts.
contract Redeploy4BonusForkTest is Test {
    address constant VAULT = 0x48D43345656f0f9510dC3c06CBa99dFf597617C2;
    IPodMining constant POD = IPodMining(0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46);
    address constant TAPEOUT = 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C;
    address constant BEHEMOTH = 0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C;
    uint256 constant BSC_BLOCK = 128_369_002;
    uint256 constant MINERS_PER_PROCESSOR = 256;
    uint256 constant MAX_CIRCUIT_ID = 5_000;

    BscRigReaderHarness reader;
    ReaderVault records;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc, BSC_BLOCK);
        reader = new BscRigReaderHarness();
        records = new ReaderVault();
    }

    function _miner(address processor, uint256 id) internal view returns (Miner memory) {
        return POD.getMiner(POD.minerKey(processor, id));
    }

    function _readBehemoth(uint256 id) internal returns (RigReport memory) {
        records.set(BEHEMOTH, id, IERC721OwnerOf(BEHEMOTH).ownerOf(id));
        return reader.read(address(records), address(POD), id);
    }

    function test_R4_01_realBehemoth52() public {
        Miner memory m = _miner(BEHEMOTH, 52);
        assertEq(m.mult, 6);
        assertEq(m.bstar, 4);
        assertEq(m.bonus, 4);
        RigReport memory r = _readBehemoth(52);
        assertEq(r.verifWeight, 48);
        assertEq(r.bonus, 24);
        assertEq(r.verifWeight - r.bonus, 24);
    }

    function test_R4_01_realBehemoth871() public {
        Miner memory m = _miner(BEHEMOTH, 871);
        assertEq(m.mult, 6);
        assertEq(m.bstar, 4);
        assertEq(m.bonus, 72);
        RigReport memory r = _readBehemoth(871);
        assertEq(r.verifWeight, 456);
        assertEq(r.bonus, 432);
        assertEq(r.verifWeight - r.bonus, 24);
    }

    function test_R4_01_realTapeOutRig5KeepsRawBonusAtMult1() public view {
        RigReport memory r = reader.read(VAULT, address(POD), 5);
        Miner memory m = _miner(r.circuits, r.circuitId);
        assertEq(r.circuits, TAPEOUT);
        assertEq(m.mult, 1);
        assertEq(m.bonus, 248);
        assertEq(r.bonus, 248);
        assertEq(r.verifWeight, m.verifWeight);
        assertEq(r.verifWeight - r.bonus, uint256(m.bstar) * m.mult);
    }

    function test_R4_01_realRevoked1965KeepsZeroWeightAndBonus() public {
        Miner memory m = _miner(BEHEMOTH, 1965);
        assertEq(m.status, 2);
        assertEq(m.bstar, 79);
        assertEq(m.bonus, 3752);
        assertEq(m.verifWeight, 0);
        RigReport memory r = _readBehemoth(1965);
        assertEq(r.verifWeight, 0);
        assertEq(r.bonus, 0);
    }

    struct Census {
        uint256 miners;
        uint256 verified;
        uint256 zeroWeight;
        uint256 broken;
    }

    function _printMiner(address processor, uint256 id, Miner memory m) internal pure {
        console2.log("R4-01 census rule broken: processor", processor);
        console2.log("circuit/status", id, m.status);
        console2.log("bstar/mult", m.bstar, m.mult);
        console2.log("raw bonus/verifWeight", m.bonus, m.verifWeight);
    }

    function _census(address processor) internal returns (Census memory c) {
        for (uint256 id = 1; id <= MAX_CIRCUIT_ID && c.miners < MINERS_PER_PROCESSOR; ++id) {
            Miner memory m = _miner(processor, id);
            if (m.circuits == address(0)) continue; // an NFT without a registered miner is not a sample
            ++c.miners;
            uint256 base = uint256(m.bstar) * m.mult;
            bool broken;
            if (m.status == 1 && m.verifWeight > 0) {
                ++c.verified;
                broken = uint256(m.verifWeight) != (uint256(m.bstar) + m.bonus) * m.mult;
            }
            if (m.verifWeight == 0) ++c.zeroWeight;

            // Custody is irrelevant to this census. A zero cell avoids ownerOf on a burned NFT.
            records.set(processor, id, address(0));
            try reader.read(address(records), address(POD), id) returns (RigReport memory r) {
                uint256 want = m.verifWeight < base ? m.verifWeight : base;
                broken = broken || r.verifWeight != m.verifWeight || r.bonus > r.verifWeight;
                if (r.bonus <= r.verifWeight) {
                    broken = broken || r.verifWeight - r.bonus != want;
                    if (m.status == 1 && m.verifWeight > 0) {
                        broken = broken || r.verifWeight - r.bonus != base;
                    }
                }
                if (m.verifWeight == 0) broken = broken || r.bonus != 0;
                if (broken) console2.log("report weight/bonus", r.verifWeight, r.bonus);
            } catch (bytes memory err) {
                broken = true;
                console2.logBytes(err);
            }
            if (broken) {
                ++c.broken;
                _printMiner(processor, id, m);
            }
        }
        console2.log("R4-01 census processor", processor);
        console2.log("miners/active verified", c.miners, c.verified);
        console2.log("zero weight/broken", c.zeroWeight, c.broken);
    }

    function test_R4_01_realMinerCensusAcrossBothProcessors() public {
        Census memory tape = _census(TAPEOUT);
        Census memory beh = _census(BEHEMOTH);
        assertEq(tape.miners, MINERS_PER_PROCESSOR, "TapeOut sample must be complete");
        assertEq(beh.miners, MINERS_PER_PROCESSOR, "Behemoth sample must be complete");
        assertGe(tape.miners + beh.miners, 500);
        assertGt(tape.verified, 0);
        assertGt(beh.verified, 0);
        assertGt(tape.zeroWeight + beh.zeroWeight, 0);
        assertEq(tape.broken + beh.broken, 0, "see each miner printed above");
    }
}
