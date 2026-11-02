import { createClient, custom, numberToHex, type AbiEvent, type Client } from 'viem';
import { getBlock, getGasPrice, getLogs, getTransactionReceipt } from 'viem/actions';
import type { Address, Hex, Sec } from '../model';
import type { RpcRequest } from './rpc';

/** A decoded log. `args` is whatever the event's ABI says; the caller knows which event it asked for. */
export interface DecodedLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hex;
}

export interface Head {
  number: bigint;
  /** Unix seconds. The chain's time: every rule in the app is measured against it. */
  timestamp: Sec;
}

export interface CallOptions {
  /** Read state at this block; the latest block when absent. */
  block?: bigint;
  /** Place runtime code at addresses for this call only. */
  code?: Record<string, Hex>;
  /** Simulate as this sender (a transaction preview); absent for plain reads. */
  from?: Address;
  /** Wei sent with the simulated call. */
  value?: bigint;
}

/** A transaction as the app previews it before the wallet is asked. */
export interface TxPreview {
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
}

/** A raw log of a receipt, not decoded. */
export interface ReceiptLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
}

export interface ReceiptInfo {
  success: boolean;
  blockNumber: bigint;
  gasUsed?: bigint;
  /** Absent in tests that only care about the outcome. */
  logs?: readonly ReceiptLog[];
}

/** A transaction the node knows, as far as the app needs it: whose count it is and where it was mined. */
export interface TxInfo {
  nonce: number;
  /** Null while it is only in the pool. */
  blockNumber: bigint | null;
}

/**
 * The read-only chain access the app needs, small enough to fake in tests.
 * An error thrown by `call` carries a revert; a node that is down throws too, and the caller keeps its old value.
 */
export interface Reader {
  head(): Promise<Head>;
  call(to: Address, data: Hex, o?: CallOptions): Promise<Hex>;
  /** Gas a transaction would use, as the node estimates it. Rejects with the revert when the transaction would fail. */
  estimateGas(tx: TxPreview): Promise<bigint>;
  /** The code at an address; `0x` when there is none. */
  getCode(address: Address): Promise<Hex>;
  blockTime(number: bigint): Promise<Sec>;
  logs(q: { address: Address; events: readonly AbiEvent[]; fromBlock: bigint; toBlock: bigint }): Promise<DecodedLog[]>;
  gasPrice(): Promise<bigint>;
  /** Null while the transaction is not mined. */
  receipt(hash: Hex): Promise<ReceiptInfo | null>;
  /** The word at a storage slot (an ERC-1967 implementation slot, say), at a block or the latest. */
  storageAt(address: Address, slot: Hex, block?: bigint): Promise<Hex>;
  /** The number of the block the node calls finalized; null when it has none or cannot say. */
  finalized(): Promise<bigint | null>;
  /** A transaction by its hash; null while the node does not know it. */
  transaction(hash: Hex): Promise<TxInfo | null>;
  /** An account's confirmed transaction count (its next nonce) at a block, or the latest. */
  nonceAt(account: Address, block?: bigint): Promise<number>;
}

const hex = (n: bigint): Hex => numberToHex(n);

/** A `Reader` over a viem client. Only the individual actions are imported, so unused ones stay out of the bundle. */
export function viemReader(request: RpcRequest, name: string): Reader {
  const client: Client = createClient({ name, key: name, transport: custom({ request: request as never }, { retryCount: 0 }) });
  const txObject = (tx: TxPreview): Record<string, string> => {
    const o: Record<string, string> = { from: tx.from, to: tx.to, data: tx.data };
    if (tx.value !== undefined && tx.value > 0n) o.value = hex(tx.value);
    return o;
  };
  return {
    async head() {
      const b = await getBlock(client, { blockTag: 'latest' });
      return { number: b.number, timestamp: Number(b.timestamp) };
    },
    // `request` is called directly, not through the viem client, so a revert reaches the caller as the node sent it
    // (an `RpcError` with its `data`) and not wrapped in a viem error
    async call(to, data, o = {}) {
      const tx: Record<string, string> = { to, data };
      if (o.from) tx.from = o.from;
      if (o.value !== undefined && o.value > 0n) tx.value = hex(o.value);
      const params: unknown[] = [tx, o.block === undefined ? 'latest' : hex(o.block)];
      if (o.code) params.push(Object.fromEntries(Object.entries(o.code).map(([a, code]) => [a, { code }])));
      return (await request({ method: 'eth_call', params })) as Hex;
    },
    async estimateGas(tx) {
      return BigInt((await request({ method: 'eth_estimateGas', params: [txObject(tx)] })) as string);
    },
    async getCode(address) {
      return (await request({ method: 'eth_getCode', params: [address, 'latest'] })) as Hex;
    },
    async blockTime(number) {
      const b = await getBlock(client, { blockNumber: number });
      return Number(b.timestamp);
    },
    async logs(q) {
      const logs = await getLogs(client, { address: q.address, events: q.events, fromBlock: q.fromBlock, toBlock: q.toBlock, strict: true });
      return logs.map((l) => ({
        eventName: (l as { eventName: string }).eventName,
        args: (l as { args: Record<string, unknown> }).args,
        blockNumber: l.blockNumber,
        transactionHash: l.transactionHash,
      }));
    },
    gasPrice: () => getGasPrice(client),
    async storageAt(address, slot, block) {
      return (await request({ method: 'eth_getStorageAt', params: [address, slot, block === undefined ? 'latest' : hex(block)] })) as Hex;
    },
    async finalized() {
      try {
        return (await getBlock(client, { blockTag: 'finalized' })).number;
      } catch {
        return null; // a node without the tag, or one that cannot answer: the caller falls back to a depth
      }
    },
    async transaction(hash) {
      const t = (await request({ method: 'eth_getTransactionByHash', params: [hash] })) as { nonce?: unknown; blockNumber?: unknown } | null;
      if (!t || typeof t.nonce !== 'string') return null;
      return { nonce: Number(BigInt(t.nonce)), blockNumber: typeof t.blockNumber === 'string' ? BigInt(t.blockNumber) : null };
    },
    async nonceAt(account, block) {
      return Number(BigInt((await request({ method: 'eth_getTransactionCount', params: [account, block === undefined ? 'latest' : hex(block)] })) as string));
    },
    async receipt(hash) {
      try {
        const r = await getTransactionReceipt(client, { hash });
        return {
          success: r.status === 'success',
          blockNumber: r.blockNumber,
          gasUsed: r.gasUsed,
          logs: r.logs.map((l) => ({ address: l.address, topics: l.topics as readonly Hex[], data: l.data })),
        };
      } catch (e) {
        if (e instanceof Error && e.name === 'TransactionReceiptNotFoundError') return null;
        throw e;
      }
    },
  };
}
