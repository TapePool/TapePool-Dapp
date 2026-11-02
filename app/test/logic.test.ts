import { describe, expect, it } from 'vitest';
import { createFixture } from '../src/fixtures/catalog';
import { AGENT_B, AGENT_C, MAINNET_PARAMS, TOTAL_VERIF_WEIGHT, bem, okb } from '../src/fixtures/data';
import { setLang } from '../src/i18n';
import { debtBarPct, defaultAmount, deriveBorrow, timely } from '../src/logic/borrow';
import { debtBucket, expectedOutput, maxDebt } from '../src/logic/creditMath';
import { fee, principalFor } from '../src/logic/fees';
import { debtBucketOf, failedFlags, firstFailedFlag } from '../src/logic/inputBits';
import type { Snapshot } from '../src/model';
import { freshUi, type UiState } from '../src/state';

const P = MAINNET_PARAMS;

describe('fee and principal (ports of TapePool.fee and TapeLens.principalFor)', () => {
  it('charges the rate rounded up, and never less than the minimum fee', () => {
    expect(fee(P, 0, bem(0.6))).toBe(bem(0.0045)); // 0.75% of 0.6 BEM
    expect(fee(P, 1, bem(0.6))).toBe(bem(0.009));
    expect(fee(P, 0, bem(0.01))).toBe(P.minFee);
    expect(fee(P, 0, 0n)).toBe(P.minFee);
    expect(fee(P, 0, 133_333_334n)).toBe(1_000_001n); // 1.33333334 BEM x 0.75% = 1000000.005, rounded up
  });

  it('principalFor is the largest principal that fits under the debt limit', () => {
    const limits = [0n, 1n, P.minFee - 1n, P.minFee, P.minFee + 1n, P.minFee + 1_000_000n, 40_000_000n, 143_000_000n, 238_471_793n, 1_000_000_000n];
    for (let x = 1_000n; x < 90_000_000n; x += 777_777n) limits.push(x);
    for (const term of [0, 1] as const) {
      for (const limit of limits) {
        const p = principalFor(P, term, limit);
        if (limit <= P.minFee) {
          expect(p, `limit ${limit}`).toBe(0n);
          continue;
        }
        expect(p + fee(P, term, p), `fits ${limit}`).toBeLessThanOrEqual(limit);
        expect(p + 1n + fee(P, term, p + 1n), `largest ${limit}`).toBeGreaterThan(limit);
      }
    }
  });
});

describe('credit math (port of CreditMath.sol)', () => {
  it('rounds expected output down and scales with base power', () => {
    const e = expectedOutput(80n, TOTAL_VERIF_WEIGHT, 0);
    expect(Number(e) / 1e8).toBeCloseTo(2.3847, 3);
    expect(expectedOutput(0n, TOTAL_VERIF_WEIGHT, 0)).toBe(0n);
    expect(expectedOutput(80n, 0n, 0)).toBe(0n);
    expect(expectedOutput(80n, TOTAL_VERIF_WEIGHT, 1)).toBeGreaterThan(expectedOutput(80n, TOTAL_VERIF_WEIGHT, 0));
  });

  it('caps the debt at 85% (7 d) and 80% (14 d) of the expected output', () => {
    expect(maxDebt(1_000_000n, 0)).toBe(850_000n);
    expect(maxDebt(1_000_000n, 1)).toBe(800_000n);
  });

  it('buckets the debt in steps of 5% and rounds toward deny', () => {
    expect(debtBucket(850_000n, 1_000_000n)).toBe(17);
    expect(debtBucket(850_001n, 1_000_000n)).toBe(18);
    expect(debtBucket(1n, 1_000_000n)).toBe(1);
    expect(debtBucket(10n, 0n)).toBe(31);
    expect(debtBucket(10n ** 30n, 1n)).toBe(31);
  });
});

