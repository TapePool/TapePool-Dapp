import { encodeAbiParameters, encodeEventTopics, type Abi } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { agentFactoryAbi, bscVaultAbi, creditPolicyAbi, rigAgentAbi, tapePoolAbi, voucherAbi } from '../src/chain/abi';
import { readBsc } from '../src/chain/bsc';
import { cloneRuntime } from '../src/chain/checks';
import { GateStore } from '../src/chain/gates';
import { createKeeperClient } from '../src/chain/keeper';
import type { DecodedLog } from '../src/chain/reader';
import { ChainSource } from '../src/chain/source';
import { IMPLEMENTATION_SLOT } from '../src/constants';
import { memoryStore } from '../src/logic/history';
import type { Address, GateRecord, Hex, PendingTx, Snapshot } from '../src/model';
import { A, ACCOUNT, addAccount, addAgent, addRig, AGENT1, bscRig, buildWorld, NOW, readyRig, type World } from './world';

/**
 * The data source side of BEM mined before a loan (SPEC-PHASE5-PRELOAN §4.4, §4.5, §5): the reads pinned to one BSC block, what
 * `mined` and the bridge fee are, and the upkeep of the harvest records on every refresh.
 */

const IMPL = A(0x1177);
const HASH = `0x${'ab'.repeat(32)}` as Hex;
const RIG = 16;
const word = (a: Address): Hex => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;

function world(over: { pending?: bigint; cellBem?: bigint } = {}): World {
  const w = buildWorld();
  const book = w.config.book;
  addAccount(w, ACCOUNT, { vouchers: [RIG], agents: [AGENT1] });
  addAgent(w, AGENT1, { collateral: [], owned: [] });
  addRig(w, RIG, readyRig(RIG, {}, { pending: over.pending ?? 3_000_000n, cellBem: over.cellBem ?? 1_000_000n }));
  w.x.on(book.pool, tapePoolAbi, { asset: book.bem, factory: book.factory });
  w.x.on(book.factory, agentFactoryAbi, { pool: book.pool, implementation: IMPL, borrowerOf: () => ACCOUNT });
  w.x.on(book.policy, creditPolicyAbi, { feed: book.receiver });
  w.x.codes.set(AGENT1.toLowerCase(), cloneRuntime(IMPL));
  w.x.storage.set(`${book.voucher.toLowerCase()}:${IMPLEMENTATION_SLOT}`, word(book.implVoucher));
  w.b.storage.set(`${book.bscVault.toLowerCase()}:${IMPLEMENTATION_SLOT}`, word(book.implVault));
  w.state.bscWallet.set(ACCOUNT.toLowerCase(), { bnb: 10n ** 17n, bem: 0n, allowance: 0n });
  return w;
}

function source(w: World, o: { store?: ReturnType<typeof memoryStore>; gates?: GateStore; chainId?: number | null } = {}) {
  const store = o.store ?? memoryStore();
  const gates = o.gates ?? new GateStore(store, 196);
  const wallet = { account: ACCOUNT as Address | null, chainId: o.chainId === undefined ? 196 : o.chainId, subscribe: () => () => undefined };
  const clock = { ms: 0 };
  const session = new Map<string, string>();
  const src = new ChainSource({
    config: w.config,
    x: w.x,
    b: w.b,
    wallet,
    keeper: createKeeperClient(null),
    store,
    gates,
    session: { get: (k) => session.get(k) ?? null, set: (k, v) => void session.set(k, v), remove: (k) => void session.delete(k) },
    clock: () => clock.ms,
    wall: () => NOW * 1000,
  });
  return { src, gates, store, wallet, clock };
}

const gate = (s: Snapshot, id = RIG): GateRecord | undefined => s.harvest.gates[String(id)];

const record = (over: Partial<GateRecord> = {}): GateRecord => ({
  id: RIG,
  wallet: ACCOUNT,
  hash: HASH,
  nonce: 42,
  harvestedAt: null,
  block: null,
  amount: 3_980_000n,
  createdAt: NOW - 30,
  state: 'in-flight',
  floor: null,
  base: null,
  agent: null,
  movedBlock: null,
  cursor: null,
  movedAt: null,
  ...over,
});

