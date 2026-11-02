import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, getAbiItem, type Abi } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { agentFactoryAbi, creditPolicyAbi, erc20Abi, extraErrorsAbi, feedReceiverAbi, reporterAbi, rigAgentAbi, tapeLensAbi, tapePoolAbi, voucherAbi } from '../src/chain/abi';
import { legacyBorrowAbi } from '../src/chain/legacyAbi';
import { ChainActions, type WalletApi } from '../src/chain/actions';
import { cloneRuntime } from '../src/chain/checks';
import { errorText } from '../src/chain/errors';
import type { Eip1193Provider, WalletResult } from '../src/chain/wallet';
import type { ReceiptInfo } from '../src/chain/reader';
import { setLang } from '../src/i18n';
import type { Address, Hex, PendingTx, Quote } from '../src/model';
import type { ActionResult, MoveOptions } from '../src/source';
import { A, ACCOUNT, addAccount, addAgent, addRig, AGENT1, buildWorld, noLoan, NOW, openLoan, readyRig, type World } from './world';

/**
 * ChainActions against the in-memory chains: what is sent, in which order, and what is not sent. The wallet is a
 * recorder: it answers `eth_sendTransaction` with a hash and mines the receipt the test prepared.
 */

const IMPL = A(0x1177);
const OPS = 31_000_000_000_000_000n;
/** A move with no BEM mined before the loan to choose about: no debt to measure it against (the gate and the requirement are tested below). */
const FREE: MoveOptions = { debt: 0n, via: null };
const hex = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

interface Sent {
  chain: number;
  from: string;
  to: string;
  data: Hex;
  value: bigint;
  /** The `chainId` field of the request, which makes a wallet refuse it after a network change. */
  chainIdParam: string | undefined;
  /** The pending mark the app had set when the wallet was asked. */
  pending: PendingTx | null;
}

interface Rig {
  w: World;
  actions: ChainActions;
  sent: Sent[];
  pendings: (PendingTx | null)[];
  refreshes: () => number;
  cleared: { agent: Address; clearedAt: number; surplus: bigint | null }[];
  wallet: { chainId: number; switches: string[] };
  /** What the wallet does with the next `eth_sendTransaction`; by default it mines a successful receipt. */
  onSend: (tx: Sent) => ReceiptInfo | Error | void;
  keeperCalls: { url: string; body: string; headers: Record<string, string> }[];
  keeper: { answer: () => { status: number; body: unknown } | Error };
  clock: { ms: number };
}

const decode = (abi: unknown, data: Hex) => decodeFunctionData({ abi: [...(abi as Abi), ...legacyBorrowAbi], data });

function logOf(abi: unknown, address: Address, eventName: string, args: Record<string, unknown>) {
  const item = getAbiItem({ abi: abi as Abi, name: eventName }) as { inputs: readonly { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi: abi as Abi, eventName, args } as never) as Hex[];
  const plain = item.inputs.filter((i) => !i.indexed);
  const data = plain.length ? encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never) : '0x';
  return { address, topics, data };
}

