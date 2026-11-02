// Rate limit of the read-only app routes (SPEC-PHASE5-APP §8.3). In memory and never persisted; it is not
// the push limiter and the two never share a counter.

export const READ_LIMITS = { perIpPerMinute: 60, globalPerMinute: 600 } as const;

export type ReadDecision = { ok: true } | { ok: false; reason: "ip" | "global"; retryAfter: number };

/**
 * Fixed one-minute windows: 60 requests per IP and 600 in total. A request that is turned away does not
 * count against the global budget, so one noisy address cannot use up everybody's share, and it adds no
 * entry to the map, so the map never holds more than the 600 requests the window can admit.
 */
export class ReadLimiter {
  private window = -1;
  private perIp = new Map<string, number>();
  private served = 0;

  constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  admit(ip: string): ReadDecision {
    const t = this.now();
    const window = Math.floor(t / 60);
    if (window !== this.window) {
      this.window = window;
      this.perIp = new Map();
      this.served = 0;
    }
    const retryAfter = 60 - (t % 60);
    if ((this.perIp.get(ip) ?? 0) >= READ_LIMITS.perIpPerMinute) return { ok: false, reason: "ip", retryAfter };
    if (this.served >= READ_LIMITS.globalPerMinute) return { ok: false, reason: "global", retryAfter };
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    this.served++;
    return { ok: true };
  }
}
