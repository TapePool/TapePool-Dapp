import { buildRigView } from '../logic/rigState';
import type { GateRecord, HarvestView, LoanPhase, ParamKey, PoolParams, Snapshot, WalletOption } from '../model';
import { freshUi, type UiState } from '../state';
import {
  AGENT_B,
  AGENT_C,
  CONTRACTS,
  VIEWED,
  agentView,
  baseSnapshot,
  bem,
  gateRecord,
  loanOn3871,
  okb,
  quotesFor,
  rigFacts,
  SAMPLE_WALLETS,
  T0,
  ts,
  withAllStates,
  type RuleAnswer,
} from './data';
import { FixtureStore, type FixtureOptions } from './store';

/**
 * Named fixtures: one for each wallet state, pool state, §5.2 row, loan phase and borrow-flow step.
 * `hash` is the page that shows the state. In a dev build, `?fixture=<name>` picks one.
 */
export interface FixtureDef {
  title: string;
  hash: string;
  build: () => Snapshot;
  ui?: (u: UiState) => void;
  rule?: RuleAnswer;
}

const connected = (): Snapshot => baseSnapshot();
const all = (): Snapshot => withAllStates(baseSnapshot());

const mapWallet = (s: Snapshot, w: Partial<Snapshot['wallet']>): Snapshot => ({ ...s, wallet: { ...s.wallet, ...w } });

/** Not connected, with these wallets found in the browser (MetaMask was used last). */
const withWallets = (found: readonly WalletOption[]): Snapshot => mapWallet(connected(), { status: 'disconnected', options: found, active: null, recent: 'io.metamask' });
const picking = (u: UiState): void => {
  u.picker = { busy: null, error: null, view: { kind: 'about' } };
};
const mapPool = (s: Snapshot, p: Partial<Snapshot['pool']>): Snapshot => ({ ...s, pool: { ...s.pool, ...p } });
const withParams = (s: Snapshot, p: Partial<PoolParams>): Snapshot => mapPool(s, { params: { ...s.pool.params, ...p } });

/** Rig #3871's loan in a given phase, with the pool and the rig brought in line with it. */
function loanPhase(phase: LoanPhase): Snapshot {
  const s = baseSnapshot();
  const { loan, now, stopped } = loanOn3871(phase);
  const open = phase === 'active' || phase === 'late' || phase === 'flagged' || phase === 'seize';
  const closed = phase === 'seized';
  const facts = rigFacts({
    id: 3871,
    proc: 'TapeOut',
    base: 14,
    age: 58,
    mined: loan.minedBsc ?? undefined,
    status: stopped ? 2 : 1,
    place: closed ? { kind: 'pool', agent: loan.agent } : { kind: 'agent', agent: loan.agent, closed: false, collateral: true, loanOpen: open },
  });
  const doubtful = phase === 'flagged' || phase === 'seize' ? loan.principal : 0n;
  return {
    ...s,
    now,
    rigs: s.rigs.map((r) => (r.id === 3871 ? buildRigView(facts, now) : r)),
    agents: s.agents.map((a) => (a.address === loan.agent ? { ...a, closed, collateral: closed ? [] : [3871], bem: loan.agentBem } : a)),
    loans: [loan],
    pool: { ...s.pool, doubtful },
    position: s.position ? { ...s.position, maxDeposit: doubtful > 0n ? 0n : s.position.maxDeposit } : null,
  };
}

/** Rig #4127 moved into a new agent, with the report and quote state a step of the borrow flow needs. */
function flowSnapshot(step: 'agent' | 'moved' | 'waiting' | 'fresh' | 'expired', rule: RuleAnswer = 'allow', from: Snapshot = baseSnapshot()): Snapshot {
  let s = from;
  const agent = agentView(AGENT_C, step === 'agent' ? {} : { collateral: [4127] });
  s = { ...s, agents: [...s.agents, agent] };
  if (step !== 'agent') {
    const moved = rigFacts({ id: 4127, proc: 'TapeOut', base: 48, age: 41, mined: bem(0.018), place: { kind: 'agent', agent: AGENT_C, closed: false, collateral: true, loanOpen: false } });
    s = { ...s, rigs: s.rigs.map((r) => (r.id === 4127 ? buildRigView(moved, s.now) : r)) };
  }
  if (step === 'waiting') s = { ...s, pending: { action: 'refresh', since: s.now, hash: null } };
  if (step === 'fresh') s = { ...s, reports: { '4127': { observedAt: s.now - 20 } }, quotes: { [AGENT_C.toLowerCase()]: quotesFor(s, agent, rule) } };
  if (step === 'expired') s = { ...s, reports: { '4127': { observedAt: s.now - 400 } } };
  return s;
}

