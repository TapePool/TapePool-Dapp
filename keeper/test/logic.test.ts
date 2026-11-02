import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { initialWatchState, stepWatch, TARGETS, type Target } from "../src/logic/upgradeWatch.js";
import { planBatches, BOND } from "../src/logic/harvest.js";
import {
  bundleEvidence,
  currentIncident,
  evidenceLanded,
  pruneEvidence,
  recordEvidenceSent,
  EVIDENCE_MAX_SENDS,
  EVIDENCE_RETRY,
  EVIDENCE_UNLANDED,
  type EvidenceRec,
  EVIDENCE_AFTER_SEIZE,
  PRE_MATURITY,
  SHORTFALL_EVERY,
  evidenceDue,
  syncsZeroPower,
  initialHarvestState,
  loanKey,
  planHarvest,
  recordHarvest,
  coveredLoan,
  COVER_MARGIN_BPS,
} from "../src/logic/schedule.js";
import { classify, initialConfirmState, observe } from "../src/logic/confirm.js";
import { PushLimiter, type PushRequest } from "../src/logic/pushLimits.js";
import { nextActions, pushUnlanded, type MachineInput, type RigView } from "../src/logic/loanMachine.js";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const EXPECTED = Object.fromEntries(TARGETS.map((t, i) => [t, A(i + 1)])) as Record<Target, Address>;
const reads = (over: Partial<Record<Target, Address | null>> = {}) =>
  ({ ...EXPECTED, ...over }) as Record<Target, Address | null>;

describe("upgrade watch", () => {
  it("a read error neither freezes nor brakes", () => {
    const r = stepWatch(initialWatchState(), reads({ voucher: null }), EXPECTED);
    expect(r.frozen).toBe(false);
    expect(r.brake).toBe("none");
  });

  it("freezes at the first difference and unfreezes by itself when no brake fired", () => {
    let r = stepWatch(initialWatchState(), reads({ podMining: A(99) }), EXPECTED);
    expect(r.frozen).toBe(true);
    expect(r.brake).toBe("none");
    expect(r.alerts.length).toBe(1);
    r = stepWatch(r.state, reads(), EXPECTED);
    expect(r.frozen).toBe(false);
  });

  it("brakes on the second consecutive difference and stays frozen afterwards", () => {
    let r = stepWatch(initialWatchState(), reads({ voucher: A(99) }), EXPECTED);
    r = stepWatch(r.state, reads({ voucher: A(99) }), EXPECTED);
    expect(r.brake).toBe("full");
    r = stepWatch(r.state, reads({ voucher: A(99) }), EXPECTED);
    expect(r.brake).toBe("none"); // already braked
    expect(r.state.brakeKind).toBe("full");
    r = stepWatch(r.state, reads(), EXPECTED);
    expect(r.frozen).toBe(true); // latched until a redeploy
  });

  it("a read error between two differences still confirms", () => {
    let r = stepWatch(initialWatchState(), reads({ rigVault: A(99) }), EXPECTED);
    r = stepWatch(r.state, reads({ rigVault: null }), EXPECTED);
    expect(r.frozen).toBe(true);
    r = stepWatch(r.state, reads({ rigVault: A(99) }), EXPECTED);
    expect(r.brake).toBe("full");
    expect(r.state.vaultChanged).toBe(true);
  });

  it("an upgrade made while the keeper was stopped is caught after a restart", () => {
    // a fresh state compares against the constants, never against a first-seen value
    let r = stepWatch(initialWatchState(), reads({ voucher: A(77) }), EXPECTED);
    expect(r.frozen).toBe(true);
    r = stepWatch(r.state, reads({ voucher: A(77) }), EXPECTED);
    expect(r.brake).toBe("full");
  });

  it("a BSC circuits evaluator change pauses borrows only (C-O4); the X Layer beacon only alerts", () => {
    for (const t of ["bscCircuitsImpl", "bscCircuitsBeacon"] as const) {
      let r = stepWatch(initialWatchState(), reads({ [t]: A(99) }), EXPECTED);
      expect(r.brake).toBe("none");
      r = stepWatch(r.state, reads({ [t]: A(99) }), EXPECTED);
      expect(r.frozen).toBe(true);
      expect(r.brake).toBe("pause");
      expect(r.alerts.some((a) => a.includes("the feed stays on"))).toBe(true);
      // a later PodMining upgrade still escalates to the full brake
      r = stepWatch(r.state, reads({ [t]: A(99), podMining: A(98) }), EXPECTED);
      expect(r.brake).toBe("none");
      r = stepWatch(r.state, reads({ [t]: A(99), podMining: A(98) }), EXPECTED);
      expect(r.brake).toBe("full");
      expect(r.state.brakeKind).toBe("full");
    }
    const x = stepWatch(initialWatchState(), reads({ xlayerCircuitsImpl: A(99) }), EXPECTED);
    expect(x.frozen).toBe(false);
    expect(x.alerts.length).toBe(1);
  });
});

