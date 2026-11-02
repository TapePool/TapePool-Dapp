import { getAddress, keccak256, toHex } from 'viem';
import { adapterAbi, agentFactoryAbi, circuitsAbi, creditPolicyAbi, erc20Abi, feedReceiverAbi, multicall3Abi, ownerOfAbi, podMiningAbi, reporterAbi, rigAgentAbi, rigScreenAbi, bscVaultAbi, tapeLensAbi, tapePoolAbi, voucherAbi } from '../src/chain/abi';
import { legacyBorrowAbi } from '../src/chain/legacyAbi';
import { cloneRuntime } from '../src/chain/checks';
import { DUMMY_LENS } from '../src/chain/reads';
import { MAINNET, readConfig, type AppConfig } from '../src/config';
import type { LoanRaw } from '../src/logic/loan';
import type { Address } from '../src/model';
import { EMPTY, FakeChain, type HandlerCtx } from './fakeChain';

/**
 * A small mainnet-shaped world behind two `FakeChain`s (X Layer and BSC). Handlers read `w.state` on every call, so
 * a test changes the world between refreshes by editing it.
 */

export const NOW = 1_800_000_000;
const DAY = 86_400;
export const A = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);

export const ACCOUNT = A(0xa11ce);
export const OTHER = A(0xb0b);
/** The agent factory's implementation: every agent in the world has the code of a clone of it. */
export const IMPL = A(0x1177);
export const AGENT1 = A(0xa6e47001);
export const AGENT2 = A(0xa6e47002);
export const AGENT3 = A(0xa6e47003);
export const CPU = { tapeout: A(0xc001), behemoth: A(0xc002), refbench: A(0xc003) };
export const CIRCUITS: Address = A(0xc1c1);
export const NETLIST: `0x${string}` = `0x${'ab'.repeat(308)}`;
export const NETLIST_HASH = keccak256(NETLIST);

export interface RigState {
  /** BSC read; null means the vault forgot the rig. */
  bsc: { circuits: Address; circuitId: bigint; status: number; stopBlock: bigint; taskId: number; since: number; verifWeight: bigint; bonus: bigint; pending: bigint; cell: Address; owner: Address; /** BEM in the rig's vault cell. */ cellBem: bigint } | null;
  voucher: { circuits: Address; circuitId: bigint; power: bigint };
  pass: { circuits: Address; circuitId: bigint; taskId: number; effectiveAt: number } | null;
  suspended: boolean;
  report: { observedAt: number; pending?: bigint; total?: bigint } | null;
}

export interface AgentState {
  closed: boolean;
  collateral: number[];
  owned: number[];
  loan: Partial<LoanRaw> & { open: boolean };
  bem: bigint;
  allowance: bigint;
  /** For a seized agent: the block it was created in and the block it closed in; calls before them see no code / an open agent. */
  createdBlock?: bigint;
  closeBlock?: bigint;
  /** `loanOf()` as it stood before the seize. */
  loanBefore?: Partial<LoanRaw> & { open: boolean };
}

export interface AccountState {
  bem: bigint;
  okb: bigint;
  room: bigint;
  allowancePool: bigint;
  tpbem: bigint;
  withdrawable: bigint;
  maxDeposit: bigint;
  vouchers: number[];
  agents: Address[];
}

export interface WorldState {
  statsOverride: Partial<Record<string, unknown>>;
  poolFail: boolean;
  tpbemValue: bigint;
  queued: Record<number, { value: bigint; eta: number }>;
  accounts: Map<string, AccountState>;
  agents: Map<string, AgentState>;
  rigs: Map<number, RigState>;
  totalVerifWeight: bigint;
  /** What `TapeLens.quote` returns, by agent and term; absent means the call fails. */
  quote: (agent: Address, term: number) => unknown | null;
  selfPush: bigint;
  /** The bridge fee of the BEM adapter on BSC, in bps. */
  feeBps: bigint;
  /** What `quoteHarvest(n)` costs for one rig, in wei of BNB; the world charges it for each rig. */
  harvestFee: bigint;
  /** BSC balances by account (lower case): BNB, BEM and the BEM allowance to the vault. */
  bscWallet: Map<string, { bnb: bigint; bem: bigint; allowance: bigint }>;
  /** What `voucher.payeeAt(id, time)` says; by default whoever holds the voucher in the world. */
  payeeAt: ((id: number, time: number) => Address) | null;
}