function setup(over: { chainId?: number; keeper?: boolean; wallet?: Partial<WalletApi> } = {}): Rig {
  const w = buildWorld({ VITE_KEEPER_URL: over.keeper === false ? undefined : 'https://keeper.example' });
  const book = w.config.book;
  addAccount(w, ACCOUNT, { room: 39_800_000n });
  addAgent(w, AGENT1, { collateral: [301], owned: [301] });
  addRig(w, 301, readyRig(301, { report: { observedAt: NOW - 10, pending: 1_000_000n, total: 1_600_000n } }));
  // the wiring the entry checks read, and the clone code of the agent
  w.x.on(book.pool, tapePoolAbi, { asset: book.bem, factory: book.factory, opsFee: OPS, maxRedeem: 777n, deposit: 1n, withdraw: 1n, redeem: 1n });
  w.x.on(book.factory, agentFactoryAbi, {
    pool: book.pool,
    implementation: IMPL,
    borrowerOf: () => ACCOUNT,
    agentsOf: () => [AGENT1],
    predictAgent: ([, i]: readonly unknown[]) => (Number(i) === 1 ? A(0xa6e47001) : A(0xa6e47000 + Number(i))),
    create: A(0xa6e47002),
  });
  w.x.on(book.policy, creditPolicyAbi, { feed: book.receiver });
  w.x.codes.set(AGENT1.toLowerCase(), cloneRuntime(IMPL));
  w.x.on(AGENT1, rigAgentAbi, { borrow: [], repay: [], sweep: [], release: [], withdrawVoucher: [], register: [], claimLate: [] });
  w.x.on(book.bem, erc20Abi, { approve: true });
  w.x.on(book.voucher, voucherAbi, { ownerOf: () => ACCOUNT, safeTransferFrom: [] });
  w.b.on(book.reporter, reporterAbi, { quote: 1_650_000_000_000_000n, push: hex(7) });
  w.state.quote = () => okQuote();
  w.x.timestamp = NOW;
  w.b.timestamp = NOW;

  const rig: Rig = {
    w,
    actions: null as never,
    sent: [],
    pendings: [],
    refreshes: () => refreshes,
    cleared: [],
    wallet: { chainId: over.chainId ?? 196, switches: [] },
    onSend: () => undefined,
    keeperCalls: [],
    keeper: { answer: () => ({ status: 200, body: { status: 'queued' } }) },
    clock: { ms: 0 },
  };
  let refreshes = 0;
  let current: PendingTx | null = null;
  let n = 0;
  const provider: Eip1193Provider = {
    async request({ method, params }) {
      if (method === 'eth_chainId') return `0x${rig.wallet.chainId.toString(16)}`;
      if (method === 'eth_sendTransaction') {
        const tx = (params as [{ from: string; to: string; data: Hex; value?: Hex; chainId?: string }])[0];
        const s: Sent = { chain: rig.wallet.chainId, from: tx.from, to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n, chainIdParam: tx.chainId, pending: current };
        rig.sent.push(s);
        const r = rig.onSend(s);
        if (r instanceof Error) throw r;
        const hash = hex(++n + 1000);
        const chain = s.chain === 56 ? w.b : w.x;
        chain.receipts.set(hash, r ?? { success: true, blockNumber: chain.number, gasUsed: 123_456n, logs: [] });
        return hash;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const wallet = {
    account: ACCOUNT as Address | null,
    get chainId() {
      return rig.wallet.chainId;
    },
    eip1193: provider as Eip1193Provider | null,
    readChainId: async () => rig.wallet.chainId,
    switchTo: async (c: 'xlayer' | 'bsc'): Promise<WalletResult> => {
      rig.wallet.switches.push(c);
      rig.wallet.chainId = c === 'bsc' ? 56 : 196;
      return { ok: true };
    },
    connect: async (): Promise<WalletResult> => ({ ok: true }),
    disconnect: () => undefined,
  };
  const host = {
    now: () => w.x.timestamp,
    setPending: (p: PendingTx | null) => {
      current = p;
      rig.pendings.push(p);
    },
    refresh: async () => void refreshes++,
    noteLoanCleared: (agent: Address, info: { clearedAt: number; surplus: bigint | null }) => void rig.cleared.push({ agent, ...info }),
  };
  const fetchFn = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    rig.keeperCalls.push({ url, body: init.body, headers: init.headers });
    const a = rig.keeper.answer();
    if (a instanceof Error) throw a;
    return { status: a.status, json: async () => a.body };
  }) as unknown as typeof fetch;
  rig.actions = new ChainActions({
    wallet: { ...wallet, ...over.wallet },
    x: w.x,
    b: w.b,
    config: w.config,
    host,
    fetch: fetchFn,
    sleep: async (ms) => void (rig.clock.ms += ms),
    clock: () => rig.clock.ms,
  });
  return rig;
}


function okQuote(over: Partial<Quote> = {}): Quote {
  return { maxPrincipal: 80_000_000n, fee: 700_000n, expected: 100_000_000n, inputBits: 0b11111 << 7, reason: 0, pending: 0n, opsFee: OPS, ...over };
}

/** The error a revert with this name and arguments carries, as a node returns it. */
function revert(abi: unknown, errorName: string, args: unknown[] = []): { code: number; message: string; data: Hex } {
  return { code: 3, message: 'execution reverted', data: encodeErrorResult({ abi: abi as Abi, errorName, args } as never) };
}

const text = (r: ActionResult): string => (r.error ? errorText(r.error) : '');

beforeEach(() => setLang('en', false));

describe('redeploy transactions (RC-02 to RC-04, RC-09)', () => {
  const args = { agent: AGENT1, term: 0 as const, principal: 2_000_000n, maxFee: 100_000n, maxLateBps: 3, opsFee: OPS, ids: [301] };
  function redeploy(r: Rig, fee = 100_000n, late = 3) {
    const lens = A(0x1e45);
    r.w.config.book = { ...r.w.config.book, redeploy: true, lens };
    r.w.config.tapeLens = lens;
    r.w.x.on(lens, tapeLensAbi, { quoteFor: ([agent, term, principal]: readonly unknown[]) => {
      expect([agent, term, principal]).toEqual([AGENT1, 0, 2_000_000n]);
      return [fee, late, 2_000_000n + fee, true, 0, 0];
    } });
  }

  it('submits a below-maximum loan with exactly the displayed bounds, also when the fresh fee falls', async () => {
    const r = setup();
    redeploy(r, 99_999n, 2);
    expect((await r.actions.borrow(args)).ok).toBe(true);
    expect(decode(rigAgentAbi, r.sent[0]!.data)).toEqual({ functionName: 'borrow', args: [0, 2_000_000n, 100_000n, 3] });
    expect(r.w.x.calls.some((c) => c.to === r.w.config.tapeLens && c.inner === 0 && !c.code)).toBe(true);
  });

  it.each(['fee', 'late'])('stops before the wallet when the fresh %s increases', async (which) => {
    const r = setup();
    redeploy(r, which === 'fee' ? 100_001n : 100_000n, which === 'late' ? 4 : 3);
    const result = await r.actions.borrow(args);
    expect(text(result)).toBe('The fee changed. Review the new quote.');
    expect(r.sent).toHaveLength(0);
    expect(r.refreshes()).toBeGreaterThan(0);
  });

  it('maps a FeeAboveBound race during submission to the same message and refreshes', async () => {
    const r = setup();
    redeploy(r);
    r.onSend = () => Object.assign(new Error('execution reverted'), revert(rigAgentAbi, 'FeeAboveBound', [100_001n, 3]));
    expect(text(await r.actions.borrow(args))).toBe('The fee changed. Review the new quote.');
    expect(r.sent).toHaveLength(1);
    expect(r.refreshes()).toBeGreaterThan(0);
  });

  it('refuses registration and moving vouchers into an agent with an open loan', async () => {
    const r = setup();
    r.w.state.agents.get(AGENT1.toLowerCase())!.loan = openLoan();
    expect((await r.actions.register(AGENT1, 301)).error).toMatchObject({ reason: 11 });
    expect((await r.actions.moveVouchers(AGENT1, [301], FREE)).error).toMatchObject({ reason: 11 });
    expect(r.sent).toHaveLength(0);
  });

  it('quotes the reporter directly, isolates unreadable custody and prices each remaining prompt', async () => {
    const r = setup();
    const reporter = r.w.config.book.reporter;
    r.w.b.on(reporter, reporterAbi, { quote: ([ids]: readonly unknown[]) => {
      if ((ids as bigint[]).includes(302n)) throw revert(reporterAbi, 'CustodyUnreadable', [302n]);
      return (ids as bigint[])[0] === 301n ? 1_000_000_000_000_000n : 2_000_000_000_000_000n;
    } });
    for (const id of [303]) addRig(r.w, id, readyRig(id, { report: { observedAt: NOW } }));
    r.w.state.rigs.get(301)!.report = { observedAt: NOW };
    const result = await r.actions.selfPush([301, 302, 303]);
    expect(result.ok).toBe(true);
    expect(result.notice?.()).toContain('Custody cannot be read for #302');
    expect(r.sent.map((s) => decode(reporterAbi, s.data).args)).toEqual([[[301n]], [[303n]]]);
    expect(r.sent.map((s) => s.value)).toEqual([1_100_000_000_000_000n, 2_200_000_000_000_000n]);
    expect(r.sent.map((s) => s.pending?.ask?.value)).toEqual(['0.0011 BNB', '0.0022 BNB']);
    expect(r.w.b.calls.filter((c) => c.to.toLowerCase() === reporter.toLowerCase()).every((c) => c.inner === 0)).toBe(true);
    expect(r.wallet.chainId).toBe(196);
  });

  it('uses only Released ids, refreshes the remaining collateral, and supports a retry and forget', async () => {
    const r = setup();
    const ag = r.w.state.agents.get(AGENT1.toLowerCase())!;
    ag.collateral = [301, 302];
    let attempt = 0;
    r.onSend = () => {
      ag.collateral = [302];
      return { success: true, blockNumber: r.w.x.number, logs: [logOf(rigAgentAbi, AGENT1, 'Released', { agent: AGENT1, ids: ++attempt === 1 ? [301n] : [] })] };
    };
    const first = await r.actions.release(AGENT1);
    expect(first.flash).toMatchObject({ kind: 'released', ids: [301] });
    expect(first.notice?.()).toContain('Some vouchers remain');
    const retry = await r.actions.release(AGENT1);
    expect(retry.flash).toBeUndefined();
    expect(r.refreshes()).toBeGreaterThanOrEqual(4);
    r.w.x.on(AGENT1, rigAgentAbi, { forget: [] });
    expect((await r.actions.forget(AGENT1, 302)).ok).toBe(true);
    expect(decode(rigAgentAbi, r.sent.at(-1)!.data)).toEqual({ functionName: 'forget', args: [302n] });
  });
});

describe('simulate first, say what the wallet will ask, never retry', () => {
  it('a revert in the simulation is shown and the wallet is never asked', async () => {
    const r = setup();
    r.w.x.on(AGENT1, rigAgentAbi, {
      borrow: () => {
        throw revert(rigAgentAbi, 'WrongOpsFee', [OPS + 1n]);
      },
    });
    const res = await r.actions.sweep(AGENT1).then(() => r.actions.borrow({ agent: AGENT1, term: 0, maxFee: 700_000n, maxLateBps: 0, principal: 5_000_000n, opsFee: OPS, ids: [301] }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ kind: 'revert', name: 'WrongOpsFee' });
    expect(text(res)).toContain('0.031'); // the pre-sign read agrees with the screen, so this is the simulation talking
    expect(r.sent.filter((s) => s.to === AGENT1 && decode(rigAgentAbi, s.data).functionName === 'borrow')).toHaveLength(0);
  });

  it('the line for the wallet is set before the wallet is asked, and stays until the receipt', async () => {
    const r = setup();
    const res = await r.actions.sweep(AGENT1);
    expect(res.ok).toBe(true);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.pending).toMatchObject({ action: 'sweep', hash: null, ask: { contract: expect.stringContaining('RigAgent'), fn: 'sweep()', value: '0 OKB' } });
    // the request names its chain, so a wallet that switched network meanwhile refuses it
    expect(r.sent[0]?.chainIdParam).toBe(`0x${(196).toString(16)}`);
    // after the hash is known the same line says it waits; the mark is gone at the end
    expect(r.pendings.map((p) => p?.hash ?? null)).toEqual([null, expect.stringMatching(/^0x/), null]);
    expect(r.refreshes()).toBe(1);
  });

  it('a cancelled prompt is the user\'s choice: no retry, nothing left pending', async () => {
    const r = setup();
    r.onSend = () => Object.assign(new Error('User rejected'), { code: 4001 });
    const res = await r.actions.sweep(AGENT1);
    expect(res.error).toEqual({ kind: 'wallet-rejected' });
    expect(r.sent).toHaveLength(1);
    expect(r.pendings.at(-1)).toBeNull();
  });

  it('a wallet that refuses with the revert data gets the same message as the simulation', async () => {
    const r = setup();
    r.onSend = () => Object.assign(new Error('execution reverted'), revert(rigAgentAbi, 'LoanOpen'));
    const res = await r.actions.release(AGENT1);
    expect(res.error).toMatchObject({ kind: 'revert', name: 'LoanOpen' });
    expect(r.sent).toHaveLength(1);
  });

  it('a mined revert is replayed to find the reason, else it says the transaction failed', async () => {
    const r = setup();
    r.onSend = () => ({ success: false, blockNumber: r.w.x.number });
    expect((await r.actions.sweep(AGENT1)).error).toMatchObject({ kind: 'tx-failed' });
    // the state changes while the transaction is on its way: the simulation passed, the replay gives the reason
    r.onSend = () => {
      r.w.x.on(AGENT1, rigAgentAbi, {
        sweep: () => {
          throw revert(rigAgentAbi, 'NoLoan');
        },
      });
      return { success: false, blockNumber: r.w.x.number };
    };
    expect((await r.actions.sweep(AGENT1)).error).toMatchObject({ kind: 'revert', name: 'NoLoan' });
  });

  it('refuses to send from the wrong chain, and a confirmed wait that times out stays pending', async () => {
    const r = setup({ chainId: 56 });
    expect((await r.actions.sweep(AGENT1)).error).toEqual({ kind: 'wrong-chain', want: 'xlayer' });
    expect(r.sent).toHaveLength(0);
    const q = setup();
    q.w.x.receipt = async () => null; // the transaction is sent and never mined
    const res = await q.actions.sweep(AGENT1);
    expect(res.ok).toBe(false);
    expect(res.error).toBeUndefined();
    expect(res.notice?.()).toContain('not confirmed yet');
    expect(q.pendings.at(-1)?.hash).toMatch(/^0x/); // still marked, so a reload shows the outcome
    expect(q.clock.ms).toBeGreaterThanOrEqual(180_000);
  });
});

