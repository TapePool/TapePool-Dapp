import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BaseError, ContractFunctionRevertedError, encodeAbiParameters, encodeErrorResult, encodeEventTopics, keccak256, parseEther, type Address, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentAbi, contractErrors, factoryAbi, ledgerEvents, lensAbi, poolAbi, receiverAbi, reporterAbi, screenAbi, shareAbi } from "../src/abi.js";
import { ADDR, DEPLOYMENT, type Deployment } from "../src/addresses.js";
import { loadConfig, loadDeployment } from "../src/config.js";
import { Keeper } from "../src/keeper.js";
import { bnbSpent, dailySpend, STARTUP_DAILY_SPEND } from "../src/logic/budget.js";
import { clearPlan, reportVerdict, verdict, type Report } from "../src/logic/evidence.js";
import { syncDue, type IncomeState } from "../src/logic/income.js";
import { nextActions, type MachineInput } from "../src/logic/loanMachine.js";
import { PushLimiter } from "../src/logic/pushLimits.js";
import { isolatedPush } from "../src/pushIsolation.js";
import { PushService } from "../src/push.js";
import { readBscRigs, readLoans, type LoanSnapshot } from "../src/reads.js";
import { emptyState, loadState, saveState } from "../src/state.js";
import { Sender, type Call, type PendingTx, type SendResult } from "../src/tx.js";
import { startHttp } from "../src/http.js";
import type { Clients, ChainClients } from "../src/chains.js";
import type { Alerts } from "../src/alerts.js";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const AGENT = A(101), CELL = A(102), BORROWER = A(103);
const D: Deployment = { pool: A(1), factory: A(2), screen: A(3), receiver: A(4), reporter: A(5), factoryDeployBlock: 1n };
const NOW = 1_000_000;
const DAY = 86_400;
const cfg = () => loadConfig({ KEEPER_MODE: "live", KEEPER_PRIVATE_KEY: `0x${"11".repeat(32)}`, BSC_RPC: "http://x", TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "1" });
const report = (id = 16n, at = NOW, over: Partial<Report> = {}): Report => ({ rigId: id, observedAt: BigInt(at), status: 1, stopBlock: 0n, custodied: true, verifWeight: 500n, bonus: 0n, totalVerifWeight: 1000n, ...over });
const custodyError = () => new BaseError("quote failed", { cause: new ContractFunctionRevertedError({ abi: reporterAbi, data: encodeErrorResult({ abi: reporterAbi, errorName: "CustodyUnreadable", args: [17n] }), functionName: "quote" }) });

function sender(results: SendResult[] = []) {
  const calls: Call[] = [];
  return { calls, send: async (call: Call) => { calls.push(call); return results.shift() ?? { status: "sent", hash: "0x01" }; }, poll: async () => {}, hasPending: () => false } as unknown as Sender & { calls: Call[] };
}
function make(c: Clients, bsc = sender(), xlayer = sender(), now = () => NOW) {
  const alerts: string[] = [];
  const alert = { send: async (_kind: string, text: string) => void alerts.push(text) } as unknown as Alerts;
  const k = new Keeper(cfg(), c, D, alert, { bsc, xlayer }, emptyState(1n, D.factory), now);
  return { k, alerts, bsc, xlayer, p: k as unknown as {
    income(d: Deployment, now: number): Promise<void>;
    impairment(d: Deployment, loans: LoanSnapshot[], block: bigint, now: number): Promise<void>;
    coverage(d: Deployment, rig: bigint, day: number): Promise<string>;
    balances(now: number): Promise<void>;
    backstop(d: Deployment): Promise<void>;
    scanLogs(d: Deployment): Promise<void>;
    act(d: Deployment, agent: Address, action: unknown, now: number): Promise<void>;
  } };
}