function harvestedLog(w: World, amounts: bigint[]) {
  const topics = encodeEventTopics({ abi: bscVaultAbi, eventName: 'Harvested', args: { guid: `0x${'09'.repeat(32)}` } } as never) as Hex[];
  const data = encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [[BigInt(RIG)], amounts.map((a) => (a << 128n) | 7n)]);
  return { address: w.config.book.bscVault, topics, data };
}

describe('the BSC read is pinned to one block (§5)', () => {
  it('runs every round at the head minus two, so a claim between rounds cannot be counted twice', async () => {
    const w = world();
    const r = await readBsc(w.b, w.config.book, [RIG], new Map());
    expect(r.block).toBe(w.b.number - 2n);
    expect(w.b.calls.length).toBeGreaterThanOrEqual(4);
    expect(w.b.calls.every((c) => c.block === w.b.number - 2n)).toBe(true);
  });

  it('on "header not found" it does the whole read again, from the first round, at the head minus four', async () => {
    const w = world();
    const head = w.b.number;
    w.b.failWith = 'header not found';
    // the node knows the head minus four but not yet the head minus two, and fails on a LATER round of the first try
    w.b.failIf = (c) => c.block === head - 2n && w.b.calls.filter((x) => x.block === head - 2n).length >= 3;
    const r = await readBsc(w.b, w.config.book, [RIG], new Map());
    expect(r.block).toBe(head - 4n);
    expect(r.facts.get(RIG)?.mined).toBe(4_000_000n);
    const retry = w.b.calls.filter((c) => c.block === head - 4n);
    // the rounds again from the first one; the miner key (a pure function of the rig) is the one answer of the first try that stays cached
    expect(retry.map((c) => c.inner)).toEqual([3, 3, 2]);
  });

  it('gives up after that one retry, and any other error is not retried', async () => {
    const w = world();
    w.b.failWith = 'header not found';
    w.b.failIf = () => true;
    await expect(readBsc(w.b, w.config.book, [RIG], new Map())).rejects.toThrow('header not found');
    expect(new Set(w.b.calls.map((c) => c.block))).toEqual(new Set([w.b.number - 2n, w.b.number - 4n]));
    const v = world();
    v.b.failIf = () => true; // "node error"
    await expect(readBsc(v.b, v.config.book, [RIG], new Map())).rejects.toThrow('node error');
    expect(new Set(v.b.calls.map((c) => c.block))).toEqual(new Set([v.b.number - 2n]));
  });
});

