import { describe, expect, it } from 'vitest';
import { buildOptions, cleanName, groupWallets, knownWallet, MAX_ICON, MAX_NAME, RECOMMENDED, RECOMMENDED_ORDER, recommendedByKey, safeIcon } from '../src/logic/wallets';
import type { WalletOption } from '../src/model';

const opt = (rdns: string, name = rdns, over: Partial<WalletOption> = {}): WalletOption => ({ id: rdns, name, icon: null, rdns, fallback: false, ...over });
const chr = (code: number): string => String.fromCharCode(code);

describe('an icon a wallet announced', () => {
  it('is used only as a base64 png, svg, webp or jpeg data URI', () => {
    for (const kind of ['png', 'svg+xml', 'webp', 'jpeg']) expect(safeIcon(`data:image/${kind};base64,AAAA`)).toBe(`data:image/${kind};base64,AAAA`);
    expect(safeIcon('data:image/png;base64,iVBORw0KGgo=')).not.toBeNull();
  });

  it('is dropped for anything else', () => {
    for (const bad of [
      'https://example.com/i.png',
      'http://example.com/i.png',
      '//example.com/i.png',
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/gif;base64,AAAA',
      'data:image/svg+xml,%3Csvg%3E', // not base64
      'data:image/svg+xml;utf8,<svg onload=alert(1)>',
      'data:image/png;base64,AAAA" onerror="alert(1)',
      'data:image/png;base64,AAAA\nx',
      'data:image/png;base64,',
      ' data:image/png;base64,AAAA',
      '',
      null,
      undefined,
      42,
      { toString: () => 'data:image/png;base64,AAAA' },
    ]) {
      expect(safeIcon(bad), String(bad)).toBeNull();
    }
  });

  it('is dropped when it is too large', () => {
    expect(safeIcon(`data:image/png;base64,${'A'.repeat(MAX_ICON)}`)).toBeNull();
    expect(safeIcon(`data:image/png;base64,${'A'.repeat(1_000)}`)).not.toBeNull();
  });
});