describe("RB-01 deployment and ABI", () => {
  it("keeps dry mode and the old deployment by default and rejects partial/unacknowledged cutovers", () => {
    expect(loadDeployment({})).toBe(DEPLOYMENT);
    expect(DEPLOYMENT?.legacy).toBe(true);
    expect(loadConfig({ KEEPER_PRIVATE_KEY: `0x${"11".repeat(32)}`, BSC_RPC: "x", TELEGRAM_BOT_TOKEN: "x", TELEGRAM_CHAT_ID: "x" }).mode).toBe("dry");
    expect(() => loadDeployment({ KEEPER_POOL: A(1) })).toThrow("RD02");
    expect(() => loadDeployment({ KEEPER_POOL: A(1), KEEPER_CUTOVER_RD02: "confirmed" })).toThrow("KEEPER_FACTORY");
    const env: Record<string, string> = { KEEPER_CUTOVER_RD02: "confirmed" };
    ["POOL", "FACTORY", "SCREEN", "RECEIVER", "REPORTER", "LENS"].forEach((key, i) => env[`KEEPER_${key}`] = A(i + 1));
    ["POOL", "FACTORY", "RECEIVER", "REPORTER"].forEach((key) => env[`KEEPER_${key}_DEPLOY_BLOCK`] = "123");
    expect(loadDeployment(env)).toMatchObject({ legacy: false, pool: A(1), lens: A(6), reporterDeployBlock: 123n });
    expect(() => loadDeployment({ ...env, KEEPER_POOL_DEPLOY_BLOCK: "-1" })).toThrow("positive block");
  });

  it.skipIf(!existsSync(new URL("../../out/", import.meta.url)))("matches the keeper ABIs to current out/ artifacts, including tuple components (run forge build first)", () => {
    const artifacts = ["TapePool", "RigAgent", "RigReporter", "TapeLens", "RigScreen", "RigFeedReceiver", "AgentFactory"];
    const built = Object.fromEntries(artifacts.map((name) => [name, JSON.parse(readFileSync(new URL(`../../out/${name}.sol/${name}.json`, import.meta.url), "utf8")).abi as { type: string; name?: string }[]]));
    const shape = (value: unknown): unknown => Array.isArray(value) ? value.map(shape) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key, child]) => key !== "name" && key !== "internalType" && !((key === "anonymous" || key === "indexed") && child === false)).map(([key, child]) => [key, shape(child)])) : value;
    const check = (abi: readonly unknown[], artifact: string) => {
      for (const entry of abi as { type: string; name?: string }[]) {
        // Error ABIs deliberately include all contracts' errors for decoded simulation failures.
        if (entry.type === "error") continue;
        expect(shape(built[artifact]!.find((e) => e.type === entry.type && e.name === entry.name)), `${artifact}.${entry.name}`).toEqual(shape(entry));
      }
    };
    check(poolAbi, "TapePool"); check(agentAbi, "RigAgent"); check(reporterAbi, "RigReporter"); check(lensAbi, "TapeLens");
    check(screenAbi, "RigScreen"); check(receiverAbi, "RigFeedReceiver"); check(factoryAbi, "AgentFactory");
    check(ledgerEvents, "TapePool"); check(shareAbi, "TapePool");
    for (const entry of contractErrors) expect(shape(Object.values(built).flat().find((e) => e.type === "error" && e.name === entry.name)), entry.name).toEqual(shape(entry));
  });
});

describe("RB-02 income", () => {
  it("uses a strict threshold and persists the positive age across restart and changing small amounts", () => {
    const s: IncomeState = {};
    expect(syncDue(s, 10_000n, 0n, NOW)).toBe(false);
    expect(syncDue(s, 1n, 0n, NOW + DAY - 1)).toBe(false);
    const path = join(mkdtempSync(join(tmpdir(), "keeper-income-")), "state.json");
    const state = emptyState(1n, D.factory); state.income = s;
    saveState(path, state);
    expect(syncDue(loadState(path, 1n, D.factory).income, 1n, 0n, NOW + DAY)).toBe(true);
    expect(syncDue({}, 10_001n, 0n, NOW)).toBe(true);
    expect(syncDue(s, 1n, 1n, NOW + DAY)).toBe(false);
    expect(s.positiveSince).toBeUndefined();
  });

  it("re-reads after success, third-party sync and failure; equal successive surpluses are independent", async () => {
    let balance = 20_000n, tracked = 0n, reads = 0, pending = false;
    const x = sender([{ status: "sent", hash: "0x01" }, { status: "reverted", reason: "temporary" }, { status: "sent", hash: "0x02" }]);
    x.hasPending = () => pending;
    const c = { xlayer: { public: { getBlockNumber: async () => 1n, readContract: async ({ functionName }: { functionName: string }) => { reads++; return functionName === "tracked" ? tracked : balance; } } } } as unknown as Clients;
    const { p } = make(c, sender(), x);
    await p.income(D, NOW); pending = true;
    await p.income(D, NOW + 60); expect(x.calls).toHaveLength(1);
    pending = false; tracked = balance; // success or a third-party sync
    await p.income(D, NOW + 120); expect(x.calls).toHaveLength(1);
    balance += 20_000n;
    await p.income(D, NOW + 180); // failed simulation, surplus unchanged
    await p.income(D, NOW + 240); expect(x.calls).toHaveLength(3);
    expect(reads).toBe(10);
  });

  it("restores an in-flight sync and accounts failed mined sends once, including an older replacement hash", async () => {
    let nonce = 0, mined = false;
    let hash: Hex;
    const chain = { name: "xlayer", public: {
      simulateContract: async () => ({ request: {} }), getGasPrice: async () => 1n,
      estimateGas: async () => 100_000n,
      getTransactionCount: async () => nonce,
      getTransactionReceipt: async (q: { hash: string }) => mined && q.hash === hash ? { status: "reverted", gasUsed: 2n, effectiveGasPrice: 3n, logs: [] } : null,
    }, wallet: { account: privateKeyToAccount(`0x${"11".repeat(32)}`), chain: { id: 196 }, sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => hash = keccak256(serializedTransaction) } } as unknown as ChainClients;
    const journal: PendingTx[] = [], spent: bigint[] = [];
    const opt = { mode: "live" as const, capWei: 10n, stuckAfterSec: 180, alert: () => {}, journal, mined: (call: Call, receipt: TransactionReceipt) => { if (call.label === "sync income") spent.push(receipt.gasUsed * receipt.effectiveGasPrice); } };
    await new Sender(chain, opt).send({ label: "sync income", address: D.pool, abi: poolAbi, functionName: "sync", urgency: "routine" });
    journal[0]!.hash = `0x${"22".repeat(32)}`;
    journal[0]!.hashes.push(journal[0]!.hash);
    const restored = new Sender(chain, { ...opt, journal: JSON.parse(JSON.stringify(journal)) });
    expect(restored.hasPending("sync income")).toBe(true);
    mined = true; nonce = 1;
    await restored.poll(); await restored.poll();
    expect(restored.hasPending("sync income")).toBe(false);
    expect(spent).toEqual([6n]);
  });
});

