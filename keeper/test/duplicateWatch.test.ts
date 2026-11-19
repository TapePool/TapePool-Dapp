// RB4-07: bounded pinned scans, validated duplicate evidence and persisted per-pair guardian actions.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zeroAddress, type Address } from "viem";
import { ADDR, type Deployment } from "../src/addresses.js";
import type { Alerts } from "../src/alerts.js";
import type { ChainClients, Clients } from "../src/chains.js";
import type { Config } from "../src/config.js";
import { Keeper } from "../src/keeper.js";
import { DUPLICATE_CHUNK, DUPLICATE_STALL } from "../src/logic/duplicateWatch.js";
import { emptyState, loadState, saveState, type KeeperState } from "../src/state.js";
import { Sender, type Call, type SendResult } from "../src/tx.js";

const NOW = 1_800_000_000;
const CIRCUITS = "0x00000000000000000000000000000000000000ab" as Address;
const OTHER = "0x00000000000000000000000000000000000000ac" as Address;
const D: Deployment = { pool: OTHER, factory: OTHER, screen: OTHER, receiver: OTHER, reporter: OTHER, factoryDeployBlock: 1n };
const dirs: string[] = [];
const pathForState = () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-duplicates-"));
  dirs.push(dir);
  return join(dir, "state.json");
};
afterEach(() => {
  for (const dir of dirs.splice(0)) { unlinkSync(join(dir, "state.json")); rmdirSync(dir); }
  vi.restoreAllMocks();
});

function world(count = 2n) {
  const versions = new Map<bigint, Map<bigint, unknown>>([[100n, new Map()]]);
  const view = (block: bigint) => versions.get([...versions.keys()].filter((b) => b <= block).sort((a, b) => a < b ? 1 : -1)[0]!)!;
  const w = { now: NOW, block: 100n, count, wholeFailure: false, countAnswer: undefined as unknown };
  const order: string[] = [];
  const readContract = vi.fn(async () => { order.push("deposits"); return w.countAnswer ?? w.count; });
  const multicall = vi.fn(async ({ blockNumber, contracts }: { blockNumber: bigint; contracts: { args: readonly [bigint] }[] }) => {
    order.push("rigs");
    if (w.wholeFailure) throw new Error("archive down");
    return contracts.map((q) => {
      const value = view(blockNumber).get(q.args[0]) ?? [CIRCUITS, q.args[0]];
      return value instanceof Error ? { status: "failure", error: value } : { status: "success", result: value };
    });
  });
  const set = (block: bigint, id: bigint, value: unknown) => {
    if (!versions.has(block)) versions.set(block, new Map(view(block)));
    versions.get(block)!.set(id, value);
  };
  return { w, order, readContract, multicall, set };
}

function fixture(source = world(), state = emptyState(1n, D.factory), sender?: Sender) {
  const alerts: { kind: string; text: string }[] = [], calls: Call[] = [], results: SendResult[] = [];
  const send = vi.fn(async (call: Call): Promise<SendResult> => { calls.push(call); return results.shift() ?? { status: "sent", hash: "0x01" }; });
  const c = { bsc: { public: { readContract: source.readContract, multicall: source.multicall, getBlock: async () => ({ number: source.w.block }) } }, xlayer: { public: {} } } as unknown as Clients;
  const xlayer = sender ?? { send, poll: async () => {} } as unknown as Sender;
  const k = new Keeper({ mode: "dry" } as Config, c, D, { send: async (kind: string, text: string) => void alerts.push({ kind, text }) } as unknown as Alerts,
    { bsc: { poll: async () => {} } as unknown as Sender, xlayer }, state, () => source.w.now);
  const jobs = k as unknown as { duplicateCircuits(d: Deployment, block: bigint | null, now: number): Promise<void>; upgradeWatch(): Promise<void>; checkHarvestLandings(): Promise<void>; scanLogs(): Promise<void>; harvest(): Promise<void>; impairment(): Promise<void>; sweep(): Promise<void>; income(): Promise<void>; backstop(): Promise<void>; balances(): Promise<void> };
  const step = (block: bigint | null = source.w.block) => jobs.duplicateCircuits(D, block, source.w.now);
  const loop = async () => {
    for (const name of ["upgradeWatch", "checkHarvestLandings", "scanLogs", "harvest", "impairment", "sweep", "income", "backstop", "balances"] as const) {
      vi.spyOn(jobs, name).mockImplementation(async () => { source.order.push(name); });
    }
    vi.spyOn(k.publicData!, "run").mockResolvedValue(undefined);
    await k.cycle();
  };
  return { ...source, k, state, alerts, calls, results, send, jobs, step, loop };
}

