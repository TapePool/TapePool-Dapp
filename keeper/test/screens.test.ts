// "Register to borrow" in the keeper (SPEC-PHASE5-REGISTER §6): the classifier, the configuration, admission, the queue,
// the outcomes, restart and the routes. The screen run itself is a stub here; test/screenJob.test.ts runs the real one.
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import type { Deployment } from "../src/addresses.js";
import { loadConfig, loadScreenConfig, type ScreenConfig } from "../src/config.js";
import { startHttp } from "../src/http.js";
import { ReadLimiter } from "../src/logic/readLimits.js";
import { RegisterLimiter } from "../src/logic/registerLimits.js";
import type { PushService } from "../src/push.js";
import { classifyReason, classifyReasons } from "../src/screen/classify.js";
import { providerOf, urlList } from "../src/screen/provider.js";
import { isJobResult, type JobInput, type JobResult } from "../src/screen/job.js";
import { cleanScreenState, KEEPER_TOOL, PRE_READ_BACKOFF_SEC, ScreenService, delayText, emptyScreenState, MAX_QUEUED, type ScreenChain, type ScreenState } from "../src/screens.js";
import { emptyState, loadState, saveState } from "../src/state.js";

const SCREEN = "0xc2bBc2f2EC90e16f8a9619D26A51144Eb0AC1744" as Address;
const D = { screen: SCREEN, pool: SCREEN, factory: SCREEN, receiver: SCREEN, reporter: SCREEN, factoryDeployBlock: 1n } as Deployment;
const CFG: ScreenConfig = { bscRpcs: ["https://bsc-dataseed.binance.org", "https://a.bsc.quiknode.pro/key"], xlayerRpcs: ["https://xlayer.drpc.org"], verifyBscRpcs: ["https://bsc-mainnet.public.blastapi.io"], verifyXlayerRpcs: ["https://rpc.xlayer.tech"], appUrl: "https://app.tapepool.io", dailyMax: 20 };
const T0 = 1_763_640_000;
const CIRCUITS = "0xb1024b89886b9a34aa4ff5f31c411d708b20a14c";

/* ───────── the classifier (§6.5) ───────── */

describe("reason classes", () => {
  it("names each rig-level reason the vendored checks write", () => {
    const rig: [string, string][] = [
      ["no voucher for this rig on X Layer", "no-voucher"],
      ["voucher and vault disagree on the rig's circuit", "voucher-mismatch"],
      ["PodMining's miner record differs from the vault", "voucher-mismatch"],
      ["the rig's processor is not PoD-mineable", "processor"],
      ["processor 0xF4412C52ec3DDf7CAf5f518B6662F77B02Bde28E is not PoD-mineable", "processor"],
      ["miner status 2, not active", "not-mining"],
      ["task is not active", "task"],
      ["unknown task kind 7", "task"],
      ["task has no cycles, outputs or vectors", "task"],
      ["netlist: REF cycle at 0xabc:1", "circuit"],
      ["rig pins differ from the task", "circuit"],
      ["combinational task but the rig has state", "circuit"],
      ["V1: the rig's output differs at official vector 3", "wrong-output"],
      ["V2: challenge of official vector 3 gave success (the miner would be revoked), not Corr()", "wrong-output"],
      ["V2: challenge of official vector 0 gave Nomn() (not mining), not Corr()", "not-mining"],
      ["the rig differs from the task reference at input 0x0102", "differs"],
      ["the rig fails a registered counterexample", "counterexample"],
      ["too wide: 24 input bits over the 20-bit equivalence limit", "too-wide"],
    ];
    for (const [r, code] of rig) expect(classifyReason(r), r).toEqual({ kind: "fail", code });
  });

  it("pauses on protocol-wide reasons, retries only what an endpoint failed to answer, and calls everything else `check`", () => {
    for (const r of [
      "PodMining implementation differs from the reviewed one",
      "PodMining is not sealed with frozen tasks and no owner",
      "PodMining is paused",
      "PodMining module code differs from the reviewed one",
      "MAX_REF_LEVELS is implausibly large",
      "processor 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C is behind an unreviewed beacon",
      "the circuits evaluator differs from the reviewed implementation",
      "PodMining minerKey differs from the local key",
    ]) expect(classifyReason(r).kind, r).toBe("protocol");
    for (const r of [
      "rpc: BSC eth_call failed after 3 attempts: network error (TimeoutError)",
      "BSC eth_chainId failed after 3 attempts: HTTP 429",
      "BSC: chain id 97, expected 56",
      "X Layer: block 123 not found",
      "vector file download failed: HTTP 503",
      "timeout",
    ]) expect(classifyReason(r).kind, r).toBe("transient");
    for (const r of [
      "rpc: getMiner reverted (0x12345678) on 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46", // a revert is an answer, not an outage
      "cross-check: the chain's evaluator disagrees with the local one on the rig (eval output on vector 2)",
      "the task reference fails its own vector 4",
      "V2: challenge of official vector 1 gave Prf() (bad proof), not Corr()",
      "V2: challenge of official vector -1 gave a wrong number of results, not Corr()",
      "task missing from the vector file",
      "vectors do not rebuild to the on-chain vectorsRoot",
      "error: something nobody expected",
      "a brand new reason",
    ]) expect(classifyReason(r).kind, r).toBe("check");
  });

  it("takes the most serious class of a mixed run: protocol, transient, check, then the first rig-level code", () => {
    expect(classifyReasons([])).toEqual({ kind: "pass" });
    expect(classifyReasons(["V1: the rig's output differs at official vector 1", "the rig fails a registered counterexample"])).toEqual({ kind: "fail", code: "wrong-output" });
    expect(classifyReasons(["V1: the rig's output differs at official vector 1", "a brand new reason"]).kind).toBe("check");
    expect(classifyReasons(["a brand new reason", "rpc: BSC eth_call failed after 3 attempts: HTTP 502"]).kind).toBe("transient");
    expect(classifyReasons(["rpc: x failed after 3 attempts", "PodMining is paused"]).kind).toBe("protocol");
  });
});

