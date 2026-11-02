import { describe, expect, it, vi } from "vitest";
import { BaseError, ContractFunctionRevertedError, HttpRequestError, TimeoutError, createPublicClient, encodeErrorResult, keccak256, parseAbi, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Sender, type Call, type PendingTx } from "../src/tx.js";
import { poolAbi } from "../src/abi.js";
import { Alerts } from "../src/alerts.js";
import { loadConfig } from "../src/config.js";
import { registerSecrets, redact } from "../src/log.js";
import { emptyState, loadState, saveState } from "../src/state.js";
import { clientIp } from "../src/http.js";
import { makeClients, readTransport, type ChainClients } from "../src/chains.js";

const KEY = `0x${"11".repeat(32)}`;

function fakeChain(over: { simulate?: () => Promise<unknown>; gasPrice?: bigint; nonce?: number } = {}) {
  const writes: { nonce: number; gasPrice: bigint }[] = [];
  let mined = false;
  const chain = {
    name: "bsc",
    public: {
      simulateContract: over.simulate ?? (async () => ({ request: {} })),
      getGasPrice: async () => over.gasPrice ?? 1_000_000_000n,
      estimateGas: async () => 100_000n,
      // "pending" counts what was sent; "latest" stays put until a test mines
      getTransactionCount: async (a: { blockTag?: string }) =>
        (over.nonce ?? 7) + (a.blockTag === "pending" ? new Set(writes.map((w) => w.nonce)).size : 0),
      getTransactionReceipt: async () => (mined ? { status: "success" } : null),
    },
    wallet: {
      account: privateKeyToAccount(KEY as Hex),
      chain: { id: 56 },
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        const tx = parseTransaction(serializedTransaction);
        writes.push({ nonce: tx.nonce!, gasPrice: tx.gasPrice! });
        return keccak256(serializedTransaction);
      },
    },
  } as unknown as ChainClients;
  return { chain, writes, mine: () => (mined = true) };
}

const call = (urgency: "routine" | "urgent", label = "x"): Call => ({
  label,
  address: "0x00000000000000000000000000000000000000bb",
  abi: parseAbi(["function f()"]),
  functionName: "f",
  urgency,
});

