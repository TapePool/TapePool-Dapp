// Chain reads, batched through Multicall3 (SPEC-PHASE3-KEEPER §3). BSC state is read at the finalized
// block. Every read that can fail returns null or a "not ok" record instead of throwing.
import { encodePacked, getAddress, keccak256, type Address, type Hex } from "viem";
import { ADDR, EXPECTED_IMPL, SLOT, type Deployment } from "./addresses.js";
import {
  agentAbi,
  beaconAbi,
  erc20Abi,
  podAbi,
  poolAbi,
  receiverAbi,
  screenAbi,
  vaultAbi,
  voucherAbi,
} from "./abi.js";
import type { Clients } from "./chains.js";
import type { Target } from "./logic/upgradeWatch.js";
import type { LoanState } from "./logic/loanMachine.js";
import { FEED_SETTLE, type Report } from "./logic/evidence.js";

const slotToAddress = (v: Hex | undefined): Address | null =>
  v && v.length === 66 ? getAddress(`0x${v.slice(26)}`) : null;

async function safe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

/**
 * A non-legacy deployment must be a redeploy 3 pool (SPEC-REDEPLOY-3 RB3-05): `FEED_SETTLE()` reads 360 and
 * `feedEnabledAt()` answers. Throws otherwise, so the keeper does not start against a pool whose evidence rules
 * this build does not mirror.
 */
export async function checkStack(c: Clients, d: Deployment): Promise<void> {
  if (d.legacy) return;
  const x = c.xlayer.public;
  const [settle] = await Promise.all([
    x.readContract({ address: d.pool, abi: poolAbi, functionName: "FEED_SETTLE" }),
    x.readContract({ address: d.pool, abi: poolAbi, functionName: "feedEnabledAt" }),
  ]);
  if (settle !== BigInt(FEED_SETTLE)) throw new Error(`pool ${d.pool} is not a redeploy 3 pool: FEED_SETTLE ${settle}`);
}

/** The finalized BSC block number. */
export async function bscFinalized(c: Clients): Promise<bigint> {
  const b = await c.bsc.public.getBlock({ blockTag: "finalized" });
  return b.number;
}

/**
 * Implementation addresses for the upgrade watch (§4.1); null on a read error. The X Layer reads run
 * alongside the BSC ones and even when BSC finality is unknown (`bscBlock` null). The BSC reads are
 * historical (at the finalized block) and run one after another: parallel archive reads trip RPC rate
 * limits and stall forked nodes.
 */
export async function readWatchTargets(c: Clients, bscBlock: bigint | null): Promise<Record<Target, Address | null>> {
  const x = c.xlayer.public;
  const b = c.bsc.public;
  const bscSlots = async (): Promise<(Hex | null)[]> => {
    const reads: [Address, Hex][] = [
      [ADDR.rigVault, SLOT.implementation],
      [ADDR.podMining, SLOT.implementation],
      ...ADDR.bscCircuits.map((circuits): [Address, Hex] => [circuits, SLOT.beacon]),
    ];
    const out: (Hex | null)[] = reads.map(() => null);
    if (bscBlock === null) return out;
    for (const [i, [address, slot]] of reads.entries()) {
      out[i] = (await safe(b.getStorageAt({ address, slot, blockNumber: bscBlock }))) ?? null;
      if (out[i] === null) break; // the RPC is failing: skip the rest instead of waiting on each (L4)
    }
    return out;
  };
  const [voucherSlot, xlayerCircuitsImpl, [vaultSlot, podSlot, ...beaconSlots]] = await Promise.all([
    safe(x.getStorageAt({ address: ADDR.voucher, slot: SLOT.implementation })),
    safe(x.readContract({ address: ADDR.xlayerCircuitsBeacon, abi: beaconAbi, functionName: "implementation" })),
    bscSlots(),
  ]);
  // every BSC processor must sit on the expected beacon; report the first one that does not
  let beacon: Address | null = EXPECTED_IMPL.bscCircuitsBeacon;
  for (const raw of beaconSlots) {
    const v = slotToAddress((raw as Hex | null) ?? undefined);
    if (v === null) {
      beacon = null; // read error: skip this comparison for the cycle
      break;
    }
    if (v.toLowerCase() !== EXPECTED_IMPL.bscCircuitsBeacon.toLowerCase()) {
      beacon = v;
      break;
    }
  }
  const bscCircuitsImpl =
    beacon === null || bscBlock === null
      ? null
      : await safe(b.readContract({ address: beacon, abi: beaconAbi, functionName: "implementation", blockNumber: bscBlock }));
  return {
    voucher: slotToAddress((voucherSlot as Hex | null) ?? undefined),
    rigVault: slotToAddress((vaultSlot as Hex | null) ?? undefined),
    podMining: slotToAddress((podSlot as Hex | null) ?? undefined),
    bscCircuitsBeacon: beacon,
    bscCircuitsImpl,
    xlayerCircuitsImpl: (xlayerCircuitsImpl as Address | null) ?? null,
  };
}

