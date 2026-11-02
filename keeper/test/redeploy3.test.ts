// Redeploy 3, Part B (docs/SPEC-REDEPLOY-3.md §5): the keeper's R3-00 mirror against the contract's own
// evidence vectors, and the RB3-03, RB3-04 and RB3-06 rules.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getAddress, type Address } from "viem";
import type { Alerts } from "../src/alerts.js";
import type { Deployment } from "../src/addresses.js";
import type { Clients } from "../src/chains.js";
import { loadConfig, loadDeployment } from "../src/config.js";
import { Keeper } from "../src/keeper.js";
import { ENABLE_PUSH_MARGIN, FEED_SETTLE, MAX_CLOCK_SKEW, MAX_REPORT_AGE, clearPlan, clearReading, evidenceKind, pushOpen, verdictCode, type FeedView, type Report, type VoucherRecord } from "../src/logic/evidence.js";
import { nextActions, type MachineInput, type RigView } from "../src/logic/loanMachine.js";
import { PushLimiter } from "../src/logic/pushLimits.js";
import { FEED_SETTLING, PushService } from "../src/push.js";
import { checkStack, minerKey, type LoanSnapshot } from "../src/reads.js";
import { emptyState, type KeeperState } from "../src/state.js";
import type { Call, Sender, SendResult } from "../src/tx.js";

interface Vector {
  row: string;
  case: string;
  id: string;
  now: string;
  feedDisabled: boolean;
  feedEnabledAt: string;
  floor: string;
  report: { ok: boolean; reverts: boolean; rigId: string; observedAt: string; status: number; stopBlock: string; custodied: boolean; verifWeight: string; bonus: string; totalVerifWeight: string };
  record: { readable: boolean; syncedAt: string; power: string };
  kind: number;
  verdict: number;
}

const VECTORS = JSON.parse(readFileSync(new URL("./fixtures/evidence-vectors.json", import.meta.url), "utf8")) as Vector[];

/** The mirror's inputs for one vector: a reverting feed is `undefined`, an empty slot `null` (both are ok == false). */
function inputs(v: Vector) {
  const r = v.report;
  const report: Report | null | undefined = r.reverts ? undefined : !r.ok ? null : {
    rigId: BigInt(r.rigId), observedAt: BigInt(r.observedAt), status: r.status, stopBlock: BigInt(r.stopBlock), custodied: r.custodied,
    verifWeight: BigInt(r.verifWeight), bonus: BigInt(r.bonus), totalVerifWeight: BigInt(r.totalVerifWeight),
  };
  const record: VoucherRecord | undefined = v.record.readable ? { syncedAt: Number(v.record.syncedAt), power: BigInt(v.record.power) } : undefined;
  const feed: FeedView = { disabled: v.feedDisabled, enabledAt: Number(v.feedEnabledAt) };
  return { id: BigInt(v.id), now: BigInt(v.now), floor: BigInt(v.floor), feed, report, record };
}

describe("RB3-01 R3-00 mirror against the ParityVectors evidence vectors", () => {
  it("has every vector of the build: 73 cases over rows E, VE, S, H, B, VC and U", () => {
    expect(VECTORS).toHaveLength(73);
    expect([...new Set(VECTORS.map((v) => v.row))].sort()).toEqual(["B", "E", "H", "S", "U", "VC", "VE"]);
    const has = (row: string, name: string) => VECTORS.some((v) => v.row === row && v.case === name);
    for (const row of ["E", "H", "S"]) {
      expect(has(row, "observedAt = enableFloor - 1"), row).toBe(true);
      expect(has(row, "observedAt = enableFloor"), row).toBe(true);
    }
    expect(has("B", "impaired report one hour old")).toBe(true);
    expect(has("U", "power-0 record older than the report")).toBe(true);
  });

  it.each(VECTORS.map((v) => [`${v.row}: ${v.case}`, v] as const))("%s", (_name, v) => {
    const x = inputs(v);
    expect(evidenceKind(x.id, x.floor, x.now, x.feed, x.report, x.record), "kind").toBe(v.kind);
    expect(verdictCode(clearReading(x.id, x.floor, x.now, x.feed, x.report, x.record).verdict), "verdict").toBe(v.verdict);
  });

  it("pins the boundaries the spec names: the enable floor, row B past 300 s, and v5 row U", () => {
    const pick = (row: string, name: string) => VECTORS.find((v) => v.row === row && v.case === name)!;
    expect(pick("E", "observedAt = enableFloor - 1").kind).toBe(0);
    expect(pick("E", "observedAt = enableFloor").kind).toBe(1);
    expect(pick("H", "observedAt = enableFloor - 1").verdict).toBe(0);
    expect(pick("H", "observedAt = enableFloor").verdict).toBe(1);
    expect(pick("S", "observedAt = enableFloor - 1").kind).toBe(2);
    expect(pick("S", "observedAt = enableFloor").kind).toBe(0);
    const stale = pick("B", "impaired report one hour old");
    expect(BigInt(stale.now) - BigInt(stale.report.observedAt)).toBeGreaterThan(300n);
    expect(stale.verdict).toBe(2);
    expect(pick("U", "power-0 record older than the report").verdict).toBe(2);
    expect(pick("U", "healthy report at enableFloor - 1 over an older positive record").verdict).toBe(0);
  });
});

// ───────────────────────── a keeper over a mocked world (X Layer and BSC reads, recorded sends)

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const AGENT = A(101), CELL = A(102), THIRD = A(104);
const D: Deployment = { pool: A(1), factory: A(2), screen: A(3), receiver: A(4), reporter: A(5), factoryDeployBlock: 1n };
const NOW = 1_800_000_000;
const cfg = () => loadConfig({ KEEPER_MODE: "live", KEEPER_PRIVATE_KEY: `0x${"11".repeat(32)}`, BSC_RPC: "http://x", TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "1" });
const healthy = (id: bigint, at: number, over: Partial<Report> = {}): Report => ({ rigId: id, observedAt: BigInt(at), status: 1, stopBlock: 0n, custodied: true, verifWeight: 500n, bonus: 0n, totalVerifWeight: 1000n, ...over });
const impairedAt = (id: bigint, at: number) => healthy(id, at, { status: 3, verifWeight: 0n });

