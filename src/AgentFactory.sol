// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IRigVoucher} from "./interfaces/IXLayer.sol";
import {IRigFeed} from "./interfaces/IRigFeed.sol";
import {ITapePool, IAgentFactory} from "./interfaces/ITapePool.sol";
import {RigAgent} from "./RigAgent.sol";

/// @title AgentFactory
/// @notice Deploys `RigAgent` clones with CREATE2 and records each agent's borrower. The pool lends
///         only to agents recorded here and always takes the borrower from `borrowerOf` (SPEC §10.1).
/// @dev Deploy this first with the pool's predicted address; the pool's constructor checks that
///      `pool()` is itself, so a wrong prediction fails the deploy.
contract AgentFactory is IAgentFactory {
    RigAgent public immutable implementation;
    address public immutable pool;
    address public immutable bem;
    IRigVoucher public immutable voucher;
    IRigFeed public immutable feed;

    mapping(address agent => address) public borrowerOf;
    mapping(address borrower => address[]) internal _agentsOf;

    event AgentCreated(address indexed agent, address indexed borrower, uint256 index);

    error BemMismatch();
    error ZeroAddress();

    /// @param pool_ The pool's predicted address.
    /// @param voucher_ The RIG voucher on X Layer.
    /// @param bem_ The BEM OFT on X Layer; must be the token the voucher pays harvests in.
    /// @param feed_ The rig data feed every agent reads evidence from.
    constructor(address pool_, IRigVoucher voucher_, IERC20 bem_, IRigFeed feed_) {
        if (pool_ == address(0) || address(feed_) == address(0)) revert ZeroAddress();
        if (voucher_.bem() != address(bem_)) revert BemMismatch();
        pool = pool_;
        bem = address(bem_);
        voucher = voucher_;
        feed = feed_;
        implementation = new RigAgent(ITapePool(pool_), voucher_, bem_, feed_);
    }

    /// @notice Create the caller's agent number `index`. The caller becomes its borrower.
    /// @param index Any number; one agent per (caller, index).
    /// @return agent The new agent.
    function create(uint256 index) external returns (address agent) {
        agent = Clones.cloneDeterministic(address(implementation), _salt(msg.sender, index));
        borrowerOf[agent] = msg.sender;
        _agentsOf[msg.sender].push(agent);
        RigAgent(agent).initialize(msg.sender);
        emit AgentCreated(agent, msg.sender, index);
    }

    /// @notice Address `create(index)` gives `borrower`.
    /// @param borrower The future borrower.
    /// @param index The agent number.
    function predictAgent(address borrower, uint256 index) external view returns (address) {
        return Clones.predictDeterministicAddress(address(implementation), _salt(borrower, index));
    }

    /// @notice Every agent `borrower` created, in creation order.
    /// @param borrower The borrower.
    function agentsOf(address borrower) external view returns (address[] memory) {
        return _agentsOf[borrower];
    }

    /// @notice True if `agent` was created by this factory.
    /// @param agent Any address.
    function isAgent(address agent) external view returns (bool) {
        return borrowerOf[agent] != address(0);
    }

    function _salt(address borrower, uint256 index) internal pure returns (bytes32) {
        return keccak256(abi.encode(borrower, index));
    }
}
