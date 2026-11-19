import { KEEP, STEP, TICKS } from './engine';

/**
 * OKX public market data over HTTPS: no login, no API key. HTTPS only on purpose: a DeWEB gateway's policy allows no
 * WebSocket, so one feed serves the app wherever it is hosted.
 */
export const OKX_REST = 'https://www.okx.com';
/** The OKB-USD index: OKX's aggregate of several venues, so one thin order book cannot move it alone. */
export const INDEX = 'OKB-USD';
/** OKX refreshes the index about once a second (measured 2026-11-17), so one request a second per visitor sees every value. */
export const POLL_MS = 1000;
/** A request with no answer after this long is abandoned and counts as a failure. */
export const TIMEOUT_MS = 4000;
/** A price older than this stops the game: no samples, no deadlines, until a fresh one arrives. */
export const STALE_MS = 5_000;
const RETRY_MS = [1000, 2000, 5000, 10_000];

export type FeedState = 'connecting' | 'live' | 'stale';
export interface PriceFeed {
  /** The newest price in ticks and when it arrived, on the feed's clock (the animation frame clock in the app). */
  latest(): { price: number; at: number } | null;
  state(now: number): FeedState;
  /** Opening prices one STEP apart, oldest first, ending now: up to KEEP samples, held from 1 s index candles. */
  history(): Promise<number[]>;
  start(): void;
  stop(): void;
}

/** Parses an OKX decimal string into integer price ticks without floating point, rounding half up past 0.1 cent. */
export function ticks(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,9}(?:\.\d{1,12})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const places = String(TICKS).length - 1, next = fraction[places];
  const result = Number(whole) * TICKS + Number(fraction.slice(0, places).padEnd(places, '0')) + (next !== undefined && next >= '5' ? 1 : 0);
  return result > 0 ? result : null;
}

/**
 * Turns 1 s candles (`[ts, open, high, low, close, confirm]`, any order) into samples one STEP apart ending at `end`.
 * Each sample holds the close of the newest candle that had finished by then, as live samples hold the newest reading.
 */
export function samplesFromCandles(rows: unknown, end: number, count = KEEP): number[] {
  if (!Array.isArray(rows)) return [];
  const candles = rows.flatMap((row) => {
    const at = Array.isArray(row) ? Number(row[0]) : NaN, price = Array.isArray(row) ? ticks(row[4]) : null;
    return Number.isSafeInteger(at) && price !== null ? [{ done: at + 1000, price }] : [];
  }).sort((a, b) => a.done - b.done);
  const out: number[] = [];
  let next = 0, held: number | null = null;
  for (let i = count - 1; i >= 0; i--) {
    const t = end - i * STEP;
    while (next < candles.length && candles[next]!.done <= t) held = candles[next++]!.price;
    if (held !== null) out.push(held);
  }
  return out;
}

export interface OkxDeps {
  fetch?: (url: string) => Promise<{ json(): Promise<unknown> }>;
  /** Clock for arrival times; the view compares them with animation frame timestamps. */
  clock?: () => number;
  /** Wall clock in epoch ms, to line candle timestamps up with now. */
  wall?: () => number;
  timer?: (fn: () => void, ms: number) => unknown;
  cancel?: (id: unknown) => void;
}

/** Sends no cookie and no referrer, never reads a cache, and gives up after TIMEOUT_MS. */
const request = (url: string): Promise<{ json(): Promise<unknown> }> =>
  fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', ...(typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(TIMEOUT_MS) } : {}) });

