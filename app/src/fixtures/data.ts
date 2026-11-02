import { getAddress } from 'viem/utils';
import { DAY, HOUR, MIN_RIG_AGE } from '../constants';
import { debtBucket, expectedOutput } from '../logic/creditMath';
import { fee } from '../logic/fees';
import { buildRigView } from '../logic/rigState';
import type {
  AgentView,
  Address,
  BscFacts,
  CollateralRow,
  GateRecord,
  GateState,
  HarvestView,
  Hex,
  LoanPhase,
  LoanView,
  PoolParams,
  Processor,
  Quote,
  RigFacts,
  RigPlace,
  Sec,
  Snapshot,
  TermIndex,
  WalletOption,
} from '../model';

/** Sample data for the fixtures. Every number here is invented for the screens, except the deployed addresses and the mainnet parameters. */

/** Two wallets for the connect dialog and the account menu. The icon is a base64 data URI, as a real wallet announces it. */
export const SAMPLE_WALLETS: readonly WalletOption[] = [
  { id: 'sample-okx', name: 'OKX Wallet', icon: null, rdns: 'com.okex.wallet', fallback: false },
  {
    id: 'sample-metamask',
    name: 'MetaMask',
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA4IDgiPjxyZWN0IHdpZHRoPSI4IiBoZWlnaHQ9IjgiIHJ4PSIyIiBmaWxsPSIjRjY4NTFCIi8+PC9zdmc+',
    rdns: 'io.metamask',
    fallback: false,
  },
];

export const T0: Sec = Date.UTC(2026, 9, 19, 12, 23) / 1000;
export const ts = (m: number, d: number, h: number, min = 0): Sec => Date.UTC(2026, m - 1, d, h, min) / 1000;

const addr = (hex: string): Address => getAddress(`0x${hex.toLowerCase()}`) as Address;
const pad = (prefix: string, suffix: string, mid = ''): string => (prefix + mid).padEnd(40 - suffix.length, '0') + suffix;

export const ACCOUNT = addr(pad('3f1c', '9a2e'));
export const VIEWED = addr(pad('c905', '4b71'));
export const AGENT_A = addr(pad('51be', '09f3'));
export const AGENT_B = addr(pad('7a21', 'c4d0'));
export const AGENT_C = addr(pad('2d90', '5e18'));
export const AGENT_D = addr(pad('84e3', 'a07c'));
export const AGENT_E = addr(pad('b6f2', '31d9'));
export const AGENT_F = addr(pad('0c47', 'e8a5'));
export const AGENT_G = addr(pad('e1a8', '6b02'));
export const AGENT_H = addr(pad('46d5', 'f3c1'));
export const AGENT_I = addr(pad('a93b', '27e6'));
export const AGENT_NEW = addr(pad('9e04', '71ab'));

/** The deployed contracts (CLAUDE.md). */
export const CONTRACTS = {
  pool: '0xD54673E73448584E86C61f45203ab507F3F2c3eC' as Address,
  factory: '0xC365a30740c17b93fE92581667A2d60bD4b92355' as Address,
  policy: '0xBfE81f1e0D91e8D2C03ce4A015e9E096558f561D' as Address,
  screen: '0xc336C0a710e99D5BD72417B35f0E70Cff063918C' as Address,
  bem: '0x60e62Efa9405d6873C5deaBD4E6CC91c25363952' as Address,
  voucher: '0x9cfc959cd42B2e1d39a0d850c528210E818AE520' as Address,
};

const CPU: Record<Processor, Address> = {
  TapeOut: addr(pad('7a0f', '1001')),
  Behemoth: addr(pad('7a0f', '1002')),
  RefBench: addr(pad('7a0f', '1003')),
};

export const NETLIST_HASH = `0xbe89${'0'.repeat(56)}8b38` as Hex;

export const TOTAL_VERIF_WEIGHT = 1_650_000n;

/** The launch parameters on mainnet (CLAUDE.md, SPEC §4). */
export const MAINNET_PARAMS: PoolParams = {
  feeBps: [75, 150],
  maxDebtBps: [8_500, 8_000],
  termDays: [7, 14],
  minFee: 300_000n,
  minAdvance: 1_000_000n,
  lateFeeBpsPerDay: 0,
  perBorrowerBps: 4_000,
  borrowCapBps: 7_000,
  borrowCapAbs: 1_000_000_000n,
  supplyCap: 2_000_000_000n,
  opsFee: [31_000_000_000_000_000n, 31_000_000_000_000_000n],
};

