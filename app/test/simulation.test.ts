// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { createFixture } from '../src/fixtures/catalog';
import { AGENT_B, bem } from '../src/fixtures/data';
import { setLang } from '../src/i18n';
import { loanForRig } from '../src/logic/selectors';
import type { Snapshot } from '../src/model';

/** The fixture world behind both seams, driven through the same dispatcher the buttons use. */

let app: App;
let store: ReturnType<typeof createFixture>['store'];
const snap = (): Snapshot => store.snapshot(null);
const rig = (id: number) => snap().rigs.find((r) => r.id === id);

function mount(name: string, hash: string): void {
  document.body.innerHTML = '<div id="tp-app"><div id="tp-screen"></div><div id="tp-mdl" hidden><div id="tp-mdl-box"></div></div></div><div id="tp-toast"></div>';
  window.location.hash = hash;
  const f = createFixture(name, { clock: () => 0, reportDelayMs: 0 });
  store = f.store;
  app = createApp({
    screen: document.getElementById('tp-screen') as HTMLElement,
    modal: document.getElementById('tp-mdl') as HTMLElement,
    modalBox: document.getElementById('tp-mdl-box') as HTMLElement,
    toast: document.getElementById('tp-toast') as HTMLElement,
    source: f.store,
    actions: f.store,
    ui: f.ui,
    inFrame: false,
    win: window,
  });
}

beforeEach(() => setLang('en', false));
afterEach(() => app?.destroy());

