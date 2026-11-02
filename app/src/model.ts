/**
 * The view model: everything the pages show, as plain data.
 *
 * Rules for every source (fixtures now, chain reads in B2):
 * - amounts are `bigint` in raw units (BEM 8 places, tpBEM 14, OKB and BNB 18);
 * - timestamps are unix seconds on the X Layer clock;
 * - `null` means "unknown, show a dash", never a made-up zero;
 * - nothing here is computed from the browser clock.
 */

import type { AppError } from './chain/errors';

export type Address = `0x${string}`;
export type Hex = `0x${string}`;
export type Sec = number;
export type TermIndex = 0 | 1;
export type Processor = 'TapeOut' | 'Behemoth' | 'RefBench';

/** Parts of the snapshot that are read separately. A stale section shows its old value and turns its actions off. */
export type Section = 'pool' | 'wallet' | 'rigs' | 'loans' | 'keeper';

/* ───────── pool ───────── */

export interface PoolParams {
  feeBps: readonly [number, number]; // feeBps7d, feeBps14d
  maxDebtBps: readonly [number, number]; // CreditMath constants: debt cap as a share of expected output
  termDays: readonly [number, number];
  minFee: bigint;
  minAdvance: bigint;
  lateFeeBpsPerDay: number;
  perBorrowerBps: number;
  borrowCapBps: number;
  borrowCapAbs: bigint;
  perBorrowerAbs?: bigint;
  supplyCap: bigint;
  opsFee: readonly [bigint, bigint]; // wei of OKB per borrow, by term
}

export type ParamKey = 'feeBps7d' | 'feeBps14d' | 'minFee' | 'minAdvance' | 'lateFee' | 'opsFee7d' | 'opsFee14d';

/** A parameter change waiting in the public queue. `value` is in the parameter's own unit. */
export interface QueuedChange {
  key: ParamKey;
  value: bigint;
  eta: Sec;
}

export interface CircuitInfo {
  processorName: string;
  processorSymbol: string;
  circuits: Address;
  circuitId: number;
  gates: number;
  netlistHash: Hex;
}

export interface PoolContracts {
  pool: Address;
  factory: Address;
  policy: Address;
  screen: Address;
  bem: Address;
  voucher: Address;
}

export interface PoolView {
  totalAssets: bigint;
  /** Unknown on the legacy stack. */
  unvested?: bigint | null;
  vestEnd?: Sec | null;
  outstanding: bigint;
  idle: bigint;
  /** Principal of loans marked doubtful. Deposits are closed while this is above 0. */
  doubtful: bigint;
  params: PoolParams;
  /** BEM (raw) that one tpBEM is worth. */
  tpbemValue: bigint;
  borrowsPaused: boolean;
  feedDisabled: boolean;
  /**
   * Redeploy 3 (R3-01): `feedEnabledAt + FEED_SETTLE`, chain time before which `lend` reverts `FeedSettling()`.
   * 0 (or absent) before any re-enable, on the legacy stack, and when it cannot be read.
   */
  feedSettleUntil?: Sec;
  pendingPolicy: { address: Address; eta: Sec } | null;
  queued: QueuedChange[];
  circuit: CircuitInfo;
  contracts: PoolContracts;
}

/** Rules the credit math needs from the network. */
export interface RulesView {
  totalVerifWeight: bigint;
  /** A term is not offered when `now + term` reaches this time (the next emission halving window). */
  emissionValidUntil: Sec;
}

/* ───────── wallet and position ───────── */

/** `view` is the read-only view of someone else's address (`#/app/view/<address>`). */
export type WalletStatus = 'disconnected' | 'wrong-network' | 'connected' | 'view';

/**
 * A wallet found in the browser (EIP-6963, or the plain `window.ethereum`), as the picker draws it. What a wallet announces is
 * untrusted: the strings here have already been cleaned (`logic/wallets.ts`), and the provider object never leaves `chain/wallet.ts`.
 */
export interface WalletOption {
  /** Opaque and safe in an attribute; the app finds the provider again by it. */
  id: string;
  name: string;
  /** A `data:image/...;base64,` URI that passed the check, else null. */
  icon: string | null;
  /** The reverse-DNS name the wallet announced. Used only to match the recommended list and the wallet used last. */
  rdns: string;
  /** The plain `window.ethereum`, found because no wallet announced itself. */
  fallback: boolean;
}

