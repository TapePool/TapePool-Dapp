import { describe, expect, it } from "vitest";
import { hexToBytes, keccak256, type Address, type Hex } from "viem";
import { PROCESSORS } from "../src/constants.js";
import { enumeratedInput, packBits, runVector, unpackBits } from "../src/evaluator.js";
import { NetlistError, loadCircuit, type CircuitInfo } from "../src/netlist.js";
import { allowed, fixtures, loadFixture, vectorFile } from "./fake.js";

const CPU = PROCESSORS.TapeOut;
const u24 = (n: number) => n.toString(16).padStart(6, "0");
const nand = (a: number, b: number) => `00${u24(a)}${u24(b)}`;
const latch = (d: number) => `01${u24(d)}`;
const ref = (cpu: Address, id: number, ins: number[], nOuts: number) =>
  `02${cpu.slice(2).toLowerCase()}${id.toString(16).padStart(16, "0")}${ins.length.toString(16).padStart(2, "0")}${nOuts.toString(16).padStart(2, "0")}${ins.map(u24).join("")}`;

/** Load crafted circuits from a map of id -> [records, info]. */
function crafted(map: Record<number, [string, CircuitInfo]>, maxRefLevels = 16) {
  const fetch = async (_cpu: Address, id: bigint) => {
    const e = map[Number(id)];
    if (!e) throw new Error(`no crafted circuit ${id}`);
    return { netlist: `0x${e[0]}` as Hex, info: e[1] };
  };
  return (id: number) => loadCircuit(CPU, BigInt(id), fetch, { allowed, maxRefLevels });
}

const XOR = nand(2, 3) + nand(2, 4) + nand(3, 4) + nand(5, 6); // X Layer circuit #1
const info = (nIn: number, nOut: number, nState = 0, gateCount = 0): CircuitInfo => ({ nIn, nOut, nState, gateCount });
const comb = (nIn: number, nOut: number) => ({ kind: 0, cycles: 1, nIn, nOut });

describe("TAP-02 evaluator", () => {
  it("evaluates the 4-NAND XOR like the chain (eval 0x00..0x03 -> 0,1,1,0)", async () => {
    const c = await crafted({ 1: [XOR, info(2, 1)] })(1);
    expect([0, 1, 2, 3].map((x) => runVector(c, comb(2, 1), Uint8Array.of(x))[0])).toEqual([0, 1, 1, 0]);
  });

  it("runs a 1-LATCH divider over 8 beats from the zero state (task 74's 01 00 01 00 …)", async () => {
    const c = await crafted({ 2: [latch(4) + nand(3, 3), info(1, 1, 1)] })(2);
    const out = runVector(c, { kind: 1, cycles: 8, nIn: 1, nOut: 1 }, new Uint8Array(8));
    expect([...out]).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);
    expect(vectorFile["74"]!.vectors[0]!.out).toBe("0x0100010001000100");
  });

  it("runs a REF sub-circuit on its own pins (XNOR = NOT XOR)", async () => {
    const load = crafted({ 1: [XOR, info(2, 1)], 3: [ref(CPU, 1, [2, 3], 1) + nand(4, 4), info(2, 1)] });
    const c = await load(3);
    expect([0, 1, 2, 3].map((x) => runVector(c, comb(2, 1), Uint8Array.of(x))[0])).toEqual([1, 0, 0, 1]);
    expect(c.height).toBe(1);
  });

  it("packs bits least-significant first and enumerates beats in order", () => {
    expect([...packBits(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 1))]).toEqual([1, 1]);
    expect([...unpackBits(Uint8Array.of(0b101), 3)]).toEqual([1, 0, 1]);
    // nIn 3, 2 beats: bit w*3+k is beat w's input k
    expect([...enumeratedInput({ kind: 1, cycles: 2, nIn: 3, nOut: 1 }, 0b100_011)]).toEqual([0b011, 0b100]);
  });

  it("matches the official vectors for rig #16 (task 4) and rig #3 (task 74), and a nIn = 0 reference", async () => {
    for (const [rig, task] of [["16", "4"], ["3", "74"]] as const) {
      const r = fixtures.rigs[rig]!;
      const c = await loadFixture(r.circuits, r.circuitId);
      const t = vectorFile[task]!;
      const shape = { kind: t.kind === "seq" ? 1 : 0, cycles: t.cycles, nIn: t.nIn, nOut: t.nOut };
      for (const v of t.vectors) expect(runVector(c, shape, hexToBytes(v.input))).toEqual(hexToBytes(v.out));
    }
    const t0 = fixtures.tasks[fixtures.nIn0Task]!;
    const c0 = await loadFixture(t0.refCircuits as Address, String(t0.refCircuitId));
    const tv = vectorFile[fixtures.nIn0Task]!;
    expect(tv.nIn).toBe(0);
    const shape = { kind: tv.kind === "seq" ? 1 : 0, cycles: tv.cycles, nIn: 0, nOut: tv.nOut };
    for (const v of tv.vectors) expect(runVector(c0, shape, hexToBytes(v.input))).toEqual(hexToBytes(v.out));
  });

  it("fixture netlists hash to what the chain returned (pinned from the live screen run at block 128,890,993)", () => {
    const at = (cpu: string, id: string) => keccak256(fixtures.circuits[`${cpu.toLowerCase()}:${id}`]!.netlist);
    const rig16 = fixtures.rigs["16"]!;
    const rig3 = fixtures.rigs["3"]!;
    expect(fixtures.block).toBe("128890993");
    expect(at(rig16.circuits, rig16.circuitId)).toBe("0x9bd41f32891fd718692b9769803db8caffabc217f66a6f682f34c6215db9c172");
    expect(at(rig3.circuits, rig3.circuitId)).toBe("0x93d4a151c0d0b02bfb2cc7cf659bd1c0517e59defb18ab029bbfaba8e4ae4347");
    // both rigs carry exactly their task's reference netlist
    expect(at(String(fixtures.tasks["4"]!.refCircuits), "4")).toBe(at(rig16.circuits, rig16.circuitId));
    expect(at(String(fixtures.tasks["74"]!.refCircuits), "74")).toBe(at(rig3.circuits, rig3.circuitId));
  });
});

