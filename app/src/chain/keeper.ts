import type { Address, Hex, PoolTransaction, ScreenArtifact, ScreenRecord, ScreensView, ScreenStatus, Sec } from '../model';

/**
 * The keeper's read-only routes (SPEC-PHASE5-APP §8). Two plain GETs with no custom header, so the browser sends
 * no preflight. Whatever comes back is data: it is parsed strictly, and anything unexpected reads as "the keeper
 * has nothing to say", which shows as a dash.
 */

export interface KeeperStats {
  asOf: Sec;
  block: number;
  /** Raw BEM per 1 whole tpBEM (100000000 is par). */
  sharePrice: bigint;
  /** A fraction as a six-place signed decimal string (`"0.050000"` is 5%), or null. */
  apy7d: string | null;
}

export interface KeeperPosition {
  transactions?: PoolTransaction[];
  netDeposited: bigint;
  transferred: boolean;
  firstDepositAt: Sec | null;
  indexedTo: number;
  indexedToTime: Sec | null;
}

/** `ok` is false when nothing answered; `data` is null when it answered "not ready" or with something unreadable. */
export interface KeeperAnswer<T> {
  reachable: boolean;
  data: T | null;
}

export interface KeeperClient {
  stats(): Promise<KeeperAnswer<KeeperStats>>;
  position(address: Address): Promise<KeeperAnswer<KeeperPosition>>;
  /** `GET /v1/screens` (SPEC-PHASE5-REGISTER §6.2), for the RigScreen of this app's address book only. */
  screens?(screen: Address): Promise<KeeperAnswer<ScreensView>>;
}

/* ───────── "Register to borrow" (SPEC-PHASE5-REGISTER §6.2) ───────── */

const STATUSES: readonly ScreenStatus[] = ['queued', 'checking', 'pass', 'fail', 'error', 'recorded', 'revoked'];
const CODES: readonly string[] = ['no-voucher', 'voucher-mismatch', 'processor', 'not-mining', 'task', 'circuit', 'wrong-output', 'differs', 'counterexample', 'too-wide', 'transient', 'verify', 'check'];
const DEC = /^(0|[1-9]\d{0,29})$/;
const RIG = /^(0|[1-9]\d{0,14})$/;
const FILE = /^[a-z0-9-]{1,80}\.json$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_TIME = 253402300799;
const isTime = (v: unknown): v is number => isNat(v) && v <= MAX_TIME;
const decOrNull = (v: unknown): bigint | null | undefined => (v === null ? null : typeof v === 'string' && DEC.test(v) ? BigInt(v) : undefined);

function parseArtifact(v: unknown): ScreenArtifact | null | undefined {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  const { file, hash, verdict, circuits, circuitId, taskId, bscBlock, verified } = v;
  if (typeof file !== 'string' || !FILE.test(file) || typeof hash !== 'string' || !HASH.test(hash)) return undefined;
  if (verdict !== 'PASS' && verdict !== 'FAIL') return undefined;
  if (circuits !== null && !(typeof circuits === 'string' && ADDRESS.test(circuits))) return undefined;
  const cid = decOrNull(circuitId);
  const tid = decOrNull(taskId);
  if (cid === undefined || tid === undefined || typeof verified !== 'boolean') return undefined;
  const block = typeof bscBlock === 'string' && DEC.test(bscBlock) ? BigInt(bscBlock) : null;
  return { file, hash: hash.toLowerCase() as Hex, verdict, circuits: circuits as Address | null, circuitId: cid, taskId: tid, bscBlock: block, verified };
}

