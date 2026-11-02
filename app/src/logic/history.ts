import type { Address, Sec } from '../model';
import type { LoanRaw } from './loan';

/**
 * History without an indexer (SPEC-PHASE5-APP §5.5). `loanOf()` is all zeros once a loan ends and `closed` has no
 * timestamp, so the app finds what it needs by searching: a binary search over blocks, then one window of at most
 * 100 blocks of logs (the public X Layer node refuses more). Everything here talks to the chain through
 * `HistoryChain`, so the searches are tested against a fake one.
 *
 * Requests are spaced by the RPC layer (`chain/rpc.ts`), which treats a log query, a block looked up by number and
 * a call at an old block as heavy.
 */

export interface HistoryChain {
  head(): Promise<{ number: bigint; timestamp: Sec }>;
  /** Timestamp of block `n`. */
  blockTime(n: bigint): Promise<Sec>;
  /** `RigAgent.closed()` at `block` (an archive call). False when the agent did not exist yet or the answer is empty. */
  closedAt(agent: Address, block: bigint): Promise<boolean>;
  /** `RigAgent.loanOf()` at `block`; null when the call fails. */
  loanAt(agent: Address, block: bigint): Promise<LoanRaw | null>;
  /** The agent's own `Borrowed`, `OpsFeePaid` and `Seized` logs in `[from, to]` (`to - from` is at most 99). */
  logs(agent: Address, from: bigint, to: bigint): Promise<HistoryLog[]>;
}

export type HistoryLog =
  | { name: 'Borrowed'; block: bigint; fee: bigint; principal: bigint; maturity: bigint }
  | { name: 'OpsFeePaid'; block: bigint; amount: bigint }
  | { name: 'Seized'; block: bigint; moved: bigint[]; stuck: bigint[]; writtenOff: bigint };

/** What the `Borrowed` and `OpsFeePaid` events of a loan say. */
export interface OpenInfo {
  feePaid: bigint;
  /** Null when the loan paid no operating fee. */
  opsFeePaid: bigint | null;
}

/** What the `Seized` event says, plus the loan as it stood one block before. */
export interface SeizeInfo {
  block: bigint;
  seizedAt: Sec;
  moved: number[];
  stuck: number[];
  writtenOff: bigint;
  /** `loanOf()` one block before the seize; null if that call failed. */
  loan: LoanRaw | null;
  /** The `Borrowed` and `OpsFeePaid` events of that loan, when they could be found. */
  open: OpenInfo | null;
}

export const LOG_WINDOW = 100n;

/**
 * The first block in `[lo, hi]` whose timestamp reaches `time`, or null when even `hi` does not.
 * Timestamps rise with block numbers, so this is a search; it guesses where the block should be from the
 * timestamps already seen and falls back to halving every third step, so it finishes in a handful of reads when
 * blocks are evenly spaced and in no more than about 1.5 x log2 of the range when they are not.
 */
export async function firstBlockAtOrAfter(time: Sec, lo: bigint, hi: bigint, timeOf: (n: bigint) => Promise<Sec>): Promise<bigint | null> {
  let tb = await timeOf(hi);
  if (tb < time) return null;
  let ta = await timeOf(lo);
  if (ta >= time) return lo;
  // invariant: timeOf(a) < time <= timeOf(b)
  let a = lo;
  let b = hi;
  for (let step = 1; b - a > 1n; step++) {
    const half = a + (b - a) / 2n;
    let g = half;
    if (step % 3 !== 0 && tb > ta) {
      g = a + ((b - a) * BigInt(time - ta)) / BigInt(tb - ta);
      if (g <= a) g = a + 1n;
      if (g >= b) g = b - 1n;
    }
    const tg = await timeOf(g);
    if (tg >= time) {
      b = g;
      tb = tg;
    } else {
      a = g;
      ta = tg;
    }
  }
  return b;
}

