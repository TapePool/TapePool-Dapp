import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, encodeFunctionResult, encodePacked, keccak256, toHex, type Address, type Hex } from "viem";
import { cpuAbi, podAbi } from "../src/abi.js";
import { buildArtifact, readArtifact, writeArtifact } from "../src/artifact.js";
import { batchViaMulticall, type ChainView } from "../src/chain.js";
import { classifyChallenge, runChecks, type Mode } from "../src/checks.js";
import { ADDR, ERR, PROCESSORS, VECTORS_URL } from "../src/constants.js";
import { runVector } from "../src/evaluator.js";
import { loadCircuit, type CircuitInfo } from "../src/netlist.js";
import { levels, proof, rootOf, type VectorFile } from "../src/vectors.js";
import { verifyFile } from "../src/verify.js";
import { FakeChain, allowed, defaultConfig, fakeXlayer, fixtures, vectorFile, type FakeConfig } from "./fake.js";

const SRC = { url: VECTORS_URL, sha256: `0x${"ab".repeat(32)}` as Hex };
const TOOL = { name: "tape-pool-screen", version: "1.0.0", commit: "test" };
const TAPEOUT = PROCESSORS.TapeOut.toLowerCase();
const REFBENCH = PROCESSORS.RefBench.toLowerCase();

function run(cfg: FakeConfig, rigId = 16n, mode: Mode = "A", vectors: VectorFile = vectorFile) {
  return runChecks({ mode, bsc: new FakeChain(cfg), xlayer: fakeXlayer(cfg), rigId, vectors, vectorSource: SRC });
}

const u24 = (n: number) => n.toString(16).padStart(6, "0");
const nand = (a: number, b: number) => `00${u24(a)}${u24(b)}`;
const info = (nIn: number, nOut: number, nState = 0): CircuitInfo => ({ nIn, nOut, nState, gateCount: 1 });
/** AND of inputs a and b: NAND then NOT, as the last signal. */
const and2 = (a: number, b: number, next: number) => nand(a, b) + nand(next, next);

/** Put `netlist` in place of rig 16's circuit. */
function replaceRig16(cfg: FakeConfig, netlist: string, i: CircuitInfo) {
  const r = fixtures.rigs["16"]!;
  cfg.circuits[`${r.circuits.toLowerCase()}:${r.circuitId}`] = { netlist: `0x${netlist}`, info: i };
}

/**
 * A synthetic task `id` whose reference is `refNl` and whose official vectors are the reference's
 * outputs on `inputs` only; rig 99 runs `rigNl` on it.
 */
async function synthetic(cfg: FakeConfig, vectors: VectorFile, id: number, nIn: number, refNl: string, rigNl: string, inputs: number[]) {
  const ib = Math.ceil(nIn / 8);
  cfg.circuits[`${REFBENCH}:${id}`] = { netlist: `0x${refNl}`, info: info(nIn, 1) };
  cfg.circuits[`${TAPEOUT}:${id}`] = { netlist: `0x${rigNl}`, info: info(nIn, 1) };
  const ref = await loadCircuit(PROCESSORS.RefBench, BigInt(id), async (c, i) => cfg.circuits[`${c.toLowerCase()}:${i}`]!, { allowed, maxRefLevels: 16 });
  const shape = { kind: 0, cycles: 1, nIn, nOut: 1 };
  const vs = inputs.map((x) => {
    const input = new Uint8Array(ib);
    for (let k = 0; k < nIn; k++) if ((x >> k) & 1) input[k >> 3]! |= 1 << (k & 7);
    return { input: toHex(input), out: toHex(runVector(ref, shape, input)) };
  });
  const root = rootOf(levels(vs));
  vectors[String(id)] = { kind: "comb", cycles: 1, nIn, nOut: 1, root, vectors: vs };
  cfg.tasks[String(id)] = { kind: 0, cycles: 1, nIn, nOut: 1, vectorCount: vs.length, active: true, vectorsRoot: root, name: `synthetic ${id}`, refArea: 1n, refCost: 1n, refCircuits: PROCESSORS.RefBench, refCircuitId: BigInt(id) };
  const key = keccak256(encodePacked(["address", "uint256"], [PROCESSORS.TapeOut, BigInt(id)]));
  cfg.miners[key] = { circuits: PROCESSORS.TapeOut, circuitId: BigInt(id), taskId: id, gateCount: 2, stateCount: 0, since: 1n, status: 1, bstar: 1, bonus: 0, verifWeight: 1, unverWeight: 0 };
  cfg.vault["99"] = [PROCESSORS.TapeOut, BigInt(id)];
  cfg.voucher["99"] = [PROCESSORS.TapeOut, BigInt(id)];
}

