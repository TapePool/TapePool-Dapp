// Push on request (SPEC-PHASE3-KEEPER §5): admits a borrower's request before any chain read, checks
// it, batches accepted requests for 5 s, and pushes the union of their rig ids (at most 16 per message).
import { getAddress, isAddress, type Address } from "viem";
import { ADDR, type Deployment } from "./addresses.js";
import { agentAbi, factoryAbi, poolAbi, reporterAbi, screenAbi } from "./abi.js";
import type { Clients } from "./chains.js";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { FEED_SETTLE, LANDED_SLACK } from "./logic/evidence.js";
import { REPORT_REUSE_AGE, type PushDecision, type PushLimiter } from "./logic/pushLimits.js";
import { isolatedPush, isolatedQuotes } from "./pushIsolation.js";
import { bscFinalized, readBscRigs, readReportTimes } from "./reads.js";
import type { Sender } from "./tx.js";

const BATCH_WINDOW_MS = 5_000;
/** Must equal `CreditPolicy.MIN_RIG_AGE` (3 days since 2026-10-21): a younger rig is refused a push. */
export const MIN_RIG_AGE = 3n * 86_400n;
export const ageOk = (since: bigint, now: number) => since > 0n && BigInt(now) >= since + MIN_RIG_AGE;
const MAX_IN_FLIGHT = 2; // concurrent requests being evaluated
const CACHE_SEC = 30; // per-agent chain inputs are reused this long
const DELIVERY_ALERT_SEC = 600; // a pushed report not stored by then means a dead feed (§4.6)
const MAX_RETRIES = 6;

/** The refusal while `lend` waits `FEED_SETTLE` after `enableFeed` (RB3-03); the app shows the same text. */
export const FEED_SETTLING = "feed settling: borrowing reopens a few minutes after the data feed is turned back on";

interface Inputs {
  at: number;
  isAgent: boolean;
  borrower: Address;
  ids: bigint[];
  eligible: Map<bigint, boolean>;
  /** X Layer time is before `feedEnabledAt + FEED_SETTLE`. */
  settling?: boolean;
}

export class PushService {
  private pending = new Set<bigint>();
  private individual = new Set<bigint>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight = 0;
  private cache = new Map<string, Inputs>();
  /** Pushes sent on request, waiting to be seen on the receiver. */
  private sent: { ids: bigint[]; at: number }[] = [];
  private custodyAlerts: Record<string, number> = {};

  constructor(
    private readonly cfg: Config,
    private readonly c: Clients,
    private readonly d: Deployment | null,
    private readonly bsc: Sender,
    private readonly limiter: PushLimiter,
    private readonly isFrozen: () => boolean,
    private readonly alert: (kind: string, text: string) => void,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly persist: () => void = () => {},
    custodyAlerts?: Record<string, number>,
  ) {
    if (custodyAlerts) this.custodyAlerts = custodyAlerts;
    if (d && bsc.pendingPushes) this.sent = bsc.pendingPushes(d.reporter);
  }

  private unreadable = (id: bigint): void => {
    const day = Math.floor(this.now() / 86_400);
    if (this.custodyAlerts[id.toString()] === day) return;
    this.custodyAlerts[id.toString()] = day;
    this.alert(`custody:${id}:${day}`, `CustodyUnreadable: rig ${id} excluded from pushes; owner review required`);
  };

  private isPending(id: bigint, stored: Map<bigint, number>): boolean {
    const unlanded = (s: { ids: bigint[]; at: number }) => s.ids.includes(id) && (stored.get(id) ?? 0) + LANDED_SLACK < s.at;
    return this.pending.has(id) || this.sent.some(unlanded) || (this.d && this.bsc.pendingPushes?.(this.d.reporter).some(unlanded)) === true;
  }

  async request(agentRaw: unknown, ip: string): Promise<PushDecision> {
    const now = this.now();
    this.limiter.prune(now);
    const admitted = this.limiter.admit(ip, now);
    if (admitted) return admitted;
    const d = this.d;
    if (!d) return { status: "refused", reason: "not deployed" };
    if (this.cfg.mode === "dry") return { status: "refused", reason: "dry mode" };
    if (this.isFrozen()) return { status: "refused", reason: "upgrade pending" };
    if (typeof agentRaw !== "string" || !isAddress(agentRaw)) return { status: "refused", reason: "bad agent address" };
    if (this.inFlight >= MAX_IN_FLIGHT) return { status: "refused", reason: "busy, try again shortly" };
    this.inFlight++;
    try {
      return await this.evaluate(d, getAddress(agentRaw), now);
    } finally {
      this.inFlight--;
    }
  }

