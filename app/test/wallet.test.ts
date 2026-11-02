import { describe, expect, it } from 'vitest';
import { memoryStore } from '../src/logic/history';
import { choose, discoverProviders, Wallet, X_LAYER, type Discovered, type Eip1193Provider, type WalletEnv } from '../src/chain/wallet';

const ADDR = '0x1111111111111111111111111111111111111111';
const ADDR2 = '0x2222222222222222222222222222222222222222';

type Handler = (params: unknown) => unknown;

/** An EIP-1193 provider with scripted answers and the events a wallet fires. */
function provider(handlers: Record<string, Handler> = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const listeners = new Map<string, ((...a: never[]) => void)[]>();
  const p: Eip1193Provider = {
    async request({ method, params }) {
      calls.push({ method, params });
      const h = handlers[method];
      if (!h) throw Object.assign(new Error(`unsupported ${method}`), { code: -32601 });
      return h(params);
    },
    on(event, fn) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    },
    removeListener(event, fn) {
      listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn));
    },
  };
  const fire = (event: string, payload: unknown): void => (listeners.get(event) ?? []).forEach((f) => (f as (x: unknown) => void)(payload));
  return { p, calls, fire, listeners };
}

const info = (rdns: string, uuid = rdns) => ({ uuid, name: rdns, icon: '', rdns });

/** A page that answers `eip6963:requestProvider` with the given wallets. */
function page(wallets: Discovered[], ethereum?: Eip1193Provider): WalletEnv {
  const target = new EventTarget();
  const env: WalletEnv = {
    addEventListener: (t, fn) => target.addEventListener(t, fn),
    removeEventListener: (t, fn) => target.removeEventListener(t, fn),
    dispatchEvent: (e) => {
      if (e.type === 'eip6963:requestProvider') for (const w of wallets) target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: w }));
      return true;
    },
    ethereum,
  };
  return env;
}

/** A wallet on chain `hex`. `eth_accounts` (no prompt) answers `known`: empty for a site that was never connected. */
const sync = (hex = '0xc4', known: string[] = []) => ({ eth_accounts: () => known, eth_requestAccounts: () => [ADDR], eth_chainId: () => hex });

describe('discovery', () => {
  it('collects the wallets that announce themselves', async () => {
    const a = provider(sync());
    const b = provider(sync());
    const found = await discoverProviders(page([{ info: info('io.metamask'), provider: a.p }, { info: info('io.rabby'), provider: b.p }]), 5);
    expect(found.map((d) => d.info.rdns)).toEqual(['io.metamask', 'io.rabby']);
  });

  it('falls back to window.ethereum when nobody announces', async () => {
    const a = provider(sync());
    const found = await discoverProviders(page([], a.p), 5);
    expect(found).toHaveLength(1);
    expect(found[0]?.provider).toBe(a.p);
    expect(await discoverProviders(page([]), 5)).toEqual([]);
  });

  it('ignores an announcement that is not a provider', async () => {
    const env = page([{ info: info('x'), provider: {} as Eip1193Provider }, { info: { uuid: 1 } as never, provider: provider().p }]);
    expect(await discoverProviders(env, 5)).toEqual([]);
  });

  it('prefers the wallet used last, then OKX Wallet, MetaMask and Rabby', () => {
    const mk = (rdns: string): Discovered => ({ info: info(rdns), provider: provider().p });
    const list = [mk('io.rabby'), mk('io.metamask'), mk('com.okex.wallet'), mk('other')];
    expect(choose(list, null)?.info.rdns).toBe('com.okex.wallet');
    expect(choose(list, 'io.rabby')?.info.rdns).toBe('io.rabby');
    expect(choose(list, 'gone')?.info.rdns).toBe('com.okex.wallet');
    expect(choose([mk('io.rabby'), mk('io.metamask')], null)?.info.rdns).toBe('io.metamask');
    expect(choose([mk('other')], null)?.info.rdns).toBe('other');
    expect(choose([], null)).toBeNull();
  });
});

