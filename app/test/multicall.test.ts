import { describe, expect, it } from 'vitest';
import { erc20Abi, tapePoolAbi } from '../src/chain/abi';
import { call, CHUNK, multicall, val } from '../src/chain/multicall';
import { FakeChain } from './fakeChain';
import { A } from './world';

const TOKEN = A(0x70c3);

describe('multicall', () => {
  it('runs a thousand-byte batch as one request, where viem would split it into many', async () => {
    const chain = new FakeChain().on(TOKEN, erc20Abi, { balanceOf: ([a]: readonly unknown[]) => BigInt(String(a).length) });
    const calls = Array.from({ length: CHUNK }, (_, i) => call<bigint>(TOKEN, erc20Abi, 'balanceOf', [A(i + 1)]));
    const out = await multicall(chain, chain.multicall, calls);
    expect(out).toHaveLength(CHUNK);
    expect(chain.calls).toHaveLength(1);
    expect(chain.calls[0]?.inner).toBe(CHUNK);
  });

  it('splits only above the chunk size, keeping the order of the answers', async () => {
    const chain = new FakeChain().on(TOKEN, erc20Abi, { balanceOf: ([a]: readonly unknown[]) => BigInt(parseInt(String(a).slice(-6), 16)) });
    const n = CHUNK * 2 + 5;
    const calls = Array.from({ length: n }, (_, i) => call<bigint>(TOKEN, erc20Abi, 'balanceOf', [A(i + 1)]));
    const out = await multicall(chain, chain.multicall, calls);
    expect(chain.calls.map((c) => c.inner)).toEqual([CHUNK, CHUNK, 5]);
    expect(out.map((r) => (r.ok ? r.value : -1n))).toEqual(Array.from({ length: n }, (_, i) => BigInt(i + 1)));
  });

  it('a read that reverts, has no handler or answers with nothing is { ok: false }, the rest still decode', async () => {
    const chain = new FakeChain()
      .on(TOKEN, erc20Abi, {
        balanceOf: ([a]: readonly unknown[]) => {
          if (a === A(2)) throw new Error('reverted');
          return 7n;
        },
      });
    const [a, b, c, d] = await multicall(chain, chain.multicall, [
      call<bigint>(TOKEN, erc20Abi, 'balanceOf', [A(1)]),
      call<bigint>(TOKEN, erc20Abi, 'balanceOf', [A(2)]),
      call<bigint>(TOKEN, erc20Abi, 'allowance', [A(1), A(2)]), // no handler
      call<bigint>(A(0xdead), erc20Abi, 'balanceOf', [A(1)]), // no code: success with empty data, which does not decode
    ]);
    expect(a).toEqual({ ok: true, value: 7n });
    expect(b.ok).toBe(false);
    expect(c.ok).toBe(false);
    expect(d.ok).toBe(false);
    expect(val(b, 0n)).toBe(0n);
    expect(val(a, 0n)).toBe(7n);
  });

  it('a node that is down rejects the whole batch', async () => {
    const chain = new FakeChain();
    chain.down = true;
    await expect(multicall(chain, chain.multicall, [call<bigint>(TOKEN, erc20Abi, 'balanceOf', [A(1)])])).rejects.toThrow('node down');
  });

  it('passes the block and the code override on to the request', async () => {
    const chain = new FakeChain().on(A(0x1e45), tapePoolAbi, { fee: 5n });
    await multicall(chain, chain.multicall, [call<bigint>(A(0x1e45), tapePoolAbi, 'fee', [0, 1n])], { block: 123n, code: { [A(0x1e45)]: '0x6080' } });
    expect(chain.calls[0]).toMatchObject({ block: 123n });
    expect(chain.calls[0]?.code).toEqual({ [A(0x1e45)]: '0x6080' });
  });

  it('an empty batch makes no request', async () => {
    const chain = new FakeChain();
    expect(await multicall(chain, chain.multicall, [])).toEqual([]);
    expect(chain.calls).toHaveLength(0);
  });
});
