import { describe, expect, it } from 'vitest';
import { ownerOfAbi } from '../src/chain/abi';
import { quoteSelfPush, readBsc, type KeyCache } from '../src/chain/bsc';
import { MAINNET } from '../src/config';
import { FORGOTTEN, factsFromMiner, factsFromReport, isCustodied, vaultForgot, ZERO_ADDRESS, type ReportRaw } from '../src/logic/bscReader';
import { A, CPU, NOW, OTHER, addRig, bscRig, buildWorld, readyRig } from './world';

const book = MAINNET;

describe('the BSC read mirrors BscRigReader', () => {
  it('reads a rig in four rounds: vault, key, miner, owner', async () => {
    const w = buildWorld();
    addRig(w, 16, readyRig(16, {}, { status: 1, verifWeight: 1n, bonus: 0n, pending: 2_927_650n, since: 1_792_158_257 }));
    const keys: KeyCache = new Map();
    const r = await readBsc(w.b, book, [16], keys);
    expect(w.b.calls.map((c) => c.inner)).toEqual([3, 1, 3, 2]); // round 1 adds the bridge fee, round 4 the BEM in the cell
    expect(r.facts.get(16)).toEqual({ status: 1, stopBlock: 0n, custodied: true, verifWeight: 1n, bonus: 0n, since: 1_792_158_257, mined: 2_927_650n, circuits: CPU.tapeout, circuitId: 1016n, taskId: 4n });
    expect(r.totalVerifWeight).toBe(1_600_000n);
    expect(keys.size).toBe(1);
  });

  it('reads many rigs in the same four rounds, and caches the miner key', async () => {
    const w = buildWorld();
    for (let id = 1; id <= 16; id++) addRig(w, id, readyRig(id));
    const keys: KeyCache = new Map();
    const ids = Array.from({ length: 16 }, (_, i) => i + 1);
    const r = await readBsc(w.b, book, ids, keys);
    expect(r.facts.size).toBe(16);
    expect(w.b.calls).toHaveLength(4);
    w.b.calls.length = 0;
    await readBsc(w.b, book, ids, keys);
    expect(w.b.calls.map((c) => c.inner)).toEqual([18, 48, 32]); // no key round the second time
  });

  it('a rig the vault forgot (a rescue) is all zero, which is evidence of impairment', async () => {
    const w = buildWorld();
    addRig(w, 5, { ...readyRig(5), bsc: null });
    const r = await readBsc(w.b, book, [5], new Map());
    expect(r.facts.get(5)).toEqual(FORGOTTEN);
    expect(w.b.calls).toHaveLength(1); // nothing more to ask
    expect(vaultForgot(ZERO_ADDRESS)).toBe(true);
    expect(vaultForgot(CPU.tapeout)).toBe(false);
  });

  it('custodied needs the cell to be non-zero and to own the circuit NFT; a failed ownerOf reads as no', async () => {
    const w = buildWorld();
    addRig(w, 1, readyRig(1)); // the cell owns it
    addRig(w, 2, readyRig(2, {}, { owner: OTHER })); // someone else owns it
    addRig(w, 3, readyRig(3, {}, { cell: ZERO_ADDRESS, owner: ZERO_ADDRESS })); // no cell
    const r = await readBsc(w.b, book, [1, 2, 3], new Map());
    expect(r.facts.get(1)?.custodied).toBe(true);
    expect(r.facts.get(2)?.custodied).toBe(false);
    expect(r.facts.get(3)?.custodied).toBe(false);
    // a processor whose ownerOf reverts
    const w2 = buildWorld();
    const odd = A(0x0dd);
    w2.b.on(odd, ownerOfAbi, { ownerOf: () => { throw new Error('revert'); } });
    addRig(w2, 9, readyRig(9, {}, { circuits: odd }));
    expect((await readBsc(w2.b, book, [9], new Map())).facts.get(9)?.custodied).toBe(false);
    expect(isCustodied(null, A(1))).toBe(false);
    expect(isCustodied(A(1), null)).toBe(false);
    expect(isCustodied(A(1), A(1))).toBe(true);
  });

  it('a rig whose miner cannot be read is left out, so the caller falls back to the feed', async () => {
    const w = buildWorld();
    addRig(w, 1, readyRig(1));
    addRig(w, 2, readyRig(2));
    w.b.set(book.podMining, 'getMiner', ([key]: readonly unknown[]) => {
      throw new Error(`no miner ${String(key)}`);
    });
    const r = await readBsc(w.b, book, [1, 2], new Map());
    expect(r.facts.size).toBe(0);
    expect(r.totalVerifWeight).toBe(1_600_000n);
  });

  it('a node that is down rejects, and a total weight that fails to read is null', async () => {
    const w = buildWorld();
    addRig(w, 1, readyRig(1));
    w.b.down = true;
    await expect(readBsc(w.b, book, [1], new Map())).rejects.toThrow('node down');
    w.b.down = false;
    w.b.set(book.podMining, 'totalVerifWeight', () => {
      throw new Error('x');
    });
    expect((await readBsc(w.b, book, [1], new Map())).totalVerifWeight).toBeNull();
  });

  it('turns miner data into facts with the types the app uses', () => {
    const f = factsFromMiner(CPU.tapeout, 7n, { since: 100n, status: 1, stopBlock: 0n, taskId: 4, verifWeight: 30n, bonus: 5n }, 9n, true);
    expect(f).toEqual({ status: 1, stopBlock: 0n, custodied: true, verifWeight: 30n, bonus: 5n, since: 100, mined: 9n, circuits: CPU.tapeout, circuitId: 7n, taskId: 4n });
  });
});

describe('the feed report as the fallback', () => {
  const report: ReportRaw = { rigId: 3n, circuitId: 1003n, since: 500n, stopBlock: 0n, circuits: CPU.tapeout, observedAt: BigInt(NOW - 100), status: 1, custodied: true, verifWeight: 25n, bonus: 5n, totalVerifWeight: 9n, bscBlock: 1n, pending: 4n, taskId: 4 };

  it('becomes facts labelled with the time it was observed', () => {
    const r = factsFromReport(report, true);
    expect(r?.asOf).toBe(NOW - 100);
    // the report holds PodMining's pending BEM only, not the BEM in the rig's cell: what the rig mined is unknown
    expect(r?.facts).toMatchObject({ status: 1, custodied: true, verifWeight: 25n, bonus: 5n, since: 500, mined: null, circuitId: 1003n, taskId: 4n });
  });

  it('is nothing when the feed never reported the rig', () => {
    expect(factsFromReport(report, false)).toBeNull();
    expect(factsFromReport({ ...report, observedAt: 0n }, true)).toBeNull();
  });
});

describe('the self-push price', () => {
  it('is the reporter quote for the ids, and null for none, too many or a failed read', async () => {
    const w = buildWorld();
    expect(await quoteSelfPush(w.b, book, [1, 2])).toBe(w.state.selfPush);
    expect(await quoteSelfPush(w.b, book, [])).toBeNull();
    expect(await quoteSelfPush(w.b, book, Array.from({ length: 17 }, (_, i) => i))).toBeNull();
    w.b.set(book.reporter, 'quote', () => {
      throw new Error('LZ');
    });
    expect(await quoteSelfPush(w.b, book, [1])).toBeNull();
    expect(bscRig(1).circuits).toBe(CPU.tapeout);
  });
});
