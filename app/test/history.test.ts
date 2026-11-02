import { describe, expect, it } from 'vitest';
import { firstBlockAtOrAfter, firstTrueBlock, History, localStore, memoryStore, openLoanInfo, seizeInfo, type HistoryChain, type HistoryLog } from '../src/logic/history';
import type { LoanRaw } from '../src/logic/loan';
import { A, openLoan } from './world';

/** A chain of blocks `spacing` seconds apart from block `n0` at time `t0`, with counters for every read. */
function fakeHistory(o: { n0?: bigint; t0?: number; head?: bigint; spacing?: (n: bigint) => number; closeBlock?: bigint; createdBlock?: bigint; logs?: (from: bigint, to: bigint) => HistoryLog[]; loan?: LoanRaw | null } = {}) {
  const n0 = o.n0 ?? 73_824_872n;
  const t0 = o.t0 ?? 1_792_000_000;
  const head = o.head ?? n0 + 200_000n;
  // time of block n: t0 plus the sum of the gaps before it (the default gap is one second)
  const gapAt = o.spacing ?? (() => 1);
  const cum = new Map<bigint, number>();
  const timeOf = (n: bigint): number => {
    const hit = cum.get(n);
    if (hit !== undefined) return hit;
    // closed form for the uniform default; a loop for a custom spacing, memoised sparsely
    if (!o.spacing) return t0 + Number(n - n0);
    let t = t0;
    for (let k = n0; k < n; k++) t += gapAt(k);
    cum.set(n, t);
    return t;
  };
  const stats = { blockTime: 0, closed: 0, loan: 0, logs: [] as [bigint, bigint][] };
  const chain: HistoryChain = {
    head: async () => ({ number: head, timestamp: timeOf(head) }),
    blockTime: async (n) => {
      stats.blockTime++;
      return timeOf(n);
    },
    closedAt: async (_a, b) => {
      stats.closed++;
      if (o.createdBlock !== undefined && b < o.createdBlock) return false;
      return o.closeBlock !== undefined && b >= o.closeBlock;
    },
    loanAt: async () => {
      stats.loan++;
      return o.loan === undefined ? null : o.loan;
    },
    logs: async (_a, from, to) => {
      stats.logs.push([from, to]);
      return o.logs ? o.logs(from, to) : [];
    },
  };
  return { chain, stats, timeOf, n0, t0, head };
}

describe('firstBlockAtOrAfter', () => {
  it('finds the block of a timestamp in a handful of reads when blocks are evenly spaced', async () => {
    const h = fakeHistory();
    const target = h.t0 + 123_456;
    const b = await firstBlockAtOrAfter(target, h.n0, h.head, async (n) => {
      h.stats.blockTime++;
      return h.timeOf(n);
    });
    expect(b).toBe(h.n0 + 123_456n);
    expect(h.stats.blockTime).toBeLessThanOrEqual(8);
  });

  it('is exact: the block before is earlier, and a time between two blocks lands on the later one', async () => {
    const h = fakeHistory({ spacing: (n) => (n % 3n === 0n ? 5 : 1) });
    for (const t of [h.t0 + 1, h.t0 + 77_777, h.t0 + 77_778, h.t0 + 150_000]) {
      const b = await firstBlockAtOrAfter(t, h.n0, h.head, async (n) => h.timeOf(n));
      expect(b).not.toBeNull();
      expect(h.timeOf(b as bigint)).toBeGreaterThanOrEqual(t);
      if ((b as bigint) > h.n0) expect(h.timeOf((b as bigint) - 1n)).toBeLessThan(t);
    }
  });

  it('stays logarithmic when blocks are badly uneven (a long halt in the middle)', async () => {
    const halt = 100_000n;
    const h = fakeHistory({ head: 73_824_872n + 200_000n, spacing: (n) => (n === 73_824_872n + halt ? 40_000 : 1) });
    let reads = 0;
    const target = h.t0 + 120_000 + 40_000;
    const b = await firstBlockAtOrAfter(target, h.n0, h.head, async (n) => {
      reads++;
      return h.timeOf(n);
    });
    expect(h.timeOf(b as bigint)).toBeGreaterThanOrEqual(target);
    expect(h.timeOf((b as bigint) - 1n)).toBeLessThan(target);
    expect(reads).toBeLessThanOrEqual(36);
  }, 20_000);

  it('returns the first block when it already reaches the time, and null when even the head does not', async () => {
    const h = fakeHistory();
    expect(await firstBlockAtOrAfter(h.t0 - 10, h.n0, h.head, async (n) => h.timeOf(n))).toBe(h.n0);
    expect(await firstBlockAtOrAfter(h.timeOf(h.head) + 1, h.n0, h.head, async (n) => h.timeOf(n))).toBeNull();
  });
});