describe("Sender", () => {
  it("serializes simultaneous request and cycle sends before allocating their nonce", async () => {
    const f = fakeChain();
    const s = new Sender(f.chain, { mode: "live", capWei: 3_000_000_000n, stuckAfterSec: 180, alert: () => {} });
    const results = await Promise.all([s.send(call("routine", "push")), s.send(call("routine", "harvest"))]);
    expect(results.map((r) => r.status)).toEqual(["sent", "waiting"]);
    expect(f.writes).toHaveLength(1);
  });

  it("never broadcasts a restored transaction replacement in dry mode", async () => {
    const f = fakeChain();
    const journal: PendingTx[] = [];
    await new Sender(f.chain, { mode: "live", capWei: 3_000_000_000n, stuckAfterSec: 180, alert: () => {}, journal, now: () => 1 }).send({ ...call("routine", "sync income"), abi: poolAbi, functionName: "sync" });
    const s = new Sender(f.chain, { mode: "dry", capWei: 3_000_000_000n, stuckAfterSec: 180, alert: () => {}, journal, now: () => 1_000_000 });
    await s.poll();
    expect(s.hasPending("sync income")).toBe(true);
    expect(f.writes).toHaveLength(1);
  });

  it("never broadcasts in dry mode", async () => {
    const f = fakeChain();
    const s = new Sender(f.chain, { mode: "dry", capWei: 3_000_000_000n, stuckAfterSec: 180, alert: () => {} });
    expect((await s.send(call("urgent"))).status).toBe("dry");
    expect(f.writes.length).toBe(0);
  });

  it("does not send when the simulation reverts, and names the error", async () => {
    const abi = parseAbi(["error NoEvidence()"]);
    const revert = new ContractFunctionRevertedError({ abi, data: encodeErrorResult({ abi, errorName: "NoEvidence" }), functionName: "flagImpaired" });
    const f = fakeChain({ simulate: async () => Promise.reject(new BaseError("call failed", { cause: revert })) });
    const s = new Sender(f.chain, { mode: "live", capWei: 3_000_000_000n, stuckAfterSec: 180, alert: () => {} });
    expect(await s.send(call("urgent"))).toEqual({ status: "reverted", reason: "NoEvidence" });
    expect(f.writes.length).toBe(0);
  });

  it("waits instead of reporting a revert when the RPC fails during the simulation (R4)", async () => {
    for (const cause of [new HttpRequestError({ url: "http://rpc", status: 503 }), new TimeoutError({ body: {}, url: "http://rpc" })]) {
      const f = fakeChain({ simulate: async () => Promise.reject(new BaseError("call failed", { cause })) });
      const s = new Sender(f.chain, { mode: "live", capWei: 3_000_000_000n, stuckAfterSec: 180, alert: () => {} });
      const r = await s.send(call("urgent"));
      expect(r.status).toBe("waiting");
      expect(f.writes.length).toBe(0);
    }
  });

  it("lets a routine call wait; an urgent one goes out on the next nonce and keeps the routine one (M1)", async () => {
    const f = fakeChain();
    const s = new Sender(f.chain, { mode: "live", capWei: 3_000_000_000n, stuckAfterSec: 180, alert: () => {} });
    expect((await s.send(call("routine", "harvest"))).status).toBe("sent");
    expect((await s.send(call("routine", "push"))).status).toBe("waiting");
    expect((await s.send(call("urgent", "pauseBorrows"))).status).toBe("sent");
    expect(f.writes.map((w) => w.nonce)).toEqual([7, 8]);
    expect(s.hasPending("harvest")).toBe(true);
  });

  it("re-prices a routine transaction below the market before an urgent one goes out behind it (M1)", async () => {
    let market = 1_000_000_000n;
    const f = fakeChain();
    (f.chain.public as unknown as { getGasPrice: () => Promise<bigint> }).getGasPrice = async () => market;
    const s = new Sender(f.chain, { mode: "live", capWei: 3_000_000_000n, stuckAfterSec: 180, alert: () => {} });
    await s.send(call("routine", "harvest"));
    market = 2_000_000_000n;
    expect((await s.send(call("urgent", "evidence-harvest"))).status).toBe("sent");
    expect(f.writes).toEqual([
      { nonce: 7, gasPrice: 1_000_000_000n },
      { nonce: 7, gasPrice: 2_000_000_000n }, // the same harvest, re-priced at the market
      { nonce: 8, gasPrice: 2_000_000_000n },
    ]);
    expect(s.hasPending("harvest")).toBe(true);
    expect(s.hasPending("evidence-harvest")).toBe(true);
  });

  it("never reuses a nonce in flight when the node's pending count lags (N2)", async () => {
    const f = fakeChain();
    const s = new Sender(f.chain, { mode: "live", capWei: 3_000_000_000n, stuckAfterSec: 180, alert: () => {} });
    await s.send(call("routine", "harvest"));
    (f.chain.public as unknown as { getTransactionCount: () => Promise<number> }).getTransactionCount = async () => 7; // has not seen nonce 7
    await s.send(call("urgent", "pauseBorrows"));
    expect(f.writes.map((w) => w.nonce)).toEqual([7, 8]);
  });

  it("a stuck routine transaction with an urgent one behind it may go up to the urgent cap (N1)", async () => {
    let t = 1_000;
    let market = 1_000_000_000n;
    const alerts: string[] = [];
    const f = fakeChain();
    (f.chain.public as unknown as { getGasPrice: () => Promise<bigint> }).getGasPrice = async () => market;
    const s = new Sender(f.chain, { mode: "live", capWei: 1_000_000_000n, stuckAfterSec: 60, alert: (a) => alerts.push(a), now: () => t });
    await s.send(call("routine", "sweep")); // at the routine cap already
    await s.send(call("urgent", "pauseBorrows")); // market not above it: no reprice, next nonce
    market = 2_000_000_000n;
    t += 61;
    await s.poll();
    expect(f.writes.filter((w) => w.nonce === 7).map((w) => w.gasPrice)).toEqual([1_000_000_000n, 1_250_000_000n]);
    expect(alerts.some((a) => a.includes("sweep stuck"))).toBe(false);
  });

  it("two urgent calls in a row both go out, on consecutive nonces", async () => {
    const f = fakeChain();
    const s = new Sender(f.chain, { mode: "live", capWei: 3_000_000_000n, stuckAfterSec: 180, alert: () => {} });
    expect((await s.send(call("urgent", "pauseBorrows"))).status).toBe("sent");
    expect((await s.send(call("urgent", "disableFeed"))).status).toBe("sent");
    expect(f.writes.map((w) => w.nonce)).toEqual([7, 8]);
  });

  it("a failure before signing is reported without broadcasting or tracking a send", async () => {
    const f = fakeChain();
    f.chain.public.estimateGas = async () => {
      throw new Error("gas estimate unavailable");
    };
    const s = new Sender(f.chain, { mode: "live", capWei: 3_000_000_000n, stuckAfterSec: 180, alert: () => {} });
    const r = await s.send(call("urgent"));
    expect(r.status).toBe("waiting");
    expect(s.busy).toBe(false);
  });

  it("routine calls wait above the gas cap; urgent ones may pay up to ten times it", async () => {
    const alerts: string[] = [];
    const f = fakeChain({ gasPrice: 5_000_000_000n });
    const s = new Sender(f.chain, { mode: "live", capWei: 3_000_000_000n, stuckAfterSec: 180, alert: (t) => alerts.push(t) });
    expect((await s.send(call("routine"))).status).toBe("waiting");
    expect(alerts.length).toBe(1);
    expect((await s.send(call("urgent"))).status).toBe("sent");
    expect(f.writes[0]!.gasPrice).toBe(5_000_000_000n);
  });

  it("replaces a stuck transaction with a higher price and clears it once mined", async () => {
    let t = 1_000;
    const f = fakeChain();
    const s = new Sender(f.chain, { mode: "live", capWei: 3_000_000_000n, stuckAfterSec: 180, alert: () => {}, now: () => t });
    await s.send(call("routine"));
    t += 181;
    await s.poll();
    expect(f.writes.length).toBe(2);
    expect(f.writes[1]!.gasPrice).toBe(1_250_000_000n);
    f.mine();
    await s.poll();
    expect(s.busy).toBe(false);
  });
});