export interface World {
  x: FakeChain;
  b: FakeChain;
  state: WorldState;
  config: AppConfig;
  /** Make `address` an agent the chain answers for. */
  register: (agent: Address) => void;
}

export function bscRig(id: number, over: Partial<NonNullable<RigState['bsc']>> = {}): NonNullable<RigState['bsc']> {
  return {
    circuits: CPU.tapeout,
    circuitId: BigInt(1000 + id),
    status: 1,
    stopBlock: 0n,
    taskId: 4,
    since: NOW - 30 * DAY,
    verifWeight: 25n,
    bonus: 5n,
    pending: 1_000_000n,
    cell: A(0xce11),
    owner: A(0xce11),
    cellBem: 0n,
    ...over,
  };
}

/** A rig that is ready to borrow: aged, screened, voucher in sync. */
export function readyRig(id: number, over: Partial<RigState> = {}, bsc: Partial<NonNullable<RigState['bsc']>> = {}): RigState {
  const b = bscRig(id, bsc);
  return {
    bsc: b,
    voucher: { circuits: b.circuits, circuitId: b.circuitId, power: b.verifWeight },
    pass: { circuits: b.circuits, circuitId: b.circuitId, taskId: b.taskId, effectiveAt: NOW - 10 * DAY },
    suspended: false,
    report: { observedAt: NOW - 3_600, pending: b.pending, total: 1_600_000n },
    ...over,
  };
}

export const noLoan = (): AgentState['loan'] => ({ open: false });

export function openLoan(over: Partial<LoanRaw> = {}): AgentState['loan'] {
  return {
    open: true,
    start: BigInt(NOW - 2 * DAY),
    maturity: BigInt(NOW + 5 * DAY),
    term: 0,
    principal: 50_000_000n,
    principal0: 60_000_000n,
    feeLeft: 450_000n,
    lateBpsPerDay: 0,
    lateAccruedTo: BigInt(NOW + 5 * DAY),
    lateFeeDue: 0n,
    debt: 50_450_000n,
    impairedAt: 0n,
    impairedRig: 0n,
    doubtful: false,
    seizeStart: 0n,
    deadline: 0n,
    expired: false,
    ...over,
  };
}

const zeroLoan = (): LoanRaw => ({ open: false, start: 0n, maturity: 0n, term: 0, principal: 0n, principal0: 0n, feeLeft: 0n, lateBpsPerDay: 0, lateAccruedTo: 0n, lateFeeDue: 0n, debt: 0n, impairedAt: 0n, impairedRig: 0n, doubtful: false, seizeStart: 0n, deadline: 0n, expired: false });

