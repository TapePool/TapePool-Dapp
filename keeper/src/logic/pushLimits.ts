// Push-on-request rules and limits (SPEC-PHASE3-KEEPER §5.3). Pure apart from the counters it holds.
import { PUSH_LIMITS } from "../config.js";

export const REPORT_REUSE_AGE = 240; // seconds: a stored report this fresh is reused, no push
export const PUSH_COOLDOWN = 600; // seconds between impairment pushes for one rig

export type PushStatus = "fresh" | "queued" | "refused";

/** Requests accepted for evaluation per minute in total, before any chain read (anti-amplification). */
export const REQUESTS_PER_MINUTE = 30;

export interface PushDecision {
  status: PushStatus;
  reason?: string;
}

export interface PushRequest {
  pending?: (id: bigint) => boolean;
  now: number; // unix seconds
  mode: "dry" | "live";
  frozen: boolean;
  isAgent: boolean;
  borrower: string;
  ids: bigint[];
  eligible: (id: bigint) => boolean; // screened, known to the vault, custodied, active, >= MIN_RIG_AGE
  storedObservedAt: (id: bigint) => number; // 0 if none
  balance: bigint; // keeper BNB
  fee: bigint; // quoted fee for one push
  reserve: bigint;
  dailyMax: number;
}

const day = (now: number) => Math.floor(now / 86_400);
const hour = (now: number) => Math.floor(now / 3_600);
const minute = (now: number) => Math.floor(now / 60);

/** Counters live in a plain record so the keeper can persist them in its state (§2). */
export class PushLimiter {
  constructor(private readonly counts: Record<string, number> = {}) {}

  private bump(key: string): void {
    this.counts[key] = (this.counts[key] ?? 0) + 1;
  }

  private get(key: string): number {
    return this.counts[key] ?? 0;
  }

  /**
   * Admit a request before any chain read: at most 10 requests per IP per hour (every request counts,
   * refused ones included) and REQUESTS_PER_MINUTE in total.
   */
  admit(ip: string, now: number): PushDecision | null {
    const ipKey = `ip:${ip}:${hour(now)}`;
    const allKey = `req:${minute(now)}`;
    if (this.get(ipKey) >= PUSH_LIMITS.perIpHourly) return { status: "refused", reason: "too many requests from this address" };
    if (this.get(allKey) >= REQUESTS_PER_MINUTE) return { status: "refused", reason: "busy, try again in a minute" };
    this.bump(ipKey);
    this.bump(allKey);
    return null;
  }

  /** Decide an admitted request. Push counters are charged only when the answer is `queued`. */
  decide(r: PushRequest): PushDecision {
    if (r.mode === "dry") return { status: "refused", reason: "dry mode" };
    if (r.frozen) return { status: "refused", reason: "upgrade pending" };
    if (!r.isAgent) return { status: "refused", reason: "not an agent" };
    if (r.ids.length === 0 || r.ids.length > 16) return { status: "refused", reason: "collateral must hold 1-16 vouchers" };
    if (!r.ids.every((id) => r.eligible(id))) return { status: "refused", reason: "not eligible" };
    const fresh = (id: bigint) => r.storedObservedAt(id) > 0 && r.storedObservedAt(id) <= r.now + 60 && r.storedObservedAt(id) >= r.now - REPORT_REUSE_AGE;
    if (r.ids.every(fresh)) return { status: "fresh" };
    const scheduled = r.ids.filter((id) => !fresh(id) && !r.pending?.(id));
    if (scheduled.length === 0) return { status: "queued" };

    const d = day(r.now);
    if (this.get(`all:${d}`) >= r.dailyMax) return { status: "refused", reason: "daily push budget used, push it yourself" };
    if (this.get(`b:${r.borrower.toLowerCase()}:${d}`) >= PUSH_LIMITS.perBorrowerDaily) {
      return { status: "refused", reason: "borrower daily limit, push it yourself" };
    }
    if (scheduled.some((id) => this.get(`r:${id}:${d}`) >= PUSH_LIMITS.perRigDaily)) {
      return { status: "refused", reason: "rig daily limit, push it yourself" };
    }
    if (scheduled.some((id) => Object.entries(this.counts).reduce((n, [k, count]) => k.startsWith(`s:${id}:`) && Number(k.split(":").pop()) > r.now - 7 * 86_400 ? n + count : n, 0) >= PUSH_LIMITS.perRigWeekly)) return { status: "refused", reason: "rig weekly limit, push it yourself" };
    if (r.balance < r.fee + r.reserve) return { status: "refused", reason: "keeper reserve" };

    this.bump(`all:${d}`);
    this.bump(`b:${r.borrower.toLowerCase()}:${d}`);
    for (const id of scheduled) { this.bump(`r:${id}:${d}`); this.bump(`s:${id}:${r.now}`); }
    return { status: "queued" };
  }

  /** Drop counters of past days, hours and minutes. */
  prune(now: number): void {
    const current: Record<string, number> = { ip: hour(now), req: minute(now) };
    for (const key of Object.keys(this.counts)) {
      const last = Number(key.split(":").pop());
      const kind = key.split(":")[0] ?? "";
      const cutoff = kind === "s" ? now - 8 * 86_400 : kind === "r" ? day(now) - 7 : (current[kind] ?? day(now));
      if (last < cutoff) delete this.counts[key];
    }
  }
}