/* ───────── configuration (§6.1) ───────── */

describe("screen configuration", () => {
  const base = { KEEPER_MODE: "dry", KEEPER_PRIVATE_KEY: `0x${"11".repeat(32)}`, BSC_RPC: "https://bsc.quiknode.example/abc", TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "1" };

  it("keeps registration closed without a second BSC provider", () => {
    expect(loadConfig(base).screen).toBeNull();
  });

  it("defaults the check to the keeper's endpoints and the X Layer verify to another public node, and redacts every keyed URL", () => {
    const c = loadConfig({ ...base, SCREEN_VERIFY_BSC_RPC: "https://bsc-archive.example/key2" });
    expect(c.screen).toEqual({ bscRpcs: [base.BSC_RPC], xlayerRpcs: ["https://rpc.xlayer.tech"], verifyBscRpcs: ["https://bsc-archive.example/key2"], verifyXlayerRpcs: ["https://xlayerrpc.okx.com"], appUrl: "https://app.tapepool.io", dailyMax: 20 });
    expect(c.secrets).toContain("https://bsc-archive.example/key2");
    expect(c.secrets).not.toContain("https://xlayerrpc.okx.com");
    const d = loadConfig({ ...base, XLAYER_RPC: "https://xlayer.drpc.org", SCREEN_VERIFY_BSC_RPC: "https://b.example/k", SCREEN_BSC_RPC: "https://a.example/k", SCREEN_APP_URL: "https://app.tapepool.io/", SCREEN_DAILY_MAX: "5" });
    expect(d.screen).toMatchObject({ bscRpcs: ["https://a.example/k"], xlayerRpcs: ["https://xlayer.drpc.org"], verifyXlayerRpcs: ["https://rpc.xlayer.tech"], appUrl: "https://app.tapepool.io", dailyMax: 5 });
    expect(d.secrets).toEqual(expect.arrayContaining(["https://a.example/k", "https://b.example/k"]));
    const keyedX = loadConfig({ ...base, SCREEN_VERIFY_BSC_RPC: "https://b.example/k", SCREEN_VERIFY_XLAYER_RPC: "https://xlayer.quiknode.example/key" });
    expect(keyedX.secrets).toContain("https://xlayer.quiknode.example/key");
  });

  it("reads each SCREEN_* RPC variable as an ordered list, public first, and redacts every BSC entry (Q2)", () => {
    const c = loadConfig({
      ...base,
      SCREEN_BSC_RPC: "https://bsc-dataseed.binance.org, https://x.bsc.quiknode.pro/KEY1/",
      SCREEN_VERIFY_BSC_RPC: "https://bsc-mainnet.public.blastapi.io,,https://y.bsc.quiknode.pro/KEY2",
      SCREEN_XLAYER_RPC: "https://xlayer.drpc.org,https://rpc.xlayer.tech",
    });
    expect(c.screen).toMatchObject({
      bscRpcs: ["https://bsc-dataseed.binance.org", "https://x.bsc.quiknode.pro/KEY1/"],
      verifyBscRpcs: ["https://bsc-mainnet.public.blastapi.io", "https://y.bsc.quiknode.pro/KEY2"],
      xlayerRpcs: ["https://xlayer.drpc.org", "https://rpc.xlayer.tech"],
      verifyXlayerRpcs: ["https://rpc.xlayer.tech"],
    });
    expect(c.secrets).toEqual(expect.arrayContaining(["https://x.bsc.quiknode.pro/KEY1/", "https://y.bsc.quiknode.pro/KEY2", "https://bsc-dataseed.binance.org"]));
    expect(c.secrets).not.toContain("https://xlayer.drpc.org");
    // every entry is shape-checked; the error names the variable and the entry, never the value
    let msg = "";
    try {
      loadScreenConfig({ SCREEN_VERIFY_BSC_RPC: "https://bsc-mainnet.public.blastapi.io,y.bsc.quiknode.pro/KEY2" }, "https://a.example", ["https://rpc.xlayer.tech"]);
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toContain("SCREEN_VERIFY_BSC_RPC must be a comma-separated list of http(s) URLs (entry 2 is not)");
    expect(msg).not.toContain("KEY2");
    // the first entries must be different providers: two keys of one provider are one provider
    expect(() => loadScreenConfig({ SCREEN_BSC_RPC: "https://x.bsc.quiknode.pro/K1", SCREEN_VERIFY_BSC_RPC: "https://y.bsc.quiknode.pro/K2" }, "https://a.example", ["https://rpc.xlayer.tech"])).toThrow("must start with another provider");
    expect(providerOf("https://x.bsc.quiknode.pro/KEY/")).toBe("quiknode.pro");
    expect(providerOf("https://bsc-dataseed.binance.org")).toBe("binance.org");
    expect(providerOf("http://127.0.0.1:8545")).toBe("127.0.0.1");
    expect(urlList(" a, ,b ,")).toEqual(["a", "b"]);
  });

  it("refuses to start when a verify endpoint is the check's own endpoint, or the link is not https", () => {
    expect(() => loadScreenConfig({ SCREEN_VERIFY_BSC_RPC: "https://bsc.example/k/" }, "https://bsc.example/k", ["https://rpc.xlayer.tech"])).toThrow("SCREEN_VERIFY_BSC_RPC");
    expect(() => loadScreenConfig({ SCREEN_VERIFY_BSC_RPC: "https://b.example", SCREEN_VERIFY_XLAYER_RPC: "https://rpc.xlayer.tech/" }, "https://a.example", ["https://rpc.xlayer.tech"])).toThrow("SCREEN_VERIFY_XLAYER_RPC");
    expect(() => loadScreenConfig({ SCREEN_VERIFY_BSC_RPC: "https://b.example", SCREEN_APP_URL: "http://app.example" }, "https://a.example", ["https://rpc.xlayer.tech"])).toThrow("SCREEN_APP_URL");
    expect(() => loadScreenConfig({ SCREEN_VERIFY_BSC_RPC: "https://b.example", SCREEN_DAILY_MAX: "0" }, "https://a.example", ["https://rpc.xlayer.tech"])).toThrow("SCREEN_DAILY_MAX");
    expect(loadScreenConfig({ SCREEN_VERIFY_BSC_RPC: "https://b.example", SCREEN_APP_URL: "http://localhost:5173" }, "https://a.example", ["https://rpc.xlayer.tech"])?.appUrl).toBe("http://localhost:5173");
    // every screen endpoint is shape-checked, and the error names the variable, never the (secret) value
    for (const [env, name] of [
      [{ SCREEN_VERIFY_BSC_RPC: "bsc-archive.example/secretkey" }, "SCREEN_VERIFY_BSC_RPC"],
      [{ SCREEN_VERIFY_BSC_RPC: "https://b.example", SCREEN_BSC_RPC: "ws://a.example/secretkey" }, "SCREEN_BSC_RPC"],
      [{ SCREEN_VERIFY_BSC_RPC: "https://b.example", SCREEN_VERIFY_XLAYER_RPC: "ftp://x.example/secretkey" }, "SCREEN_VERIFY_XLAYER_RPC"],
      [{ SCREEN_VERIFY_BSC_RPC: "https://b.example", SCREEN_XLAYER_RPC: "secretkey" }, "SCREEN_XLAYER_RPC"],
    ] as const) {
      let msg = "";
      try {
        loadScreenConfig(env, "https://a.example", ["https://rpc.xlayer.tech"]);
      } catch (e) {
        msg = String(e);
      }
      expect(msg, name).toContain(`${name}`);
      expect(msg, name).toContain("must be a comma-separated list of http(s) URLs");
      expect(msg, name).not.toContain("secretkey");
    }
  });
});

/* ───────── the service (§6.3–§6.7) ───────── */

interface Rig {
  exists?: boolean;
  circuits?: string;
  power?: bigint;
  passAt?: bigint;
  suspended?: boolean;
}

function harness(o: { state?: ScreenState; dir?: string; cfg?: ScreenConfig | null; rigs?: Record<string, Rig>; results?: JobResult[]; chainDown?: boolean } = {}) {
  let t = T0;
  let frozen = false;
  const rigs: Record<string, Rig> = o.rigs ?? { "16": {}, "17": {} };
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "screens-"));
  const state = o.state ?? emptyScreenState();
  const results = [...(o.results ?? [])];
  const inputs: JobInput[] = [];
  const alerts: { kind: string; text: string; always: boolean }[] = [];
  let down = o.chainDown ?? false;
  const chain: ScreenChain = {
    precheck: vi.fn(async (id: bigint) => {
      if (down) throw new Error("rpc down");
      const r = rigs[id.toString()];
      return { exists: r ? (r.exists ?? true) : false, circuits: (r?.circuits ?? CIRCUITS) as Address, power: r?.power ?? 5n, passAt: r?.passAt ?? 0n, suspended: r?.suspended ?? false };
    }),
    passes: vi.fn(async (ids: readonly bigint[]) => {
      if (down) throw new Error("rpc down");
      return new Map(ids.map((id) => [id.toString(), rigs[id.toString()]?.passAt ?? 0n]));
    }),
    delay: vi.fn(async () => 172_800n),
  };
  const persist = vi.fn();
  const svc = new ScreenService({
    cfg: o.cfg === undefined ? CFG : o.cfg,
    d: D,
    state,
    dir,
    chain,
    run: vi.fn(async (input: JobInput) => {
      inputs.push(input);
      const r = results.shift();
      if (!r) throw new Error("no stub result");
      return r;
    }),
    alert: (kind, text, always) => void alerts.push({ kind, text, always }),
    isFrozen: () => frozen,
    now: () => t,
    persist,
  });
  return {
    svc, state, dir, rigs, chain, inputs, alerts, persist, results,
    at: (sec: number) => (t = sec),
    advance: (sec: number) => (t += sec),
    freeze: (v: boolean) => (frozen = v),
    setDown: (v: boolean) => (down = v),
    /** One keeper cycle, and the run it starts (if any) recorded. */
    cycle: async () => {
      await svc.tick();
      await svc.idle();
    },
  };
}

