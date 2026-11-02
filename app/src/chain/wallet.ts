import { getAddress, isAddress } from 'viem/utils';
import type { AppError } from './errors';
import type { KvStore } from '../logic/history';
import { buildOptions, FALLBACK_ID } from '../logic/wallets';
import type { Address, WalletOption } from '../model';

/**
 * The browser wallet: discovery (EIP-6963, then `window.ethereum`), connecting through the wallet the user picked, the chain
 * the wallet is on, and switching it between X Layer and BNB Smart Chain (the latter only for the self-push, SPEC-PHASE5-APP §6.4).
 * Sending a transaction is done in `chain/tx.ts`, through the provider, after simulating.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
}

export interface ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface Discovered {
  info: ProviderInfo;
  provider: Eip1193Provider;
}

/** What discovery needs from `window`. */
export interface WalletEnv {
  addEventListener(type: string, fn: (e: Event) => void): void;
  removeEventListener(type: string, fn: (e: Event) => void): void;
  dispatchEvent(e: Event): boolean;
  ethereum?: Eip1193Provider;
}

/** Tried in this order when several wallets are installed (SPEC-PHASE5-APP §3: OKX Wallet, MetaMask, Rabby). */
export const PREFERRED_RDNS = ['com.okex.wallet', 'io.metamask', 'io.rabby'] as const;

export const X_LAYER = { id: 196, hex: '0xc4', name: 'X Layer', rpc: 'https://rpc.xlayer.tech', explorer: 'https://www.oklink.com/xlayer', symbol: 'OKB' } as const;
export const BSC = { id: 56, hex: '0x38', name: 'BNB Smart Chain', rpc: 'https://bsc-dataseed.bnbchain.org', explorer: 'https://bscscan.com', symbol: 'BNB' } as const;
export type ChainName = 'xlayer' | 'bsc';
const CHAINS = { xlayer: X_LAYER, bsc: BSC } as const;

/** What `ChainActions` needs from the wallet; `Wallet` is the browser implementation. */
export interface WalletPort {
  readonly account: Address | null;
  readonly chainId: number | null;
  readonly eip1193: Eip1193Provider | null;
  /** Ask the wallet which chain it is on now (the cached `chainId` can be a moment old). */
  readChainId(): Promise<number | null>;
  switchTo(chain: ChainName): Promise<WalletResult>;
}

/**
 * Ask every wallet on the page to announce itself and listen for `waitMs`. The announcement carries a provider
 * object and a few strings. The strings are untrusted: the picker shows the name and the icon only after
 * `logic/wallets.ts` has cleaned them (a plain name; an icon only if it is a base64 image data URI), as escaped text and attributes.
 */
export function discoverProviders(env: WalletEnv, waitMs = 200): Promise<Discovered[]> {
  return new Promise((resolve) => {
    const found = new Map<string, Discovered>();
    const onAnnounce = (e: Event): void => {
      const d = (e as CustomEvent<Discovered>).detail;
      if (d && typeof d.info?.uuid === 'string' && typeof d.info?.rdns === 'string' && typeof d.provider?.request === 'function') found.set(d.info.uuid, d);
    };
    env.addEventListener('eip6963:announceProvider', onAnnounce);
    env.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      env.removeEventListener('eip6963:announceProvider', onAnnounce);
      const list = [...found.values()];
      // a wallet that does not speak EIP-6963 only has `window.ethereum`
      if (list.length === 0 && env.ethereum && typeof env.ethereum.request === 'function') {
        list.push({ info: { uuid: FALLBACK_ID, name: 'Browser wallet', icon: '', rdns: FALLBACK_ID }, provider: env.ethereum });
      }
      resolve(list);
    }, waitMs);
  });
}

/** The wallet to use: the one connected last time if it is still there, else the first of the preferred ones, else the first found. */
export function choose(list: readonly Discovered[], remembered: string | null): Discovered | null {
  const by = (rdns: string): Discovered | undefined => list.find((d) => d.info.rdns === rdns);
  if (remembered) {
    const r = by(remembered);
    if (r) return r;
  }
  for (const rdns of PREFERRED_RDNS) {
    const p = by(rdns);
    if (p) return p;
  }
  return list[0] ?? null;
}