interface World {
  now: number;
  /** Latest X Layer block time; null when that read fails. */
  xNow: number | null;
  feedDisabled: boolean;
  feedEnabledAt: number | "revert";
  flagFrom: number;
  seizeFrom: number;
  /** Rigs whose BSC miner reads as stopped (status 3). */
  bad: Set<bigint>;
  /** Rigs whose BSC reads fail (the vault's `rigs(id)` reverts), so their condition is never confirmed. */
  bscDown: Set<bigint>;
  /** The receiver's report per rig; null is an empty slot, a missing key a failed read. */
  reports: Map<bigint, Report | null>;
  records: Map<bigint, VoucherRecord>;
  /** `voucher.ownerOf` on X Layer; "revert" (or no entry) fails the call. */
  owners: Map<bigint, Address | "revert">;
  /** The keeper's BNB on BSC. */
  balance: bigint;
}

function world(over: Partial<World> = {}): World {
  return { now: NOW, xNow: NOW, feedDisabled: false, feedEnabledAt: 0, flagFrom: NOW - 3_600, seizeFrom: NOW - 3_600, bad: new Set(), bscDown: new Set(), reports: new Map(), records: new Map(), owners: new Map(), balance: 10n ** 18n, ...over };
}

type Q = { functionName: string; args?: readonly unknown[] };

function clientsOf(w: World): Clients {
  const ok = (result: unknown) => ({ status: "success", result });
  const idOfKey = (key: unknown) => [16n, 17n, 18n, 19n].find((id) => minerKey(CELL, id) === key)!;
  return {
    account: { address: A(100) },
    bsc: { public: {
      getBlock: async () => ({ number: 1n, timestamp: BigInt(w.now) }),
      getBalance: async () => w.balance,
      readContract: async () => 1_000n, // reporter quote, harvest quote, the keeper's BEM float and allowance
      multicall: async ({ contracts }: { contracts: Q[] }) => contracts.map((q) => {
        if (q.functionName === "rigs" && w.bscDown.has(q.args?.[0] as bigint)) return { status: "failure", error: new Error("bsc down") };
        if (q.functionName === "getMiner") {
          const stopped = w.bad.has(idOfKey(q.args![0]));
          return ok({ status: stopped ? 3 : 1, stopBlock: 0n, since: 1n, taskId: 4, verifWeight: stopped ? 0n : 500n, bonus: 0n });
        }
        return ok(({ rigs: [CELL, q.args?.[0]], pending: 50_000n, cellOf: CELL, ownerOf: CELL, balanceOf: 0n } as Record<string, unknown>)[q.functionName]);
      }),
    } },
    xlayer: { public: {
      getBlock: async () => {
        if (w.xNow === null) throw new Error("x layer down");
        return { number: 1n, timestamp: BigInt(w.xNow) };
      },
      readContract: async (q: Q) => {
        switch (q.functionName) {
          case "feedDisabled": return w.feedDisabled;
          case "feedEnabledAt": if (w.feedEnabledAt === "revert") throw new Error("no such function"); return BigInt(w.feedEnabledAt);
          case "flagEvidenceFrom": return BigInt(w.flagFrom);
          case "seizeEvidenceFrom": return BigInt(w.seizeFrom);
          case "FEED_SETTLE": return 360n;
          case "isAgent": return true;
          case "borrowerOf": return A(103);
          case "collateralOf": return [16n];
          default: return 0n;
        }
      },
      multicall: async ({ contracts }: { contracts: Q[] }) => contracts.map((q) => {
        const id = q.args?.[0] as bigint;
        switch (q.functionName) {
          case "latest": {
            if (!w.reports.has(id)) return { status: "failure", error: new Error("rpc") };
            const r = w.reports.get(id)!;
            return ok([r ?? healthy(0n, 0), r !== null]);
          }
          case "rigs": {
            const r = w.records.get(id);
            return r ? ok([CELL, BigInt(r.syncedAt), id, r.power]) : { status: "failure", error: new Error("short answer") };
          }
          case "passOf": return ok([{}, true]);
          case "ownerOf": {
            const o = w.owners.get(id);
            return o === undefined || o === "revert" ? { status: "failure", error: new Error("reverted") } : ok(o);
          }
          default: return ok(0n);
        }
      }),
    } },
  } as unknown as Clients;
}

function recorder(results: SendResult[] = []) {
  const calls: Call[] = [];
  return { calls, send: async (call: Call) => { calls.push(call); return results.shift() ?? { status: "sent", hash: "0x01" }; }, poll: async () => {}, hasPending: () => false } as unknown as Sender & { calls: Call[] };
}

function keeperIn(w: World, state: KeeperState = emptyState(1n, D.factory)) {
  const alerts: string[] = [];
  const bsc = recorder(), xlayer = recorder();
  const k = new Keeper(cfg(), clientsOf(w), D, { send: async (_kind: string, text: string) => void alerts.push(text) } as unknown as Alerts, { bsc, xlayer }, state, () => w.now);
  const p = k as unknown as {
    impairment(d: Deployment, loans: LoanSnapshot[], block: bigint, now: number): Promise<void>;
    sweep(d: Deployment, loans: LoanSnapshot[], now: number): Promise<void>;
  };
  let block = 0n;
  /** One impairment cycle at a new BSC block (a condition is confirmed on the second). */
  const cycle = async (...loans: LoanSnapshot[]) => p.impairment(D, loans, ++block, w.now);
  /** One sweep job (sweep, claimLate and the forwardVouchers retry). */
  const sweep = async (...loans: LoanSnapshot[]) => p.sweep(D, loans, w.now);
  return { k, p, alerts, bsc, xlayer, cycle, sweep };
}