describe("RB-03 states and evidence floors", () => {
  const machine = (over: Partial<MachineInput> = {}): MachineInput => ({ now: NOW, loan: { open: true, impairedAt: 0, seizeStart: NOW - 100, deadline: NOW + 100, expired: false, impairedRig: 16n }, rigs: [{ id: 16n, confirmed: "stopped", storedObservedAt: NOW, lastPushAt: 0, passSuspended: true, report: report(16n, NOW, { status: 3 }) }], feedDisabled: false, suspendOnRevoke: true, flagEvidenceFrom: NOW, seizeEvidenceFrom: NOW, clearAllowed: false, ...over });
  it("accepts reused or third-party reports exactly at the agent floor and rejects one second earlier", () => {
    expect(nextActions(machine())).toEqual([{ kind: "flag", rig: 16n }]);
    expect(nextActions(machine({ flagEvidenceFrom: NOW + 1 }))).toEqual([{ kind: "push", rigs: [16n] }]);
    const live = { ...machine().loan, impairedAt: 1, seizeStart: NOW + 1 };
    expect(nextActions(machine({ loan: live }))).toEqual([]);
    expect(nextActions(machine({ loan: { ...live, seizeStart: NOW } }))).toEqual([{ kind: "seize" }]);
    expect(nextActions(machine({ loan: { ...live, seizeStart: NOW }, seizeEvidenceFrom: NOW + 1 }))).toEqual([{ kind: "push", rigs: [16n] }]);
  });
  it("permits voucher evidence while disabled, but an expired flag only alerts, even after a late brake", () => {
    const m = machine({ feedDisabled: true });
    expect(nextActions(m)).toEqual([]);
    m.rigs[0]!.voucherPower = 0n; m.rigs[0]!.voucherSyncedAt = NOW;
    expect(nextActions(m)).toEqual([{ kind: "flag", rig: 16n }]);
    m.loan.impairedAt = 1; m.loan.deadline = Infinity;
    expect(nextActions(m)).toEqual([{ kind: "seize" }]);
    m.loan.expired = true;
    expect(nextActions(m)).toMatchObject([{ kind: "alert" }]);
  });
  it("does not turn a paused uint64 deadline into an imprecise timestamp", async () => {
    const c = { xlayer: { public: { multicall: async () => [
      { status: "success", result: { open: true, start: 1n, maturity: 2n, impairedAt: 3n, impairedRig: 16n, seizeStart: 4n, deadline: 2n ** 64n - 1n, expired: false, debt: 1n } },
      { status: "success", result: [16n] }, { status: "success", result: false }, { status: "success", result: 0n },
    ] } } } as unknown as Clients;
    expect((await readLoans(c, [AGENT]))[0]!.loan.deadline).toBe(Infinity);
  });
});

