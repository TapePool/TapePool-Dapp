// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPIED_MS, createApp, type App } from '../src/app';
import { makeCtx } from '../src/ctx';
import { createFixture, FIXTURES } from '../src/fixtures/catalog';
import { setLang } from '../src/i18n';
import type { ClipboardLike } from '../src/clipboard';
import type { AppError } from '../src/chain/errors';
import type { Address, Snapshot, WalletOption } from '../src/model';
import { renderApp } from '../src/render';
import { parseHash } from '../src/route';
import type { ActionResult, Actions } from '../src/source';
import { freshUi } from '../src/state';
import binanceLogo from '../src/assets/wallets/binance.svg';
import metamaskLogo from '../src/assets/wallets/metamask.svg';
import okxLogo from '../src/assets/wallets/okx.svg';
import rabbyLogo from '../src/assets/wallets/rabby.svg';
import trustLogo from '../src/assets/wallets/trust.svg';

/**
 * The connect dialog and the menu on the wallet pill, driven the way a person does it: through the buttons of the page.
 */

type Override = Partial<Record<keyof Actions, (...a: never[]) => unknown>>;

interface Mounted {
  app: App;
  store: ReturnType<typeof createFixture>['store'];
  calls: string[];
  copied: string[];
  toast(): string;
}

let current: App | null = null;

async function mount(name: string, hash: string, o: { inFrame?: boolean; actions?: Override; clipboard?: ClipboardLike | null } = {}): Promise<Mounted> {
  document.body.innerHTML =
    '<div id="tp-app"><div id="tp-screen"></div><div id="tp-mdl" class="mdl-back" hidden><div id="tp-mdl-box"></div></div></div><div id="tp-toast" class="tp-toast"></div>';
  window.location.hash = hash;
  const f = createFixture(name, { clock: () => 0, reportDelayMs: 0 });
  const calls: string[] = [];
  const copied: string[] = [];
  const actions = new Proxy(f.store as unknown as Record<string, unknown>, {
    get(target, key: string) {
      const v = Reflect.get(target, key);
      const own = o.actions?.[key as keyof Actions];
      if (own) {
        return async (...a: unknown[]) => {
          calls.push(`${key}${a.length ? `(${a.map(String).join(',')})` : ''}`);
          return (own as (...x: unknown[]) => unknown)(...a);
        };
      }
      if (typeof v !== 'function') return v;
      return async (...a: unknown[]) => {
        calls.push(`${key}${a.length ? `(${a.map(String).join(',')})` : ''}`);
        return (v as (...x: unknown[]) => unknown).apply(target, a);
      };
    },
  }) as unknown as Actions;
  const app = createApp({
    screen: document.getElementById('tp-screen') as HTMLElement,
    modal: document.getElementById('tp-mdl') as HTMLElement,
    modalBox: document.getElementById('tp-mdl-box') as HTMLElement,
    toast: document.getElementById('tp-toast') as HTMLElement,
    source: f.store,
    actions,
    ui: f.ui,
    inFrame: o.inFrame ?? false,
    win: window,
    clipboard: o.clipboard === null ? undefined : (o.clipboard ?? { writeText: async (text) => void copied.push(text) }),
  });
  current = app;
  await tick(); // the hash set above fires its hashchange now, not in the middle of the test
  return { app, store: f.store, calls, copied, toast: () => document.getElementById('tp-toast')?.textContent ?? '' };
}

