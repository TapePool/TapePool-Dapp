import { describe, expect, it } from 'vitest';
import { KEEP } from '../src/dev/trace/engine';
import { INDEX, OKX_REST, OKX_WS, OkxFeed, PING_MS, STALE_MS, samplesFromCandles, ticks } from '../src/dev/trace/feed';

class FakeSocket {
  readyState = 1; sent: string[] = []; closed = false;
  onopen: ((e: unknown) => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null; onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; }
}
function harness(pages: unknown[][] = []) {
  const sockets: FakeSocket[] = [], urls: string[] = [], timers = new Map<number, { at: number; fn: () => void }>();
  let clock = 0, id = 0;
  const feed = new OkxFeed({
    socket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    fetch: async (url) => { urls.push(url); const data = pages[urls.length - 1] ?? []; return { json: async () => ({ code: '0', data }) }; },
    clock: () => clock, wall: () => 200_000,
    timer: (fn, ms) => { timers.set(++id, { at: clock + ms, fn }); return id; },
    cancel: (n) => { timers.delete(n as number); },
  });
  const advance = (ms: number): void => {
    const until = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock = due[1].at; timers.delete(due[0]); due[1].fn();
    }
    clock = until;
  };
  const push = (s: FakeSocket, data: unknown): void => s.onmessage!({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  const index = (s: FakeSocket, idxPx: unknown): void => push(s, { arg: { channel: 'index-tickers', instId: INDEX }, data: [{ instId: INDEX, idxPx, ts: '1' }] });
  return { feed, sockets, urls, timers, advance, push, index, now: () => clock };
}

describe('OKX price feed', () => {
  it('parses decimal strings into 0.1 cent ticks without floating point', () => {
    expect(ticks('112.84')).toBe(112840); expect(ticks('112.8456')).toBe(112846); expect(ticks('112.8454')).toBe(112845);
    expect(ticks('7')).toBe(7000); expect(ticks('0.0001')).toBe(null);
    for (const bad of ['', '-1', '1e3', '1.', '.5', ' 1', 112.84, null, undefined, '1234567890']) expect(ticks(bad)).toBeNull();
  });

  it('holds 1 s index candle closes on the sample grid, oldest first, and skips time before the first candle', () => {
    const rows = Array.from({ length: 10 }, (_, i) => [String(i * 1000), '1', '1', '1', `100.0${i}`, '0']).reverse();
    const samples = samplesFromCandles([...rows, ['bad'], 'junk'], 10_000);
    expect(samples).toHaveLength(46); // t = 1000 … 10000 every 200 ms; the first candle closes at 1000
    expect(samples[0]).toBe(100_000); expect(samples.at(-1)).toBe(100_090);
    expect(samples.slice(0, 5)).toEqual([100_000, 100_000, 100_000, 100_000, 100_000]); expect(samples[5]).toBe(100_010);
    expect(samplesFromCandles(null, 10_000)).toEqual([]);
    expect(samplesFromCandles(Array.from({ length: 200 }, (_, i) => [String(i * 1000), '1', '1', '1', '100', '0']), 200_000)).toHaveLength(KEEP);
  });

  it('subscribes to the OKB-USD index with no login and reports connecting, live and stale prices', () => {
    const h = harness(); h.feed.start(); const s = h.sockets[0]!;
    expect(s.url).toBe(OKX_WS); expect(h.feed.state(h.now())).toBe('connecting');
    s.onopen!({});
    expect(JSON.parse(s.sent[0]!)).toEqual({ op: 'subscribe', args: [{ channel: 'index-tickers', instId: 'OKB-USD' }] });
    expect(s.sent.some(m => m.includes('login'))).toBe(false);
    h.advance(1000); h.index(s, '112.95');
    expect(h.feed.latest()).toEqual({ price: 112_950, at: 1000 }); expect(h.feed.state(h.now())).toBe('live');
    expect(h.feed.state(1000 + STALE_MS)).toBe('live'); expect(h.feed.state(1001 + STALE_MS)).toBe('stale');
  });

  it('ignores other channels, other instruments, events it does not act on and malformed data', () => {
    const h = harness(); h.feed.start(); const s = h.sockets[0]!; s.onopen!({});
    h.push(s, { arg: { channel: 'tickers', instId: 'OKB-USDT' }, data: [{ last: '1' }] });
    h.push(s, { arg: { channel: 'index-tickers', instId: 'BTC-USD' }, data: [{ idxPx: '1' }] });
    h.push(s, { event: 'subscribe', arg: { channel: 'index-tickers', instId: INDEX } });
    h.push(s, 'not json'); h.push(s, 'pong'); h.index(s, 112.9); h.index(s, '-1');
    expect(h.feed.latest()).toBeNull(); expect(h.sockets).toHaveLength(1);
  });

  it('pings after 20 s of silence, keeps the socket on any reply and reconnects when none comes', () => {
    const h = harness(); h.feed.start(); const s = h.sockets[0]!; s.onopen!({});
    h.advance(PING_MS - 1); expect(s.sent).not.toContain('ping');
    h.advance(1); expect(s.sent).toContain('ping');
    h.push(s, 'pong'); h.advance(PING_MS - 1); expect(h.sockets).toHaveLength(1);
    h.advance(1); expect(s.sent.filter(m => m === 'ping')).toHaveLength(2);
    h.advance(PING_MS); expect(s.closed).toBe(true); // no reply: dropped, then retried after a second
    h.advance(1000); expect(h.sockets).toHaveLength(2);
  });

  it('reconnects with growing delays, resets them once connected, and follows maintenance notices', () => {
    const h = harness(); h.feed.start();
    h.sockets[0]!.onclose!({}); h.advance(999); expect(h.sockets).toHaveLength(1); h.advance(1); expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.onerror!({}); h.advance(1999); expect(h.sockets).toHaveLength(2); h.advance(1); expect(h.sockets).toHaveLength(3);
    h.sockets[2]!.onopen!({});
    h.push(h.sockets[2]!, { event: 'notice', code: '64010', msg: 'port 8443 will be retired' }); h.push(h.sockets[2]!, { event: 'error', code: '60018' });
    h.advance(10_000); expect(h.sockets[2]!.closed).toBe(false); expect(h.sockets).toHaveLength(3);
    h.push(h.sockets[2]!, { event: 'notice', code: '64008', msg: 'service upgrade' }); expect(h.sockets[2]!.closed).toBe(true);
    h.advance(1000); expect(h.sockets).toHaveLength(4);
  });

  it('stops cleanly and forgets old prices when started again', () => {
    const h = harness(); h.feed.start(); const s = h.sockets[0]!; s.onopen!({}); h.index(s, '112.95');
    h.feed.stop(); expect(s.closed).toBe(true); expect(h.timers.size).toBe(0);
    s.onclose?.({}); h.advance(60_000); expect(h.sockets).toHaveLength(1);
    h.feed.start(); expect(h.feed.latest()).toBeNull(); expect(h.feed.state(h.now())).toBe('connecting'); expect(h.sockets).toHaveLength(2);
  });

  it('loads two pages of 1 s index candles ending now', async () => {
    const newest = Array.from({ length: 100 }, (_, i) => [String(200_000 - (i + 1) * 1000), '1', '1', '1', '112.90', '0']);
    const older = Array.from({ length: 100 }, (_, i) => [String(100_000 - (i + 1) * 1000), '1', '1', '1', '112.80', '0']);
    const h = harness([newest, older]);
    const samples = await h.feed.history();
    expect(h.urls[0]).toBe(`${OKX_REST}/api/v5/market/index-candles?instId=OKB-USD&bar=1s&limit=100`);
    expect(h.urls[1]).toBe(`${h.urls[0]}&after=100000`);
    expect(samples).toHaveLength(KEEP); expect(samples[0]).toBe(112_800); expect(samples.at(-1)).toBe(112_900);
  });
});