describe("RB-04 push isolation", () => {
  afterEach(() => vi.useRealTimers());
  it("splits quote and send failures, excludes unreadable rigs and waits only for sent rigs", async () => {
    const excluded: bigint[] = [], sent: bigint[][] = [];
    const quote = async (ids: bigint[]) => { if (ids.includes(17n)) throw custodyError(); return 10n; };
    const result = await isolatedPush([16n, 17n, 18n], quote, async (ids) => { sent.push(ids); return { status: "sent", hash: "0x01" }; }, (id) => excluded.push(id));
    expect(sent).toEqual([[16n], [18n]]); expect(excluded).toEqual([17n]); expect(result.map((r) => r.ids)).toEqual(sent);
    let first = true;
    const sendFailed = await isolatedPush([16n, 17n], async () => 10n, async (ids) => {
      if (first) { first = false; return { status: "reverted", reason: "CustodyUnreadable" }; }
      return ids[0] === 17n ? { status: "reverted", reason: "CustodyUnreadable" } : { status: "sent", hash: "0x01" };
    }, (id) => excluded.push(id));
    expect(sendFailed.map((r) => r.ids)).toEqual([[16n]]);
    await expect(isolatedPush([16n], async () => { throw new Error("rpc"); }, async () => ({ status: "dry" }), () => {})).rejects.toThrow("rpc");
  });
  it("does not classify failed custody as rescue", async () => {
    const c = { bsc: { public: { multicall: async ({ contracts }: { contracts: { functionName: string }[] }) => contracts.map(({ functionName }) => functionName === "ownerOf" ? { status: "failure" } : { status: "success", result: ({ rigs: [CELL, 16n], getMiner: { status: 1, stopBlock: 0n, verifWeight: 1n, bonus: 0n }, pending: 0n, cellOf: CELL, balanceOf: 0n } as Record<string, unknown>)[functionName] }) } } } as unknown as Clients;
    expect((await readBscRigs(c, [16n], 1n))[0]!.ok).toBe(false);
  });
  it("isolates request pushes per rig and shares the once-per-day custody alert with the keeper", async () => {
    vi.useFakeTimers();
    const alerts: string[] = [], sent = sender(), custodyAlerts: Record<string, number> = {};
    const c = { account: { address: A(100) }, bsc: { public: {
      getBalance: async () => parseEther("1"),
      readContract: async (q: { args: bigint[][] }) => { if (q.args[0]!.includes(17n)) throw custodyError(); return 10n; },
    } }, xlayer: { public: { multicall: async () => [16n, 17n, 18n].map(() => ({ status: "success", result: [report(16n, NOW - 1000), true] })) } } } as unknown as Clients;
    const svc = new PushService(cfg(), c, D, sent, new PushLimiter(), () => false, (_k, text) => void alerts.push(text), () => NOW, undefined, custodyAlerts);
    (svc as unknown as { inputs: () => Promise<unknown> }).inputs = async () => ({ isAgent: true, borrower: BORROWER, ids: [16n, 17n, 18n], eligible: new Map([[16n, true], [17n, true], [18n, true]]) });
    expect((await svc.request(AGENT, "1" )).status).toBe("queued");
    await svc.flush();
    expect(sent.calls.map((call) => call.args)).toEqual([[[16n]], [[18n]]]);
    expect(alerts).toHaveLength(1);
    expect((await svc.request(AGENT, "2")).status).toBe("queued");
    expect(alerts).toHaveLength(1);
    expect(custodyAlerts["17"]).toBe(Math.floor(NOW / DAY));
    const other = make(c);
    other.k.state.custodyAlerts = custodyAlerts;
    await other.p.act(D, AGENT, { kind: "push", rigs: [17n] }, NOW);
    expect(other.alerts).toEqual([]);
  });
});

