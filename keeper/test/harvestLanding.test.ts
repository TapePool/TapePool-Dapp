// RB4-06: genuine receipt evidence and a read-only watch independent of open loans and BSC availability.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, toHex, zeroHash, type TransactionReceipt } from "viem";
import { vaultAbi } from "../src/abi.js";
import { ADDR, type Deployment } from "../src/addresses.js";
import type { Alerts } from "../src/alerts.js";
import type { ChainClients, Clients } from "../src/chains.js";
import type { Config } from "../src/config.js";
import { Keeper } from "../src/keeper.js";
import { recordHarvestReceipt } from "../src/logic/harvestLanding.js";
import { EVIDENCE_UNLANDED } from "../src/logic/schedule.js";
import type { LoanSnapshot } from "../src/reads.js";
import { emptyState, loadState, saveState, type KeeperState } from "../src/state.js";
import { Sender, type Call } from "../src/tx.js";

const NOW = 1_800_000_000;
const GUID = toHex(123, { size: 32 }), OTHER = toHex(124, { size: 32 });
const TX = toHex(456, { size: 32 }), REPLACEMENT = toHex(457, { size: 32 });
const HASH = toHex(789, { size: 32 }), LANDED = toHex(1, { size: 32 });
const AGENT = "0x0000000000000000000000000000000000000123";
const D: Deployment = { pool: AGENT, factory: AGENT, screen: AGENT, receiver: AGENT, reporter: AGENT, factoryDeployBlock: 1n };
const call: Call = { label: "harvest [16,17]", address: ADDR.rigVault, abi: vaultAbi, functionName: "harvest", args: [[16n, 17n]], urgency: "routine" };
const dirs: string[] = [];
const statePath = () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-landings-"));
  dirs.push(dir);
  return join(dir, "state.json");
};
afterEach(() => {
  for (const dir of dirs.splice(0)) { unlinkSync(join(dir, "state.json")); rmdirSync(dir); }
  vi.restoreAllMocks();
});

function harvested(guid = GUID, ids = [16n, 17n], address: string = ADDR.rigVault) {
  return {
    address,
    topics: encodeEventTopics({ abi: vaultAbi, eventName: "Harvested", args: { guid } }),
    data: encodeAbiParameters([{ type: "uint256[]" }, { type: "uint256[]" }], [ids, ids.map(() => 1n)]),
  };
}
const receipt = (logs = [harvested()], status = "success", transactionHash = TX) => ({ status, transactionHash, logs }) as unknown as TransactionReceipt;

function watch(state = emptyState(1n, D.factory)) {
  const alerts: { kind: string; text: string }[] = [];
  const queue = new Map<string, unknown>([[GUID, zeroHash], [OTHER, zeroHash]]);
  const multicall = vi.fn(async ({ contracts }: { contracts: { args: readonly unknown[] }[] }) => contracts.map((c) => {
    const value = queue.get(c.args[2] as string);
    return value instanceof Error ? { status: "failure", error: value } : { status: "success", result: value };
  }));
  const getBlock = vi.fn(async () => ({ number: 1n, timestamp: BigInt(NOW) }));
  const clients = { bsc: { public: { getBlock } }, xlayer: { public: { multicall, readContract: async () => 0n } } } as unknown as Clients;
  const send = vi.fn(), senders = { bsc: { send, poll: async () => {} }, xlayer: { send, poll: async () => {} } } as unknown as { bsc: Sender; xlayer: Sender };
  const config = { mode: "dry", seizedHarvestEveryHours: 168 } as Config;
  const keeper = new Keeper(config, clients, null, { send: async (kind: string, text: string) => void alerts.push({ kind, text }) } as unknown as Alerts, senders, state, () => NOW + 600);
  const jobs = keeper as unknown as { checkHarvestLandings(now: number): Promise<void>; upgradeWatch(): Promise<void>; balances(): Promise<void>; harvest(d: Deployment, loans: LoanSnapshot[], block: bigint, now: number): Promise<void> };
  return { keeper, jobs, state, alerts, queue, send, multicall, getBlock, check: (now: number) => jobs.checkHarvestLandings(now) };
}

