// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { esc, html } from '../src/html';
import { makeCtx } from '../src/ctx';
import { createFixture } from '../src/fixtures/catalog';
import { setLang } from '../src/i18n';
import type { Address, Snapshot } from '../src/model';
import { renderApp } from '../src/render';
import { parseHash } from '../src/route';
import type { DataSource } from '../src/source';
import { freshUi } from '../src/state';
import { allHashes } from './helpers';

const HOSTILE = [
  '<img src=x onerror=alert(1)>',
  '"><script>alert(2)</script>',
  `" onmouseover="alert(3)" x="`,
  `' onfocus='alert(4)`,
  'a&b&amp;c&#x3C;',
];

describe('esc and the html tag', () => {
  it('escapes the five characters that can break out of text or an attribute', () => {
    expect(esc(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    expect(esc(42)).toBe('42');
    expect(esc(10n ** 20n)).toBe('100000000000000000000');
  });

  it('escapes every ${} unless it is markup built by html()', () => {
    const evil = '<img src=x onerror=alert(1)>';
    expect(html`<p>${evil}</p>`.value).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    expect(html`<p title="${evil}">x</p>`.value).not.toContain('<img');
    expect(html`<p>${html`<b>${evil}</b>`}</p>`.value).toBe('<p><b>&lt;img src=x onerror=alert(1)&gt;</b></p>');
    expect(html`<p>${[evil, html`<i>ok</i>`, null, false, 7]}</p>`.value).toBe('<p>&lt;img src=x onerror=alert(1)&gt;<i>ok</i>7</p>');
  });
});

/** Replace every address and hash in the snapshot with hostile text, the same one each time. */
function hostile(snap: Snapshot, payload: string): Snapshot {
  const seen = new Map<string, string>();
  const swap = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (/^0x[0-9a-fA-F]{40}$/.test(v) || /^0x[0-9a-fA-F]{64}$/.test(v)) {
        if (!seen.has(v)) seen.set(v, `${payload}#${seen.size}`);
        return seen.get(v);
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
    return v;
  };
  const out = swap(snap) as Snapshot;
  out.pool.circuit.processorName = payload;
  out.pool.circuit.processorSymbol = payload;
  return out;
}

function assertInert(markup: string, where: string): void {
  document.body.innerHTML = markup;
  expect(document.querySelectorAll('script').length, `${where}: script`).toBe(0);
  expect(document.querySelectorAll('img[src="x"]').length, `${where}: img`).toBe(0);
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    for (const at of Array.from(el.attributes)) {
      expect(at.name.startsWith('on'), `${where}: ${el.tagName} has ${at.name}`).toBe(false);
      expect(at.name === 'style', `${where}: style attribute`).toBe(false);
      expect(at.name === 'x' || at.name === 'x="', `${where}: injected attribute`).toBe(false);
    }
  }
}

describe('text from outside never becomes markup', () => {
  const base = createFixture('rigs-all', { clock: () => 0 }).store.snapshot(null);

  for (const payload of HOSTILE) {
    it(`addresses, hashes and names: ${payload.slice(0, 24)}`, () => {
      const snap = hostile(base, payload);
      const source: DataSource = { snapshot: () => snap, now: () => snap.now, subscribe: () => () => undefined };
      let seenText = false;
      for (const hash of allHashes('rigs-all')) {
        for (const lang of ['en', 'cn'] as const) {
          setLang(lang, false);
          const ui = freshUi();
          const route = parseHash(hash);
          const out = renderApp(makeCtx(source, ui, route, false));
          const markup = out.screen.value + (out.modal?.value ?? '');
          assertInert(markup, `${hash} ${lang}`);
          if (document.body.textContent?.includes(payload.slice(0, 12))) seenText = true;
        }
      }
      expect(seenText, 'the payload is shown as plain text somewhere').toBe(true);
    });
  }

  it('rig ids, in cards, loans, steps and links', () => {
    for (const payload of HOSTILE) {
      const snap = structuredClone(base);
      const bad = (n: number): number => `${payload}~${n}` as unknown as number;
      for (const r of snap.rigs) {
        r.id = bad(r.id);
        r.facts.id = r.id;
      }
      for (const l of snap.loans) {
        l.rigIds = l.rigIds.map(bad);
        l.collateral.forEach((c) => (c.id = bad(c.id)));
        if (l.impairedRig !== null) l.impairedRig = bad(l.impairedRig);
      }
      for (const a of snap.agents) {
        a.collateral = a.collateral.map(bad);
        a.loose = a.loose.map(bad);
      }
      const source: DataSource = { snapshot: () => snap, now: () => snap.now, subscribe: () => () => undefined };
      for (const hash of ['#/app', '#/app/rigs', '#/app/rigs/group']) {
        for (const lang of ['en', 'cn'] as const) {
          setLang(lang, false);
          const out = renderApp(makeCtx(source, freshUi(), parseHash(hash), false));
          assertInert(out.screen.value, `ids ${hash} ${lang}`);
        }
      }
      // a rig page for each of them, as if the router had let the id through
      for (const r of snap.rigs.slice(0, 9)) {
        const ui = freshUi();
        ui.sel = [r.id];
        const route = { ...parseHash('#/app/rigs/1'), id: r.id };
        for (const modal of [null, 'repay', 'screen'] as const) {
          const out = renderApp(makeCtx(source, ui, { ...route, modal }, false));
          assertInert(out.screen.value + (out.modal?.value ?? ''), `rig page ${modal}`);
        }
      }
    }
  });

  it('error text and keeper reasons, in the notice at the top of a page', () => {
    for (const payload of HOSTILE) {
      const f = createFixture('connected', { clock: () => 0 });
      const ui = freshUi();
      ui.sel = [4127]; // a rig page keeps the error of its own flow
      for (const error of [
        { kind: 'unknown', details: payload } as const,
        { kind: 'keeper', reason: payload } as const,
        { kind: 'revert', name: payload } as const,
      ]) {
        ui.error = error;
        for (const lang of ['en', 'cn'] as const) {
          setLang(lang, false);
          const out = renderApp(makeCtx(f.store, ui, parseHash('#/app/rigs/4127'), false));
          assertInert(out.screen.value, `${error.kind} ${lang}`);
          if (error.kind !== 'revert') expect(document.body.textContent).toContain(payload.slice(0, 10));
        }
      }
    }
  });

  it('an address in the read-only view', () => {
    const f = createFixture('connected', { clock: () => 0 });
    for (const payload of HOSTILE) {
      const route = { ...parseHash('#/app/rigs'), view: payload as Address };
      const out = renderApp(makeCtx(f.store, freshUi(), route, false));
      assertInert(out.screen.value, `view ${payload}`);
    }
  });
});
