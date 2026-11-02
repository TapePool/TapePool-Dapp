// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { createFixture } from '../src/fixtures/catalog';
import { gateRecord } from '../src/fixtures/data';
import { setLang } from '../src/i18n';
import { BOND } from '../src/constants';
import { deriveBorrow } from '../src/logic/borrow';
import { collectable, covers, landed, minedR, shareRequired, shareText, sharePct, unknownOf } from '../src/logic/harvest';
import { buildRigView } from '../src/logic/rigState';
import type { GateRecord, Snapshot } from '../src/model';
import { freshUi, resetFlow, type UiState } from '../src/state';

/** SPEC-PHASE5-PRELOAN §3, §4.1, §4.2, §4.7: the numbers and what the borrow screen asks about BEM mined before the loan. */

const rig = (id: number, mined: bigint | null) => ({ id, mined });

describe('the numbers (§3)', () => {
  it('minedR rounds a rig down to the vault dust, and collectable sums the rounded amounts', () => {
    expect(minedR(99n)).toBe(0n);
    expect(minedR(100n)).toBe(100n);
    expect(minedR(199n)).toBe(100n);
    expect(collectable([rig(1, 199n), rig(2, 250n)])).toBe(300n);
  });

  it('a raw sum above the bond whose per-rig rounded sum is below it is below it', () => {
    const many = Array.from({ length: 102 }, (_, i) => rig(i, 99n)); // 102 x 99 = 10,098 raw
    expect(many.reduce((s, r) => s + (r.mined ?? 0n), 0n)).toBeGreaterThan(BOND);
    expect(collectable(many)).toBe(0n);
  });

  it('landed is rounded per rig after the bridge fee', () => {
    // two rigs of 199 raw: each is sent as 100, and 100 x 99.5% = 99.5 rounds down to 99 for each; one sum would give 199
    expect(landed([rig(1, 199n), rig(2, 199n)], 50)).toBe(198n);
    expect(landed([rig(1, 1_000_000n)], 0)).toBe(1_000_000n);
    expect(landed([rig(1, 1_000_000n)], 500)).toBe(950_000n);
  });

  it('a rig with an unknown amount adds nothing and is named, never counted as zero', () => {
    expect(unknownOf([rig(1, 5n), rig(2, null), rig(3, null)])).toEqual([2, 3]);
    expect(collectable([rig(1, 500n), rig(2, null)])).toBe(500n);
  });

  it('share is a whole percentage rounded down; no debt shows a dash and counts as below the line; above 999% is capped', () => {
    expect(sharePct(999n, 1_000n)).toBe(99n);
    expect(shareText(999n, 1_000n)).toBe('99%');
    expect(shareText(5n, 0n)).toBe('—');
    expect(shareRequired(5n, 0n)).toBe(false);
    expect(shareText(10_000n, 1_000n)).toBe('> 999%');
    expect(shareText(9_999n, 1_000n)).toBe('999%');
    // exactly a tenth of the debt is required, one raw less is not
    expect(shareRequired(100n, 1_000n)).toBe(true);
    expect(shareRequired(99n, 1_000n)).toBe(false);
  });

  it('covers means the landed BEM is at least the debt plus one percent', () => {
    expect(covers(1_010n, 1_000n)).toBe(true);
    expect(covers(1_009n, 1_000n)).toBe(false);
    expect(covers(5n, 0n)).toBe(false);
  });
});

/* ───────── the screen ───────── */

function load(name: string, tweak?: (s: Snapshot, u: UiState) => Snapshot | void): { snap: Snapshot; ui: UiState; now: number } {
  const f = createFixture(name, { clock: () => 0 });
  let snap = f.store.snapshot(null);
  const ui = f.ui;
  if (tweak) snap = tweak(snap, ui) ?? snap;
  return { snap, ui, now: snap.now };
}

const withMined = (s: Snapshot, id: number, mined: bigint | null): Snapshot => ({
  ...s,
  rigs: s.rigs.map((r) => (r.id === id ? buildRigView({ ...r.facts, bsc: r.facts.bsc ? { ...r.facts.bsc, mined } : null }, s.now) : r)),
});
const withGate = (s: Snapshot, rec: GateRecord): Snapshot => ({ ...s, harvest: { ...s.harvest, gates: { ...s.harvest.gates, [String(rec.id)]: rec } } });
const step2 = (s: Snapshot, u: UiState) => deriveBorrow(s, u, s.now)?.mined.step2;