const loanOf = (over: Partial<LoanSnapshot["loan"]> = {}, collateral = [16n], extra: Partial<LoanSnapshot> = {}): LoanSnapshot => ({
  agent: AGENT, start: 1_000, maturity: NOW + 86_400,
  loan: { open: true, impairedAt: 0, seizeStart: 0, deadline: 0, expired: false, impairedRig: 0n, debt: 10n, ...over },
  collateral, closed: false, bem: 0n, ...extra,
});
const IMPAIRED_AT = NOW - 5 * 86_400;
const expiredLoan = (collateral = [16n, 17n]) => loanOf({ impairedAt: IMPAIRED_AT, seizeStart: NOW - 2 * 86_400, deadline: NOW - 3_600, expired: true, impairedRig: 16n }, collateral);
const labels = (s: { calls: Call[] }) => s.calls.map((c) => c.label);

describe("RB3-02 flag, seize and clear planning on the mirror", () => {
  /** The vector as the machine sees it: a rig whose state the keeper confirmed, with the vector's report and record. */
  function view(v: Vector, confirmed: RigView["confirmed"]): RigView {
    const x = inputs(v);
    return {
      id: x.id, confirmed, passSuspended: true, lastPushAt: 0,
      storedObservedAt: x.report ? Number(x.report.observedAt) : 0,
      report: x.report === undefined ? null : x.report, // a reverting feed reads as an empty slot (ok false)
      voucherSyncedAt: x.record?.syncedAt, voucherPower: x.record?.power,
    };
  }
  const common = (v: Vector): Omit<MachineInput, "loan" | "rigs"> => ({
    now: Number(v.now), feedDisabled: v.feedDisabled, feedEnabledAt: Number(v.feedEnabledAt), suspendOnRevoke: false, pushOpen: false,
    flagEvidenceFrom: Number(v.floor), seizeEvidenceFrom: Number(v.floor),
  });

  it.each(VECTORS.map((v) => [`${v.row}: ${v.case}`, v] as const))("plans exactly what the agent accepts: %s", (_name, v) => {
    const now = Number(v.now), id = BigInt(v.id);
    const flag = nextActions({ ...common(v), loan: { open: true, impairedAt: 0, seizeStart: 0, deadline: 0, expired: false, impairedRig: 0n }, rigs: [view(v, "stopped")] });
    expect(flag, "flagImpaired").toEqual(v.kind !== 0 ? [{ kind: "flag", rig: id }] : []);
    const seize = nextActions({ ...common(v), loan: { open: true, impairedAt: now - 80 * 3_600, seizeStart: now - 8 * 3_600, deadline: now + 3_600, expired: false, impairedRig: id }, rigs: [view(v, "stopped")] });
    expect(seize, "seize").toEqual(v.kind !== 0 ? [{ kind: "seize" }] : []);
    if (v.feedDisabled) return; // an expired flag with the feed off only alerts
    const clear = nextActions({ ...common(v), loan: { open: true, impairedAt: now - 100 * 3_600, seizeStart: now - 28 * 3_600, deadline: now - 3_600, expired: true, impairedRig: id }, rigs: [view(v, "healthy")] });
    expect(clear, "clearExpiredFlag").toEqual(v.verdict === 1 ? [{ kind: "clear" }] : []);
  });

  it("plans nothing on a failed report read while the feed is on, but path (b) still flags while it is off", () => {
    const rig: RigView = { id: 16n, confirmed: "stopped", passSuspended: true, lastPushAt: NOW, storedObservedAt: 0, report: undefined, voucherSyncedAt: NOW - 10, voucherPower: 0n };
    const m: MachineInput = { now: NOW, loan: { open: true, impairedAt: 0, seizeStart: 0, deadline: 0, expired: false, impairedRig: 0n }, rigs: [rig], feedDisabled: false, suspendOnRevoke: false, flagEvidenceFrom: NOW - 100 };
    expect(nextActions(m)).toEqual([]);
    expect(nextActions({ ...m, rigs: [{ ...rig, report: null }] })).toEqual([{ kind: "flag", rig: 16n }]);
    expect(nextActions({ ...m, feedDisabled: true })).toEqual([{ kind: "flag", rig: 16n }]);
  });

  it("seizes on row E of any confirmed suspect, not only the first one", () => {
    const quiet: RigView = { id: 16n, confirmed: "stopped", passSuspended: true, lastPushAt: NOW, storedObservedAt: NOW - 400, report: impairedAt(16n, NOW - 400) };
    const fresh: RigView = { id: 17n, confirmed: "stopped", passSuspended: true, lastPushAt: NOW, storedObservedAt: NOW - 10, report: impairedAt(17n, NOW - 10) };
    const loan = { open: true, impairedAt: NOW - 80 * 3_600, seizeStart: NOW - 3_600, deadline: NOW + 3_600, expired: false, impairedRig: 16n };
    expect(nextActions({ now: NOW, loan, rigs: [quiet, fresh], feedDisabled: false, suspendOnRevoke: false, seizeEvidenceFrom: NOW - 3_000 })).toEqual([{ kind: "seize" }]);
  });

  it("reads the pool's feed state with the cycle and plans nothing when feedEnabledAt cannot be read", async () => {
    const w = world({ feedEnabledAt: "revert", bad: new Set([16n]), reports: new Map([[16n, impairedAt(16n, NOW - 10)]]), records: new Map([[16n, { syncedAt: NOW - 7_200, power: 500n }]]) });
    const { cycle, xlayer, bsc } = keeperIn(w);
    await expect(cycle(loanOf())).rejects.toThrow();
    await expect(cycle(loanOf())).rejects.toThrow();
    expect([...xlayer.calls, ...bsc.calls]).toEqual([]);
    w.feedEnabledAt = 0;
    await cycle(loanOf());
    await cycle(loanOf());
    expect(labels(xlayer)).toEqual([`flagImpaired ${AGENT} rig 16`]);
  });

  it("never flags on a report observed below the enable floor, and flags at the floor", async () => {
    const enabledAt = NOW - 200; // enable floor NOW - 140
    const w = world({ feedEnabledAt: enabledAt, bad: new Set([16n]), reports: new Map([[16n, impairedAt(16n, NOW - 141)]]), records: new Map([[16n, { syncedAt: NOW - 7_200, power: 500n }]]) });
    const { cycle, xlayer } = keeperIn(w);
    await cycle(loanOf());
    await cycle(loanOf());
    expect(xlayer.calls).toEqual([]);
    w.reports.set(16n, impairedAt(16n, NOW - 140));
    await cycle(loanOf());
    expect(labels(xlayer)).toEqual([`flagImpaired ${AGENT} rig 16`]);
  });
});