export function buildWorld(env: { VITE_KEEPER_URL?: string; VITE_TAPELENS_ADDRESS?: string } = {}): World {
  const x = new FakeChain();
  const b = new FakeChain();
  x.timestamp = NOW;
  b.timestamp = NOW;
  const book = MAINNET;
  const state: WorldState = {
    statsOverride: {},
    poolFail: false,
    tpbemValue: 101_000_000n,
    queued: {},
    accounts: new Map(),
    agents: new Map(),
    rigs: new Map(),
    totalVerifWeight: 1_600_000n,
    quote: () => null,
    selfPush: 1_650_000_000_000_000n,
    feeBps: 50n,
    harvestFee: 1_500_000_000_000_000n,
    bscWallet: new Map(),
    payeeAt: null,
  };
  const w: World = { x, b, state, config: readConfig(env), register: () => undefined };

  const acc = (a: unknown): AccountState => {
    const s = state.accounts.get(String(a).toLowerCase());
    if (!s) throw new Error(`no account ${String(a)}`);
    return s;
  };
  const ag = (a: Address): AgentState => {
    const s = state.agents.get(a.toLowerCase());
    if (!s) throw new Error(`no agent ${a}`);
    return s;
  };
  /** Whoever holds a voucher in the world: the account that lists it, else the agent that owns it. */
  const holderOf = (id: number): Address => {
    for (const [a, s] of state.accounts) if (s.vouchers.includes(id)) return getAddress(a);
    for (const [a, s] of state.agents) if (s.owned.includes(id)) return getAddress(a);
    throw new Error(`nobody holds ${id}`);
  };
  const rig = (id: unknown): RigState => {
    const s = state.rigs.get(Number(id));
    if (!s) throw new Error(`no rig ${String(id)}`);
    return s;
  };

  // X Layer: the pool
  x.on(book.pool, tapePoolAbi, {
    stats: () => {
      if (state.poolFail) throw new Error('pool broke');
      return {
        idle: 99_500_000n,
        outstanding: 0n,
        doubtful: 0n,
        reserve: 0n,
        totalAssets: 99_500_000n,
        utilizationBps: 0n,
        supplyCap: 2_000_000_000n,
        borrowCapAbs: 1_000_000_000n,
        borrowCapBps: 7_000n,
        perBorrowerBps: 4_000n,
        borrowsPaused: false,
        feedDisabled: false,
        pendingPolicy: '0x0000000000000000000000000000000000000000',
        pendingPolicyEta: 0n,
        ...state.statsOverride,
      };
    },
    fee: ([term, principal]: readonly unknown[]) => { const f = ((principal as bigint) * (Number(term) === 0 ? 75n : 150n) + 9_999n) / 10_000n; return f < 300_000n ? 300_000n : f; },
    feeBps7d: 75n,
    feeBps14d: 150n,
    minFee: 300_000n,
    minAdvance: 1_000_000n,
    lateFeeBpsPerDay: 0n,
    opsFee: 31_000_000_000_000_000n,
    convertToAssets: ([shares]: readonly unknown[]) => ((shares as bigint) * state.tpbemValue) / 10n ** 14n,
    policy: book.policy,
    queued: ([key]: readonly unknown[]) => {
      const q = state.queued[Number(key)];
      return q ? [q.value, BigInt(q.eta)] : [0n, 0n];
    },
    maxLend: ([a]: readonly unknown[]) => acc(a).room,
    balanceOf: ([a]: readonly unknown[]) => acc(a).tpbem,
    maxWithdraw: ([a]: readonly unknown[]) => acc(a).withdrawable,
    maxDeposit: ([a]: readonly unknown[]) => acc(a).maxDeposit,
  });
  x.on(book.policy, creditPolicyAbi, {
    cpuTapeOut: CPU.tapeout,
    cpuBehemoth: CPU.behemoth,
    cpuRefBench: CPU.refbench,
    emissionValidUntil: BigInt(NOW + 400 * DAY),
    circuits: CIRCUITS,
    circuitId: 1n,
  });
  x.on(CIRCUITS, circuitsAbi, { name: 'Tape Pool Policy', symbol: 'TPPOL', circuitInfo: [12, 1, 0, 44], netlist: NETLIST });
  x.on(book.bem, erc20Abi, {
    balanceOf: ([a]: readonly unknown[]) => (state.agents.has(String(a).toLowerCase()) ? ag(a as Address).bem : acc(a).bem),
    allowance: ([owner, spender]: readonly unknown[]) => (String(spender).toLowerCase() === book.pool.toLowerCase() ? acc(owner).allowancePool : ag(spender as Address).allowance),
  });
  x.on(x.multicall, multicall3Abi, { getEthBalance: ([a]: readonly unknown[]) => acc(a).okb });
  // the wiring the entry checks read (SPEC-PHASE5-APP §10)
  x.on(book.pool, tapePoolAbi, { asset: book.bem, factory: book.factory });
  x.on(book.policy, creditPolicyAbi, { feed: book.receiver });
  x.on(book.factory, agentFactoryAbi, {
    agentsOf: ([a]: readonly unknown[]) => acc(a).agents,
    pool: book.pool,
    implementation: IMPL,
    borrowerOf: ([agent]: readonly unknown[]) => {
      const owner = [...state.accounts.entries()].find(([, s]) => s.agents.some((x2) => x2.toLowerCase() === String(agent).toLowerCase()));
      return owner ? getAddress(owner[0]) : '0x0000000000000000000000000000000000000000';
    },
  });
  x.on(book.voucher, voucherAbi, {
    balanceOf: ([a]: readonly unknown[]) => BigInt(state.agents.has(String(a).toLowerCase()) ? ag(a as Address).owned.length : acc(a).vouchers.length),
    tokenOfOwnerByIndex: ([a, i]: readonly unknown[]) => {
      const list = state.agents.has(String(a).toLowerCase()) ? ag(a as Address).owned : acc(a).vouchers;
      const id = list[Number(i)];
      if (id === undefined) throw new Error('index out of bounds');
      return BigInt(id);
    },
    rigs: ([id]: readonly unknown[]) => {
      const r = rig(id);
      return [r.voucher.circuits, 0n, r.voucher.circuitId, r.voucher.power];
    },
    ownerOf: ([id]: readonly unknown[]) => holderOf(Number(id)),
    payeeAt: ([id, time]: readonly unknown[]) => (state.payeeAt ? state.payeeAt(Number(id), Number(time)) : holderOf(Number(id))),
  });
  x.on(book.screen, rigScreenAbi, {
    passOf: ([id]: readonly unknown[]) => {
      const r = rig(id);
      const p = r.pass;
      return [{ circuits: p?.circuits ?? '0x0000000000000000000000000000000000000000', circuitId: p?.circuitId ?? 0n, taskId: p?.taskId ?? 0, effectiveAt: BigInt(p?.effectiveAt ?? 0), artifactHash: `0x${'11'.repeat(32)}` }, r.suspended];
    },
  });
  x.on(book.receiver, feedReceiverAbi, {
    latest: ([id]: readonly unknown[]) => {
      const r = rig(id);
      const rep = r.report;
      const b0 = r.bsc;
      if (!rep || !b0) return [emptyReport(Number(id)), false];
      return [
        {
          rigId: BigInt(Number(id)),
          circuitId: b0.circuitId,
          since: BigInt(b0.since),
          stopBlock: b0.stopBlock,
          circuits: b0.circuits,
          observedAt: BigInt(rep.observedAt),
          status: b0.status,
          custodied: b0.cell === b0.owner,
          verifWeight: b0.verifWeight,
          bonus: b0.bonus,
          totalVerifWeight: rep.total ?? 1_600_000n,
          bscBlock: 1n,
          pending: rep.pending ?? b0.pending,
          taskId: b0.taskId,
        },
        true,
      ];
    },
  });
  // the quote, at the dummy address (the app places TapeLens's code there) or at a deployed lens
  const quoteHandler = ([agent, term]: readonly unknown[]): unknown => {
    const q = state.quote(agent as Address, Number(term));
    if (q === null) throw new Error('quote failed');
    return q;
  };
  x.on(DUMMY_LENS, tapeLensAbi, { quote: quoteHandler });
  if (w.config.tapeLens) x.on(w.config.tapeLens, tapeLensAbi, { quote: quoteHandler });

  w.register = (addr: Address) => {
    x.codes.set(addr.toLowerCase(), cloneRuntime(IMPL));
    x.on(addr, [...rigAgentAbi, ...legacyBorrowAbi], {
      hasLoan: () => ag(addr).loan.open,
      closed: (_a: readonly unknown[], ctx: HandlerCtx) => {
        const s = ag(addr);
        if (ctx.block !== undefined && s.createdBlock !== undefined && ctx.block < s.createdBlock) return EMPTY;
        if (ctx.block !== undefined && s.closeBlock !== undefined) return ctx.block >= s.closeBlock;
        return s.closed;
      },
      collateralOf: () => ag(addr).collateral.map(BigInt),
      loanOf: (_a: readonly unknown[], ctx: HandlerCtx) => {
        const s = ag(addr);
        if (ctx.block !== undefined && s.closeBlock !== undefined && ctx.block < s.closeBlock && s.loanBefore) return { ...zeroLoan(), ...s.loanBefore };
        return { ...zeroLoan(), ...s.loan };
      },
    });
  };

  // BSC
  b.on(book.podMining, podMiningAbi, {
    totalVerifWeight: () => state.totalVerifWeight,
    minerKey: ([circuits, id]: readonly unknown[]) => keccak256(toHex(`${String(circuits).toLowerCase()}:${String(id)}`)),
    getMiner: ([key]: readonly unknown[]) => {
      const r = [...state.rigs.values()].find((v) => v.bsc && keccak256(toHex(`${v.bsc.circuits.toLowerCase()}:${v.bsc.circuitId}`)) === key);
      if (!r?.bsc) throw new Error('no miner');
      const m = r.bsc;
      return { circuits: m.circuits, circuitId: m.circuitId, taskId: m.taskId, gateCount: 100, stateCount: 0, depth: 3, area: 1n, mult: 1, since: BigInt(m.since), status: m.status, registrant: A(1), nandBurn: 0, latchBurn: 0, bstar: 0n, bonus: m.bonus, optimal: false, commitBlock: 0n, firstUnusedId: 0n, stopBlock: m.stopBlock, verifWeight: m.verifWeight, unverWeight: 0n, debt: 0n };
    },
    pending: ([key]: readonly unknown[]) => {
      const r = [...state.rigs.values()].find((v) => v.bsc && keccak256(toHex(`${v.bsc.circuits.toLowerCase()}:${v.bsc.circuitId}`)) === key);
      if (!r?.bsc) throw new Error('no miner');
      return r.bsc.pending;
    },
  });
  b.on(book.bscVault, bscVaultAbi, {
    rigs: ([id]: readonly unknown[]) => {
      const r = rig(id);
      return r.bsc ? [r.bsc.circuits, r.bsc.circuitId] : ['0x0000000000000000000000000000000000000000', 0n];
    },
    cellOf: ([key]: readonly unknown[]) => {
      const r = [...state.rigs.values()].find((v) => v.bsc && keccak256(toHex(`${v.bsc.circuits.toLowerCase()}:${v.bsc.circuitId}`)) === key);
      return r?.bsc?.cell ?? '0x0000000000000000000000000000000000000000';
    },
  });
  b.on(CPU.tapeout, ownerOfAbi, {
    ownerOf: ([circuitId]: readonly unknown[]) => {
      const r = [...state.rigs.values()].find((v) => v.bsc && v.bsc.circuitId === circuitId && v.bsc.circuits === CPU.tapeout);
      if (!r?.bsc) throw new Error('nonexistent token');
      return r.bsc.owner;
    },
  });
  b.on(book.reporter, reporterAbi, { quote: () => state.selfPush });
  // the BEM mined and not harvested also counts the BEM in the rig's vault cell, and a harvest pays the bridge fee
  b.on(book.bemAdapter, adapterAbi, { feeBps: () => state.feeBps });
  const cellOf = (a: unknown) => [...state.rigs.values()].find((v) => v.bsc && v.bsc.cell.toLowerCase() === String(a).toLowerCase());
  const bscAcc = (a: unknown) => state.bscWallet.get(String(a).toLowerCase()) ?? { bnb: 0n, bem: 0n, allowance: 0n };
  b.on(book.bemBsc, erc20Abi, {
    balanceOf: ([a]: readonly unknown[]) => {
      const r = cellOf(a);
      return r?.bsc ? r.bsc.cellBem : bscAcc(a).bem;
    },
    allowance: ([owner]: readonly unknown[]) => bscAcc(owner).allowance,
  });
  b.on(b.multicall, multicall3Abi, { getEthBalance: ([a]: readonly unknown[]) => bscAcc(a).bnb });
  b.on(book.bscVault, bscVaultAbi, { quoteHarvest: ([n]: readonly unknown[]) => BigInt(Number(n)) * state.harvestFee, harvest: 0n });
  return w;
}