describe('mined and the bridge fee (§3, §5)', () => {
  it('mined is PodMining\'s pending BEM plus the BEM in the rig\'s vault cell', async () => {
    const w = world({ pending: 3_000_000n, cellBem: 1_234_567n });
    const { src } = source(w);
    await src.refresh();
    expect(src.snapshot(null).rigs.find((r) => r.id === RIG)?.mined).toBe(4_234_567n);
    src.dispose();
  });

  it('is unknown, and never zero, when the cell\'s BEM cannot be read; it is also unknown from the feed\'s report', async () => {
    const w = world();
    w.b.set(w.config.book.bemBsc, 'balanceOf', () => {
      throw new Error('boom');
    });
    const { src } = source(w);
    await src.refresh();
    expect(src.snapshot(null).rigs.find((r) => r.id === RIG)?.mined).toBeNull();
    src.dispose();
    // BSC cannot be read at all: the rig comes from the feed's report, which holds pending BEM only
    const v = world();
    v.b.down = true;
    const { src: s2 } = source(v);
    await s2.refresh();
    const rig = s2.snapshot(null).rigs.find((r) => r.id === RIG);
    expect(rig?.facts.bscAsOf).not.toBeNull();
    expect(rig?.mined).toBeNull();
    s2.dispose();
  });

  it('a rig without a cell has nothing in one', async () => {
    const w = world();
    addRig(w, RIG, readyRig(RIG, {}, { pending: 2_000_000n, cell: '0x0000000000000000000000000000000000000000', owner: '0x0000000000000000000000000000000000000000' }));
    const r = await readBsc(w.b, w.config.book, [RIG], new Map());
    expect(r.facts.get(RIG)?.mined).toBe(2_000_000n);
  });

  it('reads the bridge fee once for the refresh; when that read fails the 5% maximum stands', async () => {
    const w = world();
    const { src } = source(w);
    await src.refresh();
    expect(src.snapshot(null).harvest.feeBps).toBe(50);
    w.state.feeBps = 75n;
    await src.refresh();
    expect(src.snapshot(null).harvest.feeBps).toBe(75);
    w.b.set(w.config.book.bemAdapter, 'feeBps', () => {
      throw new Error('boom');
    });
    await src.refresh();
    expect(src.snapshot(null).harvest.feeBps).toBe(500);
    src.dispose();
  });

  it('reads what a harvest needs only while a rig has BEM worth harvesting, and for that rig', async () => {
    const w = world();
    const { src } = source(w);
    await src.refresh();
    const prep = src.snapshot(null).harvest.prep;
    expect(prep).toMatchObject({ contracts: 'ok', mark: { '16': true } });
    expect(prep?.quotes).toEqual([w.state.harvestFee]);
    expect(prep?.block).toBe(w.b.number - 2n);
    src.dispose();
    // a rig with less than the bond: nothing is read
    const v = world({ pending: 5_000n, cellBem: 0n });
    const { src: s2 } = source(v);
    await s2.refresh();
    expect(s2.snapshot(null).harvest.prep).toBeNull();
    s2.dispose();
  });

  it('says harvest is changed or unreadable from the implementation slots', async () => {
    const w = world();
    w.b.storage.set(`${w.config.book.bscVault.toLowerCase()}:${IMPLEMENTATION_SLOT}`, word(A(0xdead)));
    const { src } = source(w);
    await src.refresh();
    expect(src.snapshot(null).harvest.prep?.contracts).toBe('changed');
    w.b.storageAt = async () => {
      throw new Error('boom');
    };
    await src.refresh();
    expect(src.snapshot(null).harvest.prep?.contracts).toBeNull();
    src.dispose();
  });

  it('the wallet on BSC while a harvest is on its way is not the wrong-network gate (the exception covers harvest as well as the self-push)', async () => {
    const w = world();
    const { src } = source(w, { chainId: 56 });
    await src.refresh();
    expect(src.snapshot(null).wallet.status).toBe('wrong-network');
    const mark: PendingTx = { action: 'harvest', since: NOW, hash: null, chainId: 56 };
    src.setPending(mark);
    expect(src.snapshot(null).wallet.status).toBe('connected');
    src.setPending({ ...mark, action: 'selfpush' });
    expect(src.snapshot(null).wallet.status).toBe('connected');
    src.setPending({ ...mark, action: 'sweep' });
    expect(src.snapshot(null).wallet.status).toBe('wrong-network');
    src.dispose();
  });

  it('turns harvest first off where the browser keeps no records', async () => {
    const w = world();
    const blocked = new GateStore({ get: () => null, set: () => undefined, remove: () => undefined }, 196);
    const { src } = source(w, { gates: blocked });
    await src.refresh();
    expect(src.snapshot(null).harvest.storage).toBe(false);
    expect(src.snapshot(null).harvest.prep).toBeNull();
    src.dispose();
  });
});

/* ───────── the upkeep of the records ───────── */

/** The BSC block of the harvest, and its time: a few blocks before the head. */
function harvested(w: World, o: { block?: bigint; time?: number; success?: boolean } = {}) {
  const block = o.block ?? w.b.number - 10n;
  const time = o.time ?? NOW - 20;
  w.b.blockTimes = (n) => (n === block ? time : w.b.timestamp - Number(w.b.number - n));
  w.b.receipts.set(HASH, { success: o.success ?? true, blockNumber: block, logs: [harvestedLog(w, [3_980_000n])] });
  return { block, time };
}

