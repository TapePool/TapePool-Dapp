import type { Address, Sec } from '../model';

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

export function parsePosition(body: unknown): KeeperPosition | null {
  if (!isObj(body)) return null;
  const { netDeposited, transferred, firstDepositAt, indexedTo, indexedToTime } = body;
  if (typeof netDeposited !== 'string' || !INT.test(netDeposited)) return null;
  if (typeof transferred !== 'boolean' || !isNat(indexedTo)) return null;
  if (firstDepositAt !== null && !isNat(firstDepositAt)) return null;
  if (indexedToTime !== null && !isNat(indexedToTime)) return null;
  return { netDeposited: BigInt(netDeposited), transferred, firstDepositAt, indexedTo, indexedToTime };
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
  };
}
