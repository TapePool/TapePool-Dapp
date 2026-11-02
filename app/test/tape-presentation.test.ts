import { describe, expect, it } from 'vitest';
import { Engine, KEEP, payout, ROW, UNIT } from '../src/dev/trace/engine';

/** An engine opened on a flat $110.50 history. */
function opened(): Engine { const g = new Engine(); g.reset(Array.from({ length: KEEP }, () => 110_500)); return g; }
import { CELL, MAX_EFFECTS, MAX_RESULTS, NOTICE_MS, PLACEMENT_MS, RESULT_KEEP, RESULT_MS, Presentation, projectX, projectY, sampleAt, targetBounds } from '../src/dev/trace/presentation';
import { parseHash } from '../src/route';

describe('Tape presentation', () => {
  it('projects time and price with one square lattice across camera movement', () => {
    const p = { width: 1440, height: 700, now: 4200, camera: 110513, cell: CELL };
    const cell = targetBounds(p, 110500, 20000);
    expect(cell.width).toBe(CELL); expect(cell.height).toBe(CELL);
    expect(projectX(p, 25000) - projectX(p, 20000)).toBe(CELL);
    expect(projectY(p, 110500) - projectY(p, 110550)).toBe(CELL);
    expect(cell.x).toBe(projectX(p, 20000)); expect(cell.y).toBe(projectY(p, 110550));
    const moved = { ...p, now: p.now + 50, camera: p.camera + 1 };
    expect(targetBounds(moved, 110500, 20000).x - cell.x).toBeCloseTo(-.8);
    expect(targetBounds(moved, 110500, 20000).y - cell.y).toBeCloseTo(1.6);
  });
  it('interpolates known samples without extrapolation and preserves pending evidence', () => {
    const samples = [{ time: 0, price: 100 }, { time: 200, price: 110 }];
    expect(sampleAt(samples, 100)).toBe(105); expect(sampleAt(samples, 500)).toBe(110);
    const p = new Presentation(); const g = opened(); const q = g.quote(110500, 15000)!; const ticket = g.place(q)!;
    p.queue([ticket], 200, 110500); p.advance(100, 200, 110500); expect(p.time).toBe(100); expect(p.release()).toHaveLength(0);
    const camera = p.camera; expect(p.time).toBe(100); expect(p.camera).toBe(camera); // no callbacks while suspended
    p.advance(100, 200, 110500); expect(p.release()[0]?.price).toBe(110500); p.reset(); expect([p.time, p.phase, p.camera, p.pending.length]).toEqual([0, 0, 0, 0]);
  });
  it('does not settle when only interpolation crosses the price interval', () => {
    const g = opened(); const q = g.quote(110500, 15000)!; const ticket = g.place(q)!;
    g.now = 14800; g.sample(110490); g.sample(110560); expect(ticket.status).toBe('open');
    expect(sampleAt([{ time: 15000, price: 110490 }, { time: 15200, price: 110560 }], 15100)).toBeGreaterThan(110500);
  });
  it('routes Tape and redirects the former local URL', () => {
    expect(parseHash('#/app/tape').page).toBe('trace'); expect(parseHash('#/app/trace').redirect).toBe('#/app/tape');
  });
  it('releases a winning effect once at its authoritative sample without paying again', () => {
    const game = opened(), visual = new Presentation();
    const quote = game.quote(110500, 15000)!; game.place(quote);
    game.now = 14800; const done = game.sample(110500), balance = game.balance;
    visual.time = 14900; visual.queue(done, game.now, game.price); visual.queue(done, game.now, game.price);
    expect(visual.release()).toHaveLength(0); expect(visual.effects).toHaveLength(0);
    visual.advance(100, game.now, game.price);
    expect(visual.release()).toHaveLength(1); expect(visual.release()).toHaveLength(0);
    visual.queue(done, game.now, game.price); expect(visual.release()).toHaveLength(0);
    expect(visual.effects).toMatchObject([{ kind: 'won', low: 110500, start: 15000, sampleTime: 15000, samplePrice: 110500, amount: payout(quote.stake, quote.multiplier) }]);
    expect(visual.notice).toMatchObject({ wins: 1, losses: 0, returned: payout(quote.stake, quote.multiplier), lost: 0n });
    expect(game.balance).toBe(balance); expect(balance).toBe(10n * UNIT - quote.stake + payout(quote.stake, quote.multiplier));
  });
  it('reports lost stake without a second debit and keeps the settled cell after the notice', () => {
    const game = opened(), visual = new Presentation();
    const quote = game.quote(110000, 15000)!; game.place(quote); const balance = game.balance;
    game.now = 19800; const done = game.sample(110500); visual.time = game.now;
    visual.queue(done, game.now, game.price); visual.release();
    expect(visual.notice).toMatchObject({ wins: 0, losses: 1, returned: 0n, lost: quote.stake });
    expect(visual.effects[0]?.kind).toBe('lost'); expect(game.balance).toBe(balance);
    visual.advance(RESULT_MS, 50000, game.price); expect(visual.effects).toHaveLength(1); expect(visual.notice).not.toBeNull();
    visual.advance(NOTICE_MS - RESULT_MS, 50000, game.price); expect(visual.notice).toBeNull(); expect(visual.effects).toHaveLength(1);
    visual.advance(RESULT_KEEP - NOTICE_MS - 1, 1e9, game.price); expect(visual.effects).toHaveLength(1);
    visual.advance(1, 1e9, game.price); expect(visual.effects).toHaveLength(0); expect(game.balance).toBe(balance);
  });
  it('bounds simultaneous target effects while summarizing every result', () => {
    const game = opened(), visual = new Presentation(); game.setStake('0.05');
    for (let i = 0; i < 30; i++) game.place(game.quote(100000 + i * 50, 15000)!);
    const win = game.quote(110500, 20000)!;
    for (let i = 0; i < 20; i++) game.place(win);
    game.now = 19800; const done = game.sample(110500); visual.time = game.now;
    visual.queue(done, game.now, game.price); visual.release();
    expect(done).toHaveLength(50); expect(visual.effects).toHaveLength(31);
    expect(visual.notice).toMatchObject({ wins: 20, losses: 30, returned: 20n * payout(win.stake, win.multiplier), lost: 30n * win.stake });
    expect(visual.effects.find(effect => effect.kind === 'won')?.count).toBe(20);
    expect(game.balance).toBe(10n * UNIT - 50n * win.stake + 20n * payout(win.stake, win.multiplier));
  });
  it('keeps settled cells when new bets pulse and caps each kind separately', () => {
    const game = opened(), visual = new Presentation(); game.setStake('0.05');
    const quote = game.quote(110500, 15000)!;
    const lost = Array.from({ length: MAX_RESULTS + 5 }, (_, i) => ({ ...quote, low: 100000 + i * ROW, high: 100000 + (i + 1) * ROW, id: i + 1, status: 'lost' as const, payout: 0n }));
    visual.queue(lost, 0, 110500); visual.release();
    expect(visual.effects).toHaveLength(MAX_RESULTS); expect(visual.effects[0]?.low).toBe(100000 + 5 * ROW);
    for (let i = 0; i < MAX_EFFECTS + 2; i++) visual.placed(game.place(game.quote(110500 + i * ROW, 15000)!)!);
    expect(visual.effects.filter(effect => effect.kind === 'placed')).toHaveLength(MAX_EFFECTS);
    expect(visual.effects.filter(effect => effect.kind === 'lost')).toHaveLength(MAX_RESULTS);
  });
  it('retains placement feedback while suspended and clears all feedback on reset', () => {
    const game = opened(), visual = new Presentation(), ticket = game.place(game.quote(110500, 15000)!)!;
    visual.placed(ticket); const balance = game.balance;
    visual.advance(PLACEMENT_MS - 1, 1000, game.price); expect(visual.effects).toHaveLength(1);
    // No presentation advance while paused, hidden or unmounted: evidence keeps its exact world bounds.
    expect(visual.effects[0]).toMatchObject({ low: ticket.low, start: ticket.start, kind: 'placed' });
    visual.advance(1, 1000, game.price); expect(visual.effects).toHaveLength(0);
    game.now = 14800; const done = game.sample(110500); visual.time = game.now; visual.queue(done, game.now, game.price); visual.release();
    expect(visual.notice).not.toBeNull(); visual.reset(); expect(visual.effects).toHaveLength(0); expect(visual.notice).toBeNull(); expect(visual.pending).toHaveLength(0);
    expect(game.balance).toBe(balance + ticket.payout);
  });
});
