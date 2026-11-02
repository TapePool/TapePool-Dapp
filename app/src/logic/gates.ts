import { FINAL_LAG, GATE_MARGIN, LANDING_WAIT, PASSED_KEEP, STUCK_AFTER } from '../constants';
import type { Address, GateRecord, GateState, Sec } from '../model';

/**
 * The move gate of SPEC-PHASE5-PRELOAN §4.4, as pure functions.
 *
 * A harvest pays the BEM to `payeeAt(id, T)`, where `T` is the BSC time of the harvest transaction: whoever is the payee at that
 * time, not whoever holds the voucher when the message lands. So after "harvest first", the voucher must not move into the agent
 * until X Layer's clock has passed `T`; if it moved earlier, the harvested BEM would be paid to the agent and would repay the
 * loan, which is the failure this whole feature exists to prevent. One record per voucher id keeps that rule across reloads, tabs
 * and changes of selection. Time here is X Layer chain time, never the browser clock.
 */

/** A harvest the app is still waiting on: its transaction may yet land, and then its time is unknown. */
export const isUnresolved = (s: GateState): boolean => s === 'prompting' || s === 'in-flight' || s === 'mined';

/** An unresolved record, or one that is itself unreadable. A second harvest of the same voucher is never sent while one is. */
export const blocksHarvest = (s: GateState): boolean => isUnresolved(s) || s === 'moved' || s === 'payee-mismatch';

/**
 * May the voucher with this record move now? No record, a voided harvest (it moved nothing) and a voucher that already moved
 * say yes. A `final` or `passed` record says yes once X Layer's head is later than the harvest's BSC time plus the margin; a
 * cautious observation can raise that time, so the clock is checked every time and `passed` is only a label. Everything else says no,
 * and so does a record with no time.
 */
export function gateOpen(rec: GateRecord | undefined, headTime: Sec): boolean {
  if (!rec) return true;
  switch (rec.state) {
    case 'void':
    case 'moved':
      return true;
    case 'final':
    case 'passed':
      return rec.harvestedAt !== null && headTime > rec.harvestedAt + GATE_MARGIN;
    default:
      return false;
  }
}

/** A record that has waited for its harvest for longer than the stuck time since it was written. */
export const isStuck = (rec: GateRecord, now: Sec): boolean => isUnresolved(rec.state) && now - rec.createdAt > STUCK_AFTER;

/** The harvest was paid to the agent and has not been seen landing there for this long. */
export const landingLate = (rec: GateRecord, now: Sec): boolean => rec.state === 'payee-mismatch' && rec.movedAt !== null && now - rec.movedAt > LANDING_WAIT;

/* ───────── the order of states, and writes that only go forward ───────── */

const RANK: Record<GateState, number> = {
  prompting: 0,
  'in-flight': 1,
  cautious: 2,
  mined: 2,
  final: 3,
  void: 3,
  passed: 4,
  moved: 5,
  'payee-mismatch': 6,
};

const maxOf = <T extends number | bigint>(a: T | null, b: T | null): T | null => (a === null ? b : b === null ? a : a > b ? a : b);

/**
 * What a write leaves behind when another tab may have written first (SPEC-PHASE5-PRELOAN §4.4, "Writes from several tabs"):
 * the state only moves forward, and the harvest time only rises. A `mined` record whose receipt vanished may go back to
 * `in-flight`; that is the one step back, and the caller asks for it by name.
 */
export function mergeForward(stored: GateRecord | undefined, next: GateRecord, o: { vanished?: boolean } = {}): GateRecord {
  if (!stored) return next;
  const back = o.vanished === true && stored.state === 'mined' && next.state === 'in-flight';
  if (back) return { ...carry(next, stored), harvestedAt: next.harvestedAt, block: next.block };
  if (RANK[next.state] > RANK[stored.state]) return carry(next, stored);
  // the stored record is as far on as the new one, or further: keep it, with the knowledge that only ever grows
  return carry(stored, next);
}

/** `into` with whatever `from` knows that it does not: a hash, a nonce, an agent; the harvest time, the floor and the cursor only rise. */
function carry(into: GateRecord, from: GateRecord): GateRecord {
  return {
    ...into,
    hash: into.hash ?? from.hash,
    nonce: into.nonce ?? from.nonce,
    amount: into.amount ?? from.amount,
    harvestedAt: maxOf(into.harvestedAt, from.harvestedAt),
    // a receipt included again in a later block takes the time and the block with it; neither goes back
    block: maxOf(into.block, from.block),
    floor: maxOf(into.floor, from.floor),
    base: into.base ?? from.base,
    agent: into.agent ?? from.agent,
    movedBlock: into.movedBlock ?? from.movedBlock,
    cursor: maxOf(into.cursor, from.cursor),
    movedAt: into.movedAt ?? from.movedAt,
  };
}

/* ───────── what the refresh learns, and where it takes a record ───────── */

