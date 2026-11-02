import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, type Abi } from 'viem';
import type { AppConfig } from '../config';
import { BOND, BRIDGE_FEE_BPS_MAX, MAX_COLLATERAL, MAX_HARVEST_VALUE } from '../constants';
import { t } from '../i18n';
import { bem4, bemTrim, fmtUnits, native, shortAddr } from '../logic/format';
import { timely } from '../logic/borrow';
import { blocksHarvest, gateOpen, isStuck, observeDrop, promptingRecord } from '../logic/gates';
import { collectable, landed, minedR, shareRequired } from '../logic/harvest';
import type { LoanRaw } from '../logic/loan';
import type { Address, Ask, Hex, PrincipalQuote } from '../model';
import type { ActionResult, Actions, BorrowArgs, MoveOptions } from '../source';
import { agentFactoryAbi, bscVaultAbi, erc20Abi, multicall3Abi, rigAgentAbi, tapePoolAbi, voucherAbi, reporterAbi } from './abi';
import { readBsc, type KeyCache } from './bsc';
import { checkAgent, checkWiring, type CheckEnv } from './checks';
import { KEEPER_SELF_PUSH, type AppError, type HarvestWhy, type MsgParams } from './errors';
import { reportTimes, requestPush, waitForReports, WAIT_POLL_MS, WAIT_REPORT_MS, type WaitDeps } from './feedWait';
import { GateStore } from './gates';
import { harvestedAmounts, readContracts, readPayees } from './harvest';
import { call, multicall, type Result } from './multicall';
import { legacyBorrowAbi } from './legacyAbi';
import { decodeRevert, revertDataOf } from './revert';
import { readQuoteFor, type ReadEnv } from './reads';
import type { Reader, ReceiptInfo } from './reader';
import { TxRunner, type ActionHost, type TxResult } from './tx';
import type { WalletPort, WalletResult } from './wallet';
import { memoryStore } from '../logic/history';

/**
 * The buttons that reach the wallet (SPEC-PHASE5-APP §6). Every write goes through `TxRunner`: right chain, simulate
 * first, say what the wallet will ask, wait for one confirmation, read the chain again, never retry.
 *
 * Entry actions (supply, create, move, borrow) run the entry checks of §10 first. Exits (repay, withdraw, release,
 * claim late, sweep, take back) never do: the one exception is the agent-identity check before the approval of a
 * repayment, because that approval names the agent as spender.
 */

export interface WalletApi extends WalletPort {
  /** With an `id` from the picker, connect through that wallet; without one, the wallet already in use or the preferred one. */
  connect(id?: string): Promise<WalletResult>;
  disconnect(): void;
  /** Look for wallets again (one that announces itself late). */
  scan?(): Promise<void>;
}

export interface ActionsDeps {
  wallet: WalletApi;
  x: Reader;
  b: Reader;
  config: AppConfig;
  host: ActionHost;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds. */
  clock?: () => number;
  /** The harvest records (SPEC-PHASE5-PRELOAN §4.4): the same ones the data source reads. */
  gates?: GateStore;
}

const ZERO = '0x0000000000000000000000000000000000000000';

function fromWallet(r: WalletResult, done: () => string): ActionResult {
  if (r.ok) return { ok: true, notice: done };
  if (r.noWallet) return { ok: false, notice: () => t('No wallet found. Install OKX Wallet, MetaMask or Rabby, then reload.', '未检测到钱包。请安装 OKX Wallet、MetaMask 或 Rabby 后刷新页面。') };
  return { ok: false, error: r.error ?? { kind: 'unknown', details: 'The wallet did not answer.' } };
}

const fail = (error: AppError, extra: Partial<ActionResult> = {}): ActionResult => ({ ok: false, error, ...extra });

const fmtIds = (ids: readonly number[]): string => ids.map((i) => `#${i}`).join(', ');
/** BNB to add, rounded up to four places so that adding it is enough. */
const bnbCeil = (wei: bigint): string => fmtUnits(wei, 18, 4, 'ceil');

const okbText = (wei: bigint): string => (wei === 0n ? '0 OKB' : `${native(wei)} OKB`);
const bnbText = (wei: bigint): string => (wei === 0n ? '0 BNB' : `${native(wei, 4, 6)} BNB`);

/** The decoded events of a receipt that belong to `abi`; logs of other contracts or events are skipped. */
function eventsOf(receipt: ReceiptInfo, abi: Abi, address?: Address): { name: string; args: Record<string, unknown> }[] {
  const out: { name: string; args: Record<string, unknown> }[] = [];
  for (const l of receipt.logs ?? []) {
    if (address && l.address.toLowerCase() !== address.toLowerCase()) continue;
    try {
      const e = decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      out.push({ name: e.eventName ?? '', args: (e.args ?? {}) as Record<string, unknown> });
    } catch {
      /* not an event of this ABI */
    }
  }
  return out;
}

export class ChainActions implements Actions {
  private readonly tx: TxRunner;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => number;
  private readonly wallet: WalletApi;
  private readonly x: Reader;
  private readonly b: Reader;
  private readonly cfg: AppConfig;
  private readonly host: ActionHost;
  private readonly doFetch: typeof fetch | undefined;
  private readonly gates: GateStore;
  /** `minerKey` is a pure function of (processor, circuit id), so each key is read once. */
  private readonly keys: KeyCache = new Map();
  private readonly releaseAttempts = new Map<string, number>();

  constructor(deps: ActionsDeps) {
    this.gates = deps.gates ?? new GateStore(memoryStore(), deps.config.book.chainId);
    this.wallet = deps.wallet;
    this.x = deps.x;
    this.b = deps.b;
    this.cfg = deps.config;
    this.host = deps.host;
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.clock = deps.clock ?? (() => performance.now());
    this.doFetch = deps.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
    this.tx = new TxRunner({ wallet: deps.wallet, x: deps.x, b: deps.b, book: deps.config.book, host: deps.host, sleep: this.sleep, clock: this.clock });
  }

  private get book() {
    return this.cfg.book;
  }

  private get env(): CheckEnv {
    return { x: this.x, book: this.book };
  }

  private get readEnv(): ReadEnv {
    return { x: this.x, book: this.book, lens: this.cfg.tapeLens };
  }

  private account(): Address | null {
    return this.wallet.account;
  }

  private waitDeps(): WaitDeps {
    return { x: this.x, book: this.book, sleep: this.sleep, clock: this.clock };
  }

  private ask(contract: string, at: Address, fn: string, value = '0 OKB'): Ask {
    return { contract: `${contract} ${shortAddr(at)}`, fn, value };
  }

