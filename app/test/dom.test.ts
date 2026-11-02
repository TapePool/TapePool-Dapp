// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App } from '../src/app';
import { applyDynamic, morph, put } from '../src/dom';
import { createFixture } from '../src/fixtures/catalog';
import { html } from '../src/html';
import { setLang } from '../src/i18n';
import type { Actions, DataSource } from '../src/source';
import type { PrincipalQuote } from '../src/model';

function mount(name: string, hash: string, opts: { inFrame?: boolean; actions?: Actions; quoteFor?: DataSource['quoteFor'] } = {}): { app: App; store: ReturnType<typeof createFixture>['store'] } {
  document.body.innerHTML =
    '<div id="tp-app"><div id="tp-screen"></div><div id="tp-mdl" class="mdl-back" hidden><div id="tp-mdl-box"></div></div></div><div id="tp-toast" class="tp-toast"></div>';
  window.location.hash = hash;
  const f = createFixture(name, { clock: () => 0, reportDelayMs: 0 });
  const app = createApp({
    screen: document.getElementById('tp-screen') as HTMLElement,
    modal: document.getElementById('tp-mdl') as HTMLElement,
    modalBox: document.getElementById('tp-mdl-box') as HTMLElement,
    toast: document.getElementById('tp-toast') as HTMLElement,
    source: opts.quoteFor ? { now: () => f.store.now(), snapshot: (view) => ({ ...f.store.snapshot(view), principalQuotes: true }), subscribe: (listener) => f.store.subscribe(listener), quoteFor: opts.quoteFor } : f.store,
    actions: opts.actions ?? f.store,
    ui: f.ui,
    inFrame: opts.inFrame ?? false,
    win: window,
  });
  return { app, store: f.store };
}

let current: App | null = null;
beforeEach(() => setLang('en', false));
afterEach(() => {
  current?.destroy();
  current = null;
});

it('keeps the latest chosen-amount quote when an earlier request for the same amount arrives late', async () => {
  vi.useFakeTimers();
  const pending: { principal: bigint; resolve: (q: PrincipalQuote) => void }[] = [];
  try {
    const { app } = mount('flow-fresh', '#/app/rigs/4127', { quoteFor: (_agent, _term, principal) => new Promise((resolve) => pending.push({ principal, resolve })) });
    current = app;
    const type = async (value: string) => {
      const input = document.querySelector('[data-in="b.amt"]') as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(150);
    };
    await type('0.0200');
    await type('0.0300');
    await type('0.0200');
    const answer = (fee: bigint): PrincipalQuote => ({ fee, lateBps: 0, debt: 2_000_000n + fee, allowed: true, reason: 0, binding: 0 });
    pending.at(-1)!.resolve(answer(444_444n));
    await vi.advanceTimersByTimeAsync(0);
    pending[0]!.resolve(answer(111_111n));
    await vi.advanceTimersByTimeAsync(0);
    expect(app.ui.principalQuote?.value?.fee).toBe(444_444n);
    expect(app.ui.principalQuote?.principal).toBe(2_000_000n);
  } finally {
    current?.destroy(); current = null;
    vi.useRealTimers();
  }
});

describe('the DOM morph', () => {
  it('patches in place, so a node keeps its identity and a typed value survives', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    put(host, html`<p class="a">one</p><input id="i" value="x">`);
    const p = host.querySelector('p');
    const input = host.querySelector('input') as HTMLInputElement;
    input.focus();
    input.value = 'typed';
    put(host, html`<p class="b">two</p><input id="i" value="x">`);
    expect(host.querySelector('p')).toBe(p);
    expect(p?.className).toBe('b');
    expect(p?.textContent).toBe('two');
    expect(host.querySelector('input')).toBe(input);
    expect(input.value).toBe('typed'); // the focused input is not overwritten
    expect(document.activeElement).toBe(input);
  });

  it('adds, removes and replaces nodes', () => {
    const host = document.createElement('div');
    put(host, html`<ul><li>1</li><li>2</li><li>3</li></ul>`);
    put(host, html`<ul><li>1</li><span>two</span></ul>`);
    expect(host.innerHTML).toBe('<ul><li>1</li><span>two</span></ul>');
    const a = document.createElement('div');
    a.innerHTML = '<b>x</b>';
    const b = document.createElement('div');
    b.innerHTML = '<i>y</i>';
    morph(a, b);
    expect(a.innerHTML).toBe('<i>y</i>');
  });

  it('keeps a <details> as the reader left it', () => {
    const host = document.createElement('div');
    put(host, html`<details><summary>s</summary>x</details>`);
    host.querySelector('details')?.setAttribute('open', '');
    put(host, html`<details><summary>s</summary>y</details>`);
    expect(host.querySelector('details')?.hasAttribute('open')).toBe(true);
  });
});