/** A record for a harvest the app did not send, from a drop of the rig's mined BEM seen between two reads. */
export interface Observation {
  id: number;
  wallet: Address;
  /** The later read's pinned BSC block and its time: an upper bound for any harvest included by then. */
  block: bigint;
  time: Sec;
  /** X Layer chain time of the refresh. */
  now: Sec;
}

/**
 * A rig's mined BEM dropped between two reads, the second at a higher BSC block: someone harvested it (the app did not).
 * A record without a hash is written whose time is that later block's time. A new observation can only raise the time, which
 * closes the gate again until the new time has passed. A `prompting` record has no hash, so a drop turns it into a cautious
 * one. A record that waits for the app's own harvest is never replaced: the observation is only the block its finality must
 * reach, and the harvest's own time stands. A voucher that already moved is left alone.
 */
export function observeDrop(stored: GateRecord | undefined, o: Observation): GateRecord | null {
  const fresh: GateRecord = {
    id: o.id,
    wallet: o.wallet,
    hash: null,
    nonce: null,
    harvestedAt: o.time,
    block: o.block,
    amount: null,
    createdAt: o.now,
    state: 'cautious',
    floor: null,
    base: null,
    agent: null,
    movedBlock: null,
    cursor: null,
    movedAt: null,
  };
  if (!stored || stored.state === 'void') return fresh;
  switch (stored.state) {
    case 'prompting':
      return { ...stored, state: 'cautious', harvestedAt: o.time, block: o.block, base: null };
    case 'in-flight':
    case 'mined':
      return { ...stored, floor: maxOf(stored.floor, o.block) };
    case 'cautious':
      return { ...stored, harvestedAt: maxOf(stored.harvestedAt, o.time), block: maxOf(stored.block, o.block) };
    case 'final':
    case 'passed':
      return { ...stored, harvestedAt: maxOf(stored.harvestedAt, o.time) };
    default:
      return null; // moved, payee-mismatch: nothing to add
  }
}

/** What one refresh read for a record; each part is null when it was not read, or could not be. */
export interface Upkeep {
  /** X Layer chain time and head block of the refresh. */
  now: Sec;
  xlBlock: bigint;
  /** The BSC block the refresh pinned its reads at, and its time. */
  pin: { block: bigint; time: Sec } | null;
  /** BSC `finalized` and `latest`; without a finalized block, `latest - FINAL_LAG` counts as final. */
  finalized: bigint | null;
  latest: bigint | null;
  /** The receipt of the harvest by hash: undefined when the lookup failed, null when the node has none. */
  receipt?: { success: boolean; block: bigint; time: Sec | null; amount: bigint | null } | null;
  /** The transaction by hash: its nonce, when the node knows it. */
  txNonce?: number | null;
  /** The wallet's confirmed BSC nonce at the pinned block. */
  nonceAtPin?: number | null;
  /** Is the voucher in one of the wallet's agents now, and which? */
  agent: Address | null;
  /** `voucher.payeeAt(id, harvestedAt)`: undefined when the read failed. */
  payee?: Address | null;
  /** The `Paid` logs read since the cursor: the next block to read from, and whether the harvest was seen landing in the agent. */
  paid?: { next: bigint; landed: boolean } | null;
}

/** Final enough: the block is finalized, or, when the node cannot say, fifteen blocks deep. */
export function isFinal(block: bigint, finalized: bigint | null, latest: bigint | null): boolean {
  if (finalized !== null) return block <= finalized;
  return latest !== null && block + FINAL_LAG <= latest;
}

export interface Advanced {
  /** The record to write, or null to delete it. */
  rec: GateRecord | null;
  /** The one step back: a `mined` record whose receipt is gone. */
  vanished?: boolean;
}

