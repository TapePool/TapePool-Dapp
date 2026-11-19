// Duplicate circuit evidence (SPEC-REDEPLOY-4 RB4-07). Each scan belongs to one finalized BSC block.
import type { Address } from "viem";

export const DUPLICATE_CHUNK = 64;
export const DUPLICATE_STALL = 3_600;
export interface CircuitEntry { circuits: Address; circuitId: bigint }
export interface DuplicateScan { block: string; count: string; next: string; seen: Record<string, string[]> }
export interface DuplicatePair { ids: [string, string]; circuits: Address; circuitId: string; block: string; alerted?: boolean; sent: string[] }
export interface DuplicateWatch {
  startedAt?: number;
  completedAt?: number;
  completedBlock?: string;
  stalledAlerted?: boolean;
  scan?: DuplicateScan;
  pairs: Record<string, DuplicatePair>;
}

export const initialDuplicateWatch = (): DuplicateWatch => ({ pairs: {} });
export const uint256 = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n && v < 2n ** 256n;

/** Failed, short or malformed answers never become evidence. */
export function circuitEntry(value: unknown): CircuitEntry | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [circuits, circuitId] = value;
  if (typeof circuits !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(circuits) || !uint256(circuitId)) return null;
  return { circuits: circuits.toLowerCase() as Address, circuitId };
}

/** Remember a distinct vault id once. Empty entries and repeat observations of the same id are not duplicates. */
export function rememberCircuit(scan: DuplicateScan, pairs: DuplicateWatch["pairs"], id: bigint, entry: CircuitEntry): void {
  if (BigInt(entry.circuits) === 0n) return;
  const key = `${entry.circuits}:${entry.circuitId}`;
  const seen = scan.seen[key] ??= [];
  if (seen.includes(id.toString())) return;
  for (const other of seen) {
    const ids: [string, string] = BigInt(other) < id ? [other, id.toString()] : [id.toString(), other];
    pairs[ids.join(":")] ??= { ids, circuits: entry.circuits, circuitId: entry.circuitId.toString(), block: scan.block, sent: [] };
  }
  seen.push(id.toString());
}
