import { describe, expect, it } from 'vitest';
import { agentFactoryAbi, ownerOfAbi, tapeLensAbi, tapePoolAbi, voucherAbi } from '../src/chain/abi';
import { deriveBorrow } from '../src/logic/borrow';
import { freshUi } from '../src/state';
import { createKeeperClient } from '../src/chain/keeper';
import { DUMMY_LENS } from '../src/chain/reads';
import { ChainSource, STALE_AFTER_MS, KEEPER_BACKOFF_MS, type SessionStore } from '../src/chain/source';
import { memoryStore } from '../src/logic/history';
import type { Address, Snapshot } from '../src/model';
import type { DecodedLog } from '../src/chain/reader';
import { MAINNET } from '../src/config';
import { A, ACCOUNT, AGENT1, AGENT2, AGENT3, CPU, NETLIST_HASH, NOW, OTHER, addAccount, addAgent, addRig, buildWorld, noLoan, openLoan, readyRig, type World } from './world';

const DAY = 86_400;

function walletOf(account: Address | null, chainId: number | null = 196) {
  const subs = new Set<() => void>();
  return {
    account,
    chainId,
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    change(a: Address | null, c: number | null = chainId) {
      this.account = a;
      this.chainId = c;
      subs.forEach((f) => f());
    },
  };
}

function source(w: World, account: Address | null = null, extra: Partial<ConstructorParameters<typeof ChainSource>[0]> = {}) {
  const clock = { ms: 0 };
  const wallet = walletOf(account);
  const src = new ChainSource({
    config: w.config,
    x: w.x,
    b: w.b,
    wallet,
    keeper: createKeeperClient(null),
    store: memoryStore(),
    clock: () => clock.ms,
    wall: () => NOW * 1000,
    ...extra,
  });
  return { src, clock, wallet };
}

/** The world of most tests: a wallet rig that is ready, two that are not, an agent with a rig and a loose voucher, and an agent with a loan. */
function standardWorld(): World {
  const w = buildWorld();
  addAccount(w, ACCOUNT, { vouchers: [101, 102, 103], agents: [AGENT1, AGENT2], tpbem: 5n * 10n ** 14n, withdrawable: 505_000_000n });
  addRig(w, 101, readyRig(101));
  addRig(w, 102, readyRig(102, {}, { since: NOW - 1 * DAY }));
  addRig(w, 103, readyRig(103, { pass: null }));
  addAgent(w, AGENT1, { collateral: [201], owned: [201, 202], bem: 0n });
  addRig(w, 201, readyRig(201, { report: { observedAt: NOW - 60 } }));
  addRig(w, 202, readyRig(202));
  addAgent(w, AGENT2, { collateral: [301, 302], owned: [301, 302], loan: openLoan(), bem: 7_000n });
  addRig(w, 301, readyRig(301, { report: { observedAt: NOW - 30 } }));
  addRig(w, 302, readyRig(302));
  w.state.quote = (_agent, term) => ({ maxPrincipal: 80_000_000n, fee: 600_000n, expected: 95_000_000n, inputBits: 0b11111_00000_00 | 0x3c | term, reason: 0, pending: 1_000_000n, opsFee: 31_000_000_000_000_000n });
  return w;
}

const kinds = (s: Snapshot): Record<number, string> => Object.fromEntries(s.rigs.map((r) => [r.id, r.state.kind]));

describe('the wallets in the snapshot', () => {
  const found = [{ id: 'a', name: 'MetaMask', icon: null, rdns: 'io.metamask', fallback: false }];

  it('hands out what the wallet found, the wallet in use and the one used last', async () => {
    const w = buildWorld();
    const wallet = { ...walletOf(null), options: () => found, active: () => found[0] ?? null, recent: () => 'io.metamask' };
    const { src } = source(w, null, { wallet });
    expect(src.snapshot(null).wallet).toMatchObject({ options: found, active: found[0], recent: 'io.metamask' });
    src.dispose();
  });

  it('leaves them out when the wallet has no list of its own', async () => {
    const w = buildWorld();
    const { src } = source(w);
    const s = src.snapshot(null).wallet;
    expect('options' in s || 'active' in s || 'recent' in s).toBe(false);
    src.dispose();
  });
});

