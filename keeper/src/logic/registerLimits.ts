// Admission of "Register to borrow" requests and the daily run cap (SPEC-PHASE5-REGISTER §6.3). Its counters live in
// `state.screen.counts`, never in the push limiter's: a registration never spends anybody's push budget.

export const REGISTER_LIMITS = { perIpHourly: 10, perMinute: 30 } as const;

const hour = (now: number) => Math.floor(now / 3_600);
const minute = (now: number) => Math.floor(now / 60);
export const utcDay = (now: number) => Math.floor(now / 86_400);

export class RegisterLimiter {
  constructor(private readonly counts: Record<string, number>) {}

  private get(key: string): number {
    return this.counts[key] ?? 0;
  }

  private bump(key: string): void {
    this.counts[key] = this.get(key) + 1;
  }

  /** Before any chain read. Every request counts, refused ones included. Null admits. */
  admit(ip: string, now: number): string | null {
    const ipKey = `ip:${ip}:${hour(now)}`;
    const allKey = `req:${minute(now)}`;
    if (this.get(ipKey) >= REGISTER_LIMITS.perIpHourly) return "too many requests from this address";
    if (this.get(allKey) >= REGISTER_LIMITS.perMinute) return "busy, try again in a minute";
    this.bump(ipKey);
    this.bump(allKey);
    return null;
  }

  /** Screen runs started on this UTC day, retries included. */
  runsToday(now: number): number {
    return this.get(`run:${utcDay(now)}`);
  }

  countRun(now: number): void {
    this.bump(`run:${utcDay(now)}`);
  }

  /** Drop counters of past hours, minutes and days. */
  prune(now: number): void {
    const current: Record<string, number> = { ip: hour(now), req: minute(now), run: utcDay(now) };
    for (const key of Object.keys(this.counts)) {
      const kind = key.split(":")[0] ?? "";
      const at = Number(key.split(":").pop());
      if (!(kind in current) || !Number.isFinite(at) || at < current[kind]!) delete this.counts[key];
    }
  }
}
