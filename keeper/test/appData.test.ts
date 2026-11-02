// The app's read-only data (SPEC-PHASE5-APP §8): share-price snapshots and the 7-day APY, the position
// index, the read limiter and the state sections. Mocked clients only: no network.
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keeper } from "../src/keeper.js";
import { PublicData, INDEX_MAX_PAGES, INDEX_PAGE_GAP_MS, SNAPSHOT_DAYS_PER_CYCLE, SNAPSHOT_FAILS_BEFORE_SKIP } from "../src/publicData.js";
import { ONE_SHARE, annualise, apy7d, cleanStats, dayLabel, pickThen, type Snapshot } from "../src/logic/apy.js";
import { applyEvents, blocksNeedingTime, cleanIndex, decodeLedgerLog, emptyIndex, positionBody, type LedgerEvent } from "../src/logic/ledger.js";
import { firstBlockAtOrAfter } from "../src/logic/blockSearch.js";
import { READ_LIMITS, ReadLimiter } from "../src/logic/readLimits.js";
import { emptyState, loadState, saveState, type KeeperState } from "../src/state.js";
import { loadConfig } from "../src/config.js";
import type { Alerts } from "../src/alerts.js";
import type { Clients } from "../src/chains.js";
import type { Deployment } from "../src/addresses.js";

const POOL = "0x0000000000000000000000000000000000000a01";
const D: Deployment = {
  pool: POOL,
  factory: "0x0000000000000000000000000000000000000a02",
  screen: "0x0000000000000000000000000000000000000a03",
  receiver: "0x0000000000000000000000000000000000000a04",
  reporter: "0x0000000000000000000000000000000000000a05",
  factoryDeployBlock: 900n,
  poolDeployBlock: 1_000n,
};
const B0 = 1_000n; // the pool's first block
const DAY0 = 20_000; // UTC day number of the deploy
const T0 = DAY0 * 86_400 + 5 * 3_600; // 05:00 UTC on the deploy day; blocks are 1 s apart
const DAY = 86_400;
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

// ───────────────────────── a mocked X Layer

interface FakeLog {
  blockNumber: bigint;
  logIndex: number;
  eventName: string;
  args?: Record<string, unknown>;
}

interface ChainOpts {
  head: bigint;
  ts?: (n: bigint) => number;
  price?: (n: bigint) => bigint;
  failPrice?: (n: bigint) => boolean;
  logs?: FakeLog[];
  failLogs?: () => boolean;
}

/** Timestamps never go down; the default is 1 s blocks from `T0`. */
const linear = (n: bigint) => T0 + Number(n - B0);
/** 1.00000000 BEM at the start, then 0.0001 BEM more per day. */
const growing = (n: bigint) => 100_000_000n + ((n - B0) * 10_000n) / BigInt(DAY);

function fakeChain(opts: ChainOpts) {
  const ts = opts.ts ?? linear;
  const price = opts.price ?? growing;
  const calls = { getBlock: [] as string[], price: [] as (bigint | undefined)[], logs: [] as [bigint, bigint][] };
  const pub = {
    getBlockNumber: async () => chain.head,
    getBlock: async (a: { blockNumber?: bigint; blockTag?: string }) => {
      const n = a.blockNumber ?? chain.head;
      if (n > chain.head) throw new Error("block not found");
      calls.getBlock.push(a.blockNumber === undefined ? "latest" : String(a.blockNumber));
      return { number: n, timestamp: BigInt(ts(n)) };
    },
    readContract: async (a: { functionName: string; blockNumber?: bigint; args: readonly unknown[] }) => {
      expect(a.functionName).toBe("convertToAssets");
      expect(a.args).toEqual([ONE_SHARE]);
      calls.price.push(a.blockNumber);
      if (a.blockNumber === undefined) throw new Error("price read not pinned to a block");
      if (a.blockNumber < B0) throw new Error("no code at that block");
      if (opts.failPrice?.(a.blockNumber)) throw new Error("rpc down");
      return price(a.blockNumber);
    },
    getLogs: async (a: { address: string; events: readonly unknown[]; fromBlock: bigint; toBlock: bigint }) => {
      expect(a.address.toLowerCase()).toBe(POOL);
      expect(a.events.length).toBe(3);
      calls.logs.push([a.fromBlock, a.toBlock]);
      if (a.toBlock - a.fromBlock + 1n > 100n) throw new Error("range too large");
      if (opts.failLogs?.()) throw new Error("rpc down");
      return (opts.logs ?? [])
        .filter((l) => l.blockNumber >= a.fromBlock && l.blockNumber <= a.toBlock)
        .sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
    },
  };
  const chain = { head: opts.head, calls, ts, price, logs: opts.logs ?? [] };
  const clients = { account: { address: A(0xaa) }, bsc: { public: {} }, xlayer: { public: pub } } as unknown as Clients;
  return { clients, chain };
}

const make = (clients: Clients, state: KeeperState = emptyState(D.factoryDeployBlock, D.factory), alerts: string[] = [], clockMs = () => 0, sleep: (ms: number) => Promise<void> = async () => {}) => ({
  state,
  alerts,
  pd: new PublicData(clients, D, state, (_k, t) => void alerts.push(t), clockMs, sleep),
});