describe('Markets without a wallet', () => {
  it('shows a loading state until the first read, then the pool as the chain says it', async () => {
    const w = buildWorld();
    const { src } = source(w);
    expect(src.snapshot(null).boot).toEqual({ pool: 'loading' });
    await src.refresh();
    const s = src.snapshot(null);
    expect(s.boot).toBeUndefined();
    expect(s.stale).toEqual({});
    expect(s.pool.totalAssets).toBe(99_500_000n);
    expect(s.pool.params).toMatchObject({ feeBps: [75, 150], maxDebtBps: [8_500, 8_000], termDays: [7, 14], minFee: 300_000n, minAdvance: 1_000_000n, supplyCap: 2_000_000_000n, borrowCapAbs: 1_000_000_000n, borrowCapBps: 7_000, perBorrowerBps: 4_000, opsFee: [31_000_000_000_000_000n, 31_000_000_000_000_000n] });
    expect(s.pool.tpbemValue).toBe(101_000_000n);
    expect(s.pool.circuit).toMatchObject({ processorName: 'Tape Pool Policy', processorSymbol: 'TPPOL', gates: 44, circuitId: 1, netlistHash: NETLIST_HASH });
    expect(s.pool.contracts).toMatchObject({ pool: MAINNET.pool, factory: MAINNET.factory, policy: MAINNET.policy, voucher: MAINNET.voucher, bem: MAINNET.bem });
    expect(s.rules.emissionValidUntil).toBe(NOW + 400 * DAY);
    expect(s.wallet).toMatchObject({ status: 'disconnected', account: null, bem: 0n });
    expect(s.position).toBeNull();
    expect(s.rigs).toEqual([]);
    src.dispose();
  });

  it('reads the pool in two rounds and never touches BSC when no account is asked for', async () => {
    const w = buildWorld();
    const { src } = source(w);
    await src.refresh();
    expect(w.x.calls.filter((c) => c.inner > 0)).toHaveLength(2); // the pool and the policy's pins, then the circuit (once)
    expect(w.b.calls).toHaveLength(0);
    await src.refresh();
    expect(w.x.calls.filter((c) => c.inner > 0)).toHaveLength(3); // the second refresh is one round
    src.dispose();
  });

  it('pins every read of a refresh to the block it started from', async () => {
    const w = standardWorld();
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    const multi = w.x.calls.filter((c) => c.inner > 0);
    expect(multi.length).toBeGreaterThanOrEqual(5);
    for (const c of multi) expect(c.block).toBe(w.x.number);
    src.dispose();
  });

  it('only the live queued changes count: an eta that passed more than the grace ago is dropped', async () => {
    const w = buildWorld();
    w.state.queued = { 4: { value: 90n, eta: NOW + 1_000 }, 11: { value: 5n, eta: NOW - 8 * DAY }, 6: { value: 400_000n, eta: NOW - 3 * DAY } };
    const { src } = source(w);
    await src.refresh();
    const q = src.snapshot(null).pool.queued;
    expect(q).toEqual([
      { key: 'feeBps7d', value: 90n, eta: NOW + 1_000 },
      { key: 'minFee', value: 400_000n, eta: NOW - 3 * DAY },
    ]);
    src.dispose();
  });

  it('reports a queued credit-rule swap, a pause and a disabled feed from stats()', async () => {
    const w = buildWorld();
    w.state.statsOverride = { borrowsPaused: true, feedDisabled: true, pendingPolicy: OTHER, pendingPolicyEta: BigInt(NOW + 7 * DAY), doubtful: 1_000_000n };
    const { src } = source(w);
    await src.refresh();
    const p = src.snapshot(null).pool;
    expect(p).toMatchObject({ borrowsPaused: true, feedDisabled: true, pendingPolicy: { address: OTHER, eta: NOW + 7 * DAY }, doubtful: 1_000_000n });
    src.dispose();
  });

  it('chain time is the latest block plus the monotonic time since the read', async () => {
    const w = buildWorld();
    const { src, clock } = source(w);
    await src.refresh();
    expect(src.now()).toBe(NOW);
    clock.ms += 7_400;
    expect(src.now()).toBe(NOW + 7);
    expect(src.snapshot(null).now).toBe(NOW + 7);
    src.dispose();
  });
});

describe('failures keep the old value and mark it stale', () => {
  it('a first read that fails is a failed boot, not zeros', async () => {
    const w = buildWorld();
    w.x.down = true;
    const { src } = source(w);
    await src.refresh();
    expect(src.snapshot(null).boot).toEqual({ pool: 'failed' });
    w.x.down = false;
    await src.refresh();
    expect(src.snapshot(null).boot).toBeUndefined();
    src.dispose();
  });

  it('a later failure keeps the last pool and stales it; the next success clears it', async () => {
    const w = buildWorld();
    const { src } = source(w);
    await src.refresh();
    w.state.poolFail = true;
    await src.refresh();
    let s = src.snapshot(null);
    expect(s.pool.totalAssets).toBe(99_500_000n);
    expect(s.stale).toEqual({ pool: true });
    expect(s.boot).toBeUndefined();
    w.state.poolFail = false;
    await src.refresh();
    s = src.snapshot(null);
    expect(s.stale).toEqual({});
    src.dispose();
  });

  it('a section that has not been read for a minute is stale even though no read failed', async () => {
    const w = standardWorld();
    const { src, clock } = source(w, ACCOUNT);
    await src.refresh();
    expect(src.snapshot(null).stale).toEqual({});
    clock.ms += STALE_AFTER_MS + 1;
    expect(src.snapshot(null).stale).toEqual({ pool: true, wallet: true, rigs: true, loans: true });
    await src.refresh();
    expect(src.snapshot(null).stale).toEqual({});
    src.dispose();
  });

  it('a failed account read stales wallet, rigs and loans but leaves the pool fresh', async () => {
    const w = standardWorld();
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    const before = src.snapshot(null);
    // the account's own reads start failing (the pool's still answer)
    w.state.accounts.delete(ACCOUNT.toLowerCase());
    await src.refresh();
    const s = src.snapshot(null);
    expect(s.stale).toEqual({ wallet: true, rigs: true, loans: true });
    expect(s.rigs.map((r) => r.id)).toEqual(before.rigs.map((r) => r.id)); // the old rig list is still shown
    expect(s.wallet.bem).toBe(before.wallet.bem);
    expect(s.boot).toBeUndefined();
    src.dispose();
  });

  it('a failed first read of the account is a failed boot of the account only', async () => {
    const w = standardWorld();
    w.state.accounts.delete(ACCOUNT.toLowerCase());
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    const s = src.snapshot(null);
    expect(s.boot).toEqual({ account: 'failed' });
    expect(s.pool.totalAssets).toBe(99_500_000n);
    src.dispose();
  });
});

