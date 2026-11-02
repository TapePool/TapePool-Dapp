import type { Page } from '@playwright/test';
import type { Address, Hex } from 'viem';
import { RPC } from './stack';

/**
 * The test wallet: an EIP-1193 provider injected into the page, announced over EIP-6963 and as `window.ethereum`, that
 * forwards to the two local anvil forks as an impersonated account. No key exists anywhere: the forks run with
 * `--auto-impersonate`, so `eth_sendTransaction` from any address just works.
 *
 *   - `eth_requestAccounts` answers the account (and from then on `eth_accounts` does too);
 *   - `wallet_switchEthereumChain` moves between X Layer (196) and BNB Smart Chain (56) and tells the page;
 *   - `eth_sendTransaction` goes to the fork of the chain the wallet is on, after an optional hook;
 *   - everything else read-only goes to that fork too.
 */

export interface SentTx {
  from: Address;
  to: Address;
  data: Hex;
  value: bigint;
  chain: 'xlayer' | 'bsc';
  /** The text of the "your wallet will ask" line that was on screen when the wallet was asked. */
  ask: string | null;
}

export interface WalletOptions {
  account: Address;
  /**
   * Runs before a transaction is forwarded. It may change the chain first (scenario 3 executes a queued fee change here) or
   * throw to refuse the prompt like a user would.
   */
  beforeSend?: (tx: SentTx) => Promise<void>;
}

export interface TestWallet {
  readonly sent: SentTx[];
  chainId(): number;
  /** Replace (or remove) the hook that runs before each transaction is forwarded. */
  setBeforeSend(fn: ((tx: SentTx) => Promise<void>) | undefined): void;
}

const HEX = (n: number): string => `0x${n.toString(16)}`;

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data });
  return body.result;
}

/** Install the wallet in every page of the context the page belongs to. Call before the first navigation. */
export async function installWallet(page: Page, o: WalletOptions): Promise<TestWallet> {
  let chainId = 196;
  let connected = false;
  let beforeSend = o.beforeSend;
  const sent: SentTx[] = [];
  const urlOf = (): string => (chainId === 56 ? RPC.bsc : RPC.xlayer);

  async function handle(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case 'eth_requestAccounts':
        connected = true;
        return [o.account];
      case 'eth_accounts':
        return connected ? [o.account] : [];
      case 'eth_chainId':
        return HEX(chainId);
      case 'net_version':
        return String(chainId);
      case 'wallet_switchEthereumChain': {
        const id = Number.parseInt(String((params[0] as { chainId: string }).chainId), 16);
        if (id !== 196 && id !== 56) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 });
        chainId = id;
        await page.evaluate((hex) => (window as unknown as { __tpEmit: (e: string, a: unknown) => void }).__tpEmit('chainChanged', hex), HEX(id));
        return null;
      }
      case 'wallet_addEthereumChain':
        return null;
      case 'eth_sendTransaction': {
        const raw = params[0] as { from: string; to: string; data: Hex; value?: string };
        if (raw.from.toLowerCase() !== o.account.toLowerCase()) throw Object.assign(new Error('the wallet only signs for its own account'), { code: -32602 });
        const ask = await page
          .locator('.ask')
          .first()
          .innerText({ timeout: 500 })
          .catch(() => null);
        const tx: SentTx = { from: o.account, to: raw.to as Address, data: raw.data, value: raw.value ? BigInt(raw.value) : 0n, chain: chainId === 56 ? 'bsc' : 'xlayer', ask };
        sent.push(tx);
        if (beforeSend) await beforeSend(tx);
        return rpc(urlOf(), 'eth_sendTransaction', [raw]);
      }
      case 'personal_sign':
      case 'eth_sign':
      case 'eth_signTypedData_v4':
        throw Object.assign(new Error('the app must never ask to sign a message'), { code: -32601 });
      default:
        return rpc(urlOf(), method, params);
    }
  }

  await page.exposeBinding('__tpWallet', async (_src, method: string, params: unknown[]) => {
    try {
      return { ok: true, result: await handle(method, params ?? []) };
    } catch (e) {
      const err = e as { code?: number; message?: string; data?: unknown };
      return { ok: false, error: { code: err.code ?? -32000, message: err.message ?? String(e), data: err.data } };
    }
  });
  await page.addInitScript(() => {
    type Handler = (arg: unknown) => void;
    const listeners: Record<string, Handler[]> = {};
    const call = async (method: string, params: unknown[]): Promise<unknown> => {
      const r = (await (window as unknown as { __tpWallet: (m: string, p: unknown[]) => Promise<{ ok: boolean; result?: unknown; error?: { code: number; message: string; data?: unknown } }> }).__tpWallet(method, params)) as {
        ok: boolean;
        result?: unknown;
        error?: { code: number; message: string; data?: unknown };
      };
      if (r.ok) return r.result;
      throw Object.assign(new Error(r.error?.message ?? 'wallet error'), { code: r.error?.code, data: r.error?.data });
    };
    const provider = {
      isTestWallet: true,
      request: ({ method, params }: { method: string; params?: unknown[] }) => call(method, params ?? []),
      on(ev: string, fn: Handler) {
        (listeners[ev] ??= []).push(fn);
      },
      removeListener(ev: string, fn: Handler) {
        listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
      },
    };
    (window as unknown as { __tpEmit: (e: string, a: unknown) => void }).__tpEmit = (ev, arg) => (listeners[ev] ?? []).forEach((f) => f(arg));
    const info = { uuid: '00000000-0000-4000-8000-000000000e2e', name: 'Test wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', rdns: 'io.metamask' };
    window.addEventListener('eip6963:requestProvider', () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    });
    (window as unknown as { ethereum: unknown }).ethereum = provider;
  });
  return {
    sent,
    chainId: () => chainId,
    setBeforeSend(fn) {
      beforeSend = fn;
    },
  };
}
