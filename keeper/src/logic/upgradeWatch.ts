// Upgrade watch decision logic (SPEC-PHASE3-KEEPER §4.1). Pure: the job reads the slots, this decides.
import type { Address } from "viem";

export type Target =
  | "voucher"
  | "rigVault"
  | "podMining"
  | "bscCircuitsBeacon"
  | "bscCircuitsImpl"
  | "xlayerCircuitsImpl";

export const TARGETS: readonly Target[] = [
  "voucher",
  "rigVault",
  "podMining",
  "bscCircuitsBeacon",
  "bscCircuitsImpl",
  "xlayerCircuitsImpl",
];

/** "full" pauses borrows and disables the feed; "pause" only pauses borrows. */
export type BrakeKind = "none" | "pause" | "full";
const RANK: Record<BrakeKind, number> = { none: 0, pause: 1, full: 2 };

/**
 * The brake a confirmed change pulls. A changed BSC circuits evaluator can make a screened rig
 * revocable, so it pauses borrows until every screen pass is re-verified (part C, C-O4); the feed's
 * data does not depend on it, so the feed stays on.
 */
const BRAKE: Readonly<Partial<Record<Target, Exclude<BrakeKind, "none">>>> = {
  voucher: "full",
  rigVault: "full",
  podMining: "full",
  bscCircuitsBeacon: "pause",
  bscCircuitsImpl: "pause",
};
/** A change here freezes the impairment job and the push service. */
const FREEZE: ReadonlySet<Target> = new Set(["voucher", "rigVault", "podMining", "bscCircuitsBeacon", "bscCircuitsImpl"]);

export interface WatchState {
  braked: boolean; // latched once a brake fired; cleared only by a redeploy
  brakeKind: BrakeKind; // the strongest brake latched so far
  streak: Record<Target, number>; // consecutive cycles in which the value differed
  lastSeen: Partial<Record<Target, Address>>;
  vaultChanged: boolean; // for K-O6 (hold harvests while frozen by a vault upgrade)
}

export interface WatchResult {
  state: WatchState;
  frozen: boolean;
  brake: BrakeKind; // a brake newly required this cycle ("none" if nothing new)
  alerts: string[];
}

export function initialWatchState(): WatchState {
  const streak = Object.fromEntries(TARGETS.map((t) => [t, 0])) as Record<Target, number>;
  return { braked: false, brakeKind: "none", streak, lastSeen: {}, vaultChanged: false };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * One cycle. `readings[t]` is null on a read error: that comparison is skipped and the streak is
 * kept, so a failing RPC neither freezes nor unfreezes anything by itself.
 */
export function stepWatch(
  prev: WatchState,
  readings: Record<Target, Address | null>,
  expected: Record<Target, Address>,
): WatchResult {
  const streak = { ...prev.streak };
  const lastSeen = { ...prev.lastSeen };
  const alerts: string[] = [];
  let want: BrakeKind = "none";

  for (const t of TARGETS) {
    const got = readings[t];
    if (got === null) continue;
    lastSeen[t] = got;
    if (same(got, expected[t])) {
      streak[t] = 0;
      continue;
    }
    streak[t] += 1;
    if (streak[t] === 1) {
      const what = t === "bscCircuitsBeacon" ? "beacon address" : "implementation";
      alerts.push(`${t} ${what} changed: expected ${expected[t]}, read ${got}`);
    }
    const kind = BRAKE[t];
    if (kind && streak[t] >= 2 && RANK[kind] > RANK[want]) want = kind;
  }

  const brakeKind = RANK[want] > RANK[prev.brakeKind] ? want : prev.brakeKind;
  const brake: BrakeKind = brakeKind !== prev.brakeKind ? brakeKind : "none";
  const braked = brakeKind !== "none";
  const vaultChanged = prev.vaultChanged ? braked || streak.rigVault > 0 : streak.rigVault > 0;
  const frozen = braked || TARGETS.some((t) => FREEZE.has(t) && streak[t] > 0);
  if (brake === "full") alerts.push("upgrade confirmed in two cycles: pausing borrows and disabling the feed");
  if (brake === "pause") {
    alerts.push("BSC circuits evaluator change confirmed in two cycles: pausing borrows (the feed stays on); re-verify every screen pass before unpausing");
  }
  return { state: { braked, brakeKind, streak, lastSeen, vaultChanged }, frozen, brake, alerts };
}