function emptyReport(id: number): unknown {
  return { rigId: BigInt(id), circuitId: 0n, since: 0n, stopBlock: 0n, circuits: '0x0000000000000000000000000000000000000000', observedAt: 0n, status: 0, custodied: false, verifWeight: 0n, bonus: 0n, totalVerifWeight: 0n, bscBlock: 0n, pending: 0n, taskId: 0 };
}

export function addAccount(w: World, a: Address, over: Partial<AccountState> = {}): AccountState {
  const s: AccountState = { bem: 250_000_000n, okb: 80_000_000_000_000_000n, room: 39_800_000n, allowancePool: 0n, tpbem: 0n, withdrawable: 0n, maxDeposit: 1_900_500_000n, vouchers: [], agents: [], ...over };
  w.state.accounts.set(a.toLowerCase(), s);
  return s;
}

export function addAgent(w: World, address: Address, over: Partial<AgentState> = {}): AgentState {
  const s: AgentState = { closed: false, collateral: [], owned: [], loan: noLoan(), bem: 0n, allowance: 0n, ...over };
  w.state.agents.set(address.toLowerCase(), s);
  w.register(address);
  return s;
}

export function addRig(w: World, id: number, r: RigState): RigState {
  w.state.rigs.set(id, r);
  return r;
}