describe("RB3-03 pushes after a re-enable", () => {
  const E = NOW - 60; // feedEnabledAt: the enable floor is E + 60, and pushes may go from E + 90
  const AGENT2 = A(105);
  const liveFlag = (collateral = [16n, 18n]) => loanOf({ impairedAt: E - 3_600, seizeStart: E + 68 * 3_600, deadline: E + 100 * 3_600, expired: false, impairedRig: 16n }, collateral);
  const unflagged = () => loanOf({}, [17n], { agent: AGENT2 });
  const at = (w: World, t: number) => { w.now = t; w.xNow = t; };

  it("opens the timing rule at feedEnabledAt + MAX_CLOCK_SKEW + 30 s of X Layer time, and fails closed without it", () => {
    expect(pushOpen({ disabled: false, enabledAt: E }, E + 89)).toBe(false);
    expect(pushOpen({ disabled: false, enabledAt: E }, E + 90)).toBe(true);
    expect(pushOpen({ disabled: false, enabledAt: E }, null)).toBe(false);
    expect(pushOpen({ disabled: false, enabledAt: 0 }, null)).toBe(true); // never re-enabled: no enable floor to wait for
    expect(ENABLE_PUSH_MARGIN).toBe(30);
    expect(FEED_SETTLE).toBe(MAX_CLOCK_SKEW + MAX_REPORT_AGE);
  });

  it("pushes every rig of a flagged loan without a report at or after the enable floor, only from E + 90", async () => {
    const w = world({ feedEnabledAt: E, reports: new Map([[16n, healthy(16n, E - 3_000)], [17n, healthy(17n, E - 3_000)], [18n, healthy(18n, E + 60)]]) });
    const { k, cycle, bsc, xlayer } = keeperIn(w);
    at(w, E + 30);
    await cycle(liveFlag(), unflagged());
    // rig 17's loan has no flag, and rig 18 already holds a report observed at the enable floor
    expect(k.state.feedRound).toEqual({ enabledAt: E, rigs: ["16"] });
    at(w, E + 89);
    await cycle(liveFlag(), unflagged());
    expect(bsc.calls).toEqual([]);
    w.now = E + 200; // the keeper's own clock does not open the rule: X Layer time does
    await cycle(liveFlag(), unflagged());
    expect(bsc.calls).toEqual([]);
    at(w, E + 90);
    await cycle(liveFlag(), unflagged());
    expect(labels(bsc)).toEqual(["enable-push [16]"]);
    expect(bsc.calls[0]!.value).toBe(1_100n); // the quote plus 10%, outside the request quota
    expect(k.state.lastPushAt["16"]).toBe(E + 90);
    expect(xlayer.calls).toEqual([]);
  });

  it("does not count a push stored below the enable floor, and ends the round once one lands at or after it", async () => {
    const w = world({ feedEnabledAt: E, reports: new Map([[16n, healthy(16n, E - 3_000)], [18n, healthy(18n, E + 60)]]) });
    const { k, cycle, bsc } = keeperIn(w);
    at(w, E + 90);
    await cycle(liveFlag());
    expect(labels(bsc)).toEqual(["enable-push [16]"]);
    w.reports.set(16n, healthy(16n, E + 59)); // landed, but below the enable floor
    at(w, E + 400);
    await cycle(liveFlag());
    expect(bsc.calls).toHaveLength(1); // the push cooldown
    at(w, E + 690);
    await cycle(liveFlag());
    expect(labels(bsc)).toEqual(["enable-push [16]", "enable-push [16]"]);
    w.reports.set(16n, healthy(16n, E + 700));
    at(w, E + 1_400);
    await cycle(liveFlag());
    expect(bsc.calls).toHaveLength(2);
    expect(k.state.feedRound?.rigs).toEqual([]);
  });

  it("starts a new round at the next increase, pushes nothing while the feed is off, and stops at the harvest reserve", async () => {
    const w = world({ feedEnabledAt: E, feedDisabled: true, reports: new Map([[16n, healthy(16n, E - 3_000)], [18n, healthy(18n, E - 3_000)]]) });
    const { k, cycle, bsc, alerts } = keeperIn(w);
    at(w, E + 90);
    await cycle(liveFlag());
    expect(bsc.calls).toEqual([]);
    w.feedDisabled = false;
    w.balance = 10_000_000_000_000_000n; // exactly the 0.01 BNB reserve: one push would go below it
    await cycle(liveFlag());
    expect(bsc.calls).toEqual([]);
    expect(alerts.some((a) => a.includes("post-enable pushes held"))).toBe(true);
    w.balance = 10n ** 18n;
    w.feedEnabledAt = E + 3_600;
    at(w, E + 3_600 + 90);
    await cycle(liveFlag());
    expect(k.state.feedRound?.enabledAt).toBe(E + 3_600);
    expect(labels(bsc)).toEqual(["enable-push [16,18]"]);
  });

  it("withholds the machine's own evidence pushes until the timing rule opens", async () => {
    const w = world({ feedEnabledAt: E, bad: new Set([17n]), reports: new Map([[17n, null]]) });
    const { cycle, bsc } = keeperIn(w);
    at(w, E + 30);
    await cycle(unflagged());
    at(w, E + 60);
    await cycle(unflagged());
    expect(bsc.calls).toEqual([]); // a report pushed now would land below the enable floor
    at(w, E + 90);
    await cycle(unflagged());
    expect(labels(bsc)).toEqual(["push [17]"]);
  });

  it("restores the push time of a post-enable push broadcast before a crash", () => {
    const state = emptyState(1n, D.factory);
    state.pendingTx.bsc.push({ label: "enable-push [16,18]", address: D.reporter, data: "0x", value: "0", urgency: "urgent", nonce: 0, hash: "0x01", hashes: ["0x01"], gasPrice: "1", sentAt: E + 95 });
    keeperIn(world(), state);
    expect(state.lastPushAt).toEqual({ "16": E + 95, "18": E + 95 });
  });

  it("refuses a borrow push on request until X Layer time reaches feedEnabledAt + FEED_SETTLE", async () => {
    const w = world({ feedEnabledAt: E, reports: new Map([[16n, null]]) });
    const service = (t: number) => {
      at(w, t);
      return new PushService(cfg(), clientsOf(w), D, recorder(), new PushLimiter(), () => false, () => {}, () => w.now);
    };
    expect(await service(E + 359).request(AGENT, "1.1.1.1")).toEqual({ status: "refused", reason: FEED_SETTLING });
    const s = service(E + 359);
    w.now = E + 3_600; // the keeper's clock alone does not end the window
    expect(await s.request(AGENT, "1.1.1.1")).toEqual({ status: "refused", reason: FEED_SETTLING });
    const open = await service(E + 360).request(AGENT, "1.1.1.1");
    expect(open.reason).not.toBe(FEED_SETTLING);
  });
});