describe('the account: wallet, agents, rigs and loans', () => {
  it('reads the wallet and the position', async () => {
    const w = standardWorld();
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    const s = src.snapshot(null);
    expect(s.wallet).toMatchObject({ status: 'connected', account: ACCOUNT, bem: 250_000_000n, okb: 80_000_000_000_000_000n, room: 39_800_000n, allowancePool: 0n });
    expect(s.wallet.borrowGas).toBeGreaterThan(0n);
    expect(s.position).toMatchObject({ tpbem: 5n * 10n ** 14n, value: 505_000_000n, withdrawable: 505_000_000n, maxDeposit: 1_900_500_000n, growth: null });
    src.dispose();
  });

  it('puts every rig in the right row of the §5.2 table', async () => {
    const w = standardWorld();
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    const s = src.snapshot(null);
    expect(kinds(s)).toEqual({ 101: 'ready', 102: 'too-new', 103: 'not-screened', 201: 'in-agent', 202: 'loose', 301: 'loan', 302: 'loan' });
    expect(s.agents).toMatchObject([
      { address: AGENT1, closed: false, collateral: [201], loose: [202], bem: 0n },
      { address: AGENT2, closed: false, collateral: [301, 302], loose: [], bem: 7_000n },
    ]);
    const r101 = s.rigs.find((r) => r.id === 101);
    expect(r101?.processor).toBe('TapeOut');
    expect(r101?.basePower).toBe(20n); // verifWeight 25 minus bonus 5
    expect(r101?.mined).toBe(1_000_000n);
    expect(r101?.facts.bscAsOf).toBeNull();
    expect(s.rules.totalVerifWeight).toBe(1_600_000n);
    src.dispose();
  });

  it('a rig that matches no processor, is stopped, has a stale voucher or a changed pass lands in its row', async () => {
    const w = standardWorld();
    addAccount(w, ACCOUNT, { vouchers: [111, 112, 113, 114, 115, 116], agents: [] });
    w.b.on(A(0xdead1), ownerOfAbi, { ownerOf: A(0xce11) }); // an unsupported processor whose NFT the cell holds
    addRig(w, 111, readyRig(111, {}, { circuits: A(0xdead1), circuitId: 9n }));
    addRig(w, 112, readyRig(112, {}, { status: 3, stopBlock: 5n }));
    addRig(w, 113, readyRig(113, { voucher: { circuits: CPU.tapeout, circuitId: 1113n, power: 0n } }));
    addRig(w, 114, readyRig(114, { voucher: { circuits: CPU.tapeout, circuitId: 999n, power: 25n } }));
    addRig(w, 115, readyRig(115, { suspended: true }));
    addRig(w, 116, readyRig(116, { pass: { circuits: CPU.tapeout, circuitId: 1116n, taskId: 9, effectiveAt: NOW - DAY } }));
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    const s = src.snapshot(null);
    expect(s.stale).toEqual({});
    expect(kinds(s)).toEqual({ 111: 'processor', 112: 'not-mining', 113: 'not-synced', 114: 'mismatch', 115: 'not-screened', 116: 'not-screened' });
    expect(s.rigs.find((r) => r.id === 115)?.state).toMatchObject({ why: 'suspended' });
    expect(s.rigs.find((r) => r.id === 116)?.state).toMatchObject({ why: 'changed' });
    src.dispose();
  });

  it('builds an open loan from loanOf(), with the phase measured on chain time', async () => {
    const w = standardWorld();
    const { src, clock } = source(w, ACCOUNT);
    await src.refresh();
    let s = src.snapshot(null);
    expect(s.loans).toHaveLength(1);
    const L = s.loans[0];
    expect(L).toMatchObject({ agent: AGENT2, rigIds: [301, 302], phase: 'active', term: 0, advance: 60_000_000n, principal: 50_000_000n, feeLeft: 450_000n, lateFee: 0n, agentBem: 7_000n, feePaid: null, opsFeePaid: null, impairedAt: null, impairment: null });
    expect(L?.start).toBe(NOW - 2 * DAY);
    expect(L?.maturity).toBe(NOW + 5 * DAY);
    expect(L?.minedBsc).toBe(2_000_000n);
    expect(L?.expectedPerDay).toBeGreaterThan(0n);
    expect(L?.collateral.map((r) => ({ id: r.id, mining: r.mining, processor: r.processor }))).toEqual([
      { id: 301, mining: true, processor: 'TapeOut' },
      { id: 302, mining: true, processor: 'TapeOut' },
    ]);
    // eight days later, by the monotonic clock, the same read is past maturity
    clock.ms += 8 * DAY * 1000;
    s = src.snapshot(null);
    expect(s.loans[0]?.phase).toBe('late');
    src.dispose();
  });

  it('shows a flagged loan with the kind of impairment the BSC read gives', async () => {
    for (const [bsc, kind] of [
      [{ status: 3, stopBlock: 12n }, 'stopped'],
      [{ status: 2 }, 'inactive'],
      [{ owner: OTHER }, 'rescued'],
      [{ verifWeight: 5n, bonus: 5n }, 'no-power'],
      [{}, 'unknown'],
    ] as const) {
      const w = standardWorld();
      addRig(w, 301, readyRig(301, { report: { observedAt: NOW - 30 } }, bsc));
      const ag = w.state.agents.get(AGENT2.toLowerCase());
      if (ag) ag.loan = openLoan({ impairedAt: BigInt(NOW - 3_600), impairedRig: 301n, seizeStart: BigInt(NOW + 72 * 3_600 - 3_600), deadline: BigInt(NOW + 96 * 3_600 - 3_600) });
      const { src } = source(w, ACCOUNT);
      await src.refresh();
      const L = src.snapshot(null).loans[0];
      expect(L?.phase, kind).toBe('flagged');
      expect(L?.impairment, kind).toBe(kind);
      expect(L?.impairedRig).toBe(301);
      expect(L?.seizeStart).toBe(NOW + 71 * 3_600);
      src.dispose();
    }
  });

  it('a flag that expired reads as an ordinary loan; one past its cure window is in the seize window', async () => {
    const w = standardWorld();
    const ag = w.state.agents.get(AGENT2.toLowerCase());
    if (ag) ag.loan = openLoan({ impairedAt: BigInt(NOW - 200 * 3_600), impairedRig: 301n, seizeStart: BigInt(NOW - 128 * 3_600), deadline: BigInt(NOW - 104 * 3_600), expired: true });
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    expect(src.snapshot(null).loans[0]?.phase).toBe('active');
    if (ag) ag.loan = openLoan({ impairedAt: BigInt(NOW - 80 * 3_600), impairedRig: 301n, seizeStart: BigInt(NOW - 8 * 3_600), deadline: BigInt(NOW + 16 * 3_600) });
    await src.refresh();
    expect(src.snapshot(null).loans[0]?.phase).toBe('seize');
    src.dispose();
  });

  it('the feed reports are exposed per rig, and the quote is read only for an agent whose reports are timely', async () => {
    const w = standardWorld();
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    let s = src.snapshot(null);
    expect(s.reports['201']).toEqual({ observedAt: NOW - 60 });
    expect(Object.keys(s.quotes)).toEqual([AGENT1.toLowerCase()]);
    expect(s.quotes[AGENT1.toLowerCase()]?.[0]).toMatchObject({ maxPrincipal: 80_000_000n, reason: 0 });
    const lens = w.x.calls.find((c) => c.code && c.code[DUMMY_LENS]);
    expect(lens).toBeDefined();
    expect(lens?.code?.[DUMMY_LENS]?.startsWith('0x6080')).toBe(true);
    expect(lens?.inner).toBe(2); // both terms of the one agent, in one call

    // the report ages past five minutes: no quote is read
    w.state.rigs.set(201, readyRig(201, { report: { observedAt: NOW - 400 } }));
    w.x.calls.length = 0;
    await src.refresh();
    s = src.snapshot(null);
    expect(s.quotes).toEqual({});
    expect(w.x.calls.some((c) => c.code)).toBe(false);
    src.dispose();
  });

  it('a deployed TapeLens is called without a state override', async () => {
    const lens = '0x00000000000000000000000000000000000fe115';
    const w = buildWorld({ VITE_TAPELENS_ADDRESS: lens });
    addAccount(w, ACCOUNT, { vouchers: [], agents: [AGENT1] });
    addAgent(w, AGENT1, { collateral: [201], owned: [201] });
    addRig(w, 201, readyRig(201, { report: { observedAt: NOW - 60 } }));
    w.state.quote = () => ({ maxPrincipal: 1n, fee: 1n, expected: 1n, inputBits: 0, reason: 0, pending: 0n, opsFee: 0n });
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    expect(Object.keys(src.snapshot(null).quotes)).toEqual([AGENT1.toLowerCase()]);
    expect(w.x.calls.some((c) => c.code)).toBe(false);
    src.dispose();
  });

  it('a quote that fails inside the call is null, which the borrow flow reads as cannot-check', async () => {
    const w = standardWorld();
    w.state.quote = () => null; // the lens call fails for both terms
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    const s = src.snapshot(null);
    expect(s.quotes[AGENT1.toLowerCase()]).toEqual([null, null]);
    expect(s.stale).toEqual({});
    expect(s.rigs).toHaveLength(7);
    src.dispose();
  });

  it('a quote request that fails stales the rigs, so the borrow button stays off', async () => {
    const w = standardWorld();
    w.x.failIf = (r) => r.code !== undefined; // the node errors on the state-override call
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    const s = src.snapshot(null);
    expect(s.stale).toEqual({ rigs: true });
    expect(s.quotes).toEqual({});
    expect(s.rigs).toHaveLength(7); // the rig list itself was read
    expect(s.boot).toBeUndefined();
    src.dispose();
  });

  it('keeps the call budget of a refresh: seven X Layer rounds and five BSC rounds, then one fewer on each', async () => {
    const w = standardWorld();
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    // X Layer: core, circuit (once), holdings x2, rig records, who is the payee of a harvest now, quotes, entry checks.
    // BSC: vault and bridge fee, keys (once), miners, owners and cell BEM, the price of a harvest, self-push price.
    expect(w.x.calls.filter((c) => c.inner > 0)).toHaveLength(8);
    expect(w.b.calls.filter((c) => c.inner > 0)).toHaveLength(5);
    expect(w.b.calls.filter((c) => c.to.toLowerCase() === w.config.book.reporter.toLowerCase())).toHaveLength(1);
    w.x.calls.length = 0;
    w.b.calls.length = 0;
    await src.refresh();
    expect(w.x.calls.filter((c) => c.inner > 0)).toHaveLength(7);
    expect(w.b.calls.filter((c) => c.inner > 0)).toHaveLength(4); // the miner keys are cached; reporter quote is direct
    src.dispose();
  });

  it('reads the self-push price from the reporter for the agent that can borrow', async () => {
    const w = standardWorld();
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    expect(src.snapshot(null).keeper.selfPushBnb).toBe(1_650_000_000_000_000n);
    w.b.down = true;
    await src.refresh();
    expect(src.snapshot(null).keeper.selfPushBnb).toBeNull();
    src.dispose();
  });
});

