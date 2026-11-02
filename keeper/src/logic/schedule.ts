// Harvest schedule, covered harvests and evidence harvests (SPEC-PHASE3-OPSFEE §5.1, §5.2;
// SPEC-PHASE3-KEEPER-OPS §3.1). Pure: the job reads, this decides.
import type { RigCondition } from "./confirm.js";
import type { Phase } from "./loanMachine.js";

/** A loan's rigs are harvested once inside this window before maturity. */
export const PRE_MATURITY = 3_600;
/** After the maturity harvest, while the loan stays open (a shortfall), harvest again this often. */
export const SHORTFALL_EVERY = 72 * 3_600;
/** The fee's margin covers one shortfall harvest; alert from this many on. */
export const SHORTFALL_ALERT_AT = 3;
/** The second evidence harvest waits this long after `seizeStart` (BSC send time vs X Layer time). */
export const EVIDENCE_AFTER_SEIZE = 300;
/** At most this many successful evidence harvests per incident: sent, and their sync seen on the voucher. */
export const EVIDENCE_MAX = 2;
/** An evidence harvest whose sync is not seen on the voucher after this long raises an alert. */
export const EVIDENCE_UNLANDED = 600;
/** ...and may be sent again after this long. */
export const EVIDENCE_RETRY = 3_600;
/** Hard cap on evidence harvests sent per incident, landed or not: bounds the BNB spent. */
export const EVIDENCE_MAX_SENDS = 4;
/** A loan's covered check runs at most this often (part E §3.1). */
export const COVER_CHECK_EVERY = 600;
/** The bridged output must exceed the debt by this much, in basis points. */
export const COVER_MARGIN_BPS = 100n;
/** The BEM bridge fee assumed when the adapter cannot be read: the 5% maximum, so a failure never harvests early. */
export const FEE_BPS_FALLBACK = 500n;

export interface LoanHarvest {
  maturityDone: boolean;
  lastAt: number; // last harvest of this loan's rigs sent by the schedule
  shortfalls: number; // harvests after the maturity one
  coveredAt?: number; // the covered harvest went out (part E §3.1); at most one per loan
}

export interface HarvestState {
  loans: Record<string, LoanHarvest>; // by loanKey
  seizedLastAt: number;
}

export type EvidenceKind = "first" | "afterSeize";

export interface EvidenceRec {
  count: number; // evidence harvests of this incident whose power-0 sync was seen on the voucher
  afterSeize: boolean; // the one after seizeStart was seen
  sends: number; // evidence harvests sent for this incident, landed or not
  pending?: { kind: EvidenceKind; sentAt: number; alerted?: boolean }; // sent, its sync not seen yet
  notEvidenceAt?: number; // when a sync was seen with a non-zero power: no evidence harvest for an hour
  capAlerted?: boolean; // the "all sends used" alert went out for this incident
  flagAt: number; // the loan's impairedAt this incident belongs to (0 before its flag)
}

export interface ScheduledLoan {
  agent: string;
  start: number;
  maturity: number;
  collateral: bigint[];
}

export const loanKey = (agent: string, start: number) => `${agent.toLowerCase()}:${start}`;

export function initialHarvestState(): HarvestState {
  return { loans: {}, seizedLastAt: 0 };
}

export interface HarvestPlan {
  ids: bigint[]; // every rig to harvest now (open loans due, plus seized vouchers when included)
  due: { key: string; kind: "maturity" | "shortfall" | "covered" }[];
  seized: boolean; // seized vouchers ride along (or are due on their own)
}

/**
 * What the schedule harvests now. A loan is due once inside the last hour before maturity, then every
 * 72 h while it stays open; before that, once, when its key is in `covered` (part E §3.1). Seized
 * vouchers are due every `seizedEveryHours` on their own, and join any batch that goes out anyway (a
 * harvest costs per batch, not per rig).
 */
export function planHarvest(
  now: number,
  open: ScheduledLoan[],
  seized: bigint[],
  st: HarvestState,
  seizedEveryHours: number,
  covered: Set<string> = new Set(),
): HarvestPlan {
  const ids = new Set<bigint>();
  const due: HarvestPlan["due"] = [];
  for (const l of open) {
    const key = loanKey(l.agent, l.start);
    const rec = st.loans[key];
    if (!rec?.maturityDone) {
      if (now >= l.maturity - PRE_MATURITY) due.push({ key, kind: "maturity" });
      else if (covered.has(key) && rec?.coveredAt === undefined) due.push({ key, kind: "covered" });
      else continue;
    } else if (now - rec.lastAt >= SHORTFALL_EVERY) {
      due.push({ key, kind: "shortfall" });
    } else {
      continue;
    }
    for (const id of l.collateral) ids.add(id);
  }
  const seizedDue = seized.length > 0 && now - st.seizedLastAt >= seizedEveryHours * 3_600;
  const withSeized = seized.length > 0 && (seizedDue || due.length > 0);
  if (withSeized) for (const id of seized) ids.add(id);
  return { ids: [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), due, seized: withSeized };
}

