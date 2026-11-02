import { decodeFunctionResult, encodeFunctionData, keccak256 } from 'viem';
import type { AddressBook } from '../config';
import { QUEUE_GRACE } from '../constants';
import type { LoanRaw } from '../logic/loan';
import type { ReportRaw } from '../logic/bscReader';
import type { Address, Hex, PrincipalQuote, Quote, TermIndex } from '../model';
import { agentFactoryAbi, circuitsAbi, creditPolicyAbi, erc20Abi, feedReceiverAbi, multicall3Abi, rigAgentAbi, rigScreenAbi, tapeLensAbi, tapePoolAbi, voucherAbi } from './abi';
import { call, multicall, type Result } from './multicall';
import { legacyLensRuntime } from './legacyAbi';
import type { Reader } from './reader';

/**
 * The X Layer reads, one function per round (SPEC-PHASE5-APP §5). Every round is one Multicall3 `eth_call`
 * pinned to the block the refresh started from, so a list read in one round and the items read in the next are
 * from the same state. The decoded answers go back as plain data; `chain/map.ts` turns them into the view model.
 */

export interface ReadEnv {
  x: Reader;
  book: AddressBook;
  /** A deployed TapeLens; null places its runtime code at `DUMMY_LENS` for the quote call. */
  lens: Address | null;
}

/** Where TapeLens's runtime code is placed for a quote when no TapeLens is deployed (SPEC-PHASE5-APP O-1). */
export const DUMMY_LENS: Address = '0x00000000000000000000000000000000746c656e';

/** The most vouchers read for one owner: 16 is the most an agent holds, a wallet can hold more. */
export const MAX_OWNED = 64;

/** `Param` keys that queue: fees (4, 5), minimums (6, 7), late fee (8) and the operating fees (11, 12). */
export const QUEUE_KEYS = [4, 5, 6, 7, 8, 11, 12] as const;

export const ONE_TPBEM = 10n ** 14n; // tpBEM has 14 decimals

const need = <T>(r: Result<T>, what: string): T => {
  if (!r.ok) throw new Error(`read failed: ${what}`);
  return r.value;
};
const optional = <T>(r: Result<T>): T | null => (r.ok ? r.value : null);

/* ───────── round 1: the pool, the policy's pins, and the account's balances ───────── */

export interface StatsRaw {
  idle: bigint;
  outstanding: bigint;
  doubtful: bigint;
  reserve: bigint;
  totalAssets: bigint;
  utilizationBps: bigint;
  supplyCap: bigint;
  borrowCapAbs: bigint;
  borrowCapBps: bigint;
  perBorrowerBps: bigint;
  borrowsPaused: boolean;
  feedDisabled: boolean;
  pendingPolicy: Address;
  pendingPolicyEta: bigint;
}

export interface PoolRaw {
  stats: StatsRaw;
  unvested?: bigint | null;
  vestEnd?: bigint | null;
  perBorrowerAbs?: bigint;
  /** Redeploy 3 (R3-01): `feedEnabledAt()` and `FEED_SETTLE()`; null when they cannot be read (display only, RC3-02). */
  feedEnabledAt?: bigint | null;
  feedSettle?: bigint | null;
  feeBps7d: bigint;
  feeBps14d: bigint;
  minFee: bigint;
  minAdvance: bigint;
  lateFeeBpsPerDay: bigint;
  opsFee: readonly [bigint, bigint];
  tpbemValue: bigint;
  policy: Address;
  queued: { key: number; value: bigint; eta: bigint }[];
}

/** What CreditPolicy pins at deploy. Immutable, so read once per policy address. */
export interface PolicyPins {
  policy: Address;
  cpuTapeOut: Address;
  cpuBehemoth: Address;
  cpuRefBench: Address;
  emissionValidUntil: bigint;
  circuits: Address;
  circuitId: bigint;
}

export interface AccountRaw {
  account: Address;
  bem: bigint;
  okb: bigint;
  room: bigint;
  binding?: number;
  allowancePool: bigint;
  tpbem: bigint;
  withdrawable: bigint;
  maxDeposit: bigint;
  voucherCount: bigint;
  agents: readonly Address[];
}

