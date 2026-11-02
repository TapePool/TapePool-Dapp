import { blocksHarvest, decodeRecord, encodeRecord, mergeForward, unreadableRecord } from '../logic/gates';
import type { KvStore } from '../logic/history';
import type { Address, GateRecord } from '../model';

/**
 * The harvest records of SPEC-PHASE5-PRELOAN §4.4, kept in `localStorage` (through a `KvStore`, whose accesses are all
 * guarded), one value for each chain, wallet and voucher id, so every tab of the app sees the same ones. Reads and writes are
 * synchronous: a write reads the stored record first and applies only what goes forward (`mergeForward`), so two tabs cannot
 * undo each other.
 */
export class GateStore {
  private usable: boolean | null = null;

  constructor(
    private readonly kv: KvStore,
    private readonly chainId: number,
  ) {}

  private key(wallet: Address, id: number): string {
    return `tp:gate:${this.chainId}:${wallet.toLowerCase()}:${id}`;
  }

  /** Can this browser keep the records? A blocked or full `localStorage` cannot, and harvest from here is off then. */
  available(): boolean {
    if (this.usable === null) {
      const probe = `tp:gate:${this.chainId}:probe`;
      this.kv.set(probe, '1');
      this.usable = this.kv.get(probe) === '1';
      this.kv.remove(probe);
    }
    return this.usable;
  }

  /** The record of an id, undefined when there is none. A value that is there and cannot be read stands for a waiting harvest. */
  get(wallet: Address, id: number): GateRecord | undefined {
    const text = this.kv.get(this.key(wallet, id));
    if (text === null) return undefined;
    return decodeRecord(text, id, wallet) ?? unreadableRecord(id, wallet);
  }

  /** The records of these ids, by id. */
  all(wallet: Address, ids: readonly number[]): Record<string, GateRecord> {
    const out: Record<string, GateRecord> = {};
    for (const id of ids) {
      const r = this.get(wallet, id);
      if (r) out[String(id)] = r;
    }
    return out;
  }

  /**
   * Write a record, moving forward only. Returns what is stored now. A voided harvest moved nothing, so a record about a later
   * event supersedes it instead of being held back by it.
   */
  put(rec: GateRecord, o: { vanished?: boolean } = {}): GateRecord {
    const stored = this.get(rec.wallet, rec.id);
    const merged = mergeForward(stored?.state === 'void' && rec.state !== 'void' ? undefined : stored, rec, o);
    this.kv.set(this.key(rec.wallet, rec.id), encodeRecord(merged));
    return merged;
  }

  /**
   * Start a harvest: write its `prompting` record, unless the voucher has one in flight already (in this tab or another).
   * The check and the write are one step, so two tabs cannot both start. Returns false when it was refused.
   */
  begin(rec: GateRecord): boolean {
    const stored = this.get(rec.wallet, rec.id);
    if (stored && blocksHarvest(stored.state)) return false;
    this.kv.set(this.key(rec.wallet, rec.id), encodeRecord(rec));
    return true;
  }

  remove(wallet: Address, id: number): void {
    this.kv.remove(this.key(wallet, id));
  }
}
