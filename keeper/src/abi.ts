// Minimal ABIs of the contracts the keeper reads and calls.
import { parseAbi } from "viem";

/**
 * Custom errors of our contracts (RigAgent, TapePool, RigScreen, the feed). Merged into every ABI the
 * keeper sends with, so a simulation revert decodes to its error name and the expected ones
 * (NoEvidence, NoDebt, …) stay silent while unexpected ones alert.
 */
export const contractErrors = parseAbi([
  "error CustodyUnreadable(uint256 rigId)",
  "error ExceedsBackstop()",
  "error FeeAboveBound(uint256 fee, uint16 lateBps)",
  "error AgentClosed()",
  "error BadBatch()",
  "error BorrowsArePaused()",
  "error CureWindow()",
  "error FeedIsDisabled()",
  "error FeedNotDisabled()",
  "error FeedSettling()",
  "error FlagExpired()",
  "error FlagLive()",
  "error FlagNotExpired()",
  "error InsufficientGas()",
  "error LoanOpen()",
  "error NoCollateral()",
  "error NoDebt()",
  "error NoEvidence()",
  "error NoFlag()",
  "error NoHealthEvidence()",
  "error NoLoan()",
  "error NotAgent()",
  "error NotBorrower()",
  "error NotClosed()",
  "error NotCollateral(uint256 id)",
  "error NotGuardianOrOwner()",
  "error NotOwner()",
  "error PolicyDenied(uint8 reason)",
  "error SeizedVoucher(uint256 id)",
  "error ZeroAddress()",
  "error WrongEid(uint32 eid)",
  "error WrongOpsFee(uint256 expected)",
  "error OpsFeeTransferFailed()",
]);

export const poolAbi = [...contractErrors, ...parseAbi([
  "function tracked() view returns (uint256)",
  "function sync()",
  "function unvestedNow() view returns (uint256)",
  "function vestEnd() view returns (uint64)",
  "function frozenClock() view returns (uint256)",
  "function frozenBetween(uint64 a, uint64 b) view returns (uint256)",
  "function expiryOf(uint64 impairedAt) view returns (uint64)",
  "function frozenCount() view returns (uint256)",
  "function frozenAt(uint256 i) view returns (uint64 from, uint64 to)",
  "function perBorrowerAbs() view returns (uint256)",
  "function backstop() view returns (address)",
  "function absorbedOf(address agent) view returns (uint256)",
  "function loanReserveTerms(address agent) view returns (uint16 shareBps, uint16 capBps)",
  "function lendLimit(address borrower) view returns (uint256 amount, uint8 binding)",
  "function maxLend(address borrower) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function fee(uint8 term, uint256 principal) view returns (uint256)",
  "function bounds(uint8 key) pure returns (uint256 lo, uint256 hi)",
  "function param(uint8 key) view returns (uint256)",
  "function opsFee(uint8 term) view returns (uint256)",
  "function borrowsPaused() view returns (bool)",
  "function feedDisabled() view returns (bool)",
  "function feedEnabledAt() view returns (uint64)",
  "function FEED_SETTLE() view returns (uint256)",
  "function pauseBorrows()",
  "function disableFeed()",
  "function guardian() view returns (address)",
  "function owner() view returns (address)",
  "function idle() view returns (uint256)",
  "function outstandingPrincipal() view returns (uint256)",
  "function doubtful() view returns (uint256)",
  "function reserve() view returns (uint256)",
  "event Lent(address indexed agent, address indexed borrower, uint256 amount)",
  "event BorrowsUnpaused(address indexed by)",
  "event BorrowsPaused(address indexed by)",
  "event FeedDisabled(address indexed by)",
  "event FeedEnabled(address indexed by, uint64 extensionEnd)",
  "event Synced(uint256 amount, uint256 unvested, uint64 vestEnd)",
  "event IncomeBooked(uint256 amount, uint256 unvested, uint64 vestEnd)",
  "event LossAbsorbed(address indexed agent, uint256 cut, uint256 unvested)",
  "event ToReserve(uint256 amount)",
  "event GuardianSet(address indexed oldGuardian, address indexed newGuardian)",
  "event ParamQueued(uint8 indexed key, uint256 value, uint64 eta)",
  "event PolicyQueued(address indexed policy, uint64 eta)",
  "event PolicyActivated(address indexed policy, address indexed by)",
  "event PolicyCancelled(address indexed policy)",
  "event ParamExecuted(uint8 indexed key, uint256 value, address indexed by)",
  "event ParamCancelled(uint8 indexed key)",
  "event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
])] as const;

export const factoryAbi = parseAbi([
  "event AgentCreated(address indexed agent, address indexed borrower, uint256 index)",
  "function isAgent(address agent) view returns (bool)",
  "function borrowerOf(address agent) view returns (address)",
]);

