// "Register to borrow" (SPEC-PHASE5-REGISTER §6): admits a miner's request, queues one screen run per voucher, runs it
// in a worker (one at a time), classifies the result, publishes the artifact and tells the owner on Telegram. Read-only
// towards every chain: the keeper's key never records, suspends or revokes a pass here. Only the owner wallet signs
// `recordPass`, from the app's owner page.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, zeroAddress, type Address, type Hex } from "viem";
import { ADDR, type Deployment } from "./addresses.js";
import { screenAbi, voucherAbi } from "./abi.js";
import type { Clients } from "./chains.js";
import type { ScreenConfig } from "./config.js";
import { log, redact } from "./log.js";
import { RegisterLimiter } from "./logic/registerLimits.js";
import { classifyReasons, type ErrorCode, type FailCode } from "./screen/classify.js";
import { isJobResult, type JobInput, type JobResult, type ServedBy } from "./screen/job.js";
import { SCREEN_SOURCE } from "./screen/source.js";
import type { ToolInfo } from "./screen/vendor/artifact.js";

export type ScreenStatus = "queued" | "checking" | "pass" | "fail" | "error" | "recorded" | "revoked";

export interface ArtifactInfo {
  file: string;
  hash: Hex;
  verdict: "PASS" | "FAIL";
  circuits: string | null;
  circuitId: string | null;
  taskId: string | null;
  bscBlock: string;
  xlayerBlock: string;
  /** Reproduced byte for byte on the second providers. */
  verified: boolean;
}

export interface ScreenRecord {
  rigId: string;
  status: ScreenStatus;
  requestedAt: number;
  updatedAt: number;
  /** Runs started for the current registration. */
  attempts: number;
  /** A queued record starts no earlier than this (the transient retry ladder). */
  notBefore: number;
  retryAt: number | null;
  code: FailCode | ErrorCode | null;
  reasons: string[];
  artifact: ArtifactInfo | null;
  /**
   * `KEEPER_TOOL.commit` of the run that produced this record (the hash of the vendored screen sources, reviewed constants
   * included). A waiting PASS from another tool is screened again on start (§6.6). Absent before the first run.
   */
  tool?: string;
  /** Consecutive `passOf` reads with no pass while `recorded`: three make it `revoked` (§6.7). */
  zeroReads?: number;
  /** The provider (last two host labels, never a URL) that served each side of the last finished run (Q2). */
  hosts?: ServedBy;
}

/** Persisted in `state.json` (SPEC-PHASE5-REGISTER §6.6). */
export interface ScreenState {
  /** The RigScreen the records belong to ("" before the first start). */
  screen: string;
  records: Record<string, ScreenRecord>;
  counts: Record<string, number>;
}

export const emptyScreenState = (): ScreenState => ({ screen: "", records: {}, counts: {} });

export type RegisterAnswer =
  | { status: "queued" | "known"; screen: ScreenView }
  | { status: "recorded" }
  | { status: "refused"; reason: string };

export type ScreenView = Omit<ScreenRecord, "notBefore">;

export interface ScreensList {
  open: boolean;
  paused: boolean;
  screen: string;
  asOf: number;
  screens: ScreenView[];
}

/** The X Layer reads the service needs: the voucher, the pass. Every method throws on a failed read. */
export interface ScreenChain {
  precheck(id: bigint): Promise<{ exists: boolean; circuits: Address; power: bigint; passAt: bigint; suspended: boolean }>;
  /** `passOf(id).pass.effectiveAt` by decimal rig id. */
  passes(ids: readonly bigint[]): Promise<Map<string, bigint>>;
  delay(): Promise<bigint>;
}

export class XLayerScreenChain implements ScreenChain {
  constructor(private readonly c: Clients, private readonly d: Deployment) {}

