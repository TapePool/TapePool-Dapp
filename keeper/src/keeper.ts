// The keeper's cycle (SPEC-PHASE3-KEEPER §4): upgrade watch first, then admin watch, harvest,
// impairment, sweep and balances. Each job is isolated: a failing job logs, alerts and lets the others
// run. Every transaction goes through `Sender`, which simulates first and never sends in dry mode.
import { formatEther, getAddress, type Address } from "viem";
import { ADDR, EXPECTED_IMPL, type Deployment } from "./addresses.js";
import { agentAbi, erc20Abi, factoryAbi, oftFeeAbi, poolAbi, reporterAbi, screenAbi, vaultAbi } from "./abi.js";
import type { Alerts } from "./alerts.js";
import type { Clients } from "./chains.js";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { classify, initialConfirmState, observe, type ConfirmState, type RigCondition } from "./logic/confirm.js";
import { BOND, DUST, MAX_BATCH, planBatches } from "./logic/harvest.js";
import { LANDED_SLACK, nextActions, phaseOf, pushIfDue, pushUnlanded, type Action, type RigView } from "./logic/loanMachine.js";
import {
  COVER_CHECK_EVERY,
  EVIDENCE_MAX_SENDS,
  FEE_BPS_FALLBACK,
  PRE_MATURITY,
  SHORTFALL_ALERT_AT,
  bundleEvidence,
  coveredLoan,
  currentIncident,
  evidenceDue,
  evidenceKey,
  evidenceLanded,
  loanKey,
  planHarvest,
  pruneEvidence,
  recordEvidenceSent,
  recordHarvest,
  syncsZeroPower,
  type EvidenceKind,
  type EvidenceRec,
  type HarvestPlan,
} from "./logic/schedule.js";
import { stepWatch, type BrakeKind, type Target } from "./logic/upgradeWatch.js";
import { BEM_FLOAT, dailySpend } from "./logic/budget.js";
import { syncDue } from "./logic/income.js";
import { clearPlan, enableFloor, pushOpen, type FeedView, type Report } from "./logic/evidence.js";
import { PUSH_COOLDOWN } from "./logic/pushLimits.js";
import { isolatedPush } from "./pushIsolation.js";
import { PublicData } from "./publicData.js";
import {
  bscFinalized,
  readBscRigs,
  readLoans,
  readOwners,
  readReports,
  readSeized,
  readSuspended,
  readVoucherRecords,
  readWatchTargets,
  type LoanSnapshot,
} from "./reads.js";
import { emptyDay, type KeeperState } from "./state.js";
import type { Call, Sender, SendResult } from "./tx.js";

const LOG_PAGE = 100n; // X Layer eth_getLogs limit
/** Log scans stop this many blocks short of the head: reads may come from endpoints a block or two apart (part E §3.2). */
export const LOG_LAG = 16n;
/** A failing job alerts only after failing this long without a success (part B §4.6, part E §3.3). */
export const JOB_ALERT_AFTER = 600;
const MAX_PAGES_PER_CYCLE = 60n;
const SWEEP_EVERY = 600; // seconds per agent
const FORWARD_EVERY = 3_600; // seconds per closed agent with a stuck voucher
const OKB_LOW = 2_000_000_000_000_000n; // 0.002 OKB
const FINALITY_STALL = 600; // seconds
/** Gas of one 16-rig push of our reporter and of one harvest batch on BSC (part D D1, D2). */
const PUSH_GAS = 1_210_339n;
const HARVEST_GAS = 1_500_000n;
/** BEM allowance the keeper gives the vault for evidence-harvest bonds (100 bonds). */
const FLOAT_APPROVAL = 100n * BOND;
const APPROVE_FLOAT = "approve BEM bond float to the vault";
/** Alert when an operating fee covers less than this share of a loan's BSC cost, in percent (§5.3). */
const COVERAGE_ALERT_PCT = 110n;
/** A row B block whose BSC read stays unconfirmed this many cycles alerts the owner (final audit L-5). */
const ROW_B_UNCONFIRMED_CYCLES = 3;
/** Reverts the impairment machine expects and simply waits out (§4.4). */
/** An evidence harvest due this cycle (part D §5.2). */
interface EvidenceDue {
  rig: bigint;
  ek: string;
  kind: EvidenceKind;
  impairedAt: number;
}

const EXPECTED_REVERTS = new Set([
  "NoEvidence",
  "NoHealthEvidence",
  "FlagLive",
  "FlagNotExpired",
  "CureWindow",
  "FlagExpired",
  "NoDebt",
  "NoLoan",
  "NoFlag",
  "NotClosed",
  "CustodyUnreadable", // isolated per rig; its dedicated alert is once per UTC day
]);
const ADMIN_EVENTS = new Set([
  "PolicyActivated", "PolicyCancelled", "ParamExecuted", "ParamCancelled",
  "PolicyQueued",
  "ParamQueued",
  "GuardianSet",
  "OwnershipTransferStarted",
  "OwnershipTransferred",
  "FeedEnabled",
  "BorrowsUnpaused",
  "BorrowsPaused",
  "FeedDisabled",
  "ScreenPassAdded",
  "ScreenPassRevoked",
  "PassSuspended",
  "PassSuspensionLifted",
]);

/** "logs 3, balances 2", or "none": a day's failed cycles per job (part E §3.3). */
const failLine = (f: Record<string, number>) =>
  Object.entries(f)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ") || "none";

export interface Senders {
  bsc: Sender;
  xlayer: Sender;
}

type SendStatus = "sent" | "dry" | "reverted" | "waiting";

export class Keeper {
  frozen = false;
  lastCycleAt = 0;
  private confirm: ConfirmState = initialConfirmState();
  /** Rigs whose scheduled harvest went out this cycle: one due for evidence is booked, not re-sent (round-2 N7). */
  private harvestedThisCycle = new Set<bigint>();
  private lastFinalized = { block: 0n, at: 0 };
  private revertStreak = new Map<string, number>();
  /** When each loan's covered check last ran (part E §3.1); in memory. */
  private coverCheckedAt = new Map<string, number>();
  /** Each failing job's streak: since when, and whether it alerted (part E §3.3); in memory. */
  private failing = new Map<string, { since: number; last: number; alerted: boolean }>();
  /** Share price and position index for the app's read-only routes (SPEC-PHASE5-APP §8); null before deployment. */
  readonly publicData: PublicData | null;

  constructor(
    private readonly cfg: Config,
    private readonly c: Clients,
    private readonly d: Deployment | null,
    private readonly alerts: Alerts,
    private readonly tx: Senders,
    readonly state: KeeperState,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.publicData = d ? new PublicData(c, d, state, (kind, text) => void alerts.send(kind, text)) : null;
    // A crash after broadcast but before the cycle save must not buy a second refresh.
    for (const pending of state.pendingTx.bsc) {
      // nor a second post-enable push inside the cooldown (RB3-03), nor a second row B push for the incident (RB3-04)
      const pushed = /^(?:enable-push|clear-push) \[([\d,]+)\]/.exec(pending.label);
      if (pushed) for (const id of pushed[1]!.split(",")) state.lastPushAt[id] = Math.max(state.lastPushAt[id] ?? 0, pending.sentAt);
      const cleared = /^clear-push \[([\d,]+)\] for (.+)$/.exec(pending.label);
      if (cleared) for (const id of cleared[1]!.split(",")) (state.refresh[`${cleared[2]}:${id}`] ??= {}).pushAt ??= pending.sentAt;
      const match = /^refresh-harvest \[([\d,]+)\] for (.+)$/.exec(pending.label);
      if (!match) continue;
      for (const id of match[1]!.split(",")) {
        const rec = state.refresh[`${match[2]}:${id}`] ??= {};
        rec.sentAt ??= pending.sentAt;
      }
    }
  }