export const bem = (whole: number): bigint => BigInt(Math.round(whole * 1e8));
export const okb = (whole: number): bigint => BigInt(Math.round(whole * 1e6)) * 10n ** 12n;

/* ───────── rigs ───────── */

export type PassKind = 'ok' | 'none' | 'pending' | 'suspended' | 'changed';

export interface RigSpec {
  id: number;
  proc?: Processor | null;
  base?: number;
  bonus?: number;
  /** Days since the rig started mining, at T0. */
  age?: number;
  /** Overrides `age`: the exact start time. */
  since?: Sec;
  /** BEM mined and not harvested (`BscFacts.mined`). */
  mined?: bigint;
  pass?: PassKind;
  passAt?: Sec;
  status?: number;
  noBsc?: boolean;
  voucherPower?: bigint;
  voucherCircuitId?: bigint;
  place?: RigPlace;
}

export function rigFacts(s: RigSpec): RigFacts {
  const proc = s.proc === undefined ? 'TapeOut' : s.proc;
  const circuits = proc ? CPU[proc] : addr(pad('dead', 'beef'));
  const base = BigInt(s.base ?? 20);
  const bonus = BigInt(s.bonus ?? 0);
  const since = s.since ?? T0 - Math.round((s.age ?? 30) * DAY);
  const circuitId = BigInt(s.id);
  const bsc: BscFacts | null = s.noBsc
    ? null
    : {
        status: s.status ?? 1,
        stopBlock: 0n,
        custodied: true,
        verifWeight: base + bonus,
        bonus,
        since,
        mined: s.mined ?? 0n,
        circuits,
        circuitId,
        taskId: 4n,
      };
  const kind = s.pass ?? 'ok';
  const pass =
    kind === 'none'
      ? null
      : {
          circuits,
          circuitId,
          taskId: kind === 'changed' ? 7n : 4n,
          effectiveAt: kind === 'pending' ? (s.passAt ?? T0 + 2 * DAY) : (s.passAt ?? since + 5 * DAY),
        };
  return {
    id: s.id,
    place: s.place ?? { kind: 'wallet' },
    bsc,
    bscAsOf: null,
    voucher: { circuits, circuitId: s.voucherCircuitId ?? circuitId, power: s.voucherPower ?? base + bonus },
    processor: proc,
    screen: { pass, suspended: kind === 'suspended' },
  };
}

export const WALLET_RIGS: RigSpec[] = [
  { id: 4127, proc: 'TapeOut', base: 48, age: 41, mined: bem(0.018) },
  { id: 4128, proc: 'Behemoth', base: 32, age: 29, mined: bem(0.41) },
  { id: 3990, proc: 'RefBench', base: 6, age: 9, mined: bem(0.0031), pass: 'pending', passAt: ts(10, 21, 8) },
  { id: 4301, proc: 'TapeOut', base: 18, age: 12, mined: bem(0.041), pass: 'none' },
  { id: 4233, proc: 'Behemoth', base: 22, since: ts(10, 20, 14) - MIN_RIG_AGE, mined: bem(0.012) },
  { id: 4019, proc: 'TapeOut', base: 0, bonus: 5, age: 33 },
];

