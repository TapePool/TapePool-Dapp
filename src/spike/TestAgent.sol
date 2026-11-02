// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IRigVoucher} from "../interfaces/IXLayer.sol";

/// @notice SPIKE ONLY. Minimal per-borrower custody contract for one TapeOut RIG voucher.
///         Proves: it can receive a voucher by safeTransferFrom (hook) or transferFrom + register(),
///         send it back, and call redeem() as holder. Not production code.
contract TestAgent is IERC721Receiver {
    IRigVoucher public immutable voucher;
    address public immutable owner;

    uint256 public rigId;
    bool public holding;

    event Registered(uint256 id, bool viaHook);

    error NotOwner();
    error NotVoucher();
    error NotHeld();
    error AlreadyHolding();

    constructor(IRigVoucher voucher_, address owner_) {
        voucher = voucher_;
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// Path A: safeTransferFrom -> hook. Only accepts tokens of the real voucher contract.
    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        if (msg.sender != address(voucher)) revert NotVoucher();
        _register(id, true);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// Path B: plain transferFrom (or a direct _mint from a bridge deposit) + explicit register.
    function register(uint256 id) external {
        _register(id, false);
    }

    function _register(uint256 id, bool viaHook) internal {
        if (holding) revert AlreadyHolding();
        // When called from the hook, ownership is already updated (OZ ERC721 calls the hook after _update).
        if (voucher.ownerOf(id) != address(this)) revert NotHeld();
        rigId = id;
        holding = true;
        emit Registered(id, viaHook);
    }

    function release(address to) external onlyOwner {
        if (!holding) revert NotHeld();
        holding = false;
        voucher.safeTransferFrom(address(this), to, rigId);
    }

    /// Agent, as holder, redeems the rig to a BNB Chain address. msg.value pays the LayerZero fee.
    function redeem(address bscTo) external payable onlyOwner returns (bytes32 guid) {
        if (!holding) revert NotHeld();
        holding = false;
        guid = voucher.redeem{value: msg.value}(rigId, bscTo);
    }

    /// LayerZero refunds excess fee to the redeem caller (this contract), so it must accept OKB.
    receive() external payable {}
}
