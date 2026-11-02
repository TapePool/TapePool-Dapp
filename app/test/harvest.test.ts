import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, type Abi } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { agentFactoryAbi, bscVaultAbi, creditPolicyAbi, extraErrorsAbi, reporterAbi, rigAgentAbi, tapePoolAbi, voucherAbi } from '../src/chain/abi';
import { ChainActions } from '../src/chain/actions';
import { cloneRuntime } from '../src/chain/checks';
import { errorText } from '../src/chain/errors';
import { GateStore } from '../src/chain/gates';
import type { ReceiptInfo } from '../src/chain/reader';
import { decodeRevert } from '../src/chain/revert';
import type { Eip1193Provider, WalletResult } from '../src/chain/wallet';
import { IMPLEMENTATION_SLOT } from '../src/constants';
import { setLang } from '../src/i18n';
import { memoryStore } from '../src/logic/history';
import type { Address, GateRecord, Hex, PendingTx } from '../src/model';
import type { ActionResult, MoveOptions } from '../src/source';
import { A, ACCOUNT, addAccount, addAgent, addRig, AGENT1, buildWorld, NOW, readyRig, type World } from './world';

/**
 * "Harvest it to my wallet first" and the move gate, against the in-memory chains (SPEC-PHASE5-PRELOAN §4.3, §4.4, §4.5, §7):
 * what is sent, in which order, what is written before the wallet is asked, and what is never sent.
 */

const IMPL = A(0x1177);
const hex = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const word = (a: Address): Hex => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;
const FEE = 1_500_000_000_000_000n; // quoteHarvest for one rig
const VALUE = (FEE * 11n) / 10n;
const BNB = 10n ** 17n;
const RIG = 16;

interface Rig {
  w: World;
  actions: ChainActions;
  gates: GateStore;
  sent: { chain: number; to: string; data: Hex; value: bigint; pending: PendingTx | null; records: Record<string, GateRecord> }[];
  pendings: (PendingTx | null)[];
  wallet: { chainId: number; switches: string[] };
  /** What the wallet does with the next `eth_sendTransaction`: a receipt, or an error to throw. */
  onSend: (chain: number) => ReceiptInfo | Error | void;
  /** `eth_getTransactionByHash` through the wallet's provider. */
  txByHash: (hash: Hex) => { nonce: string } | null;
  refreshes: () => number;
  clock: { now: number };
}

const ALL = [RIG, 17, 18];

