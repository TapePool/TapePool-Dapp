// Per-loan impairment machine (SPEC-PHASE3-KEEPER §4.4). Pure: given what the keeper read this cycle,
// it returns the next actions. Every action is simulated before it is sent, so a step that the
// contract would reject (for example `NoEvidence`) never costs gas and simply waits for a new cycle.
// Whether a flag, a seize or a clear has evidence comes only from the R3-00 mirror in ./evidence.ts
// (SPEC-REDEPLOY-3 RB3-02); the keeper's two-cycle confirmed BSC read is an extra gate on top of it.
import type { RigCondition } from "./confirm.js";
import { LANDED_SLACK, MAX_REPORT_AGE, clearReading, evidenceKind, type FeedView, type Report } from "./evidence.js";
import { PUSH_COOLDOWN } from "./pushLimits.js";

export { LANDED_SLACK, MAX_REPORT_AGE };
/** Once a push has not landed after PUSH_COOLDOWN, the feed may be dead: retry at most hourly (§4.6). */
export const DEAD_FEED_COOLDOWN = 3_600;

const unlanded = (r: Pick<RigView, "lastPushAt" | "storedObservedAt">) =>
  r.lastPushAt > 0 && r.storedObservedAt + LANDED_SLACK < r.lastPushAt;

export interface LoanState {
  open: boolean;
  impairedAt: number; // 0 = no flag
  seizeStart: number;
  deadline: number;
  expired: boolean;
  impairedRig: bigint; // the flagged rig, 0 when no flag
}

export interface RigView {
  id: bigint;
  confirmed: RigCondition | null; // two-cycle confirmed condition, null if not yet confirmed
  storedObservedAt: number; // newest report on the receiver, 0 if none
  lastPushAt: number; // last impairment push the keeper sent for this rig, 0 if none
  passSuspended: boolean;
  /** The receiver's report: null for an empty slot (ok false), undefined when the read failed (nothing is planned on it). */
  report?: Report | null;
  /** The voucher record (`rigs(id)`); both undefined when it could not be read. */
  voucherSyncedAt?: number;
  voucherPower?: bigint;
}

export type Action =
  | { kind: "suspend"; rig: bigint }
  | { kind: "push"; rigs: bigint[] }
  | { kind: "flag"; rig: bigint }
  | { kind: "seize" }
  | { kind: "clear" }
  | { kind: "alert"; text: string };

export interface MachineInput {
  flagEvidenceFrom?: number;
  seizeEvidenceFrom?: number;
  clearAllowed?: boolean;
  clearPushRigs?: bigint[];
  /** Rigs whose clear is blocked by a stored impaired report (row B): their pushes follow RB3-04, not the cooldown loop. */
  rowBRigs?: bigint[];
  now: number;
  loan: LoanState;
  rigs: RigView[];
  feedDisabled: boolean;
  /** `pool.feedEnabledAt()`, 0 before the first `enableFeed` (R3-01). */
  feedEnabledAt?: number;
  /** RB3-03 timing rule: X Layer time is at least `feedEnabledAt + MAX_CLOCK_SKEW + 30 s`. Open when absent. */
  pushOpen?: boolean;
  suspendOnRevoke: boolean; // K-O5
}

export type Phase = "none" | "live" | "window" | "expired" | "closed";

export function phaseOf(loan: LoanState, now: number): Phase {
  if (!loan.open) return "closed";
  if (loan.impairedAt === 0) return "none";
  if (loan.expired) return "expired";
  if (now < loan.seizeStart) return "live";
  return "window";
}

const bad = (c: RigCondition | null): c is Exclude<RigCondition, "healthy"> => c !== null && c !== "healthy";

const recordOf = (r: RigView) =>
  r.voucherSyncedAt !== undefined && r.voucherPower !== undefined ? { syncedAt: r.voucherSyncedAt, power: r.voucherPower } : undefined;

/** The last impairment push for `r` has not been stored by the receiver after the normal cooldown. */
export function pushUnlanded(r: Pick<RigView, "lastPushAt" | "storedObservedAt">, now: number): boolean {
  return unlanded(r) && now - r.lastPushAt >= PUSH_COOLDOWN;
}

