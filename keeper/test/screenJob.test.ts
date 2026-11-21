// SPEC-PHASE5-REGISTER §6.4: one real screen run, in process, on the screen tool's own offline fake chain (screen/test).
// The vendored checks judge rig 16, the artifact lands under its canonical name, and the second provider must reproduce
// it byte for byte. Skipped when ../screen is not checked out next to the keeper.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keccak256, type Hex } from "viem";
import { downloadVectors, MAX_VECTORS_BYTES, runJob, type JobDeps, type JobInput } from "../src/screen/job.js";
import { workerOptions } from "../src/screen/runner.js";
import { createHash } from "node:crypto";
import type { ChainView } from "../src/screen/vendor/chain.js";
import { VECTORS_URL } from "../src/screen/vendor/constants.js";
import { parseCanonical } from "../src/screen/vendor/jcs.js";
import { KEEPER_TOOL } from "../src/screens.js";

const FAKE = new URL("../../screen/test/fake.ts", import.meta.url);
const have = existsSync(FAKE) && existsSync(new URL("../../screen/node_modules/viem/package.json", import.meta.url));

interface FakeModule {
  FakeChain: new (cfg: unknown, chainId?: number, block?: bigint) => ChainView;
  defaultConfig: () => Record<string, unknown>;
  fakeXlayer: (cfg: unknown) => ChainView;
  vectorFile: unknown;
}

const input = (outDir: string): JobInput => ({
  rigId: "16",
  outDir,
  bscRpcs: ["check-bsc"],
  xlayerRpcs: ["check-xlayer"],
  verifyBscRpcs: ["verify-bsc"],
  verifyXlayerRpcs: ["verify-xlayer"],
  tool: KEEPER_TOOL,
});

describe.skipIf(!have)("a screen run on the offline fake chain", () => {
  async function deps(o: { verifyBlockHashDiffers?: boolean; verifyDown?: boolean; brokenRig?: boolean } = {}) {
    const f = (await import(FAKE.href)) as FakeModule;
    const cfg = f.defaultConfig();
    if (o.brokenRig) cfg.passesCE = false;
    const opened: string[] = [];
    const d: JobDeps = {
      openBsc: async (url, block) => {
        opened.push(`${url}@${String(block)}`);
        if (url === "verify-bsc" && o.verifyDown) throw new Error("BSC eth_chainId failed after 3 attempts: network error (TypeError)");
        // the fake's block hash is a function of (chain, block): another block number is another provider's chain
        if (url === "verify-bsc" && o.verifyBlockHashDiffers) return new f.FakeChain(cfg, 56, 999n);
        return new f.FakeChain(cfg, 56, block === "finalized" ? 1_000n : block);
      },
      openXlayer: async (url, block) => {
        opened.push(`${url}@${String(block)}`);
        return block === "latest" ? f.fakeXlayer(cfg) : new f.FakeChain(cfg, 196, block);
      },
      loadVectors: async () => ({ vectors: f.vectorFile as never, url: VECTORS_URL, sha256: `0x${"ab".repeat(32)}` as Hex }),
    };
    return { d, opened };
  }

  it("passes rig 16, writes the artifact under its hash, and has it reproduced on the second providers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "screen-job-"));
    const { d, opened } = await deps();
    const r = await runJob(input(dir), d);
    expect(r.kind).toBe("done");
    if (r.kind !== "done") return;
    expect(r.verdict).toBe("PASS");
    expect(r.reasons).toEqual([]);
    const bytes = readFileSync(join(dir, r.file));
    expect(keccak256(new Uint8Array(bytes))).toBe(r.hash);
    expect(r.file).toBe(`rig-16-${r.hash.slice(2, 10)}.json`);
    const art = parseCanonical(bytes.toString("utf8")) as { tool: unknown; mode: string; verdict: string; rig: { id: string; circuits: string } };
    expect(art).toMatchObject({ mode: "A", verdict: "PASS", rig: { id: "16" } });
    expect(art.tool).toEqual(KEEPER_TOOL);
    expect(r.circuits).toBe(art.rig.circuits);
    expect(r.taskId).toBe("4");
    expect(r.verify).toEqual({ ran: true, ok: true, messages: [`reproduced ${r.hash} at BSC block 1000`], transient: false });
    // the check on the check endpoints, the reproduction on the verify endpoints at the artifact's own blocks
    expect(opened).toEqual(["check-bsc@finalized", "check-xlayer@latest", "verify-bsc@1000", "verify-xlayer@2000"]);
  });

  it("is not verified when the second provider's chain differs, and is transient when it cannot be read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "screen-job-"));
    const differs = await runJob(input(dir), (await deps({ verifyBlockHashDiffers: true })).d);
    expect(differs.kind === "done" && differs.verify.ok).toBe(false);
    expect(differs.kind === "done" && differs.verify.transient).toBe(false);
    const down = await runJob(input(dir), (await deps({ verifyDown: true })).d);
    expect(down.kind === "done" && down.verify).toMatchObject({ ran: true, ok: false, transient: true });
  });

  it("reproduces a rig-level FAIL too, so a final FAIL never rests on one provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "screen-job-"));
    const r = await runJob(input(dir), (await deps({ brokenRig: true })).d);
    expect(r.kind === "done" && r.verdict).toBe("FAIL");
    expect(r.kind === "done" && r.reasons).toEqual(["the rig fails a registered counterexample"]);
    expect(r.kind === "done" && r.verify.ran && r.verify.ok).toBe(true);
  });

  it("reports a check endpoint that cannot be opened as a transient error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "screen-job-"));
    const { d } = await deps();
    const r = await runJob(input(dir), { ...d, openBsc: async () => { throw new Error("BSC eth_chainId failed after 3 attempts: HTTP 503"); } });
    expect(r).toEqual({ kind: "error", transient: true, message: "BSC eth_chainId failed after 3 attempts: HTTP 503" });
    expect(await runJob({ ...input(dir), rigId: "x" }, d)).toEqual({ kind: "error", transient: false, message: "bad rig id" });
  });
});