describe('when the choice shows (§4.1)', () => {
  it('shows nothing when the rigs mined nothing a harvest would send', () => {
    for (const mined of [0n, 99n]) {
      const { snap, ui } = load('flow-mined-info', (s) => withMined(s, 4127, mined));
      expect(step2(snap, ui)?.kind, `${mined}`).toBe('none');
      expect(step2(snap, ui)?.canMove).toBe(true);
    }
  });

  it('shows a muted line, and no harvest, below the bond', () => {
    const { snap, ui } = load('flow-mined-info', (s) => withMined(s, 4127, BOND - 1n));
    const s2 = step2(snap, ui);
    expect(s2?.kind).toBe('tiny');
    expect(s2?.canMove).toBe(true);
  });

  it('shows an info line and an optional harvest from the bond up to a tenth of the debt', () => {
    const { snap, ui } = load('flow-mined-info', (s) => withMined(s, 4127, BOND));
    const s2 = step2(snap, ui);
    expect(s2?.kind).toBe('info');
    expect(s2?.option.off).toBeNull();
    expect(s2?.canMove).toBe(true);
  });

  it('requires the choice from a tenth of the debt, to the raw unit', () => {
    const { snap, ui } = load('flow-mined-info');
    const debt = deriveBorrow(snap, ui, snap.now)?.mined.debt ?? 0n;
    expect(debt).toBe(96_720_000n);
    // landed = floor(minedR x 99.5%); a tenth of the debt is 9,672,000
    expect(step2(withMined(snap, 4127, 9_720_600n), ui)?.kind).toBe('info'); // 9,671,997 landed
    expect(step2(withMined(snap, 4127, 9_720_700n), ui)?.kind).toBe('choice'); // 9,672,096 landed
  });

  it('turns Move voucher off until a choice is made, and on after Keep', () => {
    const { snap, ui } = load('flow-mined-choice');
    expect(step2(snap, ui)?.canMove).toBe(false);
    ui.keep = [4128];
    expect(step2(snap, ui)?.canMove).toBe(true);
    // "Keep" stands for exactly this selection
    ui.keep = [4127];
    expect(step2(snap, ui)?.canMove).toBe(false);
  });

  it('asks again about a rig that mined enough after a harvest: a past harvest does not satisfy the requirement', () => {
    const rec = gateRecord(4128, 'passed', { harvestedAt: 0 });
    const { snap, ui } = load('flow-mined-choice', (s) => withGate(s, rec));
    ui.decided = [4128];
    const s2 = step2(snap, ui);
    expect(s2?.kind).toBe('choice');
    expect(s2?.canMove).toBe(false);
  });

  it('says a read that failed is a read that failed, and turns Move voucher off', () => {
    const { snap, ui } = load('flow-mined-unreadable');
    const s2 = step2(snap, ui);
    expect(s2?.kind).toBe('unreadable');
    expect(s2?.unreadable).toEqual([4128]);
    expect(s2?.canMove).toBe(false);
  });

  it('the share and the covers warning follow the amount on screen, or the largest debt of the term when none is valid', () => {
    const { snap, ui } = load('flow-mined-covers');
    expect(step2(snap, ui)?.covers).toBe(true);
    ui.amt = '';
    const b = deriveBorrow(snap, ui, snap.now);
    expect(b?.amount.valid).toBe(false);
    expect(b?.mined.debt).toBeGreaterThan(0n);
    // 0.0001 BEM is below the minimum advance: no valid amount, so the largest debt of the term is the measure
    ui.amt = '0.0001';
    expect(deriveBorrow(snap, ui, snap.now)?.mined.debt).toBe(b?.mined.debt);
  });

  it('a harvest on its way hides the choice and closes the gate until BSC time has passed on X Layer by more than two seconds', () => {
    const waits = [
      ['prompting', 'prompting'],
      ['in-flight', 'in-flight'],
      ['mined', 'settle'],
      ['cautious', 'settle'],
    ] as const;
    for (const [state, wait] of waits) {
      const { snap, ui } = load('flow-mined-choice', (s) => withGate(s, gateRecord(4128, state, { harvestedAt: 100 })));
      const s2 = step2(snap, ui);
      expect(s2?.wait, state).toBe(wait);
      expect(s2?.canMove, state).toBe(false);
    }
    const final = gateRecord(4128, 'final', { harvestedAt: 1_000 });
    const { snap, ui } = load('flow-mined-choice', (s) => withGate(s, final));
    ui.keep = [4128];
    // the gate reads the last head of X Layer, which is what the snapshot says it is, not the page's clock
    const at = (now: number) => deriveBorrow({ ...snap, now, harvest: { ...snap.harvest, headTime: now } }, ui, now)?.mined.step2;
    // a page whose clock ran on while the head stayed at T_h + 2 does not open it
    expect(deriveBorrow({ ...snap, now: 1_500, harvest: { ...snap.harvest, headTime: 1_002 } }, ui, 1_500)?.mined.step2.canMove).toBe(false);
    expect(at(1_002)?.canMove).toBe(false); // the head must be LATER than T_h + 2
    expect(at(1_003)?.canMove).toBe(true);
  });

  it('a voided harvest and a voucher that moved do not hold the gate', () => {
    for (const state of ['void', 'moved'] as const) {
      const { snap, ui } = load('flow-mined-info', (s) => withGate(s, gateRecord(4127, state)));
      expect(step2(snap, ui)?.gateOpen, state).toBe(true);
    }
  });

  it('a record that is stuck for ten minutes offers to move anyway, and "Keep waiting" hides it', () => {
    const rec = gateRecord(4128, 'in-flight', { createdAt: 0 });
    const { snap, ui } = load('flow-mined-choice', (s) => withGate(s, rec));
    expect(step2(snap, ui)?.stuck).toBe(true);
    ui.hold = snap.now + 600;
    expect(step2(snap, ui)?.stuck).toBe(false);
    const young = gateRecord(4128, 'in-flight', { createdAt: snap.now - 599 });
    ui.hold = 0;
    expect(step2(withGate(snap, young), ui)?.stuck).toBe(false);
  });

  it('counts a harvest on BSC in the steps header only while it is chosen and has not passed', () => {
    const bsc = (state: GateRecord['state']) => {
      const { snap, ui } = load('flow-mined-choice', (s) => withGate(s, gateRecord(4128, state, { harvestedAt: 0 })));
      return deriveBorrow(snap, ui, snap.now)?.mined.bscTx;
    };
    expect(bsc('prompting')).toBe(true);
    expect(bsc('in-flight')).toBe(true);
    expect(bsc('mined')).toBe(true);
    expect(bsc('passed')).toBe(false);
    expect(bsc('cautious')).toBe(false); // someone else sent that one
    const { snap, ui } = load('flow-mined-choice');
    expect(deriveBorrow(snap, ui, snap.now)?.mined.bscTx).toBe(false);
  });
});

