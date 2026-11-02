// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice SPIKE ONLY. ERC-4626 BEM pool ("iBEM"). totalAssets = idle BEM + principal lent out.
///         Agents are whitelisted by the owner (a factory in the real design).
contract SpikePool is ERC4626, IERC721Receiver {
    using SafeERC20 for IERC20;

    address public immutable owner;
    mapping(address => bool) public isAgent;
    uint256 public outstanding; // principal currently lent
    uint256 public interestEarned;
    uint256 public writtenOff;

    event Lent(address indexed agent, address indexed to, uint256 amount);
    event Repaid(address indexed agent, uint256 interest, uint256 principal);
    event Seized(address indexed agent, uint256 principalWrittenOff);

    error NotOwner();
    error NotAgent();

    constructor(IERC20 bem) ERC4626(bem) ERC20("Tape Pool iBEM (spike)", "iBEM") {
        owner = msg.sender;
    }

    /// virtual-share offset mitigates the first-depositor inflation attack (OZ ERC4626 pattern)
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + outstanding;
    }

    /// Withdrawals are limited to idle liquidity (lent principal is not withdrawable).
    function maxWithdraw(address o) public view override returns (uint256) {
        uint256 m = super.maxWithdraw(o);
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        return m < idle ? m : idle;
    }

    function maxRedeem(address o) public view override returns (uint256) {
        uint256 m = super.maxRedeem(o);
        uint256 cap = convertToShares(IERC20(asset()).balanceOf(address(this)));
        return m < cap ? m : cap;
    }

    function setAgent(address a, bool ok) external {
        if (msg.sender != owner) revert NotOwner();
        isAgent[a] = ok;
    }

    modifier onlyAgent() {
        if (!isAgent[msg.sender]) revert NotAgent();
        _;
    }

    function lend(uint256 amount, address to) external onlyAgent {
        outstanding += amount;
        IERC20(asset()).safeTransfer(to, amount);
        emit Lent(msg.sender, to, amount);
    }

    /// Agent pays interest first, then principal (pulled via transferFrom).
    function repay(uint256 interest, uint256 principal) external onlyAgent {
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), interest + principal);
        outstanding -= principal;
        interestEarned += interest;
        emit Repaid(msg.sender, interest, principal);
    }

    /// Default: the voucher has been moved to this pool; the remaining principal is written off.
    /// Future harvests are now paid to the pool directly (pool is the holder), recovering value over time.
    function onSeize(uint256 principal) external onlyAgent {
        outstanding -= principal;
        writtenOff += principal;
        emit Seized(msg.sender, principal);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
