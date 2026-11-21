// One screen run (SPEC-PHASE5-REGISTER §6.4): `screen check` under option A, then `screen verify` at the artifact's own
// pinned blocks on a second provider. Read-only: no key, no signing, no transaction. Runs inside the worker thread
// (worker.ts) in production and in process in the tests.
//
// Each side reads through an ordered list of endpoints, public first and a keyed fallback last (owner, Q2, 2026-11-21).
// Within one run, a transport-level failure on one side moves that side to the next URL of its list and that step starts
// again; a revert, an undecodable answer or any verdict never moves it. The next run starts again from the first URLs, so
// the public endpoints are always tried first. The reproduction is never served by the check's provider (`providerOf`).
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import { classifyReason, classifyReasons, rigLevel } from "./classify.js";
import { providerOf } from "./provider.js";
import { buildArtifact, fileName, serialize, type ToolInfo } from "./vendor/artifact.js";
import { RpcView, type ChainView } from "./vendor/chain.js";
import { runChecks, type Report } from "./vendor/checks.js";
import { BSC_CHAIN_ID, VECTORS_URL, XLAYER_CHAIN_ID } from "./vendor/constants.js";
import type { Json } from "./vendor/jcs.js";
import type { VectorFile } from "./vendor/vectors.js";
import { verifyFile } from "./vendor/verify.js";

export interface JobInput {
  rigId: string;
  /** Where the artifact file is written. */
  outDir: string;
  /** Ordered endpoint lists, at least one URL each: the first is tried first on every run. */
  bscRpcs: string[];
  xlayerRpcs: string[];
  verifyBscRpcs: string[];
  verifyXlayerRpcs: string[];
  tool: ToolInfo;
}

export interface Vectors {
  vectors: VectorFile;
  url: string;
  sha256: Hex;
}

export interface JobDeps {
  openBsc(url: string, block: bigint | "finalized"): Promise<ChainView>;
  openXlayer(url: string, block: bigint | "latest"): Promise<ChainView>;
  loadVectors(): Promise<Vectors>;
}

export interface VerifyOutcome {
  ran: boolean;
  ok: boolean;
  messages: string[];
  /** The second provider could not be read (not a disagreement): retried like any transient failure. */
  transient: boolean;
}

/** The provider (never the URL) that served each side; null when that side did not run. */
export interface ServedBy {
  checkBsc: string;
  checkXlayer: string;
  verifyBsc: string | null;
  verifyXlayer: string | null;
}

export type JobResult =
  | {
      kind: "done";
      verdict: "PASS" | "FAIL";
      reasons: string[];
      file: string;
      hash: Hex;
      circuits: string | null;
      circuitId: string | null;
      taskId: string | null;
      bscBlock: string;
      xlayerBlock: string;
      verify: VerifyOutcome;
      hosts: ServedBy;
    }
  | { kind: "error"; transient: boolean; message: string };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isStrOrNull = (v: unknown) => v === null || typeof v === "string";
const HOST = /^[a-z0-9.:[\]-]{1,253}$/;
const isHost = (v: unknown) => typeof v === "string" && HOST.test(v);
const isHostOrNull = (v: unknown) => v === null || isHost(v);

/** A worker's message is data: only a well-formed result is trusted, anything else is an error (fail closed). */
export function isJobResult(v: unknown): v is JobResult {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r.kind === "error") return typeof r.transient === "boolean" && typeof r.message === "string";
  if (r.kind !== "done") return false;
  const ver = r.verify as Record<string, unknown> | null | undefined;
  const h = r.hosts as Record<string, unknown> | null | undefined;
  return (
    (r.verdict === "PASS" || r.verdict === "FAIL") &&
    isStrings(r.reasons) &&
    typeof r.file === "string" &&
    typeof r.hash === "string" && /^0x[0-9a-f]{64}$/.test(r.hash) &&
    isStrOrNull(r.circuits) && isStrOrNull(r.circuitId) && isStrOrNull(r.taskId) &&
    typeof r.bscBlock === "string" && typeof r.xlayerBlock === "string" &&
    typeof ver === "object" && ver !== null &&
    typeof ver.ran === "boolean" && typeof ver.ok === "boolean" && typeof ver.transient === "boolean" && isStrings(ver.messages) &&
    typeof h === "object" && h !== null &&
    isHost(h.checkBsc) && isHost(h.checkXlayer) && isHostOrNull(h.verifyBsc) && isHostOrNull(h.verifyXlayer)
  );
}

type Obj = { [k: string]: Json };
const obj = (v: Json | undefined): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: Json | undefined): string | null => (typeof v === "string" ? v : null);