/** `account` is null when none was asked for, and `accountFailed` when it was and a read of it failed (the pool part is still good). */
export async function readCore(env: ReadEnv, block: bigint, account: Address | null, pinsKnown: Address | null): Promise<{ pool: PoolRaw; pins: PolicyPins | null; account: AccountRaw | null; accountFailed: boolean }> {
  const { book } = env;
  const { pool, bem, voucher, factory, multicall3: mc } = book;
  const poolCalls = [
    call<StatsRaw>(pool, tapePoolAbi, 'stats'),
    call<bigint>(pool, tapePoolAbi, 'feeBps7d'),
    call<bigint>(pool, tapePoolAbi, 'feeBps14d'),
    call<bigint>(pool, tapePoolAbi, 'minFee'),
    call<bigint>(pool, tapePoolAbi, 'minAdvance'),
    call<bigint>(pool, tapePoolAbi, 'lateFeeBpsPerDay'),
    call<bigint>(pool, tapePoolAbi, 'opsFee', [0]),
    call<bigint>(pool, tapePoolAbi, 'opsFee', [1]),
    call<bigint>(pool, tapePoolAbi, 'convertToAssets', [ONE_TPBEM]),
    call<Address>(pool, tapePoolAbi, 'policy'),
    ...QUEUE_KEYS.map((k) => call<readonly [bigint, bigint]>(pool, tapePoolAbi, 'queued', [k])),
    ...(book.redeploy ? [call<bigint>(pool, tapePoolAbi, 'unvestedNow'), call<bigint>(pool, tapePoolAbi, 'vestEnd'), call<bigint>(pool, tapePoolAbi, 'perBorrowerAbs')] : []),
    // the settling window after a feed re-enable (RC3-02); the contract enforces it, so a failed read only hides the note
    ...(book.redeploy ? [call<bigint>(pool, tapePoolAbi, 'feedEnabledAt'), call<bigint>(pool, tapePoolAbi, 'FEED_SETTLE')] : []),
  ] as const;
  const pinCalls = [
    call<Address>(book.policy, creditPolicyAbi, 'cpuTapeOut'),
    call<Address>(book.policy, creditPolicyAbi, 'cpuBehemoth'),
    call<Address>(book.policy, creditPolicyAbi, 'cpuRefBench'),
    call<bigint>(book.policy, creditPolicyAbi, 'emissionValidUntil'),
    call<Address>(book.policy, creditPolicyAbi, 'circuits'),
    call<bigint>(book.policy, creditPolicyAbi, 'circuitId'),
  ] as const;
  const wantPins = pinsKnown?.toLowerCase() !== book.policy.toLowerCase();
  const a = account;
  const accountCalls = a
    ? ([
        call<bigint>(bem, erc20Abi, 'balanceOf', [a]),
        call<bigint>(mc, multicall3Abi, 'getEthBalance', [a]),
        book.redeploy ? call<readonly [bigint, number]>(pool, tapePoolAbi, 'lendLimit', [a]) : call<bigint>(pool, tapePoolAbi, 'maxLend', [a]),
        call<bigint>(bem, erc20Abi, 'allowance', [a, pool]),
        call<bigint>(pool, tapePoolAbi, 'balanceOf', [a]),
        call<bigint>(pool, tapePoolAbi, 'maxWithdraw', [a]),
        call<bigint>(pool, tapePoolAbi, 'maxDeposit', [a]),
        call<bigint>(voucher, voucherAbi, 'balanceOf', [a]),
        call<readonly Address[]>(factory, agentFactoryAbi, 'agentsOf', [a]),
      ] as const)
    : [];

  const all = [...poolCalls, ...(wantPins ? pinCalls : []), ...accountCalls];
  const r = (await multicall(env.x, mc, all, { block })) as unknown as Result<unknown>[];
  let i = 0;
  const next = <T>(): Result<T> => r[i++] as Result<T>;

  const stats = need(next<StatsRaw>(), 'pool.stats');
  const poolRaw: PoolRaw = {
    stats,
    feeBps7d: need(next<bigint>(), 'feeBps7d'),
    feeBps14d: need(next<bigint>(), 'feeBps14d'),
    minFee: need(next<bigint>(), 'minFee'),
    minAdvance: need(next<bigint>(), 'minAdvance'),
    lateFeeBpsPerDay: need(next<bigint>(), 'lateFeeBpsPerDay'),
    opsFee: [need(next<bigint>(), 'opsFee(0)'), need(next<bigint>(), 'opsFee(1)')],
    tpbemValue: need(next<bigint>(), 'convertToAssets'),
    policy: need(next<Address>(), 'policy'),
    queued: QUEUE_KEYS.map((key) => {
      const [value, eta] = need(next<readonly [bigint, bigint]>(), `queued(${key})`);
      return { key, value, eta };
    }),
  };
  if (book.redeploy) {
    poolRaw.unvested = need(next<bigint>(), 'unvestedNow');
    poolRaw.vestEnd = need(next<bigint>(), 'vestEnd');
    poolRaw.perBorrowerAbs = need(next<bigint>(), 'perBorrowerAbs');
    poolRaw.feedEnabledAt = optional(next<bigint>());
    poolRaw.feedSettle = optional(next<bigint>());
  }
  let pins: PolicyPins | null = null;
  if (wantPins) {
    pins = {
      policy: book.policy,
      cpuTapeOut: need(next<Address>(), 'cpuTapeOut'),
      cpuBehemoth: need(next<Address>(), 'cpuBehemoth'),
      cpuRefBench: need(next<Address>(), 'cpuRefBench'),
      emissionValidUntil: need(next<bigint>(), 'emissionValidUntil'),
      circuits: need(next<Address>(), 'circuits'),
      circuitId: need(next<bigint>(), 'circuitId'),
    };
  }
  let acc: AccountRaw | null = null;
  let accountFailed = false;
  if (a) {
    try {
      acc = {
        account: a,
        bem: need(next<bigint>(), 'bem.balanceOf'),
        okb: need(next<bigint>(), 'getEthBalance'),
        ...(() => {
          if (!book.redeploy) return { room: need(next<bigint>(), 'maxLend'), binding: 0 };
          const [room, binding] = need(next<readonly [bigint, number]>(), 'lendLimit');
          return { room, binding };
        })(),
        allowancePool: need(next<bigint>(), 'allowance'),
        tpbem: need(next<bigint>(), 'tpbem.balanceOf'),
        withdrawable: need(next<bigint>(), 'maxWithdraw'),
        maxDeposit: need(next<bigint>(), 'maxDeposit'),
        voucherCount: need(next<bigint>(), 'voucher.balanceOf'),
        agents: need(next<readonly Address[]>(), 'agentsOf'),
      };
    } catch {
      accountFailed = true;
    }
  }
  return { pool: poolRaw, pins, account: acc, accountFailed };
}

