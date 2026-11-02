import { decodeEventLog, getAddress } from 'viem';
import type { AddressBook } from '../config';
import { IMPLEMENTATION_SLOT } from '../constants';
import { advance, encodeRecord, observeDrop, type Upkeep } from '../logic/gates';
import { minedR } from '../logic/harvest';
import type { Address, GateRecord, HarvestPrep, Hex, RigPlace, Sec } from '../model';
import { bscVaultAbi, voucherAbi } from './abi';
import type { GateStore } from './gates';
import { call, multicall } from './multicall';
import type { DecodedLog, Reader, ReceiptInfo } from './reader';

/**
 * The chain side of SPEC-PHASE5-PRELOAN: what a harvest needs from BSC and X Layer, how a harvest's receipt is read, and the
 * upkeep of the harvest records on every refresh (the receipt and the finalized block, a replaced transaction, the payee check
 * after the move, the `Paid` logs). The rules themselves are pure functions in `logic/gates.ts`.
 */

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The address in an ERC-1967 implementation slot; null for an empty slot or a word that is not an address. */
export function slotAddress(word: Hex): Address | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(word) || /^0x0{64}$/.test(word)) return null;
  if (!/^0x0{24}/.test(word)) return null;
  return getAddress(`0x${word.slice(26)}`) as Address;
}

/**
 * Are the vault (BSC) and the voucher (X Layer) the implementations the harvest rules were reviewed against? Anything that
 * cannot be read is "unknown", and a slot that holds anything else is "changed": the TapeOut Safe can upgrade both proxies.
 */
export async function readContracts(x: Reader, b: Reader, book: AddressBook, bscBlock?: bigint): Promise<'ok' | 'changed' | null> {
  const [v, u] = await Promise.allSettled([b.storageAt(book.bscVault, IMPLEMENTATION_SLOT, bscBlock), x.storageAt(book.voucher, IMPLEMENTATION_SLOT)]);
  const vault = v.status === 'fulfilled' ? slotAddress(v.value) : undefined;
  const voucher = u.status === 'fulfilled' ? slotAddress(u.value) : undefined;
  const bad = (found: Address | null | undefined, want: Address): boolean => found !== undefined && (found === null || !same(found, want));
  if (bad(vault, book.implVault) || bad(voucher, book.implVoucher)) return 'changed';
  if (v.status === 'rejected' || u.status === 'rejected') return null;
  return 'ok';
}

/**
 * `voucher.payeeAt(id, time)` for each id: the payee of a harvest sent on BSC at `time`. It is read at the head of X Layer.
 * An entry is null when its read failed.
 */
export async function readPayees(x: Reader, book: AddressBook, ids: readonly number[], time: Sec): Promise<Map<number, Address | null>> {
  const out = new Map<number, Address | null>();
  if (ids.length === 0) return out;
  const head = await x.head();
  const rows = await multicall(x, book.multicall3, ids.map((id) => call<Address>(book.voucher, voucherAbi, 'payeeAt', [BigInt(id), BigInt(time)])), { block: head.number });
  ids.forEach((id, i) => {
    const r = rows[i];
    out.set(id, r?.ok ? r.value : null);
  });
  return out;
}

export interface PrepEnv {
  x: Reader;
  b: Reader;
  book: AddressBook;
}

/**
 * What the harvest action needs, read for the rigs that have BEM to harvest: the vault's price for a batch of each size, the
 * two implementation slots, and, for each rig, whether BSC time has passed the moment the voucher came into the wallet. Null
 * when BSC cannot be read at all. A part that fails is null inside the result and turns the action off with its reason.
 */
export async function readHarvestPrep(env: PrepEnv, wallet: Address, ids: readonly number[], block: bigint): Promise<HarvestPrep | null> {
  const { x, b, book } = env;
  let time: Sec;
  try {
    time = await b.blockTime(block);
  } catch {
    return null;
  }
  const n = Math.min(ids.length, 16);
  const [quotes, contracts, payees] = await Promise.allSettled([
    n === 0 ? Promise.resolve([]) : multicall(b, book.multicall3, Array.from({ length: n }, (_, i) => call<bigint>(book.bscVault, bscVaultAbi, 'quoteHarvest', [BigInt(i + 1)])), { block }),
    readContracts(x, b, book, block),
    readPayees(x, book, ids, time),
  ]);
  const mark: Record<string, boolean | null> = {};
  for (const id of ids) {
    const p = payees.status === 'fulfilled' ? payees.value.get(id) : null;
    mark[String(id)] = p === null || p === undefined ? null : same(p, wallet);
  }
  return {
    block,
    time,
    quotes: quotes.status === 'fulfilled' ? quotes.value.map((q) => (q.ok ? q.value : null)) : Array.from({ length: n }, () => null),
    contracts: contracts.status === 'fulfilled' ? contracts.value : null,
    mark,
  };
}

