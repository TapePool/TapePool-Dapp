// RB4-02: raw miner ingestion, stored report units and unknown custody at the callers.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address } from "viem";
import type { Deployment } from "../src/addresses.js";
import type { Alerts } from "../src/alerts.js";
import type { Clients } from "../src/chains.js";
import type { Config } from "../src/config.js";
import { Keeper } from "../src/keeper.js";
import { classify, initialConfirmState, observe } from "../src/logic/confirm.js";
import { evidenceKind, reportVerdict, type Report } from "../src/logic/evidence.js";
import { PushLimiter } from "../src/logic/pushLimits.js";
import { coveredLoan } from "../src/logic/schedule.js";
import { PushService } from "../src/push.js";
import { bonusWeight, readBscRigs, readReports, type LoanSnapshot } from "../src/reads.js";
import { emptyState } from "../src/state.js";
import type { Call, Sender } from "../src/tx.js";

const CELL = "0x00000000000000000000000000000000000000ab" as Address;
const OTHER = "0x00000000000000000000000000000000000000ac" as Address;
const NOW = 1_800_000_000;
const D: Deployment = { pool: OTHER, factory: OTHER, screen: OTHER, receiver: OTHER, reporter: OTHER, factoryDeployBlock: 1n };
interface Vector { mult: string; bstar: string; rawBonus: string; verifWeight: string; bonus: string; base: string }
const vectors = JSON.parse(readFileSync(new URL("./fixtures/bonus-vectors.json", import.meta.url), "utf8")) as Vector[];
const stored: Report = { rigId: 16n, observedAt: BigInt(NOW), status: 1, stopBlock: 0n, custodied: true, verifWeight: 456n, bonus: 432n, totalVerifWeight: 1000n };

function fixture(owner: unknown = BigInt(CELL), cell: Address = CELL) {
  const w = { report: stored, feedEnabledAt: 0n };
  const requests: { functionName: string; blockNumber?: bigint }[] = [];
  let miner = { status: 1, stopBlock: 0n, since: 1n, taskId: 4, verifWeight: 500n, bonus: 0n, bstar: 500n, mult: 1 };
  const c = { account: { address: OTHER }, bsc: { public: {
    getBlock: async () => ({ number: 10n, timestamp: BigInt(NOW) }),
    readContract: async () => 0n,
    multicall: async ({ contracts, blockNumber }: { contracts: { functionName: string; args: unknown[] }[]; blockNumber?: bigint }) => contracts.map((q) => {
      requests.push({ functionName: q.functionName, blockNumber });
      if (q.functionName === "ownerOf" && owner instanceof Error) return { status: "failure", error: owner };
      return { status: "success", result: ({ rigs: [CELL, q.args[0]], getMiner: miner, pending: 50_000n, cellOf: cell, balanceOf: 0n, ownerOf: typeof owner === "function" ? owner(q.args[0]) : owner } as Record<string, unknown>)[q.functionName] };
    }),
  } }, xlayer: { public: {
    getBlock: async () => ({ number: 10n, timestamp: BigInt(NOW) }),
    readContract: async ({ functionName }: { functionName: string }) => ({ feedDisabled: false, feedEnabledAt: w.feedEnabledAt, flagEvidenceFrom: 100n, seizeEvidenceFrom: 100n, balanceOf: 0n } as Record<string, unknown>)[functionName],
    multicall: async ({ contracts }: { contracts: { functionName: string }[] }) => contracts.map((q) => ({ status: "success", result: ({ latest: [w.report, true], suspended: false, passOf: [{}, false], isEffective: true, rigs: [CELL, 1n, 16n, 500n] } as Record<string, unknown>)[q.functionName] })),
  } } } as unknown as Clients;
  return { c, w, requests, setMiner: (m: typeof miner) => { miner = m; } };
}