describe('connecting', () => {
  it('asks for accounts only when the user presses Connect, and remembers the wallet', async () => {
    const w = provider(sync());
    const store = memoryStore();
    const wallet = new Wallet(page([{ info: info('io.metamask'), provider: w.p }]), store);
    await wallet.init();
    expect(wallet.account).toBeNull(); // eth_accounts is empty for a site never connected
    expect(w.calls.map((c) => c.method)).toEqual(['eth_accounts', 'eth_chainId']);
    let changes = 0;
    wallet.subscribe(() => changes++);
    expect(await wallet.connect()).toEqual({ ok: true });
    expect(w.calls.map((c) => c.method)).toContain('eth_requestAccounts');
    expect(wallet.account).toBe(ADDR);
    expect(wallet.chainId).toBe(196);
    expect(store.get('tp-wallet')).toBe('io.metamask');
    expect(changes).toBeGreaterThan(0);
  });

  it('picks the account up again on load without a prompt, after a connect', async () => {
    const w = provider(sync('0xc4', [ADDR]));
    const store = memoryStore();
    store.set('tp-wallet', 'io.metamask');
    const wallet = new Wallet(page([{ info: info('io.metamask'), provider: w.p }]), store);
    await wallet.init();
    expect(wallet.account).toBe(ADDR);
    expect(wallet.chainId).toBe(196);
    expect(w.calls.map((c) => c.method)).not.toContain('eth_requestAccounts');
  });

  it('disconnecting forgets the account and is not undone by the next load', async () => {
    const w = provider(sync());
    const store = memoryStore();
    const wallet = new Wallet(page([{ info: info('io.metamask'), provider: w.p }]), store);
    await wallet.init();
    await wallet.connect();
    wallet.disconnect();
    expect(wallet.account).toBeNull();
    const again = new Wallet(page([{ info: info('io.metamask'), provider: w.p }]), store);
    await again.init();
    expect(again.account).toBeNull();
    // and pressing Connect works again
    expect(await again.connect()).toEqual({ ok: true });
    expect(again.account).toBe(ADDR);
  });

  it('follows the wallet: another account, another chain, no account', async () => {
    const w = provider(sync());
    const wallet = new Wallet(page([{ info: info('io.metamask'), provider: w.p }]), memoryStore());
    await wallet.init();
    await wallet.connect();
    w.fire('accountsChanged', [ADDR2]);
    expect(wallet.account).toBe(ADDR2);
    w.fire('chainChanged', '0x38');
    expect(wallet.chainId).toBe(56);
    w.fire('accountsChanged', []);
    expect(wallet.account).toBeNull();
  });

  it('says so when there is no wallet, and when the user cancels', async () => {
    const none = new Wallet(page([]), memoryStore());
    await none.init();
    expect(await none.connect()).toEqual({ ok: false, noWallet: true });
    const rejects = provider({ ...sync(), eth_requestAccounts: () => { throw Object.assign(new Error('User rejected'), { code: 4001 }); } });
    const wallet = new Wallet(page([{ info: info('io.metamask'), provider: rejects.p }]), memoryStore());
    await wallet.init();
    expect(await wallet.connect()).toEqual({ ok: false, error: { kind: 'wallet-rejected' } });
    expect(wallet.account).toBeNull();
  });

  it('keeps the wallet\'s own error text under Details for anything else, cut short', async () => {
    const broken = provider({ ...sync(), eth_requestAccounts: () => { throw new Error('x'.repeat(1_000)); } });
    const wallet = new Wallet(page([{ info: info('io.metamask'), provider: broken.p }]), memoryStore());
    await wallet.init();
    const r = await wallet.connect();
    expect(r.ok).toBe(false);
    if (!r.ok && r.error?.kind === 'unknown') expect(r.error.details.length).toBeLessThanOrEqual(300);
  });

  it('a wallet that returns no valid account is an error, not a connection', async () => {
    const w = provider({ ...sync(), eth_requestAccounts: () => ['not an address'] });
    const wallet = new Wallet(page([{ info: info('io.metamask'), provider: w.p }]), memoryStore());
    await wallet.init();
    expect((await wallet.connect()).ok).toBe(false);
    expect(wallet.account).toBeNull();
  });

  it('never sends a transaction or asks for a signature', async () => {
    const w = provider(sync());
    const wallet = new Wallet(page([{ info: info('io.metamask'), provider: w.p }]), memoryStore());
    await wallet.init();
    await wallet.connect();
    await wallet.switchToXLayer();
    wallet.disconnect();
    for (const c of w.calls) expect(['eth_accounts', 'eth_requestAccounts', 'eth_chainId', 'wallet_switchEthereumChain', 'wallet_addEthereumChain']).toContain(c.method);
  });
});