function setup(over: { ids?: number[] } = {}): Rig {
  const w = buildWorld();
  const book = w.config.book;
  const ids = over.ids ?? [RIG];
  addAccount(w, ACCOUNT, { vouchers: [...ids], agents: [AGENT1] });
  addAgent(w, AGENT1, { collateral: [], owned: [] });
  // each rig has 0.03 BEM in PodMining and 0.01 in its cell: 0.04 BEM mined
  for (const id of ALL) addRig(w, id, readyRig(id, {}, { pending: 3_000_000n, cellBem: 1_000_000n }));
  w.x.on(book.pool, tapePoolAbi, { asset: book.bem, factory: book.factory });
  w.x.on(book.factory, agentFactoryAbi, { pool: book.pool, implementation: IMPL, borrowerOf: () => ACCOUNT, agentsOf: () => [AGENT1] });
  w.x.on(book.policy, creditPolicyAbi, { feed: book.receiver });
  w.x.codes.set(AGENT1.toLowerCase(), cloneRuntime(IMPL));
  w.x.on(AGENT1, rigAgentAbi, { withdrawVoucher: [], release: [] });
  w.x.on(book.voucher, voucherAbi, { safeTransferFrom: [] });
  // TapeOut's contracts are the ones the rules were reviewed against
  w.x.storage.set(`${book.voucher.toLowerCase()}:${IMPLEMENTATION_SLOT}`, word(book.implVoucher));
  w.b.storage.set(`${book.bscVault.toLowerCase()}:${IMPLEMENTATION_SLOT}`, word(book.implVault));
  w.state.harvestFee = FEE;
  w.state.bscWallet.set(ACCOUNT.toLowerCase(), { bnb: BNB, bem: 0n, allowance: 0n });
  w.x.timestamp = NOW;
  w.b.timestamp = NOW;

  const gates = new GateStore(memoryStore(), 196);
  const rig: Rig = {
    w,
    actions: null as never,
    gates,
    sent: [],
    pendings: [],
    wallet: { chainId: 196, switches: [] },
    onSend: () => undefined,
    txByHash: () => ({ nonce: '0x2a' }),
    refreshes: () => refreshes,
    clock: { now: 0 },
  };
  let refreshes = 0;
  let current: PendingTx | null = null;
  let n = 0;
  const provider: Eip1193Provider = {
    async request({ method, params }) {
      if (method === 'eth_chainId') return `0x${rig.wallet.chainId.toString(16)}`;
      if (method === 'eth_getTransactionByHash') return rig.txByHash((params as [Hex])[0]);
      if (method === 'eth_sendTransaction') {
        const tx = (params as [{ to: string; data: Hex; value?: Hex }])[0];
        rig.sent.push({ chain: rig.wallet.chainId, to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n, pending: current, records: gates.all(ACCOUNT, ALL) });
        const r = rig.onSend(rig.wallet.chainId);
        if (r instanceof Error) throw r;
        const hash = hex(++n + 5000);
        (rig.wallet.chainId === 56 ? w.b : w.x).receipts.set(hash, r ?? { success: true, blockNumber: (rig.wallet.chainId === 56 ? w.b : w.x).number, gasUsed: 400_000n, logs: [] });
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
    noteLoanCleared: () => undefined,
  };
  rig.actions = new ChainActions({ wallet, x: w.x, b: w.b, config: w.config, host, gates, sleep: async (ms) => void (rig.clock.now += ms), clock: () => rig.clock.now });
  return rig;
}

const text = (r: ActionResult): string => (r.error ? errorText(r.error) : '');
const rec = (r: Rig, id = RIG): GateRecord | undefined => r.gates.get(ACCOUNT, id);
const decode = (abi: unknown, data: Hex) => decodeFunctionData({ abi: abi as Abi, data });

/** The vault's `Harvested(guid, ids, packed)` log, as a receipt would carry it. */
function harvestedLog(book: World['config']['book'], ids: number[], amounts: bigint[]) {
  const topics = encodeEventTopics({ abi: bscVaultAbi, eventName: 'Harvested', args: { guid: hex(9) } } as never) as Hex[];
  const data = encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [ids.map(BigInt), amounts.map((a) => (a << 128n) | 7n)]);
  return { address: book.bscVault, topics, data };
}

const revert = (abi: unknown, errorName: string, args: unknown[] = []) => ({ code: 3, message: 'execution reverted', data: encodeErrorResult({ abi: abi as Abi, errorName, args } as never) });

beforeEach(() => setLang('en', false));

describe('harvest first: what it sends and writes (§4.3)', () => {
  it('sends harvest(ids) on BSC with the quote plus 10% from the wallet, switches there and back, and says what the wallet will ask', async () => {
    const r = setup();
    const res = await r.actions.harvestFirst([RIG], null);
    expect(res.ok).toBe(true);
    expect(res.decided).toEqual([RIG]);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ chain: 56, to: r.w.config.book.bscVault, value: VALUE });
    expect(decode(bscVaultAbi, r.sent[0]?.data as Hex)).toEqual({ functionName: 'harvest', args: [[16n]] });
    expect(r.wallet.switches).toEqual(['bsc', 'xlayer']);
    expect(r.wallet.chainId).toBe(196);
    // the pending mark names the harvest and chain 56, so the wrong-network gate does not replace the page; it is cleared at the end
    expect(r.pendings[0]).toMatchObject({ action: 'harvest', chainId: 56 });
    expect(r.pendings.at(-1)).toBeNull();
    expect(r.sent[0]?.pending?.ask).toMatchObject({ contract: expect.stringContaining('RigVault'), fn: 'harvest([#16])', value: '0.00165 BNB' });
    expect(r.sent[0]?.pending?.ask?.note).toBeUndefined();
    expect(res.notice?.()).toContain('Harvest sent on BSC. The BEM usually reaches your wallet on X Layer in about a minute.');
  });

  it('names the bond in the line for the wallet when the allowance and the BSC BEM both reach the bond', async () => {
    const r = setup();
    r.w.state.bscWallet.set(ACCOUNT.toLowerCase(), { bnb: BNB, bem: 10_000n, allowance: 10_000n });
    await r.actions.harvestFirst([RIG], null);
    expect(r.sent[0]?.pending?.ask?.note).toBe('bond');
    const q = setup();
    q.w.state.bscWallet.set(ACCOUNT.toLowerCase(), { bnb: BNB, bem: 10_000n, allowance: 9_999n });
    await q.actions.harvestFirst([RIG], null);
    expect(q.sent[0]?.pending?.ask?.note).toBeUndefined();
  });

  it('writes the provisional record BEFORE the wallet is asked, then the hash, the nonce from the transaction, and the receipt', async () => {
    const r = setup();
    r.w.b.blockTimes = () => NOW - 5;
    r.onSend = () => ({ success: true, blockNumber: r.w.b.number, logs: [harvestedLog(r.w.config.book, [RIG], [3_990_000n])] });
    const seen: GateRecord[] = [];
    const prompt = r.actions as unknown as { wallet: { eip1193: Eip1193Provider } };
    const before = prompt.wallet.eip1193.request;
    prompt.wallet.eip1193.request = async (a) => {
      if (a.method === 'eth_sendTransaction') seen.push(rec(r) as GateRecord);
      return before(a);
    };
    await r.actions.harvestFirst([RIG], null);
    // when the wallet was asked, the record already said "prompting", with no hash
    expect(seen[0]).toMatchObject({ state: 'prompting', hash: null, id: RIG, wallet: ACCOUNT });
    expect(seen[0]?.base).toMatchObject({ block: r.w.b.number - 2n, mined: 4_000_000n });
    const final = rec(r) as GateRecord;
    expect(final).toMatchObject({ state: 'mined', hash: hex(5001), nonce: 42, block: r.w.b.number, harvestedAt: NOW - 5, amount: 3_990_000n });
  });

  it('takes the nonce from the transaction itself and never from the wallet\'s count; when the wallet cannot say it stays unknown', async () => {
    const r = setup();
    r.txByHash = () => null;
    await r.actions.harvestFirst([RIG], null);
    expect(rec(r)?.nonce).toBeNull();
    expect(r.w.b.nonceReads).toEqual([]);
    expect(r.w.x.nonceReads).toEqual([]);
  });

  it('a rejected prompt leaves no record and leaves the choice open', async () => {
    const r = setup();
    r.onSend = () => Object.assign(new Error('User rejected'), { code: 4001 });
    const res = await r.actions.harvestFirst([RIG], null);
    expect(res.error).toEqual({ kind: 'wallet-rejected' });
    expect(res.decided).toBeUndefined();
    expect(rec(r)).toBeUndefined();
    expect(r.wallet.chainId).toBe(196); // back on X Layer
    expect(r.pendings.at(-1)).toBeNull();
  });

  it('any other error from the wallet keeps the record: a wallet can throw after it has broadcast', async () => {
    const r = setup();
    r.onSend = () => new Error('the popup crashed');
    const res = await r.actions.harvestFirst([RIG], null);
    expect(res.ok).toBe(false);
    expect(rec(r)).toMatchObject({ state: 'prompting', hash: null });
    expect(res.decided).toEqual([RIG]);
  });

  it('a receipt that never comes leaves the record in flight (the runner\'s waiting result) and the page says so', async () => {
    const r = setup();
    r.w.b.receipt = async () => null;
    const res = await r.actions.harvestFirst([RIG], null);
    expect(res.ok).toBe(false);
    expect(res.notice?.()).toContain('not confirmed yet');
    expect(rec(r)).toMatchObject({ state: 'in-flight', hash: hex(5001), nonce: 42 });
    expect(r.wallet.chainId).toBe(196);
  });

  it('a reverted receipt voids the record: the harvest moved nothing', async () => {
    const r = setup();
    r.onSend = () => ({ success: false, blockNumber: r.w.b.number });
    const res = await r.actions.harvestFirst([RIG], null);
    expect(res.ok).toBe(false);
    expect(rec(r)?.state).toBe('void');
  });

  it('writes one record per voucher and harvests them in one batch, ascending', async () => {
    const r = setup({ ids: [RIG, 17] });
    const res = await r.actions.harvestFirst([17, RIG], null);
    expect(res.ok).toBe(true);
    expect(decode(bscVaultAbi, r.sent[0]?.data as Hex)).toEqual({ functionName: 'harvest', args: [[16n, 17n]] });
    expect(r.sent[0]?.value).toBe((2n * FEE * 11n) / 10n);
    expect(rec(r, 17)?.state).toBe('mined');
    expect(rec(r, RIG)?.state).toBe('mined');
  });

  it('a second harvest of the same voucher is not sent while the first is unresolved, here or in another tab', async () => {
    const r = setup();
    r.w.b.receipt = async () => null;
    await r.actions.harvestFirst([RIG], null);
    expect(r.sent).toHaveLength(1);
    const again = await r.actions.harvestFirst([RIG], null);
    expect(again.error).toMatchObject({ kind: 'harvest', why: 'busy' });
    expect(r.sent).toHaveLength(1);
    // a record written by another tab of the app, through the same localStorage
    const o = setup();
    new GateStore((o.gates as unknown as { kv: ReturnType<typeof memoryStore> }).kv, 196).begin({ ...(promptingFor(o)), state: 'prompting' });
    expect((await o.actions.harvestFirst([RIG], null)).error).toMatchObject({ why: 'busy' });
    expect(o.sent).toHaveLength(0);
  });
});