describe('dynamic widths go through the CSSOM, never through markup', () => {
  it('writes --pct from data-pct and clears it where the markup no longer asks', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    put(host, html`<span class="bar"><span data-pct="42.5"></span></span>`);
    applyDynamic(host);
    const inner = host.querySelector('span span') as HTMLElement;
    expect(inner.style.getPropertyValue('--pct')).toBe('42.5%');
    // the same node is reused for something that has no width
    put(host, html`<span class="bar"><span></span></span>`);
    applyDynamic(host);
    expect(inner.style.getPropertyValue('--pct')).toBe('');
    expect(inner.getAttribute('style')).toBeNull();
    put(host, html`<span class="bar"><span data-pct="10.0"></span></span>`);
    applyDynamic(host);
    expect(inner.style.getPropertyValue('--pct')).toBe('10.0%');
  });

  it('survives a repaint of the whole app: the bar keeps its width without a flicker', () => {
    const { app } = mount('loan-active', '#/app/rigs/3871');
    current = app;
    const bar = () => document.querySelector('.v2-card-b .bar > span') as HTMLElement;
    const before = bar();
    expect(before.style.getPropertyValue('--pct')).toMatch(/^\d+(\.\d)?%$/);
    app.render();
    expect(bar()).toBe(before);
    expect(before.style.getPropertyValue('--pct')).toMatch(/^\d+(\.\d)?%$/);
    // no inline style attribute exists in the markup the app produces
    for (const el of Array.from(document.querySelectorAll('[style]'))) expect(el.getAttribute('style') ?? '').toMatch(/^--pct:/);
  });

  it('draws the timeline marker from the same variable', () => {
    const { app } = mount('loan-active', '#/app/rigs/3871');
    current = app;
    const now = document.querySelector('.tl-now') as HTMLElement;
    expect(now.style.getPropertyValue('--pct')).toMatch(/%$/);
  });
});

describe('the app shell', () => {
  it('opens the page of the hash and switches language on a click', () => {
    const { app } = mount('connected', '#/app/markets');
    current = app;
    expect(document.title).toBe('TapePool · Markets');
    expect(document.documentElement.lang).toBe('en');
    (document.querySelector('[data-a="lang"][data-v="cn"]') as HTMLElement).click();
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.title).toBe('TapePool · 市场');
    expect(document.querySelector('h1')?.textContent).toBe('市场');
  });

  it('types into the advance box without losing focus', () => {
    const { app } = mount('flow-fresh', '#/app/rigs/4127');
    current = app;
    const box = document.getElementById('bamt') as HTMLInputElement;
    box.focus();
    box.value = '0.5';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.getElementById('bamt')).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe('0.5');
    expect(document.body.textContent).toContain('You receive0.5000 BEM');
    box.value = '999';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelector('.err')?.textContent).toBe('Above your max for this rig and term.');
  });

  it('keeps a modal over the page and closes it with Escape', () => {
    const { app } = mount('connected', '#/app/supply');
    current = app;
    expect((document.getElementById('tp-mdl') as HTMLElement).hidden).toBe(false);
    expect(document.querySelector('.mdl h2')?.textContent).toBe('Supply BEM');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(window.location.hash).toBe('#/app');
  });

  it('redirects #/app/borrow to the Rigs page', () => {
    window.location.hash = '#/app/borrow';
    const f = createFixture('connected', { clock: () => 0 });
    document.body.innerHTML = '<div id="tp-app"><div id="tp-screen"></div><div id="tp-mdl" hidden><div id="tp-mdl-box"></div></div></div><div id="tp-toast"></div>';
    current = createApp({
      screen: document.getElementById('tp-screen') as HTMLElement,
      modal: document.getElementById('tp-mdl') as HTMLElement,
      modalBox: document.getElementById('tp-mdl-box') as HTMLElement,
      toast: document.getElementById('tp-toast') as HTMLElement,
      source: f.store,
      actions: f.store,
      ui: f.ui,
      inFrame: false,
      win: window,
    });
    expect(window.location.hash).toBe('#/app/rigs');
  });
});

