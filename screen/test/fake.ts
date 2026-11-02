// An offline ChainView built from test/fixtures: PodMining, the processors, the beacon, the vault and
// the voucher answer from fixture data, and `challenge` follows the judged behaviour of S4/S10.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  concat,
  decodeFunctionData,
  encodeFunctionResult,
  encodePacked,
  hexToBytes,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { beaconAbi, cpuAbi, multicallAbi, podAbi, vaultAbi, voucherAbi } from "../src/abi.js";
import { RpcError, type CallResult, type ChainView } from "../src/chain.js";
import { ADDR, ERR, PROCESSORS, REVIEWED, SLOT } from "../src/constants.js";
import { runVector, stepPacked } from "../src/evaluator.js";
import { loadCircuit, type Circuit, type CircuitInfo } from "../src/netlist.js";
import { leaf, type VectorFile } from "../src/vectors.js";

const FIX = join(import.meta.dirname, "fixtures");
export interface Fixtures {
  block: string;
  circuits: Record<string, { netlist: Hex; info: CircuitInfo }>;
  tasks: Record<string, Record<string, string | number | boolean>>;
  rigs: Record<string, { circuits: Address; circuitId: string; key: Hex; miner: Record<string, string | number | boolean> }>;
  revoked: { key: Hex; taskId: number; circuits: Address; circuitId: string; vectorIndex: number; block: number; tx: Hex }[];
  nIn0Task: string;
}
export const fixtures = JSON.parse(readFileSync(join(FIX, "chain.json"), "utf8")) as Fixtures;
export const vectorFile = JSON.parse(readFileSync(join(FIX, "vectors.json"), "utf8")) as VectorFile;

export const allowed = new Set(Object.values(PROCESSORS).map((a) => a.toLowerCase()));
export const fixtureFetch = async (cpu: Address, id: bigint) => {
  const e = fixtures.circuits[`${cpu.toLowerCase()}:${id}`];
  if (!e) throw new Error(`no fixture circuit ${cpu}:${id}`);
  return e;
};
export const loadFixture = (cpu: Address, id: bigint | string, maxRefLevels = 16) =>
  loadCircuit(cpu, BigInt(id), fixtureFetch, { allowed, maxRefLevels });

const lc = (s: string) => s.toLowerCase();
const word = (a: Address): Hex => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;

export interface FakeConfig {
  podImpl: Address;
  sealed: boolean;
  owner: Address;
  tasksFrozen: boolean;
  paused: boolean;
  maxRunGas: bigint;
  maxRefLevels: bigint;
  moduleCodeHash: Hex;
  beacon: Address;
  /** Per-processor beacon, overriding `beacon` (lowercase processor address -> beacon). */
  beaconOf?: Record<string, Address>;
  beaconImpl: Address;
  passesCE: boolean;
  ceCount: bigint;
  tasks: Record<string, Record<string, unknown>>;
  miners: Record<string, Record<string, unknown>>; // key -> miner struct
  vault: Record<string, [Address, bigint]>;
  voucher: Record<string, [Address, bigint]>;
  circuits: Record<string, { netlist: Hex; info: CircuitInfo }>;
  /** Replace the chain's answer to one call (by function name); return null to keep the normal one. */
  override?: (fn: string, args: readonly unknown[], to: Address) => CallResult | null;
  /** Throw a transport error on this function name. */
  failOn?: string;
}

/** Default config: rigs 16 and 3 as on chain at the fixture block. */
export function defaultConfig(): FakeConfig {
  const miners: FakeConfig["miners"] = {};
  const vault: FakeConfig["vault"] = {};
  for (const [id, r] of Object.entries(fixtures.rigs)) {
    miners[lc(r.key)] = { ...r.miner, circuitId: BigInt(String(r.miner.circuitId)), since: BigInt(String(r.miner.since)) };
    vault[id] = [r.circuits, BigInt(r.circuitId)];
  }
  const tasks: FakeConfig["tasks"] = {};
  for (const [id, t] of Object.entries(fixtures.tasks)) tasks[id] = { ...t, refCircuitId: BigInt(String(t.refCircuitId)), refArea: BigInt(String(t.refArea)), refCost: BigInt(String(t.refCost)) };
  return {
    podImpl: REVIEWED.podMiningImpl,
    sealed: true,
    owner: "0x0000000000000000000000000000000000000000",
    tasksFrozen: true,
    paused: false,
    maxRunGas: 12_000_000n,
    maxRefLevels: 16n,
    moduleCodeHash: REVIEWED.moduleCodeHash,
    beacon: REVIEWED.circuitsBeacon,
    beaconImpl: REVIEWED.circuitsImpl,
    passesCE: true,
    ceCount: 0n,
    tasks,
    miners,
    vault,
    voucher: { ...vault },
    circuits: { ...fixtures.circuits },
  };
}

