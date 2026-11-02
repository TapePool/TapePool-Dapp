// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TapePool} from "../../src/TapePool.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {IRigVoucher} from "../../src/interfaces/IXLayer.sol";
import {Addresses as A} from "../Addresses.sol";

/// @notice Read-only cutover gate. Scan every factory creation log, in X Layer's 100-block pages.
contract CheckOldStack is Script {
    /// @notice Holder of the old pool's dead seed, whose shares stay there for good (SPEC-REDEPLOY-3 §7.3).
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice Check the 2026-10-31 stack that redeploy 3 retires (RD3-06), from its factory deployment block
    ///         to the current block.
    function run() external {
        check(A.TAPE_POOL_2, A.AGENT_FACTORY_2, A.FACTORY_DEPLOY_BLOCK_2);
    }

    /// @notice Check one old stack: admission closed, no shares left but the dead seed's, no obligation, no
    ///         voucher, nothing queued, and every agent the factory created in `[fromBlock, now]` empty.
    function check(address poolAddress, address factory, uint256 fromBlock) public {
        require(block.chainid == A.XLAYER_CHAIN_ID, "X Layer only");
        require(block.number >= fromBlock, "fork predates old factory");
        TapePool pool = TapePool(poolAddress);
        require(pool.borrowsPaused() && pool.supplyCap() == 0, "old admission still open");
        require(pool.totalSupply() == pool.balanceOf(DEAD), "old shares beyond the dead seed");
        require(pool.outstandingPrincipal() == 0 && pool.doubtful() == 0, "old obligations");
        require(IRigVoucher(A.RIG_VOUCHER).balanceOf(poolAddress) == 0, "old pool has vouchers");
        require(address(pool.pendingPolicy()) == address(0), "old policy queued");
        // The 2026-10-31 pool has the same 14 parameters as this build.
        for (uint256 key; key <= uint256(type(TapePool.Param).max); ++key) {
            (, uint64 eta) = pool.queued(TapePool.Param(key));
            require(eta == 0, "old parameter queued");
        }
        address[] memory agents = scanAgents(factory, fromBlock, block.number);
        console2.log("old agents found", agents.length);
        for (uint256 i; i < agents.length; ++i) {
            checkAgent(RigAgent(agents[i]), IERC20(A.BEM_OFT_XLAYER));
        }
        console2.log("PASS: old stack may be retired");
    }

    /// @notice Every agent `factory` created in `[from, to]`, read from `AgentCreated` logs in 100-block pages
    ///         (X Layer's `eth_getLogs` limit).
    function scanAgents(address factory, uint256 from, uint256 to) public returns (address[] memory agents) {
        bytes32[] memory topics = new bytes32[](1);
        topics[0] = keccak256("AgentCreated(address,address,uint256)");
        address[] memory found = new address[](0);
        for (uint256 start = from; start <= to; start += 100) {
            uint256 end = start + 99 < to ? start + 99 : to;
            Vm.EthGetLogs[] memory logs = vm.eth_getLogs(start, end, factory, topics);
            if (logs.length == 0) continue;
            address[] memory grown = new address[](found.length + logs.length);
            for (uint256 i; i < found.length; ++i) {
                grown[i] = found[i];
            }
            for (uint256 i; i < logs.length; ++i) {
                grown[found.length + i] = address(uint160(uint256(logs[i].topics[1])));
            }
            found = grown;
        }
        return found;
    }

    /// @notice Check one discovered old agent and print its BEM, including late bridge deliveries, and any
    ///         voucher it holds outside its collateral (the borrower's to withdraw, not a pool obligation).
    function checkAgent(RigAgent agent, IERC20 bem) public view {
        console2.log("old agent", address(agent));
        console2.log("BEM", bem.balanceOf(address(agent)));
        console2.log("vouchers held", IRigVoucher(A.RIG_VOUCHER).balanceOf(address(agent)));
        require(!agent.hasLoan() && !agent.closed(), "old agent needs owner wind-down choice");
        require(agent.collateralOf().length == 0, "old collateral remains");
    }
}
