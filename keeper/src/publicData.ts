// Read-only data for the app (SPEC-PHASE5-APP §8): the pool's share price with a 7-day APY, and what each
// address has put into the pool. Both are built in the keeper's cycle, AFTER every guardian job, each with a
// cap and a time budget, and served from memory: an HTTP request never reads a chain.
//
// Losing the state file is safe (SPEC-PHASE3-KEEPER §2): the snapshots are rebuilt with archive `eth_call`s
// at the first block of each UTC day, and the index is rebuilt from the pool's deploy block.
import { type Address } from "viem";
import { ledgerEvents, shareAbi } from "./abi.js";
import type { Deployment } from "./addresses.js";
import type { Clients } from "./chains.js";
import { log } from "./log.js";
import { KEEP_SNAPSHOTS, ONE_SHARE, SECONDS_PER_DAY, apy7d, dayLabel, dayOf, emptyStats } from "./logic/apy.js";
import { firstBlockAtOrAfter } from "./logic/blockSearch.js";
import { applyEvents, blocksNeedingTime, decodeLedgerLog, emptyIndex, positionBody } from "./logic/ledger.js";
import type { KeeperState } from "./state.js";

/** X Layer `eth_getLogs` limit. */
const INDEX_PAGE = 100n;
/** The index stays this many blocks behind the head, clear of reorgs. */
export const INDEX_LAG = 10n;
/**
 * Pages (one `eth_getLogs` of 100 blocks each) read per cycle, one every INDEX_PAGE_GAP_MS. Live, the head
 * moves 60 blocks a cycle, so under one page. The public X Layer node answers "over rate limit" (-32016) after
 * about five back-to-back `eth_getLogs`, and took forty in a row without complaint at one every 250 ms (measured
 * 2026-10-23); forty paced pages are some 14 s of the cycle and clear 4,000 blocks a minute: the two days since
 * the deploy in about 45 minutes, a month in about 11 hours (positions read "—" in the app meanwhile).
 */
export const INDEX_MAX_PAGES = 40;
/** Pause between two pages, so a catch-up stays under the public node's rate limit. */
export const INDEX_PAGE_GAP_MS = 250;
/** UTC days snapshotted per cycle: each costs about 25 `getBlock` calls and one `eth_call`. */
export const SNAPSHOT_DAYS_PER_CYCLE = 4;
/** Cycles a day's price read may fail before that day is skipped, so one bad day cannot stall the backfill. */
export const SNAPSHOT_FAILS_BEFORE_SKIP = 5;
/** Wall-clock budgets of one cycle: no new page or day starts after them. */
const STATS_BUDGET_MS = 10_000;
const INDEX_BUDGET_MS = 15_000;
/** Cycles in a row a job may fail before the owner is told (SPEC-PHASE3-KEEPER §4.6: an RPC down for 10 minutes). */
const FAILS_BEFORE_ALERT = 10;

export interface Answer {
  status: number;
  body: unknown;
}

/** What the HTTP layer needs: synchronous answers built from memory. */
export interface PublicDataApi {
  stats(): Answer;
  /** `address` is already validated; any case. */
  position(address: string): Answer;
}

interface Reading {
  block: bigint;
  time: number;
  price: bigint;
}

type JobName = "stats" | "index";

export class PublicData implements PublicDataApi {
  private statsBody: unknown = null;
  private readonly fails: Record<JobName, number> = { stats: 0, index: 0 };
  private readonly dayFails = new Map<number, number>();
  private readonly start: bigint;
  private readonly pool: Address;

  constructor(
    private readonly c: Clients,
    d: Deployment,
    private readonly state: KeeperState,
    private readonly alert: (kind: string, text: string) => void,
    private readonly clockMs: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.pool = d.pool;
    this.start = d.poolDeployBlock ?? d.factoryDeployBlock;
    // the saved sections belong to one pool and never start before its deploy block
    const pool = d.pool.toLowerCase();
    if (state.stats.pool !== pool) state.stats = { ...emptyStats(), pool };
    if (state.index.pool !== pool) state.index = { ...emptyIndex(), pool, cursor: this.start.toString() };
    else if (BigInt(state.index.cursor) < this.start) state.index.cursor = this.start.toString();
  }

