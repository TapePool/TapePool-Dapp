import { describe, expect, it } from 'vitest';
import { GateStore } from '../src/chain/gates';
import { advance, decodeRecord, encodeRecord, gateOpen, isFinal, isStuck, landingLate, mergeForward, observeDrop, promptingRecord, unreadableRecord, type Upkeep } from '../src/logic/gates';
import { memoryStore, type KvStore } from '../src/logic/history';
import type { GateRecord, GateState } from '../src/model';
import { A } from './world';

/** SPEC-PHASE5-PRELOAN §4.4, §4.5: the state machine of the harvest records and the move gate, as pure functions. */

const ME = A(0xa11ce);
const AGENT = A(0xa6e47001);
const HASH = `0x${'ab'.repeat(32)}` as const;

const rec = (state: GateState, over: Partial<GateRecord> = {}): GateRecord => ({
  id: 16,
  wallet: ME,
  hash: state === 'prompting' ? null : HASH,
  nonce: null,
  harvestedAt: null,
  block: null,
  amount: null,
  createdAt: 1_000,
  state,
  floor: null,
  base: null,
  agent: null,
  movedBlock: null,
  cursor: null,
  movedAt: null,
  ...over,
});

const up = (over: Partial<Upkeep> = {}): Upkeep => ({ now: 2_000, xlBlock: 500n, pin: { block: 1_000n, time: 1_990 }, finalized: 990n, latest: 1_002n, agent: null, ...over });

describe('the move gate', () => {
  it('lets a voucher with no record, a voided harvest and a voucher that already moved go', () => {
    expect(gateOpen(undefined, 0)).toBe(true);
    expect(gateOpen(rec('void'), 0)).toBe(true);
    expect(gateOpen(rec('moved'), 0)).toBe(true);
  });

  it('opens a final record when the head is later than the harvest time plus two seconds, not at it', () => {
    for (const state of ['final', 'passed'] as const) {
      const r = rec(state, { harvestedAt: 1_000 });
      expect(gateOpen(r, 1_000), state).toBe(false);
      expect(gateOpen(r, 1_002), `${state} at T_h+2`).toBe(false);
      expect(gateOpen(r, 1_003), `${state} at T_h+3`).toBe(true);
    }
  });

  it('a passed label does not open a gate that a later observation raised again', () => {
    const passed = rec('passed', { harvestedAt: 1_000 });
    expect(gateOpen(passed, 1_003)).toBe(true);
    const raised = observeDrop(passed, { id: 16, wallet: ME, block: 2_000n, time: 1_500, now: 1_600 }) as GateRecord;
    expect(raised.state).toBe('passed');
    expect(raised.harvestedAt).toBe(1_500);
    expect(gateOpen(raised, 1_503)).toBe(true);
    expect(gateOpen(raised, 1_502)).toBe(false);
  });

  it('keeps every unresolved state, a mismatch and a record without a time closed', () => {
    for (const state of ['prompting', 'in-flight', 'mined', 'cautious', 'payee-mismatch'] as const) expect(gateOpen(rec(state, { harvestedAt: 1 }), 10_000), state).toBe(false);
    expect(gateOpen(rec('final'), 10_000)).toBe(false);
  });

  it('stuck is more than ten minutes after the record was written, for the unresolved states only', () => {
    expect(isStuck(rec('in-flight', { createdAt: 1_000 }), 1_600)).toBe(false);
    expect(isStuck(rec('in-flight', { createdAt: 1_000 }), 1_601)).toBe(true);
    expect(isStuck(rec('prompting', { createdAt: 1_000 }), 1_601)).toBe(true);
    expect(isStuck(rec('mined', { createdAt: 1_000 }), 1_601)).toBe(true);
    expect(isStuck(rec('cautious', { createdAt: 1_000 }), 9_999)).toBe(false);
    expect(isStuck(unreadableRecord(16, ME), 1_800_000_000)).toBe(true); // a record that cannot be read fails closed and offers the way out at once
  });

  it('a harvest paid to the agent and not seen landing for fifteen minutes says so', () => {
    expect(landingLate(rec('payee-mismatch', { movedAt: 1_000 }), 1_900)).toBe(false);
    expect(landingLate(rec('payee-mismatch', { movedAt: 1_000 }), 1_901)).toBe(true);
  });
});

