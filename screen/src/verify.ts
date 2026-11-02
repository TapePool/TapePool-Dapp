// `screen verify` (SPEC-PHASE3-SCREEN §3, §6): reproduce an artifact byte for byte at its own pinned
// blocks, and with `now` re-run it at the current chain state and report any changed result.
import { basename } from "node:path";
import type { Hex } from "viem";
import { buildArtifact, readArtifact, serialize, writeArtifact, type ToolInfo } from "./artifact.js";
import type { ChainView } from "./chain.js";
import { runChecks, type CheckOptions, type Mode } from "./checks.js";
import { canonicalize, type Json } from "./jcs.js";
import type { VectorFile } from "./vectors.js";

export interface VerifyDeps {
  openBsc(block: bigint | "finalized"): Promise<ChainView>;
  openXlayer(block: bigint | "latest"): Promise<ChainView>;
  tool: ToolInfo;
  outDir: string;
}

type Obj = { [key: string]: Json };
const obj = (v: Json | undefined): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/** Rebuild the check options an artifact was produced with (vectors from the artifact itself). */
function optionsOf(a: Obj, bsc: ChainView, xlayer: ChainView | null): CheckOptions {
  const rig = obj(a.rig);
  const task = obj(a.task);
  const source = obj(task.vectorSource);
  const vectors: VectorFile = {};
  if (Array.isArray(task.vectors) && typeof task.id === "string") {
    vectors[task.id] = {
      kind: task.kind === "1" ? "seq" : "comb",
      cycles: Number(task.cycles),
      nIn: Number(task.nIn),
      nOut: Number(task.nOut),
      root: task.vectorsRoot as Hex,
      vectors: task.vectors as { input: Hex; out: Hex }[],
    };
  }
  return {
    mode: (a.mode === "B" ? "B" : "A") as Mode,
    bsc,
    xlayer,
    rigId: typeof rig.id === "string" ? BigInt(rig.id) : null,
    minerKey: typeof rig.id === "string" ? undefined : (rig.key as Hex),
    vectors,
    vectorSource: { url: String(source.url ?? ""), sha256: String(source.sha256 ?? "0x") as Hex },
  };
}

export async function verifyFile(path: string, deps: VerifyDeps, now: boolean): Promise<{ ok: boolean; messages: string[] }> {
  const messages: string[] = [];
  const { bytes, hash, artifact } = readArtifact(path);
  if (!basename(path).includes(hash.slice(2, 10))) messages.push(`file name does not carry its hash ${hash.slice(0, 10)}`);

  const chains = obj(artifact.chains);
  const b = obj(chains.bsc);
  const x = chains.xlayer === null ? null : obj(chains.xlayer);
  const bsc = await deps.openBsc(BigInt(String(b.block)));
  if (bsc.blockHash.toLowerCase() !== String(b.blockHash)) messages.push("BSC block hash differs from the artifact");
  const xlayer = x ? await deps.openXlayer(BigInt(String(x.block))) : null;
  if (x && xlayer && xlayer.blockHash.toLowerCase() !== String(x.blockHash)) messages.push("X Layer block hash differs from the artifact");

  const again = await runChecks(optionsOf(artifact, bsc, xlayer));
  const rebuilt = serialize(buildArtifact(again, artifact.tool as unknown as ToolInfo));
  const same = rebuilt.bytes.length === bytes.length && rebuilt.bytes.every((v, i) => v === bytes[i]);
  if (!same) messages.push(`re-run at the pinned blocks does not reproduce the artifact (${rebuilt.hash.slice(0, 10)} vs ${hash.slice(0, 10)})`);
  else messages.push(`reproduced ${hash} at BSC block ${String(b.block)}`);
  let ok = same && messages.length === 1;

  if (now) {
    const bscNow = await deps.openBsc("finalized");
    const xNow = x ? await deps.openXlayer("latest") : null;
    const current = await runChecks(optionsOf(artifact, bscNow, xNow));
    const art = buildArtifact(current, deps.tool);
    const written = writeArtifact(deps.outDir, art, bscNow.block);
    // compared in canonical form, so key order cannot hide or fake a difference
    const before = canonicalize([artifact.results ?? null, artifact.verdict ?? null]);
    const after = canonicalize([art.results ?? null, art.verdict ?? null]);
    if (before !== after || current.verdict !== "PASS") {
      ok = false;
      messages.push(`at BSC block ${bscNow.block} the result changed or failed: ${current.reasons.join("; ") || "results differ"}`);
    } else {
      messages.push(`unchanged at BSC block ${bscNow.block}`);
    }
    messages.push(`re-verification written to ${written.path}`);
  }
  return { ok, messages };
}