const HOST_RE = /^[a-z0-9.-]{1,253}$/;
/** Which provider served each side (Q2): null when absent, undefined when malformed (the record is then dropped). */
function parseHosts(v: unknown): ScreenRecord['hosts'] | undefined {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return undefined;
  const ok = (x: unknown) => typeof x === 'string' && HOST_RE.test(x);
  const { checkBsc, checkXlayer, verifyBsc, verifyXlayer } = v;
  if (!ok(checkBsc) || !ok(checkXlayer) || !(verifyBsc === null || ok(verifyBsc)) || !(verifyXlayer === null || ok(verifyXlayer))) return undefined;
  return { checkBsc: checkBsc as string, checkXlayer: checkXlayer as string, verifyBsc: verifyBsc as string | null, verifyXlayer: verifyXlayer as string | null };
}

/** One record, or null when any field is not what §6.2 says (the record is then dropped, never guessed). */
export function parseScreenRecord(v: unknown): ScreenRecord | null {
  if (!isObj(v)) return null;
  const { rigId, status, requestedAt, updatedAt, attempts, retryAt, code, reasons, artifact, hosts } = v;
  if (typeof rigId !== 'string' || !RIG.test(rigId) || !STATUSES.includes(status as ScreenStatus)) return null;
  if (!isTime(requestedAt) || !isTime(updatedAt) || !isNat(attempts) || attempts > 1_000) return null;
  if (retryAt !== null && !isTime(retryAt)) return null;
  if (code !== null && !(typeof code === 'string' && CODES.includes(code))) return null;
  if (!Array.isArray(reasons) || reasons.length > 8 || !reasons.every((r) => typeof r === 'string' && r.length <= 300)) return null;
  const a = parseArtifact(artifact);
  if (a === undefined) return null;
  const h = parseHosts(hosts);
  if (h === undefined) return null;
  return { rigId: Number(rigId), status: status as ScreenStatus, requestedAt, updatedAt, attempts, retryAt, code: code as ScreenRecord['code'], reasons: reasons as string[], artifact: a, hosts: h };
}

/** The list, or null when its shape is wrong or it belongs to another RigScreen than `screen`. */
export function parseScreens(body: unknown, screen: Address): ScreensView | null {
  if (!isObj(body)) return null;
  const { open, paused, screen: s, screens } = body;
  if (typeof open !== 'boolean' || typeof paused !== 'boolean' || typeof s !== 'string' || s.toLowerCase() !== screen.toLowerCase()) return null;
  if (!Array.isArray(screens) || screens.length > 500) return null;
  const records: Record<string, ScreenRecord> = {};
  for (const v of screens) {
    const r = parseScreenRecord(v);
    if (r) records[String(r.rigId)] = r;
  }
  return { open, paused, records };
}

export type RegisterAnswer =
  | { status: 'queued' | 'known'; record: ScreenRecord }
  | { status: 'recorded' }
  | { status: 'refused'; reason: string }
  | { status: 'unreachable' };

/**
 * `POST /v1/register` with `{"rigId":"<id>"}`. A JSON POST, so the browser sends a preflight the keeper answers for the app's
 * origins. Whatever comes back is data: only the known statuses count, and anything else reads as "unreachable".
 */
