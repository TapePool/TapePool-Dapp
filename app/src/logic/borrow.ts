import { errorText, type MsgParams } from '../chain/errors';
import { COUNTDOWN_MARGIN, DAY, REPORT_FUTURE_SKEW, REPORT_VALID_FOR } from '../constants';
import { bem4Floor, bemTrim, fd, parseAmount } from './format';
import { t } from '../i18n';
import type { AgentView, PrincipalQuote, Quote, RigView, Sec, Snapshot, TermIndex } from '../model';
import type { UiState } from '../state';
import { expectedOutput } from './creditMath';
import { fee, principalFor } from './fees';
import { deriveMined, type MinedView } from './harvest';
import { borrowsOpen, feedSettling, openLoanOfAgent, rigById } from './selectors';

/** Reason codes of `TapeLens.quote` that matter here. */
const OK = 0;
const NO_ROOM = 14;
const ABOVE_LEND_LIMIT = 16;
/** The lens answers that only say the pool has no room for the borrower (NO_ROOM, ABOVE_LEND_LIMIT). */
export const isRoomReason = (reason: number): boolean => reason === NO_ROOM || reason === ABOVE_LEND_LIMIT;
const CANNOT_CHECK = [1, 3, 4, 5];

export interface TermLimit {
  /** Expected base output over the term, summed over the selection. */
  expected: bigint;
  /** Largest allowed principal; 0 when nothing can be borrowed. */
  maxPrincipal: bigint;
  roomLimited: boolean;
  /** False when the emission rule bars this term. */
  offered: boolean;
  /** The quote's reason code once the numbers come from the lens; 0 for an estimate. */
  reason: number;
}

export interface AmountView {
  text: string;
  value: bigint;
  error: string | null;
  valid: boolean;
  fee: bigint;
  debt: bigint;
  /** The minimum fee, not the rate, sets the fee at this size. */
  minFeeApplies: boolean;
}

export type ReportState = 'idle' | 'waiting' | 'fresh' | 'expired';
export type RuleAnswer = 'estimate' | 'allow' | 'deny' | 'cant';

export interface BorrowView {
  rigs: RigView[];
  ids: number[];
  term: TermIndex;
  /** The agent for this flow, once there is one. */
  agent: AgentView | null;
  reused: boolean;
  /** An empty agent the user could reuse instead of creating one. */
  reusable: AgentView | null;
  agentDone: boolean;
  moved: boolean;
  report: ReportState;
  /** Seconds left in the borrow window; 0 unless the report is fresh. */
  secondsLeft: number;
  limits: readonly [TermLimit, TermLimit];
  source: 'estimate' | 'quote';
  quote: Quote | null;
  principalQuote: PrincipalQuote | null;
  lateBps: number;
  rule: RuleAnswer;
  amount: AmountView;
  opsFee: bigint;
  poolOpen: boolean;
  /** Redeploy 3 RC3-02: the feed was turned back on less than `FEED_SETTLE` ago, so `lend` still reverts `FeedSettling()`. */
  settling: boolean;
  okbEnough: boolean;
  okbShort: bigint;
  /** The BEM the selection mined before the loan (SPEC-PHASE5-PRELOAN): what step 2 and step 3 ask, and the review row. */
  mined: MinedView;
  /** Why the Borrow button is off, in the words of the screen. */
  blockers: string[];
  canBorrow: boolean;
  /** Transactions still to send on X Layer. */
  txLeft: number;
}

export function timely(observedAt: Sec, now: Sec): boolean {
  return observedAt <= now + REPORT_FUTURE_SKEW && now <= observedAt + REPORT_VALID_FOR;
}

/** The selection that can be borrowed against: ready rigs, and rigs already in one of the user's open agents. */
export function borrowable(snap: Snapshot, ids: number[]): RigView[] {
  return ids
    .map((id) => rigById(snap, id))
    .filter((r): r is RigView => r !== undefined && (r.state.kind === 'ready' || r.state.kind === 'in-agent'));
}

export function estimateLimit(snap: Snapshot, rigs: RigView[], term: TermIndex, now: Sec): TermLimit {
  const total = snap.rules.totalVerifWeight;
  const expected = rigs.reduce((s, r) => s + expectedOutput(r.basePower ?? 0n, total, term), 0n);
  const offered = now + snap.pool.params.termDays[term] * DAY < snap.rules.emissionValidUntil;
  let p = principalFor(snap.pool.params, term, (expected * BigInt(snap.pool.params.maxDebtBps[term])) / 10_000n);
  const room = snap.wallet.room;
  const roomLimited = p > room;
  if (roomLimited) p = room;
  return { expected, maxPrincipal: offered ? p : 0n, roomLimited, offered, reason: OK };
}

function quoteLimit(q: Quote | null | undefined, snap: Snapshot, term: TermIndex, now: Sec): TermLimit {
  const offered = now + snap.pool.params.termDays[term] * DAY < snap.rules.emissionValidUntil;
  if (!q) return { expected: 0n, maxPrincipal: 0n, roomLimited: false, offered, reason: 4 };
  return { expected: q.expected, maxPrincipal: q.reason === OK ? q.maxPrincipal : 0n, roomLimited: q.reason === NO_ROOM, offered, reason: q.reason };
}