/** One rig for each of the other rows of the SPEC-PHASE5-APP §5.2 table. */
export const EXTRA_RIGS: RigSpec[] = [
  { id: 5101, noBsc: true },
  { id: 5102, status: 2, base: 12, age: 20 },
  { id: 5103, proc: null, base: 12, age: 20 },
  { id: 5104, base: 12, age: 20, voucherPower: 0n },
  { id: 5105, base: 12, age: 20, voucherCircuitId: 9_999n },
  { id: 5106, base: 12, age: 20, pass: 'suspended' },
  { id: 5107, base: 12, age: 20, pass: 'changed' },
  { id: 6001, base: 25, age: 36, place: { kind: 'agent', agent: AGENT_C, closed: false, collateral: true, loanOpen: false } },
  { id: 6002, base: 25, age: 36, place: { kind: 'agent', agent: AGENT_D, closed: false, collateral: false, loanOpen: false } },
  { id: 6003, base: 25, age: 36, place: { kind: 'agent', agent: AGENT_E, closed: true, collateral: false, loanOpen: false } },
  { id: 6010, base: 16, age: 44, place: { kind: 'agent', agent: AGENT_F, closed: true, collateral: true, loanOpen: false } },
  { id: 6020, base: 9, age: 50, place: { kind: 'pool', agent: AGENT_G } },
  { id: 6030, base: 30, age: 40, mined: bem(0.02), place: { kind: 'agent', agent: AGENT_H, closed: false, collateral: true, loanOpen: true } },
  { id: 6031, base: 22, age: 38, mined: bem(0.011), place: { kind: 'agent', agent: AGENT_H, closed: false, collateral: true, loanOpen: true } },
  { id: 6040, base: 15, age: 47, place: { kind: 'agent', agent: AGENT_I, closed: false, collateral: true, loanOpen: false } },
];

/* ───────── loans ───────── */

const perDay = (base: number, term: TermIndex): bigint => expectedOutput(BigInt(base), TOTAL_VERIF_WEIGHT, term) / BigInt(term === 0 ? 7 : 14);

export function collateralRow(f: RigFacts, mining = true): CollateralRow {
  const base = f.bsc ? f.bsc.verifWeight - f.bsc.bonus : 0n;
  return { id: f.id, basePower: base, processor: f.processor, age: f.bsc ? T0 - f.bsc.since : 0, mining };
}

export function newLoan(agent: Address, rigs: RigFacts[], over: Partial<LoanView> = {}): LoanView {
  const term: TermIndex = over.term ?? 1;
  const advance = over.advance ?? bem(0.6);
  const feePaid = over.feePaid ?? fee(MAINNET_PARAMS, term, advance);
  const days = MAINNET_PARAMS.termDays[term];
  const start = over.start ?? T0;
  const baseSum = rigs.reduce((s, r) => s + Number(r.bsc ? r.bsc.verifWeight - r.bsc.bonus : 0n), 0);
  return {
    agent,
    rigIds: rigs.map((r) => r.id).sort((a, b) => a - b),
    collateral: rigs.map((r) => collateralRow(r)),
    phase: 'active',
    term,
    start,
    maturity: start + days * DAY,
    advance,
    principal: advance,
    feeLeft: feePaid,
    lateFee: 0n,
    lateBpsPerDay: MAINNET_PARAMS.lateFeeBpsPerDay,
    feePaid,
    opsFeePaid: MAINNET_PARAMS.opsFee[term],
    agentBem: 0n,
    minedBsc: rigs.reduce((s, r) => s + (r.bsc?.mined ?? 0n), 0n),
    expectedPerDay: perDay(baseSum, term),
    impairedAt: null,
    seizeStart: null,
    deadline: null,
    impairedRig: null,
    impairment: null,
    seizedAt: null,
    writtenOff: null,
    clearedAt: null,
    surplus: null,
    ...over,
  };
}

/** The loan on rig #3871 in each phase the screens show (the sample from the design). */
export function loanOn3871(phase: LoanPhase): { loan: LoanView; now: Sec; stopped: boolean } {
  const rig = rigFacts({ id: 3871, proc: 'TapeOut', base: 14, age: 58, mined: bem(0.0623) });
  const common = { advance: bem(0.6), feePaid: bem(0.009), start: ts(10, 12, 9, 15), maturity: ts(10, 26, 9, 15), principal: bem(0.308), feeLeft: 0n, agentBem: bem(0.0412) };
  const flagAt = ts(10, 19, 8, 10);
  const flag = { impairedAt: flagAt, seizeStart: flagAt + 72 * HOUR, deadline: flagAt + 96 * HOUR, impairedRig: 3871, impairment: 'stopped' as const };
  const mk = (over: Partial<LoanView>, stopped = false): LoanView => ({
    ...newLoan(AGENT_A, [rig], { ...common, ...over }),
    collateral: [collateralRow(rig, !stopped)],
    phase,
  });
  switch (phase) {
    case 'late':
      return { loan: mk({ principal: bem(0.118), agentBem: 0n, minedBsc: bem(0.059), expectedPerDay: bem(0.033) }), now: ts(10, 27, 10), stopped: false };
    case 'flagged':
      return { loan: mk({ agentBem: 0n, ...flag }, true), now: T0, stopped: true };
    case 'seize':
      return { loan: mk({ agentBem: 0n, ...flag }, true), now: ts(10, 22, 12), stopped: true };
    case 'seized':
      return {
        loan: mk({ principal: 0n, agentBem: 0n, minedBsc: 0n, writtenOff: bem(0.308), seizedAt: ts(10, 22, 19, 40), ...flag }, true),
        now: ts(10, 22, 20),
        stopped: true,
      };
    case 'cleared':
      return {
        loan: mk({ principal: 0n, agentBem: 0n, minedBsc: bem(0.004), clearedAt: ts(10, 25, 18, 2), surplus: bem(0.0315) }),
        now: ts(10, 25, 18, 30),
        stopped: false,
      };
    default:
      return { loan: mk({ expectedPerDay: perDay(14, 1) }), now: T0, stopped: false };
  }
}

