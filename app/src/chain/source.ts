import type { AppConfig } from '../config';
import { buildRigView } from '../logic/rigState';
import { History, type HistoryChain, type HistoryLog, type KvStore } from '../logic/history';
import { buildOpenLoan, buildSeizedLoan, clearedFrom } from '../logic/loan';
import { timely } from '../logic/borrow';
import type {
  Address,
  BscFacts,
  HarvestPrep,
  HarvestView,
  Hex,
  KeeperView,
  LoanView,
  OwnerScreensView,
  PendingTx,
  PoolView,
  Quote,
  PrincipalQuote,
  TermIndex,
  Report,
  RigFacts,
  RigPlace,
  RigView,
  ScreenRecord,
  ScreensView,
  Sec,
  Section,
  Snapshot,
  WalletOption,
  WalletStatus,
  WalletView,
} from '../model';
import type { DataSource, Settled } from '../source';
import { quoteSelfPush, readBsc, type KeyCache } from './bsc';
import { growthOf, type KeeperClient, type KeeperPosition } from './keeper';
import { checkEntries } from './checks';
import type { AppError } from './errors';
import { GateStore } from './gates';
import { readHarvestPrep, upkeepGates, type MinedMemory } from './harvest';
import { BRIDGE_FEE_BPS_MAX, BOND } from '../constants';
import { gateOpen } from '../logic/gates';
import { collectable, minedR } from '../logic/harvest';
import { allowanceMap, assembleFacts, borrowGasCost, mapAgents, mapPool, placesOf } from './map';
import { readCircuit, readCore, readHoldings, readOwnerScreens, readQuoteFor, readQuotes, readRigRecords, readScreenDelay, type AgentRaw, type CircuitRaw, type PolicyPins, type ReadEnv, type XLayerRig } from './reads';
import type { Head, Reader } from './reader';
import { WalletActivity } from './activity';
import type { BscResult } from './bsc';
import { legacyBorrowAbi } from './legacyAbi';
import { rigAgentAbi } from './abi';
import { decodeFunctionResult, encodeFunctionData } from 'viem';
import type { ActionHost } from './tx';
import type { LoanRaw } from '../logic/loan';

/**
 * The chain-backed `DataSource` (SPEC-PHASE5-APP §5). `snapshot` is synchronous and returns what the last reads
 * found; `refresh` runs the reads and says so through `subscribe`. One refresh runs at a time (a second request
 * during one is folded into a single rerun), every read of a refresh is pinned to one X Layer block, and a part
 * that fails keeps its old value and is marked stale.
 */

/** What the source needs from the wallet. */
export interface WalletLike {
  readonly account: Address | null;
  readonly chainId: number | null;
  subscribe(fn: () => void): () => void;
  /** The wallets found in the browser, the one in use and the one used last: what the connect dialog and the account menu show. */
  options?(): readonly WalletOption[];
  active?(): WalletOption | null;
  recent?(): string | null;
}

/** The slice of `sessionStorage` used to keep a pending transaction across a reload (SPEC-PHASE5-APP §6.0). */
export interface SessionStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface ChainSourceDeps {
  config: AppConfig;
  x: Reader;
  /** Local server-side archive RPC used for history, when configured. */
  activityReader?: Reader;
  b: Reader;
  wallet: WalletLike;
  keeper: KeeperClient;
  /** Where the log-search answers are cached (localStorage in the browser). */
  store: KvStore;
  /** The harvest records (SPEC-PHASE5-PRELOAN §4.4); by default kept in `store`. The actions must be given the same ones. */
  gates?: GateStore;
  session?: SessionStore;
  /** Monotonic milliseconds. */
  clock?: () => number;
  /** Unix milliseconds: used only for the instant before the first block is read. */
  wall?: () => number;
}

/** A section older than this is shown stale even though no read failed: the refresh timer stopped. */
export const STALE_AFTER_MS = 60_000;
/** While a harvest record is on its way, the source reads again this often (ms) instead of every 15 s, so the move turns on within seconds of X Layer's clock getting there. */
export const GATE_POLL_MS = 4_000;
/** After a keeper request fails at the network level, wait this long before the next one, so a down keeper does not fill the console. */
export const KEEPER_BACKOFF_MS = 120_000;
/** The gas price is read at most this often. */
export const GAS_PRICE_EVERY_MS = 60_000;
/** A keeper request that survived a reload is dropped after this long: it has no transaction to wait for. */
export const RESTORED_REQUEST_SEC = 150;

interface Health {
  ever: boolean;
  failed: boolean;
  at: number;
}
const newHealth = (): Health => ({ ever: false, failed: false, at: 0 });

interface WalletRes {
  bem: bigint;
  okb: bigint;
  room: bigint;
  binding?: number;
  allowancePool: bigint;
  tpbem: bigint;
  value: bigint;
  withdrawable: bigint;
  maxDeposit: bigint;
}

