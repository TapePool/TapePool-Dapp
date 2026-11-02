// Share-price snapshots and the 7-day APY (SPEC-PHASE5-APP §8.1). Pure: no I/O.
//
// The share price is `convertToAssets(10^14)`: raw BEM units (8 decimals) per whole tpBEM (14 decimals).
// All amounts stay `bigint` here and decimal strings in the state file and in the HTTP answers.

export const SECONDS_PER_DAY = 86_400;
export const YEAR_SECONDS = 365 * SECONDS_PER_DAY;
/** Daily snapshots kept in the state. */
export const KEEP_SNAPSHOTS = 60;
/** The APY looks back about 7 days and never uses a snapshot younger than 6 days. */
export const APY_TARGET_AGE = 7 * SECONDS_PER_DAY;
export const APY_MIN_AGE = 6 * SECONDS_PER_DAY;
/** One whole tpBEM in raw units (14 decimals). */
export const ONE_SHARE = 10n ** 14n;

/** The share price at the first block of a UTC day. Amounts are decimal strings. */
export interface Snapshot {
  day: number; // UTC day number, floor(unix seconds / 86400)
  block: string;
  time: number; // unix seconds of that block
  price: string; // convertToAssets(10^14)
}

export interface StatsState {
  pool: string; // lowercase pool address the snapshots belong to ("" before deployment)
  nextDay: number; // the next UTC day to snapshot (days skipped for lack of a block are behind it)
  snapshots: Snapshot[]; // ascending by day, at most KEEP_SNAPSHOTS
}

export const emptyStats = (): StatsState => ({ pool: "", nextDay: 0, snapshots: [] });

export const dayOf = (unixSeconds: number): number => Math.floor(unixSeconds / SECONDS_PER_DAY);
/** "2026-10-21" for a UTC day number. */
export const dayLabel = (day: number): string => new Date(day * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10);

const isDigits = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Read the stats section of a state file; anything malformed is dropped (a rebuild is always safe). */
export function cleanStats(raw: unknown): StatsState {
  if (typeof raw !== "object" || raw === null) return emptyStats();
  const r = raw as Partial<StatsState>;
  if (typeof r.pool !== "string" || !isCount(r.nextDay) || !Array.isArray(r.snapshots)) return emptyStats();
  const byDay = new Map<number, Snapshot>();
  for (const s of r.snapshots as unknown[]) {
    const x = s as Partial<Snapshot> | null;
    if (x && isCount(x.day) && isDigits(x.block) && isCount(x.time) && isDigits(x.price)) {
      byDay.set(x.day, { day: x.day, block: x.block, time: x.time, price: x.price });
    }
  }
  const snapshots = [...byDay.values()].sort((a, b) => a.day - b.day).slice(-KEEP_SNAPSHOTS);
  return { pool: r.pool.toLowerCase(), nextDay: r.nextDay, snapshots };
}

/**
 * The snapshot the APY compares against: at least 6 days older than `nowTs`, and of those the one closest
 * to `nowTs - 7 days`. On a tie the older one wins (the longer window). Null when none qualifies.
 */
export function pickThen(snapshots: readonly Snapshot[], nowTs: number): Snapshot | null {
  const target = nowTs - APY_TARGET_AGE;
  let best: Snapshot | null = null;
  let bestDistance = Infinity;
  for (const s of snapshots) {
    if (nowTs - s.time < APY_MIN_AGE) continue;
    const distance = Math.abs(s.time - target);
    if (distance < bestDistance || (distance === bestDistance && best !== null && s.time < best.time)) {
      best = s;
      bestDistance = distance;
    }
  }
  return best;
}

// ───────────────────────── fixed-point power

/**
 * `(pNow / pThen) ^ (365 d / dt) - 1` with the exponent a rational, so no floating point is involved.
 *
 * It is computed in 36-digit fixed point (`SCALE = 10^36`) as `exp(ln(r) * 31,536,000 / dt)`:
 * - `ln(r)`: shift `r` into [1, 2) by powers of two (`r = m * 2^k`), then `ln(m) = 2 * atanh((m-1)/(m+1))`
 *   by its series (the argument is at most 1/3, so about 40 terms reach 10^-36), and add `k * ln 2`;
 * - `exp(y)`: write `y = k * ln 2 + f` with `|f| < ln 2`, sum the Taylor series of `f`, shift by `k`.
 * Every division truncates, so the whole result is off by a few 10^-36 at most, far below the 6 decimals
 * that are returned. The answer is a fraction (0.1 is 10% a year), may be negative, and is rounded half
 * up to 6 decimals. Null when an input is not positive or the result is absurdly large.
 */
const SCALE = 10n ** 36n;

/** ln(x) for a fixed-point x in [SCALE, 2 * SCALE]. */
function lnUnit(x: bigint): bigint {
  const z = ((x - SCALE) * SCALE) / (x + SCALE);
  const z2 = (z * z) / SCALE;
  let term = z;
  let sum = 0n;
  for (let n = 1n; term !== 0n; n += 2n) {
    sum += term / n;
    term = (term * z2) / SCALE;
  }
  return 2n * sum;
}

const LN2 = lnUnit(2n * SCALE);

/** ln(num / den) in fixed point, or null when the ratio is out of range. */
function lnRatio(num: bigint, den: bigint): bigint | null {
  let x = (num * SCALE) / den;
  if (x === 0n) return null;
  let k = 0n;
  while (x >= 2n * SCALE) {
    x >>= 1n;
    k++;
  }
  while (x < SCALE) {
    x <<= 1n;
    k--;
  }
  return k * LN2 + lnUnit(x);
}

/** exp(y) for a fixed-point y; null when the result would exceed 2^1000. */
function expFixed(y: bigint): bigint | null {
  const k = y / LN2; // truncates toward zero
  const f = y - k * LN2;
  let term = SCALE;
  let sum = SCALE;
  for (let n = 1n; term !== 0n; n++) {
    term = (term * f) / (SCALE * n);
    sum += term;
  }
  if (k > 1_000n) return null;
  return k >= 0n ? sum << k : sum >> -k;
}

/** A fixed-point value as a decimal string with 6 decimals, rounded half up in absolute value. */
function format6(v: bigint): string {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const q = (abs * 1_000_000n + SCALE / 2n) / SCALE;
  const frac = (q % 1_000_000n).toString().padStart(6, "0");
  return `${negative && q !== 0n ? "-" : ""}${q / 1_000_000n}.${frac}`;
}

/** `(pNow / pThen)^(365 d / dtSeconds) - 1` as a 6-decimal string (see the notes above), or null. */
export function annualise(pNow: bigint, pThen: bigint, dtSeconds: number): string | null {
  if (pNow <= 0n || pThen <= 0n || !Number.isSafeInteger(dtSeconds) || dtSeconds <= 0) return null;
  const ln = lnRatio(pNow, pThen);
  if (ln === null) return null;
  const grown = expFixed((ln * BigInt(YEAR_SECONDS)) / BigInt(dtSeconds));
  return grown === null ? null : format6(grown - SCALE);
}

/**
 * The 7-day APY at `nowTs` (the time of the block `pNow` was read at): the share price against the
 * snapshot `pickThen` chooses, annualised over the real time between the two blocks. Null when no
 * snapshot is at least 6 days old.
 */
export function apy7d(pNow: bigint, nowTs: number, snapshots: readonly Snapshot[]): string | null {
  const then = pickThen(snapshots, nowTs);
  return then === null ? null : annualise(pNow, BigInt(then.price), nowTs - then.time);
}
