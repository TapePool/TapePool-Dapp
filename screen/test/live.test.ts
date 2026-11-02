// Opt-in live tests (SPEC-PHASE3-SCREEN §7): SCREEN_LIVE=1 and an archive BSC_RPC. Read-only: eth_call
// against BSC, and one LOCAL anvil fork for the changed-beacon case. Nothing is ever sent to a chain.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Hex } from "viem";
import { podAbi } from "../src/abi.js";
import { buildArtifact, writeArtifact } from "../src/artifact.js";
import { RpcView } from "../src/chain.js";
import { runChecks } from "../src/checks.js";
import { ADDR, BSC_CHAIN_ID, ERR, PROCESSORS, SLOT, VECTORS_URL, XLAYER_CHAIN_ID } from "../src/constants.js";
import { levels, proof } from "../src/vectors.js";
import { verifyFile } from "../src/verify.js";
import { fixtures, vectorFile } from "./fake.js";

const LIVE = Boolean(process.env.SCREEN_LIVE && process.env.BSC_RPC);
const B = 128_890_993n; // the fixture block
const XL = process.env.XLAYER_RPC || "https://rpc.xlayer.tech";
const SRC = { url: VECTORS_URL, sha256: `0x${"00".repeat(32)}` as Hex };
const TOOL = { name: "tape-pool-screen", version: "1.0.0", commit: "live-test" };
const bscAt = (url: string, b: bigint | "finalized") => RpcView.open(url, "BSC", BSC_CHAIN_ID, b);
const xlAt = (b: bigint | "latest") => RpcView.open(XL, "X Layer", XLAYER_CHAIN_ID, b);

describe.skipIf(!LIVE)("screen against BSC (live, read-only)", () => {
  it(
    "rigs #16 and #3 PASS with 256 Corr() each at the fixture block, and verify reproduces the artifacts",
    async () => {
      const bsc = await bscAt(process.env.BSC_RPC!, B);
      const xlayer = await xlAt("latest");
      const dir = mkdtempSync(join(tmpdir(), "screen-live-"));
      for (const id of [16n, 3n]) {
        const r = await runChecks({ mode: "A", bsc, xlayer, rigId: id, vectors: vectorFile, vectorSource: SRC });
        expect(r.reasons).toEqual([]);
        expect((r.body.results as Record<string, string>).v2).toBe("256 Corr()");
        const { path } = writeArtifact(dir, buildArtifact(r, TOOL));
        const v = await verifyFile(path, { openBsc: (b) => bscAt(process.env.BSC_RPC!, b), openXlayer: xlAt, tool: TOOL, outDir: dir }, false);
        expect(v.messages.join(" ")).toMatch(/reproduced/);
        expect(v.ok).toBe(true);
      }
    },
    10 * 60_000,
  );

  it(
    "revocation #12's miner, one block before it was revoked, FAILs in V1 and in V2 (the simulation succeeds)",
    async () => {
      const r12 = fixtures.revoked.find((r) => r.block === 124_688_916)!;
      const bsc = await bscAt(process.env.BSC_RPC!, 124_688_915n);
      const r = await runChecks({ mode: "A", bsc, xlayer: null, rigId: null, minerKey: r12.key, vectors: vectorFile, vectorSource: SRC });
      expect(r.verdict).toBe("FAIL");
      const all = r.reasons.join(" | ");
      expect(all).toMatch(/V1: the rig's output differs at official vector/);
      expect(all).toMatch(/V2: challenge of official vector \d+ gave success/);
    },
    10 * 60_000,
  );

  it(
    "a gas-starved challenge reverts with empty data and never succeeds; with gas it reverts Corr()",
    async () => {
      const bsc = await bscAt(process.env.BSC_RPC!, B);
      const r16 = fixtures.rigs["16"]!;
      const tv = vectorFile["4"]!;
      const data = encodeFunctionData({ abi: podAbi, functionName: "challenge", args: [r16.key, 0, tv.vectors[0]!.input, tv.vectors[0]!.out, proof(levels(tv.vectors), 0)] });
      for (const gas of [60_000n, 70_000n, 79_000n]) expect(await bsc.call(ADDR.podMining, data, gas)).toEqual({ ok: false, data: "0x" });
      expect(await bsc.call(ADDR.podMining, data)).toEqual({ ok: false, data: ERR.Corr });
    },
    5 * 60_000,
  );

  it(
    "verify --now on a local fork whose processor beacon slot was overwritten reports the change",
    async () => {
      const port = 8791;
      const url = `http://127.0.0.1:${port}`;
      const anvil = spawn(process.platform === "win32" ? "anvil.exe" : "anvil", ["--fork-url", process.env.BSC_RPC!, "--fork-block-number", B.toString(), "--port", String(port), "--slots-in-an-epoch", "1", "--silent"], { stdio: "ignore" });
      try {
        await waitFor(url);
        const rpc = (method: string, params: unknown[]) =>
          fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
        const dir = mkdtempSync(join(tmpdir(), "screen-fork-"));
        const bsc = await bscAt(url, B);
        const xlayer = await xlAt("latest");
        const r = await runChecks({ mode: "A", bsc, xlayer, rigId: 16n, vectors: vectorFile, vectorSource: SRC });
        expect(r.verdict).toBe("PASS");
        const { path } = writeArtifact(dir, buildArtifact(r, TOOL));
        await rpc("anvil_mine", ["0x3"]);
        await rpc("anvil_setStorageAt", [PROCESSORS.TapeOut, SLOT.beacon, `0x${"0".repeat(24)}${"00".repeat(19)}bd`]);
        await rpc("anvil_mine", ["0x3"]);
        const v = await verifyFile(path, { openBsc: (b) => bscAt(url, b), openXlayer: xlAt, tool: TOOL, outDir: dir }, true);
        expect(v.messages.join(" ")).toMatch(/reproduced/);
        expect(v.ok).toBe(false);
        expect(v.messages.join(" ")).toMatch(/unreviewed beacon/);
      } finally {
        stop(anvil);
      }
    },
    10 * 60_000,
  );
});

async function waitFor(url: string) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("anvil did not start");
}

function stop(p: ChildProcess) {
  p.kill();
}
