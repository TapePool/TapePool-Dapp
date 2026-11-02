// Artifacts (SPEC-PHASE3-SCREEN §5): canonical JSON, keccak256 of the exact file bytes, an index line.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toBytes, type Hex } from "viem";
import type { Report } from "./checks.js";
import { canonicalize, parseCanonical, type Json } from "./jcs.js";

export interface ToolInfo {
  name: string;
  version: string;
  commit: string;
}

export function buildArtifact(report: Report, tool: ToolInfo): { [key: string]: Json } {
  return { schema: "1", tool: { name: tool.name, version: tool.version, commit: tool.commit }, ...report.body };
}

export function serialize(artifact: Json): { bytes: Uint8Array; hash: Hex; text: string } {
  const text = canonicalize(artifact);
  const bytes = toBytes(text);
  return { bytes, hash: keccak256(bytes), text };
}

const short = (h: Hex) => h.slice(2, 10);

/** `rig-<id>-<hash8>.json`, `miner-<key8>-<hash8>.json`, or with `reverify-<block>` before the hash. */
export function fileName(artifact: { [key: string]: Json }, hash: Hex, reverifyBlock?: bigint): string {
  const rig = artifact.rig as { id: string | null; key: string } | undefined;
  const who = rig?.id ? `rig-${rig.id}` : `miner-${(rig?.key ?? "0x00000000").slice(2, 10)}`;
  return reverifyBlock === undefined ? `${who}-${short(hash)}.json` : `${who}-reverify-${reverifyBlock}-${short(hash)}.json`;
}

/** Write the artifact bytes (no trailing newline) and add a line to INDEX.md. Returns the file path. */
export function writeArtifact(dir: string, artifact: { [key: string]: Json }, reverifyBlock?: bigint): { path: string; hash: Hex } {
  const { bytes, hash } = serialize(artifact);
  mkdirSync(dir, { recursive: true });
  const name = fileName(artifact, hash, reverifyBlock);
  const path = join(dir, name);
  writeFileSync(path, bytes);
  const index = join(dir, "INDEX.md");
  if (!existsSync(index)) {
    writeFileSync(index, "# Screen artifacts\n\n| Rig | Task | BSC block | X Layer block | Mode | Verdict | artifactHash | File |\n|---|---|---|---|---|---|---|---|\n");
  }
  const rig = artifact.rig as { id: string | null; key: string } | undefined;
  const task = artifact.task as { id: string } | undefined;
  const chains = artifact.chains as { bsc: { block: string } | null; xlayer: { block: string } | null };
  const label = rig?.id ?? `miner ${rig?.key.slice(0, 10) ?? "?"}`;
  const kind = reverifyBlock === undefined ? "" : " (re-verification)";
  appendFileSync(index, `| ${label}${kind} | ${task?.id ?? "?"} | ${chains.bsc?.block ?? "?"} | ${chains.xlayer?.block ?? "-"} | ${String(artifact.mode ?? "?")} | ${String(artifact.verdict)} | \`${hash}\` | [${name}](${name}) |\n`);
  return { path, hash };
}

/** Read an artifact file: its exact bytes, their hash, and the parsed (and canonical-checked) body. */
export function readArtifact(path: string): { bytes: Uint8Array; hash: Hex; artifact: { [key: string]: Json } } {
  const bytes = new Uint8Array(readFileSync(path));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const artifact = parseCanonical(text) as { [key: string]: Json };
  return { bytes, hash: keccak256(bytes), artifact };
}