  private async evaluate(d: Deployment, agent: Address, now: number): Promise<PushDecision> {
    const inputs = await this.inputs(d, agent, now);
    if (inputs.settling) return { status: "refused", reason: FEED_SETTLING };
    const { ids } = inputs;
    const ok = inputs.isAgent && ids.length > 0 && ids.length <= 16;
    const stored = ok ? await readReportTimes(this.c, d, ids) : new Map<bigint, number>();
    // A batch may land a rig at a time. Preserve unseen rigs, but stop joining landed reports.
    for (const s of this.sent) s.ids = s.ids.filter((id) => !stored.has(id) || stored.get(id)! + LANDED_SLACK < s.at);
    this.sent = this.sent.filter((s) => s.ids.length > 0);
    const pending = (id: bigint) => this.isPending(id, stored);
    const balance = await this.c.bsc.public.getBalance({ address: this.c.account.address });
    const needs = ids.filter((id) => !pending(id) && !((stored.get(id) ?? 0) > 0 && (stored.get(id) ?? 0) >= now - REPORT_REUSE_AGE && (stored.get(id) ?? 0) <= now + 60));
    const quotes = ok && needs.length > 0 ? await isolatedQuotes(needs, (part) => this.quote(d, part), this.unreadable) : [];
    const readable = new Set(quotes.flatMap((q) => q.ids));
    if (needs.length > 1 && quotes.some((q) => q.ids.length === 1)) for (const id of readable) this.individual.add(id);
    const accepted = ids.filter((id) => !needs.includes(id) || readable.has(id));
    if (ok && accepted.length === 0) return { status: "refused", reason: "custody unreadable, push it yourself after custody recovers" };
    const fee = quotes.reduce((sum, q) => sum + q.fee, 0n);
    const decision = this.limiter.decide({
      now,
      mode: this.cfg.mode,
      frozen: this.isFrozen(),
      isAgent: inputs.isAgent,
      borrower: inputs.borrower,
      ids: accepted,
      pending,
      eligible: (id) => inputs.eligible.get(id) ?? false,
      storedObservedAt: (id) => stored.get(id) ?? 0,
      balance,
      fee,
      reserve: this.cfg.bnbReserve,
      dailyMax: this.cfg.pushDailyMax,
    });
    if (decision.reason === "keeper reserve") this.alert("push:reserve", "push on request refused: the keeper BNB is down to the harvest reserve");
    if (decision.status === "queued") {
      this.enqueue(accepted.filter((id) => !pending(id) && needs.includes(id)));
      this.persist();
    }
    return decision;
  }

  /** Agent, borrower, collateral and eligibility, cached per agent for CACHE_SEC. */
  private async inputs(d: Deployment, agent: Address, now: number): Promise<Inputs> {
    const hit = this.cache.get(agent);
    if (hit && now - hit.at < CACHE_SEC) return hit;
    const x = this.c.xlayer.public;
    const isAgent = await x.readContract({ address: d.factory, abi: factoryAbi, functionName: "isAgent", args: [agent] });
    let borrower = "0x0000000000000000000000000000000000000000" as Address;
    let ids: bigint[] = [];
    let eligible = new Map<bigint, boolean>();
    let settling = false;
    if (isAgent) {
      const [b, collateral] = await Promise.all([
        x.readContract({ address: d.factory, abi: factoryAbi, functionName: "borrowerOf", args: [agent] }),
        x.readContract({ address: agent, abi: agentAbi, functionName: "collateralOf" }),
      ]);
      borrower = b;
      ids = [...collateral];
      settling = await this.settling(d);
      if (!settling && ids.length > 0 && ids.length <= 16) eligible = await this.eligibility(d, ids, now);
    }
    const v: Inputs = { at: now, isAgent, borrower, ids, eligible, settling };
    if (this.cache.size > 1_000) this.cache.clear();
    this.cache.set(agent, v);
    return v;
  }

  /**
   * RB3-03: `lend` reverts `FeedSettling()` until X Layer time reaches `feedEnabledAt + FEED_SETTLE`, so no borrow
   * push is planned before then. The legacy stack has no settling window. A failed read fails the request.
   */
  private async settling(d: Deployment): Promise<boolean> {
    if (d.legacy) return false;
    const x = this.c.xlayer.public;
    const enabledAt = Number(await x.readContract({ address: d.pool, abi: poolAbi, functionName: "feedEnabledAt" }));
    if (enabledAt === 0) return false;
    const block = await x.getBlock({ blockTag: "latest" });
    return Number(block.timestamp) < enabledAt + FEED_SETTLE;
  }