function fullMiner(m: Record<string, unknown>) {
  const z = { depth: 0, area: 0n, mult: 1, nandBurn: 0, latchBurn: 0, commitBlock: 0n, firstUnusedId: 0n, debt: 0n };
  const b = (k: string) => BigInt(String(m[k] ?? 0));
  return {
    ...z,
    circuits: m.circuits as Address,
    circuitId: b("circuitId"),
    taskId: Number(m.taskId),
    gateCount: Number(m.gateCount),
    stateCount: Number(m.stateCount ?? 0),
    since: b("since"),
    status: Number(m.status),
    registrant: (m.registrant as Address) ?? "0x0000000000000000000000000000000000000001",
    bstar: b("bstar"),
    bonus: b("bonus"),
    optimal: Boolean(m.optimal),
    stopBlock: b("stopBlock"),
    verifWeight: b("verifWeight"),
    unverWeight: b("unverWeight"),
  };
}

export class FakeChain implements ChainView {
  readonly blockHash: Hex;
  private loaded = new Map<string, Circuit>();

  constructor(
    readonly cfg: FakeConfig,
    readonly chainId = 56,
    readonly block = 1_000n,
  ) {
    this.blockHash = keccak256(toHex(`block ${chainId} ${block}`));
  }

  private async circuit(cpu: Address, id: bigint): Promise<Circuit> {
    const k = `${lc(cpu)}:${id}`;
    const hit = this.loaded.get(k);
    if (hit) return hit;
    const fetch = async (c: Address, i: bigint) => {
      const e = this.cfg.circuits[`${lc(c)}:${i}`];
      if (!e) throw new Error(`no circuit ${c}:${i}`);
      return e;
    };
    const c = await loadCircuit(cpu, id, fetch, { allowed, maxRefLevels: 64 });
    this.loaded.set(k, c);
    return c;
  }

  async storage(address: Address, slot: Hex): Promise<Hex> {
    if (lc(address) === lc(ADDR.podMining) && slot === SLOT.implementation) return word(this.cfg.podImpl);
    if (allowed.has(lc(address)) && slot === SLOT.beacon) return word(this.cfg.beaconOf?.[lc(address)] ?? this.cfg.beacon);
    return `0x${"0".repeat(64)}`;
  }

  async codeHash(address: Address): Promise<Hex> {
    if (lc(address) === lc(REVIEWED.module)) return this.cfg.moduleCodeHash;
    return keccak256("0x");
  }

  async batch(calls: { to: Address; data: Hex }[]): Promise<CallResult[]> {
    const out: CallResult[] = [];
    for (const c of calls) out.push(await this.call(c.to, c.data));
    return out;
  }

