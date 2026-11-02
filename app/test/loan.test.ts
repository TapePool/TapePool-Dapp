import { describe, expect, it } from 'vitest';
import type { SeizeInfo } from '../src/logic/history';
import { buildOpenLoan, buildSeizedLoan, clearedFrom, debtProgress, impairmentOf, payoffEstimate, phaseOf, type LoanRaw } from '../src/logic/loan';
import { buildRigView } from '../src/logic/rigState';
import type { BscFacts, LoanView, PoolParams, RigFacts, RigView } from '../src/model';
import { A, CPU, NOW } from './world';

const H = 3_600;
const raw = (over: Partial<LoanRaw> = {}): LoanRaw => ({
  open: true,
  start: BigInt(NOW - 86_400),
  maturity: BigInt(NOW + 6 * 86_400),
  term: 0,
  principal: 50_000_000n,
  principal0: 60_000_000n,
  feeLeft: 450_000n,
  lateBpsPerDay: 0,
  lateAccruedTo: BigInt(NOW + 6 * 86_400),
  lateFeeDue: 0n,
  debt: 50_450_000n,
  impairedAt: 0n,
  impairedRig: 0n,
  doubtful: false,
  seizeStart: 0n,
  deadline: 0n,
  expired: false,
  ...over,
});

const bsc = (over: Partial<BscFacts> = {}): BscFacts => ({ status: 1, stopBlock: 0n, custodied: true, verifWeight: 25n, bonus: 5n, since: NOW - 30 * 86_400, mined: 3n, circuits: CPU.tapeout, circuitId: 7n, taskId: 4n, ...over });
const facts = (id: number, b: BscFacts | null): RigFacts => ({
  id,
  place: { kind: 'agent', agent: A(1), closed: false, collateral: true, loanOpen: true },
  bsc: b,
  bscAsOf: null,
  voucher: { circuits: CPU.tapeout, circuitId: 7n, power: 25n },
  processor: b ? 'TapeOut' : null,
  screen: { pass: null, suspended: false },
});
const view = (id: number, b: BscFacts | null): RigView => buildRigView(facts(id, b), NOW);

const params: PoolParams = {
  feeBps: [75, 150],
  maxDebtBps: [8_500, 8_000],
  termDays: [7, 14],
  minFee: 300_000n,
  minAdvance: 1_000_000n,
  lateFeeBpsPerDay: 0,
  perBorrowerBps: 4_000,
  borrowCapBps: 7_000,
  borrowCapAbs: 1_000_000_000n,
  supplyCap: 2_000_000_000n,
  opsFee: [31_000_000_000_000_000n, 31_000_000_000_000_000n],
};

describe('phaseOf', () => {
  it('is active until maturity and late after it', () => {
    expect(phaseOf(raw(), NOW)).toBe('active');
    expect(phaseOf(raw(), NOW + 6 * 86_400)).toBe('active');
    expect(phaseOf(raw(), NOW + 6 * 86_400 + 1)).toBe('late');
  });

  it('follows the flag the contract reports: flagged until the cure window ends, then the seize window', () => {
    const flag = raw({ impairedAt: BigInt(NOW), impairedRig: 3n, seizeStart: BigInt(NOW + 72 * H), deadline: BigInt(NOW + 96 * H) });
    expect(phaseOf(flag, NOW + 1)).toBe('flagged');
    expect(phaseOf(flag, NOW + 72 * H - 1)).toBe('flagged');
    expect(phaseOf(flag, NOW + 72 * H)).toBe('seize');
    expect(phaseOf(flag, NOW + 95 * H)).toBe('seize');
  });

  it('a flag the contract calls expired no longer limits the loan', () => {
    const flag = raw({ impairedAt: BigInt(NOW - 200 * H), impairedRig: 3n, seizeStart: BigInt(NOW - 128 * H), deadline: BigInt(NOW - 104 * H), expired: true });
    expect(phaseOf(flag, NOW)).toBe('active');
    expect(phaseOf(flag, NOW + 7 * 86_400)).toBe('late');
  });
});