export async function requestRegister(base: string | null, rigId: number, doFetch: typeof fetch | undefined, timeoutMs = 15_000): Promise<RegisterAnswer> {
  if (base === null || !doFetch || !Number.isSafeInteger(rigId) || rigId < 0) return { status: 'unreachable' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await doFetch(`${base}/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rigId: String(rigId) }),
      credentials: 'omit',
      signal: ctl.signal,
    });
    if (res.status !== 200) return { status: 'unreachable' };
    const body = (await res.json()) as unknown;
    if (!isObj(body)) return { status: 'unreachable' };
    const { status, reason, screen } = body;
    if (status === 'recorded') return { status };
    if (status === 'refused') return { status, reason: typeof reason === 'string' ? reason.slice(0, 120) : 'unknown' };
    if (status === 'queued' || status === 'known') {
      const record = parseScreenRecord(screen);
      return record && record.rigId === rigId ? { status, record } : { status: 'unreachable' };
    }
    return { status: 'unreachable' };
  } catch {
    return { status: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** The artifact's bytes (`GET /v1/screens/<id>/artifact`), at most `max` of them; null on any failure. */
export async function fetchArtifact(base: string | null, rigId: number, doFetch: typeof fetch | undefined, timeoutMs = 30_000, max = 2_000_000): Promise<Uint8Array | null> {
  if (base === null || !doFetch || !Number.isSafeInteger(rigId) || rigId < 0) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await doFetch(`${base}/v1/screens/${rigId}/artifact`, { method: 'GET', credentials: 'omit', signal: ctl.signal });
    if (res.status !== 200) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length > 0 && bytes.length <= max ? bytes : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const APY = /^-?\d{1,6}\.\d{6}$/;
const INT = /^-?\d{1,40}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export function parseStats(body: unknown): KeeperStats | null {
  if (!isObj(body)) return null;
  const { asOf, block, sharePrice, apy7d } = body;
  if (!isNat(asOf) || !isNat(block) || typeof sharePrice !== 'string' || !/^\d{1,40}$/.test(sharePrice)) return null;
  if (apy7d !== null && !(typeof apy7d === 'string' && APY.test(apy7d))) return null;
  return { asOf, block, sharePrice: BigInt(sharePrice), apy7d };
}

export function parseTransactions(value: unknown): PoolTransaction[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return;
  const rows: PoolTransaction[] = [];
  for (const entry of value) {
    if (!isObj(entry)) return;
    const { kind, hash, time, amount } = entry;
    if (kind !== 'supply' && kind !== 'withdraw' && kind !== 'borrow' && kind !== 'repay') return;
    if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash) || !isNat(time) || time > 253402300799) return;
    if (typeof amount !== 'string' || !/^\d{1,78}$/.test(amount)) return;
    rows.push({ kind, hash: hash as PoolTransaction['hash'], time, amount: BigInt(amount) });
  }
  return rows;
}

export function parsePosition(body: unknown): KeeperPosition | null {
  if (!isObj(body)) return null;
  const { netDeposited, transferred, firstDepositAt, indexedTo, indexedToTime } = body;
  if (typeof netDeposited !== 'string' || !INT.test(netDeposited)) return null;
  if (typeof transferred !== 'boolean' || !isNat(indexedTo)) return null;
  if (firstDepositAt !== null && !isNat(firstDepositAt)) return null;
  if (indexedToTime !== null && !isNat(indexedToTime)) return null;
  return { netDeposited: BigInt(netDeposited), transferred, firstDepositAt, indexedTo, indexedToTime, transactions: parseTransactions(body.transactions) };
}

/**
 * Growth since deposit: what the shares are worth now minus what the account put in (SPEC-PHASE5-APP §8.2).
 * Null ("—") when the keeper cannot say: shares were transferred, the index has no timestamp yet, or it lags
 * chain time by more than an hour.
 */
export function growthOf(value: bigint, p: KeeperPosition | null, now: Sec): bigint | null {
  if (!p || p.transferred || p.indexedToTime === null) return null;
  if (now - p.indexedToTime > 3_600) return null;
  return value - p.netDeposited;
}

/** A keeper at `base` (no trailing slash), or a client that never touches the network when there is none. */
export function createKeeperClient(base: string | null, doFetch: typeof fetch = globalThis.fetch?.bind(globalThis), timeoutMs = 8_000): KeeperClient {
  async function get<T>(path: string, parse: (b: unknown) => T | null): Promise<KeeperAnswer<T>> {
    if (base === null || !doFetch) return { reachable: false, data: null };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, { method: 'GET', credentials: 'omit', signal: ctl.signal });
      if (res.status !== 200) return { reachable: true, data: null }; // 503 "not ready" until the first refresh, or a refusal
      return { reachable: true, data: parse(await res.json()) };
    } catch {
      return { reachable: false, data: null };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    stats: () => get('/v1/stats', parseStats),
    position: (address) => get(`/v1/position/${address}`, parsePosition),
    screens: (screen) => get('/v1/screens', (b) => parseScreens(b, screen)),
  };
}