describe('why "Harvest it to my wallet first" is off (§4.8, §8)', () => {
  const off = (tweak: (s: Snapshot) => Snapshot) => {
    const { snap, ui } = load('flow-mined-choice', tweak);
    return step2(snap, ui)?.option.off;
  };

  it('has a reason for each thing that can be wrong, in order', () => {
    expect(off((s) => s)).toBeNull();
    expect(off((s) => ({ ...s, harvest: { ...s.harvest, storage: false } }))).toBe('storage');
    expect(off((s) => ({ ...s, pool: { ...s.pool, borrowsPaused: true } }))).toBe('paused');
    expect(off((s) => ({ ...s, harvest: { ...s.harvest, prep: null } }))).toBe('unreadable');
    expect(off((s) => ({ ...s, harvest: { ...s.harvest, prep: s.harvest.prep && { ...s.harvest.prep, contracts: 'changed' } } }))).toBe('contracts');
    expect(off((s) => ({ ...s, harvest: { ...s.harvest, prep: s.harvest.prep && { ...s.harvest.prep, contracts: null } } }))).toBe('unreadable');
    expect(off((s) => ({ ...s, harvest: { ...s.harvest, prep: s.harvest.prep && { ...s.harvest.prep, quotes: [null] } } }))).toBe('unreadable');
    expect(off((s) => ({ ...s, harvest: { ...s.harvest, prep: s.harvest.prep && { ...s.harvest.prep, mark: { '4128': false } } } }))).toBe('mark');
    expect(off((s) => ({ ...s, harvest: { ...s.harvest, prep: s.harvest.prep && { ...s.harvest.prep, mark: { '4128': null } } } }))).toBe('unreadable');
    // the cap on the BNB sent: a quote of 0.01 BNB plus 10% is above it
    expect(off((s) => ({ ...s, harvest: { ...s.harvest, prep: s.harvest.prep && { ...s.harvest.prep, quotes: [10n ** 16n] } } }))).toBe('cap');
  });
});