// what the clipboard tests replace on the page, put back after each test so no test depends on the order they run in
let savedExec: typeof document.execCommand;
let savedClipboard: PropertyDescriptor | undefined;
beforeEach(() => {
  setLang('en', false);
  savedExec = document.execCommand;
  savedClipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
});
afterEach(() => {
  current?.destroy();
  current = null;
  document.body.innerHTML = '';
  document.execCommand = savedExec;
  if (savedClipboard) Object.defineProperty(window.navigator, 'clipboard', savedClipboard);
  else delete (window.navigator as { clipboard?: unknown }).clipboard;
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const q = <T extends HTMLElement = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const click = (sel: string): void => {
  const el = q(sel);
  if (!el) throw new Error(`no ${sel}`);
  el.click();
};
const key = (k: string, init: KeyboardEventInit = {}): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
};
const dialog = (): HTMLElement | null => q('[role="dialog"]');



const names = (root: ParentNode, sel: string): (string | null | undefined)[] => [...root.querySelectorAll(sel)].map((n) => n.textContent);
const rowsOf = (d: ParentNode): HTMLElement[] => [...d.querySelectorAll<HTMLElement>('button[data-a="pick-wallet"].wopt')];
const viewOf = (): string | null | undefined => dialog()?.getAttribute('data-view');
const OFFICIAL: Record<string, string> = {
  'Binance Wallet': 'https://www.binance.com/en/web3wallet',
  'Trust Wallet': 'https://trustwallet.com/download',
  'Rabby Wallet': 'https://rabby.io/',
  MetaMask: 'https://metamask.io/download/',
  'OKX Wallet': 'https://web3.okx.com/download',
};

describe('the Connect wallet button opens a wallet picker', () => {
  it('draws a modal dialog, moves the focus into it, and lists the wallets found in two groups', async () => {
    const m = await mount('disconnected', '#/app/markets');
    const trigger = q('[data-a="connect"]') as HTMLElement;
    trigger.focus();
    expect(dialog()).toBeNull();
    trigger.click();
    const d = dialog() as HTMLElement;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.getAttribute('aria-labelledby')).toBe('mdl-t');
    expect(q('#mdl-t')?.textContent).toBe('Connect a Wallet');
    expect(d.contains(document.activeElement)).toBe(true);
    expect(q('#tp-mdl')?.hidden).toBe(false);
    expect(q('#tp-mdl-box')?.classList.contains('wide')).toBe(true);
    // Installed: what was found, the one used last first, with "Recent" under its name
    expect(names(d, '.wlab')).toEqual(['Installed', 'Recommended']);
    const rows = rowsOf(d);
    expect(rows.map((r) => r.querySelector('.wn')?.textContent)).toEqual(['MetaMask', 'OKX Wallet']);
    expect(rows[0]?.querySelector('.wcol .wtag')?.textContent).toBe('Recent');
    expect(rows[0]?.querySelector('.wtag')?.previousElementSibling?.className).toBe('wn'); // under the name, not a pill beside it
    expect(rows[1]?.querySelector('.wtag')).toBeNull();
    // the wallet's own icon when it announced a usable one, else the logo that ships with the app for a known wallet
    expect(rows[0]?.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(rows[1]?.querySelector('img')?.getAttribute('src')).toBe(okxLogo);
    // Recommended: the ones that are not installed, in the order of the design, each opening its own "Get" panel
    const rec = [...d.querySelectorAll<HTMLElement>('button[data-a="picker-get"].wopt')];
    expect(rec.map((r) => [r.querySelector('.wn')?.textContent, r.getAttribute('data-v')])).toEqual([
      ['Binance Wallet', 'binance'],
      ['Trust Wallet', 'trust'],
      ['Rabby Wallet', 'rabby'],
    ]);
    expect(rec.map((r) => r.querySelector('img')?.getAttribute('src'))).toEqual([binanceLogo, trustLogo, rabbyLogo]);
    // the intro: "What is a Wallet?", two items with an illustration, the Get a Wallet button and the Learn More link
    expect(viewOf()).toBe('about');
    expect(d.querySelector('.wv-h')?.textContent).toBe('What is a Wallet?');
    expect(d.querySelectorAll('.wv-item')).toHaveLength(2);
    for (const item of d.querySelectorAll('.wv-item')) {
      expect(item.querySelector('img.wv-illu')?.getAttribute('src')).toMatch(/\.svg|^data:image\/svg/);
      expect(item.querySelector('b')?.textContent?.length).toBeGreaterThan(5);
      expect(item.querySelector('p')?.textContent?.length).toBeGreaterThan(20);
    }
    expect(d.textContent).toContain('A home for your BEM, OKB and RIG vouchers');
    expect(d.textContent).toContain('It signs every transaction');
    expect(d.textContent).toContain('TapePool never sees your keys');
    expect(d.querySelector('button.wv-btn[data-a="picker-get"]')?.textContent).toBe('Get a Wallet');
    const learn = d.querySelector('a.wv-link') as HTMLAnchorElement;
    expect(learn.getAttribute('href')).toBe('https://ethereum.org/en/wallets/');
    expect(learn.getAttribute('target')).toBe('_blank');
    expect(learn.getAttribute('rel')).toBe('noopener noreferrer');
    expect(learn.textContent).toContain('Learn More');
    expect(d.textContent).not.toContain('X Layer (chain 196)');
    expect(d.textContent).not.toContain('On a phone');
    // WalletConnect is not offered
    expect(d.textContent).not.toMatch(/walletconnect/i);
    // opening it connected nothing and sent nothing to the wallet
    expect(m.calls).toEqual([]);
    expect(m.store.snapshot(null).wallet.status).toBe('disconnected');
  });

  it('asks the source to look again for a wallet that announces itself late, each time it opens', async () => {
    const m = await mount('disconnected', '#/app/markets', { actions: { rescanWallets: async () => undefined } });
    click('[data-a="connect"]');
    key('Escape');
    click('[data-a="connect"]');
    expect(m.calls).toEqual(['rescanWallets', 'rescanWallets']);
  });

  it('is also the Connect wallet button of the gate, and works on any page without leaving it', async () => {
    await mount('disconnected', '#/app/rigs');
    click('.v2-connect [data-a="connect"]');
    expect(dialog()).not.toBeNull();
    key('Escape');
    expect(dialog()).toBeNull();
    expect(window.location.hash).toBe('#/app/rigs');
  });

  it('in Chinese', async () => {
    setLang('cn', false);
    await mount('disconnected', '#/app/markets');
    click('[data-a="connect"]');
    const text = dialog()?.textContent ?? '';
    for (const word of ['连接钱包', '已安装', '最近使用', '推荐', '什么是钱包？', '获取钱包', '了解更多', '存放 BEM、OKB 和 RIG 凭证的地方', '每笔交易都由它签名']) expect(text).toContain(word);
    expect(dialog()?.querySelector('[data-a="picker-close"]')?.getAttribute('aria-label')).toBe('关闭');
  });

  it('closes with Escape, the close button and a click on the backdrop, and gives the focus back', async () => {
    await mount('disconnected', '#/app/markets');
    const trigger = q('[data-a="connect"]') as HTMLElement;
    for (const close of [() => key('Escape'), () => click('[data-a="picker-close"]'), () => (q('#tp-mdl') as HTMLElement).click()]) {
      trigger.focus();
      trigger.click();
      expect(dialog()).not.toBeNull();
      close();
      expect(dialog()).toBeNull();
      expect(q('#tp-mdl')?.hidden).toBe(true);
      expect(document.activeElement).toBe(q('[data-a="connect"]'));
      expect(window.location.hash).toBe('#/app/markets'); // closing a route modal navigates; this one does not
    }
  });

  it('a click inside the dialog does not close it', async () => {
    await mount('disconnected', '#/app/markets');
    click('[data-a="connect"]');
    (q('.wr') as HTMLElement).click();
    (q('.mdl-wallet') as HTMLElement).click();
    expect(dialog()).not.toBeNull();
  });

  it('keeps Tab inside the dialog', async () => {
    await mount('disconnected', '#/app/markets');
    click('[data-a="connect"]');
    const all = [...document.querySelectorAll<HTMLElement>('#tp-mdl-box button:not([disabled]), #tp-mdl-box a[href], #tp-mdl-box summary')];
    expect(all.length).toBeGreaterThanOrEqual(9); // close, back, two wallets, three recommended, Get a Wallet, Learn More
    (all[all.length - 1] as HTMLElement).focus();
    key('Tab');
    expect(document.activeElement).toBe(all[0]);
    (all[0] as HTMLElement).focus();
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(all[all.length - 1]);
    // from the dialog itself, Shift+Tab goes to the last control
    (dialog() as HTMLElement).focus();
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(all[all.length - 1]);
  });

  it('keeps Tab to the controls on screen when the phone layout hides a column', async () => {
    await mount('disconnected', '#/app/markets');
    click('[data-a="connect"]');
    const all = [...document.querySelectorAll<HTMLElement>('#tp-mdl-box button:not([disabled]), #tp-mdl-box a[href], #tp-mdl-box summary')];
    // a page has layout: only the list side and the close button have a box; the right column and the back arrow do not
    const hidden = new Set(all.filter((el) => el.closest('.wr') !== null));
    for (const el of all) el.getClientRects = () => (hidden.has(el) ? ([] as unknown as DOMRectList) : ([{}] as unknown as DOMRectList));
    const shown = all.filter((el) => !hidden.has(el));
    (shown[shown.length - 1] as HTMLElement).focus();
    key('Tab');
    expect(document.activeElement).toBe(shown[0]);
    (shown[0] as HTMLElement).focus();
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(shown[shown.length - 1]);
  });

  it('every row is a real button', async () => {
    await mount('disconnected', '#/app/markets');
    click('[data-a="connect"]');
    const opts = [...document.querySelectorAll('.wopt')];
    expect(opts.length).toBe(5);
    for (const o of opts) expect(o.tagName).toBe('BUTTON');
  });
});

describe('the right column', () => {
  it('"Get a Wallet" lists the five wallets in the order of the design, each with a Get link to its official page, and back returns', async () => {
    await mount('disconnected', '#/app/markets');
    click('[data-a="connect"]');
    click('button.wv-btn[data-a="picker-get"]');
    const d = dialog() as HTMLElement;
    expect(viewOf()).toBe('get');
    expect(d.querySelector('.wv-h')?.textContent).toBe('Get a Wallet');
    const rows = [...d.querySelectorAll('.wv-row')];
    expect(rows.map((r) => r.querySelector('.wv-name')?.textContent)).toEqual(['Binance Wallet', 'Trust Wallet', 'Rabby Wallet', 'MetaMask', 'OKX Wallet']);
    for (const r of rows) {
      const name = r.querySelector('.wv-name')?.textContent ?? '';
      const link = r.querySelector('a') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe(OFFICIAL[name]);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.textContent).toContain('Get');
      expect(r.querySelector('img')?.getAttribute('alt')).toBe('');
    }
    expect(d.textContent).toContain('Install one, then reload this page.');
    click('[data-a="picker-back"]');
    expect(viewOf()).toBe('about');
    expect(d.querySelector('.wv-h')?.textContent).toBe('What is a Wallet?');
  });

  it('a wallet that is not installed opens "Get <wallet>" with its logo and a Get button to its official page', async () => {
    const m = await mount('disconnected', '#/app/markets');
    click('[data-a="connect"]');
    click('[data-a="picker-get"][data-v="binance"]');
    expect(viewOf()).toBe('get');
    const d = dialog() as HTMLElement;
    expect(d.querySelector('.wv-h')?.textContent).toBe('Get Binance Wallet');
    expect(d.querySelector('.wr img')?.getAttribute('src')).toBe(binanceLogo);
    const link = d.querySelector('.wr a.wv-btn') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://www.binance.com/en/web3wallet');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toContain('Get');
    expect(d.querySelector('[data-a="picker-get"][data-v="binance"]')?.getAttribute('aria-current')).toBe('true');
    expect(m.calls).toEqual([]); // nothing was asked of any wallet
    click('[data-a="picker-back"]');
    expect(viewOf()).toBe('about');
    expect(d.querySelector('[aria-current="true"]')).toBeNull();
  });

  it('only a recommended wallet key opens a panel: anything else the markup says is the list', async () => {
    const m = await mount('disconnected', '#/app/markets');
    click('[data-a="connect"]');
    for (const v of ['"><img src=x>', 'constructor', '__proto__', '']) {
      await m.app.dispatch('picker-get', v);
      expect(viewOf()).toBe('get');
      expect(dialog()?.querySelector('.wv-h')?.textContent).toBe('Get a Wallet');
    }
    await m.app.dispatch('picker-get', null);
    expect(dialog()?.querySelector('.wv-h')?.textContent).toBe('Get a Wallet');
    key('Escape');
    await m.app.dispatch('picker-get', 'binance'); // no dialog open
    await m.app.dispatch('picker-back', null);
    expect(dialog()).toBeNull();
  });

  it('Get panels are in Chinese too', async () => {
    setLang('cn', false);
    await mount('disconnected', '#/app/markets');
    click('[data-a="connect"]');
    click('[data-a="picker-get"][data-v="rabby"]');
    const d = dialog() as HTMLElement;
    expect(d.textContent).toContain('获取 Rabby Wallet');
    expect(d.textContent).toContain('请从官方页面安装');
    expect(d.querySelector('.wr a.wv-btn')?.textContent).toContain('获取');
    expect(d.querySelector('[data-a="picker-back"]')?.getAttribute('aria-label')).toBe('返回');
    click('[data-a="picker-back"]');
    click('button.wv-btn[data-a="picker-get"]');
    expect(dialog()?.textContent).toContain('安装任一钱包后，请刷新本页面。');
  });

  it('moves the focus to the right column when it changes, and back to the list on back', async () => {
    await mount('disconnected', '#/app/markets');
    click('[data-a="connect"]');
    click('[data-a="picker-get"][data-v="trust"]');
    expect(document.activeElement).toBe(q('.wview'));
    click('[data-a="picker-back"]');
    expect(document.activeElement).toBe(q('.wl .wopt'));
  });
});