describe("RB4-06 harvest receipts", () => {
  it.each(["harvest [16,17]", "evidence-harvest [16,17] for rig 16", "refresh-harvest [16,17] for incident", "harvest [16,17] seized"])("records every harvest path: %s", (label) => {
    const state = emptyState(1n);
    recordHarvestReceipt(state.harvestLandings, { ...call, label, args: [[99n]] }, receipt(), NOW);
    expect(state.harvestLandings).toEqual({ [GUID]: { rigs: ["16", "17"], transaction: TX, sentAt: NOW } });
  });

  it("uses event ids, records each guid, and does not reset an existing alert or send time", () => {
    const state = emptyState(1n);
    const r = receipt([harvested(), harvested(OTHER, [18n])]);
    recordHarvestReceipt(state.harvestLandings, call, r, NOW);
    state.harvestLandings[GUID]!.alerted = true;
    recordHarvestReceipt(state.harvestLandings, call, r, NOW + 300);
    expect(state.harvestLandings[GUID]).toEqual({ rigs: ["16", "17"], transaction: TX, sentAt: NOW, alerted: true });
    expect(state.harvestLandings[OTHER]).toEqual({ rigs: ["18"], transaction: TX, sentAt: NOW });
  });

  it.each(["reverted", "other target", "other emitter", "other event", "malformed"])("does not create receipt evidence from %s", (kind) => {
    const state = emptyState(1n);
    const logs = kind === "other emitter" ? [harvested(GUID, [16n], AGENT)] : [harvested()];
    if (kind === "other event") logs[0] = { ...logs[0]!, topics: [zeroHash] };
    if (kind === "malformed") logs[0] = { ...logs[0]!, data: "0x" };
    recordHarvestReceipt(state.harvestLandings, kind === "other target" ? { ...call, address: AGENT } : call, receipt(logs, kind === "reverted" ? "reverted" : "success"), NOW);
    expect(state.harvestLandings).toEqual({});
  });

  it("checkpoints the landing entry with removal of a restored replacement's pending transaction", async () => {
    const state = emptyState(1n, D.factory), path = statePath();
    state.pendingTx.bsc.push({ label: call.label, address: call.address, data: encodeFunctionData({ abi: vaultAbi, functionName: "harvest", args: [[16n, 17n]] }), value: "0", urgency: "routine", hash: REPLACEMENT, hashes: [TX, REPLACEMENT], nonce: 0, gasPrice: "1", createdAt: NOW, sentAt: NOW + 180 });
    saveState(path, state);
    const chain = { name: "bsc", public: { getTransactionCount: async () => 1, getTransactionReceipt: async () => receipt([harvested()], "success", REPLACEMENT) }, wallet: { account: { address: AGENT } } } as unknown as ChainClients;
    const mined = vi.fn((c: Call, r: TransactionReceipt, at: number) => recordHarvestReceipt(state.harvestLandings, c, r, at));
    const sender = new Sender(chain, { mode: "dry", capWei: 1n, stuckAfterSec: 180, alert: vi.fn(), journal: state.pendingTx.bsc, persist: () => saveState(path, state), mined });
    await sender.poll();
    await sender.poll();
    expect(mined).toHaveBeenCalledTimes(1);
    expect(mined.mock.calls[0]![0].functionName).toBe(""); // journal restoration has no original function ABI
    const disk = loadState(path, 1n, D.factory);
    expect(disk.pendingTx.bsc).toEqual([]);
    expect(disk.harvestLandings[GUID]).toEqual({ rigs: ["16", "17"], transaction: REPLACEMENT, sentAt: NOW });
  });
});