describe("RB-05 sponsorship", () => {
  afterEach(() => vi.useRealTimers());
  it("enforces UTC daily and exact rolling seven-day quotas, retaining eight days across restart", () => {
    const counts: Record<string, number> = {};
    const request = (now: number) => ({ now, mode: "live" as const, frozen: false, isAgent: true, borrower: BORROWER, ids: [16n], eligible: () => true, storedObservedAt: () => 0, balance: 100n, fee: 1n, reserve: 1n, dailyMax: 100 });
    let limiter = new PushLimiter(counts);
    for (let d = 0; d < 3; d++) for (let i = 0; i < 3; i++) expect(limiter.decide(request(NOW + d * DAY)).status).toBe("queued");
    expect(limiter.decide(request(NOW + 3 * DAY)).status).toBe("queued");
    expect(limiter.decide(request(NOW + 3 * DAY)).reason).toContain("weekly limit");
    limiter = new PushLimiter(JSON.parse(JSON.stringify(counts)));
    expect(limiter.decide(request(NOW + 7 * DAY - 1)).status).toBe("refused");
    expect(limiter.decide(request(NOW + 7 * DAY)).status).toBe("queued");
    new PushLimiter(counts).prune(NOW + 8 * DAY);
    expect(counts[`s:16:${NOW}`]).toBe(3);
    new PushLimiter(counts).prune(NOW + 8 * DAY + 1);
    expect(counts[`s:16:${NOW}`]).toBeUndefined();
  });

  it("HTTP-to-limiter: repeated third-party fresh replies and pending joins never charge rig or borrower quotas", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let fresh = true;
    const counts: Record<string, number> = {}, bsc = sender();
    const c = { account: { address: A(100) }, bsc: { public: { getBalance: async () => parseEther("1"), readContract: async () => 10n } }, xlayer: { public: { multicall: async () => [{ status: "success", result: [report(16n, fresh ? NOW : NOW - 1000), true] }] } } } as unknown as Clients;
    const service = new PushService(cfg(), c, D, bsc, new PushLimiter(counts), () => false, () => {}, () => NOW);
    (service as unknown as { inputs: () => Promise<unknown> }).inputs = async () => ({ isAgent: true, borrower: BORROWER, ids: [16n], eligible: new Map([[16n, true]]) });
    const server = startHttp(0, [], service, () => ({ ok: true }));
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const post = async () => (await fetch(`http://127.0.0.1:${port}/v1/push`, { method: "POST", body: JSON.stringify({ agent: AGENT }) })).json();
    try {
      for (let i = 0; i < 4; i++) expect(await post()).toEqual({ status: "fresh" });
      expect(Object.keys(counts).filter((k) => /^[rbs]:/.test(k))).toEqual([]);
      fresh = false;
      expect(await post()).toEqual({ status: "queued" });
      const before = Object.fromEntries(Object.entries(counts).filter(([k]) => !/^(ip|req):/.test(k)));
      for (let i = 0; i < 4; i++) expect(await post()).toEqual({ status: "queued" });
      expect(Object.fromEntries(Object.entries(counts).filter(([k]) => !/^(ip|req):/.test(k)))).toEqual(before);
      await service.flush();
      expect(bsc.calls).toHaveLength(1);
      expect(await post()).toEqual({ status: "queued" }); // join a sent push as well
    } finally { server.close(); }
  });
});

describe("RB-06 and RB-07 budget and fee modes", () => {
  it("uses startup and trailing-seven-day spend, excludes BEM bonds, and includes failed transaction gas", () => {
    expect(dailySpend([], NOW, NOW + 1)).toBe(STARTUP_DAILY_SPEND);
    expect(dailySpend([{ at: NOW - 7 * DAY, amount: "9999" }, { at: NOW, amount: "70" }], NOW - 8 * DAY, NOW)).toBe(10n);
    const call: Call = { label: "harvest [16]", address: D.reporter, abi: reporterAbi, functionName: "push", value: 11n, urgency: "routine" };
    const receipt = { status: "reverted", gasUsed: 2n, effectiveGasPrice: 3n, logs: [] } as unknown as TransactionReceipt;
    expect(bnbSpent(call, receipt)).toBe(6n);
    expect(bnbSpent(call, { ...receipt, status: "success" })).toBe(17n);
    expect(bnbSpent({ ...call, label: "approve BEM bond float" }, receipt)).toBe(null);
    const topics = encodeEventTopics({ abi: reporterAbi, eventName: "Pushed", args: { guid: `0x${"00".repeat(32)}` } });
    const log = { address: D.reporter, data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1n, 10n]), topics };
    expect(bnbSpent({ ...call, label: "push [16]" }, { ...receipt, status: "success", logs: [log] } as unknown as TransactionReceipt)).toBe(16n);
  });
  it.each([[0n, 0n], [0n, 1n], [1n, 1n]])("handles term fees %s/%s with and without a conversion rate", async (fee7, fee14) => {
    const bscReads = vi.fn(async () => 100n);
    const c = { bsc: { public: { readContract: bscReads, getGasPrice: async () => 1n } }, xlayer: { public: { readContract: async ({ args }: { args: number[] }) => args[0] === 0 ? fee7 : fee14 } } } as unknown as Clients;
    const { p, alerts, k } = make(c);
    const line = await p.coverage(D, 16n, 11);
    if (fee7 === 0n && fee14 === 0n) {
      expect(line).toContain("7d sponsored, 14d sponsored"); expect(alerts).toEqual([]); expect(bscReads).not.toHaveBeenCalled();
    } else expect(alerts).toEqual(["fee coverage not configured: set OKB_PER_BNB"]);
    (k as unknown as { cfg: { okbPerBnb: bigint | null } }).cfg.okbPerBnb = parseEther("1");
    alerts.length = 0;
    await p.coverage(D, 16n, 11);
    expect(alerts.filter((a) => a.includes("queue a new value"))).toHaveLength(Number(fee7 > 0n) + Number(fee14 > 0n));
  });
  it("alerts at the seven-day BNB runway and 0.002 OKB thresholds and reports the fourteen-day target", async () => {
    const c = { account: { address: A(100) }, bsc: { public: { getBalance: async () => parseEther("0.05") } }, xlayer: { public: { getBalance: async () => parseEther("0.0019") } } } as unknown as Clients;
    const { p, k, alerts } = make(c);
    k.state.lastSummaryDay = Math.floor(NOW / DAY);
    await p.balances(NOW);
    expect(alerts).toHaveLength(2); expect(alerts[0]).toContain("float target 0.1052 BNB"); expect(alerts[1]).toContain("OKB low");
  });
});