describe("harvest planning", () => {
  it("rounds each rig down to DUST and skips batches below the bond", () => {
    const b = planBatches([
      { id: 2n, pending: 5_050n, cellBalance: 49n },
      { id: 1n, pending: 4_999n, cellBalance: 0n },
    ]);
    expect(b[0]!.ids).toEqual([1n, 2n]);
    expect(b[0]!.total).toBe(4_900n + 5_000n);
    expect(b[0]!.skip).toBe(true);
    const ok = planBatches([{ id: 1n, pending: BOND, cellBalance: 0n }]);
    expect(ok[0]!.skip).toBe(false);
  });

  it("splits into batches of 30", () => {
    const rigs = Array.from({ length: 61 }, (_, i) => ({ id: BigInt(i + 1), pending: 1_000_000n, cellBalance: 0n }));
    expect(planBatches(rigs).map((b) => b.ids.length)).toEqual([30, 30, 1]);
  });

});

describe("harvest schedule (part D §5.1)", () => {
  const now = 2_000_000;
  const loan = (agent: string, maturity: number, ids: bigint[], start = 1_000) => ({ agent, start, maturity, collateral: ids });

  it("harvests a loan once in the last hour before maturity, then every 72 h while it stays open", () => {
    const st = initialHarvestState();
    const l = loan("0xA", now + PRE_MATURITY + 1, [16n]);
    expect(planHarvest(now, [l], [], st, 168).ids).toEqual([]); // too early
    const at = l.maturity - PRE_MATURITY;
    const p = planHarvest(at, [l], [], st, 168);
    expect(p.ids).toEqual([16n]);
    expect(p.due).toEqual([{ key: loanKey("0xA", 1_000), kind: "maturity" }]);
    recordHarvest(st, p, at, new Set([loanKey("0xA", 1_000)]), new Set(["0xa"]), false);
    expect(planHarvest(at + 60, [l], [], st, 168).ids).toEqual([]); // done once
    expect(planHarvest(at + SHORTFALL_EVERY - 1, [l], [], st, 168).ids).toEqual([]);
    const s = planHarvest(at + SHORTFALL_EVERY, [l], [], st, 168);
    expect(s.due[0]!.kind).toBe("shortfall");
  });

  it("a keeper down across maturity harvests as soon as it is back", () => {
    const l = loan("0xA", now - 86_400, [5n]);
    expect(planHarvest(now, [l], [], initialHarvestState(), 168).due[0]!.kind).toBe("maturity");
  });

  it("alerts from the third shortfall harvest, and forgets loans that closed, not loans whose read failed (L6)", () => {
    const st = initialHarvestState();
    const key = loanKey("0xA", 1_000);
    const l = loan("0xA", 0, [5n]);
    let t = now;
    let alerts: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = planHarvest(t, [l], [], st, 168);
      alerts = recordHarvest(st, p, t, new Set([key]), new Set(["0xa"]), false);
      t += SHORTFALL_EVERY;
    }
    expect(st.loans[key]!.shortfalls).toBe(3);
    expect(alerts).toEqual([key]);
    recordHarvest(st, planHarvest(t, [], [], st, 168), t, new Set(), new Set(), false); // agent not read this cycle
    expect(st.loans[key]!.shortfalls).toBe(3);
    recordHarvest(st, planHarvest(t, [], [], st, 168), t, new Set(), new Set(["0xa"]), false); // read: closed
    expect(st.loans[key]).toBeUndefined();
  });

  it("seized vouchers go weekly on their own and ride along with any due loan", () => {
    const st = initialHarvestState();
    st.seizedLastAt = now - 3_600;
    expect(planHarvest(now, [], [9n], st, 168).ids).toEqual([]); // not a week yet
    const l = loan("0xA", now, [16n]);
    const p = planHarvest(now, [l], [9n], st, 168);
    expect(p.ids).toEqual([9n, 16n]);
    expect(p.seized).toBe(true);
    st.seizedLastAt = now - 168 * 3_600;
    expect(planHarvest(now, [], [9n], st, 168).ids).toEqual([9n]);
  });

  it("the seized-voucher clock moves only when a batch holding them went out (L8)", () => {
    const st = initialHarvestState();
    st.seizedLastAt = now - 3_600;
    const p = planHarvest(now, [loan("0xA", now, [16n])], [9n], st, 168);
    recordHarvest(st, p, now, new Set([loanKey("0xA", 1_000)]), new Set(["0xa"]), false); // skipped below the bond
    expect(st.seizedLastAt).toBe(now - 3_600);
    recordHarvest(st, p, now, new Set([loanKey("0xA", 1_000)]), new Set(["0xa"]), true);
    expect(st.seizedLastAt).toBe(now);
  });
});

