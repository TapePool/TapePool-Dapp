import { describe, expect, it } from 'vitest';
import { createRpc, isHeavy, RpcError } from '../src/chain/rpc';

type Reply = { result?: unknown; error?: { code: number; message: string }; status?: number } | Error;

function harness(replies: Reply[], opts: { gapMs?: number } = {}) {
  const t = { ms: 0 };
  const sleeps: number[] = [];
  const starts: { method: string; at: number }[] = [];
  const queue = [...replies];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string };
    starts.push({ method: body.method, at: t.ms });
    const r = queue.shift() ?? { result: '0x' };
    if (r instanceof Error) throw r;
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: r.result, error: r.error }) } as Response;
  }) as unknown as typeof fetch;
  const rpc = createRpc({
    url: 'https://rpc.example',
    fetch: fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
      t.ms += ms;
    },
    clock: () => t.ms,
    gapMs: opts.gapMs ?? 250,
  });
  return { rpc, sleeps, starts, t, left: () => queue.length };
}

describe('which requests are heavy', () => {
  it('log queries, blocks by number and calls at an old block are; head reads and latest calls are not', () => {
    expect(isHeavy('eth_getLogs', [{}])).toBe(true);
    expect(isHeavy('eth_getBlockByNumber', ['0x10', false])).toBe(true);
    expect(isHeavy('eth_getBlockByNumber', ['latest', false])).toBe(false);
    expect(isHeavy('eth_call', [{}, '0x4651a3'])).toBe(true);
    expect(isHeavy('eth_call', [{}, 'latest'])).toBe(false);
    expect(isHeavy('eth_gasPrice', [])).toBe(false);
    expect(isHeavy('eth_chainId', undefined)).toBe(false);
  });
});

describe('createRpc', () => {
  it('returns the result of a call', async () => {
    const h = harness([{ result: '0xabc' }]);
    expect(await h.rpc({ method: 'eth_call', params: [{}, 'latest'] })).toBe('0xabc');
  });

  it('spaces heavy requests at least 250 ms apart, however many are asked at once', async () => {
    const h = harness(Array.from({ length: 6 }, (_, i) => ({ result: i })));
    const out = await Promise.all(Array.from({ length: 6 }, () => h.rpc({ method: 'eth_getLogs', params: [{}] })));
    expect(out).toHaveLength(6);
    for (let i = 1; i < h.starts.length; i++) expect((h.starts[i]?.at ?? 0) - (h.starts[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(250);
  });

  it('does not delay a head read behind the heavy lane', async () => {
    const h = harness([{ result: 1 }, { result: 2 }, { result: 3 }]);
    await Promise.all([h.rpc({ method: 'eth_getLogs', params: [{}] }), h.rpc({ method: 'eth_getLogs', params: [{}] }), h.rpc({ method: 'eth_gasPrice' })]);
    expect(h.starts.find((s) => s.method === 'eth_gasPrice')?.at).toBe(0);
  });

  it('retries "over rate limit" (-32016) with a growing pause, then succeeds', async () => {
    const limit = { error: { code: -32016, message: 'over rate limit' } };
    const h = harness([limit, limit, { result: 'ok' }]);
    expect(await h.rpc({ method: 'eth_getLogs', params: [{}] })).toBe('ok');
    expect(h.sleeps.filter((s) => s !== 250 && s > 0)).toEqual([500, 1_500]);
  });

  it('gives up after the last pause and throws the node error with its code', async () => {
    const limit = { error: { code: -32016, message: 'over rate limit' } };
    const h = harness([limit, limit, limit, limit, limit]);
    const err = await h.rpc({ method: 'eth_call', params: [{}, 'latest'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(-32016);
    expect(h.sleeps).toEqual([500, 1_500, 4_000]);
  });

  it('retries an HTTP 429 the same way', async () => {
    const h = harness([{ status: 429 }, { result: 'ok' }]);
    expect(await h.rpc({ method: 'eth_call', params: [{}, 'latest'] })).toBe('ok');
  });

  it('retries a node that has not seen the block yet', async () => {
    const h = harness([{ error: { code: -32000, message: 'header not found' } }, { result: 'ok' }]);
    expect(await h.rpc({ method: 'eth_call', params: [{}, '0x10'] })).toBe('ok');
  });

  it('never retries a revert', async () => {
    const h = harness([{ error: { code: 3, message: 'execution reverted' } }, { result: 'unused' }]);
    await expect(h.rpc({ method: 'eth_call', params: [{}, 'latest'] })).rejects.toMatchObject({ code: 3 });
    expect(h.left()).toBe(1);
  });

  it('retries a lost connection once', async () => {
    const h = harness([new TypeError('failed to fetch'), { result: 'ok' }]);
    expect(await h.rpc({ method: 'eth_call', params: [{}, 'latest'] })).toBe('ok');
    const h2 = harness([new TypeError('failed to fetch'), new TypeError('failed to fetch'), { result: 'unused' }]);
    await expect(h2.rpc({ method: 'eth_call', params: [{}, 'latest'] })).rejects.toThrow('failed to fetch');
    expect(h2.left()).toBe(1);
  });

  it('sends a JSON-RPC 2.0 POST without credentials', async () => {
    let seen: { init: RequestInit; url: string } | null = null;
    const rpc = createRpc({
      url: 'https://rpc.example',
      fetch: (async (url: string, init: RequestInit) => {
        seen = { init, url };
        return { ok: true, status: 200, json: async () => ({ result: '0x1' }) } as Response;
      }) as unknown as typeof fetch,
    });
    await rpc({ method: 'eth_blockNumber' });
    const s = seen as unknown as { init: RequestInit; url: string };
    expect(s.url).toBe('https://rpc.example');
    expect(s.init.method).toBe('POST');
    expect(s.init.credentials).toBe('omit');
    expect(JSON.parse(String(s.init.body))).toMatchObject({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [] });
  });
});