describe('a harvest record, from the hash to the end (§4.4)', () => {
  it('goes in flight, mined, final, passed, moved and deleted over the refreshes, and the move gate follows', async () => {
    const w = world();
    const { src, gates } = source(w);
    const { block, time } = harvested(w);
    w.b.finalizedNumber = block - 1n; // the harvest\'s block is not final yet
    w.state.payeeAt = () => ACCOUNT; // BSC time had passed the moment the voucher came into the wallet
    gates.put(record());
    await src.refresh();
    let r = gate(src.snapshot(null));
    expect(r).toMatchObject({ state: 'mined', block, harvestedAt: time, amount: 3_980_000n, nonce: 42 });

    await src.refresh(); // still not finalized
    expect(gate(src.snapshot(null))?.state).toBe('mined');

    w.b.finalizedNumber = block;
    w.x.timestamp = time + 2; // the head is T_h + 2
    await src.refresh();
    expect(gate(src.snapshot(null))?.state).toBe('final');

    w.x.timestamp = time + 3;
    await src.refresh();
    r = gate(src.snapshot(null));
    expect(r?.state).toBe('passed');

    // the voucher moves into the agent
    const acct = w.state.accounts.get(ACCOUNT.toLowerCase());
    if (acct) acct.vouchers = [];
    const ag = w.state.agents.get(AGENT1.toLowerCase());
    if (ag) {
      ag.owned = [RIG];
      ag.collateral = [RIG];
    }
    w.x.number += 5n;
    await src.refresh();
    // §4.5 ran in the same refresh: the payee at the harvest\'s time was the wallet, so the record is gone
    expect(gate(src.snapshot(null))).toBeUndefined();
    expect(gates.get(ACCOUNT, RIG)).toBeUndefined();
    src.dispose();
  });

  it('reads the check after a reload during the move: a record found `moved` is checked on any refresh, and deleted only after', async () => {
    const w = world();
    const { src, gates } = source(w);
    gates.put(record({ state: 'moved', harvestedAt: NOW - 20, block: 1n, agent: AGENT1, movedBlock: w.x.number, cursor: w.x.number, movedAt: NOW - 3 }));
    const acct = w.state.accounts.get(ACCOUNT.toLowerCase());
    if (acct) acct.vouchers = [];
    const ag = w.state.agents.get(AGENT1.toLowerCase());
    if (ag) ag.owned = [RIG];
    let payeeReads = 0;
    w.state.payeeAt = () => {
      payeeReads++;
      return ACCOUNT;
    };
    await src.refresh();
    expect(payeeReads).toBe(1);
    expect(gates.get(ACCOUNT, RIG)).toBeUndefined();
    src.dispose();
  });

  it('a reverted receipt voids the record, and the next refresh deletes it', async () => {
    const w = world();
    const { src, gates } = source(w);
    harvested(w, { success: false });
    gates.put(record());
    await src.refresh();
    expect(gate(src.snapshot(null))?.state).toBe('void');
    await src.refresh();
    expect(gate(src.snapshot(null))).toBeUndefined();
    src.dispose();
  });

  it('a reload between the hash and the receipt: the record is read again, in this tab or another, and followed', async () => {
    const w = world();
    const store = memoryStore();
    const first = source(w, { store });
    first.gates.put(record());
    first.src.dispose();
    // a new page, a new source, the same localStorage; the receipt is mined in between
    const { block } = harvested(w);
    w.b.finalizedNumber = block - 1n;
    const second = source(w, { store });
    await second.src.refresh();
    expect(gate(second.src.snapshot(null))?.state).toBe('mined');
    // and another tab sees the same record
    const other = source(w, { store });
    await other.src.refresh();
    expect(gate(other.src.snapshot(null))).toMatchObject({ state: 'mined', hash: HASH });
    second.src.dispose();
    other.src.dispose();
  });

  it('a prompting record survives a reload, and a drop of the rig\'s BEM after it turns it cautious', async () => {
    const w = world();
    const store = memoryStore();
    w.b.finalizedNumber = 1n; // nothing is final yet
    const first = source(w, { store });
    first.gates.put({ ...record(), state: 'prompting', hash: null, nonce: null, amount: null });
    first.src.dispose();
    const { src, gates } = source(w, { store });
    await src.refresh(); // the first read after the reload: 0.04 BEM
    expect(gate(src.snapshot(null))?.state).toBe('prompting');
    // someone harvests the rig; the next read is at a higher block and finds nothing
    addRig(w, RIG, readyRig(RIG, {}, { pending: 0n, cellBem: 0n }));
    w.b.number += 5n;
    w.b.blockTimes = (n) => w.b.timestamp - Number(w.b.number - n);
    await src.refresh();
    expect(gates.get(ACCOUNT, RIG)).toMatchObject({ state: 'cautious', hash: null, harvestedAt: NOW - 2, block: w.b.number - 2n });
    src.dispose();
  });

  it('a prompting record knows what the rig held when the harvest was prepared: a drop shows on the first read after a reload', async () => {
    const w = world({ pending: 0n, cellBem: 0n });
    w.b.finalizedNumber = 1n;
    const store = memoryStore();
    const first = source(w, { store });
    first.gates.put({ ...record(), state: 'prompting', hash: null, nonce: null, amount: null, base: { block: w.b.number - 20n, mined: 4_000_000n } });
    first.src.dispose();
    const { src, gates } = source(w, { store });
    await src.refresh();
    expect(gates.get(ACCOUNT, RIG)?.state).toBe('cautious');
    src.dispose();
  });

  it('a cautious record is written only when the second read\'s pinned block is higher than the first\'s', async () => {
    const w = world();
    w.b.finalizedNumber = 1n;
    const { src, gates } = source(w);
    await src.refresh();
    // a lagging node answers from the SAME block with less BEM, or from an older one: nothing is written
    addRig(w, RIG, readyRig(RIG, {}, { pending: 0n, cellBem: 0n }));
    await src.refresh();
    expect(gates.get(ACCOUNT, RIG)).toBeUndefined();
    w.b.number -= 3n;
    await src.refresh();
    expect(gates.get(ACCOUNT, RIG)).toBeUndefined();
    // a higher block with less BEM is a harvest
    w.b.number += 10n;
    await src.refresh();
    expect(gates.get(ACCOUNT, RIG)?.state).toBe('cautious');
    src.dispose();
  });

  it('a drop never replaces the app\'s own unresolved harvest: it only raises when the record becomes final', async () => {
    const w = world();
    const { src, gates } = source(w);
    gates.put(record({ state: 'in-flight' }));
    await src.refresh();
    addRig(w, RIG, readyRig(RIG, {}, { pending: 0n, cellBem: 0n }));
    w.b.number += 5n;
    await src.refresh();
    const r = gates.get(ACCOUNT, RIG);
    expect(r?.state).toBe('in-flight');
    expect(r?.hash).toBe(HASH);
    expect(r?.floor).toBe(w.b.number - 2n);
    expect(r?.harvestedAt).toBeNull();
    src.dispose();
  });

  it('a drop of the BEM of a voucher that is not in the wallet is not a harvest of the wallet\'s', async () => {
    const w = world();
    const acct = w.state.accounts.get(ACCOUNT.toLowerCase());
    if (acct) acct.vouchers = [];
    const ag = w.state.agents.get(AGENT1.toLowerCase());
    if (ag) {
      ag.owned = [RIG];
      ag.collateral = [RIG];
    }
    const { src, gates } = source(w);
    await src.refresh();
    addRig(w, RIG, readyRig(RIG, {}, { pending: 0n, cellBem: 0n }));
    w.b.number += 5n;
    await src.refresh();
    expect(gates.get(ACCOUNT, RIG)).toBeUndefined();
    src.dispose();
  });

  it('reads the nonce from the transaction by hash when it was not known, and does not infer a replacement without it', async () => {
    const w = world();
    const { src, gates } = source(w);
    gates.put(record({ nonce: null }));
    w.b.nonces.set(ACCOUNT.toLowerCase(), 99); // the wallet\'s confirmed nonce is far ahead, but the hash\'s nonce is unknown
    await src.refresh();
    expect(gates.get(ACCOUNT, RIG)).toMatchObject({ state: 'in-flight', nonce: null });
    w.b.txs.set(HASH, { nonce: 7, blockNumber: null });
    w.b.nonces.set(ACCOUNT.toLowerCase(), 7); // not past it yet
    await src.refresh();
    expect(gates.get(ACCOUNT, RIG)).toMatchObject({ state: 'in-flight', nonce: 7 });
    src.dispose();
  });

  it('a replaced hash (the confirmed nonce passed it, no receipt) is cautious, with the time of the block the nonce was read at', async () => {
    const w = world();
    w.b.finalizedNumber = 1n;
    const { src, gates } = source(w);
    gates.put(record({ nonce: 7 }));
    w.b.nonces.set(ACCOUNT.toLowerCase(), (block) => (block === undefined ? 0 : 8)); // read at the pinned block
    await src.refresh();
    const r = gates.get(ACCOUNT, RIG);
    expect(r).toMatchObject({ state: 'cautious', harvestedAt: NOW - 2, block: w.b.number - 2n });
    expect(w.b.nonceReads.every((n) => n.block === w.b.number - 2n)).toBe(true);
    src.dispose();
  });

  it('a receipt that disappears sends mined back to in flight; one included in another block updates the time and the block', async () => {
    const w = world();
    const { src, gates } = source(w);
    const first = harvested(w, { block: w.b.number - 10n, time: NOW - 20 });
    w.b.finalizedNumber = first.block - 1n;
    gates.put(record());
    await src.refresh();
    expect(gates.get(ACCOUNT, RIG)).toMatchObject({ state: 'mined', block: first.block, harvestedAt: NOW - 20 });
    // the chain reorganised: the transaction is in another block
    const second = harvested(w, { block: w.b.number - 9n, time: NOW - 19 });
    await src.refresh();
    expect(gates.get(ACCOUNT, RIG)).toMatchObject({ state: 'mined', block: second.block, harvestedAt: NOW - 19 });
    // and then it is gone
    w.b.receipts.delete(HASH);
    await src.refresh();
    expect(gates.get(ACCOUNT, RIG)).toMatchObject({ state: 'in-flight', harvestedAt: null, block: null });
    src.dispose();
  });

  it('when the node cannot say what is finalized, fifteen blocks deep counts as final', async () => {
    const w = world();
    const { src, gates } = source(w);
    const { block } = harvested(w, { block: w.b.number - 14n });
    w.b.finalizedNumber = null;
    gates.put(record());
    await src.refresh();
    expect(gates.get(ACCOUNT, RIG)?.state).toBe('mined'); // fourteen deep
    w.b.number += 1n;
    await src.refresh();
    expect(w.b.number - block).toBe(15n);
    expect(gates.get(ACCOUNT, RIG)?.state).not.toBe('mined'); // final, and then passed or final by the clock
    src.dispose();
  });

  it('a change of selection or of page keeps the gate: the records belong to the vouchers, not to the screen', async () => {
    const w = world();
    const { src, gates } = source(w);
    gates.put(record({ state: 'final', harvestedAt: NOW + 1_000, block: 1n }));
    await src.refresh();
    expect(gate(src.snapshot(null))?.state).toBe('final');
    expect(gate(src.snapshot(null), 99)).toBeUndefined();
    src.dispose();
  });
});