describe.skipIf(!have)("the second provider failing inside the re-run (L3)", () => {
  it("reports a transport failure during the reproduction as transient, not as a disagreement", async () => {
    const f = (await import(FAKE.href)) as FakeModule;
    const cfg = f.defaultConfig();
    const dir = mkdtempSync(join(tmpdir(), "screen-job-"));
    const d: JobDeps = {
      openBsc: async (url, block) => {
        const base = new f.FakeChain(cfg, 56, block === "finalized" ? 1_000n : block);
        if (url !== "verify-bsc") return base;
        let n = 0;
        return {
          chainId: base.chainId,
          block: base.block,
          blockHash: base.blockHash,
          call: async (to, data, gas) => {
            if (++n === 5) throw new Error("BSC eth_call failed after 3 attempts: network error (TimeoutError)");
            return base.call(to, data, gas);
          },
          storage: (a, s) => base.storage(a, s),
          codeHash: (a) => base.codeHash(a),
          batch: (c) => base.batch(c),
        };
      },
      openXlayer: async (_url, block) => (block === "latest" ? f.fakeXlayer(cfg) : new f.FakeChain(cfg, 196, block)),
      loadVectors: async () => ({ vectors: f.vectorFile as never, url: VECTORS_URL, sha256: `0x${"ab".repeat(32)}` as Hex }),
    };
    const r = await runJob(input(dir), d);
    expect(r.kind === "done" && r.verdict).toBe("PASS");
    expect(r.kind === "done" && r.verify).toMatchObject({ ran: true, ok: false, transient: true });
    expect(r.kind === "done" && r.verify.messages.at(-1)).toBe("the second provider failed to answer during the re-run");
  });
});

