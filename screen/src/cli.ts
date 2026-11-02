#!/usr/bin/env node
// `screen check <rigId…>` and `screen verify <artifact…>` (SPEC-PHASE3-SCREEN §3). Read-only: no key, no
// signing, no transaction. RPC URLs come from BSC_RPC and XLAYER_RPC and are never printed.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, getAddress, isAddress, type Address, type Hex } from "viem";
import { rigScreenAbi } from "./abi.js";
import { buildArtifact, writeArtifact, type ToolInfo } from "./artifact.js";
import { RpcView } from "./chain.js";
import { runChecks, type Mode } from "./checks.js";
import { BSC_CHAIN_ID, VECTORS_URL, XLAYER_CHAIN_ID } from "./constants.js";
import type { VectorFile } from "./vectors.js";
import { verifyFile } from "./verify.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const DEFAULT_OUT = join(PKG, "artifacts");
const DEFAULT_XLAYER = "https://rpc.xlayer.tech";

function toolInfo(): ToolInfo {
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { name: string; version: string };
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: PKG, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "src"], { cwd: PKG, encoding: "utf8" }).trim();
    if (dirty) commit += "-dirty";
  } catch {
    // not a git checkout: the artifact says so
  }
  return { name: pkg.name, version: pkg.version, commit };
}

/** Refuse to run a build older than its sources: the artifact names the commit of `src`, not of `dist`. */
function assertFreshBuild(): void {
  const src = join(PKG, "src");
  for (const f of readdirSync(src).filter((n) => n.endsWith(".ts"))) {
    let stale = true;
    try {
      stale = statSync(join(HERE, f.replace(/\.ts$/, ".js"))).mtimeMs < statSync(join(src, f)).mtimeMs;
    } catch {
      // no output for this source: stale
    }
    if (stale) throw new Error(`dist/ is older than src/${f}: run npm run build first`);
  }
}

interface Args {
  cmd: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function parse(argv: string[]): Args {
  const [cmd = "", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) positional.push(a);
    else if (a === "--now" || a === "--allow-mode-b") flags.set(a.slice(2), true);
    else flags.set(a.slice(2), rest[++i] ?? "");
  }
  return { cmd, positional, flags };
}

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