interface Acct {
  target: Address;
  activity: WalletActivity;
  wallet: WalletRes | null;
  holdings: { walletIds: bigint[]; agents: AgentRaw[] } | null;
  facts: RigFacts[] | null;
  reports: Record<string, Report>;
  totalVerifWeight: bigint | null;
  quotes: Record<string, readonly [Quote | null, Quote | null]>;
  /** The entry checks of the agents that could borrow (SPEC-PHASE5-APP §10), from the last refresh. */
  entry: Record<string, AppError | null>;
  selfPushBnb: bigint | null;
  /** The bridge fee of the BEM adapter from the last BSC read, null when it could not be read. */
  feeBps: number | null;
  /** What a harvest needs, from the last refresh (SPEC-PHASE5-PRELOAN §5). The records themselves are read from the store at each snapshot. */
  prep: HarvestPrep | null;
  /** The last read of each wallet rig's harvestable BEM, to notice a drop (someone harvested). */
  memory: MinedMemory;
  health: Record<'wallet' | 'rigs' | 'loans', Health>;
  /** Set when a read of this part failed before any success: the page shows a failure card. */
  bootFailed: boolean;
}

const PENDING_KEY = 'tp:pending:196';

const same = (a: string | null | undefined, b: string | null | undefined): boolean => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

export class ChainSource implements DataSource, ActionHost {
  readonly history: History;
  private readonly env: ReadEnv;
  private readonly cfg: AppConfig;
  private readonly clock: () => number;
  private readonly wall: () => number;
  private readonly listeners = new Set<() => void>();
  private readonly keys: KeyCache = new Map();
  private readonly lastOpen = new Map<string, LoanView>();
  private readonly cleared = new Map<string, LoanView>();
  private readonly queued = new Set<string>();
  private readonly releaseAttempts = new Map<string, number>();

  private head: Head | null = null;
  private headAt = 0;
  private pins: PolicyPins | null = null;
  private circuit: CircuitRaw | null = null;
  private pool: PoolView | null = null;
  private poolHealth = newHealth();
  private totalVerifWeight = 0n;
  private acct: Acct | null = null;
  /** Bumped when the account the app shows changes, so a late answer for the old one is dropped. */
  private gen = 0;
  /** The account the last `snapshot` (or the wallet at the start) asked for. */
  private wanted: Address | null;
  private running: Promise<void> | null = null;
  private again = false;
  private bg: Promise<void> = Promise.resolve();
  private gas: { price: bigint | null; at: number } = { price: null, at: Number.NEGATIVE_INFINITY };
  private keeperView: KeeperView = { reachable: false, apy7d: null, selfPushBnb: null };
  private keeperPos: { address: string; data: KeeperPosition | null } | null = null;
  private keeperDownUntil = 0;
  private showTransactions = false;
  /** SPEC-PHASE5-REGISTER §7.2, §8: the owner page is open, and the last registration list with when it was read. */
  private wantOwner = false;
  private screens: { view: ScreensView | null; at: number } = { view: null, at: Number.NEGATIVE_INFINITY };
  private screenDelay: { value: Sec | null; read: boolean } = { value: null, read: false };
  private ownerScreens: OwnerScreensView | null = null;
  private pendingTx: PendingTx | null;
  /** The pending mark was loaded from `sessionStorage` after a reload and no action in this session has taken it over. */
  private restored = false;
  private readonly settledListeners = new Set<(s: Settled) => void>();
  private offWallet: (() => void) | null = null;
  private disposed = false;
  private gasCost = borrowGasCost(null);
  private onVisible: (() => void) | null = null;
  private gateTimer: ReturnType<typeof setInterval> | null = null;
  private resuming = false;
  private readonly gates: GateStore;

  constructor(private readonly deps: ChainSourceDeps) {
    this.cfg = deps.config;
    this.gates = deps.gates ?? new GateStore(deps.store, deps.config.book.chainId);
    this.clock = deps.clock ?? (() => performance.now());
    this.wall = deps.wall ?? (() => Date.now());
    this.env = { x: deps.x, book: deps.config.book, lens: deps.config.tapeLens };
    this.history = new History(chainForHistory(deps.x), deps.store, { chainId: deps.config.book.chainId, fromBlock: deps.config.book.poolDeployBlock, clock: this.clock });
    this.wanted = deps.wallet.account;
    this.retarget(this.wanted);
    this.pendingTx = this.loadPending();
    this.restored = this.pendingTx !== null;
    // a new account or chain shows through `snapshot`, which notices the changed target and reads for it
    this.offWallet = deps.wallet.subscribe(() => this.emit());
  }

  /* ───────── DataSource ───────── */

  async quoteFor(agent: Address, term: TermIndex, principal: bigint): Promise<PrincipalQuote | null> {
    try {
      const head = await this.deps.x.head();
      return await readQuoteFor(this.env, head.number, agent, term, principal);
    } catch { return null; }
  }

  noteRelease(agent: Address, attempts: number): void {
    const key = agent.toLowerCase();
    const previous = this.releaseAttempts.get(key) ?? Number(this.deps.session?.get('tp:release:' + key) ?? 0);
    const count = Math.max(attempts, previous + 1);
    this.releaseAttempts.set(key, count);
    this.deps.session?.set('tp:release:' + key, String(count));
  }