function promptingFor(r: Rig): GateRecord {
  return { id: RIG, wallet: ACCOUNT, hash: null, nonce: null, harvestedAt: null, block: null, amount: null, createdAt: r.w.x.timestamp, state: 'prompting', floor: null, base: null, agent: null, movedBlock: null, cursor: null, movedAt: null };
}

describe('harvest first: the preconditions (§4.3), all before any wallet prompt', () => {
  const refused = async (r: Rig, why: string, ids = [RIG]) => {
    const res = await r.actions.harvestFirst(ids, null);
    expect(res.ok).toBe(false);
    expect(res.error, why).toMatchObject({ kind: 'harvest', why });
    expect(r.sent).toHaveLength(0); // the wallet was never asked
    expect(r.wallet.switches).toEqual([]); // and never moved to BSC
    expect(r.pendings).toEqual([]);
    return res;
  };

  it('runs the entry checks first: the wiring must be right, and the agent must be the user\'s when there is one', async () => {
    const r = setup();
    r.w.x.on(r.w.config.book.pool, tapePoolAbi, { asset: A(0xbad) });
    expect((await r.actions.harvestFirst([RIG], null)).error).toMatchObject({ kind: 'entry' });
    expect(r.sent).toHaveLength(0);
    const q = setup();
    q.w.x.on(q.w.config.book.factory, agentFactoryAbi, { borrowerOf: () => A(0x0b0b) });
    expect((await q.actions.harvestFirst([RIG], AGENT1)).error).toMatchObject({ kind: 'entry' });
    // a swapped credit rule blocks it too: harvest first prepares a borrow
    const p = setup();
    p.w.x.on(p.w.config.book.pool, tapePoolAbi, { policy: A(0xc0de) });
    expect((await p.actions.harvestFirst([RIG], null)).error).toEqual({ kind: 'policy-changed' });
  });

  it('refuses when the browser keeps no records', async () => {
    const r = setup();
    (r.actions as unknown as { gates: GateStore }).gates = new GateStore({ get: () => null, set: () => undefined, remove: () => undefined }, 196);
    const res = await r.actions.harvestFirst([RIG], null);
    expect(res.error).toMatchObject({ kind: 'harvest', why: 'storage' });
    expect(text(res)).toBe('This browser blocks local storage, so harvest from here is off. You can harvest on tapeout.net.');
    expect(r.sent).toHaveLength(0);
  });

  it('refuses while a harvest of the voucher is unresolved, and shows the line of that state', async () => {
    const r = setup();
    r.gates.put({ ...promptingFor(r), state: 'in-flight', hash: hex(1) });
    const res = await refused(r, 'busy');
    expect(text(res)).toBe('Harvest sent on BSC, waiting for it to be included…');
  });

  it('refuses when borrows are not open on the pool', async () => {
    for (const patch of [{ borrowsPaused: true }, { feedDisabled: true }, { pendingPolicy: A(0xc0de) }]) {
      const r = setup();
      r.w.state.statsOverride = patch;
      const res = await refused(r, 'paused');
      expect(text(res)).toBe('New borrows are paused, so harvest from here is off. You can harvest on tapeout.net.');
    }
  });

  it('refuses when either implementation is not the reviewed one, and says so in both languages', async () => {
    const r = setup();
    r.w.b.storage.set(`${r.w.config.book.bscVault.toLowerCase()}:${IMPLEMENTATION_SLOT}`, word(A(0xdead)));
    const res = await refused(r, 'contracts');
    expect(text(res)).toBe("TapeOut's contracts changed, so harvest from here is off. You can harvest on tapeout.net.");
    setLang('cn', false);
    expect(text(res)).toBe('TapeOut 合约已变更，暂停在此领取。您可以前往 tapeout.net 领取。');
    setLang('en', false);
    const q = setup();
    q.w.x.storage.set(`${q.w.config.book.voucher.toLowerCase()}:${IMPLEMENTATION_SLOT}`, word(A(0xdead)));
    await refused(q, 'contracts');
    // an empty slot is not an implementation either
    const e = setup();
    e.w.x.storage.delete(`${e.w.config.book.voucher.toLowerCase()}:${IMPLEMENTATION_SLOT}`);
    await refused(e, 'contracts');
  });

  it('refuses, fails closed, when a slot cannot be read', async () => {
    const r = setup();
    r.w.b.storageAt = async () => {
      throw new Error('boom');
    };
    await refused(r, 'unreadable');
  });

  it('refuses when the voucher is no longer in the wallet, and reads the screen again', async () => {
    const r = setup();
    r.w.state.accounts.get(ACCOUNT.toLowerCase())!.vouchers = [];
    r.w.state.agents.get(AGENT1.toLowerCase())!.owned = [RIG];
    const res = await r.actions.harvestFirst([RIG], null);
    expect(res.error).toMatchObject({ kind: 'revert', name: 'ERC721IncorrectOwner' });
    expect(r.refreshes()).toBe(1);
    expect(r.sent).toHaveLength(0);
  });

  it('waits when BSC time has not passed the moment the voucher came into the wallet: the payee would be the previous holder', async () => {
    const r = setup();
    let asked = 0;
    r.w.state.payeeAt = (_id, time) => {
      asked = time;
      return A(0xf00d); // at BSC's pinned time somebody else was the payee
    };
    const res = await refused(r, 'mark');
    expect(text(res)).toBe('Waiting for BSC to pass the time your voucher came back…');
    expect(asked).toBe(NOW - 2); // the timestamp of the pinned BSC block, head - 2
  });

  it('refuses a batch whose re-read is below the bond, decided from the re-read and not from a revert, and writes a record for the harvest it did not send', async () => {
    const r = setup();
    // someone harvested the rig meanwhile: the re-read finds 0.00005 BEM in PodMining and nothing in the cell
    addRig(r.w, RIG, readyRig(RIG, {}, { pending: 5_000n, cellBem: 0n }));
    r.gates.put({ ...promptingFor(r), state: 'void' });
    const res = await refused(r, 'sub-bond');
    expect(text(res)).toBe('Someone harvested this rig meanwhile; there is too little left to harvest from here.');
    expect(r.refreshes()).toBe(1);
    expect(rec(r)).toMatchObject({ state: 'cautious', hash: null, harvestedAt: NOW - 2 });
    // a few dust units are below the bond too, as the per-rig rounded sum is
    const q = setup();
    addRig(q.w, RIG, readyRig(RIG, {}, { pending: 9_999n, cellBem: 0n }));
    await refused(q, 'sub-bond');
  });

  it('counts the bond on the amounts a harvest would send, not on the raw sum', async () => {
    const r = setup({ ids: [RIG, 17] });
    addRig(r.w, RIG, readyRig(RIG, {}, { pending: 99n, cellBem: 0n })); // dust: a harvest sends nothing for it
    addRig(r.w, 17, readyRig(17, {}, { pending: 9_900n, cellBem: 0n }));
    const res = await r.actions.harvestFirst([RIG, 17], null);
    expect(res.error).toMatchObject({ why: 'sub-bond' }); // 9,900 sent in all is below the 10,000 bond
  });

  it('refuses when the BEM mined cannot be read', async () => {
    const r = setup();
    r.w.b.set(r.w.config.book.bemBsc, 'balanceOf', () => {
      throw new Error('boom');
    });
    await refused(r, 'unreadable');
    const q = setup();
    q.w.b.down = true;
    await refused(q, 'unreadable');
  });

  it('refuses a fee above the hard cap of 0.01 BNB, with the amount', async () => {
    const r = setup();
    r.w.state.harvestFee = 10n ** 16n; // + 10% is 0.011 BNB
    const res = await refused(r, 'cap');
    expect(text(res)).toBe('The BSC fee is unusually high (0.0110 BNB). Harvest on tapeout.net or try later.');
    // exactly at the cap is fine
    const ok = setup();
    ok.w.state.harvestFee = (10n ** 16n * 10n) / 11n;
    ok.w.state.bscWallet.set(ACCOUNT.toLowerCase(), { bnb: 10n ** 18n, bem: 0n, allowance: 0n });
    expect((await ok.actions.harvestFirst([RIG], null)).ok).toBe(true);
  });

  it('says how much BNB to add when the balance is below the value, or below the value plus the gas', async () => {
    const r = setup();
    r.w.state.bscWallet.set(ACCOUNT.toLowerCase(), { bnb: VALUE - 1_000_000_000_000n, bem: 0n, allowance: 0n });
    const res = await refused(r, 'bnb-short');
    expect(text(res)).toBe('Add at least 0.0001 BNB on BSC to harvest from here, or harvest on tapeout.net.'); // 1e-6 BNB short, rounded up to four places
    // enough for the value, not for the gas: 400,000 gas x 1.2 x the price
    const q = setup();
    q.w.b.gasUnits = 400_000n;
    q.w.b.gas = 5_000_000_000n; // 5 gwei
    q.w.state.bscWallet.set(ACCOUNT.toLowerCase(), { bnb: VALUE + 1_000_000_000_000_000n, bem: 0n, allowance: 0n });
    const gas = await refused(q, 'bnb-short');
    expect(text(gas)).toBe('Add at least 0.0014 BNB on BSC to harvest from here, or harvest on tapeout.net.'); // 2.4e15 + 1.815e15 - 2.815e15 = 1.4e15
  });

  it('shows the revert of the simulation with no wallet prompt, and maps it per action', async () => {
    const cases: [string, unknown, string][] = [
      ['unknown rig', revert(bscVaultAbi, 'BadBatch'), 'The vault on BSC no longer knows this rig.'],
      ['no BEM for the bond', revert(tapePoolAbi, 'ERC20InsufficientBalance', [ACCOUNT, 0n, 10_000n]), 'Someone harvested this rig meanwhile; there is too little left to harvest from here.'],
      ['no allowance for the bond', revert(tapePoolAbi, 'ERC20InsufficientAllowance', [ACCOUNT, 0n, 10_000n]), 'Someone harvested this rig meanwhile; there is too little left to harvest from here.'],
      ['a failed SafeERC20 call', revert(reporterAbi, 'SafeERC20FailedOperation', [A(5)]), 'Someone harvested this rig meanwhile; there is too little left to harvest from here.'],
      ['the LayerZero fee', revert(extraErrorsAbi, 'LZ_InsufficientFee', [1n, 0n, 0n, 0n]), 'The BSC fee changed. Try again.'],
      ['anything else', revert(rigAgentAbi, 'NotBorrower'), 'Something went wrong. Nothing was sent.'],
    ];
    for (const [what, err, line] of cases) {
      const r = setup();
      r.w.b.on(r.w.config.book.bscVault, bscVaultAbi, {
        harvest: () => {
          throw err;
        },
      });
      const res = await r.actions.harvestFirst([RIG], null);
      expect(res.ok, what).toBe(false);
      expect(text(res), what).toBe(line);
      expect(r.sent, what).toHaveLength(0);
    }
  });

  it('a string revert about the allowance or the balance of the token is the sub-bond case too; the self-push keeps BadBatch as "too many rigs"', () => {
    const string = encodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }], errorName: 'Error', args: ['BEP20: transfer amount exceeds allowance'] } as never);
    expect(decodeRevert(string, { action: 'harvest' })).toEqual({ kind: 'harvest', why: 'sub-bond' });
    expect(decodeRevert(string)).toMatchObject({ kind: 'unknown' });
    const bad = encodeErrorResult({ abi: bscVaultAbi as Abi, errorName: 'BadBatch', args: [] } as never);
    expect(decodeRevert(bad, { action: 'harvest' })).toEqual({ kind: 'harvest', why: 'unknown-rig' });
    expect(errorText(decodeRevert(bad))).toBe('Too many rigs for one push.');
  });
});