/* ───────── quotes ───────── */

/** A `TapeLens.quote` as the lens would answer it for an agent, from the same math the estimate uses. */
export function makeQuote(params: PoolParams, term: TermIndex, expected: bigint, room: bigint, pending: bigint, reason = 0, inputBits?: number): Quote {
  const debtLimit = (expected * BigInt(params.maxDebtBps[term])) / 10_000n;
  let p = debtLimit > params.minFee ? debtLimit - params.minFee : 0n;
  while (p > 0n && p + fee(params, term, p) > debtLimit) p -= 1n;
  if (p > room) p = room;
  const f = fee(params, term, p);
  const bits = inputBits ?? (0b11111 << 7) | (debtBucket(p + f, expected) << 2) | term;
  return { maxPrincipal: reason === 0 ? p : 0n, fee: reason === 0 ? f : 0n, expected, inputBits: bits, reason, pending, opsFee: params.opsFee[term] };
}

export type RuleAnswer = 'allow' | 'deny' | 'deny-small' | 'cant';

/** The lens answers for an agent, as the chosen credit-rule outcome would give them. */
export function quotesFor(snap: Snapshot, agent: AgentView, rule: RuleAnswer = 'allow'): readonly [Quote, Quote] {
  const rigs = snap.rigs.filter((r) => agent.collateral.includes(r.id));
  const pending = rigs.reduce((x, r) => x + (r.mined ?? 0n), 0n);
  const p = snap.pool.params;
  const one = (term: TermIndex): Quote => {
    const expected = rigs.reduce((x, r) => x + expectedOutput(r.basePower ?? 0n, snap.rules.totalVerifWeight, term), 0n);
    const room = snap.wallet.room;
    if (rule === 'deny') return makeQuote(p, term, expected, room, pending, 6, ((0b11111 & ~0b10000) << 7) | term);
    if (rule === 'deny-small') return makeQuote(p, term, expected, room, pending, 6, (0b11111 << 7) | term);
    if (rule === 'cant') return makeQuote(p, term, expected, room, pending, 4, 0);
    return makeQuote(p, term, expected, room, pending);
  };
  return [one(0), one(1)];
}

/* ───────── the base snapshot ───────── */

/** The bridge fee of today (50 bps), no records, and what a harvest needs, read for the rigs of the wallet that have BEM to harvest. */
export function baseHarvest(): HarvestView {
  return {
    headTime: T0,
    feeBps: 50,
    storage: true,
    gates: {},
    prep: { block: 128_369_000n, time: T0, quotes: Array.from({ length: 16 }, (_, i) => BigInt(i + 1) * 1_500_000_000_000_000n), contracts: 'ok', mark: Object.fromEntries(WALLET_RIGS.map((r) => [String(r.id), true])) },
  };
}

/** A record of a harvest, for the fixtures that show one on its way. */
export function gateRecord(id: number, state: GateState, over: Partial<GateRecord> = {}): GateRecord {
  return {
    id,
    wallet: ACCOUNT,
    hash: state === 'prompting' ? null : `0x${'ab'.repeat(32)}`,
    nonce: null,
    harvestedAt: null,
    block: null,
    amount: null,
    createdAt: T0 - 20,
    state,
    floor: null,
    base: null,
    agent: null,
    movedBlock: null,
    cursor: null,
    movedAt: null,
    ...over,
  };
}

