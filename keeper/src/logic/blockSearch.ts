// Finding blocks by time (SPEC-PHASE5-APP §8.1). Pure: the caller supplies the block-timestamp read.

/**
 * The smallest block `n` in [lo, hi] whose timestamp is at least `target`, by binary search (about
 * log2(hi - lo) reads). Block timestamps never go down, and the caller has checked that block `hi`
 * itself reaches `target`.
 */
export async function firstBlockAtOrAfter(
  timestampOf: (block: bigint) => Promise<number>,
  lo: bigint,
  hi: bigint,
  target: number,
): Promise<bigint> {
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    if ((await timestampOf(mid)) >= target) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}
