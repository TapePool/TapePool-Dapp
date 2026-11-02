import { createAsciiReveal } from '@ascii-reveal/core';

/**
 * ASCII text effects, in the brand's hourglass glyphs (the TapePool mark is two stacked trapezoids).
 *
 * The markup only says what it wants: `data-ascii="loop"` scrambles the text again and again while a read is running,
 * `data-ascii="reveal"` scrambles it once and settles on the real text when it first appears (the page after the wallet
 * connects). `data-ascii-text` is the text itself. The page's text is always the real one for a screen reader: the library
 * keeps a visually hidden copy and hides the scrambled one with `aria-hidden`.
 * `data-ascii="sand"` runs the hourglass of the loading card (below); it draws itself and needs no text.
 *
 * `morph` leaves the children of a live element alone (`data-ascii-live`), so a render every few seconds never restarts an
 * effect. `syncAscii` runs after each render: it starts the effects on new elements, hands changed text to the library and
 * stops the ones whose element left the page.
 */

const GLYPHS = '⌛⏳';

/*
 * The hourglass: the TapePool mark drawn in a monospace grid, 19 columns by 17 rows.
 *
 *   row 0        rim  (=)
 *   rows 1-7     upper chamber, inner widths 15, 13, ... 3 between `\` and `/`
 *   row 8        the neck, one cell wide
 *   rows 9-15    lower chamber, the mirror image
 *   row 16       rim
 *
 * The sand is simulated at twice the vertical resolution (each character holds an upper and a lower half), so a grain is
 * about as wide as it is tall and the surfaces move half a row at a time. Every grain has a place in two orders worked out
 * once: the order it leaves the upper chamber (highest and most central first, so the surface sinks with a dip in the
 * middle) and the order the heap below takes it (lowest and most central first, so it grows as a mound with a peak). Grain
 * `k` leaves at a steady rate, falls through the neck with gravity and joins the heap when it reaches it. The frame is a
 * pure function of the progress `p`, and the last frame turned upside down is exactly the first one, so the flip between
 * two runs is seamless.
 */
const WIDTHS = [15, 13, 11, 9, 7, 5, 3]; // the inner width of each chamber row, from the rim to the neck
const COLS = 19;
const ROWS = 17;
const MID = 9; // the middle column, where the stream falls
const NECK = 8; // the neck row
const HALVES = WIDTHS.length * 2; // half-rows in a chamber
const BS = String.fromCharCode(92);

/** How long the sand takes to leave the upper chamber, and the gravity and start speed of a falling grain (half-rows, seconds). */
const RUN_S = 3.6;
const GRAVITY = 220;
const SPEED0 = 8;
const DIP = 0.6; // how steep the dip in the upper surface is (half-rows per column)
const REPOSE = 0.75; // and the slope of the heap below