describe("RB-09 RA-07 verdicts", () => {
  it("uses newest counting evidence, impairment on ties, sane health, and missing non-flagged evidence", () => {
    const healthy = report();
    expect(verdict(16n, NOW - 100, NOW, healthy, { syncedAt: NOW - 1, power: 0n })).toBe("healthy");
    expect(verdict(16n, NOW - 100, NOW, healthy, { syncedAt: NOW + 1, power: 0n })).toBe("impaired");
    expect(verdict(16n, NOW - 100, NOW, healthy, { syncedAt: NOW, power: 0n })).toBe("impaired");
    expect(verdict(16n, NOW, NOW, report(16n, NOW, { totalVerifWeight: 0n }), undefined)).toBe("missing");
    expect(verdict(16n, NOW, NOW, report(16n, NOW, { custodied: false, verifWeight: 0n }), undefined)).toBe("impaired");
    expect(reportVerdict(report(16n, NOW, { verifWeight: 500n, bonus: 400n }), 16n, NOW, NOW)).toBe("healthy");
    expect(clearPlan(17n, 16n, NOW, NOW, null, { syncedAt: 1, power: 0n }, {}).blocks).toBe(false);
    expect(clearPlan(16n, 16n, NOW, NOW, null, { syncedAt: 1, power: 0n }, {}).blocks).toBe(true);
    expect(verdict(16n, NOW + 1, NOW, healthy, { syncedAt: NOW, power: 1n })).toBe("missing");
  });
  it("refreshes a blocking non-flagged rig once, alerts after it lands still impaired or is unreadable", () => {
    const r = report(17n), zero = { syncedAt: NOW + 1, power: 0n };
    expect(clearPlan(17n, 16n, NOW - 100, NOW, r, zero, {})).toMatchObject({ blocks: true, harvest: true, alert: false });
    expect(clearPlan(17n, 16n, NOW - 100, NOW + 100, r, zero, { sentAt: NOW + 50 })).toMatchObject({ harvest: false, alert: true });
    expect(clearPlan(17n, 16n, NOW - 100, NOW + 100, r, zero, { sentAt: NOW + 50, alerted: true }).alert).toBe(false);
    expect(clearPlan(17n, 16n, NOW - 100, NOW, r, undefined, {})).toMatchObject({ harvest: false, alert: true }); // healthy report itself allows the clear
    expect(clearPlan(16n, 16n, NOW + 1, NOW, report(), undefined, {})).toMatchObject({ blocks: true, harvest: true, alert: true });
  });
  it("refreshes stale healthy readings without counting them as timely health evidence", () => {
    const stale = report(17n, NOW - 301), zero = { syncedAt: NOW - 1, power: 0n };
    expect(reportVerdict(stale, 17n, 0, NOW)).toBe("missing");
    expect(clearPlan(17n, 16n, NOW - 100, NOW, stale, zero, {})).toMatchObject({ blocks: true, harvest: true, push: false, alert: false });
    expect(clearPlan(17n, 16n, NOW - 100, NOW + 60, stale, { syncedAt: NOW + 30, power: 0n }, { sentAt: NOW, syncedBefore: NOW - 1 })).toMatchObject({ blocks: true, harvest: false, push: true });
    expect(clearPlan(17n, 16n, NOW - 100, NOW, { ...stale, totalVerifWeight: 0n }, zero, {}).harvest).toBe(false);
    expect(clearPlan(17n, 16n, NOW - 100, NOW, { ...stale, rigId: 18n }, zero, {}).harvest).toBe(false);
  });
});