  /** Turn a failed `TxResult` into an `ActionResult`. */
  private failed(r: Extract<TxResult, { ok: false }>): ActionResult {
    if (r.waiting) {
      return { ok: false, notice: () => t('Your transaction is sent but not confirmed yet. This page updates when it lands.', '交易已发送但尚未确认，确认后此页面会自动更新。') };
    }
    return fail(r.error ?? { kind: 'unknown', details: 'The transaction did not complete.' });
  }

  /* ───────── the wallet ───────── */

  async connect(id?: string): Promise<ActionResult> {
    const r = await this.wallet.connect(id);
    // a wallet chosen in the picker that has gone since is an error the picker can show; with no choice it is the old notice
    if (id !== undefined && !r.ok && r.noWallet) return fail({ kind: 'no-wallet' });
    return fromWallet(r, () => t('Wallet connected.', '钱包已连接。'));
  }

  async rescanWallets(): Promise<void> {
    try {
      await this.wallet.scan?.();
    } catch {
      /* the list stays as it was */
    }
  }

  async disconnect(): Promise<ActionResult> {
    this.wallet.disconnect();
    return { ok: true, notice: () => t('Wallet disconnected.', '钱包已断开。') };
  }

  async switchNetwork(): Promise<ActionResult> {
    return fromWallet(await this.wallet.switchTo('xlayer'), () => t('Switched to X Layer.', '已切换到 X Layer。'));
  }

  /* ───────── the borrow flow (§6.1) ───────── */

  /** Step 1: `AgentFactory.create(index)` with the first free index. */
  async createAgent(): Promise<ActionResult> {
    const me = this.account();
    if (!me) return fail({ kind: 'unknown', details: 'The wallet is not connected.' });
    const bad = await checkWiring(this.env, { borrow: false });
    if (bad) return fail(bad);
    const { factory, multicall3 } = this.book;
    let index: bigint;
    let predicted: Address;
    try {
      const [mine] = await multicall(this.x, multicall3, [call<readonly Address[]>(factory, agentFactoryAbi, 'agentsOf', [me])] as const);
      if (!mine.ok) throw new Error('agentsOf');
      // the first number, counting up from how many agents there are, whose address has no code yet
      let i = BigInt(mine.value.length);
      let found: Address | null = null;
      for (let tries = 0; tries < 16 && found === null; tries++, i++) {
        const [p] = await multicall(this.x, multicall3, [call<Address>(factory, agentFactoryAbi, 'predictAgent', [me, i])] as const);
        if (!p.ok) throw new Error('predictAgent');
        if ((await this.x.getCode(p.value)) === '0x') found = p.value;
      }
      if (found === null) throw new Error('no free agent number');
      predicted = found;
      index = i - 1n;
    } catch {
      return fail({ kind: 'unknown', details: 'Could not find a free number for the new Rig Agent.' });
    }
    const r = await this.tx.run({
      chain: 'xlayer',
      to: factory,
      data: encodeFunctionData({ abi: agentFactoryAbi, functionName: 'create', args: [index] }),
      value: 0n,
      action: 'create',
      ask: this.ask('AgentFactory', factory, `create(${index})`),
    });
    if (!r.ok) return this.failed(r);
    const created = eventsOf(r.receipt, agentFactoryAbi as unknown as Abi, factory).find((e) => e.name === 'AgentCreated');
    const agent = typeof created?.args.agent === 'string' ? getAddress(created.args.agent) : predicted;
    return { ok: true, agent, notice: () => t('Rig Agent created.', '矿机代理已创建。') };
  }

  /**
   * Step 2: `voucher.safeTransferFrom(you, agent, id)`, one transaction per rig. Never a plain `transferFrom`: the hook adds the collateral.
   *
   * Two rules are enforced HERE, by voucher id, from fresh reads, whatever page, selection or reload led to this call
   * (SPEC-PHASE5-PRELOAN §4.1, §4.4): the move gate of a harvest that was sent for the voucher, and the requirement to choose
   * about the BEM it mined before the loan. A disabled button is not enough: if the voucher reached the agent before the
   * harvest's BSC time had passed on X Layer, the harvested BEM would be paid to the agent and would repay the loan.
   */
  async moveVouchers(agent: Address, ids: number[], o: MoveOptions): Promise<ActionResult> {
    const me = this.account();
    if (!me) return fail({ kind: 'unknown', details: 'The wallet is not connected.' });
    const bad = (await checkWiring(this.env, { borrow: false })) ?? (await checkAgent(this.env, agent, me));
    if (bad) return fail(bad);
    const loan = await this.noOpenLoan(agent);
    if (loan) return loan;
    // every id is checked before the first prompt: the gate first, from X Layer's head, then the requirement
    const closed = await this.gateRefusal(me, ids, o.via);
    if (closed) return closed;
    const asked = await this.requirementRefusal(ids, o);
    if (asked) return asked;
    const { voucher } = this.book;
    for (const id of ids) {
      const loan = await this.noOpenLoan(agent);
      if (loan) return loan;
      let owner: Address | null = null;
      try {
        const [own] = await multicall(this.x, this.book.multicall3, [call<Address>(voucher, voucherAbi, 'ownerOf', [BigInt(id)])] as const);
        owner = own.ok ? own.value : null;
      } catch {
        owner = null;
      }
      if (owner === null || owner.toLowerCase() !== me.toLowerCase()) return fail({ kind: 'revert', name: 'ERC721IncorrectOwner' });
      // and again just before the prompt of its own: an earlier transfer takes time, and X Layer's clock is the one that decides
      const again = await this.gateRefusal(me, [id], o.via);
      if (again) return again;
      const r = await this.tx.run({
        chain: 'xlayer',
        to: voucher,
        data: encodeFunctionData({ abi: voucherAbi, functionName: 'safeTransferFrom', args: [me, agent, BigInt(id)] }),
        value: 0n,
        action: 'move',
        ask: this.ask('RIG voucher', voucher, `safeTransferFrom(you, ${shortAddr(agent)}, #${id})`),
      });
      if (!r.ok) return this.failed(r);
      this.noteMoved(me, id, r.receipt.blockNumber);
    }
    return { ok: true, notice: () => (ids.length === 1 ? t('Voucher moved into the agent.', '凭证已转入矿机代理。') : t('Vouchers moved into the agent.', '凭证已转入矿机代理。')) };
  }

