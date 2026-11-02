// Fixed-behaviour ports of D:/TapePool-audit-a/keeper/test/audit-poc.test.ts (BC-01/02),
// audit-poc-recheck.test.ts (BC-07), plus first-broadcast/restart/recovery/alert cases (BC-05).
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, keccak256, parseEther, parseTransaction, recoverTransactionAddress, type Address, type Hex, type TransactionReceipt, type TransactionSerializedLegacy } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { poolAbi, reporterAbi } from "../src/abi.js";
import { loadConfig } from "../src/config.js";
import type { Deployment } from "../src/addresses.js";
import type { ChainClients, Clients } from "../src/chains.js";
import { PushLimiter } from "../src/logic/pushLimits.js";
import { PushService } from "../src/push.js";
import { emptyState, loadState, saveState } from "../src/state.js";
import { Sender, type Call, type PendingTx, type SendResult } from "../src/tx.js";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const D: Deployment = { pool: A(1), factory: A(2), screen: A(3), receiver: A(4), reporter: A(5), factoryDeployBlock: 1n };
const NOW = 1_000_000;
const call: Call = { label: "sync income", address: D.pool, abi: poolAbi, functionName: "sync", urgency: "routine" };
const other: Call = { ...call, label: "sweep 0xagent", address: A(7) };
const cfg = () => loadConfig({ KEEPER_MODE: "live", KEEPER_PRIVATE_KEY: `0x${"11".repeat(32)}`, BSC_RPC: "http://x", TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "1" });

function chainMock(lostResponse = 0) {
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const raw: Hex[] = [];
  const pool: Hex[] = [];
  const receipts = new Map<Hex, TransactionReceipt>();
  const f = {
    nonce: 0, market: 100n, floor: 0n, raw, pool, receipts, account,
    estimateGas: vi.fn(async () => 70_000n),
    beforeBroadcast: (_raw: Hex) => {},
    mine: (hash = keccak256(raw.at(-1)!)) => {
      f.nonce = parseTransaction(raw.find((r) => keccak256(r) === hash)!).nonce! + 1;
      receipts.set(hash, { transactionHash: hash, status: "success", gasUsed: 2n, effectiveGasPrice: 100n, logs: [] } as unknown as TransactionReceipt);
    },
  };
  const chain = { name: "xlayer", public: {
    simulateContract: async () => ({ request: {} }),
    getGasPrice: async () => f.market,
    estimateGas: f.estimateGas,
    getTransactionCount: async () => f.nonce,
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => receipts.get(hash) ?? null,
  }, wallet: { account, chain: { id: 196 }, sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
    f.beforeBroadcast(serializedTransaction);
    raw.push(serializedTransaction);
    if (parseTransaction(serializedTransaction).gasPrice! < f.floor) throw new Error("transaction underpriced");
    pool.push(serializedTransaction);
    if (raw.length === lostResponse) throw new Error("HttpRequestError: timeout after acceptance");
    return keccak256(serializedTransaction);
  } } } as unknown as ChainClients;
  return { ...f, chain, state: f };
}

