import { getAddress } from 'viem/utils';
import type { AppError } from '../chain/errors';
import { DAY } from '../constants';
import { t } from '../i18n';
import { bem4, native } from '../logic/format';
import { expectedOutput } from '../logic/creditMath';
import { fee } from '../logic/fees';
import { buildRigView } from '../logic/rigState';
import { debtOf, isOpen } from '../logic/selectors';
import type { Address, AgentView, LoanView, RigFacts, RigPlace, Sec, Snapshot } from '../model';
import type { ActionResult, Actions, BorrowArgs, DataSource } from '../source';
import { collateralRow, gateRecord, quotesFor, type RuleAnswer } from './data';

export interface FixtureOptions {
  /** Milliseconds, monotonic. Defaults to `performance.now`. */
  clock?: () => number;
  /** How long the simulated keeper takes to deliver a report. */
  reportDelayMs?: number;
  /** What the credit rule answers once the report is fresh. */
  rule?: RuleAnswer;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const ok = (over: Partial<ActionResult> = {}): ActionResult => ({ ok: true, ...over });
const fail = (error: AppError): ActionResult => ({ ok: false, error });

/** A simulated world behind both seams: the screens read it as a `DataSource`, the buttons change it as `Actions`. No chain, no wallet. */
export class FixtureStore implements DataSource, Actions {
  private state: Snapshot;
  private readonly clock: () => number;
  private readonly t0: number;
  private readonly delay: number;
  private rule: RuleAnswer;
  private readonly listeners = new Set<() => void>();
  private nextAgent = 1;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(initial: Snapshot, opts: FixtureOptions = {}) {
    this.state = initial;
    this.clock = opts.clock ?? (() => performance.now());
    this.t0 = this.clock();
    this.delay = opts.reportDelayMs ?? 4_000;
    this.rule = opts.rule ?? 'allow';
    // A refresh that was in progress when the fixture was saved finishes after the delay.
    if (initial.pending?.action === 'refresh' || initial.pending?.action === 'selfpush') this.scheduleReports();
  }

  /* ───────── DataSource ───────── */

  now(): Sec {
    return this.state.now + Math.floor((this.clock() - this.t0) / 1000);
  }

