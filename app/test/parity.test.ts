import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { debtBucket, expectedOutput, maxDebt } from '../src/logic/creditMath';
import { fee, principalFor } from '../src/logic/fees';
import type { TermIndex } from '../src/model';

/**
 * SPEC-PHASE5-APP §5.3: the TypeScript ports against vectors computed by the real Solidity
 * (`script/app/ParityVectors.s.sol`, stored by `npm run gen:vectors`).
 */

const dir = path.resolve(__dirname, 'vectors');
const load = <T>(name: string): Record<string, T[]> => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Record<string, T[]>;

const cm = load<Record<string, string | number>>('creditMath.json');
const fe = load<Record<string, string | number>>('fees.json');
const big = (v: string | number | undefined): bigint => BigInt(v ?? 0);
const term = (v: string | number | undefined): TermIndex => (Number(v) === 1 ? 1 : 0);

describe('parity vectors from the Solidity contracts', () => {
  it('there are at least 200 of them, with the edges the spec names', () => {
    const all = [...Object.values(cm), ...Object.values(fe)].flat();
    expect(all.length).toBeGreaterThanOrEqual(200);
    // rounding edges and the minimum-fee region are in the set, not only random cases
    const fees = fe.fee ?? [];
    expect(fees.some((v) => big(v.out) === big(v.minFee) && big(v.principal) > 0n)).toBe(true); // the minimum fee wins
    expect(fees.some((v) => big(v.out) > big(v.minFee))).toBe(true); // the rate wins
    expect((cm.debtBucket ?? []).some((v) => big(v.expected) === 0n && Number(v.out) === 31)).toBe(true);
    expect((cm.debtBucket ?? []).some((v) => Number(v.out) === 31 && big(v.expected) > 0n)).toBe(true);
    expect(new Set((fe.fee ?? []).map((v) => `${v.feeBps7d}/${v.feeBps14d}/${v.minFee}`)).size).toBeGreaterThanOrEqual(5);
  });

  it('expectedOutput matches every vector', () => {
    const rows = cm.expectedOutput ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(100);
    for (const v of rows) expect(expectedOutput(big(v.base), big(v.total), term(v.term)), JSON.stringify(v)).toBe(big(v.out));
  });

  it('maxDebt matches every vector', () => {
    const rows = cm.maxDebt ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const v of rows) expect(maxDebt(big(v.expected), term(v.term)), JSON.stringify(v)).toBe(big(v.out));
  });

  it('debtBucket matches every vector, the overflow guard included', () => {
    const rows = cm.debtBucket ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(100);
    for (const v of rows) expect(debtBucket(big(v.debt), big(v.expected)), JSON.stringify(v)).toBe(Number(v.out));
  });

  it('fee matches every vector', () => {
    const rows = fe.fee ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(100);
    for (const v of rows) {
      const p = { feeBps: [Number(v.feeBps7d), Number(v.feeBps14d)] as const, minFee: big(v.minFee) };
      expect(fee(p, term(v.term), big(v.principal)), JSON.stringify(v)).toBe(big(v.out));
    }
  });

  it('principalFor matches every vector', () => {
    const rows = fe.principalFor ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(100);
    for (const v of rows) {
      const p = { feeBps: [Number(v.feeBps7d), Number(v.feeBps14d)] as const, minFee: big(v.minFee) };
      expect(principalFor(p, term(v.term), big(v.debtLimit)), JSON.stringify(v)).toBe(big(v.out));
    }
  });

  it('principalFor really is the largest principal that fits (a property, on top of the vectors)', () => {
    for (const v of fe.principalFor ?? []) {
      const p = { feeBps: [Number(v.feeBps7d), Number(v.feeBps14d)] as const, minFee: big(v.minFee) };
      const t = term(v.term);
      const x = principalFor(p, t, big(v.debtLimit));
      if (x > 0n) expect(x + fee(p, t, x)).toBeLessThanOrEqual(big(v.debtLimit));
      expect(x + 1n + fee(p, t, x + 1n)).toBeGreaterThan(big(v.debtLimit));
    }
  });
});
