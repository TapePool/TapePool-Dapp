import { encodeErrorResult } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { tapeLensAbi, tapePoolAbi } from '../src/chain/abi';
import { bindingText, errorText } from '../src/chain/errors';
import { mapPool } from '../src/chain/map';
import { readCore, readQuoteFor, readQuotes, type ReadEnv } from '../src/chain/reads';
import { MAINNET, REDEPLOY, readConfig } from '../src/config';
import { setLang } from '../src/i18n';
import { deriveBorrow } from '../src/logic/borrow';
import { buildOpenLoan, type LoanRaw } from '../src/logic/loan';
import type { PrincipalQuote } from '../src/model';
import { loanBanner, loanCard } from '../src/render/loan';
import { opsFeeCell, poolPage } from '../src/render/pool';
import { releaseEntries } from '../src/render/release';
import { rigCard, rigPage } from '../src/render/rigs';
import { flow } from '../src/render/borrow';
import { EMPTY } from '../src/html';
import { make, textOf } from './helpers';
import { A, ACCOUNT, AGENT1, addAccount, buildWorld, openLoan, NOW } from './world';

const allowed = (over: Partial<PrincipalQuote> = {}): PrincipalQuote => ({ fee: 100_000n, lateBps: 0, debt: 2_100_000n, allowed: true, reason: 0, binding: 0, ...over });
beforeEach(() => setLang('en', false));

describe('redeploy configuration and reads (RC-01, RC-06, RC-07)', () => {
  it('keeps the old stack as the default and refuses an unconfigured cutover', () => {
    expect(readConfig({}).book).toBe(MAINNET);
    expect(() => readConfig({ VITE_NETWORK: 'redeploy' }, null, null)).toThrow('must be configured');
    expect(readConfig({ VITE_NETWORK: 'redeploy' })).toMatchObject({ book: REDEPLOY, tapeLens: REDEPLOY?.lens });
    const book = { ...MAINNET, redeploy: true, lens: A(99), factoryDeployBlock: 10n, reporterDeployBlock: 20n };
    expect(readConfig({ VITE_NETWORK: 'redeploy' }, null, book)).toMatchObject({ book, tapeLens: A(99) });
  });

  it('reads the deployed lens for both the maximum and the chosen principal, pinned and without overrides', async () => {
    const w = buildWorld();
    const lens = A(99);
    const env: ReadEnv = { x: w.x, book: { ...MAINNET, redeploy: true }, lens };
    w.x.on(lens, tapeLensAbi, { quote: { maxPrincipal: 9_000_000n, fee: 100_000n, expected: 20_000_000n, inputBits: 4095, reason: 0, pending: 0n, opsFee: 0n }, quoteFor: ([agent, term, principal]: readonly unknown[]) => {
      expect([agent, term, principal]).toEqual([AGENT1, 0, 2_000_000n]);
      return [100_000n, 3, 2_100_000n, true, 0, 0];
    } });
    await readQuotes(env, 123n, [AGENT1]);
    expect(await readQuoteFor(env, 123n, AGENT1, 0, 2_000_000n)).toEqual(allowed({ lateBps: 3 }));
    expect(w.x.calls.every((c) => c.block === 123n && c.code === undefined)).toBe(true);
    expect(w.x.calls.at(-1)?.to).toBe(lens);
    await expect(readQuotes({ ...env, lens: null }, 123n, [AGENT1])).rejects.toThrow('deployed TapeLens');
  });

  it('maps released-only share value, unreleased income and the on-chain binding without recomputing caps', async () => {
    const w = buildWorld();
    addAccount(w, ACCOUNT);
    const env: ReadEnv = { x: w.x, book: { ...MAINNET, redeploy: true }, lens: A(99) };
    w.x.on(MAINNET.pool, tapePoolAbi, { unvestedNow: 123_456n, vestEnd: BigInt(NOW + 86400), perBorrowerAbs: 400_000_000n, lendLimit: [2_000_000n, 4] });
    const core = await readCore(env, w.x.number, ACCOUNT, null);
    expect(core.account).toMatchObject({ room: 2_000_000n, binding: 4 });
    const circuit = { name: 'Policy', symbol: 'P', gates: 44, netlistHash: `0x${'00'.repeat(32)}` as const };
    const pool = mapPool(core.pool, core.pins!, circuit, env.book, NOW);
    expect(pool).toMatchObject({ unvested: 123_456n, vestEnd: NOW + 86400, tpbemValue: w.state.tpbemValue });
    expect(pool.params.perBorrowerAbs).toBe(400_000_000n);
  });
});