export function agentView(address: Address, over: Partial<AgentView> = {}): AgentView {
  return { address, closed: false, collateral: [], loose: [], bem: 0n, ...over };
}

export function baseSnapshot(): Snapshot {
  const specs = WALLET_RIGS;
  const loan = loanOn3871('active');
  const aFacts = rigFacts({ id: 3871, proc: 'TapeOut', base: 14, age: 58, mined: bem(0.0623), place: { kind: 'agent', agent: AGENT_A, closed: false, collateral: true, loanOpen: true } });
  const facts = [aFacts, ...specs.map(rigFacts)];
  const snap: Snapshot = {
    now: T0,
    wallet: {
      status: 'connected',
      account: ACCOUNT,
      bem: bem(3.5),
      okb: okb(0.084),
      room: bem(5.321),
      borrowGas: okb(0.0003),
      allowancePool: 0n,
      allowanceAgent: {},
    },
    pool: {
      totalAssets: bem(14.265),
      outstanding: bem(4.12),
      idle: bem(10.145),
      doubtful: 0n,
      params: MAINNET_PARAMS,
      tpbemValue: bem(1.0087),
      borrowsPaused: false,
      feedDisabled: false,
      pendingPolicy: null,
      queued: [],
      circuit: { processorName: 'Tape Pool Policy', processorSymbol: 'TPPOL', circuits: '0xdc76f123838b5398A173D215a2c8338Ad189C9a8', circuitId: 1, gates: 44, netlistHash: NETLIST_HASH },
      contracts: CONTRACTS,
    },
    rules: { totalVerifWeight: TOTAL_VERIF_WEIGHT, emissionValidUntil: T0 + 400 * DAY },
    position: { tpbem: 500_000_000_000_000n, value: bem(5.0435), withdrawable: bem(5.0435), maxDeposit: bem(5.735), growth: bem(0.0435) },
    keeper: { reachable: true, apy7d: '0.091900', selfPushBnb: 1_700_000_000_000_000n },
    rigs: facts.map((f) => buildRigView(f, T0)),
    agents: [agentView(AGENT_A, { collateral: [3871], bem: loan.loan.agentBem }), agentView(AGENT_B, { bem: bem(0.0123) })],
    loans: [loan.loan],
    reports: {},
    quotes: {},
    harvest: baseHarvest(),
    pending: null,
    stale: {},
  };
  return snap;
}

/** The base plus one rig for each remaining row of the §5.2 table, and a grouped and a cleared loan. */
export function withAllStates(snap: Snapshot): Snapshot {
  const extra = EXTRA_RIGS.map(rigFacts);
  const byId = (id: number): RigFacts => extra.find((f) => f.id === id) as RigFacts;
  const grouped = newLoan(AGENT_H, [byId(6030), byId(6031)], { term: 0, advance: bem(0.9), start: ts(10, 16, 10), principal: bem(0.9), agentBem: bem(0.01) });
  const cleared = { ...newLoan(AGENT_I, [byId(6040)], { term: 0, advance: bem(0.4), start: ts(10, 14, 9) }), phase: 'cleared' as const, principal: 0n, feeLeft: 0n, clearedAt: ts(10, 19, 9), surplus: bem(0.002) };
  const seized = { ...loanOn3871('seized').loan, agent: AGENT_G, rigIds: [6020], collateral: [collateralRow(byId(6020), false)], impairedRig: 6020, impairment: 'stopped' as const };
  return {
    ...snap,
    rigs: [...snap.rigs, ...extra.map((f) => buildRigView(f, snap.now))],
    agents: [
      ...snap.agents,
      agentView(AGENT_C, { collateral: [6001] }),
      agentView(AGENT_D, { loose: [6002] }),
      agentView(AGENT_E, { closed: true, loose: [6003] }),
      agentView(AGENT_F, { closed: true, collateral: [6010] }),
      agentView(AGENT_G, { closed: true }),
      agentView(AGENT_H, { collateral: [6030, 6031], bem: bem(0.01) }),
      agentView(AGENT_I, { collateral: [6040] }),
    ],
    loans: [...snap.loans, grouped, cleared, seized],
  };
}
