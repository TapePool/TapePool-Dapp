// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IRigVoucher} from "../interfaces/IXLayer.sol";
import {SpikePool} from "./SpikePool.sol";
import {CircuitGate} from "./CircuitGate.sol";

/// @notice SPIKE ONLY. One agent per borrower, holding one RIG voucher.
///         borrow -> (optional) TapeOut credit-policy circuit -> pool.lend to the borrower EOA
///         harvest BEM lands here (agent is the voucher holder) -> permissionless sweep pays
///         interest first, then principal -> release voucher when debt == 0
///         seize after maturity: voucher -> pool, remaining principal written off.
contract SpikeRigAgent is IERC721Receiver {
    using SafeERC20 for IERC20;

    IRigVoucher public immutable voucher;
    IERC20 public immutable bem;
    SpikePool public immutable pool;
    address public immutable borrower;

    // credit policy circuit (address(0) = disabled)
    address public immutable policyCircuits;
    uint256 public immutable policyId;
    uint256 public constant POLICY_GAS_CAP = 1_000_000;

    /// simple interest, per second, WAD. 20%/yr.
    uint256 public constant RATE_WAD_PER_SEC = uint256(0.2e18) / 365 days;
    /// underwriting: expected BEM per unit of power per day (8 decimals), from research: ~0.00452
    uint256 public constant YIELD_PER_POWER_DAY = 452_000;

    uint256 public rigId;
    bool public holding;
    uint256 public principal;
    uint64 public paidUpTo; // interest is settled up to this timestamp
    uint64 public maturity;
    bool public seized;

    error NotBorrower();
    error NotVoucher();
    error NotHeld();
    error PolicyDenied();
    error StillOwed();
    error NotMatured();
    error NoDebt();

    event Borrowed(uint256 amount, uint8 term, uint8 dtoBucket, bool policyAllowed);
    event Swept(uint256 interest, uint256 principal, uint256 leftover);

    constructor(IRigVoucher v, SpikePool p, address borrower_, address policyCircuits_, uint256 policyId_) {
        voucher = v;
        bem = IERC20(v.bem());
        pool = p;
        borrower = borrower_;
        policyCircuits = policyCircuits_;
        policyId = policyId_;
    }

    // ───────────── custody
    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        if (msg.sender != address(voucher)) revert NotVoucher();
        _register(id);
        return IERC721Receiver.onERC721Received.selector;
    }

    function register(uint256 id) external {
        _register(id);
    }

    function _register(uint256 id) internal {
        if (holding || voucher.ownerOf(id) != address(this)) revert NotHeld();
        rigId = id;
        holding = true;
    }

    // ───────────── underwriting helpers
    function accrued() public view returns (uint256) {
        if (principal == 0) return 0;
        return principal * RATE_WAD_PER_SEC * (block.timestamp - paidUpTo) / 1e18;
    }

    function owed() external view returns (uint256) {
        return principal + accrued();
    }

    /// days-to-repay bucket (4-day buckets, saturating at 15) for a given debt
    function dtoBucket(uint256 debt) public view returns (uint8) {
        (,,, uint256 power) = voucher.rigs(rigId);
        uint256 perDay = power * YIELD_PER_POWER_DAY;
        if (perDay == 0) return 15;
        uint256 dto = debt / perDay; // whole days
        uint256 b = dto / 4;
        return b > 15 ? 15 : uint8(b);
    }

    /// TAP-02 input vector, LSB-first: bits0-1 term, bits2-5 DTO bucket, bits6-8 flags.
    function policyInputs(uint8 term, uint8 bucket, uint8 flags) public pure returns (bytes memory) {
        uint256 v = uint256(term & 3) | (uint256(bucket & 15) << 2) | (uint256(flags & 7) << 6);
        return abi.encodePacked(uint8(v & 0xff), uint8(v >> 8));
    }

    // ───────────── borrow
    /// @param term 0 = 30d, 1 = 60d, 2 = 90d (maturity is derived from the term, not chosen by the borrower)
    /// @param flags attestation stub (SPIKE: supplied by the borrower, NOT verified): bit0 fresh-attestation, bit1 no rescue/upgrade flag, bit2 processor allowlisted
    function borrow(uint256 amount, uint8 term, uint8 flags) external {
        if (msg.sender != borrower) revert NotBorrower();
        if (!holding) revert NotHeld();
        uint8 bucket = dtoBucket(principal + accrued() + amount);
        bool allowed = true;
        if (policyCircuits != address(0)) {
            allowed = CircuitGate.allow(policyCircuits, policyId, policyInputs(term, bucket, flags), POLICY_GAS_CAP);
            if (!allowed) revert PolicyDenied();
        }
        // move the pointer back so the accrued interest is preserved when principal grows
        if (principal == 0) {
            paidUpTo = uint64(block.timestamp);
        } else {
            uint256 acc = accrued();
            // convert accrued interest into an earlier pointer on the larger principal
            uint256 newP = principal + amount;
            uint256 secs = acc * 1e18 / (newP * RATE_WAD_PER_SEC);
            paidUpTo = uint64(block.timestamp - secs);
        }
        principal += amount;
        uint64 mat = uint64(block.timestamp + (uint256(term) + 1) * 30 days);
        if (mat > maturity) maturity = mat;
        pool.lend(amount, borrower); // proceeds go to the borrower, never stay in the agent
        emit Borrowed(amount, term, bucket, allowed);
    }

    // ───────────── repayment (permissionless)
    function sweep() public {
        uint256 bal = bem.balanceOf(address(this));
        if (bal == 0) return;
        if (seized) {
            // late harvest sent while the agent still held the voucher -> pool
            bem.safeTransfer(address(pool), bal);
            return;
        }
        if (principal == 0) return; // leftover belongs to the borrower (claimed on release)
        uint256 acc = accrued();
        uint256 payI = bal < acc ? bal : acc;
        if (payI == acc) {
            paidUpTo = uint64(block.timestamp);
        } else {
            // partial interest: advance pointer proportionally (floor)
            paidUpTo += uint64(payI * 1e18 / (principal * RATE_WAD_PER_SEC));
        }
        uint256 rest = bal - payI;
        uint256 payP = rest < principal ? rest : principal;
        principal -= payP;
        bem.forceApprove(address(pool), payI + payP);
        pool.repay(payI, payP);
        emit Swept(payI, payP, rest - payP);
    }

    /// Debt fully repaid -> voucher and any leftover BEM back to the borrower.
    function release() external {
        if (!holding) revert NotHeld();
        sweep();
        if (principal != 0 || accrued() != 0) revert StillOwed();
        holding = false;
        voucher.safeTransferFrom(address(this), borrower, rigId);
        uint256 left = bem.balanceOf(address(this));
        if (left > 0) bem.safeTransfer(borrower, left);
    }

    /// After maturity with debt outstanding: anyone can move the voucher to the pool.
    function seize() external {
        if (!holding) revert NotHeld();
        if (block.timestamp <= maturity) revert NotMatured();
        sweep();
        if (principal == 0) revert NoDebt();
        uint256 p = principal;
        principal = 0;
        holding = false;
        seized = true;
        voucher.safeTransferFrom(address(this), address(pool), rigId);
        pool.onSeize(p);
    }
}
