import type { AddressBook } from '../config';
import { decodeFunctionResult, encodeFunctionData } from 'viem';
import { BSC_PIN_LAG, BSC_PIN_LAG_RETRY } from '../constants';
import { factsFromMiner, isCustodied, FORGOTTEN, vaultForgot, type MinerRaw } from '../logic/bscReader';
import type { Address, BscFacts, Hex } from '../model';
import { adapterAbi, bscVaultAbi, erc20Abi, ownerOfAbi, podMiningAbi, reporterAbi } from './abi';
import { call, multicall, type Result } from './multicall';
import type { Reader } from './reader';

export interface BscResult {
  /** BSC facts per rig id. A rig missing here could not be read (the caller falls back to the feed's report). */
  facts: Map<number, BscFacts>;
  /** `PodMining.totalVerifWeight()` from the same read; null when it could not be read. */
  totalVerifWeight: bigint | null;
  /** The BSC block every read of this result was pinned to (SPEC-PHASE5-PRELOAN §5). */
  block: bigint;
  /** `feeBps()` of the BEM OFT adapter at that block; null when it could not be read. */
  feeBps: number | null;
}

/** `minerKey` is a pure function of (processor, circuit id), so each key is read once per page load. */
export type KeyCache = Map<string, Hex>;

const pairKey = (circuits: Address, circuitId: bigint): string => `${circuits.toLowerCase()}:${circuitId}`;
const ok = <T>(r: Result<T>): T | null => (r.ok ? r.value : null);
const ZERO = '0x0000000000000000000000000000000000000000';

/** A public node behind a load balancer that has not seen the block yet. */
export const headerMissing = (e: unknown): boolean => /header not found|block not found|unknown block/i.test(e instanceof Error ? e.message : String(e));

/**
 * Read `ids` on BSC the way `BscRigReader.read` does (SPEC-PHASE5-APP §5.2): the vault's record, PodMining's miner and
 * pending BEM, the cell that holds the circuit and the BEM in it, and who owns the circuit NFT. Four rounds, each one
 * `eth_call`: the answers of one decide the questions of the next.
 *
 * Every round is pinned to ONE block, two behind the head, so a `PodMining.claim` between two rounds (which moves BEM from
 * pending to the cell) cannot be counted twice or not at all. A node that does not have that block yet answers "header not
 * found": the whole read is then done again, from the first round, at four behind the head (SPEC-PHASE5-PRELOAN §5).
 * Rejects when the BSC node cannot be reached at all.
 */
export async function readBsc(reader: Reader, book: AddressBook, ids: readonly number[], keys: KeyCache): Promise<BscResult> {
  const head = await reader.head();
  try {
    return await readAt(reader, book, ids, keys, behind(head.number, BSC_PIN_LAG));
  } catch (e) {
    if (!headerMissing(e)) throw e;
  }
  return readAt(reader, book, ids, keys, behind(head.number, BSC_PIN_LAG_RETRY));
}

const behind = (head: bigint, lag: bigint): bigint => (head > lag ? head - lag : 0n);