export interface WalletView {
  status: WalletStatus;
  account: Address | null;
  bem: bigint;
  okb: bigint;
  /** `TapePool.maxLend(account)`: the most the pool can lend this account right now. */
  room: bigint;
  /** lendLimit: 1 idle, 2 borrow cap, 3 borrower cap, 4 backstop, 5 paused/feed off. */
  binding?: number;
  /** Estimated gas cost of the borrow transaction, in wei of OKB. */
  borrowGas: bigint;
  /** BEM allowance to the pool. */
  allowancePool: bigint;
  /** BEM allowance to each of the account's Rig Agents, keyed by lower-case agent address. */
  allowanceAgent: Record<string, bigint>;
  /** The wallets found in the browser. Absent when the source has no wallet of its own. */
  options?: readonly WalletOption[];
  /** The wallet the app is using. */
  active?: WalletOption | null;
  /** `rdns` of the wallet that connected last, for the "Recent" tag. */
  recent?: string | null;
}

export interface PositionView {
  tpbem: bigint;
  /** `convertToAssets(tpbem)`. */
  value: bigint;
  /** `maxWithdraw`. */
  withdrawable: bigint;
  /** `maxDeposit`: 0 while deposits are closed. */
  maxDeposit: bigint;
  /** Value minus net deposits; null when the keeper cannot say (transferred shares, lagging index). */
  growth: bigint | null;
}

export interface KeeperView {
  reachable: boolean;
  /** Decimal string with 6 places (`"0.091900"`), or null. */
  apy7d: string | null;
  /** The keeper's BNB cost for a push, as quoted by the reporter, in wei of BNB. */
  selfPushBnb: bigint | null;
}

/* ───────── rigs (SPEC-PHASE5-APP §5.2) ───────── */

export type RigPlace =
  | { kind: 'wallet' }
  | { kind: 'agent'; agent: Address; closed: boolean; collateral: boolean; loanOpen: boolean }
  /** Listed in a closed agent's `Seized.movedIds`. */
  | { kind: 'pool'; agent: Address };

export interface BscFacts {
  status: number;
  stopBlock: bigint;
  custodied: boolean;
  verifWeight: bigint;
  bonus: bigint;
  /** When the rig started mining. */
  since: Sec;
  /**
   * BEM mined and not harvested yet, raw: `PodMining.pending` plus the BEM already in the rig's vault cell, both read at one
   * pinned BSC block. Null when any of the two could not be read, and for facts that come from the feed's report (which has
   * no cell balance): an unknown amount is never shown, or counted, as zero.
   */
  mined: bigint | null;
  circuits: Address;
  circuitId: bigint;
  taskId: bigint;
}

export interface ScreenPass {
  circuits: Address;
  circuitId: bigint;
  taskId: bigint;
  effectiveAt: Sec;
}

/** What the reads say about one rig. `deriveRigState` turns it into a `RigState`. */
export interface RigFacts {
  id: number;
  place: RigPlace;
  /** The BSC read, or the last feed report when BSC is unreachable; null when neither exists. */
  bsc: BscFacts | null;
  /** Set when `bsc` came from the feed: when that report was observed. */
  bscAsOf: Sec | null;
  voucher: { circuits: Address; circuitId: bigint; power: bigint };
  /** Null when the voucher's circuits contract is not one of the three supported processors. */
  processor: Processor | null;
  screen: { pass: ScreenPass | null; suspended: boolean };
}

/** The first matching row of the §5.2 table. `row` is the table row. */
export type RigState =
  | { kind: 'loan'; row: '1'; agent: Address }
  | { kind: 'seized'; row: '2'; agent: Address }
  | { kind: 'stuck'; row: '3'; agent: Address }
  | { kind: 'in-agent'; row: '4'; agent: Address }
  | { kind: 'loose'; row: '5'; agent: Address; agentClosed: boolean }
  | { kind: 'no-data'; row: '6' }
  | { kind: 'not-mining'; row: '7' }
  | { kind: 'processor'; row: '8' }
  | { kind: 'not-synced'; row: '9a' }
  | { kind: 'mismatch'; row: '9b' }
  | { kind: 'too-new'; row: '10'; readyAt: Sec }
  | { kind: 'no-base-power'; row: '11' }
  | { kind: 'not-screened'; row: '12'; why: 'none' | 'suspended' | 'changed' }
  | { kind: 'screen-pending'; row: '13'; effectiveAt: Sec }
  | { kind: 'ready'; row: '14' };

export interface RigView {
  id: number;
  facts: RigFacts;
  state: RigState;
  /** `verifWeight - bonus`, never negative; null without any BSC data. */
  basePower: bigint | null;
  /** Seconds since the rig started mining; null without BSC data. */
  age: Sec | null;
  /** BEM mined and not harvested on BSC (`BscFacts.mined`); null when unknown. */
  mined: bigint | null;
  processor: Processor | null;
}

/* ───────── agents and loans ───────── */

export interface AgentView {
  address: Address;
  closed: boolean;
  /** The agent's collateral set, ascending. */
  collateral: number[];
  /** Vouchers the agent owns that are not in its collateral set. */
  loose: number[];
  /** Ownership of listed entries; null means unreadable. */
  owners?: Record<string, Address | null>;
  releaseAttempted?: boolean;
  releaseRetried?: boolean;
  /** BEM held by the agent. */
  bem: bigint;
}