  /**
   * The move gate (SPEC-PHASE5-PRELOAN §4.4), read fresh: the head of X Layer, never the page's clock, and the records as they
   * are in storage now. A voucher without a record, or whose record is passed, moved or void, may go; a `final` record goes once
   * the head is later than the harvest's BSC time plus the margin. With `via: 'stuck'` a harvest that has waited for more than ten
   * minutes is given up on, which deletes its record: the user was told the pending harvest may then repay the loan.
   */
  private async gateRefusal(me: Address, ids: readonly number[], via: MoveOptions['via']): Promise<ActionResult | null> {
    let now: number;
    try {
      now = (await this.x.head()).timestamp;
    } catch {
      return fail({ kind: 'harvest', why: 'unreadable' }); // the clock cannot be read: the gate fails closed
    }
    let waiting = false;
    for (const id of ids) {
      let rec = this.gates.get(me, id);
      if (rec && via === 'stuck' && isStuck(rec, now)) {
        this.gates.remove(me, id);
        continue;
      }
      if (rec && rec.state === 'final' && gateOpen(rec, now)) rec = this.gates.put({ ...rec, state: 'passed' });
      if (!gateOpen(rec, now)) waiting = true;
    }
    if (!waiting) return null;
    await this.host.refresh();
    return { ok: false, notice: () => t('Waiting for the harvest to settle on BSC…', '正在等待 BSC 上的领取交易最终确认…') };
  }

  /**
   * The requirement of §4.1 again, from a fresh read of the BEM these rigs mined at a pinned BSC block: when it is at least the
   * bond and at least a tenth of the debt on screen, the user must have chosen to keep it in the loan (or to move anyway past a
   * harvest that never settled). A read that fails is refused unless the user already accepted that mined BEM goes to the loan.
   * The "Move anyway" of a read that failed does not stand for a read that now succeeds and shows a required choice.
   */
  private async requirementRefusal(ids: readonly number[], o: MoveOptions): Promise<ActionResult | null> {
    let read: Awaited<ReturnType<typeof readBsc>> | null = null;
    try {
      read = await readBsc(this.b, this.book, ids, this.keys);
    } catch {
      read = null;
    }
    const rigs = ids.map((id) => ({ id, mined: read?.facts.get(id)?.mined ?? null }));
    const unknown = rigs.filter((r) => r.mined === null).map((r) => r.id);
    const accepted = o.via === 'keep' || o.via === 'stuck';
    if (unknown.length > 0) {
      if (accepted || o.via === 'read-failed') return null;
      await this.host.refresh();
      return fail({ kind: 'harvest', why: 'mined-unreadable', params: { ids: fmtIds(unknown) } });
    }
    const required = collectable(rigs) >= BOND && shareRequired(landed(rigs, read?.feeBps ?? BRIDGE_FEE_BPS_MAX), o.debt);
    if (!required || accepted) return null;
    await this.host.refresh(); // the screen shows the choice
    return fail({ kind: 'harvest', why: 'choose' });
  }

  /** Remember the block a voucher moved at, so the check after the move reads the `Paid` logs from there. */
  private noteMoved(me: Address, id: number, block: bigint): void {
    const rec = this.gates.get(me, id);
    if (rec && (rec.state === 'final' || rec.state === 'passed')) this.gates.put({ ...rec, movedBlock: block, cursor: block });
  }

  /**
   * §4.7: rigs that are in the agent with BEM mined before the loan go back to the wallet to be harvested: `withdrawVoucher(id)`
   * for each. It is an exit, so no entry check runs. The agent stays the flow's agent; the harvest then waits for BSC time to
   * pass the moment each voucher came back (precondition 3 of `harvestFirst`).
   */
  async takeBackToHarvest(agent: Address, ids: number[]): Promise<ActionResult> {
    for (const id of ids) {
      const r = await this.tx.run({ chain: 'xlayer', to: agent, data: encodeFunctionData({ abi: rigAgentAbi, functionName: 'withdrawVoucher', args: [BigInt(id)] }), value: 0n, action: 'take-back', ask: this.ask('RigAgent', agent, `withdrawVoucher(#${id})`) });
      if (!r.ok) return this.failed(r);
    }
    const lead = ids[0] ?? 0;
    return { ok: true, agent, reuse: true, flash: { kind: 'released', rigId: lead, ids: [...ids] }, notice: () => t('Voucher sent to your wallet.', '凭证已转回您的钱包。') };
  }