describe('the entry checks (§10) run before entries and never before exits', () => {
  it('block supply, create, move and borrow when the wiring is wrong', async () => {
    const r = setup();
    r.w.x.on(r.w.config.book.pool, tapePoolAbi, { asset: A(0xbad) });
    const bad = { kind: 'entry' };
    expect((await r.actions.approveSupply(1_000_000n)).error).toMatchObject(bad);
    expect((await r.actions.supply(1_000_000n)).error).toMatchObject(bad);
    expect((await r.actions.createAgent()).error).toMatchObject(bad);
    expect((await r.actions.moveVouchers(AGENT1, [301], FREE)).error).toMatchObject(bad);
    expect((await r.actions.borrow({ agent: AGENT1, term: 0, maxFee: 700_000n, maxLateBps: 0, principal: 5_000_000n, opsFee: OPS, ids: [301] })).error).toMatchObject(bad);
    expect(r.sent).toHaveLength(0);
    expect(text(await r.actions.createAgent())).toBe('The app does not recognise this contract. Do not continue; check the official links.');
  });

  it('check each link of the wiring: factory, the factory\'s pool and the policy\'s feed', async () => {
    for (const [what, patch] of [
      ['pool.factory', () => setupWith((r) => r.w.x.on(r.w.config.book.pool, tapePoolAbi, { factory: A(0xbad) }))],
      ['factory.pool', () => setupWith((r) => r.w.x.on(r.w.config.book.factory, agentFactoryAbi, { pool: A(0xbad) }))],
    ] as const) {
      const r = patch();
      expect((await r.actions.supply(1_000_000n)).error, what).toMatchObject({ kind: 'entry' });
    }
    const r = setupWith((q) => q.w.x.on(q.w.config.book.policy, creditPolicyAbi, { feed: A(0xbad) }));
    expect((await r.actions.borrow({ agent: AGENT1, term: 0, maxFee: 700_000n, maxLateBps: 0, principal: 5_000_000n, opsFee: OPS, ids: [301] })).error).toMatchObject({ kind: 'entry' });
    expect((await r.actions.supply(1_000_000n)).error?.kind).not.toBe('entry'); // the feed is a borrow-only check
  });

  it('a swapped credit rule blocks borrow only, with its own message', async () => {
    const r = setup();
    r.w.x.on(r.w.config.book.pool, tapePoolAbi, { policy: A(0xc0de) });
    const res = await r.actions.borrow({ agent: AGENT1, term: 0, maxFee: 700_000n, maxLateBps: 0, principal: 5_000_000n, opsFee: OPS, ids: [301] });
    expect(res.error).toEqual({ kind: 'policy-changed' });
    expect(text(res)).toBe('The credit rule changed; this app version must be updated.');
    r.w.state.accounts.get(ACCOUNT.toLowerCase())!.allowancePool = 10n ** 9n;
    r.w.x.on(r.w.config.book.bem, erc20Abi, { allowance: () => 10n ** 9n });
    expect((await r.actions.supply(1_000_000n)).ok).toBe(true);
  });

  it('check the agent: its code must be the clone of the factory\'s implementation and the factory must name the account', async () => {
    const r = setup();
    r.w.x.codes.set(AGENT1.toLowerCase(), cloneRuntime(A(0x666)));
    expect((await r.actions.moveVouchers(AGENT1, [301], FREE)).error).toMatchObject({ kind: 'entry' });
    expect((await r.actions.approveRepay(AGENT1, 5n)).error).toMatchObject({ kind: 'entry' });
    expect((await r.actions.register(AGENT1, 301)).error).toMatchObject({ kind: 'entry' });
    r.w.x.codes.set(AGENT1.toLowerCase(), '0x');
    expect((await r.actions.borrow({ agent: AGENT1, term: 0, maxFee: 700_000n, maxLateBps: 0, principal: 5_000_000n, opsFee: OPS, ids: [301] })).error).toMatchObject({ kind: 'entry' });
    r.w.x.codes.set(AGENT1.toLowerCase(), cloneRuntime(IMPL));
    r.w.x.on(r.w.config.book.factory, agentFactoryAbi, { borrowerOf: () => A(0x0b0b) });
    expect((await r.actions.moveVouchers(AGENT1, [301], FREE)).error).toMatchObject({ kind: 'entry' });
    expect(r.sent).toHaveLength(0);
  });

  it('a read that fails is a failed check', async () => {
    const r = setup();
    r.w.x.failIf = () => true;
    expect((await r.actions.createAgent()).error).toMatchObject({ kind: 'entry' });
  });

  it('never stand between the user and an exit, whatever the wiring says', async () => {
    const r = setup();
    const { book } = r.w.config;
    r.w.x.on(book.pool, tapePoolAbi, { asset: A(0xbad), factory: A(0xbad), policy: A(0xbad) });
    r.w.x.on(book.factory, agentFactoryAbi, { pool: A(0xbad), borrowerOf: () => A(0x0b0b) });
    r.w.x.codes.set(AGENT1.toLowerCase(), '0x6000');
    expect((await r.actions.release(AGENT1)).ok).toBe(true);
    expect((await r.actions.takeBack(AGENT1, 301)).ok).toBe(true);
    expect((await r.actions.claimLate(AGENT1)).ok).toBe(true);
    expect((await r.actions.sweep(AGENT1)).ok).toBe(true);
    expect((await r.actions.withdraw(5_000_000n, false)).ok).toBe(true);
    // repay: the approval is a pull on the account, and the agent is already approved
    r.w.state.agents.get(AGENT1.toLowerCase())!.loan = openLoan();
    r.w.state.agents.get(AGENT1.toLowerCase())!.allowance = 10n ** 9n;
    expect((await r.actions.repay(AGENT1, 5_000_000n, false)).ok).toBe(true);
    expect(r.sent.map((s) => decode(s.to.toLowerCase() === book.pool.toLowerCase() ? tapePoolAbi : rigAgentAbi, s.data).functionName)).toEqual(['release', 'withdrawVoucher', 'claimLate', 'sweep', 'withdraw', 'repay']);
  });
});