/* ───────── the move gate (§4.4) ───────── */

const NONE: MoveOptions = { debt: 0n, via: null };
const move = (r: Rig, ids = [RIG], o: MoveOptions = NONE) => r.actions.moveVouchers(AGENT1, ids, o);
const sentMoves = (r: Rig) => r.sent.filter((s) => s.chain === 196 && s.to === r.w.config.book.voucher).length;
const wait = 'Waiting for the harvest to settle on BSC…';

describe('the gate is enforced inside the move action, from fresh reads (§4.4)', () => {
  const put = (r: Rig, state: GateRecord['state'], over: Partial<GateRecord> = {}) => r.gates.put({ ...promptingFor(r), state, hash: state === 'prompting' ? null : hex(1), ...over });

  it('refuses at the head T_h + 2 and moves at T_h + 3, reading X Layer\'s head each time', async () => {
    const r = setup();
    put(r, 'final', { harvestedAt: NOW - 100, block: 1n });
    r.w.x.timestamp = NOW - 98; // the head is T_h + 2
    const closed = await move(r);
    expect(closed.ok).toBe(false);
    expect(closed.notice?.()).toBe(wait);
    expect(sentMoves(r)).toBe(0);
    r.w.x.timestamp = NOW - 97; // T_h + 3
    expect((await move(r)).ok).toBe(true);
    expect(sentMoves(r)).toBe(1);
  });

  it('does not trust the page\'s clock: a host clock far ahead of the chain does not open it', async () => {
    const r = setup();
    put(r, 'final', { harvestedAt: NOW - 1, block: 1n });
    // the host says it is a day later; X Layer's head says it is not
    (r.actions as unknown as { host: { now: () => number } }).host.now = () => NOW + 86_400;
    expect((await move(r)).ok).toBe(false);
    expect(sentMoves(r)).toBe(0);
  });

  it('refuses for every state a harvest is on its way in, and for a mismatch', async () => {
    for (const state of ['prompting', 'in-flight', 'mined', 'cautious', 'payee-mismatch'] as const) {
      const r = setup();
      put(r, state, { harvestedAt: NOW - 1000, block: 1n });
      const res = await move(r);
      expect(res.ok, state).toBe(false);
      expect(res.notice?.(), state).toBe(wait);
      expect(sentMoves(r), state).toBe(0);
    }
  });

  it('moves when there is no record, or the record is passed, void or moved', async () => {
    for (const state of [null, 'passed', 'void', 'moved'] as const) {
      const r = setup();
      if (state) put(r, state, { harvestedAt: NOW - 1000, block: 1n });
      expect((await move(r)).ok, String(state)).toBe(true);
    }
  });

  it('promotes a final record whose time has passed to passed, and remembers the block the voucher moved at', async () => {
    const r = setup();
    put(r, 'final', { harvestedAt: NOW - 100, block: 1n });
    r.w.x.number = 777n;
    await move(r);
    expect(rec(r)).toMatchObject({ state: 'passed', movedBlock: 777n, cursor: 777n });
  });

  it('checks every id before the first prompt, and each one again before its own prompt', async () => {
    // an id whose record closes the gate stops the whole move before anything is sent
    const a = setup({ ids: [RIG, 17] });
    a.gates.put({ ...promptingFor(a), id: 17, state: 'in-flight', hash: hex(1) });
    expect((await move(a, [RIG, 17])).ok).toBe(false);
    expect(sentMoves(a)).toBe(0);
    // and a record written while the first transfer was being signed (another tab) stops the second one
    const b = setup({ ids: [RIG, 17] });
    b.onSend = () => {
      b.gates.begin({ ...promptingFor(b), id: 17 });
    };
    const res = await move(b, [RIG, 17]);
    expect(res.ok).toBe(false);
    expect(res.notice?.()).toBe(wait);
    expect(sentMoves(b)).toBe(1);
  });

  it('a stuck harvest (ten minutes) can be moved past, explicitly, and the record is then deleted', async () => {
    const r = setup();
    put(r, 'in-flight', { createdAt: NOW - 601 });
    expect((await move(r)).ok).toBe(false); // without the explicit choice the gate stays shut
    const res = await move(r, [RIG], { debt: 0n, via: 'stuck' });
    expect(res.ok).toBe(true);
    expect(rec(r)).toBeUndefined();
    // a harvest that is not stuck yet is not given up on
    const y = setup();
    put(y, 'mined', { createdAt: NOW - 599 });
    expect((await move(y, [RIG], { debt: 0n, via: 'stuck' })).ok).toBe(false);
    expect(rec(y)?.state).toBe('mined');
    // the same for a prompt that never came back, and for a harvest that was mined but never became final
    for (const state of ['prompting', 'mined'] as const) {
      const p = setup();
      put(p, state, { createdAt: NOW - 700, harvestedAt: NOW - 650, block: 1n });
      expect((await move(p, [RIG], { debt: 0n, via: 'stuck' })).ok, state).toBe(true);
    }
  });

  it('"Move anyway" of a read that failed never overrides a gate record', async () => {
    const r = setup();
    put(r, 'in-flight', { createdAt: NOW - 5000 });
    r.w.b.down = true; // the read does fail
    const res = await move(r, [RIG], { debt: 1_000n, via: 'read-failed' });
    expect(res.ok).toBe(false);
    expect(res.notice?.()).toBe(wait);
    expect(sentMoves(r)).toBe(0);
    expect(rec(r)?.state).toBe('in-flight');
  });

  it('fails closed when X Layer\'s head cannot be read', async () => {
    const r = setup();
    r.w.x.head = async () => {
      throw new Error('boom');
    };
    expect((await move(r)).error).toMatchObject({ kind: 'harvest', why: 'unreadable' });
  });
});