export interface LoanSnapshot {
  agent: Address;
  start: number; // loan start (0 when no loan)
  maturity: number;
  loan: LoanState & { debt: bigint };
  collateral: bigint[];
  closed: boolean;
  bem: bigint; // BEM held by the agent
}

/** Loan, collateral, closed flag and BEM balance of every agent. Agents whose reads fail are skipped. */
export async function readLoans(c: Clients, agents: Address[]): Promise<LoanSnapshot[]> {
  const out: LoanSnapshot[] = [];
  const x = c.xlayer.public;
  for (let i = 0; i < agents.length; i += 50) {
    const part = agents.slice(i, i + 50);
    const res = await x.multicall({
      allowFailure: true,
      contracts: part.flatMap((a) => [
        { address: a, abi: agentAbi, functionName: "loanOf" },
        { address: a, abi: agentAbi, functionName: "collateralOf" },
        { address: a, abi: agentAbi, functionName: "closed" },
        { address: ADDR.bemXLayer, abi: erc20Abi, functionName: "balanceOf", args: [a] },
      ] as const),
    });
    part.forEach((agent, j) => {
      const [l, col, cl, bal] = res.slice(j * 4, j * 4 + 4);
      if (l?.status !== "success" || col?.status !== "success" || cl?.status !== "success" || bal?.status !== "success") return;
      const v = l.result as {
        open: boolean;
        start: bigint;
        maturity: bigint;
        impairedAt: bigint;
        impairedRig: bigint;
        seizeStart: bigint;
        deadline: bigint;
        expired: boolean;
        debt: bigint;
      };
      out.push({
        agent,
        start: Number(v.start),
        maturity: Number(v.maturity),
        loan: {
          open: v.open,
          impairedAt: Number(v.impairedAt),
          seizeStart: Number(v.seizeStart),
          deadline: v.deadline === 2n ** 64n - 1n ? Infinity : Number(v.deadline),
          expired: v.expired,
          impairedRig: v.impairedRig,
          debt: v.debt,
        },
        collateral: [...(col.result as readonly bigint[])],
        closed: cl.result as boolean,
        bem: bal.result as bigint,
      });
    });
  }
  return out;
}

/** Vouchers the pool holds after seizes (the voucher is ERC-721 Enumerable). */
export async function readSeized(c: Clients, d: Deployment): Promise<bigint[]> {
  const x = c.xlayer.public;
  const n = await x.readContract({ address: ADDR.voucher, abi: voucherAbi, functionName: "balanceOf", args: [d.pool] });
  if (n === 0n) return [];
  const res = await x.multicall({
    allowFailure: false,
    contracts: Array.from({ length: Number(n) }, (_, i) => ({
      address: ADDR.voucher,
      abi: voucherAbi,
      functionName: "tokenOfOwnerByIndex",
      args: [d.pool, BigInt(i)],
    }) as const),
  });
  return res as bigint[];
}

export interface BscRig {
  id: bigint;
  ok: boolean; // false when the reads failed: no observation this cycle
  vaultKnows: boolean;
  circuits: Address;
  circuitId: bigint;
  taskId: number;
  status: number;
  stopBlock: bigint;
  since: bigint;
  verifWeight: bigint;
  bonus: bigint;
  pending: bigint;
  cellBalance: bigint;
  custodied: boolean;
}

export const minerKey = (circuits: Address, circuitId: bigint): Hex =>
  keccak256(encodePacked(["address", "uint256"], [circuits, circuitId]));