describe('BSC unreachable: the feed is the fallback, labelled', () => {
  it('uses the last report with its observation time and the network weight it carries', async () => {
    const w = standardWorld();
    w.b.down = true;
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    const s = src.snapshot(null);
    expect(s.stale).toEqual({});
    const r = s.rigs.find((x) => x.id === 101);
    expect(r?.facts.bscAsOf).toBe(NOW - 3_600);
    expect(r?.state.kind).toBe('ready');
    expect(r?.basePower).toBe(20n);
    expect(s.rules.totalVerifWeight).toBe(1_600_000n);
    src.dispose();
  });

  it('a rig the feed never reported reads as no data', async () => {
    const w = standardWorld();
    w.b.down = true;
    addRig(w, 101, readyRig(101, { report: null }));
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    expect(kinds(src.snapshot(null))[101]).toBe('no-data');
    src.dispose();
  });

  it('a rig the vault forgot (a rescue) reads as not mining', async () => {
    const w = standardWorld();
    addRig(w, 101, { ...readyRig(101), bsc: null });
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    expect(kinds(src.snapshot(null))[101]).toBe('not-mining');
    src.dispose();
  });

  it('a circuit NFT that left the cell reads as not custodied', async () => {
    const w = standardWorld();
    addRig(w, 101, readyRig(101, {}, { owner: OTHER }));
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    const r = src.snapshot(null).rigs.find((x) => x.id === 101);
    expect(r?.facts.bsc?.custodied).toBe(false);
    expect(r?.state.kind).toBe('not-mining');
    src.dispose();
  });
});