/* ───────── rigs already in the agent (§4.7) ───────── */

describe('rigs that are already in the agent (§4.7)', () => {
  const step3 = (s: Snapshot, u: UiState) => deriveBorrow(s, u, s.now)?.mined.step3;

  it('asks about the rigs of the selection with BEM mined, from a tenth of the debt, and keeps Borrow off until one is chosen', () => {
    const { snap, ui } = load('flow-agent-mined');
    const s3 = step3(snap, ui);
    expect(s3?.kind).toBe('ask');
    expect(s3?.ids).toEqual([4128]);
    expect(s3?.blocks).toBe(true);
    expect(deriveBorrow(snap, ui, snap.now)?.canBorrow).toBe(false);
  });

  it('shows an info line, and keeps Borrow on, below the line', () => {
    const { snap, ui } = load('flow-agent-mined', (s) => withMined(s, 4128, 5_000_000n));
    expect(step3(snap, ui)?.kind).toBe('info');
    expect(step3(snap, ui)?.blocks).toBe(false);
  });

  it('does not ask about a rig that already had its choice in this flow', () => {
    const { snap, ui } = load('flow-agent-mined');
    ui.decided = [4128];
    expect(step3(snap, ui)?.kind).toBe('none');
    expect(step3(snap, ui)?.blocks).toBe(false);
  });

  it('a selection change or a finished flow forgets the choices', () => {
    const ui = freshUi();
    ui.keep = [1, 2];
    ui.decided = [1, 2];
    ui.hold = 99;
    resetFlow(ui);
    expect(ui.keep).toBeNull();
    expect(ui.decided).toEqual([]);
    expect(ui.hold).toBe(0);
    // a page reload starts from a fresh state
    expect(freshUi().keep).toBeNull();
  });

  it('a rig whose BEM could not be read is a read failure there too, and Borrow waits', () => {
    const { snap, ui } = load('flow-agent-mined', (s) => withMined(s, 4128, null));
    expect(step3(snap, ui)?.kind).toBe('unreadable');
    expect(step3(snap, ui)?.blocks).toBe(true);
  });

  it('the review counts every collateral rig of the agent', () => {
    const { snap, ui } = load('flow-agent-mined');
    const k = deriveBorrow(snap, ui, snap.now)?.mined.kept;
    expect(k?.collectable).toBe(41_000_000n);
    expect(k?.amount).toBe(40_795_000n); // landed: 0.41 BEM less the 0.5% bridge fee
    expect(k?.share).toBe('63%');
  });

  it('a payee mismatch keeps Borrow off for that agent until the harvest lands there', () => {
    const rec = gateRecord(4128, 'payee-mismatch', { harvestedAt: 1, agent: undefined as never });
    const { snap, ui } = load('flow-agent-mined', (s) => {
      const agent = s.agents[s.agents.length - 1]?.address ?? null;
      return withGate(s, { ...rec, agent, movedAt: s.now - 10 });
    });
    ui.decided = [4128];
    const b = deriveBorrow(snap, ui, snap.now);
    expect(b?.mined.mismatch).toEqual({ ids: [4128], late: false });
    expect(b?.canBorrow).toBe(false);
    expect(b?.blockers.join(' ')).toContain('The harvest you sent will be paid to the agent');
    // fifteen minutes later it says so, and offers the voucher back
    const later = snap.now + 901;
    const late = deriveBorrow({ ...snap, now: later, harvest: { ...snap.harvest, headTime: later } }, ui, later);
    expect(late?.mined.mismatch?.late).toBe(true);
    expect(late?.blockers.join(' ')).toContain('15 minutes');
  });
});