describe("RB4-02 bonus units", () => {
  it("uses all six generated production reader vectors", () => expect(vectors).toHaveLength(6));
  it.each(vectors)("normalizes mult $mult, bstar $bstar, weight $verifWeight once", async (v) => {
    const f = fixture();
    const m = { status: 1, stopBlock: 0n, since: 1n, taskId: 4, verifWeight: BigInt(v.verifWeight), bonus: BigInt(v.rawBonus), bstar: BigInt(v.bstar), mult: Number(v.mult) };
    expect(bonusWeight(m)).toBe(BigInt(v.bonus));
    expect(bonusWeight({ ...m, bonus: 0n } as typeof m)).toBe(BigInt(v.bonus));
    f.setMiner(m);
    const [r] = await readBscRigs(f.c, [16n], 10n);
    expect(r!.ok).toBe(true);
    expect(r!.bonus).toBe(BigInt(v.bonus));
    expect(r!.verifWeight - r!.bonus).toBe(BigInt(v.base));
    expect(classify(r!)).toBe(v.base === "0" ? "noBase" : "healthy");
    const report = { ...stored, verifWeight: r!.verifWeight, bonus: r!.bonus };
    expect(reportVerdict(report, 16n, 100, NOW)).toBe(v.base === "0" ? "impaired" : "healthy");
    expect(evidenceKind(16n, 100, NOW, { disabled: false, enabledAt: 0 }, report, undefined)).toBe(v.base === "0" ? 1 : 0);
  });

  it("reads a stored report without raw fields or a second bonus conversion", async () => {
    const f = fixture();
    const reports = await readReports(f.c, D, [16n]);
    expect(reports.get(16n)).toEqual(stored);
    expect(reports.get(16n)!.bonus).toBe(432n);
    expect(reportVerdict(reports.get(16n)!, 16n, 100, NOW)).toBe("healthy");
    expect(f.requests).toEqual([]);
  });

  it("preserves a TapeOut miner's weight-unit bonus at multiplier one", async () => {
    const f = fixture();
    f.setMiner({ status: 1, stopBlock: 0n, since: 1n, taskId: 4, verifWeight: 1248n, bonus: 248n, bstar: 1000n, mult: 1 });
    expect((await readBscRigs(f.c, [16n], 10n))[0]!.bonus).toBe(248n);
  });
});

describe("RB4-02 custody outcomes", () => {
  it.each([new Error("reverted"), zeroAddress, 0n, "0x12", `0x${"ff".repeat(32)}`, (1n << 160n) + BigInt(CELL)])("keeps unreadable or zero owner %s unknown", async (owner) => {
    const f = fixture(owner);
    const [r] = await readBscRigs(f.c, [16n], 10n);
    expect(r!.ok).toBe(false);
    expect(coveredLoan([r!], 0n, 1n, 0n, 1n)).toBeNull();
    const state = initialConfirmState();
    expect(observe(state, 16n, r!.ok ? { condition: classify(r!), block: 10n } : null)).toBeNull();
    expect(state.last.size).toBe(0);
    expect(f.requests.every((q) => q.blockNumber === 10n)).toBe(true);
  });

  it("keeps another rig readable when one owner is unknown", async () => {
    const f = fixture((id: bigint) => id === 16n ? 0n : BigInt(CELL));
    const rigs = await readBscRigs(f.c, [16n, 17n], 10n);
    expect(rigs[0]).toMatchObject({ id: 16n, ok: false });
    expect(rigs[1]).toMatchObject({ id: 17n, ok: true, custodied: true, bonus: 0n });
  });

  it("a valid other owner is known not custodied", async () => {
    const [r] = await readBscRigs(fixture(BigInt(OTHER)).c, [16n], 10n);
    expect(r).toMatchObject({ ok: true, custodied: false });
    expect(classify(r!)).toBe("rescue");
  });

  it("a zero cell is known not custodied and makes no owner call", async () => {
    const f = fixture(new Error("must not read"), zeroAddress);
    const [r] = await readBscRigs(f.c, [16n], 10n);
    expect(r).toMatchObject({ ok: true, custodied: false, cellBalance: 0n });
    expect(f.requests.some((q) => q.functionName === "ownerOf")).toBe(false);
    expect(classify(r!)).toBe("rescue");
  });
});