describe("alerts", () => {
  it("throttles by kind, redacts secrets and never throws", async () => {
    registerSecrets(["supersecrettoken123"]);
    const sent: string[] = [];
    let t = 0;
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body).text);
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    const a = new Alerts("supersecrettoken123", "1", "[k]", fetchImpl, () => t);
    await a.send("x", "hello supersecrettoken123");
    await a.send("x", "again");
    t += 1_801;
    await a.send("x", "later");
    await a.send("y", "always", true);
    await a.send("y", "always again", true);
    expect(sent).toEqual(["[k] hello ***", "[k] later", "[k] always", "[k] always again"]);
    const broken = new Alerts("t", "1", "[k]", (async () => Promise.reject(new Error("down"))) as unknown as typeof fetch);
    await expect(broken.send("z", "x")).resolves.toBeUndefined();
    expect(redact("a supersecrettoken123 b")).toBe("a *** b");
  });
});

describe("config", () => {
  const base = { KEEPER_PRIVATE_KEY: KEY, BSC_RPC: "https://bsc.example/key", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "9" };

  it("defaults to dry mode and the spec's values", () => {
    const c = loadConfig(base);
    expect(c.mode).toBe("dry");
    expect(c.seizedHarvestEveryHours).toBe(168);
    expect(c.pushDailyMax).toBe(10);
    expect(c.bnbReserve).toBe(10_000_000_000_000_000n);
    expect(c.okbPerBnb).toBe(null);
    expect(c.suspendOnRevoke).toBe(true);
    expect(c.holdHarvestOnVaultFreeze).toBe(true);
    expect(c.secrets).toContain(KEY);
    expect(c.secrets).not.toContain("https://rpc.xlayer.tech");
  });

  it("reads a list of X Layer endpoints, sends through the first, and keeps keyed ones secret (part E §3.2)", () => {
    const keyed = "https://x.example.quiknode.pro/abc123/";
    const c = loadConfig({ ...base, XLAYER_RPC: `https://xlayer.drpc.org, ${keyed},https://rpc.xlayer.tech` });
    expect(c.xlayerRpcs).toEqual(["https://xlayer.drpc.org", keyed, "https://rpc.xlayer.tech"]);
    expect(c.xlayerRpc).toBe("https://xlayer.drpc.org");
    expect(c.secrets).toContain(keyed);
    expect(c.secrets).not.toContain("https://xlayer.drpc.org");
    expect(loadConfig({ ...base, XLAYER_RPC: "https://rpc.xlayer.tech/" }).secrets).not.toContain("https://rpc.xlayer.tech/"); // a trailing slash is still public
    const clients = makeClients(c);
    const read = clients.xlayer.public.transport as unknown as { type: string; retryCount: number };
    expect(read.type).toBe("fallback");
    expect(read.retryCount).toBe(0);
    const write = clients.xlayer.wallet.transport as unknown as { type: string; url: string };
    expect(write.type).toBe("http");
    expect(write.url).toBe("https://xlayer.drpc.org");
    expect((clients.bsc.public.transport as unknown as { type: string }).type).toBe("http");
    expect(loadConfig(base).xlayerRpcs).toEqual(["https://rpc.xlayer.tech"]);
  });

  it("tries each X Layer endpoint once per read, in order, and stops there (part E §3.2)", async () => {
    const hits: string[] = [];
    const servers = await Promise.all(
      ["a", "b"].map(
        (name) =>
          new Promise<import("node:http").Server>((resolve) => {
            const s = createServer((_req, res) => {
              hits.push(name);
              res.writeHead(429).end("rate limited");
            });
            s.listen(0, "127.0.0.1", () => resolve(s));
          }),
      ),
    );
    try {
      const urls = servers.map((s) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`);
      const client = createPublicClient({ transport: readTransport(urls) });
      await expect(client.getBlockNumber()).rejects.toThrow();
      expect(hits).toEqual(["a", "b"]);
    } finally {
      for (const s of servers) s.close();
    }
  });

  it("treats a keyed X Layer endpoint as a secret", () => {
    const keyed = "https://x.example.quiknode.pro/abc123/";
    expect(loadConfig({ ...base, XLAYER_RPC: keyed }).secrets).toContain(keyed);
  });

  it("rejects a bad mode, a malformed key and a missing secret", () => {
    expect(() => loadConfig({ ...base, KEEPER_MODE: "yolo" })).toThrow();
    expect(() => loadConfig({ ...base, KEEPER_PRIVATE_KEY: "0x1234" })).toThrow();
    expect(() => loadConfig({ ...base, BSC_RPC: "" })).toThrow();
    expect(loadConfig({ ...base, KEEPER_MODE: "live", SEIZED_HARVEST_EVERY_H: "72" }).seizedHarvestEveryHours).toBe(72);
    expect(loadConfig({ ...base, OKB_PER_BNB: "6.44" }).okbPerBnb).toBe(6_440_000_000_000_000_000n);
    expect(() => loadConfig({ ...base, OKB_PER_BNB: "-1" })).toThrow();
    expect(() => loadConfig({ ...base, OKB_PER_BNB: "abc" })).toThrow();
  });
});

describe("state", () => {
  it("round-trips and falls back to empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    const path = join(dir, "sub", "state.json");
    expect(loadState(path, 5n).cursor).toBe("5");
    const s = emptyState(10n);
    s.agents["0xA"] = "0xB";
    s.watch.braked = true;
    s.watch.streak.voucher = 3;
    saveState(path, s);
    const back = loadState(path, 0n);
    expect(back.agents["0xA"]).toBe("0xB");
    // the brake latch is not persisted: a redeploy with reviewed constants unfreezes (H2)
    expect(back.watch.braked).toBe(false);
    expect(back.watch.streak.voucher).toBe(0);
  });

  it("never starts the log scan before the deploy block, and restarts it for another factory (H3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    const p = join(dir, "state.json");
    saveState(p, emptyState(0n)); // saved before deployment: cursor 0, no factory
    const s = loadState(p, 73_600_000n, "0xFaC");
    expect(s.cursor).toBe("73600000");
    s.cursor = "73600500";
    s.agents["0xA"] = "0xB";
    saveState(p, s);
    expect(loadState(p, 73_600_000n, "0xFaC").cursor).toBe("73600500");
    const other = loadState(p, 74_000_000n, "0xNEW");
    expect(other.cursor).toBe("74000000");
    expect(other.agents).toEqual({});
  });

  it("drops the old deployment's timers with its factory, and keeps the counters (R3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    const p = join(dir, "state.json");
    const s = emptyState(100n, "0xOLD");
    s.lastPushAt["16"] = 5;
    s.lastSweepAt["0xA"] = 5;
    s.lastForwardAt["0xA"] = 5;
    s.harvest.loans["0xa:1"] = { maturityDone: true, lastAt: 5, shortfalls: 0 };
    s.harvest.seizedLastAt = 5;
    s.evidence["0xa:1:16"] = { count: 1, afterSeize: false, sends: 1, flagAt: 0 };
    s.evidence["0xa:1:5"] = { count: 1, afterSeize: true } as never; // written before the landed check
    s.pushCounts["all:11"] = 3;
    s.watch.lastSeen = { voucher: "0x01" };
    saveState(p, s);
    const same = loadState(p, 100n, "0xOLD");
    expect(same.lastPushAt["16"]).toBe(5);
    expect(same.harvest.loans["0xa:1"]!.maturityDone).toBe(true);
    expect(same.evidence["0xa:1:16"]!.count).toBe(1);
    expect(same.evidence["0xa:1:5"]).toEqual({ count: 1, afterSeize: true, sends: 1, flagAt: 0 });
    const fresh = loadState(p, 200n, "0xNEW");
    expect([fresh.lastPushAt, fresh.lastSweepAt, fresh.lastForwardAt, fresh.harvest, fresh.evidence]).toEqual([
      {},
      {},
      {},
      { loans: {}, seizedLastAt: 0 },
      {},
    ]);
    expect(fresh.factory).toBe("0xNEW");
    expect(fresh.pushCounts["all:11"]).toBe(3);
    expect(fresh.watch.lastSeen).toEqual({ voucher: "0x01" });
  });
});

describe("http", () => {
  it("takes the client IP from the last X-Forwarded-For entry", () => {
    const req = (xff?: string) =>
      ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: "10.0.0.1" } }) as unknown as IncomingMessage;
    expect(clientIp(req("6.6.6.6, 1.2.3.4"))).toBe("1.2.3.4");
    expect(clientIp(req())).toBe("10.0.0.1");
  });
});

describe("live read (opt-in: KEEPER_LIVE_READ=1 and BSC_RPC set)", () => {
  it.skipIf(!process.env.KEEPER_LIVE_READ || !process.env.BSC_RPC)(
    "a fresh keeper does not freeze on the real chains (K8 constants are current)",
    async () => {
      const { Keeper } = await import("../src/keeper.js");
      const clients = makeClients({ privateKey: KEY as `0x${string}`, bscRpc: process.env.BSC_RPC!, xlayerRpc: "https://rpc.xlayer.tech" });
      const cfg = loadConfig({ KEEPER_PRIVATE_KEY: KEY, BSC_RPC: process.env.BSC_RPC!, TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "1" });
      const sent: string[] = [];
      const alerts = { send: vi.fn(async (_k: string, t: string) => void sent.push(t)) } as unknown as Alerts;
      const sender = { poll: async () => {}, send: async () => ({ status: "dry" }) } as unknown as Sender;
      const k = new Keeper(cfg, clients, null, alerts, { bsc: sender, xlayer: sender }, emptyState(0n));
      await k.cycle();
      expect(k.frozen).toBe(false);
      expect(sent.filter((t) => t.includes("implementation changed"))).toEqual([]);
    },
    60_000,
  );
});