  async precheck(id: bigint) {
    const [owner, rig, pass] = await this.c.xlayer.public.multicall({
      allowFailure: true,
      contracts: [
        { address: ADDR.voucher, abi: voucherAbi, functionName: "ownerOf", args: [id] },
        { address: ADDR.voucher, abi: voucherAbi, functionName: "rigs", args: [id] },
        { address: this.d.screen, abi: screenAbi, functionName: "passOf", args: [id] },
      ],
    });
    if (rig.status !== "success" || pass.status !== "success") throw new Error("pre-check read failed");
    // ownerOf reverts for an id that was never minted or was burned: no voucher
    const exists = owner.status === "success" && owner.result.toLowerCase() !== zeroAddress;
    return { exists, circuits: rig.result[0], power: rig.result[3], passAt: pass.result[0].effectiveAt, suspended: pass.result[1] };
  }

  async passes(ids: readonly bigint[]) {
    const out = new Map<string, bigint>();
    if (ids.length === 0) return out;
    const rows = await this.c.xlayer.public.multicall({
      allowFailure: false,
      contracts: ids.map((id) => ({ address: this.d.screen, abi: screenAbi, functionName: "passOf", args: [id] }) as const),
    });
    ids.forEach((id, i) => out.set(id.toString(), (rows[i] as readonly [{ effectiveAt: bigint }, boolean])[0].effectiveAt));
    return out;
  }

  delay() {
    return this.c.xlayer.public.readContract({ address: this.d.screen, abi: screenAbi, functionName: "DELAY" });
  }
}

export interface ScreenServiceDeps {
  cfg: ScreenConfig | null;
  d: Deployment | null;
  state: ScreenState;
  /** Where artifact files live: `<dirname(STATE_PATH)>/screen-artifacts`. */
  dir: string;
  chain: ScreenChain | null;
  run: (input: JobInput) => Promise<JobResult>;
  alert: (kind: string, text: string, always: boolean) => void;
  isFrozen: () => boolean;
  now?: () => number;
  persist?: () => void;
}

export const MAX_QUEUED = 20;
export const MAX_IN_FLIGHT = 2;
export const MAX_ATTEMPTS = 3;
export const RETRY_LADDER_SEC = 600;
export const TRANSIENT_RETRY_SEC = 6 * 3_600;
export const ERROR_RETRY_SEC = 24 * 3_600;
export const MAX_LISTED = 500;
/** The pre-run `passOf` read failed: the record waits this long before it is tried again, uncounted (M1). */
export const PRE_READ_BACKOFF_SEC = 120;
/** Consecutive empty `passOf` reads before a `recorded` record counts as `revoked` (L2). */
export const REVOKED_AFTER_READS = 3;
const MAX_REASONS = 8;
const MAX_REASON_LEN = 300;
const RIG_ID = /^(0|[1-9][0-9]{0,14})$/;

/** The tool these artifacts name (SPEC-PHASE5-REGISTER §6.4): the vendored sources' hash, fixed at build time. */
export const KEEPER_TOOL: ToolInfo = { name: "tape-pool-screen", version: SCREEN_SOURCE.version, commit: `keeper-src-sha256:${SCREEN_SOURCE.sha256}` };

const OPEN: readonly ScreenStatus[] = ["queued", "checking", "pass", "error", "recorded", "revoked"];
const STATUSES: readonly ScreenStatus[] = ["queued", "checking", "pass", "fail", "error", "recorded", "revoked"];
const CODES: readonly string[] = ["no-voucher", "voucher-mismatch", "processor", "not-mining", "task", "circuit", "wrong-output", "differs", "counterexample", "too-wide", "transient", "verify", "check"];

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

