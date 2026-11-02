// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { hourglassFrame, sandState, stopAscii, syncAscii } from '../src/ascii';
import { morphKids } from '../src/dom';

const rows = (s: string): string[] => s.split('\n');
const STEPS = Array.from({ length: 41 }, (_, i) => i / 40);
/** The glass alone: every character that is not sand. */
const glass = (f: string): string => f.replace(/[#%:.']/g, ' ');
/** The picture turned upside down: rows and characters reversed, and the glyphs that change under a half turn swapped. */
const turned = (f: string): string =>
  rows(f)
    .reverse()
    .map((r) =>
      [...r]
        .reverse()
        .map((c) => ({ '.': "'", "'": '.', '(': ')', ')': '(' })[c] ?? c)
        .join(''),
    )
    .join('\n');

describe('the ASCII hourglass', () => {
  it('keeps the same glass, 19 by 17, at every step', () => {
    const shape = glass(hourglassFrame(0));
    expect(rows(shape)).toHaveLength(17);
    for (const p of STEPS) {
      const f = hourglassFrame(p);
      expect(rows(f).every((r) => r.length === 19)).toBe(true);
      expect(glass(f)).toBe(shape);
    }
  });

  it('starts full above, ends full below, and never loses a grain on the way', () => {
    expect(sandState(0)).toEqual({ above: 126, falling: 0, below: 0 });
    expect(sandState(1)).toEqual({ above: 0, falling: 0, below: 126 });
    let prev = sandState(0);
    for (const p of STEPS) {
      const s = sandState(p);
      expect(s.above + s.falling + s.below).toBe(126);
      expect(s.above).toBeLessThanOrEqual(prev.above);
      expect(s.below).toBeGreaterThanOrEqual(prev.below);
      prev = s;
    }
    const upper = (f: string): string => rows(f).slice(1, 8).join('');
    const lower = (f: string): string => rows(f).slice(9, 16).join('');
    expect(upper(hourglassFrame(0)).replace(/[\\/ ]/g, '')).toMatch(/^[#%]+$/);
    expect(lower(hourglassFrame(0))).not.toMatch(/[#%:.']/);
    expect(upper(hourglassFrame(1))).not.toMatch(/[#%:.']/);
  });

  it('runs a stream through the neck only while sand is falling', () => {
    const neck = (p: number): string => (rows(hourglassFrame(p))[8] as string).slice(9, 10);
    expect(neck(0)).toBe(' ');
    expect(neck(1)).toBe(' ');
    for (const p of [0.2, 0.4, 0.6, 0.8]) {
      expect(sandState(p).falling).toBeGreaterThan(0);
      expect(neck(p)).toMatch(/[:.']/);
    }
  });

  it('sinks with a dip in the middle above and grows as a mound with a peak below', () => {
    const f = rows(hourglassFrame(0.5));
    // the first row, from the top of a chamber, with sand in a column
    const surface = (r0: number, col: number, grain = /[#%:.']/): number => f.findIndex((r, i) => i >= r0 && grain.test(r[col] as string));
    expect(surface(1, 9)).toBeGreaterThan(surface(1, 6)); // the upper surface is lower in the middle than near the side
    expect(surface(9, 9, /[#%]/)).toBeLessThan(surface(9, 4, /[#%]/)); // the heap below is higher in the middle (packed sand only, not the stream)
  });

  it('turns over seamlessly: the last picture upside down is the first one', () => {
    expect(turned(hourglassFrame(1))).toBe(hourglassFrame(0));
  });

  it('shows one still picture, glass and sand coloured apart, when the reader asks for reduced motion', () => {
    const before = window.matchMedia;
    window.matchMedia = ((q: string) =>
      ({
        matches: q.includes('reduce'),
        media: q,
      }) as MediaQueryList) as typeof window.matchMedia;
    try {
      const root = document.createElement('div');
      root.innerHTML = '<div class="ascii-art"><pre data-ascii="sand">x</pre></div>';
      document.body.appendChild(root);
      syncAscii(root);
      const pre = root.querySelector('pre') as HTMLElement;
      expect(pre.hasAttribute('data-ascii-live')).toBe(true);
      expect(pre.textContent).toBe(hourglassFrame(0.4));
      expect(pre.querySelectorAll('.hg .g').length).toBeGreaterThan(0);
      expect(pre.querySelectorAll('.hg .s').length).toBeGreaterThan(0);
      root.remove();
    } finally {
      window.matchMedia = before;
      stopAscii();
    }
  });
});

describe('morph and the text effects', () => {
  const host = (markup: string): HTMLElement => {
    const el = document.createElement('div');
    el.innerHTML = markup;
    return el;
  };

  it('leaves the children of a live element alone and drops it when the page stops asking for the effect', () => {
    const a = host('<h2 data-ascii="loop" data-ascii-text="x" data-ascii-live="">scrambled</h2>');
    morphKids(a, host('<h2 data-ascii="loop" data-ascii-text="x">x</h2>'));
    expect(a.querySelector('h2')?.textContent).toBe('scrambled');
    expect(a.querySelector('h2')?.hasAttribute('data-ascii-live')).toBe(true);

    morphKids(a, host('<h2>Connect your wallet</h2>'));
    expect(a.querySelector('h2')?.textContent).toBe('Connect your wallet');
    expect(a.querySelector('h2')?.hasAttribute('data-ascii-live')).toBe(false);
  });
});
