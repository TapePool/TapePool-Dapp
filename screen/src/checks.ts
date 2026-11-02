// The screen checks of SPEC-PHASE3-SCREEN §4, in order. Fail closed: any error, missing or unexpected
// value is a reason, and a rig gets PASS only with no reason at all.
import { encodeFunctionData, decodeFunctionResult, encodePacked, hexToBytes, keccak256, toHex, type Address, type Hex } from "viem";
import { beaconAbi, cpuAbi, podAbi, vaultAbi, voucherAbi } from "./abi.js";
import { RpcError, read, wordToAddress, type CallResult, type ChainView } from "./chain.js";
import { ADDR, ERR, MAX_EQUIV_BITS, MINER_ACTIVE, PROCESSORS, REVIEWED, SLOT, ZERO } from "./constants.js";
import { beats, enumeratedInput, runVector, sameBytes, stepPacked, type TaskShape } from "./evaluator.js";
import type { Json } from "./jcs.js";
import { NetlistError, closure, loadCircuit, type Circuit, type CircuitInfo } from "./netlist.js";
import { proof, verifyTaskVectors, type OnchainTask, type VectorFile } from "./vectors.js";

export type Mode = "A" | "B";

export interface CheckOptions {
  mode: Mode;
  bsc: ChainView;
  /** Null only on the test-only path below. */
  xlayer: ChainView | null;
  rigId: bigint | null;
  /** Test-only: judge this PodMining miner directly, skipping the bridged-rig identity (§7). */
  minerKey?: Hex;
  vectors: VectorFile;
  vectorSource: { url: string; sha256: Hex };
}

/** The artifact body without `schema` and `tool` (added by artifact.ts). */
export interface Report {
  verdict: "PASS" | "FAIL";
  reasons: string[];
  body: { [key: string]: Json };
}

const POD = ADDR.podMining;
const ALLOWED = new Set(Object.values(PROCESSORS).map((a) => a.toLowerCase()));
const lc = (x: string) => x.toLowerCase();
const same = (a: string, b: string) => lc(a) === lc(b);
const dec = (x: bigint | number) => x.toString();

class Stop extends Error {}

interface Miner {
  circuits: Address;
  circuitId: bigint;
  taskId: number;
  gateCount: number;
  stateCount: number;
  since: bigint;
  status: number;
  registrant: Address;
  bstar: bigint;
  bonus: bigint;
  optimal: boolean;
  stopBlock: bigint;
  verifWeight: bigint;
  unverWeight: bigint;
}

interface Task extends OnchainTask {
  active: boolean;
  name: string;
  refArea: bigint;
  refCost: bigint;
  refCircuits: Address;
  refCircuitId: bigint;
}