function cleanArtifact(v: unknown): ArtifactInfo | null | undefined {
  if (v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return undefined;
  const a = v as Record<string, unknown>;
  if (typeof a.file !== "string" || !/^[a-z0-9-]+\.json$/.test(a.file) || typeof a.hash !== "string" || !/^0x[0-9a-f]{64}$/.test(a.hash)) return undefined;
  if ((a.verdict !== "PASS" && a.verdict !== "FAIL") || typeof a.verified !== "boolean") return undefined;
  if (!isStrOrNull(a.circuits) || !isStrOrNull(a.circuitId) || !isStrOrNull(a.taskId) || typeof a.bscBlock !== "string" || typeof a.xlayerBlock !== "string") return undefined;
  return { file: a.file, hash: a.hash as Hex, verdict: a.verdict, circuits: a.circuits, circuitId: a.circuitId, taskId: a.taskId, bscBlock: a.bscBlock, xlayerBlock: a.xlayerBlock, verified: a.verified };
}

const HOST = /^[a-z0-9.:[]-]{1,253}$/;
/** `undefined` when absent, null when malformed. */
function cleanHosts(v: unknown): ServedBy | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const h = v as Record<string, unknown>;
  const host = (x: unknown) => typeof x === "string" && HOST.test(x);
  if (!host(h.checkBsc) || !host(h.checkXlayer) || !(h.verifyBsc === null || host(h.verifyBsc)) || !(h.verifyXlayer === null || host(h.verifyXlayer))) return null;
  return { checkBsc: h.checkBsc as string, checkXlayer: h.checkXlayer as string, verifyBsc: h.verifyBsc as string | null, verifyXlayer: h.verifyXlayer as string | null };
}

/** One persisted record, or null when anything about it is off (L4): a bad `state.json` must never stop the keeper. */
export function cleanScreenRecord(key: string, v: unknown): ScreenRecord | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.rigId !== "string" || !RIG_ID.test(r.rigId) || r.rigId !== key || !STATUSES.includes(r.status as ScreenStatus)) return null;
  if (!isTime(r.requestedAt) || !isTime(r.updatedAt) || !isTime(r.attempts) || !isTime(r.notBefore)) return null;
  if (r.retryAt !== null && !isTime(r.retryAt)) return null;
  if (r.code !== null && !(typeof r.code === "string" && CODES.includes(r.code))) return null;
  if (!Array.isArray(r.reasons) || !r.reasons.every((x) => typeof x === "string")) return null;
  if (r.tool !== undefined && typeof r.tool !== "string") return null;
  if (r.zeroReads !== undefined && !isTime(r.zeroReads)) return null;
  const hosts = cleanHosts(r.hosts);
  if (hosts === null) return null;
  const artifact = cleanArtifact(r.artifact);
  if (artifact === undefined) return null;
  return {
    rigId: r.rigId,
    status: r.status as ScreenStatus,
    requestedAt: r.requestedAt,
    updatedAt: r.updatedAt,
    attempts: r.attempts,
    notBefore: r.notBefore,
    retryAt: r.retryAt as number | null,
    code: r.code as ScreenRecord["code"],
    reasons: clip(r.reasons as string[]),
    artifact,
    ...(r.tool === undefined ? {} : { tool: r.tool as string }),
    ...(r.zeroReads === undefined ? {} : { zeroReads: r.zeroReads as number }),
    ...(hosts === undefined ? {} : { hosts }),
  };
}

/** The screen section of a state file: malformed records and counters are dropped, never trusted (L4). */
export function cleanScreenState(v: unknown): ScreenState {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return emptyScreenState();
  const s = v as Record<string, unknown>;
  const records: Record<string, ScreenRecord> = {};
  if (typeof s.records === "object" && s.records !== null && !Array.isArray(s.records)) {
    for (const [k, r] of Object.entries(s.records)) {
      const c = cleanScreenRecord(k, r);
      if (c) records[k] = c;
    }
  }
  const counts: Record<string, number> = {};
  if (typeof s.counts === "object" && s.counts !== null && !Array.isArray(s.counts)) {
    for (const [k, n] of Object.entries(s.counts)) if (isTime(n)) counts[k] = n;
  }
  return { screen: typeof s.screen === "string" ? s.screen : "", records, counts };
}
const short = (h: string) => h.slice(0, 10);
const clip = (reasons: readonly string[]) => reasons.slice(0, MAX_REASONS).map((r) => redact(r).slice(0, MAX_REASON_LEN));

/** Both sides of the reproduction were served by another provider than the check's (Q2). */
export const independent = (h: ServedBy): boolean =>
  h.verifyBsc !== null && h.verifyXlayer !== null && h.verifyBsc !== h.checkBsc && h.verifyXlayer !== h.checkXlayer;