/** A queued change is live from its `eta` until the grace period ends: after that nobody can execute it. */
export const isLiveQueue = (eta: bigint, now: number): boolean => eta !== 0n && now <= Number(eta) + QUEUE_GRACE;

/* ───────── the policy circuit, once ───────── */

export interface CircuitRaw {
  name: string;
  symbol: string;
  gates: number;
  netlistHash: Hex;
}

export async function readCircuit(env: ReadEnv, block: bigint, pins: PolicyPins): Promise<CircuitRaw | null> {
  const [name, symbol, info, netlist] = await multicall(
    env.x,
    env.book.multicall3,
    [
      call<string>(pins.circuits, circuitsAbi, 'name'),
      call<string>(pins.circuits, circuitsAbi, 'symbol'),
      call<readonly [number, number, number, number]>(pins.circuits, circuitsAbi, 'circuitInfo', [pins.circuitId]),
      call<Hex>(pins.circuits, circuitsAbi, 'netlist', [pins.circuitId]),
    ],
    { block },
  );
  if (!name.ok || !symbol.ok || !info.ok || !netlist.ok) return null;
  return { name: name.value, symbol: symbol.value, gates: info.value[3], netlistHash: keccak256(netlist.value) };
}

/* ───────── round 2 and 3: tokens, agents and their vouchers ───────── */

export interface AgentRaw {
  address: Address;
  closed: boolean;
  collateral: readonly bigint[];
  loan: LoanRaw;
  bem: bigint;
  /** BEM allowance from the account to this agent. */
  allowance: bigint;
  /** Vouchers the agent owns. */
  owned: readonly bigint[];
  owners?: Record<string, Address | null>;
}