const same = (a: string | null, b: string | null): boolean => a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/** One step of the state machine of §4.4 for a record, from what the refresh read. */
export function advance(rec: GateRecord, u: Upkeep): Advanced {
  switch (rec.state) {
    case 'prompting':
      return { rec };
    case 'void':
      return { rec: null };
    case 'in-flight': {
      let r = rec;
      // the nonce comes from the transaction itself; with it unknown a replacement is never inferred
      if (r.nonce === null && u.txNonce != null) r = { ...r, nonce: u.txNonce };
      if (u.receipt) {
        if (!u.receipt.success) return { rec: { ...r, state: 'void' } };
        return { rec: { ...r, state: 'mined', block: u.receipt.block, harvestedAt: u.receipt.time, amount: u.receipt.amount ?? r.amount } };
      }
      if (u.receipt === null && r.nonce !== null && u.pin && u.nonceAtPin != null && u.nonceAtPin > r.nonce) {
        // sped up or cancelled: some other transaction took the nonce. Whatever it was, its time is no later than the pinned block's
        return { rec: { ...r, state: 'cautious', harvestedAt: u.pin.time, block: u.pin.block } };
      }
      return { rec: r };
    }
    case 'mined': {
      if (u.receipt === null) return { rec: { ...rec, state: 'in-flight', block: null, harvestedAt: null }, vanished: true };
      let r = rec;
      if (u.receipt) {
        if (!u.receipt.success) return { rec: { ...r, state: 'void' } };
        // included again in another block: the time and the block follow it
        if (u.receipt.block !== r.block || (u.receipt.time !== null && u.receipt.time !== r.harvestedAt)) {
          r = { ...r, block: u.receipt.block, harvestedAt: u.receipt.time ?? r.harvestedAt, amount: u.receipt.amount ?? r.amount };
        }
      }
      return { rec: becomesFinal(r, u) };
    }
    case 'cautious':
      return { rec: becomesFinal(rec, u) };
    case 'final':
    case 'passed': {
      const r = passes(rec, u);
      // the voucher is in an agent now: §4.5 checks who the harvest's time made the payee. A voucher that moved before the gate
      // opened (not through this app) is checked the same way: the harvest's time is final.
      if (u.agent !== null) {
        return { rec: { ...r, state: 'moved', agent: u.agent, movedBlock: r.movedBlock ?? u.xlBlock, cursor: r.cursor ?? r.movedBlock ?? u.xlBlock, movedAt: u.now } };
      }
      if (r.state === 'passed' && r.harvestedAt !== null && u.now > r.harvestedAt + PASSED_KEEP) return { rec: null };
      return { rec: r };
    }
    case 'moved': {
      // §4.5: who does the harvest's time say was the payee?
      if (u.payee === undefined) return { rec }; // the read failed: look again next time
      if (same(u.payee, rec.wallet)) return { rec: null };
      return { rec: { ...rec, state: 'payee-mismatch', agent: u.agent ?? rec.agent } };
    }
    case 'payee-mismatch': {
      if (u.paid?.landed) return { rec: null };
      return { rec: u.paid ? { ...rec, cursor: u.paid.next } : rec };
    }
  }
}

/** `mined` or `cautious` becomes `final` once its block is final, and so is the block of any cautious observation made meanwhile. */
function becomesFinal(rec: GateRecord, u: Upkeep): GateRecord {
  if (rec.block === null || rec.harvestedAt === null) return rec;
  if (!isFinal(rec.block, u.finalized, u.latest)) return rec;
  if (rec.floor !== null && !isFinal(rec.floor, u.finalized, u.latest)) return rec;
  return { ...rec, state: 'final' };
}

/** `final` becomes `passed` once X Layer's head is later than the harvest's time plus the margin. */
function passes(rec: GateRecord, u: Upkeep): GateRecord {
  if (rec.state === 'final' && rec.harvestedAt !== null && u.now > rec.harvestedAt + GATE_MARGIN) return { ...rec, state: 'passed' };
  return rec;
}

/* ───────── storage ───────── */

/** A bigint is written as its digits and an `n` ("1234n"), the way the history cache does, and read back as one. */
export const encodeRecord = (r: GateRecord): string => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));

const STATES: readonly GateState[] = ['prompting', 'in-flight', 'mined', 'cautious', 'final', 'passed', 'moved', 'payee-mismatch', 'void'];
const hex = (n: number) => (v: unknown): boolean => v === null || (typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${n}}$`).test(v));
const uint = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
const big = (v: unknown): boolean => v === null || typeof v === 'bigint';

/**
 * A record from its text. Null when the text is not a record of this id and wallet. A stored value is untrusted like any
 * other input: every field is checked (a missing one is as bad as a wrong one), and a bad record is the caller's problem, not an error.
 */
export function decodeRecord(text: string | null, id: number, wallet: Address): GateRecord | null {
  if (text === null) return null;
  try {
    const r = JSON.parse(text, (_k, v) => (typeof v === 'string' && /^\d{1,30}n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as GateRecord | null;
    if (typeof r !== 'object' || r === null || r.id !== id || typeof r.wallet !== 'string' || r.wallet.toLowerCase() !== wallet.toLowerCase()) return null;
    const base = r.base;
    const fine =
      STATES.includes(r.state) &&
      hex(64)(r.hash) &&
      hex(40)(r.agent) &&
      [r.nonce, r.harvestedAt, r.createdAt, r.movedAt].every(uint) &&
      r.createdAt !== null &&
      [r.block, r.amount, r.floor, r.movedBlock, r.cursor].every(big) &&
      (base === null || (typeof base === 'object' && typeof base.block === 'bigint' && typeof base.mined === 'bigint'));
    return fine ? { ...r, wallet } : null;
  } catch {
    return null;
  }
}

/**
 * What a record that exists but cannot be read stands for: a harvest that is waiting, written long ago. The gate fails closed
 * on it, and after the stuck time the screen offers the explicit "Move anyway".
 */
export function unreadableRecord(id: number, wallet: Address): GateRecord {
  return { id, wallet, hash: null, nonce: null, harvestedAt: null, block: null, amount: null, createdAt: 0, state: 'prompting', floor: null, base: null, agent: null, movedBlock: null, cursor: null, movedAt: null };
}

/** A new `prompting` record: written before the wallet is asked. */
export function promptingRecord(id: number, wallet: Address, now: Sec, base: GateRecord['base']): GateRecord {
  return { ...unreadableRecord(id, wallet), createdAt: now, base };
}