/** The first block of a UTC day on the linear chain. */
const firstOf = (day: number): bigint => B0 + BigInt(Math.max(0, day * DAY - T0));
const statsOf = (pd: PublicData) => pd.stats().body as { asOf: number; block: number; sharePrice: string; apy7d: string | null; history: { day: string; block: number; sharePrice: string; time: number }[] };

// ───────────────────────── the APY

describe("apy", () => {
  const fmt6 = (q: bigint) => `${q / 1_000_000n}.${(q % 1_000_000n).toString().padStart(6, "0")}`;

  it("matches exact integer arithmetic when the exponent is a whole number", () => {
    // 630,720 s = 7.3 days, so 365 d / dt = 50 exactly: (1.0001)^50 - 1, rounded half up to 6 decimals
    const [now, then] = [100_010_000n, 100_000_000n];
    const num = now ** 50n;
    const den = then ** 50n;
    expect(annualise(now, then, 630_720)).toBe(fmt6(((num - den) * 1_000_000n + den / 2n) / den));
    expect(annualise(now, then, 630_720)).toBe("0.005012");
  });

  it("agrees with floating point on a grid of ratios and spacings, negative results included", () => {
    const ratios: [bigint, bigint][] = [[100_000_000n, 100_000_000n], [100_002_000n, 100_000_000n], [101_000_000n, 100_000_000n], [150_000_000n, 100_000_000n], [99_000_000n, 100_000_000n], [200_000_000n, 100_000_000n]];
    for (const [now, then] of ratios) {
      for (const dt of [518_400, 604_800, 650_000, 777_777, 1_000_000]) {
        const got = annualise(now, then, dt);
        const want = Math.pow(Number(now) / Number(then), 31_536_000 / dt) - 1;
        expect(got).not.toBeNull();
        expect(Math.abs(Number(got) - want)).toBeLessThanOrEqual(Math.max(2e-6, Math.abs(want) * 1e-9));
        expect(got).toMatch(/^-?\d+\.\d{6}$/);
      }
    }
    expect(annualise(99_000_000n, 100_000_000n, 604_800)).toMatch(/^-0\./);
  });

  it("returns null for inputs that mean nothing, and never prints a negative zero", () => {
    expect(annualise(1n, 0n, 604_800)).toBeNull();
    expect(annualise(0n, 1n, 604_800)).toBeNull();
    expect(annualise(2n, 1n, 0)).toBeNull();
    expect(annualise(2n, 1n, -5)).toBeNull();
    expect(annualise(2n, 1n, 1.5)).toBeNull();
    expect(annualise(10n ** 20n - 1n, 10n ** 20n, 604_800)).toBe("0.000000");
  });

  const snap = (ageDays: number, now: number, price = 100_000_000n): Snapshot => {
    const time = now - Math.round(ageDays * DAY);
    return { day: Math.floor(time / DAY), block: String(time), time, price: price.toString() };
  };
  const NOW = 30 * DAY + 4_000;

  it("picks the snapshot closest to seven days back among those at least six days old", () => {
    const all = [9.5, 8.0, 7.4, 6.5, 6.1, 5.9, 1].map((d) => snap(d, NOW));
    expect(pickThen(all, NOW)?.time).toBe(NOW - Math.round(7.4 * DAY));
    expect(pickThen(all.filter((s) => s.time !== NOW - Math.round(7.4 * DAY)), NOW)?.time).toBe(NOW - Math.round(6.5 * DAY));
    // 7.5 and 6.5 days are equally far from 7: the older one wins
    expect(pickThen([snap(6.5, NOW), snap(7.5, NOW)], NOW)?.time).toBe(NOW - Math.round(7.5 * DAY));
  });

  it("uses the real time between the blocks, and is null when nothing is old enough", () => {
    const snaps = [snap(9.5, NOW, 100_000_000n), snap(7.4, NOW, 100_040_000n), snap(1, NOW, 100_070_000n)];
    expect(apy7d(100_080_000n, NOW, snaps)).toBe(annualise(100_080_000n, 100_040_000n, Math.round(7.4 * DAY)));
    expect(apy7d(100_080_000n, NOW, [snap(5.9, NOW), snap(1, NOW)])).toBeNull();
    expect(apy7d(100_080_000n, NOW, [])).toBeNull();
    expect(apy7d(100_080_000n, NOW, [snap(7, NOW, 0n)])).toBeNull(); // a zero price is no baseline
  });
});

describe("block search", () => {
  it("finds the first block at or after a time in about log2 reads", async () => {
    let reads = 0;
    const ts = async (n: bigint) => (reads++, 1_000 + Number(n) * 2); // 2 s blocks
    expect(await firstBlockAtOrAfter(ts, 0n, 1_000_000n, 1_000 + 2 * 12_345)).toBe(12_345n);
    expect(await firstBlockAtOrAfter(ts, 0n, 1_000_000n, 1_000 + 2 * 12_345 - 1)).toBe(12_345n);
    expect(await firstBlockAtOrAfter(ts, 0n, 1_000_000n, 0)).toBe(0n);
    expect(reads).toBeLessThan(70);
  });
});

