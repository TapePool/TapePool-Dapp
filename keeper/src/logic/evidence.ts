// The keeper's mirror of SPEC-REDEPLOY-3 R3-00, the only definition of when a report or a voucher record counts.
// `evidenceKind` follows RigAgent._impairment (flagImpaired, seize) and `clearReading` follows RigAgent._verdict
// (clearExpiredFlag), branch for branch; test/redeploy3.test.ts runs every ParityVectors evidence vector through
// both. The rest of the keeper plans flags, seizes and clears only through these two functions.
import type { RigCondition } from "./confirm.js";

export const MAX_REPORT_AGE = 300;
export const MAX_CLOCK_SKEW = 60;
/** TapePool.FEED_SETTLE: `lend` reverts `FeedSettling()` this long after `enableFeed` (R3-01). */
export const FEED_SETTLE = 360;
/** RB3-03: margin for the clock difference between BSC and X Layer on top of the enable floor. */
export const ENABLE_PUSH_MARGIN = 30;
/** A stored report counts as the answer to a push if observed at most this long before the keeper's send time (clock skew). */
export const LANDED_SLACK = 60;
/** A push not stored after this long has not landed (SPEC-PHASE3-KEEPER §4.6). */
export const PUSH_LANDING = 600;

export interface Report {
  rigId: bigint;
  observedAt: bigint;
  status: number;
  stopBlock: bigint;
  custodied: boolean;
  verifWeight: bigint;
  bonus: bigint;
  totalVerifWeight: bigint;
}

export interface VoucherRecord { syncedAt: number; power: bigint }
export type Verdict = "healthy" | "impaired" | "missing";
/** 0 no evidence, 1 row E (report), 2 row VE (voucher record): `ImpairmentFlagged.evidenceKind`. */
export type Kind = 0 | 1 | 2;
/** The row that decided a clear reading; null when there is no candidate. */
export type ClearRow = "H" | "B" | "U" | "VC" | null;

/** The pool's feed state (R3-01): `feedDisabled()` and `feedEnabledAt()`, 0 before the first `enableFeed`. */
export interface FeedView { disabled: boolean; enabledAt: number }
export const NO_BRAKE: FeedView = { disabled: false, enabledAt: 0 };

/** R3-00 `enableFloor = feedEnabledAt + MAX_CLOCK_SKEW`. */
export const enableFloor = (f: FeedView): number => f.enabledAt + MAX_CLOCK_SKEW;

/**
 * RB3-03 timing rule: a push sent now lands at or after the enable floor, so X Layer time must be at least
 * `feedEnabledAt + MAX_CLOCK_SKEW + 30 s`. An unreadable X Layer time (null) fails closed.
 */
export const pushOpen = (f: FeedView, xlayerNow: number | null): boolean =>
  f.enabledAt === 0 || (xlayerNow !== null && xlayerNow >= f.enabledAt + MAX_CLOCK_SKEW + ENABLE_PUSH_MARGIN);

const SKEW = BigInt(MAX_CLOCK_SKEW);
const AGE = BigInt(MAX_REPORT_AGE);
const big = (n: number | bigint): bigint => (typeof n === "bigint" ? n : BigInt(Math.floor(n)));

/** R3-00 impaired(r): not active, stopped, not in custody, or no base power. */
export const impaired = (r: Report): boolean => r.status !== 1 || r.stopBlock !== 0n || !r.custodied || r.verifWeight <= r.bonus;
/** R3-00 sane(r). */
export const sane = (r: Report): boolean => r.verifWeight !== 0n && r.verifWeight <= r.totalVerifWeight && r.bonus <= r.verifWeight;

/**
 * R3-00 base(r). `null` and `undefined` are a report with `ok == false` (an empty slot or a reverting feed); the
 * planner decides separately that a failed RPC read is never planned on.
 */
function base(r: Report | null | undefined, id: bigint, feed: FeedView, now: bigint): r is Report {
  return !!r && !feed.disabled && r.rigId === id && r.observedAt <= now + SKEW;
}

const fresh = (r: Report, now: bigint): boolean => now <= r.observedAt + AGE;

/** R3-00 known: the record was read, and is not dated more than `MAX_CLOCK_SKEW` ahead (R3-03). */
export function known(rec: VoucherRecord | undefined, now: number | bigint): rec is VoucherRecord {
  return rec !== undefined && BigInt(rec.syncedAt) <= big(now) + SKEW;
}

