import { keccak256 } from 'viem';
import { getAddress, isAddress } from 'viem/utils';
import { MIN_RIG_AGE } from '../constants';
import type { Address, Hex, RigView, ScreenRecord, ScreensView, Sec, Snapshot } from '../model';

/**
 * "Register to borrow" (SPEC-PHASE5-REGISTER): which state line a rig without a working pass shows (§5), and the checks the
 * owner page makes on an artifact's own bytes before it builds `recordPass` (§8.3). Pure: no chain, no clock, no keeper.
 */

/** §5: the state of a rig at §5.2 row 10, 12 (`none`) or 13. The chain decides first, then the keeper's record. */
export type RegisterLine =
  /** S1: a pass is recorded and matches; borrowable at `max(effectiveAt, since + MIN_RIG_AGE)`. */
  | { kind: 'recorded'; at: Sec }
  /** S2: the keeper is unreachable, gave no list, or registration is closed. */
  | { kind: 'closed' }
  /** S3: nothing yet; S10 is `retry`. */
  | { kind: 'register' }
  | { kind: 'queued'; paused: boolean }
  | { kind: 'checking' }
  | { kind: 'passed' }
  | { kind: 'fail'; record: ScreenRecord }
  | { kind: 'revoked' }
  | { kind: 'error'; record: ScreenRecord; retryAt: Sec }
  | { kind: 'retry'; record: ScreenRecord };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The pass on chain is for this rig as BSC describes it (the policy's match), and not suspended. */
function matchingPass(r: RigView): Sec | null {
  const pass = r.facts.screen.pass;
  const b = r.facts.bsc;
  if (!pass || !b || r.facts.screen.suspended) return null;
  if (!same(pass.circuits, b.circuits) || pass.circuitId !== b.circuitId || pass.taskId !== b.taskId) return null;
  return pass.effectiveAt;
}

/** Null for every rig the registration line does not belong to (in an agent, another row, a suspended or changed pass). */
export function registerLine(r: RigView, screens: ScreensView | null | undefined, now: Sec): RegisterLine | null {
  const s = r.state;
  if (r.facts.place.kind !== 'wallet') return null;
  const pending = s.kind === 'screen-pending' || s.kind === 'too-new' || (s.kind === 'not-screened' && s.why === 'none');
  if (!pending) return null;
  const effective = matchingPass(r);
  if (effective !== null) {
    const age = r.facts.bsc ? r.facts.bsc.since + MIN_RIG_AGE : effective;
    return { kind: 'recorded', at: Math.max(effective, age) };
  }
  // a too-new rig whose pass is suspended or changed keeps its age line only
  if (r.facts.screen.pass || r.facts.screen.suspended) return null;
  if (!screens || !screens.open) return { kind: 'closed' };
  const rec = screens.records[String(r.id)];
  if (!rec) return { kind: 'register' };
  switch (rec.status) {
    case 'queued':
      return { kind: 'queued', paused: screens.paused };
    case 'checking':
      return { kind: 'checking' };
    case 'pass':
    case 'recorded':
      return { kind: 'passed' };
    case 'fail':
      return { kind: 'fail', record: rec };
    case 'revoked':
      return { kind: 'revoked' };
    case 'error':
      return rec.retryAt !== null && rec.retryAt > now ? { kind: 'error', record: rec, retryAt: rec.retryAt } : { kind: 'retry', record: rec };
  }
}

/**
 * §8.2: the owner page draws Sign only here. The connected account is `pool.owner()` as read in this refresh, RigScreen
 * belongs to this pool, the queue is not paused, the keeper reports a verified PASS, and the chain has no pass for the rig and
 * no suspension. The action checks all of it again, and the artifact's bytes, before anything is sent.
 */
export function canSign(snap: Snapshot, rec: ScreenRecord): boolean {
  const o = snap.ownerScreens;
  const me = snap.wallet.account;
  if (!o || !o.owner || !me || !same(o.owner, me) || o.registryOk !== true) return false;
  if (!snap.screens || snap.screens.paused) return false;
  if (rec.status !== 'pass' || !rec.artifact?.verified || rec.artifact.verdict !== 'PASS') return false;
  const ch = o.chain[String(rec.rigId)];
  return ch !== null && ch !== undefined && ch.pass === null && !ch.suspended;
}

/** `DELAY` seconds as hours or minutes ("48 h", "90 min"), "0" when it is none; null when unread. */
export function delayParts(sec: Sec | null | undefined): { h: number } | { min: number } | null {
  if (sec === null || sec === undefined || sec < 0) return null;
  return sec % 3_600 === 0 ? { h: sec / 3_600 } : { min: Math.round(sec / 60) };
}

/** Hours and minutes left, `47:12`; never negative. */
export function hhmm(sec: number): string {
  const s = Math.max(0, Math.ceil(sec / 60) * 60);
  const h = Math.floor(s / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

/* ───────── the artifact, as the owner page checks it (§8.3 step 4) ───────── */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/**
 * RFC 8785 canonical text, as `screen/src/jcs.ts` writes artifacts: keys sorted by UTF-16 code units, no whitespace,
 * `JSON.stringify` string escaping. Artifacts hold no JSON numbers, so a number makes the bytes non-canonical.
 */
export function canonicalize(v: Json): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') throw new TypeError('artifacts hold no numbers');
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(v[k] as Json)}`).join(',')}}`;
}

export interface PassArgs {
  rigId: bigint;
  circuits: Address;
  circuitId: bigint;
  taskId: number;
  artifactHash: Hex;
}

const U64 = 2n ** 64n;
const U32 = 2n ** 32n;
const DEC = /^(0|[1-9]\d{0,29})$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The `recordPass` arguments, derived from the artifact's own bytes, or null when anything is off: the hash, the encoding,
 * the canonical form, the verdict, the mode, the rig, and the fields the keeper reported. The owner signs only what this returns.
 */
export function passArgsFrom(bytes: Uint8Array, rigId: number, rec: ScreenRecord): PassArgs | null {
  const a = rec.artifact;
  if (!a || rec.status !== 'pass' || !a.verified || a.verdict !== 'PASS') return null;
  const hash = keccak256(bytes);
  if (hash.toLowerCase() !== a.hash.toLowerCase()) return null;
  let text: string;
  let art: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    art = JSON.parse(text);
    if (canonicalize(art as Json) !== text) return null;
  } catch {
    return null;
  }
  if (!isObj(art) || art.verdict !== 'PASS' || art.mode !== 'A' || !Array.isArray(art.reasons) || art.reasons.length !== 0) return null;
  const rig = art.rig;
  const task = art.task;
  if (!isObj(rig) || !isObj(task) || rig.id !== String(rigId)) return null;
  const { circuits, circuitId } = rig;
  if (typeof circuits !== 'string' || !isAddress(circuits, { strict: false }) || /^0x0{40}$/i.test(circuits)) return null;
  if (typeof circuitId !== 'string' || !DEC.test(circuitId) || BigInt(circuitId) >= U64) return null;
  if (typeof task.id !== 'string' || !DEC.test(task.id) || BigInt(task.id) >= U32) return null;
  const out: PassArgs = { rigId: BigInt(rigId), circuits: getAddress(circuits) as Address, circuitId: BigInt(circuitId), taskId: Number(task.id), artifactHash: hash };
  // what the keeper listed must be exactly what the bytes say
  if (!a.circuits || !same(a.circuits, out.circuits) || a.circuitId !== out.circuitId || a.taskId !== BigInt(out.taskId)) return null;
  return out;
}
