// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeployPool} from "../../script/deploy/DeployPool.s.sol";
import {CheckStack} from "../../script/deploy/CheckStack.s.sol";
import {CheckFeed} from "../../script/feed/CheckFeed.s.sol";
import {FeedConfig} from "../../script/feed/FeedConfig.sol";
import {Addresses as A} from "../../script/Addresses.sol";
import {RigReporter} from "../../src/feed/RigReporter.sol";
import {RigFeedReceiver} from "../../src/feed/RigFeedReceiver.sol";
import {IRigVaultBsc, IPodMining} from "../../src/interfaces/IBsc.sol";
import {ILzEndpointSend} from "../../src/interfaces/ILayerZero.sol";

/// R4-06: one complete session on two persistent local fork states. Nothing is broadcast.
contract Redeploy4RehearsalTest is Test {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function test_R4_06_newFeedAndStackBeforeAndAfterSeed() public {
        uint256 xlayer = vm.createFork("xlayer", 74_859_492);
        uint256 bsc = vm.createFork("bsc", 131_254_985);
        vm.selectFork(bsc);
        require(
            IPodMining(A.POD_MINING).startTime() + IPodMining(A.POD_MINING).HALVING_PERIOD() - 30 days
                == A.EMISSION_VALID_UNTIL,
            "emission end"
        );
        RigReporter reporter = new RigReporter(
            A.ENDPOINT,
            address(this),
            A.XLAYER_EID,
            IRigVaultBsc(A.RIG_VAULT),
            IPodMining(A.POD_MINING),
            A.BEM_ADAPTER_BSC
        );
        vm.selectFork(xlayer);
        RigFeedReceiver receiver = new RigFeedReceiver(A.ENDPOINT, address(this), A.BSC_EID, A.BEM_OFT_XLAYER);
        ILzEndpointSend ep = ILzEndpointSend(A.ENDPOINT);
        (address recvLib,) = ep.getReceiveLibrary(A.BEM_OFT_XLAYER, A.BSC_EID);
        receiver.setPeer(A.BSC_EID, bytes32(uint256(uint160(address(reporter)))));
        FeedConfig.mirror(ep, address(receiver), recvLib, A.BSC_EID, A.BEM_OFT_XLAYER);
        receiver.lock(recvLib);
        new CheckFeed().checkReceiver(address(receiver), address(reporter));
        vm.selectFork(bsc);
        address sendLib = ep.getSendLibrary(A.BEM_ADAPTER_BSC, A.XLAYER_EID);
        reporter.setPeer(A.XLAYER_EID, bytes32(uint256(uint160(address(receiver)))));
        FeedConfig.mirror(ep, address(reporter), sendLib, A.XLAYER_EID, A.BEM_ADAPTER_BSC);
        reporter.lock(sendLib);
        new CheckFeed().checkReporter(address(reporter), address(receiver));
        vm.selectFork(xlayer);
        DeployPool deploy = new DeployPool();
        CheckStack check = new CheckStack();
        vm.makePersistent(address(check));
        DeployPool.Deployed memory d =
            deploy.deployAll(address(deploy), A.POLICY_CIRCUITS, A.POLICY_CIRCUIT_ID, address(receiver));
        deploy.check(d, address(receiver));
        check.checkOnForks(address(d.pool), address(d.lens), address(reporter), bsc, false);
        IERC20 bem = IERC20(A.BEM_OFT_XLAYER);
        deal(A.BEM_OFT_XLAYER, address(this), 1_000_000);
        bem.approve(address(d.pool), 1_000_000);
        d.pool.deposit(1_000_000, DEAD);
        deal(A.BEM_OFT_XLAYER, A.OWNER, bem.balanceOf(A.OWNER) + 63_000_000);
        vm.startPrank(A.OWNER);
        bem.approve(address(d.pool), 63_000_000);
        d.pool.deposit(63_000_000, A.OWNER);
        vm.stopPrank();
        check.checkOnForks(address(d.pool), address(d.lens), address(reporter), bsc, true);
    }
}