export const agentAbi = [...contractErrors, ...parseAbi([
  "struct LoanView { bool open; uint64 start; uint64 maturity; uint8 term; uint256 principal; uint256 principal0; uint256 feeLeft; uint16 lateBpsPerDay; uint64 lateAccruedTo; uint256 lateFeeDue; uint256 debt; uint64 impairedAt; uint256 impairedRig; bool doubtful; uint64 seizeStart; uint64 deadline; bool expired; }",
  "function loanOf() view returns (LoanView)",
  "function flagEvidenceFrom() view returns (uint64)",
  "function seizeEvidenceFrom() view returns (uint64)",
  "function wasSeized(uint256 id) view returns (bool)",
  "function borrow(uint8 term, uint256 principal, uint256 maxFee, uint16 maxLateBps) payable",
  "function forget(uint256 id)",
  "function OWNER_READ_GAS() view returns (uint256)",
  "event ImpairmentFlagged(address indexed agent, uint256 indexed rigId, uint8 evidenceKind, uint64 impairedAt)",
  "event Released(address indexed agent, uint256[] ids)",
  "event LoanClosed(address indexed agent)",
  "function collateralOf() view returns (uint256[])",
  "function closed() view returns (bool)",
  "function sweep()",
  "function claimLate()",
  "function flagImpaired(uint256 rigId)",
  "function clearExpiredFlag()",
  "function seize()",
  "function forwardVouchers()",
])] as const;

export const screenAbi = [...contractErrors, ...parseAbi([
  "struct Pass { address circuits; uint64 circuitId; uint32 taskId; uint64 effectiveAt; bytes32 artifactHash; }",
  "function suspendPass(uint256 rigId)",
  "function passOf(uint256 rigId) view returns (Pass pass, bool isSuspended)",
  "function isEffective(uint256 rigId, address circuits, uint64 circuitId, uint32 taskId) view returns (bool)",
  "event ScreenPassAdded(uint256 indexed rigId, address circuits, uint64 circuitId, uint32 taskId, bytes32 artifactHash, uint64 effectiveAt)",
  "event PassSuspensionLifted(uint256 indexed rigId)",
  "event PassSuspended(uint256 indexed rigId, address indexed by)",
  "event ScreenPassRevoked(uint256 indexed rigId)",
])] as const;

export const receiverAbi = parseAbi([
  "struct RigReport { uint64 rigId; uint64 circuitId; uint64 since; uint64 stopBlock; address circuits; uint64 observedAt; uint8 status; bool custodied; uint64 verifWeight; uint64 bonus; uint64 totalVerifWeight; uint64 bscBlock; uint128 pending; uint32 taskId; }",
  "function latest(uint256 rigId) view returns (RigReport report, bool ok)",
]);

export const reporterAbi = [...contractErrors, ...parseAbi([
  "event Pushed(bytes32 indexed guid, uint256 rigs, uint256 fee)",
  "function quote(uint256[] rigIds) view returns (uint256)",
  "function push(uint256[] rigIds) payable returns (bytes32)",
])] as const;

export const lensAbi = parseAbi([
  "function quoteFor(address agent, uint8 term, uint256 principal) view returns (uint256 fee, uint16 lateBps, uint256 debt, bool allowed, uint8 reason, uint8 binding)",
]);

export const voucherAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function ownerOf(uint256 id) view returns (address)",
  "function rigs(uint256 id) view returns (address circuits, uint64 syncedAt, uint256 circuitId, uint256 power)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/** The BEM OFT adapter on BSC: the bridge fee in basis points (part E §3.1). */
export const oftFeeAbi = parseAbi(["function feeBps() view returns (uint16)"]);

export const vaultAbi = parseAbi([
  "function rigs(uint256 id) view returns (address circuits, uint256 circuitId)",
  "function cellOf(bytes32 key) view returns (address)",
  "function quoteHarvest(uint256 n) view returns (uint256)",
  "function harvest(uint256[] ids) payable returns (uint256)",
]);

export const podAbi = parseAbi([
  "struct Miner { address circuits; uint64 circuitId; uint32 taskId; uint32 gateCount; uint32 stateCount; uint32 depth; uint64 area; uint32 mult; uint64 since; uint8 status; address registrant; uint32 nandBurn; uint32 latchBurn; uint64 bstar; uint64 bonus; bool optimal; uint64 commitBlock; uint64 firstUnusedId; uint64 stopBlock; uint128 verifWeight; uint128 unverWeight; uint256 debt; }",
  "function minerKey(address circuits, uint256 circuitId) pure returns (bytes32)",
  "function getMiner(bytes32 key) view returns (Miner)",
  "function pending(bytes32 key) view returns (uint256)",
]);

export const beaconAbi = parseAbi(["function implementation() view returns (address)"]);

/**
 * Read-only data for the app routes (SPEC-PHASE5-APP §8). Kept apart from `poolAbi` on purpose: the
 * admin watch calls `getContractEvents` on the pool with no event name, which filters on every event in
 * that ABI, so adding these there would change its RPC filter.
 */
export const shareAbi = parseAbi(["function convertToAssets(uint256 shares) view returns (uint256)"]);

/** The ERC-4626 and ERC-20 events of the pool (tpBEM is the pool contract itself). */
export const ledgerEvents = parseAbi([
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