// ───────────────────────── snapshots

describe("share-price snapshots", () => {
  it("backfills each UTC day from the pool's first block, at the first block of the day, a few days per cycle", async () => {
    const f = fakeChain({ head: firstOf(DAY0 + 10) + 500n });
    const { pd } = make(f.clients);
    await pd.run();
    let s = statsOf(pd);
    expect(s.history.map((h) => h.day)).toEqual([0, 1, 2, 3].map((i) => dayLabel(DAY0 + i)));
    expect(s.history.length).toBe(SNAPSHOT_DAYS_PER_CYCLE);
    // the deploy day starts before the pool existed, so its snapshot is the pool's first block
    expect(s.history[0]).toMatchObject({ block: Number(B0), time: T0 });
    for (const i of [1, 2, 3]) {
      const h = s.history[i]!;
      expect(h.block).toBe(Number(firstOf(DAY0 + i)));
      expect(h.time).toBe((DAY0 + i) * DAY); // exactly midnight: the very first block of the day
      expect(h.sharePrice).toBe(growing(BigInt(h.block)).toString());
    }
    expect(f.chain.calls.price.every((b) => b !== undefined && b >= B0)).toBe(true); // every read pinned to a block
    for (let i = 0; i < 5; i++) await pd.run();
    s = statsOf(pd);
    expect(s.history.length).toBe(11); // days 0..10, today's included
    expect(s.history.at(-1)).toMatchObject({ day: dayLabel(DAY0 + 10), block: Number(firstOf(DAY0 + 10)) });
    expect(s.sharePrice).toBe(growing(f.chain.head).toString());
    expect(s.block).toBe(Number(f.chain.head));
    expect(s.asOf).toBe(linear(f.chain.head));
  });

  it("takes one snapshot per day across restarts, and rebuilds the same history from nothing", async () => {
    const f = fakeChain({ head: firstOf(DAY0 + 2) + 5_000n });
    const first = make(f.clients);
    await first.pd.run();
    expect(first.state.stats.snapshots.map((x) => x.day)).toEqual([DAY0, DAY0 + 1, DAY0 + 2]);
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    saveState(join(dir, "state.json"), first.state);

    // restart on the same day: nothing new is searched or read except the head price
    const reloaded = make(f.clients, loadState(join(dir, "state.json"), D.factoryDeployBlock, D.factory));
    const before = { price: f.chain.calls.price.length, blocks: f.chain.calls.getBlock.length };
    await reloaded.pd.run();
    expect(reloaded.state.stats.snapshots).toEqual(first.state.stats.snapshots);
    expect(f.chain.calls.price.length - before.price).toBe(1); // the head
    expect(f.chain.calls.getBlock.length - before.blocks).toBe(2); // the head, and the index's time stamp

    // many cycles on the same day add nothing; the next UTC day adds exactly one
    for (let i = 0; i < 3; i++) await reloaded.pd.run();
    expect(reloaded.state.stats.snapshots.length).toBe(3);
    f.chain.head = firstOf(DAY0 + 3) + 30n;
    await reloaded.pd.run();
    await reloaded.pd.run();
    expect(reloaded.state.stats.snapshots.map((x) => x.day)).toEqual([DAY0, DAY0 + 1, DAY0 + 2, DAY0 + 3]);

    // the state file is lost: the same snapshots come back from archive reads
    const lost = make(f.clients);
    await lost.pd.run();
    await lost.pd.run();
    expect(lost.state.stats.snapshots).toEqual(reloaded.state.stats.snapshots);
  });

  it("skips days that have no block of their own, as after a 12-day jump", async () => {
    const JUMP_AT = B0 + 1_000n;
    const jumpDay = DAY0 + 13;
    const ts = (n: bigint) => (n < JUMP_AT ? linear(n) : jumpDay * DAY + 3_600 + Number(n - JUMP_AT)); // 01:00 on the 13th day after the deploy
    const f = fakeChain({ head: JUMP_AT + 30_000n, ts });
    const { pd, state } = make(f.clients);
    await pd.run();
    expect(state.stats.snapshots.map((s) => [s.day, s.block])).toEqual([
      [DAY0, String(B0)],
      [jumpDay, String(JUMP_AT)],
    ]);
    expect(state.stats.nextDay).toBe(jumpDay + 1);
    const searched = f.chain.calls.getBlock.length;
    await pd.run();
    expect(state.stats.snapshots.length).toBe(2); // the skipped days are not tried again
    expect(f.chain.calls.getBlock.length - searched).toBeLessThan(5);
    expect(statsOf(pd).history.map((h) => h.day)).toEqual([dayLabel(DAY0), dayLabel(jumpDay)]);
  });

  it("keeps the last 60 days, and starts there when the state was lost long after the deploy", async () => {
    const f = fakeChain({ head: firstOf(DAY0 + 70) + 10n });
    const { pd, state } = make(f.clients);
    for (let i = 0; i < 16; i++) await pd.run();
    expect(state.stats.snapshots.length).toBe(60);
    expect(state.stats.snapshots[0]!.day).toBe(DAY0 + 11);
    expect(state.stats.snapshots.at(-1)!.day).toBe(DAY0 + 70);
    f.chain.head = firstOf(DAY0 + 71) + 10n;
    await pd.run();
    expect(state.stats.snapshots.length).toBe(60);
    expect(state.stats.snapshots[0]!.day).toBe(DAY0 + 12);
  });

  it("skips a day whose price never reads after a few cycles, and keeps going", async () => {
    const bad = firstOf(DAY0 + 2);
    const f = fakeChain({ head: firstOf(DAY0 + 5) + 10n, failPrice: (n) => n === bad });
    const { pd, state, alerts } = make(f.clients);
    for (let i = 1; i < SNAPSHOT_FAILS_BEFORE_SKIP; i++) {
      await pd.run();
      expect(state.stats.snapshots.map((s) => s.day)).toEqual([DAY0, DAY0 + 1]); // stuck on the bad day, retrying
    }
    await pd.run(); // the fifth failure: the day is given up and the run goes on to the days after it
    expect(state.stats.snapshots.map((s) => s.day)).toEqual([DAY0, DAY0 + 1, DAY0 + 3, DAY0 + 4, DAY0 + 5]);
    await pd.run();
    expect(state.stats.snapshots.length).toBe(5);
    expect(alerts).toEqual([]);
    expect(pd.stats().status).toBe(200);
  });

  it("answers 503 until it has read the price, and reports the APY only once a snapshot is six days old", async () => {
    const f = fakeChain({ head: firstOf(DAY0 + 4) + 100n });
    const { pd } = make(f.clients);
    expect(pd.stats()).toEqual({ status: 503, body: { error: "not ready" } });
    for (let i = 0; i < 3; i++) await pd.run();
    expect(statsOf(pd).apy7d).toBeNull(); // 4 days of history
    f.chain.head = firstOf(DAY0 + 8) + 100n;
    for (let i = 0; i < 4; i++) await pd.run();
    const s = statsOf(pd);
    // the snapshot closest to seven days back and at least six old is the one at the start of day 1 (7 days and 100 s)
    const then = s.history.find((h) => h.day === dayLabel(DAY0 + 1))!;
    expect(s.apy7d).toBe(annualise(BigInt(s.sharePrice), BigInt(then.sharePrice), s.asOf - then.time));
    expect(Number(s.apy7d)).toBeGreaterThan(0);
    expect(typeof s.sharePrice).toBe("string");
  });

  it("still publishes the current price while the backfill fails", async () => {
    const f = fakeChain({ head: firstOf(DAY0 + 3), failPrice: (n) => n !== f.chain.head });
    const { pd, alerts } = make(f.clients);
    for (let i = 0; i < 4; i++) await pd.run();
    expect(pd.stats().status).toBe(200);
    expect(statsOf(pd).sharePrice).toBe(growing(f.chain.head).toString());
    expect(statsOf(pd).history).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it("answers 503 and alerts after ten cycles in a row in which nothing could be read", async () => {
    const f = fakeChain({ head: firstOf(DAY0 + 3), failPrice: () => true });
    const { pd, alerts } = make(f.clients);
    for (let i = 0; i < 9; i++) await pd.run();
    expect(pd.stats().status).toBe(503);
    expect(alerts).toEqual([]);
    await pd.run();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("stats job has failed 10 cycles in a row");
  });
});

// ───────────────────────── the position index

const dep = (block: bigint, owner: string, assets: bigint, i = 0, sender = owner): FakeLog => ({
  blockNumber: block,
  logIndex: i,
  eventName: "Deposit",
  args: { sender, owner, assets, shares: assets * 1_000_000n },
});
const wd = (block: bigint, owner: string, assets: bigint, i = 0): FakeLog => ({
  blockNumber: block,
  logIndex: i,
  eventName: "Withdraw",
  args: { sender: owner, receiver: owner, owner, assets, shares: assets * 1_000_000n },
});
const tr = (block: bigint, from: string, to: string, i = 0): FakeLog => ({
  blockNumber: block,
  logIndex: i,
  eventName: "Transfer",
  args: { from, to, value: 5n },
});
const ZERO = A(0);
const pos = (pd: PublicData, who: string) => pd.position(who).body as { netDeposited: string; transferred: boolean; firstDepositAt: number | null; indexedTo: number; indexedToTime: number | null };

describe("position index", () => {
  it("reads 100 blocks per call from the pool's first block, 10 behind the head, and keeps its own cursor", async () => {
    const safeHead = B0 + 999n; // ten full pages
    const head = safeHead + 10n; // the spec: ten blocks behind the head
    const f = fakeChain({ head });
    const { pd, state } = make(f.clients);
    const agentCursor = state.cursor;
    await pd.run();
    const ranges = f.chain.calls.logs;
    expect(ranges.length).toBe(10);
    expect(ranges[0]).toEqual([B0, B0 + 99n]);
    ranges.forEach(([from, to], i) => {
      expect(to - from).toBe(99n);
      if (i > 0) expect(from).toBe(ranges[i - 1]![1] + 1n);
    });
    expect(ranges.at(-1)![1]).toBe(safeHead); // never past the head minus 10
    expect(state.index.cursor).toBe(String(safeHead + 1n));
    expect(state.cursor).toBe(agentCursor); // the agent scan's cursor is not the index's
    expect(pos(pd, A(1)).indexedTo).toBe(Number(safeHead));
    expect(pos(pd, A(1)).indexedToTime).toBe(linear(safeHead));
    // nothing new: no more log calls until the head moves
    await pd.run();
    expect(f.chain.calls.logs.length).toBe(10);
    f.chain.head = head + 5n;
    await pd.run();
    expect(f.chain.calls.logs.at(-1)).toEqual([safeHead + 1n, safeHead + 5n]);
    f.chain.head = head + 60n;
    await pd.run();
    expect(f.chain.calls.logs.at(-1)).toEqual([safeHead + 6n, safeHead + 60n]);
    expect(f.chain.calls.logs.every(([, to]) => to <= f.chain.head - 10n)).toBe(true);
  });

  it("resumes from its saved cursor after a restart and never starts before the pool's first block", async () => {
    const f = fakeChain({ head: B0 + 1_210n });
    const first = make(f.clients);
    await first.pd.run();
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    saveState(join(dir, "state.json"), first.state);
    const calls = f.chain.calls.logs.length;
    f.chain.head = B0 + 1_410n;
    const again = make(f.clients, loadState(join(dir, "state.json"), D.factoryDeployBlock, D.factory));
    expect(again.state.index.cursor).toBe(first.state.index.cursor);
    await again.pd.run();
    expect(f.chain.calls.logs[calls]).toEqual([B0 + 1_201n, B0 + 1_300n]);
    // a cursor saved below the first block is raised to it
    const low = emptyState(D.factoryDeployBlock, D.factory);
    low.index = { ...emptyIndex(), pool: POOL, cursor: "5" };
    expect(make(f.clients, low).state.index.cursor).toBe(String(B0));
  });

  it("reads at most INDEX_MAX_PAGES pages per cycle, paced, and never alerts about the lag while it catches up", async () => {
    const f = fakeChain({ head: B0 + 100n * 120n + 10n });
    const sleeps: number[] = [];
    const { pd, state, alerts } = make(f.clients, emptyState(D.factoryDeployBlock, D.factory), [], () => 0, async (ms) => void sleeps.push(ms));
    await pd.run();
    expect(INDEX_MAX_PAGES).toBe(40);
    expect(f.chain.calls.logs.length).toBe(INDEX_MAX_PAGES);
    expect(state.index.cursor).toBe(String(B0 + BigInt(INDEX_MAX_PAGES) * 100n));
    expect(sleeps).toEqual(Array(INDEX_MAX_PAGES - 1).fill(INDEX_PAGE_GAP_MS)); // a pause between pages, none before the first
    for (let i = 0; i < 3; i++) await pd.run();
    expect(state.index.cursor).toBe(String(B0 + 100n * 120n + 1n)); // caught up to head - 10
    expect(f.chain.calls.logs.length).toBe(121); // 120 full pages and the last single block
    expect(alerts).toEqual([]);
    expect(pos(pd, A(1)).indexedTo).toBe(Number(B0 + 100n * 120n));
  });

  it("starts no new page after the time budget", async () => {
    const f = fakeChain({ head: B0 + 5_000n });
    let t = 0;
    const { pd } = make(f.clients, emptyState(D.factoryDeployBlock, D.factory), [], () => (t += 8_000)); // 15 s budget: one page fits
    await (pd as unknown as { advanceIndex: () => Promise<void> }).advanceIndex();
    expect(f.chain.calls.logs.length).toBe(1);
  });

  it("nets deposits and withdrawals per owner, flags both ends of a transfer, and ignores mints and burns", async () => {
    const [a, b, c, e, s] = [A(0xa1), A(0xb2), A(0xc3), A(0xe5), A(0x5e)];
    const logs: FakeLog[] = [
      dep(B0 + 5n, a, 1_000n, 0),
      tr(B0 + 5n, ZERO, a, 1), // the mint of that deposit
      dep(B0 + 250n, a, 500n), // a later page: the first deposit time is kept
      dep(B0 + 260n, b, 2_000n, 0, s), // sent by someone else, credited to the owner
      tr(B0 + 260n, ZERO, b, 1),
      wd(B0 + 300n, a, 400n, 0),
      tr(B0 + 300n, a, ZERO, 1), // the burn
      tr(B0 + 310n, a, c), // a real transfer: both ends are flagged
      dep(B0 + 320n, e, 100n),
      wd(B0 + 330n, e, 300n), // took out more than it put in
    ];
    const f = fakeChain({ head: B0 + 600n, logs });
    const { pd } = make(f.clients);
    await pd.run();
    expect(pos(pd, a)).toMatchObject({ netDeposited: "1100", transferred: true, firstDepositAt: linear(B0 + 5n) });
    expect(pos(pd, b)).toMatchObject({ netDeposited: "2000", transferred: false, firstDepositAt: linear(B0 + 260n) });
    expect(pos(pd, c)).toMatchObject({ netDeposited: "0", transferred: true, firstDepositAt: null });
    expect(pos(pd, e)).toMatchObject({ netDeposited: "-200", transferred: false });
    expect(pos(pd, s)).toMatchObject({ netDeposited: "0", transferred: false, firstDepositAt: null }); // the sender is credited nothing
    expect(pos(pd, A(0x99))).toMatchObject({ netDeposited: "0", transferred: false, firstDepositAt: null }); // never seen
    expect(pos(pd, a.toUpperCase().replace("0X", "0x"))).toMatchObject({ netDeposited: "1100" }); // any case
    // only the block of an address's first deposit is read for its time
    expect(f.chain.calls.getBlock.filter((x) => x === String(B0 + 250n))).toEqual([]);
    expect(f.chain.calls.getBlock.filter((x) => x === String(B0 + 5n)).length).toBe(1);
  });

  it("flags a transfer on both ends even when the sender never deposited here", () => {
    const state = emptyIndex();
    const evs: LedgerEvent[] = [{ kind: "transfer", from: A(1), to: A(2) }];
    applyEvents(state, evs, () => 0);
    expect(state.accounts[A(1)]).toEqual({ net: "0", xfer: true, first: 0 });
    expect(state.accounts[A(2)]).toEqual({ net: "0", xfer: true, first: 0 });
    applyEvents(state, [{ kind: "transfer", from: ZERO, to: A(3) }, { kind: "transfer", from: A(3), to: ZERO }], () => 0);
    expect(state.accounts[A(3)]).toBeUndefined();
  });

  it("asks for a block time only for an address's first deposit", () => {
    const state = emptyIndex();
    state.accounts[A(2)] = { net: "5", xfer: false, first: 123 };
    const evs: LedgerEvent[] = [
      { kind: "deposit", owner: A(1), assets: 1n, block: 10n },
      { kind: "deposit", owner: A(1), assets: 1n, block: 11n },
      { kind: "deposit", owner: A(2), assets: 1n, block: 12n },
      { kind: "deposit", owner: A(3), assets: 1n, block: 10n },
    ];
    expect(blocksNeedingTime(state, evs)).toEqual([10n]);
  });

  it("applies nothing and keeps the cursor when a page cannot be read or decoded", async () => {
    const bad: FakeLog = { blockNumber: B0 + 150n, logIndex: 0, eventName: "Deposit", args: { owner: "not an address", assets: 1n } };
    const logs = [dep(B0 + 5n, A(1), 10n), dep(B0 + 120n, A(2), 20n), bad];
    const f = fakeChain({ head: B0 + 400n, logs });
    const { pd, state, alerts } = make(f.clients);
    // page 1 is fine, page 2 throws on the RPC
    let n = 0;
    const real = (f.clients.xlayer.public as unknown as { getLogs: (a: unknown) => Promise<unknown> }).getLogs;
    (f.clients.xlayer.public as unknown as { getLogs: (a: unknown) => Promise<unknown> }).getLogs = async (a) => {
      if (++n === 2) throw new Error("rpc down");
      return real(a);
    };
    await pd.run();
    expect(state.index.cursor).toBe(String(B0 + 100n));
    expect(pos(pd, A(1)).netDeposited).toBe("10");
    expect(pos(pd, A(2)).netDeposited).toBe("0"); // page 2 not applied
    // the RPC recovers; page 2 holds a log that cannot be decoded: still nothing applied, cursor stays
    (f.clients.xlayer.public as unknown as { getLogs: (a: unknown) => Promise<unknown> }).getLogs = real;
    await pd.run();
    expect(state.index.cursor).toBe(String(B0 + 100n));
    expect(pos(pd, A(2)).netDeposited).toBe("0");
    expect(alerts).toEqual([]); // two failed cycles are not worth an alert
  });

  it("does not alert while a catch-up keeps moving even though the node cuts every cycle short, but does when it is stuck", async () => {
    const f = fakeChain({ head: B0 + 3_000n });
    const real = (f.clients.xlayer.public as unknown as { getLogs: (a: unknown) => Promise<unknown> }).getLogs;
    let n = 0;
    let stuck = false;
    (f.clients.xlayer.public as unknown as { getLogs: (a: unknown) => Promise<unknown> }).getLogs = async (a) => {
      if (stuck || ++n % 2 === 0) throw new Error("over rate limit"); // every second page is refused
      return real(a);
    };
    const { pd, state, alerts } = make(f.clients);
    for (let i = 1; i <= 12; i++) {
      await pd.run();
      expect(state.index.cursor).toBe(String(B0 + BigInt(i) * 100n)); // one page of progress a cycle
    }
    expect(alerts).toEqual([]);
    stuck = true;
    for (let i = 0; i < 9; i++) await pd.run();
    expect(alerts).toEqual([]);
    await pd.run();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("index job has failed 10 cycles in a row");
  });

  it("decodes only what it understands", () => {
    expect(decodeLedgerLog({ eventName: "Withdraw", args: { owner: A(1).toUpperCase().replace("0X", "0x"), assets: 5n } })).toEqual({ kind: "withdraw", owner: A(1), assets: 5n });
    expect(() => decodeLedgerLog({ eventName: "Deposit", args: { owner: A(1), assets: 5n }, blockNumber: null })).toThrow();
    expect(() => decodeLedgerLog({ eventName: "Deposit", args: { owner: A(1), assets: -5n }, blockNumber: 5n })).toThrow();
    expect(() => decodeLedgerLog({ eventName: "Approval", args: {} })).toThrow();
    expect(() => decodeLedgerLog({ eventName: "Transfer" })).toThrow();
  });

  it("reports the time of the indexed block only when it is known for that block", () => {
    const s = emptyIndex();
    s.cursor = "101";
    s.time = 5_000;
    s.timeBlock = "100";
    expect(positionBody(s, A(1))).toMatchObject({ indexedTo: 100, indexedToTime: 5_000 });
    s.cursor = "201";
    expect(positionBody(s, A(1))).toMatchObject({ indexedTo: 200, indexedToTime: null });
  });
});

// ───────────────────────── the limiter

describe("read limiter", () => {
  it("allows 60 requests per address a minute, then a new minute starts clean", () => {
    let t = 1_000_000;
    const l = new ReadLimiter(() => t);
    for (let i = 0; i < READ_LIMITS.perIpPerMinute; i++) expect(l.admit("1.1.1.1").ok).toBe(true);
    const no = l.admit("1.1.1.1");
    expect(no).toMatchObject({ ok: false, reason: "ip" });
    expect(l.admit("2.2.2.2").ok).toBe(true); // another address is unaffected
    t += 60;
    expect(l.admit("1.1.1.1").ok).toBe(true);
  });

  it("caps the total at 600 a minute, and a turned-away address does not spend the shared budget", () => {
    let t = 2_000_060; // 20 s into a minute
    const l = new ReadLimiter(() => t);
    // one noisy address sends far more than its share: it is cut off at 60 and takes only 60 of the 600
    let served = 0;
    for (let i = 0; i < 5_000; i++) if (l.admit("9.9.9.9").ok) served++;
    expect(served).toBe(60);
    for (let ip = 1; ip <= 9; ip++) for (let i = 0; i < 60; i++) expect(l.admit(`10.0.0.${ip}`).ok).toBe(true); // 540 more: 600 in all
    const over = l.admit("10.0.0.99");
    expect(over).toMatchObject({ ok: false, reason: "global" });
    expect(over.ok === false && over.retryAfter).toBe(60 - (t % 60));
    expect(l.admit("9.9.9.9")).toMatchObject({ ok: false, reason: "ip" });
    t += 60;
    expect(l.admit("10.0.0.99").ok).toBe(true);
  });
});

// ───────────────────────── the state file

describe("state sections", () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), "keeper-")), "state.json");

  it("loads a state file saved before these sections existed, and keeps everything else", () => {
    const path = tmp();
    const old = JSON.parse(JSON.stringify(emptyState(100n, "0xFaC"))) as Record<string, unknown>;
    delete old.stats;
    delete old.index;
    (old.agents as Record<string, string>)["0xA"] = "0xB";
    old.cursor = "500";
    writeFileSync(path, JSON.stringify(old));
    const s = loadState(path, 100n, "0xFaC");
    expect(s.agents).toEqual({ "0xA": "0xB" });
    expect(s.cursor).toBe("500");
    expect(s.stats).toEqual({ pool: "", nextDay: 0, snapshots: [] });
    expect(s.index).toEqual(emptyIndex());
  });

  it("round-trips both sections, drops malformed ones, and starts them over for another factory", () => {
    const path = tmp();
    const f = fakeChain({ head: B0 + 400n, logs: [dep(B0 + 5n, A(1), 10n)] });
    const { pd, state } = make(f.clients);
    return pd.run().then(() => {
      saveState(path, state);
      const back = loadState(path, D.factoryDeployBlock, D.factory);
      expect(back.stats).toEqual(state.stats);
      expect(back.index).toEqual(state.index);
      expect(back.index.accounts[A(1)]!.net).toBe("10");
      const other = loadState(path, D.factoryDeployBlock, "0xOtherFactory");
      expect(other.stats).toEqual(emptyState(1n).stats);
      expect(other.index).toEqual(emptyIndex());

      const raw = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
      raw.stats = { pool: POOL, nextDay: "x", snapshots: [1] };
      raw.index = { pool: POOL, cursor: "12", accounts: { "not an address": {} } };
      writeFileSync(path, JSON.stringify(raw));
      const bad = loadState(path, D.factoryDeployBlock, D.factory);
      expect(bad.stats).toEqual(emptyState(1n).stats);
      expect(bad.index).toEqual(emptyIndex());
      expect(cleanStats({ pool: "0xAB", nextDay: 3, snapshots: [{ day: 2, block: "5", time: 9, price: "7" }, { day: 2, block: "6", time: 9, price: "8" }, { day: -1 }] }).snapshots).toEqual([{ day: 2, block: "6", time: 9, price: "8" }]);
      expect(cleanIndex({ pool: "0xAB", cursor: "7", time: 5, timeBlock: "6", accounts: { [A(0xab).toUpperCase().replace("0X", "0x")]: { net: "-4", xfer: true, first: 3 } } }).accounts[A(0xab)]).toEqual({ net: "-4", xfer: true, first: 3 });
    });
  });

  it("resets a section that belongs to another pool", async () => {
    const state = emptyState(D.factoryDeployBlock, D.factory);
    state.stats = { pool: "0xdead", nextDay: DAY0 + 5, snapshots: [{ day: DAY0 + 4, block: "9", time: 9, price: "9" }] };
    state.index = { ...emptyIndex(), pool: "0xdead", cursor: "999999", accounts: { [A(7)]: { net: "5", xfer: false, first: 1 } } };
    const { pd } = make(fakeChain({ head: B0 + 50n }).clients, state);
    expect(state.stats).toEqual({ pool: POOL, nextDay: 0, snapshots: [] });
    expect(state.index).toEqual({ ...emptyIndex(), pool: POOL, cursor: String(B0) });
    expect(pos(pd, A(7)).netDeposited).toBe("0");
  });
});