describe('writes only go forward (several tabs)', () => {
  it('moves the state forward and keeps the highest harvest time', () => {
    const stored = rec('mined', { harvestedAt: 1_000, block: 900n });
    expect(mergeForward(stored, rec('in-flight', { harvestedAt: 1_100 })).state).toBe('mined'); // an older tab cannot undo it
    expect(mergeForward(stored, rec('in-flight', { harvestedAt: 1_100 })).harvestedAt).toBe(1_100); // but the time only rises
    expect(mergeForward(stored, rec('final', { harvestedAt: 900, block: 900n })).state).toBe('final');
    expect(mergeForward(stored, rec('final', { harvestedAt: 900, block: 900n })).harvestedAt).toBe(1_000);
  });

  it('the one step back is a vanished receipt, and only when it is asked for by name', () => {
    const stored = rec('mined', { harvestedAt: 1_000, block: 900n });
    const back = rec('in-flight', { harvestedAt: null });
    expect(mergeForward(stored, back).state).toBe('mined');
    const stepped = mergeForward(stored, back, { vanished: true });
    expect(stepped.state).toBe('in-flight');
    expect(stepped.harvestedAt).toBeNull();
    // never from further on
    expect(mergeForward(rec('final', { harvestedAt: 1_000 }), back, { vanished: true }).state).toBe('final');
  });

  it('keeps what only one tab knows: the hash, the nonce, the agent, and a floor that only rises', () => {
    const a = rec('in-flight', { nonce: 7, floor: 5n });
    const b = rec('in-flight', { nonce: null, floor: 9n, hash: HASH });
    const m = mergeForward(a, b);
    expect(m.nonce).toBe(7);
    expect(m.floor).toBe(9n);
  });

  it('two branches of the same rank do not replace each other: the first one stays', () => {
    const mined = rec('mined', { harvestedAt: 1_000, block: 900n });
    const cautious = rec('cautious', { harvestedAt: 1_200, block: 910n, hash: null });
    expect(mergeForward(mined, cautious).state).toBe('mined');
    expect(mergeForward(cautious, mined).state).toBe('cautious');
  });
});

describe('a cautious observation (a drop of the rig\'s mined BEM that the app did not cause)', () => {
  const o = { id: 16, wallet: ME, block: 5_000n, time: 4_000, now: 4_010 };

  it('writes a cautious record whose time is the later block\'s time', () => {
    const r = observeDrop(undefined, o) as GateRecord;
    expect(r).toMatchObject({ state: 'cautious', harvestedAt: 4_000, block: 5_000n, hash: null, amount: null, createdAt: 4_010 });
    expect(observeDrop(rec('void'), o)?.state).toBe('cautious');
  });

  it('turns a prompting record (it has no hash) into a cautious one', () => {
    const r = observeDrop(rec('prompting', { base: { block: 4_900n, mined: 5n } }), o) as GateRecord;
    expect(r).toMatchObject({ state: 'cautious', harvestedAt: 4_000, block: 5_000n, base: null });
  });

  it('never replaces a harvest that is in flight or mined: it only raises the floor for when it becomes final', () => {
    for (const state of ['in-flight', 'mined'] as const) {
      const r = observeDrop(rec(state, { harvestedAt: 3_000, block: 4_000n }), o) as GateRecord;
      expect(r.state, state).toBe(state);
      expect(r.hash, state).toBe(HASH);
      expect(r.harvestedAt, state).toBe(3_000);
      expect(r.floor, state).toBe(5_000n);
    }
  });

  it('only ever raises the time of a cautious, final or passed record, and leaves a voucher that moved alone', () => {
    expect(observeDrop(rec('cautious', { harvestedAt: 4_500, block: 5_100n }), o)?.harvestedAt).toBe(4_500);
    expect(observeDrop(rec('cautious', { harvestedAt: 3_000, block: 4_000n }), o)?.harvestedAt).toBe(4_000);
    expect(observeDrop(rec('final', { harvestedAt: 3_000 }), o)?.harvestedAt).toBe(4_000);
    expect(observeDrop(rec('moved', { harvestedAt: 3_000 }), o)).toBeNull();
    expect(observeDrop(rec('payee-mismatch', { harvestedAt: 3_000 }), o)).toBeNull();
  });
});