describe('a miner runs the whole flow from the buttons', () => {
  it('connect, create, move, refresh, borrow, repay, release', async () => {
    mount('disconnected', '#/app/rigs/4127');
    expect(document.body.textContent).toContain('Connect your wallet');
    // the Connect button opens the dialog; the wallet is connected by picking one in it
    await app.dispatch('connect', null);
    expect(snap().wallet.status).toBe('disconnected');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('OKX Wallet');
    await app.dispatch('pick-wallet', 'sample-okx');
    expect(snap().wallet.status).toBe('connected');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(rig(4127)?.state.kind).toBe('ready');

    const wallet0 = snap().wallet;
    const pool0 = snap().pool;

    // 1 create
    await app.dispatch('create', null);
    expect(app.ctx().borrow?.agentDone).toBe(true);
    expect(app.ctx().borrow?.agent?.collateral).toEqual([]);

    // 2 move
    await app.dispatch('move', null);
    expect(rig(4127)?.state.kind).toBe('in-agent');
    expect(app.ctx().borrow?.moved).toBe(true);

    // 3 refresh: the simulated keeper delivers a report
    await app.dispatch('refresh', null);
    let b = app.ctx().borrow;
    expect(b?.report).toBe('fresh');
    expect(b?.source).toBe('quote');
    expect(b?.canBorrow).toBe(true);
    const principal = b?.amount.value ?? 0n;
    const fee = b?.amount.fee ?? 0n;
    expect(principal).toBeGreaterThan(0n);

    // 4 borrow
    await app.dispatch('borrow', null);
    const afterBorrow = snap();
    expect(rig(4127)?.state.kind).toBe('loan');
    const loan = loanForRig(afterBorrow, 4127);
    expect(loan?.phase).toBe('active');
    expect(loan?.advance).toBe(principal);
    expect(loan?.feeLeft).toBe(fee);
    expect(afterBorrow.wallet.bem).toBe(wallet0.bem + principal);
    expect(afterBorrow.wallet.okb).toBe(wallet0.okb - afterBorrow.pool.params.opsFee[0]);
    expect(afterBorrow.pool.outstanding).toBe(pool0.outstanding + principal);
    expect(window.location.hash).toBe('#/app/rigs/4127');
    expect(app.ui.flash?.kind).toBe('borrowed');
    expect(document.body.textContent).toContain('It is in your wallet.');
    expect(document.body.textContent).toContain('Repay with BEM');

    // 5 repay in full: allow, then repay
    await app.dispatch('repay', '4127');
    expect(window.location.hash).toBe('#/app/rigs/4127/repay');
    await app.dispatch('approve-repay', '4127');
    await app.dispatch('repay-do', '4127');
    const cleared = loanForRig(snap(), 4127);
    expect(cleared?.phase).toBe('cleared');
    expect(rig(4127)?.state.kind).toBe('in-agent');
    expect(snap().pool.outstanding).toBe(pool0.outstanding);
    expect(window.location.hash).toBe('#/app/rigs/4127');
    expect(document.body.textContent).toContain('Debt cleared on');

    // 6 release
    await app.dispatch('release', '4127');
    expect(rig(4127)?.state.kind).toBe('ready');
    expect(loanForRig(snap(), 4127)).toBeUndefined();
    expect(app.ui.flash?.kind).toBe('released');
    expect(document.body.textContent).toContain('is back in your wallet');
    b = app.ctx().borrow;
    expect(b?.agentDone).toBe(false); // the page offers a fresh borrow
  });

  it('a partial repayment lowers the debt; the agent BEM counts first', async () => {
    mount('loan-active', '#/app/rigs/3871');
    const before = loanForRig(snap(), 3871);
    expect(before?.agentBem).toBe(bem(0.0412));
    await app.dispatch('approve-repay', '3871');
    app.ui.rep.amount = '0.1000';
    await app.dispatch('approve-repay', '3871');
    await app.dispatch('repay-do', '3871');
    const after = loanForRig(snap(), 3871);
    expect(after?.phase).toBe('active');
    expect(after?.principal).toBe(bem(0.308) - bem(0.1) - bem(0.0412));
    expect(after?.agentBem).toBe(0n);
  });

  it('sweep applies the BEM waiting in the agent', async () => {
    mount('loan-active', '#/app/rigs/3871');
    await app.dispatch('sweep', '3871');
    const l = loanForRig(snap(), 3871);
    expect(l?.principal).toBe(bem(0.308) - bem(0.0412));
    expect(l?.agentBem).toBe(0n);
  });

  it('takes a voucher back before borrowing', async () => {
    mount('flow-moved', '#/app/rigs/4127');
    expect(rig(4127)?.state.kind).toBe('in-agent');
    await app.dispatch('release', '4127');
    expect(rig(4127)?.state.kind).toBe('ready');
    await app.dispatch('create', null);
    await app.dispatch('move', null);
    await app.dispatch('take-back', '4127');
    expect(rig(4127)?.state.kind).toBe('ready');
  });

  it('registers a loose voucher, or takes it back', async () => {
    mount('rigs-all', '#/app/rigs/6002');
    expect(rig(6002)?.state.kind).toBe('loose');
    await app.dispatch('register', '6002');
    expect(rig(6002)?.state.kind).toBe('in-agent');
    mount('rigs-all', '#/app/rigs/6003');
    await app.dispatch('register', '6003'); // a closed agent: the app still sends only what the chain allows, the fixture does not
    await app.dispatch('take-back', '6003');
    expect(rig(6003)?.state.kind).toBe('ready');
  });

  it('claims the BEM that landed late in an empty agent', async () => {
    mount('connected', '#/app/rigs');
    expect(document.body.textContent).toContain('is waiting in your empty Rig Agent');
    const before = snap().wallet.bem;
    await app.dispatch('claim', AGENT_B);
    expect(snap().wallet.bem).toBe(before + bem(0.0123));
    expect(snap().agents.find((a) => a.address === AGENT_B)?.bem).toBe(0n);
    expect(document.body.textContent).not.toContain('is waiting in your empty Rig Agent');
  });

  it('borrows against two rigs in one loan', async () => {
    mount('group-flow', '#/app/rigs/group');
    expect(app.ui.sel).toEqual([4127, 4128]);
    await app.dispatch('create', null);
    // rig #4128 mined a lot before the loan: the voucher does not move until the user has chosen
    expect(app.ctx().borrow?.mined.step2.kind).toBe('choice');
    await app.dispatch('move', null);
    expect(app.ctx().borrow?.moved).toBe(false);
    await app.dispatch('keep', null);
    await app.dispatch('move', null);
    expect(app.ctx().borrow?.moved).toBe(true);
    await app.dispatch('refresh', null);
    expect(app.ctx().borrow?.canBorrow).toBe(true);
    await app.dispatch('borrow', null);
    const loan = loanForRig(snap(), 4127);
    expect(loan?.rigIds).toEqual([4127, 4128]);
    expect(loanForRig(snap(), 4128)).toEqual(loan);
    expect(rig(4128)?.state.kind).toBe('loan');
  });

  it('supplies and withdraws', async () => {
    mount('connected', '#/app/supply');
    const s0 = snap();
    app.ui.sup.amount = '2.0000';
    await app.dispatch('approve-supply', null);
    expect(snap().wallet.allowancePool).toBe(bem(2));
    await app.dispatch('supply', null);
    const s1 = snap();
    expect(s1.wallet.bem).toBe(s0.wallet.bem - bem(2));
    expect(s1.pool.totalAssets).toBe(s0.pool.totalAssets + bem(2));
    expect(s1.position?.value).toBe((s0.position?.value ?? 0n) + bem(2));
    expect(window.location.hash).toBe('#/app');
    window.location.hash = '#/app/withdraw';
    app.ui.sup.tab = 'withdraw';
    await app.dispatch('wdmax', null);
    expect(app.ui.sup.wmax).toBe(true);
    await app.dispatch('withdraw', null);
    expect(snap().position?.withdrawable).toBe(0n);
  });

  it('refuses a borrow when the operating fee changed under the user (WrongOpsFee)', async () => {
    mount('flow-fresh', '#/app/rigs/4127');
    const b = app.ctx().borrow;
    const agent = b?.agent?.address;
    expect(agent).toBeDefined();
    const res = await store.borrow({ agent: agent as `0x${string}`, term: 0, maxFee: 700_000n, maxLateBps: 0, principal: bem(0.5), opsFee: 1n, ids: [4127] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ kind: 'revert', name: 'WrongOpsFee' });
  });

  it('time moves the countdown: the report expires and the flow goes back to refresh', () => {
    mount('flow-fresh', '#/app/rigs/4127');
    expect(app.ctx().borrow?.report).toBe('fresh');
    store.advance(300);
    expect(app.ctx().borrow?.report).toBe('expired');
    expect(document.body.textContent).toContain('Refresh again');
    expect(document.body.textContent).toContain('older than 5 minutes');
  });

  it('too-new and pending-screen rigs become ready as the clock passes', () => {
    mount('connected', '#/app/rigs');
    expect(rig(4233)?.state.kind).toBe('too-new');
    expect(rig(3990)?.state.kind).toBe('screen-pending');
    store.advance(4 * 86_400);
    expect(rig(4233)?.state.kind).toBe('ready');
    expect(rig(3990)?.state.kind).toBe('ready');
  });

  it('a pending refresh shows the spinner and turns the borrow off, then finishes', async () => {
    mount('flow-moved', '#/app/rigs/4127');
    const p = app.dispatch('refresh', null);
    expect(document.querySelector('.spin')).not.toBeNull();
    await p;
    expect(document.querySelector('.spin')).toBeNull();
    expect(document.querySelector('.cd')).not.toBeNull();
  });
});