/** A stored artifact file whose name and hash agree, as the job writes it. */
function artifactFile(dir: string, rig: string, body = `{"rig":"${rig}"}`): { file: string; hash: Hex } {
  const hash = keccak256(toBytes(body));
  const file = `rig-${rig}-${hash.slice(2, 10)}.json`;
  writeFileSync(join(dir, file), body);
  return { file, hash };
}

function done(dir: string, rig: string, over: Partial<Extract<JobResult, { kind: "done" }>> = {}): JobResult {
  const { file, hash } = artifactFile(dir, rig, `{"rig":"${rig}","n":"${Math.random()}"}`);
  return {
    kind: "done", verdict: "PASS", reasons: [], file, hash, circuits: CIRCUITS, circuitId: "7", taskId: "4", bscBlock: "134720632", xlayerBlock: "76420102",
    verify: { ran: true, ok: true, messages: ["reproduced"], transient: false },
    hosts: { checkBsc: "binance.org", checkXlayer: "drpc.org", verifyBsc: "blastapi.io", verifyXlayer: "xlayer.tech" },
    ...over,
  };
}

describe("POST /v1/register: admission and pre-checks", () => {
  it("queues a voucher with no pass, and returns the same record on every repeat without reading the chain again", async () => {
    const h = harness();
    const a = await h.svc.request("16", "1.1.1.1");
    expect(a).toMatchObject({ status: "queued", screen: { rigId: "16", status: "queued", attempts: 0, artifact: null, retryAt: null, code: null, reasons: [] } });
    expect((a as { screen: object }).screen).not.toHaveProperty("notBefore");
    expect(h.persist).toHaveBeenCalled();
    const b = await h.svc.request("16", "2.2.2.2");
    expect(b).toMatchObject({ status: "known", screen: { rigId: "16", status: "queued" } });
    expect(h.chain.precheck).toHaveBeenCalledTimes(1);
  });

  it("refuses with the exact reasons of §6.2", async () => {
    const h = harness({ rigs: { "1": { exists: false }, "2": { circuits: "0x0000000000000000000000000000000000000000" }, "3": { power: 0n }, "4": { suspended: true }, "5": { passAt: 123n } } });
    const ask = (id: unknown, ip = `9.9.9.${Math.random()}`) => h.svc.request(id, ip);
    for (const bad of [undefined, 16, "016", "-1", "1e3", "0x10", "1".repeat(16), " 16"]) expect(await ask(bad), String(bad)).toEqual({ status: "refused", reason: "bad rig id" });
    expect(await ask("1")).toEqual({ status: "refused", reason: "no voucher" });
    expect(await ask("2")).toEqual({ status: "refused", reason: "no voucher" });
    expect(await ask("3")).toEqual({ status: "refused", reason: "voucher not synced" });
    expect(await ask("4")).toEqual({ status: "refused", reason: "screen suspended" });
    expect(await ask("5")).toEqual({ status: "recorded" });
    expect(Object.keys(h.state.records)).toEqual([]);
    h.setDown(true);
    expect(await ask("16")).toEqual({ status: "refused", reason: "chain read failed, try again shortly" });
    expect(Object.keys(h.state.records)).toEqual([]);
  });

  it("is closed without its configuration, and admits per IP and in total before anything else", async () => {
    expect(await harness({ cfg: null }).svc.request("16", "1.1.1.1")).toEqual({ status: "refused", reason: "registration is not open" });
    const h = harness();
    for (let i = 0; i < 10; i++) await h.svc.request("bad", "7.7.7.7"); // refusals count too
    expect(await h.svc.request("16", "7.7.7.7")).toEqual({ status: "refused", reason: "too many requests from this address" });
    h.advance(3_600);
    expect((await h.svc.request("16", "7.7.7.7")).status).toBe("queued");
    const g = harness();
    for (let i = 0; i < 30; i++) await g.svc.request("bad", `ip-${i}`);
    expect(await g.svc.request("16", "fresh")).toEqual({ status: "refused", reason: "busy, try again in a minute" });
    expect(g.state.counts).not.toHaveProperty("pushes"); // its own counters, in state.screen.counts
  });

  it("caps the queue at 20 and the chain reads at two in flight", async () => {
    const rigs: Record<string, Rig> = {};
    for (let i = 1; i <= MAX_QUEUED + 1; i++) rigs[String(i)] = {};
    const h = harness({ rigs });
    for (let i = 1; i <= MAX_QUEUED; i++) expect((await h.svc.request(String(i), `ip${i}`)).status).toBe("queued");
    expect(await h.svc.request(String(MAX_QUEUED + 1), "late")).toEqual({ status: "refused", reason: "queue full, try again later" });
    const slow = harness();
    let release: () => void = () => {};
    (slow.chain.precheck as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise((r) => { release = () => r({ exists: true, circuits: CIRCUITS, power: 1n, passAt: 0n, suspended: false }); }));
    const p1 = slow.svc.request("16", "a");
    const p2 = slow.svc.request("17", "b");
    expect(await slow.svc.request("18", "c")).toEqual({ status: "refused", reason: "busy, try again shortly" });
    release();
    await Promise.race([p1, p2]);
  });
});

