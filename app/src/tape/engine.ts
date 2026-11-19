export const UNIT = 100_000_000n;
export const TICKS = 1000; // Integer price ticks per USD (0.1 cent).
export const ROW = 50; // Fixed five-cent lattice.
export const STEP = 200;
export const WINDOW = 5000;
export const LEAD = 10000;
export const QUOTE_LIFE = 1000;
export const KEEP = 600; // Samples kept: 120 s, enough history to reach the left edge of a 5,000 px plot.
/** Demo margin: a fair target pays 1 / chance of a touch; these pay 95% of that, between 1.01× and 8×. */
export const EDGE = .05;
/** Ticks per √s: a quiet stretch never prices the nearest cells as certain. */
export const SIGMA_FLOOR = 3;
/** Volatility is measured over price changes this long (ms), close to the lead of the first bettable column. */
const HORIZON = 10_000;
const MIN_MULTIPLIER = 101, MAX_MULTIPLIER = 800;
export interface Quote { low: number; high: number; start: number; end: number; multiplier: number; at: number; stake: bigint; version: number }
export interface Ticket extends Quote { id: number; status: 'open' | 'won' | 'lost'; payout: bigint }
export const earliest = (now: number): number => Math.ceil((now + LEAD) / WINDOW) * WINDOW;
export const payout = (stake: bigint, multiplier: number): bigint => stake * BigInt(multiplier) / 100n;
export function parseStake(value: string): bigint | null {
  if (!/^\d+(?:\.\d{1,8})?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  const result = BigInt(whole!) * UNIT + BigInt(frac.padEnd(8, '0'));
  return result > 0n ? result : null;
}
export function money(value: bigint): string {
  const whole = value / UNIT; const frac = (value % UNIT).toString().padStart(8, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${frac}`;
}
/** Standard normal distribution function (Abramowitz and Stegun 7.1.26, error below 1.5e-7). */
function normal(x: number): number {
  const t = 1 / (1 + .3275911 * Math.abs(x) / Math.SQRT2);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
const NODES = Array.from({ length: 24 }, (_, k) => -4 + (k + .5) / 3);
const WEIGHTS = ((w) => w.map(x => x / w.reduce((a, b) => a + b)))(NODES.map(z => Math.exp(-z * z / 2)));
/**
 * Chance that a random walk now at `price`, moving `sigma` ticks per √s, is inside [low, high) at some moment of the
 * window from `lead` to `lead + span` ms ahead: where the walk may stand when the window opens, then the reflection
 * principle for reaching the range before it closes. Past samples set `sigma`; nothing here looks ahead.
 */
export function touch(price: number, low: number, high: number, lead: number, span: number, sigma: number): number {
  const opening = sigma * Math.sqrt(Math.max(0, lead) / 1000), during = sigma * Math.sqrt(span / 1000);
  let chance = 0;
  NODES.forEach((z, k) => {
    const at = price + z * opening, gap = at < low ? low - at : at >= high ? at - high : 0;
    chance += WEIGHTS[k]! * (gap === 0 ? 1 : during > 0 ? 2 * (1 - normal(gap / during)) : 0);
  });
  return Math.min(1, chance);
}
/** Multiplier in hundredths for a chance of a touch. */
export const priced = (chance: number): number => Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, Math.floor(100 * (1 - EDGE) / Math.max(chance, 1e-9))));
/** The game on real prices: no price until an opening history is loaded, then one sample every STEP of game time. */
export class Engine {
  now = 0; price = 0; balance = 10n * UNIT; stake = '0.10'; version = 0;
  /** Realised volatility in ticks per √s, measured after every sample. */
  sigma = SIGMA_FLOOR;
  private quotes = new WeakSet<Quote>();
  history: { time: number; price: number }[] = []; open: Ticket[] = []; settled: Ticket[] = []; nextId = 1;
  /** Replaces the history with real opening prices one STEP apart, ending now. An empty list means no price yet. */
  load(prices: readonly number[]): void {
    const kept = prices.slice(-KEEP);
    this.history = kept.map((price, i) => ({ time: this.now - (kept.length - 1 - i) * STEP, price }));
    this.price = kept.at(-1) ?? 0; this.version++; this.measure();
  }
  /**
   * Root mean square of overlapping 10 s price changes over the kept history, per √s, floored. Measured at the betting
   * horizon: 1 s changes understate how far a trending price carries in 10–20 s.
   */
  private measure(): void {
    const span = HORIZON / STEP; let sum = 0, count = 0;
    for (let i = this.history.length - 1; i >= span; i -= 5) { const change = this.history[i]!.price - this.history[i - span]!.price; sum += change * change; count++; }
    this.sigma = Math.max(SIGMA_FLOOR, count >= 10 ? Math.sqrt(sum / count / (HORIZON / 1000)) : 0);
  }
  /** Restores the session defaults on a new opening history (empty while it loads). */
  reset(opening: readonly number[]): void {
    this.now = 0; this.balance = 10n * UNIT; this.stake = '0.10'; this.open = []; this.settled = []; this.nextId = 1; this.version++;
    this.load(opening);
  }
  setStake(value: string): void { this.stake = value; this.version++; }
  quote(low: number, start: number): Quote | null {
    const stake = parseStake(this.stake);
    if (!stake || !this.history.length || low <= 0 || low % ROW || start % WINDOW || start < earliest(this.now)) return null;
    const multiplier = priced(touch(this.price, low, low + ROW, start - this.now, WINDOW, this.sigma));
    const q = { low, high: low + ROW, start, end: start + WINDOW, multiplier, at: this.now, stake, version: this.version };
    Object.freeze(q); this.quotes.add(q); return q;
  }
  place(q: Quote): Ticket | null {
    const stake = parseStake(this.stake);
    if (!this.quotes.has(q) || q.start < earliest(this.now) || q.version !== this.version || q.at > this.now || this.now - q.at > QUOTE_LIFE || q.high !== q.low + ROW || q.end !== q.start + WINDOW || q.stake !== stake || q.stake > this.balance || this.open.length >= 50) return null;
    const ticket: Ticket = { ...q, id: this.nextId++, status: 'open', payout: 0n };
    this.balance -= q.stake; this.open.push(ticket); return ticket;
  }
  sample(price: number): Ticket[] {
    this.now += STEP; this.price = Math.max(1, Math.floor(price)); this.history.push({ time: this.now, price: this.price });
    if (this.history.length > KEEP) this.history.shift();
    this.measure();
    const done: Ticket[] = [];
    for (const ticket of this.open) {
      if (this.now >= ticket.end) ticket.status = 'lost';
      else if (this.now >= ticket.start && this.price >= ticket.low && this.price < ticket.high) { ticket.status = 'won'; ticket.payout = payout(ticket.stake, ticket.multiplier); this.balance += ticket.payout; }
      if (ticket.status !== 'open') done.push(ticket);
    }
    this.open = this.open.filter((ticket) => ticket.status === 'open');
    this.settled.unshift(...done); this.settled.length = Math.min(100, this.settled.length); return done;
  }
}