  /** One cycle's work, after the guardian jobs. Never throws: a failure is logged and the next cycle retries. */
  async run(): Promise<void> {
    await this.guard("stats", () => this.refreshStats(), () => String(this.state.stats.nextDay));
    await this.guard("index", () => this.advanceIndex(), () => this.state.index.cursor);
  }

  /**
   * Run a job; a throw is logged and counted. A cycle that failed after moving forward (`progress()` changed:
   * a catch-up cut short by the node's rate limit) is not a stuck job, so it resets the count instead.
   */
  private async guard(name: JobName, fn: () => Promise<void>, progress: () => string): Promise<void> {
    const before = progress();
    try {
      await fn();
      this.fails[name] = 0;
    } catch (e) {
      const n = progress() === before ? ++this.fails[name] : (this.fails[name] = 0);
      log("warn", `app data job ${name} failed`, { error: String(e).slice(0, 300), consecutive: n });
      if (n >= FAILS_BEFORE_ALERT) {
        this.alert(`appdata:${name}`, `the app routes' ${name} job has failed ${n} cycles in a row (the routes keep serving what they have): ${String(e).slice(0, 200)}`);
      }
    }
  }

  // ───────────────────────── GET /v1/stats

  stats(): Answer {
    return this.statsBody === null ? { status: 503, body: { error: "not ready" } } : { status: 200, body: this.statsBody };
  }

  private priceAt(block: bigint): Promise<bigint> {
    return this.c.xlayer.public.readContract({ address: this.pool, abi: shareAbi, functionName: "convertToAssets", args: [ONE_SHARE], blockNumber: block });
  }

  /** Read the share price at the head, take the day snapshots that are due, and rebuild the cached answer. */
  private async refreshStats(): Promise<void> {
    const block = await this.c.xlayer.public.getBlock({ blockTag: "latest" });
    const reading: Reading = { block: block.number, time: Number(block.timestamp), price: await this.priceAt(block.number) };
    try {
      await this.snapshotDays(reading);
    } finally {
      this.buildStatsBody(reading); // a failed backfill still publishes the current price
    }
  }

  /**
   * One snapshot per UTC day: the price at the day's first block (found by binary search on block
   * timestamps, read with an archive `eth_call` pinned to that block). Days from the pool's first day (or
   * the last 60) up to today are taken in order, a few per cycle. A day with no block of its own, as after
   * a long halt, is skipped for good: the first block at or after its start belongs to a later day.
   */
  private async snapshotDays(head: Reading): Promise<void> {
    const x = this.c.xlayer.public;
    const st = this.state.stats;
    if (this.start > head.block) return; // the pool is not on this chain yet
    const times = new Map<bigint, number>([[head.block, head.time]]);
    const timestampOf = async (n: bigint): Promise<number> => {
      const hit = times.get(n);
      if (hit !== undefined) return hit;
      const t = Number((await x.getBlock({ blockNumber: n })).timestamp);
      times.set(n, t);
      return t;
    };
    const headDay = dayOf(head.time);
    const oldest = headDay - (KEEP_SNAPSHOTS - 1);
    let day = st.nextDay;
    if (day === 0) day = Math.max(dayOf(await timestampOf(this.start)), oldest); // nothing taken yet
    day = Math.max(day, oldest);
    const last = st.snapshots[st.snapshots.length - 1];
    let lo = last !== undefined && BigInt(last.block) > this.start ? BigInt(last.block) : this.start;
    const deadline = this.clockMs() + STATS_BUDGET_MS;
    for (let taken = 0; day <= headDay && taken < SNAPSHOT_DAYS_PER_CYCLE && this.clockMs() < deadline; taken++) {
      const target = day * SECONDS_PER_DAY;
      if (head.time < target) break;
      const block = await firstBlockAtOrAfter(timestampOf, lo, head.block, target);
      const time = await timestampOf(block);
      const own = dayOf(time); // later than `day` when the days between had no block
      let price: bigint | null = null;
      try {
        price = block === head.block ? head.price : await this.priceAt(block);
      } catch (e) {
        const n = (this.dayFails.get(own) ?? 0) + 1;
        if (n < SNAPSHOT_FAILS_BEFORE_SKIP) {
          this.dayFails.set(own, n);
          throw e; // the same day is tried again next cycle
        }
        this.dayFails.delete(own);
        log("warn", "share price of a day is unreadable, skipping the day", { day: dayLabel(own), block, error: String(e).slice(0, 200) });
      }
      if (price !== null) {
        st.snapshots.push({ day: own, block: block.toString(), time, price: price.toString() });
        if (st.snapshots.length > KEEP_SNAPSHOTS) st.snapshots.splice(0, st.snapshots.length - KEEP_SNAPSHOTS);
      }
      st.nextDay = own + 1;
      day = own + 1;
      lo = block;
    }
  }

