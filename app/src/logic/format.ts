import { DAY, HOUR } from '../constants';
import { getLang, t } from '../i18n';
import type { Address, Sec } from '../model';

export type Rounding = 'round' | 'floor' | 'ceil';

const pow10 = (n: number): bigint => 10n ** BigInt(n);

function divRound(num: bigint, den: bigint, mode: Rounding): bigint {
  const q = num / den;
  const r = num % den;
  if (r === 0n) return q;
  if (mode === 'floor') return q;
  if (mode === 'ceil') return q + 1n;
  return r * 2n >= den ? q + 1n : q;
}

/** `raw` (an integer with `decimals` places) as a fixed `dp`-place decimal string. */
export function fmtUnits(raw: bigint, decimals: number, dp: number, mode: Rounding = 'round'): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const scaledInt = decimals >= dp ? divRound(abs, pow10(decimals - dp), mode) : abs * pow10(dp - decimals);
  const s = scaledInt.toString().padStart(dp + 1, '0');
  const body = dp === 0 ? s : `${s.slice(0, s.length - dp)}.${s.slice(s.length - dp)}`;
  return neg && scaledInt !== 0n ? `-${body}` : body;
}

/** `n / d` as a decimal string with `dp` places, rounded half up. `d` must be positive. */
export function scaled(n: bigint, d: bigint, dp: number): string {
  return fmtUnits(divRound(n * pow10(dp + 6), d, 'round'), dp + 6, dp);
}

export const bem4 = (raw: bigint): string => fmtUnits(raw, 8, 4);
export const bem4Floor = (raw: bigint): string => fmtUnits(raw, 8, 4, 'floor');
export const tp4 = (raw: bigint): string => fmtUnits(raw, 14, 4);

/** Four places at least, up to eight with trailing zeros dropped: the exact value for an input box. */
export function bemExact(raw: bigint): string {
  const full = fmtUnits(raw, 8, 8);
  const [i = '0', f = ''] = full.split('.');
  return `${i}.${f.replace(/0+$/, '').padEnd(4, '0')}`;
}

/** Two places at least, up to eight with trailing zeros dropped: a parameter such as the minimum fee. */
export function bemTrim(raw: bigint): string {
  const full = fmtUnits(raw, 8, 8);
  const [i = '0', fr = ''] = full.split('.');
  return `${i}.${fr.replace(/0+$/, '').padEnd(2, '0')}`;
}

/** Up to eight places with trailing zeros dropped and no minimum: 10, 0.01, 0.003. */
export function bemAuto(raw: bigint): string {
  const [i = '0', fr = ''] = fmtUnits(raw, 8, 8).split('.');
  const frac = fr.replace(/0+$/, '');
  return frac ? `${i}.${frac}` : i;
}

/** A native-token amount (18 places) with trailing zeros dropped, keeping `minDp` places. */
export function native(wei: bigint, minDp = 3, maxDp = 6): string {
  const full = fmtUnits(wei, 18, maxDp);
  const [i = '0', f = ''] = full.split('.');
  return `${i}.${f.replace(/0+$/, '').padEnd(minDp, '0')}`;
}

/** Wallet balances show four places. */
export const native4 = (wei: bigint): string => fmtUnits(wei, 18, 4);

/** Parse what the user typed. Null when it is not a plain decimal or has too many places. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const s = text.trim();
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const [i = '0', f = ''] = s.split('.');
  if (f.length > decimals) return null;
  return BigInt(i || '0') * pow10(decimals) + BigInt(f.padEnd(decimals, '0') || '0');
}

/** Basis points as a percentage without trailing zeros: 75 -> 0.75%, 150 -> 1.5%, 8500 -> 85%. */
export function pctBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}%`;
}

/** The percentage `n / d` with `dp` places. */
export function pctOf(n: bigint, d: bigint, dp = 1): string {
  return d <= 0n ? '0%' : `${scaled(n * 100n, d, dp)}%`;
}

/** Whole-number percentage for the ring charts and bars. */
export function ringPct(n: bigint, d: bigint): number {
  if (d <= 0n) return 0;
  const p = Number((n * 1000n) / d) / 10;
  return Math.max(0, Math.min(100, Math.round(p)));
}

/** A cost share: one decimal below 100%, none above. */
export function pcAuto(n: bigint, d: bigint): string {
  if (d <= 0n) return '0%';
  return n >= d ? `${scaled(n * 100n, d, 0)}%` : `${scaled(n * 100n, d, 1)}%`;
}

/** A flat fee of `bps` per `days`, scaled to 365 days. */
export function yearlyFromBps(bps: number, days: number): string {
  return `${scaled(BigInt(bps) * 365n, BigInt(days) * 100n, 2)}%`;
}

/** The yearly rate of a cost `n` on an advance `d` paid over `days`. */
export function yearlyOf(n: bigint, d: bigint, days: number): string {
  if (d <= 0n) return '0%';
  return pcAuto(n * 365n, d * BigInt(days));
}

/** `0x1234…abcd` */
export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** `0xD7E0....92a966`: the first six characters (the `0x` included) and the last six, for the wallet menu. */
export function menuAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}....${a.slice(-6)}` : a;
}

export const addrKey = (a: Address): string => a.toLowerCase();

/** The keeper's decimal string (`"0.091900"`) as a percentage with two places. */
export function pctFromDecimalString(s: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s); // the APY is negative when the share price fell
  if (!m) return '—';
  const digits = (m[3] ?? '').padEnd(8, '0').slice(0, 8);
  const v = BigInt(m[2] ?? '0') * 10n ** 8n + BigInt(digits);
  return `${m[1] === '-' && v !== 0n ? '-' : ''}${fmtUnits(v * 100n, 8, 2)}%`;
}

/* ───────── dates and durations (UTC; language-aware) ───────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number): string => String(n).padStart(2, '0');

export function hm(sec: Sec): string {
  const d = new Date(sec * 1000);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/** A date, with the time and "UTC" when `time` is set. */
export function fd(sec: Sec, time = false): string {
  const d = new Date(sec * 1000);
  if (getLang() === 'cn') return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日${time ? ` ${hm(sec)} UTC` : ''}`;
  return `${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCDate()}${time ? `, ${hm(sec)} UTC` : ''}`;
}

/** A window on one day: `Oct 26, 08:15–09:15 UTC`. */
export function win(a: Sec, b: Sec): string {
  return getLang() === 'cn' ? `${fd(a)} ${hm(a)}–${hm(b)} UTC` : `${fd(a)}, ${hm(a)}–${hm(b)} UTC`;
}

export function dur(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / HOUR);
  const d = Math.floor(h / 24);
  const hh = h % 24;
  const m = Math.floor(s / 60) % 60;
  if (d) return t(`${d} d ${hh} h`, `${d} 天 ${hh} 小时`);
  return t(`${hh} h ${m} min`, `${hh} 小时 ${m} 分钟`);
}

export function mmss(sec: number): string {
  const s = Math.ceil(Math.max(0, sec));
  return `${Math.floor(s / 60)}:${p2(s % 60)}`;
}

export const wholeDaysBetween = (a: Sec, b: Sec): number => Math.floor((b - a) / DAY);