describe('the steps of a record (§4.4)', () => {
  const ok = (over: Partial<NonNullable<Upkeep['receipt']>> = {}) => ({ success: true, block: 900n, time: 1_900, amount: 1_000_000n, ...over });

  it('in flight with a receipt is mined: the block, the time of the block and the amount the vault sent', () => {
    const r = advance(rec('in-flight'), up({ receipt: ok() })).rec as GateRecord;
    expect(r).toMatchObject({ state: 'mined', block: 900n, harvestedAt: 1_900, amount: 1_000_000n });
  });

  it('a reverted receipt voids the record: the harvest moved nothing', () => {
    expect(advance(rec('in-flight'), up({ receipt: ok({ success: false }) })).rec?.state).toBe('void');
    expect(advance(rec('void'), up()).rec).toBeNull(); // and the next refresh deletes it
  });

  it('without a receipt it waits, also when the lookup failed', () => {
    expect(advance(rec('in-flight', { nonce: 4 }), up({ receipt: null, nonceAtPin: 4 })).rec?.state).toBe('in-flight');
    expect(advance(rec('in-flight', { nonce: 4 }), up({ receipt: undefined, nonceAtPin: 9 })).rec?.state).toBe('in-flight');
  });

  it('a replaced transaction (the confirmed nonce passed it, no receipt) is cautious, with the pinned block\'s time', () => {
    const r = advance(rec('in-flight', { nonce: 4 }), up({ receipt: null, nonceAtPin: 5, pin: { block: 1_000n, time: 1_990 } })).rec as GateRecord;
    expect(r).toMatchObject({ state: 'cautious', harvestedAt: 1_990, block: 1_000n });
  });

  it('with the nonce unknown a replacement is never inferred, however far the wallet\'s nonce is', () => {
    expect(advance(rec('in-flight', { nonce: null }), up({ receipt: null, nonceAtPin: 99 })).rec?.state).toBe('in-flight');
    // the nonce comes from the transaction by hash when the node knows it
    const r = advance(rec('in-flight', { nonce: null }), up({ receipt: null, txNonce: 7, nonceAtPin: 99 })).rec;
    expect(r?.nonce).toBe(7);
  });

  it('mined becomes final once its block is finalized; a re-included receipt updates the time and the block', () => {
    const mined = rec('mined', { block: 900n, harvestedAt: 1_900 });
    expect(advance(mined, up({ receipt: ok(), finalized: 899n })).rec?.state).toBe('mined');
    expect(advance(mined, up({ receipt: ok(), finalized: 900n })).rec?.state).toBe('final');
    const again = advance(mined, up({ receipt: ok({ block: 905n, time: 1_907 }), finalized: 800n })).rec as GateRecord;
    expect(again).toMatchObject({ state: 'mined', block: 905n, harvestedAt: 1_907 });
  });

  it('a receipt that is gone sends mined back to in flight, as the one step back', () => {
    const out = advance(rec('mined', { block: 900n, harvestedAt: 1_900 }), up({ receipt: null }));
    expect(out.rec?.state).toBe('in-flight');
    expect(out.vanished).toBe(true);
    // a receipt that could not be looked up changes nothing
    expect(advance(rec('mined', { block: 900n, harvestedAt: 1_900 }), up({ receipt: undefined, finalized: 800n })).rec?.state).toBe('mined');
  });

  it('without a readable finalized block, fifteen blocks deep is final', () => {
    expect(isFinal(900n, null, 914n)).toBe(false);
    expect(isFinal(900n, null, 915n)).toBe(true);
    expect(isFinal(900n, null, null)).toBe(false);
    expect(advance(rec('mined', { block: 900n, harvestedAt: 1_900 }), up({ receipt: ok(), finalized: null, latest: 915n })).rec?.state).toBe('final');
  });

  it('a cautious observation made meanwhile is a floor: the record is final only when that block is too', () => {
    const floored = rec('mined', { block: 900n, harvestedAt: 1_900, floor: 950n });
    expect(advance(floored, up({ receipt: ok(), finalized: 940n })).rec?.state).toBe('mined');
    expect(advance(floored, up({ receipt: ok(), finalized: 950n })).rec?.state).toBe('final');
  });

  it('a cautious record becomes final like a mined one, by the block the app read', () => {
    const c = rec('cautious', { hash: null, block: 900n, harvestedAt: 1_990 });
    expect(advance(c, up({ finalized: 899n })).rec?.state).toBe('cautious');
    expect(advance(c, up({ finalized: 900n })).rec?.state).toBe('final');
  });

  it('final becomes passed when the head is later than the time plus two seconds', () => {
    const f = rec('final', { harvestedAt: 1_000 });
    expect(advance(f, up({ now: 1_002 })).rec?.state).toBe('final');
    expect(advance(f, up({ now: 1_003 })).rec?.state).toBe('passed');
  });

  it('passed becomes moved when the voucher is found in an agent, and is dropped after a day if it never moves', () => {
    const p = rec('passed', { harvestedAt: 1_000 });
    const moved = advance(p, up({ now: 2_000, xlBlock: 777n, agent: AGENT })).rec as GateRecord;
    expect(moved).toMatchObject({ state: 'moved', agent: AGENT, movedBlock: 777n, cursor: 777n, movedAt: 2_000 });
    expect(advance(p, up({ now: 1_000 + 86_400 })).rec?.state).toBe('passed');
    expect(advance(p, up({ now: 1_000 + 86_401 })).rec).toBeNull();
  });

  it('keeps the block the move itself recorded', () => {
    const p = rec('passed', { harvestedAt: 1_000, movedBlock: 770n, cursor: 770n });
    expect(advance(p, up({ xlBlock: 777n, agent: AGENT })).rec).toMatchObject({ movedBlock: 770n, cursor: 770n });
  });

  it('moved: the payee at the harvest\'s time is the wallet, so the record is deleted; anything else is a mismatch', () => {
    const m = rec('moved', { harvestedAt: 1_000, agent: AGENT, movedBlock: 700n, cursor: 700n });
    expect(advance(m, up({ payee: ME })).rec).toBeNull();
    expect(advance(m, up({ payee: ME.toLowerCase() as never })).rec).toBeNull();
    expect(advance(m, up({ payee: AGENT })).rec).toMatchObject({ state: 'payee-mismatch', agent: AGENT });
    // a read that failed is looked at again next time, never read as "fine"
    expect(advance(m, up({ payee: undefined })).rec?.state).toBe('moved');
  });

  it('a mismatch is deleted when the harvest is seen landing, and the cursor moves on until then', () => {
    const m = rec('payee-mismatch', { agent: AGENT, cursor: 700n });
    expect(advance(m, up({ paid: { next: 800n, landed: false } })).rec).toMatchObject({ state: 'payee-mismatch', cursor: 800n });
    expect(advance(m, up({ paid: { next: 800n, landed: true } })).rec).toBeNull();
    expect(advance(m, up({ paid: null })).rec).toMatchObject({ cursor: 700n });
  });
});