describe("RB3-04 a clear blocked by a stored impaired report", () => {
  const FLOOR = NOW - 86_400; // seizeEvidenceFrom of the expired flag
  const stale = impairedAt(17n, NOW - 3_600); // row B: impaired, older than 300 s, still the stored report
  const old = { syncedAt: FLOOR - 86_400, power: 500n }; // a record from before the floor: no candidate
  const plan = (refresh: Parameters<typeof clearPlan>[6], over: Partial<{ now: number; report: Report; confirmed: RigView["confirmed"]; feed: FeedView; pushOpen: boolean; flagged: bigint }> = {}) =>
    clearPlan(17n, over.flagged ?? 16n, FLOOR, over.now ?? NOW, over.report ?? stale, old, refresh, { feed: over.feed, confirmed: "confirmed" in over ? over.confirmed : "healthy", pushOpen: over.pushOpen });

  it("pushes once per incident, with no refresh harvest, when the keeper's own BSC read is healthy", () => {
    expect(plan({})).toMatchObject({ blocks: true, row: "B", verdict: "impaired", pushOnce: true, harvest: false, push: false, alert: false });
    expect(plan({}, { flagged: 17n })).toMatchObject({ row: "B", pushOnce: true, harvest: false });
    expect(plan({}, { confirmed: null })).toMatchObject({ pushOnce: false, alert: false }); // unconfirmed: wait
    expect(plan({}, { confirmed: "stopped" })).toMatchObject({ pushOnce: false, alert: true }); // really impaired: owner review
    expect(plan({}, { pushOpen: false })).toMatchObject({ pushOnce: false, alert: false }); // RB3-03 timing
  });

  it("spends the push once it is sent, alerts if the rig still blocks once it landed or after 10 minutes", () => {
    expect(plan({ pushAt: NOW - 120 })).toMatchObject({ pushOnce: false, alert: false }); // in flight
    expect(plan({ pushAt: NOW - 600 })).toMatchObject({ pushOnce: false, alert: true }); // never landed
    const landedImpaired = impairedAt(17n, NOW - 100);
    expect(plan({ pushAt: NOW - 130 }, { report: landedImpaired })).toMatchObject({ pushOnce: false, alert: true });
    expect(plan({ pushAt: NOW - 130, alerted: true }, { report: landedImpaired }).alert).toBe(false);
    expect(plan({ pushAt: NOW - 130 }, { report: healthy(17n, NOW - 100) })).toMatchObject({ blocks: false, pushOnce: false, alert: false }); // row H overtook it
  });

  it("does not spend the incident on a push stored below the enable floor", () => {
    const feed: FeedView = { disabled: false, enabledAt: NOW - 100 }; // enable floor NOW - 40
    expect(plan({ pushAt: NOW - 130 }, { feed, report: impairedAt(17n, NOW - 41) })).toMatchObject({ row: "B", pushOnce: true, alert: false });
    expect(plan({ pushAt: NOW - 130 }, { feed, report: impairedAt(17n, NOW - 40) })).toMatchObject({ row: "B", pushOnce: false, alert: true });
  });

  it("keeps the RB-09 refresh harvest for a block that the voucher record drives", () => {
    const p = clearPlan(17n, 16n, FLOOR, NOW, healthy(17n, NOW - 10), { syncedAt: NOW - 5, power: 0n }, {}, { confirmed: "healthy" });
    expect(p).toMatchObject({ blocks: true, row: "VC", harvest: true, pushOnce: false });
  });

  const world4 = () => world({ seizeFrom: FLOOR, reports: new Map([[16n, healthy(16n, NOW - 10)], [17n, stale]]), records: new Map([[16n, old], [17n, old]]) });
  const incident = `${AGENT.toLowerCase()}:1000:${IMPAIRED_AT}`;

  it("sends one push for the incident, waits for it, then clears on the row H report it stored", async () => {
    const w = world4();
    const { k, cycle, bsc, xlayer, alerts } = keeperIn(w);
    await cycle(expiredLoan());
    expect(bsc.calls).toEqual([]); // the BSC reading is confirmed on the next cycle
    await cycle(expiredLoan());
    expect(labels(bsc)).toEqual([`clear-push [17] for ${incident}`]);
    expect(k.state.refresh[`${incident}:17`]?.pushAt).toBe(NOW);
    w.now += 120;
    w.reports.set(16n, healthy(16n, w.now - 10));
    await cycle(expiredLoan());
    expect(bsc.calls).toHaveLength(1);
    expect(xlayer.calls).toEqual([]);
    w.reports.set(17n, healthy(17n, NOW + 30));
    await cycle(expiredLoan());
    expect(labels(xlayer)).toEqual([`clearExpiredFlag ${AGENT}`]);
    expect(bsc.calls).toHaveLength(1);
    expect(alerts.filter((a) => a.includes("owner review"))).toEqual([]);
  });

  it("alerts once when the clear is still blocked after the push, and never pushes again for the incident", async () => {
    const w = world4();
    const { cycle, bsc, xlayer, alerts } = keeperIn(w);
    const tick = async (dt: number) => { w.now += dt; w.reports.set(16n, healthy(16n, w.now - 10)); await cycle(expiredLoan()); };
    await tick(0);
    await tick(60);
    expect(bsc.calls).toHaveLength(1);
    await tick(600);
    expect(alerts.filter((a) => a.includes("still blocks the clear after its fresh push"))).toHaveLength(1);
    await tick(700);
    await tick(3_600);
    expect(labels(bsc)).toEqual([`clear-push [17] for ${incident}`]);
    expect(alerts.filter((a) => a.includes("owner review"))).toHaveLength(1);
    expect(xlayer.calls).toEqual([]);
  });

  it("keeps the flagged rig out of the push cooldown loop while row B blocks it", async () => {
    const w = world({ seizeFrom: FLOOR, reports: new Map([[16n, impairedAt(16n, NOW - 3_600)]]), records: new Map([[16n, old]]) });
    const { cycle, bsc } = keeperIn(w);
    const flagged = () => expiredLoan([16n]);
    await cycle(flagged());
    await cycle(flagged());
    expect(labels(bsc)).toEqual([`clear-push [16] for ${incident}`]);
    w.now += 700;
    await cycle(flagged());
    w.now += 3_600;
    await cycle(flagged());
    expect(bsc.calls).toHaveLength(1);
  });

  it("restores the incident's push from the broadcast journal after a crash (RB3-04)", () => {
    const state = emptyState(1n, D.factory);
    state.pendingTx.bsc.push({ label: `clear-push [17] for ${incident}`, address: D.reporter, data: "0x", value: "0", urgency: "routine", nonce: 0, hash: "0x01", hashes: ["0x01"], gasPrice: "1", sentAt: NOW - 5 });
    keeperIn(world(), state);
    expect(state.refresh[`${incident}:17`]).toEqual({ pushAt: NOW - 5 });
    expect(state.lastPushAt["17"]).toBe(NOW - 5);
  });
});