  /**
   * "Harvest it to my wallet first" (SPEC-PHASE5-PRELOAN §4.3): `RigVault.harvest(ids)` on BSC, sent from the user's wallet, so
   * that the BEM the rigs mined is paid to the wallet and not to the agent. It reuses what the self-push does (the pending mark,
   * the switch to BSC and back, the simulation, the line for the wallet), and adds a record per voucher that is written before
   * the wallet is asked and decides when the voucher may move.
   */
  async harvestFirst(ids: number[], agent: Address | null): Promise<ActionResult> {
    const me = this.account();
    if (!me) return fail({ kind: 'unknown', details: 'The wallet is not connected.' });
    const list = [...new Set(ids)].sort((a, b) => a - b);
    const refuse = (why: HarvestWhy, params?: MsgParams): ActionResult => fail({ kind: 'harvest', why, params });
    if (list.length === 0 || list.length > MAX_COLLATERAL) return refuse('sub-bond');
    const { bscVault, bemBsc, voucher, multicall3 } = this.book;

    // 0. the entry checks: the pool and the credit rule, and the agent when there is one
    const bad = (await checkWiring(this.env, { borrow: true })) ?? (agent ? await checkAgent(this.env, agent, me) : null);
    if (bad) return fail(bad);
    if (!this.gates.available()) return refuse('storage');

    // 1. a harvest of the same voucher is never sent while the first is unresolved
    if (list.some((id) => blocksHarvest(this.gates.get(me, id)?.state ?? 'void'))) return refuse('busy');

    // 2. TapeOut's contracts are as reviewed, and borrows are open on the pool
    let contracts: 'ok' | 'changed' | null;
    let pool: { borrowsPaused: boolean; feedDisabled: boolean; pendingPolicy: string } | null;
    try {
      const [stats] = await multicall(this.x, multicall3, [call<{ borrowsPaused: boolean; feedDisabled: boolean; pendingPolicy: string }>(this.book.pool, tapePoolAbi, 'stats')] as const);
      pool = stats.ok ? stats.value : null;
      contracts = await readContracts(this.x, this.b, this.book);
    } catch {
      return refuse('unreadable');
    }
    if (contracts === 'changed') return refuse('contracts');
    if (contracts === null || pool === null) return refuse('unreadable');
    if (pool.borrowsPaused || pool.feedDisabled || !/^0x0{40}$/.test(pool.pendingPolicy)) return refuse('paused');

    // 3. the wallet still holds every voucher, and its own mark is in the past for BSC
    try {
      const owners = await multicall(this.x, multicall3, list.map((id) => call<Address>(voucher, voucherAbi, 'ownerOf', [BigInt(id)])));
      if (owners.some((r) => !r.ok || r.value.toLowerCase() !== me.toLowerCase())) {
        await this.host.refresh();
        return fail({ kind: 'revert', name: 'ERC721IncorrectOwner' });
      }
    } catch {
      return refuse('unreadable');
    }

    // 4. one pinned BSC block: what each rig holds now, the price, the balances. A refusal here is decided from this read, never from a revert.
    let read: Awaited<ReturnType<typeof readBsc>>;
    let pinTime: number;
    try {
      read = await readBsc(this.b, this.book, list, this.keys);
      pinTime = await this.b.blockTime(read.block);
    } catch {
      return refuse('unreadable');
    }
    const rigs = list.map((id) => ({ id, mined: read.facts.get(id)?.mined ?? null }));
    if (rigs.some((r) => r.mined === null)) return refuse('unreadable');
    let payees: Map<number, Address | null>;
    try {
      payees = await readPayees(this.x, this.book, list, pinTime);
    } catch {
      return refuse('unreadable');
    }
    if (list.some((id) => payees.get(id) === null || payees.get(id) === undefined)) return refuse('unreadable');
    if (list.some((id) => (payees.get(id) as Address).toLowerCase() !== me.toLowerCase())) return refuse('mark');
    if (collectable(rigs) < BOND) {
      // the screen offered this harvest because the rigs held at least the bond, so someone harvested them meanwhile: a record
      // for a harvest the app did not send keeps the gate honest (its time is the pinned block's, an upper bound for it)
      const now = this.host.now();
      for (const id of list) this.observe(me, id, read.block, pinTime, now);
      await this.host.refresh();
      return refuse('sub-bond');
    }
    let quote: bigint;
    let bnb: bigint;
    let bem: bigint;
    let allowance: bigint;
    try {
      const rows = await multicall(
        this.b,
        multicall3,
        [
          call<bigint>(bscVault, bscVaultAbi, 'quoteHarvest', [BigInt(list.length)]),
          call<bigint>(multicall3, multicall3Abi, 'getEthBalance', [me]),
          call<bigint>(bemBsc, erc20Abi, 'balanceOf', [me]),
          call<bigint>(bemBsc, erc20Abi, 'allowance', [me, bscVault]),
        ] as const,
        { block: read.block },
      );
      const [q, ethBal, bemBal, allow] = rows;
      if (!q.ok || !ethBal.ok || !bemBal.ok || !allow.ok) return refuse('unreadable');
      quote = q.value;
      bnb = ethBal.value;
      bem = bemBal.value;
      allowance = allow.value;
    } catch {
      return refuse('unreadable');
    }

    // 5. the value is the quote plus 10%, never above the hard cap
    const value = (quote * 11n) / 10n;
    if (value > MAX_HARVEST_VALUE) return refuse('cap', { bnb: native(value, 4, 6) });

    // 6. simulate with that value, and estimate the gas; the BNB must cover both
    if (bnb < value) return refuse('bnb-short', { bnb: bnbCeil(value - bnb) });
    const data = encodeFunctionData({ abi: bscVaultAbi, functionName: 'harvest', args: [list.map(BigInt)] });
    const bond = allowance >= BOND && bem >= BOND;
    const prepared = {
      chain: 'bsc' as const,
      to: bscVault,
      data,
      value,
      action: 'harvest' as const,
      ask: { ...this.ask('RigVault', bscVault, `harvest([${list.map((i) => `#${i}`).join(', ')}])`, bnbText(value)), ...(bond ? { note: 'bond' as const } : {}) },
      revert: { action: 'harvest' as const },
    };
    const sim = await this.tx.preview(prepared, me);
    if (!sim.ok) {
      await this.host.refresh(); // a changed fee shows its new price
      return fail(sim.error);
    }
    let gasPrice: bigint | null = null;
    try {
      gasPrice = await this.b.gasPrice();
    } catch {
      gasPrice = null;
    }
    if (sim.gas !== null && gasPrice !== null) {
      const need = value + (sim.gas * 12n * gasPrice) / 10n;
      if (bnb < need) return refuse('bnb-short', { bnb: bnbCeil(need - bnb) });
    }

    // the steps: the pending mark, BSC, the line for the wallet, the records, the wallet, the receipt, back to X Layer
    const since = this.host.now();
    this.host.setPending({ action: 'harvest', since, hash: null, chainId: this.book.bscChainId });
    let moved = false;
    try {
      if ((await this.wallet.readChainId()) !== this.book.bscChainId) {
        const sw = await this.wallet.switchTo('bsc');
        if (!sw.ok) return fromWallet(sw, () => '');
        moved = true;
      }
      const base = (id: number) => ({ block: read.block, mined: minedR(rigs.find((r) => r.id === id)?.mined ?? 0n) });
      const r = await this.tx.run(prepared, {
        keepPending: true,
        // before the wallet prompt opens: a popup can outlive a reload, and a wallet can throw after it has sent the transaction
        beforePrompt: () => {
          const written: number[] = [];
          for (const id of list) {
            if (this.gates.begin(promptingRecord(id, me, this.host.now(), base(id)))) written.push(id);
            else {
              for (const w of written) this.gates.remove(me, w);
              return false;
            }
          }
          return true;
        },
        // the wallet answered with a hash: the records say so, and take the nonce from the transaction itself
        onHash: async (hash) => {
          const nonce = await this.nonceOf(hash);
          for (const id of list) {
            const rec = this.gates.get(me, id);
            if (rec) this.gates.put({ ...rec, state: 'in-flight', hash, nonce });
          }
        },
      });
      if (!r.ok) {
        // only a rejection in the wallet proves nothing was sent: any other error leaves the records `prompting` (or `in-flight`)
        if (r.error?.kind === 'wallet-rejected') {
          for (const id of list) {
            const rec = this.gates.get(me, id);
            if (rec?.state === 'prompting' && rec.hash === null) this.gates.remove(me, id);
          }
        } else if (r.hash && r.error) {
          for (const id of list) this.settleVoid(me, id);
        }
        const kept = list.filter((id) => this.gates.get(me, id) !== undefined && this.gates.get(me, id)?.state !== 'void');
        const out = this.failed(r);
        return kept.length > 0 ? { ...out, decided: kept } : out;
      }
      // a receipt: the time of its block is `T_h`, and the vault says what it sent for each rig
      let harvestedAt: number | null = null;
      try {
        harvestedAt = await this.b.blockTime(r.receipt.blockNumber);
      } catch {
        harvestedAt = null; // the refresh reads it again from the receipt
      }
      const sent = harvestedAmounts(r.receipt, bscVault);
      for (const id of list) {
        const rec = this.gates.get(me, id);
        if (rec) this.gates.put({ ...rec, state: 'mined', block: r.receipt.blockNumber, harvestedAt, amount: sent.get(id) ?? null });
      }
      return {
        ok: true,
        decided: list,
        notice: () => t('Harvest sent on BSC. The BEM usually reaches your wallet on X Layer in about a minute. Move the voucher once the step below turns on, usually within a minute.', '已在 BSC 上发起领取。BEM 通常约一分钟后到达您在 X Layer 上的钱包。下方步骤可用后即可转入凭证，通常在一分钟内。'),
      };
    } finally {
      // back to X Layer whatever happened; a wallet that refuses leaves the wrong-network button on the page
      if (moved || (await this.wallet.readChainId()) === this.book.bscChainId) await this.wallet.switchTo('xlayer');
      this.host.setPending(null);
      await this.host.refresh();
    }
  }

  /** A harvest the app did not send, seen as a rig that is empty now: the same record the refresh writes for a drop. */
  private observe(me: Address, id: number, block: bigint, time: number, now: number): void {
    const rec = observeDrop(this.gates.get(me, id), { id, wallet: me, block, time, now });
    if (rec) this.gates.put(rec);
  }

  /** A reverted harvest moved nothing. */
  private settleVoid(me: Address, id: number): void {
    const rec = this.gates.get(me, id);
    if (rec && rec.state === 'in-flight') this.gates.put({ ...rec, state: 'void' });
  }

  /** The nonce of a transaction, from the transaction itself through the wallet's own provider (still on BSC). Null when it does not say. */
  private async nonceOf(hash: Hex): Promise<number | null> {
    try {
      const tx = (await this.wallet.eip1193?.request({ method: 'eth_getTransactionByHash', params: [hash] })) as { nonce?: unknown } | null | undefined;
      return typeof tx?.nonce === 'string' ? Number(BigInt(tx.nonce)) : null;
    } catch {
      return null;
    }
  }

  /** Step 3 through the keeper: ask for a push, then wait until every report is timely. */
  async refreshRigData(agent: Address, ids: number[]): Promise<ActionResult> {
    const since = this.host.now();
    this.host.setPending({ action: 'refresh', since, hash: null });
    try {
      const answer = await requestPush(this.cfg.keeperUrl, agent, this.doFetch);
      if (answer.status === 'unreachable') return fail({ kind: 'keeper', reason: 'unreachable' }, { offerSelfPush: true });
      if (answer.status === 'refused') {
        return fail({ kind: 'keeper', reason: answer.reason }, { offerSelfPush: KEEPER_SELF_PUSH.includes(answer.reason) });
      }
      // fresh or queued: either way the reports must be timely by chain time before the borrow button can turn on
      const ok = await waitForReports(this.waitDeps(), ids, { timeoutMs: WAIT_REPORT_MS, pollMs: WAIT_POLL_MS });
      if (!ok) return fail({ kind: 'keeper', reason: 'timeout' }, { offerSelfPush: true });
      return { ok: true, notice: () => t('Rig data is fresh. Borrow within 5 minutes.', '矿机数据已更新，请在 5 分钟内完成借款。') };
    } finally {
      this.host.setPending(null);
      await this.host.refresh();
    }
  }

  /**
   * Step 3 on BSC: show the cost, switch to BSC, `RigReporter.push(ids)` with the quote plus 10% (the endpoint
   * refunds the excess), wait for the report on X Layer, switch back. The pending mark stays set from the start to the
   * end so the wrong-network gate does not replace the page while the wallet is on BSC.
   */
  async selfPush(ids: number[]): Promise<ActionResult> {
    const me = this.account();
    if (!me) return fail({ kind: 'unknown', details: 'The wallet is not connected.' });
    const { reporter } = this.book;
    const since = this.host.now();
    const quote = async (list: number[]): Promise<bigint> => decodeFunctionResult({ abi: reporterAbi, functionName: 'quote', data: await this.b.call(reporter, encodeFunctionData({ abi: reporterAbi, functionName: 'quote', args: [list.map(BigInt)] })) });
    const unreadable = (e: unknown): boolean => {
      const data = revertDataOf(e);
      const err = data ? decodeRevert(data) : null;
      return err?.kind === 'revert' && err.name === 'CustodyUnreadable';
    };
    let single = false;
    let batchQuote: bigint;
    try {
      batchQuote = await quote(ids);
    } catch (e) {
      if (!unreadable(e)) return fail({ kind: 'quote', reason: 4 });
      single = true;
      batchQuote = 0n;
    }
    this.host.setPending({ action: 'selfpush', since, hash: null, chainId: this.book.bscChainId });
    let moved = false;
    const skipped: number[] = [];
    const sent: number[] = [];
    let total = 0n;
    try {
      for (const list of single ? ids.map((id) => [id]) : [ids]) {
        let cost = batchQuote;
        if (single) {
          try { cost = await quote(list); }
          catch (e) {
            if (!unreadable(e)) return fail({ kind: 'quote', reason: 4 });
            skipped.push(...list);
            continue;
          }
        }
        if ((await this.wallet.readChainId()) !== this.book.bscChainId) {
          const sw = await this.wallet.switchTo('bsc');
          if (!sw.ok) return fromWallet(sw, () => '');
          moved = true;
        }
        const value = (cost * 11n) / 10n;
        const r = await this.tx.run({
          chain: 'bsc', to: reporter,
          data: encodeFunctionData({ abi: reporterAbi, functionName: 'push', args: [list.map(BigInt)] }),
          value, action: 'selfpush',
          ask: this.ask('RigReporter', reporter, `push([${list.map((i) => `#${i}`).join(', ')}])`, bnbText(value)),
        }, { keepPending: true });
        if (!r.ok) return this.failed(r);
        sent.push(...list);
        total += value;
        let pushedAt = 0;
        try { pushedAt = await this.b.blockTime(r.receipt.blockNumber); } catch { /* latest timely report */ }
        const arrived = await waitForReports(this.waitDeps(), list, { timeoutMs: WAIT_REPORT_MS, pollMs: WAIT_POLL_MS, notBefore: pushedAt });
        if (!arrived) return fail({ kind: 'report-late' });
      }
      if (!sent.length) return fail({ kind: 'revert', name: 'CustodyUnreadable', params: { ids: fmtIds(skipped) } });
      return {
        ok: true,
        notice: () => skipped.length
          ? t(`Pushed ${fmtIds(sent)}. Custody cannot be read for ${fmtIds(skipped)}; those rigs cannot back a loan now.`, `已推送 ${fmtIds(sent)}。无法读取 ${fmtIds(skipped)} 的托管状态，暂时不能用这些矿机借款。`)
          : t(`Pushed on BSC from your wallet (about ${native(total, 4, 4)} BNB). Borrow within 5 minutes.`, `已从您的钱包在 BSC 上推送（约 ${native(total, 4, 4)} BNB）。请在 5 分钟内完成借款。`),
      };
    } finally {
      // back to X Layer whatever happened; a wallet that refuses leaves the wrong-network button on the page
      if (moved || (await this.wallet.readChainId()) === this.book.bscChainId) await this.wallet.switchTo('xlayer');
      this.host.setPending(null);
      await this.host.refresh();
    }
  }

  /**
   * Step 4. Right before signing, the operating fee and the lens quote are read again in this session; the value sent is
   * the exact fee that was read. If the fee on chain is not the one on screen, nothing is sent and the screen is asked to
   * show the new one.
   */
  async borrow(args: BorrowArgs): Promise<ActionResult> {
    const me = this.account();
    if (!me) return fail({ kind: 'unknown', details: 'The wallet is not connected.' });
    const bad = (await checkWiring(this.env, { borrow: true })) ?? (await checkAgent(this.env, args.agent, me));
    if (bad) return fail(bad);
    // SPEC-PHASE5-PRELOAN §4.5, from storage and not only from the screen: a harvest the app sent that will be paid to this
    // agent must land before the borrow, or it would repay the loan instead of reaching the borrower
    if (args.ids.some((id) => { const s = this.gates.get(me, id)?.state; return s === 'moved' || s === 'payee-mismatch'; })) {
      await this.host.refresh();
      return fail({ kind: 'harvest', why: 'landing' });
    }

    const { pool, multicall3 } = this.book;
    let ops: bigint;
    let minAdvance: bigint;
    let quote: PrincipalQuote | null;
    let times: Map<number, number>;
    let now: number;
    try {
      const head = await this.x.head();
      now = head.timestamp;
      const [o, m] = await multicall(this.x, multicall3, [call<bigint>(pool, tapePoolAbi, 'opsFee', [args.term]), call<bigint>(pool, tapePoolAbi, 'minAdvance')] as const, { block: head.number });
      if (!o.ok || !m.ok) throw new Error('pool');
      ops = o.value;
      minAdvance = m.value;
      quote = await readQuoteFor(this.readEnv, head.number, args.agent, args.term, args.principal);
      times = await reportTimes(this.x, this.book, args.ids, head.number);
    } catch {
      return fail({ kind: 'quote', reason: 4 });
    }
    if (ops !== args.opsFee) {
      await this.host.refresh();
      return fail({ kind: 'revert', name: 'WrongOpsFee', params: { expectedFee: native(ops) } });
    }
    if (quote && (quote.fee > args.maxFee || quote.lateBps > args.maxLateBps)) {
      await this.host.refresh();
      return fail({ kind: 'revert', name: 'FeeAboveBound' });
    }
    const params = { minAdvance: bemTrim(minAdvance) };
    if (!quote) return fail({ kind: 'quote', reason: 4, params });
    if (quote.reason !== 0) return fail({ kind: 'quote', reason: quote.reason, params: { ...params, binding: quote.binding } });
    if (!args.ids.every((id) => timely(times.get(id) ?? 0, now) && (times.get(id) ?? 0) !== 0)) return fail({ kind: 'quote', reason: 6, params: { ...params, inputBits: 0 } });
    if (args.principal < minAdvance) return fail({ kind: 'revert', name: 'BelowMinAdvance', params });
    if (!quote.allowed) return fail({ kind: 'quote', reason: quote.reason || 4 });

    const days = args.term === 0 ? 7 : 14;
    const r = await this.tx.run({
      chain: 'xlayer',
      to: args.agent,
      data: this.book.redeploy
        ? encodeFunctionData({ abi: rigAgentAbi, functionName: 'borrow', args: [args.term, args.principal, args.maxFee, args.maxLateBps] })
        : encodeFunctionData({ abi: legacyBorrowAbi, functionName: 'borrow', args: [args.term, args.principal] }),
      value: ops,
      action: 'borrow',
      ask: this.ask('RigAgent', args.agent, `borrow(${days} days, ${bem4(args.principal)} BEM)`, okbText(ops)),
      revert: { minAdvance },
    });
    if (!r.ok) {
      if (r.error?.kind === 'revert' && ['WrongOpsFee', 'FeeAboveBound'].includes(r.error.name)) await this.host.refresh(); // the screen shows the new fee
      return this.failed(r);
    }
    const borrowed = eventsOf(r.receipt, rigAgentAbi as unknown as Abi, args.agent).find((e) => e.name === 'Borrowed');
    const maturity = typeof borrowed?.args.maturity === 'bigint' ? Number(borrowed.args.maturity) : this.host.now() + days * 86_400;
    const lead = args.ids[0] ?? 0;
    return {
      ok: true,
      go: `/rigs/${lead}`,
      flash: { kind: 'borrowed', rigId: lead, ids: [...args.ids], amount: args.principal, maturity, opsFee: ops },
      notice: () => t('Borrowed. The BEM is in your wallet.', '借款成功，BEM 已到账。'),
    };
  }

  /* ───────── repayment and the rest (§6.2) ───────── */

  /** `BEM.approve(agent, amount)`, only if the allowance is below `amount`. The spender is the agent: `repay` pulls into it. */
  async approveRepay(agent: Address, amount: bigint): Promise<ActionResult> {
    const me = this.account();
    if (!me) return fail({ kind: 'unknown', details: 'The wallet is not connected.' });
    const bad = await checkAgent(this.env, agent, me);
    if (bad) return fail(bad);
    const have = await this.allowance(me, agent);
    if (have === null) return fail({ kind: 'unknown', details: 'The BEM allowance could not be read.' });
    if (have >= amount) return { ok: true, notice: () => t('BEM is already allowed for this Rig Agent.', '该矿机代理已获授权使用 BEM。') };
    const r = await this.tx.run({
      chain: 'xlayer',
      to: this.book.bem,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [agent, amount] }),
      value: 0n,
      action: 'approve-repay',
      ask: this.ask('BEM', this.book.bem, `approve(your Rig Agent ${shortAddr(agent)}, ${bem4(amount)} BEM)`),
    });
    if (!r.ok) return this.failed(r);
    return { ok: true, notice: () => t('BEM allowed for your Rig Agent. Now repay.', '已授权矿机代理使用 BEM，请继续还款。') };
  }

  /**
   * `agent.repay(amount)`. `amount` already carries the late-fee margin of a full repayment; the contract pulls only what
   * the agent's own BEM leaves unpaid, so the approval needed is the smaller of the two.
   */
  async repay(agent: Address, amount: bigint, _full: boolean): Promise<ActionResult> {
    const me = this.account();
    if (!me) return fail({ kind: 'unknown', details: 'The wallet is not connected.' });
    const state = await this.agentMoney(agent, me);
    if (!state) return fail({ kind: 'unknown', details: 'The loan could not be read.' });
    if (!state.loan.open) return fail({ kind: 'revert', name: 'NoLoan' });
    const pull = state.loan.debt > state.bem ? state.loan.debt - state.bem : 0n;
    if (pull === 0n) {
      return { ok: false, notice: () => t("The agent's own BEM already covers the debt. Apply it instead.", '代理中已有的 BEM 足以还清债务，请直接用它还款。') };
    }
    const needed = amount < pull ? amount : pull;
    if (state.allowance < needed) return fail({ kind: 'revert', name: 'ERC20InsufficientAllowance' });
    const r = await this.tx.run({
      chain: 'xlayer',
      to: agent,
      data: encodeFunctionData({ abi: rigAgentAbi, functionName: 'repay', args: [amount] }),
      value: 0n,
      action: 'repay',
      ask: this.ask('RigAgent', agent, `repay(${bem4(amount)} BEM)`),
    });
    if (!r.ok) return this.failed(r);
    const cleared = await this.noteClearing(agent, r.receipt);
    const lead = state.collateral[0] ?? 0;
    return {
      ok: true,
      go: `/rigs/${lead}`,
      notice: cleared ? () => t('Debt cleared. Release the voucher to take your rig back.', '债务已还清，请取回凭证以拿回矿机。') : () => t(`Repaid ${bem4(pull < amount ? pull : amount)} BEM.`, `已还款 ${bem4(pull < amount ? pull : amount)} BEM。`),
    };
  }

  async sweep(agent: Address): Promise<ActionResult> {
    const r = await this.tx.run({ chain: 'xlayer', to: agent, data: encodeFunctionData({ abi: rigAgentAbi, functionName: 'sweep' }), value: 0n, action: 'sweep', ask: this.ask('RigAgent', agent, 'sweep()') });
    if (!r.ok) return this.failed(r);
    const cleared = await this.noteClearing(agent, r.receipt);
    return { ok: true, notice: cleared ? () => t('Debt cleared. Release the voucher to take your rig back.', '债务已还清，请取回凭证以拿回矿机。') : () => t('Harvested BEM applied to the debt.', '已领取的 BEM 已用于还款。') };
  }

  async release(agent: Address): Promise<ActionResult> {
    const ids = await this.collateral(agent) ?? [];
    const r = await this.tx.run({ chain: 'xlayer', to: agent, data: encodeFunctionData({ abi: rigAgentAbi, functionName: 'release' }), value: 0n, action: 'release', ask: this.ask('RigAgent', agent, 'release()') });
    if (!r.ok) return this.failed(r);
    const released = eventsOf(r.receipt, rigAgentAbi as unknown as Abi, agent).find((e) => e.name === 'Released');
    const moved = Array.isArray(released?.args.ids) ? released.args.ids.map(Number) : [];
    const attempts = (this.releaseAttempts.get(agent.toLowerCase()) ?? 0) + 1;
    this.releaseAttempts.set(agent.toLowerCase(), attempts);
    this.host.noteRelease?.(agent, attempts);
    await this.host.refresh();
    const left = await this.collateral(agent);
    const lead = moved[0] ?? ids[0] ?? 0;
    return { ok: true, ...(moved.length ? { flash: { kind: 'released' as const, rigId: lead, ids: moved, agent } } : {}), notice: () => left === null
      ? t('Release confirmed. Refresh to check the remaining vouchers.', '取回交易已确认，请刷新查看剩余凭证。')
      : left.length ? t('Some vouchers remain in the agent. Release again to retry.', '部分凭证仍在代理中，请再次取回。')
      : moved.length ? t('Voucher sent to your wallet.', '凭证已转回您的钱包。')
      : t('Entry removed. The voucher was not moved.', '已移除记录，凭证未转移。') };
  }

  async takeBack(agent: Address, id: number): Promise<ActionResult> {
    const r = await this.tx.run({ chain: 'xlayer', to: agent, data: encodeFunctionData({ abi: rigAgentAbi, functionName: 'withdrawVoucher', args: [BigInt(id)] }), value: 0n, action: 'take-back', ask: this.ask('RigAgent', agent, `withdrawVoucher(#${id})`) });
    if (!r.ok) return this.failed(r);
    return { ok: true, flash: { kind: 'released', rigId: id, ids: [id] }, notice: () => t('Voucher sent to your wallet.', '凭证已转回您的钱包。') };
  }

  async register(agent: Address, id: number): Promise<ActionResult> {
    const me = this.account();
    if (!me) return fail({ kind: 'unknown', details: 'The wallet is not connected.' });
    const bad = await checkAgent(this.env, agent, me);
    if (bad) return fail(bad);
    const loan = await this.noOpenLoan(agent);
    if (loan) return loan;
    const r = await this.tx.run({ chain: 'xlayer', to: agent, data: encodeFunctionData({ abi: rigAgentAbi, functionName: 'register', args: [BigInt(id)] }), value: 0n, action: 'register', ask: this.ask('RigAgent', agent, `register(#${id})`) });
    if (!r.ok) return this.failed(r);
    return { ok: true, notice: () => t('Voucher registered in the agent.', '凭证已登记到矿机代理中。') };
  }

  async forget(agent: Address, id: number): Promise<ActionResult> {
    const loan = await this.noOpenLoan(agent);
    if (loan) return loan;
    const r = await this.tx.run({ chain: 'xlayer', to: agent, data: encodeFunctionData({ abi: rigAgentAbi, functionName: 'forget', args: [BigInt(id)] }), value: 0n, action: 'forget', ask: this.ask('RigAgent', agent, 'forget(#' + id + ')') });
    if (!r.ok) return this.failed(r);
    return { ok: true, notice: () => t('Entry removed. The voucher was not moved.', '已移除记录，凭证未转移。') };
  }

  private async noOpenLoan(agent: Address): Promise<ActionResult | null> {
    try {
      const data = await this.x.call(agent, encodeFunctionData({ abi: rigAgentAbi, functionName: 'hasLoan' }));
      return decodeFunctionResult({ abi: rigAgentAbi, functionName: 'hasLoan', data }) ? fail({ kind: 'quote', reason: 11 }) : null;
    } catch { return fail({ kind: 'quote', reason: 1 }); }
  }

  async claimLate(agent: Address): Promise<ActionResult> {
    const held = (await this.agentMoney(agent, this.account() ?? (ZERO as Address)))?.bem ?? 0n;
    const r = await this.tx.run({ chain: 'xlayer', to: agent, data: encodeFunctionData({ abi: rigAgentAbi, functionName: 'claimLate' }), value: 0n, action: 'claim', ask: this.ask('RigAgent', agent, 'claimLate()') });
    if (!r.ok) return this.failed(r);
    return { ok: true, notice: () => t(`${bem4(held)} BEM sent to your wallet.`, `${bem4(held)} BEM 已转入您的钱包。`) };
  }

  /* ───────── supply and withdraw ───────── */

  /** `BEM.approve(pool, amount)`, only if the allowance is below `amount`. */
  async approveSupply(amount: bigint): Promise<ActionResult> {
    const me = this.account();
    if (!me) return fail({ kind: 'unknown', details: 'The wallet is not connected.' });
    const bad = await checkWiring(this.env, { borrow: false });
    if (bad) return fail(bad);
    const have = await this.allowance(me, this.book.pool);
    if (have === null) return fail({ kind: 'unknown', details: 'The BEM allowance could not be read.' });
    if (have >= amount) return { ok: true, notice: () => t('BEM is already allowed for the pool.', '资金池已获授权使用 BEM。') };
    const r = await this.tx.run({
      chain: 'xlayer',
      to: this.book.bem,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [this.book.pool, amount] }),
      value: 0n,
      action: 'approve-supply',
      ask: this.ask('BEM', this.book.bem, `approve(the pool ${shortAddr(this.book.pool)}, ${bem4(amount)} BEM)`),
    });
    if (!r.ok) return this.failed(r);
    return { ok: true, notice: () => t('BEM allowed for the pool. Now supply.', '已授权资金池使用 BEM，请继续存入。') };
  }

  async supply(amount: bigint): Promise<ActionResult> {
    const me = this.account();
    if (!me) return fail({ kind: 'unknown', details: 'The wallet is not connected.' });
    const bad = await checkWiring(this.env, { borrow: false });
    if (bad) return fail(bad);
    const have = await this.allowance(me, this.book.pool);
    if (have === null) return fail({ kind: 'unknown', details: 'The BEM allowance could not be read.' });
    if (have < amount) return fail({ kind: 'revert', name: 'ERC20InsufficientAllowance' });
    const r = await this.tx.run({
      chain: 'xlayer',
      to: this.book.pool,
      data: encodeFunctionData({ abi: tapePoolAbi, functionName: 'deposit', args: [amount, me] }),
      value: 0n,
      action: 'supply',
      ask: this.ask('TapePool', this.book.pool, `deposit(${bem4(amount)} BEM, you)`),
    });
    if (!r.ok) return this.failed(r);
    return { ok: true, notice: () => t('Supplied. Your tpBEM now earns the fees borrowers pay.', '存入成功，您的 tpBEM 将分得借款人支付的费用。') };
  }

  /** `withdraw(assets)`; MAX uses `redeem(maxRedeem)` so no dust is left behind. */
  async withdraw(amount: bigint, max: boolean): Promise<ActionResult> {
    const me = this.account();
    if (!me) return fail({ kind: 'unknown', details: 'The wallet is not connected.' });
    let data: Hex;
    let fn: string;
    if (max) {
      const [m] = await multicall(this.x, this.book.multicall3, [call<bigint>(this.book.pool, tapePoolAbi, 'maxRedeem', [me])] as const).catch(() => [{ ok: false } as Result<bigint>] as const);
      if (!m.ok) return fail({ kind: 'unknown', details: 'maxRedeem could not be read.' });
      data = encodeFunctionData({ abi: tapePoolAbi, functionName: 'redeem', args: [m.value, me, me] });
      fn = 'redeem(all your tpBEM, you, you)';
    } else {
      data = encodeFunctionData({ abi: tapePoolAbi, functionName: 'withdraw', args: [amount, me, me] });
      fn = `withdraw(${bem4(amount)} BEM, you, you)`;
    }
    const r = await this.tx.run({ chain: 'xlayer', to: this.book.pool, data, value: 0n, action: 'withdraw', ask: this.ask('TapePool', this.book.pool, fn) });
    if (!r.ok) return this.failed(r);
    return { ok: true, notice: () => t('Withdrawn. The BEM is in your wallet.', '提取成功，BEM 已转入您的钱包。') };
  }

  /* ───────── reads the writes need ───────── */

  private async allowance(owner: Address, spender: Address): Promise<bigint | null> {
    try {
      const [a] = await multicall(this.x, this.book.multicall3, [call<bigint>(this.book.bem, erc20Abi, 'allowance', [owner, spender])] as const);
      return a.ok ? a.value : null;
    } catch {
      return null;
    }
  }

  /** The agent's loan, its BEM and the account's allowance to it, read together. */
  private async agentMoney(agent: Address, me: Address): Promise<{ loan: LoanRaw; bem: bigint; allowance: bigint; collateral: number[] } | null> {
    try {
      const rows = await multicall(this.x, this.book.multicall3, [
        call<LoanRaw>(agent, rigAgentAbi, 'loanOf'),
        call<bigint>(this.book.bem, erc20Abi, 'balanceOf', [agent]),
        call<bigint>(this.book.bem, erc20Abi, 'allowance', [me, agent]),
        call<readonly bigint[]>(agent, rigAgentAbi, 'collateralOf'),
      ] as const);
      const [loan, bem, allowance, col] = rows;
      if (!loan.ok || !bem.ok || !allowance.ok || !col.ok) return null;
      return { loan: loan.value, bem: bem.value, allowance: allowance.value, collateral: col.value.map(Number) };
    } catch {
      return null;
    }
  }

  private async collateral(agent: Address): Promise<number[] | null> {
    try {
      const [c] = await multicall(this.x, this.book.multicall3, [call<readonly bigint[]>(agent, rigAgentAbi, 'collateralOf')] as const);
      return c.ok ? c.value.map(Number) : null;
    } catch {
      return null;
    }
  }

  /**
   * A receipt that closed the loan (`LoanClosed`) clears it for this session's history: the chain keeps nothing of a
   * cleared loan, so the receipt is the only place the clearing time and the surplus can come from.
   */
  private async noteClearing(agent: Address, receipt: ReceiptInfo): Promise<boolean> {
    const events = eventsOf(receipt, rigAgentAbi as unknown as Abi, agent);
    if (!events.some((e) => e.name === 'LoanClosed')) return false;
    let clearedAt = this.host.now();
    try {
      clearedAt = await this.x.blockTime(receipt.blockNumber);
    } catch {
      /* the chain clock is close enough */
    }
    const swept = events.find((e) => e.name === 'Swept');
    const leftover = typeof swept?.args.leftover === 'bigint' ? swept.args.leftover : 0n;
    this.host.noteLoanCleared(agent, { clearedAt, surplus: leftover > 0n ? leftover : null });
    return true;
  }
}

