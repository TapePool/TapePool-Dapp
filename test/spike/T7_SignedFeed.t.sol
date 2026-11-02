// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FeedBase} from "./FeedBase.sol";
import {console2} from "forge-std/console2.sol";
import {RigReport, RigReportCheck} from "../../src/spike/feed/RigReport.sol";
import {SignedRigFeed} from "../../src/spike/feed/SignedRigFeed.sol";
import {FeedGate} from "../../src/spike/feed/FeedGate.sol";

/// T7 (DERISK Q1, option B): an off-chain signer reads the rig on BSC and signs an EIP-712 report;
///    the borrow path on X Layer accepts it only if it is authentic, fresh, unused and unimpaired.
///    The signer key is a throwaway test key that exists only in this test.
contract T7_SignedFeedTest is FeedBase {
    SignedRigFeed feed;
    FeedGate gate;
    address signer;
    uint256 signerKey;

    function setUp() public {
        _forks();
        (signer, signerKey) = makeAddrAndKey("feed-signer");
        vm.selectFork(xFork);
        feed = new SignedRigFeed(signer);
        gate = new FeedGate(feed, VOUCHER);
        feed.bind(address(gate));
    }

    /// What the signer service does: read on BSC, then sign for the X Layer feed.
    function _readOnBsc(uint256 id) internal returns (RigReport memory r) {
        vm.selectFork(bscFork);
        r = _read(id);
    }

    function _proof(RigReport memory r, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(key, feed.digest(r));
        return abi.encode(r, abi.encodePacked(rr, s, v));
    }

    function test_T7_fresh_report_allows_and_returns_base_power() public {
        RigReport memory r = _readOnBsc(RIG);
        _arriveOnXLayer(r, 30);
        bytes memory proof = _proof(r, signerKey);
        uint256 g = gasleft();
        uint256 base = gate.check(RIG, proof);
        console2.log("gas: verify signature + checks on X Layer", g - gasleft());
        assertEq(base, 58, "base power, bonus excluded");
    }

    function test_T7_stale_report_denied() public {
        RigReport memory r = _readOnBsc(RIG);
        _arriveOnXLayer(r, RigReportCheck.MAX_AGE + 1);
        bytes memory proof = _proof(r, signerKey);
        vm.expectRevert(RigReportCheck.Stale.selector);
        gate.check(RIG, proof);
    }

    function test_T7_report_from_the_future_denied() public {
        RigReport memory r = _readOnBsc(RIG);
        _arriveOnXLayer(r, 0);
        r.observedAt += uint64(RigReportCheck.MAX_SKEW + 1);
        bytes memory proof = _proof(r, signerKey);
        vm.expectRevert(RigReportCheck.Stale.selector);
        gate.check(RIG, proof);
    }

    function test_T7_replay_denied() public {
        RigReport memory r = _readOnBsc(RIG);
        _arriveOnXLayer(r, 30);
        bytes memory proof = _proof(r, signerKey);
        gate.check(RIG, proof);
        vm.expectRevert(SignedRigFeed.Replayed.selector);
        gate.check(RIG, proof);
    }

    function test_T7_wrong_signer_denied() public {
        RigReport memory r = _readOnBsc(RIG);
        _arriveOnXLayer(r, 30);
        (, uint256 otherKey) = makeAddrAndKey("attacker");
        bytes memory proof = _proof(r, otherKey);
        vm.expectRevert(SignedRigFeed.BadSignature.selector);
        gate.check(RIG, proof);
    }

    function test_T7_tampered_report_denied() public {
        RigReport memory r = _readOnBsc(RIG);
        _arriveOnXLayer(r, 30);
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(signerKey, feed.digest(r));
        r.bonus = 0; // claim the bonus is base power
        vm.expectRevert(SignedRigFeed.BadSignature.selector);
        gate.check(RIG, abi.encode(r, abi.encodePacked(rr, s, v)));
    }

    function test_T7_report_for_another_rig_denied() public {
        RigReport memory r = _readOnBsc(4);
        _arriveOnXLayer(r, 30);
        bytes memory proof = _proof(r, signerKey);
        vm.expectRevert(SignedRigFeed.WrongRig.selector);
        gate.check(RIG, proof);
    }

    function test_T7_honest_report_of_a_rescued_rig_denied() public {
        vm.selectFork(bscFork);
        _rescueOnBsc(RIG);
        RigReport memory r = _read(RIG);
        _arriveOnXLayer(r, 30);
        bytes memory proof = _proof(r, signerKey);
        vm.expectRevert(RigReportCheck.Impaired.selector);
        gate.check(RIG, proof);
    }

    function test_T7_only_bound_consumer_can_burn_signatures() public {
        RigReport memory r = _readOnBsc(RIG);
        _arriveOnXLayer(r, 30);
        bytes memory proof = _proof(r, signerKey);
        vm.expectRevert(SignedRigFeed.NotConsumer.selector);
        feed.consume(RIG, proof);
    }

    /// The trust cost of option B, shown plainly: a leaked signer key can vouch for a rig that
    /// does not exist on BSC as it claims. Only the caps limit the damage.
    function test_T7_leaked_key_can_forge_power() public {
        RigReport memory r = _readOnBsc(RIG);
        _arriveOnXLayer(r, 30);
        r.verifWeight = 1_000_000;
        r.bonus = 0;
        uint256 base = gate.check(RIG, _proof(r, signerKey));
        assertEq(base, 1_000_000, "a signed lie passes every on-chain check");
    }
}
