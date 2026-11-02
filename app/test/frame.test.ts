import { describe, expect, it } from 'vitest';
import { allHashes, fixtureNames, make, must, mustNot } from './helpers';

/** Buttons that send a transaction or open a wallet prompt. */
const WRITE = /data-a="(connect|pick-wallet|picker-close|picker-get|picker-back|menu|copy-addr|disconnect|switchnet|create|move|refresh|selfpush|borrow|approve-repay|repay-do|repay|sweep|release|take-back|register|claim|approve-supply|supply|withdraw)"/;

describe('write controls', () => {
  it('are not drawn at all inside another site (frame check)', { timeout: 60_000 }, () => {
    const thorough = ['connected', 'rigs-all', 'flow-fresh', 'flow-moved', 'loan-flagged', 'loan-cleared', 'deposits-closed'];
    const pages: [string, string][] = [
      ...fixtureNames.map((n): [string, string] => [n, '']),
      ...thorough.flatMap((n) => allHashes(n).map((h): [string, string] => [n, h])),
    ];
    for (const [name, hash] of pages) {
      for (const lang of ['en', 'cn'] as const) {
        const { html } = make(name, { hash: hash || undefined, lang, inFrame: true });
        mustNot(html, WRITE, `${name} ${hash} frame`);
      }
    }
  });

  it('say why, in a frame', () => {
    must(make('connected', { hash: '#/app/rigs', inFrame: true }).html, 'shown inside another site', 'frame notice');
    must(make('connected', { hash: '#/app/rigs', lang: 'cn', inFrame: true }).html, '其他网站内', 'frame notice');
  });

  it('are drawn off in the read-only view of an address', () => {
    for (const hash of ['#/app', '#/app/rigs', '#/app/rigs/4127', '#/app/rigs/3871', '#/app/rigs/group', '#/app/markets/bem', '#/app/supply', '#/app/withdraw', '#/app/rigs/3871/repay']) {
      const view = hash.replace('#/app', '#/app/view/0xde709f2102306220921060314715629080e2fb77');
      for (const name of ['connected', 'flow-fresh', 'loan-cleared', 'rigs-all']) {
        const { html, ctx } = make(name, { hash: view });
        expect(ctx.readOnly).toBe('view');
        mustNot(html, WRITE, `${name} ${view}`);
        must(html, 'Read-only view', `${name} ${view}`);
      }
    }
  });

  it('keep the view prefix in every link', () => {
    const view = '#/app/view/0xde709f2102306220921060314715629080e2fb77';
    const { html } = make('rigs-all', { hash: `${view}/rigs` });
    const links = [...html.matchAll(/href="(#\/app[^"]*)"/g)].map((m) => m[1] ?? '');
    expect(links.length).toBeGreaterThan(20);
    for (const l of links) expect(l.startsWith(view), l).toBe(true);
  });

  it('are on for a connected wallet', () => {
    expect(WRITE.test(make('connected', { hash: '#/app/rigs/3871' }).html)).toBe(true);
    must(make('flow-fresh').html, 'data-a="borrow"', 'borrow button');
  });

  it('the wallet gate shows only a connect or switch button', () => {
    const off = make('disconnected', { hash: '#/app/rigs' }).html;
    must(off, 'data-a="connect"', 'gate');
    mustNot(off, 'class="rcard', 'gate');
    const wrong = make('wrong-network', { hash: '#/app' }).html;
    must(wrong, 'data-a="switchnet"', 'gate');
    must(wrong, 'Switch to X Layer', 'gate');
    // markets and the pool page need no wallet
    must(make('disconnected', { hash: '#/app/markets' }).html, 'Total Supplied', 'markets');
    must(make('disconnected', { hash: '#/app/markets/bem' }).html, 'Supply BEM, receive tpBEM', 'pool');
  });
});