describe("TAP-02 well-formedness (§4.2.1)", () => {
  const bad = async (map: Record<number, [string, CircuitInfo]>, id: number, msg: RegExp, maxRefLevels = 16) => {
    await expect(crafted(map, maxRefLevels)(id)).rejects.toThrow(NetlistError);
    await expect(crafted(map, maxRefLevels)(id)).rejects.toThrow(msg);
  };

  it("rejects an unknown opcode and a truncated record", async () => {
    await bad({ 1: ["03", info(1, 1)] }, 1, /bad opcode 3/);
    await bad({ 1: ["00000002", info(1, 1)] }, 1, /truncated/);
  });

  it("rejects NAND and REF inputs that are not earlier signals", async () => {
    await bad({ 1: [nand(2, 4), info(2, 1)] }, 1, /NAND: future signal/);
    await bad({ 1: [XOR, info(2, 1)], 2: [ref(CPU, 1, [2, 5], 1), info(2, 1)] }, 2, /REF: future signal/);
  });

  it("rejects a LATCH whose d is past the last signal", async () => {
    await bad({ 1: [latch(10) + nand(3, 3), info(1, 1, 1)] }, 1, /LATCH d out of range/);
  });

  it("rejects a REF outside the allowlist, with wrong pins, too deep, or in a cycle", async () => {
    await bad({ 2: [ref("0x0000000000000000000000000000000000000001", 1, [2, 3], 1), info(2, 1)] }, 2, /not an allowed processor/);
    await bad({ 1: [XOR, info(2, 1)], 2: [ref(CPU, 1, [2, 2, 3], 1), info(2, 1)] }, 2, /pin mismatch/);
    const chain = { 1: [XOR, info(2, 1)], 2: [ref(CPU, 1, [2, 3], 1), info(2, 1)], 3: [ref(CPU, 2, [2, 3], 1), info(2, 1)], 4: [ref(CPU, 3, [2, 3], 1), info(2, 1)] } as Record<number, [string, CircuitInfo]>;
    await expect(crafted(chain, 3)(4)).resolves.toBeTruthy();
    await bad(chain, 4, /REF nesting/, 2);
    await bad({ 5: [ref(CPU, 6, [2, 3], 1), info(2, 1)], 6: [ref(CPU, 5, [2, 3], 1), info(2, 1)] }, 5, /REF cycle/);
  });

  it("rejects too few signals for the outputs, no outputs, and a state count that differs from circuitInfo", async () => {
    await bad({ 1: [nand(2, 3), info(2, 3)] }, 1, /too few signals/);
    await bad({ 1: [nand(2, 3), info(2, 0)] }, 1, /no outputs/);
    await bad({ 1: [XOR, info(2, 1, 1)] }, 1, /state bits 0 differ/);
  });
});