/** `DELAY` seconds as copy: "48 h", "90 min", "at once". */
export function delayText(sec: bigint | null): string {
  if (sec === null) return "after RigScreen.DELAY";
  if (sec === 0n) return "at once";
  if (sec % 3_600n === 0n) return `${sec / 3_600n} h after it is recorded`;
  if (sec % 60n === 0n) return `${sec / 60n} min after it is recorded`;
  return `${sec} s after it is recorded`;
}

export class ScreenService {
  private readonly limiter: RegisterLimiter;
  private readonly now: () => number;
  private readonly persist: () => void;
  private inFlight = 0;
  private running: Promise<void> | null = null;
  /** A protocol-wide reason stopped the queue: no run starts until the keeper restarts (§6.5). In memory only. */
  private protocolPause: string | null = null;
  private delay: bigint | null = null;

  constructor(private readonly x: ScreenServiceDeps) {
    this.now = x.now ?? (() => Math.floor(Date.now() / 1000));
    this.persist = x.persist ?? (() => {});
    const s = x.state;
    // whatever came from disk is checked again here: a malformed record is dropped, never trusted (L4)
    const clean = cleanScreenState(s);
    s.screen = clean.screen;
    s.records = clean.records;
    s.counts = clean.counts;
    if (x.d && s.screen.toLowerCase() !== x.d.screen.toLowerCase()) {
      // records belong to one RigScreen: another one starts over (artifact files stay on disk)
      s.screen = x.d.screen;
      s.records = {};
      s.counts = {};
    }
    this.limiter = new RegisterLimiter(s.counts);
    this.restart();
  }

  get open(): boolean {
    return this.x.cfg !== null && this.x.d !== null && this.x.chain !== null;
  }

  get paused(): boolean {
    return this.x.isFrozen() || this.protocolPause !== null;
  }

  /** Read `RigScreen.DELAY()` for the alert text; a failed read leaves the text without a number. */
  async init(): Promise<void> {
    if (!this.x.chain) return;
    try {
      this.delay = await this.x.chain.delay();
    } catch (e) {
      log("warn", "RigScreen.DELAY unreadable", { error: redact(String(e)) });
    }
  }

  /** Persist, and never throw: a failed write is logged and the owner told, and the record goes on as it is (L1). */
  private save(): void {
    try {
      this.persist();
    } catch (e) {
      log("error", "could not save the screen state", { error: redact(String(e)) });
      this.x.alert("screen:persist", "The keeper could not save its screen records to the volume; registrations may be lost on restart.", false);
    }
  }

