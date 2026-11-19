import { ROW, STEP, WINDOW, type Ticket } from './engine';
export const CELL = 80;
export interface Projection { width: number; height: number; now: number; camera: number; cell: number }
export const projectX = (p: Projection, time: number): number => p.width * .35 + (time - p.now) / WINDOW * p.cell;
export const projectY = (p: Projection, price: number): number => p.height / 2 - (price - p.camera) / ROW * p.cell;
export function targetBounds(p: Projection, low: number, start: number): { x: number; y: number; width: number; height: number } {
  return { x: projectX(p, start), y: projectY(p, low + ROW), width: p.cell, height: p.cell };
}
export interface Pending { ticket: Ticket; time: number; price: number }
export const RESULT_MS = 1400;
/** Settled cells stay marked until they scroll off the plot; the view fades them near the left edge. */
export const RESULT_KEEP = 120_000;
export const PLACEMENT_MS = 450;
export const NOTICE_MS = 4000;
export const MAX_EFFECTS = 8;
/** Separate cap, so placement pulses never evict a settled cell before it fades. */
export const MAX_RESULTS = 100;
export interface Effect {
  kind: 'placed' | 'won' | 'lost'; low: number; start: number; born: number;
  sampleTime: number; samplePrice: number; amount: bigint; count: number;
}
export interface ResultNotice { born: number; wins: number; losses: number; returned: bigint; lost: bigint }
/** Presentation is delayed by one sample. It never affects engine accounting. */
export class Presentation {
  time = 0; camera = 0; phase = 0; pending: Pending[] = [];
  effects: Effect[] = []; notice: ResultNotice | null = null;
  private seen = new Set<number>();
  reset(): void { this.time = 0; this.camera = 0; this.phase = 0; this.pending = []; this.effects = []; this.notice = null; this.seen.clear(); }
  advance(elapsed: number, engineNow: number, displayedPrice: number): void {
    this.time = Math.min(engineNow, this.time + Math.max(0, elapsed));
    const alpha = 1 - Math.exp(-Math.max(0, elapsed) / 650);
    this.camera += (displayedPrice - this.camera) * alpha;
    this.effects = this.effects.filter(effect => this.time - effect.born < (effect.kind === 'placed' ? PLACEMENT_MS : RESULT_KEEP));
    if (this.notice && this.time - this.notice.born >= NOTICE_MS) this.notice = null;
  }
  placed(ticket: Ticket): void {
    this.addEffect({ kind: 'placed', low: ticket.low, start: ticket.start, born: this.time, sampleTime: this.time, samplePrice: ticket.low, amount: ticket.stake, count: 1 });
  }
  private addEffect(effect: Effect): void {
    this.effects = this.effects.filter(old => old.low !== effect.low || old.start !== effect.start || old.kind !== effect.kind);
    this.effects.push(effect);
    const placed = this.effects.filter(old => old.kind === 'placed'), results = this.effects.filter(old => old.kind !== 'placed');
    const keep = new Set([...placed.slice(-MAX_EFFECTS), ...results.slice(-MAX_RESULTS)]);
    this.effects = this.effects.filter(old => keep.has(old));
  }
  queue(tickets: Ticket[], time: number, price: number): void {
    for (const ticket of tickets) {
      if (this.seen.has(ticket.id)) continue;
      this.seen.add(ticket.id);
      // A bounded replay guard is enough for the engine's capped, in-memory history.
      if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
      this.pending.push({ ticket: { ...ticket }, time, price });
    }
  }
  release(): Pending[] {
    const done = this.pending.filter(p => p.time <= this.time);
    this.pending = this.pending.filter(p => p.time > this.time);
    const results = done.filter(item => item.ticket.status !== 'open');
    if (results.length) {
      const notice = this.notice && this.time - this.notice.born <= 400
        ? { ...this.notice, born: this.time }
        : { born: this.time, wins: 0, losses: 0, returned: 0n, lost: 0n };
      const grouped = new Map<string, Effect>();
      for (const item of results) {
        const ticket = item.ticket, won = ticket.status === 'won';
        if (won) { notice.wins++; notice.returned += ticket.payout; }
        else { notice.losses++; notice.lost += ticket.stake; }
        const key = `${ticket.status}:${ticket.low}:${ticket.start}`;
        const existing = grouped.get(key), amount = won ? ticket.payout : ticket.stake;
        if (existing) { existing.amount += amount; existing.count++; }
        else grouped.set(key, { kind: won ? 'won' : 'lost', low: ticket.low, start: ticket.start, born: this.time, sampleTime: item.time, samplePrice: item.price, amount, count: 1 });
      }
      for (const effect of grouped.values()) this.addEffect(effect);
      this.notice = notice;
    }
    return done;
  }
}
export function sampleAt(samples: readonly { time: number; price: number }[], time: number): number {
  if (!samples.length) return 0;
  let i = samples.length - 1;
  while (i > 0 && samples[i]!.time > time) i--;
  const a = samples[i]!, b = samples[Math.min(i + 1, samples.length - 1)]!;
  if (b.time === a.time) return a.price;
  return a.price + (b.price - a.price) * Math.max(0, Math.min(1, (time - a.time) / (b.time - a.time)));
}
export { STEP };