describe('inputBits', () => {
  it('reads the five flags from bit 7 and the bucket from bits 2 to 6', () => {
    expect(failedFlags(0xfc4)).toEqual([]);
    expect(debtBucketOf(0xfc4)).toBe(17);
    expect(debtBucketOf(0xfc1)).toBe(16);
    expect(firstFailedFlag(0b11110 << 7)).toBe('fresh');
    expect(failedFlags(0b01010 << 7)).toEqual(['fresh', 'processor', 'screened']);
    expect(firstFailedFlag(0b01111 << 7)).toBe('screened');
  });

  it('decodes what the live TapeLens answered for an agent whose report was stale and whose rig had no screen pass (2026-10-23)', () => {
    // inputBits 1916 (term 7 d) and 1917 (term 14 d) from TapeLens.quote on mainnet: bucket 31 (no expected output), fresh and screened missing
    expect(debtBucketOf(1916)).toBe(31);
    expect(1916 & 3).toBe(0);
    expect(1917 & 3).toBe(1);
    expect(failedFlags(1916)).toEqual(['fresh', 'screened']);
    expect(failedFlags(1917)).toEqual(['fresh', 'screened']);
    expect(firstFailedFlag(1916)).toBe('fresh');
  });
});

describe('freshness of a report, by chain time (§6.3)', () => {
  it('is timely up to 60 s ahead and 300 s behind', () => {
    const now = 1_000_000;
    expect(timely(now + 60, now)).toBe(true);
    expect(timely(now + 61, now)).toBe(false);
    expect(timely(now - 300, now)).toBe(true);
    expect(timely(now - 301, now)).toBe(false);
  });
});

/* ───────── the borrow flow, step by step ───────── */

function load(name: string, tweak?: (s: Snapshot, u: UiState) => Snapshot | void): { snap: Snapshot; ui: UiState; now: number } {
  const f = createFixture(name, { clock: () => 0 });
  let snap = f.store.snapshot(null);
  const ui = f.ui;
  if (name === 'flow-idle' || name === 'connected') ui.sel = [4127];
  if (tweak) snap = tweak(snap, ui) ?? snap;
  return { snap, ui, now: snap.now };
}

const agentC = (s: Snapshot) => s.agents.find((a) => a.address === AGENT_C);