/** Everything the keeper needs about `ids` on BSC, at `block`. */
export async function readBscRigs(c: Clients, ids: bigint[], block: bigint): Promise<BscRig[]> {
  if (ids.length === 0) return [];
  const b = c.bsc.public;
  const empty = (id: bigint, ok: boolean): BscRig => ({
    id,
    ok,
    vaultKnows: false,
    circuits: "0x0000000000000000000000000000000000000000",
    circuitId: 0n,
    taskId: 0,
    status: 0,
    stopBlock: 0n,
    since: 0n,
    verifWeight: 0n,
    bonus: 0n,
    pending: 0n,
    cellBalance: 0n,
    custodied: false,
  });
  const first = await safe(
    b.multicall({
      allowFailure: true,
      blockNumber: block,
      contracts: ids.map((id) => ({ address: ADDR.rigVault, abi: vaultAbi, functionName: "rigs", args: [id] }) as const),
    }),
  );
  if (!first) return ids.map((id) => empty(id, false));

  const known = ids.flatMap((id, i) => {
    const r = first[i];
    if (r?.status !== "success") return [];
    const [circuits, circuitId] = r.result as readonly [Address, bigint];
    if (circuits === "0x0000000000000000000000000000000000000000") return [];
    return [{ id, circuits, circuitId, key: minerKey(circuits, circuitId) }];
  });
  // every rig unknown to the vault (rescued): nothing more to read, and no empty multicall
  if (known.length === 0) return ids.map((id, i) => (first[i]?.status === "success" ? empty(id, true) : empty(id, false)));
  const second = await safe(
    b.multicall({
      allowFailure: true,
      blockNumber: block,
      contracts: known.flatMap((k) => [
        { address: ADDR.podMining, abi: podAbi, functionName: "getMiner", args: [k.key] },
        { address: ADDR.podMining, abi: podAbi, functionName: "pending", args: [k.key] },
        { address: ADDR.rigVault, abi: vaultAbi, functionName: "cellOf", args: [k.key] },
        { address: k.circuits, abi: voucherAbi, functionName: "ownerOf", args: [k.circuitId] },
      ] as const),
    }),
  );
  if (!second) return ids.map((id) => empty(id, false));

  const cells = known.map((_, j) => {
    const r = second[j * 4 + 2];
    return r?.status === "success" ? (r.result as Address) : null;
  });
  const third = await safe(
    b.multicall({
      allowFailure: true,
      blockNumber: block,
      contracts: cells.map((cell) => ({
        address: ADDR.bemBsc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [cell ?? "0x0000000000000000000000000000000000000000"],
      }) as const),
    }),
  );

  return ids.map((id, i) => {
    if (first[i]?.status !== "success") return empty(id, false);
    const j = known.findIndex((k) => k.id === id);
    if (j < 0) return { ...empty(id, true), vaultKnows: false }; // the vault forgot it: a rescue
    const k = known[j]!;
    const miner = second[j * 4];
    const pending = second[j * 4 + 1];
    const owner = second[j * 4 + 3];
    const cell = cells[j];
    if (miner?.status !== "success" || pending?.status !== "success" || cell === null || cell === undefined) {
      return empty(id, false);
    }
    const m = miner.result as {
      taskId: number;
      status: number;
      stopBlock: bigint;
      since: bigint;
      verifWeight: bigint;
      bonus: bigint;
    };
    const cellBal = third?.[j];
    return {
      id,
      ok: cell === "0x0000000000000000000000000000000000000000" || (owner?.status === "success" && typeof owner.result === "string" && /^0x[0-9a-fA-F]{40}$/.test(owner.result)),
      vaultKnows: true,
      circuits: k.circuits,
      circuitId: k.circuitId,
      taskId: m.taskId,
      status: m.status,
      stopBlock: m.stopBlock,
      since: m.since,
      verifWeight: m.verifWeight,
      bonus: m.bonus,
      pending: pending.result as bigint,
      cellBalance: cellBal?.status === "success" ? (cellBal.result as bigint) : 0n,
      // A failed custody read is unknown, never rescue evidence (RA-14).
      custodied: cell !== "0x0000000000000000000000000000000000000000" && owner?.status === "success" && typeof owner.result === "string" && owner.result.toLowerCase() === cell.toLowerCase(),
    };
  });
}