function setupWith(fn: (r: Rig) => void): Rig {
  const r = setup();
  fn(r);
  return r;
}

describe('create, move', () => {
  it('create counts up from the number of agents to the first address with no code', async () => {
    const r = setup();
    // agentsOf has 1 agent; predictAgent(1) has code, predictAgent(2) does not
    r.w.x.codes.set(A(0xa6e47001).toLowerCase(), '0x6000');
    const res = await r.actions.createAgent();
    expect(res.ok).toBe(true);
    const tx = r.sent[0];
    expect(tx?.to).toBe(r.w.config.book.factory);
    expect(decode(agentFactoryAbi, tx?.data as Hex)).toMatchObject({ functionName: 'create', args: [2n] });
    expect(tx?.pending?.ask).toMatchObject({ fn: 'create(2)', value: '0 OKB' });
  });

  it('create reads the new agent from the AgentCreated event', async () => {
    const r = setup();
    const created = A(0xa6e47aaa);
    r.onSend = () => ({ success: true, blockNumber: r.w.x.number, logs: [logOf(agentFactoryAbi, r.w.config.book.factory, 'AgentCreated', { agent: created, borrower: ACCOUNT, index: 1n })] });
    expect(await r.actions.createAgent()).toMatchObject({ ok: true, agent: created });
  });

  it('move sends safeTransferFrom(you, agent, id) for each rig, never a plain transferFrom', async () => {
    const r = setup();
    addRig(r.w, 302, readyRig(302));
    expect((await r.actions.moveVouchers(AGENT1, [301, 302], FREE)).ok).toBe(true);
    expect(r.sent.map((s) => decode(voucherAbi, s.data))).toEqual([
      { functionName: 'safeTransferFrom', args: [ACCOUNT, AGENT1, 301n] },
      { functionName: 'safeTransferFrom', args: [ACCOUNT, AGENT1, 302n] },
    ]);
    expect(r.sent.every((s) => s.to === r.w.config.book.voucher && s.value === 0n)).toBe(true);
    // the selector is the 3-argument safeTransferFrom
    expect(r.sent[0]?.data.slice(0, 10)).toBe('0x42842e0e');
  });

  it('move stops at a voucher that is not in the wallet', async () => {
    const r = setup();
    addRig(r.w, 302, readyRig(302));
    r.w.x.on(r.w.config.book.voucher, voucherAbi, { ownerOf: ([id]: readonly unknown[]) => (Number(id) === 302 ? A(0x0b0b) : ACCOUNT) });
    const res = await r.actions.moveVouchers(AGENT1, [301, 302], FREE);
    expect(res.error).toMatchObject({ kind: 'revert', name: 'ERC721IncorrectOwner' });
    expect(r.sent).toHaveLength(1);
  });
});