  /**
   * On start (§6.6):
   * - a run the process lost goes back to the queue, its attempt counted, so a run that kills the process cannot loop (L5);
   * - a PASS still waiting for a signature that another tool made (another vendored source hash, reviewed constants
   *   included) is screened again, so the owner never signs a result made under constants that were since changed (M2);
   * - a stored verdict whose file is gone or altered is not trusted.
   */
  private restart(): void {
    const now = this.now();
    const requeued: string[] = [];
    for (const r of Object.values(this.x.state.records)) {
      if (r.status === "checking") {
        r.updatedAt = now;
        if (r.attempts >= MAX_ATTEMPTS) {
          this.setError(r, "transient", ["the keeper restarted during the run"], now, TRANSIENT_RETRY_SEC);
          this.x.alert(`screen:error:${r.rigId}:${now}`, `Screen of rig #${r.rigId} was cut short by ${MAX_ATTEMPTS} keeper restarts. Nothing to sign.`, true);
        } else {
          r.status = "queued";
          r.notBefore = now;
        }
      }
      if (r.status === "pass" && r.tool !== KEEPER_TOOL.commit) {
        r.status = "queued";
        r.attempts = 0;
        r.notBefore = now;
        r.updatedAt = now;
        r.code = null;
        r.reasons = [];
        r.retryAt = null;
        r.artifact = null;
        requeued.push(r.rigId);
        continue;
      }
      if ((r.status === "pass" || r.status === "fail") && !this.fileOk(r.artifact)) {
        this.setError(r, "check", ["the stored artifact is missing or altered"], now, 0);
        this.x.alert(`screen:lost:${r.rigId}`, `Screen artifact of rig #${r.rigId} is missing or altered on the volume; the record is now an error. Nothing to sign.`, true);
      }
    }
    if (requeued.length > 0) {
      this.x.alert(`screen:requeued:${KEEPER_TOOL.commit.slice(-8)}`, `The screen tool changed (${KEEPER_TOOL.commit.slice(0, 26)}…): rigs ${requeued.map((id) => `#${id}`).join(", ")} had a PASS waiting for a signature and are screened again. Do not sign their old artifacts.`, true);
    }
  }

  private fileOk(a: ArtifactInfo | null): boolean {
    if (!a) return false;
    const bytes = this.read(a);
    return bytes !== null;
  }

  /** The stored bytes when they still hash to the record's hash; null otherwise (fail closed). */
  private read(a: ArtifactInfo): Buffer | null {
    const path = join(this.x.dir, a.file);
    if (!/^[a-z0-9-]+\.json$/.test(a.file) || !existsSync(path)) return null;
    try {
      const bytes = readFileSync(path);
      return keccak256(new Uint8Array(bytes)) === a.hash ? bytes : null;
    } catch {
      return null;
    }
  }

  /* ───────── the routes ───────── */

  view(r: ScreenRecord): ScreenView {
    const { notBefore: _n, ...v } = r;
    return { ...v, reasons: [...v.reasons], artifact: v.artifact ? { ...v.artifact } : null };
  }

  list(): ScreensList {
    const screens = Object.values(this.x.state.records)
      .sort((a, b) => (BigInt(a.rigId) < BigInt(b.rigId) ? -1 : 1))
      .slice(0, MAX_LISTED)
      .map((r) => this.view(r));
    return { open: this.open, paused: this.paused, screen: this.x.d?.screen ?? zeroAddress, asOf: this.now(), screens };
  }

  /** The artifact's exact bytes, or null when there is none or the file no longer matches its hash. */
  artifact(rigIdRaw: string): { bytes: Buffer; file: string } | null {
    if (!RIG_ID.test(rigIdRaw)) return null;
    const a = this.x.state.records[rigIdRaw]?.artifact;
    if (!a) return null;
    const bytes = this.read(a);
    return bytes ? { bytes, file: a.file } : null;
  }

  /** `POST /v1/register` (§6.2, §6.3). Never throws. */
  async request(rigIdRaw: unknown, ip: string): Promise<RegisterAnswer> {
    const now = this.now();
    this.limiter.prune(now);
    const admitted = this.limiter.admit(ip, now);
    if (admitted) return { status: "refused", reason: admitted };
    if (!this.open) return { status: "refused", reason: "registration is not open" };
    if (typeof rigIdRaw !== "string" || !RIG_ID.test(rigIdRaw)) return { status: "refused", reason: "bad rig id" };
    const id = rigIdRaw;
    const known = this.x.state.records[id];
    if (known && (known.status !== "error" || (known.retryAt ?? 0) > now)) return { status: "known", screen: this.view(known) };
    if (this.inFlight >= MAX_IN_FLIGHT) return { status: "refused", reason: "busy, try again shortly" };
    this.inFlight++;
    try {
      let pre: Awaited<ReturnType<ScreenChain["precheck"]>>;
      try {
        pre = await this.x.chain!.precheck(BigInt(id));
      } catch (e) {
        log("warn", "register pre-check failed", { rig: id, error: redact(String(e)) });
        return { status: "refused", reason: "chain read failed, try again shortly" };
      }
      if (!pre.exists || pre.circuits.toLowerCase() === zeroAddress) return { status: "refused", reason: "no voucher" };
      if (pre.power === 0n) return { status: "refused", reason: "voucher not synced" };
      if (pre.suspended) return { status: "refused", reason: "screen suspended" };
      if (pre.passAt !== 0n) return { status: "recorded" };
      // the record may have changed while the chain was read
      const again = this.x.state.records[id];
      if (again && (again.status !== "error" || (again.retryAt ?? 0) > now)) return { status: "known", screen: this.view(again) };
      if (Object.values(this.x.state.records).filter((r) => r.status === "queued").length >= MAX_QUEUED) {
        return { status: "refused", reason: "queue full, try again later" };
      }
      const rec: ScreenRecord = { rigId: id, status: "queued", requestedAt: now, updatedAt: now, attempts: 0, notBefore: now, retryAt: null, code: null, reasons: [], artifact: null };
      this.x.state.records[id] = rec;
      this.save();
      log("info", "screen registered", { rig: id });
      return { status: "queued", screen: this.view(rec) };
    } finally {
      this.inFlight--;
    }
  }

  /* ───────── every cycle (§6.7) ───────── */

  /** Never throws into the keeper loop. Starts at most one run; it goes on in the background. */
  async tick(): Promise<void> {
    if (!this.open) return;
    try {
      await this.refreshChain();
    } catch (e) {
      log("warn", "screen pass refresh failed", { error: redact(String(e)) });
    }
    this.maybeStart();
  }

  /** Settles when the run in progress (if any) has been recorded. For tests and shutdown. */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async refreshChain(): Promise<void> {
    const open = Object.values(this.x.state.records).filter((r) => OPEN.includes(r.status));
    if (open.length === 0) return;
    const at = await this.x.chain!.passes(open.map((r) => BigInt(r.rigId)));
    const now = this.now();
    let changed = false;
    for (const r of open) {
      const p = at.get(r.rigId);
      if (p === undefined) continue;
      if (p !== 0n) {
        if (r.zeroReads) {
          r.zeroReads = 0;
          changed = true;
        }
        // a pass on chain, also one seen again after a read that showed none (L2)
        if (r.status !== "recorded" && r.status !== "checking") {
          r.status = "recorded";
          r.updatedAt = now;
          changed = true;
        }
      } else if (r.status === "recorded") {
        // one empty read is not enough to call it revoked: an endpoint can answer from a stale state (L2)
        r.zeroReads = (r.zeroReads ?? 0) + 1;
        changed = true;
        if (r.zeroReads >= REVOKED_AFTER_READS) {
          r.status = "revoked";
          r.updatedAt = now;
          this.x.alert(`screen:revoked:${r.rigId}`, `Screen pass of rig #${r.rigId} is gone from RigScreen (revoked); the keeper will not offer it again.`, true);
        }
      }
    }
    if (changed) this.save();
  }

  /**
   * Picks the next queued record and starts it in the background. `running` is set before anything else can fail (L1); the
   * run is counted against the daily cap only once its pre-run read succeeded and the job really starts (M1).
   */
  private maybeStart(): void {
    if (this.running || this.paused) return;
    const now = this.now();
    if (this.limiter.runsToday(now) >= (this.x.cfg?.dailyMax ?? 0)) return;
    const next = Object.values(this.x.state.records)
      .filter((r) => r.status === "queued" && r.notBefore <= now)
      .sort((a, b) => a.notBefore - b.notBefore || a.requestedAt - b.requestedAt)[0];
    if (!next) return;
    this.running = this.execute(next)
      .catch((e: unknown) => {
        // fail closed: never leave a record in `checking` behind a bug
        log("error", "screen run failed", { rig: next.rigId, error: redact(String(e)) });
        if (next.status === "checking") {
          this.setError(next, "check", [`the run failed: ${redact(String(e))}`], this.now());
          this.x.alert(`screen:error:${next.rigId}:${this.now()}`, `Screen of rig #${next.rigId} failed inside the keeper (check). Nothing to sign.`, true);
          this.save();
        }
      })
      .finally(() => {
        this.running = null;
      });
  }

  private async execute(rec: ScreenRecord): Promise<void> {
    const cfg = this.x.cfg!;
    try {
      // a pass recorded meanwhile (by hand, or by a run before a restart) ends the registration
      const at = (await this.x.chain!.passes([BigInt(rec.rigId)])).get(rec.rigId);
      if (at !== undefined && at !== 0n) {
        rec.status = "recorded";
        rec.updatedAt = this.now();
        this.save();
        return;
      }
    } catch (e) {
      // without a fresh read the run waits, uncounted, and backs off: an outage cannot spend the daily cap (M1)
      rec.notBefore = this.now() + PRE_READ_BACKOFF_SEC;
      log("warn", "screen pre-run read failed", { rig: rec.rigId, error: redact(String(e)) });
      this.x.alert("screen:preread", `Screen runs wait: RigScreen.passOf could not be read on X Layer (rig #${rec.rigId} retries in ${PRE_READ_BACKOFF_SEC / 60} minutes).`, false);
      this.save();
      return;
    }
    // the run really starts now: count it, stamp the tool, and only then hand it to the worker
    const started = this.now();
    rec.status = "checking";
    rec.attempts++;
    rec.updatedAt = started;
    rec.tool = KEEPER_TOOL.commit;
    this.limiter.countRun(started);
    this.save();
    let result: JobResult;
    try {
      result = await this.x.run({
        rigId: rec.rigId,
        outDir: this.x.dir,
        bscRpcs: [...cfg.bscRpcs],
        xlayerRpcs: [...cfg.xlayerRpcs],
        verifyBscRpcs: [...cfg.verifyBscRpcs],
        verifyXlayerRpcs: [...cfg.verifyXlayerRpcs],
        tool: KEEPER_TOOL,
      });
    } catch (e) {
      result = { kind: "error", transient: false, message: String(e) };
    }
    // the run's answer is data: a malformed one is an error, never a verdict
    if (!isJobResult(result)) result = { kind: "error", transient: false, message: "malformed screen result" };
    try {
      this.settle(rec, result);
    } catch (e) {
      // fail closed: whatever went wrong, no PASS, the record leaves `checking`, and the owner is told
      const now = this.now();
      if (rec.artifact) rec.artifact = { ...rec.artifact, verified: false };
      this.setError(rec, "check", [`could not record the result: ${redact(String(e))}`], now);
      this.x.alert(`screen:error:${rec.rigId}:${now}`, `Screen of rig #${rec.rigId} could not be recorded (check). Nothing to sign.`, true);
    } finally {
      this.save();
    }
  }

  /** §6.5: every row that is not `pass` means no PASS. */
  settle(rec: ScreenRecord, r: JobResult): void {
    const now = this.now();
    rec.updatedAt = now;
    const id = rec.rigId;
    if (r.kind === "error") {
      const m = redact(r.message);
      if (r.transient) return this.ladder(rec, m, now);
      this.setError(rec, "check", [m], now);
      this.x.alert(`screen:error:${id}:${now}`, `Screen of rig #${id} could not finish (check): ${m.slice(0, MAX_REASON_LEN)}. Nothing to sign.`, true);
      return;
    }
    rec.artifact = {
      file: r.file,
      hash: r.hash,
      verdict: r.verdict,
      circuits: r.circuits,
      circuitId: r.circuitId,
      taskId: r.taskId,
      bscBlock: r.bscBlock,
      xlayerBlock: r.xlayerBlock,
      verified: r.verify.ran && r.verify.ok && independent(r.hosts),
    };
    rec.hosts = { ...r.hosts };
    const cls = classifyReasons(r.reasons);
    const verdictPass = r.verdict === "PASS" && cls.kind === "pass";
    if (!verdictPass && cls.kind === "protocol") {
      // not this rig's fault: the queue stops until a human reviews the change and the keeper restarts
      rec.status = "queued";
      rec.attempts = Math.max(0, rec.attempts - 1);
      rec.notBefore = now;
      const reason = clip(r.reasons.filter((x) => classifyReasons([x]).kind === "protocol"))[0] ?? "protocol check";
      if (this.protocolPause === null) {
        this.protocolPause = reason;
        this.x.alert("screen:pause", `Screen queue paused: ${reason}. Review the TapeOut change; runs resume after a keeper restart.`, true);
      }
      return;
    }
    if (!verdictPass && cls.kind === "transient") return this.ladder(rec, clip(r.reasons)[0] ?? "transient", now);
    if (!verdictPass && cls.kind === "check") {
      this.setError(rec, "check", clip(r.reasons), now);
      this.x.alert(`screen:error:${id}:${short(r.hash)}`, `Screen of rig #${id} could not finish (check): ${clip(r.reasons)[0] ?? ""}. Nothing to sign.`, true);
      return;
    }
    // PASS, or a FAIL whose reasons are all rig-level: both must be reproduced on the second providers
    if (r.verify.transient) return this.ladder(rec, `second provider: ${clip(r.verify.messages)[0] ?? "unreadable"}`, now);
    // fail closed (Q2): a reproduction served by the check's own provider is no reproduction, whatever the job said
    if (r.verify.ran && r.verify.ok && !independent(r.hosts)) {
      this.setError(rec, "verify", ["the check and the reproduction were served by the same provider"], now);
      this.x.alert(`screen:verify:${id}:${short(r.hash)}`, `Screen of rig #${id}: the check and the reproduction were served by the same provider (${r.hosts.checkBsc}). Nothing to sign.`, true);
      return;
    }
    if (!(r.verify.ran && r.verify.ok)) {
      this.setError(rec, "verify", clip(r.verify.messages), now);
      this.x.alert(`screen:verify:${id}:${short(r.hash)}`, `Screen of rig #${id} was not reproduced on the second provider: ${clip(r.verify.messages).join("; ")}. Nothing to sign.`, true);
      return;
    }
    if (verdictPass) {
      rec.status = "pass";
      rec.code = null;
      rec.reasons = [];
      rec.retryAt = null;
      const a = rec.artifact;
      const link = `${this.x.cfg?.appUrl ?? ""}/#/app/owner`;
      this.x.alert(
        `screen:pass:${id}:${short(r.hash)}`,
        `Screen PASS for rig #${id} (task ${a.taskId ?? "?"}, BSC block ${a.bscBlock}), reproduced on a second provider. artifactHash ${r.hash}. Sign recordPass on the owner page: ${link}. It counts ${delayText(this.delay)}.`,
        true,
      );
      return;
    }
    rec.status = "fail";
    rec.code = cls.kind === "fail" ? cls.code : null;
    rec.reasons = clip(r.reasons);
    rec.retryAt = null;
    this.x.alert(`screen:fail:${id}:${short(r.hash)}`, `Screen FAIL for rig #${id}: ${rec.reasons[0] ?? ""}. Nothing to sign.`, true);
  }

  /** Transient failures: up to MAX_ATTEMPTS runs, 10 minutes apart, then an error the miner may retry after 6 h. */
  private ladder(rec: ScreenRecord, why: string, now: number): void {
    if (rec.attempts < MAX_ATTEMPTS) {
      rec.status = "queued";
      rec.notBefore = now + RETRY_LADDER_SEC;
      rec.code = null;
      rec.reasons = [why.slice(0, MAX_REASON_LEN)];
      this.x.alert(`screen:transient:${rec.rigId}`, `Screen of rig #${rec.rigId} hit a transient failure (run ${rec.attempts} of ${MAX_ATTEMPTS}): ${why.slice(0, MAX_REASON_LEN)}. Retrying in 10 minutes.`, false);
      return;
    }
    this.setError(rec, "transient", [why], now, TRANSIENT_RETRY_SEC);
    this.x.alert(`screen:error:${rec.rigId}:${now}`, `Screen of rig #${rec.rigId} could not finish (transient, ${MAX_ATTEMPTS} runs): ${why.slice(0, MAX_REASON_LEN)}. Nothing to sign.`, true);
  }

  private setError(rec: ScreenRecord, code: ErrorCode, reasons: readonly string[], now: number, after = ERROR_RETRY_SEC): void {
    rec.status = "error";
    rec.code = code;
    rec.reasons = clip(reasons);
    rec.retryAt = now + after;
    rec.updatedAt = now;
  }
}
