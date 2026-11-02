import type { AddressBook } from '../config';
import { timely } from '../logic/borrow';
import type { ReportRaw } from '../logic/bscReader';
import type { Address } from '../model';
import { feedReceiverAbi } from './abi';
import { call, multicall, type Result } from './multicall';
import type { Reader } from './reader';

/**
 * The keeper side of "refresh rig data" (SPEC-PHASE5-APP §6.1 step 3) and the wait for the report to show up on
 * X Layer, shared by the keeper path and the self-push.
 */

/* ───────── POST /v1/push ───────── */

export type PushAnswer = { status: 'fresh' | 'queued' } | { status: 'refused'; reason: string } | { status: 'unreachable' };

/**
 * Ask the keeper to push the reports of an agent's collateral. A simple JSON POST: the keeper answers a preflight for
 * this one route. Whatever comes back is data: only the three known statuses count, and a reason is a short string.
 * Anything else (a network failure, a 5xx, a body that is not the expected shape) reads as "unreachable".
 */
export async function requestPush(base: string | null, agent: Address, doFetch: typeof fetch | undefined, timeoutMs = 15_000): Promise<PushAnswer> {
  if (base === null || !doFetch) return { status: 'unreachable' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await doFetch(`${base}/v1/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent }),
      credentials: 'omit',
      signal: ctl.signal,
    });
    if (res.status === 400) return { status: 'refused', reason: 'bad agent address' };
    if (res.status !== 200) return { status: 'unreachable' };
    const body = (await res.json()) as unknown;
    if (typeof body !== 'object' || body === null) return { status: 'unreachable' };
    const { status, reason } = body as { status?: unknown; reason?: unknown };
    if (status === 'fresh' || status === 'queued') return { status };
    if (status === 'refused') return { status: 'refused', reason: typeof reason === 'string' ? reason.slice(0, 120) : 'unknown' };
    return { status: 'unreachable' };
  } catch {
    return { status: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/* ───────── waiting for the reports ───────── */

/** The `observedAt` of the feed's last report for each id (0 when there is none). */
export async function reportTimes(x: Reader, book: AddressBook, ids: readonly number[], block?: bigint): Promise<Map<number, number>> {
  const rows = await multicall(x, book.multicall3, ids.map((id) => call<readonly [ReportRaw, boolean]>(book.receiver, feedReceiverAbi, 'latest', [BigInt(id)])), { block });
  const out = new Map<number, number>();
  ids.forEach((id, i) => {
    const r = rows[i] as Result<readonly [ReportRaw, boolean]>;
    out.set(id, r.ok && r.value[1] ? Number(r.value[0].observedAt) : 0);
  });
  return out;
}

export interface WaitDeps {
  x: Reader;
  book: AddressBook;
  sleep: (ms: number) => Promise<void>;
  /** Monotonic milliseconds. */
  clock: () => number;
}

export const WAIT_REPORT_MS = 120_000;
export const WAIT_POLL_MS = 2_000;

/**
 * Poll the feed until every id has a report that is timely by X Layer's chain time (SPEC-PHASE5-APP §6.3), and, when
 * `notBefore` is given, one observed at or after that BSC time (so a push does not stop at a report that was already
 * there). False when `timeoutMs` passes first. A read that fails is tried again.
 */
export async function waitForReports(d: WaitDeps, ids: readonly number[], o: { timeoutMs?: number; pollMs?: number; notBefore?: number } = {}): Promise<boolean> {
  const t0 = d.clock();
  const timeout = o.timeoutMs ?? WAIT_REPORT_MS;
  for (;;) {
    try {
      const head = await d.x.head();
      const times = await reportTimes(d.x, d.book, ids, head.number);
      if (ids.every((id) => {
        const at = times.get(id) ?? 0;
        return at !== 0 && timely(at, head.timestamp) && at >= (o.notBefore ?? 0);
      })) return true;
    } catch {
      /* a failed read is tried again */
    }
    if (d.clock() - t0 >= timeout) return false;
    await d.sleep(o.pollMs ?? WAIT_POLL_MS);
  }
}