describe('who the snapshot is for', () => {
  it('a read-only view reads that address and never shows the connected wallet', async () => {
    const w = standardWorld();
    addAccount(w, OTHER, { vouchers: [101], agents: [], bem: 1n });
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    expect(src.snapshot(null).rigs.length).toBe(7);
    // the page moves to the view of another address: nothing of the connected account shows meanwhile
    const during = src.snapshot(OTHER);
    expect(during.wallet.status).toBe('view');
    expect(during.wallet.account).toBe(OTHER);
    expect(during.rigs).toEqual([]);
    expect(during.boot).toEqual({ account: 'loading' });
    await src.refresh();
    const after = src.snapshot(OTHER);
    expect(after.boot).toBeUndefined();
    expect(after.rigs.map((r) => r.id)).toEqual([101]);
    expect(after.wallet.bem).toBe(1n);
    expect(after.wallet.status).toBe('view');
    src.dispose();
  });

  it('a change of account drops the old account at once and ignores a late answer for it', async () => {
    const w = standardWorld();
    addAccount(w, OTHER, { vouchers: [101], agents: [], bem: 2n });
    const { src, wallet } = source(w, ACCOUNT);
    await src.refresh();
    wallet.change(OTHER);
    const s = src.snapshot(null);
    expect(s.wallet.account).toBe(OTHER);
    expect(s.rigs).toEqual([]);
    expect(s.boot).toEqual({ account: 'loading' });
    await src.refresh(); // the refresh the change started, and the one folded into it
    const done = src.snapshot(null);
    expect(done.wallet.bem).toBe(2n);
    expect(done.rigs.map((r) => r.id)).toEqual([101]);
    src.dispose();
  });

  it('the wallet status follows the chain the wallet is on', async () => {
    const w = standardWorld();
    const { src, wallet } = source(w, ACCOUNT);
    await src.refresh();
    expect(src.snapshot(null).wallet.status).toBe('connected');
    wallet.change(ACCOUNT, 56);
    expect(src.snapshot(null).wallet.status).toBe('wrong-network');
    wallet.change(null, null);
    expect(src.snapshot(null).wallet.status).toBe('disconnected');
    expect(src.snapshot(null).rigs).toEqual([]);
    src.dispose();
  });

  it('a second refresh requested during one folds into a single rerun', async () => {
    const w = buildWorld();
    const { src } = source(w);
    const a = src.refresh();
    const b = src.refresh();
    const c = src.refresh();
    await Promise.all([a, b, c]);
    expect(w.x.calls.filter((x) => x.inner > 0)).toHaveLength(3); // one full read (2 rounds), one rerun (1 round)
    src.dispose();
  });
});

describe('history in the background', () => {
  function history(w: World): void {
    // the loan of AGENT2 started 2 days before the head and the head's block time is one second a block
    const borrowBlock = w.x.number - BigInt(2 * DAY);
    w.x.logsHandler = (q): DecodedLog[] => {
      if (q.address !== AGENT2 || q.fromBlock > borrowBlock || q.toBlock < borrowBlock) return [];
      return [
        { eventName: 'Borrowed', args: { agent: AGENT2, borrower: ACCOUNT, term: 0, principal: 60_000_000n, fee: 450_000n, maturity: BigInt(NOW + 5 * DAY), ids: [301n, 302n] }, blockNumber: borrowBlock, transactionHash: `0x${'aa'.repeat(32)}` },
        { eventName: 'OpsFeePaid', args: { agent: AGENT2, term: 0, amount: 31_000_000_000_000_000n, to: OTHER }, blockNumber: borrowBlock, transactionHash: `0x${'aa'.repeat(32)}` },
      ];
    };
  }

  it('finds the flat fee and the operating fee of an open loan without holding up the refresh', async () => {
    const w = standardWorld();
    history(w);
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    expect(src.snapshot(null).loans[0]).toMatchObject({ feePaid: null, opsFeePaid: null }); // not yet: "—"
    await src.settled();
    const L = src.snapshot(null).loans[0];
    expect(L).toMatchObject({ feePaid: 450_000n, opsFeePaid: 31_000_000_000_000_000n });
    // one window of at most 100 blocks, filtered by the agent
    expect(w.x.logQueries).toHaveLength(1);
    const q = w.x.logQueries[0];
    expect(q?.address).toBe(AGENT2);
    expect((q?.toBlock ?? 0n) - (q?.fromBlock ?? 0n)).toBeLessThanOrEqual(99n);
    // the second read finds it cached: no more block reads, no more logs
    w.x.logQueries.length = 0;
    w.x.blockTimeReads.length = 0;
    await src.refresh();
    await src.settled();
    expect(w.x.logQueries).toHaveLength(0);
    expect(w.x.blockTimeReads).toHaveLength(0);
    src.dispose();
  });

  it('a failed search shows a dash and the rest of the page keeps working', async () => {
    const w = standardWorld();
    w.x.logsHandler = () => {
      throw new Error('over rate limit');
    };
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    await src.settled();
    const s = src.snapshot(null);
    expect(s.loans[0]?.feePaid).toBeNull();
    expect(s.stale).toEqual({});
    expect(kinds(s)[101]).toBe('ready');
    src.dispose();
  });

  it('a seized agent: the Seized event names the rigs that moved, and the loan before the seize fills the card', async () => {
    const w = standardWorld();
    addAccount(w, ACCOUNT, { vouchers: [101], agents: [AGENT3] });
    const closeBlock = w.x.number - 5_000n;
    addAgent(w, AGENT3, {
      closed: true,
      collateral: [402],
      owned: [402],
      createdBlock: w.x.number - 150_000n,
      closeBlock,
      loanBefore: openLoan({ start: BigInt(NOW - 4 * DAY), maturity: BigInt(NOW + 3 * DAY), principal: 55_000_000n, principal0: 60_000_000n, impairedAt: BigInt(NOW - 100_000), impairedRig: 401n, seizeStart: BigInt(NOW - 40_000), deadline: BigInt(NOW - 3_600) }),
    });
    addRig(w, 401, readyRig(401, {}, { status: 3, stopBlock: 7n }));
    addRig(w, 402, readyRig(402));
    const seizedAt = w.x.timestamp - 5_000;
    w.x.logsHandler = (q): DecodedLog[] => {
      if (q.address === AGENT3 && q.fromBlock <= closeBlock && q.toBlock >= closeBlock && q.fromBlock === q.toBlock) {
        return [{ eventName: 'Seized', args: { agent: AGENT3, movedIds: [401n], stuckIds: [402n], writtenOff: 55_000_000n }, blockNumber: closeBlock, transactionHash: `0x${'bb'.repeat(32)}` }];
      }
      return [];
    };
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    // before the search: the agent is closed, the stuck voucher shows, the moved one is nowhere yet
    let s = src.snapshot(null);
    expect(kinds(s)).toEqual({ 101: 'ready', 402: 'stuck' });
    await src.settled(); // the search ends by asking for one more refresh
    await src.refresh();
    s = src.snapshot(null);
    expect(kinds(s)).toEqual({ 101: 'ready', 402: 'stuck', 401: 'seized' });
    const L = s.loans.find((l) => l.agent === AGENT3);
    expect(L).toMatchObject({ phase: 'seized', rigIds: [401, 402], writtenOff: 55_000_000n, advance: 60_000_000n, principal: 0n, impairedRig: 401, impairment: 'stopped', seizedAt });
    expect(L?.start).toBe(NOW - 4 * DAY);
    // closed() was searched from the pool's deploy block with archive calls; the empty answer before the agent existed counts as "not closed"
    const archive = w.x.calls.filter((c) => c.inner === 0 && c.block !== undefined);
    expect(archive.length).toBeGreaterThan(5);
    expect(archive.length).toBeLessThan(40);
    src.dispose();
  });
});