describe('impairmentOf: what the BSC read says about the rig that raised the flag', () => {
  it('names a rescue, a stop, a rig that is no longer active and a missing base power', () => {
    expect(impairmentOf(facts(1, bsc({ stopBlock: 5n, status: 3 })))).toBe('stopped');
    expect(impairmentOf(facts(1, bsc({ status: 2 })))).toBe('inactive');
    expect(impairmentOf(facts(1, bsc({ custodied: false })))).toBe('rescued');
    expect(impairmentOf(facts(1, bsc({ circuits: '0x0000000000000000000000000000000000000000', custodied: false, status: 0 })))).toBe('rescued');
    expect(impairmentOf(facts(1, bsc({ verifWeight: 5n, bonus: 5n })))).toBe('no-power');
  });

  it('falls back to the generic line without data, or when the rig looks healthy (a voucher that synced power 0)', () => {
    expect(impairmentOf(undefined)).toBe('unknown');
    expect(impairmentOf(facts(1, null))).toBe('unknown');
    expect(impairmentOf(facts(1, bsc()))).toBe('unknown');
  });

  it('checks a rescue before a stop, since a rescued rig is also gone from the vault', () => {
    expect(impairmentOf(facts(1, bsc({ custodied: false, stopBlock: 9n, status: 3 })))).toBe('rescued');
  });
});

describe('buildOpenLoan', () => {
  const rigs = new Map<number, RigView>([
    [3, view(3, bsc({ mined: 10n }))],
    [4, view(4, bsc({ mined: 20n, verifWeight: 45n }))],
  ]);
  const rules = { totalVerifWeight: 1_600_000n, emissionValidUntil: NOW + 400 * 86_400 };

  it('maps loanOf() and sums the collateral', () => {
    const L = buildOpenLoan({ agent: A(1), raw: raw(), agentBem: 99n, now: NOW, collateral: [3, 4], rigs, rules, params, info: { feePaid: 450_000n, opsFeePaid: 31_000_000_000_000_000n } });
    expect(L).toMatchObject({ agent: A(1), rigIds: [3, 4], phase: 'active', term: 0, advance: 60_000_000n, principal: 50_000_000n, feeLeft: 450_000n, lateFee: 0n, feePaid: 450_000n, opsFeePaid: 31_000_000_000_000_000n, agentBem: 99n, minedBsc: 30n, impairment: null });
    expect(L.start).toBe(NOW - 86_400);
    expect(L.collateral.map((c) => [c.id, c.basePower, c.mining])).toEqual([
      [3, 20n, true],
      [4, 40n, true],
    ]);
    // expected output per day: the term's output spread over its days
    expect(L.expectedPerDay).toBeGreaterThan(0n);
  });

  it('keeps the late fee and the late rate, and unknown fees as null', () => {
    const L = buildOpenLoan({ agent: A(1), raw: raw({ lateFeeDue: 9n, lateBpsPerDay: 10, term: 1 }), agentBem: 0n, now: NOW, collateral: [3], rigs, rules, params, info: null });
    expect(L).toMatchObject({ lateFee: 9n, lateBpsPerDay: 10, term: 1, feePaid: null, opsFeePaid: null });
  });

  it('a collateral id that was not read shows zeros and "not mining" rather than a guess', () => {
    const L = buildOpenLoan({ agent: A(1), raw: raw(), agentBem: 0n, now: NOW, collateral: [3, 99], rigs, rules, params, info: null });
    expect(L.collateral[1]).toEqual({ id: 99, basePower: 0n, processor: null, age: 0, mining: false });
  });

  it('a flagged loan carries the cure and seize windows as the contract gave them, and the kind of impairment', () => {
    const stoppedRigs = new Map<number, RigView>([[3, view(3, bsc({ status: 3, stopBlock: 9n }))]]);
    const L = buildOpenLoan({
      agent: A(1),
      raw: raw({ impairedAt: BigInt(NOW - H), impairedRig: 3n, seizeStart: BigInt(NOW + 71 * H), deadline: BigInt(NOW + 95 * H) }),
      agentBem: 0n,
      now: NOW,
      collateral: [3],
      rigs: stoppedRigs,
      rules,
      params,
      info: null,
    });
    expect(L).toMatchObject({ phase: 'flagged', impairedAt: NOW - H, seizeStart: NOW + 71 * H, deadline: NOW + 95 * H, impairedRig: 3, impairment: 'stopped' });
    expect(L.collateral[0]?.mining).toBe(false);
  });
});