describe('refresh rig data through the keeper (§6.1 step 3)', () => {
  const reportAt = (r: Rig, at: number | null) => {
    const rig = r.w.state.rigs.get(301);
    if (rig) rig.report = at === null ? null : { observedAt: at, pending: 1_000_000n, total: 1_600_000n };
  };

  it('posts {"agent"} as JSON, waits until the report is timely by chain time, and offers nothing more', async () => {
    const r = setup();
    reportAt(r, NOW - 3_000); // stale
    let polls = 0;
    r.w.x.on(r.w.config.book.receiver, feedReceiverAbi, {
      latest: ([id]: readonly unknown[]) => {
        polls++;
        if (polls === 3) reportAt(r, NOW - 5);
        const rig = r.w.state.rigs.get(Number(id));
        return latestRow(r, Number(id), rig?.report?.observedAt ?? 0);
      },
    });
    const res = await r.actions.refreshRigData(AGENT1, [301]);
    expect(res.ok).toBe(true);
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(r.keeperCalls).toHaveLength(1);
    expect(r.keeperCalls[0]).toMatchObject({ url: 'https://keeper.example/v1/push', body: JSON.stringify({ agent: AGENT1 }) });
    expect(r.keeperCalls[0]?.headers['content-type']).toBe('application/json');
    expect(r.pendings.map((p) => p?.action ?? null)).toEqual(['refresh', null]);
    expect(r.sent).toHaveLength(0); // no transaction, no BNB
  });

  it('"fresh" still waits for timely reports', async () => {
    const r = setup();
    reportAt(r, NOW - 10);
    r.keeper.answer = () => ({ status: 200, body: { status: 'fresh' } });
    expect((await r.actions.refreshRigData(AGENT1, [301])).ok).toBe(true);
  });

  it('times out after 120 s and offers the self-push', async () => {
    const r = setup();
    reportAt(r, NOW - 3_000);
    const res = await r.actions.refreshRigData(AGENT1, [301]);
    expect(res).toMatchObject({ ok: false, offerSelfPush: true, error: { kind: 'keeper', reason: 'timeout' } });
    expect(r.clock.ms).toBeGreaterThanOrEqual(120_000);
    expect(r.clock.ms).toBeLessThan(130_000);
  });

  it('a report from the future by more than 60 s is not timely either', async () => {
    const r = setup();
    reportAt(r, NOW + 500);
    expect((await r.actions.refreshRigData(AGENT1, [301])).error).toMatchObject({ reason: 'timeout' });
  });

  it('maps every refusal and offers the self-push only where the keeper cannot help', async () => {
    const cases: [string, boolean][] = [
      ['not eligible', false],
      ['rig daily limit', true],
      ['borrower daily limit', true],
      ['daily push budget used, push it yourself', true],
      ['keeper reserve', true],
      ['upgrade pending', true],
      ['dry mode', true],
      ['not deployed', true],
      ['too many requests from this address', false],
      ['busy, try again shortly', false],
      ['not an agent', false],
    ];
    for (const [reason, offer] of cases) {
      const r = setup();
      r.keeper.answer = () => ({ status: 200, body: { status: 'refused', reason } });
      const res = await r.actions.refreshRigData(AGENT1, [301]);
      expect(res.error, reason).toEqual({ kind: 'keeper', reason });
      expect(res.offerSelfPush === true, reason).toBe(offer);
      expect(text(res), reason).not.toBe('Something went wrong. Nothing was sent.');
    }
  });

  it('a keeper that cannot be reached, answers 5xx or answers nonsense offers the self-push; so does no keeper at all', async () => {
    for (const answer of [() => new Error('network'), () => ({ status: 503, body: {} }), () => ({ status: 200, body: { status: 'launch' } }), () => ({ status: 200, body: 'x' })]) {
      const r = setup();
      r.keeper.answer = answer;
      expect(await r.actions.refreshRigData(AGENT1, [301])).toMatchObject({ ok: false, offerSelfPush: true, error: { kind: 'keeper', reason: 'unreachable' } });
    }
    const none = setup({ keeper: false });
    expect(await none.actions.refreshRigData(AGENT1, [301])).toMatchObject({ ok: false, offerSelfPush: true });
    expect(none.keeperCalls).toHaveLength(0);
  });
});