  private buildStatsBody(r: Reading): void {
    this.statsBody = {
      asOf: r.time,
      block: Number(r.block),
      sharePrice: r.price.toString(),
      apy7d: apy7d(r.price, r.time, this.state.stats.snapshots),
      history: this.state.stats.snapshots.map((s) => ({ day: dayLabel(s.day), block: Number(s.block), sharePrice: s.price, time: s.time })),
    };
  }

  // ───────────────────────── GET /v1/position/<address>

  position(address: string): Answer {
    return { status: 200, body: positionBody(this.state.index, address.toLowerCase()) };
  }

  /**
   * Scan the pool's events, 100 blocks per call, from the index's own cursor to 10 blocks behind the head, at
   * most INDEX_MAX_PAGES pages per cycle. Lagging behind is normal while it backfills and is never alerted.
   */
  private async advanceIndex(): Promise<void> {
    const x = this.c.xlayer.public;
    const head = await x.getBlockNumber();
    const safeHead = head - INDEX_LAG;
    let from = BigInt(this.state.index.cursor);
    const deadline = this.clockMs() + INDEX_BUDGET_MS;
    let pages = 0;
    while (from <= safeHead && pages < INDEX_MAX_PAGES && this.clockMs() < deadline) {
      if (pages > 0) await this.sleep(INDEX_PAGE_GAP_MS);
      const to = from + INDEX_PAGE - 1n > safeHead ? safeHead : from + INDEX_PAGE - 1n;
      await this.indexPage(from, to);
      from = to + 1n;
      pages++;
    }
    const indexedTo = BigInt(this.state.index.cursor) - 1n;
    if (indexedTo >= 0n && indexedTo <= head && this.state.index.timeBlock !== indexedTo.toString()) {
      this.state.index.time = Number((await x.getBlock({ blockNumber: indexedTo })).timestamp);
      this.state.index.timeBlock = indexedTo.toString();
    }
  }

  /** Read one page completely, then apply it and move the cursor together: a failed page changes nothing. */
  private async indexPage(from: bigint, to: bigint): Promise<void> {
    const x = this.c.xlayer.public;
    const index = this.state.index;
    const logs = await x.getLogs({ address: this.pool, events: ledgerEvents, fromBlock: from, toBlock: to });
    const events = logs.map((l) => decodeLedgerLog(l));
    // logs carry no timestamp: only the block of an address's first deposit is read
    const times = new Map<bigint, number>();
    await Promise.all(
      blocksNeedingTime(index, events).map(async (b) => {
        times.set(b, Number((await x.getBlock({ blockNumber: b })).timestamp));
      }),
    );
    applyEvents(index, events, (b) => times.get(b) ?? 0);
    index.cursor = (to + 1n).toString();
  }
}