/** Push `rig` again unless one was sent within the cooldown; hourly while the last one has not landed. */
export function pushIfDue(r: Pick<RigView, "id" | "lastPushAt" | "storedObservedAt">, now: number): Action[] {
  const cooldown = unlanded(r) ? DEAD_FEED_COOLDOWN : PUSH_COOLDOWN;
  return now - r.lastPushAt >= cooldown ? [{ kind: "push", rigs: [r.id] }] : [];
}

export function nextActions(m: MachineInput): Action[] {
  const phase = phaseOf(m.loan, m.now);
  const suspect = m.rigs.find((r) => bad(r.confirmed));
  const actions: Action[] = [];
  const flagFrom = m.flagEvidenceFrom ?? 0;
  const seizeFrom = m.seizeEvidenceFrom ?? m.loan.seizeStart;
  const feed: FeedView = { disabled: m.feedDisabled, enabledAt: m.feedEnabledAt ?? 0 };
  // R3-00 rows E and VE (with the row S shield). A failed report read is never planned on, except while the
  // feed is disabled, when no report row applies.
  const readable = (r: RigView) => m.feedDisabled || r.report !== undefined;
  const evidence = (r: RigView, floor: number) =>
    readable(r) && evidenceKind(r.id, floor, m.now, feed, r.report, recordOf(r)) !== 0;
  // rows H, B, U and VC; a push before the RB3-03 time would land below the enable floor and count for nothing
  const reading = (r: RigView) => clearReading(r.id, seizeFrom, m.now, feed, r.report, recordOf(r)).verdict;
  const push = (r: RigView): Action[] => (m.pushOpen ?? true ? pushIfDue(r, m.now) : []);

  switch (phase) {
    case "closed":
    case "live":
      return [];

    case "none": {
      if (!suspect) return [];
      const c = suspect.confirmed;
      if (!suspect.passSuspended && (c === "rescue" || (c === "revoked" && m.suspendOnRevoke))) {
        actions.push({ kind: "suspend", rig: suspect.id });
      }
      if (m.feedDisabled) {
        // path (a) is closed; a stopped or revoked rig syncs power 0 through the daily harvest, so
        // path (b) can still flag it. A rescued rig never syncs: tell the owner.
        if (c === "rescue") {
          actions.push({ kind: "alert", text: `rescue of rig ${suspect.id} seen, flag impossible until enableFeed` });
        } else if (evidence(suspect, flagFrom)) {
          actions.push({ kind: "flag", rig: suspect.id });
        }
        return actions;
      }
      if (evidence(suspect, flagFrom)) actions.push({ kind: "flag", rig: suspect.id });
      else actions.push(...push(suspect));
      return actions;
    }

    case "window": {
      if (!suspect) return []; // healthy: let the flag expire
      if (m.rigs.some((r) => bad(r.confirmed) && evidence(r, seizeFrom))) return [{ kind: "seize" }];
      if (m.feedDisabled) return [];
      return push(suspect);
    }

    case "expired": {
      if (m.feedDisabled) return [{ kind: "alert", text: "expired impairment flag while the feed is disabled: owner review required" }];
      if (m.clearAllowed) return [{ kind: "clear" }];
      if (suspect) {
        if (evidence(suspect, flagFrom)) return [{ kind: "flag", rig: suspect.id }];
        return push(suspect);
      }
      const clearPushRigs = m.clearPushRigs ?? [];
      const pushes = m.rigs.filter((r) => clearPushRigs.includes(r.id) && r.confirmed === "healthy").flatMap(push);
      if (pushes.length > 0) return pushes;
      // clearExpiredFlag needs health evidence for the flagged rig, from after seizeStart
      const flagged = m.rigs.find((r) => r.id === m.loan.impairedRig);
      if (!flagged || flagged.confirmed !== "healthy") return []; // wait until it is confirmed healthy
      if (reading(flagged) === "healthy") {
        // without a clear plan from the keeper, check every rig here: none impaired and no failed read
        const permits = (r: RigView) => readable(r) && reading(r) !== "impaired";
        return m.clearAllowed === undefined && m.rigs.every(permits) ? [{ kind: "clear" }] : [];
      }
      if ((m.rowBRigs ?? []).includes(flagged.id)) return []; // RB3-04: one push per incident, sent by the keeper
      return push(flagged);
    }
  }
}