function latestRow(r: Rig, id: number, observedAt: number): unknown {
  const b = r.w.state.rigs.get(id)?.bsc;
  if (!b || observedAt === 0) return [{ rigId: BigInt(id), circuitId: 0n, since: 0n, stopBlock: 0n, circuits: '0x0000000000000000000000000000000000000000', observedAt: 0n, status: 0, custodied: false, verifWeight: 0n, bonus: 0n, totalVerifWeight: 0n, bscBlock: 0n, pending: 0n, taskId: 0 }, false];
  return [{ rigId: BigInt(id), circuitId: b.circuitId, since: BigInt(b.since), stopBlock: 0n, circuits: b.circuits, observedAt: BigInt(observedAt), status: 1, custodied: true, verifWeight: b.verifWeight, bonus: b.bonus, totalVerifWeight: 1_600_000n, bscBlock: 1n, pending: 0n, taskId: 4 }, true];
}

describe('borrow (§6.1 step 4)', () => {
  const args = { agent: AGENT1, term: 0 as const, maxFee: 700_000n, maxLateBps: 0, principal: 5_000_000n, opsFee: OPS, ids: [301] };

  it('re-reads the fee and the quote, then sends borrow(term, principal) with exactly the fee as the value', async () => {
    const r = setup();
    const res = await r.actions.borrow(args);
    expect(res).toMatchObject({ ok: true, go: '/rigs/301', flash: { kind: 'borrowed', rigId: 301, amount: 5_000_000n, opsFee: OPS } });
    expect(r.sent).toHaveLength(1);
    expect(decode(rigAgentAbi, r.sent[0]?.data as Hex)).toEqual({ functionName: 'borrow', args: [0, 5_000_000n] });
    expect(r.sent[0]?.value).toBe(OPS);
    expect(r.sent[0]?.pending?.ask).toMatchObject({ fn: 'borrow(7 days, 0.0500 BEM)', value: '0.031 OKB' });
  });

  it('does not send when the fee on chain is not the one on screen, and says what it is now', async () => {
    const r = setup();
    const res = await r.actions.borrow({ ...args, opsFee: OPS - 1n });
    expect(res.error).toMatchObject({ kind: 'revert', name: 'WrongOpsFee' });
    expect(text(res)).toBe('The operating fee changed. It is now 0.031 OKB. Review and sign again.');
    expect(r.sent).toHaveLength(0);
    expect(r.refreshes()).toBeGreaterThan(0); // the screen reads the new fee
  });

  it('a fee that moves between the simulation and the prompt comes back as WrongOpsFee and the screen is refreshed', async () => {
    const r = setup();
    r.onSend = () => Object.assign(new Error('execution reverted: WrongOpsFee'), revert(rigAgentAbi, 'WrongOpsFee', [OPS * 2n]));
    const res = await r.actions.borrow(args);
    expect(text(res)).toContain('0.062 OKB');
    expect(r.refreshes()).toBeGreaterThan(0);
  });

  it('refuses an advance outside minAdvance..maxPrincipal, a quote that says no, and reports that are not timely', async () => {
    const r = setup();
    expect((await r.actions.borrow({ ...args, maxFee: 700_000n, maxLateBps: 0, principal: 999_999n })).error).toMatchObject({ kind: 'revert', name: 'BelowMinAdvance' });
    expect((await r.actions.borrow({ ...args, maxFee: 700_000n, maxLateBps: 0, principal: 80_000_001n })).error).toMatchObject({ kind: 'quote', reason: 14 });
    r.w.state.quote = () => okQuote({ reason: 7, maxPrincipal: 0n });
    expect((await r.actions.borrow(args)).error).toMatchObject({ kind: 'quote', reason: 7 });
    r.w.state.quote = () => null;
    expect((await r.actions.borrow(args)).error).toMatchObject({ kind: 'quote', reason: 4 });
    r.w.state.quote = () => okQuote();
    r.w.state.rigs.get(301)!.report = { observedAt: NOW - 400 };
    expect((await r.actions.borrow(args)).error).toMatchObject({ kind: 'quote', reason: 6 });
    expect(r.sent).toHaveLength(0);
  });

  it('with an OKB fee of 0 sends no value', async () => {
    const r = setup();
    r.w.x.on(r.w.config.book.pool, tapePoolAbi, { opsFee: 0n });
    r.w.state.quote = () => okQuote({ opsFee: 0n });
    expect((await r.actions.borrow({ ...args, opsFee: 0n })).ok).toBe(true);
    expect(r.sent[0]?.value).toBe(0n);
    expect(r.sent[0]?.pending?.ask?.value).toBe('0 OKB');
  });
});