// ───────────────────────── wiring into the keeper's cycle

describe("keeper wiring", () => {
  const cfg = loadConfig({ KEEPER_MODE: "dry", KEEPER_PRIVATE_KEY: `0x${"11".repeat(32)}`, BSC_RPC: "http://x", TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "1" });
  const order: string[] = [];
  /** A chain whose every call is recorded and fails: the cycle must still finish. */
  const down = (name: string) =>
    new Proxy({}, { get: (_t, m) => async () => { order.push(`${name}.${String(m)}`); throw new Error("rpc down"); } });
  const clients = { account: { address: A(0xaa) }, bsc: { public: down("bsc") }, xlayer: { public: down("xlayer") } } as unknown as Clients;
  const alerts = { send: async () => {} } as unknown as Alerts;
  const senders = { poll: async () => {}, send: async () => ({ status: "dry" }), hasPending: () => false } as never;

  it("runs after every guardian job, last in the cycle, and a dead RPC stops nothing", async () => {
    const k = new Keeper(cfg, clients, D, alerts, { bsc: senders, xlayer: senders }, emptyState(1n, D.factory), () => 1_000_000);
    await k.cycle();
    const x = order.filter((o) => o.startsWith("xlayer."));
    // the guardian's X Layer reads (log scan, balances) all come before the app data's first read
    const firstApp = x.indexOf("xlayer.getBlock");
    expect(firstApp).toBeGreaterThan(x.lastIndexOf("xlayer.getBalance"));
    expect(firstApp).toBeGreaterThan(x.indexOf("xlayer.getBlockNumber"));
    expect(firstApp).toBeGreaterThan(x.lastIndexOf("xlayer.getStorageAt"));
    expect(k.lastCycleAt).toBe(1_000_000);
    expect(k.publicData!.stats().status).toBe(503);
  });

  it("marks the guardian cycle done before the app data starts, and has none before deployment", async () => {
    const k = new Keeper(cfg, clients, D, alerts, { bsc: senders, xlayer: senders }, emptyState(1n, D.factory), () => 1_000_000);
    let seenAt = -1;
    const seen = vi.fn(async () => void (seenAt = k.lastCycleAt));
    k.publicData!.run = seen;
    await k.cycle();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seenAt).toBe(1_000_000);
    expect(new Keeper(cfg, clients, null, alerts, { bsc: senders, xlayer: senders }, emptyState(0n)).publicData).toBeNull();
  });
});

