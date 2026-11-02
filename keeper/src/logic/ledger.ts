// The position index (SPEC-PHASE5-APP §8.2): what each address put into the pool and took out, from the
// pool's own ERC-4626 and tpBEM Transfer events. Pure: the caller does the I/O.
//
// Per address: `net` is signed (+Deposit.assets credited to `owner`, -Withdraw.assets debited from
// `owner`); `xfer` is set on BOTH ends of any tpBEM transfer that is neither a mint nor a burn, because
// tpBEM that moved between wallets makes "value minus net deposited" meaningless; `first` is the time of
// the address's first Deposit (0 = none).

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface AccountRec {
  net: string; // signed decimal, raw BEM
  xfer: boolean;
  first: number; // unix seconds, 0 when the address never deposited
}

export interface IndexState {
  pool: string; // lowercase pool address the index belongs to ("" before deployment)
  cursor: string; // next X Layer block to scan
  time: number; // unix seconds of block `timeBlock`, 0 when unknown
  timeBlock: string; // the block `time` belongs to ("" when unknown)
  accounts: Record<string, AccountRec>; // lowercase address -> record
}

export const emptyIndex = (): IndexState => ({ pool: "", cursor: "0", time: 0, timeBlock: "", accounts: {} });

export type LedgerEvent =
  | { kind: "deposit"; owner: string; assets: bigint; block: bigint }
  | { kind: "withdraw"; owner: string; assets: bigint }
  | { kind: "transfer"; from: string; to: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A decoded log as viem returns it from `getLogs` with the pool's three events. */
export interface RawLog {
  eventName?: string;
  args?: unknown;
  blockNumber?: bigint | null;
}

/** Decode one log; throws on anything unexpected, so a page that cannot be read is never half-applied. */
export function decodeLedgerLog(log: RawLog): LedgerEvent {
  const a = (log.args ?? {}) as Record<string, unknown>;
  const addr = (v: unknown): string => {
    if (typeof v !== "string" || !ADDRESS.test(v)) throw new Error(`bad address in a ${log.eventName} log`);
    return v.toLowerCase();
  };
  const amount = (v: unknown): bigint => {
    if (typeof v !== "bigint" || v < 0n) throw new Error(`bad amount in a ${log.eventName} log`);
    return v;
  };
  switch (log.eventName) {
    case "Deposit":
      if (typeof log.blockNumber !== "bigint") throw new Error("a Deposit log has no block number");
      return { kind: "deposit", owner: addr(a.owner), assets: amount(a.assets), block: log.blockNumber };
    case "Withdraw":
      return { kind: "withdraw", owner: addr(a.owner), assets: amount(a.assets) };
    case "Transfer":
      amount(a.value);
      return { kind: "transfer", from: addr(a.from), to: addr(a.to) };
    default:
      throw new Error(`unexpected log ${String(log.eventName)}`);
  }
}

/** The blocks whose timestamp the page needs: those of deposits that are an address's first. */
export function blocksNeedingTime(state: IndexState, events: readonly LedgerEvent[]): bigint[] {
  const seen = new Set<string>();
  const blocks = new Set<bigint>();
  for (const e of events) {
    if (e.kind !== "deposit" || seen.has(e.owner)) continue;
    seen.add(e.owner);
    if ((state.accounts[e.owner]?.first ?? 0) === 0) blocks.add(e.block);
  }
  return [...blocks];
}

function account(state: IndexState, address: string): AccountRec {
  return (state.accounts[address] ??= { net: "0", xfer: false, first: 0 });
}

/** Apply events in log order. `timeOf` gives a block's timestamp for `blocksNeedingTime`; it must not fail. */
export function applyEvents(state: IndexState, events: readonly LedgerEvent[], timeOf: (block: bigint) => number): void {
  for (const e of events) {
    if (e.kind === "deposit") {
      const rec = account(state, e.owner);
      rec.net = (BigInt(rec.net) + e.assets).toString();
      if (rec.first === 0) rec.first = timeOf(e.block);
    } else if (e.kind === "withdraw") {
      const rec = account(state, e.owner);
      rec.net = (BigInt(rec.net) - e.assets).toString();
    } else if (e.from !== ZERO_ADDRESS && e.to !== ZERO_ADDRESS) {
      account(state, e.from).xfer = true;
      account(state, e.to).xfer = true;
    }
  }
}

const isDigits = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);

/** Read the index section of a state file; anything malformed is dropped (the index rebuilds from the deploy block). */
export function cleanIndex(raw: unknown): IndexState {
  if (typeof raw !== "object" || raw === null) return emptyIndex();
  const r = raw as Partial<IndexState>;
  if (typeof r.pool !== "string" || !isDigits(r.cursor) || typeof r.accounts !== "object" || r.accounts === null) return emptyIndex();
  const accounts: Record<string, AccountRec> = {};
  for (const [k, v] of Object.entries(r.accounts as Record<string, Partial<AccountRec> | null>)) {
    if (!ADDRESS.test(k) || !v || typeof v.net !== "string" || !/^-?\d+$/.test(v.net) || typeof v.xfer !== "boolean") return emptyIndex();
    accounts[k.toLowerCase()] = { net: v.net, xfer: v.xfer, first: typeof v.first === "number" && v.first > 0 ? v.first : 0 };
  }
  const timed = typeof r.time === "number" && r.time > 0 && isDigits(r.timeBlock);
  return { pool: r.pool.toLowerCase(), cursor: r.cursor, time: timed ? (r.time as number) : 0, timeBlock: timed ? (r.timeBlock as string) : "", accounts };
}

/** The `GET /v1/position/<address>` answer for a (lowercase) address; an unseen address reads as zero. */
export function positionBody(state: IndexState, address: string) {
  const rec = state.accounts[address];
  const indexedTo = BigInt(state.cursor) - 1n;
  return {
    netDeposited: rec?.net ?? "0",
    transferred: rec?.xfer ?? false,
    firstDepositAt: rec && rec.first > 0 ? rec.first : null,
    indexedTo: Number(indexedTo),
    // the time of block `indexedTo`, only when it is known for that exact block
    indexedToTime: state.time > 0 && state.timeBlock === indexedTo.toString() ? state.time : null,
  };
}
