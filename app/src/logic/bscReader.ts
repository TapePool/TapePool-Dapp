import type { Address, BscFacts, Sec } from '../model';

/**
 * The pure half of the BSC read: it turns what the vault and PodMining answered into `BscFacts`, the way
 * `src/feed/BscRigReader.sol` turns it into a `RigReport` (SPEC-PHASE5-APP §5.2). The calls themselves are in
 * `chain/bsc.ts`.
 */

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/** `PodMining.getMiner` as viem decodes it: uint64 and uint128 fields are bigints, uint32 and uint8 are numbers. */
export interface MinerRaw {
  since: bigint;
  status: number;
  stopBlock: bigint;
  taskId: number;
  verifWeight: bigint;
  bonus: bigint;
}

/** What `BscRigReader.read` leaves behind for a rig the vault no longer knows (after a rescue): all zero. It is impairment evidence. */
export const FORGOTTEN: BscFacts = {
  status: 0,
  stopBlock: 0n,
  custodied: false,
  verifWeight: 0n,
  bonus: 0n,
  since: 0,
  mined: 0n, // the vault holds nothing for a rig it forgot: a harvest of it pays nothing
  circuits: ZERO_ADDRESS,
  circuitId: 0n,
  taskId: 0n,
};

/** `vault.rigs(id)` names no processor: the vault forgot the rig. */
export const vaultForgot = (circuits: Address): boolean => circuits.toLowerCase() === ZERO_ADDRESS;

/**
 * `custodied` is `cell != 0 && circuits.ownerOf(circuitId) == cell`. A read that failed counts as "not custodied",
 * the way the contract's gas-capped static call does.
 */
export function isCustodied(cell: Address | null, owner: Address | null): boolean {
  if (cell === null || owner === null) return false;
  return cell.toLowerCase() !== ZERO_ADDRESS && cell.toLowerCase() === owner.toLowerCase();
}

/** `mined` is `pending + the cell's BEM`, or null when either read failed. */
export function factsFromMiner(circuits: Address, circuitId: bigint, m: MinerRaw, mined: bigint | null, custodied: boolean): BscFacts {
  return {
    status: m.status,
    stopBlock: m.stopBlock,
    custodied,
    verifWeight: m.verifWeight,
    bonus: m.bonus,
    since: Number(m.since),
    mined,
    circuits,
    circuitId,
    taskId: BigInt(m.taskId),
  };
}

/** `RigFeedReceiver.latest(id)` as viem decodes it. */
export interface ReportRaw {
  rigId: bigint;
  circuitId: bigint;
  since: bigint;
  stopBlock: bigint;
  circuits: Address;
  observedAt: bigint;
  status: number;
  custodied: boolean;
  verifWeight: bigint;
  bonus: bigint;
  totalVerifWeight: bigint;
  bscBlock: bigint;
  pending: bigint;
  taskId: number;
}

/**
 * The fallback when BSC cannot be read: the last report the feed holds, if it holds one. The report carries
 * `PodMining.pending` only, not the BEM in the rig's cell, so the BEM mined and not harvested is unknown here.
 */
export function factsFromReport(r: ReportRaw, ok: boolean): { facts: BscFacts; asOf: Sec } | null {
  if (!ok || r.observedAt === 0n) return null;
  return {
    asOf: Number(r.observedAt),
    facts: {
      status: r.status,
      stopBlock: r.stopBlock,
      custodied: r.custodied,
      verifWeight: r.verifWeight,
      bonus: r.bonus,
      since: Number(r.since),
      mined: null,
      circuits: r.circuits,
      circuitId: r.circuitId,
      taskId: BigInt(r.taskId),
    },
  };
}