function callerFixture() {
  const f = fixture(0n);
  const calls: Call[] = [];
  const sender = { send: async (c: Call) => { calls.push(c); return { status: "dry" }; }, hasPending: () => false } as unknown as Sender;
  const cfg = { mode: "dry", bnbReserve: 0n, suspendOnRevoke: true } as Config;
  const messages: string[] = [];
  const alerts = { send: vi.fn(async (_key: string, message: string) => { messages.push(message); }) } as unknown as Alerts;
  const keeper = new Keeper(cfg, f.c, D, alerts, { bsc: sender, xlayer: sender }, emptyState(1n, D.factory), () => NOW);
  return { ...f, cfg, sender, keeper, calls, messages };
}
const loan: LoanSnapshot = { agent: OTHER, start: 100, maturity: NOW + 86_400, closed: false, bem: 0n, collateral: [16n], loan: { open: true, impairedAt: 0, impairedRig: 0n, seizeStart: 0, deadline: 0, expired: false, debt: 1n } };
interface PrivateKeeper {
  coveredLoans: (loans: LoanSnapshot[], block: bigint, now: number) => Promise<Set<string>>;
  sendHarvest: (ids: bigint[], block: bigint) => Promise<{ allDone: boolean; sent: Set<bigint> }>;
  refreshHarvest: (d: Deployment, loan: LoanSnapshot, ids: bigint[], block: bigint, now: number, bounded: boolean) => Promise<void>;
  evidenceHarvest: (d: Deployment, due: { rig: bigint; ek: string; kind: "first"; impairedAt: number }[], loans: LoanSnapshot[], block: bigint, now: number) => Promise<void>;
  scanLogs: (d: Deployment) => Promise<void>;
  impairment: (d: Deployment, loans: LoanSnapshot[], block: bigint, now: number) => Promise<void>;
}

describe("RB4-02 unknown custody at callers", () => {
  it("defers covered checks and leaves scheduled harvest incomplete", async () => {
    const f = callerFixture(), p = f.keeper as unknown as PrivateKeeper;
    expect((await p.coveredLoans([loan], 10n, NOW)).size).toBe(0);
    expect(await p.sendHarvest([16n], 10n)).toEqual({ allDone: false, sent: new Set() });
    expect(f.calls).toEqual([]);
    expect(f.keeper.state.harvest.loans).toEqual({});
  });

  it("sends no evidence or recovery harvest and spends no incident allowance", async () => {
    const f = callerFixture(), p = f.keeper as unknown as PrivateKeeper;
    await p.refreshHarvest(D, loan, [16n], 10n, NOW, true);
    await p.evidenceHarvest(D, [{ rig: 16n, ek: "test", kind: "first", impairedAt: 0 }], [loan], 10n, NOW);
    expect(f.calls).toEqual([]);
    expect(f.keeper.state.evidence).toEqual({});
    expect(f.keeper.state.refresh).toEqual({});
  });

  it("confirms no BSC impairment on successive unknown reads", async () => {
    const f = callerFixture(), p = f.keeper as unknown as PrivateKeeper;
    await p.impairment(D, [loan], 10n, NOW);
    await p.impairment(D, [loan], 11n, NOW + 60);
    expect(f.calls).toEqual([]);
  });

  it("refuses requested-push eligibility", async () => {
    const f = callerFixture();
    const push = new PushService(f.cfg, f.c, D, f.sender, new PushLimiter(), () => false, () => {}, () => NOW);
    const p = push as unknown as { eligibility: (d: Deployment, ids: bigint[], now: number) => Promise<Map<bigint, boolean>> };
    expect((await p.eligibility(D, [16n], NOW)).get(16n)).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("does not spend row-U recovery attempts without confirmed BSC health", async () => {
    const f = callerFixture(), p = f.keeper as unknown as PrivateKeeper;
    f.w.feedEnabledAt = BigInt(NOW - 100);
    f.w.report = { ...stored, observedAt: BigInt(NOW - 50) };
    const expired = { ...loan, loan: { ...loan.loan, impairedAt: 100, expired: true, impairedRig: 16n } };
    await p.impairment(D, [expired], 10n, NOW);
    await p.impairment(D, [expired], 11n, NOW + 1);
    expect(f.calls).toEqual([]);
    expect(Object.values(f.keeper.state.refresh)).toEqual([{ unknown: true, unconfirmed: 2 }]);
  });

  it("reports unknown in an independent flag-event alert", async () => {
    const f = callerFixture(), p = f.keeper as unknown as PrivateKeeper;
    f.keeper.state.agents[OTHER] = OTHER;
    Object.assign(f.c.xlayer.public, {
      getBlockNumber: async () => 100n,
      getContractEvents: async ({ eventName }: { eventName?: string }) => eventName === "ImpairmentFlagged"
        ? [{ args: { rigId: 16n }, address: OTHER, transactionHash: "0x01", logIndex: 0 }] : [],
    });
    await p.scanLogs(D);
    expect(f.messages.some((m) => m.includes("rig 16: unknown"))).toBe(true);
    expect(f.calls).toEqual([]);
  });
});