/** The wallet's voucher ids and the agents, read in two rounds because the second needs the counts of the first. */
export async function readHoldings(env: ReadEnv, block: bigint, acc: AccountRaw): Promise<{ walletIds: bigint[]; agents: AgentRaw[]; truncated: boolean; value: bigint }> {
  const { book } = env;
  const mc = book.multicall3;
  const nWallet = Math.min(Number(acc.voucherCount), MAX_OWNED);
  const r2 = await multicall(
    env.x,
    mc,
    [
      call<bigint>(book.pool, tapePoolAbi, 'convertToAssets', [acc.tpbem]),
      ...Array.from({ length: nWallet }, (_, i) => call<bigint>(book.voucher, voucherAbi, 'tokenOfOwnerByIndex', [acc.account, BigInt(i)])),
      ...acc.agents.flatMap((a) => [
        call<boolean>(a, rigAgentAbi, 'closed'),
        call<readonly bigint[]>(a, rigAgentAbi, 'collateralOf'),
        call<LoanRaw>(a, rigAgentAbi, 'loanOf'),
        call<bigint>(book.bem, erc20Abi, 'balanceOf', [a]),
        call<bigint>(book.voucher, voucherAbi, 'balanceOf', [a]),
        call<bigint>(book.bem, erc20Abi, 'allowance', [acc.account, a]),
      ]),
    ] as const,
    { block },
  );
  const rows = r2 as unknown as Result<unknown>[];
  const value = need(rows[0] as Result<bigint>, 'convertToAssets(balance)');
  const walletIds = rows.slice(1, 1 + nWallet).map((r, i) => need(r as Result<bigint>, `tokenOfOwnerByIndex(${i})`));
  const per = acc.agents.map((address, k) => {
    const at = 1 + nWallet + k * 6;
    return {
      address,
      closed: need(rows[at] as Result<boolean>, 'closed'),
      collateral: need(rows[at + 1] as Result<readonly bigint[]>, 'collateralOf'),
      loan: need(rows[at + 2] as Result<LoanRaw>, 'loanOf'),
      bem: need(rows[at + 3] as Result<bigint>, 'agent BEM'),
      count: need(rows[at + 4] as Result<bigint>, 'agent vouchers'),
      allowance: need(rows[at + 5] as Result<bigint>, 'allowance(agent)'),
    };
  });

  // every voucher an agent owns, collateral or not
  const wanted = per.flatMap((p) => Array.from({ length: Math.min(Number(p.count), MAX_OWNED) }, (_, i) => ({ agent: p.address, i })));
  const r3 = wanted.length === 0 ? [] : ((await multicall(env.x, mc, wanted.map((w) => call<bigint>(book.voucher, voucherAbi, 'tokenOfOwnerByIndex', [w.agent, BigInt(w.i)])), { block })) as unknown as Result<bigint>[]);
  const owned = new Map<string, bigint[]>();
  wanted.forEach((w, k) => {
    const list = owned.get(w.agent) ?? [];
    list.push(need(r3[k] as Result<bigint>, 'agent tokenOfOwnerByIndex'));
    owned.set(w.agent, list);
  });
  const agents: AgentRaw[] = per.map((p) => ({ address: p.address, closed: p.closed, collateral: p.collateral, loan: p.loan, bem: p.bem, allowance: p.allowance, owned: owned.get(p.address) ?? [] }));
  if (book.redeploy) {
    const entries = agents.flatMap((a) => a.collateral.map((id) => ({ a, id })));
    const owners = entries.length ? await multicall(env.x, mc, entries.map(({ id }) => call<Address>(book.voucher, voucherAbi, 'ownerOf', [id])), { block }) : [];
    entries.forEach(({ a, id }, k) => {
      a.owners ??= {};
      a.owners[String(id)] = optional(owners[k] as Result<Address>);
    });
  }
  const truncated = Number(acc.voucherCount) > MAX_OWNED || per.some((p) => Number(p.count) > MAX_OWNED);
  return { walletIds, agents, truncated, value };
}

/* ───────── round 4: what the chain says about each rig on X Layer ───────── */

export interface VoucherRecord {
  circuits: Address;
  circuitId: bigint;
  power: bigint;
}

export interface PassRecord {
  circuits: Address;
  circuitId: bigint;
  taskId: number;
  effectiveAt: bigint;
}

export interface XLayerRig {
  voucher: VoucherRecord;
  /** Null when no pass was ever recorded (`effectiveAt == 0`). */
  pass: PassRecord | null;
  /** Set even when no pass exists: the guardian can suspend a rig before it is screened. */
  suspended: boolean;
  /** The last report the feed holds, if it holds one. */
  report: ReportRaw | null;
}

