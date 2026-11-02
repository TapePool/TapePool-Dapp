import { describe, expect, it } from 'vitest';
import {
  bem4,
  bem4Floor,
  bemAuto,
  bemExact,
  bemTrim,
  dur,
  fd,
  fmtUnits,
  mmss,
  native,
  parseAmount,
  pcAuto,
  pctBps,
  pctFromDecimalString,
  pctOf,
  ringPct,
  shortAddr,
  win,
  yearlyFromBps,
  yearlyOf,
} from '../src/logic/format';
import { setLang } from '../src/i18n';

describe('formatters work on bigint', () => {
  it('rounds half up, floors and ceils', () => {
    expect(bem4(123_456_789n)).toBe('1.2346');
    expect(bem4(123_450_000n)).toBe('1.2345');
    expect(bem4(123_455_000n)).toBe('1.2346');
    expect(bem4Floor(123_459_999n)).toBe('1.2345');
    expect(fmtUnits(1n, 8, 4, 'ceil')).toBe('0.0001');
    expect(fmtUnits(0n, 8, 4)).toBe('0.0000');
    expect(fmtUnits(-150_000_000n, 8, 2)).toBe('-1.50');
    expect(bem4(10n ** 20n)).toBe('1000000000000.0000'); // far beyond Number precision
  });

  it('trims trailing zeros where the figure is a parameter', () => {
    expect(bemTrim(1_000_000n)).toBe('0.01');
    expect(bemTrim(300_000n)).toBe('0.003');
    expect(bemTrim(1_000_000_000n)).toBe('10.00');
    expect(bemAuto(1_000_000_000n)).toBe('10');
    expect(bemAuto(1_000_000n)).toBe('0.01');
    expect(bemExact(30_800_000n)).toBe('0.3080');
    expect(bemExact(30_800_001n)).toBe('0.30800001');
  });

  it('formats OKB with the figures that matter', () => {
    expect(native(31_000_000_000_000_000n)).toBe('0.031');
    expect(native(40_000_000_000_000_000n)).toBe('0.040');
    expect(native(1_700_000_000_000_000n, 4, 4)).toBe('0.0017');
    expect(native(500_000_000_000_000_000n)).toBe('0.500');
  });

  it('parses what the user types, strictly', () => {
    expect(parseAmount('1', 8)).toBe(100_000_000n);
    expect(parseAmount('0.0001', 8)).toBe(10_000n);
    expect(parseAmount('.5', 8)).toBe(50_000_000n);
    expect(parseAmount('5.', 8)).toBe(500_000_000n);
    expect(parseAmount(' 2.50000001 ', 8)).toBe(250_000_001n);
    for (const bad of ['', '.', 'abc', '1e3', '-1', '1,5', '1.123456789', '0x10', '1 2', '１']) expect(parseAmount(bad, 8), bad).toBeNull();
  });

  it('writes basis points as a short percentage', () => {
    expect(pctBps(75)).toBe('0.75%');
    expect(pctBps(150)).toBe('1.5%');
    expect(pctBps(8500)).toBe('85%');
    expect(pctBps(0)).toBe('0%');
    expect(pctBps(10)).toBe('0.1%');
    expect(pctBps(3500)).toBe('35%');
  });

  it('derives the yearly figures', () => {
    expect(yearlyFromBps(75, 7)).toBe('39.11%');
    expect(yearlyFromBps(150, 14)).toBe('39.11%');
    expect(pctOf(30n, 4000n, 2)).toBe('0.75%');
    expect(pcAuto(3n, 100n)).toBe('3.0%');
    expect(pcAuto(150n, 100n)).toBe('150%');
    expect(yearlyOf(30n, 4000n, 7)).toBe('39.1%');
    expect(yearlyOf(3n, 1n, 7)).toBe('15643%');
  });

  it('shows the keeper APY string as a percentage', () => {
    expect(pctFromDecimalString('0.091900')).toBe('9.19%');
    expect(pctFromDecimalString('0.000000')).toBe('0.00%');
    expect(pctFromDecimalString('1.5')).toBe('150.00%');
    expect(pctFromDecimalString('not a number')).toBe('—');
  });

  it('computes ring percentages', () => {
    expect(ringPct(14_265n, 20_000n)).toBe(71);
    expect(ringPct(0n, 0n)).toBe(0);
    expect(ringPct(5n, 2n)).toBe(100);
  });

  it('shortens addresses', () => {
    expect(shortAddr('0xD54673E73448584E86C61f45203ab507F3F2c3eC')).toBe('0xD546…c3eC');
    expect(shortAddr('0x12')).toBe('0x12');
  });
});

describe('dates and durations (UTC)', () => {
  const t0 = Date.UTC(2026, 9, 19, 12, 23) / 1000;
  it('writes English and Chinese dates', () => {
    setLang('en', false);
    expect(fd(t0)).toBe('Oct 19');
    expect(fd(t0, true)).toBe('Oct 19, 12:23 UTC');
    expect(win(t0 - 3600, t0)).toBe('Oct 19, 11:23–12:23 UTC');
    expect(dur(2 * 86400 + 3 * 3600)).toBe('2 d 3 h');
    expect(dur(5 * 3600 + 7 * 60)).toBe('5 h 7 min');
    setLang('cn', false);
    expect(fd(t0)).toBe('10月19日');
    expect(fd(t0, true)).toBe('10月19日 12:23 UTC');
    expect(dur(2 * 86400 + 3 * 3600)).toBe('2 天 3 小时');
    setLang('en', false);
  });

  it('counts down in m:ss and never goes below zero', () => {
    expect(mmss(285)).toBe('4:45');
    expect(mmss(59.2)).toBe('1:00');
    expect(mmss(-5)).toBe('0:00');
  });
});