/** The agent part of a loan or evidence key. */
const agentOf = (key: string) => key.split(":")[0]!;

/**
 * Record a completed schedule harvest. Returns the keys whose shortfall count reached the alert level.
 * `seizedSent` says whether a batch holding seized vouchers went out (a batch below the bond does not).
 * Loans no longer open are dropped, but only for agents read this cycle (`readAgents`, lower case): an
 * agent whose read failed keeps its record.
 */
export function recordHarvest(
  st: HarvestState,
  plan: HarvestPlan,
  now: number,
  openKeys: Set<string>,
  readAgents: Set<string>,
  seizedSent: boolean,
): string[] {
  const alerts: string[] = [];
  for (const d of plan.due) {
    const rec = st.loans[d.key] ?? { maturityDone: false, lastAt: 0, shortfalls: 0 };
    if (d.kind === "covered") {
      // the maturity schedule is untouched: it still runs if the loan stays open
      rec.coveredAt = now;
      st.loans[d.key] = rec;
      continue;
    }
    if (d.kind === "maturity") rec.maturityDone = true;
    else {
      rec.shortfalls += 1;
      if (rec.shortfalls >= SHORTFALL_ALERT_AT) alerts.push(d.key);
    }
    rec.lastAt = now;
    st.loans[d.key] = rec;
  }
  if (seizedSent) st.seizedLastAt = now;
  for (const k of Object.keys(st.loans)) if (readAgents.has(agentOf(k)) && !openKeys.has(k)) delete st.loans[k];
  return alerts;
}

/**
 * Whether a loan's rigs should be harvested now because their output already covers the debt (part E
 * §3.1): only when the agent cannot close the loan by itself, and when the bridged output plus the
 * agent's BEM clear the debt by `COVER_MARGIN_BPS`. Each rig counts `pending + cellBalance` rounded down
 * to `dust`, as the vault sends it; a rig the vault no longer knows (rescued) counts 0. `null` when a
 * rig could not be read: decide on a later cycle.
 */
export function coveredLoan(
  rigs: { ok: boolean; vaultKnows: boolean; pending: bigint; cellBalance: bigint }[],
  agentBem: bigint,
  debt: bigint,
  feeBps: bigint,
  dust: bigint,
): boolean | null {
  if (debt === 0n || agentBem >= debt) return false;
  let total = 0n;
  for (const r of rigs) {
    if (!r.ok) return null;
    if (!r.vaultKnows) continue;
    const a = r.pending + r.cellBalance;
    total += a - (a % dust);
  }
  const fee = feeBps >= 0n && feeBps <= 10_000n ? feeBps : FEE_BPS_FALLBACK;
  const bridged = (total * (10_000n - fee)) / 10_000n;
  return agentBem + bridged >= (debt * (10_000n + COVER_MARGIN_BPS)) / 10_000n;
}

/** Drop evidence records of loans that are no longer open, for agents read this cycle. */
export function pruneEvidence(evidence: Record<string, EvidenceRec>, openKeys: Set<string>, readAgents: Set<string>): void {
  for (const k of Object.keys(evidence)) {
    const loan = k.slice(0, k.lastIndexOf(":"));
    if (readAgents.has(agentOf(k)) && !openKeys.has(loan)) delete evidence[k];
  }
}

/**
 * The record of the current incident: a flag that was cleared or replaced by a new one (`impairedAt`
 * changed after the record saw a flag) starts a new incident with a fresh budget.
 */
export function currentIncident(rec: EvidenceRec | undefined, impairedAt: number): EvidenceRec | undefined {
  if (!rec) return undefined;
  if (rec.flagAt !== 0 && rec.flagAt !== impairedAt) return undefined;
  if (rec.flagAt === 0 && impairedAt !== 0) rec.flagAt = impairedAt; // the flag this incident's evidence raised
  return rec;
}

/**
 * Check a sent evidence harvest against the voucher record (`syncedAt` is the BSC send time of the
 * newest harvest that reached the voucher). A sync counts once it is at or after both the send time
 * (less `slack`) and what the agent accepts for that kind (`accepted`: loan start + 1 for a flag,
 * `seizeStart` for a seize). Seen with power 0, it counts; with any other power, it is not evidence
 * (no new send for `EVIDENCE_RETRY`); not seen after `EVIDENCE_UNLANDED`, "unlanded" once per send.
 */
