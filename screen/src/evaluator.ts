// TAP-02 one-beat evaluation and the PodMining vector semantics (SPEC-PHASE3-SCREEN S6, §4.2.3).
// Bits are stored one per byte (0 or 1); packed bytes are least-significant bit first.
import type { Circuit } from "./netlist.js";

export interface TaskShape {
  kind: number; // 0 combinational, 1 sequential
  cycles: number;
  nIn: number;
  nOut: number;
}

export const beats = (t: TaskShape) => (t.kind === 1 ? t.cycles : 1);
export const inBytes = (t: TaskShape) => Math.ceil(t.nIn / 8);
export const outBytes = (t: TaskShape) => Math.ceil(t.nOut / 8);

export function unpackBits(bytes: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) out[k] = ((bytes[k >> 3] ?? 0) >> (k & 7)) & 1;
  return out;
}

export function packBits(bits: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let k = 0; k < bits.length; k++) if (bits[k]) out[k >> 3]! |= 1 << (k & 7);
  return out;
}

/** One beat of `c` from `state` (bits) with `inputs` (bits). */
export function step(c: Circuit, state: Uint8Array, inputs: Uint8Array): { state: Uint8Array; outputs: Uint8Array } {
  const s = new Uint8Array(c.nSignals);
  s[1] = 1;
  for (let k = 0; k < c.info.nIn; k++) s[2 + k] = inputs[k] ? 1 : 0;
  const next = new Uint8Array(c.info.nState);
  let i = 2 + c.info.nIn;
  for (const e of c.elements) {
    if (e.op === 0) {
      s[i++] = s[e.a]! & s[e.b]! ? 0 : 1;
    } else if (e.op === 1) {
      s[i++] = state[e.stateAt] ? 1 : 0;
    } else {
      const sub = step(
        e.target,
        state.subarray(e.stateAt, e.stateAt + e.target.info.nState),
        Uint8Array.from(e.ins, (p) => s[p]!),
      );
      next.set(sub.state, e.stateAt);
      for (let p = 0; p < e.target.info.nOut; p++) s[i++] = sub.outputs[p]!;
    }
  }
  for (const e of c.elements) if (e.op === 1) next[e.stateAt] = s[e.d]!;
  return { state: next, outputs: s.slice(c.nSignals - c.info.nOut) };
}

/** One beat as packed bytes, the way the chain's `step` returns it. */
export function stepPacked(c: Circuit, state: Uint8Array, input: Uint8Array): { state: Uint8Array; outputs: Uint8Array } {
  const r = step(c, unpackBits(state, c.info.nState), unpackBits(input, c.info.nIn));
  return { state: packBits(r.state), outputs: packBits(r.outputs) };
}

/** Run one vector input from the all-zero state; returns every beat's packed outputs, concatenated. */
export function runVector(c: Circuit, t: TaskShape, input: Uint8Array): Uint8Array {
  const n = beats(t);
  const ib = inBytes(t);
  let state: Uint8Array = new Uint8Array(c.info.nState);
  const out: number[] = [];
  for (let w = 0; w < n; w++) {
    const r = step(c, state, unpackBits(input.subarray(w * ib, (w + 1) * ib), t.nIn));
    state = r.state;
    out.push(...packBits(r.outputs));
  }
  return Uint8Array.from(out);
}

export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, k) => x === b[k]);

/** The `x`-th input string of the exhaustive enumeration (§4.4.2): bit `w·nIn + k` is beat w's input k. */
export function enumeratedInput(t: TaskShape, x: number): Uint8Array {
  const n = beats(t);
  const ib = inBytes(t);
  const out = new Uint8Array(ib * n);
  for (let w = 0; w < n; w++) {
    for (let k = 0; k < t.nIn; k++) {
      if (Math.floor(x / 2 ** (w * t.nIn + k)) % 2 === 1) out[w * ib + (k >> 3)]! |= 1 << (k & 7);
    }
  }
  return out;
}