/** The first block in `[lo, hi]` where `pred` holds, given that it holds at `hi` and never turns off. Null when it does not hold at `hi`. */
export async function firstTrueBlock(lo: bigint, hi: bigint, pred: (n: bigint) => Promise<boolean>): Promise<bigint | null> {
  if (!(await pred(hi))) return null;
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    if (await pred(mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/**
 * Open loan: the block where `loanOf().start` is reached, then one window of logs from it.
 * Null when the search or the read fails, or the `Borrowed` event is not in the window.
 */
export async function openLoanInfo(c: HistoryChain, agent: Address, start: Sec, fromBlock: bigint): Promise<OpenInfo | null> {
  const head = await c.head();
  const b = await firstBlockAtOrAfter(start, fromBlock, head.number, (n) => c.blockTime(n));
  if (b === null) return null;
  const to = b + LOG_WINDOW - 1n < head.number ? b + LOG_WINDOW - 1n : head.number;
  return openFromLogs(await c.logs(agent, b, to));
}

function openFromLogs(logs: HistoryLog[]): OpenInfo | null {
  const borrowed = logs.find((l): l is Extract<HistoryLog, { name: 'Borrowed' }> => l.name === 'Borrowed');
  if (!borrowed) return null;
  const ops = logs.find((l): l is Extract<HistoryLog, { name: 'OpsFeePaid' }> => l.name === 'OpsFeePaid' && l.block === borrowed.block);
  return { feePaid: borrowed.fee, opsFeePaid: ops ? ops.amount : 0n };
}

/**
 * Seized agent: `closed()` turns true exactly once, so search for the first block where it is true, read that
 * block's logs for `Seized`, and read the loan one block earlier. Null when the agent is not closed or a read fails.
 * `fromBlock` is where the pool's code starts (SPEC-PHASE5-APP §5.5).
 */
export async function seizeInfo(c: HistoryChain, agent: Address, fromBlock: bigint): Promise<SeizeInfo | null> {
  const head = await c.head();
  const b = await firstTrueBlock(fromBlock, head.number, (n) => c.closedAt(agent, n));
  if (b === null) return null;
  const logs = await c.logs(agent, b, b);
  const seized = logs.find((l): l is Extract<HistoryLog, { name: 'Seized' }> => l.name === 'Seized');
  if (!seized) return null;
  const seizedAt = await c.blockTime(b);
  const loan = await c.loanAt(agent, b - 1n);
  let open: OpenInfo | null = null;
  if (loan?.open) open = await openLoanInfo(c, agent, Number(loan.start), fromBlock).catch(() => null);
  return {
    block: b,
    seizedAt,
    moved: seized.moved.map(Number),
    stuck: seized.stuck.map(Number),
    writtenOff: seized.writtenOff,
    loan,
    open,
  };
}

/* ───────── caching ───────── */

/** The slice of `localStorage` the cache and the harvest records use. */
export interface KvStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function memoryStore(): KvStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
}

/** `localStorage`, with every access guarded: storage can be blocked, full or absent (a private window, a test). */
export function localStore(): KvStore {
  return {
    get(k) {
      try {
        return globalThis.localStorage?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        globalThis.localStorage?.setItem(k, v);
      } catch {
        /* blocked or full: the answer is recomputed next time */
      }
    },
    remove(k) {
      try {
        globalThis.localStorage?.removeItem(k);
      } catch {
        /* blocked */
      }
    },
  };
}

const replacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? `${v}n` : v);
const reviver = (_k: string, v: unknown): unknown => (typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
const encode = (v: unknown): string => JSON.stringify(v, replacer);
const decode = <T>(s: string | null): T | null => {
  if (s === null) return null;
  try {
    return JSON.parse(s, reviver) as T;
  } catch {
    return null;
  }
};

export interface HistoryOptions {
  chainId: number;
  /** First block to search from. */
  fromBlock: bigint;
  /** Milliseconds, monotonic. */
  clock?: () => number;
  /** How long a failed search is left alone before it is tried again. */
  retryAfterMs?: number;
}

/**
 * The searches, with a cache keyed by `(chainId, agent, start | 'closed')`, answers shared between callers asking
 * at the same time, and a pause after a failure so a node that cannot serve the search is not hammered every
 * refresh. Only answers are cached, never failures.
 */
export class History {
  private readonly mem = new Map<string, unknown>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly failedAt = new Map<string, number>();
  private readonly clock: () => number;
  private readonly retryAfter: number;

  constructor(
    private readonly chain: HistoryChain,
    private readonly store: KvStore,
    private readonly o: HistoryOptions,
  ) {
    this.clock = o.clock ?? (() => performance.now());
    this.retryAfter = o.retryAfterMs ?? 120_000;
  }

  private key(agent: Address, part: string | number): string {
    return `tp:hist:${this.o.chainId}:${agent.toLowerCase()}:${part}`;
  }

  /** The answer if the cache already has it. */
  peekOpen(agent: Address, start: Sec): OpenInfo | null {
    return this.peek<OpenInfo>(this.key(agent, start));
  }

  peekSeized(agent: Address): SeizeInfo | null {
    return this.peek<SeizeInfo>(this.key(agent, 'closed'));
  }

  private peek<T>(key: string): T | null {
    if (this.mem.has(key)) return this.mem.get(key) as T;
    const stored = decode<T>(this.store.get(key));
    if (stored !== null) this.mem.set(key, stored);
    return stored;
  }

  open(agent: Address, start: Sec): Promise<OpenInfo | null> {
    return this.run(this.key(agent, start), () => openLoanInfo(this.chain, agent, start, this.o.fromBlock));
  }

  seized(agent: Address): Promise<SeizeInfo | null> {
    return this.run(this.key(agent, 'closed'), () => seizeInfo(this.chain, agent, this.o.fromBlock));
  }

  private async run<T>(key: string, search: () => Promise<T | null>): Promise<T | null> {
    const hit = this.peek<T>(key);
    if (hit !== null) return hit;
    const running = this.inflight.get(key);
    if (running) return (await running) as T | null;
    const failed = this.failedAt.get(key);
    if (failed !== undefined && this.clock() - failed < this.retryAfter) return null;
    const p = (async () => {
      try {
        const found = await search();
        if (found === null) this.failedAt.set(key, this.clock());
        else {
          this.mem.set(key, found);
          this.store.set(key, encode(found));
          this.failedAt.delete(key);
        }
        return found;
      } catch {
        this.failedAt.set(key, this.clock());
        return null;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