describe('deriveBorrow', () => {
  it('step 1: nothing done, an empty agent could be reused', () => {
    const { snap, ui, now } = load('flow-idle');
    const b = deriveBorrow(snap, ui, now);
    expect(b?.agentDone).toBe(false);
    expect(b?.moved).toBe(false);
    expect(b?.report).toBe('idle');
    expect(b?.reusable?.address).toBe(AGENT_B);
    expect(b?.source).toBe('estimate');
    expect(b?.rule).toBe('estimate');
    expect(b?.canBorrow).toBe(false);
    expect(b?.txLeft).toBe(3);
  });

  it('step 1 is done when the agent exists, step 2 when every voucher is in it', () => {
    const a = load('flow-agent');
    const ba = deriveBorrow(a.snap, a.ui, a.now);
    expect(ba?.agentDone).toBe(true);
    expect(ba?.moved).toBe(false);
    expect(ba?.txLeft).toBe(2);
    const m = load('flow-moved');
    const bm = deriveBorrow(m.snap, m.ui, m.now);
    expect(bm?.moved).toBe(true);
    expect(bm?.report).toBe('idle');
    expect(bm?.txLeft).toBe(1);
  });

  it('resumes after a reload: with no screen state at all, the agent that holds the voucher is found', () => {
    const { snap, now } = load('flow-moved');
    const b = deriveBorrow(snap, { ...freshUi(), sel: [4127] }, now);
    expect(b?.agent?.address).toBe(AGENT_C);
    expect(b?.moved).toBe(true);
  });

  it('step 3: waiting while the keeper request is out', () => {
    const { snap, ui, now } = load('flow-waiting');
    expect(deriveBorrow(snap, ui, now)?.report).toBe('waiting');
  });

  it('step 3: a fresh report counts down to 15 s before it expires, and switches to the lens quote', () => {
    const { snap, ui, now } = load('flow-fresh');
    const b = deriveBorrow(snap, ui, now);
    expect(b?.report).toBe('fresh');
    expect(b?.secondsLeft).toBe(300 - 15 - 20); // the fixture report is 20 s old
    expect(b?.source).toBe('quote');
    expect(b?.rule).toBe('allow');
    expect(b?.canBorrow).toBe(true);
    expect(b?.blockers).toEqual([]);
  });

  it('the countdown reaches zero at observedAt + 285 and step 3 goes back to "refresh again"', () => {
    const { snap, ui } = load('flow-fresh');
    const obs = snap.reports['4127']?.observedAt ?? 0;
    expect(deriveBorrow(snap, ui, obs + 284)?.report).toBe('fresh');
    expect(deriveBorrow(snap, ui, obs + 284)?.secondsLeft).toBe(1);
    const late = deriveBorrow(snap, ui, obs + 285);
    expect(late?.report).toBe('expired');
    expect(late?.canBorrow).toBe(false);
    expect(late?.source).toBe('estimate');
    expect(deriveBorrow(snap, ui, obs + 301)?.report).toBe('expired');
  });

  it('a report from the future by more than 60 s is not used', () => {
    const { snap, ui, now } = load('flow-fresh', (s) => ({ ...s, reports: { '4127': { observedAt: s.now + 61 } } }));
    expect(deriveBorrow(snap, ui, now)?.report).toBe('expired');
    const ok = load('flow-fresh', (s) => ({ ...s, reports: { '4127': { observedAt: s.now + 60 } } }));
    expect(deriveBorrow(ok.snap, ok.ui, ok.now)?.report).toBe('fresh');
  });

  it('every voucher of the agent needs a timely report', () => {
    const { snap, ui, now } = load('flow-fresh', (s) => ({
      ...s,
      agents: s.agents.map((a) => (a.address === AGENT_C ? { ...a, collateral: [4127, 4128] } : a)),
      reports: { '4127': { observedAt: s.now - 10 } },
    }));
    // 4128 is not in the selection, but it is in the agent's collateral set: the loan is backed by all of it
    expect(deriveBorrow(snap, ui, now)?.report).toBe('idle');
  });

  it('shows the rule saying no, and which flag failed', () => {
    const { snap, ui, now } = load('flow-deny');
    const b = deriveBorrow(snap, ui, now);
    expect(b?.rule).toBe('deny');
    expect(b?.canBorrow).toBe(false);
    expect(b?.blockers.join(' ')).toContain('The credit rule says no: it has no valid screen pass.');
    const s = load('flow-deny-small');
    const bs = deriveBorrow(s.snap, s.ui, s.now);
    expect(bs?.rule).toBe('deny');
    expect(bs?.blockers.join(' ')).toContain('minimum advance of 0.01 BEM');
  });

  it("shows can't check as no", () => {
    const { snap, ui, now } = load('flow-cant-check');
    const b = deriveBorrow(snap, ui, now);
    expect(b?.rule).toBe('cant');
    expect(b?.canBorrow).toBe(false);
    expect(b?.blockers.join(' ')).toContain('could not be checked');
  });

  it('needs the fee and the gas in OKB', () => {
    const ok = load('flow-fresh');
    expect(deriveBorrow(ok.snap, ok.ui, ok.now)?.okbEnough).toBe(true);
    const low = load('flow-fresh', (s) => ({ ...s, wallet: { ...s.wallet, okb: okb(0.03) } }));
    const b = deriveBorrow(low.snap, low.ui, low.now);
    expect(b?.okbEnough).toBe(false);
    expect(b?.canBorrow).toBe(false);
    expect(b?.okbShort).toBe(P.opsFee[0] + low.snap.wallet.borrowGas - okb(0.03));
    // exactly enough is enough
    const exact = load('flow-fresh', (s) => ({ ...s, wallet: { ...s.wallet, okb: P.opsFee[0] + s.wallet.borrowGas } }));
    expect(deriveBorrow(exact.snap, exact.ui, exact.now)?.okbEnough).toBe(true);
  });

  it('is closed while the pool is paused, the feed is off or a rule swap is queued', () => {
    for (const patch of [{ borrowsPaused: true }, { feedDisabled: true }, { pendingPolicy: { address: AGENT_B, eta: 1 } }]) {
      const { snap, ui, now } = load('flow-fresh', (s) => ({ ...s, pool: { ...s.pool, ...patch } }));
      const b = deriveBorrow(snap, ui, now);
      expect(b?.poolOpen).toBe(false);
      expect(b?.canBorrow).toBe(false);
    }
  });

  it('turns every action off while a request is in progress or a read is stale', () => {
    const p = load('flow-fresh', (s) => ({ ...s, pending: { action: 'move', since: s.now, hash: null } }));
    expect(deriveBorrow(p.snap, p.ui, p.now)?.canBorrow).toBe(false);
    const st = load('flow-fresh', (s) => ({ ...s, stale: { pool: true } }));
    expect(deriveBorrow(st.snap, st.ui, st.now)?.canBorrow).toBe(false);
  });

  it('checks the typed amount: empty, below the minimum, above the max', () => {
    const { snap, ui, now } = load('flow-fresh');
    const b0 = deriveBorrow(snap, ui, now);
    const max = b0?.limits[0].maxPrincipal ?? 0n;
    expect(b0?.amount.valid).toBe(true);
    expect(b0?.amount.value).toBe(defaultAmount(max, P.minAdvance));
    for (const [text, part] of [
      ['', 'Enter an amount.'],
      ['abc', 'Enter an amount.'],
      ['0', 'Enter an amount.'],
      ['0.009', 'minimum advance is 0.01 BEM'],
      ['999', 'Above your max'],
    ] as const) {
      ui.amt = text;
      const b = deriveBorrow(snap, ui, now);
      expect(b?.amount.valid, text).toBe(false);
      expect(b?.amount.error, text).toContain(part);
      expect(b?.canBorrow, text).toBe(false);
    }
    ui.amt = '0.0100';
    const small = deriveBorrow(snap, ui, now);
    expect(small?.amount.valid).toBe(true);
    expect(small?.amount.fee).toBe(P.minFee);
    expect(small?.amount.minFeeApplies).toBe(true);
    ui.amt = String(Number(max) / 1e8);
    expect(deriveBorrow(snap, ui, now)?.amount.valid).toBe(true);
  });

  it('applies the emission rule: a term that would end after the halving window is not offered', () => {
    const { snap, ui, now } = load('flow-idle', (s) => ({ ...s, rules: { ...s.rules, emissionValidUntil: s.now + 10 * 86_400 } }));
    const b = deriveBorrow(snap, ui, now);
    expect(b?.limits[0].offered).toBe(true);
    expect(b?.limits[1].offered).toBe(false);
    expect(b?.limits[1].maxPrincipal).toBe(0n);
  });

  it('caps the estimate by the pool room for the miner', () => {
    const { snap, ui, now } = load('flow-idle', (s) => ({ ...s, wallet: { ...s.wallet, room: bem(0.5) } }));
    const b = deriveBorrow(snap, ui, now);
    expect(b?.limits[0].maxPrincipal).toBe(bem(0.5));
    expect(b?.limits[0].roomLimited).toBe(true);
  });

  it('asks about BEM mined before the loan from a tenth of the debt, and not for a rig with little (SPEC-PHASE5-PRELOAN §4.1)', () => {
    const { snap, ui, now } = load('flow-idle', () => undefined);
    ui.sel = [4128];
    expect(deriveBorrow(snap, ui, now)?.mined.step2.kind).toBe('choice');
    expect(deriveBorrow(snap, { ...freshUi(), sel: [4127] }, now)?.mined.step2.kind).toBe('info');
  });

  it('has nothing without a borrowable selection', () => {
    const { snap, ui, now } = load('flow-idle');
    ui.sel = [4301]; // not screened
    expect(deriveBorrow(snap, ui, now)).toBeNull();
    ui.sel = [];
    expect(deriveBorrow(snap, ui, now)).toBeNull();
  });

  it('the debt bar shows the share of the allowed maximum', () => {
    expect(debtBarPct(850n, 1000n, 8500)).toBe(100);
    expect(debtBarPct(425n, 1000n, 8500)).toBe(50);
    expect(debtBarPct(5000n, 1000n, 8500)).toBe(100);
    expect(debtBarPct(1n, 0n, 8500)).toBe(0);
  });

  it('keeps the term and the group choice out of the chain facts', () => {
    const { snap, ui, now } = load('flow-fresh');
    ui.term = 1;
    const b = deriveBorrow(snap, ui, now);
    expect(b?.term).toBe(1);
    expect(b?.quote?.opsFee).toBe(P.opsFee[1]);
    expect(agentC(snap)?.collateral).toEqual([4127]);
    setLang('en', false);
  });
});