describe("RB4-07 duplicate circuit watch", () => {
  it("ignores two released ids empty at the same pinned block", async () => {
    const h = fixture();
    h.set(100n, 1n, [zeroAddress, 0n]); h.set(100n, 2n, [zeroAddress, 0n]);
    await h.step();
    expect(h.state.duplicateWatch.pairs).toEqual({});
    expect(h.alerts).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.multicall.mock.calls[0]![0].blockNumber).toBe(100n);
  });

  it("alerts and suspends both distinct ids once, even across later clean scans", async () => {
    const h = fixture(); h.set(100n, 2n, [CIRCUITS.toUpperCase().replace("0X", "0x"), 1n]);
    await h.step();
    expect(h.calls.map((c) => [c.functionName, c.address, c.args])).toEqual([["suspendPass", D.screen, [1n]], ["suspendPass", D.screen, [2n]]]);
    expect(h.alerts.filter((a) => a.kind === "duplicate:1:2")).toHaveLength(1);
    expect(h.alerts[0]!.text).toContain("finalized BSC block 100");
    const notifications = h.alerts.length; // the existing sender also announces each urgent transaction
    await h.step(101n);
    h.set(102n, 2n, [CIRCUITS, 2n]);
    await h.step(102n);
    expect(h.calls).toHaveLength(2);
    expect(h.alerts).toHaveLength(notifications);
    expect(h.state.duplicateWatch.pairs["1:2"]!.sent).toEqual(["1", "2"]);
  });

  it("does nothing for distinct circuits or a released zero entry", async () => {
    const h = fixture(world(4n));
    h.set(100n, 2n, [OTHER, 1n]); h.set(100n, 3n, [zeroAddress, 0n]);
    await h.step();
    expect(h.calls).toEqual([]); expect(h.alerts).toEqual([]);
    expect(h.state.duplicateWatch.pairs).toEqual({});
  });

  it("does not turn a repeated answer for the same id into a duplicate", async () => {
    const h = fixture(world(1n));
    h.state.duplicateWatch.scan = { block: "100", count: "1", next: "1", seen: { [`${CIRCUITS}:1`]: ["1"] } };
    await h.step();
    expect(h.calls).toEqual([]); expect(h.state.duplicateWatch.pairs).toEqual({});
  });

  it.each([new Error("read failed"), [], [CIRCUITS], [CIRCUITS, 1n, 0n], ["0x01", 1n], [CIRCUITS, -1n], [CIRCUITS, 2n ** 256n], [CIRCUITS, 1]])("rejects an incomplete or invalid answer and retries its pinned chunk: %s", async (value) => {
    const h = fixture(); h.set(100n, 2n, value);
    await expect(h.step()).rejects.toThrow("retained for retry");
    expect(h.calls).toEqual([]); expect(h.state.duplicateWatch.pairs).toEqual({});
    expect(h.state.duplicateWatch.scan).toMatchObject({ block: "100", next: "1", seen: {} });
    h.set(100n, 2n, [CIRCUITS, 1n]);
    await h.step(101n);
    expect(h.calls).toHaveLength(2);
    expect(h.multicall.mock.calls.map(([q]) => q.blockNumber)).toEqual([100n, 100n]);
  });

  it("rejects partial batch responses and a whole failed multicall without recording evidence", async () => {
    const h = fixture();
    h.multicall.mockResolvedValueOnce([{ status: "success", result: [CIRCUITS, 1n] }]);
    await expect(h.step()).rejects.toThrow("retained for retry");
    h.w.wholeFailure = true;
    await expect(h.step(101n)).rejects.toThrow("archive down");
    expect(h.state.duplicateWatch.scan!.next).toBe("1");
    expect(h.calls).toEqual([]);
  });

  it.each([-1n, 2n ** 256n, 2, "2"])("rejects a malformed deposits counter: %s", async (count) => {
    const h = fixture(); h.w.countAnswer = count;
    await expect(h.step()).rejects.toThrow("unreadable deposits counter");
    expect(h.multicall).not.toHaveBeenCalled(); expect(h.calls).toEqual([]);
  });

  it("completes an empty scan and waits for a newer finalized block before restarting", async () => {
    const h = fixture(world(0n));
    await h.step(); await h.step();
    expect(h.readContract).toHaveBeenCalledTimes(1); expect(h.multicall).not.toHaveBeenCalled();
    expect(h.state.duplicateWatch.completedBlock).toBe("100");
    await h.step(101n);
    expect(h.readContract).toHaveBeenCalledTimes(2);
  });

  it("pins the counter and every chunk, so a normal redeem and re-deposit never looks duplicated", async () => {
    const h = fixture(world(65n));
    h.set(100n, 1n, [CIRCUITS, 7n]); h.set(100n, 7n, [OTHER, 7n]); h.set(100n, 65n, [zeroAddress, 0n]);
    h.set(101n, 1n, [zeroAddress, 0n]); h.set(101n, 65n, [CIRCUITS, 7n]);
    await h.step(100n); await h.step(101n); // second chunk must still read block 100
    await h.step(101n); await h.step(102n); // both chunks of the next scan read block 101
    expect(h.multicall.mock.calls.map(([q]) => q.blockNumber)).toEqual([100n, 100n, 101n, 101n]);
    expect(h.readContract.mock.calls.map((args) => (args[0] as unknown as { blockNumber: bigint }).blockNumber)).toEqual([100n, 101n]);
    expect(h.calls).toEqual([]);
  });

  it("finds a duplicate created just after pinning during the next scan", async () => {
    const h = fixture(world(130n));
    await h.step(100n); h.set(101n, 130n, [CIRCUITS, 1n]);
    await h.step(101n); await h.step(102n);
    expect(h.calls).toEqual([]);
    await h.step(103n); await h.step(104n); await h.step(105n);
    expect(h.calls.map((c) => c.args)).toEqual([[1n], [130n]]);
    expect(h.multicall.mock.calls.map(([q]) => q.blockNumber)).toEqual([100n, 100n, 100n, 103n, 103n, 103n]);
  });

  it("reads at most 64 ids each cycle and completes without starving existing jobs", async () => {
    const h = fixture(world(130n));
    for (let i = 0; i < 3; i++) { h.w.block = 100n + BigInt(i); await h.loop(); }
    expect(DUPLICATE_CHUNK).toBe(64);
    expect(h.multicall.mock.calls.map(([q]) => q.contracts.length)).toEqual([64, 64, 2]);
    expect(h.state.duplicateWatch.scan).toBeUndefined();
    for (const name of ["harvest", "impairment", "sweep", "balances"]) expect(h.order.filter((n) => n === name)).toHaveLength(3);
    expect(h.order.indexOf("balances")).toBeLessThan(h.order.indexOf("rigs"));
  });

  it("persists progress across restart and resets screen-specific action limits for a new factory", async () => {
    const h = fixture(world(65n)), path = pathForState();
    h.set(100n, 65n, [CIRCUITS, 1n]);
    await h.step(); saveState(path, h.state);
    const restarted = fixture(h, loadState(path, 1n, D.factory));
    await restarted.step(101n);
    expect(restarted.calls.map((c) => c.args)).toEqual([[1n], [65n]]);
    saveState(path, restarted.state);
    const again = fixture(h, loadState(path, 1n, D.factory));
    await again.step(102n); await again.step(103n);
    expect(again.calls).toEqual([]);
    expect(loadState(path, 1n, CIRCUITS).duplicateWatch).toEqual({ pairs: {} });
  });

  it("restores a suspension broadcast before a crash and retries only the unsent id", async () => {
    const h = fixture(); h.set(100n, 2n, [CIRCUITS, 1n]);
    h.results.push({ status: "sent", hash: "0x01" }, { status: "waiting", reason: "RPC down" });
    await h.step();
    h.state.duplicateWatch.pairs["1:2"]!.sent = []; // save happened inside Sender, before the caller recorded the send
    h.state.pendingTx.xlayer.push({ label: "duplicate-suspend 1 for 1:2", address: D.screen, data: "0x", value: "0", urgency: "urgent", hash: "0x01", hashes: ["0x01"], nonce: 0, gasPrice: "1", sentAt: NOW });
    const restarted = fixture(h, h.state);
    await restarted.step(null);
    expect(restarted.calls.map((c) => c.args)).toEqual([[2n]]);
    expect(restarted.state.duplicateWatch.pairs["1:2"]!.sent).toEqual(["1", "2"]);
    await restarted.step(null);
    expect(restarted.calls).toHaveLength(1);
  });

  it("uses Sender's dry mode without broadcasting or consuming either suspension", async () => {
    const simulate = vi.fn(async () => ({ request: {} })), broadcast = vi.fn(), sign = vi.fn();
    const chain = { name: "xlayer", public: { simulateContract: simulate }, wallet: { sendRawTransaction: broadcast, account: { signTransaction: sign } } } as unknown as ChainClients;
    const sender = new Sender(chain, { mode: "dry", capWei: 1n, stuckAfterSec: 60, alert: vi.fn() });
    const h = fixture(world(), undefined, sender); h.set(100n, 2n, [CIRCUITS, 1n]);
    await h.step();
    expect(simulate).toHaveBeenCalledTimes(2);
    expect(broadcast).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
    expect(h.state.duplicateWatch.pairs["1:2"]!.sent).toEqual([]);
  });

  it("alerts at the one-hour boundary, keeps the alert across restart, and resets it only after completion", async () => {
    const h = fixture(world(65n)); h.w.wholeFailure = true;
    await expect(h.step()).rejects.toThrow();
    h.w.now = NOW + 3_599; await h.step(null);
    expect(h.alerts).toEqual([]);
    h.w.now++; await h.step(null);
    expect(DUPLICATE_STALL).toBe(3_600);
    expect(h.alerts.filter((a) => a.kind === "duplicate:stalled")).toHaveLength(1);
    const restarted = fixture(h, structuredClone(h.state));
    restarted.w.now = NOW + 7_200; await restarted.step(null);
    expect(restarted.alerts).toEqual([]);
    restarted.w.wholeFailure = false;
    await restarted.step(101n); await restarted.step(102n);
    restarted.w.now += 3_600; await restarted.step(null);
    expect(restarted.alerts.filter((a) => a.kind === "duplicate:stalled")).toHaveLength(1);
  });

  it("alerts on persistent read failures through the isolated job and keeps other jobs running", async () => {
    const h = fixture(); h.w.wholeFailure = true;
    for (const age of [0, 599, 600]) { h.w.now = NOW + age; await h.loop(); }
    expect(h.alerts.filter((a) => a.kind === "job:duplicate-circuits")).toHaveLength(1);
    expect(h.order.filter((n) => n === "sweep")).toHaveLength(3);
    expect(h.calls).toEqual([]);
  });

  it("loads pre-scanner state files with empty scan progress and pairs", () => {
    const state = emptyState(1n, D.factory), path = pathForState();
    delete (state as Partial<KeeperState>).duplicateWatch;
    saveState(path, state);
    expect(loadState(path, 1n, D.factory).duplicateWatch).toEqual({ pairs: {} });
  });
});