describe('after the move: who was paid (§4.5)', () => {
  const moveIn = (w: World) => {
    const acct = w.state.accounts.get(ACCOUNT.toLowerCase());
    if (acct) acct.vouchers = [];
    const ag = w.state.agents.get(AGENT1.toLowerCase());
    if (ag) {
      ag.owned = [RIG];
      ag.collateral = [RIG];
    }
  };
  const paid = (at: bigint, amount: bigint): DecodedLog => ({ eventName: 'Paid', args: { id: BigInt(RIG), to: AGENT1, amount }, blockNumber: at, transactionHash: HASH });

  it('keeps the record as a mismatch when the agent was the payee, and Borrow off until a Paid log shows the harvest there', async () => {
    const w = world();
    const { src, gates } = source(w);
    moveIn(w);
    w.state.payeeAt = () => AGENT1; // the gate was defeated by some cause nobody foresaw
    gates.put(record({ state: 'moved', harvestedAt: NOW - 20, block: 1n, agent: AGENT1, movedBlock: w.x.number - 100n, cursor: w.x.number - 100n, movedAt: NOW - 100, amount: 4_000_000n }));
    await src.refresh();
    expect(gate(src.snapshot(null))).toMatchObject({ state: 'payee-mismatch', agent: AGENT1 });

    // the agent\'s BEM was claimed away again: its balance says nothing, the voucher\'s own Paid log does
    w.state.agents.get(AGENT1.toLowerCase())!.bem = 0n;
    w.x.logsHandler = () => [];
    await src.refresh();
    expect(gate(src.snapshot(null))?.state).toBe('payee-mismatch');
    // 89% of what the harvest sent has not landed; 90% has
    w.x.number += 1n;
    w.x.logsHandler = () => [paid(w.x.number, 3_559_999n)];
    await src.refresh();
    expect(gate(src.snapshot(null))?.state).toBe('payee-mismatch');
    w.x.number += 1n;
    w.x.logsHandler = () => [paid(w.x.number, 3_600_000n)];
    await src.refresh();
    expect(gate(src.snapshot(null))).toBeUndefined();
    src.dispose();
  });

  it('reads the logs in pages of 100 blocks from the move, and remembers where it got to', async () => {
    const w = world();
    const { src, gates } = source(w);
    moveIn(w);
    w.state.payeeAt = () => AGENT1;
    const movedBlock = w.x.number - 250n;
    gates.put(record({ state: 'payee-mismatch', harvestedAt: NOW - 20, block: 1n, agent: AGENT1, movedBlock, cursor: movedBlock, movedAt: NOW - 100 }));
    w.x.logsHandler = () => [];
    await src.refresh();
    const q = w.x.logQueries.filter((l) => l.address === w.config.book.voucher);
    expect(q.map((l) => [l.fromBlock - movedBlock, l.toBlock - movedBlock])).toEqual([
      [0n, 99n],
      [100n, 199n],
      [200n, 250n],
    ]);
    expect(gates.get(ACCOUNT, RIG)?.cursor).toBe(w.x.number + 1n);
    // the next refresh reads only the new blocks
    w.x.logQueries.length = 0;
    w.x.number += 30n;
    await src.refresh();
    const next = w.x.logQueries.filter((l) => l.address === w.config.book.voucher);
    expect(next).toHaveLength(1);
    expect(next[0]?.fromBlock).toBe(w.x.number - 30n + 1n);
    src.dispose();
  });

  it('a record with no stored amount (a cautious one) lands on any payment to the agent', async () => {
    const w = world();
    const { src, gates } = source(w);
    moveIn(w);
    w.state.payeeAt = () => AGENT1;
    gates.put(record({ state: 'payee-mismatch', hash: null, amount: null, harvestedAt: NOW - 20, block: 1n, agent: AGENT1, movedBlock: w.x.number - 10n, cursor: w.x.number - 10n, movedAt: NOW - 10 }));
    w.x.logsHandler = () => [paid(w.x.number - 1n, 1n)];
    await src.refresh();
    expect(gate(src.snapshot(null))).toBeUndefined();
    src.dispose();
  });

  it('a payment of another voucher, or to another address, is not the harvest landing', async () => {
    const w = world();
    const { src, gates } = source(w);
    moveIn(w);
    w.state.payeeAt = () => AGENT1;
    gates.put(record({ state: 'payee-mismatch', amount: 100n, harvestedAt: NOW - 20, block: 1n, agent: AGENT1, movedBlock: w.x.number - 10n, cursor: w.x.number - 10n, movedAt: NOW - 10 }));
    w.x.logsHandler = () => [
      { ...paid(w.x.number, 100n), args: { id: 17n, to: AGENT1, amount: 100n } },
      { ...paid(w.x.number, 100n), args: { id: BigInt(RIG), to: ACCOUNT, amount: 100n } },
    ];
    await src.refresh();
    expect(gate(src.snapshot(null))?.state).toBe('payee-mismatch');
    src.dispose();
  });
});