async function readAt(reader: Reader, book: AddressBook, ids: readonly number[], keys: KeyCache, block: bigint): Promise<BscResult> {
  const mc = book.multicall3;
  const { bscVault, podMining } = book;
  const facts = new Map<number, BscFacts>();
  const at = { block };

  // round 1: which processor and circuit does the vault say each rig is? And the bridge fee, which a harvest pays on its way over
  const r1 = await multicall(
    reader,
    mc,
    [
      call<bigint>(podMining, podMiningAbi, 'totalVerifWeight'),
      call<bigint>(book.bemAdapter, adapterAbi, 'feeBps'),
      ...ids.map((id) => call<readonly [Address, bigint]>(bscVault, bscVaultAbi, 'rigs', [BigInt(id)])),
    ],
    at,
  );
  const [totalRes, feeRes, ...rigRes] = r1 as unknown as [Result<bigint>, Result<bigint>, ...Result<readonly [Address, bigint]>[]];
  const totalVerifWeight = ok(totalRes);
  const fee = ok(feeRes);
  const feeBps = fee !== null && fee <= 10_000n ? Number(fee) : null;

  const known: { id: number; circuits: Address; circuitId: bigint }[] = [];
  ids.forEach((id, i) => {
    const row = ok(rigRes[i] as Result<readonly [Address, bigint]>);
    if (row === null) return; // unreadable: left out, so the caller falls back
    const [circuits, circuitId] = row;
    if (vaultForgot(circuits)) facts.set(id, FORGOTTEN);
    else known.push({ id, circuits, circuitId });
  });
  if (known.length === 0) return { facts, totalVerifWeight, block, feeBps };

  // round 2: the miner key of every (processor, circuit) pair not seen yet
  const missing = [...new Map(known.filter((k) => !keys.has(pairKey(k.circuits, k.circuitId))).map((k) => [pairKey(k.circuits, k.circuitId), k])).values()];
  if (missing.length > 0) {
    const r2 = await multicall(reader, mc, missing.map((k) => call<Hex>(podMining, podMiningAbi, 'minerKey', [k.circuits, k.circuitId])), at);
    (r2 as readonly Result<Hex>[]).forEach((r, i) => {
      const m = missing[i];
      if (m && r.ok) keys.set(pairKey(m.circuits, m.circuitId), r.value);
    });
  }
  const withKey = known.flatMap((k) => {
    const key = keys.get(pairKey(k.circuits, k.circuitId));
    return key ? [{ ...k, key }] : [];
  });

  // round 3: the miner, its pending BEM and the vault cell
  const r3 = await multicall(
    reader,
    mc,
    withKey.flatMap((k) => [
      call<MinerRaw>(podMining, podMiningAbi, 'getMiner', [k.key]),
      call<bigint>(podMining, podMiningAbi, 'pending', [k.key]),
      call<Address>(bscVault, bscVaultAbi, 'cellOf', [k.key]),
    ]),
    at,
  );
  const rows = withKey.map((k, i) => ({
    ...k,
    miner: ok(r3[i * 3] as Result<MinerRaw>),
    pending: ok(r3[i * 3 + 1] as Result<bigint>),
    cell: ok(r3[i * 3 + 2] as Result<Address>),
  }));

  // round 4: does the cell own the circuit NFT? (a read that fails reads as "no", like the contract's capped static call)
  // and how much BEM is in the cell. A failed BEM read is NOT zero: it makes `mined` unknown, which the screen treats as unreadable.
  const withCell = rows.filter((r) => r.miner !== null && r.pending !== null && r.cell !== null && r.cell.toLowerCase() !== ZERO);
  const r4 = withCell.length > 0 ? await multicall(reader, mc, withCell.flatMap((r) => [call<Address>(r.circuits, ownerOfAbi, 'ownerOf', [r.circuitId]), call<bigint>(book.bemBsc, erc20Abi, 'balanceOf', [r.cell as Address])]), at) : [];
  const owner = new Map<number, Address | null>();
  const cellBem = new Map<number, bigint | null>();
  withCell.forEach((r, i) => {
    owner.set(r.id, ok((r4 as readonly Result<unknown>[])[i * 2] as Result<Address>));
    cellBem.set(r.id, ok((r4 as readonly Result<unknown>[])[i * 2 + 1] as Result<bigint>));
  });

  for (const r of rows) {
    if (r.miner === null || r.pending === null || r.cell === null) continue; // unreadable: left out
    const custodied = isCustodied(r.cell, owner.get(r.id) ?? null);
    // a rig with no cell holds nothing in one; otherwise `mined` needs both reads
    const inCell = r.cell.toLowerCase() === ZERO ? 0n : (cellBem.get(r.id) ?? null);
    facts.set(r.id, factsFromMiner(r.circuits, r.circuitId, r.miner, inCell === null ? null : r.pending + inCell, custodied));
  }
  return { facts, totalVerifWeight, block, feeBps };
}

/**
 * The BNB a self-push of `ids` costs: `RigReporter.quote(ids)`. A rig the vault does not know reads as an empty
 * report of the same size, so any ids give the right price for their count. Null when the read fails.
 */
export async function quoteSelfPush(reader: Reader, book: AddressBook, ids: readonly number[]): Promise<bigint | null> {
  if (ids.length === 0 || ids.length > 16) return null;
  try {
    const data = await reader.call(book.reporter, encodeFunctionData({ abi: reporterAbi, functionName: 'quote', args: [ids.map(BigInt)] }));
    return decodeFunctionResult({ abi: reporterAbi, functionName: 'quote', data });
  } catch { return null; }
}
