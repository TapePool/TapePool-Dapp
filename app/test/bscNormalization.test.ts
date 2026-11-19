import { decodeFunctionResult, encodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';
import { ownerOfAbi, podMiningAbi } from '../src/chain/abi';
import { readBsc, type KeyCache } from '../src/chain/bsc';
import { MAINNET } from '../src/config';
import { MAINNET_PARAMS, rigFacts } from '../src/fixtures/data';
import { bonusWeight, factsFromMiner, factsFromReport, isCustodied, ZERO_ADDRESS, type ReportRaw } from '../src/logic/bscReader';
import { expectedOutput } from '../src/logic/creditMath';
import { buildOpenLoan, impairmentOf, payoffEstimate } from '../src/logic/loan';
import { buildRigView } from '../src/logic/rigState';
import type { Address } from '../src/model';
import { EMPTY } from './fakeChain';
import { A, CPU, NOW, OTHER, addRig, buildWorld, openLoan, readyRig } from './world';
import bonusVectors from './vectors/bonus.json';
import clearPairVectors from './vectors/clearPair.json';
import evidenceVectors from './vectors/evidence.json';

const report: ReportRaw = { rigId: 1n, circuitId: 1001n, since: BigInt(NOW - 30 * 86_400), stopBlock: 0n, circuits: CPU.tapeout, observedAt: BigInt(NOW - 1), status: 1, custodied: true, verifWeight: 25n, bonus: 5n, totalVerifWeight: 1_600_000n, bscBlock: 1n, pending: 0n, taskId: 4 };

describe('RC4-02 raw miner normalization', () => {
  it('exports the complete evidence, clearPair and bonus groups from the Solidity producer', () => {
    expect(evidenceVectors.evidence).toHaveLength(103);
    expect(clearPairVectors.clearPair).toHaveLength(3);
    expect(bonusVectors.bonus).toHaveLength(6);
  });

  for (const [i, v] of bonusVectors.bonus.entries()) {
    const miner = { since: report.since, status: 1, stopBlock: 0n, taskId: 4, verifWeight: BigInt(v.verifWeight), bonus: BigInt(v.rawBonus), bstar: BigInt(v.bstar), mult: Number(v.mult) };

    it(`R4-01 vector ${i}: normalizes once and leaves report and downstream facts in weight units`, () => {
      expect(bonusWeight(miner)).toBe(BigInt(v.bonus));
      expect(bonusWeight({ ...miner, bonus: 0n } as typeof miner)).toBe(BigInt(v.bonus));
      const rawFacts = factsFromMiner(CPU.tapeout, 1001n, miner, 0n, true);
      const received = { ...report, verifWeight: miner.verifWeight, bonus: BigInt(v.bonus) };
      const fallback = factsFromReport(received, true)!;
      expect(rawFacts.bonus).toBe(BigInt(v.bonus));
      expect(rawFacts.verifWeight - rawFacts.bonus).toBe(BigInt(v.base));
      expect(fallback.facts).toEqual({ ...rawFacts, mined: null });
      expect(factsFromReport(received, true)).toEqual(fallback);

      for (const bsc of [rawFacts, fallback.facts]) {
        const f = { ...rigFacts({ id: 1 }), bsc, voucher: { circuits: CPU.tapeout, circuitId: 1001n, power: miner.verifWeight } };
        const view = buildRigView(f, NOW);
        expect(view.basePower).toBe(BigInt(v.base));
        expect(impairmentOf(f)).toBe(BigInt(v.base) === 0n ? 'no-power' : 'unknown');
        const loan = buildOpenLoan({ agent: A(1), raw: { ...openLoan(), open: true } as Parameters<typeof buildOpenLoan>[0]['raw'], agentBem: 0n, now: NOW, collateral: [1], rigs: new Map([[1, view]]), rules: { totalVerifWeight: report.totalVerifWeight, emissionValidUntil: NOW + 86_400 }, params: MAINNET_PARAMS, info: null });
        expect(loan.collateral[0].basePower).toBe(BigInt(v.base));
        expect(loan.expectedPerDay).toBe(expectedOutput(BigInt(v.base), report.totalVerifWeight, 0) / 7n);
        if (bsc.mined === null) expect(payoffEstimate(loan, 50, NOW).kind).toBe('none');
        else if (BigInt(v.base) === 0n) expect(payoffEstimate(loan, 50, NOW).kind).toBe('unknown');
      }
    });

    it(`R4-01 vector ${i}: ingests the raw getMiner response through the batched chain reader`, async () => {
      const w = buildWorld();
      addRig(w, 1, readyRig(1));
      const keys: KeyCache = new Map();
      await readBsc(w.b, MAINNET, [1], keys);
      const data = await w.b.call(MAINNET.podMining, encodeFunctionData({ abi: podMiningAbi, functionName: 'getMiner', args: [[...keys.values()][0]] }));
      const original = decodeFunctionResult({ abi: podMiningAbi, functionName: 'getMiner', data });
      w.b.set(MAINNET.podMining, 'getMiner', { ...original, ...miner });
      const result = await readBsc(w.b, MAINNET, [1], keys);
      expect(result.facts.get(1)).toMatchObject({ verifWeight: miner.verifWeight, bonus: BigInt(v.bonus), custodied: true });
      expect(result.facts.get(1)!.verifWeight - result.facts.get(1)!.bonus).toBe(BigInt(v.base));
    });
  }

  it('keeps TapeOut figures unchanged at multiplier one', async () => {
    const w = buildWorld();
    addRig(w, 1, readyRig(1, {}, { verifWeight: 1_248n, bonus: 248n }));
    expect((await readBsc(w.b, MAINNET, [1], new Map())).facts.get(1)).toMatchObject({ verifWeight: 1_248n, bonus: 248n });
  });
});

describe('RC4-02 custody outcomes', () => {
  it.each(['revert', 'malformed', 'zero', 'high-word'])('leaves an unreadable owner (%s) unknown without dropping another rig', async (answer) => {
    const w = buildWorld();
    addRig(w, 1, readyRig(1));
    addRig(w, 2, readyRig(2));
    w.b.set(CPU.tapeout, 'ownerOf', ([id]: readonly unknown[]) => {
      if (id === 1002n) return A(0xce11);
      if (answer === 'revert') throw new Error('owner unavailable');
      return answer === 'zero' ? ZERO_ADDRESS : EMPTY;
    });
    if (answer === 'high-word') {
      w.b.on(CPU.tapeout, [{ ...ownerOfAbi[0], outputs: [{ name: '', type: 'uint256' }] }], {
        ownerOf: ([id]: readonly unknown[]) => BigInt(A(0xce11)) + (id === 1001n ? 1n << 160n : 0n),
      });
    }
    const result = await readBsc(w.b, MAINNET, [1, 2], new Map());
    expect(result.facts.has(1)).toBe(false);
    expect(result.facts.get(2)?.custodied).toBe(true);
    expect(factsFromReport(report, true)?.facts.custodied).toBe(true);
    expect(factsFromReport(report, false)).toBeNull();
  });

  it('keeps a valid third-party owner as known not custodied', async () => {
    const w = buildWorld();
    addRig(w, 1, readyRig(1, {}, { owner: OTHER }));
    const facts = (await readBsc(w.b, MAINNET, [1], new Map())).facts.get(1);
    expect(facts?.custodied).toBe(false);
    expect(impairmentOf({ ...rigFacts({ id: 1 }), bsc: facts! })).toBe('rescued');
  });

  it('keeps a zero cell as known not custodied without reading ownerOf', async () => {
    const w = buildWorld();
    addRig(w, 1, readyRig(1, {}, { cell: ZERO_ADDRESS, owner: ZERO_ADDRESS }));
    let ownerReads = 0;
    w.b.set(CPU.tapeout, 'ownerOf', () => { ownerReads++; throw new Error('must not read'); });
    const facts = (await readBsc(w.b, MAINNET, [1], new Map())).facts.get(1);
    expect(facts).toMatchObject({ custodied: false, mined: 1_000_000n });
    expect(ownerReads).toBe(0);
    expect(w.b.calls.map((c) => c.inner)).toEqual([3, 1, 3]);
    expect(isCustodied(ZERO_ADDRESS, null)).toBe(false);
  });

  it.each(['0x12', `0x${'ff'.repeat(32)}`, ZERO_ADDRESS])('treats invalid or zero owner %s as unknown', (owner) => {
    expect(isCustodied(A(1), owner as Address)).toBeNull();
  });
});