describe("the queue and its outcomes", () => {
  it("runs one job at a time with the configured endpoints and the keeper's tool, then records a verified PASS and alerts with the owner link", async () => {
    const h = harness();
    h.results.push(done(h.dir, "16"), done(h.dir, "17"));
    await h.svc.request("16", "a");
    await h.svc.request("17", "b");
    await h.svc.init();
    await h.svc.tick(); // starts 16 only
    expect(h.state.records["16"]?.status).toBe("checking");
    expect(h.state.records["17"]?.status).toBe("queued");
    await h.svc.idle();
    expect(h.inputs).toHaveLength(1);
    expect(h.inputs[0]).toMatchObject({ rigId: "16", bscRpcs: CFG.bscRpcs, xlayerRpcs: CFG.xlayerRpcs, verifyBscRpcs: CFG.verifyBscRpcs, verifyXlayerRpcs: CFG.verifyXlayerRpcs, outDir: h.dir });
    expect(h.inputs[0]!.tool.commit).toMatch(/^keeper-src-sha256:[0-9a-f]{64}$/);
    const r = h.state.records["16"]!;
    expect(r).toMatchObject({ status: "pass", attempts: 1, code: null, reasons: [], artifact: { verdict: "PASS", verified: true, taskId: "4", circuits: CIRCUITS } });
    const pass = h.alerts.find((x) => x.kind.startsWith("screen:pass:16:"))!;
    expect(pass.always).toBe(true);
    expect(pass.text).toContain("https://app.tapepool.io/#/app/owner");
    expect(pass.text).toContain("48 h after it is recorded");
    expect(pass.text).toContain(r.artifact!.hash);
    await h.cycle();
    expect(h.state.records["17"]?.status).toBe("pass");
    expect(new Set(h.alerts.filter((x) => x.kind.startsWith("screen:pass:")).map((x) => x.kind)).size).toBe(2); // two PASSes, two kinds
  });

  it("never records a PASS the second provider did not reproduce", async () => {
    const h = harness();
    h.results.push(done(h.dir, "16", { verify: { ran: true, ok: false, messages: ["BSC block hash differs from the artifact"], transient: false } }));
    await h.svc.request("16", "a");
    await h.cycle();
    expect(h.state.records["16"]).toMatchObject({ status: "error", code: "verify", retryAt: T0 + 86_400, artifact: { verified: false } });
    expect(h.alerts.some((x) => x.kind.startsWith("screen:verify:16") && x.always)).toBe(true);
  });

  it("records a verified rig-level FAIL as final, with its code", async () => {
    const h = harness();
    h.results.push(done(h.dir, "16", { verdict: "FAIL", reasons: ["V2: challenge of official vector 3 gave success (the miner would be revoked), not Corr()"] }));
    await h.svc.request("16", "a");
    await h.cycle();
    expect(h.state.records["16"]).toMatchObject({ status: "fail", code: "wrong-output", retryAt: null, artifact: { verdict: "FAIL", verified: true } });
    expect(h.alerts.find((x) => x.kind.startsWith("screen:fail:16"))?.text).toContain("Nothing to sign");
    h.advance(10 * 86_400);
    expect(await h.svc.request("16", "b")).toMatchObject({ status: "known", screen: { status: "fail" } });
  });

  it("retries a transient failure twice, 10 minutes apart, then makes it an error the miner can retry after 6 h", async () => {
    const h = harness();
    const flaky: JobResult = { kind: "error", transient: true, message: "BSC eth_call failed after 3 attempts: network error (TimeoutError)" };
    h.results.push(flaky, flaky, flaky, done(h.dir, "16"));
    await h.svc.request("16", "a");
    await h.cycle();
    expect(h.state.records["16"]).toMatchObject({ status: "queued", attempts: 1 });
    await h.cycle(); // not before 10 minutes
    expect(h.inputs).toHaveLength(1);
    h.advance(600);
    await h.cycle();
    h.advance(600);
    await h.cycle();
    expect(h.state.records["16"]).toMatchObject({ status: "error", code: "transient", attempts: 3, retryAt: T0 + 1_200 + 6 * 3_600 });
    expect(await h.svc.request("16", "b")).toMatchObject({ status: "known" });
    h.at(T0 + 1_200 + 6 * 3_600);
    expect(await h.svc.request("16", "c")).toMatchObject({ status: "queued", screen: { attempts: 0 } });
    await h.cycle();
    expect(h.state.records["16"]?.status).toBe("pass");
  });

  it("fails closed on a malformed run result: an error with an alert, never a PASS and never stuck in `checking`", async () => {
    const h = harness();
    const good = done(h.dir, "16") as Extract<JobResult, { kind: "done" }>;
    h.results.push({ ...good, verify: undefined } as unknown as JobResult, { kind: "done", verdict: "PASS" } as unknown as JobResult);
    await h.svc.request("16", "a");
    await h.cycle();
    expect(h.state.records["16"]).toMatchObject({ status: "error", code: "check", reasons: ["malformed screen result"] });
    expect(h.alerts.some((x) => x.kind.startsWith("screen:error:16") && x.always)).toBe(true);
    expect(isJobResult(good)).toBe(true);
    expect(isJobResult({ ...good, hash: "0x12" })).toBe(false);
    expect(isJobResult({ kind: "error", transient: "yes", message: "x" })).toBe(false);
    expect(isJobResult(null)).toBe(false);
  });

  it("fails closed when the check and the reproduction were served by one provider, whatever the job says (Q2)", async () => {
    const h = harness();
    h.results.push(done(h.dir, "16", { hosts: { checkBsc: "quiknode.pro", checkXlayer: "drpc.org", verifyBsc: "quiknode.pro", verifyXlayer: "xlayer.tech" } }));
    await h.svc.request("16", "a");
    await h.cycle();
    expect(h.state.records["16"]).toMatchObject({ status: "error", code: "verify", reasons: ["the check and the reproduction were served by the same provider"], artifact: { verified: false } });
    expect(h.state.records["16"]?.hosts).toEqual({ checkBsc: "quiknode.pro", checkXlayer: "drpc.org", verifyBsc: "quiknode.pro", verifyXlayer: "xlayer.tech" });
    expect(h.alerts.some((x) => x.kind.startsWith("screen:verify:16") && x.always)).toBe(true);
    const ok = harness();
    ok.results.push(done(ok.dir, "16"));
    await ok.svc.request("16", "a");
    await ok.cycle();
    expect(ok.state.records["16"]).toMatchObject({ status: "pass", hosts: { checkBsc: "binance.org", verifyBsc: "blastapi.io" } });
    expect(ok.svc.list().screens[0]?.hosts).toEqual({ checkBsc: "binance.org", checkXlayer: "drpc.org", verifyBsc: "blastapi.io", verifyXlayer: "xlayer.tech" });
  });

  it("treats a FAIL with an unknown or unexpected reason as an error, never as the rig's fault", async () => {
    const h = harness();
    h.results.push(done(h.dir, "16", { verdict: "FAIL", reasons: ["rpc: getMiner reverted (0x12345678) on 0x7E2E"], verify: { ran: false, ok: false, messages: [], transient: false } }));
    await h.svc.request("16", "a");
    await h.cycle();
    expect(h.state.records["16"]).toMatchObject({ status: "error", code: "check", retryAt: T0 + 86_400 });
  });

  it("pauses the whole queue on a protocol-wide reason, without charging the rig, and alerts once", async () => {
    const h = harness();
    h.results.push(done(h.dir, "16", { verdict: "FAIL", reasons: ["PodMining is paused"], verify: { ran: false, ok: false, messages: [], transient: false } }));
    await h.svc.request("16", "a");
    await h.svc.request("17", "b");
    await h.cycle();
    expect(h.state.records["16"]).toMatchObject({ status: "queued", attempts: 0 });
    expect(h.svc.paused).toBe(true);
    expect(h.svc.list().paused).toBe(true);
    await h.cycle();
    expect(h.inputs).toHaveLength(1);
    expect(h.alerts.filter((x) => x.kind === "screen:pause")).toHaveLength(1);
    expect(await h.svc.request("18", "c")).toMatchObject({ status: "refused" }); // 18 is not a voucher here; the route still answers
  });

  it("starts no run while the keeper is frozen, and keeps to the daily cap", async () => {
    const h = harness({ cfg: { ...CFG, dailyMax: 1 } });
    h.results.push(done(h.dir, "16"), done(h.dir, "17"));
    await h.svc.request("16", "a");
    await h.svc.request("17", "b");
    h.freeze(true);
    await h.cycle();
    expect(h.inputs).toHaveLength(0);
    expect(h.svc.list().paused).toBe(true);
    h.freeze(false);
    await h.cycle();
    await h.cycle();
    expect(h.inputs).toHaveLength(1); // the cap: one run on this UTC day
    expect(h.state.records["17"]?.status).toBe("queued");
    h.at(T0 + 86_400);
    await h.cycle();
    expect(h.state.records["17"]?.status).toBe("pass");
  });

  it("follows the chain: a pass recorded makes a record `recorded`, and a pass that disappears makes it `revoked`, never offered again", async () => {
    const h = harness();
    h.results.push(done(h.dir, "16"));
    await h.svc.request("16", "a");
    await h.cycle();
    expect(h.state.records["16"]?.status).toBe("pass");
    h.rigs["16"]!.passAt = BigInt(T0 + 172_800);
    await h.cycle();
    expect(h.state.records["16"]?.status).toBe("recorded");
    // L2: one empty read (a lagging endpoint) is not a revocation; three in a row are
    h.rigs["16"]!.passAt = 0n;
    await h.cycle();
    expect(h.state.records["16"]).toMatchObject({ status: "recorded", zeroReads: 1 });
    h.rigs["16"]!.passAt = BigInt(T0 + 172_800);
    await h.cycle();
    expect(h.state.records["16"]).toMatchObject({ status: "recorded", zeroReads: 0 });
    h.rigs["16"]!.passAt = 0n;
    await h.cycle();
    await h.cycle();
    expect(h.state.records["16"]?.status).toBe("recorded");
    await h.cycle();
    expect(h.state.records["16"]?.status).toBe("revoked");
    expect(h.alerts.filter((x) => x.kind === "screen:revoked:16")).toHaveLength(1);
    expect(await h.svc.request("16", "b")).toMatchObject({ status: "known", screen: { status: "revoked" } });
    // a pass seen again (re-recorded, or the reads were wrong) brings it back
    h.rigs["16"]!.passAt = BigInt(T0 + 999);
    await h.cycle();
    expect(h.state.records["16"]?.status).toBe("recorded");
  });

  it("counts a run only once its pre-run read succeeded: an X Layer outage backs off and never spends the daily cap (M1)", async () => {
    const h = harness({ cfg: { ...CFG, dailyMax: 2 } });
    h.results.push(done(h.dir, "16"));
    await h.svc.request("16", "a");
    h.setDown(true);
    for (let i = 0; i < 25; i++) {
      await h.cycle();
      h.advance(60);
    }
    const runs = () => Object.entries(h.state.counts).filter(([k]) => k.startsWith("run:")).reduce((n, [, v]) => n + v, 0);
    expect(runs()).toBe(0);
    expect(h.inputs).toHaveLength(0);
    expect(h.state.records["16"]).toMatchObject({ status: "queued", attempts: 0 });
    expect(h.state.records["16"]!.notBefore).toBeGreaterThan(T0);
    const pre = h.alerts.filter((x) => x.kind === "screen:preread");
    expect(pre.length).toBeGreaterThan(0);
    expect(pre.every((x) => !x.always)).toBe(true); // throttled by Alerts: at most one per 30 minutes
    // the read before the run backs off: at most one try per PRE_READ_BACKOFF_SEC (25 cycles a minute apart)
    expect(pre.length).toBeLessThanOrEqual(Math.ceil((25 * 60) / PRE_READ_BACKOFF_SEC) + 1);
    h.setDown(false);
    h.advance(PRE_READ_BACKOFF_SEC);
    await h.cycle();
    expect(runs()).toBe(1);
    expect(h.state.records["16"]).toMatchObject({ status: "pass", attempts: 1, tool: KEEPER_TOOL.commit });
  });

  it("never fails because the state cannot be saved: the registration is answered, the run is recorded, the owner is told (L1)", async () => {
    const h = harness();
    h.persist.mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    h.results.push(done(h.dir, "16"));
    expect(await h.svc.request("16", "a")).toMatchObject({ status: "queued" });
    await h.cycle();
    expect(h.state.records["16"]?.status).toBe("pass");
    expect(h.alerts.some((x) => x.kind === "screen:persist")).toBe(true);
  });

  it("ends a queued run without running it when a pass was recorded meanwhile", async () => {
    const h = harness();
    await h.svc.request("16", "a");
    (h.chain.passes as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => new Map()); // the cycle's refresh sees nothing yet
    h.rigs["16"]!.passAt = 5n;
    await h.cycle();
    expect(h.inputs).toHaveLength(0);
    expect(h.state.records["16"]?.status).toBe("recorded");
  });

  it("lists records by rig id and serves only artifact bytes that still hash to the record", async () => {
    const h = harness({ rigs: { "9": {}, "16": {} } });
    h.results.push(done(h.dir, "16"), done(h.dir, "9"));
    await h.svc.request("16", "a");
    await h.svc.request("9", "b");
    await h.cycle();
    await h.cycle();
    const list = h.svc.list();
    expect(list).toMatchObject({ open: true, paused: false, screen: SCREEN, asOf: T0 });
    expect(list.screens.map((s) => s.rigId)).toEqual(["9", "16"]);
    const a = h.svc.artifact("16")!;
    expect(keccak256(new Uint8Array(a.bytes))).toBe(h.state.records["16"]!.artifact!.hash);
    expect(a.file).toBe(h.state.records["16"]!.artifact!.file);
    writeFileSync(join(h.dir, a.file), "tampered");
    expect(h.svc.artifact("16")).toBeNull();
    expect(h.svc.artifact("nope")).toBeNull();
    expect(h.svc.artifact("17")).toBeNull();
  });
});

