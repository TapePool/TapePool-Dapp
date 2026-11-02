// Persistent keeper state on the Railway volume (SPEC-PHASE3-KEEPER §2). Logs rebuild discovery;
// the volume preserves quotas, spend, pending transactions and per-incident limits across restarts.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cleanStats, emptyStats, type StatsState } from "./logic/apy.js";
import { cleanIndex, emptyIndex, type IndexState } from "./logic/ledger.js";
import { initialHarvestState, type EvidenceRec, type HarvestState } from "./logic/schedule.js";
import { initialWatchState, type WatchState } from "./logic/upgradeWatch.js";
import type { IncomeState } from "./logic/income.js";
import type { RefreshRecord } from "./logic/evidence.js";
import type { Spend } from "./logic/budget.js";
import type { PendingTx } from "./tx.js";

export interface DailyCounts {
  day: number;
  harvests: number;
  pushes: number;
  coveredThenMatured: number; // covered loans that still needed their maturity harvest (part E §3.1, E-O4)
  jobFailures: Record<string, number>; // failed cycles per job (part E §3.3)
  synced: string;
}

export const emptyDay = (day: number): DailyCounts => ({ day, harvests: 0, pushes: 0, coveredThenMatured: 0, jobFailures: {}, synced: "0" });

/** A day record written before part E lacks its new counters. */
const cleanDay = (d: Partial<DailyCounts> | undefined, fallback: DailyCounts): DailyCounts =>
  d ? { ...emptyDay(d.day ?? fallback.day), ...d, coveredThenMatured: d.coveredThenMatured ?? 0, jobFailures: d.jobFailures ?? {} } : fallback;

export interface KeeperState {
  income: IncomeState;
  refresh: Record<string, RefreshRecord>;
  custodyAlerts: Record<string, number>;
  /** Rig id -> UTC day of the last "report cannot be read" alert for a flagged or suspect loan (final audit L-2). */
  reportAlerts: Record<string, number>;
  spend: Spend[];
  spendStartedAt: number;
  pendingTx: { bsc: PendingTx[]; xlayer: PendingTx[] };
  version: 1;
  factory: string; // the factory the cursor and agents belong to ("" before deployment)
  cursor: string; // next X Layer block to scan for logs
  agents: Record<string, string>; // agent -> borrower
  harvest: HarvestState; // part D §5.1: per-loan maturity schedule and seized vouchers
  evidence: Record<string, EvidenceRec>; // part D §5.2: evidence harvests per incident
  lastPushAt: Record<string, number>; // rig id -> unix seconds of the last impairment push
  lastSweepAt: Record<string, number>; // agent -> unix seconds
  lastForwardAt: Record<string, number>; // agent -> unix seconds of the last forwardVouchers try
  /** RB3-03: the last `feedEnabledAt` seen, and the rigs still owed a post-enable push. Absent before the first re-enable. */
  feedRound?: { enabledAt: number; rigs: string[] };
  /** RB3-06: "agent:id" of each id a closed agent keeps that was alerted once, with the holder read then ("unknown" if unreadable). */
  keptAlerts: Record<string, string>;
  pushCounts: Record<string, number>; // push-on-request limiter counters
  daily: DailyCounts; // today's counts (UTC day)
  previousDay: DailyCounts; // the last full day, for the summary
  lastSummaryDay: number;
  watch: WatchState;
  stats: StatsState; // SPEC-PHASE5-APP §8.1: daily share-price snapshots (rebuilt from archive reads if lost)
  index: IndexState; // SPEC-PHASE5-APP §8.2: the position index with its own cursor (rebuilt from the deploy block if lost)
}

export function emptyState(startBlock: bigint, factory = ""): KeeperState {
  return {
    income: {}, refresh: {}, custodyAlerts: {}, reportAlerts: {}, spend: [], spendStartedAt: 0,
    pendingTx: { bsc: [], xlayer: [] },
    version: 1,
    factory,
    cursor: startBlock.toString(),
    agents: {},
    harvest: initialHarvestState(),
    evidence: {},
    lastPushAt: {},
    lastSweepAt: {},
    lastForwardAt: {},
    keptAlerts: {},
    pushCounts: {},
    daily: emptyDay(0),
    previousDay: emptyDay(0),
    lastSummaryDay: 0,
    watch: initialWatchState(),
    stats: emptyStats(),
    index: emptyIndex(),
  };
}

/**
 * Load the state saved at `path`. The log cursor never starts before `startBlock`, and a state saved
 * for another factory (or before deployment) restarts the agent scan. The upgrade watch restarts clean:
 * its latch is re-derived from the constants every cycle, so a redeploy with reviewed constants
 * unfreezes the keeper (§4.1 rule 5) while a still-differing value freezes and brakes again.
 */
export function loadState(path: string, startBlock: bigint, factory = ""): KeeperState {
  const fresh = emptyState(startBlock, factory);
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Partial<KeeperState>;
    if (s.version !== 1) throw new Error("unknown state version");
    const sameFactory = (s.factory ?? "").toLowerCase() === factory.toLowerCase();
    const kept = {
      spend: s.spend ?? [], spendStartedAt: s.spendStartedAt ?? 0,
      pendingTx: s.pendingTx ?? { bsc: [], xlayer: [] },
      custodyAlerts: s.custodyAlerts ?? {},
      reportAlerts: s.reportAlerts ?? {},
      pushCounts: s.pushCounts ?? {},
      daily: cleanDay(s.daily, fresh.daily),
      previousDay: cleanDay(s.previousDay, fresh.previousDay),
      lastSummaryDay: s.lastSummaryDay ?? 0,
      watch: { ...initialWatchState(), lastSeen: s.watch?.lastSeen ?? {} },
    };
    // The app-route data belongs to a pool. A file from before these sections existed starts them empty,
    // and PublicData resets either one when its pool differs from the configured one.
    const publicData = { stats: cleanStats(s.stats), index: cleanIndex(s.index) };
    // another factory: agents, cursor and every per-loan timer belong to the old deployment
    if (!sameFactory) return { ...fresh, ...kept }; // snapshots and the index start over too (fresh)
    const saved = BigInt(s.cursor ?? "0");
    return {
      ...fresh,
      ...s,
      factory,
      cursor: (saved > startBlock ? saved : startBlock).toString(),
      agents: s.agents ?? {},
      lastForwardAt: s.lastForwardAt ?? {},
      keptAlerts: s.keptAlerts ?? {},
      harvest: { ...fresh.harvest, ...(s.harvest ?? {}), loans: s.harvest?.loans ?? {} },
      // records written before the landed check (audit M2) count every send as landed
      evidence: Object.fromEntries(
        Object.entries(s.evidence ?? {}).map(([k, r]) => [k, { ...r, count: r.count ?? 0, afterSeize: r.afterSeize ?? false, sends: r.sends ?? r.count ?? 0, flagAt: r.flagAt ?? 0 }]),
      ),
      ...publicData,
      ...kept,
    };
  } catch {
    return fresh;
  }
}

export function saveState(path: string, s: KeeperState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  renameSync(tmp, path);
}