describe("covered harvest (part E §3.1)", () => {
  const rig = (pending: bigint, cellBalance = 0n, ok = true, vaultKnows = true) => ({ ok, vaultKnows, pending, cellBalance });

  it("needs bridged output plus agent BEM to clear the debt by 1%, rounding each rig down to dust and less the fee", () => {
    expect(COVER_MARGIN_BPS).toBe(100n);
    // 10,099 + 1 raw -> 10,000 after dust; less 0.5%: 9,950 vs 9,000 debt x 1.01 = 9,090
    expect(coveredLoan([rig(10_099n, 1n)], 0n, 9_000n, 50n, 100n)).toBe(true);
    // 9,950 bridged + 0 vs 9,900 x 1.01 = 9,999: short
    expect(coveredLoan([rig(10_000n)], 0n, 9_900n, 50n, 100n)).toBe(false);
    // the agent's BEM counts
    expect(coveredLoan([rig(10_000n)], 100n, 9_900n, 50n, 100n)).toBe(true);
    // two rigs add up
    expect(coveredLoan([rig(5_000n), rig(5_000n)], 0n, 9_000n, 50n, 100n)).toBe(true);
  });

  it("is never due when the agent can close the loan itself, and waits on a failed read", () => {
    expect(coveredLoan([rig(1_000_000n)], 9_000n, 9_000n, 50n, 100n)).toBe(false); // the sweep closes it
    expect(coveredLoan([rig(1_000_000n)], 0n, 0n, 50n, 100n)).toBe(false);
    expect(coveredLoan([rig(1_000_000n, 0n, false)], 0n, 9_000n, 50n, 100n)).toBe(null);
  });

  it("counts a rescued rig as zero and treats a nonsense fee as the 5% maximum", () => {
    expect(coveredLoan([rig(1_000_000n, 0n, true, false), rig(5_000n)], 0n, 9_000n, 50n, 100n)).toBe(false);
    // 10,000 less 5% = 9,500 vs 9,400 x 1.01 = 9,494
    expect(coveredLoan([rig(10_000n)], 0n, 9_400n, 100_000n, 100n)).toBe(true);
    expect(coveredLoan([rig(10_000n)], 0n, 9_450n, 100_000n, 100n)).toBe(false);
  });

  it("is planned once per loan, before maturity only, and never touches the maturity schedule", () => {
    const now = 2_000_000;
    const st = initialHarvestState();
    const l = { agent: "0xA", start: 1_000, maturity: now + 5 * 86_400, collateral: [16n] };
    const key = loanKey("0xA", 1_000);
    expect(planHarvest(now, [l], [], st, 168).ids).toEqual([]);
    const p = planHarvest(now, [l], [9n], st, 168, new Set([key]));
    expect(p.due).toEqual([{ key, kind: "covered" }]);
    expect(p.ids).toEqual([9n, 16n]); // seized vouchers ride along
    recordHarvest(st, p, now, new Set([key]), new Set(["0xa"]), true);
    expect(st.loans[key]).toEqual({ maturityDone: false, lastAt: 0, shortfalls: 0, coveredAt: now });
    expect(planHarvest(now + 60, [l], [], st, 168, new Set([key])).ids).toEqual([]); // once
    const m = planHarvest(l.maturity - PRE_MATURITY, [l], [], st, 168, new Set([key]));
    expect(m.due).toEqual([{ key, kind: "maturity" }]);
  });
});