describe("persistence and restart (§6.6)", () => {
  it("puts a lost run back in the queue with its attempt counted (L5), and distrusts a verdict whose file is gone or altered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "screens-"));
    const good = artifactFile(dir, "5");
    const state = emptyScreenState();
    state.screen = SCREEN;
    const base = { requestedAt: T0, updatedAt: T0, notBefore: T0, retryAt: null, code: null, reasons: [], tool: KEEPER_TOOL.commit };
    const info = (f: { file: string; hash: Hex }) => ({ ...f, verdict: "PASS" as const, circuits: CIRCUITS, circuitId: "1", taskId: "4", bscBlock: "1", xlayerBlock: "1", verified: true });
    state.records["4"] = { rigId: "4", status: "checking", attempts: 2, artifact: null, ...base };
    state.records["3"] = { rigId: "3", status: "checking", attempts: 3, artifact: null, ...base };
    state.records["5"] = { rigId: "5", status: "pass", attempts: 1, artifact: info(good), ...base };
    state.records["6"] = { rigId: "6", status: "pass", attempts: 1, artifact: info({ file: "rig-6-deadbeef.json", hash: `0x${"de".repeat(32)}` }), ...base };
    const alerts: string[] = [];
    const h = new ScreenService({ cfg: CFG, d: D, state, dir, chain: null, run: async () => ({ kind: "error", transient: false, message: "x" }), alert: (k) => void alerts.push(k), isFrozen: () => false, now: () => T0 + 5 });
    expect(state.records["4"]).toMatchObject({ status: "queued", attempts: 2, notBefore: T0 + 5 });
    // a run that a third restart cut short: no more automatic tries
    expect(state.records["3"]).toMatchObject({ status: "error", code: "transient", retryAt: T0 + 5 + 6 * 3_600 });
    expect(state.records["5"]?.status).toBe("pass");
    expect(state.records["6"]).toMatchObject({ status: "error", code: "check", retryAt: T0 + 5 });
    expect(alerts).toEqual([`screen:error:3:${T0 + 5}`, "screen:lost:6"]);
    expect(h.open).toBe(false); // no chain: registration closed
  });

  it("screens a waiting PASS again when the tool changed, reviewed constants included (M2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "screens-"));
    const f = artifactFile(dir, "5");
    const state = emptyScreenState();
    state.screen = SCREEN;
    const base = { requestedAt: T0, updatedAt: T0, notBefore: T0, retryAt: null, code: null, reasons: [], attempts: 1 };
    const art = { ...f, verdict: "PASS" as const, circuits: CIRCUITS, circuitId: "1", taskId: "4", bscBlock: "1", xlayerBlock: "1", verified: true };
    state.records["5"] = { rigId: "5", status: "pass", artifact: art, tool: "keeper-src-sha256:old", ...base };
    state.records["7"] = { rigId: "7", status: "pass", artifact: art, ...base }; // from before the stamp existed
    state.records["8"] = { rigId: "8", status: "recorded", artifact: art, tool: "keeper-src-sha256:old", ...base }; // already signed: left alone
    const alerts: { kind: string; text: string }[] = [];
    new ScreenService({ cfg: CFG, d: D, state, dir, chain: null, run: async () => ({ kind: "error", transient: false, message: "x" }), alert: (kind, text) => void alerts.push({ kind, text }), isFrozen: () => false, now: () => T0 + 9 });
    for (const id of ["5", "7"]) expect(state.records[id]).toMatchObject({ status: "queued", attempts: 0, artifact: null, notBefore: T0 + 9 });
    expect(state.records["8"]?.status).toBe("recorded");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain("#5, #7");
    expect(alerts[0]!.text).toContain("Do not sign their old artifacts");
  });

  it("drops malformed persisted records and counters instead of crashing the keeper (L4)", () => {
    const dir = mkdtempSync(join(tmpdir(), "screens-bad-"));
    const path = join(dir, "state.json");
    const s = emptyState(1n, "0xFaC") as unknown as Record<string, unknown>;
    const good = { rigId: "16", status: "queued", requestedAt: T0, updatedAt: T0, attempts: 0, notBefore: T0, retryAt: null, code: null, reasons: [], artifact: null };
    s.screen = {
      screen: SCREEN,
      records: {
        "16": good,
        "17": { ...good, rigId: "18" }, // key and id disagree
        "19": { ...good, rigId: "19", status: "weird" },
        "20": { ...good, rigId: "20", artifact: { file: "../state.json", hash: "0x1" } },
        "21": { ...good, rigId: "21", reasons: "not a list" },
        "22": null,
        "x": { ...good, rigId: "x" },
      },
      counts: { "run:20412": 1, "ip:1.1.1.1:5": "many" },
    };
    writeFileSync(path, JSON.stringify(s));
    const loaded = loadState(path, 1n, "0xFaC");
    expect(Object.keys(loaded.screen.records)).toEqual(["16"]);
    expect(loaded.screen.counts).toEqual({ "run:20412": 1 });
    const raw = { screen: SCREEN, records: { "16": { ...good, attempts: -1 } }, counts: {} } as unknown as ScreenState;
    expect(() => new ScreenService({ cfg: CFG, d: D, state: raw, dir, chain: null, run: async () => ({ kind: "error", transient: false, message: "x" }), alert: () => {}, isFrozen: () => false })).not.toThrow();
    expect(raw.records).toEqual({});
    expect(cleanScreenState("garbage")).toEqual(emptyScreenState());
  });

  it("survives a state file round trip and a factory change, and starts over for another RigScreen", () => {
    const dir = mkdtempSync(join(tmpdir(), "screens-state-"));
    const path = join(dir, "state.json");
    const s = emptyState(1n, "0xFaC");
    s.screen.screen = SCREEN;
    s.screen.records["16"] = { rigId: "16", status: "queued", requestedAt: T0, updatedAt: T0, attempts: 0, notBefore: T0, retryAt: null, code: null, reasons: [], artifact: null };
    s.screen.counts["run:20412"] = 1;
    saveState(path, s);
    expect(loadState(path, 1n, "0xFaC").screen.records["16"]?.status).toBe("queued");
    const other = loadState(path, 1n, "0xOtherFactory");
    expect(other.screen.records["16"]?.status).toBe("queued");
    new ScreenService({ cfg: CFG, d: { ...D, screen: "0x0000000000000000000000000000000000000Abc" as Address }, state: other.screen, dir, chain: null, run: async () => ({ kind: "error", transient: false, message: "x" }), alert: () => {}, isFrozen: () => false });
    expect(other.screen).toEqual({ screen: "0x0000000000000000000000000000000000000Abc", records: {}, counts: {} });
    const old = JSON.parse(JSON.stringify(emptyState(1n, "0xFaC"))) as Record<string, unknown>;
    delete old.screen;
    writeFileSync(path, JSON.stringify(old));
    expect(loadState(path, 1n, "0xFaC").screen).toEqual(emptyScreenState());
  });
});

