// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICreditPolicy, Reasons} from "./interfaces/ICreditPolicy.sol";
import {ITapePool} from "./interfaces/ITapePool.sol";
import {IRigFeed, RigReport} from "./interfaces/IRigFeed.sol";
import {IRigVoucher} from "./interfaces/IXLayer.sol";
import {RigAgent} from "./RigAgent.sol";

/// @title TapeLens
/// @notice Read-only helper for the app, the keeper and the Copilot: one call answers "how much can
///         this agent borrow, and if nothing, why" (SPEC §13). Holds no state and no funds.
contract TapeLens {
    uint256 internal constant BPS = 10_000;

    /// @notice A borrow quote for one agent and term.
    struct Quote {
        uint256 maxPrincipal; // 0 when `reason != OK`
        uint256 fee; // flat fee for `maxPrincipal`
        uint256 expected; // expected base output over the term, from the policy
        uint16 inputBits; // the circuit input the policy evaluated
        uint8 reason; // a `Reasons` code
        uint256 pending; // BEM still claimable on BSC for the collateral (harvest first if large)
        uint256 opsFee; // operating fee in wei of OKB that `borrow` must carry, for every reason code
    }

    /// @notice Largest advance `agent` can take for `term` right now, its fee, and the reason when
    ///         it can take nothing.
    /// @param agent The agent.
    /// @param term Term code (0 = 7 days, 1 = 14 days).
    function quote(RigAgent agent, uint8 term) external view returns (Quote memory q) {
        ITapePool pool = agent.pool();
        uint256[] memory ids = agent.collateralOf();
        q.pending = _pending(agent.feed(), ids);
        if (term <= 1) q.opsFee = pool.opsFee(term); // a bad term is reported as BAD_TERM, never reverts

        q.reason = _blocker(agent, pool, ids, term);
        if (q.reason == Reasons.OK) _policyQuote(q, agent, pool, ids, term);
    }

    /// @notice Quote the exact advance chosen by the borrower, including its fee bounds and blocker.
    /// @param agent The borrowing agent.
    /// @param term Term code (0 = 7 days, 1 = 14 days).
    /// @param principal The requested advance in raw BEM.
    function quoteFor(RigAgent agent, uint8 term, uint256 principal)
        external
        view
        returns (uint256 fee, uint16 lateBps, uint256 debt, bool allowed, uint8 reason, uint8 binding)
    {
        ITapePool pool = agent.pool();
        lateBps = uint16(pool.lateFeeBpsPerDay());
        if (term <= 1) {
            fee = pool.fee(term, principal);
            debt = principal + fee;
        }
        uint256[] memory ids = agent.collateralOf();
        reason = _blocker(agent, pool, ids, term);
        if (reason != Reasons.OK) return (fee, lateBps, debt, false, reason, 0);
        reason = _decision(agent, pool, ids, term, debt);
        if (reason != Reasons.OK) return (fee, lateBps, debt, false, reason, 0);
        if (principal < pool.minAdvance()) return (fee, lateBps, debt, false, Reasons.BELOW_MIN_ADVANCE, 0);
        (uint256 limit, uint8 constraint) = pool.lendLimit(agent.borrower());
        if (principal > limit) return (fee, lateBps, debt, false, Reasons.ABOVE_LEND_LIMIT, constraint);
        return (fee, lateBps, debt, true, Reasons.OK, 0);
    }

    function _decision(RigAgent agent, ITapePool pool, uint256[] memory ids, uint8 term, uint256 debt)
        internal
        view
        returns (uint8)
    {
        try pool.policy().check(address(agent), ids, term, debt) returns (bool allow, uint8 reason, uint16, uint256) {
            if (!allow || reason != Reasons.OK) return allow || reason == Reasons.OK ? Reasons.MISMATCH : reason;
            return Reasons.OK;
        } catch {
            return Reasons.EVAL;
        }
    }

    /// @notice The agent's loan with the late fee accrued to now.
    /// @param agent The agent.
    function loanOf(RigAgent agent) external view returns (RigAgent.LoanView memory) {
        return agent.loanOf();
    }

    /// @notice The agent's collateral voucher ids.
    /// @param agent The agent.
    function collateralOf(RigAgent agent) external view returns (uint256[] memory) {
        return agent.collateralOf();
    }

    /// @notice Largest principal `p` with `p + pool.fee(term, p) <= debtLimit`.
    /// @param pool The pool whose fee function applies.
    /// @param term Term code.
    /// @param debtLimit Largest allowed debt in raw BEM.
    function principalFor(ITapePool pool, uint8 term, uint256 debtLimit) public view returns (uint256 p) {
        uint256 minFee = pool.minFee();
        if (debtLimit <= minFee) return 0;
        // flat region: the minimum fee applies
        p = debtLimit - minFee;
        if (p + pool.fee(term, p) <= debtLimit) return p;
        // rate region: p + ceil(p * bps / BPS) <= debtLimit
        uint256 bps = term == 0 ? pool.feeBps7d() : pool.feeBps14d();
        p = debtLimit * BPS / (BPS + bps);
        while (p != 0 && p + pool.fee(term, p) > debtLimit) --p;
    }

    /// @dev Size the advance from the policy's max debt and the pool's room, then ask the policy
    ///      once more for the inputs and the reason. Probes `minAdvance` when nothing fits, so the
    ///      reason says why.
    function _policyQuote(Quote memory q, RigAgent agent, ITapePool pool, uint256[] memory ids, uint8 term)
        internal
        view
    {
        ICreditPolicy policy = pool.policy();
        (uint256 p, uint8 shortReason) = _size(agent, pool, policy, ids, term);
        q.fee = pool.fee(term, p);
        try policy.check(address(agent), ids, term, p + q.fee) returns (
            bool allow, uint8 reason, uint16 bits, uint256 expected
        ) {
            q.inputBits = bits;
            q.expected = expected;
            if (!allow || reason != Reasons.OK) {
                // same reading as the agent: allow with a non-OK reason is a mismatch
                q.reason = allow || reason == Reasons.OK ? Reasons.MISMATCH : reason;
                q.fee = 0;
            } else if (shortReason != Reasons.OK) {
                q.reason = shortReason;
                q.fee = 0;
            } else {
                q.reason = Reasons.OK;
                q.maxPrincipal = p;
            }
        } catch {
            q.reason = Reasons.EVAL;
            q.fee = 0;
        }
    }

    /// @dev Advance from the policy's max debt, capped by the pool's room. When that is below
    ///      `minAdvance`, returns `minAdvance` as the probe and the reason nothing fits.
    function _size(RigAgent agent, ITapePool pool, ICreditPolicy policy, uint256[] memory ids, uint8 term)
        internal
        view
        returns (uint256 p, uint8 shortReason)
    {
        try policy.maxDebt(address(agent), ids, term) returns (uint256 limit) {
            p = principalFor(pool, term, limit);
        } catch {} // p stays 0: the probe below asks `check` for the reason
        (uint256 room,) = pool.lendLimit(agent.borrower());
        bool roomLimited = p > room;
        if (roomLimited) p = room;
        uint256 minAdvance = pool.minAdvance();
        if (p < minAdvance) {
            shortReason = roomLimited ? Reasons.NO_ROOM : Reasons.DENIED;
            p = minAdvance;
        }
    }

    function _blocker(RigAgent agent, ITapePool pool, uint256[] memory ids, uint8 term) internal view returns (uint8) {
        if (agent.closed()) return Reasons.CLOSED;
        if (agent.hasLoan()) return Reasons.LOAN_OPEN;
        if (term > 1) return Reasons.BAD_TERM;
        if (pool.policySwapQueued()) return Reasons.SWAP_QUEUED;
        if (pool.borrowsPaused()) return Reasons.PAUSED;
        if (pool.feedDisabled()) return Reasons.FEED_OFF;
        if (ids.length == 0) return Reasons.NO_COLLATERAL;
        IRigVoucher voucher = agent.voucher();
        for (uint256 i; i < ids.length; ++i) {
            if (!_owns(voucher, ids[i], address(agent))) return Reasons.NO_COLLATERAL;
        }
        return Reasons.OK;
    }

    function _owns(IRigVoucher voucher, uint256 id, address agent) internal view returns (bool) {
        bytes memory q = abi.encodeCall(IRigVoucher.ownerOf, (id));
        address v = address(voucher);
        bool ok;
        uint256 word;
        assembly {
            ok := staticcall(100000, v, add(q, 0x20), mload(q), 0, 0x20)
            ok := and(ok, gt(returndatasize(), 0x1f))
            word := mload(0)
        }
        return ok && word <= type(uint160).max && address(uint160(word)) == agent;
    }

    function _pending(IRigFeed feed, uint256[] memory ids) internal view returns (uint256 sum) {
        for (uint256 i; i < ids.length; ++i) {
            try feed.latest(ids[i]) returns (RigReport memory r, bool ok) {
                if (ok) sum += r.pending;
            } catch {}
        }
    }
}
