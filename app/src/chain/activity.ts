import type { AddressBook } from '../config';
import type { Address, PoolTransaction, Snapshot } from '../model';
import type { KvStore } from '../logic/history';
import { parseTransactions } from './keeper';
import type { DecodedLog, Reader } from './reader';
import { activityEvents } from './activityEvents';
import index from './activityBlocks.json';

interface Checkpoint {
  through: bigint;
  rows: PoolTransaction[];
}

function operation(log: DecodedLog, wallet: string, agents: Set<string>) {
  const { args, eventName } = log;
  const owned = (address: unknown) => typeof address === 'string' && address.toLowerCase() === wallet;
  if (eventName === 'Deposit' || eventName === 'Withdraw') {
    if (owned(args.owner) && typeof args.assets === 'bigint') return { kind: eventName === 'Deposit' ? 'supply' : 'withdraw', amount: args.assets } as const;
  } else if (eventName === 'Lent') {
    if (owned(args.borrower) && typeof args.amount === 'bigint') return { kind: 'borrow', amount: args.amount } as const;
  } else if (eventName === 'RepaymentReceived' && typeof args.agent === 'string' && agents.has(args.agent.toLowerCase())) {
    if (typeof args.fee === 'bigint' && typeof args.principal === 'bigint') return { kind: 'repay', amount: args.fee + args.principal } as const;
  }
}

/** A wallet's confirmed pool events. Only fully covered ranges advance the saved cursor. */
export class WalletActivity {
  view: Snapshot['transactions'] = { rows: [], syncing: true };
  private saved?: Checkpoint;
  private busy = false;
  private readonly key: string;

  constructor(private readonly book: AddressBook, private readonly wallet: Address, private readonly store: KvStore) {
    this.key = `tp:activity:1:${book.network}:${book.chainId}:${book.pool.toLowerCase()}:${wallet.toLowerCase()}`;
  }

  private restore(head: bigint): Checkpoint {
    try {
      const cache = JSON.parse(this.store.get(this.key) ?? 'null');
      const rows = parseTransactions(cache?.rows);
      if (rows && Number.isSafeInteger(cache.through)) {
        const through = BigInt(cache.through);
        if (through >= this.book.poolDeployBlock && through <= head) return { through, rows };
      }
    } catch { /* incomplete browser storage: start again from the pool's deployment */ }
    return { through: this.book.poolDeployBlock - 1n, rows: [] };
  }

  async refresh(reader: Pick<Reader, 'logs' | 'blockTime'>, head: bigint, ownersAgents: readonly Address[], pageSize: bigint, active: () => boolean, notify: () => void): Promise<void> {
    if (this.busy || !active()) return;
    this.busy = true;
    const agents = new Set(ownersAgents.map(a => a.toLowerCase()));
    const wallet = this.wallet.toLowerCase();
    const times = new Map<bigint, number>();
    const page = async (fromBlock: bigint, toBlock: bigint): Promise<PoolTransaction[]> => {
      const logs = await reader.logs({ address: this.book.pool, events: activityEvents, fromBlock, toBlock });
      const rows: PoolTransaction[] = [];
      for (const log of logs.reverse()) {
        const tx = operation(log, wallet, agents);
        if (!tx) continue;
        if (!active()) return [];
        if (!times.has(log.blockNumber)) times.set(log.blockNumber, await reader.blockTime(log.blockNumber));
        rows.push({ ...tx, hash: log.transactionHash, time: times.get(log.blockNumber)! });
      }
      return rows;
    };
    const publish = (rows: PoolTransaction[], syncing: boolean) => {
      this.view = { rows: rows.slice(0, 100), syncing };
      notify();
    };
    const commit = (through: bigint, rows: PoolTransaction[]) => {
      this.saved = { through, rows: rows.slice(0, 100) };
      this.store.set(this.key, JSON.stringify({ through: Number(through), rows: this.saved.rows }, (_, v) => typeof v === 'bigint' ? v.toString() : v));
    };
    try {
      if (!this.saved || this.saved.through > head) {
        this.saved = this.restore(head);
        if (this.saved.rows.length) publish(this.saved.rows, this.saved.through < head);
      }
      // The compact index contains block numbers only. Read the actual logs, including third-party repayments.
      if (this.book.network !== 'fork' && index.pool.toLowerCase() === this.book.pool.toLowerCase() &&
          BigInt(index.start) === this.book.poolDeployBlock && this.saved.through < BigInt(index.through) && BigInt(index.through) <= head) {
        const found: PoolTransaction[] = [];
        for (const n of index.blocks.slice().reverse()) {
          if (BigInt(n) <= this.saved.through || found.length >= 100) break;
          found.push(...await page(BigInt(n), BigInt(n)));
          if (!active()) return;
          if (found.length) publish([...found, ...this.saved.rows], true);
        }
        commit(BigInt(index.through), [...found, ...this.saved.rows]);
      }
      const base = this.saved;
      const found: PoolTransaction[] = [];
      for (let end = head; end > base.through && found.length < 100;) {
        const start = end - pageSize + 1n > base.through ? end - pageSize + 1n : base.through + 1n;
        const rows = await page(start, end);
        if (!active()) return;
        found.push(...rows);
        if (rows.length) publish([...found, ...base.rows], true);
        end = start - 1n;
      }
      if (!active()) return;
      if (head > base.through) commit(head, [...found, ...base.rows]);
      publish(this.saved.rows, false);
    } catch {
      if (active()) {
        const rows = this.view?.rows.length ? this.view.rows : this.saved?.rows;
        this.view = rows?.length ? { rows, syncing: true } : undefined;
        notify();
      }
    } finally {
      this.busy = false;
    }
  }
}