  now(): Sec {
    if (!this.head) return Math.floor(this.wall() / 1000);
    return this.head.timestamp + Math.floor((this.clock() - this.headAt) / 1000);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(view: Address | null, showTransactions = false, screens = false): Snapshot {
    const opened = showTransactions && !this.showTransactions;
    this.showTransactions = showTransactions;
    const ownerOpened = screens && !this.wantOwner;
    this.wantOwner = screens;
    if (ownerOpened) void this.refresh();
    const target = this.targetOf(view);
    if (!same(this.wanted, target)) {
      this.wanted = target;
      this.retarget(target);
      void this.refresh();
    } else if (opened && this.acct?.holdings && this.head) this.readActivity(this.acct, this.head);
    return this.assemble(view, target);
  }

  /** Read now. Calls during a refresh fold into one rerun after it. */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = (async () => {
      try {
        do {
          this.again = false;
          try {
            await this.cycle();
          } catch {
            // a bug or an odd answer must not become an unhandled rejection: keep what is shown, mark it stale
            this.failEverything(this.acct);
          }
        } while (this.again && !this.disposed);
      } finally {
        this.running = null;
      }
    })();
    this.running = run;
    return run;
  }

  /** Start the page-visible behaviours that belong to the source: read again when the tab comes back. */
  start(): void {
    if (typeof document !== 'undefined' && !this.onVisible) {
      this.onVisible = () => {
        if (document.visibilityState !== 'visible') return;
        // the tab was hidden, so its data is old for a good reason: do not call it stale while it is being read again
        this.resuming = true;
        void this.refresh().finally(() => {
          this.resuming = false;
        });
      };
      document.addEventListener('visibilitychange', this.onVisible);
    }
    this.gateTimer ??= setInterval(() => {
      if (!this.disposed && this.gateBusy()) void this.refresh();
    }, GATE_POLL_MS);
    void this.refresh();
  }

