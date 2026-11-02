import type { TermIndex } from '../model';

/** Ports of TapePool.fee and TapeLens.principalFor. B2 checks them against the forge-written parity vectors. */

export interface FeeParams {
  feeBps: readonly [number, number];
  minFee: bigint;
}

const BPS = 10_000n;

/** Flat fee for `principal`: the term rate rounded up, at least `minFee`. */
export function fee(p: FeeParams, term: TermIndex, principal: bigint): bigint {
  const f = (principal * BigInt(p.feeBps[term]) + BPS - 1n) / BPS;
  return f > p.minFee ? f : p.minFee;
}

/** Largest principal whose principal + fee stays within `debtLimit`. */
export function principalFor(p: FeeParams, term: TermIndex, debtLimit: bigint): bigint {
  if (debtLimit <= p.minFee) return 0n;
  let x = debtLimit - p.minFee; // flat region: the minimum fee applies
  if (x + fee(p, term, x) <= debtLimit) return x;
  x = (debtLimit * BPS) / (BPS + BigInt(p.feeBps[term])); // rate region
  while (x !== 0n && x + fee(p, term, x) > debtLimit) x -= 1n;
  return x;
}
