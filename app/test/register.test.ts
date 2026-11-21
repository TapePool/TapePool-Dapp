import fs from 'node:fs';
import path from 'node:path';
import { decodeFunctionData, encodeErrorResult, keccak256, type Abi } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerOfAbi, rigScreenAbi, tapePoolAbi } from '../src/chain/abi';
import { ChainActions } from '../src/chain/actions';
import { ChainSource } from '../src/chain/source';
import { memoryStore } from '../src/logic/history';
import { createKeeperClient } from '../src/chain/keeper';
import { errorText, REGISTER, REVERTS, SCREEN } from '../src/chain/errors';
import { fetchArtifact, parseScreenRecord, parseScreens, requestRegister } from '../src/chain/keeper';
import type { ReceiptInfo } from '../src/chain/reader';
import { decodeRevert } from '../src/chain/revert';
import type { Eip1193Provider, WalletResult } from '../src/chain/wallet';
import { rigFacts, T0 } from '../src/fixtures/data';
import { setLang } from '../src/i18n';
import { buildRigView } from '../src/logic/rigState';
import { canonicalize, canSign, hhmm, passArgsFrom, registerLine } from '../src/logic/screen';
import type { Address, Hex, PendingTx, ScreenRecord, ScreensView, Snapshot } from '../src/model';
import { A, ACCOUNT, addAccount, addRig, bscRig, buildWorld, NOW, readyRig, type World } from './world';

/** "Register to borrow" in the app (SPEC-PHASE5-REGISTER §5, §6.2, §7, §8). */

const SCREEN_ADDR = '0xc2bBc2f2EC90e16f8a9619D26A51144Eb0AC1744' as Address;
const ART_PATH = path.resolve(__dirname, '..', '..', 'screen', 'artifacts', 'rig-16-55f3c1aa.json');
const haveArtifact = fs.existsSync(ART_PATH);
const BYTES = haveArtifact ? new Uint8Array(fs.readFileSync(ART_PATH)) : new Uint8Array();
const HASH = keccak256(BYTES);
const CIRCUITS = '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c' as Address;

beforeEach(() => setLang('en', false));

const view = (over: Record<string, unknown> = {}) => ({
  rigId: '16', status: 'pass', requestedAt: 1_763_640_000, updatedAt: 1_763_640_300, attempts: 1, retryAt: null, code: null, reasons: [],
  artifact: { file: 'rig-16-55f3c1aa.json', hash: HASH, verdict: 'PASS', circuits: CIRCUITS, circuitId: '17663', taskId: '4', bscBlock: '128895140', xlayerBlock: '73797346', verified: true },
  ...over,
});

const passRecord = (): ScreenRecord => parseScreenRecord(view()) as ScreenRecord;

/* ───────── the keeper client (§6.2) ───────── */