describe("BC-01 / BC-05 signed hashes survive lost broadcast responses", () => {
  it.each([true, false])("finds the lost replacement's receipt and unblocks routine sends (journal=%s)", async (journaled) => {
    let now = NOW;
    const f = chainMock(2), journal = journaled ? [] as PendingTx[] : undefined;
    const mined = vi.fn(), alerts: string[] = [];
    const s = new Sender(f.chain, { mode: "live", capWei: 1000n, stuckAfterSec: 60, alert: (a) => alerts.push(a), now: () => now, journal, mined });
    expect((await s.send(call)).status).toBe("sent");
    const first = keccak256(f.raw[0]!);
    now += 61;
    await s.poll(); // accepted replacement; HTTP response lost
    const replacement = keccak256(f.raw[1]!);
    expect(replacement).not.toBe(first);
    if (journal) expect(journal[0]!.hashes).toEqual([first, replacement]);
    expect(parseTransaction(f.raw[1]!)).toMatchObject({ nonce: 0, gasPrice: 125n });
    f.mine(replacement);
    for (let i = 0; i < 1000; i++) { now += 60; await s.poll(); } // audit's ~17-hour timeline
    expect(s.hasPending(call.label)).toBe(false);
    expect(mined).toHaveBeenCalledTimes(1);
    expect(mined.mock.calls[0]![1].transactionHash).toBe(replacement);
    expect(alerts).toEqual([]);
    expect((await s.send(other)).status).toBe("sent");
    expect(parseTransaction(f.raw[2]!)).toMatchObject({ nonce: 1 });
  });

  it("persists signed first and replacement hashes before broadcasting, and restores after a lost first response", async () => {
    let now = NOW;
    const f = chainMock(1), state = emptyState(1n, D.factory);
    const snapshots: { raw: Hex; entry: PendingTx }[] = [];
    const path = join(mkdtempSync(join(tmpdir(), "keeper-broadcast-")), "state.json");
    const opt = { mode: "live" as const, capWei: 1000n, stuckAfterSec: 60, alert: vi.fn(), now: () => now, journal: state.pendingTx.xlayer, persist: () => saveState(path, state), mined: vi.fn() };
    f.state.beforeBroadcast = (raw) => {
      const disk = JSON.parse(readFileSync(path, "utf8")) as { pendingTx: { xlayer: PendingTx[] } };
      snapshots.push({ raw, entry: disk.pendingTx.xlayer[0]! });
    };
    const s = new Sender(f.chain, opt);
    const result = await s.send(call);
    expect(result).toEqual({ status: "sent", hash: keccak256(f.raw[0]!) });
    expect(await recoverTransactionAddress({ serializedTransaction: f.raw[0]! as TransactionSerializedLegacy })).toBe(f.account.address);
    now += 10;
    expect(await s.send(call)).toEqual({ status: "waiting", reason: "transaction in flight" });
    expect(f.raw).toHaveLength(1); // no blind new-nonce resend
    const restoredState = loadState(path, 1n, D.factory);
    const restored = new Sender(f.chain, { ...opt, journal: restoredState.pendingTx.xlayer, persist: () => saveState(path, restoredState) });
    expect(restored.hasPending(call.label)).toBe(true);
    now += 51;
    await restored.poll(); // restored calldata signs a replacement without the original ABI
    expect(f.raw).toHaveLength(2);
    f.mine();
    await restored.poll(); await restored.poll();
    expect(restored.busy).toBe(false);
    expect(opt.mined).toHaveBeenCalledTimes(1);
    expect(loadState(path, 1n, D.factory).pendingTx.xlayer).toEqual([]);
    expect(snapshots).toHaveLength(2);
    for (const { raw, entry } of snapshots) {
      expect(entry.raw).toBe(raw);
      expect(entry.hash).toBe(keccak256(raw));
      expect(entry.hashes).toContain(keccak256(raw));
      const tx = parseTransaction(raw);
      expect(tx).toMatchObject({ chainId: 196, nonce: 0, gas: 70_000n, to: D.pool });
      expect(tx.value ?? 0n).toBe(0n);
    }
  });

  it("journals a market-priced replacement before sending the urgent transaction behind it", async () => {
    let persisted: PendingTx[] = [];
    const snapshots: { raw: Hex; journal: PendingTx[] }[] = [];
    const journal: PendingTx[] = [], f = chainMock(2);
    const s = new Sender(f.chain, { mode: "live", capWei: 1000n, stuckAfterSec: 60, alert: () => {}, now: () => NOW, journal, persist: () => persisted = JSON.parse(JSON.stringify(journal)) });
    f.state.beforeBroadcast = (raw) => snapshots.push({ raw, journal: persisted });
    await s.send(call);
    f.state.market = 200n;
    expect((await s.send({ ...other, urgency: "urgent" })).status).toBe("sent");
    expect(f.raw.map((raw) => parseTransaction(raw).nonce)).toEqual([0, 0, 1]);
    expect(journal[0]!.hashes).toEqual(f.raw.slice(0, 2).map((raw) => keccak256(raw)));
    expect(snapshots).toHaveLength(3);
    for (const { raw, journal } of snapshots) expect(journal.some((p) => p.raw === raw && p.hash === keccak256(raw) && p.hashes.includes(keccak256(raw)))).toBe(true);
    f.mine(keccak256(f.raw[1]!)); f.mine(keccak256(f.raw[2]!));
    await s.poll();
    expect(s.busy).toBe(false);
  });

  it("does not broadcast if the journal cannot be persisted", async () => {
    const f = chainMock();
    const s = new Sender(f.chain, { mode: "live", capWei: 1000n, stuckAfterSec: 60, alert: () => {}, journal: [], persist: () => { throw new Error("disk unavailable"); } });
    expect((await s.send(call)).status).toBe("waiting");
    expect(f.raw).toEqual([]);
  });

  it("drops a passed nonce only after an additional stuck period, preserves the grace over restart, and alerts once without recording spend", async () => {
    let now = NOW;
    const f = chainMock(), journal: PendingTx[] = [], alerts: string[] = [], mined = vi.fn();
    const opt = { mode: "live" as const, capWei: 1000n, stuckAfterSec: 60, alert: (a: string) => alerts.push(a), now: () => now, journal, mined };
    const s = new Sender(f.chain, opt);
    await s.send(call);
    f.state.nonce = 1; // another hash consumed the nonce; every recorded hash has no receipt
    now += 1000;
    await s.poll();
    expect(s.busy).toBe(true);
    now += 59;
    await s.poll();
    const restored = new Sender(f.chain, { ...opt, journal: JSON.parse(JSON.stringify(journal)) });
    expect(restored.busy).toBe(true);
    now++;
    await restored.poll(); await restored.poll();
    expect(restored.busy).toBe(false);
    expect(mined).not.toHaveBeenCalled();
    expect(alerts).toHaveLength(1);
    for (const text of [call.label, "xlayer", "nonce 0", "spend not recorded"]) expect(alerts[0]).toContain(text);
    expect((await restored.send(other)).status).toBe("sent");
  });

  it("keeps the original pending age through replacements and alerts once across restarts at one hour", async () => {
    let now = NOW;
    const f = chainMock(), journal: PendingTx[] = [], alerts: string[] = [];
    const opt = { mode: "live" as const, capWei: 1000n, stuckAfterSec: 60, alert: (a: string) => alerts.push(a), now: () => now, journal };
    const s = new Sender(f.chain, opt);
    await s.send(call);
    now += 1800; await s.poll(); // replacement must not reset the age
    expect(alerts).toEqual([]);
    now = NOW + 3600; await s.poll();
    const restored = new Sender(f.chain, { ...opt, journal: JSON.parse(JSON.stringify(journal)) });
    now += 1800; await restored.poll(); await restored.poll();
    expect(alerts.filter((a) => a.includes("one hour"))).toEqual([`xlayer: sync income pending for over one hour (nonce 0)`]);
    expect(journal[0]!.createdAt).toBe(NOW);
  });
});