describe('quotes and rendering (RC-02 to RC-09)', () => {
  it('uses the fee and late rate for a below-maximum principal and waits for an amount change to be quoted', () => {
    const { ctx } = make('flow-fresh');
    const b = ctx.borrow!;
    ctx.snap.principalQuotes = true;
    ctx.ui.amt = '0.0200';
    ctx.ui.principalQuote = { agent: b.agent!.address, term: 0, principal: 2_000_000n, value: allowed({ fee: 111_111n, lateBps: 7 }) };
    const shown = deriveBorrow(ctx.snap, ctx.ui, ctx.now)!;
    expect(shown.amount.fee).toBe(111_111n);
    expect(shown.lateBps).toBe(7);
    expect(shown.rule).toBe('allow');
    ctx.ui.amt = '0.0300';
    expect(deriveBorrow(ctx.snap, ctx.ui, ctx.now)?.canBorrow).toBe(false);
  });

  it.each(['en', 'cn'] as const)('shows sponsored zero fees, minimum/effective BEM fees and the binding in %s', (lang) => {
    const { ctx } = make('ops-fee-zero', { hash: '#/app/rigs/4127', lang });
    ctx.snap.wallet.binding = 4;
    const text = textOf(flow(ctx, EMPTY).value);
    expect(text).toContain(lang === 'en' ? '0 OKB (sponsored)' : '0 OKB（由赞助方支付）');
    expect(text).toContain(bindingText(4));
    expect(text).toContain(lang === 'en' ? 'BEM fee rate' : 'BEM 费率');
    expect(text).toContain('%');
  });

  it.each([1, 2, 3, 4, 5])('names lendLimit binding %i', (binding) => {
    expect(errorText({ kind: 'quote', reason: 16, params: { binding } })).toContain(bindingText(binding));
  });

  it('uses the same fee-change message for FeeAboveBound', () => {
    expect(errorText({ kind: 'revert', name: 'FeeAboveBound' })).toBe('The fee changed. Review the new quote.');
    expect(encodeErrorResult({ abi: tapePoolAbi, errorName: 'ExceedsBackstop' })).toMatch(/^0x/);
  });

  it('disables Register for a loose voucher during a loan and keeps Take back', () => {
    const { ctx } = make('flow-fresh');
    const rig = ctx.snap.rigs[0]!;
    rig.state = { kind: 'loose', row: '5', agent: AGENT1, agentClosed: false };
    rig.facts.place = { kind: 'agent', agent: AGENT1, closed: false, collateral: false, loanOpen: true };
    const html = rigCard(ctx, rig).value;
    expect(textOf(html)).toContain('Rigs you add now stay outside this loan. Register them after it closes.');
    expect(html).not.toContain('data-a="register"');
    expect(html).toContain('data-a="take-back"');
    expect(textOf(html)).toContain('not collateral');
  });

  it('renders the pool income schedule without adding unreleased income to the share price', () => {
    const { ctx } = make('connected');
    ctx.snap.pool.unvested = 100_000_000n;
    ctx.snap.pool.vestEnd = NOW + 86400;
    expect(textOf(poolPage(ctx).value)).toContain('Income still being released');
    expect(textOf(poolPage(ctx).value)).toContain('Release schedule ends');
  });

  it('branches on the uint64 sentinel before Number/date conversion and preserves doubtful/expired state', () => {
    const { ctx } = make('loan-flagged');
    const loan = buildOpenLoan({ agent: AGENT1, raw: openLoan({ impairedAt: BigInt(NOW - 80 * 3600), seizeStart: BigInt(NOW - 8 * 3600), deadline: (1n << 64n) - 1n, doubtful: true }) as LoanRaw, agentBem: 0n, now: NOW, collateral: [16], rigs: new Map(), rules: ctx.snap.rules, params: ctx.snap.pool.params, info: null });
    expect(loan.deadline).toBeNull();
    expect(loan.deadlinePaused).toBe(true);
    const text = textOf(loanCard(ctx, loan).value);
    expect(text).toContain('The seize deadline is paused while the feed is off. A seize is still possible on voucher evidence.');
    expect(text).not.toMatch(/Invalid|NaN|184467/);
    expect(textOf(loanBanner(ctx, { ...loan, deadlinePaused: false, expired: true }).value)).toContain('remains doubtful');
  });

  it('distinguishes a verified zero operating fee from unknown history', () => {
    const { ctx } = make('loan-active');
    const loan = ctx.snap.loans[0]!;
    expect(textOf(loanCard(ctx, { ...loan, opsFeePaid: 0n }).value)).toContain('no fee');
    expect(textOf(loanCard(ctx, { ...loan, opsFeePaid: null }).value)).not.toContain('no fee');
  });

  it('labels only the zero term sponsored when operating fees are mixed', () => {
    const { ctx } = make('connected');
    ctx.snap.pool.params.opsFee = [0n, 40_000_000_000_000_000n];
    const text = textOf(opsFeeCell(ctx).value);
    expect(text).toContain('0 OKB (sponsored)');
    expect(text).toContain('0.040');
    expect(text.match(/sponsored/g)).toHaveLength(1);
  });

  it.each([null, A(3)])('offers forget after a retry for unreadable or different ownership (%s)', (owner) => {
    const { ctx } = make('connected');
    const agent = { address: AGENT1, closed: false, collateral: [16], loose: [], bem: 0n, owners: { '16': owner }, releaseAttempted: true, releaseRetried: true };
    const text = textOf(releaseEntries(ctx, agent).value);
    expect(text).toContain('Release again');
    expect(text).toContain('Remove from the collateral list');
    expect(text).toContain('This only removes the entry. It does not move the voucher.');
    expect(releaseEntries(ctx, { ...agent, releaseRetried: false }).value).not.toContain('forget-entry');
    expect(releaseEntries(ctx, { ...agent, owners: { '16': AGENT1 } }).value).not.toContain('forget-entry');
  });

  it('shows remaining vouchers on the released rig page after a partial release', () => {
    const { ctx } = make('connected', { hash: '#/app/rigs/4127' });
    ctx.snap.agents.push({ address: AGENT1, closed: false, collateral: [5], loose: [], bem: 0n, releaseAttempted: true });
    ctx.ui.flash = { kind: 'released', rigId: 4127, ids: [4127], agent: AGENT1 };
    const text = textOf(rigPage(ctx, 4127).value);
    expect(text).toContain('Vouchers still listed in the agent');
    expect(text).toContain('#5');
    expect(text).toContain('Release again');
  });
});