describe('keeper data', () => {
  type Reply = { status: number; body?: unknown } | 'network';
  function fetcher(routes: Record<string, Reply>) {
    const seen: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      expect(init?.headers).toBeUndefined(); // simple GETs only: no custom header, so no preflight
      const key = Object.keys(routes).find((k) => url.endsWith(k));
      const r = key ? routes[key] : 'network';
      if (r === 'network' || r === undefined) throw new TypeError('failed to fetch');
      return { status: r.status, json: async () => r.body } as Response;
    }) as unknown as typeof fetch;
    return { f, seen };
  }
  const stats = { asOf: NOW - 10, block: 73_900_000, sharePrice: '101000000', apy7d: '0.050000', history: [] };
  const pos = (over: Record<string, unknown> = {}) => ({ netDeposited: '500000000', transferred: false, firstDepositAt: NOW - DAY, indexedTo: 73_999_990, indexedToTime: NOW - 20, ...over });

  it('with no KEEPER_URL it never calls out, and the APY and growth are dashes', async () => {
    const w = standardWorld();
    const { f, seen } = fetcher({});
    const { src } = source(w, ACCOUNT, { keeper: createKeeperClient(w.config.keeperUrl, f) });
    await src.refresh();
    const s = src.snapshot(null);
    expect(seen).toEqual([]);
    expect(s.keeper).toMatchObject({ reachable: false, apy7d: null });
    expect(s.position?.growth).toBeNull();
    src.dispose();
  });

  it('reads the APY, and growth = what the shares are worth now minus the net deposits', async () => {
    const w = buildWorld({ VITE_KEEPER_URL: 'https://keeper.example/' });
    addAccount(w, ACCOUNT, { tpbem: 5n * 10n ** 14n, withdrawable: 505_000_000n, vouchers: [], agents: [] });
    const { f, seen } = fetcher({ '/v1/stats': { status: 200, body: stats }, [`/v1/position/${ACCOUNT}`]: { status: 200, body: pos() } });
    const { src } = source(w, ACCOUNT, { keeper: createKeeperClient(w.config.keeperUrl, f) });
    await src.refresh();
    const s = src.snapshot(null);
    expect(seen.sort()).toEqual([`GET https://keeper.example/v1/position/${ACCOUNT}`, 'GET https://keeper.example/v1/stats']);
    expect(s.keeper).toMatchObject({ reachable: true, apy7d: '0.050000' });
    expect(s.position?.growth).toBe(5_000_000n); // 5.05 BEM now, 5.00 put in
    src.dispose();
  });

  it('growth is a dash when shares were transferred, the index has no time, or it lags by more than an hour', async () => {
    for (const over of [{ transferred: true }, { indexedToTime: null }, { indexedToTime: NOW - 3_700 }]) {
      const w = buildWorld({ VITE_KEEPER_URL: 'https://keeper.example' });
      addAccount(w, ACCOUNT, { tpbem: 5n * 10n ** 14n, vouchers: [], agents: [] });
      const { f } = fetcher({ '/v1/stats': { status: 200, body: stats }, [`/v1/position/${ACCOUNT}`]: { status: 200, body: pos(over) } });
      const { src } = source(w, ACCOUNT, { keeper: createKeeperClient(w.config.keeperUrl, f) });
      await src.refresh();
      expect(src.snapshot(null).position?.growth, JSON.stringify(over)).toBeNull();
      src.dispose();
    }
  });

  it('a negative APY and a 503 "not ready" are handled', async () => {
    const w = buildWorld({ VITE_KEEPER_URL: 'https://keeper.example' });
    const a = fetcher({ '/v1/stats': { status: 200, body: { ...stats, apy7d: '-0.012300' } } });
    const one = source(w, null, { keeper: createKeeperClient(w.config.keeperUrl, a.f) });
    await one.src.refresh();
    expect(one.src.snapshot(null).keeper.apy7d).toBe('-0.012300');
    one.src.dispose();

    const b = fetcher({ '/v1/stats': { status: 503, body: { error: 'not ready' } } });
    const two = source(w, null, { keeper: createKeeperClient(w.config.keeperUrl, b.f) });
    await two.src.refresh();
    expect(two.src.snapshot(null).keeper).toMatchObject({ reachable: true, apy7d: null });
    expect(two.src.snapshot(null).stale).toEqual({});
    two.src.dispose();
  });

  it('a keeper that cannot be reached is left alone for two minutes and never stales the chain data', async () => {
    const w = buildWorld({ VITE_KEEPER_URL: 'https://keeper.example' });
    const { f, seen } = fetcher({});
    const { src, clock } = source(w, null, { keeper: createKeeperClient(w.config.keeperUrl, f) });
    await src.refresh();
    expect(seen).toHaveLength(1);
    expect(src.snapshot(null).keeper).toMatchObject({ reachable: false, apy7d: null });
    expect(src.snapshot(null).stale).toEqual({});
    clock.ms += 30_000;
    await src.refresh();
    expect(seen).toHaveLength(1); // still backing off: no new request, so no new console error
    clock.ms += KEEPER_BACKOFF_MS;
    await src.refresh();
    expect(seen).toHaveLength(2);
    src.dispose();
  });

  it('answers that are not what the contract says read as nothing', async () => {
    const w = buildWorld({ VITE_KEEPER_URL: 'https://keeper.example' });
    const { f } = fetcher({ '/v1/stats': { status: 200, body: { asOf: 'x', block: 1, sharePrice: '1', apy7d: '5%' } } });
    const { src } = source(w, null, { keeper: createKeeperClient(w.config.keeperUrl, f) });
    await src.refresh();
    expect(src.snapshot(null).keeper).toMatchObject({ reachable: true, apy7d: null });
    src.dispose();
  });
});