describe("BC-07 rejected transactions at the gas cap are re-broadcast", () => {
  const urgent: Call = { ...call, label: "pauseBorrows", functionName: "pauseBorrows", urgency: "urgent" };
  const brake: Call = { ...urgent, label: "disableFeed", functionName: "disableFeed" };

  it.each(["in memory", "restored raw bytes", "older journal without raw bytes"])("fills the rejected nonce after the market falls, then sends the routine call and second brake (%s)", async (recovery) => {
    let now = NOW;
    const f = chainMock(), alerts: string[] = [], mined = vi.fn();
    const sign = vi.spyOn(f.account, "signTransaction");
    f.state.market = f.state.floor = 150n; // above the urgent cap of 10 x 10 = 100
    let state = emptyState(1n, D.factory);
    const path = join(mkdtempSync(join(tmpdir(), "keeper-bc07-")), "state.json");
    const snapshots: { raw: Hex; entry: PendingTx }[] = [];
    const opt = { mode: "live" as const, capWei: 10n, stuckAfterSec: 60, alert: (a: string) => alerts.push(a), now: () => now, mined, persist: () => saveState(path, state) };
    f.state.beforeBroadcast = (raw) => snapshots.push({ raw, entry: loadState(path, 1n, D.factory).pendingTx.xlayer[0]! });
    let s = new Sender(f.chain, { ...opt, journal: state.pendingTx.xlayer });
    expect(await s.send(urgent)).toEqual({ status: "sent", hash: keccak256(f.raw[0]!) });
    const raw = f.raw[0]!, hash = keccak256(raw);
    expect(parseTransaction(raw)).toMatchObject({ nonce: 0, gasPrice: 100n });
    expect(f.pool).toEqual([]); // definite rejection still counts as acceptance unknown
    expect(await s.send(other)).toEqual({ status: "waiting", reason: "transaction in flight" });
    now += 59; await s.poll();
    expect(f.raw).toHaveLength(1);
    now++; await s.poll(); // another rejection at the first full stuck interval
    expect(f.raw).toEqual([raw, raw]);
    expect(f.pool).toEqual([]);

    if (recovery !== "in memory") {
      if (recovery === "older journal without raw bytes") {
        delete state.pendingTx.xlayer[0]!.raw;
        saveState(path, state);
      } else {
        // A new estimate would change the signature/hash: restored bytes must bypass signing.
        f.estimateGas.mockResolvedValue(99_000n);
      }
      state = loadState(path, 1n, D.factory);
      expect(state.pendingTx.xlayer[0]!.raw).toBe(recovery === "restored raw bytes" ? raw : undefined);
      s = new Sender(f.chain, { ...opt, journal: state.pendingTx.xlayer });
    }
    now = NOW + 3600; await s.poll(); await s.poll(); // age alert survives periodic re-broadcasts
    expect(f.raw).toEqual([raw, raw, raw]);
    expect(alerts.filter((a) => a.includes("stuck at the gas cap"))).toHaveLength(1);
    expect(alerts.filter((a) => a.includes("over one hour"))).toHaveLength(1);
    expect(s.hasPending(urgent.label)).toBe(true);

    f.state.market = f.state.floor = 2n; // node now accepts the capped transaction
    now += 59; await s.poll();
    expect(f.raw).toHaveLength(3);
    now++; await s.poll();
    expect(f.raw).toEqual([raw, raw, raw, raw]);
    expect(f.pool).toEqual([raw]);
    expect(sign).toHaveBeenCalledTimes(recovery === "older journal without raw bytes" ? 2 : 1);
    expect(f.estimateGas).toHaveBeenCalledTimes(sign.mock.calls.length);
    expect(state.pendingTx.xlayer[0]).toMatchObject({ raw, hash, hashes: [hash], gasPrice: "100", createdAt: NOW, sentAt: now });
    for (const snapshot of snapshots) {
      expect(snapshot.raw).toBe(raw);
      expect(snapshot.entry).toMatchObject({ raw, hash, hashes: [hash], gasPrice: "100" });
    }

    f.mine(hash); await s.poll();
    expect(s.busy).toBe(false);
    expect(state.pendingTx.xlayer).toEqual([]);
    expect(mined).toHaveBeenCalledTimes(1);
    expect(mined.mock.calls[0]![1].transactionHash).toBe(hash);
    expect((await s.send(other)).status).toBe("sent");
    expect((await s.send(brake)).status).toBe("sent");
    expect(f.raw.slice(-2).map((r) => parseTransaction(r).nonce)).toEqual([1, 2]);
    f.mine(keccak256(f.raw.at(-2)!)); f.mine(); await s.poll();
    expect(s.busy).toBe(false);
    expect(loadState(path, 1n, D.factory).pendingTx.xlayer).toEqual([]);
  });

  it("re-broadcasts the current replacement's bytes without adding a hash or changing its price", async () => {
    let now = NOW;
    const f = chainMock(), journal: PendingTx[] = [];
    f.state.market = 80n; f.state.floor = 200n;
    const s = new Sender(f.chain, { mode: "live", capWei: 100n, stuckAfterSec: 60, alert: () => {}, now: () => now, journal });
    await s.send(call);
    now += 60; await s.poll(); // 80 -> 100, the routine cap
    const replacement = f.raw[1]!, hashes = f.raw.map((r) => keccak256(r));
    expect(journal[0]!.raw).toBe(replacement);
    f.state.market = f.state.floor = 20n;
    now += 60; await s.poll();
    expect(f.raw).toEqual([f.raw[0], replacement, replacement]);
    expect(journal[0]).toMatchObject({ raw: replacement, hash: keccak256(replacement), hashes, gasPrice: "100" });
    f.mine(); await s.poll();
    expect(s.busy).toBe(false);
  });

  it.each([false, true])("does not sign or re-broadcast a restored at-cap entry in dry mode (older journal=%s)", async (older) => {
    const f = chainMock(), journal: PendingTx[] = [];
    f.state.market = f.state.floor = 150n;
    const opt = { capWei: 10n, stuckAfterSec: 60, alert: () => {}, journal };
    await new Sender(f.chain, { ...opt, mode: "live", now: () => NOW }).send(urgent);
    if (older) delete journal[0]!.raw;
    const sign = vi.spyOn(f.account, "signTransaction");
    f.estimateGas.mockClear();
    const s = new Sender(f.chain, { ...opt, mode: "dry", now: () => NOW + 3600 });
    await s.poll();
    expect((await s.send(brake)).status).toBe("dry");
    expect(s.hasPending(urgent.label)).toBe(true);
    expect(sign).not.toHaveBeenCalled();
    expect(f.estimateGas).not.toHaveBeenCalled();
    expect(f.raw).toHaveLength(1);
  });
});

