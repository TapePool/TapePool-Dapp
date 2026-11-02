/**
 * JSON-RPC over `fetch` for a public endpoint, with the two things the public X Layer node needs from a client
 * (SPEC-PHASE5-APP §5.5): requests that read old state or logs are spaced apart, and "over rate limit" (-32016)
 * is retried with a growing pause. Measured on 2026-10-23: about five back-to-back `eth_getLogs` trip -32016,
 * and one call per 250 ms passed forty in a row.
 *
 * The result is an EIP-1193 style `request`, so viem's `createClient` can sit on top of it with `custom`.
 */

export type RpcRequest = (args: { method: string; params?: unknown }) => Promise<unknown>;

/** What viem's own error mapping looks at: a numeric `code`, and `data` for a revert. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface RpcOptions {
  url: string;
  fetch?: typeof fetch;
  /** Wait; replaced by a fake in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds; replaced by a fake in tests. */
  clock?: () => number;
  /** Least time between the starts of two "heavy" requests. */
  gapMs?: number;
  /** Pauses before each retry of a rate-limited or flaky request. */
  backoffMs?: readonly number[];
  timeoutMs?: number;
}

export const DEFAULT_GAP_MS = 250;
export const DEFAULT_BACKOFF_MS = [500, 1_500, 4_000] as const;

const RATE_LIMITED = -32016;

/**
 * Requests that cost the node more than a head read: log queries, a block looked up by number, and a call at an
 * old block. They share one lane, one at a time and spaced apart.
 */
export function isHeavy(method: string, params: unknown): boolean {
  if (method === 'eth_getLogs') return true;
  const p = Array.isArray(params) ? params : [];
  if (method === 'eth_getBlockByNumber') return typeof p[0] === 'string' && !['latest', 'pending', 'safe', 'finalized', 'earliest'].includes(p[0]);
  if (method === 'eth_call') return typeof p[1] === 'string' && p[1] !== 'latest' && p[1] !== 'pending';
  return false;
}

/** How many times a failure is retried: a rate limit and a node that has not seen the block yet clear with time; a lost connection gets one more try; a revert or a bad request none. */
function retriesFor(e: unknown, max: number): number {
  if (e instanceof RpcError) {
    if (e.code === RATE_LIMITED || e.code === 429) return max;
    if (e.code === -32000 && /header not found|block not found|unknown block|too many/i.test(e.message)) return max;
    return e.code === -32603 ? 1 : 0; // an HTTP 5xx from the gateway
  }
  return 1; // network error, timeout, bad JSON from a proxy
}

export function createRpc(o: RpcOptions): RpcRequest {
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = o.clock ?? (() => performance.now());
  const gap = o.gapMs ?? DEFAULT_GAP_MS;
  const backoff = o.backoffMs ?? DEFAULT_BACKOFF_MS;
  const timeout = o.timeoutMs ?? 15_000;
  let id = 0;
  // the heavy lane: each request waits for the one before it and for the gap after that one started
  let lane: Promise<void> = Promise.resolve();
  let lastStart = Number.NEGATIVE_INFINITY;

  async function once(method: string, params: unknown): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await doFetch(o.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }),
        signal: ctl.signal,
        credentials: 'omit',
      });
      if (res.status === 429) throw new RpcError('HTTP 429', 429);
      if (!res.ok) throw new RpcError(`HTTP ${res.status}`, -32603);
      const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
      if (body.error) throw new RpcError(body.error.message, body.error.code, body.error.data);
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async function withRetry(method: string, params: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(method, params);
      } catch (e) {
        const pause = backoff[attempt];
        if (pause === undefined || attempt >= retriesFor(e, backoff.length)) throw e;
        await sleep(pause);
      }
    }
  }

  return async ({ method, params }) => {
    if (!isHeavy(method, params)) return withRetry(method, params);
    const turn = lane.then(async () => {
      const wait = lastStart + gap - clock();
      if (wait > 0) await sleep(wait);
      lastStart = clock();
    });
    lane = turn.catch(() => undefined);
    await turn;
    return withRetry(method, params);
  };
}
