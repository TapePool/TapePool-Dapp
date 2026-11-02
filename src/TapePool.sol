// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICreditPolicy, Reasons} from "./interfaces/ICreditPolicy.sol";
import {ITapePool, IAgentFactory} from "./interfaces/ITapePool.sol";

/// @title TapePool
/// @notice ERC-4626 BEM lending pool (share tpBEM). Lends only to agents created by its factory,
///         books repayments (fee first into the loss reserve and lenders, then principal), marks
///         impaired loans doubtful and writes off seized ones (SPEC §11).
/// @dev The owner and the guardian can change parameters and pull brakes, but no function moves
///      pool BEM, reserve BEM or vouchers at their request (SPEC §12).
contract TapePool is ERC4626, Ownable2Step, ReentrancyGuard, ITapePool {
    using SafeERC20 for IERC20;

    // ───────────────────────── constants (SPEC §2, §11.3, §12)

    uint256 public constant TIMELOCK = 48 hours;
    uint256 public constant POLICY_TIMELOCK = 7 days;
    uint256 public constant QUEUE_GRACE = 7 days;
    /// @notice Hard upper bound of each operating fee, in wei of OKB.
    uint256 public constant MAX_OPS_FEE = 0.5 ether;
    uint256 public constant VEST = 7 days;
    /// @notice Seconds after `enableFeed` during which `lend` reverts: `MAX_CLOCK_SKEW + MAX_REPORT_AGE`
    ///         of `RigAgent` and `CreditPolicy`, so every report the policy accepts afterwards was
    ///         observed at or after `feedEnabledAt + MAX_CLOCK_SKEW` (R3-01).
    uint256 public constant FEED_SETTLE = 360;
    uint256 internal constant FLAG_LIFETIME = 96 hours;
    uint256 internal constant EVIDENCE_WINDOW = 24 hours;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant BEM_UNIT = 1e8;

    /// @notice Owner-settable parameters. Each has hard bounds in `bounds`.
    enum Param {
        SupplyCap,
        BorrowCapAbs,
        BorrowCapBps,
        PerBorrowerBps,
        FeeBps7d,
        FeeBps14d,
        MinFee,
        MinAdvance,
        LateFeeBpsPerDay,
        ReserveShareBps,
        ReserveCapBps,
        OpsFee7d,
        OpsFee14d,
        PerBorrowerAbs
    }

    struct Queued {
        uint256 value;
        uint64 eta;
    }

    /// @notice Pool figures for the app and the keeper (SPEC §13).
    struct Stats {
        uint256 idle;
        uint256 outstanding;
        uint256 doubtful;
        uint256 reserve;
        uint256 totalAssets;
        uint256 utilizationBps;
        uint256 supplyCap;
        uint256 borrowCapAbs;
        uint256 borrowCapBps;
        uint256 perBorrowerBps;
        bool borrowsPaused;
        bool feedDisabled;
        address pendingPolicy;
        uint64 pendingPolicyEta;
    }

    // ───────────────────────── wiring

    /// @notice The only source of agents this pool lends to.
    IAgentFactory public immutable factory;

    // ───────────────────────── credit policy and brakes

    ICreditPolicy public policy;
    ICreditPolicy public pendingPolicy;
    uint64 public pendingPolicyEta;

    address public guardian;
    bool public borrowsPaused;
    bool public feedDisabled;
    /// @notice Time of the last `enableFeed`, 0 until the first. A report observed before
    ///         `feedEnabledAt + MAX_CLOCK_SKEW` is never evidence, health or a shield (SPEC §6, R3-00).
    uint64 public feedEnabledAt;
    /// @notice The immutable seed-share holder, independent of later ownership transfers.
    address public immutable backstop;

    struct Frozen {
        uint64 from;
        uint64 to;
        uint256 before;
    }

    Frozen[] internal _frozen;

    // ───────────────────────── accounting (SPEC §11.1)

    /// @notice Loss reserve, held in the pool's BEM balance and excluded from `totalAssets`.
    uint256 public reserve;
    uint256 public tracked;
    uint256 public unvested;
    uint64 public vestUpdatedAt;
    uint64 public vestEnd;
    mapping(address agent => uint256) public absorbedOf;
    mapping(address agent => uint32) internal _reserveTerms;
    uint256 public outstandingPrincipal;
    /// @notice Remaining principal of every loan with an impairment mark.
    uint256 public doubtful;
    mapping(address borrower => uint256) public principalOf;
    mapping(address agent => uint256) public loanPrincipalOf;
    mapping(address agent => uint256) public doubtfulOf;

    // ───────────────────────── parameters (SPEC §11.3, §12)

    uint256 public supplyCap;
    uint256 public borrowCapAbs;
    uint256 public borrowCapBps;
    uint256 public perBorrowerBps;
    uint256 public perBorrowerAbs;
    uint256 public feeBps7d;
    uint256 public feeBps14d;
    uint256 public minFee;
    uint256 public minAdvance;
    uint256 public lateFeeBpsPerDay;
    uint256 public reserveShareBps;
    uint256 public reserveCapBps;
    /// @notice Operating fee in wei of OKB a borrower pays with `borrow`, per term (SPEC-PHASE3-OPSFEE §4).
    uint256 public opsFee7d;
    uint256 public opsFee14d;

    mapping(Param => Queued) public queued;

    // ───────────────────────── events (SPEC §13)

    event Lent(address indexed agent, address indexed borrower, uint256 amount);
    event RepaymentReceived(address indexed agent, uint256 fee, uint256 toReserve, uint256 principal);
    event WrittenOff(address indexed agent, uint256 amount, uint256 coveredByReserve);
    event LoanDoubtful(address indexed agent, uint256 amount);
    event LoanDoubtCleared(address indexed agent, uint256 amount);
    event BorrowsPaused(address indexed by);
    event BorrowsUnpaused(address indexed by);
    event FeedDisabled(address indexed by);
    event FeedEnabled(address indexed by, uint64 extensionEnd);
    event Synced(uint256 amount, uint256 unvested, uint64 vestEnd);
    event IncomeBooked(uint256 amount, uint256 unvested, uint64 vestEnd);
    event LossAbsorbed(address indexed agent, uint256 cut, uint256 unvested);
    event ToReserve(uint256 amount);
    event GuardianSet(address indexed oldGuardian, address indexed newGuardian);
    event ParamQueued(Param indexed key, uint256 value, uint64 eta);
    event ParamExecuted(Param indexed key, uint256 value, address indexed by);
    event ParamCancelled(Param indexed key);
    event ParamLapsed(Param indexed key);
    event PolicyQueued(address indexed policy, uint64 eta);
    event PolicyActivated(address indexed policy, address indexed by);
    event PolicyCancelled(address indexed policy);
    event PolicyLapsed(address indexed policy);

    // ───────────────────────── errors

    error FactoryMismatch();
    error AssetMismatch();
    error GuardianIsOwner();
    error NotAgent();
    error NotGuardianOrOwner();
    error RenounceDisabled();
    error BadTerm(uint8 term);
    error BorrowsArePaused();
    error FeedIsDisabled();
    error ExceedsBorrowCap();
    error ExceedsBorrowerCap();
    error ExceedsIdle();
    error ExceedsBackstop();
    error ZeroBackstop();
    error RepayExceedsPrincipal();
    error OutOfBounds(Param key, uint256 value);
    error NotACap(Param key);
    error UnknownParam();
    error NotLower(Param key, uint256 value);
    error NothingQueued();
    error TooEarly();
    error QueueLapsed();
    error BadPolicy();
    error SwapQueued();
    error FeedNotDisabled();
    error FeedSettling();

    // ───────────────────────── construction

    /// @param bem_ The BEM OFT on X Layer (8 decimals).
    /// @param factory_ The agent factory, deployed first with this pool's predicted address.
    /// @param policy_ The initial credit policy (exempt only from the version check).
    /// @param owner_ The owner: a dedicated, hand-signed wallet (PO-1).
    /// @param guardian_ The guardian: the keeper's hot key, brakes only (PO-1).
    /// @param backstop_ The seed-share holder; set to the owner at production deployment.
    constructor(
        IERC20 bem_,
        IAgentFactory factory_,
        ICreditPolicy policy_,
        address owner_,
        address guardian_,
        address backstop_
    ) ERC4626(bem_) ERC20("Tape Pool BEM", "tpBEM") Ownable(owner_) {
        if (factory_.pool() != address(this)) revert FactoryMismatch();
        if (factory_.bem() != address(bem_)) revert AssetMismatch();
        if (guardian_ == owner_) revert GuardianIsOwner(); // PO-1: separate keys
        if (backstop_ == address(0)) revert ZeroBackstop();
        backstop = backstop_;
        factory = factory_;
        _checkPolicy(policy_, false);
        policy = policy_;
        guardian = guardian_;
        emit GuardianSet(address(0), guardian_);

        // MVP launch values (SPEC §11.3, §12, §14)
        supplyCap = 20 * BEM_UNIT;
        borrowCapAbs = 8 * BEM_UNIT;
        perBorrowerAbs = 4 * BEM_UNIT;
        borrowsPaused = true;
        emit BorrowsPaused(msg.sender);
        borrowCapBps = 7_000;
        perBorrowerBps = 4_000;
        feeBps7d = 25;
        feeBps14d = 50;
        minFee = 100_000; // 0.001 BEM
        minAdvance = 1_000_000; // 0.01 BEM
        lateFeeBpsPerDay = 0;
        reserveShareBps = 2_000;
        reserveCapBps = 500;
        opsFee7d = 0;
        opsFee14d = 0;
    }

    // ───────────────────────── ERC-4626 (SPEC §11.1, §11.3)

    /// @notice Pool BEM not held as loss reserve. Lending and withdrawals draw only on this.
    function idle() public view returns (uint256) {
        return _sub(tracked, reserve);
    }

    /// @notice Lender-owned assets: idle BEM plus outstanding principal minus doubtful principal.
    function totalAssets() public view override returns (uint256) {
        return _sub(_sub(idle() + outstandingPrincipal, doubtful), unvestedNow());
    }

    /// @notice Remaining supply cap; 0 while any loan is doubtful.
    function maxDeposit(address) public view override returns (uint256) {
        if (doubtful != 0) return 0;
        uint256 ta = totalAssets();
        return supplyCap > ta ? supplyCap - ta : 0;
    }

    /// @notice Shares for the remaining supply cap; 0 while any loan is doubtful.
    function maxMint(address receiver) public view override returns (uint256) {
        return _convertToShares(maxDeposit(receiver), Math.Rounding.Floor);
    }

    /// @notice The OpenZeppelin value capped to idle BEM.
    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner_), idle());
    }

    /// @notice The OpenZeppelin value capped to the shares that idle BEM can pay.
    function maxRedeem(address owner_) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner_), _convertToShares(idle(), Math.Rounding.Floor));
    }

    /// @dev Decimals offset 6 bounds the first-depositor donation attack (F13).
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    // ───────────────────────── fee (SPEC §4.2, §4.3)

    /// @notice The flat fee for `principal` over `term`, the only place the fee is computed.
    /// @param term Term code (0 = 7 days, 1 = 14 days).
    /// @param principal Advance in raw BEM.
    /// @return The fee in raw BEM: the term rate rounded up, at least `minFee`.
    function fee(uint8 term, uint256 principal) public view returns (uint256) {
        uint256 bps;
        if (term == 0) bps = feeBps7d;
        else if (term == 1) bps = feeBps14d;
        else revert BadTerm(term);
        uint256 f = Math.mulDiv(principal, bps, BPS, Math.Rounding.Ceil);
        return f > minFee ? f : minFee;
    }

    /// @notice The operating fee in wei of OKB that `borrow` must carry for `term`
    ///         (SPEC-PHASE3-OPSFEE §4.1). It pays for the BSC report push and harvests the keeper sends in
    ///         BNB; it goes to the owner and is never refunded.
    /// @param term Term code (0 = 7 days, 1 = 14 days).
    function opsFee(uint8 term) external view returns (uint256) {
        if (term == 0) return opsFee7d;
        if (term == 1) return opsFee14d;
        revert BadTerm(term);
    }

    /// @notice The pool's owner, who also receives the operating fee.
    /// @dev Declared in `ITapePool` too, so agents can read it.
    function owner() public view override(Ownable, ITapePool) returns (address) {
        return super.owner();
    }

    // ───────────────────────── agent entry points

    /// @notice Lend `principal` to the calling agent's borrower. The single path by which pool BEM
    ///         reaches a borrower (invariant 12). Reverts `FeedSettling` for `FEED_SETTLE` seconds
    ///         after `enableFeed` (R3-01).
    /// @param principal Advance in raw BEM.
    function lend(uint256 principal) external nonReentrant checkpoint {
        address borrower = _agentBorrower();
        if (borrowsPaused) revert BorrowsArePaused();
        if (feedDisabled) revert FeedIsDisabled();
        if (_feedSettling()) revert FeedSettling();
        (uint256 limit, uint8 binding) = lendLimit(borrower);
        if (principal > limit) {
            if (binding == 1) revert ExceedsIdle();
            if (binding == 2) revert ExceedsBorrowCap();
            if (binding == 3) revert ExceedsBorrowerCap();
            revert ExceedsBackstop();
        }
        _reserveTerms[msg.sender] = uint32(reserveShareBps) | (uint32(reserveCapBps) << 16);

        outstandingPrincipal += principal;
        principalOf[borrower] += principal;
        loanPrincipalOf[msg.sender] += principal;

        tracked -= principal;
        IERC20(asset()).safeTransfer(borrower, principal);
        emit Lent(msg.sender, borrower, principal);
    }

    /// @notice Book a repayment from the calling agent and pull the BEM from it.
    /// @param feePart Late fee plus flat fee being paid.
    /// @param principalPart Principal being paid.
    function repay(uint256 feePart, uint256 principalPart) external nonReentrant checkpoint {
        address borrower = _agentBorrower();
        if (principalPart > loanPrincipalOf[msg.sender]) revert RepayExceedsPrincipal();

        // reserve share, capped against totalAssets measured before this payment is credited
        (uint16 shareBps, uint16 capBps) = loanReserveTerms(msg.sender);
        uint256 toReserve = feePart * shareBps / BPS;
        uint256 reserveCap = totalAssets() * capBps / BPS;
        uint256 room = reserveCap > reserve ? reserveCap - reserve : 0;
        if (toReserve > room) toReserve = room;

        reserve += toReserve;
        outstandingPrincipal -= principalPart;
        principalOf[borrower] -= principalPart;
        loanPrincipalOf[msg.sender] -= principalPart;
        uint256 d = doubtfulOf[msg.sender];
        if (d != 0) {
            uint256 cut = principalPart < d ? principalPart : d;
            doubtfulOf[msg.sender] = d - cut;
            doubtful -= cut;
            _restore(msg.sender, cut);
        }
        if (loanPrincipalOf[msg.sender] == 0) delete _reserveTerms[msg.sender];

        IERC20(asset()).safeTransferFrom(msg.sender, address(this), feePart + principalPart);
        tracked += feePart + principalPart;
        _book(feePart - toReserve);
        emit RepaymentReceived(msg.sender, feePart, toReserve, principalPart);
    }

    /// @notice Mark the calling agent's remaining principal doubtful (at an impairment flag).
    function markDoubtful() external nonReentrant checkpoint {
        _agentBorrower();
        uint256 amount = loanPrincipalOf[msg.sender];
        uint256 old = doubtfulOf[msg.sender];
        doubtful = doubtful - old + amount;
        doubtfulOf[msg.sender] = amount;
        if (amount > old) _absorb(msg.sender, amount - old);
        else _restore(msg.sender, old - amount);
        emit LoanDoubtful(msg.sender, amount);
    }

    /// @notice Clear the calling agent's doubtful mark (health evidence after an expired flag).
    function clearDoubtful() external nonReentrant checkpoint {
        _agentBorrower();
        uint256 amount = doubtfulOf[msg.sender];
        doubtful -= amount;
        doubtfulOf[msg.sender] = 0;
        _restore(msg.sender, amount);
        emit LoanDoubtCleared(msg.sender, amount);
    }

    /// @notice Write off the calling agent's remaining principal at a seize. The reserve covers
    ///         what it can; lenders bear the rest.
    /// @return amount The principal written off, taken from the pool's own record.
    function writeOff() external nonReentrant checkpoint returns (uint256 amount) {
        address borrower = _agentBorrower();
        amount = loanPrincipalOf[msg.sender];
        loanPrincipalOf[msg.sender] = 0;
        outstandingPrincipal -= amount;
        principalOf[borrower] -= amount;
        doubtful -= doubtfulOf[msg.sender];
        doubtfulOf[msg.sender] = 0;
        uint256 cover = amount < reserve ? amount : reserve;
        reserve -= cover;
        delete absorbedOf[msg.sender];
        delete _reserveTerms[msg.sender];
        emit WrittenOff(msg.sender, amount, cover);
    }

    // ───────────────────────── views

    /// @notice Largest principal `lend` would accept for `borrower` right now (0 while paused).
    /// @param borrower The borrower address (caps are summed across its agents).
    function maxLend(address borrower) external view returns (uint256 amount) {
        (amount,) = lendLimit(borrower);
    }

    /// @notice Current admission limit and its binding constraint; lower codes win ties. Binding 5
    ///         (amount 0) while borrows are paused, the feed is disabled, or the feed is settling.
    function lendLimit(address borrower) public view returns (uint256 amount, uint8 binding) {
        if (borrowsPaused || feedDisabled || _feedSettling()) return (0, 5);
        uint256 ta = totalAssets();
        amount = idle();
        binding = 1;
        uint256 room = _sub(_borrowCap(ta), outstandingPrincipal);
        if (room < amount) {
            amount = room;
            binding = 2;
        }
        room = _sub(Math.min(perBorrowerAbs, ta * perBorrowerBps / BPS), principalOf[borrower]);
        if (room < amount) {
            amount = room;
            binding = 3;
        }
        room = _sub(convertToAssets(balanceOf(backstop)), outstandingPrincipal);
        if (room < amount) {
            amount = room;
            binding = 4;
        }
    }

    /// @notice Reserve share and cap stored when this agent's current loan began.
    function loanReserveTerms(address agent) public view returns (uint16 shareBps, uint16 capBps) {
        uint32 terms = _reserveTerms[agent];
        return (uint16(terms), uint16(terms >> 16));
    }

    /// @notice True while a policy swap is queued and has not lapsed.
    function policySwapQueued() public view returns (bool) {
        return address(pendingPolicy) != address(0) && block.timestamp <= pendingPolicyEta + QUEUE_GRACE;
    }

    /// @notice Pool figures in one call.
    function stats() external view returns (Stats memory s) {
        s.idle = idle();
        s.outstanding = outstandingPrincipal;
        s.doubtful = doubtful;
        s.reserve = reserve;
        s.totalAssets = totalAssets();
        uint256 gross = s.idle + s.outstanding;
        s.utilizationBps = gross == 0 ? 0 : s.outstanding * BPS / gross;
        s.supplyCap = supplyCap;
        s.borrowCapAbs = borrowCapAbs;
        s.borrowCapBps = borrowCapBps;
        s.perBorrowerBps = perBorrowerBps;
        s.borrowsPaused = borrowsPaused;
        s.feedDisabled = feedDisabled;
        if (policySwapQueued()) {
            s.pendingPolicy = address(pendingPolicy);
            s.pendingPolicyEta = pendingPolicyEta;
        }
    }

    /// @notice Current value of `key`.
    function param(Param key) public view returns (uint256) {
        if (key == Param.SupplyCap) return supplyCap;
        if (key == Param.BorrowCapAbs) return borrowCapAbs;
        if (key == Param.BorrowCapBps) return borrowCapBps;
        if (key == Param.PerBorrowerBps) return perBorrowerBps;
        if (key == Param.PerBorrowerAbs) return perBorrowerAbs;
        if (key == Param.FeeBps7d) return feeBps7d;
        if (key == Param.FeeBps14d) return feeBps14d;
        if (key == Param.MinFee) return minFee;
        if (key == Param.MinAdvance) return minAdvance;
        if (key == Param.LateFeeBpsPerDay) return lateFeeBpsPerDay;
        if (key == Param.ReserveShareBps) return reserveShareBps;
        if (key == Param.ReserveCapBps) return reserveCapBps;
        if (key == Param.OpsFee7d) return opsFee7d;
        if (key == Param.OpsFee14d) return opsFee14d;
        revert UnknownParam();
    }

    /// @notice Hard bounds for `key`, checked when a change is queued and again when it executes.
    function bounds(Param key) public pure returns (uint256 lo, uint256 hi) {
        if (key == Param.SupplyCap) return (0, 1_000 * BEM_UNIT);
        if (key == Param.BorrowCapAbs || key == Param.PerBorrowerAbs) return (0, 500 * BEM_UNIT);
        if (key == Param.BorrowCapBps) return (0, 9_000);
        if (key == Param.PerBorrowerBps) return (0, 5_000);
        if (key == Param.FeeBps7d) return (25, 300);
        if (key == Param.FeeBps14d) return (50, 600);
        if (key == Param.MinFee) return (100_000, 10_000_000); // 0.001 - 0.1 BEM
        if (key == Param.MinAdvance) return (100_000, 100_000_000); // 0.001 - 1 BEM
        if (key == Param.LateFeeBpsPerDay) return (0, 30);
        if (key == Param.ReserveShareBps) return (0, 5_000);
        if (key == Param.ReserveCapBps) return (0, 2_000);
        if (key == Param.OpsFee7d || key == Param.OpsFee14d) return (0, MAX_OPS_FEE);
        revert UnknownParam();
    }

    // ───────────────────────── brakes (SPEC §12)

    /// @notice Deny new borrows. Guardian or owner, instant.
    function pauseBorrows() external nonReentrant checkpoint {
        _onlyGuardianOrOwner();
        _pause();
    }

    /// @notice Restore borrowing under the current policy. Owner only; reverts while a swap is queued.
    function unpauseBorrows() external onlyOwner nonReentrant checkpoint {
        _lapsePolicyIfStale();
        if (address(pendingPolicy) != address(0)) revert SwapQueued();
        if (borrowsPaused) {
            borrowsPaused = false;
            emit BorrowsUnpaused(msg.sender);
        }
    }

    /// @notice Stop trusting feed reports: borrows stop and report evidence is ignored. Guardian or owner.
    function disableFeed() external nonReentrant checkpoint {
        _onlyGuardianOrOwner();
        if (!feedDisabled) {
            uint64 now_ = uint64(block.timestamp);
            uint256 n = _frozen.length;
            if (n != 0 && _frozen[n - 1].to >= now_) {
                _frozen[n - 1].to = type(uint64).max;
            } else {
                uint256 before_ = n == 0 ? 0 : _frozen[n - 1].before + _frozen[n - 1].to - _frozen[n - 1].from;
                _frozen.push(Frozen(now_, type(uint64).max, before_));
            }
            feedDisabled = true;
            emit FeedDisabled(msg.sender);
        }
    }

    /// @notice Trust feed reports again. Owner only. Every earlier flag gets at least
    ///         `EVIDENCE_WINDOW` of seize time from now (SPEC §10.5). Records `feedEnabledAt`: reports
    ///         observed before it plus clock skew stay unusable, and `lend` waits `FEED_SETTLE` (R3-01).
    function enableFeed() external onlyOwner nonReentrant checkpoint {
        if (!feedDisabled) revert FeedNotDisabled();
        feedDisabled = false;
        feedEnabledAt = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + EVIDENCE_WINDOW);
        _frozen[_frozen.length - 1].to = end;
        emit FeedEnabled(msg.sender, end);
    }

    /// @notice Replace the guardian key at once (the answer to a leaked guardian key).
    /// @param newGuardian The new guardian address.
    function setGuardian(address newGuardian) external onlyOwner nonReentrant checkpoint {
        if (newGuardian != address(0) && (newGuardian == owner() || newGuardian == pendingOwner())) {
            revert GuardianIsOwner();
        }
        emit GuardianSet(guardian, newGuardian);
        guardian = newGuardian;
    }

    /// @notice Disabled: renouncing would freeze every restore lever forever.
    function renounceOwnership() public override nonReentrant checkpoint {
        revert RenounceDisabled();
    }

    // ───────────────────────── parameters (SPEC §12)

    /// @notice Lower a cap at once. Tightening needs no delay.
    /// @param key One of the five caps.
    /// @param value The new, lower or equal value.
    function lowerCap(Param key, uint256 value) external onlyOwner nonReentrant checkpoint {
        if (
            key != Param.SupplyCap && key != Param.BorrowCapAbs && key != Param.BorrowCapBps
                && key != Param.PerBorrowerBps && key != Param.PerBorrowerAbs
        ) revert NotACap(key);
        if (value > param(key)) revert NotLower(key, value);
        if (queued[key].eta != 0 && queued[key].value > value) {
            delete queued[key];
            emit ParamCancelled(key);
        }
        _write(key, value);
        emit ParamExecuted(key, value, msg.sender);
    }

    /// @notice Queue a parameter change for `TIMELOCK`. Overwrites any change already queued for `key`.
    /// @param key The parameter.
    /// @param value The new value, within `bounds(key)`.
    function queueParam(Param key, uint256 value) external onlyOwner nonReentrant checkpoint {
        _checkBounds(key, value);
        Queued storage q = queued[key];
        if (q.eta != 0) {
            if (block.timestamp > q.eta + QUEUE_GRACE) emit ParamLapsed(key);
            else emit ParamCancelled(key);
        }
        // forge-lint: disable-next-line(unsafe-typecast) timestamps fit uint64
        uint64 eta = uint64(block.timestamp + TIMELOCK);
        q.value = value;
        q.eta = eta;
        emit ParamQueued(key, value, eta);
    }

    /// @notice Apply the queued value of `key`. Anyone, inside `[eta, eta + QUEUE_GRACE]`.
    /// @param key The parameter.
    function executeParam(Param key) external nonReentrant checkpoint {
        Queued memory q = queued[key];
        if (q.eta == 0) revert NothingQueued();
        if (block.timestamp < q.eta) revert TooEarly();
        if (block.timestamp > q.eta + QUEUE_GRACE) revert QueueLapsed();
        _checkBounds(key, q.value);
        delete queued[key];
        _write(key, q.value);
        emit ParamExecuted(key, q.value, msg.sender);
    }

    /// @notice Drop the change queued for `key`. Owner only.
    /// @param key The parameter.
    function cancelParam(Param key) external onlyOwner nonReentrant checkpoint {
        if (queued[key].eta == 0) revert NothingQueued();
        delete queued[key];
        emit ParamCancelled(key);
    }

    // ───────────────────────── policy swap (SPEC §9.2)

    /// @notice Queue a new credit policy for `POLICY_TIMELOCK` and pause borrows at once.
    /// @param newPolicy The replacement policy; must pass the sanity checks.
    function queuePolicy(ICreditPolicy newPolicy) external onlyOwner nonReentrant checkpoint {
        _checkPolicy(newPolicy, true);
        address old = address(pendingPolicy);
        if (old != address(0)) {
            if (policySwapQueued()) emit PolicyCancelled(old);
            else emit PolicyLapsed(old);
        }
        // forge-lint: disable-next-line(unsafe-typecast) timestamps fit uint64
        uint64 eta = uint64(block.timestamp + POLICY_TIMELOCK);
        pendingPolicy = newPolicy;
        pendingPolicyEta = eta;
        emit PolicyQueued(address(newPolicy), eta);
        _pause();
    }

    /// @notice Install the queued policy. Anyone, inside `[eta, eta + QUEUE_GRACE]`. Borrows stay
    ///         paused until the owner unpauses.
    function activatePolicy() external nonReentrant checkpoint {
        ICreditPolicy p = pendingPolicy;
        if (address(p) == address(0)) revert NothingQueued();
        if (block.timestamp < pendingPolicyEta) revert TooEarly();
        if (block.timestamp > pendingPolicyEta + QUEUE_GRACE) revert QueueLapsed();
        _checkPolicy(p, true);
        policy = p;
        pendingPolicy = ICreditPolicy(address(0));
        pendingPolicyEta = 0;
        emit PolicyActivated(address(p), msg.sender);
    }

    /// @notice Drop the queued policy. Owner only. Borrows stay paused until the owner unpauses.
    function cancelPolicy() external onlyOwner nonReentrant checkpoint {
        address p = address(pendingPolicy);
        if (p == address(0)) revert NothingQueued();
        pendingPolicy = ICreditPolicy(address(0));
        pendingPolicyEta = 0;
        emit PolicyCancelled(p);
    }

    // ───────────────────────── internals

    /// @notice Transfer ownership while keeping the guardian a separate key.
    function transferOwnership(address newOwner) public override onlyOwner nonReentrant checkpoint {
        if (newOwner != address(0) && newOwner == guardian) revert GuardianIsOwner();
        super.transferOwnership(newOwner);
    }

    /// @notice Accept a pending ownership transfer.
    function acceptOwnership() public override nonReentrant checkpoint {
        super.acceptOwnership();
    }

    /// @notice Transfer shares after booking newly received income.
    function transfer(address to, uint256 value) public override(ERC20, IERC20) nonReentrant checkpoint returns (bool) {
        return super.transfer(to, value);
    }

    /// @notice Approve a share allowance after booking income.
    function approve(address spender, uint256 value)
        public
        override(ERC20, IERC20)
        nonReentrant
        checkpoint
        returns (bool)
    {
        return super.approve(spender, value);
    }

    /// @notice Transfer shares using an allowance after booking income.
    function transferFrom(address from, address to, uint256 value)
        public
        override(ERC20, IERC20)
        nonReentrant
        checkpoint
        returns (bool)
    {
        return super.transferFrom(from, to, value);
    }

    /// @notice Deposit BEM at the price of released income only.
    function deposit(uint256 assets, address receiver) public override nonReentrant checkpoint returns (uint256) {
        return super.deposit(assets, receiver);
    }

    /// @notice Mint shares at the price of released income only.
    function mint(uint256 shares, address receiver) public override nonReentrant checkpoint returns (uint256) {
        return super.mint(shares, receiver);
    }

    /// @notice Withdraw booked idle BEM.
    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        nonReentrant
        checkpoint
        returns (uint256)
    {
        return super.withdraw(assets, receiver, owner_);
    }

    /// @notice Redeem shares for booked idle BEM.
    function redeem(uint256 shares, address receiver, address owner_)
        public
        override
        nonReentrant
        checkpoint
        returns (uint256)
    {
        return super.redeem(shares, receiver, owner_);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        IERC20(asset()).safeTransferFrom(caller, address(this), assets);
        tracked += assets;
        _mint(receiver, shares);
        emit Deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        tracked -= assets;
        super._withdraw(caller, receiver, owner_, assets, shares);
    }

    modifier checkpoint() {
        _sync();
        _;
    }

    /// @notice Book newly arrived BEM as income, without releasing it in this block.
    function sync() external nonReentrant checkpoint {}

    /// @notice Income still excluded from lender assets at the current second.
    function unvestedNow() public view returns (uint256) {
        if (unvested == 0 || block.timestamp >= vestEnd) return 0;
        return Math.mulDiv(unvested, vestEnd - block.timestamp, vestEnd - vestUpdatedAt);
    }

    function _sync() internal {
        uint256 amount = _sub(IERC20(asset()).balanceOf(address(this)), tracked);
        if (amount == 0) return;
        tracked += amount;
        _book(amount);
        emit Synced(amount, unvestedNow(), vestEnd);
    }

    function _book(uint256 amount) internal {
        if (amount == 0) return;
        if (totalSupply() == 0) {
            reserve += amount;
            emit ToReserve(amount);
            return;
        }
        uint256 u = unvestedNow();
        uint256 duration = u == 0 ? VEST : (u * (vestEnd - block.timestamp) + amount * VEST) / (u + amount);
        vestEnd = uint64(block.timestamp + duration);
        vestUpdatedAt = uint64(block.timestamp);
        unvested = u + amount;
        emit IncomeBooked(amount, unvested, vestEnd);
    }

    function _absorb(address agent, uint256 amount) internal {
        uint256 u = unvestedNow();
        uint256 cut = Math.min(u, amount);
        unvested = u - cut;
        vestUpdatedAt = uint64(block.timestamp);
        absorbedOf[agent] += cut;
        emit LossAbsorbed(agent, cut, unvested);
    }

    function _restore(address agent, uint256 back) internal {
        uint256 r = Math.min(absorbedOf[agent], back);
        absorbedOf[agent] -= r;
        _book(r);
    }

    /// @notice Number of union intervals in the feed-brake history.
    function frozenCount() external view returns (uint256) {
        return _frozen.length;
    }

    /// @notice Interval endpoints; an open interval ends at uint64.max.
    function frozenAt(uint256 i) external view returns (uint64 from, uint64 to) {
        Frozen storage f = _frozen[i];
        return (f.from, f.to);
    }

    /// @notice Total frozen wall seconds up to now. This clock never decreases.
    function frozenClock() external view returns (uint256) {
        return _frozenUntil(uint64(block.timestamp));
    }

    /// @notice Frozen seconds in [a,b), saturating at zero for reversed endpoints.
    function frozenBetween(uint64 a, uint64 b) public view returns (uint256) {
        return b > a ? _frozenUntil(b) - _frozenUntil(a) : 0;
    }

    function _frozenUntil(uint64 t) internal view returns (uint256) {
        uint256 lo;
        uint256 hi = _frozen.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_frozen[mid].from <= t) lo = mid + 1;
            else hi = mid;
        }
        if (lo == 0) return 0;
        Frozen storage f = _frozen[lo - 1];
        return f.before + Math.min(t, f.to) - f.from;
    }

    /// @notice First expired wall second for a flag, found in logarithmic reads of brake history.
    function expiryOf(uint64 impairedAt) public view returns (uint64) {
        uint256 target = uint256(impairedAt) - _frozenUntil(impairedAt) + FLAG_LIFETIME + 1;
        uint256 lo;
        uint256 hi = _frozen.length;
        // A brake at the expiry second cannot revive an already expired flag.
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            Frozen storage f = _frozen[mid];
            if (uint256(f.from) - f.before < target) lo = mid + 1;
            else hi = mid;
        }
        if (lo != 0) {
            Frozen storage f = _frozen[lo - 1];
            if (f.to == type(uint64).max) return type(uint64).max;
            target += f.before + f.to - f.from;
        }
        return uint64(Math.min(target, type(uint64).max));
    }

    function _sub(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    function _agentBorrower() internal view returns (address borrower) {
        borrower = factory.borrowerOf(msg.sender);
        if (borrower == address(0)) revert NotAgent();
    }

    function _onlyGuardianOrOwner() internal view {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardianOrOwner();
    }

    /// @dev True for `FEED_SETTLE` seconds after the last `enableFeed` (R3-01).
    function _feedSettling() internal view returns (bool) {
        return block.timestamp < uint256(feedEnabledAt) + FEED_SETTLE;
    }

    function _pause() internal {
        if (!borrowsPaused) {
            borrowsPaused = true;
            emit BorrowsPaused(msg.sender);
        }
    }

    function _borrowCap(uint256 ta) internal view returns (uint256) {
        return Math.min(borrowCapAbs, ta * borrowCapBps / BPS);
    }

    function _lapsePolicyIfStale() internal {
        address p = address(pendingPolicy);
        if (p != address(0) && !policySwapQueued()) {
            pendingPolicy = ICreditPolicy(address(0));
            pendingPolicyEta = 0;
            emit PolicyLapsed(p);
        }
    }

    /// @dev Code exists, the version rises (unless `checkVersion` is false), and an empty id list
    ///      returns `(false, BAD_IDS)` without reverting.
    function _checkPolicy(ICreditPolicy p, bool checkVersion) internal view {
        if (address(p).code.length == 0) revert BadPolicy();
        if (checkVersion && p.version() <= policy.version()) revert BadPolicy();
        try p.check(address(0), new uint256[](0), 0, 0) returns (bool allow, uint8 reason, uint16, uint256) {
            if (allow || reason != Reasons.BAD_IDS) revert BadPolicy();
        } catch {
            revert BadPolicy();
        }
    }

    function _checkBounds(Param key, uint256 value) internal pure {
        (uint256 lo, uint256 hi) = bounds(key);
        if (value < lo || value > hi) revert OutOfBounds(key, value);
    }

    function _write(Param key, uint256 value) internal {
        if (key == Param.SupplyCap) supplyCap = value;
        else if (key == Param.BorrowCapAbs) borrowCapAbs = value;
        else if (key == Param.BorrowCapBps) borrowCapBps = value;
        else if (key == Param.PerBorrowerBps) perBorrowerBps = value;
        else if (key == Param.PerBorrowerAbs) perBorrowerAbs = value;
        else if (key == Param.FeeBps7d) feeBps7d = value;
        else if (key == Param.FeeBps14d) feeBps14d = value;
        else if (key == Param.MinFee) minFee = value;
        else if (key == Param.MinAdvance) minAdvance = value;
        else if (key == Param.LateFeeBpsPerDay) lateFeeBpsPerDay = value;
        else if (key == Param.ReserveShareBps) reserveShareBps = value;
        else if (key == Param.ReserveCapBps) reserveCapBps = value;
        else if (key == Param.OpsFee7d) opsFee7d = value;
        else if (key == Param.OpsFee14d) opsFee14d = value;
        else revert UnknownParam();
    }
}