  /**
   * Run one job. A failure is logged and counted for the day every time, but alerts only once the job has
   * failed for `JOB_ALERT_AFTER` without a success (then at most every 30 minutes); the first success
   * after that alert says it recovered (part E §3.3).
   */
  private async job(name: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      const f = this.failing.get(name);
      if (f) {
        this.failing.delete(name);
        if (f.alerted) await this.alerts.send(`job:${name}:recovered`, `keeper job ${name} recovered after ${Math.round((this.now() - f.since) / 60)} min`, true);
      }
      return true;
    } catch (e) {
      const now = this.now();
      log("error", `job ${name} failed`, { error: String(e) });
      const fails = this.state.daily.jobFailures;
      fails[name] = (fails[name] ?? 0) + 1;
      // a job that was not run for a while (frozen, or no finalized block) starts a new streak, so one old
      // failure cannot make the next one alert at once; an unanswered alert still gets its "recovered"
      const prev = this.failing.get(name);
      const f = prev && now - prev.last <= JOB_ALERT_AFTER ? prev : { since: now, last: now, alerted: prev?.alerted ?? false };
      f.last = now;
      this.failing.set(name, f);
      if (now - f.since >= JOB_ALERT_AFTER) {
        f.alerted = true;
        await this.alerts.send(`job:${name}`, `keeper job ${name} has failed for ${Math.round((now - f.since) / 60)} min: ${String(e).slice(0, 200)}`);
      }
      return false;
    }
  }

  async cycle(): Promise<void> {
    const now = this.now();
    const day = Math.floor(now / 86_400);
    if (this.state.daily.day !== day) {
      // keep the last full day for the summary; a day the keeper missed counts as empty
      this.state.previousDay = this.state.daily.day === day - 1 ? this.state.daily : emptyDay(day - 1);
      this.state.daily = emptyDay(day);
    }
    await this.job("poll", async () => {
      await this.tx.bsc.poll();
      await this.tx.xlayer.poll();
    });
    let bscBlock: bigint | null = null;
    await this.job("finality", async () => {
      const b = await bscFinalized(this.c);
      bscBlock = b;
      if (b > this.lastFinalized.block) this.lastFinalized = { block: b, at: now };
      else if (this.lastFinalized.at > 0 && now - this.lastFinalized.at > FINALITY_STALL) {
        await this.alerts.send("finality", `BSC finalized block stuck at ${b} for over 10 minutes`);
      }
    });
    await this.job("upgradeWatch", () => this.upgradeWatch(bscBlock));
    if (this.d) {
      const d = this.d;
      await this.job("logs", () => this.scanLogs(d));
      let loans: LoanSnapshot[] = [];
      const loansOk = await this.job("loans", async () => {
        loans = await readLoans(this.c, Object.keys(this.state.agents).map((a) => getAddress(a)));
      });
      if (loansOk && bscBlock !== null) {
        const block: bigint = bscBlock;
        await this.job("harvest", () => this.harvest(d, loans, block, now));
        if (!this.frozen) await this.job("impairment", () => this.impairment(d, loans, block, now));
      }
      if (loansOk) await this.job("sweep", () => this.sweep(d, loans, now));
      if (!d.legacy) {
        await this.job("income", () => this.income(d, now));
        await this.job("backstop", () => this.backstop(d));
      }
    }
    await this.job("balances", () => this.balances(now));
    this.lastCycleAt = now;
    // The app's read-only data comes last, after every guardian job, capped and time-boxed, and it never
    // throws, so it can neither delay nor stop the guardian work (SPEC-PHASE5-APP §8.2).
    if (this.publicData) await this.publicData.run();
  }

  // ───────────────────────── §4.1 upgrade watch

  private async upgradeWatch(bscBlock: bigint | null): Promise<void> {
    // the X Layer reads run even when BSC finality is unavailable (L4)
    const readings = await readWatchTargets(this.c, bscBlock);
    const expected = {
      voucher: EXPECTED_IMPL.voucher,
      rigVault: EXPECTED_IMPL.rigVault,
      podMining: EXPECTED_IMPL.podMining,
      bscCircuitsBeacon: EXPECTED_IMPL.bscCircuitsBeacon,
      bscCircuitsImpl: EXPECTED_IMPL.bscCircuitsImpl,
      xlayerCircuitsImpl: EXPECTED_IMPL.xlayerCircuitsImpl,
    } satisfies Record<Target, Address>;
    const r = stepWatch(this.state.watch, readings, expected);
    this.state.watch = r.state;
    this.frozen = r.frozen;
    for (const a of r.alerts) await this.alerts.send(`watch:${a}`, a, true);
    if (r.state.braked && this.d) await this.brake(this.d, r.state.brakeKind);
  }

  /**
   * Pause borrows and, for a "full" brake, disable the feed (guardian), skipping what is in place or
   * already in flight.
   */
  private async brake(d: Deployment, kind: BrakeKind): Promise<void> {
    const x = this.c.xlayer.public;
    const [paused, disabled] = await Promise.all([
      x.readContract({ address: d.pool, abi: poolAbi, functionName: "borrowsPaused" }),
      x.readContract({ address: d.pool, abi: poolAbi, functionName: "feedDisabled" }),
    ]);
    if (!paused && !this.tx.xlayer.hasPending("pauseBorrows")) {
      await this.send(this.tx.xlayer, { label: "pauseBorrows", address: d.pool, abi: poolAbi, functionName: "pauseBorrows", urgency: "urgent" }, true);
    }
    if (kind === "full" && !disabled && !this.tx.xlayer.hasPending("disableFeed")) {
      await this.send(this.tx.xlayer, { label: "disableFeed", address: d.pool, abi: poolAbi, functionName: "disableFeed", urgency: "urgent" }, true);
    }
  }

  // ───────────────────────── §4.2 admin watch and agent discovery

  private async scanLogs(d: Deployment): Promise<void> {
    const x = this.c.xlayer.public;
    // stop LOG_LAG short of the head: a lagging endpoint must not answer a range it has not seen (part E §3.2)
    const head = (await x.getBlockNumber()) - LOG_LAG;
    if (head < 0n) return; // a chain shorter than LOG_LAG (a fresh local node)
    let from = BigInt(this.state.cursor);
    for (let page = 0n; page < MAX_PAGES_PER_CYCLE && from <= head; page++) {
      const to = from + LOG_PAGE - 1n > head ? head : from + LOG_PAGE - 1n;
      const [created, admin, screen] = await Promise.all([
        x.getContractEvents({ address: d.factory, abi: factoryAbi, eventName: "AgentCreated", fromBlock: from, toBlock: to }),
        x.getContractEvents({ address: d.pool, abi: poolAbi, fromBlock: from, toBlock: to }),
        x.getContractEvents({ address: d.screen, abi: screenAbi, fromBlock: from, toBlock: to }),
      ]);
      for (const e of created) {
        const { agent, borrower } = e.args as { agent: Address; borrower: Address };
        this.state.agents[getAddress(agent)] = getAddress(borrower);
      }
      const agents = Object.keys(this.state.agents).map((a) => getAddress(a));
      for (let i = 0; i < agents.length; i += 50) {
        const flags = await x.getContractEvents({ address: agents.slice(i, i + 50), abi: agentAbi, eventName: "ImpairmentFlagged", fromBlock: from, toBlock: to });
        for (const e of flags) {
          const { rigId } = e.args;
          if (rigId === undefined) continue;
          let verdict = "unknown", observedAt = "unknown";
          try {
            const block = await this.c.bsc.public.getBlock({ blockTag: "finalized" });
            const [rig] = await readBscRigs(this.c, [rigId], block.number);
            observedAt = block.timestamp.toString();
            if (rig?.ok) verdict = classify(rig) === "healthy" ? "healthy" : "impaired";
          } catch { /* still alert on the flag when the independent source is unavailable */ }
          await this.alerts.send(`flag:${e.transactionHash}:${e.logIndex}`, `ImpairmentFlagged on ${e.address}, rig ${rigId}: ${verdict}, observedAt ${observedAt} (keeper BSC read)`, true);
        }
      }
      for (const e of [...admin, ...screen]) {
        if (!e.eventName || !ADMIN_EVENTS.has(e.eventName)) continue;
        await this.alerts.send(
          `admin:${e.transactionHash}:${e.logIndex}`,
          `admin event ${e.eventName} at block ${e.blockNumber}: ${JSON.stringify(e.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`,
          true,
        );
      }
      // Timestamp positive syncs before changing counters; a failed page can be retried without double counting.
      const synced = admin.filter((e) => e.eventName === "Synced" && ((e.args as { amount?: bigint }).amount ?? 0n) > 0n);
      const times = new Map<bigint, number>();
      for (const e of synced) if (!times.has(e.blockNumber)) times.set(e.blockNumber, Number((await x.getBlock({ blockNumber: e.blockNumber })).timestamp));
      for (const e of synced) {
        const day = Math.floor(times.get(e.blockNumber)! / 86_400);
        const counter = day === this.state.daily.day ? this.state.daily : day === this.state.previousDay.day ? this.state.previousDay : null;
        if (counter) counter.synced = (BigInt(counter.synced) + (e.args as { amount: bigint }).amount).toString();
        // A third-party sync also starts a new age for any later positive surplus.
        delete this.state.income.positiveSince;
      }
      from = to + 1n;
      this.state.cursor = from.toString();
    }
    if (from <= head) {
      await this.alerts.send("logs:behind", `log scan is ${head - from + 1n} blocks behind (catching up)`);
    }
  }

  // ───────────────────────── §4.3 harvest

  /**
   * A loan's rigs are harvested once in the last hour before maturity, then every 72 h while it stays
   * open; seized vouchers every `SEIZED_HARVEST_EVERY_H` and with any batch that goes out anyway
   * (SPEC-PHASE3-OPSFEE §5.1). Harvests continue for every loan, including sponsored terms.
   */
  private async harvest(d: Deployment, loans: LoanSnapshot[], bscBlock: bigint, now: number): Promise<void> {
    this.harvestedThisCycle = new Set();
    const open = loans.filter((l) => l.loan.open);
    const openKeys = new Set(open.map((l) => loanKey(l.agent, l.start)));
    const readAgents = new Set(loans.map((l) => l.agent.toLowerCase())); // a failed read keeps its records
    pruneEvidence(this.state.evidence, openKeys, readAgents);
    const incidents = new Set(open.map((l) => `${loanKey(l.agent, l.start)}:${l.loan.impairedAt}`));
    for (const key of Object.keys(this.state.refresh)) {
      if (readAgents.has(key.split(":")[0]!) && !incidents.has(key.slice(0, key.lastIndexOf(":")))) delete this.state.refresh[key];
    }
    const seized = await readSeized(this.c, d);
    for (const k of this.coverCheckedAt.keys()) if (!openKeys.has(k)) this.coverCheckedAt.delete(k);
    // the scheduled harvest never waits on the covered check (part E §3.1)
    let covered = new Set<string>();
    try {
      covered = await this.coveredLoans(open, bscBlock, now);
    } catch (e) {
      log("warn", "covered check failed", { error: String(e) });
    }
    const plan: HarvestPlan = planHarvest(
      now,
      open.map((l) => ({ agent: l.agent, start: l.start, maturity: l.maturity, collateral: l.collateral })),
      seized,
      this.state.harvest,
      this.cfg.seizedHarvestEveryHours,
      covered,
    );
    if (plan.ids.length === 0) {
      recordHarvest(this.state.harvest, plan, now, openKeys, readAgents, false); // drops loans that closed
      return;
    }
    if (this.cfg.holdHarvestOnVaultFreeze && this.frozen && this.state.watch.vaultChanged) {
      await this.alerts.send("harvest:held", "harvests held: the rig vault changed and waits for the owner's review");
      return;
    }
    // a transient read failure or a batch that did not go out is retried next cycle (M1)
    const { allDone, sent } = await this.sendHarvest(plan.ids, bscBlock);
    if (this.cfg.mode === "live") this.harvestedThisCycle = sent;
    if (!allDone) return;
    // a covered harvest counts only once its loan's rigs really went out: not dry, not skipped (part E §3.1)
    const collateral = new Map(open.map((l) => [loanKey(l.agent, l.start), l.collateral]));
    const wentOut = (key: string) => this.cfg.mode === "live" && (collateral.get(key) ?? []).some((id) => sent.has(id));
    plan.due = plan.due.filter((x) => x.kind !== "covered" || wentOut(x.key));
    for (const x of plan.due) {
      // E-O4's evidence: a covered loan whose maturity harvest still went out (a skipped one cost nothing)
      if (x.kind === "maturity" && wentOut(x.key) && this.state.harvest.loans[x.key]?.coveredAt !== undefined) this.state.daily.coveredThenMatured++;
    }
    const seizedSent = plan.seized && seized.some((id) => sent.has(id));
    for (const key of recordHarvest(this.state.harvest, plan, now, openKeys, readAgents, seizedSent)) {
      await this.alerts.send(`shortfall:${key}`, `loan ${key} needed ${SHORTFALL_ALERT_AT} or more harvests after maturity; keeper spend is included in the budget watch`);
    }
  }

  /**
   * Loans whose rigs' bridged output already covers the debt and that the agent cannot close by itself
   * (part E §3.1), each checked at most every `COVER_CHECK_EVERY`. A loan whose rigs could not be read is
   * checked again next cycle; a failed fee read assumes the 5% maximum.
   */
  private async coveredLoans(open: LoanSnapshot[], bscBlock: bigint, now: number): Promise<Set<string>> {
    const out = new Set<string>();
    const candidates = open.filter((l) => {
      const key = loanKey(l.agent, l.start);
      const rec = this.state.harvest.loans[key];
      if (rec?.maturityDone || rec?.coveredAt !== undefined) return false;
      if (now >= l.maturity - PRE_MATURITY) return false; // the maturity harvest is due anyway
      if (l.bem >= l.loan.debt) return false; // the sweep closes it
      return now - (this.coverCheckedAt.get(key) ?? 0) >= COVER_CHECK_EVERY;
    });
    if (candidates.length === 0) return out;
    const rigs = await readBscRigs(this.c, [...new Set(candidates.flatMap((l) => l.collateral))], bscBlock);
    const byId = new Map(rigs.map((r) => [r.id, r]));
    const feeBps = await this.c.bsc.public
      .readContract({ address: ADDR.bemAdapter, abi: oftFeeAbi, functionName: "feeBps" })
      .then((v) => BigInt(v), () => FEE_BPS_FALLBACK);
    for (const l of candidates) {
      const key = loanKey(l.agent, l.start);
      const yes = coveredLoan(
        l.collateral.map((id) => byId.get(id) ?? { ok: false, vaultKnows: false, pending: 0n, cellBalance: 0n }),
        l.bem,
        l.loan.debt,
        feeBps,
        DUST,
      );
      if (yes === null) continue; // a rig was unreadable: check again next cycle
      this.coverCheckedAt.set(key, now);
      if (yes) out.add(key);
    }
    return out;
  }

  /**
   * Harvest `ids` in batches, skipping batches below the bond (K1). `allDone` when every read succeeded
   * and every batch went out; `sent` holds the ids of the batches that went out (or would, in dry mode).
   */
  private async sendHarvest(ids: bigint[], bscBlock: bigint): Promise<{ allDone: boolean; sent: Set<bigint> }> {
    const rigs = await readBscRigs(this.c, ids, bscBlock);
    let allDone = rigs.every((r) => r.ok);
    const sent = new Set<bigint>();
    const batches = planBatches(rigs.filter((r) => r.ok && r.vaultKnows).map((r) => ({ id: r.id, pending: r.pending, cellBalance: r.cellBalance })));
    for (const b of batches) {
      if (b.skip) continue; // below the bond: nothing worth sending (K1)
      const fee = await this.c.bsc.public.readContract({ address: ADDR.rigVault, abi: vaultAbi, functionName: "quoteHarvest", args: [BigInt(b.ids.length)] });
      const res = await this.send(this.tx.bsc, {
        label: `harvest [${b.ids.join(",")}]`,
        address: ADDR.rigVault,
        abi: vaultAbi,
        functionName: "harvest",
        args: [b.ids],
        value: (fee * 11n) / 10n,
        urgency: "routine",
      });
      if (res === "sent") this.state.daily.harvests++;
      if (res === "sent" || res === "dry") for (const id of b.ids) sent.add(id);
      else allDone = false;
    }
    return { allDone, sent };
  }

  // ───────────────────────── §4.4 impairment machine

  private async impairment(d: Deployment, loans: LoanSnapshot[], bscBlock: bigint, now: number): Promise<void> {
    const open = loans.filter((l) => l.loan.open);
    const ids = [...new Set(open.flatMap((l) => l.collateral))];
    if (ids.length === 0) return;
    // the pool's feed state is read once per cycle; if it cannot be read the job fails and plans nothing (RB3-01)
    const [rigs, reports, suspended, feed] = await Promise.all([
      readBscRigs(this.c, ids, bscBlock),
      readReports(this.c, d, ids),
      readSuspended(this.c, d, ids),
      this.feedState(d),
    ]);
    const feedDisabled = feed.disabled;
    const confirmed = new Map<bigint, RigCondition | null>();
    const syncsZero = new Map<bigint, boolean>();
    for (const r of rigs) {
      confirmed.set(r.id, r.ok ? observe(this.confirm, r.id, { condition: classify(r), block: bscBlock }) : observe(this.confirm, r.id, null));
      syncsZero.set(r.id, r.ok && syncsZeroPower(r));
    }
    // evidence harvests in flight: has their sync reached the voucher? (part D §5.2, audit M2)
    const records = await readVoucherRecords(this.c, ids);
    // RB3-03 timing: a push lands at or after the enable floor only once X Layer time is 90 s past feedEnabledAt
    const ready = pushOpen(feed, feed.enabledAt > 0 ? await this.xlayerTime() : null);
    await this.job("enable-push", () => this.enablePushes(d, open, reports, feed, ready, now));
    const due: EvidenceDue[] = [];
    for (const l of open) {
      // one loan's failure must not stop the others (L11)
      await this.job(`impairment:${l.agent}`, async () => {
        const x = this.c.xlayer.public;
        const [flagFrom, seizeFrom] = d.legacy ? [l.start + 1, l.loan.seizeStart] : (await Promise.all([
          x.readContract({ address: l.agent, abi: agentAbi, functionName: "flagEvidenceFrom" }),
          x.readContract({ address: l.agent, abi: agentAbi, functionName: "seizeEvidenceFrom" }),
        ])).map(Number);
        const views: RigView[] = l.collateral.map((id) => ({
          id,
          confirmed: confirmed.get(id) ?? null,
          storedObservedAt: Number(reports.get(id)?.observedAt ?? 0),
          report: reports.get(id), // undefined: the read failed
          voucherSyncedAt: records.get(id)?.syncedAt,
          voucherPower: records.get(id)?.power,
          lastPushAt: this.state.lastPushAt[id.toString()] ?? 0,
          passSuspended: suspended.get(id) ?? false,
        }));
        for (const v of views) {
          if (!pushUnlanded(v, now)) continue;
          // a row B push (RB3-04) goes once per incident and is not retried (final audit L-6)
          const once = this.state.refresh[`${loanKey(l.agent, l.start)}:${l.loan.impairedAt}:${v.id}`]?.pushAt === v.lastPushAt;
          await this.alerts.send(`feed:dead:${v.id}`, once
            ? `the report pushed for rig ${v.id} to clear the flag was not stored after 10 minutes: the feed may be dead (sent once for this flag, not retried)`
            : `the impairment report pushed for rig ${v.id} was not stored after 10 minutes: the feed may be dead (retrying hourly)`);
        }
        // nothing is planned on a failed report read while the feed is on: for a flag or a confirmed suspect, tell
        // the owner once per rig per UTC day (final audit L-2)
        if (!feedDisabled && (l.loan.impairedAt !== 0 || views.some((v) => v.confirmed !== null && v.confirmed !== "healthy"))) {
          const day = Math.floor(now / 86_400);
          for (const v of views) {
            if (v.report !== undefined || this.state.reportAlerts[v.id.toString()] === day) continue;
            this.state.reportAlerts[v.id.toString()] = day;
            await this.alerts.send(`report:unreadable:${v.id}:${day}`, `owner review: the stored report of rig ${v.id} on ${l.agent} cannot be read, so no flag, seize or clear is planned on it`, true);
          }
        }
        let clearAllowed = false;
        const clearPushRigs: bigint[] = [];
        const rowBRigs: bigint[] = [];
        if (l.loan.expired && !feedDisabled) {
          clearAllowed = true;
          const refresh: bigint[] = [];
          const once: bigint[] = [];
          for (const id of l.collateral) {
            const key = `${loanKey(l.agent, l.start)}:${l.loan.impairedAt}:${id}`;
            const rec = this.state.refresh[key] ??= {};
            const p = clearPlan(id, l.loan.impairedRig, seizeFrom!, now, reports.get(id), records.get(id), rec, { feed, confirmed: confirmed.get(id) ?? null, pushOpen: ready });
            if (p.blocks) clearAllowed = false;
            if (p.blocks && p.row === "B") rowBRigs.push(id);
            if (p.push) clearPushRigs.push(id);
            if (p.pushOnce) once.push(id);
            if (p.alert) {
              rec.alerted = true;
              const why = p.row === "B" && rec.pushAt !== undefined
                ? `still blocks the clear after its fresh push (stored impaired report)`
                : `blocks or has an unreadable clear source (${p.verdict})`;
              await this.alerts.send(`clear:${key}`, `owner review: rig ${id} ${why} on ${l.agent}; observedAt ${reports.get(id)?.observedAt ?? "unknown"}`, true);
            }
            // row B waits while the BSC read is unconfirmed; one that stays unconfirmed is alerted like an unreadable
            // refresh source, once per incident (final audit L-5)
            if (p.blocks && p.row === "B" && (confirmed.get(id) ?? null) === null) rec.unconfirmed = (rec.unconfirmed ?? 0) + 1;
            else delete rec.unconfirmed;
            if ((rec.unconfirmed ?? 0) >= ROW_B_UNCONFIRMED_CYCLES && !rec.alerted) {
              rec.alerted = true;
              await this.alerts.send(`clear:${key}`, `owner review: rig ${id} needs a clear refresh but its BSC source is unreadable`, true);
            }
            if (p.harvest) {
              rec.syncedBefore = records.get(id)?.syncedAt;
              if (this.harvestedThisCycle.has(id)) rec.sentAt = now;
              else if (rigs.find((r) => r.id === id)?.ok) refresh.push(id);
              else if (!rec.alerted) {
                rec.alerted = true;
                await this.alerts.send(`clear:${key}`, `owner review: rig ${id} needs a clear refresh but its BSC source is unreadable`, true);
              }
            }
          }
          if (refresh.length > 0) await this.refreshHarvest(d, l, refresh, bscBlock, now);
          if (once.length > 0) await this.clearPush(d, l, once, reports, now);
        }
        const actions = nextActions({ now, loan: l.loan, rigs: views, feedDisabled, feedEnabledAt: feed.enabledAt, pushOpen: ready, suspendOnRevoke: this.cfg.suspendOnRevoke, flagEvidenceFrom: flagFrom, seizeEvidenceFrom: seizeFrom, clearAllowed, clearPushRigs, rowBRigs });
        for (const a of actions) {
          await this.act(d, l.agent, a, now);
          if (a.kind === "flag") {
            // RA-08 may pay and close instead of flagging. Stop using this snapshot.
            const [fresh] = await readLoans(this.c, [l.agent]);
            if (fresh) Object.assign(l, fresh);
            return;
          }
        }
        // path (b) needs a harvest-synced power of 0 while the feed is disabled (part D §5.2)
        const phase = phaseOf(l.loan, now);
        for (const v of views) {
          const ek = evidenceKey(loanKey(l.agent, l.start), v.id);
          const rec = currentIncident(this.state.evidence[ek], l.loan.impairedAt);
          if (rec) this.state.evidence[ek] = rec;
          else delete this.state.evidence[ek]; // none yet, or the flag changed: a new incident
          const voucher = records.get(v.id);
          const accepted = { first: flagFrom!, afterSeize: seizeFrom! };
          if (rec && voucher) await this.checkEvidence(ek, v.id, rec, voucher, now, accepted);
          const zero = syncsZero.get(v.id) ?? false;
          const bad = v.confirmed !== null && v.confirmed !== "healthy" && v.confirmed !== "rescue";
          if (feedDisabled && bad && !zero && (phase === "none" || phase === "window")) {
            await this.alerts.send(
              `evidence:nonzero:${v.id}`,
              `rig ${v.id} is suspect (${v.confirmed}) but a harvest would sync a non-zero power, so it cannot be evidenced while the feed is disabled: the ${phase === "none" ? "flag" : "seize"} waits for enableFeed`,
            );
          }
          const kind = evidenceDue(now, feedDisabled, phase, l.loan.seizeStart, v.confirmed, zero, rec);
          if (kind === "capped") {
            if (rec && !rec.capAlerted) {
              rec.capAlerted = true; // once per incident (N5)
              await this.alerts.send(
                `evidence:capped:${ek}`,
                `evidence harvests for rig ${v.id} used all ${EVIDENCE_MAX_SENDS} sends without a power-0 sync on the voucher: the flag or seize waits for enableFeed`,
              );
            }
          } else if (kind && this.harvestedThisCycle.has(v.id)) {
            // the scheduled harvest that just went out syncs the same power: book it as this evidence
            this.state.evidence[ek] = recordEvidenceSent(rec, kind, now, l.loan.impairedAt);
          } else if (kind) {
            due.push({ rig: v.id, ek, kind, impairedAt: l.loan.impairedAt });
          }
        }
      });
    }
    // one batch for every rig due this cycle (audit L11)
    if (due.length > 0) await this.job("evidence-harvest", () => this.evidenceHarvest(d, due, open, bscBlock, now));
  }

  /**
   * `feedDisabled()` and `feedEnabledAt()` of the pool (R3-01). The legacy stack has no enable floor. A failed read
   * throws, so the impairment job plans no flag, seize or clear this cycle.
   */
  private async feedState(d: Deployment): Promise<FeedView> {
    const x = this.c.xlayer.public;
    const [disabled, enabledAt] = await Promise.all([
      x.readContract({ address: d.pool, abi: poolAbi, functionName: "feedDisabled" }),
      d.legacy ? Promise.resolve(0n) : x.readContract({ address: d.pool, abi: poolAbi, functionName: "feedEnabledAt" }),
    ]);
    return { disabled: Boolean(disabled), enabledAt: Number(enabledAt) };
  }

  /**
   * The latest X Layer block time, or null when it cannot be read: the RB3-03 timing rule then fails closed. The read
   * runs as its own job, so a failure is logged every cycle and alerts like any job failing for `JOB_ALERT_AFTER`
   * (final audit L-1): a lasting failure withholds every evidence and health push, and must not do so silently.
   */
  private async xlayerTime(): Promise<number | null> {
    let at: number | null = null;
    await this.job("xlayer-time", async () => {
      try {
        at = Number((await this.c.xlayer.public.getBlock({ blockTag: "latest" })).timestamp);
      } catch (e) {
        throw new Error(`X Layer time cannot be read, so evidence and health pushes are withheld after the feed re-enable: ${String(e)}`);
      }
    });
    return at;
  }

  /**
   * RB3-03: once the keeper sees `feedEnabledAt` increase, push a fresh report for every collateral rig of every
   * loan with a live or an expired flag, so post-enable evidence or health exists inside the 24 h window; the
   * per-loan machine then plans on what lands. A rig is done once the receiver holds a report observed at or after
   * the enable floor, or once it is no longer collateral of a flagged loan. Pushes wait for the timing rule (`ready`)
   * and the push cooldown, stay outside the request quota, and never take the keeper below the harvest reserve.
   */
  private async enablePushes(d: Deployment, open: LoanSnapshot[], reports: Map<bigint, Report | null>, feed: FeedView, ready: boolean, now: number): Promise<void> {
    const flagged = open.filter((l) => l.loan.impairedAt !== 0).flatMap((l) => l.collateral);
    if (feed.enabledAt > (this.state.feedRound?.enabledAt ?? 0)) {
      this.state.feedRound = { enabledAt: feed.enabledAt, rigs: [...new Set(flagged.map(String))] };
      log("info", "feed re-enabled: post-enable pushes", { enabledAt: feed.enabledAt, rigs: this.state.feedRound.rigs });
    }
    const round = this.state.feedRound;
    if (!round || round.rigs.length === 0) return;
    const floor = enableFloor(feed);
    const still = new Set(flagged.map(String));
    const storedAt = (id: bigint) => {
      const r = reports.get(id);
      return r && r.rigId === id ? Number(r.observedAt) : 0;
    };
    // an unreadable report keeps the rig in the round
    round.rigs = round.rigs.filter((id) => still.has(id) && storedAt(BigInt(id)) < floor);
    if (round.rigs.length === 0 || feed.disabled || !ready) return;
    const due = round.rigs.map(BigInt).filter((id) => pushIfDue({ id, lastPushAt: this.state.lastPushAt[id.toString()] ?? 0, storedObservedAt: storedAt(id) }, now).length > 0);
    if (due.length === 0) return;
    let balance = await this.c.bsc.public.getBalance({ address: this.c.account.address });
    let held = false;
    for (let i = 0; i < due.length; i += 16) {
      const results = await isolatedPush(due.slice(i, i + 16),
        async (ids) => (await this.c.bsc.public.readContract({ address: d.reporter, abi: reporterAbi, functionName: "quote", args: [ids] })) * 11n / 10n,
        async (ids, fee) => {
          if (balance - fee < this.cfg.bnbReserve) {
            held = true;
            return { status: "waiting", reason: "keeper reserve" };
          }
          const r = await this.sendResult(this.tx.bsc, { label: `enable-push [${ids.join(",")}]`, address: d.reporter, abi: reporterAbi, functionName: "push", args: [ids], value: fee, urgency: "urgent" }, true);
          if (r.status === "sent") balance -= fee;
          return r;
        },
        (id) => this.custodyAlert(id, now));
      for (const { ids, result } of results) if (result.status === "sent") {
        this.state.daily.pushes++;
        for (const id of ids) this.state.lastPushAt[id.toString()] = now;
      }
    }
    if (held) await this.alerts.send("push:reserve:enable", "post-enable pushes held: the keeper BNB is down to the harvest reserve");
  }

  /**
   * RB3-04: one fresh push per incident for each rig whose clear a stored impaired report blocks (row B) while the
   * keeper's own BSC read shows it healthy, so a row H report overtakes the block; no refresh harvest. A rig with a
   * push sent inside the cooldown waits for that one, and its incident push stays unspent.
   */
  private async clearPush(d: Deployment, loan: LoanSnapshot, wanted: bigint[], reports: Map<bigint, Report | null>, now: number): Promise<void> {
    const incident = `${loanKey(loan.agent, loan.start)}:${loan.loan.impairedAt}`;
    const ids = wanted.filter((id) => now - (this.state.lastPushAt[id.toString()] ?? 0) >= PUSH_COOLDOWN);
    if (ids.length === 0) return;
    const results = await isolatedPush(ids,
      async (part) => (await this.c.bsc.public.readContract({ address: d.reporter, abi: reporterAbi, functionName: "quote", args: [part] })) * 11n / 10n,
      (part, fee) => this.sendResult(this.tx.bsc, { label: `clear-push [${part.join(",")}] for ${incident}`, address: d.reporter, abi: reporterAbi, functionName: "push", args: [part], value: fee, urgency: "routine" }),
      (id) => this.custodyAlert(id, now));
    for (const { ids: part, result } of results) if (result.status === "sent") {
      this.state.daily.pushes++;
      for (const id of part) {
        this.state.lastPushAt[id.toString()] = now;
        const key = `${incident}:${id}`;
        // the report stored now, so the push's own report can be told from it (final audit L-4)
        const r = reports.get(id);
        this.state.refresh[key] = { ...this.state.refresh[key], pushAt: now, storedBefore: r && r.rigId === id ? Number(r.observedAt) : 0 };
      }
    }
  }

  /** CustodyUnreadable: the rig is left out of pushes, alerted once per rig per UTC day. */
  private custodyAlert(id: bigint, now: number): void {
    const day = Math.floor(now / 86_400);
    if (this.state.custodyAlerts[id.toString()] === day) return;
    this.state.custodyAlerts[id.toString()] = day;
    void this.alerts.send(`custody:${id}:${day}`, `CustodyUnreadable: rig ${id} excluded from pushes; owner review required`, true);
  }

  /** Refresh health once for each blocking rig of this flag, including non-flagged collateral. */
  private async refreshHarvest(d: Deployment, loan: LoanSnapshot, wanted: bigint[], block: bigint, now: number): Promise<void> {
    const all = await readBscRigs(this.c, loan.collateral, block);
    const readable = all.filter((r) => r.ok && r.vaultKnows);
    const targets = readable.filter((r) => wanted.includes(r.id));
    if (targets.length === 0) return;
    const { ids, needsBond } = bundleEvidence(targets, readable, BOND, DUST, MAX_BATCH);
    if (needsBond && !(await this.bondReady())) return;
    const fee = await this.c.bsc.public.readContract({ address: ADDR.rigVault, abi: vaultAbi, functionName: "quoteHarvest", args: [BigInt(ids.length)] });
    const result = await this.send(this.tx.bsc, { label: `refresh-harvest [${ids.join(",")}] for ${loanKey(loan.agent, loan.start)}:${loan.loan.impairedAt}`, address: ADDR.rigVault, abi: vaultAbi, functionName: "harvest", args: [ids], value: fee * 11n / 10n, urgency: "routine" });
    if (result !== "sent") return;
    this.state.daily.harvests++;
    for (const r of targets) {
      const key = `${loanKey(loan.agent, loan.start)}:${loan.loan.impairedAt}:${r.id}`;
      this.state.refresh[key] = { ...this.state.refresh[key], sentAt: now };
    }
  }

  /** Has a sent evidence harvest reached the voucher? Counts it, or alerts (part D §5.2, audit M2). */
  private async checkEvidence(
    ek: string,
    rig: bigint,
    rec: EvidenceRec,
    voucher: { syncedAt: number; power: bigint },
    now: number,
    accepted: Record<EvidenceKind, number>,
  ): Promise<void> {
    const r = evidenceLanded(rec, now, voucher, LANDED_SLACK, accepted);
    if (r === "notEvidence") {
      await this.alerts.send(
        `evidence:notzero:${ek}`,
        `the evidence harvest for rig ${rig} synced power ${voucher.power}, not 0: not evidence; one more is sent after an hour only if the rig still reads as syncing 0, else the flag waits for enableFeed`,
      );
    } else if (r === "unlanded") {
      await this.alerts.send(
        `evidence:unlanded:${ek}`,
        `the evidence harvest for rig ${rig} has not synced the voucher on X Layer after 10 minutes: retrying after an hour, at most ${EVIDENCE_MAX_SENDS} sends per incident`,
      );
    }
  }

  /**
   * One evidence harvest for every rig in `due`. The batch adds other harvestable rigs (open loans,
   * seized vouchers) until it clears the bond; otherwise the keeper fronts the bond from its BEM float
   * on BSC. A sent harvest counts toward the two per incident only once its sync is seen (checkEvidence).
   */
  private async evidenceHarvest(d: Deployment, due: EvidenceDue[], open: LoanSnapshot[], bscBlock: bigint, now: number): Promise<void> {
    const wanted = due.map((e) => e.rig);
    const others = [...new Set([...open.flatMap((l) => l.collateral), ...(await readSeized(this.c, d))])].filter((id) => !wanted.includes(id));
    const reads = (await readBscRigs(this.c, [...wanted, ...others], bscBlock)).filter((r) => r.ok && r.vaultKnows);
    // a rig unreadable this cycle, or rescued (filtered by the vault), is not harvested now
    const targets = reads.filter((r) => wanted.includes(r.id));
    if (targets.length === 0) return;
    const { ids, needsBond } = bundleEvidence(targets, reads, BOND, DUST, MAX_BATCH);
    if (needsBond && !(await this.bondReady())) return;
    const fee = await this.c.bsc.public.readContract({ address: ADDR.rigVault, abi: vaultAbi, functionName: "quoteHarvest", args: [BigInt(ids.length)] });
    const forRigs = targets.map((r) => r.id).filter((id) => ids.includes(id));
    const res = await this.send(
      this.tx.bsc,
      { label: `evidence-harvest [${ids.join(",")}] for rig ${forRigs.join(",")}`, address: ADDR.rigVault, abi: vaultAbi, functionName: "harvest", args: [ids], value: (fee * 11n) / 10n, urgency: "urgent" },
      true,
    );
    if (res !== "sent") return;
    this.state.daily.harvests++;
    for (const e of due) {
      if (forRigs.includes(e.rig)) this.state.evidence[e.ek] = recordEvidenceSent(this.state.evidence[e.ek], e.kind, now, e.impairedAt);
    }
  }

  /** The keeper can front one harvest bond: BEM on BSC and an allowance to the vault (approving if needed). */
  private async bondReady(): Promise<boolean> {
    const me = this.c.account.address;
    const b = this.c.bsc.public;
    const [held, allowance] = await Promise.all([
      b.readContract({ address: ADDR.bemBsc, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
      b.readContract({ address: ADDR.bemBsc, abi: erc20Abi, functionName: "allowance", args: [me, ADDR.rigVault] }),
    ]);
    if (held < BOND) {
      await this.alerts.send("bem:float:empty", `an evidence harvest needs the 0.0001 BEM bond, but the keeper holds ${held} raw BEM on BSC: send BEM to the keeper on BSC`);
      return false;
    }
    if (allowance < BOND) {
      // approve once (not again while it is in flight); the harvest follows on a later cycle, once mined
      if (this.tx.bsc.hasPending(APPROVE_FLOAT)) return false;
      await this.send(this.tx.bsc, { label: APPROVE_FLOAT, address: ADDR.bemBsc, abi: erc20Abi, functionName: "approve", args: [ADDR.rigVault, FLOAT_APPROVAL], urgency: "urgent" }, true);
      return false;
    }
    return true;
  }

  private async act(d: Deployment, agent: Address, a: Action, now: number): Promise<void> {
    switch (a.kind) {
      case "alert":
        await this.alerts.send(`impair:${a.text}`, a.text);
        return;
      case "suspend":
        await this.send(this.tx.xlayer, { label: `suspendPass ${a.rig}`, address: d.screen, abi: screenAbi, functionName: "suspendPass", args: [a.rig], urgency: "urgent" }, true);
        return;
      case "push": {
        // impairment pushes ignore the request limits and the reserve (§5.3 rule 7); fee + 10% (L1)
        const results = await isolatedPush(a.rigs,
          async (ids) => (await this.c.bsc.public.readContract({ address: d.reporter, abi: reporterAbi, functionName: "quote", args: [ids] })) * 11n / 10n,
          (ids, fee) => this.sendResult(this.tx.bsc, { label: `push [${ids.join(",")}]`, address: d.reporter, abi: reporterAbi, functionName: "push", args: [ids], value: fee, urgency: "urgent" }),
          (id) => this.custodyAlert(id, now));
        for (const { ids, result } of results) if (result.status === "sent") {
          this.state.daily.pushes++;
          for (const id of ids) this.state.lastPushAt[id.toString()] = now;
        }
        return;
      }
      case "flag":
        if (this.tx.xlayer.hasPending(`flagImpaired ${agent} rig ${a.rig}`)) return;
        await this.send(this.tx.xlayer, { label: `flagImpaired ${agent} rig ${a.rig}`, address: agent, abi: agentAbi, functionName: "flagImpaired", args: [a.rig], urgency: "urgent" }, true);
        return;
      case "seize":
        await this.send(this.tx.xlayer, { label: `seize ${agent}`, address: agent, abi: agentAbi, functionName: "seize", urgency: "urgent" }, true);
        return;
      case "clear":
        await this.send(this.tx.xlayer, { label: `clearExpiredFlag ${agent}`, address: agent, abi: agentAbi, functionName: "clearExpiredFlag", urgency: "routine" }, true);
        return;
    }
  }

  // ───────────────────────── §4.5 sweep, claimLate, forwardVouchers

  private async sweep(d: Deployment, loans: LoanSnapshot[], now: number): Promise<void> {
    for (const l of loans) {
      const key = l.agent;
      if (l.closed && l.collateral.length > 0 && now - (this.state.lastForwardAt[key] ?? 0) >= FORWARD_EVERY) {
        // a stuck voucher does not revert forwardVouchers, so this runs at most hourly (M2); a failed read retries next cycle
        try {
          await this.forwardKept(d, l, now);
        } catch (e) {
          log("warn", "voucher holder read failed", { agent: l.agent, error: String(e) });
        }
      }
      if (now - (this.state.lastSweepAt[key] ?? 0) < SWEEP_EVERY) continue;
      const enough = l.bem >= this.cfg.sweepMin || (l.loan.open && l.bem >= l.loan.debt && l.bem > 0n);
      if (!enough) continue;
      // an open loan is repaid by sweep; with no loan, claimLate forwards to the borrower (or the pool if closed)
      const fn = l.loan.open ? "sweep" : "claimLate";
      const res = await this.send(this.tx.xlayer, { label: `${fn} ${key}`, address: l.agent, abi: agentAbi, functionName: fn, urgency: "routine" });
      if (res === "sent" || res === "dry") this.state.lastSweepAt[key] = now;
    }
  }

  /**
   * RB3-06: a closed agent keeps every id it cannot hand to the pool listed for good (R3-02), so the keeper calls
   * `forwardVouchers` only when its own `ownerOf` read names the agent or the pool for a listed id (the pool's are
   * then removed). An id held by anyone else is alerted once and not retried; an unreadable one (a revert or the
   * zero address) is alerted once and read again next hour. Reads go on hourly, so a voucher that comes back to
   * the agent is forwarded.
   */
  private async forwardKept(d: Deployment, l: LoanSnapshot, now: number): Promise<void> {
    const holders = await readOwners(this.c, l.collateral);
    this.state.lastForwardAt[l.agent] = now;
    const agent = l.agent.toLowerCase(), pool = d.pool.toLowerCase();
    const movable: bigint[] = [];
    for (const id of l.collateral) {
      const h = holders.get(id)?.toLowerCase() ?? null;
      if (h === agent || h === pool) {
        movable.push(id);
        continue;
      }
      const k = `${agent}:${id}`;
      if (this.state.keptAlerts[k] !== undefined) continue;
      this.state.keptAlerts[k] = h ?? "unknown";
      await this.alerts.send(`kept:${k}`, h === null
        ? `owner review: the holder of voucher ${id}, listed by closed agent ${l.agent}, cannot be read; forwardVouchers waits until it reads as the agent or the pool`
        : `owner review: voucher ${id}, listed by closed agent ${l.agent}, is held by ${getAddress(h)}, not the agent or the pool; forwardVouchers is not retried for it`, true);
    }
    if (movable.length === 0) return;
    await this.alerts.send(`stuck:${l.agent}`, `agent ${l.agent} is closed and lists vouchers [${movable.join(",")}] held by the agent or the pool: calling forwardVouchers`);
    await this.send(this.tx.xlayer, { label: `forwardVouchers ${l.agent}`, address: l.agent, abi: agentAbi, functionName: "forwardVouchers", urgency: "routine" });
  }

  // ───────────────────────── §4.6 balances and the daily summary

  private async balances(now: number): Promise<void> {
    const me = this.c.account.address;
    const [bnb, okb] = await Promise.all([this.c.bsc.public.getBalance({ address: me }), this.c.xlayer.public.getBalance({ address: me })]);
    this.state.spendStartedAt ||= now;
    this.state.spend = this.state.spend.filter((s) => s.at > now - 8 * 86_400);
    const estimate = dailySpend(this.state.spend, this.state.spendStartedAt, now);
    const target = this.cfg.bnbReserve + 14n * estimate;
    if (bnb - this.cfg.bnbReserve < 7n * estimate) await this.alerts.send("bnb", `keeper BNB low: ${formatEther(bnb)}; spend estimate ${formatEther(estimate)} BNB/day; float target ${formatEther(target)} BNB (reserve ${formatEther(this.cfg.bnbReserve)})`);
    if (okb < OKB_LOW) await this.alerts.send("okb", `keeper OKB low: ${formatEther(okb)}`);
    const day = Math.floor(now / 86_400);
    const hour = Math.floor((now % 86_400) / 3_600);
    if (hour >= 1 && this.state.lastSummaryDay < day) {
      this.state.lastSummaryDay = day;
      let pool = "not deployed";
      let loansLine = "";
      if (this.d) {
        const x = this.c.xlayer.public;
        const [idle, outstanding, doubtful, reserve] = await Promise.all(
          (["idle", "outstandingPrincipal", "doubtful", "reserve"] as const).map((fn) => x.readContract({ address: this.d!.pool, abi: poolAbi, functionName: fn })),
        );
        pool = `idle ${idle}, outstanding ${outstanding}, doubtful ${doubtful}, reserve ${reserve} (raw BEM)`;
        const snap = await readLoans(this.c, Object.keys(this.state.agents).map((a) => getAddress(a)));
        loansLine = `; open loans ${snap.filter((s) => s.loan.open).length}`;
        const rig = snap.flatMap((s) => s.collateral).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0] ?? 1n;
        // a failed read here must not cost the day's summary (audit L9)
        const line = async (what: string, f: () => Promise<string>) => {
          try {
            return await f();
          } catch (e) {
            log("warn", `${what} unavailable`, { error: String(e) });
            return `${what} unavailable`;
          }
        };
        loansLine += `; ${await line("fee coverage", () => this.coverage(this.d!, rig, day))}; ${await line("BEM float", () => this.floatLine(day))}`;
      }
      const yesterday = this.state.previousDay;
      await this.alerts.send(
        "summary",
        `daily summary (${this.cfg.mode}): pool ${pool}${loansLine}; agents ${Object.keys(this.state.agents).length}; harvests ${yesterday.harvests}, pushes ${yesterday.pushes}, synced ${yesterday.synced} raw BEM, covered then matured ${yesterday.coveredThenMatured} yesterday; job failures ${failLine(yesterday.jobFailures)}; keeper ${formatEther(bnb)} BNB, ${formatEther(okb)} OKB; sponsor spend ${formatEther(estimate)} BNB/day; float target ${formatEther(target)} BNB${this.frozen ? "; FROZEN" : ""}`,
        true,
      );
    }
  }

  /**
   * Fee coverage watch (part D §5.3): the BSC cost of one loan under the maturity schedule (one push and
   * one harvest, at today's quotes and gas price), in OKB at the owner-set `OKB_PER_BNB`, against
   * each term's `opsFee`. Alerts below 110%; the keeper never changes parameters.
   */
  private async coverage(d: Deployment, rig: bigint, day: number): Promise<string> {
    const x = this.c.xlayer.public;
    const fees = await Promise.all([0, 1].map((term) => x.readContract({ address: d.pool, abi: poolAbi, functionName: "opsFee", args: [term] })));
    const sponsored = fees.map((fee, i) => fee === 0n ? `${i === 0 ? "7d" : "14d"} sponsored` : "").filter(Boolean);
    const sponsorLine = `${sponsored.join(", ")}; sponsor spend ${formatEther(dailySpend(this.state.spend, this.state.spendStartedAt || this.now(), this.now()))} BNB/day`;
    if (fees.every((fee) => fee === 0n)) return sponsorLine;
    if (this.cfg.okbPerBnb === null) {
      if (this.cfg.mode === "live") await this.alerts.send(`coverage:unset:${day}`, "fee coverage not configured: set OKB_PER_BNB");
      return sponsored.length > 0 ? `${sponsorLine}; fee coverage not configured` : "fee coverage not configured";
    }
    const b = this.c.bsc.public;
    const [pushFee, harvestFee, gasPrice] = await Promise.all([
      b.readContract({ address: d.reporter, abi: reporterAbi, functionName: "quote", args: [[rig]] }),
      b.readContract({ address: ADDR.rigVault, abi: vaultAbi, functionName: "quoteHarvest", args: [1n] }),
      b.getGasPrice(),
    ]);
    const [fee7, fee14] = fees as [bigint, bigint];
    const costBnb = pushFee + harvestFee + (PUSH_GAS + HARVEST_GAS) * gasPrice;
    const costOkb = (costBnb * this.cfg.okbPerBnb) / 10n ** 18n;
    const pct = (fee: bigint) => (costOkb === 0n ? 0n : (fee * 100n) / costOkb);
    const [p7, p14] = [pct(fee7), pct(fee14)];
    for (const [term, p] of [["7 days", p7], ["14 days", p14]] as const) {
      if ((term === "7 days" ? fee7 : fee14) === 0n) continue;
      if (p < COVERAGE_ALERT_PCT) {
        await this.alerts.send(`coverage:${term}:${day}`, `the ${term} operating fee covers ${p}% of a loan's BSC cost (${formatEther(costOkb)} OKB): queue a new value`);
      }
    }
    return `fee coverage 7d ${fee7 === 0n ? "sponsored" : `${p7}%`}, 14d ${fee14 === 0n ? "sponsored" : `${p14}%`} of ${formatEther(costOkb)} OKB${sponsored.length > 0 ? `; ${sponsorLine}` : ""}`;
  }

  /** The BEM float on BSC for evidence-harvest bonds (part D §5.2). */
  private async floatLine(day: number): Promise<string> {
    const held = await this.c.bsc.public.readContract({ address: ADDR.bemBsc, abi: erc20Abi, functionName: "balanceOf", args: [this.c.account.address] });
    if (held < BEM_FLOAT) {
      await this.alerts.send(`bem:float:${day}`, `the keeper's refundable BEM bond float on BSC holds ${held} raw BEM; target 0.001 BEM`);
    }
    return `BEM float ${held} raw`;
  }

  // ───────────────────────── helpers

  /**
   * Send through `s` and report: urgent sends alert; with `alertOnFailure`, an unexpected simulation
   * revert or a wait alerts at once (H4); harvests and pushes alert after two consecutive reverts.
   */
  private async income(d: Deployment, now: number): Promise<void> {
    const x = this.c.xlayer.public;
    const blockNumber = await x.getBlockNumber();
    const [balance, tracked] = await Promise.all([
      x.readContract({ address: ADDR.bemXLayer, abi: erc20Abi, functionName: "balanceOf", args: [d.pool], blockNumber }),
      x.readContract({ address: d.pool, abi: poolAbi, functionName: "tracked", blockNumber }),
    ]);
    const due = syncDue(this.state.income, balance, tracked, now);
    if (!due || this.tx.xlayer.hasPending("sync income")) return;
    await this.send(this.tx.xlayer, { label: "sync income", address: d.pool, abi: poolAbi, functionName: "sync", urgency: "routine" });
  }

  private async backstop(d: Deployment): Promise<void> {
    const x = this.c.xlayer.public;
    const blockNumber = await x.getBlockNumber();
    const backstop = await x.readContract({ address: d.pool, abi: poolAbi, functionName: "backstop", blockNumber });
    const shares = await x.readContract({ address: d.pool, abi: poolAbi, functionName: "balanceOf", args: [backstop], blockNumber });
    const [value, principal] = await Promise.all([
      x.readContract({ address: d.pool, abi: poolAbi, functionName: "convertToAssets", args: [shares], blockNumber }),
      x.readContract({ address: d.pool, abi: poolAbi, functionName: "outstandingPrincipal", blockNumber }),
    ]);
    if (principal * 10n > value * 9n) await this.alerts.send("backstop", `backstop usage above 90%: outstanding ${principal}, backstop value ${value} raw BEM`);
  }

  private async send(s: Sender, call: Call, alertOnFailure = false): Promise<SendStatus> {
    return (await this.sendResult(s, call, alertOnFailure)).status;
  }

  private async sendResult(s: Sender, call: Call, alertOnFailure = false): Promise<SendResult> {
    const r = await s.send(call);
    const kind = call.label.split(" ")[0] ?? call.label;
    if (r.status === "sent") {
      this.revertStreak.delete(kind);
      if (call.urgency === "urgent") await this.alerts.send(`tx:${r.hash}`, `sent ${call.label}: ${r.hash}`, true);
    } else if (r.status === "dry") {
      if (call.urgency === "urgent") await this.alerts.send(`dry:${call.label}`, `dry mode: would send ${call.label}`);
    } else if (r.status === "reverted") {
      if (EXPECTED_REVERTS.has(r.reason)) return r;
      if (alertOnFailure) {
        // the first alert goes out at once; a revert that repeats every cycle is throttled (30 min)
        await this.alerts.send(`revert:${call.label}`, `${call.label} would revert (${r.reason}); not sent`);
      } else {
        const n = (this.revertStreak.get(kind) ?? 0) + 1;
        this.revertStreak.set(kind, n);
        if (n >= 2) await this.alerts.send(`revert:${kind}`, `${call.label} reverted in simulation ${n} cycles in a row (${r.reason})`);
      }
    } else if (alertOnFailure) {
      await this.alerts.send(`wait:${call.label}`, `${call.label} is waiting: ${r.reason}`);
    }
    return r;
  }
}
