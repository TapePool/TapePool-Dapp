export const SYNC_THRESHOLD = 10_000n; // strictly above 0.0001 BEM (8 decimals)
export const SYNC_WAIT = 86_400;
export interface IncomeState { positiveSince?: number }

/** The age belongs to a positive unbooked balance, never to its amount or a previous send. */
export function syncDue(s: IncomeState, balance: bigint, tracked: bigint, now: number): boolean {
  const surplus = balance > tracked ? balance - tracked : 0n;
  if (surplus === 0n) { delete s.positiveSince; return false; }
  s.positiveSince ??= now;
  return surplus > SYNC_THRESHOLD || now - s.positiveSince >= SYNC_WAIT;
}