  /** Screened, known to the vault, custodied, active and at least `MIN_RIG_AGE` old (§5.3 rule 3). */
  private async eligibility(d: Deployment, ids: bigint[], now: number): Promise<Map<bigint, boolean>> {
    const out = new Map<bigint, boolean>();
    const rigs = await readBscRigs(this.c, ids, await bscFinalized(this.c));
    const screened = await this.c.xlayer.public.multicall({
      allowFailure: true,
      contracts: rigs.map((r) => ({
        address: d.screen,
        abi: screenAbi,
        functionName: "isEffective",
        args: [r.id, r.circuits, r.circuitId, r.taskId],
      }) as const),
    });
    rigs.forEach((r, i) => {
      const pass = screened[i]?.status === "success" && screened[i]?.result === true;
      const live = r.ok && r.vaultKnows && r.custodied && r.status === 1 && r.stopBlock === 0n;
      out.set(r.id, pass && live && ageOk(r.since, now) && ADDR.bscCircuits.some((c) => c.toLowerCase() === r.circuits.toLowerCase()));
    });
    return out;
  }

  /** The reporter's fee plus 10%; the excess is refunded to the keeper (L1). */
  private async quote(d: Deployment, ids: bigint[]): Promise<bigint> {
    const fee = await this.c.bsc.public.readContract({ address: d.reporter, abi: reporterAbi, functionName: "quote", args: [ids] });
    return (fee * 11n) / 10n;
  }

  private enqueue(ids: bigint[]): void {
    if (ids.length === 0) return;
    for (const id of ids) this.pending.add(id);
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), BATCH_WINDOW_MS);
  }

  /** Send the batched ids, at most 16 per message; retry a chunk while another transaction holds the nonce. */
  async flush(attempt = 0): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const d = this.d;
    if (!d || this.pending.size === 0) return;
    const ids = [...this.pending].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const chunks: bigint[][] = [];
    for (let i = 0; i < ids.length;) {
      if (this.individual.has(ids[i]!)) chunks.push([ids[i++]!]);
      else {
        const chunk: bigint[] = [];
        while (i < ids.length && chunk.length < 16 && !this.individual.has(ids[i]!)) chunk.push(ids[i++]!);
        chunks.push(chunk);
      }
    }
    for (const chunk of chunks) {
      try {
        const results = await isolatedPush(chunk, (part) => this.quote(d, part), (part, fee) => this.bsc.send({
          label: `push on request [${part.join(",")}]`,
          address: d.reporter,
          abi: reporterAbi,
          functionName: "push",
          args: [part],
          value: fee,
          urgency: "routine",
        }), this.unreadable);
        for (const { ids: part, result: r } of results) {
          if (r.status === "waiting" && attempt < MAX_RETRIES) {
            this.timer = setTimeout(() => void this.flush(attempt + 1), 15_000);
            return;
          }
          if (r.status === "sent") this.sent.push({ ids: part, at: this.now() });
          else this.alert(`push:dropped:${part.join(",")}`, `push on request for rigs [${part.join(",")}] dropped: ${r.status}`);
          for (const id of part) this.pending.delete(id);
          for (const id of part) this.individual.delete(id);
        }
        for (const id of chunk) if (!results.some((r) => r.ids.includes(id))) this.pending.delete(id);
      } catch (e) {
        log("error", "push on request failed", { error: String(e) });
        this.alert(`push:dropped:${chunk.join(",")}`, `push on request for rigs [${chunk.join(",")}] failed`);
        for (const id of chunk) this.pending.delete(id);
      }
    }
  }

  /** Alert when a push sent on request is still not stored by the receiver after 10 minutes (§4.6). */
  async checkDeliveries(): Promise<void> {
    const d = this.d;
    if (!d || this.sent.length === 0) return;
    const now = this.now();
    const due = this.sent.filter((s) => now - s.at >= DELIVERY_ALERT_SEC);
    if (due.length === 0) return;
    for (const s of due) {
      const stored = await readReportTimes(this.c, d, s.ids); // a throw keeps this entry for the next loop
      const inFlight = this.bsc.pendingPushes?.(d.reporter).some((p) => p.ids.some((id) => s.ids.includes(id))) ?? false;
      if (!inFlight) this.sent = this.sent.filter((x) => x !== s);
      if (s.ids.some((id) => (stored.get(id) ?? 0) + LANDED_SLACK < s.at)) {
        this.alert("feed:dead", `a report pushed for rigs [${s.ids.join(",")}] was not stored after 10 minutes: the feed may be dead`);
      }
    }
  }
}