export function evidenceLanded(
  rec: EvidenceRec,
  now: number,
  voucher: { syncedAt: number; power: bigint },
  slack: number,
  accepted: Record<EvidenceKind, number>,
): "landed" | "notEvidence" | "unlanded" | null {
  const p = rec.pending;
  if (!p) return null;
  const since = Math.max(p.sentAt - slack, accepted[p.kind]);
  if (voucher.syncedAt >= since) {
    rec.pending = undefined;
    if (voucher.power !== 0n) {
      rec.notEvidenceAt = now;
      return "notEvidence";
    }
    rec.count += 1;
    if (p.kind === "afterSeize") rec.afterSeize = true;
    return "landed";
  }
  if (now - p.sentAt < EVIDENCE_UNLANDED || p.alerted) return null;
  p.alerted = true;
  return "unlanded";
}

/** Book a sent evidence harvest. */
export function recordEvidenceSent(rec: EvidenceRec | undefined, kind: EvidenceKind, now: number, impairedAt: number): EvidenceRec {
  const r = rec ?? { count: 0, afterSeize: false, sends: 0, flagAt: impairedAt };
  r.sends += 1;
  r.pending = { kind, sentAt: now };
  return r;
}

/** The power a harvest syncs to the voucher: the vault sends `verifWeight` for an active miner, else 0. */
export const syncsZeroPower = (r: { status: number; verifWeight: bigint }) => r.status !== 1 || r.verifWeight === 0n;

/**
 * Whether an evidence harvest of `rig` is due (§5.2): only while the feed is disabled, for a confirmed
 * suspect whose harvest will sync power 0 on the voucher (`syncsZero`, read this cycle). Not for a
 * rescued rig (the vault filters it out of `harvest`), and not for a suspect that still syncs a
 * non-zero power (a harvest would not be evidence). A sent harvest is waited for until it lands, or
 * for `EVIDENCE_RETRY`; "capped" means one is due but the incident used all its sends.
 */
export function evidenceDue(
  now: number,
  feedDisabled: boolean,
  phase: Phase,
  seizeStart: number,
  confirmed: RigCondition | null,
  syncsZero: boolean,
  rec: EvidenceRec | undefined,
): EvidenceKind | "capped" | null {
  if (!feedDisabled || !syncsZero || confirmed === null || confirmed === "healthy" || confirmed === "rescue") return null;
  // a non-zero sync: try again only after an hour, and only while this cycle's read still says 0
  if (rec?.notEvidenceAt !== undefined && now - rec.notEvidenceAt < EVIDENCE_RETRY) return null;
  if (rec?.pending && now - rec.pending.sentAt < EVIDENCE_RETRY) return null;
  const count = rec?.count ?? 0;
  if (count >= EVIDENCE_MAX) return null;
  let due: EvidenceKind | null = null;
  if (phase === "none" && count === 0) due = "first";
  else if (phase === "window" && now >= seizeStart + EVIDENCE_AFTER_SEIZE && !rec?.afterSeize) due = "afterSeize";
  if (due && (rec?.sends ?? 0) >= EVIDENCE_MAX_SENDS) return "capped";
  return due;
}

export const evidenceKey = (loan: string, rig: bigint) => `${loan}:${rig}`;

export interface Harvestable {
  id: bigint;
  pending: bigint;
  cellBalance: bigint;
}

/**
 * One batch for this cycle's evidence harvests (`targets`, at most `maxBatch`): the targets first, then
 * other harvestable rigs, largest first, until the batch clears `bond` (part D §5.2). `needsBond` means
 * the keeper must front it.
 */
export function bundleEvidence(targets: Harvestable[], others: Harvestable[], bond: bigint, dust: bigint, maxBatch: number): { ids: bigint[]; needsBond: boolean } {
  const amount = (r: Harvestable) => {
    const a = r.pending + r.cellBalance;
    return a - (a % dust);
  };
  const ids = targets.slice(0, maxBatch).map((r) => r.id);
  let total = targets.slice(0, maxBatch).reduce((s, r) => s + amount(r), 0n);
  const sorted = others.filter((r) => !ids.includes(r.id)).sort((a, b) => (amount(b) > amount(a) ? 1 : amount(b) < amount(a) ? -1 : 0));
  for (const r of sorted) {
    if (total >= bond || ids.length >= maxBatch) break;
    ids.push(r.id);
    total += amount(r);
  }
  return { ids, needsBond: total < bond };
}