/** null is a readable empty slot; absent entries mean a failed source. */
export async function readReports(c: Clients, d: Deployment, ids: bigint[]): Promise<Map<bigint, Report | null>> {
  const out = new Map<bigint, Report | null>();
  if (ids.length === 0) return out;
  const res = await c.xlayer.public.multicall({ allowFailure: true, contracts: ids.map((id) => ({ address: d.receiver, abi: receiverAbi, functionName: "latest", args: [id] }) as const) });
  ids.forEach((id, i) => {
    const r = res[i];
    if (r?.status === "success") {
      const [report, ok] = r.result as unknown as [Report, boolean];
      out.set(id, ok ? report : null);
    }
  });
  return out;
}

/** Newest stored report time per rig on the receiver (0 when none). */
export async function readReportTimes(c: Clients, d: Deployment, ids: bigint[]): Promise<Map<bigint, number>> {
  const out = new Map<bigint, number>();
  if (ids.length === 0) return out;
  const res = await c.xlayer.public.multicall({
    allowFailure: true,
    contracts: ids.map((id) => ({ address: d.receiver, abi: receiverAbi, functionName: "latest", args: [id] }) as const),
  });
  ids.forEach((id, i) => {
    const r = res[i];
    if (r?.status === "success") {
      const [report, ok] = r.result as unknown as [{ observedAt: bigint }, boolean];
      out.set(id, ok ? Number(report.observedAt) : 0);
    } else out.set(id, 0);
  });
  return out;
}

/**
 * `voucher.ownerOf(id)` on X Layer for each id. A failed read and the zero address are null (unknown), as the agent
 * reads them (R3-02: ERC-721 `ownerOf` never returns zero). A failing RPC throws.
 */
export async function readOwners(c: Clients, ids: bigint[]): Promise<Map<bigint, Address | null>> {
  const out = new Map<bigint, Address | null>();
  if (ids.length === 0) return out;
  const res = await c.xlayer.public.multicall({
    allowFailure: true,
    contracts: ids.map((id) => ({ address: ADDR.voucher, abi: voucherAbi, functionName: "ownerOf", args: [id] }) as const),
  });
  ids.forEach((id, i) => {
    const r = res[i];
    const v = r?.status === "success" ? r.result : null;
    out.set(id, typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && BigInt(v) !== 0n ? getAddress(v) : null);
  });
  return out;
}

/** Whether each rig's screen pass is suspended. */
export async function readSuspended(c: Clients, d: Deployment, ids: bigint[]): Promise<Map<bigint, boolean>> {
  const out = new Map<bigint, boolean>();
  if (ids.length === 0) return out;
  const res = await c.xlayer.public.multicall({
    allowFailure: true,
    contracts: ids.map((id) => ({ address: d.screen, abi: screenAbi, functionName: "passOf", args: [id] }) as const),
  });
  ids.forEach((id, i) => {
    const r = res[i];
    out.set(id, r?.status === "success" ? (r.result as unknown as [unknown, boolean])[1] : false);
  });
  return out;
}

/**
 * The voucher's record for `ids` on X Layer (`syncedAt` is the BSC send time of the newest harvest that
 * reached it). A failed or out-of-range read is left out: the evidence check waits for the next cycle.
 */
export async function readVoucherRecords(c: Clients, ids: bigint[]): Promise<Map<bigint, { syncedAt: number; power: bigint }>> {
  const out = new Map<bigint, { syncedAt: number; power: bigint }>();
  if (ids.length === 0) return out;
  const res = await c.xlayer.public.multicall({
    allowFailure: true,
    contracts: ids.map((id) => ({ address: ADDR.voucher, abi: voucherAbi, functionName: "rigs", args: [id] }) as const),
  });
  ids.forEach((id, i) => {
    const r = res[i];
    if (r?.status !== "success") return;
    const [, syncedAt, , power] = r.result as unknown as [string, bigint, bigint, bigint];
    if (syncedAt > BigInt(Number.MAX_SAFE_INTEGER)) return;
    out.set(id, { syncedAt: Number(syncedAt), power });
  });
  return out;
}
