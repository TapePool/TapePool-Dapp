import type { AddressBook } from '../config';
import type { ActionId, Address, Ask, Hex, PendingTx, Sec } from '../model';
import type { AppError } from './errors';
import type { Reader, ReceiptInfo } from './reader';
import { codeOf, fromFailure, type RevertCtx } from './revert';
import type { ChainName, WalletPort } from './wallet';

/**
 * Sending one transaction the way SPEC-PHASE5-APP §6.0 says:
 *   1. the wallet must be on the right chain;
 *   2. simulate first, so a revert shows its message instead of opening a wallet prompt;
 *   3. say what the wallet will ask (contract, function, value) before it asks;
 *   4. send through the wallet and keep the hash, so a reload still shows the outcome;
 *   5. wait for one confirmation, then read the chain again;
 *   6. never retry on its own.
 */

/** What the runner needs from the data source. `ChainSource` is the real one. */
export interface ActionHost {
  now(): Sec;
  setPending(p: PendingTx | null): void;
  refresh(): Promise<void>;
  noteRelease?(agent: Address, attempts: number): void;
  noteLoanCleared(agent: Address, info: { clearedAt: Sec; surplus: bigint | null }): void;
}

export interface TxDeps {
  wallet: WalletPort;
  x: Reader;
  b: Reader;
  book: AddressBook;
  host: ActionHost;
  sleep: (ms: number) => Promise<void>;
  /** Monotonic milliseconds. */
  clock: () => number;
}

/** How long to wait for a transaction to be mined, and how often to look. */
export const RECEIPT_TIMEOUT_MS = 180_000;
export const RECEIPT_POLL_MS = 1_500;

export interface Prepared {
  chain: ChainName;
  to: Address;
  data: Hex;
  value: bigint;
  action: ActionId;
  ask: Ask;
  /** What the messages of a revert may need (the minimum advance, the credit rule's bits). */
  revert?: RevertCtx;
}

export type TxResult =
  | { ok: true; hash: Hex; receipt: ReceiptInfo; gas: bigint | null }
  /** `error` is set when the app knows what to say; `waiting` when the transaction was sent and has not been mined yet. */
  | { ok: false; error?: AppError; waiting?: boolean; hash?: Hex };

const toHex = (n: bigint): Hex => `0x${n.toString(16)}`;

export class TxRunner {
  constructor(private readonly d: TxDeps) {}

  readerFor(chain: ChainName): Reader {
    return chain === 'bsc' ? this.d.b : this.d.x;
  }

  chainIdOf(chain: ChainName): number {
    return chain === 'bsc' ? this.d.book.bscChainId : this.d.book.chainId;
  }

  /** The wallet is on `chain`, as the wallet itself says right now. Null means "yes". */
  async checkChain(chain: ChainName): Promise<AppError | null> {
    const id = await this.d.wallet.readChainId();
    return id === this.chainIdOf(chain) ? null : { kind: 'wrong-chain', want: chain };
  }

  /** Run `eth_call` as the account and map a revert; also the gas a node estimates. */
  async preview(p: Prepared, from: Address): Promise<{ ok: true; gas: bigint | null } | { ok: false; error: AppError }> {
    const reader = this.readerFor(p.chain);
    try {
      await reader.call(p.to, p.data, { from, value: p.value });
    } catch (e) {
      return { ok: false, error: fromFailure(e, p.revert) };
    }
    let gas: bigint | null = null;
    try {
      gas = await reader.estimateGas({ from, to: p.to, data: p.data, value: p.value });
    } catch {
      /* the call passed, so the estimate is a nicety: the wallet estimates for itself */
    }
    return { ok: true, gas };
  }

  /**
   * `keepPending` leaves the pending mark set after a confirmed transaction, for a flow that has more to do (the self-push
   * waits for the report on X Layer); the caller clears it. A failure always clears it.
   *
   * `beforePrompt` runs once the simulation passed and the line for the wallet is on screen, right before the wallet is asked;
   * returning false stops there (nothing was sent). `onHash` runs when the wallet has answered with a hash, before the wait for
   * the receipt; the transaction is on its way by then, so a failure in it never stops the wait.
   */
  async run(p: Prepared, o: { keepPending?: boolean; beforePrompt?: () => boolean | void | Promise<boolean | void>; onHash?: (hash: Hex) => void | Promise<void> } = {}): Promise<TxResult> {
    const { wallet, host } = this.d;
    const provider = wallet.eip1193;
    const from = wallet.account;
    if (!provider || !from) return { ok: false, error: { kind: 'unknown', details: 'The wallet is not connected.' } };
    const wrong = await this.checkChain(p.chain);
    if (wrong) return { ok: false, error: wrong };

    const pre = await this.preview(p, from);
    if (!pre.ok) return { ok: false, error: pre.error };

    // the line is on screen before the wallet is asked
    const chainId = this.chainIdOf(p.chain);
    const since = host.now();
    host.setPending({ action: p.action, since, hash: null, chainId, ask: p.ask });
    await this.d.sleep(0);
    if (o.beforePrompt && (await o.beforePrompt()) === false) {
      host.setPending(null);
      return { ok: false, error: { kind: 'harvest', why: 'busy' } };
    }

    let hash: Hex;
    try {
      // `chainId` makes a wallet refuse the transaction if its network changed after `checkChain`
      const tx: Record<string, string> = { from, to: p.to, data: p.data, chainId: toHex(BigInt(chainId)) };
      if (p.value > 0n) tx.value = toHex(p.value);
      hash = (await provider.request({ method: 'eth_sendTransaction', params: [tx] })) as Hex;
      if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('The wallet returned no transaction hash.');
    } catch (e) {
      host.setPending(null);
      // a wallet that simulates for itself can refuse with the revert; a user can cancel
      const err = codeOf(e) === 4001 ? ({ kind: 'wallet-rejected' } as AppError) : fromFailure(e, p.revert);
      return { ok: false, error: err };
    }

    host.setPending({ action: p.action, since, hash, chainId, ask: p.ask });
    try {
      await o.onHash?.(hash);
    } catch {
      /* the transaction is sent: the wait for its receipt goes on */
    }
    const receipt = await this.waitForReceipt(this.readerFor(p.chain), hash);
    if (!receipt) return { ok: false, waiting: true, hash };
    if (!receipt.success) {
      host.setPending(null);
      await host.refresh();
      return { ok: false, error: await this.explainRevert(p, from, hash), hash };
    }
    if (!o.keepPending) {
      host.setPending(null);
      await host.refresh();
    }
    return { ok: true, hash, receipt, gas: receipt.gasUsed ?? pre.gas };
  }

  /** Wait for one confirmation: the receipt exists. Null when it has not shown up in time (the transaction may still land). */
  private async waitForReceipt(reader: Reader, hash: Hex): Promise<ReceiptInfo | null> {
    const t0 = this.d.clock();
    for (;;) {
      try {
        const r = await reader.receipt(hash);
        if (r) return r;
      } catch {
        /* the node may be catching up: look again */
      }
      if (this.d.clock() - t0 >= RECEIPT_TIMEOUT_MS) return null;
      await this.d.sleep(RECEIPT_POLL_MS);
    }
  }

  /** A mined transaction reverted: replay it against the latest state to find out why. */
  private async explainRevert(p: Prepared, from: Address, hash: Hex): Promise<AppError> {
    try {
      await this.readerFor(p.chain).call(p.to, p.data, { from, value: p.value });
    } catch (e) {
      const err = fromFailure(e, p.revert);
      if (err.kind !== 'unknown') return err;
    }
    return { kind: 'tx-failed', hash };
  }
}