describe('pending transaction and cleared loans (hooks for B4)', () => {
  function session(): SessionStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), remove: (k) => void data.delete(k) };
  }

  it('keeps a pending transaction across a reload and clears it once the receipt is mined', async () => {
    const w = buildWorld();
    const store = session();
    const hash = `0x${'cd'.repeat(32)}` as const;
    const one = source(w, ACCOUNT, { session: store });
    addAccount(w, ACCOUNT, {});
    one.src.setPending({ action: 'supply', since: NOW, hash });
    expect(store.data.get('tp:pending:196')).toContain(hash);
    one.src.dispose();

    const two = source(w, ACCOUNT, { session: store });
    expect(two.src.snapshot(null).pending).toEqual({ action: 'supply', since: NOW, hash });
    await two.src.refresh();
    expect(two.src.snapshot(null).pending).not.toBeNull(); // not mined yet
    w.x.receipts.set(hash, { success: true, blockNumber: w.x.number });
    await two.src.refresh();
    expect(two.src.snapshot(null).pending).toBeNull();
    expect(store.data.has('tp:pending:196')).toBe(false);
    two.src.dispose();
  });

  it('shows "Debt cleared" only for a loan whose repayment the session saw', async () => {
    const w = standardWorld();
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    expect(src.snapshot(null).loans[0]?.phase).toBe('active');
    // the loan is repaid: loanOf() is all zeros again, the voucher is still in the agent
    const ag = w.state.agents.get(AGENT2.toLowerCase());
    if (ag) ag.loan = noLoan();
    await src.refresh();
    expect(src.snapshot(null).loans).toEqual([]); // no receipt seen: the rigs are "in your agent, no loan" (row 4)
    expect(kinds(src.snapshot(null))[301]).toBe('in-agent');
    src.noteLoanCleared(AGENT2, { clearedAt: NOW + 100, surplus: 1_234n });
    const L = src.snapshot(null).loans[0];
    expect(L).toMatchObject({ phase: 'cleared', clearedAt: NOW + 100, surplus: 1_234n, principal: 0n, feeLeft: 0n, advance: 60_000_000n });
    // once the voucher leaves the agent there is nothing more to say about that loan
    if (ag) ag.collateral = [];
    await src.refresh();
    expect(src.snapshot(null).loans).toEqual([]);
    src.dispose();
  });
});

describe('what B4 added to the source', () => {
  it('estimates the gas of a borrow once an agent has a quote, and keeps the constant when the node cannot', async () => {
    const w = standardWorld();
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    // 300,000 gas estimated, a fifth on top, twice the price (the price moves) at 0.02 gwei
    expect(src.snapshot(null).wallet.borrowGas).toBe(((300_000n * 12n) / 10n) * 2n * 20_000_000n);
    expect(w.x.estimates.at(-1)).toMatchObject({ from: ACCOUNT, to: AGENT1, value: 31_000_000_000_000_000n });
    src.dispose();

    const w2 = standardWorld();
    w2.x.gasFails = new Error('execution reverted');
    const two = source(w2, ACCOUNT);
    await two.src.refresh();
    expect(two.src.snapshot(null).wallet.borrowGas).toBe(1_200_000n * 2n * 20_000_000n);
    two.src.dispose();
  });

  it('does not turn the page into the wrong-network gate while a self-push is in progress on BSC', async () => {
    const w = standardWorld();
    const { src, wallet } = source(w, ACCOUNT, {});
    wallet.change(ACCOUNT, 56);
    await src.refresh();
    expect(src.snapshot(null).wallet.status).toBe('wrong-network');
    src.setPending({ action: 'selfpush', since: NOW, hash: null, chainId: 56 });
    expect(src.snapshot(null).wallet.status).toBe('connected');
    // only a self-push, and only on BSC
    src.setPending({ action: 'refresh', since: NOW, hash: null });
    expect(src.snapshot(null).wallet.status).toBe('wrong-network');
    src.setPending({ action: 'selfpush', since: NOW, hash: null, chainId: 56 });
    wallet.change(ACCOUNT, 1);
    expect(src.snapshot(null).wallet.status).toBe('wrong-network');
    src.setPending(null);
    wallet.change(ACCOUNT, 56);
    expect(src.snapshot(null).wallet.status).toBe('wrong-network');
    src.dispose();
  });

  describe('a pending transaction after a reload', () => {
    function session(): SessionStore & { data: Map<string, string> } {
      const data = new Map<string, string>();
      return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), remove: (k) => void data.delete(k) };
    }
    const hash = `0x${'ab'.repeat(32)}` as const;

    it('a self-push is looked up on BSC, and the outcome is reported once', async () => {
      const w = standardWorld();
      const store = session();
      store.set('tp:pending:196', JSON.stringify({ action: 'selfpush', since: NOW, hash, chainId: 56 }));
      const { src } = source(w, ACCOUNT, { session: store });
      const seen: { action: string; success: boolean }[] = [];
      src.onSettled((s) => seen.push(s));
      await src.refresh();
      expect(src.snapshot(null).pending).toMatchObject({ action: 'selfpush', chainId: 56 });
      w.x.receipts.set(hash, { success: true, blockNumber: 1n }); // a receipt on X Layer with the same hash is not the one
      await src.refresh();
      expect(src.snapshot(null).pending).not.toBeNull();
      w.b.receipts.set(hash, { success: false, blockNumber: 1n });
      await src.refresh();
      expect(src.snapshot(null).pending).toBeNull();
      expect(seen).toEqual([{ action: 'selfpush', success: false, hash }]);
      await src.refresh();
      expect(seen).toHaveLength(1);
      src.dispose();
    });

    it('a keeper request that survived the reload expires, but a mark set by this session is left to its action', async () => {
      const w = standardWorld();
      const store = session();
      store.set('tp:pending:196', JSON.stringify({ action: 'refresh', since: NOW - 10, hash: null }));
      const { src } = source(w, ACCOUNT, { session: store });
      await src.refresh();
      expect(src.snapshot(null).pending).not.toBeNull(); // 10 s old
      w.x.timestamp = NOW + 200;
      await src.refresh();
      expect(src.snapshot(null).pending).toBeNull();
      src.dispose();

      const two = source(w, ACCOUNT);
      two.src.setPending({ action: 'repay', since: NOW, hash });
      w.x.receipts.set(hash, { success: true, blockNumber: 1n });
      await two.src.refresh();
      expect(two.src.snapshot(null).pending).not.toBeNull(); // the repay action clears its own mark when it has the receipt
      two.src.dispose();
    });
  });
});

