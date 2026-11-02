import { encodeAbiParameters, encodeErrorResult, toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import { agentFactoryAbi, extraErrorsAbi, reporterAbi, rigAgentAbi, tapePoolAbi } from '../src/chain/abi';
import { errorDetails, errorText, KEEPER, REVERTS, UNKNOWN } from '../src/chain/errors';
import { requestPush } from '../src/chain/feedWait';
import { codeOf, decodeRevert, fromFailure, revertAbi, revertDataOf } from '../src/chain/revert';
import { setLang } from '../src/i18n';
import type { Hex } from '../src/model';

/** SPEC-PHASE5-APP §9: every revert is decoded against the union of the ABIs, and every name has a message. */

const names = (abi: readonly unknown[]): string[] => (abi as { type: string; name: string }[]).filter((i) => i.type === 'error').map((i) => i.name);

/** Example arguments for an error's inputs. */
function sample(inputs: readonly { type: string }[]): unknown[] {
  return inputs.map((i) => (i.type === 'address' ? '0x00000000000000000000000000000000000000aa' : i.type.startsWith('uint') ? 7n : i.type === 'bool' ? true : '0x01'));
}

const encode = (name: string, args?: unknown[]): Hex => {
  const item = (revertAbi as readonly { type: string; name: string; inputs: readonly { type: string }[] }[]).find((i) => i.type === 'error' && i.name === name);
  if (!item) throw new Error(`no error ${name}`);
  return encodeErrorResult({ abi: revertAbi, errorName: name, args: (args ?? sample(item.inputs)) as never } as never);
};

describe('the union of the ABIs a revert is decoded against', () => {
  it('holds the errors of RigAgent, TapePool, AgentFactory, RigReporter and the hand-written list, once each by selector', () => {
    const all = new Set([...names(rigAgentAbi), ...names(tapePoolAbi), ...names(agentFactoryAbi), ...names(reporterAbi), ...names(extraErrorsAbi)]);
    const have = new Set(names(revertAbi));
    for (const n of all) expect(have.has(n), n).toBe(true);
    const selectors = (revertAbi as unknown as { name: string; inputs: { type: string }[] }[]).map((e) => toFunctionSelector(`${e.name}(${e.inputs.map((i) => i.type).join(',')})`));
    expect(new Set(selectors).size).toBe(selectors.length);
  });

  it('decodes the ERC-721 errors of the voucher and the LayerZero fee error', () => {
    for (const n of ['ERC721IncorrectOwner', 'ERC721InsufficientApproval', 'ERC721NonexistentToken', 'LZ_InsufficientFee']) {
      expect(decodeRevert(encode(n))).toMatchObject({ kind: 'revert', name: n });
    }
  });
});

describe('every revert of the §9 table', () => {
  it('has a selector in the union and a message in both languages', () => {
    for (const name of Object.keys(REVERTS)) {
      const data = encode(name);
      const err = decodeRevert(data, { minAdvance: 20_000n, terms: [7, 14] });
      expect(err, name).toMatchObject({ kind: 'revert', name });
      setLang('en', false);
      expect(errorText(err), name).not.toBe(UNKNOWN.en({}));
      setLang('cn', false);
      expect(errorText(err), name).toMatch(/[一-鿿]/);
    }
    setLang('en', false);
  });

  it('fills in the numbers a message names', () => {
    expect(errorText(decodeRevert(encode('WrongOpsFee', [52_000_000_000_000_000n])))).toBe('The operating fee changed. It is now 0.052 OKB. Review and sign again.');
    expect(errorText(decodeRevert(encode('NotOwned', [4127n])))).toBe('A voucher is not in the agent. Move it in first.');
    expect(errorText(decodeRevert(encode('AlreadyCollateral', [4127n])))).toBe('#4127 is already in this agent.');
    expect(errorText(decodeRevert(encode('BelowMinAdvance'), { minAdvance: 1_000_000n }))).toBe('The minimum advance is 0.01 BEM.');
  });

  it('PolicyDenied shows the line of its reason, and names a failed flag when the quote\'s bits are known', () => {
    const e = decodeRevert(encode('PolicyDenied', [7]));
    expect(e).toMatchObject({ kind: 'revert', name: 'PolicyDenied', reason: 7 });
    expect(errorText(e)).toBe('New borrows are paused. Repaying and withdrawals keep working.');
    const denied = decodeRevert(encode('PolicyDenied', [6]), { inputBits: 0b10111 << 7, minAdvance: 20_000n });
    expect(errorText(denied)).toContain('younger than 3 days');
  });

  it('shows a revert nobody knows, a built-in Error(string) and a Panic as "something went wrong" with the raw text as details', () => {
    const unknown = decodeRevert('0xdeadbeef');
    expect(unknown).toMatchObject({ kind: 'unknown' });
    expect(errorDetails(unknown)).toContain('0xdeadbeef');
    const message = encodeAbiParameters([{ type: 'string' }], ['nope']);
    const err = decodeRevert(`0x08c379a0${message.slice(2)}` as Hex);
    expect(err).toMatchObject({ kind: 'unknown' });
    expect(errorDetails(err)).toContain('nope');
    expect(errorText(err)).toBe(UNKNOWN.en({}));
    const panic = decodeRevert(`0x4e487b71${encodeAbiParameters([{ type: 'uint256' }], [17n]).slice(2)}` as Hex);
    expect(panic).toMatchObject({ kind: 'unknown' });
  });
});

describe('reading a failure from a node or a wallet', () => {
  const data = encode('LoanOpen');

  it('finds the revert data wherever the node or the wallet put it', () => {
    expect(revertDataOf({ code: 3, data })).toBe(data);
    expect(revertDataOf({ error: { data } })).toBe(data);
    expect(revertDataOf({ data: { data } })).toBe(data);
    expect(revertDataOf({ cause: { cause: { data } } })).toBe(data);
    expect(revertDataOf({ data: '0x' })).toBeNull();
    expect(revertDataOf({ data: 'execution reverted' })).toBeNull();
    expect(revertDataOf(new Error('boom'))).toBeNull();
    expect(revertDataOf(null)).toBeNull();
    // a cycle cannot loop forever
    const loop: Record<string, unknown> = {};
    loop.cause = loop;
    expect(revertDataOf(loop)).toBeNull();
  });

  it('maps a rejected prompt, a revert and anything else', () => {
    expect(fromFailure({ code: 4001, message: 'User rejected the request.' })).toEqual({ kind: 'wallet-rejected' });
    expect(fromFailure(Object.assign(new Error('execution reverted'), { code: 3, data }))).toMatchObject({ kind: 'revert', name: 'LoanOpen' });
    expect(fromFailure(new Error('network down'))).toEqual({ kind: 'unknown', details: 'network down' });
    expect(fromFailure('plain text')).toEqual({ kind: 'unknown', details: 'plain text' });
    expect(codeOf({ code: 4001 })).toBe(4001);
    expect(codeOf(new Error('x'))).toBeNull();
  });

  it('keeps the raw text of an unknown failure short', () => {
    const e = fromFailure(new Error('x'.repeat(5_000)));
    expect(e.kind === 'unknown' && e.details.length).toBeLessThanOrEqual(300);
  });
});

describe('the app\'s own messages', () => {
  it('have one English and one Chinese line each', () => {
    const lines = [
      { kind: 'entry', check: 'pool.asset() is not the BEM token' },
      { kind: 'policy-changed' },
      { kind: 'wrong-chain', want: 'xlayer' },
      { kind: 'wrong-chain', want: 'bsc' },
      { kind: 'report-late' },
      { kind: 'tx-failed', hash: `0x${'ab'.repeat(32)}` },
      { kind: 'keeper', reason: 'timeout' },
      { kind: 'keeper', reason: 'unreachable' },
    ] as const;
    for (const l of lines) {
      setLang('en', false);
      const en = errorText(l);
      setLang('cn', false);
      const cn = errorText(l);
      expect(en, JSON.stringify(l)).not.toBe(UNKNOWN.en({}));
      expect(cn).toMatch(/[一-鿿]/);
      expect(en + cn).not.toMatch(/audit|审计|!|！/i);
    }
    setLang('en', false);
    expect(errorText({ kind: 'entry', check: 'x' })).toBe('The app does not recognise this contract. Do not continue; check the official links.');
    expect(errorText({ kind: 'policy-changed' })).toBe('The credit rule changed; this app version must be updated.');
    expect(errorDetails({ kind: 'entry', check: 'pool.asset() is not the BEM token' })).toBe('pool.asset() is not the BEM token');
    expect(KEEPER.timeout).toBeDefined();
  });
});

describe('POST /v1/push', () => {
  const fetchOf = (status: number, body: unknown, calls: { url: string; init: RequestInit }[] = []): typeof fetch =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { status, json: async () => body };
    }) as unknown as typeof fetch;
  const agent = '0x00000000000000000000000000000000000000aa' as const;

  it('sends {"agent"} as JSON without credentials and returns the three statuses', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    expect(await requestPush('https://k.example', agent, fetchOf(200, { status: 'queued' }, calls))).toEqual({ status: 'queued' });
    expect(calls[0]?.url).toBe('https://k.example/v1/push');
    expect(calls[0]?.init).toMatchObject({ method: 'POST', body: JSON.stringify({ agent }), credentials: 'omit', headers: { 'content-type': 'application/json' } });
    expect(await requestPush('https://k.example', agent, fetchOf(200, { status: 'fresh' }))).toEqual({ status: 'fresh' });
    expect(await requestPush('https://k.example', agent, fetchOf(200, { status: 'refused', reason: 'rig daily limit' }))).toEqual({ status: 'refused', reason: 'rig daily limit' });
  });

  it('reads anything else as unreachable, and a 400 as a bad address', async () => {
    expect(await requestPush('https://k.example', agent, fetchOf(400, { error: 'invalid JSON' }))).toEqual({ status: 'refused', reason: 'bad agent address' });
    for (const [s, b] of [[500, {}], [503, { error: 'x' }], [200, { status: 'launch' }], [200, 'queued'], [200, null], [200, { status: 'refused' }]] as const) {
      const a = await requestPush('https://k.example', agent, fetchOf(s, b));
      expect(a.status === 'refused' ? a.reason : a.status, JSON.stringify([s, b])).toMatch(/unreachable|unknown/);
    }
    expect(await requestPush(null, agent, fetchOf(200, { status: 'queued' }))).toEqual({ status: 'unreachable' });
    expect(await requestPush('https://k.example', agent, (async () => {
      throw new Error('offline');
    }) as never)).toEqual({ status: 'unreachable' });
  });

  it('caps a reason from the keeper at 120 characters (it is data, shown escaped)', async () => {
    const a = await requestPush('https://k.example', agent, fetchOf(200, { status: 'refused', reason: '<b>x</b>'.repeat(100) }));
    expect(a.status === 'refused' && a.reason.length).toBe(120);
  });
});