describe('repay, sweep and what a receipt tells (§6.2)', () => {
  function withLoan(r: Rig, over: { bem?: bigint; allowance?: bigint } = {}) {
    const ag = r.w.state.agents.get(AGENT1.toLowerCase())!;
    ag.loan = openLoan({ debt: 50_450_000n });
    ag.bem = over.bem ?? 0n;
    ag.allowance = over.allowance ?? 0n;
    return ag;
  }

  it('approves the agent (the spender is the agent, not the pool), only when the allowance is below the amount', async () => {
    const r = setup();
    withLoan(r, { allowance: 100n });
    expect((await r.actions.approveRepay(AGENT1, 50_000_000n)).ok).toBe(true);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.to).toBe(r.w.config.book.bem);
    expect(decode(erc20Abi, r.sent[0]?.data as Hex)).toEqual({ functionName: 'approve', args: [AGENT1, 50_000_000n] });
    expect(r.sent[0]?.pending?.ask?.fn).toContain('approve(your Rig Agent');
    // already enough: nothing is sent
    r.w.state.agents.get(AGENT1.toLowerCase())!.allowance = 60_000_000n;
    expect((await r.actions.approveRepay(AGENT1, 50_000_000n)).notice?.()).toContain('already allowed');
    expect(r.sent).toHaveLength(1);
  });

  it('repay needs min(amount, debt - the agent\'s BEM) approved, and says so without asking the wallet', async () => {
    const r = setup();
    withLoan(r, { bem: 10_000_000n, allowance: 30_000_000n });
    // debt 50.45, agent holds 10: 40.45 would be pulled
    const short = await r.actions.repay(AGENT1, 50_450_000n, true);
    expect(short.error).toMatchObject({ kind: 'revert', name: 'ERC20InsufficientAllowance' });
    expect(r.sent).toHaveLength(0);
    r.w.state.agents.get(AGENT1.toLowerCase())!.allowance = 40_450_000n;
    expect((await r.actions.repay(AGENT1, 50_450_000n, true)).ok).toBe(true);
    expect(decode(rigAgentAbi, r.sent[0]?.data as Hex)).toEqual({ functionName: 'repay', args: [50_450_000n] });
    // a partial repayment needs only what it pulls
    r.w.state.agents.get(AGENT1.toLowerCase())!.allowance = 5_000_000n;
    expect((await r.actions.repay(AGENT1, 5_000_000n, false)).ok).toBe(true);
  });

  it('offers the sweep when the agent\'s own BEM covers the debt, and sends nothing', async () => {
    const r = setup();
    withLoan(r, { bem: 60_000_000n });
    const res = await r.actions.repay(AGENT1, 1n, true);
    expect(res.ok).toBe(false);
    expect(res.notice?.()).toContain('already covers the debt');
    expect(r.sent).toHaveLength(0);
  });

  it('no loan is NoLoan', async () => {
    const r = setup();
    r.w.state.agents.get(AGENT1.toLowerCase())!.loan = noLoan();
    expect((await r.actions.repay(AGENT1, 1n, false)).error).toMatchObject({ name: 'NoLoan' });
  });

  it('LoanClosed in the receipt clears the loan for this session, with the receipt\'s time and the surplus', async () => {
    const r = setup();
    withLoan(r, { allowance: 60_000_000n });
    r.w.x.blockTimes = () => NOW + 42;
    r.onSend = () => ({
      success: true,
      blockNumber: r.w.x.number,
      logs: [
        logOf(rigAgentAbi, AGENT1, 'Swept', { agent: AGENT1, lateFeePaid: 0n, feePaid: 450_000n, principalPaid: 50_000_000n, leftover: 1_234n }),
        logOf(rigAgentAbi, AGENT1, 'LoanClosed', { agent: AGENT1 }),
      ],
    });
    const res = await r.actions.repay(AGENT1, 50_450_000n, true);
    expect(r.cleared).toEqual([{ agent: AGENT1, clearedAt: NOW + 42, surplus: 1_234n }]);
    expect(res.notice?.()).toContain('Debt cleared');
    // a sweep that closes the loan is the same
    r.cleared.length = 0;
    expect((await r.actions.sweep(AGENT1)).notice?.()).toContain('Debt cleared');
    expect(r.cleared).toHaveLength(1);
  });

  it('a receipt without LoanClosed leaves the loan open', async () => {
    const r = setup();
    withLoan(r, { allowance: 60_000_000n });
    const res = await r.actions.repay(AGENT1, 5_000_000n, false);
    expect(r.cleared).toEqual([]);
    expect(res.notice?.()).toContain('Repaid 0.0500 BEM');
  });

  it('release, take back, register and claim late call the agent with the right arguments', async () => {
    const r = setup();
    await r.actions.release(AGENT1);
    await r.actions.takeBack(AGENT1, 301);
    await r.actions.register(AGENT1, 302);
    await r.actions.claimLate(AGENT1);
    expect(r.sent.map((s) => decode(rigAgentAbi, s.data))).toEqual([
      { functionName: 'release' },
      { functionName: 'withdrawVoucher', args: [301n] },
      { functionName: 'register', args: [302n] },
      { functionName: 'claimLate' },
    ]);
    expect(r.sent.every((s) => s.to === AGENT1 && s.value === 0n)).toBe(true);
  });
});

describe('supply and withdraw', () => {
  it('approve the pool only when the allowance is below the amount, then deposit(assets, you)', async () => {
    const r = setup();
    const set = (n: bigint) => r.w.x.on(r.w.config.book.bem, erc20Abi, { allowance: () => n });
    set(5n);
    expect((await r.actions.supply(200_000_000n)).error).toMatchObject({ name: 'ERC20InsufficientAllowance' }); // no prompt: approve first
    expect(r.sent).toHaveLength(0);
    expect((await r.actions.approveSupply(200_000_000n)).ok).toBe(true);
    expect(decode(erc20Abi, r.sent[0]?.data as Hex)).toEqual({ functionName: 'approve', args: [r.w.config.book.pool, 200_000_000n] });
    set(200_000_000n);
    expect((await r.actions.approveSupply(200_000_000n)).notice?.()).toContain('already allowed');
    expect((await r.actions.supply(200_000_000n)).ok).toBe(true);
    expect(decode(tapePoolAbi, r.sent[1]?.data as Hex)).toEqual({ functionName: 'deposit', args: [200_000_000n, ACCOUNT] });
    expect(r.sent[1]?.pending?.ask).toMatchObject({ fn: 'deposit(2.0000 BEM, you)', value: '0 OKB' });
  });

  it('withdraw(assets) normally, redeem(maxRedeem) for MAX', async () => {
    const r = setup();
    await r.actions.withdraw(50_000_000n, false);
    await r.actions.withdraw(50_000_000n, true);
    expect(r.sent.map((s) => decode(tapePoolAbi, s.data))).toEqual([
      { functionName: 'withdraw', args: [50_000_000n, ACCOUNT, ACCOUNT] },
      { functionName: 'redeem', args: [777n, ACCOUNT, ACCOUNT] },
    ]);
  });

  it('shows the ERC-4626 caps as one message', async () => {
    const r = setup();
    r.w.x.on(r.w.config.book.pool, tapePoolAbi, {
      withdraw: () => {
        throw revert(tapePoolAbi, 'ERC4626ExceededMaxWithdraw', [ACCOUNT, 5n, 4n]);
      },
    });
    expect(text(await r.actions.withdraw(5n, false))).toBe('Above what the pool accepts right now (cap, or idle BEM).');
  });
});