describe('firstTrueBlock', () => {
  it('finds where a flag turned on in about log2 reads', async () => {
    let reads = 0;
    const at = 73_900_123n;
    const b = await firstTrueBlock(73_824_872n, 74_000_000n, async (n) => {
      reads++;
      return n >= at;
    });
    expect(b).toBe(at);
    expect(reads).toBeLessThanOrEqual(19);
  });

  it('is null when the flag is not on at the end', async () => {
    expect(await firstTrueBlock(1n, 100n, async () => false)).toBeNull();
  });
});

const borrowed = (block: bigint, fee = 450_000n): HistoryLog => ({ name: 'Borrowed', block, fee, principal: 60_000_000n, maturity: 1n });
const ops = (block: bigint, amount = 31_000_000_000_000_000n): HistoryLog => ({ name: 'OpsFeePaid', block, amount });

describe('openLoanInfo', () => {
  it('searches to the loan start, then reads one window of at most 100 blocks from there', async () => {
    const start = 1_792_000_000 + 50_000;
    const startBlock = 73_824_872n + 50_000n;
    const h = fakeHistory({ logs: (from, to) => (from <= startBlock && to >= startBlock ? [borrowed(startBlock), ops(startBlock)] : []) });
    const info = await openLoanInfo(h.chain, A(1), start, h.n0);
    expect(info).toEqual({ feePaid: 450_000n, opsFeePaid: 31_000_000_000_000_000n });
    expect(h.stats.logs).toHaveLength(1);
    const [from, to] = h.stats.logs[0] ?? [0n, 0n];
    expect(from).toBe(startBlock);
    expect(to - from).toBeLessThanOrEqual(99n);
    expect(h.stats.blockTime).toBeLessThan(30);
  });

  it('a loan that paid no operating fee has none', async () => {
    const startBlock = 73_824_872n + 10n;
    const h = fakeHistory({ logs: () => [borrowed(startBlock)] });
    expect(await openLoanInfo(h.chain, A(1), 1_792_000_010, h.n0)).toEqual({ feePaid: 450_000n, opsFeePaid: 0n });
  });

  it('is null when the Borrowed event is not in the window, and the window never runs past the head', async () => {
    const h = fakeHistory({ head: 73_824_872n + 20n, logs: () => [] });
    expect(await openLoanInfo(h.chain, A(1), 1_792_000_015, h.n0)).toBeNull();
    const [, to] = h.stats.logs[0] ?? [0n, 0n];
    expect(to).toBeLessThanOrEqual(73_824_872n + 20n);
  });
});

describe('seizeInfo', () => {
  const closeBlock = 73_824_872n + 120_000n;
  const seizedLogs = (from: bigint, to: bigint): HistoryLog[] =>
    from === closeBlock && to === closeBlock ? [{ name: 'Seized', block: closeBlock, moved: [4n, 9n], stuck: [12n], writtenOff: 123n }] : [];

  it('searches closed(), reads that block for Seized and the loan one block before it', async () => {
    const loan = { ...openLoan({ start: BigInt(1_792_000_000 + 1_000) }), open: true } as unknown as LoanRaw;
    const h = fakeHistory({ closeBlock, createdBlock: 73_824_872n + 100_000n, loan, logs: (from, to) => (from === closeBlock && to === closeBlock ? seizedLogs(from, to) : [borrowed(73_824_872n + 1_000n)]) });
    const info = await seizeInfo(h.chain, A(3), h.n0);
    expect(info).toMatchObject({ block: closeBlock, moved: [4, 9], stuck: [12], writtenOff: 123n, seizedAt: h.timeOf(closeBlock) });
    expect(info?.loan).toBe(loan);
    expect(info?.open).toEqual({ feePaid: 450_000n, opsFeePaid: 0n });
    expect(h.stats.closed).toBeLessThanOrEqual(19); // log2 of 200,000 blocks
  });

  it('a call before the agent existed (no data) counts as not closed, so the search still works', async () => {
    const h = fakeHistory({ closeBlock, createdBlock: closeBlock - 10n, logs: seizedLogs });
    expect((await seizeInfo(h.chain, A(3), h.n0))?.block).toBe(closeBlock);
  });

  it('is null for an agent that is not closed, or whose Seized event is missing', async () => {
    expect(await seizeInfo(fakeHistory({}).chain, A(3), 73_824_872n)).toBeNull();
    expect(await seizeInfo(fakeHistory({ closeBlock, logs: () => [] }).chain, A(3), 73_824_872n)).toBeNull();
  });

  it('keeps the seize when the loan before it cannot be read', async () => {
    const h = fakeHistory({ closeBlock, logs: seizedLogs, loan: null });
    const info = await seizeInfo(h.chain, A(3), h.n0);
    expect(info?.loan).toBeNull();
    expect(info?.open).toBeNull();
    expect(info?.moved).toEqual([4, 9]);
  });
});