export type LoanPhase = 'active' | 'late' | 'flagged' | 'seize' | 'seized' | 'cleared';

/**
 * What the BSC read says is wrong with the rig that raised an impairment flag: it stopped (a stop block is set), is no longer
 * active (its status is not active and no stop block says why; a code is not enough to call it revoked), left the
 * vault's custody (a rescue), or has no base power. `unknown` is the generic "proven impaired on-chain" (for
 * example a voucher that synced power 0).
 */
export type ImpairmentKind = 'stopped' | 'inactive' | 'rescued' | 'no-power' | 'unknown';

export interface CollateralRow {
  id: number;
  basePower: bigint;
  processor: Processor | null;
  /** Seconds since the rig started mining. */
  age: Sec;
  mining: boolean;
}

export interface LoanView {
  agent: Address;
  /** Every id in the agent's collateral set, ascending. The loan is backed by all of them. */
  rigIds: number[];
  collateral: CollateralRow[];
  phase: LoanPhase;
  term: TermIndex;
  start: Sec;
  maturity: Sec;
  /** `principal0`. */
  advance: bigint;
  principal: bigint;
  feeLeft: bigint;
  lateFee: bigint;
  lateBpsPerDay: number;
  /** `fee0`, from the Borrowed event. */
  feePaid: bigint | null;
  /** From the OpsFeePaid event. */
  opsFeePaid: bigint | null;
  /** BEM harvested and waiting in the agent. */
  agentBem: bigint;
  /** BEM mined on BSC and not harvested, over the collateral; null when any rig's amount is unknown. */
  minedBsc: bigint | null;
  /** Expected base output per day, for the forecast. */
  expectedPerDay: bigint;
  impairedAt: Sec | null;
  /** End of the cure window. */
  seizeStart: Sec | null;
  /** End of the seize window. */
  deadline: Sec | null;
  deadlinePaused?: boolean;
  doubtful?: boolean;
  expired?: boolean;
  impairedRig: number | null;
  /** Why `impairedRig` counts as impaired, from the BSC read of that rig; null without a flag. */
  impairment: ImpairmentKind | null;
  seizedAt: Sec | null;
  writtenOff: bigint | null;
  clearedAt: Sec | null;
  /** BEM above the debt that went back to the borrower. */
  surplus: bigint | null;
}

/* ───────── borrow flow inputs and quotes ───────── */

export interface Report {
  /** `RigFeedReceiver.latest(id).observedAt`. */
  observedAt: Sec;
}

/** `TapeLens.quote(agent, term)`. */
export interface Quote {
  maxPrincipal: bigint;
  fee: bigint;
  expected: bigint;
  inputBits: number;
  reason: number;
  pending: bigint;
  opsFee: bigint;
}

export interface PrincipalQuote {
  fee: bigint;
  lateBps: number;
  debt: bigint;
  allowed: boolean;
  reason: number;
  binding: number;
}

export type ActionId =
  | 'create'
  | 'move'
  | 'refresh'
  | 'selfpush'
  /** Harvest first: `RigVault.harvest` on BSC, sent from the user's wallet (SPEC-PHASE5-PRELOAN §4.3). */
  | 'harvest'
  | 'borrow'
  | 'approve-repay'
  | 'repay'
  | 'sweep'
  | 'release'
  | 'take-back'
  | 'register'
  | 'forget'
  | 'claim'
  | 'approve-supply'
  | 'supply'
  | 'withdraw';

/** What the wallet is about to ask the user to confirm: the contract, the function and the value (SPEC-PHASE5-APP §6.0 rule 4). */
export interface Ask {
  /** The contract's name and short address, for example `RigAgent 0xAB12…cdEF`. */
  contract: string;
  /** The function with its arguments, for example `borrow(0, 1.2000 BEM)`. */
  fn: string;
  /** What is sent with it, for example `0.031 OKB`. */
  value: string;
  /** A sentence that belongs under the line, kept as a code so it is translated when it is shown. */
  note?: 'bond';
}

/** A transaction or keeper request that has been sent and not settled. Kept so that a reload still shows it. */
export interface PendingTx {
  action: ActionId;
  since: Sec;
  hash: Hex | null;
  /** The chain the transaction was sent on; absent means X Layer. A self-push is on BNB Smart Chain. */
  chainId?: number;
  /** Set while the wallet prompt is open or the transaction is unconfirmed. */
  ask?: Ask;
}

/* ───────── BEM mined before a loan (SPEC-PHASE5-PRELOAN) ───────── */

/** Where a harvest the app sent (or saw) stands (SPEC-PHASE5-PRELOAN §4.4). */
export type GateState = 'prompting' | 'in-flight' | 'mined' | 'cautious' | 'final' | 'passed' | 'moved' | 'payee-mismatch' | 'void';

