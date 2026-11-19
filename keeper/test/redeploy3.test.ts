// Redeploy 3, Part B (docs/SPEC-REDEPLOY-3.md §5): the keeper's R3-00 mirror against the contract's own
// evidence vectors amended by R4-00/RB4-01, and the RB3-03, RB3-04 and RB3-06 rules.
import { describe, expect, it } from "vitest";
import { readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HttpRequestError, encodeFunctionData, getAddress, type Address, type TransactionReceipt } from "viem";
import { Alerts } from "../src/alerts.js";
import type { Deployment } from "../src/addresses.js";
import type { Clients } from "../src/chains.js";
import { reporterAbi } from "../src/abi.js";
import type { RigCondition } from "../src/logic/confirm.js";
import { loadConfig, loadDeployment } from "../src/config.js";
import { Keeper } from "../src/keeper.js";
import { ENABLE_PUSH_MARGIN, FEED_SETTLE, MAX_CLOCK_SKEW, MAX_REPORT_AGE, clearPlan, clearPushState, clearReading, evidenceKind, pushOpen, reportVerdict, verdict, verdictCode, type FeedView, type Report, type VoucherRecord } from "../src/logic/evidence.js";
import { nextActions, type Action, type MachineInput, type RigView } from "../src/logic/loanMachine.js";
import { PushLimiter } from "../src/logic/pushLimits.js";
import { FEED_SETTLING, PushService } from "../src/push.js";
import { checkStack, minerKey, type LoanSnapshot } from "../src/reads.js";
import { emptyState, loadState, saveState, type KeeperState } from "../src/state.js";
import { Sender, type Call, type SendResult } from "../src/tx.js";

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
type VectorInput = Omit<Vector, "row" | "kind" | "verdict">;
interface ClearPairVector extends VectorInput { flaggedId: string; flaggedVerdict: number; otherVerdict: number; allowed: boolean }
interface BonusVector { mult: string; bstar: string; rawBonus: string; verifWeight: string; bonus: string; base: string }
const CLEAR_PAIRS = JSON.parse(readFileSync(new URL("./fixtures/clear-pair-vectors.json", import.meta.url), "utf8")) as ClearPairVector[];
const BONUSES = JSON.parse(readFileSync(new URL("./fixtures/bonus-vectors.json", import.meta.url), "utf8")) as BonusVector[];

/** The mirror's inputs for one vector: a reverting feed is `undefined`, an empty slot `null` (both are ok == false). */
function inputs(v: VectorInput) {
  const r = v.report;
  const report: Report | null | undefined = r.reverts ? undefined : !r.ok ? null : {
    rigId: BigInt(r.rigId), observedAt: BigInt(r.observedAt), status: r.status, stopBlock: BigInt(r.stopBlock), custodied: r.custodied,
    verifWeight: BigInt(r.verifWeight), bonus: BigInt(r.bonus), totalVerifWeight: BigInt(r.totalVerifWeight),
  };
  const record: VoucherRecord | undefined = v.record.readable ? { syncedAt: Number(v.record.syncedAt), power: BigInt(v.record.power) } : undefined;
  const feed: FeedView = { disabled: v.feedDisabled, enabledAt: Number(v.feedEnabledAt) };
  return { id: BigInt(v.id), now: BigInt(v.now), floor: BigInt(v.floor), feed, report, record };
}