describe("evidence harvests (part D §5.2)", () => {
  const now = 2_000_000;

  it("bundles other rigs until the batch clears the bond, largest first, else asks for the keeper's bond", () => {
    const rig = (id: bigint, pending: bigint) => ({ id, pending, cellBalance: 0n });
    expect(bundleEvidence([rig(16n, 20_000n)], [rig(1n, 5_000n)], BOND, 100n, 30)).toEqual({ ids: [16n], needsBond: false });
    expect(bundleEvidence([rig(16n, 0n)], [rig(1n, 3_000n), rig(2n, 8_000n), rig(3n, 50n)], BOND, 100n, 30)).toEqual({
      ids: [16n, 2n, 1n],
      needsBond: false,
    });
    expect(bundleEvidence([rig(16n, 0n)], [rig(3n, 150n)], BOND, 100n, 30)).toEqual({ ids: [16n, 3n], needsBond: true });
    expect(bundleEvidence([rig(16n, 0n)], [rig(1n, 9_999n)], BOND, 100n, 1)).toEqual({ ids: [16n], needsBond: true });
    // two suspects due in one cycle share one batch (L11); a target listed among the others is not repeated
    expect(bundleEvidence([rig(16n, 0n), rig(5n, 0n)], [rig(16n, 0n), rig(1n, 20_000n)], BOND, 100n, 30)).toEqual({
      ids: [16n, 5n, 1n],
      needsBond: false,
    });
  });

  it("a harvest syncs power 0 only for a miner that is not active or has no weight at all", () => {
    expect(syncsZeroPower({ status: 3, verifWeight: 500n })).toBe(true); // stopped and cooling
    expect(syncsZeroPower({ status: 2, verifWeight: 500n })).toBe(true); // revoked
    expect(syncsZeroPower({ status: 1, verifWeight: 0n })).toBe(true);
    expect(syncsZeroPower({ status: 1, verifWeight: 1n })).toBe(false); // bonus only: still non-zero
  });

  it("only while the feed is disabled, for a confirmed suspect whose harvest syncs power 0", () => {
    expect(evidenceDue(now, false, "none", 0, "revoked", true, undefined)).toBe(null);
    expect(evidenceDue(now, true, "none", 0, "revoked", true, undefined)).toBe("first");
    expect(evidenceDue(now, true, "none", 0, "noBase", true, undefined)).toBe("first"); // verifWeight 0
    expect(evidenceDue(now, true, "none", 0, "noBase", false, undefined)).toBe(null); // would sync the bonus
    expect(evidenceDue(now, true, "none", 0, "stopped", false, undefined)).toBe(null);
    for (const c of ["rescue", "healthy", null] as const) {
      expect(evidenceDue(now, true, "none", 0, c, true, undefined)).toBe(null);
    }
  });

  const rec = (over: Partial<EvidenceRec> = {}): EvidenceRec => ({ count: 0, afterSeize: false, sends: 0, flagAt: 0, ...over });

  it("once before the flag, once 5 minutes after seizeStart, never more than two", () => {
    expect(evidenceDue(now, true, "none", 0, "revoked", true, rec({ count: 1, sends: 1 }))).toBe(null);
    expect(evidenceDue(now, true, "live", now + 10, "revoked", true, rec({ count: 1, sends: 1 }))).toBe(null);
    const seizeStart = now - EVIDENCE_AFTER_SEIZE + 1;
    expect(evidenceDue(now, true, "window", seizeStart, "revoked", true, rec({ count: 1, sends: 1 }))).toBe(null);
    expect(evidenceDue(now, true, "window", now - EVIDENCE_AFTER_SEIZE, "revoked", true, rec({ count: 1, sends: 1 }))).toBe("afterSeize");
    expect(evidenceDue(now, true, "window", 0, "revoked", true, rec({ count: 2, afterSeize: true, sends: 2 }))).toBe(null);
    // a first harvest that never went out does not use the budget
    expect(evidenceDue(now, true, "window", 0, "revoked", true, undefined)).toBe("afterSeize");
  });

  const any = { first: 0, afterSeize: 0 };

  it("counts a sent harvest only once its power-0 sync is seen on the voucher, alerting once if unseen (M2, N5)", () => {
    const r = recordEvidenceSent(undefined, "first", now, 0);
    expect(r).toEqual({ count: 0, afterSeize: false, sends: 1, flagAt: 0, pending: { kind: "first", sentAt: now } });
    expect(evidenceLanded(r, now + 30, { syncedAt: now - 3_600, power: 7n }, 60, any)).toBe(null); // an older sync
    expect(evidenceLanded(r, now + EVIDENCE_UNLANDED, { syncedAt: now - 3_600, power: 7n }, 60, any)).toBe("unlanded");
    expect(evidenceLanded(r, now + 2 * EVIDENCE_UNLANDED, { syncedAt: now - 3_600, power: 7n }, 60, any)).toBe(null); // once per send
    expect(r.count).toBe(0);
    expect(evidenceLanded(r, now + EVIDENCE_UNLANDED, { syncedAt: now - 20, power: 0n }, 60, any)).toBe("landed"); // BSC clock 20 s behind
    expect(r).toMatchObject({ count: 1, pending: undefined });
    const s = recordEvidenceSent(rec({ count: 1, sends: 1 }), "afterSeize", now, 5);
    expect(evidenceLanded(s, now + 40, { syncedAt: now + 5, power: 0n }, 60, any)).toBe("landed");
    expect(s).toMatchObject({ count: 2, afterSeize: true, sends: 2 });
  });

  it("counts only a sync the agent would accept: after the loan start for a flag, after seizeStart for a seize (N4)", () => {
    const r = recordEvidenceSent(undefined, "first", now, 0);
    expect(evidenceLanded(r, now + 30, { syncedAt: now - 30, power: 0n }, 60, { first: now - 10, afterSeize: 0 })).toBe(null);
    expect(evidenceLanded(r, now + 30, { syncedAt: now - 10, power: 0n }, 60, { first: now - 10, afterSeize: 0 })).toBe("landed");
    const s = recordEvidenceSent(rec({ count: 1, sends: 1 }), "afterSeize", now, 5);
    expect(evidenceLanded(s, now + 30, { syncedAt: now - 30, power: 0n }, 60, { first: 0, afterSeize: now - 5 })).toBe(null);
  });

  it("a sync with a non-zero power is not evidence; one more send only after an hour while the rig still reads 0 (M2, N3)", () => {
    const r = recordEvidenceSent(undefined, "first", now, 0);
    expect(evidenceLanded(r, now + 40, { syncedAt: now + 5, power: 3n }, 60, any)).toBe("notEvidence");
    expect(r.notEvidenceAt).toBe(now + 40);
    expect(evidenceDue(now + 40 + EVIDENCE_RETRY - 1, true, "none", 0, "revoked", true, r)).toBe(null);
    expect(evidenceDue(now + 40 + EVIDENCE_RETRY, true, "none", 0, "revoked", false, r)).toBe(null); // reads non-zero
    expect(evidenceDue(now + 40 + EVIDENCE_RETRY, true, "none", 0, "revoked", true, r)).toBe("first");
  });

  it("waits for a sent harvest, retries an unseen one after an hour, and stops at four sends (M2)", () => {
    const r = recordEvidenceSent(undefined, "first", now, 0);
    expect(evidenceDue(now + EVIDENCE_RETRY - 1, true, "none", 0, "revoked", true, r)).toBe(null);
    expect(evidenceDue(now + EVIDENCE_RETRY, true, "none", 0, "revoked", true, r)).toBe("first");
    const spent = rec({ sends: EVIDENCE_MAX_SENDS, pending: { kind: "first", sentAt: now } });
    expect(evidenceDue(now + EVIDENCE_RETRY, true, "none", 0, "revoked", true, spent)).toBe("capped");
    // a reverted or unsent harvest never reaches the voucher: the same rules cover it
  });

  it("a cleared or replaced flag starts a new incident; closed loans drop their records (L7)", () => {
    const r = rec({ count: 1, sends: 1 });
    expect(currentIncident(r, 0)).toBe(r);
    expect(currentIncident(r, 500)!.flagAt).toBe(500); // the flag this evidence raised
    expect(currentIncident(r, 500)).toBe(r);
    expect(currentIncident(r, 0)).toBe(undefined); // cleared
    expect(currentIncident(rec({ flagAt: 500 }), 900)).toBe(undefined); // a new flag
    const ev: Record<string, EvidenceRec> = { "0xa:1:16": rec(), "0xb:2:5": rec(), "0xc:3:7": rec() };
    pruneEvidence(ev, new Set(["0xa:1"]), new Set(["0xa", "0xb"])); // 0xb closed; 0xc not read this cycle
    expect(Object.keys(ev)).toEqual(["0xa:1:16", "0xc:3:7"]);
  });
});

