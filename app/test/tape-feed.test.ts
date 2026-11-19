import { describe, expect, it } from 'vitest';
import { KEEP } from '../src/tape/engine';
import { INDEX, OKX_REST, OkxFeed, POLL_MS, STALE_MS, TIMEOUT_MS, samplesFromCandles, ticks } from '../src/tape/feed';

const TICKER = `${OKX_REST}/api/v5/market/index-tickers?instId=OKB-USD`;
const reading = (idxPx: unknown, ts: unknown, instId: unknown = INDEX): unknown => ({ code: '0', data: [{ instId, idxPx, ts }], msg: '' });

/** A feed on a manual clock. Ticker requests stay open until the test answers them; candle requests answer from `pages`. */
function harness(pages: unknown[][] = []) {
  const urls: string[] = [], open: { resolve(body: unknown): void; reject(): void }[] = [], timers = new Map<number, { at: number; fn: () => void }>();
  let clock = 0, id = 0, candles = 0;
  const feed = new OkxFeed({
    fetch: (url) => {
      urls.push(url);
      if (url.includes('index-candles')) { const data = pages[candles++] ?? []; return Promise.resolve({ json: async () => ({ code: '0', data }) }); }
      return new Promise((resolve, reject) => open.push({ resolve: (body) => resolve({ json: async () => body }), reject: () => reject(new Error('offline')) }));
    },
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
  const settled = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  /** Answers the oldest open ticker request. */
  const answer = async (body: unknown): Promise<void> => { open.shift()!.resolve(body); await settled(); };
  const fail = async (): Promise<void> => { open.shift()!.reject(); await settled(); };
  const tickers = (): number => urls.filter((u) => u === TICKER).length;
  return { feed, urls, open, timers, advance, answer, fail, tickers, now: () => clock };
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

  it('asks for the OKB-USD index over HTTPS only and reports connecting, live and stale prices', async () => {
    const h = harness(); h.feed.start();
    expect(h.urls).toEqual([TICKER]); expect(TICKER.startsWith('https://www.okx.com/')).toBe(true);
    expect(h.feed.state(h.now())).toBe('connecting');
    h.advance(300); await h.answer(reading('112.95', '1794927367101'));
    expect(h.feed.latest()).toEqual({ price: 112_950, at: 300 }); expect(h.feed.state(h.now())).toBe('live');
    expect(h.feed.state(300 + STALE_MS)).toBe('live'); expect(h.feed.state(301 + STALE_MS)).toBe('stale');
  });

  it('asks again one second after the last request was sent, one request at a time', async () => {
    const h = harness(); h.feed.start();
    h.advance(300); await h.answer(reading('112.95', '1000'));
    h.advance(POLL_MS - 301); expect(h.tickers()).toBe(1);
    h.advance(1); expect(h.tickers()).toBe(2);
    h.advance(1500); expect(h.tickers()).toBe(2); // still unanswered: no second request beside it
    await h.answer(reading('112.96', '2000')); h.advance(0); // answered late: the next one goes at once
    expect(h.tickers()).toBe(3); expect(h.feed.latest()).toEqual({ price: 112_960, at: 2500 });
  });

  it('does not take a repeated reading for a fresh price', async () => {
    const h = harness(); h.feed.start();
    await h.answer(reading('112.95', '1000'));
    for (let i = 0; i < 6; i++) { h.advance(POLL_MS); await h.answer(reading('112.95', '1000')); }
    expect(h.feed.latest()).toEqual({ price: 112_950, at: 0 }); expect(h.feed.state(h.now())).toBe('stale');
    h.advance(POLL_MS); await h.answer(reading('112.95', '999')); expect(h.feed.state(h.now())).toBe('stale'); // an older stamp neither
    h.advance(POLL_MS); await h.answer(reading('112.95', '1001'));
    expect(h.feed.latest()).toEqual({ price: 112_950, at: 8000 }); expect(h.feed.state(h.now())).toBe('live');
  });

  it('ignores malformed answers, other instruments and error codes, and asks less often while they keep coming', async () => {
    const h = harness(); h.feed.start();
    const bad = [{ code: '50011', data: [], msg: 'Too Many Requests' }, reading('1', '1000', 'BTC-USD'), reading(112.9, '1000'), reading('-1', '1000'), reading('112.95', 1000), reading('112.95', '-5'), null, 'not an object'];
    const waits = [1000, 2000, 5000, 10_000, 10_000, 10_000, 10_000, 10_000];
    for (const [i, body] of bad.entries()) {
      await h.answer(body);
      h.advance(waits[i]! - 1); expect(h.tickers(), `answer ${i}`).toBe(i + 1);
      h.advance(1); expect(h.tickers(), `answer ${i}`).toBe(i + 2);
    }
    expect(h.feed.latest()).toBeNull(); expect(h.feed.state(h.now())).toBe('connecting');
    await h.answer(reading('112.95', '1000')); // one good answer brings the one-second pace back
    h.advance(POLL_MS); expect(h.tickers()).toBe(bad.length + 2);
    await h.fail(); h.advance(999); expect(h.tickers()).toBe(bad.length + 2); h.advance(1); expect(h.tickers()).toBe(bad.length + 3);
  });

  it('counts a request with no answer as a failure and ignores its answer if it comes later', async () => {
    const h = harness(); h.feed.start();
    h.advance(TIMEOUT_MS - 1); expect(h.tickers()).toBe(1);
    h.advance(1 + 999); expect(h.tickers()).toBe(1); h.advance(1); expect(h.tickers()).toBe(2); // abandoned at 4 s, retried 1 s later
    await h.answer(reading('1.00', '500')); // the abandoned request answers at last
    expect(h.feed.latest()).toBeNull(); expect(h.tickers()).toBe(2);
    await h.answer(reading('112.95', '1000')); expect(h.feed.latest()).toEqual({ price: 112_950, at: 5000 });
  });

  it('stops cleanly and forgets old prices when started again', async () => {
    const h = harness(); h.feed.start(); await h.answer(reading('112.95', '1000'));
    h.advance(POLL_MS); expect(h.tickers()).toBe(2); // one request is in flight
    h.feed.stop(); expect(h.timers.size).toBe(0);
    h.advance(60_000); expect(h.tickers()).toBe(2);
    h.feed.start(); expect(h.feed.latest()).toBeNull(); expect(h.feed.state(h.now())).toBe('connecting'); expect(h.tickers()).toBe(3);
    await h.answer(reading('1.00', '2000')); // the request from before the stop
    expect(h.feed.latest()).toBeNull(); h.advance(POLL_MS); expect(h.tickers()).toBe(3);
    await h.answer(reading('112.97', '1000')); // the stamp from before the restart counts again
    expect(h.feed.latest()).toEqual({ price: 112_970, at: 62_000 });
    h.feed.stop(); await h.fail().catch(() => undefined); expect(h.timers.size).toBe(0);
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
