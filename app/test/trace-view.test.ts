// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTraceSession } from '../src/dev/trace/view';
import { morph } from '../src/dom';
import { KEEP, money, payout, UNIT } from '../src/dev/trace/engine';
import type { FeedState, PriceFeed } from '../src/dev/trace/feed';

/** The opening index price in ticks: $110.50. */
const OPEN = 110_500;
function visible(value: 'visible' | 'hidden'): void { Object.defineProperty(document, 'visibilityState', { configurable: true, value }); document.dispatchEvent(new Event('visibilitychange')); }
function button(host: HTMLElement, action: string): HTMLButtonElement { return host.querySelector(`[data-action="${action}"]`)!; }
const count = (host: HTMLElement, action: string): string => button(host, action).querySelector('.trace-count')!.textContent!;

/** A feed the test drives: its prices arrive on the same clock the animation frames use. */
function fakeFeed(history: number[]) {
  let latest: { price: number; at: number } | null = null; const calls = { start: 0, stop: 0 };
  const feed: PriceFeed = {
    latest: () => latest, history: () => Promise.resolve(history),
    state: (now): FeedState => !latest ? 'connecting' : now - latest.at > 5000 ? 'stale' : 'live',
    start: () => { calls.start++; }, stop: () => { calls.stop++; },
  };
  return { feed, calls, push: (price: number, at: number) => { latest = { price, at }; } };
}
/** Mounts Tape on a fake feed, with animation frames and the clock in the test's hands. */
function play(history: number[] = Array.from({ length: KEEP }, () => OPEN)) {
  let id = 0, view: { unmount(): void; translate(): void };
  const callbacks = new Map<number, FrameRequestCallback>(), clock = { now: 0 };
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(cb => { callbacks.set(++id, cb); return id; });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(n => { callbacks.delete(n); });
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const live = fakeFeed(history), host = document.createElement('div'); document.body.append(host); visible('visible');
  const session = createTraceSession(() => live.feed); view = session.mount(host);
  return {
    host, live, callbacks, clock,
    /** One animation frame at `at`, after a price push at the same moment when `price` is given. */
    step(at: number, price?: number): void { clock.now = at; if (price !== undefined) live.push(price, at); const item = [...callbacks.entries()][0]; if (!item) return; callbacks.delete(item[0]); item[1](at); },
    /** Lets the opening history promise settle. */
    ready: (): Promise<void> => new Promise(resolve => setTimeout(resolve)),
    remount(): void { view.unmount(); view = session.mount(host); },
    text: (selector: string): string => host.querySelector(selector)!.textContent!,
    shift: (): string => host.querySelector<HTMLElement>('.trace-scroll')!.style.transform,
    cells: (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('.trace-cell')],
    done(): void { view.unmount(); session.dispose(); },
  };
}
/** Opening history loaded and live samples flowing at 200 ms, so bets are open. */
async function running(history?: number[]) {
  const g = play(history); await g.ready(); g.step(0, OPEN); g.step(200, OPEN); return g;
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.body.replaceChildren(); visible('visible'); });