describe('the requirement is checked again inside the move (§4.1)', () => {
  // rig 16 holds 0.04 BEM mined: 0.0398 landed, against a debt of 0.2 BEM that is 19%
  const DEBT = 20_000_000n;

  it('refuses a move that needs a choice when none was made, and reads the screen again', async () => {
    const r = setup();
    const res = await move(r, [RIG], { debt: DEBT, via: null });
    expect(res.error).toMatchObject({ kind: 'harvest', why: 'choose' });
    expect(sentMoves(r)).toBe(0);
    expect(r.refreshes()).toBeGreaterThan(0);
  });

  it('moves with Keep, or with a stuck harvest the user moved past', async () => {
    for (const via of ['keep', 'stuck'] as const) {
      const r = setup();
      expect((await move(r, [RIG], { debt: DEBT, via })).ok, via).toBe(true);
    }
  });

  it('does not need a choice below a tenth of the debt, or below the bond', async () => {
    const r = setup();
    expect((await move(r, [RIG], { debt: 1_000_000_000n, via: null })).ok).toBe(true);
    const q = setup();
    addRig(q.w, RIG, readyRig(RIG, {}, { pending: 9_000n, cellBem: 0n }));
    expect((await move(q, [RIG], { debt: 1_000n, via: null })).ok).toBe(true);
  });

  it('refuses when its own read fails and the user accepted nothing; the user\'s "Move anyway" of a failed read lets it through', async () => {
    const r = setup();
    r.w.b.down = true;
    const res = await move(r, [RIG], { debt: DEBT, via: null });
    expect(res.error).toMatchObject({ kind: 'harvest', why: 'mined-unreadable' });
    expect(text(res)).toBe('Could not read the BEM mined on BSC for #16.');
    expect(sentMoves(r)).toBe(0);
    for (const via of ['read-failed', 'keep'] as const) {
      const q = setup();
      q.w.b.down = true;
      expect((await move(q, [RIG], { debt: DEBT, via })).ok, via).toBe(true);
    }
  });

  it('the "Move anyway" of a failed read does not stand for a read that now succeeds and shows a required choice', async () => {
    const r = setup();
    const res = await move(r, [RIG], { debt: DEBT, via: 'read-failed' });
    expect(res.error).toMatchObject({ kind: 'harvest', why: 'choose' });
    expect(sentMoves(r)).toBe(0);
  });

  it('measures the share against the landed BEM after the bridge fee', async () => {
    // landed = 0.04 less 5% = 0.038; a tenth of 0.38 BEM
    const r = setup();
    r.w.state.feeBps = 500n;
    expect((await move(r, [RIG], { debt: 38_000_000n, via: null })).error).toMatchObject({ why: 'choose' });
    expect((await move(r, [RIG], { debt: 38_000_001n, via: null })).ok).toBe(true);
    // a fee that cannot be read counts as the 5% maximum
    const q = setup();
    q.w.b.set(q.w.config.book.bemAdapter, 'feeBps', () => {
      throw new Error('boom');
    });
    expect((await move(q, [RIG], { debt: 38_000_000n, via: null })).error).toMatchObject({ why: 'choose' });
    expect((await move(q, [RIG], { debt: 38_000_001n, via: null })).ok).toBe(true);
  });
});

