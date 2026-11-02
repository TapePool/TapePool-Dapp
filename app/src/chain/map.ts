import { MAX_DEBT_BPS } from '../logic/creditMath';
import { factsFromReport } from '../logic/bscReader';
import type { Address, AgentView, BscFacts, ParamKey, PoolView, Processor, QueuedChange, RigFacts, RigPlace, Sec } from '../model';
import type { AddressBook } from '../config';
import { isLiveQueue, type AccountRaw, type AgentRaw, type CircuitRaw, type PolicyPins, type PoolRaw, type XLayerRig } from './reads';

/**
 * Pure mappers from what the reads decoded to the view model. No chain, no clock beyond the `now` they are given.
 */

const PARAM_KEYS: Record<number, ParamKey> = { 4: 'feeBps7d', 5: 'feeBps14d', 6: 'minFee', 7: 'minAdvance', 8: 'lateFee', 11: 'opsFee7d', 12: 'opsFee14d' };

/** TapePool.Param order and hard bounds, checked against bounds() in the fork suite. */
export const POOL_PARAMS = [
  ['supplyCap', 0n, 100_000_000_000n],
  ['borrowCapAbs', 0n, 50_000_000_000n],
  ['borrowCapBps', 0n, 9_000n],
  ['perBorrowerBps', 0n, 5_000n],
  ['feeBps7d', 25n, 300n],
  ['feeBps14d', 50n, 600n],
  ['minFee', 100_000n, 10_000_000n],
  ['minAdvance', 100_000n, 100_000_000n],
  ['lateFee', 0n, 30n],
  ['reserveShareBps', 0n, 5_000n],
  ['reserveCapBps', 0n, 2_000n],
  ['opsFee7d', 0n, 500_000_000_000_000_000n],
  ['opsFee14d', 0n, 500_000_000_000_000_000n],
  ['perBorrowerAbs', 0n, 50_000_000_000n],
] as const;

export function mapQueued(raw: PoolRaw['queued'], now: Sec): QueuedChange[] {
  const out: QueuedChange[] = [];
  for (const q of raw) {
    const key = PARAM_KEYS[q.key];
    if (key && isLiveQueue(q.eta, now)) out.push({ key, value: q.value, eta: Number(q.eta) });
  }
  return out;
}

const ZERO = '0x0000000000000000000000000000000000000000';

export function mapPool(raw: PoolRaw, pins: PolicyPins, circuit: CircuitRaw, book: AddressBook, now: Sec): PoolView {
  const s = raw.stats;
  return {
    totalAssets: s.totalAssets,
    unvested: raw.unvested ?? null,
    vestEnd: raw.vestEnd == null ? null : Number(raw.vestEnd),
    feedSettleUntil: raw.feedEnabledAt && raw.feedSettle != null ? Number(raw.feedEnabledAt + raw.feedSettle) : 0,
    outstanding: s.outstanding,
    idle: s.idle,
    doubtful: s.doubtful,
    params: {
      feeBps: [Number(raw.feeBps7d), Number(raw.feeBps14d)],
      maxDebtBps: MAX_DEBT_BPS,
      termDays: [7, 14],
      minFee: raw.minFee,
      minAdvance: raw.minAdvance,
      lateFeeBpsPerDay: Number(raw.lateFeeBpsPerDay),
      perBorrowerBps: Number(s.perBorrowerBps),
      borrowCapBps: Number(s.borrowCapBps),
      borrowCapAbs: s.borrowCapAbs,
      perBorrowerAbs: raw.perBorrowerAbs,
      supplyCap: s.supplyCap,
      opsFee: raw.opsFee,
    },
    tpbemValue: raw.tpbemValue,
    borrowsPaused: s.borrowsPaused,
    feedDisabled: s.feedDisabled,
    pendingPolicy: s.pendingPolicy.toLowerCase() === ZERO ? null : { address: s.pendingPolicy, eta: Number(s.pendingPolicyEta) },
    queued: mapQueued(raw.queued, now),
    circuit: {
      processorName: circuit.name,
      processorSymbol: circuit.symbol,
      circuits: pins.circuits,
      circuitId: Number(pins.circuitId),
      gates: circuit.gates,
      netlistHash: circuit.netlistHash,
    },
    contracts: { pool: book.pool, factory: book.factory, policy: raw.policy, screen: book.screen, bem: book.bem, voucher: book.voucher },
  };
}

/** The processors the policy accepts, by BSC address. */
export function processorOf(circuits: Address, pins: PolicyPins): Processor | null {
  const c = circuits.toLowerCase();
  if (c === pins.cpuTapeOut.toLowerCase()) return 'TapeOut';
  if (c === pins.cpuBehemoth.toLowerCase()) return 'Behemoth';
  if (c === pins.cpuRefBench.toLowerCase()) return 'RefBench';
  return null;
}