/** An Actions that records what was called and never resolves anything. */
function spy(): { actions: Actions; calls: string[] } {
  const calls: string[] = [];
  const handler: ProxyHandler<object> = {
    get: (_t, name: string) => async () => {
      calls.push(name);
      return { ok: true };
    },
  };
  return { actions: new Proxy({}, handler) as Actions, calls };
}

describe('the dispatcher refuses to send whatever the markup says', () => {
  const WRITES = ['create', 'move', 'refresh', 'selfpush', 'borrow', 'approve-repay', 'repay-do', 'sweep', 'release', 'take-back', 'register', 'claim', 'approve-supply', 'supply', 'withdraw'];

  it('in a frame', async () => {
    const s = spy();
    const { app } = mount('flow-fresh', '#/app/rigs/4127', { inFrame: true, actions: s.actions });
    current = app;
    for (const a of [...WRITES, 'connect', 'disconnect', 'switchnet']) await app.dispatch(a, '4127');
    expect(s.calls).toEqual([]);
  });

  it('in a read-only view', async () => {
    const s = spy();
    const { app } = mount('flow-fresh', '#/app/view/0xde709f2102306220921060314715629080e2fb77/rigs/4127', { actions: s.actions });
    current = app;
    for (const a of WRITES) await app.dispatch(a, '4127');
    expect(s.calls).toEqual([]);
  });

  it('without a connected wallet', async () => {
    const s = spy();
    const { app } = mount('disconnected', '#/app/markets/bem', { actions: s.actions });
    current = app;
    for (const a of WRITES) await app.dispatch(a, '4127');
    expect(s.calls).toEqual([]);
  });

  it('and sends when everything is in order', async () => {
    const s = spy();
    const { app } = mount('flow-fresh', '#/app/rigs/4127', { actions: s.actions });
    current = app;
    await app.dispatch('borrow', null);
    expect(s.calls).toEqual(['borrow']);
  });

  it('never borrows while the borrow button would be off', async () => {
    const s = spy();
    const { app } = mount('flow-deny', '#/app/rigs/4127', { actions: s.actions });
    current = app;
    await app.dispatch('borrow', null);
    expect(s.calls).toEqual([]);
  });

  it('never sends a value the markup could have forged', async () => {
    const s = spy();
    const { app } = mount('connected', '#/app/rigs/3871', { actions: s.actions });
    current = app;
    await app.dispatch('claim', '<img src=x onerror=alert(1)>');
    await app.dispatch('release', '999999');
    await app.dispatch('sweep', 'abc');
    await app.dispatch('repay-do', '4127'); // not a loan
    expect(s.calls).toEqual([]);
  });
});

describe('a result that opens another page', () => {
  it('keeps its banner: the render that ends the action is already on the new page', async () => {
    const { app } = mount('flow-fresh', '#/app/rigs/4127', {
      actions: {
        ...spy().actions,
        borrow: async () => ({ ok: true, go: '/rigs/4128', flash: { kind: 'borrowed' as const, rigId: 4128, ids: [4128, 4127], amount: 1_000_000n, maturity: 1_900_000_000, opsFee: 0n } }),
      } as Actions,
    });
    current = app;
    await app.dispatch('borrow', null);
    expect(window.location.hash).toBe('#/app/rigs/4128');
    expect(document.getElementById('tp-screen')?.textContent).toContain('It is in your wallet');
  });
});
