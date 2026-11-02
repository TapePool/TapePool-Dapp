import { describe, expect, it } from 'vitest';
import { renderApp } from '../src/render';
import type { Ask } from '../src/model';
import { make, textOf } from './helpers';

/** SPEC-PHASE5-APP §6.0 rule 4: one line says what the wallet will ask, on the page and in a modal. */

const ASK: Ask = { contract: 'RigAgent 0x1234…abcd', fn: 'borrow(7 days, 1.2000 BEM)', value: '0.031 OKB' };

function shown(name: string, hash: string, lang: 'en' | 'cn', pending: { hash: `0x${string}` | null; ask?: Ask } | null): { html: string; text: string } {
  const made = make(name, { hash, lang });
  const ctx = { ...made.ctx, snap: { ...made.ctx.snap, pending: pending ? { action: 'borrow' as const, since: 1, ...pending } : null } };
  const out = renderApp(ctx);
  const html = out.screen.value + (out.modal?.value ?? '');
  return { html, text: textOf(html) };
}

describe('the line for the wallet', () => {
  for (const [name, hash] of [
    ['connected', '#/app/rigs'],
    ['rig-ready', '#/app/rigs/4127'],
    ['repay-modal', '#/app/rigs/3871/repay'],
  ] as const) {
    it(`is on ${name} (${hash}) in English and Chinese, with the contract, the function and the value`, () => {
      const en = shown(name, hash, 'en', { hash: null, ask: ASK });
      expect(en.text).toContain('Your wallet will ask you to confirm:');
      for (const part of [ASK.contract, ASK.fn, ASK.value]) expect(en.text, part).toContain(part);
      const cn = shown(name, hash, 'cn', { hash: null, ask: ASK });
      expect(cn.text).toContain('您的钱包将请您确认：');
      for (const part of [ASK.contract, ASK.fn, ASK.value]) expect(cn.text, part).toContain(part);
      expect(en.html + cn.html).not.toMatch(/ style=/);
    });

    it(`says it waits for confirmation once the hash is known, and is gone when nothing is pending (${name})`, () => {
      expect(shown(name, hash, 'en', { hash: `0x${'ab'.repeat(32)}`, ask: ASK }).text).toContain('Waiting for confirmation:');
      expect(shown(name, hash, 'cn', { hash: `0x${'ab'.repeat(32)}`, ask: ASK }).text).toContain('等待确认：');
      expect(shown(name, hash, 'en', null).text).not.toContain('Your wallet will ask');
      // a pending keeper request has no transaction and no line
      expect(shown(name, hash, 'en', { hash: null }).text).not.toContain('Your wallet will ask');
    });
  }

  it('escapes its text', () => {
    const evil: Ask = { contract: '<img src=x onerror=alert(1)>', fn: '"><script>1</script>', value: '&amp;' };
    const { html } = shown('connected', '#/app/rigs', 'en', { hash: null, ask: evil });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>1');
    expect(html).toContain('&lt;img src=x');
  });
});