describe("RB4-01 R4-00 mirror against the ParityVectors evidence vectors", () => {
  it("has every vector of the build: 103 evidence cases, three clear pairs and six bonus cases", () => {
    expect(VECTORS).toHaveLength(103);
    expect(CLEAR_PAIRS).toHaveLength(3);
    expect(BONUSES).toHaveLength(6);
    expect([...new Set(VECTORS.map((v) => v.row))].sort()).toEqual(["B", "E", "H", "N", "S", "U", "VC", "VE"]);
    const has = (row: string, name: string) => VECTORS.some((v) => v.row === row && v.case === name);
    for (const row of ["E", "H", "S"]) {
      expect(has(row, "observedAt = enableFloor - 1"), row).toBe(true);
      expect(has(row, "observedAt = enableFloor"), row).toBe(true);
    }
    expect(has("B", "impaired report one hour old")).toBe(true);
    expect(has("U", "power-0 record older than the report")).toBe(true);
    for (const row of ["B", "U"]) for (let i = 0; i < 4; i++) expect(has(row, `feed off: record variant ${i}`)).toBe(true);
  });

  it.each(VECTORS.map((v) => [`${v.row}: ${v.case}`, v] as const))("%s", (_name, v) => {
    const x = inputs(v);
    expect(evidenceKind(x.id, x.floor, x.now, x.feed, x.report, x.record), "kind").toBe(v.kind);
    expect(verdictCode(clearReading(x.id, x.floor, x.now, x.feed, x.report, x.record).verdict), "verdict").toBe(v.verdict);
    expect(verdictCode(verdict(x.id, Number(x.floor), Number(x.now), x.report, x.record, x.feed))).toBe(v.verdict);
    // A reverting receiver is a known ok=false answer here, distinct from a failed keeper RPC read.
    const report = x.report === undefined ? null : x.report;
    const plan = (flagged: bigint) => clearPlan(x.id, flagged, Number(x.floor), Number(x.now), report, x.record, {}, { feed: x.feed });
    expect(plan(x.id).blocks, "flagged rig").toBe(v.verdict !== 1);
    expect(plan(x.id + 1n).blocks, "other rig").toBe(v.verdict >= 2);
  });

  it("pins the boundaries the spec names: the enable floor, row B past 300 s, and R4-00 row U", () => {
    const pick = (row: string, name: string) => VECTORS.find((v) => v.row === row && v.case === name)!;
    expect(pick("E", "observedAt = enableFloor - 1").kind).toBe(0);
    expect(pick("E", "observedAt = enableFloor").kind).toBe(1);
    expect(pick("H", "observedAt = enableFloor - 1").verdict).toBe(3);
    expect(pick("H", "observedAt = enableFloor").verdict).toBe(1);
    expect(pick("S", "observedAt = enableFloor - 1").kind).toBe(2);
    expect(pick("S", "observedAt = enableFloor").kind).toBe(0);
    const stale = pick("B", "impaired report one hour old");
    expect(BigInt(stale.now) - BigInt(stale.report.observedAt)).toBeGreaterThan(300n);
    expect(stale.verdict).toBe(2);
    expect(pick("U", "power-0 record older than the report").verdict).toBe(2);
    expect(pick("U", "healthy report at enableFloor - 1 over an older positive record").verdict).toBe(3);
    const u = inputs(pick("U", "no record candidate"));
    expect(reportVerdict(u.report, u.id, Number(u.floor), Number(u.now), u.feed)).toBe("unknown");
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
  flagFrom: number | "revert";
  seizeFrom: number;
  /** Rigs whose BSC miner reads as stopped (status 3). */
  bad: Set<bigint>;
  conditions: Map<bigint, RigCondition>;
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
  return { now: NOW, xNow: NOW, feedDisabled: false, feedEnabledAt: 0, flagFrom: NOW - 3_600, seizeFrom: NOW - 3_600, bad: new Set(), conditions: new Map(), bscDown: new Set(), reports: new Map(), records: new Map(), owners: new Map(), balance: 10n ** 18n, ...over };
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
          const id = idOfKey(q.args![0]);
          const condition = w.conditions.get(id) ?? (w.bad.has(id) ? "revoked" : "healthy");
          return ok({ status: condition === "revoked" ? 3 : 1, stopBlock: condition === "stopped" ? 1n : 0n, since: 1n, taskId: 4,
            verifWeight: condition === "revoked" || condition === "noBase" ? 0n : 500n, bstar: 500n, mult: 1, bonus: 0n });
        }
        if (q.functionName === "ownerOf" && w.conditions.get(q.args![0] as bigint) === "rescue") return ok(THIRD);
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
          case "flagEvidenceFrom": if (w.flagFrom === "revert") throw new Error("flag floor unavailable"); return BigInt(w.flagFrom);
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

function keeperIn(w: World, state: KeeperState = emptyState(1n, D.factory), alertSource?: (messages: string[]) => Alerts) {
  const alerts: string[] = [];
  const bsc = recorder(), xlayer = recorder();
  const k = new Keeper(cfg(), clientsOf(w), D, alertSource?.(alerts) ?? { send: async (_kind: string, text: string) => void alerts.push(text) } as unknown as Alerts, { bsc, xlayer }, state, () => w.now);
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
  function view(v: VectorInput, confirmed: RigView["confirmed"]): RigView {
    const x = inputs(v);
    return {
      id: x.id, confirmed, passSuspended: true, lastPushAt: 0,
      storedObservedAt: x.report ? Number(x.report.observedAt) : 0,
      report: x.report === undefined ? null : x.report, // a reverting feed reads as an empty slot (ok false)
      voucherSyncedAt: x.record?.syncedAt, voucherPower: x.record?.power,
    };
  }
  const common = (v: VectorInput): Omit<MachineInput, "loan" | "rigs"> => ({
    now: Number(v.now), feedDisabled: v.feedDisabled, feedEnabledAt: Number(v.feedEnabledAt), suspendOnRevoke: false, pushOpen: false,
    flagEvidenceFrom: Number(v.floor), seizeEvidenceFrom: Number(v.floor),
  });

  it.each(VECTORS.map((v) => [`${v.row}: ${v.case}`, v] as const))("plans exactly what the agent accepts: %s", (_name, v) => {
    const now = Number(v.now), id = BigInt(v.id);
    const flag = nextActions({ ...common(v), loan: { open: true, impairedAt: 0, seizeStart: 0, deadline: 0, expired: false, impairedRig: 0n }, rigs: [view(v, "stopped")] });
    expect(flag, "flagImpaired").toEqual(v.kind !== 0 ? [{ kind: "flag", rig: id }] : []);
    const seize = nextActions({ ...common(v), loan: { open: true, impairedAt: now - 80 * 3_600, seizeStart: now - 8 * 3_600, deadline: now + 3_600, expired: false, impairedRig: id }, rigs: [view(v, "stopped")] });
    expect(seize, "seize").toEqual(v.kind !== 0 ? [{ kind: "seize" }] : []);
    const clear = nextActions({ ...common(v), loan: { open: true, impairedAt: now - 100 * 3_600, seizeStart: now - 28 * 3_600, deadline: now - 3_600, expired: true, impairedRig: id }, rigs: [view(v, "healthy")] });
    expect(clear, "clearExpiredFlag").toEqual(v.verdict === 1 ? [{ kind: "clear" }] : v.feedDisabled ? [{ kind: "alert", text: "expired impairment flag while the feed is disabled: owner review required" }] : []);
  });

  it.each(CLEAR_PAIRS.map((v) => [v.case, v] as const))("matches the production two-rig clear predicate: %s", (_name, v) => {
    const x = inputs(v), flagged = inputs({ ...v, id: v.flaggedId });
    const read = (r: ReturnType<typeof inputs>) => clearReading(r.id, r.floor, r.now, r.feed, r.report, r.record).verdict;
    expect(verdictCode(read(flagged))).toBe(v.flaggedVerdict);
    expect(verdictCode(read(x))).toBe(v.otherVerdict);
    const plans = [flagged, x].map((r) => clearPlan(r.id, flagged.id, Number(r.floor), Number(r.now), r.report, r.record, {}, { feed: r.feed, confirmed: "healthy" }));
    expect(plans.every((p) => !p.blocks)).toBe(v.allowed);
    expect(plans[1]).toMatchObject(v.allowed
      ? { blocks: false, verdict: "healthy", row: "VC" }
      : { blocks: true, verdict: "unknown", row: v.feedDisabled ? "U" : "N" });
  });

  it.each([false, true])("rejects unknown on the other rig with feedDisabled=%s, even without a clear plan", (feedDisabled) => {
    const v = { ...CLEAR_PAIRS[0]!, feedDisabled, feedEnabledAt: feedDisabled ? "0" : CLEAR_PAIRS[0]!.now };
    const flagged = view({ ...v, id: v.flaggedId }, "healthy"), other = view(v, "healthy");
    const now = Number(v.now), floor = Number(v.floor);
    const m: MachineInput = { ...common(v), loan: { open: true, impairedAt: floor - 80 * 3_600, seizeStart: floor, deadline: now - 3_600, expired: true, impairedRig: flagged.id }, rigs: [flagged, other] };
    for (const clearAllowed of [undefined, false, true]) {
      expect(nextActions({ ...m, clearAllowed }).some((a) => a.kind === "clear")).toBe(false);
    }
    // Refreshing only the flagged rig leaves the other rig's row U unresolved.
    expect(nextActions({ ...m, rigs: [{ ...flagged, voucherSyncedAt: now }, other] }).some((a) => a.kind === "clear")).toBe(false);
    const resolved = { ...other, voucherSyncedAt: Number(v.report.observedAt) + 1 };
    expect(nextActions({ ...m, rigs: [flagged, resolved] })).toEqual([{ kind: "clear" }]);
    expect(nextActions({ ...m, rigs: [flagged, { ...resolved, confirmed: "stopped" }] }).some((a) => a.kind === "clear")).toBe(false);
    // Truly missing on another rig remains permitted (R3-00); unknown is a separate block.
    const missing = { ...other, report: null, voucherSyncedAt: floor - 1 };
    expect(nextActions({ ...m, rigs: [flagged, missing] })).toEqual([{ kind: "clear" }]);
    const unreadable = { ...resolved, report: undefined };
    expect(nextActions({ ...m, rigs: [flagged, unreadable], clearAllowed: true }).some((a) => a.kind === "clear")).toBe(false);
  });

  it.each(BONUSES.map((v) => [`mult ${v.mult}, bstar ${v.bstar}, weight ${v.verifWeight}`, v] as const))("consumes report bonus in weight units: %s", (_name, v) => {
    const r = healthy(7n, NOW - 10, { verifWeight: BigInt(v.verifWeight), bonus: BigInt(v.bonus) });
    expect(r.verifWeight - r.bonus).toBe(BigInt(v.base));
    expect(reportVerdict(r, 7n, NOW - 100, NOW)).toBe(v.base === "0" ? "impaired" : "healthy");
    expect(evidenceKind(7n, NOW - 100, NOW, { disabled: false, enabledAt: 0 }, r, undefined)).toBe(v.base === "0" ? 1 : 0);
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

describe("RB4-04 clears during a brake", () => {
  const FLOOR = NOW - 86_400;
  it.each(["B", "U"])("keeps row %s on the other rig blocked, with one incident alert and no push", async (row) => {
    const w = world({ feedDisabled: true, seizeFrom: FLOOR,
      reports: new Map([[16n, null], [17n, row === "B" ? impairedAt(17n, NOW - 10) : healthy(17n, NOW - 10)]]),
      records: new Map([[16n, { syncedAt: NOW - 20, power: 500n }], [17n, { syncedAt: FLOOR, power: 500n }]]) });
    const h = keeperIn(w), loan = expiredLoan();
    await h.cycle(loan);
    w.now += 3_600;
    await h.cycle(loan);
    expect(h.bsc.calls).toEqual([]);
    expect(h.xlayer.calls).toEqual([]);
    expect(h.alerts.filter((a) => a.includes("owner review: rig 17"))).toHaveLength(1);
    const restarted = keeperIn(w, structuredClone(h.k.state));
    await restarted.cycle(loan);
    expect(restarted.alerts).toEqual([]);
    expect(restarted.bsc.calls).toEqual([]);
    w.records.set(17n, { syncedAt: NOW - 9, power: 500n });
    await restarted.cycle(loan);
    expect(labels(restarted.xlayer)).toEqual([`clearExpiredFlag ${AGENT}`]);
  });

  it("clears from records alone with no stored reports during a brake", async () => {
    const w = world({ feedDisabled: true, seizeFrom: FLOOR, reports: new Map([[16n, null], [17n, null]]),
      records: new Map([[16n, { syncedAt: FLOOR, power: 500n }], [17n, { syncedAt: FLOOR - 1, power: 0n }]]) });
    const h = keeperIn(w);
    await h.cycle(expiredLoan());
    expect(labels(h.xlayer)).toEqual([`clearExpiredFlag ${AGENT}`]);
    expect(h.bsc.calls).toEqual([]);
    expect(h.alerts).toEqual([]);
  });
});

describe("RB4-05 bounded unknown recovery", () => {
  const FLOOR = NOW - 86_400, E = NOW - 100;
  const incident = `${AGENT.toLowerCase()}:1000:${IMPAIRED_AT}`;
  const unknownWorld = (id = 17n) => world({ feedEnabledAt: E, seizeFrom: FLOOR,
    reports: new Map([[16n, id === 16n ? healthy(16n, NOW - 41) : null], [17n, id === 17n ? healthy(17n, NOW - 41) : null]]),
    records: new Map([[16n, { syncedAt: id === 16n ? FLOOR : NOW - 30, power: 500n }], [17n, { syncedAt: FLOOR, power: 500n }]]) });
  const outsideRound = () => {
    const state = emptyState(1n, D.factory);
    state.feedRound = { enabledAt: E, rigs: [] }; // this loan was not among the enable snapshot's flagged loans
    return state;
  };
  const tick = async (h: ReturnType<typeof keeperIn>, w: World, dt: number, loan = expiredLoan()) => {
    w.now += dt; w.xNow = w.now;
    await h.cycle(loan);
  };

  it("plans another push rather than a harvest for a row U answer landed below the enable floor", () => {
    expect(clearPlan(17n, 16n, FLOOR, NOW, healthy(17n, E + MAX_CLOCK_SKEW - 1),
      { syncedAt: FLOOR, power: 500n }, { unknown: true, pushAt: NOW - 130, storedBefore: NOW - 200 },
      { feed: { disabled: false, enabledAt: E }, confirmed: "healthy", pushOpen: true }))
      .toMatchObject({ row: "U", blocks: true, pushOnce: true, harvest: false });
  });

  it("does not credit a push from before the brake and starts recovery with a post-enable push", async () => {
    const w = unknownWorld(), state = outsideRound();
    w.feedDisabled = true; w.feedEnabledAt = NOW - 10_000;
    state.lastPushAt["17"] = NOW - 6_000; // after the flag and the previous enable, before the brake
    const h = keeperIn(w, state);
    await h.cycle(expiredLoan());
    expect(h.k.state.refresh[`${incident}:17`]?.pushAt).toBeUndefined();
    expect(h.bsc.calls).toEqual([]);
    const restarted = keeperIn(w, structuredClone(h.k.state));
    w.feedDisabled = false; w.feedEnabledAt = NOW;
    await tick(restarted, w, 89);
    expect(restarted.k.state.refresh[`${incident}:17`]?.pushAt).toBeUndefined();
    expect(restarted.bsc.calls).toEqual([]);
    await tick(restarted, w, 1);
    expect(restarted.bsc.calls.map((c) => c.functionName)).toEqual(["push"]);
    expect(restarted.bsc.calls[0]!.args).toEqual([[16n, 17n]]);
    expect(restarted.k.state.refresh[`${incident}:17`]).toMatchObject({ pushAt: NOW + 90 });
    expect(restarted.k.state.refresh[`${incident}:17`]?.sentAt).toBeUndefined();
  });

  it("does not credit an earlier push before the latest E + 90 opening", async () => {
    const w = unknownWorld(), state = outsideRound();
    state.lastPushAt["17"] = E + MAX_CLOCK_SKEW + ENABLE_PUSH_MARGIN - 1;
    const h = keeperIn(w, state);
    await h.cycle(expiredLoan());
    await tick(h, w, 1);
    expect(h.k.state.refresh[`${incident}:17`]?.pushAt).toBeUndefined();
    expect(h.bsc.calls).toEqual([]);
    await tick(h, w, 600);
    expect(h.bsc.calls.map((c) => c.functionName)).toEqual(["push"]);
  });

  it.each([false, true])("replaces a push landed below the latest enable floor, enable round=%s", async (inRound) => {
    const w = unknownWorld(), h = keeperIn(w, outsideRound());
    await h.cycle(expiredLoan());
    await tick(h, w, 1);
    expect(h.bsc.calls.map((c) => c.functionName)).toEqual(["push"]);
    w.feedEnabledAt = NOW + 2;
    w.reports.set(17n, healthy(17n, NOW + 61)); // newer answer, but below the new floor NOW + 62
    w.reports.set(16n, healthy(16n, NOW + 62));
    h.k.state.feedRound = { enabledAt: NOW + 2, rigs: inRound ? ["17"] : [] };
    await tick(h, w, 600);
    expect(h.bsc.calls.map((c) => c.functionName)).toEqual(inRound ? ["push", "push", "push"] : ["push", "push"]);
    expect(h.bsc.calls.map((c) => c.args)).toEqual(inRound ? [[[17n]], [[17n]], [[16n]]] : [[[17n]], [[16n, 17n]]]);
    expect(labels(h.bsc)).toEqual(inRound
      ? [`unknown-push [17] for ${incident}`, "enable-push [17]", `unknown-push [16] for ${incident}`]
      : [`unknown-push [17] for ${incident}`, `unknown-push [16,17] for ${incident}`]);
    expect(h.k.state.refresh[`${incident}:16`]).toMatchObject({ unknown: true, pushAt: w.now, storedBefore: NOW + 62 });
    expect(h.k.state.refresh[`${incident}:17`]).toMatchObject({ pushAt: w.now, storedBefore: NOW + 61 });
    expect(h.k.state.refresh[`${incident}:17`]?.sentAt).toBeUndefined();
    const restarted = keeperIn(w, structuredClone(h.k.state));
    await tick(restarted, w, 1); // first confirmation after restart
    expect(restarted.bsc.calls).toEqual([]);
    await tick(restarted, w, 599);
    expect(restarted.bsc.calls.map((c) => c.functionName)).toEqual(["harvest"]);
    expect(restarted.bsc.calls[0]!.args).toEqual([[16n, 17n]]);
    await tick(restarted, w, 600);
    await tick(restarted, w, 600);
    expect(restarted.bsc.calls).toHaveLength(1);
    expect(restarted.alerts.filter((a) => a.includes("owner review"))).toHaveLength(2);
    for (const id of [16n, 17n]) {
      expect(restarted.alerts.filter((a) => a.includes(`owner review: rig ${id} `))).toHaveLength(1);
      expect(restarted.k.state.refresh[`${incident}:${id}`]).toMatchObject({ unknown: true, pushAt: NOW + 601, sentAt: NOW + 1_201, recoveryAlerted: true });
    }
  });

  it("alerts once after three down BSC cycles before any recovery send, across restart", async () => {
    const w = unknownWorld(), h = keeperIn(w, outsideRound());
    w.bscDown.add(17n);
    await h.cycle(expiredLoan());
    await tick(h, w, 1);
    expect(h.alerts.filter((a) => a.includes("owner review"))).toEqual([]);
    const restarted = keeperIn(w, structuredClone(h.k.state));
    await tick(restarted, w, 1);
    expect(restarted.alerts.filter((a) => a.includes("owner review: rig 17"))).toHaveLength(1);
    await tick(restarted, w, 600);
    expect(restarted.alerts.filter((a) => a.includes("owner review: rig 17"))).toHaveLength(1);
    expect(h.bsc.calls).toEqual([]); expect(restarted.bsc.calls).toEqual([]);
    expect(restarted.xlayer.calls).toEqual([]);
  });

  it.each(["unknown-push", "enable-push", "row-B"])("alerts once when BSC goes down after a counted %s, without harvesting", async (source) => {
    const w = unknownWorld(), h = keeperIn(w, outsideRound());
    if (source === "enable-push") h.k.state.feedRound!.rigs = ["17"];
    await h.cycle(expiredLoan());
    await tick(h, w, 1);
    expect(h.bsc.calls.map((c) => c.functionName)).toEqual(["push"]);
    expect(h.k.state.refresh[`${incident}:17`]?.pushAt).toBeDefined();
    if (source === "row-B") w.reports.set(17n, impairedAt(17n, w.now));
    const before = h.bsc.calls.length;
    w.bscDown.add(17n);
    await tick(h, w, 600);
    await tick(h, w, 1);
    expect(h.alerts.filter((a) => a.includes("owner review"))).toEqual([]);
    const restarted = keeperIn(w, structuredClone(h.k.state));
    await tick(restarted, w, 1);
    expect(restarted.alerts.filter((a) => a.includes("owner review: rig 17"))).toHaveLength(1);
    await tick(restarted, w, 600);
    expect(restarted.alerts.filter((a) => a.includes("owner review: rig 17"))).toHaveLength(1);
    expect(h.bsc.calls).toHaveLength(before); expect(restarted.bsc.calls).toEqual([]);
    expect(restarted.k.state.refresh[`${incident}:17`]?.sentAt).toBeUndefined();
  });

  it("uses the terminal timer after harvesting even if row U becomes B and BSC is down", async () => {
    const w = unknownWorld(), h = keeperIn(w, outsideRound());
    await h.cycle(expiredLoan());
    await tick(h, w, 1);
    w.reports.set(17n, impairedAt(17n, w.now));
    await tick(h, w, 1);
    expect(h.bsc.calls.map((c) => c.functionName)).toEqual(["push", "harvest"]);
    w.bscDown.add(17n);
    for (let i = 0; i < 3; i++) await tick(h, w, 1);
    expect(h.alerts.filter((a) => a.includes("owner review"))).toEqual([]);
    await tick(h, w, 597);
    expect(h.alerts.filter((a) => a.includes("owner review: rig 17"))).toHaveLength(1);
    expect(h.bsc.calls).toHaveLength(2);
  });

  it.each([16n, 17n])("pushes rig %s outside the enable snapshot, harvests once, then alerts once across restart", async (id) => {
    const w = unknownWorld(id), h = keeperIn(w, outsideRound()), loan = expiredLoan();
    await h.cycle(loan);
    expect(h.bsc.calls).toEqual([]); // two-cycle BSC confirmation
    await tick(h, w, 1);
    expect(labels(h.bsc)).toEqual([`unknown-push [${id}] for ${incident}`]);
    await tick(h, w, 599);
    expect(h.bsc.calls).toHaveLength(1);
    await tick(h, w, 1);
    expect(labels(h.bsc)).toEqual([`unknown-push [${id}] for ${incident}`, `refresh-harvest [${id}] for ${incident}`]);
    await tick(h, w, 599);
    expect(h.alerts.filter((a) => a.includes("owner review"))).toEqual([]);
    await tick(h, w, 1);
    expect(h.alerts.filter((a) => a.includes(`owner review: rig ${id}`))).toHaveLength(1);
    await tick(h, w, 3_600);
    expect(h.bsc.calls).toHaveLength(2);
    expect(h.xlayer.calls).toEqual([]);
    const restarted = keeperIn(w, structuredClone(h.k.state));
    await tick(restarted, w, 3_600);
    await tick(restarted, w, 1);
    expect(restarted.bsc.calls).toEqual([]);
    expect(restarted.alerts).toEqual([]);
    expect(restarted.xlayer.calls).toEqual([]);
  });

  it("waits for X Layer time E + 90 and withholds both steps while BSC is unconfirmed", async () => {
    const w = unknownWorld(), h = keeperIn(w, outsideRound());
    w.xNow = E + 89;
    await h.cycle(expiredLoan());
    await h.cycle(expiredLoan());
    expect(h.bsc.calls).toEqual([]);
    w.xNow = null;
    await h.cycle(expiredLoan());
    expect(h.bsc.calls).toEqual([]);
    w.xNow = E + 90;
    await h.cycle(expiredLoan());
    expect(labels(h.bsc)).toEqual([`unknown-push [17] for ${incident}`]);
    w.bscDown.add(17n);
    await tick(h, w, 600);
    expect(h.bsc.calls).toHaveLength(1);
    w.bscDown.clear();
    await tick(h, w, 1);
    await tick(h, w, 1);
    expect(h.bsc.calls).toHaveLength(2);
  });

  it("clears on a landed healthy push without harvesting", async () => {
    const w = unknownWorld(), h = keeperIn(w, outsideRound());
    await h.cycle(expiredLoan());
    await tick(h, w, 1);
    w.reports.set(17n, healthy(17n, w.now));
    await tick(h, w, 1);
    expect(h.bsc.calls).toHaveLength(1);
    expect(labels(h.xlayer)).toEqual([`clearExpiredFlag ${AGENT}`]);
  });

  it.each(["unknown-push", "enable-push"])("restores a %s from the pending journal without buying another push", async (label) => {
    const w = unknownWorld(), state = outsideRound();
    const text = label === "unknown-push" ? `${label} [17] for ${incident}` : `${label} [17]`;
    state.pendingTx.bsc.push({ label: text, address: D.reporter, data: "0x", value: "0", urgency: "routine", nonce: 0, hash: "0x01", hashes: ["0x01"], gasPrice: "1", sentAt: NOW - 10 });
    if (label === "unknown-push") w.reports.set(17n, impairedAt(17n, NOW - 10)); // row changed after broadcast
    const h = keeperIn(w, state);
    await h.cycle(expiredLoan());
    await tick(h, w, 600);
    expect(h.bsc.calls.map((c) => c.functionName)).toEqual(["harvest"]);
    expect(h.k.state.refresh[`${incident}:17`]).toMatchObject({ pushAt: NOW - 10, unknown: true, sentAt: NOW + 600 });
  });

  it("keeps the recovery allowance after U is overwritten by B, and stops after the harvest", async () => {
    const w = unknownWorld(), h = keeperIn(w, outsideRound());
    await h.cycle(expiredLoan());
    await tick(h, w, 1);
    w.reports.set(17n, impairedAt(17n, w.now + 1));
    await tick(h, w, 1); // the push landed but still blocks
    expect(h.bsc.calls.map((c) => c.functionName)).toEqual(["push", "harvest"]);
    await tick(h, w, 600);
    await tick(h, w, 3_600);
    expect(h.bsc.calls).toHaveLength(2);
    expect(h.alerts.filter((a) => a.includes("owner review"))).toHaveLength(1);
  });

  it("holds the harvest at the reserve and permits it exactly at reserve plus fee", async () => {
    const w = unknownWorld(), h = keeperIn(w, outsideRound());
    await h.cycle(expiredLoan());
    await tick(h, w, 1);
    w.balance = 10_000_000_000_000_000n + 1_099n;
    await tick(h, w, 600);
    expect(h.bsc.calls).toHaveLength(1);
    expect(h.k.state.refresh[`${incident}:17`]?.sentAt).toBeUndefined();
    w.balance++;
    await tick(h, w, 1);
    expect(h.bsc.calls.map((c) => c.functionName)).toEqual(["push", "harvest"]);
    expect(h.bsc.calls[1]!.value).toBe(1_100n);
  });

  it("covers an initially unflagged two-rig loan, a later flag, and unknown on the other rig at expiry", async () => {
    const enabled = NOW - 6 * 86_400;
    const w = world({ now: enabled + 90, xNow: enabled + 90, feedEnabledAt: enabled,
      reports: new Map([[16n, healthy(16n, enabled + 60)], [17n, healthy(17n, enabled + 60)]]),
      records: new Map([[16n, { syncedAt: enabled, power: 500n }], [17n, { syncedAt: enabled, power: 500n }]]) });
    const h = keeperIn(w);
    await h.cycle(loanOf({}, [16n, 17n]));
    expect(h.k.state.feedRound).toEqual({ enabledAt: enabled, rigs: [] });
    const flagAt = enabled + 120, floor = flagAt + 72 * 3_600 + 60;
    const loan = loanOf({ impairedAt: flagAt, seizeStart: floor - 60, deadline: flagAt + 96 * 3_600, expired: false, impairedRig: 16n }, [16n, 17n]);
    await tick(h, w, 31, loan); // this flag was not in the first enable snapshot
    w.now = loan.loan.deadline + 1; w.xNow = w.now; loan.loan.expired = true; w.seizeFrom = floor;
    // A later brake permits a stored report above the seize floor to become row U.
    w.feedDisabled = true;
    w.reports.set(16n, null);
    w.reports.set(17n, healthy(17n, w.now - 10));
    w.records.set(16n, { syncedAt: w.now - 20, power: 500n });
    w.records.set(17n, { syncedAt: floor, power: 500n });
    await h.cycle(loan);
    const check = () => {
      const feed = { disabled: w.feedDisabled, enabledAt: Number(w.feedEnabledAt) };
      const codes = loan.collateral.map((id) => verdictCode(clearReading(id, floor, w.now, feed, w.reports.get(id), w.records.get(id)).verdict));
      const production = CLEAR_PAIRS[0]!; // actual RigAgent verdicts and NoHealthEvidence result from Forge
      expect(codes).toEqual([production.flaggedVerdict, production.otherVerdict]);
      const permits = loan.collateral.every((id) => !clearPlan(id, 16n, floor, w.now, w.reports.get(id), w.records.get(id), {}, { feed, confirmed: "healthy" }).blocks);
      expect(permits).toBe(production.allowed);
      const rigs = loan.collateral.map((id): RigView => ({ id, confirmed: "healthy", passSuspended: true, lastPushAt: 0, storedObservedAt: Number(w.reports.get(id)?.observedAt ?? 0), report: w.reports.get(id), voucherSyncedAt: w.records.get(id)?.syncedAt, voucherPower: w.records.get(id)?.power }));
      expect(nextActions({ now: w.now, loan: loan.loan, rigs, feedDisabled: w.feedDisabled, feedEnabledAt: feed.enabledAt, seizeEvidenceFrom: floor, suspendOnRevoke: false }).some((a) => a.kind === "clear")).toBe(false);
    };
    check();
    w.feedDisabled = false; w.feedEnabledAt = w.now;
    await h.cycle(loan);
    check();
    await tick(h, w, 89, loan);
    expect(h.bsc.calls).toEqual([]);
    await tick(h, w, 1, loan);
    expect(labels(h.bsc)).toEqual(["enable-push [16,17]"]);
    await tick(h, w, 600, loan);
    expect(h.bsc.calls.filter((c) => c.functionName === "push")).toHaveLength(1);
    expect(h.bsc.calls.filter((c) => c.functionName === "harvest")).toHaveLength(1);
    expect(h.xlayer.calls).toEqual([]);
    w.records.set(17n, { syncedAt: w.now, power: 500n });
    await tick(h, w, 1, loan);
    expect(labels(h.xlayer)).toEqual([`clearExpiredFlag ${AGENT}`]);
  });
});

describe("RB4-08 row N and bounded recovery", () => {
  const FLOOR = IMPAIRED_AT + 72 * 3_600 + MAX_CLOCK_SKEW, E = FLOOR - 120;
  const incident = `${AGENT.toLowerCase()}:1000:${IMPAIRED_AT}`;
  const cases = [16n, 17n].flatMap((id) => [false, true].map((insane) => ({ id, insane })));
  const nReport = (id: bigint, insane: boolean, now = NOW) => healthy(id, insane ? now : FLOOR + 2,
    insane ? { totalVerifWeight: 0n } : {});
  const nWorld = (id: bigint, insane = false) => world({ feedEnabledAt: E, seizeFrom: FLOOR,
    reports: new Map([[16n, id === 16n ? nReport(id, insane) : null], [17n, id === 17n ? nReport(id, insane) : null]]),
    records: new Map([[16n, { syncedAt: FLOOR, power: 500n }], [17n, { syncedAt: FLOOR, power: 500n }]]) });
  const outsideRound = () => {
    const state = emptyState(1n, D.factory);
    state.feedRound = { enabledAt: E, rigs: [] };
    return state;
  };
  const tick = async (h: ReturnType<typeof keeperIn>, w: World, dt: number, loan = expiredLoan()) => {
    w.now += dt; w.xNow = w.now;
    await h.cycle(loan);
  };
  const review = (h: ReturnType<typeof keeperIn>, id: bigint) => h.alerts.filter((a) => a.includes(`owner review: rig ${id} `));
  const reading = (w: World, id: bigint) => clearReading(id, w.seizeFrom, w.now,
    { disabled: w.feedDisabled, enabledAt: Number(w.feedEnabledAt) }, w.reports.get(id), w.records.get(id));
  const view = (w: World, id: bigint, confirmed: RigView["confirmed"] = "healthy"): RigView => ({
    id, confirmed, passSuspended: true, lastPushAt: w.now - 3_600,
    storedObservedAt: Number(w.reports.get(id)?.observedAt ?? 0), report: w.reports.get(id),
    voucherSyncedAt: w.records.get(id)?.syncedAt, voucherPower: w.records.get(id)?.power,
  });
  const machine = (w: World): MachineInput => ({ now: w.now, loan: expiredLoan().loan,
    rigs: [view(w, 16n), view(w, 17n)], feedDisabled: w.feedDisabled, feedEnabledAt: Number(w.feedEnabledAt),
    flagEvidenceFrom: NOW - 100, seizeEvidenceFrom: FLOOR, suspendOnRevoke: false });
  const pushed = async (id: bigint, insane = false) => {
    const w = nWorld(id, insane), h = keeperIn(w, outsideRound());
    await h.cycle(expiredLoan());
    expect(h.bsc.calls).toEqual([]);
    expect(h.xlayer.calls).toEqual([]);
    await tick(h, w, 1);
    expect(labels(h.bsc)).toEqual([`unknown-push [${id}] for ${incident}`]);
    expect(h.bsc.calls[0]!.args).toEqual([[id]]);
    expect(h.k.state.refresh[`${incident}:${id}`]).toMatchObject({ unknown: true, pushAt: NOW + 1 });
    expect(h.k.state.refresh[`${incident}:${id}`]?.sentAt).toBeUndefined();
    expect(h.xlayer.calls).toEqual([]);
    return { w, h };
  };

  it.each(cases)("rejects N on rig $id, insane=$insane, with absent, false or wrongly true clearAllowed", ({ id, insane }) => {
    const w = nWorld(id, insane), m = machine(w);
    expect(reading(w, id)).toEqual({ verdict: "unknown", row: "N" });
    const plan = clearPlan(id, 16n, FLOOR, NOW, w.reports.get(id), w.records.get(id), {},
      { feed: { disabled: false, enabledAt: E }, confirmed: "healthy" });
    expect(plan).toMatchObject({ blocks: true, verdict: "unknown", row: "N", pushOnce: true, harvest: false });
    for (const clearAllowed of [undefined, false, true]) {
      expect(nextActions({ ...m, clearAllowed })).toEqual([]);
    }
    const at = Number(w.reports.get(id)!.observedAt);
    w.records.set(id, { syncedAt: at + 1, power: 500n });
    expect(reading(w, id)).toEqual({ verdict: "healthy", row: "VC" });
    expect(nextActions(machine(w))).toEqual([{ kind: "clear" }]);
    expect(nextActions({ ...machine(w), clearAllowed: false })).toEqual([]);
    expect(nextActions({ ...machine(w), clearAllowed: true })).toEqual([{ kind: "clear" }]);
  });

  it.each(["N", "U", "B", "VC"])("keeps a confirmed suspect's impairment push after N becomes %s", (row) => {
    const w = nWorld(17n);
    if (row === "U") w.feedEnabledAt = NOW - 100;
    if (row === "B") w.reports.set(17n, impairedAt(17n, FLOOR + 2));
    if (row === "VC") w.records.set(17n, { syncedAt: FLOOR, power: 0n });
    expect(reading(w, 17n).row).toBe(row);
    const m = { ...machine(w), rigs: [view(w, 16n), view(w, 17n, "stopped")] };
    expect(nextActions(m)).toEqual([{ kind: "push", rigs: [17n] }]);
    expect(nextActions({ ...m, recoveryRigs: [17n] })).toEqual([{ kind: "push", rigs: [17n] }]);
    w.reports.set(17n, impairedAt(17n, NOW));
    expect(nextActions({ ...m, rigs: [view(w, 16n), view(w, 17n, "stopped")], recoveryRigs: [17n] }))
      .toEqual([{ kind: "flag", rig: 17n }]); // new evidence still starts a new flag incident
  });

  it.each(cases)("replaces the scan's B with N on rig $id, insane=$insane, pushes once and clears on landed H", async ({ id, insane }) => {
    const w = nWorld(id, insane), h = keeperIn(w, outsideRound());
    w.reports.set(id, impairedAt(id, FLOOR + 1));
    await h.cycle(expiredLoan());
    expect(reading(w, id)).toEqual({ verdict: "impaired", row: "B" });
    expect(h.bsc.calls).toEqual([]); expect(h.xlayer.calls).toEqual([]);
    w.reports.set(id, nReport(id, insane, NOW + 1));
    await tick(h, w, 1);
    expect(reading(w, id)).toEqual({ verdict: "unknown", row: "N" });
    expect(labels(h.bsc)).toEqual([`unknown-push [${id}] for ${incident}`]);
    expect(h.bsc.calls[0]!.args).toEqual([[id]]);
    expect(h.k.state.refresh[`${incident}:${id}`]).toMatchObject({ unknown: true, pushAt: NOW + 1 });
    expect(h.xlayer.calls).toEqual([]);
    w.reports.set(id, healthy(id, NOW + 2));
    await tick(h, w, 1);
    expect(reading(w, id)).toEqual({ verdict: "healthy", row: "H" });
    expect(h.bsc.calls).toHaveLength(1);
    expect(labels(h.xlayer)).toEqual([`clearExpiredFlag ${AGENT}`]);
    expect(review(h, id)).toEqual([]);
  });

  it("owns the 995-second-old flagged report's single push instead of the ordinary cooldown loop", async () => {
    const now = 1_000_000;
    const loan = loanOf({ impairedAt: 1, seizeStart: now - 10_000, deadline: now - 5_000, expired: true, impairedRig: 16n });
    const w = world({ now: now - 1_001, xNow: now - 1_001, seizeFrom: loan.loan.seizeStart,
      reports: new Map([[16n, healthy(16n, loan.loan.seizeStart + 2)]]), records: new Map() });
    const h = keeperIn(w);
    await h.cycle(loan);
    await tick(h, w, 1, loan);
    const key = `${AGENT.toLowerCase()}:1000:1:16`;
    expect(labels(h.bsc)).toEqual([`unknown-push [16] for ${AGENT.toLowerCase()}:1000:1`]);
    w.reports.set(16n, healthy(16n, now - 995)); // lands five seconds after the counted push
    await tick(h, w, 1_000, loan); // next observation matches logic.test.ts exactly; H has aged into N
    expect(w.now).toBe(now);
    expect(h.k.state.lastPushAt["16"]).toBe(now - 1_000);
    expect(Number(w.reports.get(16n)!.observedAt)).toBe(now - 995);
    expect(h.k.state.refresh[key]).toMatchObject({ unknown: true, pushAt: now - 1_000, sentAt: now });
    expect(h.bsc.calls.map((c) => c.functionName)).toEqual(["push", "harvest"]);
    await tick(h, w, 3_600, loan);
    expect(h.bsc.calls.map((c) => c.functionName)).toEqual(["push", "harvest"]);
    expect(h.xlayer.calls).toEqual([]);
    expect(review(h, 16n)).toHaveLength(1);
  });

  it.each(cases)("waits 600 s for rig $id, insane=$insane, then harvests and alerts once across persisted restart", async ({ id, insane }) => {
    const { w, h } = await pushed(id, insane);
    const path = fileURLToPath(new URL(`../../out/rb4-08-${id}-${insane}-spent-state.json`, import.meta.url));
    let state: KeeperState;
    try {
      saveState(path, h.k.state);
      state = loadState(path, 1n, D.factory);
    } finally {
      unlinkSync(path);
    }
    const restarted = keeperIn(w, state);
    await tick(restarted, w, 1);
    await tick(restarted, w, 598);
    expect(restarted.bsc.calls).toEqual([]); // 599 seconds after the push
    expect(restarted.xlayer.calls).toEqual([]);
    await tick(restarted, w, 1);
    expect(labels(restarted.bsc)).toEqual([`refresh-harvest [${id}] for ${incident}`]);
    expect(restarted.bsc.calls[0]!.args).toEqual([[id]]);
    await tick(restarted, w, 599);
    expect(review(restarted, id)).toEqual([]);
    await tick(restarted, w, 1);
    expect(review(restarted, id)).toHaveLength(1);
    await tick(restarted, w, 3_600);
    expect(restarted.bsc.calls).toHaveLength(1); expect(restarted.xlayer.calls).toEqual([]);
    const again = keeperIn(w, structuredClone(restarted.k.state));
    await tick(again, w, 3_600);
    await tick(again, w, 1);
    expect(again.bsc.calls).toEqual([]); expect(again.xlayer.calls).toEqual([]); expect(again.alerts).toEqual([]);
  });

  it.each(cases)("harvests once when rig $id's push lands still N, insane=$insane", async ({ id, insane }) => {
    const { w, h } = await pushed(id, insane);
    const sentAt = w.now;
    w.reports.set(id, healthy(id, sentAt + 1, insane ? { totalVerifWeight: 0n } : {}));
    await tick(h, w, insane ? 1 : 302); // fresh insane, or already stale but before the 600 s timeout
    expect(reading(w, id)).toEqual({ verdict: "unknown", row: "N" });
    expect(w.now - sentAt).toBeLessThan(600);
    expect(labels(h.bsc)).toEqual([`unknown-push [${id}] for ${incident}`, `refresh-harvest [${id}] for ${incident}`]);
    expect(h.k.state.refresh[`${incident}:${id}`]).toMatchObject({ unknown: true, pushAt: sentAt, sentAt: w.now });
    expect(h.xlayer.calls).toEqual([]);
    await tick(h, w, 600);
    await tick(h, w, 3_600);
    expect(h.bsc.calls).toHaveLength(2); expect(review(h, id)).toHaveLength(1);
  });

  it.each([16n, 17n].flatMap((id) => ["unknown-push", "enable-push"].map((label) => ({ id, label }))))
    ("restores $label for rig $id from the pending journal without another push", async ({ id, label }) => {
      const w = nWorld(id), state = outsideRound();
      state.pendingTx.bsc.push({ label: label === "unknown-push" ? `${label} [${id}] for ${incident}` : `${label} [${id}]`,
        address: D.reporter, data: "0x", value: "0", urgency: "routine", nonce: 0, hash: "0x01", hashes: ["0x01"], gasPrice: "1", sentAt: NOW - 10 });
      if (label === "unknown-push") w.reports.set(id, impairedAt(id, FLOOR + 3)); // N changed to B before restart
      const h = keeperIn(w, state);
      await h.cycle(expiredLoan());
      expect(h.bsc.calls).toEqual([]);
      await tick(h, w, 600);
      expect(labels(h.bsc)).toEqual([`refresh-harvest [${id}] for ${incident}`]);
      expect(h.k.state.refresh[`${incident}:${id}`]).toMatchObject({ unknown: true, pushAt: NOW - 10, sentAt: w.now });
      await tick(h, w, 600);
      await tick(h, w, 3_600);
      expect(h.bsc.calls).toHaveLength(1); expect(review(h, id)).toHaveLength(1); expect(h.xlayer.calls).toEqual([]);
    });

  it.each([16n, 17n].flatMap((id) => ["U", "B", "VC"].map((row) => ({ id, row }))))
    ("keeps rig $id's one budget when N changes to $row", async ({ id, row }) => {
      const { w, h } = await pushed(id);
      if (row === "U") {
        w.feedDisabled = true;
        await tick(h, w, 1);
        expect(reading(w, id).row).toBe("U");
        expect(h.bsc.calls).toHaveLength(1);
        w.feedDisabled = false; w.feedEnabledAt = w.now;
        const other = id === 16n ? 17n : 16n;
        w.reports.set(other, healthy(other, w.now + 60));
        w.records.set(other, { syncedAt: w.now + 61, power: 500n });
        await tick(h, w, 90);
        expect(reading(w, id).row).toBe("U");
      } else if (row === "B") {
        w.reports.set(id, impairedAt(id, w.now + 1));
        await tick(h, w, 1);
        expect(reading(w, id).row).toBe("B");
      } else {
        w.records.set(id, { syncedAt: w.now + 1, power: 0n });
        await tick(h, w, 1);
        expect(reading(w, id).row).toBe("VC");
      }
      const restarted = keeperIn(w, structuredClone(h.k.state));
      await tick(restarted, w, 1);
      await tick(restarted, w, 600);
      await tick(restarted, w, 600);
      await tick(restarted, w, 3_600);
      const calls = [...h.bsc.calls, ...restarted.bsc.calls];
      expect(calls.filter((c) => c.functionName === "push").map((c) => c.args)).toEqual([[[id]]]);
      expect(calls.filter((c) => c.functionName === "harvest").map((c) => c.args)).toEqual([[[id]]]);
      expect([...review(h, id), ...review(restarted, id)].filter((a) => a.includes("after its recovery push and harvest"))).toHaveLength(1);
      expect(restarted.k.state.refresh[`${incident}:${id}`]).toMatchObject({ unknown: true, pushAt: NOW + 1, recoveryAlerted: true });
      expect(h.xlayer.calls).toEqual([]); expect(restarted.xlayer.calls).toEqual([]);
    });

  it.each([16n, 17n])("withholds rig %s's N push until X Layer E + 90 and healthy BSC confirmation", async (id) => {
    const w = nWorld(id, true), state = outsideRound();
    w.feedEnabledAt = NOW - 100; state.feedRound = { enabledAt: NOW - 100, rigs: [] };
    w.xNow = NOW - 11;
    const h = keeperIn(w, state);
    await h.cycle(expiredLoan()); await h.cycle(expiredLoan());
    expect(h.bsc.calls).toEqual([]);
    w.xNow = null;
    await h.cycle(expiredLoan());
    expect(h.bsc.calls).toEqual([]);
    w.xNow = NOW - 10;
    await h.cycle(expiredLoan());
    expect(labels(h.bsc)).toEqual([`unknown-push [${id}] for ${incident}`]);
    expect(h.xlayer.calls).toEqual([]);
  });

  it.each([16n, 17n])("holds rig %s's N harvest at the reserve and sends exactly at reserve plus fee", async (id) => {
    const { w, h } = await pushed(id);
    w.balance = 10_000_000_000_000_000n + 1_099n;
    await tick(h, w, 600);
    expect(h.bsc.calls).toHaveLength(1);
    expect(h.k.state.refresh[`${incident}:${id}`]?.sentAt).toBeUndefined();
    w.balance++;
    await tick(h, w, 1);
    expect(h.bsc.calls.map((c) => c.functionName)).toEqual(["push", "harvest"]);
    expect(h.bsc.calls[1]!.value).toBe(1_100n);
    expect(h.xlayer.calls).toEqual([]);
  });
});

describe("RB4-09 impairment progress, provenance and notification budgets", () => {
  const FLOOR = IMPAIRED_AT + 72 * 3_600 + MAX_CLOCK_SKEW, E = FLOOR - 120;
  const incident = `${AGENT.toLowerCase()}:1000:${IMPAIRED_AT}`;
  const key = (id: bigint) => `${incident}:${id}`;
  const snapshot = (phase: "none" | "window" | "expired", ids = [16n, 17n]) => phase === "none" ? loanOf({}, ids)
    : phase === "expired" ? expiredLoan(ids)
    : loanOf({ impairedAt: IMPAIRED_AT, seizeStart: FLOOR - 60, deadline: NOW + 86_400, impairedRig: 16n }, ids);
  const nWorld = (id = 17n) => world({ flagFrom: NOW - 100, seizeFrom: FLOOR, feedEnabledAt: E,
    reports: new Map([[16n, id === 16n ? healthy(id, FLOOR + 2) : null], [17n, id === 17n ? healthy(id, FLOOR + 2) : null]]),
    records: new Map([[16n, { syncedAt: FLOOR, power: 500n }], [17n, { syncedAt: FLOOR, power: 500n }]]) });
  const stateOf = (w: World) => {
    const state = emptyState(1n, D.factory);
    state.feedRound = { enabledAt: Number(w.feedEnabledAt), rigs: [] };
    return state;
  };
  const tick = async (h: ReturnType<typeof keeperIn>, w: World, dt: number, loan = expiredLoan()) => {
    w.now += dt; w.xNow = w.now;
    await h.cycle(loan);
  };
  const pushes = (h: ReturnType<typeof keeperIn>) => h.bsc.calls.filter((c) => c.functionName === "push");
  const harvests = (h: ReturnType<typeof keeperIn>) => h.bsc.calls.filter((c) => c.functionName === "harvest");
  const notices = (h: ReturnType<typeof keeperIn>) => h.alerts.filter((a) => a.includes("remains suspect"));
  const terminal = (h: ReturnType<typeof keeperIn>) => h.alerts.filter((a) => a.includes("after its recovery push and harvest"));
  const refuse = (h: ReturnType<typeof keeperIn>, result: SendResult = { status: "waiting", reason: "RPC unavailable" }) => {
    h.bsc.send = async (call) => { h.bsc.calls.push(call); return result; };
  };
  const persisted = (state: KeeperState, name: string) => {
    const path = fileURLToPath(new URL(`../../out/rb4-09-${name}.json`, import.meta.url));
    try { saveState(path, state); return loadState(path, 1n, D.factory); }
    finally { unlinkSync(path); }
  };
  const selectionCases = (["none", "window", "expired"] as const).flatMap((phase) => [false, true].flatMap((reverse) =>
    ["cooldown", "unlanded"].flatMap((busy) => [false, true].map((evidence) => ({ phase, reverse, busy, evidence })))));
  it.each(selectionCases)("services the second suspect: $phase reverse=$reverse $busy evidence=$evidence", ({ phase, reverse, busy, evidence }) => {
    const ids = reverse ? [17n, 16n] : [16n, 17n];
    const rigs: RigView[] = ids.map((id, i) => ({ id, confirmed: "revoked", passSuspended: true,
      lastPushAt: i === 0 ? NOW - (busy === "cooldown" ? 30 : 700) : NOW - 3_600,
      storedObservedAt: i === 0 && busy === "cooldown" ? NOW - 30 : 0,
      report: i === 1 && evidence ? impairedAt(id, NOW) : null }));
    expect(evidenceKind(ids[0]!, NOW - 100, NOW, { disabled: false, enabledAt: E }, rigs[0]!.report, undefined)).toBe(0);
    expect(evidenceKind(ids[1]!, NOW - 100, NOW, { disabled: false, enabledAt: E }, rigs[1]!.report, undefined)).toBe(evidence ? 1 : 0);
    expect(nextActions({ now: NOW, loan: snapshot(phase, ids).loan, rigs, feedDisabled: false, feedEnabledAt: E,
      flagEvidenceFrom: NOW - 100, seizeEvidenceFrom: NOW - 100, suspendOnRevoke: false, recoveryRigs: [16n] }))
      .toEqual(evidence ? phase === "window" ? [{ kind: "seize" }] : [{ kind: "flag", rig: ids[1] }]
        : [{ kind: "push", rigs: [ids[1]] }]);
  });

  it.each((["none", "window", "expired"] as const).flatMap((phase) => [false, true].map((reverse) => ({ phase, reverse }))))
    ("batches every due suspect: $phase reverse=$reverse", ({ phase, reverse }) => {
      const ids = reverse ? [17n, 16n] : [16n, 17n];
      expect(nextActions({ now: NOW, loan: snapshot(phase, ids).loan, feedDisabled: false, suspendOnRevoke: false,
        recoveryRigs: [16n], rigs: ids.map((id) => ({ id, confirmed: "revoked", passSuspended: true, report: null, storedObservedAt: 0, lastPushAt: 0 })) }))
        .toEqual([{ kind: "push", rigs: ids }]);
    });

  it.each([false, true])("suspends every qualifying suspect before selecting evidence, K-O5=%s", (suspendOnRevoke) => {
    const rigs: RigView[] = [16n, 17n, 18n].map((id) => ({ id, confirmed: id === 17n ? "revoked" : "rescue",
      passSuspended: id === 18n, report: impairedAt(id, NOW), storedObservedAt: NOW, lastPushAt: NOW }));
    const m: MachineInput = { now: NOW, loan: loanOf().loan, rigs, feedDisabled: false, suspendOnRevoke, flagEvidenceFrom: NOW };
    expect(nextActions(m)).toEqual([{ kind: "suspend", rig: 16n }, ...(suspendOnRevoke ? [{ kind: "suspend", rig: 17n }] : []), { kind: "flag", rig: 16n }]);
    expect(nextActions({ ...m, loan: { ...snapshot("window").loan, seizeStart: NOW + 1 } })).toEqual([]);
    expect(nextActions({ ...m, loan: { ...m.loan, open: false } })).toEqual([]);
  });

  it.each([false, true])("services a confirmed suspect before an allowed expired clear, evidence=%s", (hasEvidence) => {
    const rigs: RigView[] = [16n, 17n].map((id) => ({ id, confirmed: id === 16n ? "healthy" : "revoked", passSuspended: true,
      lastPushAt: NOW - 3_600, storedObservedAt: NOW - 1,
      report: id === 17n && hasEvidence ? impairedAt(id, NOW - 1) : healthy(id, NOW - 1), voucherSyncedAt: NOW, voucherPower: 500n }));
    expect(rigs.map((r) => clearReading(r.id, FLOOR, NOW, { disabled: false, enabledAt: E }, r.report,
      { syncedAt: r.voucherSyncedAt!, power: r.voucherPower! }).verdict)).toEqual(["healthy", "healthy"]);
    expect(nextActions({ now: NOW, loan: expiredLoan().loan, rigs, feedDisabled: false, suspendOnRevoke: false,
      flagEvidenceFrom: NOW - 100, seizeEvidenceFrom: FLOOR, clearAllowed: true, recoveryRigs: [17n] }))
      .toEqual(hasEvidence ? [{ kind: "flag", rig: 17n }] : [{ kind: "push", rigs: [17n] }]);
    expect(nextActions({ now: NOW, loan: expiredLoan().loan, rigs, feedDisabled: true, suspendOnRevoke: false,
      flagEvidenceFrom: NOW - 100, seizeEvidenceFrom: FLOOR, clearAllowed: true, recoveryRigs: [17n] }))
      .toEqual([{ kind: "clear" }]);
  });

  it("withholds an expired clear for a suspect with the feed on, and permits it with the feed off", () => {
    const rigs: RigView[] = [16n, 17n].map((id) => ({ id, confirmed: id === 16n ? "healthy" : "revoked", passSuspended: true,
      lastPushAt: NOW - 3_600, storedObservedAt: NOW - 1, report: healthy(id, NOW - 1), voucherSyncedAt: NOW, voucherPower: 500n }));
    const m: MachineInput = { now: NOW, loan: expiredLoan().loan, rigs, feedDisabled: false, suspendOnRevoke: false,
      flagEvidenceFrom: NOW - 100, seizeEvidenceFrom: FLOOR, clearAllowed: true, recoveryRigs: [17n] };
    expect(nextActions(m)).toEqual([{ kind: "push", rigs: [17n] }]);
    expect(nextActions({ ...m, feedDisabled: true })).toEqual([{ kind: "clear" }]);
    const afterClear = { ...m, loan: loanOf({}, [16n, 17n]).loan, flagEvidenceFrom: NOW + MAX_CLOCK_SKEW };
    expect(nextActions(afterClear)).toEqual([{ kind: "push", rigs: [17n] }]);
    expect(nextActions({ ...afterClear, now: NOW + MAX_CLOCK_SKEW,
      rigs: [rigs[0]!, { ...rigs[1]!, report: impairedAt(17n, NOW + MAX_CLOCK_SKEW) }] }))
      .toEqual([{ kind: "flag", rig: 17n }]);
  });

  const progression = [
    { name: "another rig N revoked", id: 17n, condition: "revoked", mode: "N" },
    { name: "flagged H aged into N revoked", id: 16n, condition: "revoked", mode: "aged" },
    { name: "both revoked, one in recovery", id: 16n, condition: "revoked", mode: "both" },
    { name: "spent recovery then revoked", id: 17n, condition: "revoked", mode: "spent" },
    { name: "row U below enable floor revoked", id: 17n, condition: "revoked", mode: "U" },
    { name: "stopped", id: 17n, condition: "stopped", mode: "N" },
    { name: "rescued", id: 17n, condition: "rescue", mode: "N" },
    { name: "no base power", id: 17n, condition: "noBase", mode: "N" },
  ] as const;
  it.each(progression)("pushes through landing to flagImpaired: $name", async ({ id, condition, mode }) => {
    const w = nWorld(id), h = keeperIn(w, stateOf(w));
    if (mode === "spent") {
      await h.cycle(expiredLoan()); await tick(h, w, 1);
      await tick(h, w, 600); await tick(h, w, 600);
      expect(terminal(h)).toHaveLength(1);
      expect(harvests(h)).toHaveLength(1);
    }
    if (mode === "U") { w.feedEnabledAt = NOW - 100; h.k.state.feedRound = { enabledAt: NOW - 100, rigs: [] }; }
    if (mode === "aged") {
      const r = healthy(id, NOW - 301);
      expect(clearReading(id, FLOOR, NOW - 1, { disabled: false, enabledAt: E }, r, w.records.get(id)).row).toBe("H");
      w.reports.set(id, r);
    }
    w.conditions.set(id, condition);
    if (mode === "both") w.conditions.set(17n, "revoked");
    await tick(h, w, 1); await tick(h, w, mode === "spent" ? 3_600 : 1);
    const impairment = pushes(h).filter((c) => c.label.startsWith("push "));
    expect(impairment).toHaveLength(1);
    expect(impairment[0]!.args).toEqual([mode === "both" ? [16n, 17n] : [id]]);
    expect(labels(h.xlayer).some((s) => s.startsWith("flagImpaired"))).toBe(false);
    const spent = structuredClone(h.k.state.refresh[key(id)]);
    w.reports.set(id, healthy(id, w.now + 1, { status: condition === "revoked" ? 3 : 1,
      stopBlock: condition === "stopped" ? 1n : 0n, custodied: condition !== "rescue", verifWeight: condition === "noBase" || condition === "revoked" ? 0n : 500n }));
    await tick(h, w, 1);
    expect(labels(h.xlayer).filter((s) => s.startsWith("flagImpaired"))).toEqual([`flagImpaired ${AGENT} rig ${id}`]);
    expect(h.xlayer.calls.find((c) => c.functionName === "flagImpaired")!.args).toEqual([id]);
    if (mode === "spent") {
      expect(h.k.state.refresh[key(id)]).toMatchObject({ pushAt: spent!.pushAt, storedBefore: spent!.storedBefore, sentAt: spent!.sentAt, recoveryAlerted: true });
      expect(harvests(h)).toHaveLength(1); expect(terminal(h)).toHaveLength(1);
    }
  });

  it.each(["waiting", "refused", "simulation"] as const)("alerts at the alert time for an unsent %s and keeps retrying across restart", async (failure) => {
    const w = nWorld(), h = keeperIn(w, stateOf(w));
    w.conditions.set(17n, "revoked");
    const install = (target: ReturnType<typeof keeperIn>) => {
      if (failure !== "simulation") {
        refuse(target, failure === "waiting" ? { status: "waiting", reason: "transaction in flight" } : { status: "reverted", reason: "SendRefused" });
      } else {
        const c = clientsOf(w);
        c.bsc.wallet = { account: c.account } as Clients["bsc"]["wallet"];
        c.bsc.public.simulateContract = async () => { throw new HttpRequestError({ url: "http://mock.invalid", cause: new Error("simulation transport down") }); };
        const sender = new Sender(c.bsc, { mode: "dry", capWei: 1n, stuckAfterSec: 180, alert: () => {}, now: () => w.now });
        const send = sender.send.bind(sender);
        target.bsc.send = async (call) => { target.bsc.calls.push(call); return send(call); };
      }
    };
    install(h);
    await h.cycle(expiredLoan()); await tick(h, w, 1);
    const since = w.now;
    for (const dt of [400, 400, 399]) await tick(h, w, dt);
    expect(notices(h)).toHaveLength(0);
    await tick(h, w, 1);
    expect(notices(h)).toHaveLength(1);
    expect(notices(h)[0]).toContain("confirmed revoked");
    expect(notices(h)[0]).toContain(failure === "simulation" ? "simulation failed" : failure === "waiting" ? "transaction in flight" : "SendRefused");
    expect(h.k.state.refresh[key(17n)]).toMatchObject({ suspectSince: since, impairmentAlerted: true });
    expect(h.k.state.impairmentPushes["17"]).toMatchObject({ at: w.now, status: failure === "refused" ? "reverted" : "waiting" });
    const restarted = keeperIn(w, persisted(h.k.state, `unsent-${failure}`)); install(restarted);
    await tick(restarted, w, 60); await tick(restarted, w, 1_200);
    expect(notices(restarted)).toHaveLength(0);
    expect(pushes(restarted).length).toBeGreaterThan(0);
    expect(labels(restarted.xlayer).some((s) => s.startsWith("flagImpaired"))).toBe(false);
  });
});

describe("RB4-09 restart timers and recovery notifications", () => {
  const FLOOR = IMPAIRED_AT + 72 * 3_600 + MAX_CLOCK_SKEW, E = FLOOR - 120;
  const incident = `${AGENT.toLowerCase()}:1000:${IMPAIRED_AT}`;
  const key = (id: bigint) => `${incident}:${id}`;
  const setup = (id = 17n) => {
    const w = world({ flagFrom: NOW - 100, seizeFrom: FLOOR, feedEnabledAt: E,
      reports: new Map([[16n, id === 16n ? healthy(id, FLOOR + 2) : null], [17n, id === 17n ? healthy(id, FLOOR + 2) : null]]),
      records: new Map([[16n, { syncedAt: FLOOR, power: 500n }], [17n, { syncedAt: FLOOR, power: 500n }]]) });
    const state = emptyState(1n, D.factory);
    state.feedRound = { enabledAt: E, rigs: [] };
    return { w, state };
  };
  const tick = async (h: ReturnType<typeof keeperIn>, w: World, dt: number, loan = expiredLoan()) => {
    w.now += dt; w.xNow = w.now;
    await h.cycle(loan);
  };
  const refusal = (h: ReturnType<typeof keeperIn>) => {
    h.bsc.send = async (call) => { h.bsc.calls.push(call); return { status: "waiting", reason: "simulation failed: source unavailable" }; };
  };
  const notices = (h: ReturnType<typeof keeperIn>) => h.alerts.filter((a) => a.includes("remains suspect"));
  const terminal = (h: ReturnType<typeof keeperIn>) => h.alerts.filter((a) => a.includes("after its recovery push and harvest"));
  const cloneFromDisk = (s: KeeperState, suffix: string) => {
    const path = fileURLToPath(new URL(`../../out/rb4-09-notify-${suffix.replace(/[^a-z0-9_-]/gi, "-")}.json`, import.meta.url));
    try { saveState(path, s); return loadState(path, 1n, D.factory); }
    finally { unlinkSync(path); }
  };

  it.each(["none", "window", "expired"] as const)("retains %s's timer through isolated unknown reads and a restart just before the alert time", async (phase) => {
    const { w, state } = setup();
    w.conditions.set(17n, "revoked");
    const loan = phase === "none" ? loanOf({}, [16n, 17n]) : phase === "expired" ? expiredLoan()
      : loanOf({ impairedAt: IMPAIRED_AT, seizeStart: FLOOR, deadline: NOW + 86_400, impairedRig: 16n }, [16n, 17n]);
    const k = phase === "none" ? `${AGENT.toLowerCase()}:1000:u${w.flagFrom}:17` : key(17n);
    const h = keeperIn(w, state); refusal(h);
    await h.cycle(loan); await tick(h, w, 1, loan);
    const since = w.now;
    for (let i = 1; i <= 19; i++) {
      if (i % 3 === 0) w.bscDown.add(17n); else w.bscDown.delete(17n);
      await tick(h, w, 60, loan);
      expect(h.k.state.refresh[k]?.suspectSince).toBe(since);
    }
    w.bscDown.delete(17n);
    await tick(h, w, 59, loan);
    expect(notices(h)).toHaveLength(0);
    const restarted = keeperIn(w, cloneFromDisk(h.k.state, phase)); refusal(restarted);
    await tick(restarted, w, 1, loan); // confirmation warm-up is null, not affirmative health
    expect(notices(restarted)).toHaveLength(1);
    expect(notices(restarted)[0]).toContain("current BSC read unconfirmed");
    expect(notices(restarted)[0]).toContain("revoked");
    expect(notices(restarted)[0]).toContain("simulation failed: source unavailable");
    expect(restarted.k.state.refresh[k]).toMatchObject({ suspectSince: since, impairmentAlerted: true });
    expect(restarted.bsc.calls).toEqual([]); expect(restarted.xlayer.calls).toEqual([]);
    w.reports.set(17n, impairedAt(17n, w.now + 1)); // usable evidence resets only the timer
    await tick(restarted, w, 1, loan);
    expect(restarted.k.state.refresh[k]?.suspectSince).toBeUndefined();
    expect(restarted.k.state.refresh[k]?.impairmentAlerted).toBe(true);
    w.reports.set(17n, healthy(17n, FLOOR + 2));
    w.conditions.set(17n, "healthy");
    await tick(restarted, w, 1, loan); await tick(restarted, w, 1, loan);
    expect(restarted.k.state.refresh[k]?.suspectSince).toBeUndefined();
    w.bscDown.add(17n);
    await tick(restarted, w, 60, loan);
    w.bscDown.delete(17n); w.conditions.set(17n, "revoked");
    await tick(restarted, w, 1, loan); await tick(restarted, w, 1, loan); await tick(restarted, w, 1_200, loan);
    expect(notices(restarted)).toHaveLength(1);
    // A distinct flag, or a distinct unflagged floor, earns one new deadline and notification.
    if (phase === "none") w.flagFrom = Number(w.flagFrom) + 1;
    else loan.loan.impairedAt++;
    await tick(restarted, w, 1, loan);
    expect(notices(restarted)).toHaveLength(1);
    await tick(restarted, w, 1_200, loan);
    expect(notices(restarted)).toHaveLength(2);
  });

  it.each([false, true])("starts a new unflagged epoch after a missed flag/expiry/clear, old alert=%s", async (alerted) => {
    const { w, state } = setup();
    const loan = loanOf({}, [16n, 17n]);
    w.conditions.set(17n, "revoked");
    const h = keeperIn(w, state); refusal(h);
    await h.cycle(loan); await tick(h, w, 1, loan);
    await tick(h, w, alerted ? 1_200 : 1_199, loan);
    const oldKey = `${AGENT.toLowerCase()}:1000:u${w.flagFrom}:17`;
    expect(notices(h)).toHaveLength(alerted ? 1 : 0);
    expect(h.k.state.refresh[oldKey]?.lastConfirmed).toBe("revoked");
    const saved = cloneFromDisk(h.k.state, `epoch-${alerted}`);
    const start = loan.start, oldFloor = Number(w.flagFrom);
    // The keeper is offline for every intermediate snapshot of this complete lifecycle.
    loan.loan.impairedAt = w.now;
    loan.loan.impairedRig = 16n;
    loan.loan.seizeStart = w.now + 72 * 3_600;
    loan.loan.deadline = loan.loan.seizeStart + 86_400;
    w.now = loan.loan.deadline + 1; loan.loan.expired = true;
    w.flagFrom = w.now + MAX_CLOCK_SKEW;
    loan.loan.impairedAt = 0; loan.loan.impairedRig = 0n; loan.loan.expired = false;
    w.xNow = w.now;
    expect(loan.start).toBe(start); expect(Number(w.flagFrom)).toBeGreaterThan(oldFloor);
    const restarted = keeperIn(w, saved); refusal(restarted);
    await restarted.cycle(loan);
    expect(restarted.k.state.refresh[oldKey]).toBeUndefined();
    expect(restarted.k.state.refresh[`${AGENT.toLowerCase()}:1000:u${w.flagFrom}:17`]?.lastConfirmed).toBeUndefined();
    await tick(restarted, w, 1, loan);
    const freshKey = `${AGENT.toLowerCase()}:1000:u${w.flagFrom}:17`, since = w.now;
    expect(restarted.k.state.refresh[freshKey]).toMatchObject({ suspectSince: since });
    expect(restarted.k.state.refresh[freshKey]?.impairmentAlerted).toBeUndefined();
    const alertAt = Math.max(since, Number(w.flagFrom)) + 1_200;
    await tick(restarted, w, alertAt - w.now - 1, loan); expect(notices(restarted)).toHaveLength(0);
    await tick(restarted, w, 1, loan); expect(notices(restarted)).toHaveLength(1);
    const again = keeperIn(w, cloneFromDisk(restarted.k.state, `epoch-again-${alerted}`)); refusal(again);
    await tick(again, w, 1, loan); await tick(again, w, 1_200, loan);
    expect(notices(again)).toHaveLength(0);
  });

  it("keeps an unflagged record on a failed floor read, and prunes it on flagging or closure", async () => {
    const { w, state } = setup();
    const loan = loanOf({}, [16n, 17n]);
    w.conditions.set(17n, "revoked");
    const h = keeperIn(w, state); refusal(h);
    await h.cycle(loan); await tick(h, w, 1, loan);
    const oldKey = `${AGENT.toLowerCase()}:1000:u${w.flagFrom}:17`, saved = structuredClone(h.k.state.refresh[oldKey]);
    w.flagFrom = "revert";
    const p = h.k as unknown as { harvest(d: Deployment, loans: LoanSnapshot[], block: bigint, now: number): Promise<void> };
    await p.harvest(D, [loan], 3n, w.now);
    await tick(h, w, 1, loan);
    expect(h.k.state.refresh[oldKey]).toEqual(saved);
    w.flagFrom = NOW - 100; loan.loan.impairedAt = IMPAIRED_AT;
    await p.harvest(D, [loan], 4n, w.now);
    expect(h.k.state.refresh[oldKey]).toBeUndefined();
    loan.loan.impairedAt = 0;
    await tick(h, w, 1, loan);
    expect(h.k.state.refresh[oldKey]).toBeDefined();
    loan.loan.open = false;
    await p.harvest(D, [loan], 5n, w.now);
    expect(h.k.state.refresh[oldKey]).toBeUndefined();
  });

  it("keeps feed:dead's 30-minute reminders separate from the incident alert, including credit and restart", async () => {
    const { w, state } = setup(); w.conditions.set(17n, "revoked");
    const transport = (messages: string[]) => new Alerts("mock", "mock", "keeper", async (_url, init) => {
      messages.push((JSON.parse(init!.body as string) as { text: string }).text);
      return { ok: true } as Response;
    }, () => w.now);
    const h = keeperIn(w, state, transport);
    await h.cycle(expiredLoan()); await tick(h, w, 1); await tick(h, w, 1);
    expect(h.k.state.refresh[key(17n)]).toMatchObject({ unknown: true, pushAt: NOW + 1 }); // credit precedes the first reminder
    const dead = (target: ReturnType<typeof keeperIn>) => target.alerts.filter((a) => a.includes("feed may be dead"));
    await tick(h, w, 598); expect(notices(h)).toHaveLength(0);
    await tick(h, w, 1);
    expect(notices(h)).toHaveLength(0); expect(dead(h)).toHaveLength(1);
    expect(dead(h)[0]).toContain("impairment report"); expect(dead(h)[0]).toContain("retrying hourly");
    expect(dead(h)[0]).not.toContain("not retried");
    await tick(h, w, 599); expect(notices(h)).toHaveLength(0);
    await tick(h, w, 1); expect(notices(h)).toHaveLength(1); expect(dead(h)).toHaveLength(1);
    await tick(h, w, 1_199); expect(dead(h)).toHaveLength(1);
    await tick(h, w, 1); expect(dead(h)).toHaveLength(2);
    await tick(h, w, 1_200); // retry at the one-hour unlanded cooldown
    expect(h.bsc.calls.filter((c) => c.label === "push [17]")).toHaveLength(2);
    expect(h.k.state.refresh[key(17n)]?.pushAt).toBe(NOW + 1);
    expect(notices(h)).toHaveLength(1);
    const restarted = keeperIn(w, cloneFromDisk(h.k.state, "dead"), transport);
    await tick(restarted, w, 600); await tick(restarted, w, 1);
    expect(notices(restarted)).toHaveLength(0); expect(dead(restarted).length).toBeGreaterThan(0);
    expect(labels(restarted.xlayer).some((s) => s.startsWith("flagImpaired"))).toBe(false);
    const next = expiredLoan(); next.loan.impairedAt++;
    await tick(restarted, w, 1, next); await tick(restarted, w, 1_200, next);
    expect(notices(restarted)).toHaveLength(1);
  });

  it.each(["block", "unconfirmed", "feed:dead"] as const)("sends a terminal recovery alert after an earlier %s notification", async (prior) => {
    const id = prior === "block" ? 16n : 17n;
    const { w, state } = setup(id), h = keeperIn(w, state);
    if (prior === "block") {
      w.reports.set(id, impairedAt(id, FLOOR + 1)); w.records.delete(id);
      await h.cycle(expiredLoan());
      expect(h.alerts.some((a) => a.includes("blocks or has an unreadable clear source"))).toBe(true);
      w.reports.set(id, healthy(id, FLOOR + 2));
      await tick(h, w, 1);
    } else if (prior === "unconfirmed") {
      w.bscDown.add(id);
      await h.cycle(expiredLoan()); await tick(h, w, 1); await tick(h, w, 1);
      expect(h.alerts.some((a) => a.includes("BSC source is unreadable"))).toBe(true);
      w.bscDown.delete(id);
      await tick(h, w, 1); await tick(h, w, 1);
    } else {
      w.conditions.set(id, "revoked");
      await h.cycle(expiredLoan()); await tick(h, w, 1); await tick(h, w, 600);
      expect(h.alerts.some((a) => a.includes("feed may be dead"))).toBe(true);
      w.conditions.set(id, "healthy");
      await tick(h, w, 1); await tick(h, w, 1);
    }
    await tick(h, w, 600);
    expect(h.bsc.calls.filter((c) => c.functionName === "harvest")).toHaveLength(1);
    await tick(h, w, 600);
    expect(terminal(h)).toHaveLength(1);
    expect(h.k.state.refresh[key(id)]?.recoveryAlerted).toBe(true);
    const again = keeperIn(w, cloneFromDisk(h.k.state, `terminal-${prior}`));
    await tick(again, w, 1); await tick(again, w, 3_600);
    expect(terminal(again)).toHaveLength(0); expect(again.bsc.calls).toEqual([]);
  });

  it("keeps one harvest after it lands and a strictly newer N report blocks again", async () => {
    const { w, state } = setup(), h = keeperIn(w, state);
    await h.cycle(expiredLoan()); await tick(h, w, 1); await tick(h, w, 600);
    const sentAt = h.k.state.refresh[key(17n)]!.sentAt!;
    w.records.set(17n, { syncedAt: sentAt + 1, power: 500n });
    await tick(h, w, 1); // the harvest landed and its positive record resolves the old report
    expect(labels(h.xlayer)).toContain(`clearExpiredFlag ${AGENT}`);
    const before = h.xlayer.calls.length;
    w.reports.set(17n, healthy(17n, w.now + 1, { totalVerifWeight: 0n }));
    await tick(h, w, 1);
    expect(clearReading(17n, FLOOR, w.now, { disabled: false, enabledAt: E }, w.reports.get(17n), w.records.get(17n)).row).toBe("N");
    expect(h.xlayer.calls).toHaveLength(before);
    expect(h.k.state.refresh[key(17n)]?.sentAt).toBe(sentAt);
    expect(h.bsc.calls.filter((c) => c.functionName === "harvest")).toHaveLength(1);
    expect(terminal(h)).toHaveLength(1);
    const again = keeperIn(w, cloneFromDisk(h.k.state, "landed-N"));
    await tick(again, w, 1); await tick(again, w, 3_600);
    expect(again.bsc.calls).toEqual([]); expect(terminal(again)).toHaveLength(0);
    expect(again.k.state.refresh[key(17n)]?.sentAt).toBe(sentAt);
  });

  it("does not clear an aged H/N tie, harvest again or repeat its terminal alert; record +1 clears", async () => {
    const { w, state } = setup(), h = keeperIn(w, state);
    await h.cycle(expiredLoan()); await tick(h, w, 1); await tick(h, w, 600);
    const sentAt = w.now;
    w.reports.set(17n, healthy(17n, sentAt)); w.records.set(17n, { syncedAt: sentAt, power: 500n });
    expect(clearReading(17n, FLOOR, sentAt + 300, { disabled: false, enabledAt: E }, w.reports.get(17n), w.records.get(17n)).row).toBe("H");
    await tick(h, w, 301); // no clear was mined while H was fresh
    expect(clearReading(17n, FLOOR, w.now, { disabled: false, enabledAt: E }, w.reports.get(17n), w.records.get(17n)).row).toBe("N");
    expect(h.xlayer.calls).toEqual([]); expect(terminal(h)).toHaveLength(1);
    expect(h.bsc.calls.filter((c) => c.functionName === "harvest")).toHaveLength(1);
    const again = keeperIn(w, cloneFromDisk(h.k.state, "tie"));
    await tick(again, w, 1); await tick(again, w, 600);
    expect(again.bsc.calls).toEqual([]); expect(again.xlayer.calls).toEqual([]); expect(terminal(again)).toHaveLength(0);
    w.records.set(17n, { syncedAt: sentAt + 1, power: 500n });
    await tick(again, w, 1);
    expect(labels(again.xlayer)).toEqual([`clearExpiredFlag ${AGENT}`]);
  });

  it.each([false, true])("sends one brake alert and no brake-time push as N changes to U, suspect=%s", async (suspect) => {
    const { w, state } = setup(), h = keeperIn(w, state);
    if (suspect) w.conditions.set(17n, "revoked");
    await h.cycle(expiredLoan());
    if (suspect) { await tick(h, w, 1); await tick(h, w, 1); }
    const before = h.bsc.calls.length;
    expect(before).toBe(suspect ? 1 : 0);
    w.feedDisabled = true;
    await tick(h, w, 1); await tick(h, w, 600);
    expect(clearReading(17n, FLOOR, w.now, { disabled: true, enabledAt: E }, w.reports.get(17n), w.records.get(17n)).row).toBe("U");
    expect(h.alerts.filter((a) => a.includes("owner review: rig 17"))).toHaveLength(1);
    expect(h.alerts.filter((a) => a.includes("feed may be dead"))).toEqual([]);
    expect(h.k.state.refresh[key(17n)]?.brakeAlerted).toBe(true);
    const again = keeperIn(w, cloneFromDisk(h.k.state, "brake"));
    await tick(again, w, 600); await tick(again, w, 600);
    expect(again.alerts).toEqual([]); expect(h.bsc.calls).toHaveLength(before); expect(again.bsc.calls).toEqual([]);
  });

  it("clears the timer on a brake or upgrade freeze and does no impairment work in the cure phase", async () => {
    const { w, state } = setup(), h = keeperIn(w, state);
    w.conditions.set(17n, "revoked"); refusal(h);
    await h.cycle(expiredLoan()); await tick(h, w, 1);
    expect(h.k.state.refresh[key(17n)]?.suspectSince).toBeDefined();
    await tick(h, w, 1_200);
    expect(notices(h)).toHaveLength(1);
    expect(h.k.state.refresh[key(17n)]?.impairmentAlerted).toBe(true);
    w.feedDisabled = true;
    await tick(h, w, 1);
    expect(h.k.state.refresh[key(17n)]?.suspectSince).toBeUndefined();
    w.feedDisabled = false;
    await tick(h, w, 1);
    expect(h.k.state.refresh[key(17n)]?.suspectSince).toBe(w.now);
    h.k.frozen = true;
    const count = h.bsc.calls.length;
    await tick(h, w, 600);
    expect(h.k.state.refresh[key(17n)]?.suspectSince).toBeUndefined(); expect(h.bsc.calls).toHaveLength(count);
    h.k.frozen = false;
    const live = expiredLoan(); live.loan.expired = false; live.loan.seizeStart = w.now + 5_000;
    await tick(h, w, 600, live);
    expect(h.bsc.calls).toHaveLength(count); expect(notices(h)).toHaveLength(1);
    expect(h.k.state.refresh[key(17n)]?.impairmentAlerted).toBe(true);
  });
});

describe("RB4-09 journal and same-cycle push credit", () => {
  const FLOOR = IMPAIRED_AT + 72 * 3_600 + MAX_CLOCK_SKEW;
  const incident = `${AGENT.toLowerCase()}:1000:${IMPAIRED_AT}`, key = `${incident}:17`;
  const setup = (insane = false) => {
    const w = world({ flagFrom: NOW - 100, seizeFrom: FLOOR, feedEnabledAt: NOW - 90,
      reports: new Map([[16n, null], [17n, healthy(17n, NOW - 40, insane ? { totalVerifWeight: 0n } : {})]]),
      records: new Map([[16n, { syncedAt: FLOOR, power: 500n }], [17n, { syncedAt: FLOOR, power: 500n }]]) });
    if (insane) w.feedEnabledAt = NOW - 120; // the same old report lies above this enable floor
    const state = emptyState(1n, D.factory);
    state.feedRound = { enabledAt: Number(w.feedEnabledAt), rigs: [] };
    return { w, state };
  };
  const tick = async (h: ReturnType<typeof keeperIn>, w: World, at: number) => {
    w.now = at; w.xNow = at;
    await h.cycle(expiredLoan());
  };
  const privateKeeper = (k: Keeper) => k as unknown as {
    act(d: Deployment, agent: Address, a: Action, now: number, reports: Map<bigint, Report | null>): Promise<void>;
    clearPush(d: Deployment, l: LoanSnapshot, ids: bigint[], reports: Map<bigint, Report | null>, now: number, unknown?: boolean): Promise<void>;
    enablePushes(d: Deployment, loans: LoanSnapshot[], reports: Map<bigint, Report | null>, feed: FeedView, ready: boolean, now: number): Promise<void>;
  };

  it.each(["push", "enable-push", "clear-push", "unknown-push"] as const)("checkpoints %s's provenance with the original pending time before broadcast", async (label) => {
    const { w, state } = setup(true), c = clientsOf(w), messages: string[] = [];
    const path = fileURLToPath(new URL(`../../out/rb4-09-journal-${label}.json`, import.meta.url));
    const saved: KeeperState[] = [];
    c.bsc.public.simulateContract = async () => ({ request: {} }) as never;
    c.bsc.public.estimateGas = async () => 21_000n;
    c.bsc.public.getGasPrice = async () => 1n;
    c.bsc.public.getTransactionCount = async () => 0;
    c.bsc.public.getTransactionReceipt = async () => null as never;
    c.bsc.wallet = { chain: { id: 56 }, account: { address: c.account.address,
      signTransaction: async () => { w.now += 7; return "0x0102"; } },
      sendRawTransaction: async () => {
        saved.push(loadState(path, 1n, D.factory));
        return "0x01";
      } } as unknown as Clients["bsc"]["wallet"];
    const sender = new Sender(c.bsc, { mode: "live", capWei: 10n, stuckAfterSec: 180, alert: (s) => messages.push(s),
      now: () => w.now, journal: state.pendingTx.bsc, persist: () => saveState(path, state) });
    const k = new Keeper(cfg(), c, D, { send: async () => {} } as unknown as Alerts, { bsc: sender, xlayer: recorder() }, state, () => w.now);
    const p = privateKeeper(k);
    try {
      if (label === "push") await p.act(D, AGENT, { kind: "push", rigs: [17n] }, NOW, w.reports);
      else if (label === "enable-push") {
        state.feedRound!.rigs = ["17"];
        w.reports.set(17n, healthy(17n, FLOOR + 2));
        await p.enablePushes(D, [expiredLoan()], w.reports, { disabled: false, enabledAt: Number(w.feedEnabledAt) }, true, NOW);
      } else await p.clearPush(D, expiredLoan(), [17n], w.reports, NOW, label === "unknown-push");
      expect(saved).toHaveLength(1);
      const entry = saved[0]!.pendingTx.bsc[0]!;
      expect(entry.label.startsWith(`${label} [17]`)).toBe(true);
      expect(entry.createdAt).toBe(NOW + 7);
      expect(saved[0]!.pushProvenance["17"]).toEqual({ at: entry.createdAt, storedBefore: Number(w.reports.get(17n)!.observedAt) });
      expect(saved[0]!.refresh[key]?.pushAt).toBeUndefined(); // the checkpoint precedes post-send incident credit
      expect(k.state.lastPushAt["17"]).toBe(entry.createdAt);
      const restarted = keeperIn(w, saved[0]!);
      expect(restarted.k.state.lastPushAt["17"]).toBe(NOW + 7);
      expect(messages).toEqual([]);
    } finally { unlinkSync(path); }
  });

  it.each([false, true].flatMap((insane) => ["replacement", "rebroadcast"].map((kind) => ({ insane, kind }))))
    ("keeps $kind's original push clock after receipt reconciliation, insane=$insane", async ({ insane, kind }) => {
      const { w, state } = setup(insane);
      state.pushProvenance["17"] = { at: NOW, storedBefore: NOW - 40 };
      state.pendingTx.bsc.push({ label: "push [17]", address: D.reporter,
        data: encodeFunctionData({ abi: reporterAbi, functionName: "push", args: [[17n]] }), value: "0", urgency: "urgent", nonce: 0,
        hash: "0x02", hashes: kind === "replacement" ? ["0x01", "0x02"] : ["0x02"], gasPrice: "1", createdAt: NOW, sentAt: NOW + 180 });
      const path = fileURLToPath(new URL(`../../out/rb4-09-receipt-${kind}-${insane}.json`, import.meta.url));
      try {
        saveState(path, state);
        const restored = loadState(path, 1n, D.factory), c = clientsOf(w);
        c.bsc.wallet = { account: c.account } as Clients["bsc"]["wallet"];
        c.bsc.public.getTransactionCount = async () => 1;
        c.bsc.public.getTransactionReceipt = async () => ({ status: "success", transactionHash: "0x02", logs: [] }) as unknown as TransactionReceipt;
        const sender = new Sender(c.bsc, { mode: "dry", capWei: 1n, stuckAfterSec: 180, alert: () => {}, journal: restored.pendingTx.bsc, persist: () => saveState(path, restored) });
        const h = keeperIn(w, restored);
        expect(h.k.state.lastPushAt["17"]).toBe(NOW);
        expect(h.k.state.refresh[key]).toBeUndefined(); // only the ordinary journal entry and its provenance existed
        await sender.poll(); // cycle() reconciles receipts before impairment planning
        expect(restored.pendingTx.bsc).toEqual([]);
        expect(loadState(path, 1n, D.factory).pushProvenance["17"]).toEqual({ at: NOW, storedBefore: NOW - 40 });
        await tick(h, w, NOW + 181); await tick(h, w, NOW + 182);
        expect(h.k.state.refresh[key]).toMatchObject({ unknown: true, pushAt: NOW, storedBefore: NOW - 40 });
        expect(h.bsc.calls).toEqual([]); // the pre-existing report inside slack did not land this push
        await tick(h, w, NOW + 599); expect(h.bsc.calls).toEqual([]);
        await tick(h, w, NOW + 600);
        expect(h.bsc.calls.map((call) => call.functionName)).toEqual(["harvest"]); // only 420 s since replacement
        await tick(h, w, NOW + 1_201);
        expect(h.bsc.calls.filter((call) => call.functionName === "push")).toEqual([]);
        expect(h.k.state.refresh[key]?.pushAt).toBe(NOW);
      } finally { unlinkSync(path); }
    });

  it("waits more than 600 s on an unconfirmed source after reconciling the ordinary journal, then buys no health push", async () => {
    const { w, state } = setup();
    state.pushProvenance["17"] = { at: NOW, storedBefore: NOW - 40 };
    state.pendingTx.bsc.push({ label: "push [17]", address: D.reporter, data: "0x", value: "0", urgency: "urgent", nonce: 0,
      hash: "0x01", hashes: ["0x01"], gasPrice: "1", createdAt: NOW, sentAt: NOW });
    const h = keeperIn(w, state);
    h.bsc.poll = async () => { state.pendingTx.bsc.splice(0); };
    await h.bsc.poll();
    w.bscDown.add(17n);
    for (const at of [NOW + 1, NOW + 300, NOW + 601]) await tick(h, w, at);
    expect(h.bsc.calls).toEqual([]);
    expect(h.k.state.refresh[key]).toMatchObject({ pushAt: NOW, storedBefore: NOW - 40 });
    w.bscDown.delete(17n);
    await tick(h, w, NOW + 602); await tick(h, w, NOW + 603);
    expect(h.bsc.calls.map((call) => call.functionName)).toEqual(["harvest"]);
    expect(clearPushState(17n, w.reports.get(17n), h.k.state.refresh[key]!, { disabled: false, enabledAt: NOW - 90 })).toEqual({ landed: false, spent: true });
  });

  it("uses sentAt only for a journal without createdAt and allows a genuinely newer below-floor answer", async () => {
    const { w, state } = setup();
    state.pushProvenance["17"] = { at: NOW, storedBefore: NOW - 40 };
    state.pendingTx.bsc.push({ label: "push [17]", address: D.reporter, data: "0x", value: "0", urgency: "urgent", nonce: 0,
      hash: "0x01", hashes: ["0x01"], gasPrice: "1", sentAt: NOW });
    const h = keeperIn(w, state);
    expect(state.lastPushAt["17"]).toBe(NOW);
    await tick(h, w, NOW + 1); await tick(h, w, NOW + 2);
    expect(clearPushState(17n, w.reports.get(17n), state.refresh[key]!, { disabled: false, enabledAt: NOW - 90 }).spent).toBe(true);
    w.feedEnabledAt = NOW + 10; state.feedRound = { enabledAt: NOW + 10, rigs: [] };
    w.reports.set(17n, healthy(17n, NOW + 69)); // newer than baseline, below the later enable floor NOW+70
    expect(clearPushState(17n, w.reports.get(17n), state.refresh[key]!, { disabled: false, enabledAt: NOW + 10 })).toEqual({ landed: true, spent: false });
    await tick(h, w, NOW + 601);
    expect(h.bsc.calls.map((call) => call.label)).toEqual([`unknown-push [17] for ${incident}`]);
    expect(state.refresh[key]).toMatchObject({ pushAt: NOW + 601, storedBefore: NOW + 69 });
  });

  it.each([16n, 17n].flatMap((id) => ["push", "enable-push"].map((source) => ({ id, source }))))
    ("credits $source in rig $id's first N planning cycle with BSC already confirmed, without unknown-push", async ({ id, source }) => {
      const { w, state } = setup(true);
      w.feedEnabledAt = NOW - 1_000; state.feedRound = { enabledAt: NOW - 1_000, rigs: [] };
      w.reports.set(16n, null); w.reports.set(17n, null);
      const h = keeperIn(w, state), p = privateKeeper(h.k);
      await tick(h, w, NOW - 603); await tick(h, w, NOW - 602); // healthy observations, no N latch yet
      w.now = NOW - 601; w.xNow = w.now;
      w.reports.set(id, healthy(id, NOW - 641, { totalVerifWeight: 0n }));
      if (source === "push") await p.act(D, AGENT, { kind: "push", rigs: [id] }, w.now, w.reports);
      else {
        w.reports.set(id, healthy(id, NOW - 941));
        state.feedRound!.rigs = [id.toString()];
        await p.enablePushes(D, [expiredLoan()], w.reports, { disabled: false, enabledAt: NOW - 1_000 }, true, w.now);
        w.reports.set(id, healthy(id, NOW - 641, { totalVerifWeight: 0n }));
      }
      expect(state.refresh[`${incident}:${id}`]?.unknown).toBeUndefined();
      await tick(h, w, NOW); // first N cycle credits an old push; the 600 s cooldown cannot hide M26
      expect(state.refresh[`${incident}:${id}`]).toMatchObject({ unknown: true, pushAt: NOW - 601, storedBefore: source === "push" ? NOW - 641 : NOW - 941 });
      expect(h.bsc.calls.filter((call) => call.functionName === "push").map((call) => call.label)).toEqual([`${source} [${id}]`]);
      await tick(h, w, NOW + 1); await tick(h, w, NOW + 3_601);
      expect(h.bsc.calls.some((call) => call.label.startsWith("unknown-push"))).toBe(false);
      expect(h.bsc.calls.filter((call) => call.functionName === "harvest")).toHaveLength(1);
    });

  it("never overwrites spent credit with a later impairment retry and gives later health no second recovery push", async () => {
    const { w, state } = setup(true), h = keeperIn(w, state);
    w.conditions.set(17n, "revoked");
    await tick(h, w, NOW); await tick(h, w, NOW + 1); await tick(h, w, NOW + 2);
    const first = structuredClone(state.refresh[key])!;
    expect(first).toMatchObject({ unknown: true, pushAt: NOW + 1, storedBefore: NOW - 40 });
    w.reports.set(17n, healthy(17n, NOW + 300, { totalVerifWeight: 0n }));
    await tick(h, w, NOW + 601); await tick(h, w, NOW + 602);
    expect(state.pushProvenance["17"]).toEqual({ at: NOW + 601, storedBefore: NOW + 300 });
    expect(state.refresh[key]).toMatchObject({ pushAt: first.pushAt, storedBefore: first.storedBefore });
    w.conditions.set(17n, "healthy");
    await tick(h, w, NOW + 603); await tick(h, w, NOW + 604); await tick(h, w, NOW + 4_205);
    expect(h.bsc.calls.filter((call) => call.functionName === "push").map((call) => call.label)).toEqual(["push [17]", "push [17]"]);
    expect(h.bsc.calls.filter((call) => call.functionName === "harvest")).toHaveLength(1);
    expect(state.refresh[key]).toMatchObject({ pushAt: first.pushAt, storedBefore: first.storedBefore, recoveryAlerted: true });
  });
});

describe("RB4-09 v13 selection, alert floors and round 2 regression cases", () => {
  const FLOOR = IMPAIRED_AT + 72 * 3_600 + MAX_CLOCK_SKEW, E = FLOOR - 120;
  const incident = `${AGENT.toLowerCase()}:1000:${IMPAIRED_AT}`, key = `${incident}:17`;
  const outside = (enabledAt = E) => {
    const state = emptyState(1n, D.factory);
    state.feedRound = { enabledAt, rigs: [] };
    return state;
  };
  const twoRig = (over: Partial<World> = {}) => world({ feedEnabledAt: E, seizeFrom: FLOOR, flagFrom: NOW - 100,
    reports: new Map<bigint, Report | null>([[16n, null], [17n, healthy(17n, FLOOR + 2)]]),
    records: new Map([[16n, { syncedAt: FLOOR, power: 500n }], [17n, { syncedAt: FLOOR, power: 500n }]]), ...over });
  const tick = async (h: ReturnType<typeof keeperIn>, w: World, dt: number, loan: LoanSnapshot) => {
    w.now += dt; w.xNow = w.now;
    await h.cycle(loan);
  };
  const notices = (h: ReturnType<typeof keeperIn>) => h.alerts.filter((a) => a.includes("remains suspect"));
  const unsent = (h: ReturnType<typeof keeperIn>) => {
    h.bsc.send = async (call) => { h.bsc.calls.push(call); return { status: "waiting", reason: "send failed" }; };
  };

  it.each(["cooldown", "unlanded", "opening"] as const)("does not clear instead of a suspect waiting for its %s", (wait) => {
    const rigs: RigView[] = [16n, 17n].map((id) => ({ id, confirmed: id === 16n ? "healthy" : "revoked", passSuspended: true,
      lastPushAt: NOW - (wait === "cooldown" ? 30 : 700), storedObservedAt: wait === "unlanded" ? 0 : NOW - 1,
      report: healthy(id, NOW - 1), voucherSyncedAt: NOW, voucherPower: 500n }));
    expect(nextActions({ now: NOW, loan: expiredLoan().loan, rigs, feedDisabled: false, suspendOnRevoke: false,
      flagEvidenceFrom: NOW - 100, seizeEvidenceFrom: FLOOR, clearAllowed: true, pushOpen: wait !== "opening" }))
      .toEqual([]);
  });

  it("G-N41: confirmed health clears suspicion without evidence and sends no alert at the alert time", async () => {
    const w = twoRig({ bad: new Set([17n]) }), h = keeperIn(w, outside()), loan = loanOf({}, [16n, 17n]);
    unsent(h);
    await h.cycle(loan); await tick(h, w, 60, loan);
    const k = `${AGENT.toLowerCase()}:1000:u${w.flagFrom}:17`, since = w.now;
    expect(h.k.state.refresh[k]?.suspectSince).toBe(since);
    await tick(h, w, 240, loan);
    w.bad.delete(17n);
    await tick(h, w, 60, loan); await tick(h, w, 60, loan);
    expect(evidenceKind(17n, Number(w.flagFrom), w.now, { disabled: false, enabledAt: E }, w.reports.get(17n), w.records.get(17n))).toBe(0);
    expect(h.k.state.refresh[k]?.suspectSince).toBeUndefined();
    await tick(h, w, since + 1_200 - w.now, loan); await tick(h, w, 60, loan);
    expect(notices(h)).toEqual([]);
    expect(h.k.state.refresh[k]?.suspectSince).toBeUndefined();
  });

  it("G-N47: cure-phase suspicion starts its timer only on entering the seize window", async () => {
    const w = twoRig({ bad: new Set([17n]), flagFrom: Number(2n ** 64n - 1n) }), h = keeperIn(w, outside());
    const loan = loanOf({ impairedAt: IMPAIRED_AT, seizeStart: NOW + 1_000, deadline: NOW + 90_000, impairedRig: 16n }, [16n, 17n]);
    unsent(h);
    await h.cycle(loan); await tick(h, w, 60, loan); await tick(h, w, 900, loan);
    expect(h.k.state.refresh[key]?.suspectSince).toBeUndefined();
    expect(h.bsc.calls).toEqual([]); expect(h.xlayer.calls).toEqual([]);
    w.seizeFrom = loan.loan.seizeStart + MAX_CLOCK_SKEW;
    await tick(h, w, 60, loan);
    expect(h.k.state.refresh[key]?.suspectSince).toBe(w.now);
    const alertAt = Math.max(w.now, w.seizeFrom) + 1_200;
    await tick(h, w, alertAt - w.now - 1, loan); expect(notices(h)).toEqual([]);
    await tick(h, w, 1, loan); expect(notices(h)).toHaveLength(1);
  });

  it("G-N48: seize evidence clears the window timer despite the maximum flag floor and a waiting seize", async () => {
    const w = twoRig({ bad: new Set([17n]), flagFrom: Number(2n ** 64n - 1n), seizeFrom: NOW - 30 }), h = keeperIn(w, outside());
    const loan = loanOf({ impairedAt: IMPAIRED_AT, seizeStart: w.seizeFrom - MAX_CLOCK_SKEW, deadline: NOW + 86_400, impairedRig: 16n }, [16n, 17n]);
    h.xlayer.send = async (call) => { h.xlayer.calls.push(call); return { status: "waiting", reason: "send failed" }; };
    await h.cycle(loan); await tick(h, w, 60, loan);
    expect(h.k.state.refresh[key]?.suspectSince).toBe(w.now);
    w.reports.set(17n, impairedAt(17n, w.now + 1));
    for (let i = 0; i < 4; i++) await tick(h, w, 60, loan);
    expect(h.xlayer.calls.filter((c) => c.functionName === "seize").length).toBeGreaterThan(0);
    expect(h.k.state.refresh[key]?.suspectSince).toBeUndefined();
    expect(notices(h)).toEqual([]);
  });

  it.each(["clear-push", "unknown-push"] as const)("G-N29: restores %s's baseline and waits for landing or 600 s before harvesting", async (label) => {
    const w = twoRig({ feedEnabledAt: NOW - 200,
      reports: new Map<bigint, Report | null>([[16n, null], [17n, healthy(17n, NOW - 40, { totalVerifWeight: 0n })]]) });
    const state = outside(NOW - 200);
    state.pushProvenance["17"] = { at: NOW, storedBefore: NOW - 40 };
    state.pendingTx.bsc.push({ label: `${label} [17] for ${incident}`, address: D.reporter, data: "0x", value: "0", urgency: "routine", nonce: 0,
      hash: "0x01", hashes: ["0x01"], gasPrice: "1", createdAt: NOW, sentAt: NOW });
    const h = keeperIn(w, state), loan = expiredLoan();
    expect(h.k.state.refresh[key]).toMatchObject({ pushAt: NOW, storedBefore: NOW - 40 });
    await tick(h, w, 1, loan); await tick(h, w, 60, loan); await tick(h, w, 538, loan);
    expect(h.bsc.calls).toEqual([]);
    await tick(h, w, 1, loan);
    expect(labels(h.bsc)).toEqual([`refresh-harvest [17] for ${incident}`]);
    expect(h.k.state.refresh[key]).toMatchObject({ unknown: true, pushAt: NOW, storedBefore: NOW - 40, sentAt: NOW + 600 });
  });

  it("G-N61: a power-zero record alone cannot stop the timer when the feed-on report read fails", async () => {
    const w = twoRig({ bad: new Set([17n]), records: new Map([[16n, { syncedAt: FLOOR, power: 500n }], [17n, { syncedAt: NOW - 50, power: 0n }]]) });
    w.reports.delete(17n);
    const h = keeperIn(w, outside()), loan = loanOf({}, [16n, 17n]);
    unsent(h);
    await h.cycle(loan); await tick(h, w, 60, loan);
    const k = `${AGENT.toLowerCase()}:1000:u${w.flagFrom}:17`, since = w.now;
    expect(h.k.state.refresh[k]?.suspectSince).toBe(since);
    expect(h.xlayer.calls.filter((c) => c.functionName === "flagImpaired")).toEqual([]);
    await tick(h, w, 1_199, loan); expect(notices(h)).toEqual([]);
    await tick(h, w, 1, loan); expect(notices(h)).toHaveLength(1);
    expect(h.k.state.refresh[k]?.suspectSince).toBe(since);
    expect(h.xlayer.calls.filter((c) => c.functionName === "flagImpaired")).toEqual([]);
  });

  it("G-N30: a push from before the flag does not spend the new incident's recovery push", async () => {
    const w = twoRig({ feedEnabledAt: 0 }), state = emptyState(1n, D.factory);
    state.lastPushAt["17"] = IMPAIRED_AT - 30;
    const h = keeperIn(w, state), loan = expiredLoan();
    await h.cycle(loan); await tick(h, w, 60, loan);
    expect(labels(h.bsc)).toEqual([`unknown-push [17] for ${incident}`]);
    expect(h.k.state.refresh[key]?.pushAt).toBe(w.now);
  });

  it("G-N11: a rescued rig with the feed off is alerted rather than flagged even with a power-zero record", () => {
    const rigs: RigView[] = [{ id: 16n, confirmed: "rescue", passSuspended: true, lastPushAt: 0, storedObservedAt: 0,
      report: null, voucherSyncedAt: NOW - 10, voucherPower: 0n }];
    expect(nextActions({ now: NOW, loan: loanOf().loan, rigs, feedDisabled: true, suspendOnRevoke: false, flagEvidenceFrom: NOW - 100 }))
      .toEqual([{ kind: "alert", text: "rescue of rig 16 seen, flag impossible until enableFeed" }]);
  });

  const deadlines = (["none", "window", "expired"] as const).flatMap((phase) => [-10_000, 0, 60].map((offset) => ({ phase, offset })));
  it.each(deadlines)("alerts at max(suspectSince, phase floor) + 1200: $phase, floor offset=$offset", async ({ phase, offset }) => {
    const w = twoRig({ bad: new Set([17n]) }), h = keeperIn(w, outside());
    const since = NOW + 1, floor = since + offset;
    const loan = phase === "none" ? loanOf({}, [16n, 17n]) : expiredLoan();
    if (phase === "window") {
      loan.loan.expired = false; loan.loan.seizeStart = floor - MAX_CLOCK_SKEW; loan.loan.deadline = NOW + 86_400;
      w.flagFrom = Number(2n ** 64n - 1n); w.seizeFrom = floor;
    } else w.flagFrom = floor;
    unsent(h);
    await h.cycle(loan); await tick(h, w, 1, loan);
    const k = phase === "none" ? `${AGENT.toLowerCase()}:1000:u${floor}:17` : key;
    expect(h.k.state.refresh[k]?.suspectSince).toBe(since);
    const alertAt = Math.max(since, floor) + 1_200;
    await tick(h, w, alertAt - w.now - 1, loan); expect(notices(h)).toEqual([]);
    await tick(h, w, 1, loan); expect(notices(h)).toHaveLength(1);
    await tick(h, w, 1_200, loan); expect(notices(h)).toHaveLength(1);
  });

  it.each((["seize", "flag after expiry"] as const).flatMap((action) => [20, 58].map((offset) => ({ action, offset }))))
    ("gets $action evidence on the retry after a below-floor first push, offset=$offset, without an impairment alert", async ({ action, offset }) => {
      const start = NOW, floor = start + MAX_CLOCK_SKEW;
      const w = world({ now: start + offset - 60, xNow: start + offset - 60, bad: new Set([16n]),
        flagFrom: action === "seize" ? Number(2n ** 64n - 1n) : floor, seizeFrom: action === "seize" ? floor : start - 86_400 + MAX_CLOCK_SKEW,
        reports: new Map([[16n, impairedAt(16n, start - 86_400)]]) });
      const loan = loanOf({ impairedAt: start - (action === "seize" ? 72 : 96) * 3_600, seizeStart: action === "seize" ? start : start - 86_400,
        deadline: action === "seize" ? start + 86_400 - 1 : start - 1, impairedRig: 16n });
      const h = keeperIn(w), k = `${AGENT.toLowerCase()}:1000:${loan.loan.impairedAt}:16`;
      await h.cycle(loan);
      loan.loan.expired = action !== "seize";
      await tick(h, w, 60, loan);
      expect(labels(h.bsc)).toEqual(["push [16]"]);
      const firstPush = w.now;
      w.reports.set(16n, impairedAt(16n, firstPush));
      expect(firstPush).toBeLessThan(floor);
      expect(evidenceKind(16n, floor, w.now, { disabled: false, enabledAt: 0 }, w.reports.get(16n), undefined)).toBe(0);
      for (let i = 0; i < 9; i++) await tick(h, w, 60, loan);
      expect(h.xlayer.calls).toEqual([]); expect(labels(h.bsc)).toEqual(["push [16]"]);
      await tick(h, w, 60, loan);
      expect(labels(h.bsc)).toEqual(["push [16]", "push [16]"]);
      expect(h.k.state.refresh[k]?.suspectSince).toBe(firstPush);
      w.reports.set(16n, impairedAt(16n, w.now));
      await tick(h, w, 60, loan);
      expect(h.xlayer.calls.map((c) => ({ functionName: c.functionName, args: c.args })))
        .toEqual([{ functionName: action === "seize" ? "seize" : "flagImpaired", args: action === "seize" ? undefined : [16n] }]);
      expect(h.k.state.refresh[k]?.suspectSince).toBeUndefined();
      expect(notices(h)).toEqual([]);
    });
});

describe("RB4-09 v14 kept conditions and withheld clears", () => {
  type H = ReturnType<typeof keeperIn>;
  const key = (w: World, loan: LoanSnapshot, id = 17n) => `${AGENT.toLowerCase()}:1000:${loan.loan.impairedAt || `u${w.flagFrom}`}:${id}`;
  const setup = (ids = [16n, 17n]) => {
    const expiry = NOW - 180, impairedAt = expiry - 96 * 3_600 - 1, seizeStart = impairedAt + 72 * 3_600;
    const loan = loanOf({ impairedAt, seizeStart, deadline: expiry - 1, expired: true, impairedRig: 16n }, ids);
    const w = world({ flagFrom: expiry + MAX_CLOCK_SKEW, seizeFrom: seizeStart + MAX_CLOCK_SKEW,
      conditions: new Map([[17n, "revoked"]]), reports: new Map(ids.map((id) => [id, null])),
      records: new Map(ids.map((id) => [id, { syncedAt: id === 16n ? NOW - 20 : seizeStart, power: 500n }])) });
    return { w, loan };
  };
  const tick = async (h: H, w: World, dt: number, loan: LoanSnapshot) => {
    w.now += dt; w.xNow = w.now;
    await h.cycle(loan);
  };
  const unsent = (h: H) => {
    h.bsc.send = async (call) => { h.bsc.calls.push(call); return { status: "waiting", reason: "send failed" }; };
    h.xlayer.send = async (call) => { h.xlayer.calls.push(call); return { status: "waiting", reason: "send failed" }; };
  };
  const establish = async (h: H, w: World, loan: LoanSnapshot) => {
    const record = w.records.get(16n)!;
    w.records.delete(16n); // the flagged rig's healthy record arrives with the first impaired confirmation
    await h.cycle(loan);
    w.records.set(16n, record);
    await tick(h, w, 60, loan);
    expect(h.k.state.refresh[key(w, loan)]?.lastConfirmed).toBe("revoked");
  };
  const disk = (state: KeeperState, suffix: string) => {
    const path = fileURLToPath(new URL(`../../out/rb4-09-v14-${suffix}.json`, import.meta.url));
    try { saveState(path, state); return loadState(path, 1n, D.factory); }
    finally { unlinkSync(path); }
  };
  const clears = (h: H) => h.xlayer.calls.filter((c) => c.functionName === "clearExpiredFlag");
  const family = (h: H) => h.alerts.filter((a) => a.includes("remains suspect") || a.includes("an allowed clear is withheld"));
  const withheld = (h: H) => h.alerts.filter((a) => a.includes("an allowed clear is withheld"));
  const allowed = (w: World, loan: LoanSnapshot) => {
    const readings = loan.collateral.map((id) => clearReading(id, w.seizeFrom, w.now,
      { disabled: w.feedDisabled, enabledAt: Number(w.feedEnabledAt) }, w.reports.get(id), w.records.get(id)).verdict);
    expect(readings[0]).toBe("healthy");
    expect(readings.every((r) => r === "healthy" || r === "missing")).toBe(true);
  };

  it.each(["failed read", "restart"] as const)("R10: withholds an allowed clear after a %s without buying a push", async (how) => {
    const { w, loan } = setup();
    let h = keeperIn(w); unsent(h);
    await establish(h, w, loan);
    for (let i = 0; i < 4; i++) await tick(h, w, 60, loan);
    allowed(w, loan);
    expect(clears(h)).toEqual([]);
    const k = key(w, loan), since = h.k.state.refresh[k]!.suspectSince, before = h.bsc.calls.length;
    if (how === "restart") { h = keeperIn(w, disk(h.k.state, "r10")); unsent(h); }
    else w.bscDown.add(17n);
    await tick(h, w, 60, loan);
    expect(h.k.state.refresh[k]).toMatchObject({ lastConfirmed: "revoked", suspectSince: since, clearWithheldSince: w.now });
    expect(clears(h)).toEqual([]);
    expect(h.bsc.calls).toHaveLength(how === "restart" ? 0 : before);
  });

  it("keeps the condition through successive failed, repeated-block and changed observations and saved-state warm-up", async () => {
    const { w, loan } = setup(), h = keeperIn(w); unsent(h);
    await establish(h, w, loan);
    const k = key(w, loan), before = h.bsc.calls.length;
    w.bscDown.add(17n);
    await tick(h, w, 60, loan);
    expect(h.k.state.refresh[k]?.lastConfirmed).toBe("revoked");
    w.bscDown.delete(17n);
    w.now += 60; w.xNow = w.now;
    await h.p.impairment(D, [loan], 2n, w.now);
    expect(h.k.state.refresh[k]?.lastConfirmed).toBe("revoked");
    w.conditions.set(17n, "stopped");
    await tick(h, w, 60, loan);
    expect(h.k.state.refresh[k]?.lastConfirmed).toBe("revoked");
    w.conditions.set(17n, "healthy");
    await tick(h, w, 60, loan);
    expect(h.k.state.refresh[k]?.lastConfirmed).toBe("revoked");
    expect(clears(h)).toEqual([]); expect(h.bsc.calls).toHaveLength(before);
    const restarted = keeperIn(w, disk(h.k.state, "successive")); unsent(restarted);
    await tick(restarted, w, 60, loan);
    expect(restarted.k.state.refresh[k]?.lastConfirmed).toBe("revoked");
    expect(clears(restarted)).toEqual([]); expect(restarted.bsc.calls).toEqual([]);
    await tick(restarted, w, 60, loan);
    expect(restarted.k.state.refresh[k]?.lastConfirmed).toBeUndefined();
    expect(restarted.k.state.refresh[k]?.clearWithheldSince).toBeUndefined();
    expect(clears(restarted)).toHaveLength(1);
  });

  it("replaces the kept condition on a newly confirmed impairment, and removes it on that rig's confirmed health", async () => {
    const { w, loan } = setup(), h = keeperIn(w); unsent(h);
    await establish(h, w, loan);
    const k = key(w, loan);
    w.conditions.set(17n, "stopped");
    await tick(h, w, 60, loan); expect(h.k.state.refresh[k]?.lastConfirmed).toBe("revoked");
    await tick(h, w, 60, loan); expect(h.k.state.refresh[k]?.lastConfirmed).toBe("stopped");
    w.conditions.set(17n, "healthy");
    await tick(h, w, 60, loan); expect(h.k.state.refresh[k]?.lastConfirmed).toBe("stopped");
    expect(clears(h)).toEqual([]);
    await tick(h, w, 60, loan);
    expect(h.k.state.refresh[k]?.lastConfirmed).toBeUndefined();
    expect(clears(h)).toHaveLength(1);
  });

  it("does not withhold a clear for a rig that has never been confirmed impaired", async () => {
    const { w, loan } = setup(), h = keeperIn(w);
    w.bscDown.add(17n);
    allowed(w, loan);
    await h.cycle(loan); await tick(h, w, 60, loan);
    expect(clears(h)).toHaveLength(2);
    expect(h.k.state.refresh[key(w, loan)]?.lastConfirmed).toBeUndefined();
    expect(h.k.state.refresh[key(w, loan)]?.clearWithheldSince).toBeUndefined();
  });

  it("records the first impaired confirmation even with flag evidence and an allowed clear, then keeps it through failure and restart", async () => {
    const { w, loan } = setup(), h = keeperIn(w); unsent(h);
    w.reports.set(17n, impairedAt(17n, NOW - 20)); w.records.set(17n, { syncedAt: NOW - 10, power: 500n });
    await establish(h, w, loan);
    const k = key(w, loan);
    allowed(w, loan);
    expect(evidenceKind(17n, Number(w.flagFrom), w.now, { disabled: false, enabledAt: 0 }, w.reports.get(17n), w.records.get(17n))).toBe(1);
    expect(h.k.state.refresh[k]?.suspectSince).toBeUndefined();
    expect(h.xlayer.calls.map((c) => [c.functionName, c.args])).toEqual([["flagImpaired", [17n]]]);
    w.bscDown.add(17n);
    await tick(h, w, 60, loan);
    expect(h.k.state.refresh[k]).toMatchObject({ lastConfirmed: "revoked", clearWithheldSince: w.now });
    expect(clears(h)).toEqual([]); expect(h.xlayer.calls).toHaveLength(1);
    const restarted = keeperIn(w, disk(h.k.state, "first-evidence")); unsent(restarted);
    await tick(restarted, w, 60, loan);
    expect(restarted.k.state.refresh[k]?.lastConfirmed).toBe("revoked");
    expect(restarted.xlayer.calls).toEqual([]); expect(restarted.bsc.calls).toEqual([]);
  });

  it("confirmed health of one rig does not remove another rig's retained veto", async () => {
    const { w, loan } = setup([16n, 17n, 18n]), h = keeperIn(w); unsent(h);
    w.conditions.set(18n, "stopped");
    await establish(h, w, loan);
    w.bscDown.add(18n); w.conditions.set(17n, "healthy");
    await tick(h, w, 60, loan);
    const since = w.now;
    expect(h.k.state.refresh[key(w, loan)]?.lastConfirmed).toBe("revoked");
    await tick(h, w, 60, loan);
    expect(h.k.state.refresh[key(w, loan)]?.lastConfirmed).toBeUndefined();
    expect(h.k.state.refresh[key(w, loan)]?.clearWithheldSince).toBeUndefined();
    expect(h.k.state.refresh[key(w, loan, 18n)]?.lastConfirmed).toBe("stopped");
    expect(clears(h)).toEqual([]);
    expect(h.k.state.refresh[key(w, loan, 18n)]?.clearWithheldSince).toBe(since);
  });

  it.each((["none", "window", "expired"] as const).flatMap((phase) => [false, true].map((feedOff) => ({ phase, feedOff }))))
    ("retained state alone authorizes no push, flag, seize or harvest in $phase with usable evidence, feed off=$feedOff", async ({ phase, feedOff }) => {
      const { w, loan } = setup();
      if (phase === "none") { loan.loan.impairedAt = 0; loan.loan.expired = false; }
      if (phase === "window") { loan.loan.expired = false; loan.loan.deadline = NOW + 86_400; w.flagFrom = Number(2n ** 64n - 1n); }
      if (feedOff) w.feedDisabled = true;
      else w.bscDown.add(17n);
      w.reports.set(17n, impairedAt(17n, NOW - 20)); w.records.set(17n, { syncedAt: NOW - 10, power: 500n });
      if (feedOff) w.records.set(17n, { syncedAt: NOW - 10, power: 0n });
      const state = emptyState(1n, D.factory), k = key(w, loan);
      state.refresh[k] = { lastConfirmed: "revoked" };
      const h = keeperIn(w, disk(state, `no-authority-${phase}`));
      const floor = phase === "window" ? w.seizeFrom : Number(w.flagFrom);
      expect(evidenceKind(17n, floor, w.now, { disabled: feedOff, enabledAt: 0 }, w.reports.get(17n), w.records.get(17n))).toBe(feedOff ? 2 : 1);
      expect(pushOpen({ disabled: false, enabledAt: 0 }, w.now)).toBe(true);
      await h.cycle(loan);
      w.now += 60; w.xNow = w.now;
      await h.p.impairment(D, [loan], 1n, w.now);
      expect(h.k.state.refresh[k]?.lastConfirmed).toBe("revoked");
      expect(h.bsc.calls).toEqual([]); expect(h.xlayer.calls).toEqual([]);
    });

  it("keeps another rig's current impairment work while the retained rig has usable evidence and no confirmation", async () => {
    const { w, loan } = setup([16n, 17n, 18n]);
    w.bscDown.add(17n); w.conditions.set(18n, "revoked");
    w.reports.set(17n, impairedAt(17n, NOW - 20)); w.records.set(17n, { syncedAt: NOW - 10, power: 500n });
    const state = emptyState(1n, D.factory); state.refresh[key(w, loan)] = { lastConfirmed: "revoked" };
    const h = keeperIn(w, state); unsent(h);
    await h.cycle(loan); await tick(h, w, 60, loan);
    expect(h.bsc.calls.map((c) => [c.functionName, c.args])).toEqual([["push", [[18n]]]]);
    expect(h.xlayer.calls).toEqual([]);
    w.reports.set(18n, impairedAt(18n, w.now));
    await tick(h, w, 1, loan);
    expect(h.xlayer.calls.map((c) => [c.functionName, c.args])).toEqual([["flagImpaired", [18n]]]);
  });

  it("keeps another healthy rig's bounded recovery push and harvest while the retained rig stays unconfirmed", async () => {
    const { w, loan } = setup([16n, 17n, 18n]);
    w.bscDown.add(17n);
    w.reports.set(18n, healthy(18n, NOW - 10, { totalVerifWeight: 0n }));
    const state = emptyState(1n, D.factory); state.refresh[key(w, loan)] = { lastConfirmed: "revoked" };
    const h = keeperIn(w, state);
    await h.cycle(loan); await tick(h, w, 60, loan); await tick(h, w, 600, loan);
    expect(h.bsc.calls.map((c) => [c.functionName, c.args])).toEqual([["push", [[18n]]], ["harvest", [[18n]]]]);
    expect(h.k.state.refresh[key(w, loan)]?.lastConfirmed).toBe("revoked");
    expect(clears(h)).toEqual([]);
  });

  it.each([false, true])("review M-1: alerts for the window-to-expired withheld clear after restart, usable evidence at deadline=%s", async (evidence) => {
    const expiry = NOW + 180, flagAt = expiry - 96 * 3_600 - 1, seizeStart = flagAt + 72 * 3_600;
    const loan = loanOf({ impairedAt: flagAt, seizeStart, deadline: expiry - 1, impairedRig: 16n }, [16n, 17n]);
    const w = world({ flagFrom: Number(2n ** 64n - 1n), seizeFrom: seizeStart + MAX_CLOCK_SKEW, conditions: new Map([[17n, "stopped"]]),
      reports: new Map([[16n, null], [17n, null]]), records: new Map([[16n, { syncedAt: NOW - 20, power: 500n }], [17n, { syncedAt: NOW - 20, power: 500n }]]) });
    const h = keeperIn(w); unsent(h);
    await h.cycle(loan); await tick(h, w, 60, loan);
    const k = key(w, loan);
    expect(h.k.state.refresh[k]).toMatchObject({ lastConfirmed: "stopped", suspectSince: NOW + 60 });
    w.bscDown.add(17n);
    w.reports.set(17n, healthy(17n, NOW + 61, { stopBlock: 1n })); w.records.set(17n, { syncedAt: NOW + 62, power: 500n });
    await tick(h, w, 60, loan);
    expect(h.k.state.refresh[k]?.suspectSince).toBeUndefined();
    expect(h.k.state.refresh[k]?.lastConfirmed).toBe("stopped");
    loan.loan.expired = true; w.flagFrom = expiry + MAX_CLOCK_SKEW;
    await tick(h, w, 60, loan); allowed(w, loan);
    expect(h.k.state.refresh[k]?.clearWithheldSince).toBe(expiry);
    expect(clears(h)).toEqual([]);
    const alertAt = NOW + 1_440;
    if (evidence) {
      w.reports.set(17n, healthy(17n, alertAt - 2, { stopBlock: 1n })); w.records.set(17n, { syncedAt: alertAt - 1, power: 500n });
    }
    await tick(h, w, alertAt - w.now - 1, loan); allowed(w, loan);
    expect(family(h)).toEqual([]);
    expect(h.k.state.refresh[k]).toMatchObject({ lastConfirmed: "stopped", clearWithheldSince: expiry });
    const restarted = keeperIn(w, disk(h.k.state, `window-expired-${evidence}`)); unsent(restarted);
    await tick(restarted, w, 1, loan); allowed(w, loan);
    expect(family(restarted)).toHaveLength(1); expect(withheld(restarted)).toHaveLength(1);
    expect(withheld(restarted)[0]).toContain("rig 17"); expect(withheld(restarted)[0]).toContain("kept condition stopped");
    expect(withheld(restarted)[0]).toContain("current BSC read unconfirmed");
    expect(withheld(restarted)[0]).not.toContain("no flag evidence"); expect(withheld(restarted)[0]).not.toContain("no seize evidence");
    expect(h.k.state.refresh[k]?.suspectSince).toBeUndefined();
    expect(restarted.k.state.refresh[k]?.impairmentAlerted).toBe(true);
    if (evidence) expect(evidenceKind(17n, Number(w.flagFrom), w.now, { disabled: false, enabledAt: 0 }, w.reports.get(17n), w.records.get(17n))).toBe(1);
    await tick(restarted, w, 1_200, loan);
    expect(family(restarted)).toHaveLength(1); expect(clears(restarted)).toEqual([]);
    expect(restarted.bsc.calls).toEqual([]); expect(restarted.xlayer.calls).toEqual([]);
  });

  it("shares the impairment budget when the evidence timer already alerted before the withheld clear", async () => {
    const { w, loan } = setup(), h = keeperIn(w); unsent(h);
    await establish(h, w, loan); await tick(h, w, 1_200, loan);
    expect(family(h)).toHaveLength(1);
    w.bscDown.add(17n);
    w.reports.set(17n, impairedAt(17n, w.now)); w.records.set(17n, { syncedAt: w.now + 1, power: 500n });
    await tick(h, w, 1, loan);
    const k = key(w, loan), since = w.now;
    expect(h.k.state.refresh[k]).toMatchObject({ clearWithheldSince: since, impairmentAlerted: true });
    expect(h.k.state.refresh[k]?.suspectSince).toBeUndefined();
    const restarted = keeperIn(w, disk(h.k.state, "shared-budget")); unsent(restarted);
    await tick(restarted, w, 1_200, loan);
    expect(family(restarted)).toEqual([]); expect(clears(restarted)).toEqual([]);
  });

  it("records cure-only confirmation and retains it through an unconfirmed window and expiry with a saved-state restart", async () => {
    const { w } = setup();
    const seizeStart = NOW + 1_000, flagAt = seizeStart - 72 * 3_600, expiry = flagAt + 96 * 3_600 + 1;
    const loan = loanOf({ impairedAt: flagAt, seizeStart, deadline: expiry - 1, impairedRig: 16n }, [16n, 17n]);
    w.flagFrom = Number(2n ** 64n - 1n); w.seizeFrom = seizeStart + MAX_CLOCK_SKEW;
    const h = keeperIn(w); unsent(h);
    await h.cycle(loan); await tick(h, w, 60, loan);
    const k = key(w, loan);
    expect(h.k.state.refresh[k]?.lastConfirmed).toBe("revoked");
    expect(h.k.state.refresh[k]?.suspectSince).toBeUndefined(); expect(h.k.state.refresh[k]?.clearWithheldSince).toBeUndefined();
    expect(h.bsc.calls).toEqual([]); expect(h.xlayer.calls).toEqual([]);
    w.bscDown.add(17n);
    await tick(h, w, seizeStart - w.now, loan);
    expect(h.k.state.refresh[k]?.lastConfirmed).toBe("revoked");
    const restarted = keeperIn(w, disk(h.k.state, "live-only")); unsent(restarted);
    await tick(restarted, w, 60, loan);
    loan.loan.expired = true; w.flagFrom = expiry + MAX_CLOCK_SKEW;
    w.records.set(16n, { syncedAt: expiry - 1, power: 500n }); w.records.set(17n, { syncedAt: expiry - 1, power: 500n });
    await tick(restarted, w, expiry - w.now, loan); allowed(w, loan);
    expect(restarted.k.state.refresh[k]).toMatchObject({ lastConfirmed: "revoked", clearWithheldSince: expiry });
    expect(restarted.k.state.refresh[k]?.suspectSince).toBeUndefined();
    expect(restarted.bsc.calls).toEqual([]); expect(restarted.xlayer.calls).toEqual([]);
  });

  it.each((["brake", "freeze", "independent block"] as const).flatMap((interrupt) => [false, true].map((spent) => ({ interrupt, spent }))))
    ("resets only the withheld clock across $interrupt, spent budget=$spent", async ({ interrupt, spent }) => {
      const { w, loan } = setup(), state = emptyState(1n, D.factory), k = key(w, loan);
      w.bscDown.add(17n); state.refresh[k] = { lastConfirmed: "stopped", impairmentAlerted: spent };
      const h = keeperIn(w, disk(state, `reset-${interrupt.replaceAll(" ", "-")}-${spent}`)); unsent(h);
      await h.cycle(loan);
      expect(h.k.state.refresh[k]?.clearWithheldSince).toBe(NOW);
      if (interrupt === "brake") w.feedDisabled = true;
      else if (interrupt === "freeze") h.k.frozen = true;
      else w.reports.delete(16n);
      await tick(h, w, 600, loan);
      expect(h.k.state.refresh[k]?.clearWithheldSince).toBeUndefined();
      expect(h.k.state.refresh[k]).toMatchObject({ lastConfirmed: "stopped", impairmentAlerted: spent });
      if (interrupt === "brake") expect(clears(h)).toHaveLength(1);
      await tick(h, w, 600, loan);
      expect(family(h)).toEqual([]); expect(h.k.state.refresh[k]?.clearWithheldSince).toBeUndefined();
      w.feedDisabled = false; h.k.frozen = false; w.reports.set(16n, null);
      await tick(h, w, 600, loan);
      const since = w.now;
      expect(h.k.state.refresh[k]).toMatchObject({ lastConfirmed: "stopped", clearWithheldSince: since, impairmentAlerted: spent });
      await tick(h, w, 1_199, loan); expect(family(h)).toEqual([]);
      await tick(h, w, 1, loan); expect(family(h)).toHaveLength(spent ? 0 : 1);
      expect(h.k.state.refresh[k]?.impairmentAlerted).toBe(true);
      await tick(h, w, 1_200, loan); expect(family(h)).toHaveLength(spent ? 0 : 1);
    });

  it.each(["replacement flag", "external clear", "closure"] as const)("discards the whole kept record on %s without carrying it into the next incident", async (end) => {
    const { w, loan } = setup(), h = keeperIn(w); unsent(h);
    await establish(h, w, loan);
    w.bscDown.add(17n); await tick(h, w, 60, loan);
    const oldKey = key(w, loan);
    expect(h.k.state.refresh[oldKey]).toMatchObject({ lastConfirmed: "revoked", clearWithheldSince: w.now });
    if (end === "replacement flag") loan.loan.impairedAt++;
    else if (end === "external clear") { loan.loan.impairedAt = 0; loan.loan.expired = false; w.flagFrom = w.now + MAX_CLOCK_SKEW; }
    else loan.loan.open = false;
    const p = h.k as unknown as { harvest(d: Deployment, loans: LoanSnapshot[], block: bigint, now: number): Promise<void> };
    await p.harvest(D, [loan], 4n, w.now);
    await tick(h, w, 1, loan);
    expect(h.k.state.refresh[oldKey]).toBeUndefined();
    expect(h.k.state.refresh[key(w, loan)]?.lastConfirmed).toBeUndefined();
    expect(h.k.state.refresh[key(w, loan)]?.clearWithheldSince).toBeUndefined();
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

  it("L-3: sends no initial refresh harvest for row U on the flagged rig; every unknown rig needs its own recovery", async () => {
    const FLOOR = NOW - 86_400;
    const feed: FeedView = { disabled: false, enabledAt: NOW - 100 }; // enable floor NOW - 40
    const masked = healthy(16n, NOW - 41); // row U over an older positive record
    const old = { syncedAt: FLOOR, power: 500n };
    expect(clearPlan(16n, 16n, FLOOR, NOW, masked, old, {}, { feed, confirmed: "healthy" })).toMatchObject({ row: "U", blocks: true, harvest: false });
    expect(clearPlan(16n, 16n, FLOOR, NOW, masked, old, {}, { feed, confirmed: null })).toMatchObject({ row: "U", harvest: false, pushOnce: false }); // RB4-05: wait for a healthy BSC confirmation
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