describe("RB3-05 the redeploy 3 address book", () => {
  const pool = (settle: unknown) => ({ xlayer: { public: { readContract: async (q: Q) => {
    if (settle instanceof Error) throw settle;
    return q.functionName === "FEED_SETTLE" ? settle : 0n;
  } } } }) as unknown as Clients;

  it("starts only against a redeploy 3 pool, and never reads the legacy stack", async () => {
    await expect(checkStack(pool(360n), D)).resolves.toBeUndefined();
    await expect(checkStack(pool(new Error("execution reverted")), D)).rejects.toThrow("execution reverted"); // the 2026-10-31 pool
    await expect(checkStack(pool(300n), D)).rejects.toThrow("not a redeploy 3 pool");
    await expect(checkStack(pool(new Error("unreachable")), { ...D, legacy: true })).resolves.toBeUndefined();
  });

  it("takes the new pool, factory, screen and lens with the reused receiver and reporter from the environment", () => {
    const env: Record<string, string> = { KEEPER_CUTOVER_RD02: "confirmed" };
    const book = { POOL: A(11), FACTORY: A(12), SCREEN: A(13), LENS: A(14), RECEIVER: "0xB96847a3af4C9eC658cDC77dB98801AF399cFA1d", REPORTER: "0x24b5a7CA358Af29C51d16F801BbEcF746247AF0e" };
    for (const [k, v] of Object.entries(book)) env[`KEEPER_${k}`] = v;
    Object.assign(env, { KEEPER_POOL_DEPLOY_BLOCK: "80000002", KEEPER_FACTORY_DEPLOY_BLOCK: "80000001", KEEPER_RECEIVER_DEPLOY_BLOCK: "74684257", KEEPER_REPORTER_DEPLOY_BLOCK: "130864778" });
    expect(loadDeployment(env)).toEqual({ legacy: false, pool: getAddress(A(11)), factory: getAddress(A(12)), screen: getAddress(A(13)), lens: getAddress(A(14)), receiver: book.RECEIVER, reporter: book.REPORTER, poolDeployBlock: 80_000_002n, factoryDeployBlock: 80_000_001n, receiverDeployBlock: 74_684_257n, reporterDeployBlock: 130_864_778n });
  });
});

