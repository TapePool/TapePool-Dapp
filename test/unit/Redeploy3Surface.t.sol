// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {TapePool} from "../../src/TapePool.sol";
import {ITapePool} from "../../src/interfaces/ITapePool.sol";

/// Redeploy 3, R3-06: the external surface. `RigAgent` gains only `wasSeized(uint256)` and
/// `SeizedVoucher(uint256)`; `TapePool` and `ITapePool` gain `feedEnabledAt()` and `FEED_SETTLE()`, and
/// the pool `FeedSettling()`. Read from the build artifacts, so a stray external function fails here.
contract Redeploy3SurfaceTest is Test {
    mapping(bytes32 => bool) internal _want;

    function test_R3_06_agentSurfaceAddsOnlyWasSeized() public {
        string[36] memory expected = [
            "CURE_WINDOW()",
            "EVIDENCE_REPORT()",
            "EVIDENCE_VOUCHER()",
            "EVIDENCE_WINDOW()",
            "MAX_CLOCK_SKEW()",
            "MAX_COLLATERAL()",
            "MAX_REPORT_AGE()",
            "OWNER_READ_GAS()",
            "VOUCHER_GAS()",
            "bem()",
            "borrow(uint8,uint256,uint256,uint16)",
            "borrower()",
            "claimLate()",
            "clearExpiredFlag()",
            "closed()",
            "collateralOf()",
            "factory()",
            "feed()",
            "flagEvidenceFrom()",
            "flagImpaired(uint256)",
            "forget(uint256)",
            "forwardVouchers()",
            "hasLoan()",
            "initialize(address)",
            "loanOf()",
            "onERC721Received(address,address,uint256,bytes)",
            "pool()",
            "register(uint256)",
            "release()",
            "repay(uint256)",
            "seize()",
            "seizeEvidenceFrom()",
            "sweep()",
            "voucher()",
            "wasSeized(uint256)", // new in redeploy 3 (R3-02)
            "withdrawVoucher(uint256)"
        ];
        string memory json = vm.readFile("out/RigAgent.sol/RigAgent.json");
        string[] memory got = vm.parseJsonKeys(json, ".methodIdentifiers");
        for (uint256 i; i < expected.length; ++i) {
            _want[keccak256(bytes(expected[i]))] = true;
        }
        for (uint256 i; i < got.length; ++i) {
            assertTrue(_want[keccak256(bytes(got[i]))], string.concat("unexpected external function ", got[i]));
        }
        assertEq(got.length, expected.length, "external function count");
        assertEq(RigAgent.SeizedVoucher.selector, bytes4(keccak256("SeizedVoucher(uint256)")));
    }

    function test_R3_06_poolAndInterfaceAddTheFeedRecordAndTheSettlingWindow() public view {
        string[2] memory artifacts = ["out/ITapePool.sol/ITapePool.json", "out/TapePool.sol/TapePool.json"];
        for (uint256 i; i < 2; ++i) {
            string memory json = vm.readFile(artifacts[i]);
            assertEq(vm.parseJsonString(json, ".methodIdentifiers['feedEnabledAt()']"), _hex4("feedEnabledAt()"));
            assertEq(vm.parseJsonString(json, ".methodIdentifiers['FEED_SETTLE()']"), _hex4("FEED_SETTLE()"));
        }
        assertEq(ITapePool.feedEnabledAt.selector, bytes4(keccak256("feedEnabledAt()")));
        assertEq(ITapePool.FEED_SETTLE.selector, bytes4(keccak256("FEED_SETTLE()")));
        assertEq(TapePool.FeedSettling.selector, bytes4(keccak256("FeedSettling()")));
    }

    function _hex4(string memory sig) internal pure returns (string memory) {
        bytes4 sel = bytes4(keccak256(bytes(sig)));
        bytes memory digits = "0123456789abcdef";
        bytes memory out = new bytes(8);
        for (uint256 i; i < 4; ++i) {
            out[2 * i] = digits[uint8(sel[i]) >> 4];
            out[2 * i + 1] = digits[uint8(sel[i]) & 15];
        }
        return string(out);
    }
}