describe('buildSeizedLoan', () => {
  const rigs = new Map<number, RigView>([[8, view(8, bsc({ status: 3, stopBlock: 1n }))]]);
  const info = (loan: LoanRaw | null): SeizeInfo => ({ block: 5n, seizedAt: NOW - 100, moved: [9, 8], stuck: [12], writtenOff: 55_000_000n, loan, open: { feePaid: 450_000n, opsFeePaid: null } });

  it('uses the loan as it stood before the seize, with the principal written off', () => {
    const L = buildSeizedLoan(A(3), info(raw({ impairedAt: BigInt(NOW - 200_000), impairedRig: 8n, seizeStart: BigInt(NOW - 100_000), deadline: BigInt(NOW - 20_000) })), rigs);
    expect(L).toMatchObject({ phase: 'seized', rigIds: [8, 9, 12], advance: 60_000_000n, principal: 0n, feeLeft: 0n, lateFee: 0n, writtenOff: 55_000_000n, seizedAt: NOW - 100, feePaid: 450_000n, impairedRig: 8, impairment: 'stopped', minedBsc: 0n, agentBem: 0n });
    expect(L.collateral.every((c) => !c.mining)).toBe(true);
  });

  it('without the earlier loan it still describes the seize, with empty terms', () => {
    const L = buildSeizedLoan(A(3), info(null), rigs);
    expect(L).toMatchObject({ phase: 'seized', advance: 0n, start: NOW - 100, maturity: NOW - 100, impairedRig: null, impairment: null, writtenOff: 55_000_000n });
  });
});

describe('clearedFrom', () => {
  it('turns the last open loan the session saw into a cleared one', () => {
    const open = buildOpenLoan({ agent: A(1), raw: raw(), agentBem: 5n, now: NOW, collateral: [3], rigs: new Map([[3, view(3, bsc())]]), rules: { totalVerifWeight: 1n, emissionValidUntil: 1 }, params, info: { feePaid: 1n, opsFeePaid: null } });
    const L = clearedFrom(open, NOW + 5, 77n, 0n);
    expect(L).toMatchObject({ phase: 'cleared', clearedAt: NOW + 5, surplus: 77n, principal: 0n, feeLeft: 0n, lateFee: 0n, agentBem: 0n, advance: 60_000_000n, feePaid: 1n, impairedAt: null });
  });
});

describe('payoffEstimate: when the loan should be repaid (SPEC-PHASE5-PAYOFF)', () => {
  const T0 = Date.UTC(2026, 9, 24, 14, 37, 0) / 1000;
  const MAT = Date.UTC(2026, 9, 31, 14, 36, 27) / 1000;
  const WINDOW = MAT - 3_600;
  // rig #16's second loan: 0.0264 BEM of debt, 0.00165 BEM already mined, about 0.0044 BEM of base output a day
  const loan = (over: Partial<LoanView> = {}): LoanView =>
    ({ phase: 'active', principal: 2_340_000n, feeLeft: 300_000n, lateFee: 0n, agentBem: 0n, minedBsc: 165_532n, expectedPerDay: 443_600n, maturity: MAT, rigIds: [16], ...over }) as LoanView;

  it("works rig #16's loan out: covered about Oct 30 06:39 UTC, repaid about 07:00 UTC", () => {
    const p = payoffEstimate(loan(), 50, T0);
    expect(p.kind).toBe('before');
    expect(p.cover).toBe(T0 + 489_724);
    expect(p.at).toBe(Date.UTC(2026, 9, 30, 7, 0, 0) / 1000);
  });

  it('says nothing for a loan that is not open and active, has no debt, or whose mined BEM is unknown', () => {
    for (const phase of ['late', 'flagged', 'seize', 'seized', 'cleared'] as const) expect(payoffEstimate(loan({ phase }), 50, T0).kind, phase).toBe('none');
    expect(payoffEstimate(loan({ principal: 0n, feeLeft: 0n }), 50, T0).kind).toBe('none');
    expect(payoffEstimate(loan({ minedBsc: null }), 50, T0).kind).toBe('none');
  });

  it('the next sweep repays a loan whose agent already holds the debt', () => {
    const p = payoffEstimate(loan({ agentBem: 2_640_000n }), 50, T0);
    expect(p).toEqual({ kind: 'sweep', at: Math.ceil((T0 + 600) / 600) * 600, cover: null });
  });

  it("is covered from exactly the keeper's debt × 1.01 (here with no bridge fee), and not one raw unit below", () => {
    expect(payoffEstimate(loan({ minedBsc: 2_666_400n }), 0, T0).kind).toBe('covered');
    expect(payoffEstimate(loan({ minedBsc: 2_666_399n }), 0, T0).kind).toBe('before');
    // the BEM in the agent counts with the bridged output
    expect(payoffEstimate(loan({ minedBsc: 1_333_200n, agentBem: 1_333_200n }), 0, T0).kind).toBe('covered');
  });

  it('counts the bridge fee: the 5% fallback is later than the 0.5% fee', () => {
    const a = payoffEstimate(loan(), 50, T0).cover ?? 0;
    const b = payoffEstimate(loan(), 500, T0).cover ?? 0;
    expect(b).toBeGreaterThan(a);
  });

  it('adds a dust of rounding per rig: two rigs are later than one with the same output', () => {
    const one = payoffEstimate(loan(), 50, T0).cover ?? 0;
    const two = payoffEstimate(loan({ rigIds: [16, 17] }), 50, T0).cover ?? 0;
    expect(two).toBeGreaterThan(one);
  });

  it('switches to the maturity harvest at maturity − 1 h, to the second', () => {
    const s = (payoffEstimate(loan(), 50, T0).cover ?? 0) - T0; // seconds from now to covered, for these inputs
    expect(payoffEstimate(loan(), 50, WINDOW - s - 1).kind).toBe('before');
    const at = payoffEstimate(loan(), 50, WINDOW - s);
    expect(at.kind).toBe('maturity');
    expect(at.at).toBe(Math.ceil((WINDOW + 1_200) / 600) * 600);
  });

  it('inside the maturity window, the harvest there is the estimate, or the output falls short', () => {
    expect(payoffEstimate(loan({ minedBsc: 2_700_000n }), 50, WINDOW + 60).kind).toBe('maturity');
    expect(payoffEstimate(loan(), 50, WINDOW + 60).kind).toBe('short');
    // far too little output for the term
    expect(payoffEstimate(loan({ expectedPerDay: 1_000n }), 50, T0).kind).toBe('short');
  });

  it('has no estimate without an output rate', () => {
    expect(payoffEstimate(loan({ expectedPerDay: 0n }), 50, T0)).toEqual({ kind: 'unknown', at: null, cover: null });
  });

  it('rounds the time up to ten minutes and adds the check, the delivery and the sweep', () => {
    const p = payoffEstimate(loan(), 50, T0);
    expect((p.at ?? 0) % 600).toBe(0);
    expect(p.at ?? 0).toBeGreaterThanOrEqual((p.cover ?? 0) + 1_200);
    expect((p.at ?? 0) - ((p.cover ?? 0) + 1_200)).toBeLessThan(600);
  });
});