describe('harvesting right after a voucher came back (§4.3 precondition 3, §4.7)', () => {
  it('waits until BSC time has passed the moment the voucher came into the wallet, then harvests', async () => {
    const r = setup();
    const markTime = NOW + 30; // the take-back landed on X Layer at this time
    r.w.state.payeeAt = (_id, time) => (time >= markTime ? ACCOUNT : AGENT1); // before it the agent was the payee
    // BSC is behind: the pinned block's time is before the mark
    const res = await r.actions.harvestFirst([RIG], AGENT1);
    expect(res.error).toMatchObject({ kind: 'harvest', why: 'mark' });
    expect(r.sent).toHaveLength(0);
    // BSC time passes it
    r.w.b.timestamp = markTime + 5;
    const later = await r.actions.harvestFirst([RIG], AGENT1);
    expect(later.ok).toBe(true);
    expect(r.sent).toHaveLength(1);
  });
});

describe('taking rigs back to harvest them (§4.7)', () => {
  it('calls withdrawVoucher for each rig, an exit that no entry check stands in front of, and keeps the agent', async () => {
    const r = setup();
    r.w.x.on(r.w.config.book.pool, tapePoolAbi, { asset: A(0xbad) });
    const res = await r.actions.takeBackToHarvest(AGENT1, [16, 17]);
    expect(res).toMatchObject({ ok: true, agent: AGENT1, reuse: true, flash: { kind: 'released', rigId: 16, ids: [16, 17] } });
    expect(r.sent.map((s) => decode(rigAgentAbi, s.data))).toEqual([
      { functionName: 'withdrawVoucher', args: [16n] },
      { functionName: 'withdrawVoucher', args: [17n] },
    ]);
    expect(r.sent.every((s) => s.to === AGENT1)).toBe(true);
  });
});

describe('a harvest paid to the agent is checked again inside the borrow action (§4.5)', () => {
  it('refuses to borrow, with nothing sent, while a record of a collateral voucher is moved or payee-mismatch', async () => {
    for (const state of ['moved', 'payee-mismatch'] as const) {
      const r = setup();
      r.gates.put({ ...promptingFor(r), state, hash: hex(1), harvestedAt: NOW - 1000, block: 1n, agent: AGENT1 });
      const res = await r.actions.borrow({ agent: AGENT1, term: 0, maxFee: 700_000n, maxLateBps: 0, principal: 1_000_000n, opsFee: 0n, ids: [RIG] });
      expect(res.ok, state).toBe(false);
      expect(text(res), state).toBe('The harvest you sent will be paid to the agent. Borrowing waits until it lands there; borrowing then sends it to you.');
      expect(r.sent, state).toEqual([]);
    }
  });
});