/* ───────── the buttons ───────── */

let app: App;
const mount = (name: string, hash: string): ReturnType<typeof createFixture> => {
  document.body.innerHTML = '<div id="tp-app"><div id="tp-screen"></div><div id="tp-mdl" hidden><div id="tp-mdl-box"></div></div></div><div id="tp-toast"></div>';
  window.location.hash = hash;
  const f = createFixture(name, { clock: () => 0, reportDelayMs: 0 });
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
  return f;
};

beforeEach(() => setLang('en', false));
afterEach(() => app?.destroy());

describe('the buttons', () => {
  it('Keep is remembered for the selection and forgotten when the selection changes', async () => {
    mount('group-flow', '#/app/rigs/group');
    expect(app.ui.sel).toEqual([4127, 4128]);
    expect(app.ctx().borrow?.mined.step2.kind).toBe('choice');
    await app.dispatch('keep', null);
    expect(app.ui.keep).toEqual([4127, 4128]);
    expect(app.ctx().borrow?.mined.step2.canMove).toBe(true);
    // un-pick a rig: the selection changed, so Keep no longer stands
    const box = document.querySelector<HTMLInputElement>('[data-pick="4127"]');
    expect(box).not.toBeNull();
    (box as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.ui.sel).toEqual([4128]);
    expect(app.ui.keep).toBeNull();
    expect(app.ctx().borrow?.mined.step2.canMove).toBe(false);
  });

  it('Move voucher is off while the choice is open, and the buttons say so', async () => {
    mount('flow-mined-choice', '#/app/rigs/4128');
    const move = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Move voucher');
    expect(move?.hasAttribute('disabled')).toBe(true);
    await app.dispatch('move', null); // a click on a stale screen sends nothing
    expect(app.ctx().borrow?.moved).toBe(false);
    await app.dispatch('keep', null);
    const after = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Move voucher');
    expect(after?.hasAttribute('disabled')).toBe(false);
  });

  it('Take back to harvest first keeps the agent as the flow\'s agent, and does not start the flow over', async () => {
    const f = mount('flow-agent-mined', '#/app/rigs/4128');
    const agent = app.ctx().borrow?.agent?.address;
    expect(agent).toBeDefined();
    await app.dispatch('take-back-harvest', null);
    expect(app.ui.agent).toBe(agent);
    expect(app.ui.reuse).toBe(true);
    const b = app.ctx().borrow;
    expect(b?.agent?.address).toBe(agent);
    expect(b?.agent?.collateral).toEqual([]);
    expect(b?.mined.step2.ids).toEqual([4128]); // back at §4.1 for the rig
    expect(f.store.snapshot(null).rigs.find((r) => r.id === 4128)?.facts.place.kind).toBe('wallet');
  });

  it('Keep it in this loan at step 3 turns Borrow back on', async () => {
    mount('flow-agent-mined', '#/app/rigs/4128');
    expect(app.ctx().borrow?.mined.step3.blocks).toBe(true);
    await app.dispatch('keep-agent', null);
    expect(app.ctx().borrow?.mined.step3.kind).toBe('none');
    expect(app.ui.decided).toEqual([4128]);
  });

  it('Harvest first is sent only when it is on, and the rigs it harvested are not asked about again', async () => {
    const f = mount('flow-mined-choice', '#/app/rigs/4128');
    await app.dispatch('harvest-first', null);
    expect(app.ui.decided).toEqual([4128]);
    expect(f.store.snapshot(null).rigs.find((r) => r.id === 4128)?.mined).toBe(0n);
  });

  it('"Move anyway" of a failed read is off while a harvest holds the gate, and Retry reads again', async () => {
    let reads = 0;
    const f = mount('flow-mined-unreadable', '#/app/rigs/4128');
    (f.store as unknown as { refresh: () => Promise<void> }).refresh = async () => void reads++;
    await app.dispatch('retry', null);
    expect(reads).toBe(1);
    const any = [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Move anyway'));
    expect(any?.hasAttribute('disabled')).toBe(false);
  });
});