describe('debtProgress: the repaid and mined segments of the loan bar (SPEC-PHASE5-PROGRESS)', () => {
  // rig #16's second loan: 0.0234 BEM advance, 0.003 BEM fee, nothing repaid yet
  const loan = (over: Partial<LoanView> = {}): LoanView =>
    ({ phase: 'active', advance: 2_340_000n, feePaid: 300_000n, principal: 2_340_000n, feeLeft: 300_000n, lateFee: 0n, agentBem: 0n, minedBsc: 0n, ...over }) as LoanView;

  it('a fresh loan: nothing repaid or mined, the keeper harvests at 101%', () => {
    expect(debtProgress(loan(), 50)).toEqual({ repaid: 0, mined: 0, trigger: 1010 });
  });

  it("rig #16's loan on 2026-10-25 03:59 UTC: 0.004158 BEM mined is 15.6% of the debt after the bridge fee", () => {
    expect(debtProgress(loan({ minedBsc: 415_812n }), 50)).toEqual({ repaid: 0, mined: 156, trigger: 1010 });
  });

  it('BEM waiting in the agent counts as mined, not repaid, until a sweep', () => {
    expect(debtProgress(loan({ agentBem: 1_320_000n }), 50).mined).toBe(500);
  });

  it('a manual repayment moves the repaid segment and the marker with it', () => {
    // half the debt repaid: 1,320,000 left
    const p = debtProgress(loan({ principal: 1_320_000n, feeLeft: 0n }), 50);
    expect(p.repaid).toBe(500);
    expect(p.trigger).toBe(1005); // 50% + 50% × 1.01
  });

  it('the mined BEM can be unknown', () => {
    expect(debtProgress(loan({ minedBsc: null }), 50).mined).toBeNull();
  });

  it('without the fee from the borrow event, the base is the debt now and nothing counts as repaid', () => {
    expect(debtProgress(loan({ feePaid: null, minedBsc: 1_320_000n }), 0)).toEqual({ repaid: 0, mined: 500, trigger: 1010 });
  });

  it('the 5% fee fallback shows less mined than the 0.5% fee', () => {
    expect(debtProgress(loan({ minedBsc: 1_000_000n }), 500).mined ?? 0).toBeLessThan(debtProgress(loan({ minedBsc: 1_000_000n }), 50).mined ?? 0);
  });

  it('goes past 100% when the output covers more than the debt', () => {
    expect(debtProgress(loan({ minedBsc: 3_130_000n }), 50).mined).toBe(1179);
  });
});