describe("screen checks on the offline chain", () => {
  it("passes rigs #16 (task 4) and #3 (sequential task 74) with 256 Corr() each", async () => {
    for (const id of [16n, 3n]) {
      const r = await run(defaultConfig(), id);
      expect(r.reasons).toEqual([]);
      expect(r.verdict).toBe("PASS");
      const results = r.body.results as Record<string, unknown>;
      expect(results.v1).toBe("256/256");
      expect(results.v2).toBe("256 Corr()");
      expect(results.referenceV1).toBe("256/256");
      expect((results.equivalence as Record<string, string>).result).toBe("equivalent");
    }
  });

  it("fails on identity problems: no voucher, voucher vs vault, wrong key, inactive miner, miner vs vault", async () => {
    const cases: [(c: FakeConfig) => void, RegExp][] = [
      [(c) => delete c.voucher["16"], /no voucher/],
      [(c) => (c.voucher["16"] = [PROCESSORS.TapeOut, 1n]), /voucher and vault disagree/],
      [(c) => (c.override = (fn) => (fn === "minerKey" ? { ok: true, data: `0x${"11".repeat(32)}` } : null)), /minerKey differs/],
      [(c) => (c.miners[fixtures.rigs["16"]!.key.toLowerCase()]!.status = 3), /miner status 3/],
      [(c) => (c.miners[fixtures.rigs["16"]!.key.toLowerCase()]!.circuitId = 5n), /miner record differs/],
    ];
    for (const [mutate, why] of cases) {
      const cfg = defaultConfig();
      mutate(cfg);
      const r = await run(cfg);
      expect(r.verdict).toBe("FAIL");
      expect(r.reasons.join(" ")).toMatch(why);
    }
  });

  it("refuses to judge when PodMining, its module or the evaluator differ from the reviewed constants", async () => {
    const cases: [(c: FakeConfig) => void, RegExp][] = [
      [(c) => (c.podImpl = "0x0000000000000000000000000000000000000bad"), /implementation differs/],
      [(c) => (c.sealed = false), /not sealed/],
      [(c) => (c.owner = "0x0000000000000000000000000000000000000001"), /not sealed/],
      [(c) => (c.tasksFrozen = false), /not sealed/],
      [(c) => (c.paused = true), /paused/],
      [(c) => (c.moduleCodeHash = `0x${"00".repeat(32)}`), /module code differs/],
      [(c) => (c.beacon = "0x0000000000000000000000000000000000000bad"), /unreviewed beacon/],
      [(c) => (c.beaconImpl = "0x0000000000000000000000000000000000000bad"), /evaluator differs/],
    ];
    for (const [mutate, why] of cases) {
      const cfg = defaultConfig();
      mutate(cfg);
      const r = await run(cfg);
      expect(r.verdict, String(why)).toBe("FAIL");
      expect(r.reasons.join(" ")).toMatch(why);
    }
  });

  it("fails on task and vector problems: inactive task, unknown kind, task missing from the file, wrong root", async () => {
    const inactive = defaultConfig();
    inactive.tasks["4"]!.active = false;
    expect((await run(inactive)).reasons.join(" ")).toMatch(/not active/);
    const kind = defaultConfig();
    kind.tasks["4"]!.kind = 2;
    expect((await run(kind)).reasons.join(" ")).toMatch(/unknown task kind/);
    const noTask: VectorFile = { ...vectorFile };
    delete noTask["4"];
    expect((await run(defaultConfig(), 16n, "A", noTask)).reasons.join(" ")).toMatch(/missing from the vector file/);
    const root = defaultConfig();
    root.tasks["4"]!.vectorsRoot = `0x${"12".repeat(32)}`;
    expect((await run(root)).reasons.join(" ")).toMatch(/rebuild/);
  });

  it("fails when the rig's pins differ from the task or a combinational rig has state", async () => {
    const pins = defaultConfig();
    replaceRig16(pins, nand(2, 3), info(3, 1));
    expect((await run(pins)).reasons.join(" ")).toMatch(/pins differ/);
    const state = defaultConfig();
    replaceRig16(state, `01${u24(5)}${nand(2, 3)}`, info(2, 1, 1));
    expect((await run(state)).reasons.join(" ")).toMatch(/combinational task but the rig has state/);
  });

  it("a wrong circuit fails V1 and V2 (the simulated challenge succeeds), and differs from the reference", async () => {
    const cfg = defaultConfig();
    replaceRig16(cfg, and2(2, 3, 4), info(2, 1)); // AND where the task wants NAND
    const r = await run(cfg);
    expect(r.verdict).toBe("FAIL");
    const all = r.reasons.join(" | ");
    expect(all).toMatch(/V1: the rig's output differs at official vector 0/);
    expect(all).toMatch(/V2: challenge of official vector 0 gave success/);
    expect(all).toMatch(/differs from the task reference/);
  });

  it("fails when the chain's evaluator disagrees with the local one", async () => {
    const cfg = defaultConfig();
    cfg.override = (fn, args) => (fn === "eval" && args[0] === 17663n ? { ok: true, data: encodeEvalResult("0x07") } : null);
    expect((await run(cfg)).reasons.join(" ")).toMatch(/cross-check: .* on the rig/);
  });

  it("only an exact Corr() revert passes V2", async () => {
    for (const [data, ok, why] of [
      [ERR.Prf, false, /Prf\(\)/],
      [ERR.Nomn, false, /Nomn\(\)/],
      ["0x", false, /empty revert/],
      ["0x12345678", false, /revert 0x12345678/],
      [`${ERR.Corr}00`, false, /revert 0xe915f0ea/],
    ] as const) {
      const cfg = defaultConfig();
      cfg.override = (fn, args) => (fn === "challenge" && args[1] === 9 ? { ok, data: data as Hex } : null);
      const r = await run(cfg);
      expect(r.reasons.join(" ")).toMatch(/V2: challenge of official vector 9/);
      expect(r.reasons.join(" ")).toMatch(why);
    }
    expect(classifyChallenge({ ok: false, data: ERR.Corr }).pass).toBe(true);
    expect(classifyChallenge({ ok: false, data: "0xE915F0EA" }).pass).toBe(true);
    expect(classifyChallenge({ ok: true, data: "0x" })).toEqual({ pass: false, what: "success (the miner would be revoked)" });
  });

  it("fails when the task reference fails its own vectors", async () => {
    const cfg = defaultConfig();
    cfg.circuits[`${REFBENCH}:4`] = { netlist: `0x${and2(2, 3, 4)}`, info: info(2, 1) };
    expect((await run(cfg)).reasons.join(" ")).toMatch(/task reference fails its own vector/);
  });

  it("option A also needs reference equivalence and passesCounterexamples; option B records them only", async () => {
    const vectors: VectorFile = { ...vectorFile };
    const cfg = defaultConfig();
    // reference: AND of in0, in1, in2 (as NOT(NAND(AND(in0,in1), in2))); rig: AND of in0, in1 only.
    // The official vectors only hold inputs 0 and 7, where both agree.
    const and3 = nand(2, 3) + nand(5, 5) + nand(6, 4) + nand(7, 7);
    await synthetic(cfg, vectors, 9001, 3, and3, and2(2, 3, 5), [0, 7]);
    const a = await run(cfg, 99n, "A", vectors);
    expect(a.reasons.join(" ")).toMatch(/differs from the task reference at input 0x03/);
    const b = await run(cfg, 99n, "B", vectors);
    expect(b.verdict).toBe("PASS");
    expect(((b.body.results as Record<string, unknown>).equivalence as Record<string, string>).result).toBe("differs at 0x03");
    cfg.passesCE = false;
    expect((await run(cfg, 99n, "B", vectors)).verdict).toBe("PASS");
    const ce = defaultConfig();
    ce.passesCE = false;
    expect((await run(ce)).reasons.join(" ")).toMatch(/registered counterexample/);
  });

  it("a rig wider than 20 bits is not eligible under option A, and passes under option B", async () => {
    const vectors: VectorFile = { ...vectorFile };
    const cfg = defaultConfig();
    await synthetic(cfg, vectors, 9002, 21, and2(2, 22, 23), and2(2, 22, 23), [0, 1, 2 ** 20, 2 ** 21 - 1]);
    expect((await run(cfg, 99n, "A", vectors)).reasons.join(" ")).toMatch(/too wide: 21 input bits/);
    expect((await run(cfg, 99n, "B", vectors)).verdict).toBe("PASS");
  });

  it("a rig that REFs a circuit on another allowed processor passes, and fails if that processor is behind another beacon", async () => {
    const BEHEMOTH = PROCESSORS.Behemoth.toLowerCase();
    const refTo = `02${BEHEMOTH.slice(2)}${(7001).toString(16).padStart(16, "0")}0201${u24(2)}${u24(3)}`;
    const ok = defaultConfig();
    ok.circuits[`${BEHEMOTH}:7001`] = { netlist: `0x${nand(2, 3)}`, info: info(2, 1) };
    replaceRig16(ok, refTo, info(2, 1));
    const r = await run(ok);
    expect(r.reasons).toEqual([]);
    const roles = (r.body.circuits as { role: string; processor: string }[]).map((c) => `${c.role}@${c.processor}`);
    expect(roles).toContain(`rig-ref-target@${BEHEMOTH}`);
    expect((r.body.processors as { address: string }[]).map((p) => p.address)).toContain(BEHEMOTH);
    const other = defaultConfig();
    other.circuits[`${BEHEMOTH}:7001`] = { netlist: `0x${nand(2, 3)}`, info: info(2, 1) };
    replaceRig16(other, refTo, info(2, 1));
    other.beaconOf = { [BEHEMOTH]: "0x0000000000000000000000000000000000000bad" };
    expect((await run(other)).reasons.join(" ")).toMatch(/0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C is behind an unreviewed beacon/i);
  });

  it("a sequential rig whose chain step disagrees at a later beat fails the cross-check", async () => {
    const cfg = defaultConfig();
    const rig3 = BigInt(fixtures.rigs["3"]!.circuitId);
    cfg.override = (fn, args) =>
      fn === "step" && args[0] === rig3 && args[1] !== "0x"
        ? { ok: true, data: encodeFunctionResult({ abi: cpuAbi, functionName: "step", result: ["0x00", "0x01"] }) }
        : null;
    const r = await run(cfg, 3n);
    expect(r.reasons.join(" ")).toMatch(/cross-check: .* on the rig \(step on vector 0 beat 1\)/);
  });

  it("an RPC failure is a FAIL, never a skipped check", async () => {
    const cfg = defaultConfig();
    cfg.failOn = "getTask";
    const r = await run(cfg);
    expect(r.verdict).toBe("FAIL");
    expect(r.reasons[0]).toMatch(/^rpc: fake transport failure on getTask/);
  });

  it("the Multicall3 path classifies a challenge exactly like the direct call", async () => {
    const chain = new FakeChain(defaultConfig());
    const r16 = fixtures.rigs["16"]!;
    const tv = vectorFile["4"]!;
    const L = levels(tv.vectors);
    const call = (i: number, out: Hex) => ({ to: ADDR.podMining as Address, data: encodeFunctionData({ abi: podAbi, functionName: "challenge", args: [r16.key, i, tv.vectors[i]!.input, out, proof(L, i)] }) });
    const calls = [call(0, tv.vectors[0]!.out), call(1, tv.vectors[1]!.out === "0x00" ? "0x01" : "0x00")];
    const direct = await Promise.all(calls.map((c) => chain.call(c.to, c.data)));
    const viaMulticall = await batchViaMulticall(chain as ChainView, calls);
    expect(viaMulticall).toEqual(direct);
    expect(direct.map((d) => classifyChallenge(d).what)).toEqual(["Corr()", "Prf() (bad proof)"]);
  });
});

describe("artifacts and verify", () => {
  const deps = (cfg: FakeConfig, nowCfg = cfg) => ({
    openBsc: async (b: bigint | "finalized") => (b === "finalized" ? new FakeChain(nowCfg, 56, 1_001n) : new FakeChain(cfg, 56, b)),
    openXlayer: async (b: bigint | "latest") => (b === "latest" ? fakeXlayer(nowCfg) : new FakeChain(cfg, 196, b)),
    tool: TOOL,
    outDir: mkdtempSync(join(tmpdir(), "screen-now-")),
  });

  it("writes a canonical artifact that verify reproduces byte for byte, and rejects one changed byte", async () => {
    const cfg = defaultConfig();
    const art = buildArtifact(await run(cfg), TOOL);
    const dir = mkdtempSync(join(tmpdir(), "screen-"));
    const { path, hash } = writeArtifact(dir, art);
    expect(path).toContain(`rig-16-${hash.slice(2, 10)}.json`);
    const raw = readFileSync(path);
    expect(raw.at(-1)).not.toBe(0x0a); // no trailing newline
    expect(readArtifact(path).hash).toBe(hash);
    expect(readFileSync(join(dir, "INDEX.md"), "utf8")).toContain(hash);

    const ok = await verifyFile(path, deps(cfg), false);
    expect(ok.messages.join(" ")).toMatch(/reproduced/);
    expect(ok.ok).toBe(true);

    const tampered = Buffer.from(raw);
    const at = tampered.indexOf(Buffer.from('"256 Corr()"'));
    tampered[at + 1] = "3".charCodeAt(0);
    writeFileSync(path, tampered);
    const bad = await verifyFile(path, deps(cfg), false);
    expect(bad.ok).toBe(false);
    expect(bad.messages.join(" ")).toMatch(/file name does not carry its hash|does not reproduce/);
  });

  it("verify --now reports a changed evaluator and writes a re-verification artifact", async () => {
    const cfg = defaultConfig();
    const dir = mkdtempSync(join(tmpdir(), "screen-"));
    const { path } = writeArtifact(dir, buildArtifact(await run(cfg), TOOL));
    const unchanged = await verifyFile(path, deps(cfg), true);
    expect(unchanged.ok).toBe(true);
    expect(unchanged.messages.join(" ")).toMatch(/unchanged at BSC block 1001/);
    const upgraded = defaultConfig();
    upgraded.beaconImpl = "0x0000000000000000000000000000000000000bad";
    const changed = await verifyFile(path, deps(cfg, upgraded), true);
    expect(changed.ok).toBe(false);
    expect(changed.messages.join(" ")).toMatch(/evaluator differs/);
    expect(changed.messages.join(" ")).toMatch(/re-verification written to .*rig-16-reverify-1001-/);
  });
});

function encodeEvalResult(bytes: Hex): Hex {
  // ABI encoding of a single `bytes` return value
  const len = (bytes.length - 2) / 2;
  const body = bytes.slice(2).padEnd(64, "0");
  return `0x${"20".padStart(64, "0")}${len.toString(16).padStart(64, "0")}${body}`;
}