describe("the register limiter", () => {
  it("prunes past hours, minutes and days", () => {
    const counts: Record<string, number> = {};
    const l = new RegisterLimiter(counts);
    l.admit("::1", T0);
    l.countRun(T0);
    expect(l.runsToday(T0)).toBe(1);
    l.prune(T0 + 86_400);
    expect(counts).toEqual({});
  });

  it("words the delay from the chain", () => {
    expect(delayText(172_800n)).toBe("48 h after it is recorded");
    expect(delayText(5_400n)).toBe("90 min after it is recorded");
    expect(delayText(0n)).toBe("at once");
    expect(delayText(null)).toBe("after RigScreen.DELAY");
  });
});

/* ───────── the routes (§6.2) ───────── */

describe("the register routes", () => {
  const APP = "https://app.tapepool.io";
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  async function boot(h: ReturnType<typeof harness>) {
    const push = { request: vi.fn(async () => ({ status: "queued" })) };
    // a frozen clock: the one-minute window cannot roll over in the middle of the test
    server = startHttp(0, [APP], push as unknown as PushService, () => ({ ok: true }), undefined, new ReadLimiter(() => 1_000), h.svc);
    await new Promise((r) => server!.once("listening", r));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, push };
  }

  it("answers POST /v1/register as JSON with CORS for the app, its preflight, and 400 for a large or broken body", async () => {
    const h = harness();
    const { base, push } = await boot(h);
    const pre = await fetch(`${base}/v1/register`, { method: "OPTIONS", headers: { origin: APP } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(APP);
    expect(pre.headers.get("access-control-allow-methods")).toBe("POST");
    expect(pre.headers.get("access-control-allow-headers")).toBe("content-type");
    const foreign = await fetch(`${base}/v1/register`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    const ok = await fetch(`${base}/v1/register`, { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ rigId: "16" }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(APP);
    expect(await ok.json()).toMatchObject({ status: "queued", screen: { rigId: "16" } });
    expect((await fetch(`${base}/v1/register`, { method: "POST", body: JSON.stringify({ rigId: "1".repeat(300) }) })).status).toBe(400);
    expect((await fetch(`${base}/v1/register`, { method: "POST", body: "{" })).status).toBe(400);
    expect(await (await fetch(`${base}/v1/register`, { method: "POST", body: "[]" })).json()).toEqual({ status: "refused", reason: "bad rig id" });
    expect(push.request).not.toHaveBeenCalled();
    expect((await fetch(`${base}/v1/push`, { method: "POST", body: JSON.stringify({ agent: "0x0" }) })).status).toBe(200);
    expect(push.request).toHaveBeenCalledTimes(1);
    expect((await fetch(`${base}/v1/register`)).status).toBe(404);
  });

  it("serves the list and the artifact bytes with their name, 404 without one, and rate-limits both GETs", async () => {
    const h = harness();
    h.results.push(done(h.dir, "16"));
    await h.svc.request("16", "a");
    await h.cycle();
    const { base } = await boot(h);
    const list = await fetch(`${base}/v1/screens?x=1`, { headers: { origin: APP } });
    expect(list.headers.get("access-control-allow-origin")).toBe(APP);
    const body = (await list.json()) as { screens: { rigId: string; artifact: { file: string; hash: string } }[] };
    expect(body).toMatchObject({ open: true, paused: false, screen: SCREEN });
    const a = body.screens[0]!.artifact;
    const file = await fetch(`${base}/v1/screens/16/artifact`, { headers: { origin: APP } });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/json");
    expect(file.headers.get("content-disposition")).toBe(`attachment; filename="${a.file}"`);
    expect(file.headers.get("access-control-allow-origin")).toBe(APP);
    expect(keccak256(new Uint8Array(await file.arrayBuffer()))).toBe(a.hash);
    expect((await fetch(`${base}/v1/screens/17/artifact`)).status).toBe(404);
    expect((await fetch(`${base}/v1/screens/..%2fstate.json/artifact`)).status).toBe(404);
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await fetch(`${base}/v1/screens`)).status;
    expect(last).toBe(429);
  });

  it("does not exist without a screen service", async () => {
    const push = { request: vi.fn(async () => ({ status: "queued" })) };
    server = startHttp(0, [APP], push as unknown as PushService, () => ({ ok: true }));
    await new Promise((r) => server!.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${base}/v1/screens`)).status).toBe(404);
    expect((await fetch(`${base}/v1/register`, { method: "POST", body: "{}" })).status).toBe(404);
  });
});