  /** A record of a harvest is still on its way: unresolved, waiting for the gate, or waiting to be checked after the move. */
  private gateBusy(): boolean {
    const acct = this.acct;
    if (!acct?.facts || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return false;
    const head = this.head?.timestamp ?? 0;
    return Object.values(this.gates.all(acct.target, acct.facts.map((f) => f.id))).some((r) => r.state !== 'void' && !(r.state === 'passed' && gateOpen(r, head)));
  }

  /** Resolves when the background log searches queued so far have finished. */
  settled(): Promise<void> {
    return this.bg;
  }

  dispose(): void {
    this.disposed = true;
    if (this.gateTimer) clearInterval(this.gateTimer);
    if (this.onVisible && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
    this.offWallet?.();
    this.listeners.clear();
  }

  /* ───────── hooks for the write step (B4) ───────── */

  /**
   * A repayment receipt the session saw cleared the loan of `agent`. The chain keeps nothing of a cleared loan, so
   * this is the only way "Debt cleared on <date>" can be shown (SPEC-PHASE5-APP §5.5).
   */
  noteLoanCleared(agent: Address, info: { clearedAt: Sec; surplus: bigint | null }): void {
    const open = this.lastOpen.get(agent.toLowerCase());
    if (!open) return;
    this.cleared.set(agent.toLowerCase(), clearedFrom(open, info.clearedAt, info.surplus, 0n));
    this.emit();
  }

  /** Called when a transaction left pending by a reload turns out to be mined (or never to have been sent). */
  onSettled(listener: (s: Settled) => void): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  /** Keep (or drop, with null) the transaction in flight, so a reload still shows it. */
  setPending(p: PendingTx | null): void {
    this.restored = false; // an action of this session owns the mark now
    this.pendingTx = p;
    const s = this.deps.session;
    try {
      if (p === null) s?.remove(PENDING_KEY);
      else s?.set(PENDING_KEY, JSON.stringify(p));
    } catch {
      /* storage can be blocked */
    }
    this.emit();
  }

  /* ───────── target ───────── */

  private targetOf(view: Address | null): Address | null {
    return view ?? this.deps.wallet.account;
  }

  private retarget(target: Address | null): void {
    if (this.acct && same(this.acct.target, target)) return;
    this.gen++;
    this.acct = target ? this.newAcct(target) : null;
    this.keeperPos = null;
  }

  private newAcct(target: Address): Acct {
    return {
      target,
      activity: new WalletActivity(this.cfg.book, target, this.deps.store),
      wallet: null,
      holdings: null,
      facts: null,
      reports: {},
      totalVerifWeight: null,
      quotes: {},
      entry: {},
      selfPushBnb: null,
      feeBps: null,
      prep: null,
      memory: new Map(),
      health: { wallet: newHealth(), rigs: newHealth(), loans: newHealth() },
      bootFailed: false,
    };
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  /* ───────── the refresh ───────── */

  private async cycle(): Promise<void> {
    const gen = this.gen;
    const target = this.wanted;
    const acct = this.acct && target && same(this.acct.target, target) ? this.acct : null;
    let head: Head;
    try {
      head = await this.deps.x.head();
    } catch {
      this.failEverything(acct);
      return;
    }
    this.head = head;
    this.headAt = this.clock();
    const block = head.number;
    const keeperDone = this.readKeeper(acct?.target ?? null, gen);

    // round 1: the pool and, for the account, its balances
    let core: Awaited<ReturnType<typeof readCore>>;
    try {
      core = await readCore(this.env, block, acct?.target ?? null, this.pins?.policy ?? null);
    } catch {
      this.fail(this.poolHealth);
      if (acct) this.failAccount(acct);
      this.emit();
      await keeperDone;
      return;
    }
    try {
      if (core.pins) this.pins = core.pins;
      if (this.pins && (!this.circuit || core.pins)) {
        const c = await readCircuit(this.env, block, this.pins);
        if (!c) throw new Error('circuit unreadable');
        this.circuit = c;
      }
      if (!this.pins || !this.circuit) throw new Error('policy unreadable');
      this.pool = mapPool(core.pool, this.pins, this.circuit, this.cfg.book, head.timestamp);
      this.ok(this.poolHealth);
    } catch {
      this.fail(this.poolHealth);
    }
    this.emit();

    if (acct && gen === this.gen) await this.accountCycle(acct, core, head, gen);
    await keeperDone;
    await this.readScreens(acct, head);
    if (acct && gen === this.gen) this.readActivity(acct, head);
    this.emit();
  }

  private readActivity(acct: Acct, head: Head): void {
    const keeper = this.keeperPos?.data;
    if (!acct.holdings || (!this.deps.activityReader && keeper?.transactions && keeper.indexedToTime && head.timestamp - keeper.indexedToTime <= 300)) return;
    const active = () => this.acct === acct && !this.disposed && this.showTransactions &&
      (typeof document === 'undefined' || document.visibilityState !== 'hidden');
    const archive = this.deps.activityReader;
    void acct.activity.refresh(archive ?? this.deps.x, head.number - 10n, acct.holdings.agents.map(a => a.address),
      archive ? 10000n : 100n, active, () => this.emit());
  }

  private async accountCycle(acct: Acct, core: Awaited<ReturnType<typeof readCore>>, head: Head, gen: number): Promise<void> {
    const block = head.number;
    const live = (): boolean => gen === this.gen && !this.disposed;
    if (!core.account) {
      this.failAccount(acct);
      return;
    }
    const gasP = this.readGasPrice();

    // round 2 and 3: the wallet's vouchers and the agents
    let holdings: Awaited<ReturnType<typeof readHoldings>> | null = null;
    try {
      holdings = await readHoldings(this.env, block, core.account);
    } catch {
      holdings = null;
    }
    if (!live()) return;
    const gasPrice = await gasP;
    const value = holdings?.value ?? (core.account.tpbem * core.pool.tpbemValue) / 10n ** 14n;
    acct.wallet = { bem: core.account.bem, okb: core.account.okb, room: core.account.room, binding: core.account.binding, allowancePool: core.account.allowancePool, tpbem: core.account.tpbem, value, withdrawable: core.account.withdrawable, maxDeposit: core.account.maxDeposit };
    this.gasCost = borrowGasCost(gasPrice);
    this.ok(acct.health.wallet);
    if (!holdings) {
      this.fail(acct.health.rigs);
      this.fail(acct.health.loans);
      if (acct.holdings === null) acct.bootFailed = true;
      this.emit();
      return;
    }
    acct.holdings = { walletIds: holdings.walletIds, agents: holdings.agents };
    acct.bootFailed = false;
    this.ok(acct.health.loans);
    this.emit();

    // round 4: every rig, on X Layer and on BSC
    const seized = this.seizedIds(holdings.agents);
    const places = placesOf(holdings.walletIds, holdings.agents, seized);
    const ids = [...places.keys()];
    const bscIds = ids;
    const selfPushIds = this.selfPushIds(holdings.agents, holdings.walletIds);
    const [xlRes, bscRes, pushRes] = await Promise.allSettled([
      ids.length === 0 ? Promise.resolve(new Map<number, XLayerRig>()) : readRigRecords(this.env, block, ids),
      bscIds.length === 0 ? Promise.resolve<BscResult | null>(null) : readBsc(this.deps.b, this.cfg.book, bscIds, this.keys),
      selfPushIds.length === 0 ? Promise.resolve(null) : quoteSelfPush(this.deps.b, this.cfg.book, selfPushIds),
    ]);
    if (!live()) return;
    acct.selfPushBnb = pushRes.status === 'fulfilled' ? pushRes.value : null;
    if (xlRes.status === 'rejected' || !this.pins) {
      this.fail(acct.health.rigs);
      if (acct.facts === null) acct.bootFailed = true;
      this.scheduleHistory(holdings.agents);
      this.emit();
      return;
    }
    const xl = xlRes.value;
    const bscRead = bscRes.status === 'fulfilled' ? bscRes.value : null;
    const bsc = bscRead ?? { facts: new Map<number, BscFacts>(), totalVerifWeight: null };
    acct.facts = assembleFacts({ places, xl, bsc: bsc.facts, pins: this.pins });
    acct.reports = {};
    for (const [id, x] of xl) if (x.report && x.report.observedAt !== 0n) acct.reports[String(id)] = { observedAt: Number(x.report.observedAt) };
    acct.totalVerifWeight = bsc.totalVerifWeight ?? newestTotal(xl) ?? this.totalVerifWeight;
    if (acct.totalVerifWeight !== null) this.totalVerifWeight = acct.totalVerifWeight;
    acct.feeBps = bscRead ? bscRead.feeBps : null;
    await this.harvestCycle(acct, head, places, bscRead);
    if (!live()) return;

    // round 5: the lens, for the agents whose reports are timely
    let quotesOk = true;
    const eligible = holdings.agents.filter((a) => !a.closed && !a.loan.open && a.collateral.length > 0 && a.collateral.every((id) => acct.reports[String(id)] !== undefined && timely(acct.reports[String(id)]?.observedAt ?? 0, head.timestamp)));
    try {
      const q = await readQuotes(this.env, block, eligible.map((a) => a.address));
      if (!live()) return;
      acct.quotes = Object.fromEntries(q);
    } catch {
      quotesOk = false;
    }
    if (!live()) return;
    acct.entry = await this.entryChecks(core.account.account, holdings.agents, block);
    if (quotesOk) await this.estimateBorrowGas(core.account.account, eligible, acct.quotes, gasPrice);
    if (quotesOk) this.ok(acct.health.rigs);
    else {
      // the rig list is in, the quotes are not: show the list, mark it stale so the borrow button stays off
      acct.health.rigs.ever = true;
      this.fail(acct.health.rigs);
    }
    this.scheduleHistory(holdings.agents);
    void this.checkPending();
  }

  /* ───────── helpers of the refresh ───────── */

  /**
   * BEM mined before a loan (SPEC-PHASE5-PRELOAN §5): the upkeep of the account's harvest records (receipts, finality, drops, the
   * payee check after a move) and, while some wallet rig has BEM worth harvesting, what the harvest action needs. A failure here
   * leaves the old values: the records themselves are read from the store at each snapshot, and the move re-reads everything.
   */
  private async harvestCycle(acct: Acct, head: Head, places: ReadonlyMap<number, RigPlace>, bsc: BscResult | null): Promise<void> {
    const wallet = acct.target;
    const mined = new Map<number, bigint | null>();
    for (const f of acct.facts ?? []) if (f.place.kind === 'wallet') mined.set(f.id, f.bsc?.mined ?? null);
    const env = { x: this.deps.x, b: this.deps.b, book: this.cfg.book };
    try {
      await upkeepGates({ ...env, gates: this.gates }, { wallet, head, pin: bsc?.block ?? null, places, mined, memory: acct.memory });
    } catch {
      /* the records stay as they are */
    }
    acct.prep = null;
    // the action is offered for the wallet rigs that have something to harvest; the action itself reads again for the exact ids
    const harvestIds = [...mined].filter(([, m]) => m !== null && minedR(m) > 0n).map(([id]) => id).sort((a, b) => a - b).slice(0, 16);
    const worth = collectable(harvestIds.map((id) => ({ id, mined: mined.get(id) ?? null }))) >= BOND;
    if (bsc && worth && this.gates.available()) {
      try {
        acct.prep = await readHarvestPrep(env, wallet, harvestIds, bsc.block);
      } catch {
        acct.prep = null;
      }
    }
  }

  /**
   * The entry checks for every open agent that holds a voucher and owes nothing: the wiring once, the agent per agent. The Borrow
   * button needs a pass (SPEC-PHASE5-APP §6.1 step 4); the click runs the checks again, since the chain can change in between.
   */
  private async entryChecks(account: Address, agents: readonly AgentRaw[], block: bigint): Promise<Record<string, AppError | null>> {
    const candidates = agents.filter((a) => !a.closed && !a.loan.open && a.collateral.length > 0).map((a) => a.address);
    if (candidates.length === 0) return {};
    return checkEntries({ x: this.deps.x, book: this.cfg.book }, candidates, account, block);
  }

  /**
   * Once an agent can borrow, ask the node what its `borrow` costs in gas (the simulation of SPEC-PHASE5-APP §6.0), and
   * keep the OKB it would need for gas. Without a quote, or when the node cannot estimate, the constant of B2 stays.
   */
  private async estimateBorrowGas(account: Address, agents: readonly AgentRaw[], quotes: Record<string, readonly [Quote | null, Quote | null]>, gasPrice: bigint | null): Promise<void> {
    for (const a of agents) {
      const q = quotes[a.address.toLowerCase()]?.[0];
      if (!q || q.reason !== 0) continue;
      try {
        const gas = await this.deps.x.estimateGas({ from: account, to: a.address, data: this.cfg.book.redeploy
          ? encodeFunctionData({ abi: rigAgentAbi, functionName: 'borrow', args: [0, q.maxPrincipal, q.fee, this.pool?.params.lateFeeBpsPerDay ?? 0] })
          : encodeFunctionData({ abi: legacyBorrowAbi, functionName: 'borrow', args: [0, q.maxPrincipal] }), value: q.opsFee });
        this.gasCost = borrowGasCost(gasPrice, gas);
        return;
      } catch {
        /* try the next agent */
      }
    }
  }

  private async readGasPrice(): Promise<bigint | null> {
    if (this.clock() - this.gas.at < GAS_PRICE_EVERY_MS) return this.gas.price;
    try {
      this.gas = { price: await this.deps.x.gasPrice(), at: this.clock() };
    } catch {
      this.gas = { price: this.gas.price, at: this.clock() };
    }
    return this.gas.price;
  }

  private async readKeeper(target: Address | null, gen: number): Promise<void> {
    if (!this.cfg.keeperUrl) return;
    if (this.clock() < this.keeperDownUntil) return;
    const [stats, pos] = await Promise.all([this.deps.keeper.stats(), target ? this.deps.keeper.position(target) : Promise.resolve(null)]);
    if (!stats.reachable && !(pos && pos.reachable)) {
      this.keeperDownUntil = this.clock() + KEEPER_BACKOFF_MS;
      this.keeperView = { ...this.keeperView, reachable: false, apy7d: null };
    } else {
      this.keeperView = { ...this.keeperView, reachable: true, apy7d: stats.data?.apy7d ?? null };
    }
    if (target && pos && gen === this.gen) this.keeperPos = { address: target.toLowerCase(), data: pos.data };
  }

  /** A rig of the account is at §5.2 row 10, 12 (no pass) or 13: its line needs the keeper's registrations (SPEC-PHASE5-REGISTER §7.2). */
  private needsScreens(acct: Acct | null, now: Sec): boolean {
    return this.rigViews(acct, now).some((r) => {
      const s = r.state;
      return r.facts.place.kind === 'wallet' && (s.kind === 'too-new' || s.kind === 'screen-pending' || (s.kind === 'not-screened' && s.why === 'none'));
    });
  }

  /** The registration list, `RigScreen.DELAY()` once, and on the owner page its own chain reads. Never throws. */
  private async readScreens(acct: Acct | null, head: Head): Promise<void> {
    // once per session, for an account's pages (the eligibility card names the delay too, and only as the chain says it)
    if (!acct && !this.wantOwner) return;
    if (!this.screenDelay.read) {
      try {
        this.screenDelay = { value: await readScreenDelay(this.env, head.number), read: true };
      } catch {
        /* read again on the next refresh */
      }
    }
    if (!this.wantOwner && !this.needsScreens(acct, head.timestamp)) return;
    const list = this.deps.keeper.screens;
    if (this.cfg.keeperUrl && list && this.clock() >= this.keeperDownUntil) {
      try {
        const a = await list(this.cfg.book.screen);
        // only a 200 with a list for this RigScreen replaces the last one (L6). Anything else (no answer, a 404 or 5xx, a list
        // for another RigScreen) keeps the last answer until it is a minute old; after that the rig shows the static note (§5)
        if (a.data) this.screens = { view: a.data, at: this.clock() };
      } catch {
        /* keep the last list until it goes stale */
      }
    }
    if (this.wantOwner) {
      const ids = Object.keys(this.screens.view?.records ?? {}).map(Number);
      try {
        this.ownerScreens = { ...(await readOwnerScreens(this.env, head.number, ids)), keeperUrl: this.cfg.keeperUrl };
      } catch {
        this.ownerScreens = null;
      }
    }
  }

  /** A registration the keeper just answered with: shown at once, before the next list read. */
  noteScreen(record: ScreenRecord): void {
    const view = this.screens.view;
    if (!view) return;
    this.screens = { view: { ...view, records: { ...view.records, [String(record.rigId)]: record } }, at: this.screens.at };
    this.emit();
  }

  private seizedIds(agents: readonly AgentRaw[]): Map<string, number[]> {
    const m = new Map<string, number[]>();
    for (const a of agents) {
      if (!a.closed) continue;
      const si = this.history.peekSeized(a.address);
      if (si) m.set(a.address, si.moved);
    }
    return m;
  }

  /** The ids whose self-push price to read: the first agent that can borrow, else one wallet rig. */
  private selfPushIds(agents: readonly AgentRaw[], walletIds: readonly bigint[]): number[] {
    const a = agents.find((x) => !x.closed && !x.loan.open && x.collateral.length > 0);
    if (a) return a.collateral.map(Number);
    const w = walletIds[0];
    return w === undefined ? [] : [Number(w)];
  }

  /** Searches that need history run in the background, one after the other, and never hold up a refresh. */
  private scheduleHistory(agents: readonly AgentRaw[]): void {
    for (const a of agents) {
      if (a.loan.open) {
        const start = Number(a.loan.start);
        if (this.history.peekOpen(a.address, start) === null) this.enqueue(`open:${a.address}:${start}`, async () => {
          if (await this.history.open(a.address, start)) this.emit();
        });
      } else if (a.closed && this.history.peekSeized(a.address) === null) {
        this.enqueue(`closed:${a.address}`, async () => {
          if (await this.history.seized(a.address)) void this.refresh(); // the seized rigs now have ids to read
        });
      }
    }
  }

  private enqueue(key: string, task: () => Promise<void>): void {
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.bg = this.bg.then(async () => {
      try {
        await task();
      } catch {
        /* a failed search shows a dash */
      } finally {
        this.queued.delete(key);
      }
    });
  }

  /**
   * Only a mark left over from before a reload is settled here: an action of this session clears its own mark when it
   * has what it waits for. A sent transaction is looked up on the chain it was sent on (a self-push is on BSC); a
   * keeper request has no hash and simply expires.
   */
  private async checkPending(): Promise<void> {
    const p = this.pendingTx;
    if (!p || !this.restored) return;
    if (!p.hash) {
      if (this.now() - p.since > RESTORED_REQUEST_SEC) this.setPending(null);
      return;
    }
    try {
      const reader = p.chainId === this.cfg.book.bscChainId ? this.deps.b : this.deps.x;
      const r = await reader.receipt(p.hash);
      if (!r) return;
      this.setPending(null);
      this.settledListeners.forEach((l) => l({ action: p.action, success: r.success, hash: p.hash as Hex }));
    } catch {
      /* try again next refresh */
    }
  }

  private loadPending(): PendingTx | null {
    try {
      const raw = this.deps.session?.get(PENDING_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw) as PendingTx;
      return typeof p.action === 'string' && typeof p.since === 'number' ? p : null;
    } catch {
      return null;
    }
  }

  /* ───────── health ───────── */

  private ok(h: Health): void {
    h.ever = true;
    h.failed = false;
    h.at = this.clock();
  }

  private fail(h: Health): void {
    h.failed = true;
  }

  private failAccount(acct: Acct): void {
    for (const h of Object.values(acct.health)) this.fail(h);
    if (acct.wallet === null || acct.holdings === null) acct.bootFailed = true;
  }

  private failEverything(acct: Acct | null): void {
    this.fail(this.poolHealth);
    if (acct) this.failAccount(acct);
    this.emit();
  }

  private isStale(h: Health): boolean {
    return h.ever && (h.failed || (!this.resuming && this.clock() - h.at > STALE_AFTER_MS));
  }

  /* ───────── the snapshot ───────── */

  private assemble(view: Address | null, target: Address | null): Snapshot {
    const now = this.now();
    const acct = this.acct && target && same(this.acct.target, target) ? this.acct : null;
    const stale: Partial<Record<Section, true>> = {};
    if (this.isStale(this.poolHealth)) stale.pool = true;
    if (acct) {
      for (const k of ['wallet', 'rigs', 'loans'] as const) if (this.isStale(acct.health[k])) stale[k] = true;
    }

    const w = this.deps.wallet;
    // while a self-push or a harvest is in progress the wallet is on BNB Smart Chain on purpose: the page must not turn into the gate
    const pushing = (this.pendingTx?.action === 'selfpush' || this.pendingTx?.action === 'harvest') && w.chainId === this.cfg.book.bscChainId;
    const status: WalletStatus = view ? 'view' : !w.account ? 'disconnected' : w.chainId === this.cfg.book.chainId || pushing ? 'connected' : 'wrong-network';
    const rigs = this.rigViews(acct, now);
    const rigMap = new Map(rigs.map((r) => [r.id, r]));
    const agents = acct?.holdings ? mapAgents(acct.holdings.agents) : [];
    for (const a of agents) {
      const key = a.address.toLowerCase();
      if (acct?.holdings?.agents.find((raw) => same(raw.address, a.address))?.loan.open) {
        this.releaseAttempts.delete(key);
        this.deps.session?.remove('tp:release:' + key);
      }
      const attempts = this.releaseAttempts.get(key) ?? Number(this.deps.session?.get('tp:release:' + key) ?? 0);
      a.releaseAttempted = attempts > 0;
      a.releaseRetried = attempts >= 2;
    }
    const loans = this.loansOf(acct, rigMap, now);

    const wallet: WalletView = {
      status,
      account: target,
      bem: acct?.wallet?.bem ?? 0n,
      okb: acct?.wallet?.okb ?? 0n,
      room: acct?.wallet?.room ?? 0n,
      binding: acct?.wallet?.binding,
      borrowGas: this.gasCost,
      allowancePool: acct?.wallet?.allowancePool ?? 0n,
      allowanceAgent: acct?.holdings ? allowanceMap(acct.holdings.agents) : {},
      ...(w.options ? { options: w.options(), active: w.active?.() ?? null, recent: w.recent?.() ?? null } : {}),
    };
    const keeperPosition = this.keeperPos && same(this.keeperPos.address, acct?.target) ? this.keeperPos.data : null;
    const aw = acct?.wallet;
    const position = aw
      ? {
          tpbem: aw.tpbem,
          value: aw.value,
          withdrawable: aw.withdrawable,
          maxDeposit: aw.maxDeposit,
          growth: growthOf(aw.value, keeperPosition, now),
        }
      : null;

    const boot: NonNullable<Snapshot['boot']> = {};
    if (!this.pool) boot.pool = this.poolHealth.failed ? 'failed' : 'loading';
    if (acct && !(acct.wallet && acct.holdings && acct.facts)) boot.account = acct.bootFailed ? 'failed' : 'loading';

    return {
      now,
      boot: boot.pool || boot.account ? boot : undefined,
      wallet,
      pool: this.pool ?? emptyPool(this.cfg),
      rules: { totalVerifWeight: acct?.totalVerifWeight ?? this.totalVerifWeight, emissionValidUntil: this.pins ? Number(this.pins.emissionValidUntil) : 0 },
      position,
      transactions: !this.deps.activityReader && keeperPosition?.transactions && keeperPosition.indexedToTime && now - keeperPosition.indexedToTime <= 300 ? {
        rows: keeperPosition.transactions,
        syncing: false,
      } : acct?.activity.view,
      keeper: { ...this.keeperView, selfPushBnb: acct?.selfPushBnb ?? null },
      rigs,
      agents,
      loans,
      reports: acct?.reports ?? {},
      quotes: acct?.quotes ?? {},
      principalQuotes: true,
      entry: acct?.entry ?? {},
      harvest: this.harvestView(acct),
      // a list older than a minute is not shown: the rig falls back to the static note (SPEC-PHASE5-REGISTER §5)
      screens: this.clock() - this.screens.at <= STALE_AFTER_MS ? this.screens.view : null,
      screenDelay: this.screenDelay.value,
      ownerScreens: this.wantOwner ? this.ownerScreens : undefined,
      pending: this.pendingTx,
      stale,
    };
  }

  /** The bridge fee, the harvest records (read from the store, so a write of this tab or another shows at once) and what a harvest needs. */
  private harvestView(acct: Acct | null): HarvestView {
    const storage = this.gates.available();
    const gates = acct?.facts && storage ? this.gates.all(acct.target, acct.facts.map((f) => f.id)) : {};
    return { headTime: this.head?.timestamp ?? this.now(), feeBps: acct?.feeBps ?? BRIDGE_FEE_BPS_MAX, storage, gates, prep: acct?.prep ?? null };
  }

  private rigViews(acct: Acct | null, now: Sec): RigView[] {
    return acct?.facts ? acct.facts.map((f) => buildRigView(f, now)) : [];
  }

  private loansOf(acct: Acct | null, rigs: ReadonlyMap<number, RigView>, now: Sec): LoanView[] {
    if (!acct?.holdings || !this.pool) return [];
    const out: LoanView[] = [];
    const rules = { totalVerifWeight: acct.totalVerifWeight ?? this.totalVerifWeight, emissionValidUntil: this.pins ? Number(this.pins.emissionValidUntil) : 0 };
    for (const a of acct.holdings.agents) {
      const key = a.address.toLowerCase();
      const collateral = a.collateral.map(Number).sort((x, y) => x - y);
      if (a.loan.open) {
        const loan = buildOpenLoan({ agent: a.address, raw: a.loan, agentBem: a.bem, now, collateral, rigs, rules, params: this.pool.params, info: this.history.peekOpen(a.address, Number(a.loan.start)) });
        this.lastOpen.set(key, loan);
        this.cleared.delete(key);
        out.push(loan);
      } else if (a.closed) {
        const si = this.history.peekSeized(a.address);
        if (si) out.push(buildSeizedLoan(a.address, si, rigs));
      } else {
        const c = this.cleared.get(key);
        if (c && collateral.length > 0) out.push({ ...c, agentBem: a.bem });
        else if (c) this.cleared.delete(key); // the voucher left the agent: nothing more to say about that loan
      }
    }
    return out;
  }
}

/** The newest report's network weight, for when BSC cannot be read. */
function newestTotal(xl: ReadonlyMap<number, XLayerRig>): bigint | null {
  let best: { at: bigint; total: bigint } | null = null;
  for (const x of xl.values()) if (x.report && x.report.totalVerifWeight !== 0n && (best === null || x.report.observedAt > best.at)) best = { at: x.report.observedAt, total: x.report.totalVerifWeight };
  return best?.total ?? null;
}

/** Placeholder for the instant before the pool is read; the page shows a loading card instead of these zeros. */
function emptyPool(cfg: AppConfig): PoolView {
  const b = cfg.book;
  return {
    totalAssets: 0n,
    outstanding: 0n,
    idle: 0n,
    doubtful: 0n,
    params: { feeBps: [0, 0], maxDebtBps: [0, 0], termDays: [7, 14], minFee: 0n, minAdvance: 0n, lateFeeBpsPerDay: 0, perBorrowerBps: 0, borrowCapBps: 0, borrowCapAbs: 0n, supplyCap: 0n, opsFee: [0n, 0n] },
    tpbemValue: 0n,
    borrowsPaused: false,
    feedDisabled: false,
    pendingPolicy: null,
    queued: [],
    circuit: { processorName: '', processorSymbol: '', circuits: b.policy, circuitId: 0, gates: 0, netlistHash: '0x' },
    contracts: { pool: b.pool, factory: b.factory, policy: b.policy, screen: b.screen, bem: b.bem, voucher: b.voucher },
  };
}

/** The log searches over a `Reader`. */
export function chainForHistory(x: Reader): HistoryChain {
  const events = rigAgentAbi.filter((i) => i.type === 'event' && (i.name === 'Borrowed' || i.name === 'OpsFeePaid' || i.name === 'Seized'));
  return {
    head: () => x.head(),
    blockTime: (n) => x.blockTime(n),
    async closedAt(agent, block) {
      const out = await x.call(agent, encodeFunctionData({ abi: rigAgentAbi, functionName: 'closed' }), { block });
      // before the agent existed, a call to its address answers with no data: it was not closed
      if (out === '0x') return false;
      return decodeFunctionResult({ abi: rigAgentAbi, functionName: 'closed', data: out }) as boolean;
    },
    async loanAt(agent, block) {
      try {
        const out = await x.call(agent, encodeFunctionData({ abi: rigAgentAbi, functionName: 'loanOf' }), { block });
        return decodeFunctionResult({ abi: rigAgentAbi, functionName: 'loanOf', data: out }) as unknown as LoanRaw;
      } catch {
        return null;
      }
    },
    async logs(agent, from, to) {
      const logs = await x.logs({ address: agent, events: events as never, fromBlock: from, toBlock: to });
      return logs.flatMap((l): HistoryLog[] => {
        const a = l.args as Record<string, bigint | bigint[]>;
        if (l.eventName === 'Borrowed') return [{ name: 'Borrowed' as const, block: l.blockNumber, fee: a.fee as bigint, principal: a.principal as bigint, maturity: a.maturity as bigint }];
        if (l.eventName === 'OpsFeePaid') return [{ name: 'OpsFeePaid' as const, block: l.blockNumber, amount: a.amount as bigint }];
        if (l.eventName === 'Seized') return [{ name: 'Seized' as const, block: l.blockNumber, moved: [...(a.movedIds as bigint[])], stuck: [...(a.stuckIds as bigint[])], writtenOff: a.writtenOff as bigint }];
        return [];
      });
    },
  };
}