/**
 * Flag or seize evidence for rig `id` against the caller's floor (`flagEvidenceFrom()` or `seizeEvidenceFrom()`),
 * as `RigAgent._impairment`. Row E (kind 1, first): base(r), observed at or after the enable floor and `floor`,
 * fresh and impaired. Row VE (kind 2): a known power-0 record synced at or after `floor`, unless row S holds: a
 * sane healthy report with base(r) at or after the enable floor and strictly newer than the record, of any age.
 */
export function evidenceKind(
  id: bigint,
  floor: number | bigint,
  now: number | bigint,
  feed: FeedView,
  report: Report | null | undefined,
  record: VoucherRecord | undefined,
): Kind {
  const N = big(now), F = big(floor), ef = big(enableFloor(feed));
  let healthyAt = 0n; // row S, 0 if none: the enable floor is at least MAX_CLOCK_SKEW, so a shield is never 0
  if (base(report, id, feed, N) && report.observedAt >= ef) {
    if (impaired(report)) {
      if (report.observedAt >= F && fresh(report, N)) return 1;
    } else if (sane(report)) {
      healthyAt = report.observedAt;
    }
  }
  if (known(record, N) && record.power === 0n && BigInt(record.syncedAt) >= F && BigInt(record.syncedAt) >= healthyAt) return 2;
  return 0;
}

/**
 * The clear reading of rig `id` against `seizeEvidenceFrom()`, as `RigAgent._verdict`: the newest candidate among
 * the report (row H healthy, row B impaired at any age and without the enable floor, row U unknown) and the record
 * (row VC); impairment wins a tie. Row U masks only health (v5): the record decides over it when synced after it,
 * or when its power is 0; a positive record not newer than it leaves the rig missing. No candidate is missing.
 */
export function clearReading(
  id: bigint,
  floor: number | bigint,
  now: number | bigint,
  feed: FeedView,
  report: Report | null | undefined,
  record: VoucherRecord | undefined,
): { verdict: Verdict; row: ClearRow } {
  const N = big(now), F = big(floor), ef = big(enableFloor(feed));
  let code: 0 | 1 | 2 = 0;
  let reported = false;
  let at = 0n;
  let row: ClearRow = null;
  if (base(report, id, feed, N) && report.observedAt >= F) {
    if (impaired(report)) [code, reported, at, row] = [2, true, report.observedAt, "B"];
    else if (report.observedAt < ef) [code, reported, at, row] = [0, true, report.observedAt, "U"];
    else if (fresh(report, N) && sane(report)) [code, reported, at, row] = [1, true, report.observedAt, "H"];
  }
  if (known(record, N)) {
    const s = BigInt(record.syncedAt), zero = record.power === 0n;
    if (s >= F && (!reported || s > at || (s === at && zero) || (code === 0 && zero))) [code, row] = [zero ? 2 : 1, "VC"];
  }
  return { verdict: code === 2 ? "impaired" : code === 1 ? "healthy" : "missing", row };
}

/** The verdict as the contract's code: 0 missing, 1 healthy, 2 impaired. */
export const verdictCode = (v: Verdict): 0 | 1 | 2 => (v === "impaired" ? 2 : v === "healthy" ? 1 : 0);

/** The report's own clear candidate (rows H, B and U): healthy, impaired, or missing for row U and no candidate. */
export function reportVerdict(r: Report | null | undefined, id: bigint, floor: number, now: number, feed: FeedView = NO_BRAKE): Verdict {
  return clearReading(id, floor, now, feed, r, undefined).verdict;
}

/** Health of the newest reading, independently of whether the contract can still count it. */
function reportHealth(r: Report | null | undefined, id: bigint): Verdict {
  if (!r || r.rigId !== id) return "missing";
  if (impaired(r)) return "impaired";
  return sane(r) ? "healthy" : "missing";
}

export function verdict(id: bigint, floor: number, now: number, report: Report | null | undefined, record: VoucherRecord | undefined, feed: FeedView = NO_BRAKE): Verdict {
  return clearReading(id, floor, now, feed, report, record).verdict;
}

/**
 * Per rig and flag incident: the refresh harvest (RB-09) and the row B push (RB3-04). `storedBefore` is the stored
 * report's `observedAt` when the push was sent; `unconfirmed` counts the cycles row B waited on an unconfirmed BSC read.
 */
