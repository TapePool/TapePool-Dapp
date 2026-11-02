import { decodeFunctionResult, encodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';
import { agentFactoryAbi, circuitsAbi, creditPolicyAbi, tapeLensAbi, tapeLensRuntime, tapePoolAbi, voucherAbi } from '../src/chain/abi';
import { readBsc } from '../src/chain/bsc';
import { createKeeperClient } from '../src/chain/keeper';
import { call, multicall } from '../src/chain/multicall';
import { viemReader } from '../src/chain/reader';
import { DUMMY_LENS } from '../src/chain/reads';
import { createRpc } from '../src/chain/rpc';
import { ChainSource, chainForHistory } from '../src/chain/source';
import { MAINNET, PUBLIC_RPC, readConfig } from '../src/config';
import { firstBlockAtOrAfter, firstTrueBlock, memoryStore } from '../src/logic/history';
import { MIN_RIG_AGE, QUEUE_GRACE } from '../src/constants';
import type { Address, Snapshot } from '../src/model';

/**
 * Opt-in smoke test against mainnet, read-only: `APP_LIVE=1 npm test -- live`.
 * It sends only `eth_call`, `eth_getBlockByNumber` and `eth_gasPrice` to the two public RPCs, paced by the app's own
 * RPC layer. Nothing is signed, nothing is sent.
 */
const live = process.env.APP_LIVE === '1';
const AGENT: Address = '0xAAD24D50c7FdFaFbA8e40a1fEDE6D08E6FC40f1E';
const book = MAINNET;

describe.skipIf(!live)('live mainnet reads (read-only)', () => {
  const x = viemReader(createRpc({ url: PUBLIC_RPC.xlayer }), 'xlayer');
  const b = viemReader(createRpc({ url: PUBLIC_RPC.bsc }), 'bsc');

  it('the pinned address book matches the deployment, and the hand-written ABI entries work', async () => {
    const [asset, factory, policy, tokenAt0, name, symbol, supply] = await multicall(x, book.multicall3, [
      call<Address>(book.pool, tapePoolAbi, 'asset'),
      call<Address>(book.pool, tapePoolAbi, 'factory'),
      call<Address>(book.pool, tapePoolAbi, 'policy'),
      call<bigint>(book.voucher, voucherAbi, 'tokenOfOwnerByIndex', [AGENT, 0n]),
      call<string>(book.policy, circuitsAbi, 'name'), // wrong target on purpose: the policy has no name(); it must fail, not throw
      call<string>('0xdc76f123838b5398A173D215a2c8338Ad189C9a8', circuitsAbi, 'symbol'),
      call<bigint>(book.voucher, voucherAbi, 'balanceOf', [AGENT]),
    ]);
    expect(asset.ok && asset.value).toBe(book.bem);
    expect(factory.ok && factory.value).toBe(book.factory);
    expect(policy.ok && policy.value).toBe(book.policy);
    expect(tokenAt0.ok && tokenAt0.value).toBe(16n); // voucher #16 sits in the agent
    expect(name.ok).toBe(false);
    expect(symbol.ok && symbol.value).toBe('TPPOL');
    expect(supply.ok && supply.value).toBeGreaterThanOrEqual(1n); // voucher #16, and anything else the agent holds
  }, 60_000);

  it('the rules the app hard-codes are the ones the contracts hold', async () => {
    const [grace, minAge, cpuA, cpuB, cpuC] = await multicall(x, book.multicall3, [
      call<bigint>(book.pool, tapePoolAbi, 'QUEUE_GRACE'),
      call<bigint>(book.policy, creditPolicyAbi, 'MIN_RIG_AGE'),
      call<Address>(book.policy, creditPolicyAbi, 'cpuTapeOut'),
      call<Address>(book.policy, creditPolicyAbi, 'cpuBehemoth'),
      call<Address>(book.policy, creditPolicyAbi, 'cpuRefBench'),
    ]);
    expect(grace.ok && grace.value).toBe(BigInt(QUEUE_GRACE));
    expect(minAge.ok && minAge.value).toBe(BigInt(MIN_RIG_AGE));
    expect(cpuA.ok && cpuB.ok && cpuC.ok).toBe(true);
  }, 60_000);

  it('Markets and the pool page: the pool, its parameters and the credit rule are read from the chain', async () => {
    const config = readConfig({});
    const src = new ChainSource({ config, x, b, wallet: { account: null, chainId: null, subscribe: () => () => undefined }, keeper: createKeeperClient(null), store: memoryStore() });
    await src.refresh();
    const s = src.snapshot(null);
    expect(s.boot).toBeUndefined();
    expect(s.stale).toEqual({});
    expect(s.pool.params.feeBps).toEqual([75, 150]);
    expect(s.pool.params.supplyCap).toBeGreaterThan(0n);
    expect(s.pool.circuit.processorSymbol).toBe('TPPOL');
    expect(s.pool.circuit.gates).toBe(44);
    expect(s.pool.circuit.netlistHash.startsWith('0xbe89')).toBe(true);
    expect(s.pool.circuit.netlistHash.endsWith('8b38')).toBe(true);
    expect(s.pool.contracts.policy).toBe(book.policy);
    expect(s.rules.emissionValidUntil).toBeGreaterThan(s.now);
    console.log('pool', { totalAssets: s.pool.totalAssets, outstanding: s.pool.outstanding, idle: s.pool.idle, tpbemValue: s.pool.tpbemValue, params: s.pool.params, paused: s.pool.borrowsPaused, feedOff: s.pool.feedDisabled, queued: s.pool.queued, now: s.now });
    src.dispose();
  }, 60_000);

  it('read-only view of the borrower of the agent: the rig list, rig #16 and the wallet', async () => {
    const [borrowerRes] = await multicall(x, book.multicall3, [call<Address>(book.factory, agentFactoryAbi, 'borrowerOf', [AGENT])]);
    expect(borrowerRes.ok).toBe(true);
    const borrower = borrowerRes.ok ? borrowerRes.value : AGENT;
    const config = readConfig({});
    const src = new ChainSource({ config, x, b, wallet: { account: null, chainId: null, subscribe: () => () => undefined }, keeper: createKeeperClient(null), store: memoryStore() });
    src.snapshot(borrower); // sets the target
    await src.refresh();
    const s: Snapshot = src.snapshot(borrower);
    expect(s.boot).toBeUndefined();
    expect(s.wallet.status).toBe('view');
    expect(s.wallet.account).toBe(borrower);
    expect(s.agents.some((a) => a.address === AGENT && a.collateral.includes(16))).toBe(true);
    const rig = s.rigs.find((r) => r.id === 16);
    expect(['in-agent', 'loan']).toContain(rig?.state.kind); // §5.2 row 4 now; row 1 once the test loan is open
    expect(rig?.facts.bsc?.status).toBe(1);
    expect(rig?.facts.bscAsOf).toBeNull();
    expect(rig?.basePower).toBeGreaterThan(0n);
    expect(s.rules.totalVerifWeight).toBeGreaterThan(0n);
    const loans = s.loans.filter((l) => l.agent === AGENT);
    expect(loans).toHaveLength(rig?.state.kind === 'loan' ? 1 : 0);
    if (loans.length > 0) {
      // the first real loan is the first live check of the log search (SPEC-PHASE5-APP §5.5)
      await src.settled();
      const L = src.snapshot(borrower).loans.find((l) => l.agent === AGENT);
      console.log('loan', L);
      expect(L?.feePaid).not.toBeNull();
    }
    console.log('view', borrower, { rigs: s.rigs.map((r) => ({ id: r.id, state: r.state.kind, base: r.basePower, processor: r.processor, age: r.age, mined: r.mined })), wallet: { bem: s.wallet.bem, okb: s.wallet.okb, room: s.wallet.room }, selfPushBnb: s.keeper.selfPushBnb, reports: s.reports, quotes: s.quotes[AGENT.toLowerCase()] ?? null, stale: s.stale });
    src.dispose();
  }, 90_000);

  it("voucher #16's BSC read mirrors BscRigReader", async () => {
    const r = await readBsc(b, book, [16], new Map());
    const f = r.facts.get(16);
    expect(f).toBeDefined();
    expect(f?.status).toBe(1);
    expect(f?.stopBlock).toBe(0n);
    expect(f?.custodied).toBe(true);
    expect(f?.verifWeight).toBeGreaterThan(f?.bonus ?? 0n);
    expect(f?.since).toBeGreaterThan(0);
    expect(r.totalVerifWeight).toBeGreaterThan(0n);
    console.log('bsc #16', f, 'totalVerifWeight', r.totalVerifWeight);
  }, 60_000);

  it('TapeLens.quote through a state override answers for the agent, without a timely report', async () => {
    const out: Record<string, unknown> = {};
    for (const term of [0, 1]) {
      const data = encodeFunctionData({ abi: tapeLensAbi, functionName: 'quote', args: [AGENT, term] });
      const raw = await x.call(DUMMY_LENS, data, { code: { [DUMMY_LENS]: tapeLensRuntime } });
      const q = decodeFunctionResult({ abi: tapeLensAbi, functionName: 'quote', data: raw });
      expect(q.opsFee).toBe(31_000_000_000_000_000n);
      expect([6, 4, 0]).toContain(q.reason); // DENIED while the report is stale (or OK if someone just pushed one)
      out[`term${term}`] = q;
    }
    console.log('quote', out);
  }, 60_000);

  it('the log reads and the receipt lookup work against the node (the paths the fake chain replaces)', async () => {
    const head = await x.head();
    const hist = chainForHistory(x);
    // one 100-block window, filtered by the agent, for the three events at once: nothing happened in it
    expect(await hist.logs(AGENT, head.number - 99n, head.number)).toEqual([]);
    // before the agent existed the call returns no data, which counts as "not closed"
    expect(await hist.closedAt(AGENT, 73_824_872n)).toBe(false);
    expect(await hist.closedAt(AGENT, head.number)).toBe(false);
    // so the seize search asks once and gives up on an agent that is open
    let asked = 0;
    expect(await firstTrueBlock(73_824_872n, head.number, async (n) => {
      asked++;
      return hist.closedAt(AGENT, n);
    })).toBeNull();
    expect(asked).toBe(1);
    // a transaction nobody sent is not mined
    expect(await x.receipt(`0x${'ab'.repeat(32)}`)).toBeNull();
  }, 60_000);

  it('the block search finds the first block of a timestamp, and the one before it is earlier', async () => {
    const t = await x.blockTime(73_824_872n);
    const head = await x.head();
    const found = await firstBlockAtOrAfter(t, 73_000_000n, head.number, (n) => x.blockTime(n));
    expect(found).not.toBeNull();
    expect(found).toBeLessThanOrEqual(73_824_872n);
    expect(await x.blockTime(found as bigint)).toBeGreaterThanOrEqual(t);
    expect(await x.blockTime((found as bigint) - 1n)).toBeLessThan(t);
  }, 90_000);
});