/** The vector file was 2.64 MB on 2026-10-21; anything past this is not it, and is never held in memory (L5). */
export const MAX_VECTORS_BYTES = 64 * 1024 * 1024;

/** The published vector file (SCREEN S7): web content, trusted only through each task's on-chain root (§4.3.1). Streamed, capped. */
export async function downloadVectors(doFetch: typeof fetch = fetch, max = MAX_VECTORS_BYTES): Promise<Vectors> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120_000);
  try {
    let res: Response;
    try {
      res = await doFetch(VECTORS_URL, { signal: ctl.signal });
    } catch (e) {
      throw new Error(`vector file download failed: ${e instanceof Error ? e.name : "network error"}`);
    }
    if (!res.ok) throw new Error(`vector file download failed: HTTP ${res.status}`);
    const declared = Number(res.headers?.get?.("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > max) throw new Error("vector file download failed: too large");
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    if (!reader) throw new Error("vector file download failed: no body");
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
          ctl.abort();
          throw new Error("vector file download failed: too large");
        }
        chunks.push(value);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("vector file download failed")) throw e;
      throw new Error(`vector file download failed: ${e instanceof Error ? e.name : "network error"}`);
    }
    const bytes = Buffer.concat(chunks);
    const sha256 = `0x${createHash("sha256").update(bytes).digest("hex")}` as Hex;
    return { vectors: JSON.parse(bytes.toString("utf8")) as VectorFile, url: VECTORS_URL, sha256 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One side's views, watched (L3, Q2): a transport failure while the checks read is caught by `runChecks` and becomes an
 * `rpc:` or `error:` reason, which would read as a verdict or a disagreement. `failed` remembers that this side's endpoint
 * did not answer (opening it included). A revert is an answer: `call` returns it, nothing throws, nothing is noted.
 */
export function watched<B>(open: (b: B) => Promise<ChainView>, seen: { failed: boolean }): (b: B) => Promise<ChainView> {
  const note = (e: unknown): never => {
    if (classifyReason(message(e)).kind === "transient") seen.failed = true;
    throw e;
  };
  return async (b) => {
    const v = await open(b).catch(note);
    return {
      chainId: v.chainId,
      block: v.block,
      blockHash: v.blockHash,
      call: (to, data, gas) => v.call(to, data, gas).catch(note),
      storage: (a, s) => v.storage(a, s).catch(note),
      codeHash: (a) => v.codeHash(a).catch(note),
      batch: (calls) => v.batch(calls).catch(note),
    };
  };
}

export const rpcDeps = (doFetch: typeof fetch = fetch): JobDeps => ({
  openBsc: (url, block) => RpcView.open(url, "BSC", BSC_CHAIN_ID, block),
  openXlayer: (url, block) => RpcView.open(url, "X Layer", XLAYER_CHAIN_ID, block),
  loadVectors: () => downloadVectors(doFetch),
});

/** Write the artifact's exact bytes under its canonical name, atomically. */
function store(dir: string, artifact: { [k: string]: Json }): { path: string; file: string; hash: Hex } {
  const { bytes, hash } = serialize(artifact);
  mkdirSync(dir, { recursive: true });
  const file = fileName(artifact, hash);
  const path = join(dir, file);
  writeFileSync(`${path}.tmp`, bytes);
  renameSync(`${path}.tmp`, path);
  return { path, file, hash };
}

/** Two cursors over two endpoint lists: a side moves on only when it failed the way an endpoint fails, and has a next URL. */
class Cursor {
  private b = 0;
  private x = 0;
  constructor(readonly bsc: readonly string[], readonly xlayer: readonly string[]) {}
  get bscUrl(): string {
    return this.bsc[this.b]!;
  }
  get xlayerUrl(): string {
    return this.xlayer[this.x]!;
  }
  /** True when at least one failed side moved to its next URL. */
  advance(seen: { bsc: { failed: boolean }; xlayer: { failed: boolean } }): boolean {
    let moved = false;
    if (seen.bsc.failed && this.b + 1 < this.bsc.length) {
      this.b++;
      moved = true;
    }
    if (seen.xlayer.failed && this.x + 1 < this.xlayer.length) {
      this.x++;
      moved = true;
    }
    return moved;
  }
}

const sides = () => ({ bsc: { failed: false }, xlayer: { failed: false } });

export async function runJob(input: JobInput, deps: JobDeps): Promise<JobResult> {
  let rigId: bigint;
  try {
    rigId = BigInt(input.rigId);
  } catch {
    return { kind: "error", transient: false, message: "bad rig id" };
  }
  if ([input.bscRpcs, input.xlayerRpcs, input.verifyBscRpcs, input.verifyXlayerRpcs].some((l) => !Array.isArray(l) || l.length === 0)) {
    return { kind: "error", transient: false, message: "an endpoint list is empty" };
  }

  // the check: the vector file is fetched once; an endpoint failure moves only the side that failed
  const check = new Cursor(input.bscRpcs, input.xlayerRpcs);
  let vectors: Vectors | null = null;
  let report: Report;
  for (;;) {
    const seen = sides();
    try {
      const bscUrl = check.bscUrl;
      const xlayerUrl = check.xlayerUrl;
      const bsc = await watched((b: "finalized") => deps.openBsc(bscUrl, b), seen.bsc)("finalized");
      const xlayer = await watched((b: "latest") => deps.openXlayer(xlayerUrl, b), seen.xlayer)("latest");
      vectors ??= await deps.loadVectors();
      report = await runChecks({ mode: "A", bsc, xlayer, rigId, vectors: vectors.vectors, vectorSource: { url: vectors.url, sha256: vectors.sha256 } });
    } catch (e) {
      const m = message(e);
      const transient = classifyReason(m).kind === "transient";
      if (transient && check.advance(seen)) continue;
      return { kind: "error", transient, message: m };
    }
    if (classifyReasons(report.reasons).kind === "transient" && check.advance(seen)) continue;
    break;
  }
  const art = buildArtifact(report, input.tool);
  const verdict = report.verdict;
  const reasons = report.reasons;
  const hosts: ServedBy = { checkBsc: providerOf(check.bscUrl), checkXlayer: providerOf(check.xlayerUrl), verifyBsc: null, verifyXlayer: null };

  let saved: { path: string; file: string; hash: Hex };
  try {
    saved = store(input.outDir, art);
  } catch (e) {
    return { kind: "error", transient: false, message: `artifact write failed: ${message(e)}` };
  }

  const verify: VerifyOutcome = { ran: false, ok: false, messages: [], transient: false };
  if (verdict === "PASS" || rigLevel(reasons)) {
    verify.ran = true;
    // never the check's provider, also after a fallback on either side: the URLs actually used are compared
    const vb = input.verifyBscRpcs.filter((u) => providerOf(u) !== hosts.checkBsc);
    const vx = input.verifyXlayerRpcs.filter((u) => providerOf(u) !== hosts.checkXlayer);
    if (vb.length === 0 || vx.length === 0) {
      verify.transient = true;
      verify.messages = ["no second provider other than the check's is configured for this run"];
    } else {
      const second = new Cursor(vb, vx);
      for (;;) {
        const seen = sides();
        const bscUrl = second.bscUrl;
        const xlayerUrl = second.xlayerUrl;
        hosts.verifyBsc = providerOf(bscUrl);
        hosts.verifyXlayer = providerOf(xlayerUrl);
        try {
          const r = await verifyFile(saved.path, {
            openBsc: watched((b: bigint | "finalized") => deps.openBsc(bscUrl, b), seen.bsc),
            openXlayer: watched((b: bigint | "latest") => deps.openXlayer(xlayerUrl, b), seen.xlayer),
            tool: input.tool,
            outDir: input.outDir, // unused without `now`: verify writes nothing here
          }, false);
          if (r.ok) {
            verify.ok = true;
            verify.transient = false;
            verify.messages = r.messages;
            break;
          }
          const failed = seen.bsc.failed || seen.xlayer.failed;
          if (failed && second.advance(seen)) continue;
          // not reproduced because the second provider did not answer: retried later, not a mismatch
          verify.ok = false;
          verify.transient = failed;
          verify.messages = failed ? [...r.messages, "the second provider failed to answer during the re-run"] : r.messages;
          break;
        } catch (e) {
          const m = message(e);
          const transient = classifyReason(m).kind === "transient";
          if (transient && second.advance(seen)) continue;
          verify.ok = false;
          verify.transient = transient;
          verify.messages = [m];
          break;
        }
      }
    }
  }
  const rig = obj(art.rig);
  const task = obj(art.task);
  const chains = obj(art.chains);
  return {
    kind: "done",
    verdict,
    reasons,
    file: saved.file,
    hash: saved.hash,
    circuits: str(rig.circuits),
    circuitId: str(rig.circuitId),
    taskId: str(task.id),
    bscBlock: str(obj(chains.bsc).block) ?? "",
    xlayerBlock: str(obj(chains.xlayer).block) ?? "",
    verify,
    hosts,
  };
}
