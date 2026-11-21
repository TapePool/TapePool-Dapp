// TAP-02 netlist decoding with the well-formedness rules of SPEC-PHASE3-SCREEN §4.2.1. A REF target is
// loaded through `fetch`, so the same code reads the chain or test fixtures.
import { getAddress, hexToBytes, keccak256, type Address, type Hex } from "viem";

export interface CircuitInfo {
  nIn: number;
  nOut: number;
  nState: number;
  gateCount: number;
}

export type Element =
  | { op: 0; a: number; b: number }
  | { op: 1; d: number; stateAt: number }
  | { op: 2; target: Circuit; ins: number[]; stateAt: number };

export interface Circuit {
  cpu: Address;
  id: bigint;
  info: CircuitInfo;
  netlistHash: Hex;
  elements: Element[];
  nSignals: number;
  /** Deepest REF nesting below this circuit (0 when it has no REF). */
  height: number;
}

export class NetlistError extends Error {}

export type Fetch = (cpu: Address, id: bigint) => Promise<{ netlist: Hex; info: CircuitInfo }>;

export interface LoadOptions {
  allowed: ReadonlySet<string>; // lowercase processor addresses a REF may target
  maxRefLevels: number;
}

const key = (cpu: Address, id: bigint) => `${cpu.toLowerCase()}:${id}`;

/** Load `(cpu, id)` and every REF below it; throws NetlistError on any rule broken. */
export async function loadCircuit(cpu: Address, id: bigint, fetch: Fetch, opt: LoadOptions, cache = new Map<string, Circuit>()): Promise<Circuit> {
  const c = await load(cpu, id, fetch, opt, cache, new Set());
  if (c.height > opt.maxRefLevels) throw new NetlistError(`REF nesting ${c.height} above ${opt.maxRefLevels}`);
  return c;
}

async function load(cpu: Address, id: bigint, fetch: Fetch, opt: LoadOptions, cache: Map<string, Circuit>, visiting: Set<string>): Promise<Circuit> {
  const k = key(cpu, id);
  const hit = cache.get(k);
  if (hit) return hit;
  if (visiting.has(k)) throw new NetlistError(`REF cycle at ${k}`);
  if (visiting.size > opt.maxRefLevels) throw new NetlistError(`REF nesting above ${opt.maxRefLevels}`);
  visiting.add(k);
  const { netlist, info } = await fetch(cpu, id);
  const b = hexToBytes(netlist);
  const u24 = (i: number) => (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
  const need = (i: number, n: number) => {
    if (i + n > b.length) throw new NetlistError(`truncated record at byte ${i - 1} of ${k}`);
  };
  const elements: Element[] = [];
  const latchDs: number[] = [];
  let i = 0;
  let sig = 2 + info.nIn;
  let state = 0;
  let height = 0;
  while (i < b.length) {
    const op = b[i++];
    if (op === 0) {
      need(i, 6);
      const a = u24(i);
      const bb = u24(i + 3);
      if (a >= sig || bb >= sig) throw new NetlistError(`NAND: future signal in ${k}`);
      elements.push({ op: 0, a, b: bb });
      i += 6;
      sig++;
    } else if (op === 1) {
      need(i, 3);
      const d = u24(i);
      elements.push({ op: 1, d, stateAt: state++ });
      latchDs.push(d);
      i += 3;
      sig++;
    } else if (op === 2) {
      need(i, 30);
      const target = getAddress(`0x${Buffer.from(b.subarray(i, i + 20)).toString("hex")}`);
      let tid = 0n;
      for (let j = 0; j < 8; j++) tid = (tid << 8n) | BigInt(b[i + 20 + j]!);
      const nIns = b[i + 28]!;
      const nOuts = b[i + 29]!;
      i += 30;
      need(i, 3 * nIns);
      const ins: number[] = [];
      for (let j = 0; j < nIns; j++) {
        const s = u24(i + 3 * j);
        if (s >= sig) throw new NetlistError(`REF: future signal in ${k}`);
        ins.push(s);
      }
      i += 3 * nIns;
      if (!opt.allowed.has(target.toLowerCase())) throw new NetlistError(`REF target ${target} is not an allowed processor`);
      const sub = await load(target, tid, fetch, opt, cache, visiting);
      if (sub.info.nIn !== nIns || sub.info.nOut !== nOuts) throw new NetlistError(`REF: pin mismatch to ${key(target, tid)}`);
      elements.push({ op: 2, target: sub, ins, stateAt: state });
      state += sub.info.nState;
      sig += nOuts;
      height = Math.max(height, sub.height + 1);
    } else {
      throw new NetlistError(`bad opcode ${op} at byte ${i - 1} of ${k}`);
    }
  }
  for (const d of latchDs) if (d >= sig) throw new NetlistError(`LATCH d out of range in ${k}`);
  if (info.nOut < 1) throw new NetlistError(`no outputs in ${k}`);
  if (sig - 2 - info.nIn < info.nOut) throw new NetlistError(`too few signals for outputs in ${k}`);
  if (state !== info.nState) throw new NetlistError(`state bits ${state} differ from circuitInfo ${info.nState} in ${k}`);
  visiting.delete(k);
  const c: Circuit = { cpu: getAddress(cpu), id, info, netlistHash: keccak256(netlist), elements, nSignals: sig, height };
  cache.set(k, c);
  return c;
}

/** Every circuit reachable from `root` through REFs, root first, each once. */
export function closure(root: Circuit): Circuit[] {
  const seen = new Map<string, Circuit>();
  const walk = (c: Circuit) => {
    const k = key(c.cpu, c.id);
    if (seen.has(k)) return;
    seen.set(k, c);
    for (const e of c.elements) if (e.op === 2) walk(e.target);
  };
  walk(root);
  return [...seen.values()];
}