describe('switching to X Layer', () => {
  it('asks the wallet to switch to chain 196', async () => {
    const w = provider({ ...sync('0x38'), wallet_switchEthereumChain: () => null });
    const wallet = new Wallet(page([{ info: info('io.metamask'), provider: w.p }]), memoryStore());
    await wallet.init();
    await wallet.connect();
    expect(wallet.chainId).toBe(56);
    w.calls.length = 0;
    // after the switch the wallet reports the new chain
    (w.p as { request: Eip1193Provider['request'] }).request = (async ({ method, params }: { method: string; params?: unknown }) => {
      w.calls.push({ method, params });
      return method === 'eth_chainId' ? '0xc4' : null;
    }) as Eip1193Provider['request'];
    expect(await wallet.switchToXLayer()).toEqual({ ok: true });
    expect(w.calls[0]).toEqual({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xc4' }] });
    expect(wallet.chainId).toBe(196);
  });

  it('adds the chain when the wallet does not know it (4902), with the public RPC and the explorer', async () => {
    let added: unknown = null;
    const w = provider({
      ...sync('0x38'),
      wallet_switchEthereumChain: () => {
        throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 });
      },
      wallet_addEthereumChain: (p) => {
        added = p;
        return null;
      },
    });
    const wallet = new Wallet(page([{ info: info('io.metamask'), provider: w.p }]), memoryStore());
    await wallet.init();
    await wallet.connect();
    expect((await wallet.switchToXLayer()).ok).toBe(true);
    expect(added).toEqual([{ chainId: '0xc4', chainName: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: [X_LAYER.rpc], blockExplorerUrls: [X_LAYER.explorer] }]);
    expect(X_LAYER.rpc).toBe('https://rpc.xlayer.tech');
  });

  it('also adds the chain on the message some wallets give instead of 4902', async () => {
    let added = false;
    const w = provider({
      ...sync('0x38'),
      wallet_switchEthereumChain: () => {
        throw Object.assign(new Error('Unrecognized chain ID "0xc4". Try adding the chain'), { code: -32603 });
      },
      wallet_addEthereumChain: () => {
        added = true;
        return null;
      },
    });
    const wallet = new Wallet(page([{ info: info('io.metamask'), provider: w.p }]), memoryStore());
    await wallet.init();
    await wallet.connect();
    await wallet.switchToXLayer();
    expect(added).toBe(true);
  });

  it('a cancelled switch is a cancellation, and another failure is reported', async () => {
    const reject = provider({ ...sync('0x38'), wallet_switchEthereumChain: () => { throw Object.assign(new Error('no'), { code: 4001 }); } });
    const wallet = new Wallet(page([{ info: info('io.metamask'), provider: reject.p }]), memoryStore());
    await wallet.init();
    await wallet.connect();
    expect(await wallet.switchToXLayer()).toEqual({ ok: false, error: { kind: 'wallet-rejected' } });
    const none = new Wallet(page([]), memoryStore());
    expect(await none.switchToXLayer()).toEqual({ ok: false, noWallet: true });
  });
});

const ICON = 'data:image/svg+xml;base64,PHN2Zy8+';
const RLO = String.fromCharCode(0x202e); // right-to-left override