export async function runChecks(o: CheckOptions): Promise<Report> {
  const body: { [key: string]: Json } = { mode: o.mode };
  const reasons: string[] = [];
  const fail: (r: string) => never = (r) => {
    reasons.push(r);
    throw new Stop(r);
  };
  const view = (v: ChainView | null) => (v ? { chainId: dec(v.chainId), block: dec(v.block), blockHash: lc(v.blockHash) } : null);
  body.chains = { bsc: view(o.bsc), xlayer: view(o.xlayer) };

  try {
    // §4.1.1–4.1.3 identity
    const bsc = o.bsc;
    let circuits: Address;
    let circuitId: bigint;
    let key: Hex;
    if (o.rigId !== null) {
      if (!o.xlayer) fail("X Layer view missing");
      const [vc, , vid] = (await read(o.xlayer!, ADDR.voucher, voucherAbi, "rigs", [o.rigId])) as readonly [Address, bigint, bigint, bigint];
      if (same(vc, ZERO)) fail("no voucher for this rig on X Layer");
      const [bc, bid] = (await read(bsc, ADDR.rigVault, vaultAbi, "rigs", [o.rigId])) as readonly [Address, bigint];
      if (!same(bc, vc) || bid !== vid) fail("voucher and vault disagree on the rig's circuit");
      circuits = bc;
      circuitId = bid;
      key = keccak256(encodePacked(["address", "uint256"], [circuits, circuitId]));
      const chainKey = (await read(bsc, POD, podAbi, "minerKey", [circuits, circuitId])) as Hex;
      if (!same(chainKey, key)) fail("PodMining minerKey differs from the local key");
      if (!ALLOWED.has(lc(circuits))) fail("the rig's processor is not PoD-mineable");
    } else {
      if (!o.minerKey) fail("neither a rig id nor a miner key");
      key = o.minerKey!;
      circuits = ZERO;
      circuitId = 0n;
    }
    const miner = (await read(bsc, POD, podAbi, "getMiner", [key])) as Miner;
    body.rig = {
      id: o.rigId === null ? null : dec(o.rigId),
      key: lc(key),
      miner: {
        circuits: lc(miner.circuits),
        circuitId: dec(miner.circuitId),
        taskId: dec(miner.taskId),
        gateCount: dec(miner.gateCount),
        stateCount: dec(miner.stateCount),
        status: dec(miner.status),
        since: dec(miner.since),
        stopBlock: dec(miner.stopBlock),
        registrant: lc(miner.registrant),
        bstar: dec(miner.bstar),
        bonus: dec(miner.bonus),
        optimal: miner.optimal,
        verifWeight: dec(miner.verifWeight),
        unverWeight: dec(miner.unverWeight),
      },
    };
    if (miner.status !== MINER_ACTIVE) fail(`miner status ${miner.status}, not active`);
    if (o.rigId !== null) {
      if (!same(miner.circuits, circuits) || miner.circuitId !== circuitId) fail("PodMining's miner record differs from the vault");
    } else {
      circuits = miner.circuits;
      circuitId = miner.circuitId;
    }
    (body.rig as { [k: string]: Json }).circuits = lc(circuits);
    (body.rig as { [k: string]: Json }).circuitId = dec(circuitId);

    // §4.1.4 protocol state and reviewed constants
    const impl = wordToAddress(await bsc.storage(POD, SLOT.implementation));
    const [isSealed, owner, tasksFrozen, paused, maxRunGas, maxRefLevels] = [
      (await read(bsc, POD, podAbi, "isSealed")) as boolean,
      (await read(bsc, POD, podAbi, "owner")) as Address,
      (await read(bsc, POD, podAbi, "tasksFrozen")) as boolean,
      (await read(bsc, POD, podAbi, "paused")) as boolean,
      (await read(bsc, POD, podAbi, "maxRunGas")) as bigint,
      (await read(bsc, POD, podAbi, "MAX_REF_LEVELS")) as bigint,
    ];
    const moduleCodeHash = await bsc.codeHash(REVIEWED.module);
    body.protocol = {
      podMining: lc(POD),
      vault: lc(ADDR.rigVault),
      voucher: lc(ADDR.voucher),
      implementation: impl ? lc(impl) : null,
      isSealed,
      owner: lc(owner),
      tasksFrozen,
      paused,
      module: lc(REVIEWED.module),
      moduleCodeHash: lc(moduleCodeHash),
      maxRunGas: dec(maxRunGas),
      maxRefLevels: dec(maxRefLevels),
    };
    if (!impl || !same(impl, REVIEWED.podMiningImpl)) fail("PodMining implementation differs from the reviewed one");
    if (!isSealed || !same(owner, ZERO) || !tasksFrozen) fail("PodMining is not sealed with frozen tasks and no owner");
    if (paused) fail("PodMining is paused");
    if (!same(moduleCodeHash, REVIEWED.moduleCodeHash)) fail("PodMining module code differs from the reviewed one");
    if (maxRefLevels > 64n) fail("MAX_REF_LEVELS is implausibly large");

    const processors = new Map<string, { [k: string]: Json }>();
    const checkProcessor = async (cpu: Address) => {
      if (processors.has(lc(cpu))) return;
      if (!ALLOWED.has(lc(cpu))) fail(`processor ${cpu} is not PoD-mineable`);
      const beacon = wordToAddress(await bsc.storage(cpu, SLOT.beacon));
      const entry: { [k: string]: Json } = { address: lc(cpu), beacon: beacon ? lc(beacon) : null, beaconImplementation: null };
      processors.set(lc(cpu), entry);
      body.processors = [...processors.values()];
      // the beacon address is judged before anything is read from it
      if (!beacon || !same(beacon, REVIEWED.circuitsBeacon)) fail(`processor ${cpu} is behind an unreviewed beacon`);
      const beaconImpl = (await read(bsc, beacon!, beaconAbi, "implementation")) as Address;
      entry.beaconImplementation = lc(beaconImpl);
      body.processors = [...processors.values()];
      if (!same(beaconImpl, REVIEWED.circuitsImpl)) fail("the circuits evaluator differs from the reviewed implementation");
    };
    await checkProcessor(circuits);

    // §4.1.5 task
    const task = (await read(bsc, POD, podAbi, "getTask", [miner.taskId])) as Task;
    const tv = o.vectors[String(miner.taskId)];
    body.task = {
      id: dec(miner.taskId),
      kind: dec(task.kind),
      cycles: dec(task.cycles),
      nIn: dec(task.nIn),
      nOut: dec(task.nOut),
      vectorCount: dec(task.vectorCount),
      active: task.active,
      vectorsRoot: lc(task.vectorsRoot),
      name: task.name,
      refArea: dec(task.refArea),
      refCost: dec(task.refCost),
      refCircuits: lc(task.refCircuits),
      refCircuitId: dec(task.refCircuitId),
      vectors: tv?.vectors ? tv.vectors.map((v) => ({ input: lc(v.input), out: lc(v.out) })) : null,
      vectorSource: { url: o.vectorSource.url, sha256: lc(o.vectorSource.sha256) },
    };
    if (!task.active) fail("task is not active");
    if (task.kind !== 0 && task.kind !== 1) fail(`unknown task kind ${task.kind}`);
    if (task.cycles < 1 || task.nOut < 1 || task.vectorCount < 1) fail("task has no cycles, outputs or vectors");

    // §4.3.1 vectors
    const checked = verifyTaskVectors(tv, task);
    if (!checked.ok) fail(checked.reason);
    const L = (checked as { levels: Hex[][] }).levels;
    const vectors = tv!.vectors.map((v) => ({ input: hexToBytes(v.input), out: hexToBytes(v.out), inputHex: v.input, outHex: v.out }));

    // §4.2 circuits
    const fetchCircuit = async (cpu: Address, id: bigint) => {
      await checkProcessor(cpu);
      const netlist = (await read(bsc, cpu, cpuAbi, "netlist", [id])) as Hex;
      const [nIn, nOut, nState, gateCount] = (await read(bsc, cpu, cpuAbi, "circuitInfo", [id])) as readonly [number, number, number, number];
      const info: CircuitInfo = { nIn, nOut, nState, gateCount };
      return { netlist, info };
    };
    const opt = { allowed: ALLOWED, maxRefLevels: Number(maxRefLevels) };
    const cache = new Map<string, Circuit>();
    let rig: Circuit;
    let ref: Circuit;
    try {
      rig = await loadCircuit(circuits, circuitId, fetchCircuit, opt, cache);
      ref = await loadCircuit(task.refCircuits, task.refCircuitId, fetchCircuit, opt, cache);
    } catch (e) {
      if (e instanceof NetlistError) fail(`netlist: ${e.message}`);
      throw e;
    }
    const describe = (role: string, c: Circuit): Json => ({
      role,
      processor: lc(c.cpu),
      id: dec(c.id),
      nIn: dec(c.info.nIn),
      nOut: dec(c.info.nOut),
      nState: dec(c.info.nState),
      gateCount: dec(c.info.gateCount),
      netlistHash: lc(c.netlistHash),
    });
    body.circuits = [
      ...closure(rig!).map((c, i) => describe(i === 0 ? "rig" : "rig-ref-target", c)),
      ...closure(ref!).map((c, i) => describe(i === 0 ? "reference" : "reference-ref-target", c)),
    ];
    if (rig!.info.nIn !== task.nIn || rig!.info.nOut !== task.nOut) fail("rig pins differ from the task");
    if (task.kind === 0 && rig!.info.nState !== 0) fail("combinational task but the rig has state");

    // §4.3.2 V1, §4.2.4 cross-check, §4.3.3 V2: independent judgments, all recorded
    const results: { [k: string]: Json } = {};
    body.results = results;
    const v1 = firstMismatch(rig!, task, vectors);
    results.v1 = v1 === null ? `${vectors.length}/${vectors.length}` : `mismatch at vector ${v1}`;
    if (v1 !== null) reasons.push(`V1: the rig's output differs at official vector ${v1}`);

    const xr = await crossCheck(bsc, rig!, task, vectors);
    results.crossCheckRig = xr.ok ? `${xr.calls} calls agree` : `mismatch: ${xr.detail}`;
    if (!xr.ok) reasons.push(`cross-check: the chain's evaluator disagrees with the local one on the rig (${xr.detail})`);

    const v2 = await challengeAll(bsc, key, vectors, L);
    results.v2 = v2.ok ? `${v2.corr} Corr()` : `vector ${v2.index}: ${v2.what}`;
    if (!v2.ok) reasons.push(`V2: challenge of official vector ${v2.index} gave ${v2.what}, not Corr()`);

    // §4.4.1 reference consistency (decides under both modes)
    const xref = await crossCheck(bsc, ref!, task, vectors);
    results.crossCheckReference = xref.ok ? `${xref.calls} calls agree` : `mismatch: ${xref.detail}`;
    if (!xref.ok) reasons.push(`cross-check: the chain's evaluator disagrees with the local one on the reference (${xref.detail})`);
    const rv1 = firstMismatch(ref!, task, vectors);
    results.referenceV1 = rv1 === null ? `${vectors.length}/${vectors.length}` : `mismatch at vector ${rv1}`;
    if (rv1 !== null) reasons.push(`the task reference fails its own vector ${rv1}`);

    // §4.4.2 equivalence and §4.4.3 counterexamples (decide under option A only)
    const w = task.nIn * beats(task);
    if (w > MAX_EQUIV_BITS) {
      results.equivalence = { w: dec(w), inputs: "0", result: "not run: too wide" };
      if (o.mode === "A") reasons.push(`too wide: ${w} input bits over the ${MAX_EQUIV_BITS}-bit equivalence limit`);
    } else {
      const diff = firstDifference(rig!, ref!, task, w);
      results.equivalence = { w: dec(w), inputs: dec(2 ** w), result: diff === null ? "equivalent" : `differs at ${diff}` };
      if (diff !== null && o.mode === "A") reasons.push(`the rig differs from the task reference at input ${diff}`);
    }
    const passes = (await read(bsc, POD, podAbi, "passesCounterexamples", [circuits, circuitId, miner.taskId, miner.gateCount, maxRunGas])) as boolean;
    const ceCount = (await read(bsc, POD, podAbi, "ceCount", [miner.taskId, circuits])) as bigint;
    results.passesCounterexamples = passes;
    results.ceCount = dec(ceCount);
    if (!passes && o.mode === "A") reasons.push("the rig fails a registered counterexample");
  } catch (e) {
    if (!(e instanceof Stop)) reasons.push(e instanceof RpcError ? `rpc: ${e.message}` : `error: ${e instanceof Error ? e.message : String(e)}`);
  }
  body.verdict = reasons.length === 0 ? "PASS" : "FAIL";
  body.reasons = reasons;
  return { verdict: reasons.length === 0 ? "PASS" : "FAIL", reasons, body };
}