// ───────────────────────── opt-in: the real X Layer, read-only

describe("live read (opt-in: KEEPER_PUBLIC_DATA_LIVE=1; about 45 s, about 120 eth_getLogs on the public node)", () => {
  it.skipIf(!process.env.KEEPER_PUBLIC_DATA_LIVE)(
    "snapshots and the index work against the public X Layer node (archive eth_call, getLogs with three events)",
    async () => {
      const { createPublicClient, http } = await import("viem");
      const { xlayerChain } = await import("../src/chains.js");
      const { DEPLOYMENT } = await import("../src/addresses.js");
      const client = createPublicClient({ chain: xlayerChain, transport: http("https://rpc.xlayer.tech", { retryCount: 2, timeout: 30_000 }) });
      const live = { account: { address: A(0xaa) }, bsc: { public: {} }, xlayer: { public: client } } as unknown as Clients;
      const state = emptyState(DEPLOYMENT!.factoryDeployBlock, DEPLOYMENT!.factory);
      const pd = new PublicData(live, DEPLOYMENT!, state, () => {});
      for (let i = 0; i < 3; i++) await pd.run();
      const s = statsOf(pd);
      console.log("live stats", s.history.length, "snapshots, share price", s.sharePrice, "apy7d", s.apy7d);
      console.log("live index to block", state.index.cursor, Object.keys(state.index.accounts).length, "accounts");
      expect(s.history.length).toBeGreaterThan(0);
      expect(BigInt(s.sharePrice)).toBeGreaterThanOrEqual(100_000_000n);
      expect(s.history[0]!.block).toBeGreaterThanOrEqual(73_824_872);
    },
    240_000,
  );
});