/** What a failed request looks like: EIP-1193 gives a numeric `code`. */
const codeOf = (e: unknown): number | null => (typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'number' ? (e as { code: number }).code : null);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) : String(e));

export type WalletResult = { ok: true } | { ok: false; error?: AppError; noWallet?: true };

const failure = (e: unknown): WalletResult => (codeOf(e) === 4001 ? { ok: false, error: { kind: 'wallet-rejected' } } : { ok: false, error: { kind: 'unknown', details: messageOf(e).slice(0, 300) } });

/**
 * A wallet that could not be moved to `chain`. For X Layer, any refusal but a cancel (4001) or a prompt that is already open in
 * the wallet (-32002) means the wallet cannot go there: some multi-chain wallets neither switch to X Layer nor add it.
 */
const refusal = (e: unknown, chain: ChainName): WalletResult => {
  const code = codeOf(e);
  if (chain !== 'xlayer' || code === 4001 || code === -32002) return failure(e);
  return { ok: false, error: { kind: 'wallet-no-xlayer', details: messageOf(e).slice(0, 300) } };
};

const parseChainId = (v: unknown): number | null => {
  if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)) return Number.parseInt(v, 16);
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  return null;
};

const pickAccount = (v: unknown): Address | null => {
  const first = Array.isArray(v) ? v[0] : undefined;
  return typeof first === 'string' && isAddress(first, { strict: false }) ? (getAddress(first) as Address) : null;
};

const STORE_KEY = 'tp-wallet'; // `rdns` of the wallet used last, or `off` after the user disconnected on purpose
const RECENT_KEY = 'tp-wallet-last'; // `rdns` of the wallet that connected last; unlike STORE_KEY a disconnect keeps it (the "Recent" tag)

export class Wallet implements WalletPort {
  account: Address | null = null;
  chainId: number | null = null;
  private provider: Eip1193Provider | null = null;
  private rdns: string | null = null;
  private readonly listeners = new Set<() => void>();
  private detach: (() => void) | null = null;
  /** The wallets found, cleaned for the screen. The same array until the set changes, so a snapshot can hand it out. */
  private list: readonly WalletOption[] = [];
  private readonly byId = new Map<string, Discovered>();

  constructor(
    private readonly env: WalletEnv,
    private readonly store: KvStore,
  ) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  /** The wallets found in the browser. */
  options(): readonly WalletOption[] {
    return this.list;
  }

  /** The wallet the app is using, once one was picked or remembered. */
  active(): WalletOption | null {
    const provider = this.provider;
    return provider ? (this.list.find((o) => this.byId.get(o.id)?.provider === provider) ?? null) : null;
  }

  /** `rdns` of the wallet that connected last. */
  recent(): string | null {
    return this.store.get(RECENT_KEY);
  }

  /** Clean what was found. True when the list the screen sees is not the one it had. */
  private remember(found: readonly Discovered[]): boolean {
    const built = buildOptions(found, (d) => d.info);
    const next = built.map((b) => b.option);
    const same = next.length === this.list.length && next.every((o, i) => JSON.stringify(o) === JSON.stringify(this.list[i]));
    this.byId.clear();
    for (const b of built) this.byId.set(b.option.id, b.item);
    if (same) return false;
    this.list = next;
    return true;
  }

  /** Ask the wallets to announce themselves again (one that loads late, or was just installed) and tell the screen if the list changed. */
  async scan(waitMs = 150): Promise<void> {
    if (this.remember(await discoverProviders(this.env, waitMs))) this.emit();
  }

  /** Find the wallet and, if the user connected before and did not disconnect, pick the account up again without a prompt. */
  async init(): Promise<void> {
    const saved = this.store.get(STORE_KEY);
    const list = await discoverProviders(this.env);
    // the screen may already be drawn: tell it what was found, whatever happens next
    if (this.remember(list)) this.emit();
    const pick = choose(list, saved && saved !== 'off' ? saved : null);
    if (!pick) return;
    this.use(pick);
    if (saved === 'off') return;
    try {
      const accounts = await pick.provider.request({ method: 'eth_accounts' });
      this.account = pickAccount(accounts);
      this.chainId = parseChainId(await pick.provider.request({ method: 'eth_chainId' }));
    } catch {
      /* the wallet is locked or refused: the user can press Connect */
    }
    this.emit();
  }

