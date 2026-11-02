import { decodeFunctionData, encodeFunctionResult, type Abi } from 'viem';
import { multicall3Abi } from '../src/chain/abi';
import type { CallOptions, DecodedLog, Head, Reader, ReceiptInfo, TxInfo, TxPreview } from '../src/chain/reader';
import type { Address, Hex } from '../src/model';

/**
 * A chain in memory for tests: contracts are registered as handlers by function name, `aggregate3` is run for
 * real (each inner call goes to its handler; a missing handler or a throw is a failed call), and every `eth_call`
 * is recorded so tests can assert how many rounds a read took and at which block.
 */

/** Return this from a handler for a call that succeeds with no data (an address without code at that block). */
export const EMPTY = Symbol('empty');

export interface HandlerCtx {
  block: bigint | undefined;
  code: CallOptions['code'];
  /** Set when the call is a transaction preview. */
  from?: Address;
  value?: bigint;
}

export type Handler = (args: readonly unknown[], ctx: HandlerCtx) => unknown;

export interface Recorded {
  to: Address;
  block: bigint | undefined;
  /** Inner calls when the target is Multicall3, else 0. */
  inner: number;
  code: CallOptions['code'];
}

export class FakeChain implements Reader {
  number = 74_000_000n;
  timestamp = 1_800_000_000;
  down = false;
  /** Make a whole request fail (a node error, not a failed inner call). */
  failIf: ((r: Recorded) => boolean) | null = null;
  /** The message of the error `failIf` throws: a node that has not seen a block says "header not found". */
  failWith = 'node error';
  gas = 20_000_000n;
  readonly calls: Recorded[] = [];
  readonly receipts = new Map<string, ReceiptInfo>();
  /** Runtime code by address (lower case) for `getCode`; an address without an entry has none. */
  readonly codes = new Map<string, Hex>();
  /** Gas `estimateGas` answers with; set `gasFails` to make it reject like a reverting transaction. */
  gasUnits = 300_000n;
  gasFails: unknown = null;
  readonly estimates: TxPreview[] = [];
  /** Timestamp of a block other than the head; by default one second per block counted from the head. */
  blockTimes: (n: bigint) => number = (n) => this.timestamp - Number(this.number - n);
  logsHandler: (q: { address: Address; fromBlock: bigint; toBlock: bigint }) => DecodedLog[] = () => [];
  logQueries: { address: Address; fromBlock: bigint; toBlock: bigint }[] = [];
  blockTimeReads: bigint[] = [];
  private readonly contracts = new Map<string, { abi: Abi; handlers: Record<string, Handler> }>();

  constructor(readonly multicall: Address = '0xcA11bde05977b3631167028862bE2a173976CA11') {}

  /** Register `handlers` (by function name) for the contract at `address`. */
  on(address: Address, abi: unknown, handlers: Record<string, Handler | unknown>): this {
    const wrapped: Record<string, Handler> = {};
    for (const [k, v] of Object.entries(handlers)) wrapped[k] = typeof v === 'function' ? (v as Handler) : () => v;
    const key = address.toLowerCase();
    const prev = this.contracts.get(key);
    this.contracts.set(key, { abi: [...(abi as Abi), ...(prev?.abi ?? [])] as Abi, handlers: { ...(prev?.handlers ?? {}), ...wrapped } });
    return this;
  }

  /** Replace one handler of an already registered contract. */
  set(address: Address, fn: string, h: Handler | unknown): this {
    const c = this.contracts.get(address.toLowerCase());
    if (!c) throw new Error(`no contract at ${address}`);
    c.handlers[fn] = typeof h === 'function' ? (h as Handler) : () => h;
    return this;
  }

  rounds(): number {
    return this.calls.length;
  }

  async head(): Promise<Head> {
    if (this.down) throw new Error('node down');
    return { number: this.number, timestamp: this.timestamp };
  }

  async blockTime(n: bigint): Promise<number> {
    if (this.down) throw new Error('node down');
    this.blockTimeReads.push(n);
    return this.blockTimes(n);
  }

  async gasPrice(): Promise<bigint> {
    if (this.down) throw new Error('node down');
    return this.gas;
  }

  async estimateGas(tx: TxPreview): Promise<bigint> {
    if (this.down) throw new Error('node down');
    this.estimates.push(tx);
    if (this.gasFails !== null) throw this.gasFails;
    return this.gasUnits;
  }

