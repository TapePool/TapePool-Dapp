import { KEEP, STEP, TICKS } from './engine';

/** OKX public market data: no login, no API key. Port 443; OKX is retiring 8443. */
export const OKX_WS = 'wss://ws.okx.com/ws/v5/public';
export const OKX_REST = 'https://www.okx.com';
/** The OKB-USD index: OKX's aggregate of several venues, so one thin order book cannot move it alone. */
export const INDEX = 'OKB-USD';
/** OKX closes a socket after 30 s without traffic; ping after 20 s of silence and give up 20 s later. */
export const PING_MS = 20_000;
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
 * Each sample holds the close of the newest candle that had finished by then, as live samples hold the newest push.
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

interface Socket { readyState: number; send(data: string): void; close(): void; onopen: ((e: unknown) => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: ((e: unknown) => void) | null; onerror: ((e: unknown) => void) | null }
export interface OkxDeps {
  socket?: (url: string) => Socket;
  fetch?: (url: string) => Promise<{ json(): Promise<unknown> }>;
  /** Clock for arrival times; the view compares them with animation frame timestamps. */
  clock?: () => number;
  /** Wall clock in epoch ms, to line candle timestamps up with now. */
  wall?: () => number;
  timer?: (fn: () => void, ms: number) => unknown;
  cancel?: (id: unknown) => void;
}

/** Streams the OKB-USD index from OKX with keep-alive pings, maintenance notices and reconnects. Read-only. */
export class OkxFeed implements PriceFeed {
  private ws: Socket | undefined;
  private last: { price: number; at: number } | null = null;
  private running = false;
  private attempt = 0;
  private quiet: unknown;
  private retry: unknown;
  private readonly socket: (url: string) => Socket;
  private readonly get: (url: string) => Promise<{ json(): Promise<unknown> }>;
  private readonly clock: () => number;
  private readonly wall: () => number;
  private readonly timer: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (id: unknown) => void;
  constructor(deps: OkxDeps = {}) {
    this.socket = deps.socket ?? ((url) => new WebSocket(url) as unknown as Socket);
    this.get = deps.fetch ?? ((url) => fetch(url));
    this.clock = deps.clock ?? (() => performance.now());
    this.wall = deps.wall ?? (() => Date.now());
    this.timer = deps.timer ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = deps.cancel ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }
  latest(): { price: number; at: number } | null { return this.last; }
  state(now: number): FeedState { return !this.last ? 'connecting' : now - this.last.at > STALE_MS ? 'stale' : 'live'; }
  /** Forgets any earlier price, so a restarted feed never serves one from before the restart. */
  start(): void { if (this.running) return; this.running = true; this.attempt = 0; this.last = null; this.connect(); }
  stop(): void {
    this.running = false; this.cancel(this.quiet); this.cancel(this.retry); this.quiet = this.retry = undefined;
    this.drop();
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
  private connect(): void {
    const ws = this.socket(OKX_WS); this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'index-tickers', instId: INDEX }] }));
      this.listen();
    };
    ws.onmessage = (e) => {
      this.listen();
      if (e.data === 'pong' || typeof e.data !== 'string') return;
      let message: { event?: unknown; code?: unknown; arg?: { channel?: unknown; instId?: unknown }; data?: unknown };
      try { message = JSON.parse(e.data); } catch { return; }
      // Code 64008 announces a service upgrade and asks clients to reconnect. Other notices (64010: port 8443 retiring)
      // and errors are not cured by reconnecting, which would only loop; without prices the game simply waits.
      if (message.event === 'notice' && message.code === '64008') { this.reconnect(); return; }
      if (message.arg?.channel !== 'index-tickers' || message.arg.instId !== INDEX || !Array.isArray(message.data)) return;
      const row = message.data[0] as { idxPx?: unknown } | undefined, price = ticks(row?.idxPx);
      if (price !== null) this.last = { price, at: this.clock() };
    };
    ws.onclose = () => { if (this.ws === ws) this.reconnect(); };
    ws.onerror = () => { if (this.ws === ws) this.reconnect(); };
  }
  /** After each message: ping once the line has been quiet for PING_MS, reconnect if it stays quiet as long again. */
  private listen(): void {
    this.cancel(this.quiet);
    this.quiet = this.timer(() => {
      try { this.ws?.send('ping'); } catch { /* the close handler reconnects */ }
      this.quiet = this.timer(() => this.reconnect(), PING_MS);
    }, PING_MS);
  }
  private reconnect(): void {
    this.drop(); this.cancel(this.quiet); this.cancel(this.retry);
    if (!this.running) return;
    const wait = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)]!;
    this.retry = this.timer(() => { this.retry = undefined; if (this.running) this.connect(); }, wait);
  }
  private drop(): void {
    const ws = this.ws; this.ws = undefined;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch { /* already closed */ }
  }
}
