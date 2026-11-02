import bemImg from '../assets/bem.png';
import fabxImg from '../assets/fabx.png';
import logoImg from '../assets/logo.svg';
import tapeoutImg from '../assets/tapeout.jpg';
import tpbemImg from '../assets/tpbem.png';
import xlayerImg from '../assets/xlayer.jpg';
import { bem4 } from '../logic/format';
import { EMPTY, html, raw, type Html, type Part } from '../html';
import { t } from '../i18n';
import type { Processor, Sec, Section, Snapshot } from '../model';
import type { BorrowView } from '../logic/borrow';
import type { Route } from '../route';
import type { UiState } from '../state';

/** Everything a page needs to draw itself. Pure data: rendering never reads the clock or the chain. */
export interface Ctx {
  snap: Snapshot;
  ui: UiState;
  route: Route;
  /** Chain time. */
  now: Sec;
  borrow: BorrowView | null;
  /** Build an app link that keeps the read-only view prefix. */
  link: (path?: string) => string;
  /** Why write controls are off: shown inside another site, or a read-only view. */
  readOnly: 'frame' | 'view' | null;
}

export const IMG = { logo: logoImg, tapeout: tapeoutImg, xlayer: xlayerImg, bem: bemImg, tpbem: tpbemImg, fabx: fabxImg };

let tipN = 0;
export function resetIds(): void {
  tipN = 0;
}

export const img = (k: keyof typeof IMG, cls = ''): Html => html`<img src="${IMG[k]}" alt=""${cls ? html` class="${cls}"` : EMPTY}>`;

export const M = (s: Part): Html => html`<span class="mono">${s}</span>`;

/** A BEM amount: four places and the unit, kept on one line. */
export const B = (rawAmount: bigint): Html => html`<span class="nw"><span class="mono">${bem4(rawAmount)}</span> <span class="u">BEM</span></span>`;

export type ChipKind = 'a' | 'ok' | 'n' | 'w' | 'bad';
export const chip = (kind: ChipKind, label: Part): Html => html`<span class="st st-${kind}"><i></i>${label}</span>`;

const INFO = raw(
  '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" stroke="#8A9AB2" stroke-width="1.3" fill="none"></circle><path d="M7 6.2V10M7 4.1V4" stroke="#8A9AB2" stroke-width="1.4" stroke-linecap="round"></path></svg>',
);

export function tip(text: Part, cls = ''): Html {
  const id = `tip${++tipN}`;
  return html`<span class="tip-w"><button type="button" class="tip" aria-label="${t('More info', '详细说明')}" aria-describedby="${id}">${INFO}</button><span class="tip-pop ${cls}" role="tooltip" id="${id}">${text}</span></span>`;
}

export type CalloutKind = 'i' | 'w' | 'bad' | 'ok' | 'n';
/** A callout box. `bad` is announced to screen readers. */
export function cl(kind: CalloutKind, content: Part, act: Part = null): Html {
  return html`<div class="cl cl-${kind}"${kind === 'bad' ? raw(' role="alert"') : EMPTY}><span class="cl-ic" aria-hidden="true"></span><div class="cl-t">${content}</div>${act ? html`<div class="cl-act">${act}</div>` : EMPTY}</div>`;
}

/** The FabX and FAB placeholders stay on purpose (SPEC-PHASE5-APP S-2). */
export const soonTip = (): string =>
  t('A FAB pool for FabX rigs is planned. It is not live, so there is nothing to supply or borrow yet.', 'FabX 矿机的 FAB 资金池正在计划中，尚未上线，目前无法存入或借款。');
export const soon = (title: string = soonTip()): Html => html`<span class="soon" title="${title}">${t('Coming soon', '即将上线')}</span>`;

export const back = (href: string, label: Part): Html => html`<a class="back" href="${href}">← ${label}</a>`;

export function proc(p: Processor | null): Html {
  if (p === null) return html`${t('Unsupported processor', '不支持的处理器')}`;
  return p === 'TapeOut' ? html`${img('tapeout')}TapeOut` : html`${p}`;
}

/** A progress ring. The sizes are fixed classes; the arc is an SVG attribute. */
export function ring(pct: number, size: 30 | 34 | 56): Html {
  const d = Math.round((170 * pct) / 100);
  return html`<span class="ring ring-${size}" role="img" aria-label="${pct}%"><svg width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="27" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="7"></circle><circle cx="32" cy="32" r="27" fill="none" stroke="#2E9BDA" stroke-width="7" stroke-linecap="round" stroke-dasharray="${d} 170"></circle></svg><span>${pct}%</span></span>`;
}

/** A bar whose width is applied from `data-pct` after each render. */
export const bar = (pct: number, cls = ''): Html => html`<span class="bar bar-b ${cls}"><span data-pct="${pct.toFixed(1)}"></span></span>`;

/* ───────── write controls ───────── */

export interface ActOpts {
  a: string;
  v?: string | number;
  /** Look of the enabled button: primary, secondary or danger. */
  kind?: 'p' | 's' | 'd';
  /** Look when it is off. */
  offKind?: 's' | 'x';
  size?: 'lg' | 'sm';
  block?: boolean;
  /** Sections whose staleness turns this button off. */
  needs?: Section[];
  /** Extra reason to turn it off. */
  disabled?: boolean;
}

/**
 * A button that sends something. In a frame it is not drawn; in a read-only view or on stale data it is drawn off.
 * Wallet buttons (connect, switch network) and plain page controls use `html` directly.
 */
export function act(c: Ctx, o: ActOpts, label: Part): Html {
  if (c.readOnly === 'frame') return EMPTY;
  const stale = (o.needs ?? []).some((s) => c.snap.stale[s]);
  const off = c.readOnly === 'view' || stale || o.disabled === true;
  const look = off ? (o.offKind ?? 'x') : (o.kind ?? 'p');
  const klass = `btn btn-${look}${o.size ? ` btn-${o.size}` : ''}${o.block ? ' w100' : ''}`;
  if (off) return html`<button type="button" class="${klass}" disabled>${label}</button>`;
  return html`<button type="button" class="${klass}" data-a="${o.a}"${o.v !== undefined ? html` data-v="${o.v}"` : EMPTY}>${label}</button>`;
}

/** A link-styled write control (Change, Apply now). */
export function actLink(c: Ctx, o: { a: string; v?: string | number; needs?: Section[] }, label: Part): Html {
  if (c.readOnly === 'frame' || c.readOnly === 'view') return EMPTY;
  if ((o.needs ?? []).some((s) => c.snap.stale[s])) return EMPTY;
  return html`<button type="button" class="lnk" data-a="${o.a}"${o.v !== undefined ? html` data-v="${o.v}"` : EMPTY}>${label}</button>`;
}
