import { describe, expect, it } from 'vitest';
import { EDGE, Engine, earliest, KEEP, money, parseStake, payout, priced, ROW, SIGMA_FLOOR, STEP, touch, UNIT, WINDOW } from '../src/dev/trace/engine';

/** An engine opened on a flat $110.50 history, as if the index had not moved for 2 minutes. */
function opened(price = 110_500): Engine { const g = new Engine(); g.reset(Array.from({ length: KEEP }, () => price)); return g; }
const source = (seed: number) => () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
/** A seeded price path with momentum (trending runs), the hardest case for a volatility measured on past changes. */
function trending(seed: number): () => number {
  const rng = source(seed); let level = 110_500, velocity = 0, trend = 0;
  return () => { trend = trend * .99 + (rng() - .5) * .4; velocity = velocity * .93 + trend * .07 + (rng() - .5) * 2.6 - (level - 110_500) * .0001; level += velocity; return Math.round(level); };
}

describe('Tape engine', () => {
  it('validates decimal stake and computes exact gross payout', () => {
    for (const s of ['0', '-1', '1e2', 'NaN', '1.000000001', '.1']) expect(parseStake(s)).toBeNull();
    expect(parseStake('0.00000001')).toBe(1n); expect(money(payout(10000001n, 123))).toBe('0.12300001');
  });
  it('honors the aligned minimum lead around boundaries', () => {
    expect([earliest(0), earliest(1), earliest(4999), earliest(5000), earliest(5001)]).toEqual([10000, 15000, 15000, 15000, 20000]);
  });
  it('locks a quote, debits repeated bets, pays a touch once, and resets', () => {
    const g = opened(); const q = g.quote(110500, 15000)!; const a = g.place(q)!; const b = g.place(q)!;
    expect(g.balance).toBe(98n * UNIT / 10n); expect(a.multiplier).toBe(q.multiplier);
    for (let i = 0; i < 74; i++) g.sample(110000);
    expect(g.sample(110500)).toHaveLength(2); expect(g.balance).toBe(98n * UNIT / 10n + 2n * payout(q.stake, q.multiplier));
    g.sample(110500); expect(g.settled).toHaveLength(2); expect(b.status).toBe('won');
    g.setStake('2'); g.reset([110_600]); expect(g.balance).toBe(10n * UNIT); expect(g.stake).toBe('0.10'); expect(g.open).toHaveLength(0); expect(g.price).toBe(110_600);
  });
  it('excludes high price and end time, then loses exactly once', () => {
    const g = opened(); const q = g.quote(110500, 15000)!; g.place(q);
    for (let i = 0; i < 99; i++) g.sample(110550);
    expect(g.open).toHaveLength(1); g.sample(110500); expect(g.settled[0]?.status).toBe('lost');
    g.sample(110500); expect(g.settled).toHaveLength(1);
  });
  it('rejects stale, changed-stake, forged and late quotes without charging', () => {
    const g = opened(); const q = g.quote(110500, 15000)!;
    expect(g.place({ ...q })).toBeNull(); g.setStake('0.25'); expect(g.place(q)).toBeNull();
    const later = g.quote(110500, 20000)!; for (let i = 0; i < 6; i++) g.sample(110500); expect(g.place(later)).toBeNull();
    expect(g.quote(110500, 10000)).toBeNull(); expect(g.balance).toBe(10n * UNIT);
  });
  it('caps open tickets and settled history', () => {
    const g = opened(); g.setStake('0.05'); const q = g.quote(110500, 15000)!;
    for (let i = 0; i < 50; i++) expect(g.place(q)).not.toBeNull(); expect(g.place(q)).toBeNull();
    for (let i = 0; i < 100; i++) g.sample(110000); expect(g.open).toHaveLength(0); expect(g.settled).toHaveLength(50);
  });
  it('expires one ticket while another wins on the same sample and caps history at 100', () => {
    const g = opened(); g.setStake('0.05');
    const first = g.quote(110000, 15000)!; const second = g.quote(110500, 20000)!;
    g.place(first); g.place(second);
    for (let i = 0; i < 99; i++) g.sample(110250);
    const done = g.sample(110500); expect(done.map(x => x.status)).toEqual(['lost', 'won']);
    for (let batch = 0; batch < 3; batch++) {
      const q = g.quote(110000, earliest(g.now))!;
      for (let i = 0; i < 40; i++) expect(g.place(q)).not.toBeNull();
      while (g.now < q.end) g.sample(110250);
    }
    expect(g.settled).toHaveLength(100); expect(g.open).toHaveLength(0);
  });
  it('prices a touch from where the walk may be, never paying more than a fair bet plus one cent in a hundred', () => {
    expect(touch(110_525, 110_500, 110_550, 0, WINDOW, 20)).toBeCloseTo(1, 6);
    expect(touch(110_525, 112_000, 112_050, 10_000, WINDOW, 3)).toBeLessThan(1e-6);
    expect(touch(110_500, 110_550, 110_600, 10_000, WINDOW, 10)).toBeCloseTo(touch(110_500, 110_400, 110_450, 10_000, WINDOW, 10), 2); // the same gap below or above
    expect(touch(110_500, 110_650, 110_700, 60_000, WINDOW, 10)).toBeGreaterThan(touch(110_500, 110_650, 110_700, 10_000, WINDOW, 10));
    expect([priced(1), priced(.5), priced(.95), priced(1e-6)]).toEqual([101, 190, 101, 800]);
    const walk = trending(7), g = new Engine(); g.reset(Array.from({ length: KEEP }, walk)); const start = earliest(g.now);
    for (const lead of [0, 3, 10]) {
      const base = Math.floor(g.price / ROW) * ROW, column = Array.from({ length: 13 }, (_, i) => g.quote(base + (i - 6) * ROW, start + lead * WINDOW)!);
      const shown = column.map(q => q.multiplier), near = shown.indexOf(Math.min(...shown));
      for (let i = near; i > 0; i--) expect(shown[i - 1]).toBeGreaterThanOrEqual(shown[i]!);
      for (let i = near; i < shown.length - 1; i++) expect(shown[i + 1]).toBeGreaterThanOrEqual(shown[i]!);
      for (const q of column) expect(touch(g.price, q.low, q.high, q.start - g.now, WINDOW, g.sigma) * q.multiplier / 100).toBeLessThanOrEqual(Math.max(1 - EDGE, 1.01) + 1e-9);
    }
  });
  it('has no price before the opening history, then loads it, measures its volatility and samples on', () => {
    const g = new Engine();
    expect(g.history).toHaveLength(0); expect(g.price).toBe(0); expect(g.quote(110_500, earliest(0))).toBeNull(); expect(g.sigma).toBe(SIGMA_FLOOR);
    g.reset([]); expect(g.history).toHaveLength(0); expect(g.quote(110_500, earliest(0))).toBeNull();
    // A steady climb of 1 cent a second moves 10 cents in 10 s; a flicker that returns within 10 s adds nothing.
    const prices = Array.from({ length: 400 }, (_, i) => 112_000 + Math.floor(i / 5) * 10 + (i % 10 < 5 ? 0 : 10));
    g.load(prices);
    expect(g.history).toHaveLength(400); expect(g.history.at(-1)).toEqual({ time: 0, price: prices.at(-1) }); expect(g.history[0]!.time).toBe(-399 * STEP);
    expect(g.price).toBe(prices.at(-1)); expect(g.sigma).toBeCloseTo(100 / Math.sqrt(10), 6);
    expect(g.quote(112_900, earliest(0))).not.toBeNull();
    g.sample(112_950); expect(g.history.at(-1)).toEqual({ time: STEP, price: 112_950 });
    g.load(Array.from({ length: KEEP + 50 }, () => 112_000)); expect(g.history).toHaveLength(KEEP);
  });
  it('returns less than the stake on average for every distance and lead, measured on seeded trending paths', () => {
    const groups = new Map<string, { n: number; paid: number }>();
    for (let session = 0; session < 30; session++) {
      const walk = trending(1000 + session); for (let i = 0; i < 400; i++) walk();
      const g = new Engine(); g.reset(Array.from({ length: KEEP }, walk));
      const bets: { low: number; start: number; end: number; m: number; key: string }[] = [], path: { time: number; price: number }[] = [];
      for (let i = 1; i <= 1200; i++) {
        if (i % 25 === 0) for (const lead of [0, 4]) {
          const base = Math.floor(g.price / ROW) * ROW;
          for (let d = -4; d <= 4; d++) {
            const q = g.quote(base + d * ROW, earliest(g.now) + lead * WINDOW)!;
            const away = q.low > g.price ? Math.ceil((q.low - g.price) / ROW) : g.price >= q.high ? Math.ceil((g.price - q.high + 1) / ROW) : 0;
            bets.push({ low: q.low, start: q.start, end: q.end, m: q.multiplier, key: `${lead}:${Math.min(away, 3)}` });
          }
        }
        g.sample(walk()); path.push({ time: g.now, price: g.price });
      }
      for (const b of bets.filter(x => x.end <= g.now)) {
        const won = path.some(x => x.time >= b.start && x.time < b.end && x.price >= b.low && x.price < b.low + ROW);
        const group = groups.get(b.key) ?? { n: 0, paid: 0 }; group.n++; if (won) group.paid += b.m / 100; groups.set(b.key, group);
      }
    }
    expect(groups.size).toBe(8);
    for (const [key, group] of groups) expect(group.paid / group.n, key).toBeLessThan(1);
  });
});