const flowUi = (u: UiState): void => {
  u.sel = [4127];
  u.agent = AGENT_C;
};

const queued = (key: ParamKey, value: bigint, eta: number) => ({ key, value, eta });

/** A rig of the snapshot with another amount of BEM mined and not harvested (null: the BSC read failed). */
function withMined(s: Snapshot, id: number, mined: bigint | null): Snapshot {
  return { ...s, rigs: s.rigs.map((r) => (r.id === id ? buildRigView({ ...r.facts, bsc: r.facts.bsc ? { ...r.facts.bsc, mined } : null }, s.now) : r)) };
}

function withHarvest(s: Snapshot, patch: Partial<HarvestView>): Snapshot {
  return { ...s, harvest: { ...s.harvest, ...patch } };
}

/** An empty agent for the flow and the rig picked: step 2, "Move voucher", is the open step. */
function readyToMove(): Snapshot {
  return flowSnapshot('agent');
}

const flowFor = (id: number) => (u: UiState): void => {
  u.sel = [id];
  u.agent = AGENT_C;
};

/** Rig #4128 has the most BEM mined (0.41): a harvest of it is on its way, in the state of `rec`. */
function harvesting(rec: GateRecord, extra: Partial<Snapshot> = {}): Snapshot {
  const s = withHarvest(readyToMove(), { gates: { '4128': rec } });
  return { ...s, ...extra };
}

/** Rig #4128's voucher is in the agent, with its BEM still unharvested: the question of SPEC-PHASE5-PRELOAN §4.7. */
function minedInAgent(): Snapshot {
  const s = flowSnapshot('agent');
  const moved = rigFacts({ id: 4128, proc: 'Behemoth', base: 32, age: 29, mined: bem(0.41), place: { kind: 'agent', agent: AGENT_C, closed: false, collateral: true, loanOpen: false } });
  return {
    ...s,
    rigs: s.rigs.map((r) => (r.id === 4128 ? buildRigView(moved, s.now) : r)),
    agents: s.agents.map((a) => (a.address === AGENT_C ? { ...a, collateral: [4128] } : a)),
  };
}

/** Every on-chain parameter differs from mainnet, so a test can prove no number is written into the copy. */
function paramShift(): Snapshot {
  const p: PoolParams = {
    feeBps: [90, 190],
    maxDebtBps: [8_400, 7_900],
    termDays: [7, 14],
    minFee: bem(0.004),
    minAdvance: bem(0.02),
    lateFeeBpsPerDay: 10,
    perBorrowerBps: 3_500,
    borrowCapBps: 6_500,
    borrowCapAbs: bem(12),
    supplyCap: bem(25),
    opsFee: [okb(0.027), okb(0.029)],
  };
  let s = withParams(baseSnapshot(), p);
  s = {
    ...s,
    now: ts(11, 5, 12), // other dates than the prototype's
    keeper: { ...s.keeper, selfPushBnb: 2_100_000_000_000_000n },
    pool: {
      ...s.pool,
      pendingPolicy: { address: CONTRACTS.policy, eta: ts(11, 3, 15) },
      queued: [queued('opsFee7d', okb(0.052), ts(11, 2, 9)), queued('opsFee14d', okb(0.052), ts(11, 2, 9))],
    },
    wallet: { ...s.wallet, room: bem(6.4321) },
    // the open loan was taken under other terms
    loans: s.loans.map((l) => ({ ...l, opsFeePaid: okb(0.027), start: ts(10, 15, 9, 15), maturity: ts(10, 29, 9, 15) })),
  };
  return s;
}