export interface RefreshRecord { sentAt?: number; syncedBefore?: number; alerted?: boolean; pushAt?: number; storedBefore?: number; unconfirmed?: number }

export interface ClearContext {
  /** The pool's feed state; no brake ever when absent. */
  feed?: FeedView;
  /** The keeper's two-cycle confirmed BSC condition of this rig: null while unconfirmed, absent when not known. */
  confirmed?: RigCondition | null;
  /** RB3-03 timing rule; open when absent. */
  pushOpen?: boolean;
}

/**
 * The clear plan for one collateral rig of an expired flag. A rig blocks when it reads impaired, or, for the
 * flagged rig, anything but healthy (R3-00); a failed report read always blocks. Missing evidence on another rig
 * permits a clear.
 * - Row B, a stored impaired report decides (RB3-04): when the keeper's own BSC read is healthy, one fresh push
 *   per incident (`pushOnce`) and no harvest; a push stored below the enable floor does not use up the incident.
 *   Once that push has landed, or has not after 10 minutes, and the rig still blocks, the owner is alerted. When
 *   the BSC read is not healthy the owner is alerted at once; while it is unconfirmed the plan waits.
 * - Any other block (RB-09): one refresh harvest per incident when the newest report is healthy, then a push when
 *   the refreshed record needs a newer report (`push`). Row U on a rig the keeper reads as healthy gets no harvest:
 *   the loan machine pushes the flagged rig instead.
 */
export function clearPlan(
  id: bigint,
  flagged: bigint,
  floor: number,
  now: number,
  report: Report | null | undefined,
  record: VoucherRecord | undefined,
  refresh: RefreshRecord,
  ctx: ClearContext = {},
) {
  const feed = ctx.feed ?? NO_BRAKE;
  const open = ctx.pushOpen ?? true;
  const reading = clearReading(id, floor, now, feed, report, record);
  const v = reading.verdict;
  const blocks = v === "impaired" || (id === flagged && v !== "healthy") || report === undefined;
  const unreadable = report === undefined || record === undefined;
  const healthyReport = reportHealth(report, id) === "healthy";
  const rowB = blocks && reading.row === "B";
  // RB3-04: the incident's push is spent once sent, unless the report it stored is below the enable floor. Only a
  // report newer than the one stored at send time is the push's: the blocking report itself may be recent enough to
  // pass the landing slack (final audit L-4). A push restored from the journal has no `storedBefore`.
  const stored = report && report.rigId === id ? Number(report.observedAt) : 0;
  const pushLanded = refresh.pushAt !== undefined && stored + LANDED_SLACK >= refresh.pushAt
    && (refresh.storedBefore === undefined || stored > refresh.storedBefore);
  const pushSpent = refresh.pushAt !== undefined && !(pushLanded && stored < enableFloor(feed));
  const bscHealthy = ctx.confirmed === "healthy";
  const pushOnce = rowB && bscHealthy && !pushSpent && open;
  const rowBAlert = rowB && ctx.confirmed !== null
    && (!bscHealthy || (pushSpent && (pushLanded || now - refresh.pushAt! >= PUSH_LANDING)));
  // RB-09: one refresh harvest per rig and incident for any other block. Not for row U on a rig the keeper reads as
  // healthy: the loan machine's push of the flagged rig gives a row H report, so a harvest is redundant (final audit L-3)
  const rowUPush = blocks && reading.row === "U" && bscHealthy;
  const harvest = blocks && !rowB && !rowUPush && healthyReport && refresh.sentAt === undefined;
  const landed = refresh.sentAt !== undefined && record !== undefined && record.syncedAt >= refresh.sentAt - LANDED_SLACK && (refresh.syncedBefore === undefined || record.syncedAt > refresh.syncedBefore);
  // A positive voucher record can clear by itself. Otherwise a fresh report must overtake the
  // blocking reading, including when the refreshed record is below the agent's evidence floor.
  const push = blocks && !rowB && open && landed && healthyReport && (reportVerdict(report, id, floor, now, feed) !== "healthy" || Number(report!.observedAt) <= record!.syncedAt);
  const otherAlert = blocks && !rowB && ((refresh.sentAt !== undefined && (landed || now - refresh.sentAt >= PUSH_LANDING)) || !healthyReport);
  const alert = !refresh.alerted && (unreadable || otherAlert || rowBAlert);
  return { blocks, harvest, push, pushOnce, alert, verdict: v, row: reading.row };
}