/** A deterministic hash in [0, 1): the same grain always gets the same small irregularity. */
function noise(a: number, b: number): number {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

interface Grain {
  col: number;
  /** half-rows from the rim of its chamber (0 = against the rim) */
  d: number;
}

/** Every half-cell of one chamber. */
const CELLS: Grain[] = [];
for (let d = 0; d < HALVES; d++) {
  const half = ((WIDTHS[d >> 1] as number) - 1) / 2;
  for (let col = MID - half; col <= MID + half; col++) CELLS.push({ col, d });
}
const N = CELLS.length;
const byScore = (score: (g: Grain) => number) => (a: Grain, b: Grain) => score(a) - score(b);
/**
 * The order the heap takes the grains: lowest first, the middle a little before the sides. The noise stays under one
 * half-row, so a grain never rests on an empty cell.
 */
const FILL = [...CELLS].sort(byScore((g) => g.d + REPOSE * Math.abs(g.col - MID) + 0.45 * noise(g.col, g.d)));
/** The order the upper chamber gives them up: highest first, the middle first, so the surface sinks in a dip. */
const DRAIN = [...CELLS].sort(byScore((g) => g.d + DIP * Math.abs(g.col - MID) + 0.3 * noise(g.d + 17, g.col)));

/** Where a falling grain stops: the half-row just above the heap's middle column once `m` grains are in it, counted down from the neck. */
const LAND: number[] = [];
{
  let top = -1;
  for (let m = 0; m < N; m++) {
    LAND.push(HALVES + 1 - top); // the stream starts at the neck's upper half (0); the heap's half-row d sits at HALVES + 1 - d
    const g = FILL[m] as Grain;
    if (g.col === MID) top = Math.max(top, g.d);
  }
}
const fallTime = (z: number): number => (-SPEED0 + Math.sqrt(SPEED0 * SPEED0 + 2 * GRAVITY * z)) / GRAVITY;
/** When grain `k` leaves the upper chamber (a steady flow, with a little jitter) and when it lands. */
const LEAVE = Array.from({ length: N }, (_, k) => (RUN_S * (k + 0.5 + 0.6 * (noise(k, 3) - 0.5))) / N);
const LANDED = LEAVE.map((t, k) => t + fallTime(LAND[k] as number));
/** One run from the first grain leaving to the last one landing. */
export const PASS_S = Math.max(...LANDED) + 0.05;

/** What the run looks like at progress `p` (0 = all sand above, 1 = all below): how many grains are where. */
export function sandState(p: number): {
  above: number;
  falling: number;
  below: number;
} {
  const t = Math.min(1, Math.max(0, p)) * PASS_S;
  const above = N - LEAVE.filter((x) => x <= t).length;
  const below = LANDED.filter((x) => x <= t).length;
  return { above, falling: N - above - below, below };
}

type Cell = 0 | 1 | 2; // empty, resting sand, falling grain
type Kind = ' ' | 'g' | 's'; // nothing, glass, sand

/** The picture at progress `p`: one string per row, and per character whether it is glass or sand. */
function picture(p: number): { rows: string[]; kinds: Kind[][] } {
  const t = Math.min(1, Math.max(0, p)) * PASS_S;
  // half-cells: grid[row][col * 2 + half], half 0 = upper
  const grid: Cell[][] = Array.from({ length: ROWS }, () => new Array<Cell>(COLS * 2).fill(0));
  const left = LEAVE.filter((x) => x <= t).length;
  const landed = LANDED.filter((x) => x <= t).length;
  // the upper chamber still holds every grain after the first `left` of the drain order
  for (let i = left; i < N; i++) {
    const g = DRAIN[i] as Grain;
    (grid[1 + (g.d >> 1)] as Cell[])[g.col * 2 + (g.d & 1)] = 1;
  }
  // the heap below holds the first `landed` grains of the fill order (its half-row d counts up from the lower rim)
  for (let i = 0; i < landed; i++) {
    const g = FILL[i] as Grain;
    (grid[ROWS - 2 - (g.d >> 1)] as Cell[])[g.col * 2 + 1 - (g.d & 1)] = 1;
  }
  // the grains in the air, from the neck down
  for (let k = 0; k < N; k++) {
    const dt = t - (LEAVE[k] as number);
    if (dt < 0 || (LANDED[k] as number) <= t) continue;
    const z = Math.floor(SPEED0 * dt + 0.5 * GRAVITY * dt * dt);
    const row = NECK + (z >> 1);
    if (row > ROWS - 2) continue;
    // just above the heap a grain may bounce one column aside
    const near = (LAND[k] as number) - z <= 2 && row > NECK;
    const r = noise(k, 7);
    const col = near && r < 0.25 ? MID - 1 : near && r > 0.75 ? MID + 1 : MID;
    const cells = grid[row] as Cell[];
    if (cells[col * 2 + (z & 1)] === 0) cells[col * 2 + (z & 1)] = 2;
  }
  // a cell counts as packed if it is full of resting sand or lies outside the chamber (rim, neck, wall)
  const packed = (row: number, col: number): boolean => {
    const i = row <= NECK ? row - 1 : ROWS - 2 - row;
    if (i < 0 || i >= WIDTHS.length || Math.abs(col - MID) > ((WIDTHS[i] as number) - 1) / 2) return true;
    const c = grid[row] as Cell[];
    return c[col * 2] === 1 && c[col * 2 + 1] === 1;
  };
  const rows: string[] = [];
  const kinds: Kind[][] = [];
  for (let row = 0; row < ROWS; row++) {
    const chars = new Array<string>(COLS).fill(' ');
    const kind = new Array<Kind>(COLS).fill(' ');
    const glass = (col: number, ch: string): void => {
      chars[col] = ch;
      kind[col] = 'g';
    };
    if (row === 0 || row === ROWS - 1) for (let col = 0; col < COLS; col++) glass(col, '=');
    else {
      const upper = row <= NECK;
      const i = upper ? row - 1 : ROWS - 2 - row; // chamber row from its rim (the neck counts as 7)
      const half = i < WIDTHS.length ? ((WIDTHS[i] as number) - 1) / 2 : 0;
      // the neck is drawn `)(`, which looks the same after a half turn, so the glass does not change when it turns over
      glass(MID - half - 1, row === NECK ? ')' : upper ? BS : '/');
      glass(MID + half + 1, row === NECK ? '(' : upper ? '/' : BS);
      for (let col = MID - half; col <= MID + half; col++) {
        const c = grid[row] as Cell[];
        const u = c[col * 2] as Cell;
        const l = c[col * 2 + 1] as Cell;
        if (!u && !l) continue;
        kind[col] = 's';
        if (u === 1 && l === 1) {
          // sand packed above and below is drawn denser than the sand at a surface
          chars[col] = row !== NECK && packed(row - 1, col) && packed(row + 1, col) ? '#' : '%';
        } else chars[col] = u && l ? ':' : u ? "'" : '.';
      }
    }
    rows.push(chars.join(''));
    kinds.push(kind);
  }
  return { rows, kinds };
}

/** The hourglass at progress `p`, as plain text (the first paint, reduced motion and tests). */
export function hourglassFrame(p: number): string {
  return picture(p).rows.join('\n');
}

/** The same picture as markup: glass and sand in their own spans, so the stylesheet colours them. Only ASCII art, nothing to escape. */
function hourglassHtml(p: number): string {
  const { rows, kinds } = picture(p);
  return rows
    .map((line, r) => {
      let out = '';
      let run = '';
      let cur: Kind = ' ';
      const flush = (): void => {
        if (run) out += cur === ' ' ? run : `<span class="${cur}">${run}</span>`;
        run = '';
      };
      for (let c = 0; c < line.length; c++) {
        const k = (kinds[r] as Kind[])[c] as Kind;
        if (k !== cur) {
          flush();
          cur = k;
        }
        run += line[c];
      }
      flush();
      return out;
    })
    .join('\n');
}

/** What the art scrambles through: plain ASCII, so the rows keep their width in a monospace font. */
export const ART_CHARS = '.:*#';

/**
 * The terminal skeleton of the loading card: what the app is doing, in the look of a blueprint. Plain ASCII, fixed width,
 * so it keeps its shape in a monospace font while the characters scramble.
 */
const W = 36;
const row = (s: string): string => `| ${s.padEnd(W - 2)} |`;
const step = (label: string): string => row((label + ' ').padEnd(W - 7, '.') + ' [..]');
export const TERMINAL = [
  '+' + '- TAPEPOOL // X LAYER '.padEnd(W, '-') + '+',
  step('> connect rpc.xlayer.tech'),
  step('> read pool parameters'),
  step('> read your position'),
  row('> waiting for the chain_'),
  '+' + '-'.repeat(W) + '+',
].join('\n');

/** Looks for `data-ascii-preset`: the characters it scrambles through and how long one pass takes. */
const PRESETS = {
  blueprint: { characters: '+-|:.', loop: 1500 },
  art: { characters: ART_CHARS, loop: 1100 },
} as const;

const LOOP_MS = 1100;
const LOOP_PAUSE_MS = 350;
const REVEAL_MS = 350;

interface Live {
  api: ReturnType<typeof createAsciiReveal>;
  mode: 'loop' | 'reveal';
  text: string;
  done: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const live = new Map<Element, Live>();

/** After a run the hourglass rests, then turns over. */
const REST_S = 0.45;
const TURN_S = 0.75;
/** The running hourglasses: the animation frame each one is waiting for. */
const sands = new Map<Element, { frame: number }>();

function stopSand(el: Element): void {
  const s = sands.get(el);
  if (s && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(s.frame);
  sands.delete(el);
}

const easeInOut = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/** Run the hourglass on a `<pre>`: the sand runs down, rests, the glass turns over (the last picture upside down is the first one) and it runs again. */
function startSand(el: HTMLElement): void {
  el.setAttribute('data-ascii-live', '');
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const glass = el.ownerDocument.createElement('span');
  glass.className = 'hg';
  el.replaceChildren(glass);
  if (reduced || typeof requestAnimationFrame !== 'function') {
    glass.innerHTML = hourglassHtml(0.4);
    return;
  }
  const entry = { frame: 0 };
  sands.set(el, entry);
  let t0 = -1;
  let shown = '';
  const tick = (now: number): void => {
    if (sands.get(el) !== entry) return; // stopped, or replaced by a newer run
    if (!el.isConnected) return stopSand(el);
    if (t0 < 0) t0 = now;
    const cycle = PASS_S + REST_S + TURN_S;
    const t = ((now - t0) / 1000) % cycle;
    const markup = hourglassHtml(t / PASS_S);
    if (markup !== shown) {
      glass.innerHTML = markup;
      shown = markup;
    }
    // the turn: half a revolution, eased, and a little smaller halfway as if lifted (it also keeps the corners clear of the heading)
    const x = t > PASS_S + REST_S ? (t - PASS_S - REST_S) / TURN_S : 0;
    glass.style.transform = x ? `rotate(${(easeInOut(x) * 180).toFixed(1)}deg) scale(${(1 - 0.12 * Math.sin(Math.PI * x)).toFixed(3)})` : '';
    entry.frame = requestAnimationFrame(tick);
  };
  entry.frame = requestAnimationFrame(tick);
}

function start(el: HTMLElement, mode: 'loop' | 'reveal', text: string): void {
  const preset = PRESETS[el.getAttribute('data-ascii-preset') as keyof typeof PRESETS] as (typeof PRESETS)[keyof typeof PRESETS] | undefined;
  const characters = el.getAttribute('data-ascii-chars') || preset?.characters || GLYPHS;
  const entry: Live = {
    api: undefined as never,
    mode,
    text,
    done: false,
    timer: undefined,
  };
  const common = {
    text,
    characters,
    trigger: 'manual' as const,
    direction: 'left' as const,
  };
  entry.api =
    mode === 'loop'
      ? createAsciiReveal(el, {
          ...common,
          duration: preset?.loop ?? LOOP_MS,
          onComplete: () => {
            // wait a moment on the real text, then scramble it again for as long as the element is on the page
            entry.timer = setTimeout(() => {
              if (!el.isConnected) return;
              entry.api.reset();
              void entry.api.play();
            }, LOOP_PAUSE_MS);
          },
        })
      : createAsciiReveal(el, {
          ...common,
          duration: REVEAL_MS,
          onComplete: () => {
            entry.done = true;
          },
        });
  el.setAttribute('data-ascii-live', '');
  live.set(el, entry);
  void entry.api.play();
}

function stop(el: Element, entry: Live): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.api.destroy();
  live.delete(el);
}

/** Start, update and clean up the effects under `root`. */
export function syncAscii(root: ParentNode): void {
  for (const [el, entry] of live) if (!el.isConnected) stop(el, entry);
  for (const el of sands.keys()) if (!el.isConnected) stopSand(el);
  root.querySelectorAll<HTMLElement>('[data-ascii]').forEach((el) => {
    if (el.getAttribute('data-ascii') === 'sand') {
      if (!sands.has(el) && !el.hasAttribute('data-ascii-live')) startSand(el);
      return;
    }
    const mode = el.getAttribute('data-ascii') === 'loop' ? 'loop' : 'reveal';
    const text = el.getAttribute('data-ascii-text') ?? '';
    const entry = live.get(el);
    if (!entry) {
      if (text) start(el, mode, text);
      return;
    }
    if (entry.text === text) return;
    entry.text = text;
    entry.api.update({ text });
    // a value that changes after its reveal is shown at once: the effect belongs to the first appearance
    if (entry.mode === 'reveal' && entry.done) entry.api.finish();
    else void entry.api.play();
  });
}

/** Stop every effect (tests and `destroy`). */
export function stopAscii(): void {
  for (const el of [...sands.keys()]) stopSand(el);
  for (const [el, entry] of live) stop(el, entry);
}