describe('a name a wallet announced', () => {
  it('is one short plain line', () => {
    expect(cleanName('MetaMask')).toBe('MetaMask');
    expect(cleanName('  Open\n\tWallet  ')).toBe('Open Wallet');
    expect(cleanName(`a${chr(0x202e)}b${chr(0x200b)}c${chr(0)}d`)).toBe('a b c d');
    expect([...cleanName('x'.repeat(100))].length).toBe(MAX_NAME);
    expect(cleanName('x'.repeat(100)).endsWith('…')).toBe(true);
    expect(cleanName('')).toBe('Wallet');
    expect(cleanName(null)).toBe('Wallet');
    expect(cleanName({})).toBe('Wallet');
    expect(cleanName(`${chr(0x200b)}${chr(0x200b)}`)).toBe('Wallet');
  });

  it('is not cut in the middle of a character', () => {
    const name = cleanName('😀'.repeat(60));
    expect([...name].length).toBe(MAX_NAME);
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe('building the options', () => {
  const raw = (uuid: unknown, rdns: unknown, name: unknown = 'W', icon: unknown = null) => ({ uuid, name, icon, rdns });

  it('gives each wallet an id that is safe in an attribute and unique', () => {
    const built = buildOptions([raw('a-1', 'x.a'), raw('a"1', 'x.b'), raw(undefined, 'x.c'), raw('a-1', 'x.d')], (r) => r);
    const ids = built.map((b) => b.option.id);
    expect(ids[0]).toBe('a-1');
    expect(ids[1]).toBe('w1');
    expect(ids[2]).toBe('w2');
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('lists a wallet once, however often it announced', () => {
    const built = buildOptions([raw('1', 'io.metamask'), raw('2', 'io.metamask'), raw('3', 'io.rabby')], (r) => r);
    expect(built.map((b) => b.option.rdns)).toEqual(['io.metamask', 'io.rabby']);
  });

  it('marks only the plain window.ethereum as the fallback, and gives it no icon', () => {
    const [fb, other] = buildOptions([raw('window.ethereum', 'window.ethereum', 'x', 'data:image/png;base64,AAAA'), raw('u', 'window.ethereum', 'x')], (r) => r);
    expect(fb?.option.fallback).toBe(true);
    expect(fb?.option.icon).toBeNull();
    expect(other).toBeUndefined(); // same rdns
  });

  it('carries the item along untouched', () => {
    const item = { provider: {} };
    const [b] = buildOptions([item], () => raw('u', 'r'));
    expect(b?.item).toBe(item);
  });
});

describe('Installed and Recommended', () => {
  it('lists every wallet found as installed, and the recommended ones that are not', () => {
    const g = groupWallets([opt('io.metamask', 'MetaMask'), opt('com.coinbase.wallet', 'Coinbase Wallet')], null);
    expect(g.installed.map((i) => i.option.name)).toEqual(['MetaMask', 'Coinbase Wallet']);
    // the order of the screenshot, not the ranking of the installed group
    expect(g.recommended.map((r) => r.name)).toEqual(['Binance Wallet', 'Trust Wallet', 'Rabby Wallet', 'OKX Wallet']);
  });

  it('recommends all five when nothing is installed, with the official download pages', () => {
    const g = groupWallets([], null);
    expect(g.installed).toEqual([]);
    expect(g.recommended.map((r) => r.name)).toEqual(['Binance Wallet', 'Trust Wallet', 'Rabby Wallet', 'MetaMask', 'OKX Wallet']);
    expect(Object.fromEntries(g.recommended.map((r) => [r.name, r.url]))).toEqual({
      'OKX Wallet': 'https://web3.okx.com/download',
      MetaMask: 'https://metamask.io/download/',
      'Rabby Wallet': 'https://rabby.io/',
      'Binance Wallet': 'https://www.binance.com/en/web3wallet',
      'Trust Wallet': 'https://trustwallet.com/download',
    });
    // the ranking of the installed group is a separate list from the order shown here
    expect(RECOMMENDED.map((r) => r.key)).toEqual(['okx', 'metamask', 'rabby', 'binance', 'trust', 'phantom']);
    expect(RECOMMENDED_ORDER).toEqual(['binance', 'trust', 'rabby', 'metamask', 'okx']);
  });

  it('recommends nothing when all five are installed', () => {
    const all = ['com.okex.wallet', 'io.metamask', 'io.rabby', 'com.binance.w3w', 'com.trustwallet.app'].map((r) => opt(r));
    expect(groupWallets(all, null).recommended).toEqual([]);
  });

  it('knows an installed wallet by its name when the rdns is not the usual one', () => {
    const g = groupWallets([opt('some.fork', 'Rabby Wallet'), opt('other', 'Binance Web3 Wallet')], null);
    expect(g.recommended.map((r) => r.key)).toEqual(['trust', 'metamask', 'okx']);
  });

  it('tags the wallet used last and puts it first, then OKX Wallet, MetaMask and Rabby, then the rest in the order found', () => {
    const list = [opt('z.other', 'Zed'), opt('io.rabby', 'Rabby'), opt('io.metamask', 'MetaMask'), opt('com.okex.wallet', 'OKX Wallet'), opt('a.other', 'Aye')];
    expect(groupWallets(list, null).installed.map((i) => i.option.name)).toEqual(['OKX Wallet', 'MetaMask', 'Rabby', 'Zed', 'Aye']);
    expect(groupWallets(list, null).installed.some((i) => i.recent)).toBe(false);
    const recent = groupWallets(list, 'a.other');
    expect(recent.installed.map((i) => i.option.name)).toEqual(['Aye', 'OKX Wallet', 'MetaMask', 'Rabby', 'Zed']);
    expect(recent.installed.map((i) => i.recent)).toEqual([true, false, false, false, false]);
  });

  it('tags nothing when the last wallet is gone, or none was used', () => {
    const list = [opt('io.metamask')];
    expect(groupWallets(list, 'gone').installed[0]?.recent).toBe(false);
    expect(groupWallets(list, '').installed[0]?.recent).toBe(false);
  });

  it('lists the plain window.ethereum as one installed wallet, tagged when it was used last', () => {
    const fb = opt('window.ethereum', 'Browser wallet', { fallback: true });
    const g = groupWallets([fb], 'window.ethereum');
    expect(g.installed).toEqual([{ option: fb, recent: true }]);
    expect(g.recommended).toHaveLength(5);
  });
});

describe('the wallet an installed one says it is', () => {
  it('is known by the rdns it announced, never by its name', () => {
    expect(knownWallet(opt('io.metamask', 'Anything'))?.key).toBe('metamask');
    expect(knownWallet(opt('com.binance.wallet', 'x'))?.key).toBe('binance');
    expect(knownWallet(opt('com.okex.wallet', 'x'))?.key).toBe('okx');
    expect(knownWallet(opt('app.phantom', 'x'))?.key).toBe('phantom');
    expect(knownWallet(opt('some.fork', 'MetaMask'))).toBeNull();
    expect(knownWallet(opt('', 'MetaMask'))).toBeNull();
    expect(knownWallet(opt('window.ethereum', 'MetaMask', { fallback: true }))).toBeNull();
  });

  it('finds a recommended wallet by its key, and nothing else', () => {
    expect(recommendedByKey('rabby')?.name).toBe('Rabby Wallet');
    for (const bad of ['', 'Rabby', 'phantom', '"><img src=x>', null, undefined, 3, 'constructor']) expect(recommendedByKey(bad), String(bad)).toBeNull();
  });
});