describe('the entry checks gate the Borrow button (SPEC-PHASE5-APP §6.1 step 4, §10)', () => {
  const book = MAINNET;

  /** The standard world, with the rig of AGENT1 selected in a borrow flow whose report is fresh. */
  async function flow(w: World) {
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    const ui = freshUi();
    ui.sel = [201];
    ui.agent = AGENT1;
    const snap = src.snapshot(null);
    const amount = deriveBorrow(snap, ui, snap.now)?.amount.value ?? 0n;
    ui.principalQuote = { agent: AGENT1, term: ui.term, principal: amount, value: await src.quoteFor(AGENT1, ui.term, amount) };
    return { src, snap, view: deriveBorrow(snap, ui, snap.now) };
  }

  it('lets the button turn on once the wiring and the agent have passed', async () => {
    const { src, snap, view } = await flow(standardWorld());
    expect(snap.entry?.[AGENT1.toLowerCase()]).toBeNull();
    expect(view?.report).toBe('fresh');
    expect(view?.canBorrow).toBe(true);
    src.dispose();
  });

  it('turns it off with the entry message when the wiring is wrong, and with its own message when the credit rule was swapped', async () => {
    const w = standardWorld();
    w.x.on(book.pool, tapePoolAbi, { asset: A(0xbad) });
    const bad = await flow(w);
    expect(bad.snap.entry?.[AGENT1.toLowerCase()]).toMatchObject({ kind: 'entry' });
    expect(bad.view?.canBorrow).toBe(false);
    expect(bad.view?.blockers.join(' ')).toContain('The app does not recognise this contract.');
    bad.src.dispose();

    const swapped = standardWorld();
    swapped.x.on(book.pool, tapePoolAbi, { policy: A(0xc0de) });
    const two = await flow(swapped);
    expect(two.snap.entry?.[AGENT1.toLowerCase()]).toEqual({ kind: 'policy-changed' });
    expect(two.view?.canBorrow).toBe(false);
    expect(two.view?.blockers.join(' ')).toContain('this app version must be updated');
    two.src.dispose();
  });

  it('turns it off when the agent is not a clone of the factory implementation, or is not the account\'s', async () => {
    const w = standardWorld();
    w.x.codes.set(AGENT1.toLowerCase(), '0x6000');
    expect((await flow(w)).view?.canBorrow).toBe(false);
    const other = standardWorld();
    other.x.on(book.factory, agentFactoryAbi, { borrowerOf: () => OTHER });
    const o = await flow(other);
    expect(o.snap.entry?.[AGENT1.toLowerCase()]).toMatchObject({ kind: 'entry' });
    expect(o.view?.canBorrow).toBe(false);
  });

  it('fails closed: a failed read is a failed check, and an agent not checked yet keeps the button off', async () => {
    const w = standardWorld();
    const { src } = source(w, ACCOUNT);
    await src.refresh();
    w.x.on(book.pool, tapePoolAbi, {
      asset: () => {
        throw new Error('the node could not answer'); // one read of the wiring fails
      },
    });
    await src.refresh();
    expect(src.snapshot(null).entry?.[AGENT1.toLowerCase()]).toMatchObject({ kind: 'entry' });
    // a snapshot that has no result for the agent yet waits; one from a source that runs no checks (the fixtures) does not
    const snap = src.snapshot(null);
    const ui = freshUi();
    ui.sel = [201];
    ui.agent = AGENT1;
    expect(deriveBorrow({ ...snap, entry: {} }, ui, snap.now)?.blockers.join(' ')).toContain('Checking the contracts');
    const { entry: _entry, ...noChecks } = snap;
    void _entry;
    expect(deriveBorrow({ ...noChecks, entry: { [AGENT1.toLowerCase()]: null } }, ui, snap.now)?.blockers.join(' ')).not.toContain('Checking the contracts');
    expect(deriveBorrow(noChecks, ui, snap.now)?.blockers.join(' ')).not.toContain('Checking the contracts');
    src.dispose();
  });
});


describe('redeploy release reconciliation', () => {
  it.each([null, OTHER])('refreshes ownership and preserves retries after a reload (%s)', async (owner) => {
    const w = standardWorld();
    const lens = A(99);
    w.config.book = { ...w.config.book, redeploy: true, lens };
    w.config.tapeLens = lens;
    w.x.on(w.config.book.pool, tapePoolAbi, { unvestedNow: 123n, vestEnd: BigInt(NOW + 100), perBorrowerAbs: 400_000_000n, lendLimit: [2_000_000n, 4] });
    w.x.on(lens, tapeLensAbi, { quote: ([agent, term]: readonly unknown[]) => w.state.quote(agent as Address, Number(term)) });
    w.x.on(w.config.book.voucher, voucherAbi, { ownerOf: () => { if (owner === null) throw new Error('unreadable'); return owner; } });
    const data = new Map<string, string>();
    const session: SessionStore = { get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), remove: (k) => void data.delete(k) };
    const { src } = source(w, ACCOUNT, { session });
    await src.refresh();
    src.noteRelease(AGENT1, 1);
    src.noteRelease(AGENT1, 2);
    expect(src.snapshot(null).agents.find((a) => a.address === AGENT1)).toMatchObject({ owners: { '201': owner }, releaseAttempted: true, releaseRetried: true });
    src.dispose();
    const restored = source(w, ACCOUNT, { session }).src;
    await restored.refresh();
    expect(restored.snapshot(null).agents.find((a) => a.address === AGENT1)?.releaseRetried).toBe(true);
    w.state.agents.get(AGENT1.toLowerCase())!.loan = openLoan();
    await restored.refresh();
    expect(restored.snapshot(null).agents.find((a) => a.address === AGENT1)?.releaseRetried).toBe(false);
    restored.dispose();
  });
});