describe('the keeper answers, parsed strictly', () => {
  it('takes a well-formed list for this RigScreen only, and drops any record that is not exactly §6.2', () => {
    const body = { open: true, paused: false, screen: SCREEN_ADDR.toLowerCase(), asOf: 1, screens: [view(), view({ rigId: '17', status: 'nonsense' }), view({ rigId: '18', code: 'made-up' }), view({ rigId: '19', reasons: ['x'.repeat(301)] }), view({ rigId: '20', artifact: { ...view().artifact, hash: '0x12' } }), view({ rigId: '21', attempts: -1 }), view({ rigId: '016' })] };
    const s = parseScreens(body, SCREEN_ADDR) as ScreensView;
    expect(Object.keys(s.records)).toEqual(['16']);
    expect(s.records['16']).toMatchObject({ rigId: 16, status: 'pass', artifact: { circuitId: 17663n, taskId: 4n, bscBlock: 128_895_140n, verified: true } });
    expect(parseScreens({ ...body, screen: A(0xbad) }, SCREEN_ADDR)).toBeNull();
    expect(parseScreens({ ...body, open: 'yes' }, SCREEN_ADDR)).toBeNull();
    expect(parseScreens({ ...body, screens: Array(501).fill(view()) }, SCREEN_ADDR)).toBeNull();
    expect(parseScreens(null, SCREEN_ADDR)).toBeNull();
  });

  it('reads which provider served each side, and drops a record whose providers look like anything else (Q2)', () => {
    const hosts = { checkBsc: 'binance.org', checkXlayer: 'drpc.org', verifyBsc: 'blastapi.io', verifyXlayer: null };
    expect(parseScreenRecord(view({ hosts }))?.hosts).toEqual(hosts);
    expect(parseScreenRecord(view())?.hosts).toBeNull();
    expect(parseScreenRecord(view({ hosts: { ...hosts, checkBsc: 'https://x.bsc.quiknode.pro/KEY' } }))).toBeNull();
    expect(parseScreenRecord(view({ hosts: { ...hosts, verifyBsc: 7 } }))).toBeNull();
    expect(parseScreenRecord(view({ hosts: 'binance.org' }))).toBeNull();
  });

  it('posts {"rigId":"<id>"} as JSON and reads only the known statuses', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let answer: { status: number; body: unknown } = { status: 200, body: { status: 'queued', screen: view({ status: 'queued', artifact: null }) } };
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { status: answer.status, json: async () => answer.body };
    }) as unknown as typeof fetch;
    const q = await requestRegister('https://keeper.example', 16, f);
    expect(q).toMatchObject({ status: 'queued', record: { rigId: 16, status: 'queued' } });
    expect(calls[0]).toMatchObject({ url: 'https://keeper.example/v1/register', init: { method: 'POST', body: '{"rigId":"16"}', credentials: 'omit' } });
    answer = { status: 200, body: { status: 'known', screen: view({ rigId: '17' }) } };
    expect(await requestRegister('https://keeper.example', 16, f)).toEqual({ status: 'unreachable' }); // a record for another rig
    answer = { status: 200, body: { status: 'recorded' } };
    expect(await requestRegister('https://keeper.example', 16, f)).toEqual({ status: 'recorded' });
    answer = { status: 200, body: { status: 'refused', reason: 'voucher not synced' } };
    expect(await requestRegister('https://keeper.example', 16, f)).toEqual({ status: 'refused', reason: 'voucher not synced' });
    answer = { status: 500, body: {} };
    expect(await requestRegister('https://keeper.example', 16, f)).toEqual({ status: 'unreachable' });
    expect(await requestRegister(null, 16, f)).toEqual({ status: 'unreachable' });
  });

  it('downloads artifact bytes within the size limit only', async () => {
    const ok = (async () => ({ status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })) as unknown as typeof fetch;
    expect(await fetchArtifact('https://k.example', 16, ok)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await fetchArtifact('https://k.example', 16, ok, 1_000, 2)).toBeNull();
    const missing = (async () => ({ status: 404, arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch;
    expect(await fetchArtifact('https://k.example', 16, missing)).toBeNull();
  });

  it('has a line for every register answer and owner-page refusal, in both languages', () => {
    for (const reason of [...Object.keys(REGISTER), 'too many requests from this address', 'busy, try again shortly', 'busy, try again in a minute']) {
      setLang('en', false);
      const en = errorText({ kind: 'register', reason });
      setLang('cn', false);
      const cn = errorText({ kind: 'register', reason });
      expect(en, reason).not.toBe('Something went wrong. Nothing was sent.');
      expect(cn, reason).toMatch(/[一-鿿]/);
    }
    for (const why of Object.keys(SCREEN) as (keyof typeof SCREEN)[]) {
      setLang('cn', false);
      expect(errorText({ kind: 'screen', why }), why).toMatch(/[一-鿿]/);
    }
    setLang('en', false);
    expect(REVERTS.NotOwner?.en({})).toBe("Only the pool owner's wallet can record a screen pass.");
    expect(decodeRevert(encodeErrorResult({ abi: rigScreenAbi as Abi, errorName: 'NotOwner' }))).toMatchObject({ kind: 'revert', name: 'NotOwner' });
    expect(decodeRevert(encodeErrorResult({ abi: rigScreenAbi as Abi, errorName: 'BadPass' }))).toMatchObject({ kind: 'revert', name: 'BadPass' });
  });
});

/* ───────── the miner's states (§5) ───────── */

describe('the registration line', () => {
  const open = (records: Record<string, ScreenRecord> = {}, paused = false): ScreensView => ({ open: true, paused, records });
  const rec = (status: ScreenRecord['status'], over: Partial<ScreenRecord> = {}): ScreenRecord => ({ rigId: 7, status, requestedAt: T0, updatedAt: T0, attempts: 1, retryAt: null, code: null, reasons: [], artifact: null, hosts: null, ...over });
  const none = buildRigView(rigFacts({ id: 7, pass: 'none', age: 20 }), T0);

  it('lets the chain decide first: a matching pass gives the countdown to max(effectiveAt, since + MIN_RIG_AGE)', () => {
    const pending = buildRigView(rigFacts({ id: 7, pass: 'pending', passAt: T0 + 3_600, age: 20 }), T0);
    expect(registerLine(pending, null, T0)).toEqual({ kind: 'recorded', at: T0 + 3_600 });
    // too new: the age rule ends later than the pass delay
    const young = buildRigView(rigFacts({ id: 7, pass: 'pending', passAt: T0 + 3_600, since: T0 - 86_400 }), T0);
    expect(registerLine(young, open({ '7': rec('fail') }), T0)).toEqual({ kind: 'recorded', at: T0 - 86_400 + 3 * 86_400 });
    expect(hhmm(47 * 3_600 + 12 * 60)).toBe('47:12');
    expect(hhmm(-5)).toBe('0:00');
  });

  it('follows the keeper for a rig with no pass, and falls back to the note without a list', () => {
    expect(registerLine(none, null, T0)).toEqual({ kind: 'closed' });
    expect(registerLine(none, { open: false, paused: false, records: {} }, T0)).toEqual({ kind: 'closed' });
    expect(registerLine(none, open(), T0)).toEqual({ kind: 'register' });
    expect(registerLine(none, open({ '7': rec('queued') }), T0)).toEqual({ kind: 'queued', paused: false });
    expect(registerLine(none, open({ '7': rec('queued') }, true), T0)).toEqual({ kind: 'queued', paused: true });
    expect(registerLine(none, open({ '7': rec('checking') }), T0)).toEqual({ kind: 'checking' });
    expect(registerLine(none, open({ '7': rec('pass') }), T0)).toEqual({ kind: 'passed' });
    expect(registerLine(none, open({ '7': rec('recorded') }), T0)).toEqual({ kind: 'passed' });
    expect(registerLine(none, open({ '7': rec('fail', { code: 'too-wide' }) }), T0)?.kind).toBe('fail');
    expect(registerLine(none, open({ '7': rec('revoked') }), T0)).toEqual({ kind: 'revoked' });
    expect(registerLine(none, open({ '7': rec('error', { retryAt: T0 + 60 }) }), T0)?.kind).toBe('error');
    expect(registerLine(none, open({ '7': rec('error', { retryAt: T0 }) }), T0)?.kind).toBe('retry');
  });

  it('belongs to rows 10, 12 (no pass) and 13 of the wallet only: never to a suspended or changed pass, a ready rig or an agent', () => {
    const at = (s: Parameters<typeof rigFacts>[0]) => registerLine(buildRigView(rigFacts(s), T0), open(), T0);
    expect(at({ id: 7, pass: 'suspended', age: 20 })).toBeNull();
    expect(at({ id: 7, pass: 'changed', age: 20 })).toBeNull();
    expect(at({ id: 7, age: 20 })).toBeNull(); // ready
    expect(at({ id: 7, pass: 'none', base: 0, bonus: 3, age: 20 })).toBeNull(); // no base power
    expect(at({ id: 7, pass: 'none', age: 20, place: { kind: 'agent', agent: A(0xa9), closed: false, collateral: false, loanOpen: false } })).toBeNull();
    expect(at({ id: 7, pass: 'none', since: T0 - 3_600 })).toEqual({ kind: 'register' }); // too new, no pass: register now
  });
});

/* ───────── the owner page's checks on the bytes (§8.3 step 4) ───────── */

describe.skipIf(!haveArtifact)('recordPass arguments from the artifact bytes', () => {
  const enc = new TextEncoder();
  const text = new TextDecoder().decode(BYTES);

  it('derives exactly the call from the committed rig 16 artifact', () => {
    expect(canonicalize(JSON.parse(text))).toBe(text);
    expect(passArgsFrom(BYTES, 16, passRecord())).toEqual({ rigId: 16n, circuits: '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C', circuitId: 17663n, taskId: 4, artifactHash: HASH });
  });

  it('refuses tampered, re-encoded, failing, foreign or mismatching bytes, and an unverified or non-PASS record', () => {
    const tampered = BYTES.slice();
    tampered[tampered.indexOf(0x34)] = 0x35;
    expect(passArgsFrom(tampered, 16, passRecord())).toBeNull(); // the hash
    const pretty = enc.encode(JSON.stringify(JSON.parse(text), null, 1));
    const rehashed = (bytes: Uint8Array, over: Record<string, unknown> = {}) => parseScreenRecord(view({ artifact: { ...view().artifact, hash: keccak256(bytes), ...over } })) as ScreenRecord;
    expect(passArgsFrom(pretty, 16, rehashed(pretty))).toBeNull(); // not canonical
    const art = JSON.parse(text) as Record<string, unknown>;
    const variant = (patch: (a: Record<string, unknown>) => void) => {
      const a = JSON.parse(text) as Record<string, unknown>;
      patch(a);
      const b = enc.encode(canonicalize(a as never));
      return passArgsFrom(b, 16, rehashed(b));
    };
    expect(variant(() => undefined)).not.toBeNull();
    expect(variant((a) => void (a.verdict = 'FAIL'))).toBeNull();
    expect(variant((a) => void (a.mode = 'B'))).toBeNull();
    expect(variant((a) => void (a.reasons = ['x']))).toBeNull();
    expect(variant((a) => void ((a.rig as Record<string, unknown>).id = '17'))).toBeNull();
    expect(variant((a) => void ((a.rig as Record<string, unknown>).circuitId = '18446744073709551616'))).toBeNull(); // 2^64
    expect(variant((a) => void ((a.task as Record<string, unknown>).id = '4294967296'))).toBeNull(); // 2^32
    expect(variant((a) => void ((a.task as Record<string, unknown>).id = '5'))).toBeNull(); // the keeper said task 4
    expect(passArgsFrom(BYTES, 16, rehashed(BYTES, { circuitId: '1' }))).toBeNull();
    expect(passArgsFrom(BYTES, 16, rehashed(BYTES, { verified: false }))).toBeNull();
    expect(passArgsFrom(BYTES, 16, { ...passRecord(), status: 'error' })).toBeNull();
    expect(art.verdict).toBe('PASS');
  });
});

describe('who may Sign (§8.2)', () => {
  const snap = (over: Partial<Snapshot> = {}): Snapshot =>
    ({
      wallet: { account: ACCOUNT },
      screens: { open: true, paused: false, records: {} },
      ownerScreens: { owner: ACCOUNT, registryOk: true, chain: { '16': { pass: null, suspended: false } } },
      ...over,
    }) as unknown as Snapshot;
  it('only the owner, on a verified PASS with no pass and no suspension on chain, with the queue running', () => {
    const r = passRecord();
    expect(canSign(snap(), r)).toBe(true);
    expect(canSign(snap({ wallet: { account: A(0xbee) } } as never), r)).toBe(false);
    expect(canSign(snap({ ownerScreens: { owner: ACCOUNT, registryOk: false, chain: { '16': { pass: null, suspended: false } } } }), r)).toBe(false);
    expect(canSign(snap({ ownerScreens: { owner: ACCOUNT, registryOk: true, chain: { '16': { pass: null, suspended: true } } } }), r)).toBe(false);
    expect(canSign(snap({ ownerScreens: { owner: ACCOUNT, registryOk: true, chain: { '16': null } } }), r)).toBe(false);
    expect(canSign(snap({ screens: { open: true, paused: true, records: {} } }), r)).toBe(false);
    expect(canSign(snap(), { ...r, artifact: { ...r.artifact!, verified: false } })).toBe(false);
    expect(canSign(snap(), { ...r, status: 'recorded' })).toBe(false);
  });
});

/* ───────── the two actions against the in-memory chains ───────── */

interface Harness {
  w: World;
  actions: ChainActions;
  sent: { to: string; data: Hex; value: bigint }[];
  noted: ScreenRecord[];
  fetches: string[];
  answer: { register: unknown; artifact: Uint8Array | null };
}

function harness(): Harness {
  const w = buildWorld({ VITE_KEEPER_URL: 'https://keeper.example' });
  const book = w.config.book;
  addAccount(w, ACCOUNT);
  const b = bscRig(16, { circuits: CIRCUITS, circuitId: 17_663n, taskId: 4 });
  addRig(w, 16, readyRig(16, { pass: null, voucher: { circuits: CIRCUITS, circuitId: 17_663n, power: b.verifWeight } }, { circuits: CIRCUITS, circuitId: 17_663n, taskId: 4 }));
  // the artifact's real processor holds the circuit NFT in the vault cell, as the world's own processors do
  w.b.on(CIRCUITS, ownerOfAbi, { ownerOf: () => b.owner });
  w.x.on(book.pool, tapePoolAbi, { owner: ACCOUNT });
  w.x.on(book.screen, rigScreenAbi, { pool: book.pool, recordPass: [] });
  w.x.timestamp = NOW;
  w.b.timestamp = NOW;
  const h: Harness = { w, actions: null as never, sent: [], noted: [], fetches: [], answer: { register: { status: 'queued', screen: view({ status: 'queued', artifact: null }) }, artifact: BYTES } };
  let n = 0;
  const provider: Eip1193Provider = {
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0xc4';
      if (method === 'eth_sendTransaction') {
        const tx = (params as [{ to: string; data: Hex; value?: Hex }])[0];
        h.sent.push({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n });
        const hash = `0x${(++n).toString(16).padStart(64, '0')}` as Hex;
        w.x.receipts.set(hash, { success: true, blockNumber: w.x.number, gasUsed: 1n, logs: [] } as ReceiptInfo);
        return hash;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const wallet = {
    account: ACCOUNT as Address | null,
    chainId: 196,
    eip1193: provider as Eip1193Provider | null,
    readChainId: async () => 196,
    switchTo: async (): Promise<WalletResult> => ({ ok: true }),
    connect: async (): Promise<WalletResult> => ({ ok: true }),
    disconnect: () => undefined,
  };
  const fetchFn = (async (url: string) => {
    h.fetches.push(url);
    if (url.endsWith('/v1/register')) return { status: 200, json: async () => h.answer.register };
    const bytes = h.answer.artifact;
    return bytes ? { status: 200, arrayBuffer: async () => bytes.slice().buffer } : { status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  }) as unknown as typeof fetch;
  h.actions = new ChainActions({
    wallet,
    x: w.x,
    b: w.b,
    config: w.config,
    host: { now: () => NOW, setPending: (_p: PendingTx | null) => undefined, refresh: async () => undefined, noteLoanCleared: () => undefined, noteScreen: (r) => void h.noted.push(r) },
    fetch: fetchFn,
    sleep: async () => undefined,
    clock: () => 0,
  });
  return h;
}

describe('Register to borrow (§7.1)', () => {
  it('posts once, sends no transaction, and shows the returned record at once', async () => {
    const h = harness();
    const r = await h.actions.registerRig(16);
    expect(r.ok).toBe(true);
    expect(r.notice?.()).toBe('Registered. The keeper checks this rig now.');
    expect(h.noted.map((x) => x.status)).toEqual(['queued']);
    expect(h.sent).toEqual([]);
    h.answer.register = { status: 'refused', reason: 'voucher not synced' };
    const refused = await h.actions.registerRig(16);
    expect(refused.ok).toBe(false);
    expect(errorText(refused.error!)).toBe('The voucher has not synced with the rig yet. Harvest once on tapeout.net to sync it.');
  });
});

describe.skipIf(!haveArtifact)("the owner's Sign (§8.3)", () => {
  it('sends exactly recordPass(rigId, circuits, circuitId, taskId, keccak256(bytes)) to RigScreen, with no value', async () => {
    const h = harness();
    const r = await h.actions.recordPass(16, passRecord());
    expect(r.ok, r.error ? errorText(r.error) : '').toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.to.toLowerCase()).toBe(h.w.config.book.screen.toLowerCase());
    expect(h.sent[0]!.value).toBe(0n);
    expect(decodeFunctionData({ abi: rigScreenAbi, data: h.sent[0]!.data })).toEqual({ functionName: 'recordPass', args: [16n, '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C', 17663n, 4, HASH] });
    expect(h.fetches).toContain('https://keeper.example/v1/screens/16/artifact');
  });

  const refuses = async (prep: (h: Harness) => void, why: string) => {
    const h = harness();
    prep(h);
    const r = await h.actions.recordPass(16, passRecord());
    expect(r.ok).toBe(false);
    expect(errorText(r.error!)).toBe(why);
    expect(h.sent).toEqual([]);
  };

  it('sends nothing when the wallet is not the owner, the registry is not this pool, or a pass is already recorded', async () => {
    await refuses((h) => h.w.x.set(h.w.config.book.pool, 'owner', A(0xbee)), "Only the pool owner's wallet can record a screen pass.");
    await refuses((h) => h.w.x.set(h.w.config.book.screen, 'pool', A(0xbad)), 'The app does not recognise this contract. Do not continue; check the official links.');
    await refuses((h) => void (h.w.state.rigs.get(16)!.pass = { circuits: CIRCUITS, circuitId: 17_663n, taskId: 4, effectiveAt: NOW + 10 }), 'This rig already has a screen pass on-chain.');
  });

  it('sends nothing when the bytes cannot be downloaded or do not match the record', async () => {
    await refuses((h) => void (h.answer.artifact = null), 'The artifact could not be downloaded, so nothing was sent. Try again.');
    await refuses((h) => void (h.answer.artifact = new TextEncoder().encode('{"verdict":"PASS"}')), 'The artifact does not match what the keeper reported, so nothing was sent. Tell the team.');
  });

  it('sends nothing when the voucher or BSC no longer describe the rig of the artifact', async () => {
    await refuses((h) => void (h.w.state.rigs.get(16)!.voucher.circuitId = 1n), 'The rig on-chain no longer matches the artifact, so nothing was sent.');
    await refuses((h) => void (h.w.state.rigs.get(16)!.bsc!.taskId = 9), 'The rig on-chain no longer matches the artifact, so nothing was sent.');
    await refuses((h) => void (h.w.state.rigs.get(16)!.bsc!.status = 2), 'The rig on-chain no longer matches the artifact, so nothing was sent.');
  });

  it('never acts on a record the keeper did not report as a verified PASS', async () => {
    const h = harness();
    for (const rec of [{ ...passRecord(), status: 'pass' as const, artifact: { ...passRecord().artifact!, verified: false } }, { ...passRecord(), status: 'recorded' as const }, { ...passRecord(), rigId: 17 }]) {
      const r = await h.actions.recordPass(16, rec);
      expect(errorText(r.error!)).toBe('This rig has no verified screen pass to record.');
    }
    expect(h.sent).toEqual([]);
    expect(h.fetches).toEqual([]);
  });
});

/* ───────── the data source (§7.2) ───────── */

describe('the registrations in the snapshot', () => {
  function world() {
    const w = buildWorld({ VITE_KEEPER_URL: 'https://keeper.example' });
    addAccount(w, ACCOUNT, { vouchers: [103] });
    addRig(w, 103, readyRig(103, { pass: null }));
    w.x.on(w.config.book.screen, rigScreenAbi, { DELAY: 172_800n, pool: w.config.book.pool });
    w.x.on(w.config.book.pool, tapePoolAbi, { owner: ACCOUNT });
    return w;
  }
  const list = (w: World) => ({ open: true, paused: false, screen: w.config.book.screen, asOf: NOW, screens: [view({ rigId: '103', status: 'checking', artifact: null })] });

  it('reads the list and RigScreen.DELAY for a wallet rig without a pass, and drops a list older than a minute', async () => {
    const w = world();
    const seen: string[] = [];
    let up = true;
    const f = (async (url: string) => {
      seen.push(url);
      if (!up) throw new TypeError('failed to fetch');
      if (url.endsWith('/v1/screens')) return { status: 200, json: async () => list(w) } as Response;
      return { status: 503, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    const clock = { ms: 0 };
    const src = new ChainSource({ config: w.config, x: w.x, b: w.b, wallet: { account: ACCOUNT, chainId: 196, subscribe: () => () => undefined }, keeper: createKeeperClient(w.config.keeperUrl, f), store: memoryStore(), clock: () => clock.ms, wall: () => NOW * 1000 });
    src.snapshot(null);
    await src.refresh();
    const s = src.snapshot(null);
    expect(seen).toContain('https://keeper.example/v1/screens');
    expect(s.screenDelay).toBe(172_800);
    expect(s.screens?.records['103']?.status).toBe('checking');
    expect(registerLine(s.rigs.find((r) => r.id === 103)!, s.screens, s.now)).toEqual({ kind: 'checking' });
    expect(s.ownerScreens).toBeUndefined();
    up = false;
    clock.ms += 61_000;
    await src.refresh();
    expect(src.snapshot(null).screens).toBeNull();
    src.dispose();
  });

  it('replaces the list only on a 200 for this RigScreen, and keeps the last answer for a minute otherwise (L6)', async () => {
    const w = world();
    let reply: () => { status: number; body: unknown } = () => ({ status: 200, body: list(w) });
    const f = (async (url: string) => {
      if (!url.endsWith('/v1/screens')) return { status: 503, json: async () => ({}) } as Response;
      const r = reply();
      return { status: r.status, json: async () => r.body } as Response;
    }) as unknown as typeof fetch;
    const clock = { ms: 0 };
    const src = new ChainSource({ config: w.config, x: w.x, b: w.b, wallet: { account: ACCOUNT, chainId: 196, subscribe: () => () => undefined }, keeper: createKeeperClient(w.config.keeperUrl, f), store: memoryStore(), clock: () => clock.ms, wall: () => NOW * 1000 });
    src.snapshot(null);
    await src.refresh();
    expect(src.snapshot(null).screens?.records['103']?.status).toBe('checking');
    for (const bad of [() => ({ status: 503, body: {} }), () => ({ status: 404, body: { error: 'not found' } }), () => ({ status: 200, body: { ...list(w), screen: A(0xbad) } })]) {
      reply = bad;
      clock.ms += 10_000;
      await src.refresh();
      expect(src.snapshot(null).screens?.records['103']?.status).toBe('checking');
    }
    clock.ms += 31_000; // 61 s after the last good answer
    await src.refresh();
    expect(src.snapshot(null).screens).toBeNull();
    reply = () => ({ status: 200, body: { ...list(w), open: false, screens: [] } });
    await src.refresh();
    expect(src.snapshot(null).screens).toEqual({ open: false, paused: false, records: {} }); // a 200 that says closed replaces at once
    src.dispose();
  });

  it('reads the owner, the registry and the passes while the owner page is open', async () => {
    const w = world();
    const f = (async (url: string) => (url.endsWith('/v1/screens') ? { status: 200, json: async () => list(w) } : { status: 503, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    const src = new ChainSource({ config: w.config, x: w.x, b: w.b, wallet: { account: ACCOUNT, chainId: 196, subscribe: () => () => undefined }, keeper: createKeeperClient(w.config.keeperUrl, f), store: memoryStore(), clock: () => 0, wall: () => NOW * 1000 });
    src.snapshot(null, false, true);
    await src.refresh();
    const o = src.snapshot(null, false, true).ownerScreens;
    expect(o).toMatchObject({ owner: ACCOUNT, registryOk: true, chain: { '103': { pass: null, suspended: false } }, keeperUrl: 'https://keeper.example' });
    src.dispose();
  });
});
