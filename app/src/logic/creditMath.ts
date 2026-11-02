import type { TermIndex } from '../model';

/** Port of src/libraries/CreditMath.sol. B2 checks it against the forge-written parity vectors. */

export const BPS = 10_000n;
export const VERIF_EMISSION_PER_DAY = 712_800_000_000n; // 7,200 BEM/day x 99%, 8 decimals
export const BRIDGE_KEEP_BPS = 9_950n;
export const TERM_DAYS = [7, 14] as const;
export const DILUTION_BPS = [9_907n, 9_815n] as const;
export const MAX_DEBT_BPS = [8_500, 8_000] as const;
export const BUCKET_BPS = 500n;
export const MAX_BUCKET = 31;
const MAX_UINT256 = (1n << 256n) - 1n;

/** Expected BEM one rig mines over the term, after dilution and the bridge fee. Rounds down. */
export function expectedOutput(base: bigint, totalVerifWeight: bigint, term: TermIndex): bigint {
  if (totalVerifWeight === 0n) return 0n;
  const num = VERIF_EMISSION_PER_DAY * BigInt(TERM_DAYS[term]) * DILUTION_BPS[term] * BRIDGE_KEEP_BPS;
  return (base * num) / (totalVerifWeight * BPS * BPS);
}

/** Largest debt allowed for an expected output. Rounds down. */
export function maxDebt(expected: bigint, term: TermIndex): bigint {
  return (expected * BigInt(MAX_DEBT_BPS[term])) / BPS;
}

/** The 5% debt bucket, saturating at 31. Rounds up, toward deny. */
export function debtBucket(debt: bigint, expected: bigint): number {
  // the contract also saturates when `debt x BPS` would overflow 256 bits (never reached with real figures)
  if (expected === 0n || debt > MAX_UINT256 / BPS) return MAX_BUCKET;
  const debtBps = (debt * BPS + expected - 1n) / expected;
  const b = (debtBps + BUCKET_BPS - 1n) / BUCKET_BPS;
  return b > BigInt(MAX_BUCKET) ? MAX_BUCKET : Number(b);
}