  snapshot(view: Address | null): Snapshot {
    const now = this.now();
    const wallet = view ? { ...this.state.wallet, status: 'view' as const, account: view } : this.state.wallet;
    // the BEM an open loan sees in its agent is the agent's own balance
    const loans = this.state.loans.map((l) => {
      const a = this.agent(l.agent);
      return a && isOpen(l) ? { ...l, agentBem: a.bem } : l;
    });
    // in a fixture the last head is the clock itself
    return { ...this.state, now, wallet, loans, rigs: this.state.rigs.map((r) => buildRigView(r.facts, now)), harvest: { ...this.state.harvest, headTime: now } };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Test hook: move the fixture clock. */
  advance(seconds: number): void {
    this.state = { ...this.state, now: this.state.now + seconds };
    this.emit();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  private set(patch: Partial<Snapshot>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  /* ───────── small editors ───────── */

  private editRig(id: number, fn: (f: RigFacts) => RigFacts): void {
    const now = this.now();
    this.state = { ...this.state, rigs: this.state.rigs.map((r) => (r.id === id ? buildRigView(fn(r.facts), now) : r)) };
  }

  private setPlace(ids: number[], place: RigPlace): void {
    ids.forEach((id) => this.editRig(id, (f) => ({ ...f, place })));
  }

  private editAgent(a: Address, fn: (x: AgentView) => AgentView): void {
    this.state = { ...this.state, agents: this.state.agents.map((x) => (same(x.address, a) ? fn(x) : x)) };
  }

  private editLoan(a: Address, fn: (x: LoanView) => LoanView): void {
    this.state = { ...this.state, loans: this.state.loans.map((x) => (same(x.agent, a) ? fn(x) : x)) };
  }

  private agent(a: Address): AgentView | undefined {
    return this.state.agents.find((x) => same(x.address, a));
  }

  private loan(a: Address): LoanView | undefined {
    return this.state.loans.find((x) => same(x.agent, a));
  }

  private place(agent: Address, collateral: boolean, loanOpen = false): RigPlace {
    return { kind: 'agent', agent, closed: false, collateral, loanOpen };
  }

  /** The lens answer for an agent, as the chosen rule would give it. */
  private requote(a: Address): void {
    const ag = this.agent(a);
    if (!ag) return;
    this.state = { ...this.state, quotes: { ...this.state.quotes, [a.toLowerCase()]: quotesFor(this.state, ag, this.rule) } };
  }

  /* ───────── wallet ───────── */

  async connect(id?: string): Promise<ActionResult> {
    const w = this.state.wallet;
    const active = w.options?.find((o) => o.id === id) ?? w.active ?? null;
    this.set({ wallet: { ...w, status: 'connected', account: w.account, active, recent: active?.rdns ?? w.recent ?? null } });
    return ok({ notice: () => t('Sample wallet connected. Nothing is ever sent.', '已连接示例钱包，不会发送任何交易。') });
  }

  async disconnect(): Promise<ActionResult> {
    this.set({ wallet: { ...this.state.wallet, status: 'disconnected', active: null } });
    return ok({ notice: () => t('Wallet disconnected.', '钱包已断开。') });
  }

  async switchNetwork(): Promise<ActionResult> {
    this.set({ wallet: { ...this.state.wallet, status: 'connected' } });
    return ok({ notice: () => t('Switched to X Layer.', '已切换到 X Layer。') });
  }

  /* ───────── borrow flow ───────── */

  async createAgent(): Promise<ActionResult> {
    const n = this.nextAgent++;
    const address = getAddress(`0x9e04${n.toString(16).padStart(32, '0')}71ab`) as Address;
    this.set({ agents: [...this.state.agents, { address, closed: false, collateral: [], loose: [], bem: 0n }] });
    return ok({ agent: address, notice: () => t('Rig Agent created (sample).', '已创建矿机代理（示例）。') });
  }

  async moveVouchers(agent: Address, ids: number[]): Promise<ActionResult> {
    if (this.loan(agent) && isOpen(this.loan(agent)!)) return fail({ kind: 'revert', name: 'LoanOpen' });
    this.setPlace(ids, this.place(agent, true));
    this.editAgent(agent, (a) => ({ ...a, collateral: [...new Set([...a.collateral, ...ids])].sort((x, y) => x - y), loose: a.loose.filter((i) => !ids.includes(i)) }));
    this.state = { ...this.state, quotes: {}, reports: {} };
    this.emit();
    return ok({ notice: () => t('Voucher moved into the agent (sample).', '凭证已转入代理（示例）。') });
  }

  /** "Harvest it to my wallet first", as a sample: the rigs are emptied and their vouchers may move at once. Nothing is sent. */
  async harvestFirst(ids: number[]): Promise<ActionResult> {
    ids.forEach((id) => this.editRig(id, (f) => ({ ...f, bsc: f.bsc ? { ...f.bsc, mined: 0n } : f.bsc })));
    const gates = { ...this.state.harvest.gates };
    for (const id of ids) gates[String(id)] = gateRecord(id, 'passed', { harvestedAt: this.now() - 30, block: 128_369_000n });
    this.set({ harvest: { ...this.state.harvest, gates } });
    return ok({ decided: ids, notice: () => t('Harvest sent on BSC (sample). Nothing was sent.', '已在 BSC 上发起领取（示例），未发送任何交易。') });
  }

  /** §4.7 as a sample: the vouchers go back to the wallet and the agent stays the flow's agent. */
  async takeBackToHarvest(agent: Address, ids: number[]): Promise<ActionResult> {
    this.setPlace(ids, { kind: 'wallet' });
    this.editAgent(agent, (a) => ({ ...a, collateral: a.collateral.filter((i) => !ids.includes(i)) }));
    this.state = { ...this.state, quotes: {}, reports: {} };
    this.emit();
    const lead = ids[0] ?? 0;
    return ok({ agent, reuse: true, flash: { kind: 'released', rigId: lead, ids: [...ids] }, notice: () => t('Voucher sent to your wallet (sample).', '凭证已转回您的钱包（示例）。') });
  }

  private scheduleReports(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const s = this.state;
      const reports = { ...s.reports };
      const now = this.now();
      s.agents.forEach((a) => {
        if (a.closed) return;
        a.collateral.forEach((id) => {
          reports[String(id)] = { observedAt: now - 5 };
        });
      });
      this.state = { ...s, reports, pending: null };
      s.agents.filter((a) => a.collateral.length > 0 && !a.closed).forEach((a) => this.requote(a.address));
      this.emit();
    }, this.delay);
  }

  private startPending(action: 'refresh' | 'selfpush'): void {
    this.set({ pending: { action, since: this.now(), hash: null } });
    this.scheduleReports();
  }

  private waitForReports(): Promise<void> {
    return new Promise((resolve) => {
      const off = this.subscribe(() => {
        if (this.state.pending === null) {
          off();
          resolve();
        }
      });
    });
  }

  async refreshRigData(): Promise<ActionResult> {
    this.startPending('refresh');
    await this.waitForReports();
    return ok({ notice: () => t('Rig data requested (sample).', '已请求矿机数据（示例）。') });
  }

  async selfPush(): Promise<ActionResult> {
    this.startPending('selfpush');
    await this.waitForReports();
    const bnb = this.state.keeper.selfPushBnb;
    return ok({
      notice: () =>
        bnb === null
          ? t('Pushed on BSC (sample).', '已在 BSC 上推送（示例）。')
          : t(`Pushed on BSC from your wallet: about ${native(bnb, 4, 4)} BNB (sample). It does not lower the OKB fee.`, `已从您的钱包在 BSC 上推送：约 ${native(bnb, 4, 4)} BNB（示例），不会减少 OKB 运营费。`),
    });
  }

  async borrow(args: BorrowArgs): Promise<ActionResult> {
    const s = this.state;
    const ag = this.agent(args.agent);
    if (!ag) return fail({ kind: 'revert', name: 'NotBorrower' });
    const p = s.pool.params;
    if (args.opsFee !== p.opsFee[args.term]) return fail({ kind: 'revert', name: 'WrongOpsFee', params: { expectedFee: native(p.opsFee[args.term]) } });
    const rigs = s.rigs.filter((r) => ag.collateral.includes(r.id));
    const f = fee(p, args.term, args.principal);
    const now = this.now();
    const loan: LoanView = {
      agent: ag.address,
      rigIds: [...ag.collateral],
      collateral: rigs.map((r) => collateralRow(r.facts)),
      phase: 'active',
      term: args.term,
      start: now,
      maturity: now + p.termDays[args.term] * DAY,
      advance: args.principal,
      principal: args.principal,
      feeLeft: f,
      lateFee: 0n,
      lateBpsPerDay: p.lateFeeBpsPerDay,
      feePaid: f,
      opsFeePaid: args.opsFee,
      agentBem: 0n,
      minedBsc: rigs.reduce((x, r) => x + (r.mined ?? 0n), 0n),
      expectedPerDay: rigs.reduce((x, r) => x + expectedOutput(r.basePower ?? 0n, s.rules.totalVerifWeight, args.term), 0n) / BigInt(p.termDays[args.term]),
      impairedAt: null,
      seizeStart: null,
      deadline: null,
      impairedRig: null,
      impairment: null,
      seizedAt: null,
      writtenOff: null,
      clearedAt: null,
      surplus: null,
    };
    this.setPlace(ag.collateral, this.place(ag.address, true, true));
    this.state = {
      ...this.state,
      loans: [...this.state.loans.filter((l) => !same(l.agent, ag.address)), loan],
      wallet: { ...this.state.wallet, bem: this.state.wallet.bem + args.principal + ag.bem, okb: this.state.wallet.okb - args.opsFee, room: this.state.wallet.room - args.principal },
      pool: { ...this.state.pool, outstanding: this.state.pool.outstanding + args.principal, idle: this.state.pool.idle - args.principal },
      reports: {},
      quotes: {},
    };
    this.editAgent(ag.address, (a) => ({ ...a, bem: 0n }));
    this.emit();
    const lead = ag.collateral[0] ?? args.ids[0] ?? 0;
    return ok({
      go: `/rigs/${lead}`,
      flash: { kind: 'borrowed', rigId: lead, ids: [...ag.collateral], amount: args.principal, maturity: loan.maturity, opsFee: args.opsFee },
      notice: () => t('Borrowed (sample). Nothing was sent.', '借款成功（示例），未发送任何交易。'),
    });
  }

  /* ───────── repay, release and the rest ───────── */

  async approveRepay(agent: Address, amount: bigint): Promise<ActionResult> {
    this.set({ wallet: { ...this.state.wallet, allowanceAgent: { ...this.state.wallet.allowanceAgent, [agent.toLowerCase()]: amount } } });
    return ok();
  }

  /** Apply `amount` of BEM to a loan, fee first. Marks the loan cleared when nothing is left. */
  private applyToLoan(agent: Address, amount: bigint): bigint {
    const l = this.loan(agent);
    if (!l) return 0n;
    let left = amount;
    const late = left < l.lateFee ? left : l.lateFee;
    left -= late;
    const feePart = left < l.feeLeft ? left : l.feeLeft;
    left -= feePart;
    const princ = left < l.principal ? left : l.principal;
    left -= princ;
    const next: LoanView = { ...l, lateFee: l.lateFee - late, feeLeft: l.feeLeft - feePart, principal: l.principal - princ };
    const cleared = debtOf(next) === 0n;
    this.editLoan(agent, () => (cleared ? { ...next, phase: 'cleared', clearedAt: this.now(), surplus: left > 0n ? left : null } : next));
    if (cleared) this.setPlace(l.rigIds, this.place(agent, true, false));
    this.state = { ...this.state, pool: { ...this.state.pool, outstanding: this.state.pool.outstanding - (l.principal - next.principal) } };
    return left;
  }

  async repay(agent: Address, amount: bigint): Promise<ActionResult> {
    const ag = this.agent(agent);
    const l = this.loan(agent);
    if (!ag || !l || !isOpen(l)) return fail({ kind: 'revert', name: 'NoLoan' });
    const total = amount + ag.bem;
    this.editAgent(agent, (a) => ({ ...a, bem: 0n }));
    const surplus = this.applyToLoan(agent, total);
    this.state = { ...this.state, wallet: { ...this.state.wallet, bem: this.state.wallet.bem - amount + surplus } };
    const now = this.loan(agent);
    this.emit();
    const cleared = now?.phase === 'cleared';
    return ok({
      go: `/rigs/${l.rigIds[0] ?? 0}`,
      notice: () =>
        cleared
          ? t('Debt cleared (sample). Release the voucher to take your rig back.', '债务已还清（示例）。请取回凭证以拿回矿机。')
          : t(`Repaid ${bem4(amount)} BEM (sample).`, `已还款 ${bem4(amount)} BEM（示例）。`),
    });
  }

  async sweep(agent: Address): Promise<ActionResult> {
    const ag = this.agent(agent);
    if (!ag) return fail({ kind: 'revert', name: 'NotBorrower' });
    this.editAgent(agent, (a) => ({ ...a, bem: 0n }));
    this.applyToLoan(agent, ag.bem);
    this.emit();
    return ok({ notice: () => t('Harvested BEM applied to the debt (sample).', '已领取的 BEM 已用于还款（示例）。') });
  }

  async release(agent: Address): Promise<ActionResult> {
    const ag = this.agent(agent);
    if (!ag) return fail({ kind: 'revert', name: 'NotBorrower' });
    const l = this.loan(agent);
    if (l && isOpen(l)) return fail({ kind: 'revert', name: 'LoanOpen' });
    this.setPlace(ag.collateral, { kind: 'wallet' });
    this.editAgent(agent, (a) => ({ ...a, collateral: [] }));
    this.state = { ...this.state, loans: this.state.loans.filter((x) => !same(x.agent, agent)) };
    this.emit();
    const lead = ag.collateral[0] ?? 0;
    return ok({ flash: { kind: 'released', rigId: lead, ids: [...ag.collateral] }, notice: () => t('Voucher sent to your wallet (sample).', '凭证已转回您的钱包（示例）。') });
  }

  async takeBack(agent: Address, id: number): Promise<ActionResult> {
    this.setPlace([id], { kind: 'wallet' });
    this.editAgent(agent, (a) => ({ ...a, collateral: a.collateral.filter((i) => i !== id), loose: a.loose.filter((i) => i !== id) }));
    this.state = { ...this.state, quotes: {}, reports: {} };
    this.emit();
    return ok({ flash: { kind: 'released', rigId: id, ids: [id] }, notice: () => t('Voucher sent to your wallet (sample).', '凭证已转回您的钱包（示例）。') });
  }

  async register(agent: Address, id: number): Promise<ActionResult> {
    if (this.loan(agent) && isOpen(this.loan(agent)!)) return fail({ kind: 'revert', name: 'LoanOpen' });
    this.setPlace([id], this.place(agent, true));
    this.editAgent(agent, (a) => ({ ...a, collateral: [...a.collateral, id].sort((x, y) => x - y), loose: a.loose.filter((i) => i !== id) }));
    this.emit();
    return ok({ notice: () => t('Voucher registered in the agent (sample).', '凭证已登记到代理中（示例）。') });
  }

  async forget(agent: Address, id: number): Promise<ActionResult> {
    if (this.loan(agent) && isOpen(this.loan(agent)!)) return fail({ kind: 'revert', name: 'LoanOpen' });
    this.editAgent(agent, (a) => ({ ...a, collateral: a.collateral.filter((i) => i !== id) }));
    this.emit();
    return ok();
  }

  async claimLate(agent: Address): Promise<ActionResult> {
    const ag = this.agent(agent);
    if (!ag) return fail({ kind: 'revert', name: 'NotBorrower' });
    this.editAgent(agent, (a) => ({ ...a, bem: 0n }));
    this.set({ wallet: { ...this.state.wallet, bem: this.state.wallet.bem + ag.bem } });
    return ok({ notice: () => t(`${bem4(ag.bem)} BEM sent to your wallet (sample).`, `${bem4(ag.bem)} BEM 已转入您的钱包（示例）。`) });
  }

  /* ───────── supply and withdraw ───────── */

  async approveSupply(amount: bigint): Promise<ActionResult> {
    this.set({ wallet: { ...this.state.wallet, allowancePool: amount } });
    return ok();
  }

  private shares(assets: bigint): bigint {
    return (assets * 10n ** 14n) / this.state.pool.tpbemValue;
  }

  async supply(amount: bigint): Promise<ActionResult> {
    const s = this.state;
    if (!s.position) return fail({ kind: 'unknown', details: 'no position' });
    this.state = {
      ...s,
      wallet: { ...s.wallet, bem: s.wallet.bem - amount, allowancePool: s.wallet.allowancePool - amount },
      pool: { ...s.pool, totalAssets: s.pool.totalAssets + amount, idle: s.pool.idle + amount },
      position: { ...s.position, tpbem: s.position.tpbem + this.shares(amount), value: s.position.value + amount, withdrawable: s.position.withdrawable + amount, maxDeposit: s.position.maxDeposit - amount },
    };
    this.emit();
    return ok({ notice: () => t('Supplied (sample). Nothing was sent.', '存入成功（示例），未发送任何交易。') });
  }

  async withdraw(amount: bigint): Promise<ActionResult> {
    const s = this.state;
    if (!s.position) return fail({ kind: 'unknown', details: 'no position' });
    this.state = {
      ...s,
      wallet: { ...s.wallet, bem: s.wallet.bem + amount },
      pool: { ...s.pool, totalAssets: s.pool.totalAssets - amount, idle: s.pool.idle - amount },
      position: { ...s.position, tpbem: s.position.tpbem - this.shares(amount), value: s.position.value - amount, withdrawable: s.position.withdrawable - amount, maxDeposit: s.position.maxDeposit + amount },
    };
    this.emit();
    return ok({ notice: () => t('Withdrawn (sample). Nothing was sent.', '提取成功（示例），未发送任何交易。') });
  }
}