/** `voucher.rigs`, `RigScreen.passOf` and `RigFeedReceiver.latest` for each id. A failed read fails the round: the rig list must not guess. */
export async function readRigRecords(env: ReadEnv, block: bigint, ids: readonly number[]): Promise<Map<number, XLayerRig>> {
  const { book } = env;
  const rows = (await multicall(
    env.x,
    book.multicall3,
    ids.flatMap((id) => [
      call<readonly [Address, bigint, bigint, bigint]>(book.voucher, voucherAbi, 'rigs', [BigInt(id)]),
      call<readonly [{ circuits: Address; circuitId: bigint; taskId: number; effectiveAt: bigint }, boolean]>(book.screen, rigScreenAbi, 'passOf', [BigInt(id)]),
      call<readonly [ReportRaw, boolean]>(book.receiver, feedReceiverAbi, 'latest', [BigInt(id)]),
    ]),
    { block },
  )) as unknown as Result<unknown>[];
  const out = new Map<number, XLayerRig>();
  ids.forEach((id, k) => {
    const [circuits, , circuitId, power] = need(rows[k * 3] as Result<readonly [Address, bigint, bigint, bigint]>, `voucher.rigs(${id})`);
    const [pass, suspended] = need(rows[k * 3 + 1] as Result<readonly [{ circuits: Address; circuitId: bigint; taskId: number; effectiveAt: bigint }, boolean]>, `passOf(${id})`);
    const [report, ok] = need(rows[k * 3 + 2] as Result<readonly [ReportRaw, boolean]>, `latest(${id})`);
    out.set(id, {
      voucher: { circuits, circuitId, power },
      pass: pass.effectiveAt === 0n ? null : pass,
      suspended,
      report: ok ? report : null,
    });
  });
  return out;
}

/* ───────── round 5: the lens ───────── */

/** `TapeLens.quote(agent, term)` for each agent and term, batched, with the lens's runtime code placed at a dummy address unless a TapeLens is deployed. */
export async function readQuotes(env: ReadEnv, block: bigint, agents: readonly Address[]): Promise<Map<string, readonly [Quote | null, Quote | null]>> {
  const out = new Map<string, readonly [Quote | null, Quote | null]>();
  if (agents.length === 0) return out;
  if (env.book.redeploy && !env.lens) throw new Error('The redeploy requires a deployed TapeLens');
  const lens = env.lens ?? DUMMY_LENS;
  const rows = (await multicall(
    env.x,
    env.book.multicall3,
    agents.flatMap((a) => [0, 1].map((term) => call<Quote>(lens, tapeLensAbi, 'quote', [a, term]))),
    { block, code: env.lens ? undefined : { [DUMMY_LENS]: legacyLensRuntime }, chunk: 6 },
  )) as unknown as Result<Quote>[];
  agents.forEach((a, k) => {
    out.set(a.toLowerCase(), [optional(rows[k * 2] as Result<Quote>), optional(rows[k * 2 + 1] as Result<Quote>)]);
  });
  return out;
}

/** The quote for the chosen amount, read directly from the deployed lens. */
export async function readQuoteFor(env: ReadEnv, block: bigint, agent: Address, term: TermIndex, principal: bigint): Promise<PrincipalQuote> {
  if (env.book.redeploy) {
    if (!env.lens) throw new Error('The redeploy requires a deployed TapeLens');
    const data = await env.x.call(env.lens, encodeFunctionData({ abi: tapeLensAbi, functionName: 'quoteFor', args: [agent, term, principal] }), { block });
    const [fee, lateBps, debt, allowed, reason, binding] = decodeFunctionResult({ abi: tapeLensAbi, functionName: 'quoteFor', data });
    return { fee, lateBps, debt, allowed, reason, binding };
  }
  const q = (await readQuotes(env, block, [agent])).get(agent.toLowerCase())?.[term];
  if (!q) throw new Error('No legacy quote');
  const [f, late] = await multicall(env.x, env.book.multicall3, [call<bigint>(env.book.pool, tapePoolAbi, 'fee', [term, principal]), call<bigint>(env.book.pool, tapePoolAbi, 'lateFeeBpsPerDay')], { block });
  if (!f.ok || !late.ok) throw new Error('No legacy fee');
  const reason = q.reason || (principal > q.maxPrincipal ? 14 : 0);
  return { fee: f.value, lateBps: Number(late.value), debt: principal + f.value, allowed: reason === 0, reason, binding: 0 };
}