interface Vec {
  input: Uint8Array;
  out: Uint8Array;
  inputHex: Hex;
  outHex: Hex;
}

/** Index of the first official vector the circuit gets wrong, or null (V1). */
function firstMismatch(c: Circuit, t: TaskShape, vectors: Vec[]): number | null {
  for (const [i, v] of vectors.entries()) if (!sameBytes(runVector(c, t, v.input), v.out)) return i;
  return null;
}

/** First enumerated input on which `a` and `b` differ, as hex, or null (§4.4.2). */
function firstDifference(a: Circuit, b: Circuit, t: TaskShape, w: number): string | null {
  for (let x = 0; x < 2 ** w; x++) {
    const input = enumeratedInput(t, x);
    if (!sameBytes(runVector(a, t, input), runVector(b, t, input))) return toHex(input);
  }
  return null;
}

/**
 * §4.2.4: the processor's own `eval` (combinational) or `step` chain (sequential, empty first state,
 * then the returned state) must agree with the local evaluator on every official vector.
 */
async function crossCheck(bsc: ChainView, c: Circuit, t: TaskShape, vectors: Vec[]): Promise<{ ok: boolean; calls: number; detail: string }> {
  let calls = 0;
  if (t.kind === 0) {
    const res = await bsc.batch(vectors.map((v) => ({ to: c.cpu, data: encodeFunctionData({ abi: cpuAbi, functionName: "eval", args: [c.id, v.inputHex] }) })));
    calls += res.length;
    for (const [i, r] of res.entries()) {
      if (!r.ok) return { ok: false, calls, detail: `eval reverted on vector ${i}` };
      const got = hexToBytes(decodeFunctionResult({ abi: cpuAbi, functionName: "eval", data: r.data }));
      if (!sameBytes(got, runVector(c, t, vectors[i]!.input))) return { ok: false, calls, detail: `eval output on vector ${i}` };
    }
    return { ok: true, calls, detail: "" };
  }
  const ib = Math.ceil(t.nIn / 8);
  const chainState: Hex[] = vectors.map(() => "0x");
  const localState: Uint8Array[] = vectors.map(() => new Uint8Array(Math.ceil(c.info.nState / 8)));
  for (let w = 0; w < beats(t); w++) {
    const inputs = vectors.map((v) => v.input.subarray(w * ib, (w + 1) * ib));
    const res = await bsc.batch(
      vectors.map((_, i) => ({ to: c.cpu, data: encodeFunctionData({ abi: cpuAbi, functionName: "step", args: [c.id, chainState[i]!, toHex(inputs[i]!)] }) })),
    );
    calls += res.length;
    for (const [i, r] of res.entries()) {
      if (!r.ok) return { ok: false, calls, detail: `step reverted on vector ${i} beat ${w}` };
      const [newState, outputs] = decodeFunctionResult({ abi: cpuAbi, functionName: "step", data: r.data });
      const local = stepPacked(c, localState[i]!, inputs[i]!);
      if (!sameBytes(hexToBytes(newState), local.state) || !sameBytes(hexToBytes(outputs), local.outputs)) {
        return { ok: false, calls, detail: `step on vector ${i} beat ${w}` };
      }
      chainState[i] = newState;
      localState[i] = local.state;
    }
  }
  return { ok: true, calls, detail: "" };
}