export function mapAgents(raw: readonly AgentRaw[]): AgentView[] {
  return raw.map((a) => {
    const collateral = a.collateral.map(Number).sort((x, y) => x - y);
    const loose = a.owned.map(Number).filter((id) => !collateral.includes(id)).sort((x, y) => x - y);
    return { address: a.address, closed: a.closed, collateral, loose, bem: a.bem, owners: a.owners };
  });
}

export function allowanceMap(raw: readonly AgentRaw[]): Record<string, bigint> {
  return Object.fromEntries(raw.map((a) => [a.address.toLowerCase(), a.allowance]));
}

/**
 * Where each rig is. A rig that is both in a wallet and in an agent (it cannot be) counts as in the agent;
 * a seized rig is the pool's. Order: wallet rigs, then each agent's, then the seized ones.
 */
export function placesOf(walletIds: readonly bigint[], agents: readonly AgentRaw[], seized: ReadonlyMap<string, readonly number[]>): Map<number, RigPlace> {
  const places = new Map<number, RigPlace>();
  for (const id of walletIds) places.set(Number(id), { kind: 'wallet' });
  for (const a of agents) {
    const collateral = new Set(a.collateral.map(Number));
    for (const id of a.owned.map(Number)) {
      places.set(id, { kind: 'agent', agent: a.address, closed: a.closed, collateral: collateral.has(id), loanOpen: a.loan.open });
    }
    // a collateral id the agent no longer owns is still in its set (it is dropped on the next release)
    for (const id of collateral) {
      if (!places.has(id)) places.set(id, { kind: 'agent', agent: a.address, closed: a.closed, collateral: true, loanOpen: a.loan.open });
    }
  }
  for (const [agent, ids] of seized) for (const id of ids) if (!places.has(id)) places.set(id, { kind: 'pool', agent: agent as Address });
  return places;
}

export interface FactSources {
  places: ReadonlyMap<number, RigPlace>;
  xl: ReadonlyMap<number, XLayerRig>;
  /** Facts read from BSC; a rig missing here falls back to the feed's last report. */
  bsc: ReadonlyMap<number, BscFacts>;
  pins: PolicyPins;
}

/** One `RigFacts` per rig: BSC first, the feed's last report (labelled "as of") when BSC could not be read for it. */
export function assembleFacts(src: FactSources): RigFacts[] {
  const out: RigFacts[] = [];
  for (const [id, place] of src.places) {
    const x = src.xl.get(id);
    if (!x) continue;
    const direct = src.bsc.get(id);
    const fallback = !direct && x.report ? factsFromReport(x.report, true) : null;
    const bsc = direct ?? fallback?.facts ?? null;
    out.push({
      id,
      place,
      bsc,
      bscAsOf: fallback ? fallback.asOf : null,
      voucher: { circuits: x.voucher.circuits, circuitId: x.voucher.circuitId, power: x.voucher.power },
      processor: bsc ? processorOf(bsc.circuits, src.pins) : null,
      screen: {
        pass: x.pass ? { circuits: x.pass.circuits, circuitId: x.pass.circuitId, taskId: BigInt(x.pass.taskId), effectiveAt: Number(x.pass.effectiveAt) } : null,
        suspended: x.suspended,
      },
    });
  }
  return out;
}

/** A conservative gas allowance for the borrow transaction, used until the node has estimated one: the credit rule's circuit, the loan, the transfer and the fee. */
export const BORROW_GAS_UNITS = 1_200_000n;
export const FALLBACK_GAS_PRICE = 1_000_000_000n; // 1 gwei, far above X Layer's ~0.02 gwei, used only when the price cannot be read

/**
 * What a borrow costs in OKB for gas: the node's estimate (the constant before there is one) with a fifth on top for
 * the gas, and twice the price, which can move before the transaction lands.
 */
export function borrowGasCost(gasPrice: bigint | null, estimate: bigint | null = null): bigint {
  const units = estimate === null ? BORROW_GAS_UNITS : (estimate * 12n) / 10n;
  return units * 2n * (gasPrice ?? FALLBACK_GAS_PRICE);
}

export function accountWallet(acc: AccountRaw, holdingsAgents: readonly AgentRaw[]): { bem: bigint; okb: bigint; room: bigint; allowancePool: bigint; allowanceAgent: Record<string, bigint> } {
  return { bem: acc.bem, okb: acc.okb, room: acc.room, allowancePool: acc.allowancePool, allowanceAgent: allowanceMap(holdingsAgents) };
}