describe("two-cycle confirmation", () => {
  it("confirms only the same condition at a later block", () => {
    const s = initialConfirmState();
    expect(observe(s, 5n, { condition: "rescue", block: 10n })).toBe(null);
    expect(observe(s, 5n, { condition: "rescue", block: 10n })).toBe(null); // same block
    expect(observe(s, 5n, { condition: "rescue", block: 11n })).toBe("rescue");
    expect(observe(s, 5n, null)).toBe(null); // read error keeps the last observation
    expect(observe(s, 5n, { condition: "healthy", block: 12n })).toBe(null);
    expect(observe(s, 5n, { condition: "healthy", block: 13n })).toBe("healthy");
  });

  it("classifies the BSC reads", () => {
    const base = { vaultKnows: true, custodied: true, status: 1, stopBlock: 0n, verifWeight: 10n, bonus: 2n };
    expect(classify(base)).toBe("healthy");
    expect(classify({ ...base, vaultKnows: false })).toBe("rescue");
    expect(classify({ ...base, custodied: false })).toBe("rescue");
    expect(classify({ ...base, status: 2 })).toBe("revoked");
    expect(classify({ ...base, stopBlock: 5n })).toBe("stopped");
    expect(classify({ ...base, bonus: 10n })).toBe("noBase");
  });
});