  private use(d: Discovered): void {
    if (this.provider !== null && this.provider !== d.provider) {
      // another wallet: what the old one said about the account and the chain is not about this one
      this.account = null;
      this.chainId = null;
    }
    this.detach?.();
    this.provider = d.provider;
    this.rdns = d.info.rdns;
    const onAccounts = (accounts: unknown): void => {
      this.account = pickAccount(accounts);
      this.emit();
    };
    const onChain = (id: unknown): void => {
      this.chainId = parseChainId(id);
      this.emit();
    };
    d.provider.on?.('accountsChanged', onAccounts as never);
    d.provider.on?.('chainChanged', onChain as never);
    this.detach = () => {
      d.provider.removeListener?.('accountsChanged', onAccounts as never);
      d.provider.removeListener?.('chainChanged', onChain as never);
    };
  }

  /**
   * The user chose a wallet in the picker (`id` is its `WalletOption.id`): ask THAT wallet for an account, through its own
   * provider, whatever the preferred order is. It shows its own prompt. Without an `id`, ask the wallet already in use, or
   * the preferred one.
   */
  async connect(id?: string): Promise<WalletResult> {
    if (id !== undefined) {
      const chosen = this.byId.get(id);
      if (!chosen) return { ok: false, noWallet: true };
      this.use(chosen);
    } else if (!this.provider) {
      const found = await discoverProviders(this.env);
      this.remember(found);
      const pick = choose(found, null);
      if (!pick) return { ok: false, noWallet: true };
      this.use(pick);
    }
    const provider = this.provider;
    if (!provider) return { ok: false, noWallet: true };
    try {
      this.account = pickAccount(await provider.request({ method: 'eth_requestAccounts' }));
      this.chainId = parseChainId(await provider.request({ method: 'eth_chainId' }));
    } catch (e) {
      return failure(e);
    }
    if (this.account === null) return { ok: false, error: { kind: 'unknown', details: 'The wallet returned no account.' } };
    if (this.rdns) {
      this.store.set(STORE_KEY, this.rdns);
      this.store.set(RECENT_KEY, this.rdns);
    }
    this.emit();
    return { ok: true };
  }

  /** EIP-1193 has no disconnect: the app forgets the account and does not pick it up again on the next load. */
  disconnect(): void {
    this.account = null;
    this.store.set(STORE_KEY, 'off');
    this.emit();
  }

  /** Move the wallet to X Layer, adding the chain first if the wallet does not know it. */
  switchToXLayer(): Promise<WalletResult> {
    return this.switchTo('xlayer');
  }

  async readChainId(): Promise<number | null> {
    const provider = this.provider;
    if (!provider) return this.chainId;
    try {
      const id = parseChainId(await provider.request({ method: 'eth_chainId' }));
      if (id !== null && id !== this.chainId) {
        this.chainId = id;
        this.emit();
      }
    } catch {
      /* keep the last known chain */
    }
    return this.chainId;
  }

  /** Move the wallet to `which`, adding the chain first if the wallet does not know it. */
  async switchTo(which: ChainName): Promise<WalletResult> {
    const chain = CHAINS[which];
    const provider = this.provider;
    if (!provider) return { ok: false, noWallet: true };
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.hex }] });
    } catch (e) {
      const unknownChain = codeOf(e) === 4902 || /unrecognized chain|unknown chain|not been added/i.test(messageOf(e));
      if (!unknownChain) return refusal(e, which);
      try {
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: chain.hex,
              chainName: chain.name,
              nativeCurrency: { name: chain.symbol, symbol: chain.symbol, decimals: 18 },
              rpcUrls: [chain.rpc],
              blockExplorerUrls: [chain.explorer],
            },
          ],
        });
      } catch (e2) {
        return refusal(e2, which);
      }
    }
    try {
      this.chainId = parseChainId(await provider.request({ method: 'eth_chainId' }));
    } catch {
      this.chainId = chain.id; // the switch succeeded; `chainChanged` corrects this if the wallet disagrees
    }
    this.emit();
    return { ok: true };
  }

  /** The provider, for the transactions. */
  get eip1193(): Eip1193Provider | null {
    return this.provider;
  }
}
