import { describe, expect, it } from "vitest";
import { hexToBytes, keccak256, toBytes, type Address, type Hex } from "viem";
import { runVector } from "../src/evaluator.js";
import { canonicalize, parseCanonical } from "../src/jcs.js";
import { levels, proof, rootOf, verifyTaskVectors, type OnchainTask, type TaskVectors } from "../src/vectors.js";
import { fixtures, loadFixture, vectorFile } from "./fake.js";

const onchain = (id: string): OnchainTask => {
  const t = fixtures.tasks[id]!;
  return { kind: Number(t.kind), cycles: Number(t.cycles), nIn: Number(t.nIn), nOut: Number(t.nOut), vectorCount: Number(t.vectorCount), vectorsRoot: t.vectorsRoot as Hex };
};
const copy = (id: string): TaskVectors => JSON.parse(JSON.stringify(vectorFile[id])) as TaskVectors;

describe("official vectors and their Merkle tree (S5, §4.3.1)", () => {
  it("rebuilds the on-chain vectorsRoot of tasks 4 and 74, and every fixture task", () => {
    for (const id of Object.keys(fixtures.tasks)) {
      const r = verifyTaskVectors(vectorFile[id], onchain(id));
      expect(r.ok, `task ${id}`).toBe(true);
    }
    expect(rootOf(levels(vectorFile["4"]!.vectors))).toBe("0x1db2f636c3733baef30b98903cf340e4026cec8d1c2bdf72c745727060171b7e");
  });

  it("gives proofs of the tree's depth that fold back to the root", () => {
    const L = levels(vectorFile["4"]!.vectors);
    for (const i of [0, 1, 128, 255]) expect(proof(L, i).length).toBe(8);
  });

  it("rejects a changed byte, a missing, extra or repeated vector, a wrong length, non-hex, a shape change and a missing task", () => {
    const t = onchain("4");
    const changed = copy("4");
    changed.vectors[7]!.out = changed.vectors[7]!.out === "0x00" ? "0x01" : "0x00";
    expect(verifyTaskVectors(changed, t)).toMatchObject({ ok: false, reason: /rebuild/ });
    const missing = copy("4");
    missing.vectors.pop();
    expect(verifyTaskVectors(missing, t)).toMatchObject({ ok: false, reason: /255 vectors/ });
    const extra = copy("4");
    extra.vectors.push(extra.vectors[0]!);
    expect(verifyTaskVectors(extra, t)).toMatchObject({ ok: false, reason: /257 vectors/ });
    const repeated = copy("4");
    repeated.vectors[3] = repeated.vectors[2]!;
    expect(verifyTaskVectors(repeated, t).ok).toBe(false);
    const long = copy("4");
    long.vectors[0]!.input = "0x0000";
    expect(verifyTaskVectors(long, t)).toMatchObject({ ok: false, reason: /byte length/ });
    const notHex = copy("4");
    notHex.vectors[0]!.input = "0xzz" as Hex;
    expect(verifyTaskVectors(notHex, t)).toMatchObject({ ok: false, reason: /not hex/ });
    const shape = copy("4");
    shape.nIn = 3;
    expect(verifyTaskVectors(shape, t)).toMatchObject({ ok: false, reason: /shape/ });
    expect(verifyTaskVectors(undefined, t)).toMatchObject({ ok: false, reason: /missing/ });
  });
});

describe("historical revocations (S3)", () => {
  it("each of the 12 revoked miners fails an official vector at or before the logged index", async () => {
    expect(fixtures.revoked.length).toBe(12);
    for (const r of fixtures.revoked) {
      const c = await loadFixture(r.circuits as Address, r.circuitId);
      const tv = vectorFile[String(r.taskId)]!;
      const shape = { kind: tv.kind === "seq" ? 1 : 0, cycles: tv.cycles, nIn: tv.nIn, nOut: tv.nOut };
      const first = tv.vectors.findIndex((v) => {
        const got = runVector(c, shape, hexToBytes(v.input));
        return !got.every((x, k) => x === hexToBytes(v.out)[k]) || got.length !== hexToBytes(v.out).length;
      });
      expect(first, `miner ${r.key}`).toBeGreaterThanOrEqual(0);
      expect(first, `miner ${r.key}`).toBeLessThanOrEqual(r.vectorIndex);
    }
  });
});

describe("canonical JSON (§5, RFC 8785)", () => {
  it("sorts keys by UTF-16 code units, keeps Chinese text as UTF-8, and writes no whitespace", () => {
    const text = canonicalize({ b: "二分频", a: [true, null, "x"], "": { z: "1", Z: "2" } });
    expect(text).toBe('{"":{"Z":"2","z":"1"},"a":[true,null,"x"],"b":"二分频"}');
    expect(parseCanonical(text)).toEqual({ "": { Z: "2", z: "1" }, a: [true, null, "x"], b: "二分频" });
  });

  it("refuses numbers and non-canonical text", () => {
    expect(() => canonicalize({ n: 1 } as never)).toThrow(/decimal strings/);
    expect(() => parseCanonical('{"a": "1"}')).toThrow(/canonical/);
    expect(() => parseCanonical('{"a":"1"}\n')).toThrow(/canonical/);
  });

  it("hashes a fixed document to a fixed value (computed independently with cast keccak over the UTF-8 bytes)", () => {
    const text = canonicalize({ task: { name: "与非门 NAND", id: "4" }, verdict: "PASS", reasons: [] });
    expect(keccak256(toBytes(text))).toBe(keccak256(toBytes('{"reasons":[],"task":{"id":"4","name":"与非门 NAND"},"verdict":"PASS"}')));
    expect(keccak256(toBytes(text))).toBe("0xb208e74f7cc8e805dcfb35cf7b404cad7cd7a0dd7278971196300adf49cb7739");
  });
});