describe("BC-02 landed reports leave the pending push set", () => {
  afterEach(() => vi.useRealTimers());
  it.each([false, true])("reuses at T+200, charges a new push at T+400, and reuses it at T+601 (restored journal=%s)", async (restored) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = NOW, stored = 0;
    const sent: Call[] = [], counts: Record<string, number> = {};
    const pending = new Sender(chainMock().chain, { mode: "dry", capWei: 1000n, stuckAfterSec: 60, alert: () => {}, journal: [{ label: "push on request [16]", address: D.reporter, data: encodeFunctionData({ abi: reporterAbi, functionName: "push", args: [[16n]] }), value: "0", urgency: "routine", hash: "0x01", hashes: ["0x01"], nonce: 0, gasPrice: "125", sentAt: NOW + 180, createdAt: NOW }] });
    const bsc = { send: async (c: Call) => { sent.push(c); return { status: "sent", hash: "0x01" } as SendResult; }, pendingPushes: () => restored ? pending.pendingPushes(D.reporter) : [] } as unknown as Sender;
    const c = { account: { address: A(100) }, bsc: { public: { getBalance: async () => parseEther("1"), readContract: async () => 10n } }, xlayer: { public: { multicall: async () => [{ status: "success", result: [{ rigId: 16n, observedAt: BigInt(stored) }, stored > 0] }] } } } as unknown as Clients;
    const svc = new PushService(cfg(), c, D, bsc, new PushLimiter(counts), () => false, () => {}, () => now);
    (svc as unknown as { inputs: () => Promise<unknown> }).inputs = async () => ({ isAgent: true, borrower: A(103), ids: [16n], eligible: new Map([[16n, true]]) });
    expect((await svc.request(A(101), "1")).status).toBe("queued");
    await svc.flush();
    expect(sent).toHaveLength(restored ? 0 : 1);
    const quota = () => Object.fromEntries(Object.entries(counts).filter(([k]) => /^(r|s|all|b):/.test(k)));
    const beforeLanding = quota();
    stored = NOW + 5;
    now = NOW + 200;
    expect((await svc.request(A(101), "2")).status).toBe("fresh");
    expect(quota()).toEqual(beforeLanding);
    now = NOW + 400;
    expect((await svc.request(A(101), "3")).status).toBe("queued");
    await svc.flush();
    expect(sent).toHaveLength(restored ? 1 : 2); // audit previously swallowed this send
    const rigKey = `r:16:${Math.floor(NOW / 86400)}`;
    expect(counts[rigKey]).toBe(restored ? 1 : 2);
    stored = NOW + 405;
    now = NOW + 601;
    await svc.checkDeliveries();
    expect((await svc.request(A(101), "4")).status).toBe("fresh");
    await svc.flush();
    expect(sent).toHaveLength(restored ? 1 : 2);
  });
});
