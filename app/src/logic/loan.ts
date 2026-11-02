import { DUST } from '../constants';
import { expectedOutput } from './creditMath';
import { ZERO_ADDRESS } from './bscReader';
import type { OpenInfo, SeizeInfo } from './history';
import type { Address, CollateralRow, ImpairmentKind, LoanPhase, LoanView, PoolParams, RigFacts, RigView, RulesView, Sec, TermIndex } from '../model';

/** `RigAgent.loanOf()` as viem decodes it: uint64 and uint256 fields are bigints, uint8 and uint16 fields are numbers. */
export interface LoanRaw {
  open: boolean;
  start: bigint;
  maturity: bigint;
  term: number;
  principal: bigint;
  principal0: bigint;
  feeLeft: bigint;
  lateBpsPerDay: number;
  lateAccruedTo: bigint;
  lateFeeDue: bigint;
  debt: bigint;
  impairedAt: bigint;
  impairedRig: bigint;
  doubtful: boolean;
  seizeStart: bigint;
  deadline: bigint;
  expired: boolean;
}

const sec = (v: bigint): Sec => Number(v);
const termOf = (n: number): TermIndex => (n === 1 ? 1 : 0);

/**
 * Where an open loan stands, from what `loanOf()` says (SPEC-PHASE5-APP §5.4): the app never recomputes the cure and
 * seize windows, it only compares them with chain time. A flag whose deadline has passed with the feed on is
 * `expired`: it no longer limits anything, so the loan reads as an ordinary one.
 */
export function phaseOf(l: LoanRaw, now: Sec): LoanPhase {
  if (l.impairedAt !== 0n && !l.expired) return now < sec(l.seizeStart) ? 'flagged' : 'seize';
  return now > sec(l.maturity) ? 'late' : 'active';
}

/**
 * What is wrong with the rig that raised the flag, from the BSC read of that rig. The kinds follow the evidence the
 * contracts accept (SPEC §7.2): a rig the vault no longer holds (a rescue), a stop (`stopBlock` is set), a status that is no longer active
 * (named so, not "revoked": no code here proves a revocation), or no base power.
 * Anything else, such as a voucher that synced power 0, reads as the generic line.
 */
export function impairmentOf(f: RigFacts | undefined): ImpairmentKind {
  const b = f?.bsc;
  if (!b) return 'unknown';
  if (b.circuits.toLowerCase() === ZERO_ADDRESS || !b.custodied) return 'rescued';
  if (b.stopBlock !== 0n) return 'stopped';
  if (b.status !== 1) return 'inactive';
  if (b.verifWeight <= b.bonus) return 'no-power';
  return 'unknown';
}

const isMining = (f: RigFacts): boolean => f.bsc !== null && f.bsc.status === 1 && f.bsc.stopBlock === 0n && f.bsc.custodied;

/** One collateral row. A rig that could not be read shows zeros and "not mining" rather than a guess. */
export function collateralRow(id: number, rig: RigView | undefined): CollateralRow {
  if (!rig) return { id, basePower: 0n, processor: null, age: 0, mining: false };
  return { id, basePower: rig.basePower ?? 0n, processor: rig.processor, age: rig.age ?? 0, mining: isMining(rig.facts) };
}

export interface OpenLoanInputs {
  agent: Address;
  raw: LoanRaw;
  /** `BEM.balanceOf(agent)`. */
  agentBem: bigint;
  now: Sec;
  /** The agent's collateral ids, ascending. */
  collateral: number[];
  rigs: ReadonlyMap<number, RigView>;
  rules: RulesView;
  params: PoolParams;
  /** From the log search; null while it is unknown. */
  info: OpenInfo | null;
}

