// Builds the offline test fixtures (read-only): the circuits, task records and miners the unit tests
// use, read from BSC at one pinned block, plus the matching subset of the official vector file.
// Usage (from screen/): npx tsc -p tsconfig.scripts.json && node dist-scripts/scripts/fixtures.js <vector file> [block]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { cpuAbi, podAbi } from "../src/abi.js";
import { RpcView, read } from "../src/chain.js";
import { ADDR, BSC_CHAIN_ID, PROCESSORS } from "../src/constants.js";
import { closure, loadCircuit, type CircuitInfo } from "../src/netlist.js";
import type { VectorFile } from "../src/vectors.js";

const OUT = join(process.cwd(), "test", "fixtures");
const RIGS = [16, 3];
/** The 12 revocations in research/data/pod-events.json (key, task, logged vector index). */
const REVOKED = JSON.parse(readFileSync(join(process.cwd(), "..", "research", "data", "pod-events.json"), "utf8")) as {
  ev: string;
  key: Hex;
  vectorIndex?: number;
  block: number;
  tx: Hex;
  circuits?: Address;
  circuitId?: number;
  taskId?: number;
}[];

async function main() {
  const [vectorFile, block] = process.argv.slice(2);
  if (!vectorFile) throw new Error("usage: fixtures <vector file> [block]");
  const url = process.env.BSC_RPC;
  if (!url) throw new Error("BSC_RPC is not set");
  const bsc = await RpcView.open(url, "BSC", BSC_CHAIN_ID, block ? BigInt(block) : "finalized");
  const all = JSON.parse(readFileSync(vectorFile, "utf8")) as VectorFile;
  const starts = new Map(REVOKED.filter((e) => e.ev === "Started").map((e) => [e.key, e]));
  const revoked = REVOKED.filter((e) => e.ev === "Revoked").map((e) => {
    const s = starts.get(e.key)!;
    return { key: e.key, taskId: s.taskId!, circuits: s.circuits!, circuitId: String(s.circuitId!), vectorIndex: e.vectorIndex!, block: e.block, tx: e.tx };
  });
  const nIn0 = Object.entries(all).find(([, t]) => t.nIn === 0)![0];

  const circuits: Record<string, { netlist: Hex; info: CircuitInfo }> = {};
  const fetch = async (cpu: Address, id: bigint) => {
    const netlist = (await read(bsc, cpu, cpuAbi, "netlist", [id])) as Hex;
    const [nIn, nOut, nState, gateCount] = (await read(bsc, cpu, cpuAbi, "circuitInfo", [id])) as readonly [number, number, number, number];
    const entry = { netlist, info: { nIn, nOut, nState, gateCount } };
    circuits[`${cpu.toLowerCase()}:${id}`] = entry;
    return entry;
  };
  const opt = { allowed: new Set(Object.values(PROCESSORS).map((a) => a.toLowerCase())), maxRefLevels: 16 };

  const tasks: Record<string, unknown> = {};
  const taskIds = new Set<number>([4, 74, Number(nIn0), ...revoked.map((r) => r.taskId)]);
  for (const id of taskIds) {
    const t = (await read(bsc, ADDR.podMining, podAbi, "getTask", [id])) as Record<string, unknown>;
    tasks[id] = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
    const ref = await loadCircuit(t.refCircuits as Address, t.refCircuitId as bigint, fetch, opt);
    closure(ref);
  }
  for (const r of revoked) await loadCircuit(r.circuits, BigInt(r.circuitId), fetch, opt);

  const rigs: Record<string, unknown> = {};
  for (const id of RIGS) {
    const snap = JSON.parse(readFileSync(join(process.cwd(), "..", "research", "data", "snapshot-latest.json"), "utf8")) as {
      rigs: { id: number; circuits: Address; circuitId: number; key: Hex; taskId: number }[];
    };
    const s = snap.rigs.find((x) => x.id === id)!;
    const miner = (await read(bsc, ADDR.podMining, podAbi, "getMiner", [s.key])) as Record<string, unknown>;
    rigs[id] = {
      circuits: s.circuits,
      circuitId: String(s.circuitId),
      key: s.key,
      miner: Object.fromEntries(Object.entries(miner).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
    };
    await loadCircuit(s.circuits, BigInt(s.circuitId), fetch, opt);
  }

  const vectors: VectorFile = {};
  for (const id of taskIds) {
    const t = all[String(id)]!;
    vectors[String(id)] = { kind: t.kind, cycles: t.cycles, nIn: t.nIn, nOut: t.nOut, root: t.root, vectors: t.vectors };
  }
  writeFileSync(join(OUT, "chain.json"), `${JSON.stringify({ block: bsc.block.toString(), blockHash: bsc.blockHash, circuits, tasks, rigs, revoked, nIn0Task: nIn0 }, null, 1)}\n`);
  writeFileSync(join(OUT, "vectors.json"), `${JSON.stringify(vectors)}\n`);
  console.log(`fixtures at BSC block ${bsc.block}: ${Object.keys(circuits).length} circuits, ${taskIds.size} tasks, ${revoked.length} revoked miners`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