describe('storage', () => {
  it('a record survives the round trip through text, bigints included', () => {
    const r = rec('mined', { nonce: 5, harvestedAt: 1_900, block: 900n, amount: 123_456_789_012n, floor: 950n, base: { block: 800n, mined: 5_000n }, agent: AGENT, movedBlock: 10n, cursor: 11n, movedAt: 12 });
    expect(decodeRecord(encodeRecord(r), 16, ME)).toEqual(r);
  });

  it('is refused for another id or wallet, and for text that is not a record', () => {
    const text = encodeRecord(rec('mined', { harvestedAt: 1, block: 1n }));
    expect(decodeRecord(text, 17, ME)).toBeNull();
    expect(decodeRecord(text, 16, A(0xb0b))).toBeNull();
    for (const bad of ['', '{', 'null', '[]', '{"id":16}', JSON.stringify({ ...JSON.parse(text), state: 'weird' }), JSON.stringify({ ...JSON.parse(text), hash: '0x12' }), JSON.stringify({ ...JSON.parse(text), block: 'abc' })]) {
      expect(decodeRecord(bad, 16, ME), bad).toBeNull();
    }
  });

  it('a record that is there and cannot be read stands for a waiting harvest', () => {
    const kv = memoryStore();
    const store = new GateStore(kv, 196);
    kv.set(`tp:gate:196:${ME.toLowerCase()}:16`, '{not json');
    const r = store.get(ME, 16);
    expect(r?.state).toBe('prompting');
    expect(gateOpen(r, 99_999_999)).toBe(false);
  });

  it('is shared by every tab: a record written through one store blocks a harvest started through another', () => {
    const kv = memoryStore(); // the same localStorage
    const tabA = new GateStore(kv, 196);
    const tabB = new GateStore(kv, 196);
    expect(tabA.begin(promptingRecord(16, ME, 1_000, null))).toBe(true);
    expect(tabB.get(ME, 16)?.state).toBe('prompting');
    expect(tabB.begin(promptingRecord(16, ME, 1_001, null))).toBe(false);
    // tab B moves it forward; tab A, still holding the old state, cannot undo that
    tabB.put(rec('in-flight', { createdAt: 1_000 }));
    tabA.put(rec('prompting', { createdAt: 1_000, hash: null }));
    expect(tabA.get(ME, 16)?.state).toBe('in-flight');
    expect(tabA.begin(promptingRecord(16, ME, 1_002, null))).toBe(false);
    // other wallets and other chains do not collide
    expect(new GateStore(kv, 196).get(A(0xb0b), 16)).toBeUndefined();
    expect(new GateStore(kv, 56).get(ME, 16)).toBeUndefined();
  });

  it('a voided, passed or cautious record does not block a new harvest', () => {
    for (const state of ['void', 'passed', 'final', 'cautious'] as const) {
      const store = new GateStore(memoryStore(), 196);
      store.put(rec(state, { harvestedAt: 1 }));
      expect(store.begin(promptingRecord(16, ME, 2_000, null)), state).toBe(true);
      expect(store.get(ME, 16)?.state).toBe('prompting');
    }
  });

  it('is not available where nothing can be kept (blocked localStorage), and is where it can', () => {
    const blocked: KvStore = { get: () => null, set: () => undefined, remove: () => undefined };
    expect(new GateStore(blocked, 196).available()).toBe(false);
    expect(new GateStore(memoryStore(), 196).available()).toBe(true);
    const throwing: KvStore = { get: () => null, set: () => { throw new Error('quota'); }, remove: () => undefined };
    expect(() => new GateStore(throwing, 196).available()).toThrow(); // a real store guards itself (`localStore`); the raw one is not a store
  });
});