describe("the worker's limits and the vector download (L5)", () => {
  it("starts the worker with an empty environment and a memory ceiling, the job's input in workerData only", () => {
    const o = workerOptions(input("/tmp/x"));
    expect(o.env).toEqual({});
    expect(o.resourceLimits).toEqual({ maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 });
    expect(o.workerData).toEqual(input("/tmp/x"));
  });

  const respond = (body: string | Uint8Array, headers: Record<string, string> = {}, status = 200) =>
    (async () => new Response(typeof body === "string" ? body : new Uint8Array(body), { status, headers })) as unknown as typeof fetch;

  it("streams the file, hashes the exact bytes, and refuses one that is too large, declared or not", async () => {
    const text = '{"4":{"kind":"comb"}}';
    const v = await downloadVectors(respond(text), 1_000);
    expect(v.url).toBe(VECTORS_URL);
    expect(v.sha256).toBe(`0x${createHash("sha256").update(text).digest("hex")}`);
    expect(v.vectors).toEqual({ "4": { kind: "comb" } });
    await expect(downloadVectors(respond("x".repeat(50)), 10)).rejects.toThrow("vector file download failed: too large");
    await expect(downloadVectors(respond(text, { "content-length": "999999" }), 1_000)).rejects.toThrow("vector file download failed: too large");
    await expect(downloadVectors(respond("", {}, 503))).rejects.toThrow("vector file download failed: HTTP 503");
    expect(MAX_VECTORS_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe.skipIf(!have)("endpoint lists: public first, a fallback on transport failures only (Q2)", () => {
  const TRANSIENT = "BSC eth_chainId failed after 3 attempts: HTTP 503";
  /** `down` hosts fail to open, `flaky` hosts fail transiently on their 5th call, `revert` hosts answer every call with a revert. */
  async function world() {
    const f = (await import(FAKE.href)) as FakeModule;
    const cfg = f.defaultConfig();
    const opened: string[] = [];
    const wrap = (url: string, base: ChainView): ChainView => {
      let n = 0;
      return {
        chainId: base.chainId,
        block: base.block,
        blockHash: base.blockHash,
        call: async (to, data, gas) => {
          if (url.includes("revert")) return { ok: false, data: "0x" };
          if (url.includes("flaky") && ++n === 5) throw new Error("BSC eth_call failed after 3 attempts: network error (TimeoutError)");
          return base.call(to, data, gas);
        },
        storage: (a, s) => base.storage(a, s),
        codeHash: (a) => base.codeHash(a),
        batch: (c) => base.batch(c),
      };
    };
    const d: JobDeps = {
      openBsc: async (url, block) => {
        opened.push(`${url}@${String(block)}`);
        if (url.includes("down")) throw new Error(TRANSIENT);
        return wrap(url, new f.FakeChain(cfg, 56, block === "finalized" ? 1_000n : block));
      },
      openXlayer: async (url, block) => {
        opened.push(`${url}@${String(block)}`);
        if (url.includes("down")) throw new Error("X Layer eth_chainId failed after 3 attempts: HTTP 502");
        return block === "latest" ? f.fakeXlayer(cfg) : new f.FakeChain(cfg, 196, block);
      },
      loadVectors: async () => ({ vectors: f.vectorFile as never, url: VECTORS_URL, sha256: `0x${"ab".repeat(32)}` as Hex }),
    };
    return { d, opened };
  }
  const job = (over: Partial<JobInput>): JobInput => ({ ...input(mkdtempSync(join(tmpdir(), "screen-job-"))), ...over });

  it("moves the check to the next URL of the side that failed to answer, and records only providers", async () => {
    const { d, opened } = await world();
    const r = await runJob(job({ bscRpcs: ["https://down.example/k", "https://bsc-dataseed.binance.org"], xlayerRpcs: ["https://down.example/x", "https://xlayer.drpc.org"], verifyBscRpcs: ["https://bsc-mainnet.public.blastapi.io"], verifyXlayerRpcs: ["https://rpc.xlayer.tech"] }), d);
    expect(r.kind === "done" && r.verdict).toBe("PASS");
    expect(r.kind === "done" && r.verify).toMatchObject({ ran: true, ok: true, transient: false });
    expect(r.kind === "done" && r.hosts).toEqual({ checkBsc: "binance.org", checkXlayer: "drpc.org", verifyBsc: "blastapi.io", verifyXlayer: "xlayer.tech" });
    // each attempt opens both sides again at a fresh pin; only the side that failed moves on
    expect(opened.slice(0, 5)).toEqual(["https://down.example/k@finalized", "https://bsc-dataseed.binance.org@finalized", "https://down.example/x@latest", "https://bsc-dataseed.binance.org@finalized", "https://xlayer.drpc.org@latest"]);
  });

  it("moves on after a transport failure in the middle of the checks, too", async () => {
    const { d, opened } = await world();
    const r = await runJob(job({ bscRpcs: ["https://flaky.example", "https://bsc-dataseed.binance.org"], verifyBscRpcs: ["https://bsc-mainnet.public.blastapi.io"] }), d);
    expect(r.kind === "done" && r.verdict).toBe("PASS");
    expect(r.kind === "done" && r.hosts.checkBsc).toBe("binance.org");
    expect(opened.filter((o) => o.endsWith("@finalized"))).toEqual(["https://flaky.example@finalized", "https://bsc-dataseed.binance.org@finalized"]);
  });

  it("never moves on a revert: that is the chain's answer, and the run reports it", async () => {
    const { d, opened } = await world();
    const r = await runJob(job({ bscRpcs: ["https://revert.example", "https://bsc-dataseed.binance.org"], verifyBscRpcs: ["https://bsc-mainnet.public.blastapi.io"] }), d);
    expect(r.kind === "done" && r.verdict).toBe("FAIL");
    expect(r.kind === "done" && r.reasons[0]).toMatch(/^rpc: rigs reverted/);
    expect(opened.some((o) => o.includes("binance.org"))).toBe(false);
    expect(r.kind === "done" && r.verify.ran).toBe(false); // not a rig-level FAIL: nothing to reproduce
  });

  it("never lets the check's provider serve the reproduction, also after a fallback; no PASS then", async () => {
    const { d, opened } = await world();
    // the check falls back to the keyed endpoint; the verify list's only other provider is down
    const a = await runJob(job({ bscRpcs: ["https://down.example", "https://k1.bsc.quiknode.pro/t1"], verifyBscRpcs: ["https://down2.example", "https://k2.bsc.quiknode.pro/t2"] }), d);
    expect(a.kind === "done" && a.hosts.checkBsc).toBe("quiknode.pro");
    expect(a.kind === "done" && a.verify).toMatchObject({ ran: true, ok: false, transient: true });
    expect(opened.some((o) => o.startsWith("https://k2.bsc.quiknode.pro"))).toBe(false);
    // and with no other provider in the verify list at all
    const b = await runJob(job({ bscRpcs: ["https://down.example", "https://k1.bsc.quiknode.pro/t1"], verifyBscRpcs: ["https://k2.bsc.quiknode.pro/t2"] }), d);
    expect(b.kind === "done" && b.verify).toEqual({ ran: true, ok: false, transient: true, messages: ["no second provider other than the check's is configured for this run"] });
    expect(b.kind === "done" && b.hosts.verifyBsc).toBeNull();
  });
});