describe("RB3-06 retries of ids a closed agent keeps", () => {
  const closed = (ids = [16n, 17n]) => loanOf({ open: false }, ids, { closed: true });
  const forwards = (s: { calls: Call[] }) => s.calls.filter((c) => c.functionName === "forwardVouchers").length;

  it("calls forwardVouchers only when its own read names the agent or the pool for a listed id", async () => {
    const w = world({ owners: new Map<bigint, Address | "revert">([[16n, THIRD], [17n, AGENT]]) });
    const { sweep, xlayer, alerts } = keeperIn(w);
    await sweep(closed());
    expect(labels(xlayer)).toEqual([`forwardVouchers ${AGENT}`]);
    expect(alerts.filter((a) => a.includes(`voucher 16, listed by closed agent ${AGENT}, is held by ${getAddress(THIRD)}`))).toHaveLength(1);
    w.owners.set(17n, D.pool); // the pool already holds it: forwardVouchers removes it from the list
    w.now += 3_600;
    await sweep(closed());
    expect(forwards(xlayer)).toBe(2);
  });

  it("alerts once for an id held elsewhere and stops retrying, then forwards once the voucher is back in the agent", async () => {
    const w = world({ owners: new Map<bigint, Address | "revert">([[16n, THIRD]]) });
    const { sweep, xlayer, alerts } = keeperIn(w);
    await sweep(closed([16n]));
    expect(xlayer.calls).toEqual([]);
    for (let h = 1; h <= 3; h++) {
      w.now += 3_600;
      await sweep(closed([16n]));
    }
    expect(xlayer.calls).toEqual([]);
    expect(alerts.filter((a) => a.includes("voucher 16"))).toHaveLength(1);
    w.owners.set(16n, AGENT);
    w.now += 3_600;
    await sweep(closed([16n]));
    expect(labels(xlayer)).toEqual([`forwardVouchers ${AGENT}`]);
  });

  it("reads an unreadable or zero holder as unknown: no forwardVouchers, one alert, and a read every hour", async () => {
    const w = world({ owners: new Map<bigint, Address | "revert">([[16n, "revert"], [17n, A(0)]]) });
    const { k, sweep, xlayer, alerts } = keeperIn(w);
    await sweep(closed());
    expect(xlayer.calls).toEqual([]);
    expect(alerts.filter((a) => a.includes("cannot be read"))).toHaveLength(2);
    expect(k.state.keptAlerts).toEqual({ [`${AGENT.toLowerCase()}:16`]: "unknown", [`${AGENT.toLowerCase()}:17`]: "unknown" });
    w.owners.set(16n, AGENT);
    w.now += 1_800;
    await sweep(closed());
    expect(xlayer.calls).toEqual([]); // at most hourly
    w.now += 1_800;
    await sweep(closed());
    expect(labels(xlayer)).toEqual([`forwardVouchers ${AGENT}`]);
    expect(alerts.filter((a) => a.includes("cannot be read"))).toHaveLength(2);
  });
});

