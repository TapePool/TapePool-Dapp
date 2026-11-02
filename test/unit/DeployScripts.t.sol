// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TapePool} from "../../src/TapePool.sol";
import {DeployPool} from "../../script/deploy/DeployPool.s.sol";
import {DeployFeed} from "../../script/feed/DeployFeed.s.sol";
import {CheckStack} from "../../script/deploy/CheckStack.s.sol";
import {Addresses as A} from "../../script/Addresses.sol";
import {BscRigReader} from "../../src/feed/BscRigReader.sol";
import {PolicyV1} from "../../src/libraries/PolicyV1.sol";
import {MockBEM, MockVoucher, MockRigFeed} from "../mocks/Mocks.sol";
import {NandCircuits} from "../mocks/NandCircuits.sol";

contract ManifestReporter {
    mapping(uint256 => bool) public pushed;
    uint256 public count;
    uint256 public batches;

    function quote(uint256[] calldata ids) external pure returns (uint256) {
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] == 2) revert BscRigReader.CustodyUnreadable(2);
        }
        return 0;
    }

    function push(uint256[] calldata ids) external payable returns (bytes32) {
        for (uint256 i; i < ids.length; ++i) {
            require(ids[i] != 2, "readable rigs only");
            pushed[ids[i]] = true;
            ++count;
        }
        return bytes32(++batches);
    }
}

/// Script checks run entirely on local mocks, without RPC calls or broadcasts to any chain.
contract DeployScriptsTest is Test {
    function test_RA17_manifestSkipsOnlyUnreadableRigAndPushesEveryOtherRig() public {
        vm.chainId(56);
        ManifestReporter reporter = new ManifestReporter();
        new DeployFeed().pushAll(address(reporter));
        assertEq(reporter.count(), 15);
        assertEq(reporter.batches(), 1);
        for (uint256 i = 1; i <= 16; ++i) {
            assertEq(reporter.pushed(i), i != 2);
        }
    }

    function test_RA17_deploysLensPausedPoolAndCheckStackAcceptsAllLaunchPins() public {
        DeployPool.Deployed memory d = _deployLaunch();
        assertTrue(d.pool.borrowsPaused());
        assertEq(d.pool.backstop(), A.OWNER);
        assertGt(address(d.lens).code.length, 0);
        CheckStack check = new CheckStack();
        check.checkPool(d.pool, d.lens);
        vm.prank(A.OWNER);
        d.pool.lowerCap(TapePool.Param.SupplyCap, 0);
        vm.expectRevert(bytes("initial value"));
        check.checkPool(d.pool, d.lens);
    }

    function test_N01_checkStackAcceptsSyncedPreSeedDonation() public {
        DeployPool.Deployed memory d = _deployLaunch();
        MockBEM bem = MockBEM(A.BEM_OFT_XLAYER);
        bem.mint(address(this), 1);
        assertTrue(bem.transfer(address(d.pool), 1));
        d.pool.sync();
        assertEq(d.pool.reserve(), 1);
        assertEq(d.pool.tracked(), 1);
        assertEq(d.pool.totalSupply(), 0);
        assertEq(d.pool.idle(), 0);
        assertEq(d.pool.unvestedNow(), 0);
        assertEq(d.pool.outstandingPrincipal(), 0);
        new CheckStack().checkPool(d.pool, d.lens);
    }

    function _deployLaunch() internal returns (DeployPool.Deployed memory d) {
        vm.warp(1_800_000_000);
        MockBEM bem = new MockBEM();
        vm.etch(A.BEM_OFT_XLAYER, address(bem).code);
        MockVoucher voucher = new MockVoucher(A.BEM_OFT_XLAYER);
        vm.etch(A.RIG_VOUCHER, address(voucher).code);
        NandCircuits circuits = new NandCircuits();
        vm.etch(A.POLICY_CIRCUITS, address(circuits).code);
        (bytes memory netlist,) = PolicyV1.build();
        NandCircuits(A.POLICY_CIRCUITS).tapeout(netlist, PolicyV1.N_IN, PolicyV1.N_OUT);
        MockRigFeed feed = new MockRigFeed();
        DeployPool deployer = new DeployPool();
        d = deployer.deployAll(address(deployer), A.POLICY_CIRCUITS, 1, address(feed));
    }
}