describe('picking a wallet', () => {
  it('connects through THAT wallet and closes the dialog', async () => {
    const m = await mount('disconnected', '#/app/rigs');
    click('[data-a="connect"]');
    const okx = rowsOf(dialog() as HTMLElement).find((b) => b.textContent?.includes('OKX Wallet')) as HTMLElement;
    okx.click();
    await tick();
    expect(m.calls).toContain('connect(sample-okx)');
    expect(m.calls.filter((c) => c.startsWith('connect'))).toEqual(['connect(sample-okx)']);
    expect(m.store.snapshot(null).wallet.status).toBe('connected');
    expect(m.store.snapshot(null).wallet.active?.name).toBe('OKX Wallet');
    expect(dialog()).toBeNull();
    expect(m.toast()).toBe('Sample wallet connected. Nothing is ever sent.');
  });

  it('shows which wallet it is waiting for on the right, and ignores a second click meanwhile', async () => {
    let release: (r: ActionResult) => void = () => undefined;
    const m = await mount('disconnected', '#/app/markets', { actions: { connect: () => new Promise<ActionResult>((r) => (release = r)) } });
    click('[data-a="connect"]');
    click('[data-v="sample-metamask"]');
    expect(viewOf()).toBe('connect');
    expect(q('.wv-conn .wv-h')?.textContent).toBe('Opening MetaMask…');
    expect(q('.wv-conn .wv-sub')?.textContent).toBe('Confirm the connection in your wallet.');
    expect(q('.wv-conn img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(q('.wv-logo')?.classList.contains('wv-busy')).toBe(true);
    expect(q('[data-v="sample-metamask"]')?.getAttribute('aria-current')).toBe('true');
    expect(document.querySelector('[data-v="sample-okx"]')?.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(q('.wview'));
    click('[data-v="sample-okx"]');
    expect(m.calls).toEqual(['connect(sample-metamask)']);
    release({ ok: true });
    await tick();
    expect(dialog()).toBeNull();
  });

  it('says so in Chinese while it waits', async () => {
    setLang('cn', false);
    await mount('disconnected', '#/app/markets', { actions: { connect: () => new Promise<ActionResult>(() => undefined) } });
    click('[data-a="connect"]');
    click('[data-v="sample-okx"]');
    expect(q('.wv-conn .wv-h')?.textContent).toBe('正在打开 OKX Wallet…');
    expect(q('.wv-conn .wv-sub')?.textContent).toBe('请在钱包中确认连接。');
  });

  it('stays open with the reason and a Retry button when the wallet says no, and the user can try the same wallet or another', async () => {
    const error: AppError = { kind: 'wallet-rejected' };
    let n = 0;
    const m = await mount('disconnected', '#/app/markets', { actions: { connect: async () => (++n === 1 ? ({ ok: false, error } as ActionResult) : ({ ok: true } as ActionResult)) } });
    click('[data-a="connect"]');
    click('[data-v="sample-okx"]');
    await tick();
    const d = dialog() as HTMLElement;
    expect(viewOf()).toBe('connect');
    expect(d.querySelector('[role="alert"]')?.textContent).toContain('You cancelled in your wallet. Nothing was sent.');
    expect(d.querySelector('.wr [role="alert"]')).not.toBeNull(); // on the right, with the wallet
    expect(d.querySelector('.wv-conn .wv-h')).toBeNull(); // no "Opening…" any more
    expect(d.querySelector('[data-v="sample-okx"].wopt')?.getAttribute('aria-disabled')).toBeNull();
    expect(m.toast()).toBe('You cancelled in your wallet. Nothing was sent.');
    // not repeated in the banner behind the dialog
    expect(q('#tp-screen')?.textContent).not.toContain('You cancelled');
    // Retry asks the same wallet again
    const retry = d.querySelector('button.wv-btn[data-a="pick-wallet"]') as HTMLElement;
    expect(retry.textContent).toBe('Retry');
    expect(retry.getAttribute('data-v')).toBe('sample-okx');
    retry.click();
    await tick();
    expect(m.calls.filter((c) => c.startsWith('connect'))).toEqual(['connect(sample-okx)', 'connect(sample-okx)']);
    expect(dialog()).toBeNull();
  });

  it('another wallet can be tried after a failure, and the reason of the first is gone', async () => {
    let n = 0;
    const m = await mount('disconnected', '#/app/markets', { actions: { connect: async () => (++n === 1 ? ({ ok: false, error: { kind: 'wallet-rejected' } } as ActionResult) : ({ ok: true } as ActionResult)) } });
    click('[data-a="connect"]');
    click('[data-v="sample-okx"]');
    await tick();
    expect(q('[role="alert"]')).not.toBeNull();
    click('[data-v="sample-metamask"].wopt');
    expect(q('[role="alert"]')).toBeNull();
    await tick();
    expect(m.calls.filter((c) => c.startsWith('connect'))).toEqual(['connect(sample-okx)', 'connect(sample-metamask)']);
    expect(dialog()).toBeNull();
  });

  it('keeps the reason when the reader moved to another panel while the wallet was asking', async () => {
    let fail: (r: ActionResult) => void = () => undefined;
    await mount('disconnected', '#/app/markets', { actions: { connect: () => new Promise<ActionResult>((r) => (fail = r)) } });
    click('[data-a="connect"]');
    click('[data-v="sample-okx"].wopt');
    click('[data-a="picker-get"][data-v="binance"]');
    expect(viewOf()).toBe('get');
    fail({ ok: false, error: { kind: 'wallet-rejected' } });
    await tick();
    // not on the wallet's panel (the reader left it), but never dropped: a line above the panel that is open
    expect(viewOf()).toBe('get');
    expect(dialog()?.querySelector('.wr [role="alert"]')?.textContent).toContain('You cancelled in your wallet. Nothing was sent.');
    expect(dialog()?.querySelector('.wv-h')?.textContent).toBe('Get Binance Wallet');
  });

  it('shows the Chinese line, and the wallet\'s own words under Details, for a wallet that cannot go to X Layer', async () => {
    setLang('cn', false);
    await mount('disconnected', '#/app/markets', {
      actions: { connect: async () => ({ ok: false, error: { kind: 'wallet-no-xlayer', details: 'Unrecognized chain ID "0xc4"' } }) },
    });
    click('[data-a="connect"]');
    click('[data-v="sample-okx"]');
    await tick();
    const alert = q('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('该钱包无法切换到 X Layer。请改用 OKX Wallet、MetaMask 或 Rabby。');
    expect(alert.querySelector('pre')?.textContent).toBe('Unrecognized chain ID "0xc4"');
    expect(q('button.wv-btn[data-a="pick-wallet"]')?.textContent).toBe('重试');
  });

  it('refuses an id the dialog does not list (the markup could be forged)', async () => {
    const m = await mount('disconnected', '#/app/markets');
    await m.app.dispatch('pick-wallet', 'sample-okx'); // no dialog open
    click('[data-a="connect"]');
    await m.app.dispatch('pick-wallet', '"><img src=x>');
    await m.app.dispatch('pick-wallet', null);
    expect(m.calls).toEqual([]);
    expect(m.store.snapshot(null).wallet.status).toBe('disconnected');
    expect(viewOf()).toBe('about');
  });

  it('closes by itself when the wallet connects some other way while it is open', async () => {
    const m = await mount('disconnected', '#/app/markets');
    click('[data-a="connect"]');
    expect(dialog()).not.toBeNull();
    void m.store.connect('sample-okx');
    expect(dialog()).toBeNull();
  });

  it('a wallet that cannot go to X Layer: the clear line, in both languages, and the page stays on the wrong-network state', async () => {
    const error: AppError = { kind: 'wallet-no-xlayer', details: 'Adding this network is not supported' };
    const m = await mount('wrong-network', '#/app/rigs', { actions: { switchNetwork: async () => ({ ok: false, error }) as ActionResult } });
    click('.v2-hd [data-a="switchnet"]');
    await tick();
    expect(m.calls).toEqual(['switchNetwork']);
    expect(q('#tp-screen')?.textContent).toContain('This wallet cannot switch to X Layer. Try OKX Wallet, MetaMask or Rabby.');
    expect(q('.det pre')?.textContent).toBe('Adding this network is not supported');
    expect(m.toast()).toBe('This wallet cannot switch to X Layer. Try OKX Wallet, MetaMask or Rabby.');
    expect(m.store.snapshot(null).wallet.status).toBe('wrong-network');
    expect(q('[data-a="create"], [data-a="borrow"], [data-a="supply"]')).toBeNull();
    setLang('cn', false);
    m.app.render();
    expect(q('#tp-screen')?.textContent).toContain('该钱包无法切换到 X Layer。请改用 OKX Wallet、MetaMask 或 Rabby。');
  });

  it('a user rejection of the switch is the cancelled line', async () => {
    const m = await mount('wrong-network', '#/app/rigs', { actions: { switchNetwork: async () => ({ ok: false, error: { kind: 'wallet-rejected' } }) as ActionResult } });
    click('.v2-hd [data-a="switchnet"]');
    await tick();
    expect(q('#tp-screen')?.textContent).toContain('You cancelled in your wallet. Nothing was sent.');
    expect(m.toast()).toBe('You cancelled in your wallet. Nothing was sent.');
  });
});

describe('when there is nothing to pick', () => {
  it('says no wallet was found, and offers all five to get, in the order of the design', async () => {
    await mount('picker-none', '#/app/markets');
    const d = dialog() as HTMLElement;
    expect(d.textContent).toContain('No wallet found in this browser.');
    expect(d.querySelectorAll('button[data-a="pick-wallet"]')).toHaveLength(0);
    expect(names(d, '.wlab')).toEqual(['Recommended']);
    expect(names(d, '[data-a="picker-get"].wopt .wn')).toEqual(['Binance Wallet', 'Trust Wallet', 'Rabby Wallet', 'MetaMask', 'OKX Wallet']);
  });

  it('shows the plain window.ethereum as "Browser wallet" and still recommends all five', async () => {
    await mount('picker-fallback', '#/app');
    const rows = names(document, 'button[data-a="pick-wallet"] .wn');
    expect(rows).toEqual(['Browser wallet']);
    expect(document.querySelectorAll('[data-a="picker-get"].wopt')).toHaveLength(5);
    // it has no icon and no name of its own to trust: a letter badge
    expect(document.querySelector('button[data-a="pick-wallet"] .wic')?.textContent).toBe('B');
  });

  it('is never opened inside another site', async () => {
    const m = await mount('disconnected', '#/app/markets', { inFrame: true });
    expect(q('[data-a="connect"]')).toBeNull();
    for (const a of ['connect', 'pick-wallet', 'picker-close', 'picker-get', 'picker-back', 'menu', 'copy-addr']) await m.app.dispatch(a, 'sample-okx');
    expect(dialog()).toBeNull();
    expect(m.calls).toEqual([]);
  });
});

describe('the fixtures of the other panels', () => {
  it('connecting: the wallet being asked, busy', async () => {
    await mount('picker-connecting', '#/app');
    expect(viewOf()).toBe('connect');
    expect(q('.wv-h')?.textContent).toBe('Opening MetaMask…');
    expect(q('.wv-logo')?.classList.contains('wv-busy')).toBe(true);
  });

  it('error: the reason and Retry on the wallet that failed', async () => {
    await mount('picker-error', '#/app');
    expect(viewOf()).toBe('connect');
    expect(q('[role="alert"]')?.textContent).toContain('This wallet cannot switch to X Layer');
    expect(q('button.wv-btn[data-a="pick-wallet"]')?.getAttribute('data-v')).toBe('sample-okx');
  });

  it('a panel for a wallet that is no longer there is the intro', () => {
    const f = createFixture('picker-connecting', { clock: () => 0 });
    f.ui.picker = { busy: null, error: null, view: { kind: 'connect', id: 'gone' } };
    const out = renderApp(makeCtx(f.store, f.ui, parseHash('#/app'), false));
    expect(out.modal?.value).toContain('data-view="about"');
    expect(out.modal?.value).toContain('What is a Wallet?');
  });
});

describe('the menu on the wallet pill', () => {
  const account = (m: Mounted): Address => m.store.snapshot(null).wallet.account as Address;
  const short = (a: string): string => `${a.slice(0, 6)}....${a.slice(-6)}`;

  it('shows a person icon on the pill, not a coloured circle', async () => {
    await mount('menu', '#/app');
    const pill = q('[data-a="menu"]') as HTMLElement;
    expect(pill.querySelector('.uav svg')).not.toBeNull();
    expect(pill.querySelector('.avatar')).toBeNull();
    expect(q('.v2-hd .avatar')).toBeNull();
  });

  it('opens on a click with the wallet, the short address on one line, copy, explorer and disconnect', async () => {
    const m = await mount('menu', '#/app');
    // the fixture starts with it open; close and open it again through the pill
    click('[data-a="menu"]');
    expect(q('.acct-menu')).toBeNull();
    const pill = q('[data-a="menu"]') as HTMLElement;
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    pill.click();
    expect(pill.getAttribute('aria-expanded')).toBe('true');
    expect(pill.getAttribute('aria-controls')).toBe('acct-menu');
    const menu = q('#acct-menu') as HTMLElement;
    expect(menu.querySelector('.acct-id b')?.textContent).toBe('MetaMask');
    expect(menu.querySelector('.acct-id img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    // first six characters, four dots, last six; the whole address is the tooltip and what a screen reader reads
    const addr = menu.querySelector('.acct-addr') as HTMLElement;
    expect(addr.textContent).toBe(short(account(m)));
    expect(addr.textContent).toMatch(/^0x[0-9a-fA-F]{4}\.{4}[0-9a-fA-F]{6}$/);
    expect(addr.getAttribute('title')).toBe(account(m));
    expect(addr.classList.contains('mono')).toBe(true);
    expect(menu.querySelector('.acct-ar > .sr')?.textContent).toBe(account(m));
    expect(addr.textContent).not.toContain(account(m).slice(6, -6)); // the middle of the address is not drawn (only read out)
    // the copy button is an icon with a label
    const copy = menu.querySelector('[data-a="copy-addr"]') as HTMLElement;
    expect(copy.tagName).toBe('BUTTON');
    expect(copy.getAttribute('aria-label')).toBe('Copy address');
    expect(copy.querySelector('svg')).not.toBeNull();
    expect(copy.textContent).toBe('');
    expect(addr.nextElementSibling?.nextElementSibling).toBe(copy);
    const link = menu.querySelector('a') as HTMLAnchorElement;
    expect(link.textContent).toBe('View on explorer');
    expect(link.getAttribute('href')).toBe(`https://www.oklink.com/xlayer/address/${account(m)}`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(menu.querySelector('[data-a="disconnect"]')?.textContent).toBe('Disconnect');
  });

  it('copies the full address and says "Copied!" beside the icon, in both languages', async () => {
    const m = await mount('menu', '#/app');
    const bubble = (): string => q('.acct-copied')?.textContent ?? '';
    expect(q('.acct-copied')?.getAttribute('aria-live')).toBe('polite'); // present before it speaks, so the change is announced
    expect(bubble()).toBe('');
    click('[data-a="copy-addr"]');
    await tick();
    expect(m.copied).toEqual([account(m)]);
    expect(bubble()).toBe('Copied!');
    expect(m.toast()).toBe(''); // the bubble says it, not the toast
    setLang('cn', false);
    m.app.render();
    expect(bubble()).toBe('已复制');
    click('[data-a="copy-addr"]');
    await tick();
    expect(m.copied).toEqual([account(m), account(m)]);
    expect(m.calls).toEqual([]); // nothing reached the wallet or the chain
  });

  it('takes the bubble down after a moment, and starts again from the last click', async () => {
    const m = await mount('menu', '#/app');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const bubble = (): string => q('.acct-copied')?.textContent ?? '';
      click('[data-a="copy-addr"]');
      await vi.advanceTimersByTimeAsync(0);
      expect(bubble()).toBe('Copied!');
      await vi.advanceTimersByTimeAsync(COPIED_MS - 100);
      click('[data-a="copy-addr"]'); // a second click restarts the clock
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(COPIED_MS - 100);
      expect(bubble()).toBe('Copied!');
      await vi.advanceTimersByTimeAsync(100);
      expect(bubble()).toBe('');
      expect(m.copied).toHaveLength(2);
      expect(m.app.ui.copied).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets the bubble when the menu closes, and leaves no timer behind', async () => {
    const m = await mount('menu', '#/app');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      click('[data-a="copy-addr"]');
      await vi.advanceTimersByTimeAsync(0);
      expect(m.app.ui.copied).toBe('ok');
      key('Escape');
      expect(q('.acct-menu')).toBeNull();
      expect(m.app.ui.copied).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      click('[data-a="menu"]');
      expect(q('.acct-copied')?.textContent).toBe('');
      click('[data-a="copy-addr"]');
      await vi.advanceTimersByTimeAsync(0);
      m.app.destroy();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the old way when the clipboard API is missing or refuses', async () => {
    const m = await mount('menu', '#/app', {
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    });
    let commands = 0;
    document.execCommand = ((c: string) => (c === 'copy' ? (commands++, true) : false)) as typeof document.execCommand;
    click('[data-a="copy-addr"]');
    await tick();
    expect(commands).toBe(1);
    expect(q('.acct-copied')?.textContent).toBe('Copied!');
    expect(m.app.ui.copied).toBe('ok');
    expect(document.querySelector('.copy-field')).toBeNull(); // the throw-away field is gone
  });

  it('says so, and shows the whole address to select, when nothing can copy', async () => {
    // an app made without a clipboard, in a browser that has none either
    const m = await mount('menu', '#/app', { clipboard: null });
    Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true });
    document.execCommand = (() => false) as typeof document.execCommand;
    expect(q('.acct-full')).toBeNull();
    click('[data-a="copy-addr"]');
    await tick();
    expect(m.toast()).toBe('Could not copy. Select the address and copy it by hand.');
    expect(q('.acct-copied')?.textContent).toBe('');
    expect(q('.acct-full')?.textContent).toBe(account(m)); // the full address on screen to select
  });

  it('disconnects, and the menu closes with it', async () => {
    const m = await mount('menu', '#/app');
    click('[data-a="disconnect"]');
    await tick();
    expect(m.calls).toEqual(['disconnect']);
    expect(m.store.snapshot(null).wallet.status).toBe('disconnected');
    expect(q('.acct-menu')).toBeNull();
    expect(q('[data-a="connect"]')).not.toBeNull();
  });

  it('closes on Escape and gives the focus back to the pill', async () => {
    await mount('menu', '#/app');
    (q('.acct-acts button') as HTMLElement).focus();
    key('Escape');
    expect(q('.acct-menu')).toBeNull();
    expect(document.activeElement).toBe(q('[data-a="menu"]'));
  });

  it('closes on a click anywhere else, and that click still does its job', async () => {
    await mount('menu', '#/app');
    click('.v2-nav a[href$="/rigs"]');
    expect(q('.acct-menu')).toBeNull();
    await tick(); // the hash change of that click is handled now, not in the middle of the rest
    // a click inside the menu does not close it
    click('[data-a="menu"]');
    expect(q('.acct-menu')).not.toBeNull();
    (q('.acct-addr') as HTMLElement).click();
    expect(q('.acct-menu')).not.toBeNull();
    click('[data-a="copy-addr"]');
    await tick();
    expect(q('.acct-menu')).not.toBeNull(); // copying does not close it either
  });

  it('is reachable with the keyboard: a button, then the copy button, a link and a button in tab order', async () => {
    await mount('menu', '#/app');
    const pill = q('[data-a="menu"]') as HTMLElement;
    expect(pill.tagName).toBe('BUTTON');
    const items = [...document.querySelectorAll('.acct-menu button, .acct-menu a[href]')];
    expect(items.map((i) => i.tagName)).toEqual(['BUTTON', 'A', 'BUTTON']);
    // the menu follows the pill in the document, so Tab goes from one to the other
    expect(pill.nextElementSibling?.id).toBe('acct-menu');
    for (const i of items) expect(i.getAttribute('tabindex')).toBeNull();
  });

  it('keeps the switch-network button when the wallet is on another network, and still offers the menu', async () => {
    const m = await mount('menu-wrong-network', '#/app');
    expect(q('.v2-hd [data-a="switchnet"]')?.textContent).toBe('Wrong network');
    expect(q('.acct-menu')?.textContent).toContain('On another network');
    expect(q('.acct-id b')?.textContent).toBe('OKX Wallet');
    expect(q('.acct-id img')?.getAttribute('src')).toBe(okxLogo); // no icon announced: the logo of the wallet it says it is
    click('.v2-hd [data-a="switchnet"]');
    await tick();
    expect(m.calls).toEqual(['switchNetwork']);
  });

  it('is a plain pill with no menu in a read-only view and inside another site', async () => {
    const view = await mount('view', FIXTURES.view?.hash ?? '#/app');
    expect(q('[data-a="menu"]')).toBeNull();
    expect(q('.v2-hd .v2-pillbtn')).not.toBeNull();
    expect(q('.v2-hd .v2-pillbtn .uav')).not.toBeNull();
    view.app.destroy();
    const framed = await mount('menu', '#/app', { inFrame: true });
    expect(q('[data-a="menu"]')).toBeNull();
    expect(q('.acct-menu')).toBeNull();
    await framed.app.dispatch('menu', null);
    await framed.app.dispatch('copy-addr', null);
    expect(framed.copied).toEqual([]);
  });

  it('is closed when the wallet is no longer connected', async () => {
    const m = await mount('menu', '#/app');
    await m.store.disconnect();
    expect(q('.acct-menu')).toBeNull();
    await m.app.dispatch('menu', null); // nothing to open any more
    expect(q('.acct-menu')).toBeNull();
  });

  it('closes when the page changes', async () => {
    await mount('menu', '#/app');
    expect(q('.acct-menu')).not.toBeNull();
    window.location.hash = '#/app/markets';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(q('.acct-menu')).toBeNull();
  });
});

describe('text from a wallet never becomes markup', () => {
  const HOSTILE = ['<img src=x onerror=alert(1)>', '"><script>alert(2)</script>', `" onmouseover="alert(3)" x="`, `' onfocus='alert(4)`, 'a&b&amp;c&#x3C;'];
  const BAD_ICONS = ['javascript:alert(1)', 'https://example.com/i.png', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png;base64,AAAA" onerror="alert(1)', 'data:image/svg+xml,%3Csvg onload=alert(1)%3E'];

  function render(payload: string, icon: string, state: { picker?: boolean; menu?: boolean }, over: Partial<WalletOption> = {}): string {
    const base = createFixture('connected', { clock: () => 0 }).store.snapshot(null);
    const hostile: WalletOption = { id: 'h1', name: payload, icon, rdns: payload, fallback: false, ...over };
    const snap: Snapshot = {
      ...base,
      wallet: { ...base.wallet, status: state.picker ? 'disconnected' : 'connected', options: [hostile], active: hostile, recent: payload },
    };
    const ui = freshUi();
    if (state.picker) ui.picker = { busy: null, error: null, view: { kind: 'about' } };
    if (state.menu) ui.menu = true;
    const out = renderApp(makeCtx({ snapshot: () => snap, now: () => snap.now, subscribe: () => () => undefined }, ui, parseHash('#/app'), false));
    return out.screen.value + (out.modal?.value ?? '');
  }

  for (const lang of ['en', 'cn'] as const) {
    for (const [i, payload] of HOSTILE.entries()) {
      it(`names and icons: ${lang} ${i}`, () => {
        setLang(lang, false);
        for (const state of [{ picker: true }, { menu: true }]) {
          const icon = BAD_ICONS[i] ?? BAD_ICONS[0] ?? '';
          const markup = render(payload, icon, state);
          document.body.innerHTML = markup;
          expect(document.querySelectorAll('script').length).toBe(0);
          expect(document.querySelectorAll('img[src="x"]').length).toBe(0);
          for (const el of Array.from(document.body.querySelectorAll('*'))) {
            for (const at of Array.from(el.attributes)) {
              expect(at.name.startsWith('on'), `${el.tagName} has ${at.name}`).toBe(false);
              expect(at.name === 'style' || (at.name === 'x' && !el.closest('svg')) || at.name === 'x="', `${at.name}`).toBe(false);
            }
          }
          // a rejected icon on a wallet the app does not know leaves a letter badge; the name is on the page as text
          expect(document.querySelectorAll('button[data-a="pick-wallet"] img, .acct-id img')).toHaveLength(0);
          expect(document.body.textContent).toContain(payload.slice(0, 8));
          // the id of the option is plain, whatever the wallet announced
          for (const b of document.querySelectorAll('[data-v]')) expect(b.getAttribute('data-v')).toMatch(/^[A-Za-z0-9._-]+$/);
        }
      });
    }
  }

  it('an icon that is a base64 image data URI is shown, as the src of an image and nothing else', () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    const markup = render('Wallet', icon, { picker: true });
    document.body.innerHTML = markup;
    const imgs = [...document.querySelectorAll('button[data-a="pick-wallet"] img')];
    expect(imgs).toHaveLength(1);
    expect(imgs[0]?.getAttribute('src')).toBe(icon);
    expect(imgs[0]?.getAttribute('alt')).toBe('');
  });

  it('a very long icon is dropped, and a very long name is cut', () => {
    const markup = render('N'.repeat(500), `data:image/png;base64,${'A'.repeat(300_000)}`, { picker: true });
    document.body.innerHTML = markup;
    expect(document.querySelectorAll('button[data-a="pick-wallet"] img')).toHaveLength(0);
    expect((document.querySelector('button[data-a="pick-wallet"] .wn')?.textContent ?? '').length).toBeLessThanOrEqual(32);
  });

  it('a wallet that announced a known rdns but an unusable icon gets the logo that ships with the app, never the icon it sent', () => {
    for (const [rdns, logo] of [['io.metamask', metamaskLogo], ['com.okex.wallet', okxLogo], ['io.rabby', rabbyLogo], ['com.binance.w3w', binanceLogo], ['com.trustwallet.app', trustLogo]] as const) {
      document.body.innerHTML = render('Some name', 'javascript:alert(1)', { picker: true }, { rdns });
      const img = document.querySelector('button[data-a="pick-wallet"] img');
      expect(img?.getAttribute('src'), rdns).toBe(logo);
      expect(document.body.innerHTML).not.toContain('javascript:');
    }
  });

  it('a wallet that only says in its name that it is a known wallet gets a letter badge', () => {
    document.body.innerHTML = render('MetaMask', 'https://example.com/i.png', { picker: true }, { rdns: 'evil.example' });
    expect(document.querySelector('button[data-a="pick-wallet"] img')).toBeNull();
    expect(document.querySelector('button[data-a="pick-wallet"] .wic')?.textContent).toBe('M');
  });

  it('the panels of the dialog draw a hostile name as text too', () => {
    for (const payload of HOSTILE) {
      const base = createFixture('connected', { clock: () => 0 }).store.snapshot(null);
      const hostile: WalletOption = { id: 'h1', name: payload, icon: 'javascript:alert(1)', rdns: payload, fallback: false };
      const snap: Snapshot = { ...base, wallet: { ...base.wallet, status: 'disconnected', options: [hostile], active: null, recent: null } };
      const ui = freshUi();
      ui.picker = { busy: 'h1', error: { kind: 'unknown', details: payload }, view: { kind: 'connect', id: 'h1' } };
      const out = renderApp(makeCtx({ snapshot: () => snap, now: () => snap.now, subscribe: () => () => undefined }, ui, parseHash('#/app'), false));
      document.body.innerHTML = out.modal?.value ?? '';
      expect(document.querySelectorAll('script, img[src="x"]')).toHaveLength(0);
      for (const el of Array.from(document.body.querySelectorAll('*'))) for (const at of Array.from(el.attributes)) expect(at.name.startsWith('on') || at.name === 'style', at.name).toBe(false);
      expect(document.querySelector('.wv-err b')?.textContent?.length ?? 0).toBeGreaterThan(0);
      expect(document.querySelector('.wv-err pre')?.textContent).toBe(payload);
    }
  });
});

describe('the new states', () => {
  it('carry no style attribute and no handler, in English and Chinese, as the dialog and as the menu', () => {
    const names = Object.keys(FIXTURES).filter((n) => n.startsWith('picker') || n.startsWith('menu'));
    expect(names).toEqual(expect.arrayContaining(['picker', 'picker-fallback', 'picker-none', 'picker-error', 'picker-connecting', 'picker-get', 'picker-get-wallet', 'menu', 'menu-copied', 'menu-copy-failed', 'menu-wrong-network']));
    for (const name of names) {
      for (const lang of ['en', 'cn'] as const) {
        setLang(lang, false);
        const f = createFixture(name, { clock: () => 0 });
        const out = renderApp(makeCtx(f.store, f.ui, parseHash(f.def.hash), false));
        const markup = out.screen.value + (out.modal?.value ?? '');
        expect(markup, `${name} ${lang}`).not.toMatch(/\sstyle\s*=/i);
        expect(markup, `${name} ${lang}`).not.toMatch(/\son[a-z]+\s*=/i);
        expect(markup, `${name} ${lang}`).not.toMatch(/<script/i);
        expect(out.modal !== null, `${name} ${lang}`).toBe(name.startsWith('picker'));
      }
    }
  });

  it('draw no audit wording and name no other product', () => {
    for (const name of ['picker', 'picker-error', 'picker-connecting', 'picker-get', 'picker-get-wallet', 'menu', 'menu-copied']) {
      for (const lang of ['en', 'cn'] as const) {
        setLang(lang, false);
        const f = createFixture(name, { clock: () => 0 });
        const out = renderApp(makeCtx(f.store, f.ui, parseHash(f.def.hash), false));
        const markup = out.screen.value + (out.modal?.value ?? '');
        expect(markup).not.toMatch(/audit|审计/i);
        expect(markup).not.toMatch(/walletconnect|rainbow/i);
      }
    }
  });

  it('draw every image of the dialog from the app itself or as a data URI, and every link to the pages the policy list names', () => {
    for (const name of ['picker', 'picker-get', 'picker-get-wallet', 'picker-none']) {
      const f = createFixture(name, { clock: () => 0 });
      const out = renderApp(makeCtx(f.store, f.ui, parseHash(f.def.hash), false));
      document.body.innerHTML = out.modal?.value ?? '';
      for (const img of document.querySelectorAll('img')) expect(img.getAttribute('src'), name).toMatch(/^(data:image\/|\/|\.\/|[A-Za-z0-9_-]+\/)/);
      for (const a of document.querySelectorAll('a[href]')) {
        expect(a.getAttribute('href'), name).toMatch(/^https:\/\/(web3\.okx\.com|metamask\.io|rabby\.io|www\.binance\.com|trustwallet\.com|ethereum\.org)\//);
        expect(a.getAttribute('target')).toBe('_blank');
        expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      }
    }
  });

  it('mark which column the phone layout shows', () => {
    for (const [name, view] of [['picker', 'about'], ['picker-connecting', 'connect'], ['picker-error', 'connect'], ['picker-get', 'get'], ['picker-get-wallet', 'get']] as const) {
      const f = createFixture(name, { clock: () => 0 });
      const out = renderApp(makeCtx(f.store, f.ui, parseHash(f.def.hash), false));
      expect(out.modal?.value, name).toContain(`data-view="${view}"`);
    }
  });
});
