// Two-cycle confirmation (SPEC-PHASE3-KEEPER §4.4): a condition counts only after it is seen in two
// consecutive cycles at different finalized BSC blocks. Pure.

export type RigCondition = "rescue" | "revoked" | "stopped" | "noBase" | "healthy";

export interface Observation {
  condition: RigCondition;
  block: bigint;
}

export interface ConfirmState {
  last: Map<string, Observation>;
}

export function initialConfirmState(): ConfirmState {
  return { last: new Map() };
}

/**
 * Record this cycle's reading for `rigId` and return the condition if it is now confirmed
 * (the same as the previous cycle's, at a later block), else null. `null` input = read error: the
 * previous observation is kept and nothing is confirmed this cycle.
 */
export function observe(
  state: ConfirmState,
  rigId: bigint,
  current: Observation | null,
): RigCondition | null {
  const key = rigId.toString();
  if (current === null) return null;
  const prev = state.last.get(key);
  state.last.set(key, current);
  if (prev === undefined) return null;
  return prev.condition === current.condition && current.block > prev.block ? current.condition : null;
}

/** Classify one rig from the BSC reads (SPEC §7.2 path (a)). */
export function classify(r: {
  vaultKnows: boolean;
  custodied: boolean;
  status: number;
  stopBlock: bigint;
  verifWeight: bigint;
  bonus: bigint;
}): RigCondition {
  if (!r.vaultKnows || !r.custodied) return "rescue";
  if (r.status !== 1) return "revoked";
  if (r.stopBlock !== 0n) return "stopped";
  if (r.verifWeight <= r.bonus) return "noBase";
  return "healthy";
}
