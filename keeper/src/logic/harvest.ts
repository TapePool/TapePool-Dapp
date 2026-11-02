// Harvest planning (SPEC-PHASE3-KEEPER §4.3, DERISK Q9 / T9). Pure.

export const DUST = 100n;
export const BOND = 10_000n; // 0.0001 BEM: fronted by the caller only when a batch harvests less
export const MAX_BATCH = 30;

export interface RigHarvestable {
  id: bigint;
  pending: bigint; // PodMining.pending(key)
  cellBalance: bigint; // BEM already claimed into the rig's escrow cell
}

export interface Batch {
  ids: bigint[];
  total: bigint; // what the vault will send, after rounding each rig down to DUST
  skip: boolean; // below BOND: harvesting would need a bond, so the keeper skips it
}

/** Split `rigs` into batches of at most `MAX_BATCH` ids, in id order, and mark the ones to skip. */
export function planBatches(rigs: RigHarvestable[], maxBatch = MAX_BATCH): Batch[] {
  const sorted = [...rigs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const batches: Batch[] = [];
  for (let i = 0; i < sorted.length; i += maxBatch) {
    const part = sorted.slice(i, i + maxBatch);
    let total = 0n;
    for (const r of part) {
      const amount = r.pending + r.cellBalance;
      total += amount - (amount % DUST);
    }
    batches.push({ ids: part.map((r) => r.id), total, skip: total < BOND });
  }
  return batches;
}