describe("push limits", () => {
  const now = 1_793_368_800;
  const req = (over: Partial<PushRequest> = {}): PushRequest => ({
    now,
    mode: "live",
    frozen: false,
    isAgent: true,
    borrower: "0xB0",
    ids: [16n],
    eligible: () => true,
    storedObservedAt: () => 0,
    balance: 10n ** 18n,
    fee: 340_000_000_000_000n,
    reserve: 5n * 10n ** 15n,
    dailyMax: 20,
    ...over,
  });

  it("refuses in dry mode, while frozen, for non-agents, bad sets and unscreened rigs", () => {
    const l = new PushLimiter();
    expect(l.decide(req({ mode: "dry" })).reason).toBe("dry mode");
    expect(l.decide(req({ frozen: true })).reason).toBe("upgrade pending");
    expect(l.decide(req({ isAgent: false })).status).toBe("refused");
    expect(l.decide(req({ ids: [] })).status).toBe("refused");
    expect(l.decide(req({ ids: Array.from({ length: 17 }, (_, i) => BigInt(i)) })).status).toBe("refused");
    expect(l.decide(req({ eligible: () => false })).reason).toBe("not eligible");
  });

  it("reuses a fresh report and charges nothing", () => {
    const l = new PushLimiter();
    expect(l.decide(req({ storedObservedAt: () => now - 240 })).status).toBe("fresh");
    expect(l.decide(req({ storedObservedAt: () => now - 241 })).status).toBe("queued");
  });

  it("admits at most 10 requests per IP per hour and 30 per minute in total, refused ones included", () => {
    const l = new PushLimiter();
    for (let i = 0; i < 10; i++) expect(l.admit("9.9.9.9", now)).toBe(null);
    expect(l.admit("9.9.9.9", now)?.reason).toBe("too many requests from this address");
    expect(l.admit("9.9.9.9", now + 3_600)).toBe(null); // next hour
    const g = new PushLimiter();
    for (let i = 0; i < 30; i++) expect(g.admit(`ip${i}`, now)).toBe(null);
    expect(g.admit("another", now)?.reason).toBe("busy, try again in a minute");
    expect(g.admit("another", now + 60)).toBe(null);
  });

  it("persists its counters in the record it was given", () => {
    const counts: Record<string, number> = {};
    new PushLimiter(counts).decide(req());
    const again = new PushLimiter(counts);
    for (let i = 0; i < 11; i++) again.decide(req({ borrower: `0x${i}` }));
    expect(again.decide(req({ borrower: "0xz" })).reason).toBe("rig daily limit, push it yourself");
  });

  it("limits per rig, per borrower and in total (part D D-O4: 3, 3, 10)", () => {

    const r = new PushLimiter();
    for (let i = 0; i < 3; i++) expect(r.decide(req({ borrower: `0x${i}` })).status).toBe("queued");
    expect(r.decide(req({ borrower: "0xfresh" })).reason).toBe("rig daily limit, push it yourself");

    const b = new PushLimiter();
    for (let i = 0; i < 3; i++) b.decide(req({ ids: [BigInt(100 + i)], dailyMax: 100 }));
    expect(b.decide(req({ ids: [999n], dailyMax: 100 })).reason).toBe("borrower daily limit, push it yourself");

    const g = new PushLimiter();
    for (let i = 0; i < 3; i++) g.decide(req({ borrower: `0x${i}`, ids: [BigInt(i)], dailyMax: 3 }));
    expect(g.decide(req({ borrower: "0xz", ids: [77n], dailyMax: 3 })).reason).toBe(
      "daily push budget used, push it yourself",
    );
  });

  it("never pushes into the harvest reserve", () => {
    const l = new PushLimiter();
    const fee = 340_000_000_000_000n;
    const reserve = 5n * 10n ** 15n;
    expect(l.decide(req({ balance: fee + reserve - 1n })).reason).toBe("keeper reserve");
    expect(l.decide(req({ balance: fee + reserve })).status).toBe("queued");
  });

  it("prunes old counters", () => {
    const counts: Record<string, number> = {};
    const l = new PushLimiter(counts);
    for (let i = 0; i < 10; i++) l.admit("1.1.1.1", now);
    l.decide(req());
    l.prune(now + 86_400);
    expect(Object.keys(counts).sort()).toEqual([`r:16:${Math.floor(now / 86_400)}`, `s:16:${now}`]);
    l.prune(now + 9 * 86_400);
    expect(Object.keys(counts)).toEqual([]);
  });
});