describe('the wallets the picker lists', () => {
  it('cleans what a wallet announces: a plain name, an icon only if it is a base64 image data URI', async () => {
    const a = provider(sync());
    const b = provider(sync());
    const wallet = new Wallet(
      page([
        { info: { uuid: 'u-a', name: 'MetaMask', icon: ICON, rdns: 'io.metamask' }, provider: a.p },
        { info: { uuid: 'x"><script>', name: `<img src=x onerror=alert(1)>${RLO}`.padEnd(80, 'z'), icon: 'javascript:alert(1)', rdns: 'evil' }, provider: b.p },
      ]),
      memoryStore(),
    );
    await wallet.init();
    const [first, second] = wallet.options();
    expect(first).toEqual({ id: 'u-a', name: 'MetaMask', icon: ICON, rdns: 'io.metamask', fallback: false });
    expect(second?.icon).toBeNull();
    expect(second?.id).toBe('w1'); // an id that is not plain is replaced by the position
    expect(second?.name.length).toBeLessThanOrEqual(32);
    expect(second?.name).not.toContain(RLO);
  });

  it('lists the plain window.ethereum as a fallback only when nothing announced itself', async () => {
    const eth = provider(sync());
    const alone = new Wallet(page([], eth.p), memoryStore());
    await alone.init();
    expect(alone.options()).toEqual([{ id: 'window.ethereum', name: 'Browser wallet', icon: null, rdns: 'window.ethereum', fallback: true }]);
    const withOne = new Wallet(page([{ info: info('io.rabby'), provider: provider(sync()).p }], eth.p), memoryStore());
    await withOne.init();
    expect(withOne.options().map((o) => o.rdns)).toEqual(['io.rabby']);
  });

  it('keeps one entry for a wallet that announces twice', async () => {
    const a = provider(sync());
    const wallet = new Wallet(page([{ info: info('io.metamask', 'one'), provider: a.p }, { info: info('io.metamask', 'two'), provider: a.p }]), memoryStore());
    await wallet.init();
    expect(wallet.options().map((o) => o.id)).toEqual(['one']);
  });

  it('connects through the wallet that was picked, not the preferred one', async () => {
    const okx = provider({ ...sync(), eth_requestAccounts: () => [ADDR2] });
    const mm = provider(sync());
    const store = memoryStore();
    const wallet = new Wallet(page([{ info: info('com.okex.wallet'), provider: okx.p }, { info: info('io.metamask'), provider: mm.p }]), store);
    await wallet.init();
    expect(await wallet.connect('io.metamask')).toEqual({ ok: true });
    expect(wallet.account).toBe(ADDR);
    expect(mm.calls.map((c) => c.method)).toContain('eth_requestAccounts');
    expect(okx.calls.map((c) => c.method)).not.toContain('eth_requestAccounts');
    expect(wallet.eip1193).toBe(mm.p);
    expect(wallet.active()?.rdns).toBe('io.metamask');
    expect(store.get('tp-wallet')).toBe('io.metamask');
    // and the other one the next time
    wallet.disconnect();
    expect(await wallet.connect('com.okex.wallet')).toEqual({ ok: true });
    expect(wallet.account).toBe(ADDR2);
    expect(wallet.eip1193).toBe(okx.p);
    expect(store.get('tp-wallet')).toBe('com.okex.wallet');
  });

  it('does not use a wallet the list does not have', async () => {
    const mm = provider(sync());
    const wallet = new Wallet(page([{ info: info('io.metamask'), provider: mm.p }]), memoryStore());
    await wallet.init();
    expect(await wallet.connect('nope')).toEqual({ ok: false, noWallet: true });
    expect(mm.calls.map((c) => c.method)).not.toContain('eth_requestAccounts');
  });

  it("forgets the old wallet's account when another one is picked", async () => {
    const a = provider(sync('0xc4', [ADDR]));
    const b = provider({
      ...sync(),
      eth_requestAccounts: () => {
        throw Object.assign(new Error('no'), { code: 4001 });
      },
    });
    const store = memoryStore();
    store.set('tp-wallet', 'io.metamask');
    const wallet = new Wallet(page([{ info: info('io.metamask'), provider: a.p }, { info: info('io.rabby'), provider: b.p }]), store);
    await wallet.init();
    expect(wallet.account).toBe(ADDR);
    expect(await wallet.connect('io.rabby')).toEqual({ ok: false, error: { kind: 'wallet-rejected' } });
    expect(wallet.account).toBeNull();
  });

  it('keeps the wallet used last across a disconnect, for the Recent tag', async () => {
    const w = provider(sync());
    const store = memoryStore();
    const wallet = new Wallet(page([{ info: info('io.metamask'), provider: w.p }]), store);
    await wallet.init();
    expect(wallet.recent()).toBeNull();
    await wallet.connect('io.metamask');
    wallet.disconnect();
    expect(store.get('tp-wallet')).toBe('off'); // the silent reconnect stays off
    expect(wallet.recent()).toBe('io.metamask');
    const again = new Wallet(page([{ info: info('io.metamask'), provider: w.p }]), store);
    expect(again.recent()).toBe('io.metamask');
  });

  it('tells the screen what it found on load, also after a disconnect and also when nothing was connected', async () => {
    const w = provider(sync());
    for (const saved of [null, 'off', 'io.metamask']) {
      const store = memoryStore();
      if (saved) store.set('tp-wallet', saved);
      const wallet = new Wallet(page([{ info: info('io.metamask'), provider: w.p }]), store);
      let seen: string[] = [];
      wallet.subscribe(() => (seen = wallet.options().map((o) => o.rdns)));
      await wallet.init();
      expect(seen, String(saved)).toEqual(['io.metamask']);
    }
  });

  it('finds a wallet that announces itself late, and tells the screen', async () => {
    const wallets: Discovered[] = [];
    const wallet = new Wallet(page(wallets), memoryStore());
    await wallet.init();
    expect(wallet.options()).toEqual([]);
    let changes = 0;
    wallet.subscribe(() => changes++);
    wallets.push({ info: info('io.rabby'), provider: provider(sync()).p });
    await wallet.scan(5);
    expect(wallet.options().map((o) => o.rdns)).toEqual(['io.rabby']);
    expect(changes).toBe(1);
    await wallet.scan(5);
    expect(changes).toBe(1); // nothing new: no change
  });
});