export function buildOpenLoan(i: OpenLoanInputs): LoanView {
  const { raw, params } = i;
  const term = termOf(raw.term);
  const phase = phaseOf(raw, i.now);
  const rows = i.collateral.map((id) => collateralRow(id, i.rigs.get(id)));
  const views = i.collateral.map((id) => i.rigs.get(id));
  // the BEM mined and not harvested: unknown as soon as one rig of the loan is
  const minedBsc = views.some((r) => r?.mined == null) ? null : views.reduce((s, r) => s + (r?.mined ?? 0n), 0n);
  const expected = views.reduce((s, r) => s + expectedOutput(r?.basePower ?? 0n, i.rules.totalVerifWeight, term), 0n);
  const flagged = raw.impairedAt !== 0n && !raw.expired;
  const impairedRig = raw.impairedRig === 0n && !flagged ? null : Number(raw.impairedRig);
  return {
    agent: i.agent,
    rigIds: [...i.collateral],
    collateral: rows,
    phase,
    term,
    start: sec(raw.start),
    maturity: sec(raw.maturity),
    advance: raw.principal0,
    principal: raw.principal,
    feeLeft: raw.feeLeft,
    lateFee: raw.lateFeeDue,
    lateBpsPerDay: raw.lateBpsPerDay,
    feePaid: i.info?.feePaid ?? null,
    opsFeePaid: i.info?.opsFeePaid ?? null,
    agentBem: i.agentBem,
    minedBsc,
    expectedPerDay: expected / BigInt(params.termDays[term]),
    impairedAt: flagged ? sec(raw.impairedAt) : null,
    seizeStart: flagged ? sec(raw.seizeStart) : null,
    deadline: flagged && raw.deadline !== (1n << 64n) - 1n ? sec(raw.deadline) : null,
    deadlinePaused: flagged && raw.deadline === (1n << 64n) - 1n,
    doubtful: raw.doubtful,
    expired: raw.expired,
    impairedRig: flagged ? impairedRig : null,
    impairment: flagged ? impairmentOf(i.rigs.get(Number(raw.impairedRig))?.facts) : null,
    seizedAt: null,
    writtenOff: null,
    clearedAt: null,
    surplus: null,
  };
}

/**
 * The loan of a closed agent, from the `Seized` event and `loanOf()` one block before it. The principal and the fee
 * left are 0 (the pool wrote them off), and the debt row shows "Written off".
 */
export function buildSeizedLoan(agent: Address, info: SeizeInfo, rigs: ReadonlyMap<number, RigView>): LoanView {
  const raw = info.loan;
  const ids = [...info.moved, ...info.stuck].sort((a, b) => a - b);
  const term = termOf(raw?.term ?? 0);
  const impairedRig = raw && raw.impairedRig !== 0n ? Number(raw.impairedRig) : null;
  return {
    agent,
    rigIds: ids,
    collateral: ids.map((id) => ({ ...collateralRow(id, rigs.get(id)), mining: false })),
    phase: 'seized',
    term,
    start: raw ? sec(raw.start) : info.seizedAt,
    maturity: raw ? sec(raw.maturity) : info.seizedAt,
    advance: raw?.principal0 ?? 0n,
    principal: 0n,
    feeLeft: 0n,
    lateFee: 0n,
    lateBpsPerDay: raw?.lateBpsPerDay ?? 0,
    feePaid: info.open?.feePaid ?? null,
    opsFeePaid: info.open?.opsFeePaid ?? null,
    agentBem: 0n,
    minedBsc: 0n,
    expectedPerDay: 0n,
    impairedAt: raw && raw.impairedAt !== 0n ? sec(raw.impairedAt) : null,
    seizeStart: raw && raw.impairedAt !== 0n ? sec(raw.seizeStart) : null,
    deadline: raw && raw.impairedAt !== 0n && raw.deadline !== (1n << 64n) - 1n ? sec(raw.deadline) : null,
    deadlinePaused: raw?.deadline === (1n << 64n) - 1n,
    impairedRig,
    impairment: impairedRig === null ? null : impairmentOf(rigs.get(impairedRig)?.facts),
    seizedAt: info.seizedAt,
    writtenOff: info.writtenOff,
    clearedAt: null,
    surplus: null,
  };
}

/**
 * A loan that ended in a repayment whose receipt this session saw. The chain keeps nothing of a cleared loan
 * (SPEC-PHASE5-APP §5.5), so this is the open loan as the session last saw it, with the debt paid.
 */
export function clearedFrom(open: LoanView, clearedAt: Sec, surplus: bigint | null, agentBem: bigint): LoanView {
  return { ...open, phase: 'cleared', principal: 0n, feeLeft: 0n, lateFee: 0n, agentBem, clearedAt, surplus, impairedAt: null, seizeStart: null, deadline: null, deadlinePaused: false, doubtful: false, expired: false, impairedRig: null, impairment: null };
}

/* ───────── when the loan should be repaid (SPEC-PHASE5-PAYOFF) ───────── */

/**
 * `sweep`: the agent already holds the debt and the next sweep repays it. `covered`: the keeper's covered harvest fires
 * at its next check. `before`: the rig's output covers the debt before the maturity window. `maturity`: the harvest in
 * the last hour before maturity does it. `short`: not even that. `unknown`: no output rate to project with. `none`: not
 * an open, unflagged loan before maturity, or the BEM mined on BSC is unknown.
 */
export type PayoffKind = 'none' | 'sweep' | 'covered' | 'before' | 'maturity' | 'short' | 'unknown';