/** Name a `challenge` outcome (§4.3.3): only a revert with exactly `Corr()` is a pass. */
export function classifyChallenge(r: CallResult): { pass: boolean; what: string } {
  if (r.ok) return { pass: false, what: "success (the miner would be revoked)" };
  const d = lc(r.data);
  if (d === ERR.Corr) return { pass: true, what: "Corr()" };
  if (d === ERR.Prf) return { pass: false, what: "Prf() (bad proof)" };
  if (d === ERR.Nomn) return { pass: false, what: "Nomn() (not mining)" };
  if (d === "0x") return { pass: false, what: "an empty revert" };
  return { pass: false, what: `revert ${d.slice(0, 10)}` };
}

/** V2: simulate `challenge` for every official vector; every one must revert `Corr()`. */
async function challengeAll(bsc: ChainView, key: Hex, vectors: Vec[], L: Hex[][]): Promise<{ ok: true; corr: number } | { ok: false; index: number; what: string }> {
  const res = await bsc.batch(
    vectors.map((v, i) => ({
      to: POD,
      data: encodeFunctionData({ abi: podAbi, functionName: "challenge", args: [key, i, v.inputHex, v.outHex, proof(L, i)] }),
    })),
  );
  if (res.length !== vectors.length) return { ok: false, index: -1, what: "a wrong number of results" };
  for (const [i, r] of res.entries()) {
    const c = classifyChallenge(r);
    if (!c.pass) return { ok: false, index: i, what: c.what };
  }
  return { ok: true, corr: res.length };
}