describe('how often the source reads', () => {
  it('reads again every few seconds while a harvest record is on its way, so the move turns on soon after the clock of X Layer gets there, and not otherwise', async () => {
    vi.useFakeTimers();
    try {
      const w = world();
      const { src, gates } = source(w);
      src.start();
      await vi.advanceTimersByTimeAsync(100);
      const calls = () => w.x.calls.length;
      const c0 = calls();
      expect(c0).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(10_000); // nothing on its way: the 15 s timer of the app is the only one
      expect(calls()).toBe(c0);
      gates.put(record());
      await vi.advanceTimersByTimeAsync(4_100);
      expect(calls()).toBeGreaterThan(c0);
      src.dispose();
      const c1 = calls();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls()).toBe(c1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('measures the gate against the last head it read, and the clock of the page does not stand in for it', async () => {
    const w = world();
    const { src } = source(w);
    await src.refresh();
    expect(src.snapshot(null).harvest.headTime).toBe(NOW);
    w.x.timestamp = NOW + 30;
    await src.refresh();
    expect(src.snapshot(null).harvest.headTime).toBe(NOW + 30);
    src.dispose();
  });
});

describe('the voucher ABI the scan reads', () => {
  it('names the Paid event the voucher emits', () => {
    const paid = (voucherAbi as Abi).find((i) => i.type === 'event' && i.name === 'Paid');
    expect(paid).toBeDefined();
    expect(rigAgentAbi.length).toBeGreaterThan(0);
  });
});

void bscRig;
