// Official task vectors: shape checks and the Merkle tree PodMining's `challenge` verifies against
// (SPEC-PHASE3-SCREEN S5, S7, §4.3.1). The vector file is web content, trusted only through the root.
import { concat, encodeAbiParameters, hexToBytes, isHex, keccak256, type Hex } from "viem";
import { beats, inBytes, outBytes, type TaskShape } from "./evaluator.js";

export interface Vector {
  input: Hex;
  out: Hex;
}

/** One task's entry in the published file (extra keys such as `srcId` and `name` are ignored). */
export interface TaskVectors {
  kind: string; // "comb" or "seq"
  cycles: number;
  nIn: number;
  nOut: number;
  root: Hex;
  vectors: Vector[];
}

export type VectorFile = Record<string, TaskVectors>;

export interface OnchainTask extends TaskShape {
  vectorCount: number;
  vectorsRoot: Hex;
}

export function leaf(i: number, input: Hex, out: Hex): Hex {
  return keccak256(keccak256(encodeAbiParameters([{ type: "uint32" }, { type: "bytes" }, { type: "bytes" }], [i, input, out])));
}

const pair = (a: Hex, b: Hex): Hex => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

/** Every level of the tree, leaves first; a node without a sibling moves up unchanged. */
export function levels(vectors: Vector[]): Hex[][] {
  const out: Hex[][] = [vectors.map((v, i) => leaf(i, v.input, v.out))];
  while (out.at(-1)!.length > 1) {
    const n = out.at(-1)!;
    const up: Hex[] = [];
    for (let s = 0; s < n.length; s += 2) up.push(s + 1 < n.length ? pair(n[s]!, n[s + 1]!) : n[s]!);
    out.push(up);
  }
  return out;
}

export const rootOf = (L: Hex[][]): Hex => L.at(-1)![0]!;

export function proof(L: Hex[][], index: number): Hex[] {
  const p: Hex[] = [];
  let r = index;
  for (const level of L.slice(0, -1)) {
    if ((r ^ 1) < level.length) p.push(level[r ^ 1]!);
    r >>= 1;
  }
  return p;
}

/**
 * Check one task's vectors against the chain's task record. Returns the tree, or a reason when the
 * entry is missing, has the wrong shape, or does not rebuild to `vectorsRoot`.
 */
export function verifyTaskVectors(tv: TaskVectors | undefined, task: OnchainTask): { ok: true; levels: Hex[][] } | { ok: false; reason: string } {
  if (!tv || !Array.isArray(tv.vectors)) return { ok: false, reason: "task missing from the vector file" };
  const kind = tv.kind === "comb" ? 0 : tv.kind === "seq" ? 1 : -1;
  if (kind !== task.kind || tv.cycles !== task.cycles || tv.nIn !== task.nIn || tv.nOut !== task.nOut) {
    return { ok: false, reason: "vector file task shape differs from getTask" };
  }
  if (tv.vectors.length !== task.vectorCount) return { ok: false, reason: `vector file has ${tv.vectors.length} vectors, getTask ${task.vectorCount}` };
  const ilen = beats(task) * inBytes(task);
  const olen = beats(task) * outBytes(task);
  for (const [i, v] of tv.vectors.entries()) {
    if (!isHex(v?.input, { strict: true }) || !isHex(v?.out, { strict: true })) return { ok: false, reason: `vector ${i} is not hex` };
    if (hexToBytes(v.input).length !== ilen || hexToBytes(v.out).length !== olen) return { ok: false, reason: `vector ${i} has a wrong byte length` };
  }
  const L = levels(tv.vectors);
  if (rootOf(L).toLowerCase() !== task.vectorsRoot.toLowerCase()) return { ok: false, reason: "vectors do not rebuild to the on-chain vectorsRoot" };
  return { ok: true, levels: L };
}