describe("final audit lows (Parts B and C)", () => {
  it("L-1: alerts when X Layer time stays unreadable after a re-enable, and keeps withholding pushes", async () => {
    const w = world({ feedEnabledAt: NOW - 1_000, xNow: null, bad: new Set([16n]), reports: new Map([[16n, null]]) });
    const { cycle, bsc, alerts } = keeperIn(w);
    await cycle(loanOf());
    w.now += 300;
    await cycle(loanOf());
    expect(alerts.filter((a) => a.includes("xlayer-time"))).toEqual([]); // a short outage only logs
    w.now += 300;
    await cycle(loanOf());
    expect(alerts.filter((a) => a.includes("xlayer-time") && a.includes("evidence and health pushes are withheld"))).toHaveLength(1);
    expect(bsc.calls).toEqual([]); // still fail closed: no push for the confirmed suspect
    w.xNow = w.now;
    await cycle(loanOf());
    expect(labels(bsc)).toEqual(["push [16]"]);
    expect(alerts.some((a) => a.includes("keeper job xlayer-time recovered"))).toBe(true);
  });

  it("L-2: tells the owner once a day when a flagged or suspect loan's report cannot be read", async () => {
    const w = world({ bad: new Set([16n]), records: new Map([[16n, { syncedAt: NOW - 10, power: 0n }]]) }); // no report entry: the read fails
    const { cycle, xlayer, alerts } = keeperIn(w);
    const unreadable = () => alerts.filter((a) => a.includes("stored report of rig 16") && a.includes("cannot be read"));
    await cycle(loanOf());
    expect(unreadable()).toEqual([]); // not a confirmed suspect yet
    await cycle(loanOf());
    expect(unreadable()).toHaveLength(1);
    expect(xlayer.calls).toEqual([]); // still nothing planned on it, although the record alone would be row VE
    w.now += 3_600;
    await cycle(loanOf());
    expect(unreadable()).toHaveLength(1);
    w.now += 86_400;
    await cycle(loanOf());
    expect(unreadable()).toHaveLength(2);
    const quiet = world({ records: new Map([[17n, { syncedAt: NOW - 10, power: 500n }]]) });
    const healthy = keeperIn(quiet);
    await healthy.cycle(loanOf({}, [17n]));
    await healthy.cycle(loanOf({}, [17n]));
    expect(healthy.alerts.filter((a) => a.includes("cannot be read"))).toEqual([]); // no flag and no suspect: no alert
    await healthy.cycle(loanOf({ impairedAt: NOW - 3_600, seizeStart: NOW + 68 * 3_600, deadline: NOW + 100 * 3_600, impairedRig: 17n }, [17n]));
    expect(healthy.alerts.filter((a) => a.includes("stored report of rig 17"))).toHaveLength(1); // a live flag
  });

  it("L-3: sends no refresh harvest for row U on a rig the keeper reads as healthy: the push of the flagged rig suffices", async () => {
    const FLOOR = NOW - 86_400;
    const feed: FeedView = { disabled: false, enabledAt: NOW - 100 }; // enable floor NOW - 40
    const masked = healthy(16n, NOW - 41); // row U over an older positive record
    const old = { syncedAt: FLOOR, power: 500n };
    expect(clearPlan(16n, 16n, FLOOR, NOW, masked, old, {}, { feed, confirmed: "healthy" })).toMatchObject({ row: "U", blocks: true, harvest: false });
    expect(clearPlan(16n, 16n, FLOOR, NOW, masked, old, {}, { feed, confirmed: null })).toMatchObject({ row: "U", harvest: true }); // unchanged while unconfirmed
    const w = world({ feedEnabledAt: NOW - 100, seizeFrom: FLOOR, reports: new Map([[16n, masked]]), records: new Map([[16n, old]]) });
    const { cycle, bsc } = keeperIn(w);
    await cycle(loanOf({ impairedAt: NOW - 3_600, seizeStart: NOW + 68 * 3_600, deadline: NOW + 100 * 3_600, impairedRig: 16n })); // confirms rig 16 healthy
    await cycle(expiredLoan([16n]));
    expect(labels(bsc)).toEqual(["enable-push [16]"]); // the RB3-03 push only, no refresh harvest
  });

  it("L-4: tells the push's own report from a recent blocking report before spending the incident", async () => {
    const FLOOR = NOW - 86_400;
    const old = { syncedAt: FLOOR - 86_400, power: 500n };
    const recent = impairedAt(17n, NOW - 30); // row B, observed 30 s before the push: inside the landing slack
    const ctx = { confirmed: "healthy" as const };
    expect(clearPlan(17n, 16n, FLOOR, NOW + 60, recent, old, { pushAt: NOW, storedBefore: NOW - 30 }, ctx)).toMatchObject({ row: "B", pushOnce: false, alert: false }); // in flight
    expect(clearPlan(17n, 16n, FLOOR, NOW + 600, recent, old, { pushAt: NOW, storedBefore: NOW - 30 }, ctx)).toMatchObject({ pushOnce: false, alert: true }); // never landed
    expect(clearPlan(17n, 16n, FLOOR, NOW + 60, impairedAt(17n, NOW + 10), old, { pushAt: NOW, storedBefore: NOW - 30 }, ctx)).toMatchObject({ pushOnce: false, alert: true }); // landed, still impaired
    // a landed push below the enable floor still leaves the incident's push unspent
    const feed: FeedView = { disabled: false, enabledAt: NOW - 30 }; // enable floor NOW + 30
    expect(clearPlan(17n, 16n, FLOOR, NOW + 60, impairedAt(17n, NOW + 10), old, { pushAt: NOW, storedBefore: NOW - 30 }, { ...ctx, feed })).toMatchObject({ pushOnce: true, alert: false });
    const w = world({ seizeFrom: FLOOR, reports: new Map([[16n, healthy(16n, NOW - 10)], [17n, recent]]), records: new Map([[16n, old], [17n, old]]) });
    const { k, cycle, bsc, alerts } = keeperIn(w);
    await cycle(expiredLoan());
    await cycle(expiredLoan());
    expect(labels(bsc)).toEqual([`clear-push [17] for ${AGENT.toLowerCase()}:1000:${IMPAIRED_AT}`]);
    expect(k.state.refresh[`${AGENT.toLowerCase()}:1000:${IMPAIRED_AT}:17`]).toMatchObject({ pushAt: NOW, storedBefore: NOW - 30 });
    w.now += 60;
    w.reports.set(16n, healthy(16n, w.now - 10));
    await cycle(expiredLoan());
    expect(alerts.filter((a) => a.includes("owner review"))).toEqual([]); // the push has not landed yet
  });

  it("L-5: alerts once when row B waits on a BSC read that stays unconfirmed for three cycles", async () => {
    const FLOOR = NOW - 86_400;
    const old = { syncedAt: FLOOR - 86_400, power: 500n };
    const w = world({ seizeFrom: FLOOR, bscDown: new Set([17n]), reports: new Map([[16n, healthy(16n, NOW - 10)], [17n, impairedAt(17n, NOW - 3_600)]]), records: new Map([[16n, old], [17n, old]]) });
    const { k, cycle, bsc, alerts } = keeperIn(w);
    const unreadable = () => alerts.filter((a) => a.includes("rig 17 needs a clear refresh but its BSC source is unreadable"));
    const tick = async () => { w.now += 60; w.reports.set(16n, healthy(16n, w.now - 10)); await cycle(expiredLoan()); };
    await tick();
    await tick();
    expect(unreadable()).toEqual([]);
    expect(k.state.refresh[`${AGENT.toLowerCase()}:1000:${IMPAIRED_AT}:17`]?.unconfirmed).toBe(2);
    await tick();
    expect(unreadable()).toHaveLength(1);
    await tick();
    expect(unreadable()).toHaveLength(1); // once per incident
    expect(bsc.calls).toEqual([]); // no push without a healthy BSC read
    w.bscDown.clear();
    await tick();
    await tick(); // two good reads confirm the rig healthy
    expect(k.state.refresh[`${AGENT.toLowerCase()}:1000:${IMPAIRED_AT}:17`]?.unconfirmed).toBeUndefined();
    expect(labels(bsc)).toEqual([`clear-push [17] for ${AGENT.toLowerCase()}:1000:${IMPAIRED_AT}`]);
  });

  it("L-6: does not promise an hourly retry for an unlanded row B push, which is sent once", async () => {
    const FLOOR = NOW - 86_400;
    const old = { syncedAt: FLOOR - 86_400, power: 500n };
    const w = world({ seizeFrom: FLOOR, reports: new Map([[16n, healthy(16n, NOW - 10)], [17n, impairedAt(17n, NOW - 3_600)]]), records: new Map([[16n, old], [17n, old]]) });
    const { cycle, bsc, alerts } = keeperIn(w);
    const tick = async (dt: number) => { w.now += dt; w.reports.set(16n, healthy(16n, w.now - 10)); await cycle(expiredLoan()); };
    await tick(0);
    await tick(60);
    expect(labels(bsc)).toEqual([`clear-push [17] for ${AGENT.toLowerCase()}:1000:${IMPAIRED_AT}`]);
    await tick(600);
    const dead = alerts.filter((a) => a.includes("rig 17") && a.includes("was not stored after 10 minutes"));
    expect(dead).toEqual(["the report pushed for rig 17 to clear the flag was not stored after 10 minutes: the feed may be dead (sent once for this flag, not retried)"]);
    expect(bsc.calls).toHaveLength(1);
  });
});
