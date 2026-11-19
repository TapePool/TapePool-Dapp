// The position index (SPEC-PHASE5-APP §8.2): what each address put into the pool and took out, from the
// pool's ERC-4626 and tpBEM Transfer events, plus borrower history from Lent and RepaymentReceived.
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

interface PoolTransaction {
  kind: "supply" | "withdraw" | "borrow" | "repay";
  amount: string;
  hash: string;
  time: number;
}

const HISTORY_LIMIT = 100;

export interface IndexState {
  borrowers: Record<string, string>; // agent -> borrower from Lent
  transactions: Record<string, PoolTransaction[]>; // newest first
  pool: string; // lowercase pool address the index belongs to ("" before deployment)
  cursor: string; // next X Layer block to scan
  time: number; // unix seconds of block `timeBlock`, 0 when unknown
  timeBlock: string; // the block `time` belongs to ("" when unknown)
  accounts: Record<string, AccountRec>; // lowercase address -> record
}

export const emptyIndex = (): IndexState => ({ pool: "", cursor: "0", time: 0, timeBlock: "", accounts: {}, borrowers: {}, transactions: {} });

export type LedgerEvent =
  | ({ block: bigint; hash: string; amount: bigint } & (
      | { kind: "supply" | "withdraw"; owner: string }
      | { kind: "borrow"; agent: string; owner: string }
      | { kind: "repay"; agent: string }
    ))
  | { kind: "transfer"; from: string; to: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A decoded log as viem returns it from `getLogs` for the pool's indexed events. */
export interface RawLog {
  eventName?: string;
  args?: unknown;
  blockNumber?: bigint | null;
  transactionHash?: string | null;
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
  function metadata() {
    if (typeof log.blockNumber !== "bigint" || !log.transactionHash || !/^0x[0-9a-f]{64}$/i.test(log.transactionHash)) {
      throw new Error("missing pool transaction metadata");
    }
    return { block: log.blockNumber, hash: log.transactionHash };
  }
  switch (log.eventName) {
    case "Deposit":
    case "Withdraw":
      return { kind: log.eventName === "Deposit" ? "supply" : "withdraw", owner: addr(a.owner), amount: amount(a.assets), ...metadata() };
    case "Lent":
      return { kind: "borrow", agent: addr(a.agent), owner: addr(a.borrower), amount: amount(a.amount), ...metadata() };
    case "RepaymentReceived":
      return { kind: "repay", agent: addr(a.agent), amount: amount(a.fee) + amount(a.principal), ...metadata() };
    case "Transfer":
      amount(a.value);
      return { kind: "transfer", from: addr(a.from), to: addr(a.to) };
    default:
      throw new Error(`unexpected log ${String(log.eventName)}`);
  }
}

function account(state: IndexState, address: string): AccountRec {
  return (state.accounts[address] ??= { net: "0", xfer: false, first: 0 });
}

/** Resolve all borrowers before committing the page. A loan can open and repay on the same page. */
export function applyEvents(state: IndexState, events: readonly LedgerEvent[], timeOf: (block: bigint) => number): void {
  const newBorrowers: Record<string, string> = {};
  const rows = events.map((e) => {
    if (e.kind === "transfer") return e;
    if (e.kind === "borrow") newBorrowers[e.agent] = e.owner;
    const owner = e.kind === "repay" ? newBorrowers[e.agent] ?? state.borrowers[e.agent] : e.owner;
    if (!owner) throw new Error("repayment without a recorded borrower");
    return { ...e, owner, time: timeOf(e.block) };
  });
  Object.assign(state.borrowers, newBorrowers);
  for (const e of rows) {
    if (e.kind === "transfer") {
      if (e.from !== ZERO_ADDRESS && e.to !== ZERO_ADDRESS) {
        account(state, e.from).xfer = true;
        account(state, e.to).xfer = true;
      }
      continue;
    }
    if (e.kind === "supply" || e.kind === "withdraw") {
      const rec = account(state, e.owner);
      rec.net = (BigInt(rec.net) + (e.kind === "supply" ? e.amount : -e.amount)).toString();
      if (e.kind === "supply" && rec.first === 0) rec.first = e.time;
    }
    const recent = state.transactions[e.owner] ??= [];
    recent.unshift({ kind: e.kind, amount: e.amount.toString(), hash: e.hash, time: e.time });
    if (recent.length > HISTORY_LIMIT) recent.pop();
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
  // Balance-only files replay the public index from deployment to recover prior transactions.
  if (!r.borrowers || !r.transactions || typeof r.borrowers !== "object" || typeof r.transactions !== "object") return emptyIndex();
  for (const [agent, owner] of Object.entries(r.borrowers)) {
    if (!ADDRESS.test(agent) || !ADDRESS.test(owner)) return emptyIndex();
  }
  for (const [owner, rows] of Object.entries(r.transactions)) {
    if (!ADDRESS.test(owner) || !Array.isArray(rows) || rows.length > HISTORY_LIMIT) return emptyIndex();
    if (!rows.every((v) => v && ["supply", "withdraw", "borrow", "repay"].includes(v.kind) &&
        isDigits(v.amount) && /^0x[0-9a-f]{64}$/i.test(v.hash) && Number.isSafeInteger(v.time) && v.time > 0)) return emptyIndex();
  }
  const timed = typeof r.time === "number" && r.time > 0 && isDigits(r.timeBlock);
  return { pool: r.pool.toLowerCase(), cursor: r.cursor, time: timed ? (r.time as number) : 0, timeBlock: timed ? (r.timeBlock as string) : "", accounts, borrowers: r.borrowers, transactions: r.transactions };
}

/** The `GET /v1/position/<address>` answer for a (lowercase) address; an unseen address reads as zero. */
export function positionBody(state: IndexState, address: string) {
  const rec = state.accounts[address];
  const indexedTo = BigInt(state.cursor) - 1n;
  return {
    transactions: state.transactions[address] ?? [],
    netDeposited: rec?.net ?? "0",
    transferred: rec?.xfer ?? false,
    firstDepositAt: rec && rec.first > 0 ? rec.first : null,
    indexedTo: Number(indexedTo),
    // the time of block `indexedTo`, only when it is known for that exact block
    indexedToTime: state.time > 0 && state.timeBlock === indexedTo.toString() ? state.time : null,
  };
}