export function ruleOf(reason: number): RuleAnswer {
  if (reason === OK) return 'allow';
  return CANNOT_CHECK.includes(reason) ? 'cant' : 'deny';
}

/** The default advance: 80% of the max in whole 0.01 BEM, at least the minimum, never above the max. */
export function defaultAmount(max: bigint, minAdvance: bigint): bigint {
  const floor = (max * 80n) / 100n / 1_000_000n;
  let v = floor * 1_000_000n;
  if (v < minAdvance) v = minAdvance;
  const maxTrim = (max / 10_000n) * 10_000n;
  return v > maxTrim ? maxTrim : v;
}

/** Everything the borrow flow shows, from the snapshot and what the user typed. Null without a selection. */
export function deriveBorrow(snap: Snapshot, ui: UiState, now: Sec): BorrowView | null {
  const rigs = borrowable(snap, ui.sel);
  if (rigs.length === 0) return null;
  const ids = rigs.map((r) => r.id);
  const params = snap.pool.params;
  const term = ui.term;

  // Step 1: the agent. One that already holds a selected voucher wins, then the one the user just made or chose.
  const holder = snap.agents.find(
    (a) => !a.closed && !openLoanOfAgent(snap, a.address) && a.collateral.some((id) => ids.includes(id)),
  );
  const picked = ui.agent
    ? snap.agents.find((a) => a.address.toLowerCase() === ui.agent?.toLowerCase() && !a.closed && !openLoanOfAgent(snap, a.address))
    : undefined;
  const agent = holder ?? picked ?? null;
  const reusable =
    snap.agents.find((a) => !a.closed && a.collateral.length === 0 && !openLoanOfAgent(snap, a.address) && a !== agent) ?? null;

  // Step 2: every selected voucher is in the agent's collateral set.
  const moved = agent !== null && ids.every((id) => agent.collateral.includes(id));

  // Step 3: every report of the collateral is timely, by chain time.
  const reportTimes = agent && moved ? agent.collateral.map((id) => snap.reports[String(id)]?.observedAt) : [];
  const allTimely = agent !== null && moved && reportTimes.length > 0 && reportTimes.every((o) => o !== undefined && timely(o, now));
  const earliest = allTimely ? Math.min(...(reportTimes as number[])) : 0;
  const secondsLeft = allTimely ? Math.max(0, earliest + REPORT_VALID_FOR - COUNTDOWN_MARGIN - now) : 0;
  const waiting = snap.pending !== null && (snap.pending.action === 'refresh' || snap.pending.action === 'selfpush');
  let report: ReportState = 'idle';
  if (waiting) report = 'waiting';
  else if (allTimely && secondsLeft > 0) report = 'fresh';
  else if (allTimely || reportTimes.some((o) => o !== undefined && !timely(o, now))) report = 'expired'; // a report exists but cannot be used (any more)

  // The numbers: an estimate until the vouchers are in and the reports are timely, then the lens quote.
  const quotes = agent ? snap.quotes[agent.address.toLowerCase()] : undefined;
  const useQuote = report === 'fresh' && quotes !== undefined;
  const limits: readonly [TermLimit, TermLimit] = useQuote
    ? [quoteLimit(quotes[0], snap, 0, now), quoteLimit(quotes[1], snap, 1, now)]
    : [estimateLimit(snap, rigs, 0, now), estimateLimit(snap, rigs, 1, now)];
  const quote = useQuote ? (quotes[term] ?? null) : null;
  let rule: RuleAnswer = report === 'fresh' ? (quote ? ruleOf(quote.reason) : 'cant') : 'estimate';

  // The advance box.
  const limit = limits[term];
  const text = ui.amt ?? bem4Floor(defaultAmount(limit.maxPrincipal, params.minAdvance));
  const value = parseAmount(text, 8) ?? 0n;
  let error: string | null = null;
  if (value === 0n) error = t('Enter an amount.', '请输入金额。');
  else if (value < params.minAdvance)
    error = t(`The minimum advance is ${fmtMin(params.minAdvance)} BEM.`, `最低借款金额为 ${fmtMin(params.minAdvance)} BEM。`);
  else if (value > limit.maxPrincipal) error = t('Above your max for this rig and term.', '超过该矿机在此期限下的上限。');
  const chosen = ui.principalQuote;
  const principalQuote = agent && chosen && chosen.agent.toLowerCase() === agent.address.toLowerCase() && chosen.term === term && chosen.principal === value ? chosen.value : null;
  if (snap.principalQuotes && report === 'fresh') rule = principalQuote ? ruleOf(principalQuote.reason) : 'cant';
  const feeNow = principalQuote?.fee ?? (value > 0n ? fee(params, term, value) : 0n);
  const amount: AmountView = {
    text,
    value,
    error,
    valid: error === null,
    fee: feeNow,
    debt: principalQuote?.debt ?? value + feeNow,
    minFeeApplies: value > 0n && (value * BigInt(params.feeBps[term]) + 9_999n) / 10_000n < params.minFee,
  };

  const opsFee = params.opsFee[term];
  const need = opsFee + snap.wallet.borrowGas;
  const okbEnough = snap.wallet.okb >= need;
  const poolOpen = borrowsOpen(snap.pool);
  const settling = poolOpen && feedSettling(snap.pool, now);
  // while the feed settles `lendLimit` is (0, 5): the pool-room answers of the lens (14, 16) say no more than the settling line
  const roomOnly = (reason: number) => settling && isRoomReason(reason);

  // the BEM the rigs mined before the loan is measured against the debt on screen, or the largest debt of the term while there is no valid amount
  const maxDebt = limit.maxPrincipal > 0n ? limit.maxPrincipal + fee(params, term, limit.maxPrincipal) : 0n;
  const mined = deriveMined({ snap, ui, now, rigs, agent, debt: amount.valid ? amount.debt : maxDebt });

  const blockers: string[] = [];
  if (!poolOpen) blockers.push(t('New borrows are not open right now.', '当前不开放新借款。'));
  else if (settling) blockers.push(errorText({ kind: 'revert', name: 'FeedSettling' }));
  if (report === 'fresh' && (rule === 'deny' || rule === 'cant') && quote) {
    const p: MsgParams = { minAdvance: fmtMin(params.minAdvance), inputBits: quote.inputBits, eta: snap.pool.pendingPolicy ? fd(snap.pool.pendingPolicy.eta, true) : undefined, terms: params.termDays };
    if (!roomOnly(quote.reason)) blockers.push(errorText({ kind: 'quote', reason: quote.reason, params: p }));
  } else if (report === 'fresh' && !quote) blockers.push(errorText({ kind: 'quote', reason: 4 }));
  if (snap.principalQuotes && report === 'fresh') {
    if (!principalQuote) blockers.push(t('Checking the amount quote…', '正在核对金额报价…'));
    else if (!principalQuote.allowed && !roomOnly(principalQuote.reason)) blockers.push(errorText({ kind: 'quote', reason: principalQuote.reason || 4, params: { binding: principalQuote.binding, minAdvance: fmtMin(params.minAdvance) } }));
  }
  if (error) blockers.push(error);
  // the entry checks of SPEC-PHASE5-APP §10: a source that runs them says so with `snap.entry`; until an agent's result is in, the button waits
  if (agent && snap.entry !== undefined && report === 'fresh') {
    const checked = snap.entry[agent.address.toLowerCase()];
    if (checked) blockers.push(errorText(checked));
    else if (checked === undefined) blockers.push(t('Checking the contracts…', '正在核对合约…'));
  }
  // a harvest that was paid to the agent: borrowing now would send that BEM to the borrower only once it lands there (SPEC-PHASE5-PRELOAN §4.5)
  if (mined.mismatch) {
    blockers.push(t('The harvest you sent will be paid to the agent. Borrowing waits until it lands there; borrowing then sends it to you.', '您发起的领取将付给矿机代理。借款将等到这笔 BEM 到账后再进行，届时借款会把它转给您。'));
    if (mined.mismatch.late) blockers.push(t('It has not landed after 15 minutes. You can take the voucher back.', '15 分钟后仍未到账。您可以取回凭证。'));
  }
  if (!okbEnough) blockers.push(t('Add OKB on X Layer for the operating fee and gas.', '请在 X Layer 上补充 OKB，用于运营费和 gas。'));
  if (Object.keys(snap.stale).length > 0) blockers.push(t('Some data could not be refreshed. Try again in a moment.', '部分数据未能刷新，请稍后再试。'));
  if (snap.pending !== null) blockers.push(t('A request is still in progress.', '有请求仍在进行中。'));

  // BEM mined before the loan that nobody chose about keeps Borrow off: it would repay the loan first
  const canBorrow = blockers.length === 0 && report === 'fresh' && rule === 'allow' && !mined.step3.blocks;
  const txLeft = (agent ? 0 : 1) + ids.filter((id) => !(agent?.collateral.includes(id) ?? false)).length + 1;

  return {
    rigs,
    ids,
    term,
    agent,
    reused: ui.reuse && agent !== null && holder === undefined,
    reusable,
    agentDone: agent !== null,
    moved,
    report,
    secondsLeft,
    limits,
    source: useQuote ? 'quote' : 'estimate',
    quote,
    principalQuote,
    lateBps: principalQuote?.lateBps ?? params.lateFeeBpsPerDay,
    rule,
    amount,
    opsFee,
    poolOpen,
    settling,
    okbEnough,
    okbShort: okbEnough ? 0n : need - snap.wallet.okb,
    mined,
    blockers,
    canBorrow,
    txLeft,
  };
}

const fmtMin = (v: bigint): string => bemTrim(v);

/** The debt as a share of what the max allows, for the bar (0 to 100). */
export function debtBarPct(debt: bigint, expected: bigint, maxDebtBps: number): number {
  const cap = (expected * BigInt(maxDebtBps)) / 10_000n;
  if (cap === 0n) return 0;
  return Math.min(100, Number((debt * 1000n) / cap) / 10);
}