/**
 * What the vault's `Harvested(guid, ids, packed)` event says each rig was sent: `packed[i] >> 128` is the BEM (raw) for
 * `ids[i]`. Logs of other contracts or events are skipped. A rig the receipt does not name has no entry.
 */
export function harvestedAmounts(receipt: ReceiptInfo, vault: Address): Map<number, bigint> {
  const out = new Map<number, bigint>();
  for (const l of receipt.logs ?? []) {
    if (!same(l.address, vault)) continue;
    try {
      const e = decodeEventLog({ abi: bscVaultAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (e.eventName !== 'Harvested') continue;
      const { ids, packed } = e.args as { ids: readonly bigint[]; packed: readonly bigint[] };
      ids.forEach((id, i) => {
        const p = packed[i];
        if (p !== undefined) out.set(Number(id), p >> 128n);
      });
    } catch {
      /* not a Harvested event */
    }
  }
  return out;
}

/* ───────── the upkeep of the records ───────── */

export interface UpkeepEnv extends PrepEnv {
  gates: GateStore;
}

/** The last read of a rig's harvestable BEM, kept in memory between refreshes: the baseline for a drop. */
export type MinedMemory = Map<number, { block: bigint; mined: bigint }>;

export interface UpkeepInput {
  wallet: Address;
  /** X Layer's head at the start of the refresh. */
  head: { number: bigint; timestamp: Sec };
  /** The BSC block the refresh read the rigs at; null when BSC could not be read. */
  pin: bigint | null;
  places: ReadonlyMap<number, RigPlace>;
  /** Each wallet rig's mined BEM at `pin`; null when unknown. */
  mined: ReadonlyMap<number, bigint | null>;
  memory: MinedMemory;
}

const PAID_PAGE = 100n;
const PAID_PAGES_PER_REFRESH = 5;

/**
 * One refresh of the harvest records (SPEC-PHASE5-PRELOAN §4.4, §4.5). First the drops: a wallet rig whose mined BEM fell
 * between two reads, the second at a higher BSC block, was harvested by someone, and a record is written or raised for it. Then
 * each record takes the steps it is ready for, up to four, reading only what its state needs. Every write goes forward only.
 * Returns the records as they stand.
 */
export async function upkeepGates(env: UpkeepEnv, i: UpkeepInput): Promise<Record<string, GateRecord>> {
  const { x, b, book, gates } = env;
  const ids = [...i.places.keys()];
  if (!gates.available()) return {};

  /* drops */
  let pinTime: Sec | null | undefined;
  const timeOfPin = async (): Promise<Sec | null> => {
    if (pinTime === undefined) {
      try {
        pinTime = i.pin === null ? null : await b.blockTime(i.pin);
      } catch {
        pinTime = null;
      }
    }
    return pinTime;
  };
  if (i.pin !== null) {
    for (const [id, place] of i.places) {
      if (place.kind !== 'wallet') continue;
      const m = i.mined.get(id);
      if (m === null || m === undefined) continue;
      const r = minedR(m);
      const prev = i.memory.get(id);
      const stored = gates.get(i.wallet, id);
      // a record of ours that is still `prompting` knows what the rig held when the harvest was prepared: a drop after a reload
      const base = stored?.state === 'prompting' ? stored.base : null;
      const before = prev && prev.block < i.pin ? prev : base && base.block < i.pin ? { block: base.block, mined: base.mined } : null;
      if (before && r < before.mined) {
        const time = await timeOfPin();
        if (time !== null) {
          const rec = observeDrop(stored, { id, wallet: i.wallet, block: i.pin, time, now: i.head.timestamp });
          if (rec) gates.put(rec);
        }
      }
      // the baseline moves only to a HIGHER block: a lagging node that answers from the same block with another amount must not reset it
      if (!prev || prev.block < i.pin) i.memory.set(id, { block: i.pin, mined: r });
    }
  }

  /* the records */
  const need = { finalized: undefined as bigint | null | undefined, latest: undefined as bigint | null | undefined };
  const chainBsc = async (): Promise<void> => {
    if (need.latest !== undefined) return;
    try {
      need.latest = (await b.head()).number;
    } catch {
      need.latest = null;
    }
    try {
      need.finalized = await b.finalized();
    } catch {
      need.finalized = null;
    }
  };

  for (const id of ids) {
    let rec = gates.get(i.wallet, id);
    for (let step = 0; rec && step < 4; step++) {
      const place = i.places.get(id);
      const u: Upkeep = { now: i.head.timestamp, xlBlock: i.head.number, pin: null, finalized: null, latest: null, agent: place?.kind === 'agent' ? place.agent : null };
      if (i.pin !== null) {
        const t = await timeOfPin();
        if (t !== null) u.pin = { block: i.pin, time: t };
      }
      if (rec.state === 'in-flight' || rec.state === 'mined') await readReceipt(b, book, rec, u, i.wallet);
      if (rec.state === 'mined' || rec.state === 'cautious') {
        await chainBsc();
        u.finalized = need.finalized ?? null;
        u.latest = need.latest ?? null;
      }
      if (rec.state === 'moved' && rec.harvestedAt !== null) {
        try {
          u.payee = (await readPayees(x, book, [id], rec.harvestedAt)).get(id);
        } catch {
          u.payee = undefined;
        }
      }
      if (rec.state === 'payee-mismatch' && rec.agent !== null) u.paid = await scanPaid(x, book, rec, i.head.number);
      const out = advance(rec, u);
      if (out.rec === null) {
        gates.remove(i.wallet, id);
        break;
      }
      if (encodeRecord(out.rec) === encodeRecord(rec)) break;
      const was = rec.state;
      rec = gates.put(out.rec, { vanished: out.vanished });
      // a record that took a step may be ready for the next (final, passed, moved); one that only learned something waits for the next refresh,
      // and a voided one is deleted at the next refresh
      if (rec.state === was || rec.state === 'void') break;
    }
  }
  return gates.all(i.wallet, ids);
}

/** The receipt of the harvest by hash, the time of its block, the amount it sent for this rig, and the nonce from the transaction. */
async function readReceipt(b: Reader, book: AddressBook, rec: GateRecord, u: Upkeep, wallet: Address): Promise<void> {
  if (rec.hash === null) return;
  try {
    const r = await b.receipt(rec.hash);
    if (r === null) {
      u.receipt = null;
    } else {
      let time: Sec | null = null;
      try {
        time = await b.blockTime(r.blockNumber);
      } catch {
        time = null;
      }
      u.receipt = { success: r.success, block: r.blockNumber, time, amount: harvestedAmounts(r, book.bscVault).get(rec.id) ?? null };
    }
  } catch {
    u.receipt = undefined;
  }
  if (rec.nonce === null) {
    try {
      u.txNonce = (await b.transaction(rec.hash))?.nonce ?? null;
    } catch {
      u.txNonce = undefined;
    }
  }
  const nonce = rec.nonce ?? u.txNonce ?? null;
  if (u.receipt === null && nonce !== null && u.pin) {
    try {
      u.nonceAtPin = await b.nonceAt(wallet, u.pin.block);
    } catch {
      u.nonceAtPin = undefined;
    }
  }
}

/**
 * Has the harvest landed in the agent? The voucher's own `Paid(id, to, amount)` log says so (the agent's balance would not:
 * `claimLate` is permissionless and can move it out again). Pages of 100 blocks from the record's cursor; a refresh reads at
 * most a few pages, and the cursor remembers where it got to. Landed means a payment to the agent of at least 90% of what the
 * harvest sent (the bridge fee and rounding lower it), or any payment when the app does not know what was sent.
 */
async function scanPaid(x: Reader, book: AddressBook, rec: GateRecord, head: bigint): Promise<{ next: bigint; landed: boolean } | null> {
  const agent = rec.agent;
  if (agent === null) return null;
  let from = rec.cursor ?? rec.movedBlock ?? head;
  let landed = false;
  try {
    for (let page = 0; page < PAID_PAGES_PER_REFRESH && from <= head && !landed; page++) {
      const to = from + PAID_PAGE - 1n < head ? from + PAID_PAGE - 1n : head;
      const logs = await x.logs({ address: book.voucher, events: voucherAbi.filter((e) => e.type === 'event') as never, fromBlock: from, toBlock: to });
      landed = logs.some((l) => isPaymentFor(l, rec, agent));
      from = to + 1n;
    }
  } catch {
    return null; // look again next refresh, from the same cursor
  }
  return { next: from, landed };
}

function isPaymentFor(l: DecodedLog, rec: GateRecord, agent: Address): boolean {
  if (l.eventName !== 'Paid') return false;
  const a = l.args as { id?: bigint; to?: string; amount?: bigint };
  if (a.id === undefined || Number(a.id) !== rec.id || typeof a.to !== 'string' || !same(a.to, agent) || a.amount === undefined) return false;
  return rec.amount === null ? a.amount > 0n : a.amount * 10n >= rec.amount * 9n;
}
