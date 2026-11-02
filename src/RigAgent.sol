// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IRigVoucher} from "./interfaces/IXLayer.sol";
import {IRigFeed, RigReport} from "./interfaces/IRigFeed.sol";
import {ICreditPolicy, Reasons} from "./interfaces/ICreditPolicy.sol";
import {ITapePool} from "./interfaces/ITapePool.sol";
import {CreditMath} from "./libraries/CreditMath.sol";

/// @title RigAgent
/// @notice One borrower's agent (an EIP-1167 clone). It holds the borrower's RIG vouchers as
///         collateral and carries at most one loan. Harvests of those rigs pay the agent, and anyone
///         can sweep that BEM into the pool: late fee, then flat fee, then principal. A live rig is
///         never seized for being slow; only proven impairment leads to a seize (SPEC §10).
/// @dev The implementation is closed in its constructor, so only clones are usable. The pool, the
///      voucher, BEM and the feed are immutables of the implementation, shared by every clone.
///      A clone's `ReentrancyGuard` slot starts at 0 because no constructor runs for it. OZ 5.1
///      treats only `ENTERED` (2) as locked, so 0 is safe; recheck this on any OZ upgrade.
contract RigAgent is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────────────────────── constants (SPEC §2, §10.5)

    uint256 public constant MAX_COLLATERAL = 16;
    uint256 public constant MAX_REPORT_AGE = 300;
    uint256 public constant MAX_CLOCK_SKEW = 60;
    uint256 public constant CURE_WINDOW = 72 hours;
    uint256 public constant EVIDENCE_WINDOW = 24 hours;
    /// @notice Gas cap for each voucher call inside `seize` and `forwardVouchers`.
    uint256 public constant VOUCHER_GAS = 200_000;
    /// @notice Gas cap for an ownership read during voucher reconciliation.
    uint256 public constant OWNER_READ_GAS = 100_000;
    uint8 public constant EVIDENCE_REPORT = 1;
    uint8 public constant EVIDENCE_VOUCHER = 2;
    uint8 internal constant ACTIVE = 1;
    uint256 internal constant BPS = 10_000;

    /// @notice The open loan. `start == 0` means no loan.
    struct Loan {
        uint64 start;
        uint64 maturity;
        uint64 lateAccruedTo;
        uint64 impairedAt;
        uint8 term;
        uint16 lateBpsPerDay;
        bool doubtful;
        uint256 impairedRig;
        uint256 principal;
        uint256 principal0;
        uint256 feeLeft;
        uint256 lateFeeDue;
        uint256 lateBooked;
    }

    /// @dev The pool's feed state, read once per external call (R3-01). `enableFloor` is
    ///      `feedEnabledAt + MAX_CLOCK_SKEW`, saturating (R3-00).
    struct FeedState {
        bool disabled;
        uint256 enableFloor;
    }

    /// @notice The loan as views report it, with the late fee accrued to now (SPEC §13).
    struct LoanView {
        bool open;
        uint64 start;
        uint64 maturity;
        uint8 term;
        uint256 principal;
        uint256 principal0;
        uint256 feeLeft;
        uint16 lateBpsPerDay;
        uint64 lateAccruedTo;
        uint256 lateFeeDue;
        uint256 debt;
        uint64 impairedAt;
        uint256 impairedRig;
        bool doubtful;
        uint64 seizeStart;
        uint64 deadline;
        bool expired;
    }

    // ───────────────────────── immutables (shared by all clones)

    ITapePool public immutable pool;
    IRigVoucher public immutable voucher;
    IERC20 public immutable bem;
    /// @notice The only source of report evidence, fixed at deploy (SPEC §6).
    IRigFeed public immutable feed;
    address public immutable factory;

    // ───────────────────────── state

    address public borrower;
    /// @notice A seized agent is closed for good: no new collateral or loans, BEM goes to the pool.
    bool public closed;
    uint256[] internal _collateral;
    Loan internal _loan;
    uint64 internal _evidenceFloor;
    /// @notice True for every voucher id that was collateral when this agent was seized (R3-02). Only
    ///         `seize` writes it, so it is set only on a closed agent.
    mapping(uint256 id => bool) public wasSeized;

    // ───────────────────────── events (SPEC §13)

    event CollateralAdded(address indexed agent, uint256 indexed id);
    event CollateralRemoved(address indexed agent, uint256 indexed id);
    event VoucherWithdrawn(address indexed agent, uint256 indexed id);
    event Borrowed(
        address indexed agent,
        address indexed borrower,
        uint8 term,
        uint256 principal,
        uint256 fee,
        uint64 maturity,
        uint256[] ids
    );
    event Swept(address indexed agent, uint256 lateFeePaid, uint256 feePaid, uint256 principalPaid, uint256 leftover);
    event Repaid(address indexed agent, address indexed payer, uint256 amount);
    event LoanClosed(address indexed agent);
    event Released(address indexed agent, uint256[] ids);
    event LateClaimed(address indexed agent, address indexed to, uint256 amount);
    event ImpairmentFlagged(address indexed agent, uint256 indexed rigId, uint8 evidenceKind, uint64 impairedAt);
    event Seized(address indexed agent, uint256[] movedIds, uint256[] stuckIds, uint256 writtenOff);
    event VouchersForwarded(address indexed agent, uint256[] ids);
    event FlagCleared(address indexed agent, uint256 indexed rigId);
    event OpsFeePaid(address indexed agent, uint8 term, uint256 amount, address indexed to);

    // ───────────────────────── errors

    error NotFactory();
    error AlreadyInitialized();
    error NotBorrower();
    error NotVoucher();
    error NotFromBorrower();
    error AgentClosed();
    error NotClosed();
    error CollateralFull();
    error AlreadyCollateral(uint256 id);
    error NotCollateral(uint256 id);
    error NotOwned(uint256 id);
    error NoCollateral();
    error LoanOpen();
    error NoLoan();
    error BorrowsArePaused();
    error FeedIsDisabled();
    error BadTerm(uint8 term);
    error BelowMinAdvance();
    error FeeAboveBound(uint256 fee, uint16 lateBps);
    error WrongOpsFee(uint256 expected);
    error OpsFeeTransferFailed();
    error PolicyDenied(uint8 reason);
    error FlagLive();
    error NoFlag();
    error FlagNotExpired();
    error FlagExpired();
    error CureWindow();
    error NoEvidence();
    error NoHealthEvidence();
    error NoDebt();
    error InsufficientGas();
    error SeizedVoucher(uint256 id);

    // ───────────────────────── construction

    /// @param pool_ The pool (its predicted address when the factory is deployed first).
    /// @param voucher_ The RIG voucher on X Layer.
    /// @param bem_ The BEM OFT on X Layer.
    /// @param feed_ The rig data feed.
    constructor(ITapePool pool_, IRigVoucher voucher_, IERC20 bem_, IRigFeed feed_) {
        pool = pool_;
        voucher = voucher_;
        bem = bem_;
        feed = feed_;
        factory = msg.sender;
        closed = true; // the bare implementation is never usable
    }

    /// @notice Bind a fresh clone to its borrower. Factory only, once.
    /// @param borrower_ The borrower that created the clone.
    function initialize(address borrower_) external {
        if (msg.sender != factory) revert NotFactory();
        if (borrower != address(0) || closed) revert AlreadyInitialized();
        borrower = borrower_;
    }

    modifier onlyBorrower() {
        if (msg.sender != borrower) revert NotBorrower();
        _;
    }

    // ───────────────────────── collateral (SPEC §10.2)

    /// @notice Accept a voucher sent with `safeTransferFrom` by the borrower and add it to the
    ///         collateral. Every other sender reverts.
    function onERC721Received(address operator, address from, uint256 id, bytes calldata)
        external
        nonReentrant
        returns (bytes4)
    {
        if (msg.sender != address(voucher)) revert NotVoucher();
        if (operator != borrower || from != borrower || from == address(0)) revert NotFromBorrower();
        if (closed) revert AgentClosed();
        if (_loan.start != 0) revert LoanOpen();
        if (voucher.ownerOf(id) != address(this)) revert NotOwned(id);
        if (_add(id)) emit CollateralAdded(address(this), id);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice Add a voucher the agent already owns (after a plain `transferFrom` or a bridge mint).
    /// @param id Voucher id.
    function register(uint256 id) external onlyBorrower nonReentrant {
        if (closed) revert AgentClosed();
        if (_loan.start != 0) revert LoanOpen();
        if (voucher.ownerOf(id) != address(this)) revert NotOwned(id);
        if (!_add(id)) revert AlreadyCollateral(id);
        emit CollateralAdded(address(this), id);
    }

    /// @notice Send a voucher to the borrower. A collateral voucher needs no open loan and an open
    ///         agent; a voucher that was collateral at a seize never leaves (`SeizedVoucher`, R3-02);
    ///         any other voucher can always be withdrawn, also from a closed agent. A collateral id
    ///         the agent no longer owns (moved out by a voucher-side action) is only removed from the set.
    /// @param id Voucher id.
    function withdrawVoucher(uint256 id) external onlyBorrower nonReentrant {
        // only `seize` sets `wasSeized`, and it closes the agent, so this is the closed-agent check
        if (wasSeized[id]) revert SeizedVoucher(id);
        (bool found, uint256 i) = _indexOf(id);
        if (found) {
            if (_loan.start != 0) revert LoanOpen();
            if (closed) revert AgentClosed();
            _removeAt(i);
            emit CollateralRemoved(address(this), id);
            if (!_owns(id)) return;
        }
        voucher.transferFrom(address(this), borrower, id);
        emit VoucherWithdrawn(address(this), id);
    }

    /// @notice Send collateral vouchers to the borrower, retaining unreadable or stuck ids for retry.
    ///         Borrower only, open agent with no loan.
    function release() external onlyBorrower nonReentrant {
        if (_loan.start != 0) revert LoanOpen();
        if (closed) revert AgentClosed();
        uint256[] memory ids = _collateral;
        delete _collateral;
        (uint256[] memory moved,) = _moveCollateral(ids, borrower);
        emit Released(address(this), moved);
    }

    /// @notice Remove an entry without a voucher call. Borrower only, open agent with no loan.
    /// @param id Listed voucher id.
    function forget(uint256 id) external onlyBorrower nonReentrant {
        if (closed) revert AgentClosed();
        if (_loan.start != 0) revert LoanOpen();
        (bool found, uint256 i) = _indexOf(id);
        if (!found) revert NotCollateral(id);
        _removeAt(i);
        emit CollateralRemoved(address(this), id);
    }

    // ───────────────────────── borrow (SPEC §10.3)

    /// @notice Take an advance of `principal` for `term`. The maturity follows from the term, and
    ///         the proceeds go to the borrower. `msg.value` must equal `pool.opsFee(term)`, the
    ///         operating fee in OKB, which goes to the pool's owner and is never refunded.
    /// @param term Term code (0 = 7 days, 1 = 14 days).
    /// @param principal Advance in raw BEM, at least `pool.minAdvance()`.
    /// @param maxFee Maximum computed BEM fee, including the minimum fee.
    /// @param maxLateBps Maximum late rate accepted by the borrower.
    function borrow(uint8 term, uint256 principal, uint256 maxFee, uint16 maxLateBps)
        external
        payable
        onlyBorrower
        nonReentrant
    {
        if (closed) revert AgentClosed();
        if (_loan.start != 0) revert LoanOpen();
        if (pool.borrowsPaused()) revert BorrowsArePaused();
        if (pool.feedDisabled()) revert FeedIsDisabled();
        uint256 n = _collateral.length;
        if (n == 0) revert NoCollateral();
        for (uint256 i; i < n; ++i) {
            uint256 id = _collateral[i];
            if (voucher.ownerOf(id) != address(this)) revert NotOwned(id);
        }
        if (!CreditMath.isTerm(term)) revert BadTerm(term);
        // the operating fee in OKB, exact so a borrower can never overpay (SPEC-PHASE3-OPSFEE §4.2)
        uint256 ops = pool.opsFee(term);
        if (msg.value != ops) revert WrongOpsFee(ops);
        if (principal < pool.minAdvance()) revert BelowMinAdvance();

        uint256 fee = pool.fee(term, principal);
        {
            uint16 lateBps = uint16(pool.lateFeeBpsPerDay());
            if (fee > maxFee || lateBps > maxLateBps) revert FeeAboveBound(fee, lateBps);
            (bool allow, uint8 reason,,) = pool.policy().check(address(this), _collateral, term, principal + fee);
            if (!allow || reason != Reasons.OK) {
                revert PolicyDenied(allow || reason == Reasons.OK ? Reasons.MISMATCH : reason);
            }
        }

        uint64 start = uint64(block.timestamp);
        uint64 maturity = uint64(block.timestamp + CreditMath.termDays(term) * 1 days);
        _evidenceFloor = start;
        _loan = Loan({
            start: start,
            maturity: maturity,
            lateAccruedTo: maturity,
            impairedAt: 0,
            term: term,
            lateBpsPerDay: uint16(pool.lateFeeBpsPerDay()),
            doubtful: false,
            impairedRig: 0,
            principal: principal,
            principal0: principal,
            feeLeft: fee,
            lateFeeDue: 0,
            lateBooked: 0
        });

        // BEM already here predates the loan, so it is the borrower's
        uint256 bal = bem.balanceOf(address(this));
        if (bal != 0) bem.safeTransfer(borrower, bal);
        pool.lend(principal);
        emit Borrowed(address(this), borrower, term, principal, fee, maturity, _collateral);

        // last external call: forward exactly the fee (never the balance) to the pool's owner
        if (ops != 0) {
            address to = pool.owner();
            (bool sent,) = to.call{value: ops}("");
            if (!sent) revert OpsFeeTransferFailed();
            emit OpsFeePaid(address(this), term, ops, to);
        }
    }

    // ───────────────────────── repayment (SPEC §10.4)

    /// @notice Pay the open loan from the agent's BEM: late fee, flat fee, then principal. On a
    ///         closed agent, forward the BEM to the pool. Permissionless.
    function sweep() external nonReentrant {
        if (closed) {
            _forward(address(pool));
            return;
        }
        if (_loan.start == 0) revert NoLoan();
        _accrue();
        _waterfall();
    }

    /// @notice Pay up to `amount` of the open loan from the caller's BEM. Pulls only what the
    ///         agent's own balance leaves unpaid. Permissionless.
    /// @param amount Most BEM to pull from the caller.
    function repay(uint256 amount) external nonReentrant {
        if (_loan.start == 0) revert NoLoan();
        _accrue();
        uint256 bal = bem.balanceOf(address(this));
        uint256 owed = _debt(_loan);
        uint256 pull = owed > bal ? owed - bal : 0;
        if (amount < pull) pull = amount;
        if (pull != 0) bem.safeTransferFrom(msg.sender, address(this), pull);
        emit Repaid(address(this), msg.sender, pull);
        _waterfall();
    }

    /// @notice Forward BEM that landed with no loan open: to the borrower, or to the pool if the
    ///         agent is closed. Permissionless.
    function claimLate() external nonReentrant {
        if (_loan.start != 0) revert LoanOpen();
        _forward(closed ? address(pool) : borrower);
    }

    // ───────────────────────── impairment (SPEC §7.2, §10.5)

    /// @notice Flag the loan as impaired on on-chain evidence about collateral voucher `rigId`, and
    ///         mark its principal doubtful. Acts only when there is no live flag. Evidence is a report
    ///         that meets R3-00 row E (kind 1) or a voucher record that meets row VE (kind 2), at or
    ///         after `flagEvidenceFrom()`. Permissionless.
    /// @param rigId A collateral voucher id.
    function flagImpaired(uint256 rigId) external nonReentrant {
        Loan storage l = _loan;
        if (l.start == 0) revert NoLoan();
        (bool found,) = _indexOf(rigId);
        if (!found) revert NotCollateral(rigId);
        if (l.impairedAt != 0 && !_expired(l)) revert FlagLive();
        _accrue();
        if (_waterfall()) return;
        uint8 kind = _impairment(rigId, flagEvidenceFrom(), _feedState());
        if (kind == 0) revert NoEvidence();

        l.impairedAt = uint64(block.timestamp);
        l.impairedRig = rigId;
        l.doubtful = true;
        pool.markDoubtful();
        emit ImpairmentFlagged(address(this), rigId, kind, l.impairedAt);
    }

    /// @notice Clear an expired flag when the flagged rig is healthy and no collateral rig is impaired.
    ///         For each rig the newest candidate at or after `seizeEvidenceFrom()` decides: a report
    ///         under R3-00 row H (healthy), row B (impaired) or row U (unknown, which masks only
    ///         health: an older power-0 record still blocks), or the voucher record under row VC.
    ///         Permissionless.
    function clearExpiredFlag() external nonReentrant {
        Loan storage l = _loan;
        if (l.start == 0) revert NoLoan();
        if (l.impairedAt == 0) revert NoFlag();
        if (!_expired(l)) revert FlagNotExpired();
        uint256 rigId = l.impairedRig;
        // both paths need evidence from after the cure window: `syncedAt` is a BSC send time, so
        // `impairedAt` (X Layer time) would let a harvest sent just before a rescue count as health
        uint256 from = seizeEvidenceFrom();
        FeedState memory f = _feedState();
        uint256 n = _collateral.length;
        for (uint256 i; i < n; ++i) {
            uint8 verdict = _verdict(_collateral[i], from, f);
            if (verdict == 2 || (_collateral[i] == rigId && verdict != 1)) revert NoHealthEvidence();
        }
        _evidenceFloor = uint64(block.timestamp);

        l.impairedAt = 0;
        l.impairedRig = 0;
        l.doubtful = false;
        pool.clearDoubtful();
        emit FlagCleared(address(this), rigId);
    }

    /// @notice Seize an impaired loan after the cure window, on new evidence (R3-00 row E or VE for
    ///         any collateral rig, at or after `seizeEvidenceFrom()`): write off the principal, close
    ///         the agent and send every collateral voucher to the pool. Every collateral id is recorded
    ///         in `wasSeized` before any interaction, and an id read as held elsewhere stays listed
    ///         for `forwardVouchers` (R3-02). Permissionless.
    function seize() external nonReentrant {
        Loan storage l = _loan;
        if (l.start == 0) revert NoLoan();
        if (l.impairedAt == 0) revert NoFlag();
        uint256 from = _seizeStart(l);
        if (block.timestamp < from) revert CureWindow();
        if (_expired(l)) revert FlagExpired();
        from = seizeEvidenceFrom();
        FeedState memory f = _feedState();
        bool evidence;
        uint256 n = _collateral.length;
        for (uint256 i; i < n && !evidence; ++i) {
            evidence = _impairment(_collateral[i], from, f) != 0;
        }
        if (!evidence) revert NoEvidence();

        _accrue();
        (uint256 late, uint256 flat, uint256 prin,) = _payment(l);
        if (prin == l.principal) revert NoDebt();
        uint256[] memory ids = _collateral;
        for (uint256 i; i < ids.length; ++i) {
            wasSeized[ids[i]] = true;
        }
        delete _collateral;
        delete _loan;
        closed = true;
        uint256 paid = late + flat + prin;
        if (paid != 0) {
            bem.forceApprove(address(pool), paid);
            pool.repay(late + flat, prin);
        }
        uint256 writtenOff = pool.writeOff();
        (uint256[] memory moved, uint256[] memory stuck) = _moveCollateral(ids, address(pool));
        emit Seized(address(this), moved, stuck, writtenOff);
    }

    /// @notice Retry sending collateral vouchers that a seize could not move. An id is removed only
    ///         once the pool holds it; an id read as unknown or as held by anyone else stays listed
    ///         for the next retry (R3-02). Permissionless.
    function forwardVouchers() external nonReentrant {
        if (!closed) revert NotClosed();
        uint256[] memory ids = _collateral;
        delete _collateral;
        (uint256[] memory moved,) = _moveCollateral(ids, address(pool));
        emit VouchersForwarded(address(this), moved);
    }

    // ───────────────────────── views (SPEC §13)

    /// @notice The loan with the late fee accrued to now, plus the seize timeline.
    function loanOf() external view returns (LoanView memory v) {
        Loan storage l = _loan;
        if (l.start == 0) return v;
        v.open = true;
        v.start = l.start;
        v.maturity = l.maturity;
        v.term = l.term;
        v.principal = l.principal;
        v.principal0 = l.principal0;
        v.feeLeft = l.feeLeft;
        v.lateBpsPerDay = l.lateBpsPerDay;
        v.lateAccruedTo = l.lateAccruedTo;
        v.lateFeeDue = l.lateFeeDue + _lateSince(l) - l.lateBooked;
        v.debt = v.lateFeeDue + l.feeLeft + l.principal;
        v.impairedAt = l.impairedAt;
        v.impairedRig = l.impairedRig;
        v.doubtful = l.doubtful;
        if (l.impairedAt != 0) {
            v.seizeStart = uint64(_seizeStart(l));
            v.deadline = uint64(_deadline(l));
            v.expired = _expired(l);
        }
    }

    /// @notice The collateral voucher ids, strictly ascending.
    function collateralOf() external view returns (uint256[] memory) {
        return _collateral;
    }

    /// @notice True while a loan is open.
    function hasLoan() external view returns (bool) {
        return _loan.start != 0;
    }

    // ───────────────────────── internals: loan math

    /// @dev Checkpoint the late fee (SPEC §10.3). Runs before every change of principal.
    function _accrue() internal {
        Loan storage l = _loan;
        uint256 due = _lateSince(l);
        if (due > l.lateBooked) {
            l.lateFeeDue += due - l.lateBooked;
            l.lateBooked = due;
        }
    }

    function _lateSince(Loan storage l) internal view returns (uint256) {
        if (block.timestamp <= l.lateAccruedTo || l.lateBpsPerDay == 0) return 0;
        uint256 dt = block.timestamp - l.lateAccruedTo;
        return Math.mulDiv(l.principal, uint256(l.lateBpsPerDay) * dt, BPS * 1 days, Math.Rounding.Ceil);
    }

    function _debt(Loan storage l) internal view returns (uint256) {
        return l.lateFeeDue + l.feeLeft + l.principal;
    }

    /// @dev Pay the loan from the agent's whole BEM balance. Closes the loan and sends any leftover
    ///      to the borrower when the debt reaches 0. Returns true if it closed the loan.
    function _waterfall() internal returns (bool done) {
        Loan storage l = _loan;
        (uint256 late, uint256 flat, uint256 prin, uint256 bal) = _payment(l);

        l.lateFeeDue -= late;
        l.feeLeft -= flat;
        l.principal -= prin;
        if (prin != 0) {
            l.lateAccruedTo = uint64(Math.max(block.timestamp, l.maturity));
            l.lateBooked = 0;
        }
        done = l.principal == 0;
        if (done) delete _loan;

        uint256 paid = late + flat + prin;
        if (paid != 0) {
            bem.forceApprove(address(pool), paid);
            pool.repay(late + flat, prin);
        }
        emit Swept(address(this), late, flat, prin, bal);
        if (done) {
            emit LoanClosed(address(this));
            if (bal != 0) bem.safeTransfer(borrower, bal);
        }
    }

    function _forward(address to) internal {
        uint256 bal = bem.balanceOf(address(this));
        if (bal != 0) bem.safeTransfer(to, bal);
        emit LateClaimed(address(this), to, bal);
    }

    // ───────────────────────── internals: impairment timeline

    function _seizeStart(Loan storage l) internal view returns (uint256) {
        return uint256(l.impairedAt) + CURE_WINDOW;
    }

    function _deadline(Loan storage l) internal view returns (uint256) {
        uint64 expiry = pool.expiryOf(l.impairedAt);
        return expiry == type(uint64).max ? expiry : expiry - 1;
    }

    function _expired(Loan storage l) internal view returns (bool) {
        return l.impairedAt != 0 && block.timestamp >= pool.expiryOf(l.impairedAt);
    }

    /// @notice Earliest admissible evidence for a new flag, with BSC clock skew included.
    function flagEvidenceFrom() public view returns (uint64) {
        if (_loan.impairedAt == 0) return _plusSkew(_evidenceFloor);
        if (!_expired(_loan)) return type(uint64).max;
        return _plusSkew(pool.expiryOf(_loan.impairedAt));
    }

    /// @notice Earliest evidence for seizure or clearing, with BSC clock skew included.
    function seizeEvidenceFrom() public view returns (uint64) {
        if (_loan.impairedAt == 0) return type(uint64).max;
        return _plusSkew(_seizeStart(_loan));
    }

    function _plusSkew(uint256 t) internal pure returns (uint64) {
        return uint64(Math.min(t + MAX_CLOCK_SKEW, type(uint64).max));
    }

    function _payment(Loan storage l) internal view returns (uint256 late, uint256 flat, uint256 prin, uint256 bal) {
        bal = bem.balanceOf(address(this));
        late = Math.min(bal, l.lateFeeDue);
        bal -= late;
        flat = Math.min(bal, l.feeLeft);
        bal -= flat;
        prin = Math.min(bal, l.principal);
        bal -= prin;
    }

    // ───────────────────────── internals: evidence (SPEC §7.2, §10.5)

    /// @dev The feed flag and the enable floor, read once per external call (R3-01).
    function _feedState() internal view returns (FeedState memory f) {
        f.disabled = pool.feedDisabled();
        f.enableFloor = _plusSkew(pool.feedEnabledAt());
    }

    /// @dev Impairment evidence kind for `id` against the caller's `floor` (0 = none), per R3-00.
    ///      Row E (kind 1, checked first): a report with base(r), observed at or after the enable
    ///      floor and `floor`, fresh and impaired; `sane` is not required. Row VE (kind 2): a known
    ///      voucher record with power 0, synced at or after `floor`, unless row S holds: a sane
    ///      healthy report with base(r), observed at or after the enable floor and strictly after the
    ///      record's `syncedAt`, of any age (R3-04). A tie does not shield.
    function _impairment(uint256 id, uint256 floor, FeedState memory f) internal view returns (uint8) {
        // row S: `observedAt` of a sane healthy report at or after the enable floor, 0 if none. A
        // candidate is never 0, because the enable floor is at least `MAX_CLOCK_SKEW`.
        uint256 healthyAt;
        if (!f.disabled) {
            (RigReport memory r, bool ok) = _report(id);
            if (ok && _base(r, id) && r.observedAt >= f.enableFloor) {
                if (_impaired(r)) {
                    if (r.observedAt >= floor && _fresh(r)) return EVIDENCE_REPORT;
                } else if (_sane(r)) {
                    healthyAt = r.observedAt;
                }
            }
        }
        (bool known, uint64 syncedAt, uint256 power) = _voucherRecord(id);
        if (known && power == 0 && syncedAt >= floor && syncedAt >= healthyAt) return EVIDENCE_VOUCHER;
        return 0;
    }

    /// @dev The newest candidate reading of `id` against `floor`: 0 missing, 1 healthy, 2 impaired,
    ///      per R3-00. Row H: a fresh, sane, healthy report with base(r), observed at or after the
    ///      enable floor and `floor`. Row B: an impaired report with base(r) observed at or after
    ///      `floor`, of any age and without the enable floor (R3-05). Row U: a report with base(r) that
    ///      is not impaired, observed at or after `floor` but below the enable floor, is a candidate of
    ///      unknown verdict (0): a brake-time report may hide an impairment it overwrote. Row VC: a
    ///      known voucher record synced at or after `floor`; power above 0 is healthy, power 0 impaired.
    ///      The newer candidate wins and impairment wins a timestamp tie. Unknown masks only health:
    ///      over row U the record decides when synced after it, and a power-0 record decides at any
    ///      `syncedAt` at or after `floor`; a positive record not newer than it leaves the rig missing.
    ///      No candidate means missing.
    function _verdict(uint256 id, uint256 floor, FeedState memory f) internal view returns (uint8 verdict) {
        bool reported;
        uint256 at;
        if (!f.disabled) {
            (RigReport memory r, bool ok) = _report(id);
            if (ok && _base(r, id) && r.observedAt >= floor) {
                if (_impaired(r)) {
                    (verdict, reported, at) = (2, true, r.observedAt);
                } else if (r.observedAt < f.enableFloor) {
                    (verdict, reported, at) = (0, true, r.observedAt);
                } else if (_fresh(r) && _sane(r)) {
                    (verdict, reported, at) = (1, true, r.observedAt);
                }
            }
        }
        (bool known, uint64 syncedAt, uint256 power) = _voucherRecord(id);
        if (
            known && syncedAt >= floor
                && (!reported || syncedAt > at || (syncedAt == at && power == 0) || (verdict == 0 && power == 0))
        ) {
            verdict = power == 0 ? 2 : 1;
        }
    }

    /// @dev The feed is fixed at deploy and locked (SPEC §6), so a plain try/catch suffices here.
    function _report(uint256 id) internal view returns (RigReport memory r, bool ok) {
        try feed.latest(id) returns (RigReport memory got, bool okGot) {
            return (got, okGot);
        } catch {
            return (r, false);
        }
    }

    /// @dev `rigs(id)` through a gas-capped static call that copies at most 4 words. The voucher is
    ///      upgradeable by the TapeOut Safe, so a revert, a short answer or a `syncedAt` more than
    ///      `MAX_CLOCK_SKEW` ahead of now reads as "unknown" instead of reverting the caller (R3-00
    ///      known, R3-03). A longer answer is read from its first four words, as Solidity's own
    ///      decoder would.
    function _voucherRecord(uint256 id) internal view returns (bool known, uint64 syncedAt, uint256 power) {
        address v = address(voucher);
        bytes memory q = abi.encodeCall(IRigVoucher.rigs, (id));
        uint256 cap = VOUCHER_GAS;
        bool ok;
        uint256 s;
        uint256 p;
        assembly {
            let out := mload(0x40)
            ok := staticcall(cap, v, add(q, 0x20), mload(q), out, 0x80)
            ok := and(ok, gt(returndatasize(), 0x7f))
            s := mload(add(out, 0x20))
            p := mload(add(out, 0x60))
        }
        if (!ok || s > block.timestamp + MAX_CLOCK_SKEW) return (false, 0, 0);
        // forge-lint: disable-next-line(unsafe-typecast) s <= now + skew < uint64.max checked above
        return (true, uint64(s), p);
    }

    /// @dev `ownerOf(id) == this` through a gas-capped static call; false on any failure.
    function _owns(uint256 id) internal view returns (bool) {
        (bool known, address holder) = _ownerOf(id);
        return known && holder == address(this);
    }

    /// @dev `ownerOf(id)` through a gas-capped static call. Unknown on a revert, a short answer, a
    ///      non-canonical address or the zero address: ERC-721 `ownerOf` reverts for a missing token
    ///      and never returns zero, so a zero holder is a misreport (R3-02).
    function _ownerOf(uint256 id) internal view returns (bool known, address holder) {
        address v = address(voucher);
        bytes memory q = abi.encodeCall(IRigVoucher.ownerOf, (id));
        uint256 cap = OWNER_READ_GAS;
        uint256 word;
        assembly {
            known := staticcall(cap, v, add(q, 0x20), mload(q), 0, 0x20)
            known := and(known, gt(returndatasize(), 0x1f))
            word := mload(0)
        }
        known = known && word != 0 && word <= type(uint160).max;
        holder = address(uint160(word));
    }

    /// @dev R3-00 base(r), less `ok` and the feed flag: the report is about `id` and is not dated
    ///      more than `MAX_CLOCK_SKEW` ahead.
    function _base(RigReport memory r, uint256 id) internal view returns (bool) {
        return r.rigId == id && r.observedAt <= block.timestamp + MAX_CLOCK_SKEW;
    }

    /// @dev R3-00 fresh(r): at most `MAX_REPORT_AGE` old.
    function _fresh(RigReport memory r) internal view returns (bool) {
        return block.timestamp <= uint256(r.observedAt) + MAX_REPORT_AGE;
    }

    /// @dev R3-00 impaired(r): not active, stopped, not in custody, or no base power.
    function _impaired(RigReport memory r) internal pure returns (bool) {
        return r.status != ACTIVE || r.stopBlock != 0 || !r.custodied || r.verifWeight <= r.bonus;
    }

    function _sane(RigReport memory r) internal pure returns (bool) {
        return r.verifWeight != 0 && r.verifWeight <= r.totalVerifWeight && r.bonus <= r.verifWeight;
    }

    // ───────────────────────── internals: collateral set

    function _indexOf(uint256 id) internal view returns (bool found, uint256 i) {
        uint256 n = _collateral.length;
        for (; i < n; ++i) {
            if (_collateral[i] == id) return (true, i);
        }
        return (false, n);
    }

    /// @dev Insert `id` keeping the set strictly ascending. Returns false if it is already there.
    function _add(uint256 id) internal returns (bool) {
        uint256 n = _collateral.length;
        uint256 pos;
        while (pos < n && _collateral[pos] < id) ++pos;
        if (pos < n && _collateral[pos] == id) return false;
        if (n == MAX_COLLATERAL) revert CollateralFull();
        _collateral.push(id);
        for (uint256 j = n; j > pos; --j) {
            _collateral[j] = _collateral[j - 1];
        }
        _collateral[pos] = id;
        return true;
    }

    function _removeAt(uint256 i) internal {
        uint256 n = _collateral.length;
        for (uint256 j = i; j + 1 < n; ++j) {
            _collateral[j] = _collateral[j + 1];
        }
        _collateral.pop();
    }

    // ───────────────────────── internals: voucher transfers (SPEC §10.5)

    /// @dev Try to send every collateral voucher to the pool. Vouchers that do not arrive stay in
    ///      the set, in order, for `forwardVouchers`.
    function _moveCollateral(uint256[] memory ids, address to)
        internal
        returns (uint256[] memory moved, uint256[] memory stuck)
    {
        uint256 n = ids.length;
        moved = new uint256[](n);
        stuck = new uint256[](n);
        uint256 m;
        uint256 k;
        for (uint256 i; i < n; ++i) {
            uint8 result = _tryMove(ids[i], to);
            if (result == 0) stuck[k++] = ids[i];
            else if (result == 1) moved[m++] = ids[i];
        }
        for (uint256 i; i < k; ++i) {
            _collateral.push(stuck[i]);
        }
        assembly {
            mstore(moved, m)
            mstore(stuck, k)
        }
    }

    /// @dev 0 keeps the id for a retry, 1 moved it, 2 reconciles an already moved id. Toward the
    ///      pool (`seize`, `forwardVouchers`) an id is removed only when the pool holds it; an id read
    ///      as unknown, as the agent's after a try, or as anyone else's stays listed, so a seized
    ///      voucher never becomes withdrawable (R3-02). Toward the borrower (`release`) an id another
    ///      account holds is removed.
    function _tryMove(uint256 id, address to) internal returns (uint8) {
        _needGas();
        (bool known, address holder) = _ownerOf(id);
        if (!known) return 0;
        bool toPool = to == address(pool);
        if (holder != address(this)) {
            if (toPool && holder != to) return 0;
            emit CollateralRemoved(address(this), id);
            return 2;
        }
        address v = address(voucher);
        bytes memory q = abi.encodeCall(IRigVoucher.transferFrom, (address(this), to, id));
        uint256 cap = VOUCHER_GAS;
        _needGas();
        assembly { pop(call(cap, v, 0, add(q, 0x20), mload(q), 0, 0)) }
        _needGas();
        (known, holder) = _ownerOf(id);
        if (!known || holder == address(this)) return 0;
        if (holder == to) return 1;
        if (toPool) return 0;
        emit CollateralRemoved(address(this), id);
        return 2;
    }

    function _needGas() internal view {
        if (gasleft() < VOUCHER_GAS + VOUCHER_GAS / 63 + 10_000) revert InsufficientGas();
    }
}
