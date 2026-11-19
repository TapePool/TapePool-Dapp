// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { errorText } from '../src/chain/errors';
import { EMPTY } from '../src/html';
import { deriveBorrow } from '../src/logic/borrow';
import { flow } from '../src/render/borrow';
import { make } from './helpers';

function quoted(source: 'maximum' | 'principal', offset: number, reason: number, lang: 'en' | 'cn') {
  const { ctx } = make('flow-fresh', { lang });
  const enabledAt = ctx.now - 359;
  ctx.now = enabledAt + offset;
  ctx.snap.now = ctx.now;
  ctx.snap.pool.feedSettleUntil = enabledAt + 360;
  ctx.snap.pool.feedDisabled = false;
  const agent = ctx.borrow!.agent!;
  for (const id of agent.collateral) ctx.snap.reports[String(id)] = { observedAt: ctx.now - 1 };
  const quotes = ctx.snap.quotes[agent.address.toLowerCase()]!;
  ctx.snap.quotes[agent.address.toLowerCase()] = [
    { ...quotes[0]!, reason: source === 'maximum' ? reason : 0, maxPrincipal: source === 'maximum' && reason !== 0 ? 0n : quotes[0]!.maxPrincipal },
    quotes[1],
  ];
  ctx.ui.term = 0;
  ctx.ui.amt = '0.0200';
  if (source === 'principal') {
    ctx.snap.principalQuotes = true;
    ctx.ui.principalQuote = { agent: agent.address, term: 0, principal: 2_000_000n, value: { fee: 300_000n, lateBps: 0, debt: 2_300_000n, allowed: reason === 0, reason, binding: 0 } };
  }
  ctx.borrow = deriveBorrow(ctx.snap, ctx.ui, ctx.now);
  const root = document.createElement('div');
  root.innerHTML = flow(ctx, EMPTY).value;
  return { ctx, summary: root.querySelector('[aria-labelledby="q1"]')!.textContent! };
}

describe('RC4-04 settling copy for maximum and principal quotes', () => {
  for (const source of ['maximum', 'principal'] as const) {
    for (const lang of ['en', 'cn'] as const) {
      for (const offset of [359, 360]) {
        it(`${source} quote at +${offset} uses the settling boundary in ${lang}`, () => {
          const { ctx, summary } = quoted(source, offset, offset === 359 ? 8 : 0, lang);
          const settling = errorText({ kind: 'revert', name: 'FeedSettling' });
          const feedOff = errorText({ kind: 'quote', reason: 8 });
          const b = ctx.borrow!;
          expect(b.report).toBe('fresh');
          expect(b.source).toBe('quote');
          expect(b.settling).toBe(offset === 359);
          if (source === 'principal') {
            expect(b.principalQuote).toMatchObject({ reason: offset === 359 ? 8 : 0, fee: 300_000n, debt: 2_300_000n, binding: 0 });
          } else expect(b.quote?.reason).toBe(offset === 359 ? 8 : 0);
          if (offset === 359) {
            expect(b.canBorrow).toBe(false);
            expect(b.blockers).toContain(settling);
            expect(b.blockers).not.toContain(feedOff);
            expect(summary).toContain(settling);
          } else {
            expect(b.blockers).not.toContain(settling);
            expect(summary).not.toContain(settling);
          }
          expect(summary).not.toContain(feedOff);
        });
      }

      it(`${source} FEED_OFF outside settling keeps the plain feed-off text in ${lang}`, () => {
        const { ctx, summary } = quoted(source, 360, 8, lang);
        const feedOff = errorText({ kind: 'quote', reason: 8 });
        const settling = errorText({ kind: 'revert', name: 'FeedSettling' });
        expect(ctx.borrow!.settling).toBe(false);
        expect(ctx.borrow!.canBorrow).toBe(false);
        expect(ctx.borrow!.blockers).toContain(feedOff);
        expect(ctx.borrow!.blockers).not.toContain(settling);
        expect(summary).toContain(feedOff);
        expect(summary).not.toContain(settling);
      });
    }
  }

  it('preserves an earlier quote blocker during settling', () => {
    const { ctx, summary } = quoted('maximum', 359, 7, 'en');
    expect(ctx.borrow!.blockers).toContain(errorText({ kind: 'quote', reason: 7 }));
    expect(summary).toContain(errorText({ kind: 'quote', reason: 7 }));
  });
});