describe('History: cache, sharing and backoff', () => {
  const startBlock = 73_824_872n + 50_000n;
  const mk = (clock: { ms: number }, store = memoryStore()) => {
    const h = fakeHistory({ logs: (from, to) => (from <= startBlock && to >= startBlock ? [borrowed(startBlock)] : []) });
    return { h, hist: new History(h.chain, store, { chainId: 196, fromBlock: h.n0, clock: () => clock.ms }), store };
  };
  const start = 1_792_000_000 + 50_000;

  it('answers from the cache the second time, also after a reload (localStorage)', async () => {
    const clock = { ms: 0 };
    const { h, hist, store } = mk(clock);
    expect(hist.peekOpen(A(1), start)).toBeNull();
    const a = await hist.open(A(1), start);
    expect(a).toEqual({ feePaid: 450_000n, opsFeePaid: 0n });
    const reads = h.stats.blockTime;
    expect(await hist.open(A(1), start)).toEqual(a);
    expect(h.stats.blockTime).toBe(reads);
    // a new History over the same store (a page reload) finds it without a read
    const again = new History(h.chain, store, { chainId: 196, fromBlock: h.n0 });
    expect(again.peekOpen(A(1), start)).toEqual(a);
    // the key is (chain, agent, start): another loan of the same agent is a different search
    expect(again.peekOpen(A(1), start + 1)).toBeNull();
  });

  it('shares one search between callers that ask at the same time', async () => {
    const clock = { ms: 0 };
    const { h, hist } = mk(clock);
    const [a, b, c] = await Promise.all([hist.open(A(1), start), hist.open(A(1), start), hist.open(A(1), start)]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(h.stats.logs).toHaveLength(1);
  });

  it('does not cache a failure, and leaves a failed search alone for two minutes', async () => {
    const clock = { ms: 0 };
    let fail = true;
    const h = fakeHistory({ logs: () => { if (fail) throw new Error('over rate limit'); return [borrowed(startBlock)]; } });
    const hist = new History(h.chain, memoryStore(), { chainId: 196, fromBlock: h.n0, clock: () => clock.ms });
    expect(await hist.open(A(1), start)).toBeNull();
    const tries = h.stats.logs.length;
    fail = false;
    clock.ms = 60_000;
    expect(await hist.open(A(1), start)).toBeNull(); // still backing off: nothing is read
    expect(h.stats.logs.length).toBe(tries);
    clock.ms = 121_000;
    expect(await hist.open(A(1), start)).toEqual({ feePaid: 450_000n, opsFeePaid: 0n });
  });

  it('caches a seized agent under (chain, agent, closed) with its big numbers intact', async () => {
    const closeBlock = 73_824_872n + 5_000n;
    const h = fakeHistory({ closeBlock, logs: (from, to) => (from === closeBlock && to === closeBlock ? [{ name: 'Seized', block: closeBlock, moved: [1n], stuck: [], writtenOff: 2n ** 70n }] : []) });
    const store = memoryStore();
    const hist = new History(h.chain, store, { chainId: 196, fromBlock: h.n0 });
    await hist.seized(A(7));
    const raw = store.get(`tp:hist:196:${A(7).toLowerCase()}:closed`);
    expect(raw).toContain('"writtenOff"');
    const again = new History(h.chain, store, { chainId: 196, fromBlock: h.n0 });
    expect(again.peekSeized(A(7))?.writtenOff).toBe(2n ** 70n);
  });

  it('ignores a cache entry it cannot parse', () => {
    const store = memoryStore();
    store.set(`tp:hist:196:${A(1).toLowerCase()}:5`, '{not json');
    const hist = new History(fakeHistory().chain, store, { chainId: 196, fromBlock: 1n });
    expect(hist.peekOpen(A(1), 5)).toBeNull();
  });
});

describe('stores', () => {
  it('localStore survives blocked or missing storage', () => {
    const s = localStore();
    expect(() => s.set('k', 'v')).not.toThrow();
    expect(() => s.get('k')).not.toThrow();
  });
});