describe("RB-03/RB-08/RB-09 keeper wiring", () => {
  function fixture() {
    let closedAtFlag = false;
    const reports = new Map([[16n, report(16n)], [17n, report(17n)]]);
    const records = new Map([[16n, { syncedAt: NOW, power: 1n }], [17n, { syncedAt: NOW + 1, power: 0n }]]);
    let bad = false;
    const c = { account: { address: A(100) }, bsc: { public: {
      readContract: async () => 100_000n,
      multicall: async ({ contracts }: { contracts: { functionName: string; args: unknown[] }[] }) => contracts.map((q) => ({ status: "success", result: ({
        rigs: [CELL, q.args[0]], getMiner: { status: bad ? 3 : 1, stopBlock: 0n, since: 1n, taskId: 4, verifWeight: bad ? 0n : 500n, bonus: 0n },
        pending: 50_000n, cellOf: CELL, ownerOf: CELL, balanceOf: 0n,
      } as Record<string, unknown>)[q.functionName] })),
    } }, xlayer: { public: {
      // feedEnabledAt 0: no brake ever (redeploy 3 R3-01); every evidence floor reads NOW - 100
      readContract: async ({ functionName }: { functionName: string }) => functionName === "feedDisabled" ? false : functionName === "balanceOf" || functionName === "feedEnabledAt" ? 0n : BigInt(NOW - 100),
      multicall: async ({ contracts }: { contracts: { functionName: string; args?: unknown[] }[] }) => contracts.map((q) => {
        const id = q.args?.[0] as bigint;
        const record = records.get(id);
        return { status: "success", result: ({ latest: [reports.get(id), reports.has(id)], rigs: [CELL, BigInt(record?.syncedAt ?? 0), id, record?.power ?? 1n],
          passOf: [{}, true], loanOf: { open: !closedAtFlag, start: closedAtFlag ? 0n : 1000n, maturity: 2000n, impairedAt: 0n, seizeStart: 0n, deadline: 0n, expired: false, debt: closedAtFlag ? 0n : 10n, impairedRig: 0n }, collateralOf: [16n], closed: false, balanceOf: 0n,
        } as Record<string, unknown>)[q.functionName] };
      }),
    } } } as unknown as Clients;
    return { c, records, reports, stop: () => { bad = true; reports.set(16n, report(16n, NOW, { status: 3 })); }, close: () => closedAtFlag = true };
  }
  const snap = (expired = true): LoanSnapshot => ({ agent: AGENT, start: 1000, maturity: NOW + DAY, loan: { open: true, impairedAt: expired ? 100 : 0, seizeStart: NOW - 100, deadline: NOW - 1, expired, impairedRig: 16n, debt: 10n }, collateral: expired ? [16n, 17n] : [16n], closed: false, bem: 0n });

  it("refreshes the blocking non-flagged rig once, then clears when its health record lands", async () => {
    const f = fixture(), { p, bsc, xlayer, k, alerts } = make(f.c);
    const l = snap();
    await p.impairment(D, [l], 1n, NOW);
    expect(bsc.calls.map((c) => c.functionName)).toEqual(["harvest"]);
    expect(bsc.calls[0]!.args).toEqual([[17n]]);
    expect(xlayer.calls).toHaveLength(0);
    await p.impairment(D, [l], 2n, NOW + 60);
    expect(bsc.calls).toHaveLength(1);
    expect(alerts.some((s) => s.includes("owner review"))).toBe(false);
    f.records.set(17n, { syncedAt: NOW + 60, power: 500n });
    await p.impairment(D, [l], 3n, NOW + 120);
    expect(xlayer.calls.map((c) => c.functionName)).toEqual(["clearExpiredFlag"]);
    expect(Object.values(k.state.refresh).some((r) => r.sentAt === NOW)).toBe(true);
  });

  it("BC-04 harvests once for a stale healthy non-flagged report and clears from the refreshed positive voucher record", async () => {
    const f = fixture(), { p, bsc, xlayer, alerts } = make(f.c);
    f.reports.set(17n, report(17n, NOW - 400));
    const l = snap();
    await p.impairment(D, [l], 1n, NOW);
    expect(bsc.calls.map((c) => [c.functionName, c.args])).toEqual([["harvest", [[17n]]]]);
    expect(xlayer.calls).toEqual([]);
    await p.impairment(D, [l], 2n, NOW + 60);
    expect(bsc.calls).toHaveLength(1);
    f.records.set(17n, { syncedAt: NOW + 60, power: 500n });
    await p.impairment(D, [l], 3n, NOW + 120);
    expect(xlayer.calls.map((c) => c.functionName)).toEqual(["clearExpiredFlag"]);
    expect(bsc.calls).toHaveLength(1);
    expect(alerts).toEqual([]);
  });

  it("BC-04 pushes the blocking rig after its refresh when a timely newer report is needed, then clears", async () => {
    const f = fixture(), { p, bsc, xlayer } = make(f.c);
    f.reports.set(17n, report(17n, NOW - 400));
    const l = snap();
    await p.impairment(D, [l], 1n, NOW);
    f.records.set(17n, { syncedAt: NOW + 60, power: 0n });
    await p.impairment(D, [l], 2n, NOW + 120);
    expect(bsc.calls.map((c) => [c.functionName, c.args])).toEqual([["harvest", [[17n]]], ["push", [[17n]]]]);
    expect(xlayer.calls).toEqual([]);
    f.reports.set(17n, report(17n, NOW + 130));
    await p.impairment(D, [l], 3n, NOW + 180);
    expect(xlayer.calls.map((c) => c.functionName)).toEqual(["clearExpiredFlag"]);
    expect(bsc.calls).toHaveLength(2);
  });

  it("re-reads after flagImpaired closes the funded loan, and performs no further impairment action", async () => {
    const f = fixture(); f.stop();
    const x = sender();
    const original = x.send;
    x.send = async (call) => { const r = await original(call); if (call.functionName === "flagImpaired") f.close(); return r; };
    const { p } = make(f.c, sender(), x);
    const l = snap(false);
    await p.impairment(D, [l], 1n, NOW);
    await p.impairment(D, [l], 2n, NOW + 60);
    expect(x.calls.map((c) => c.functionName)).toEqual(["flagImpaired"]);
    expect(l.loan.open).toBe(false);
    await p.impairment(D, [l], 3n, NOW + 120);
    expect(x.calls).toHaveLength(1);
  });

  it("decodes the four added admin events and flagged-rig health; Synced is summary-only", async () => {
    const events = ["PolicyActivated", "PolicyCancelled", "ParamExecuted", "ParamCancelled", "Synced"];
    const base = fixture().c;
    const c = { ...base, bsc: { public: { ...base.bsc.public, getBlock: async () => ({ number: 1n, timestamp: BigInt(NOW) }) } }, xlayer: { public: {
      getBlockNumber: async () => 17n,
      getBlock: async () => ({ timestamp: BigInt(NOW) }),
      getContractEvents: async (q: { address: Address | Address[] }) => Array.isArray(q.address) ? [{ eventName: "ImpairmentFlagged", address: AGENT, args: { rigId: 16n }, transactionHash: "0x01", logIndex: 1 }] : q.address === D.pool ? events.map((eventName, logIndex) => ({ eventName, args: { amount: 123n }, transactionHash: "0x01", logIndex, blockNumber: 1n })) : [],
      multicall: async () => [{ status: "success", result: [report(), true] }],
    } } } as unknown as Clients;
    const { p, k, alerts } = make(c);
    k.state.daily.day = Math.floor(NOW / DAY);
    k.state.agents[AGENT] = BORROWER;
    await p.scanLogs(D);
    expect(alerts).toHaveLength(5);
    expect(alerts[0]).toContain(`rig 16: healthy, observedAt ${NOW}`);
    expect(alerts.some((s) => s.includes("admin event Synced"))).toBe(false);
    expect(k.state.daily.synced).toBe("123");
  });

  it("uses a strict 90% backstop threshold, including a zero-value backstop", async () => {
    let principal = 90n, value = 100n;
    const c = { xlayer: { public: { getBlockNumber: async () => 1n, readContract: async (q: { functionName: string }) => ({ backstop: BORROWER, balanceOf: 100n, convertToAssets: value, outstandingPrincipal: principal } as Record<string, unknown>)[q.functionName] } } } as unknown as Clients;
    const { p, alerts } = make(c);
    await p.backstop(D); expect(alerts).toEqual([]);
    principal = 91n;
    await p.backstop(D); expect(alerts).toHaveLength(1);
    value = 0n; principal = 1n;
    await p.backstop(D); expect(alerts).toHaveLength(2);
  });

  it("restores a refresh incident from the broadcast journal after the cycle was interrupted", () => {
    const c = { xlayer: { public: {} } } as unknown as Clients;
    const { k } = make(c);
    const key = `${AGENT.toLowerCase()}:1000:100:17`;
    k.state.refresh[key] = { syncedBefore: NOW - 100 };
    k.state.pendingTx.bsc.push({ label: `refresh-harvest [17] for ${AGENT.toLowerCase()}:1000:100`, address: ADDR.rigVault, data: "0x", value: "0", urgency: "routine", nonce: 0, hash: "0x01", hashes: ["0x01"], gasPrice: "1", sentAt: NOW });
    new Keeper(cfg(), c, D, { send: async () => {} } as unknown as Alerts, { bsc: sender(), xlayer: sender() }, k.state);
    expect(k.state.refresh[key]).toEqual({ syncedBefore: NOW - 100, sentAt: NOW });
  });
});
