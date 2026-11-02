import { describe, expect, it } from 'vitest';
import { createKeeperClient, growthOf, parsePosition, parseStats, type KeeperPosition } from '../src/chain/keeper';
import { cleanKeeperUrl } from '../src/config';
import { pctFromDecimalString } from '../src/logic/format';

const stats = { asOf: 1_792_000_000, block: 73_900_000, sharePrice: '100500000', apy7d: '0.050000', history: [{ day: 20, block: 1, sharePrice: '1', time: 1 }] };
const pos = { netDeposited: '500000000', transferred: false, firstDepositAt: 1_791_000_000, indexedTo: 73_999_990, indexedToTime: 1_792_000_000 };

describe('parseStats', () => {
  it('reads the contract: numbers for asOf and block, decimal strings for the price and the APY', () => {
    expect(parseStats(stats)).toEqual({ asOf: 1_792_000_000, block: 73_900_000, sharePrice: 100_500_000n, apy7d: '0.050000' });
  });

  it('keeps a null APY and a negative one', () => {
    expect(parseStats({ ...stats, apy7d: null })?.apy7d).toBeNull();
    expect(parseStats({ ...stats, apy7d: '-0.001234' })?.apy7d).toBe('-0.001234');
  });

  it('refuses anything else', () => {
    for (const bad of [null, [], 'x', { ...stats, asOf: '1' }, { ...stats, block: -1 }, { ...stats, block: 1.5 }, { ...stats, sharePrice: 'abc' }, { ...stats, sharePrice: 100 }, { ...stats, apy7d: '5%' }, { ...stats, apy7d: 0.05 }, { ...stats, apy7d: '0.05' }, { error: 'not ready' }]) {
      expect(parseStats(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('parsePosition', () => {
  it('reads the contract, including a negative net deposit and null times', () => {
    expect(parsePosition(pos)).toEqual({ netDeposited: 500_000_000n, transferred: false, firstDepositAt: 1_791_000_000, indexedTo: 73_999_990, indexedToTime: 1_792_000_000 });
    expect(parsePosition({ ...pos, netDeposited: '-12', firstDepositAt: null, indexedToTime: null })).toMatchObject({ netDeposited: -12n, firstDepositAt: null, indexedToTime: null });
    // an unknown address: 200 with "0", false, null
    expect(parsePosition({ netDeposited: '0', transferred: false, firstDepositAt: null, indexedTo: 5, indexedToTime: null })).not.toBeNull();
  });

  it('refuses anything else', () => {
    for (const bad of [null, {}, { ...pos, netDeposited: 5 }, { ...pos, netDeposited: '1.5' }, { ...pos, transferred: 'no' }, { ...pos, indexedTo: '5' }, { ...pos, firstDepositAt: '1' }]) {
      expect(parsePosition(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('growthOf', () => {
  const p = (over: Partial<KeeperPosition> = {}): KeeperPosition => ({ netDeposited: 500_000_000n, transferred: false, firstDepositAt: 1, indexedTo: 5, indexedToTime: 1_000, ...over });

  it('is the value of the shares minus what was put in', () => {
    expect(growthOf(505_000_000n, p(), 1_030)).toBe(5_000_000n);
    expect(growthOf(498_000_000n, p(), 1_030)).toBe(-2_000_000n); // the share price can fall
  });

  it('is a dash when the keeper cannot say', () => {
    expect(growthOf(1n, null, 1_030)).toBeNull();
    expect(growthOf(1n, p({ transferred: true }), 1_030)).toBeNull();
    expect(growthOf(1n, p({ indexedToTime: null }), 1_030)).toBeNull();
    expect(growthOf(1n, p(), 1_000 + 3_601)).toBeNull(); // the index lags chain time by more than an hour
    expect(growthOf(1n, p(), 1_000 + 3_600)).not.toBeNull();
  });
});

describe('the client', () => {
  const reply = (status: number, body: unknown) => (async () => ({ status, json: async () => body }) as Response) as unknown as typeof fetch;

  it('with no base URL never calls fetch', async () => {
    let called = false;
    const c = createKeeperClient(
      null,
      (async () => {
        called = true;
        throw new Error('x');
      }) as unknown as typeof fetch,
    );
    expect(await c.stats()).toEqual({ reachable: false, data: null });
    expect(await c.position('0x0000000000000000000000000000000000000001')).toEqual({ reachable: false, data: null });
    expect(called).toBe(false);
  });

  it('GETs the two routes with no header and no cookies', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return { status: 200, json: async () => (url.endsWith('/v1/stats') ? stats : pos) } as Response;
    }) as unknown as typeof fetch;
    const c = createKeeperClient('https://keeper.example/api', f);
    expect((await c.stats()).data?.sharePrice).toBe(100_500_000n);
    expect((await c.position('0x00000000000000000000000000000000000000aA')).data?.netDeposited).toBe(500_000_000n);
    expect(seen.map((s) => s.url)).toEqual(['https://keeper.example/api/v1/stats', 'https://keeper.example/api/v1/position/0x00000000000000000000000000000000000000aA']);
    for (const s of seen) {
      expect(s.init?.method).toBe('GET');
      expect(s.init?.headers).toBeUndefined();
      expect(s.init?.credentials).toBe('omit');
    }
  });

  it('503 "not ready" is reachable with no data; a network error is not reachable', async () => {
    expect(await createKeeperClient('https://k', reply(503, { error: 'not ready' })).stats()).toEqual({ reachable: true, data: null });
    expect(await createKeeperClient('https://k', reply(400, { error: 'bad' })).position('0x0000000000000000000000000000000000000001')).toEqual({ reachable: true, data: null });
    const down = (async () => {
      throw new TypeError('failed to fetch');
    }) as unknown as typeof fetch;
    expect(await createKeeperClient('https://k', down).stats()).toEqual({ reachable: false, data: null });
  });

  it('an answer that is not JSON counts as unreachable; JSON of the wrong shape as no data', async () => {
    const notJson = (async () =>
      ({
        status: 200,
        json: async () => {
          throw new SyntaxError('x');
        },
      }) as unknown as Response) as unknown as typeof fetch;
    expect((await createKeeperClient('https://k', notJson).stats()).reachable).toBe(false);
    expect(await createKeeperClient('https://k', reply(200, { hello: 1 })).stats()).toEqual({ reachable: true, data: null });
  });
});

describe('KEEPER_URL', () => {
  it('must be https, or http on a local host; the trailing slash goes', () => {
    expect(cleanKeeperUrl('https://keeper.example/')).toBe('https://keeper.example');
    expect(cleanKeeperUrl('https://keeper.example/api//')).toBe('https://keeper.example/api');
    expect(cleanKeeperUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(cleanKeeperUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
    for (const bad of [undefined, '', 'http://keeper.example', 'ftp://x', 'javascript:alert(1)', 'not a url']) expect(cleanKeeperUrl(bad), String(bad)).toBeNull();
  });
});

describe('the keeper APY shown as a percentage', () => {
  it('turns the six-place fraction into a percentage, negative values included', () => {
    expect(pctFromDecimalString('0.050000')).toBe('5.00%');
    expect(pctFromDecimalString('0.091900')).toBe('9.19%');
    expect(pctFromDecimalString('1.234567')).toBe('123.46%');
    expect(pctFromDecimalString('-0.012300')).toBe('-1.23%');
    expect(pctFromDecimalString('-0.000000')).toBe('0.00%');
    expect(pctFromDecimalString('0')).toBe('0.00%');
    expect(pctFromDecimalString('nope')).toBe('—');
    expect(pctFromDecimalString('5%')).toBe('—');
  });
});