describe('a wallet that cannot go to X Layer', () => {
  const walletWith = async (handlers: Record<string, Handler>) => {
    const w = provider({ ...sync('0x38'), ...handlers });
    const wallet = new Wallet(page([{ info: info('io.metamask'), provider: w.p }]), memoryStore());
    await wallet.init();
    await wallet.connect();
    return { wallet, w };
  };
  const refuse = (message: string, code: number): Handler => () => {
    throw Object.assign(new Error(message), { code });
  };

  it('says so when the wallet refuses both the switch and the add', async () => {
    const { wallet } = await walletWith({
      wallet_switchEthereumChain: refuse('Unrecognized chain ID', 4902),
      wallet_addEthereumChain: refuse('Adding this network is not supported', -32603),
    });
    expect(await wallet.switchToXLayer()).toEqual({ ok: false, error: { kind: 'wallet-no-xlayer', details: 'Adding this network is not supported' } });
    expect(wallet.chainId).toBe(56); // still where it was: the app stays on the wrong-network state and writes nothing
    expect(wallet.account).toBe(ADDR);
  });

  it('says so when the wallet has no way to switch at all', async () => {
    for (const code of [4200, -32601, -32603]) {
      const { wallet } = await walletWith({ wallet_switchEthereumChain: refuse('unsupported method', code) });
      const r = await wallet.switchToXLayer();
      expect(r.ok, String(code)).toBe(false);
      if (!r.ok) expect(r.error?.kind, String(code)).toBe('wallet-no-xlayer');
    }
  });

  it('keeps the cancelled line for a user rejection, in the switch and in the add', async () => {
    const rejectSwitch = await walletWith({ wallet_switchEthereumChain: refuse('User rejected', 4001) });
    expect(await rejectSwitch.wallet.switchToXLayer()).toEqual({ ok: false, error: { kind: 'wallet-rejected' } });
    const rejectAdd = await walletWith({ wallet_switchEthereumChain: refuse('Unrecognized chain ID', 4902), wallet_addEthereumChain: refuse('User rejected', 4001) });
    expect(await rejectAdd.wallet.switchToXLayer()).toEqual({ ok: false, error: { kind: 'wallet-rejected' } });
  });

  it('does not call a prompt that is already open a refusal', async () => {
    const { wallet } = await walletWith({ wallet_switchEthereumChain: refuse('Request already pending', -32002) });
    const r = await wallet.switchToXLayer();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error?.kind).toBe('unknown');
  });

  it('keeps the plain failure for BNB Smart Chain, where the X Layer line would be wrong', async () => {
    const { wallet } = await walletWith({ wallet_switchEthereumChain: refuse('nope', -32603) });
    const r = await wallet.switchTo('bsc');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error?.kind).toBe('unknown');
  });
});