describe('Tape view lifetime', () => {
  it('waits for the OKX price, samples the newest one and stands still while it is stale', async () => {
    const g = play();
    expect(g.live.calls.start).toBe(1); expect(g.text('.trace-source')).toBe('WAITING'); expect(g.text('.trace-feed')).toBe('Loading the OKX price…'); expect(g.text('.trace-price')).toBe('—');
    await g.ready(); g.step(0);
    expect(g.text('.trace-feed')).toBe('Connecting to OKX…'); expect(g.text('.trace-price')).toBe('$110.50');
    const waiting = g.shift(); g.step(200); g.step(400); expect(g.shift()).toBe(waiting); // no price: game time stands still
    g.live.push(113_010, 400); g.step(600); g.step(800);
    expect(g.text('.trace-source')).toBe('LIVE · OKX'); expect(g.host.querySelector<HTMLElement>('.trace-feed')!.hidden).toBe(true); expect(g.text('.trace-price')).toBe('$113.01');
    expect(g.shift()).not.toBe(waiting);
    g.step(5401); const frozen = g.shift(); g.step(5601); g.step(5801);
    expect(g.text('.trace-source')).toBe('WAITING'); expect(g.text('.trace-feed')).toContain('stopped updating'); expect(g.shift()).toBe(frozen);
    g.step(6000, 113_000); g.step(6200, 113_000); expect(g.shift()).not.toBe(frozen); expect(g.text('.trace-price')).toBe('$113.00');
    const stops = g.live.calls.stop; g.remount(); expect(g.live.calls.stop).toBe(stops + 1); expect(g.live.calls.start).toBe(2);
    g.done();
  });

  it('has no pause, reset or price-source control', () => {
    const g = play();
    for (const selector of ['[data-action="pause"]', '[data-action="reset"]', '[data-mode]', '.trace-modes']) expect(g.host.querySelector(selector)).toBeNull();
    g.done();
  });

  it('refuses bets while samples are not flowing and voids quotes from before', async () => {
    const g = await running(); const grid = g.host.querySelector('.trace-grid')!, open = (): HTMLButtonElement => g.cells().find(c => !c.disabled)!;
    expect(grid.classList.contains('frozen')).toBe(false);
    // Away from the tab the market moves on: no bet may be priced on the frozen price.
    visible('hidden'); g.live.push(110_600, 300); g.clock.now = 1000; open().click();
    expect(count(g.host, 'open')).toBe('0'); expect(g.text('.trace-balance')).toBe('10.00 BEM'); expect(g.text('.trace-status')).toContain('live price is updating');
    expect(grid.classList.contains('frozen')).toBe(true);
    visible('visible'); g.step(1100); g.step(1300);
    expect(grid.classList.contains('frozen')).toBe(false); expect(g.text('.trace-price')).toBe('$110.60');
    open().click(); expect(count(g.host, 'open')).toBe('1');
    g.done();
  });

  it('shows a released win and keeps its feedback through a hidden tab and a remount', async () => {
    const g = await running();
    const cell = g.cells().find(item => item.getAttribute('aria-label')?.startsWith('$110.50–$110.55'))!;
    // The quoted multiplier comes from recent volatility; the payout must be exactly the one shown on the cell.
    const shown = Math.round(parseFloat(cell.textContent!) * 100), won = money(payout(UNIT / 10n, shown)), after = money(10n * UNIT - UNIT / 10n + payout(UNIT / 10n, shown));
    cell.click(); expect(g.text('.trace-balance')).toBe('9.90 BEM');
    const result = g.host.querySelector<HTMLElement>('.trace-result')!;
    for (let at = 400; at <= 20_000 && result.hidden; at += 200) g.step(at, OPEN);
    expect(result.hidden).toBe(false); expect(g.text('.trace-result-title')).toBe('Won');
    expect(g.text('.trace-result-return')).toBe(`+${won} BEM returned`); expect(g.text('.trace-balance')).toBe(`${after} BEM`);
    visible('hidden'); g.remount();
    expect(g.callbacks.size).toBe(0); expect(g.host.querySelector<HTMLElement>('.trace-result')!.hidden).toBe(false); expect(g.text('.trace-balance')).toBe(`${after} BEM`);
    visible('visible'); expect(g.callbacks.size).toBe(1);
    g.done(); expect(g.callbacks.size).toBe(0);
  });

  it('preserves the owned input through shell morphs', () => {
    const g = play(); const host = g.host; host.setAttribute('data-trace-owned', '');
    const input = host.querySelector('input')!; input.focus(); input.value = '0.25'; input.dispatchEvent(new Event('input', { bubbles: true }));
    const next = document.createElement('div'); next.setAttribute('data-trace-owned', ''); morph(host, next);
    expect(host.querySelector('input')).toBe(input); expect(document.activeElement).toBe(input); expect(input.value).toBe('0.25');
    g.done();
  });

  it('a hidden tab or route unmount never leaves duplicate animation frames', () => {
    const g = play();
    expect(g.callbacks.size).toBe(1); visible('hidden'); expect(g.callbacks.size).toBe(0); visible('visible'); expect(g.callbacks.size).toBe(1);
    g.remount(); expect(g.callbacks.size).toBe(1);
    visible('hidden'); g.remount(); expect(g.callbacks.size).toBe(0); visible('visible'); expect(g.callbacks.size).toBe(1);
    g.done(); expect(g.callbacks.size).toBe(0);
  });

  it('cancels pointer drags and invalidates a quote after a stake edit', async () => {
    const g = await running(); const cell = g.cells()[0]!;
    cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 })); cell.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 30, clientY: 10 })); cell.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(count(g.host, 'open')).toBe('0');
    cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 })); const input = g.host.querySelector('input')!; input.value = '0.50'; input.dispatchEvent(new Event('input', { bubbles: true })); cell.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(count(g.host, 'open')).toBe('0'); expect(g.host.textContent).toContain('Please try again');
    g.done();
  });

  it('draws past the plot edges but keeps keyboard targets inside the canvas and price gutter', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const width = this.classList.contains('trace-plot') ? 1000 : 390;
      return { width, height: 500, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 500, toJSON: () => ({}) } as DOMRect;
    });
    const g = play(); await g.ready(); g.step(0);
    const cells = g.cells(); cells[0]!.focus();
    for (let n = 0; n < 9; n++) document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    // Row 0 is the hidden row above the top edge, so focus lands on the first visible row and stops at the last column at least half shown.
    expect(document.activeElement).toBe(cells[32 + 5]);
    const x = Number(g.shift().match(/translate\(([-\d.]+)/)?.[1]);
    expect(x + 5 * 80 + 40).toBeLessThanOrEqual(950); expect(x + 6 * 80 + 40).toBeGreaterThan(950);
    expect(cells[32 + 6]!.disabled).toBe(false); expect(cells[32 + 7]!.disabled).toBe(true); // one column drawn past the gutter, then nothing
    g.done();
  });

  it('fills wide plots with square targets and stops keyboard focus at the gutter', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { width: 2048, height: 700, x: 0, y: 0, top: 0, left: 0, right: 2048, bottom: 700, toJSON: () => ({}) } as DOMRect;
    });
    const g = play(); await g.ready(); g.step(0);
    const cells = g.cells(); cells[0]!.focus();
    for (let n = 0; n < 20; n++) document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const shift = g.shift().match(/translate\(([-\d.]+)px, ([-\d.]+)px/)!;
    const x = Number(shift[1]), y = Number(shift[2]), top = Math.floor(cells.indexOf(document.activeElement as HTMLButtonElement) / 32);
    // The top row is only a fifth visible here, so focus starts on the next one.
    expect(top).toBe(2); expect(y + (top - 1) * 80 + 40).toBeLessThan(0); expect(y + top * 80 + 40).toBeGreaterThanOrEqual(0);
    expect(document.activeElement).toBe(cells[top * 32 + 13]);
    expect(x + 13 * 80 + 40).toBeLessThanOrEqual(1998); expect(x + 14 * 80 + 40).toBeGreaterThan(1998);
    for (let n = 0; n < 20; n++) document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const row = Math.floor(cells.indexOf(document.activeElement as HTMLButtonElement) / 32);
    expect(y + row * 80 + 40).toBeLessThanOrEqual(672); expect(y + (row + 1) * 80 + 40).toBeGreaterThan(672);
    expect(cells[(row + 1) * 32]!.disabled).toBe(false); // drawn under the time axis, clipped by the plot window
    g.done();
  });

  it('preserves presentation phase and camera through a hidden tab and a remount', async () => {
    const g = await running(); g.step(300, OPEN); const transform = g.shift();
    visible('hidden'); expect(g.callbacks.size).toBe(0); g.remount();
    expect(g.shift()).toBe(transform); expect(g.callbacks.size).toBe(0);
    visible('visible'); g.step(100_000, OPEN); expect(g.shift()).toBe(transform);
    g.step(100_150, OPEN); expect(g.shift()).not.toBe(transform);
    g.done(); expect(g.callbacks.size).toBe(0);
  });

  it('cancels a press when the screen slot is recycled to a later window', async () => {
    const g = play(); await g.ready(); g.step(0);
    const cell = g.cells()[0]!; cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1, clientY: 1 }));
    g.step(200, OPEN); cell.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(count(g.host, 'open')).toBe('0'); expect(g.host.textContent).toContain('Please try again');
    g.done();
  });

  it('resizes the canvas backing only when the device pixel ratio changes', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
    const g = play(); const canvas = g.host.querySelector('canvas')!;
    expect(canvas.width).toBe(1000); g.step(0); g.step(16); expect(canvas.width).toBe(1000);
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true }); g.step(32); expect(canvas.width).toBe(2000);
    g.done(); if (descriptor) Object.defineProperty(window, 'devicePixelRatio', descriptor); else Reflect.deleteProperty(window, 'devicePixelRatio');
  });

  it('holds the displayed quote across price samples and accepts those same terms', async () => {
    const g = await running(); const cell = g.cells()[0]!; const multiplier = cell.textContent!, description = cell.getAttribute('aria-label');
    cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1, clientY: 1 })); g.step(400, OPEN - 10); g.step(600, OPEN - 20);
    expect(cell.textContent).toBe(multiplier); expect(cell.getAttribute('aria-label')).toBe(description); expect(g.text('.trace-quote')).toBe(description);
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); button(g.host, 'open').click();
    expect(count(g.host, 'open')).toBe('1'); expect(g.text('.trace-list')).toContain(multiplier);
    g.done();
  });
});