/**
 * The record kept for one voucher id, in `localStorage`, about a harvest of its BEM. It decides whether the voucher may move
 * (the move gate): the harvest pays whoever is the payee at the harvest's BSC time, so the voucher must not reach the agent
 * before that time has passed on X Layer. Records hold no secret.
 */
export interface GateRecord {
  id: number;
  wallet: Address;
  hash: Hex | null;
  /** The nonce of the harvest transaction, taken from the transaction itself; null while unknown. */
  nonce: number | null;
  /** `T_h`: the BSC time of the harvest's block (for a cautious record, of the block of the observation: an upper bound). */
  harvestedAt: Sec | null;
  /** The BSC block of the harvest, or of the observation. */
  block: bigint | null;
  /** BEM (raw) the harvest sent for this rig, from the vault's `Harvested` event; null when the app did not send it. */
  amount: bigint | null;
  /** X Layer chain time when the record was written. */
  createdAt: Sec;
  state: GateState;
  /** A BSC block a cautious observation was made at: an `in-flight` or `mined` record becomes `final` only once it is finalized too. */
  floor: bigint | null;
  /** What `prompting` knew: the rig's mined BEM (rounded to the dust) at the pinned block the harvest was prepared at. */
  base: { block: bigint; mined: bigint } | null;
  /** After the move: the agent the voucher is in, the X Layer block to look for `Paid` from, the last block looked at, and when it was seen. */
  agent: Address | null;
  movedBlock: bigint | null;
  cursor: bigint | null;
  movedAt: Sec | null;
}

/** What the harvest action needs from BSC and X Layer, read only while a rig has BEM worth harvesting (SPEC-PHASE5-PRELOAN §5). */
export interface HarvestPrep {
  /** The pinned BSC block the reads are from, and its time. */
  block: bigint;
  time: Sec;
  /** `quoteHarvest(n)` for n = 1, 2, …; an entry is null when its read failed. */
  quotes: (bigint | null)[];
  /**
   * Do the ERC-1967 implementation slots of the vault (BSC) and the voucher (X Layer) hold the implementations the
   * harvest-first rules were reviewed against? Null when a slot could not be read.
   */
  contracts: 'ok' | 'changed' | null;
  /**
   * By rig id: is the wallet `voucher.payeeAt(id, time)`, that is, has BSC time passed the moment the voucher came into the
   * wallet? False means a harvest now would pay the previous holder. Null when the read failed.
   */
  mark: Record<string, boolean | null>;
}

export interface HarvestView {
  /**
   * The timestamp of the last X Layer head the source read. The move gate is measured against it and not against the page's clock
   * between reads (`Snapshot.now`, which keeps counting): the gate says the HEAD of X Layer is later than the harvest's BSC time.
   */
  headTime: Sec;
  /** `feeBps()` of the BEM OFT adapter; 500 (the 5% maximum) when it could not be read. */
  feeBps: number;
  /** False when this browser keeps no records (blocked `localStorage`): harvest from here is off. */
  storage: boolean;
  /** The records of the connected wallet, by voucher id. */
  gates: Record<string, GateRecord>;
  /** Null when no rig has BEM to harvest, or the reads failed. */
  prep: HarvestPrep | null;
}

/** Set while the first read of a part has not finished (`loading`) or could not finish (`failed`). */
export type BootState = 'loading' | 'failed';

export interface Snapshot {
  /** Chain time of this read. */
  now: Sec;
  /** The pool read (every page needs it) and the read of the account the page is for. Absent once they are in. */
  boot?: { pool?: BootState; account?: BootState };
  wallet: WalletView;
  pool: PoolView;
  rules: RulesView;
  position: PositionView | null;
  keeper: KeeperView;
  rigs: RigView[];
  agents: AgentView[];
  loans: LoanView[];
  /** Latest feed report per rig id (string keys). */
  reports: Record<string, Report>;
  /** `quote` for each term, per agent (lower-case address keys), once reports are timely. */
  quotes: Record<string, readonly [Quote | null, Quote | null]>;
  principalQuotes?: boolean;
  /**
   * The entry checks of SPEC-PHASE5-APP §10 for each agent that could borrow (lower-case address keys): `null` passed, an
   * `AppError` failed. Absent for an agent not checked yet, and absent altogether in a source that does not run them (the
   * fixtures); the Borrow button waits for a pass wherever the field exists.
   */
  entry?: Record<string, AppError | null>;
  /** BEM mined before a loan: the bridge fee, the harvest records of this wallet and what a harvest needs (SPEC-PHASE5-PRELOAN). */
  harvest: HarvestView;
  pending: PendingTx | null;
  stale: Partial<Record<Section, true>>;
}