describe("RB4-06 compose landing watch", () => {
  const tracked = () => {
    const h = watch();
    recordHarvestReceipt(h.state.harvestLandings, call, receipt(), NOW);
    return h;
  };

  it.each([[zeroHash, "not received"], [HASH, "compose pending"], [LANDED, "landed"]] as const)("reads the queue state %s (%s)", async (value, status) => {
    const h = tracked(); h.queue.set(GUID, value);
    await h.check(NOW + EVIDENCE_UNLANDED);
    const q = (h.multicall.mock.calls[0]![0].contracts[0] as unknown as { address: string; functionName: string; args: unknown[] });
    expect(q).toMatchObject({ address: ADDR.endpoint, functionName: "composeQueue", args: [ADDR.bemXLayer, ADDR.voucher, GUID, 0] });
    if (value === LANDED) {
      expect(h.state.harvestLandings).toEqual({});
      expect(h.alerts).toEqual([]);
    } else {
      expect(h.alerts).toHaveLength(1);
      expect(h.alerts[0]!.text).toContain(status);
      for (const detail of ["16,17", GUID, TX]) expect(h.alerts[0]!.text).toContain(detail);
    }
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each([599, 600, 601])("uses the exact 600-second boundary at +%s", async (age) => {
    const h = tracked();
    await h.check(NOW + age);
    expect(h.alerts).toHaveLength(age < 600 ? 0 : 1);
    expect(EVIDENCE_UNLANDED).toBe(600);
  });

  it("alerts once per guid even when its queue state changes, then drops it on landing", async () => {
    const h = tracked();
    recordHarvestReceipt(h.state.harvestLandings, call, receipt([harvested(OTHER)]), NOW);
    await h.check(NOW + 600);
    h.queue.set(GUID, HASH);
    await h.check(NOW + 3_600);
    expect(h.alerts).toHaveLength(2);
    expect(new Set(h.alerts.map((a) => a.kind)).size).toBe(2);
    h.queue.set(GUID, LANDED); h.queue.set(OTHER, LANDED);
    await h.check(NOW + 3_601);
    expect(h.state.harvestLandings).toEqual({});
    expect(h.send).not.toHaveBeenCalled();
  });

  it("retains an entry when loan bookkeeping is pruned after closure", async () => {
    const h = tracked(), key = `${AGENT.toLowerCase()}:1000`;
    h.state.harvest.loans[key] = { maturityDone: true, lastAt: NOW, shortfalls: 0 };
    await h.jobs.harvest(D, [{ agent: AGENT, start: 1000, maturity: NOW, collateral: [], closed: true, bem: 0n, loan: { open: false, impairedAt: 0, seizeStart: 0, deadline: 0, expired: false, impairedRig: 0n, debt: 0n } }], 1n, NOW + 1);
    expect(h.state.harvest.loans).toEqual({});
    expect(h.state.harvestLandings[GUID]).toBeDefined();
    await h.check(NOW + 600);
    expect(h.alerts).toHaveLength(1);
  });

  it.each([new Error("rpc down"), undefined, "0x01"])("keeps unreadable or malformed queue results for retry: %s", async (value) => {
    const h = tracked(); h.queue.set(GUID, value);
    recordHarvestReceipt(h.state.harvestLandings, call, receipt([harvested(OTHER)]), NOW);
    h.queue.set(OTHER, LANDED);
    await expect(h.check(NOW + 600)).rejects.toThrow("landing entries retained");
    expect(h.state.harvestLandings[GUID]).toBeDefined();
    expect(h.state.harvestLandings[OTHER]).toBeUndefined();
    expect(h.alerts).toEqual([]);
    h.queue.set(GUID, LANDED);
    await h.check(NOW + 601);
    expect(h.state.harvestLandings).toEqual({});
  });

  it("retains every entry after a whole multicall fails", async () => {
    const h = tracked(); h.multicall.mockRejectedValueOnce(new Error("rpc down"));
    await expect(h.check(NOW + 600)).rejects.toThrow("rpc down");
    expect(h.state.harvestLandings[GUID]!.alerted).toBeUndefined();
    expect(h.alerts).toEqual([]);
  });

  it("runs each cycle without a deployment or open loan, even when BSC finality fails and the keeper is frozen", async () => {
    const h = tracked();
    vi.spyOn(h.jobs, "upgradeWatch").mockResolvedValue(undefined);
    vi.spyOn(h.jobs, "balances").mockResolvedValue(undefined);
    h.getBlock.mockRejectedValue(new Error("BSC unavailable"));
    h.keeper.frozen = true;
    await h.keeper.cycle();
    await h.keeper.cycle();
    expect(h.multicall).toHaveBeenCalledTimes(2);
    expect(h.alerts).toHaveLength(1);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("restarts from persisted entries, preserves alerts and follows them across a factory change", async () => {
    const h = tracked(), path = statePath();
    await h.check(NOW + 599);
    saveState(path, h.state);
    const restarted = watch(loadState(path, 1n, D.factory));
    await restarted.check(NOW + 600);
    expect(restarted.alerts).toHaveLength(1);
    saveState(path, restarted.state);
    const changed = watch(loadState(path, 2n, ADDR.voucher));
    await changed.check(NOW + 3_600);
    expect(changed.alerts).toEqual([]);
    changed.queue.set(GUID, LANDED);
    await changed.check(NOW + 3_601);
    saveState(path, changed.state);
    expect(loadState(path, 2n, ADDR.voucher).harvestLandings).toEqual({});
  });

  it("loads older state files with no landing section as an empty watch", async () => {
    const state = emptyState(1n, D.factory), path = statePath();
    delete (state as Partial<KeeperState>).harvestLandings;
    saveState(path, state);
    const h = watch(loadState(path, 1n, D.factory));
    expect(h.state.harvestLandings).toEqual({});
    await h.check(NOW + 600);
    expect(h.multicall).not.toHaveBeenCalled();
  });
});