describe("per-loan machine", () => {
  const now = 1_000_000;
  // Redeploy 3 (RB3-02): the machine reads evidence from the stored report through the R3-00 mirror, so the
  // helper stores a report at `storedObservedAt` whose state matches the confirmed BSC condition.
  const rig = (over: Partial<RigView> = {}): RigView => {
    const v: RigView = { id: 16n, confirmed: "healthy", storedObservedAt: 0, lastPushAt: 0, passSuspended: false, ...over };
    if (!("report" in over)) {
      const bad = v.confirmed !== null && v.confirmed !== "healthy";
      v.report = v.storedObservedAt === 0 ? null : {
        rigId: v.id, observedAt: BigInt(v.storedObservedAt), status: bad ? 3 : 1, stopBlock: 0n, custodied: v.confirmed !== "rescue",
        verifWeight: bad ? 0n : 500n, bonus: 0n, totalVerifWeight: 1_000n,
      };
    }
    return v;
  };
  const input = (over: Partial<MachineInput> = {}): MachineInput => ({
    now,
    loan: { open: true, impairedAt: 0, seizeStart: 0, deadline: 0, expired: false, impairedRig: 0n },
    rigs: [rig()],
    feedDisabled: false,
    suspendOnRevoke: true,
    ...over,
  });

  it("does nothing for a healthy loan or a closed agent", () => {
    expect(nextActions(input())).toEqual([]);
    expect(nextActions(input({ loan: { ...input().loan, open: false }, rigs: [rig({ confirmed: "rescue" })] }))).toEqual([]);
  });

  it("on a rescue: suspend, push, then flag while the report is timely", () => {
    expect(nextActions(input({ rigs: [rig({ confirmed: "rescue" })] }))).toEqual([
      { kind: "suspend", rig: 16n },
      { kind: "push", rigs: [16n] },
    ]);
    const landed = rig({ confirmed: "rescue", passSuspended: true, lastPushAt: now - 40, storedObservedAt: now - 35 });
    expect(nextActions(input({ rigs: [landed] }))).toEqual([{ kind: "flag", rig: 16n }]);
  });

  it("pushes again after a stale report, respecting the cooldown", () => {
    const stale = rig({ confirmed: "stopped", lastPushAt: now - 400, storedObservedAt: now - 395 });
    expect(nextActions(input({ rigs: [stale] }))).toEqual([]); // stale, cooldown not over
    const later = rig({ confirmed: "stopped", lastPushAt: now - 700, storedObservedAt: now - 695 });
    expect(nextActions(input({ rigs: [later] }))).toEqual([{ kind: "push", rigs: [16n] }]);
  });

  it("suspends on a revocation only with K-O5", () => {
    expect(nextActions(input({ rigs: [rig({ confirmed: "revoked" })] }))[0]).toEqual({ kind: "suspend", rig: 16n });
    expect(nextActions(input({ suspendOnRevoke: false, rigs: [rig({ confirmed: "revoked" })] }))[0]).toEqual({
      kind: "push",
      rigs: [16n],
    });
  });

  it("with the feed disabled: alert on a rescue, path (b) flag otherwise", () => {
    expect(nextActions(input({ feedDisabled: true, rigs: [rig({ confirmed: "rescue", passSuspended: true })] }))).toEqual([
      { kind: "alert", text: "rescue of rig 16 seen, flag impossible until enableFeed" },
    ]);
    expect(nextActions(input({ feedDisabled: true, rigs: [rig({ confirmed: "stopped" })] }))).toEqual([]);
    expect(nextActions(input({ feedDisabled: true, rigs: [rig({ confirmed: "stopped", voucherPower: 0n, voucherSyncedAt: now })] }))).toEqual([
      { kind: "flag", rig: 16n },
    ]);
  });

  it("waits during the cure window, then pushes and seizes", () => {
    const loan = { open: true, impairedAt: now - 1_000, seizeStart: now + 10, deadline: now + 86_400, expired: false, impairedRig: 16n };
    expect(nextActions(input({ loan, rigs: [rig({ confirmed: "rescue" })] }))).toEqual([]);
    const window = { ...loan, seizeStart: now - 100 };
    // the report behind the flag landed before seizeStart: a new one is needed
    expect(
      nextActions(input({ loan: window, rigs: [rig({ confirmed: "rescue", lastPushAt: now - 1_000, storedObservedAt: now - 995 })] })),
    ).toEqual([{ kind: "push", rigs: [16n] }]);
    expect(
      nextActions(input({ loan: window, rigs: [rig({ confirmed: "rescue", lastPushAt: now - 50, storedObservedAt: now - 40 })] })),
    ).toEqual([{ kind: "seize" }]);
    expect(nextActions(input({ loan: window, rigs: [rig({ confirmed: "healthy" })] }))).toEqual([]);
  });

  it("retries an unlanded push only hourly and reports it (a dead feed)", () => {
    const unlanded = rig({ confirmed: "rescue", passSuspended: true, lastPushAt: now - 700, storedObservedAt: 0 });
    expect(pushUnlanded(unlanded, now)).toBe(true);
    expect(nextActions(input({ rigs: [unlanded] }))).toEqual([]); // 700 s < 1 h
    const hourLater = rig({ confirmed: "rescue", passSuspended: true, lastPushAt: now - 3_600, storedObservedAt: 0 });
    expect(nextActions(input({ rigs: [hourLater] }))).toEqual([{ kind: "push", rigs: [16n] }]);
    expect(pushUnlanded(rig({ lastPushAt: now - 700, storedObservedAt: now - 690 }), now)).toBe(false);
    // a keeper clock a little ahead of BSC block time still sees its report as landed
    expect(pushUnlanded(rig({ lastPushAt: now - 700, storedObservedAt: now - 730 }), now)).toBe(false);
    expect(pushUnlanded(rig({ lastPushAt: now - 700, storedObservedAt: now - 761 }), now)).toBe(true);
    // a report stamped up to 60 s before the keeper's push time also counts for the flag (R2)
    const skewed = rig({ confirmed: "rescue", passSuspended: true, lastPushAt: now - 100, storedObservedAt: now - 130 });
    expect(nextActions(input({ rigs: [skewed] }))).toEqual([{ kind: "flag", rig: 16n }]);
  });

  it("after expiry: clear on fresh health of the flagged rig, or flag again", () => {
    const loan = { open: true, impairedAt: 1, seizeStart: now - 10_000, deadline: now - 5_000, expired: true, impairedRig: 16n };
    expect(nextActions(input({ loan, rigs: [rig({ lastPushAt: now - 1_000, storedObservedAt: now - 995 })] }))).toEqual([
      { kind: "push", rigs: [16n] },
    ]);
    expect(nextActions(input({ loan, rigs: [rig({ lastPushAt: now - 50, storedObservedAt: now - 40 })] }))).toEqual([
      { kind: "clear" },
    ]);
    expect(
      nextActions(input({ loan, rigs: [rig({ confirmed: "noBase", lastPushAt: now - 50, storedObservedAt: now - 40 })] })),
    ).toEqual([{ kind: "flag", rig: 16n }]);
    expect(nextActions(input({ loan, rigs: [rig({ confirmed: null })] }))).toEqual([]); // not confirmed yet
  });
});

describe("miner key", () => {
  it("matches PodMining's key for a known miner", async () => {
    const { minerKey } = await import("../src/reads.js");
    // first Started event in research/data/pod-events.json: Behemoth circuit 156
    expect(minerKey("0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C", 156n)).toBe(
      "0x3a4902e74165ffdde949ee18c40e9fb0f699c705d5ca7ac687766c5f5b1d2939",
    );
  });
});
