import { describe, expect, it } from 'vitest';
import { allHashes, make, must, mustNot } from './helpers';

/** A figure that is an on-chain parameter must come from the view model, never from the copy (SPEC-PHASE5-APP §11). */
const MAINNET_FIGURES = [
  '0.75%',
  '1.5%',
  '39.11%',
  '0.031',
  '0.040',
  '0.003',
  '0.01',
  '0.0100',
  '0.0017',
  '85%',
  '80%',
  '70%',
  '40%',
  '20.0000',
  '9.9855',
  '10 BEM',
  'Oct 26',
  '10月26日',
];

const has = (text: string, token: string): boolean => {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}(?!\\d)`).test(text);
};

describe('no on-chain parameter is written into the copy', () => {
  it('param-shift: none of the mainnet figures appears on any page', () => {
    const hits: string[] = [];
    for (const name of ['param-shift', 'param-shift-flow']) {
      for (const hash of allHashes(name)) {
        for (const lang of ['en', 'cn'] as const) {
          const text = make(name, { hash, lang }).text;
          for (const token of MAINNET_FIGURES) if (has(text, token)) hits.push(`${name} ${hash} ${lang}: ${token}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('param-shift: the shifted figures do appear', () => {
    const { html } = make('param-shift', { hash: '#/app/markets/bem', lang: 'en' });
    for (const token of ['0.9%', '1.9%', '84%', '79%', '35%', '65%', '0.02', '0.004', '25.0000']) must(html, token, 'pool page');
    const rig = make('param-shift', { hash: '#/app/rigs/4127', lang: 'en' }).html;
    for (const token of ['0.027', '0.052', 'Nov 3']) must(rig, token, 'rig page');
  });

  it('ops fee 0: the operating fee is labelled sponsored and the nonzero fee box disappears', () => {
    for (const lang of ['en', 'cn'] as const) {
      // the harvest-first cost line says the OKB fee does not cover its BNB (SPEC-PHASE5-PRELOAN §7): that sentence is not about the fee
      const text = make('ops-fee-zero', { hash: '#/app/rigs/4127', lang }).text.replace('The OKB operating fee does not cover it.', '').replace('OKB 运营费不涵盖这笔费用。', '');
      must(text, lang === 'en' ? '0 OKB (sponsored)' : '0 OKB（由赞助方支付）', `ops fee 0 ${lang}`);
      mustNot(text, lang === 'en' ? 'About the' : '关于', `ops fee 0 ${lang}`);
    }
    const on = make('connected', { hash: '#/app/rigs/4127', lang: 'en' }).html;
    must(on, 'Plus 0.031 OKB per loan, not included in this percentage', 'ops fee on');
    must(on, 'About the 0.031 OKB operating fee', 'ops fee on');
  });

  it('shows no dollar figure and no price line', () => {
    for (const lang of ['en', 'cn'] as const) {
      const { html } = make('connected', { hash: '#/app/rigs/4127', lang });
      expect(html).not.toMatch(/\$\d/);
      expect(html).not.toMatch(/Prices used|美元换算/);
    }
  });
});