/** Polls the OKB-USD index from OKX once a second, backing off while requests fail. Read-only. */
export class OkxFeed implements PriceFeed {
  private last: { price: number; at: number } | null = null;
  /** OKX's timestamp of the newest index reading taken. */
  private stamp = 0;
  private running = false;
  /** Each request belongs to a turn; an answer from an earlier turn (stopped, restarted or timed out) is ignored. */
  private turn = 0;
  private failures = 0;
  private next: unknown;
  private deadline: unknown;
  private readonly get: (url: string) => Promise<{ json(): Promise<unknown> }>;
  private readonly clock: () => number;
  private readonly wall: () => number;
  private readonly timer: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (id: unknown) => void;
  constructor(deps: OkxDeps = {}) {
    this.get = deps.fetch ?? request;
    this.clock = deps.clock ?? (() => performance.now());
    this.wall = deps.wall ?? (() => Date.now());
    this.timer = deps.timer ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = deps.cancel ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }
  latest(): { price: number; at: number } | null { return this.last; }
  state(now: number): FeedState { return !this.last ? 'connecting' : now - this.last.at > STALE_MS ? 'stale' : 'live'; }
  /** Forgets any earlier price, so a restarted feed never serves one from before the restart. */
  start(): void { if (this.running) return; this.running = true; this.failures = 0; this.last = null; this.stamp = 0; this.poll(); }
  stop(): void {
    this.running = false; this.turn++; this.cancel(this.next); this.cancel(this.deadline); this.next = this.deadline = undefined;
  }
  async history(): Promise<number[]> {
    const end = this.wall(), url = `${OKX_REST}/api/v5/market/index-candles?instId=${INDEX}&bar=1s&limit=100`;
    const page = async (after?: number): Promise<unknown[]> => {
      const body = await (await this.get(after === undefined ? url : `${url}&after=${after}`)).json() as { code?: unknown; data?: unknown };
      return body.code === '0' && Array.isArray(body.data) ? body.data : [];
    };
    const newest = await page();
    const oldest = Math.min(...newest.map((row) => Array.isArray(row) ? Number(row[0]) : Infinity));
    // One more page reaches the full 120 s; the API returns rows older than `after`.
    const older = Number.isFinite(oldest) ? await page(oldest) : [];
    return samplesFromCandles([...newest, ...older], end);
  }
  /** One request, then the next: POLL_MS after this one was sent when it answered, later and later while it does not. */
  private poll(): void {
    const turn = ++this.turn, sent = this.clock();
    const settle = (ok: boolean): void => {
      if (turn !== this.turn || !this.running) return;
      this.turn++; this.cancel(this.deadline); this.deadline = undefined;
      this.failures = ok ? 0 : this.failures + 1;
      const wait = ok ? Math.max(0, POLL_MS - (this.clock() - sent)) : RETRY_MS[Math.min(this.failures - 1, RETRY_MS.length - 1)]!;
      this.next = this.timer(() => { this.next = undefined; if (this.running) this.poll(); }, wait);
    };
    this.deadline = this.timer(() => settle(false), TIMEOUT_MS);
    let answer: Promise<unknown>;
    try { answer = this.get(`${OKX_REST}/api/v5/market/index-tickers?instId=${INDEX}`).then((r) => r.json()); } catch { settle(false); return; }
    answer.then((body) => settle(turn === this.turn && this.running && this.take(body)), () => settle(false));
  }
  /** Reads one answer. False when it is not a well-formed reading of the index. */
  private take(body: unknown): boolean {
    const b = body as { code?: unknown; data?: unknown } | null;
    const row = b?.code === '0' && Array.isArray(b.data) ? b.data[0] as { instId?: unknown; idxPx?: unknown; ts?: unknown } | undefined : undefined;
    const price = row?.instId === INDEX ? ticks(row.idxPx) : null;
    const stamp = typeof row?.ts === 'string' && /^\d{1,15}$/.test(row.ts) ? Number(row.ts) : 0;
    if (price === null || stamp <= 0) return false;
    // OKX stamps every refresh of the index, also when the price did not move. An answer with no newer stamp is the same
    // reading again (a cache on the way, or the index standing still), so it does not make the price fresh: the game waits.
    if (stamp > this.stamp) { this.stamp = stamp; this.last = { price, at: this.clock() }; }
    return true;
  }
}