  async call(to: Address, data: Hex): Promise<CallResult> {
    const t = lc(to);
    const abi: Abi | null =
      t === lc(ADDR.podMining) ? podAbi
      : allowed.has(t) ? cpuAbi
      : t === lc(this.cfg.beacon) ? beaconAbi
      : t === lc(ADDR.rigVault) ? vaultAbi
      : t === lc(ADDR.voucher) ? voucherAbi
      : t === lc(ADDR.multicall3) ? multicallAbi
      : null;
    if (!abi) return { ok: false, data: "0x" };
    const { functionName: fn, args = [] } = decodeFunctionData({ abi, data });
    if (this.cfg.failOn === fn) throw new RpcError(`fake transport failure on ${fn}`);
    const o = this.cfg.override?.(fn, args, to);
    if (o) return o;
    const ok = (result: unknown): CallResult => ({ ok: true, data: encodeFunctionResult({ abi, functionName: fn, result } as never) });
    const revert = (d: Hex): CallResult => ({ ok: false, data: d });

    if (abi === multicallAbi) {
      const calls = args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
      const res: { success: boolean; returnData: Hex }[] = [];
      for (const c of calls) {
        const r = await this.call(c.target, c.callData);
        res.push({ success: r.ok, returnData: r.data });
      }
      return ok(res);
    }
    if (abi === beaconAbi) return ok(this.cfg.beaconImpl);
    if (abi === vaultAbi) {
      const r = this.cfg.vault[String(args[0])];
      return ok(r ?? ["0x0000000000000000000000000000000000000000", 0n]);
    }
    if (abi === voucherAbi) {
      const r = this.cfg.voucher[String(args[0])];
      return ok(r ? [r[0], 1n, r[1], 2n] : ["0x0000000000000000000000000000000000000000", 0n, 0n, 0n]);
    }
    if (abi === cpuAbi) {
      const id = args[0] as bigint;
      if (fn === "netlist") return ok(this.cfg.circuits[`${t}:${id}`]?.netlist ?? "0x");
      const info = this.cfg.circuits[`${t}:${id}`]?.info;
      if (fn === "circuitInfo") return info ? ok([info.nIn, info.nOut, info.nState, info.gateCount]) : revert("0x");
      const c = await this.circuit(to, id);
      if (fn === "eval") {
        const shape = { kind: 0, cycles: 1, nIn: c.info.nIn, nOut: c.info.nOut };
        return ok(toHex(runVector(c, shape, hexToBytes(args[1] as Hex))));
      }
      const r = stepPacked(c, hexToBytes(args[1] as Hex), hexToBytes(args[2] as Hex));
      return ok([toHex(r.state), toHex(r.outputs)]);
    }
    // PodMining
    switch (fn) {
      case "getTask": {
        const task = this.cfg.tasks[String(args[0])];
        return ok(task ?? { kind: 0, cycles: 0, nIn: 0, nOut: 0, vectorCount: 0, active: false, vectorsRoot: `0x${"0".repeat(64)}`, name: "", refArea: 0n, refCost: 0n, refCircuits: "0x0000000000000000000000000000000000000000", refCircuitId: 0n });
      }
      case "getMiner": {
        const m = this.cfg.miners[lc(args[0] as string)];
        return ok(fullMiner(m ?? { circuits: "0x0000000000000000000000000000000000000000", circuitId: 0, taskId: 0, gateCount: 0, status: 0 }));
      }
      case "minerKey":
        return ok(keccak256(encodePacked(["address", "uint256"], [args[0] as Address, args[1] as bigint])));
      case "isSealed":
        return ok(this.cfg.sealed);
      case "owner":
        return ok(this.cfg.owner);
      case "tasksFrozen":
        return ok(this.cfg.tasksFrozen);
      case "paused":
        return ok(this.cfg.paused);
      case "maxRunGas":
        return ok(this.cfg.maxRunGas);
      case "MAX_REF_LEVELS":
        return ok(this.cfg.maxRefLevels);
      case "ceCount":
        return ok(this.cfg.ceCount);
      case "passesCounterexamples":
        return ok(this.cfg.passesCE);
      case "challenge": {
        const [key, i, input, out, prf] = args as [Hex, number, Hex, Hex, Hex[]];
        const m = this.cfg.miners[lc(key)];
        if (!m || Number(m.status) !== 1) return revert(ERR.Nomn);
        const task = this.cfg.tasks[String(m.taskId)]!;
        let h = leaf(i, input, out);
        for (const p of prf) h = BigInt(h) < BigInt(p) ? keccak256(concat([h, p])) : keccak256(concat([p, h]));
        if (lc(h) !== lc(String(task.vectorsRoot))) return revert(ERR.Prf);
        const c = await this.circuit(m.circuits as Address, BigInt(String(m.circuitId)));
        const shape = { kind: Number(task.kind), cycles: Number(task.cycles), nIn: Number(task.nIn), nOut: Number(task.nOut) };
        const got = toHex(runVector(c, shape, hexToBytes(input)));
        return lc(got) === lc(out) ? revert(ERR.Corr) : { ok: true, data: "0x" };
      }
    }
    return revert("0x");
  }
}

/** The X Layer side: only the voucher answers. */
export const fakeXlayer = (cfg: FakeConfig) => new FakeChain(cfg, 196, 2_000n);