  async getCode(address: Address): Promise<Hex> {
    if (this.down) throw new Error('node down');
    return this.codes.get(address.toLowerCase()) ?? '0x';
  }

  async receipt(hash: Hex): Promise<ReceiptInfo | null> {
    if (this.down) throw new Error('node down');
    return this.receipts.get(hash) ?? null;
  }

  /** Storage words by `address:slot`, both lower case. A slot nobody set reads as zero. */
  readonly storage = new Map<string, Hex>();
  storageReads: { address: Address; slot: Hex; block: bigint | undefined }[] = [];
  async storageAt(address: Address, slot: Hex, block?: bigint): Promise<Hex> {
    if (this.down) throw new Error('node down');
    this.storageReads.push({ address, slot, block });
    return this.storage.get(`${address.toLowerCase()}:${slot.toLowerCase()}`) ?? `0x${'00'.repeat(32)}`;
  }

  /** What the node calls finalized: a number, or null for a node that cannot say. */
  finalizedNumber: bigint | null | 'head-2' = 'head-2';
  async finalized(): Promise<bigint | null> {
    if (this.down) throw new Error('node down');
    return this.finalizedNumber === 'head-2' ? this.number - 2n : this.finalizedNumber;
  }

  /** Transactions the node knows, by hash. */
  readonly txs = new Map<string, TxInfo>();
  txReads: Hex[] = [];
  async transaction(hash: Hex): Promise<TxInfo | null> {
    if (this.down) throw new Error('node down');
    this.txReads.push(hash);
    return this.txs.get(hash) ?? null;
  }

  /** Confirmed transaction counts by account (lower case), as a number or a function of the block asked for. */
  readonly nonces = new Map<string, number | ((block: bigint | undefined) => number)>();
  nonceReads: { account: Address; block: bigint | undefined }[] = [];
  async nonceAt(account: Address, block?: bigint): Promise<number> {
    if (this.down) throw new Error('node down');
    this.nonceReads.push({ account, block });
    const n = this.nonces.get(account.toLowerCase());
    return typeof n === 'function' ? n(block) : (n ?? 0);
  }

  async logs(q: { address: Address; events: readonly unknown[]; fromBlock: bigint; toBlock: bigint }): Promise<DecodedLog[]> {
    if (this.down) throw new Error('node down');
    this.logQueries.push({ address: q.address, fromBlock: q.fromBlock, toBlock: q.toBlock });
    return this.logsHandler(q);
  }

  async call(to: Address, data: Hex, o: CallOptions = {}): Promise<Hex> {
    if (this.down) throw new Error('node down');
    if (to.toLowerCase() === this.multicall.toLowerCase()) {
      const dec = decodeFunctionData({ abi: multicall3Abi, data });
      if (dec.functionName === 'aggregate3') {
        const inner = (dec.args as [readonly { target: Address; allowFailure: boolean; callData: Hex }[]])[0];
        const rec = { to, block: o.block, inner: inner.length, code: o.code };
        this.calls.push(rec);
        if (this.failIf?.(rec)) throw new Error(this.failWith);
        const rows = inner.map((c) => {
          try {
            return { success: true, returnData: this.run(c.target, c.callData, o) };
          } catch {
            return { success: false, returnData: '0x' as Hex };
          }
        });
        return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: rows });
      }
    }
    const rec = { to, block: o.block, inner: 0, code: o.code };
    this.calls.push(rec);
    if (this.failIf?.(rec)) throw new Error(this.failWith);
    return this.run(to, data, o);
  }

  private run(to: Address, data: Hex, o: CallOptions): Hex {
    const c = this.contracts.get(to.toLowerCase());
    if (!c) {
      if (o.code && Object.keys(o.code).some((a) => a.toLowerCase() === to.toLowerCase())) throw new Error(`override code at ${to} is not modelled`);
      return '0x'; // no code at the address: the call succeeds with no data
    }
    const dec = decodeFunctionData({ abi: c.abi, data });
    const h = c.handlers[dec.functionName];
    if (!h) throw new Error(`no handler for ${dec.functionName}`);
    const result = h((dec.args ?? []) as readonly unknown[], { block: o.block, code: o.code, from: o.from, value: o.value });
    if (result === EMPTY) return '0x';
    return encodeFunctionResult({ abi: c.abi, functionName: dec.functionName, result } as never);
  }
}