describe('the self-push on BSC (§6.4)', () => {
  const ids = [301];
  const reportAt = (r: Rig, at: number) => {
    r.w.state.rigs.get(301)!.report = { observedAt: at };
  };

  it('switches to BSC, pushes with the quote plus 10%, waits for a new report, and switches back', async () => {
    const r = setup();
    reportAt(r, NOW - 100); // an older report is already there
    r.w.b.blockTimes = () => NOW - 2;
    r.onSend = () => {
      reportAt(r, NOW - 2); // the push lands
      return undefined;
    };
    const res = await r.actions.selfPush(ids);
    expect(res.ok).toBe(true);
    expect(r.wallet.switches).toEqual(['bsc', 'xlayer']);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ chain: 56, to: r.w.config.book.reporter, value: (1_650_000_000_000_000n * 11n) / 10n });
    expect(decode(reporterAbi, r.sent[0]?.data as Hex)).toEqual({ functionName: 'push', args: [[301n]] });
    expect(r.sent[0]?.pending?.ask).toMatchObject({ contract: expect.stringContaining('RigReporter'), fn: 'push([#301])', value: '0.001815 BNB' });
    // the mark is set from the start and kept to the end, so the wrong-network gate never replaces the page
    expect(r.pendings.map((p) => p?.action ?? null)).toEqual(['selfpush', 'selfpush', 'selfpush', null]);
    expect(r.pendings[0]?.chainId).toBe(56);
    expect(r.wallet.chainId).toBe(196);
  });

  it('does not stop at a report that was already there', async () => {
    const r = setup();
    reportAt(r, NOW - 100);
    r.w.b.blockTimes = () => NOW - 2; // the push block is newer than the report on X Layer, which never changes
    const res = await r.actions.selfPush(ids);
    expect(res.error).toEqual({ kind: 'report-late' });
    expect(text(res)).toContain('taking longer than usual');
    expect(r.wallet.chainId).toBe(196); // back on X Layer anyway
  });

  it('a LayerZero fee error and a refused switch are shown', async () => {
    const r = setup();
    r.w.b.on(r.w.config.book.reporter, reporterAbi, {
      push: () => {
        throw revert(extraErrorsAbi, 'LZ_InsufficientFee', [1n, 0n, 0n, 0n]);
      },
    });
    expect(text(await r.actions.selfPush(ids))).toBe('The BSC fee changed. Try again.');
    expect(r.sent).toHaveLength(0);
    expect(r.wallet.chainId).toBe(196);
  });
});


describe('the wallet and the network', () => {
  it('connects through the wallet the user picked, and passes the choice on', async () => {
    const asked: (string | undefined)[] = [];
    const r = setup({ wallet: { connect: async (id) => (asked.push(id), { ok: true }) } });
    expect((await r.actions.connect('sample-okx')).ok).toBe(true);
    expect((await r.actions.connect()).ok).toBe(true);
    expect(asked).toEqual(['sample-okx', undefined]);
  });

  it('a wallet that was picked and is gone is an error the dialog can show; with no choice it stays the old notice', async () => {
    const r = setup({ wallet: { connect: async () => ({ ok: false, noWallet: true }) } });
    const picked = await r.actions.connect('gone');
    expect(picked.error).toEqual({ kind: 'no-wallet' });
    expect(text(picked)).toBe('No wallet found. Install OKX Wallet, MetaMask or Rabby, then reload.');
    const none = await r.actions.connect();
    expect(none.error).toBeUndefined();
    expect(none.notice?.()).toBe('No wallet found. Install OKX Wallet, MetaMask or Rabby, then reload.');
  });

  it('a user rejection in the wallet is the cancelled line', async () => {
    const r = setup({ wallet: { connect: async () => ({ ok: false, error: { kind: 'wallet-rejected' } }) } });
    expect(text(await r.actions.connect('sample-okx'))).toBe('You cancelled in your wallet. Nothing was sent.');
  });

  it('a wallet that cannot go to X Layer says so, in both languages, and nothing is sent', async () => {
    const r = setup({ chainId: 56, wallet: { switchTo: async () => ({ ok: false, error: { kind: 'wallet-no-xlayer', details: 'Unrecognized chain ID' } }) } });
    const res = await r.actions.switchNetwork();
    expect(res.ok).toBe(false);
    expect(text(res)).toBe('This wallet cannot switch to X Layer. Try OKX Wallet, MetaMask or Rabby.');
    setLang('cn', false);
    expect(text(res)).toBe('该钱包无法切换到 X Layer。请改用 OKX Wallet、MetaMask 或 Rabby。');
    expect(r.sent).toHaveLength(0);
  });

  it('looking for wallets again goes to the wallet, and a failure there changes nothing', async () => {
    let scans = 0;
    const r = setup({ wallet: { scan: async () => void scans++ } });
    await r.actions.rescanWallets();
    expect(scans).toBe(1);
    const broken = setup({ wallet: { scan: async () => Promise.reject(new Error('x')) } });
    await expect(broken.actions.rescanWallets()).resolves.toBeUndefined();
  });

  it('connect, disconnect and the switch to X Layer go through the wallet', async () => {
    const r = setup();
    expect((await r.actions.connect()).ok).toBe(true);
    expect((await r.actions.switchNetwork()).ok).toBe(true);
    expect(r.wallet.switches).toEqual(['xlayer']);
  });
});