export const FIXTURES: Record<string, FixtureDef> = {
  /* wallet */
  disconnected: { title: 'Wallet not connected', hash: '#/app', build: () => withWallets(SAMPLE_WALLETS) },
  'wrong-network': { title: 'Wallet on another network', hash: '#/app', build: () => mapWallet(connected(), { status: 'wrong-network' }) },
  connected: { title: 'Connected, the sample miner', hash: '#/app', build: connected },
  picker: { title: 'Connect dialog: two wallets found, one used last', hash: '#/app', build: () => withWallets(SAMPLE_WALLETS), ui: picking },
  'picker-fallback': { title: 'Connect dialog: only the plain window.ethereum', hash: '#/app', build: () => withWallets([{ id: 'window.ethereum', name: 'Browser wallet', icon: null, rdns: 'window.ethereum', fallback: true }]), ui: picking },
  'picker-none': { title: 'Connect dialog: no wallet in the browser', hash: '#/app/markets', build: () => withWallets([]), ui: picking },
  'picker-error': {
    title: 'Connect dialog: the wallet cannot go to X Layer',
    hash: '#/app',
    build: () => withWallets(SAMPLE_WALLETS),
    ui: (u) => {
      u.picker = { busy: null, error: { kind: 'wallet-no-xlayer', details: 'Unrecognized chain ID "0xc4"' }, view: { kind: 'connect', id: 'sample-okx' } };
    },
  },
  'picker-connecting': {
    title: 'Connect dialog: waiting for the wallet to confirm',
    hash: '#/app',
    build: () => withWallets(SAMPLE_WALLETS),
    ui: (u) => {
      u.picker = { busy: 'sample-metamask', error: null, view: { kind: 'connect', id: 'sample-metamask' } };
    },
  },
  'picker-get': {
    title: 'Connect dialog: Get a Wallet',
    hash: '#/app',
    build: () => withWallets(SAMPLE_WALLETS),
    ui: (u) => {
      u.picker = { busy: null, error: null, view: { kind: 'get', key: null } };
    },
  },
  'picker-get-wallet': {
    title: 'Connect dialog: Get one recommended wallet',
    hash: '#/app',
    build: () => withWallets(SAMPLE_WALLETS),
    ui: (u) => {
      u.picker = { busy: null, error: null, view: { kind: 'get', key: 'binance' } };
    },
  },
  menu: { title: 'Wallet menu open', hash: '#/app', build: () => mapWallet(connected(), { options: SAMPLE_WALLETS, active: SAMPLE_WALLETS[1] ?? null, recent: 'io.metamask' }), ui: (u) => { u.menu = true; } },
  'menu-copied': { title: 'Wallet menu open, the address was just copied', hash: '#/app', build: () => mapWallet(connected(), { options: SAMPLE_WALLETS, active: SAMPLE_WALLETS[1] ?? null, recent: 'io.metamask' }), ui: (u) => { u.menu = true; u.copied = 'ok'; } },
  'menu-copy-failed': { title: 'Wallet menu open, nothing could copy', hash: '#/app', build: () => mapWallet(connected(), { options: SAMPLE_WALLETS, active: SAMPLE_WALLETS[1] ?? null, recent: 'io.metamask' }), ui: (u) => { u.menu = true; u.copied = 'fail'; } },
  'menu-wrong-network': { title: 'Wallet menu open on another network', hash: '#/app', build: () => mapWallet(connected(), { status: 'wrong-network', options: SAMPLE_WALLETS, active: SAMPLE_WALLETS[0] ?? null }), ui: (u) => { u.menu = true; } },
  'low-okb': { title: 'Connected with too little OKB', hash: '#/app/rigs/4127', build: () => mapWallet(connected(), { okb: okb(0.01) }) },
  view: { title: 'Read-only view of an address', hash: `#/app/view/${VIEWED}`, build: connected },

  /* pages */
  markets: { title: 'Markets', hash: '#/app/markets', build: connected },
  'markets-disconnected': { title: 'Markets, no wallet', hash: '#/app/markets', build: () => mapWallet(connected(), { status: 'disconnected' }) },
  'pool-page': { title: 'BEM pool page', hash: '#/app/markets/bem', build: connected },
  'keeper-absent': { title: 'Keeper unreachable: no APY, no growth', hash: '#/app/markets/bem', build: () => ({ ...connected(), keeper: { reachable: false, apy7d: null, selfPushBnb: null }, position: { ...(connected().position as NonNullable<Snapshot['position']>), growth: null } }) },
  stale: { title: 'A read failed: old values marked stale', hash: '#/app/rigs', build: () => ({ ...connected(), stale: { pool: true, wallet: true, rigs: true, loans: true, keeper: true } }) },

  /* pool states */
  paused: { title: 'Borrows paused', hash: '#/app/rigs/4127', build: () => mapPool(connected(), { borrowsPaused: true }) },
  'feed-off': { title: 'Rig data feed off', hash: '#/app/rigs/4127', build: () => mapPool(connected(), { feedDisabled: true }) },
  // redeploy 3 RC3-02: lend waits FEED_SETTLE after enableFeed, and lendLimit answers (0, 5) meanwhile
  'feed-settling': { title: 'Feed just turned back on: borrowing reopens in minutes', hash: '#/app/rigs/4127', build: () => { const s = connected(); return mapWallet(mapPool(s, { feedSettleUntil: s.now + 240 }), { room: 0n, binding: 5 }); } },
  'swap-queued': { title: 'New credit rule queued', hash: '#/app/rigs/4127', build: () => mapPool(connected(), { borrowsPaused: true, pendingPolicy: { address: CONTRACTS.policy, eta: ts(10, 26, 12) } }) },
  'no-room': { title: 'No room in the pool for this miner', hash: '#/app/rigs', build: () => mapWallet(connected(), { room: bem(0.005) }) },
  'deposits-closed': {
    title: 'Deposits closed while a loan is doubtful',
    hash: '#/app',
    build: () => ({ ...mapPool(connected(), { doubtful: bem(0.308) }), position: { ...(connected().position as NonNullable<Snapshot['position']>), maxDeposit: 0n } }),
  },
  'fee-queued': {
    title: 'Operating fee change queued',
    hash: '#/app/rigs/4127',
    build: () => mapPool(connected(), { queued: [queued('opsFee7d', okb(0.04), ts(10, 21, 14)), queued('opsFee14d', okb(0.04), ts(10, 21, 14))] }),
  },
  'ops-fee-zero': { title: 'Operating fee is 0', hash: '#/app/rigs/4127', build: () => withParams(connected(), { opsFee: [0n, 0n] }) },
  'param-shift': { title: 'Every parameter differs from mainnet', hash: '#/app/rigs/4127', build: paramShift },
  'param-shift-flow': { title: 'The same, at the last step of the borrow flow', hash: '#/app/rigs/4127', build: () => flowSnapshot('fresh', 'allow', paramShift()), ui: flowUi },

  /* loans */
  'loan-active': { title: 'Loan: active', hash: '#/app/rigs/3871', build: () => loanPhase('active') },
  'loan-late': { title: 'Loan: past maturity', hash: '#/app/rigs/3871', build: () => loanPhase('late') },
  'loan-flagged': { title: 'Loan: flagged, cure window', hash: '#/app/rigs/3871', build: () => loanPhase('flagged') },
  'loan-seize': { title: 'Loan: seize window', hash: '#/app/rigs/3871', build: () => loanPhase('seize') },
  'loan-seized': { title: 'Loan: seized', hash: '#/app/rigs/3871', build: () => loanPhase('seized') },
  'loan-cleared': { title: 'Loan: debt cleared this session', hash: '#/app/rigs/3871', build: () => loanPhase('cleared') },
  'loan-grouped': { title: 'One loan for two rigs', hash: '#/app/rigs/6030', build: all },
  'repay-modal': { title: 'Repay modal', hash: '#/app/rigs/3871/repay', build: () => loanPhase('active') },

  /* the rows of the §5.2 table */
  'rigs-all': { title: 'Rigs page with a rig in every state', hash: '#/app/rigs', build: all },
  'rig-ready': { title: 'Row 14: ready', hash: '#/app/rigs/4127', build: all },
  'rig-screen-pending': { title: 'Row 13: screen pending', hash: '#/app/rigs/3990', build: all },
  'rig-screen-suspended': { title: 'Row 12: screen suspended', hash: '#/app/rigs/5106', build: all },
  'rig-screen-changed': { title: 'Row 12: pass no longer matches', hash: '#/app/rigs/5107', build: all },
  'rig-not-screened': { title: 'Row 12: no screen pass', hash: '#/app/rigs/4301', build: all },
  'rig-no-base-power': { title: 'Row 11: no base power', hash: '#/app/rigs/4019', build: all },
  'rig-too-new': { title: 'Row 10: too new', hash: '#/app/rigs/4233', build: all },
  'rig-mismatch': { title: 'Row 9b: voucher does not match', hash: '#/app/rigs/5105', build: all },
  'rig-not-synced': { title: 'Row 9a: voucher not synced', hash: '#/app/rigs/5104', build: all },
  'rig-processor': { title: 'Row 8: processor not supported', hash: '#/app/rigs/5103', build: all },
  'rig-not-mining': { title: 'Row 7: not mining', hash: '#/app/rigs/5102', build: all },
  'rig-no-data': { title: 'Row 6: no data yet', hash: '#/app/rigs/5101', build: all },
  'rig-loose-open': { title: 'Row 5: in an open agent, not collateral', hash: '#/app/rigs/6002', build: all },
  'rig-loose-closed': { title: 'Row 5: in a closed agent, not collateral', hash: '#/app/rigs/6003', build: all },
  'rig-in-agent': { title: 'Row 4: in your agent, no loan', hash: '#/app/rigs/6001', build: all },
  'rig-stuck': { title: 'Row 3: stuck after a seize', hash: '#/app/rigs/6010', build: all },
  'rig-seized': { title: 'Row 2: seized', hash: '#/app/rigs/6020', build: all },
  'rig-loan': { title: 'Row 1: in a loan', hash: '#/app/rigs/3871', build: all },

  /* the borrow flow, step by step */
  'flow-idle': { title: 'Borrow flow: nothing done', hash: '#/app/rigs/4127', build: connected },
  'flow-reuse': { title: 'Borrow flow: reusing the empty agent', hash: '#/app/rigs/4127', build: connected, ui: (u) => { u.sel = [4127]; u.agent = AGENT_B; u.reuse = true; } },
  'flow-agent': { title: 'Borrow flow: agent created', hash: '#/app/rigs/4127', build: () => flowSnapshot('agent'), ui: flowUi },
  'flow-moved': { title: 'Borrow flow: voucher moved in', hash: '#/app/rigs/4127', build: () => flowSnapshot('moved'), ui: flowUi },
  'flow-waiting': { title: 'Borrow flow: waiting for the report', hash: '#/app/rigs/4127', build: () => flowSnapshot('waiting'), ui: flowUi },
  'flow-fresh': { title: 'Borrow flow: fresh report, countdown', hash: '#/app/rigs/4127', build: () => flowSnapshot('fresh'), ui: flowUi },
  'flow-expired': { title: 'Borrow flow: report expired', hash: '#/app/rigs/4127', build: () => flowSnapshot('expired'), ui: flowUi },
  'flow-deny': { title: 'Borrow flow: the rule says no (a flag failed)', hash: '#/app/rigs/4127', build: () => flowSnapshot('fresh', 'deny'), ui: flowUi, rule: 'deny' },
  'flow-deny-small': { title: 'Borrow flow: the rule says no (too small)', hash: '#/app/rigs/4127', build: () => flowSnapshot('fresh', 'deny-small'), ui: flowUi, rule: 'deny-small' },
  'flow-cant-check': { title: "Borrow flow: the rule can't be checked", hash: '#/app/rigs/4127', build: () => flowSnapshot('fresh', 'cant'), ui: flowUi, rule: 'cant' },
  /* BEM mined before the loan (SPEC-PHASE5-PRELOAN): the choice at step 2, a harvest on its way, the question at step 3 */
  'flow-mined-choice': { title: 'Borrow flow: BEM mined before the loan, the required choice', hash: '#/app/rigs/4128', build: readyToMove, ui: flowFor(4128) },
  'flow-mined-info': { title: 'Borrow flow: some BEM mined before the loan, an optional harvest', hash: '#/app/rigs/4127', build: readyToMove, ui: flowFor(4127) },
  'flow-mined-covers': { title: 'Borrow flow: the mined BEM covers the whole debt', hash: '#/app/rigs/4127', build: () => withMined(readyToMove(), 4127, bem(2)), ui: flowFor(4127) },
  'flow-mined-tiny': { title: 'Borrow flow: too little mined BEM to harvest', hash: '#/app/rigs/4127', build: () => withMined(readyToMove(), 4127, 9_000n), ui: flowFor(4127) },
  'flow-harvest-prompting': {
    title: 'Borrow flow: the wallet is asked to confirm the harvest',
    hash: '#/app/rigs/4128',
    build: () =>
      harvesting(gateRecord(4128, 'prompting', { createdAt: T0 }), {
        pending: { action: 'harvest', since: T0, hash: null, chainId: 56, ask: { contract: 'RigVault 0x48D4…17C2', fn: 'harvest([#4128])', value: '0.00181 BNB', note: 'bond' } },
      }),
    ui: flowFor(4128),
  },
  'flow-harvest-inflight': {
    title: 'Borrow flow: the harvest was sent, waiting to be included',
    hash: '#/app/rigs/4128',
    build: () => harvesting(gateRecord(4128, 'in-flight', { createdAt: T0 })),
    ui: flowFor(4128),
  },
  'flow-harvest-gate': {
    title: 'Borrow flow: the harvest is in, the voucher waits for BSC time to pass on X Layer',
    hash: '#/app/rigs/4128',
    build: () => withMined(harvesting(gateRecord(4128, 'final', { createdAt: T0 - 20, harvestedAt: T0, block: 128_369_000n })), 4128, 0n),
    ui: flowFor(4128),
  },
  'flow-harvest-passed': {
    title: 'Borrow flow: the harvest settled, the voucher may move',
    hash: '#/app/rigs/4128',
    build: () => withMined(harvesting(gateRecord(4128, 'passed', { createdAt: T0 - 120, harvestedAt: T0 - 60, block: 128_369_000n })), 4128, 0n),
    ui: flowFor(4128),
  },
  'flow-agent-mined': { title: 'Borrow flow: the voucher is in the agent with BEM mined before the loan', hash: '#/app/rigs/4128', build: minedInAgent, ui: flowFor(4128) },
  'flow-mined-unreadable': { title: 'Borrow flow: the BEM mined on BSC could not be read', hash: '#/app/rigs/4128', build: () => withMined(readyToMove(), 4128, null), ui: flowFor(4128) },
  'flow-harvest-contracts-changed': {
    title: "Borrow flow: TapeOut's contracts changed, harvest from here is off",
    hash: '#/app/rigs/4128',
    build: () => {
      const s = readyToMove();
      return s.harvest.prep ? withHarvest(s, { prep: { ...s.harvest.prep, contracts: 'changed' } }) : s;
    },
    ui: flowFor(4128),
  },
  'group-flow': { title: 'Group page: two rigs', hash: '#/app/rigs/group', build: connected, ui: (u) => { u.group = true; u.sel = [4127, 4128]; } },

  /* modals */
  'supply-modal': { title: 'Supply modal', hash: '#/app/supply', build: connected },
  'withdraw-modal': { title: 'Withdraw modal', hash: '#/app/withdraw', build: connected, ui: (u) => { u.sup.tab = 'withdraw'; } },
  'screen-note': { title: 'Ask for a screen: the note', hash: '#/app/rigs/4301/screen', build: connected },
};

export const DEFAULT_FIXTURE = 'disconnected';

export interface Fixture {
  name: string;
  def: FixtureDef;
  store: FixtureStore;
  ui: UiState;
}

export function createFixture(name: string, opts: FixtureOptions = {}): Fixture {
  const def = FIXTURES[name] ?? (FIXTURES[DEFAULT_FIXTURE] as FixtureDef);
  const ui = freshUi();
  def.ui?.(ui);
  const store = new FixtureStore(def.build(), { rule: def.rule, ...opts });
  return { name: FIXTURES[name] ? name : DEFAULT_FIXTURE, def, store, ui };
}

