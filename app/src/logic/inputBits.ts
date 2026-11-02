/**
 * `TapeLens.quote().inputBits` is the 12-bit circuit input. Bits 0 and 1 hold the term, bits 2 to 6 the debt bucket,
 * and `inputBits >> 7` holds the five flags (SPEC-PHASE5-APP §5.3).
 */
export const FLAG_NAMES = ['fresh', 'unimpaired', 'processor', 'age', 'screened'] as const;
export type FlagName = (typeof FLAG_NAMES)[number];

export function failedFlags(inputBits: number): FlagName[] {
  const flags = inputBits >> 7;
  return FLAG_NAMES.filter((_, i) => ((flags >> i) & 1) === 0);
}

/** The first flag that failed, or null when all five are set. */
export function firstFailedFlag(inputBits: number): FlagName | null {
  return failedFlags(inputBits)[0] ?? null;
}

export function debtBucketOf(inputBits: number): number {
  return (inputBits >> 2) & 0x1f;
}