export interface Payoff {
  kind: PayoffKind;
  /** About when the loan is repaid, rounded up to ten minutes; null for none, short and unknown. */
  at: Sec | null;
  /** `before`: when the mined BEM reaches what the keeper's covered check asks for. */
  cover: Sec | null;
}

/** One keeper sweep (every 10 minutes per agent). */
const SWEEP_WAIT = 600;
/** One 10-minute covered check, the delivery over the bridge (about a minute) and one sweep. */
const HARVEST_WAIT = 1_200;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const up10 = (s: Sec): Sec => Math.ceil(s / 600) * 600;

/**
 * When the loan should be repaid, by the keeper's own rules (SPEC-PHASE3-KEEPER-OPS §3.1): its covered harvest fires
 * once the agent's BEM plus the rigs' bridged output reaches the debt plus 1%, and otherwise it harvests in the last
 * hour before maturity. The output rate is the expected BASE output, so the estimate errs late while a design bonus
 * lasts; the bridge fee and a dust of rounding per rig are added back, so it errs late there too.
 */
export function payoffEstimate(L: LoanView, feeBps: number, now: Sec): Payoff {
  const d = L.principal + L.feeLeft + L.lateFee;
  const mined = L.minedBsc;
  if (L.phase !== 'active' || d === 0n || mined === null) return { kind: 'none', at: null, cover: null };
  const inAgent = L.agentBem;
  if (inAgent >= d) return { kind: 'sweep', at: up10(now + SWEEP_WAIT), cover: null };
  const keep = BigInt(10_000 - Math.min(10_000, Math.max(0, feeBps)));
  if (keep === 0n) return { kind: 'unknown', at: null, cover: null };
  const landedOf = (m: bigint): bigint => ((m / DUST) * DUST * keep) / 10_000n;
  const window = L.maturity - 3_600;
  if (now < window && (inAgent + landedOf(mined)) * 100n >= d * 101n) return { kind: 'covered', at: up10(now + HARVEST_WAIT), cover: now };
  const rate = L.expectedPerDay;
  if (rate <= 0n) return { kind: 'unknown', at: null, cover: null };
  if (now < window) {
    const need = ceilDiv(d * 101n, 100n) - inAgent;
    const minedNeed = ceilDiv(need * 10_000n, keep) + BigInt(Math.max(1, L.rigIds.length)) * DUST;
    const cover = now + Math.max(0, Number(ceilDiv((minedNeed - mined) * 86_400n, rate)));
    if (cover < window) return { kind: 'before', at: up10(cover + HARVEST_WAIT), cover };
  }
  // the harvest in the maturity window takes everything mined by then
  const minedThen = mined + (rate * BigInt(Math.max(0, window - now))) / 86_400n;
  if (inAgent + landedOf(minedThen) >= d) return { kind: 'maturity', at: up10(Math.max(now, window) + HARVEST_WAIT), cover: null };
  return { kind: 'short', at: null, cover: null };
}

/* ───────── how far the debt is repaid, and mined toward (SPEC-PHASE5-PROGRESS) ───────── */

export interface DebtProgress {
  /** What is repaid on chain, in tenths of a percent of the debt at borrow (of the debt now when that is unknown). */
  repaid: number;
  /** BEM mined and not harvested yet, after the bridge fee, plus BEM waiting in the agent; null when the mined BEM is unknown. */
  mined: number | null;
  /** Where the keeper's covered harvest fires: what is repaid plus the debt now × 1.01. */
  trigger: number;
}

/** Tenths of a percent, rounded down. */
const tenths = (n: bigint, of: bigint): number => (of > 0n ? Number((n * 1_000n) / of) : 0);

/**
 * The two segments of the loan's repayment bar. The keeper repays in one step, when the rigs' output covers the debt, so
 * what is repaid alone stays at 0% for days; what is mined toward the debt (after the bridge fee, by the same rule as
 * `payoffEstimate`) shows the way there. BEM in the agent is not repaid until a sweep, so it counts as mined.
 */
export function debtProgress(L: LoanView, feeBps: number): DebtProgress {
  const d = L.principal + L.feeLeft + L.lateFee;
  const atBorrow = L.feePaid === null ? null : L.advance + L.feePaid;
  const base = atBorrow ?? d;
  const repaid = atBorrow === null ? 0n : atBorrow - d;
  const keep = BigInt(10_000 - Math.min(10_000, Math.max(0, feeBps)));
  const mined = L.minedBsc === null ? null : L.agentBem + ((L.minedBsc / DUST) * DUST * keep) / 10_000n;
  return { repaid: tenths(repaid, base), mined: mined === null ? null : tenths(mined, base), trigger: tenths(repaid * 100n + d * 101n, base * 100n) };
}