async function loadVectors(file: string | undefined): Promise<{ vectors: VectorFile; url: string; sha256: Hex }> {
  let bytes: Buffer;
  let url: string;
  if (file) {
    bytes = readFileSync(file);
    url = VECTORS_URL; // a local copy of the published file; the hash says which bytes were used
  } else {
    const res = await fetch(VECTORS_URL, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`vector file download failed: HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
    url = VECTORS_URL;
  }
  const sha256 = `0x${createHash("sha256").update(bytes).digest("hex")}` as Hex;
  // web content: parsed as data, then trusted only through each task's on-chain root (§4.3.1)
  const vectors = JSON.parse(bytes.toString("utf8")) as VectorFile;
  return { vectors, url, sha256 };
}

function printRecord(rigId: bigint, a: { [k: string]: unknown }, hash: Hex, screen: string | undefined) {
  const rig = a.rig as { circuits: string; circuitId: string };
  const task = a.task as { id: string };
  const target = screen && isAddress(screen) ? getAddress(screen) : "<RigScreen>";
  const args = [rigId, getAddress(rig.circuits) as Address, BigInt(rig.circuitId), Number(task.id), hash] as const;
  const calldata = encodeFunctionData({ abi: rigScreenAbi, functionName: "recordPass", args });
  console.log("  record it from the owner's browser wallet on X Layer (never --private-key or -i):");
  console.log(
    `    cast send ${target} "recordPass(uint256,address,uint64,uint32,bytes32)" ${rigId} ${args[1]} ${args[2]} ${args[3]} ${hash} --browser --rpc-url ${DEFAULT_XLAYER}`,
  );
  console.log(`  or send calldata ${calldata} to ${target} with value 0`);
  console.log(`  then check ScreenPassAdded(rigId ${rigId}, circuits ${args[1]}, circuitId ${args[2]}, taskId ${args[3]}, artifactHash ${hash}, effectiveAt = block time + 48 h)`);
}

async function check(a: Args): Promise<boolean> {
  const block = a.flags.get("block");
  const xblock = a.flags.get("xblock");
  const mode = (a.flags.get("mode") === "B" ? "B" : "A") as Mode;
  const out = typeof a.flags.get("out") === "string" ? String(a.flags.get("out")) : DEFAULT_OUT;
  const vectorsFlag = a.flags.get("vectors");
  if (a.positional.length === 0) throw new Error("usage: screen check <rigId…> [--block N] [--xblock N] [--vectors file] [--out dir] [--screen addr]");
  // the owner chose option A (C-O1): B needs an explicit opt-in and never prints a recordPass call
  if (mode === "B" && !a.flags.has("allow-mode-b")) throw new Error("--mode B needs --allow-mode-b (the owner's rule is option A)");
  assertFreshBuild();
  const bsc = await RpcView.open(env("BSC_RPC"), "BSC", BSC_CHAIN_ID, typeof block === "string" ? BigInt(block) : "finalized");
  const xlayer = await RpcView.open(process.env.XLAYER_RPC || DEFAULT_XLAYER, "X Layer", XLAYER_CHAIN_ID, typeof xblock === "string" ? BigInt(xblock) : "latest");
  const v = await loadVectors(typeof vectorsFlag === "string" ? vectorsFlag : undefined);
  const tool = toolInfo();
  console.log(`BSC block ${bsc.block}, X Layer block ${xlayer.block}, vectors sha256 ${v.sha256}, mode ${mode}, tool ${tool.commit}`);
  if (mode === "B") console.log("WARNING: option B artifacts are not what the owner records (option A is the rule)");
  let all = true;
  for (const p of a.positional) {
    const rigId = BigInt(p);
    const report = await runChecks({ mode, bsc, xlayer, rigId, vectors: v.vectors, vectorSource: { url: v.url, sha256: v.sha256 } });
    const art = buildArtifact(report, tool);
    const { path, hash } = writeArtifact(out, art);
    console.log(`rig ${rigId}: ${report.verdict}${report.reasons.length ? ` (${report.reasons.join("; ")})` : ""}`);
    console.log(`  artifact ${path}`);
    console.log(`  artifactHash ${hash}`);
    if (report.verdict === "PASS" && mode === "A" && !tool.commit.endsWith("-dirty")) printRecord(rigId, art, hash, a.flags.get("screen") as string | undefined);
    if (report.verdict !== "PASS") all = false;
  }
  return all;
}

async function verify(a: Args): Promise<boolean> {
  if (a.positional.length === 0) throw new Error("usage: screen verify <artifact…> [--now] [--out dir]");
  assertFreshBuild();
  const out = typeof a.flags.get("out") === "string" ? String(a.flags.get("out")) : DEFAULT_OUT;
  const bscUrl = env("BSC_RPC");
  const xlUrl = process.env.XLAYER_RPC || DEFAULT_XLAYER;
  const deps = {
    openBsc: (b: bigint | "finalized") => RpcView.open(bscUrl, "BSC", BSC_CHAIN_ID, b),
    openXlayer: (b: bigint | "latest") => RpcView.open(xlUrl, "X Layer", XLAYER_CHAIN_ID, b),
    tool: toolInfo(),
    outDir: out,
  };
  let all = true;
  for (const p of a.positional) {
    const r = await verifyFile(p, deps, a.flags.has("now"));
    console.log(`${p}: ${r.ok ? "VERIFIED" : "NOT VERIFIED"}`);
    for (const m of r.messages) console.log(`  ${m}`);
    if (!r.ok && r.messages.some((m) => m.includes("X Layer"))) {
      console.log("  hint: the X Layer RPC may not keep state that old; set XLAYER_RPC to an archive endpoint");
    }
    if (!r.ok) all = false;
  }
  return all;
}

async function main() {
  const a = parse(process.argv.slice(2));
  const ok = a.cmd === "check" ? await check(a) : a.cmd === "verify" ? await verify(a) : (console.log("usage: screen check <rigId…> | screen verify <artifact…> [--now]"), false);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
});
