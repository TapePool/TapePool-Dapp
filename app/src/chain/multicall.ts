import { decodeFunctionResult, encodeFunctionData, type Abi } from 'viem';
import type { Address, Hex } from '../model';
import { multicall3Abi } from './abi';
import type { Reader } from './reader';

/**
 * Batching through Multicall3 (SPEC-PHASE5-APP §5). The batching is done here rather than by viem's `multicall`
 * action because its default chunk is 1 KB of calldata, which silently turns one round into several `eth_call`s,
 * and because the quotes need a state override on the very call that batches them.
 */

/** One read. `T` is what its decoded result is; the type is a promise by the caller, tested against the ABI. */
export interface Call<T = unknown> {
  readonly to: Address;
  readonly abi: Abi;
  readonly fn: string;
  readonly args: readonly unknown[];
  readonly _t?: T;
}

export function call<T>(to: Address, abi: unknown, fn: string, args: readonly unknown[] = []): Call<T> {
  return { to, abi: abi as Abi, fn, args };
}

export type Result<T> = { ok: true; value: T } | { ok: false };

/** Calls per `eth_call`. 120 inner reads stay far under any node's gas cap for the contracts read here. */
export const CHUNK = 120;

export interface MulticallOptions {
  block?: bigint;
  /** Runtime code placed at an address for this one batch (the TapeLens quotes). */
  code?: Record<string, Hex>;
  chunk?: number;
}

type Results<C extends readonly Call[]> = { [K in keyof C]: C[K] extends Call<infer U> ? Result<U> : never };

/**
 * Run `calls` as `aggregate3` with `allowFailure`: one request per `chunk` calls. A read that reverts, or whose
 * answer does not decode, is `{ ok: false }`; a node that is down rejects the whole promise.
 */
export async function multicall<const C extends readonly Call[]>(reader: Reader, mc: Address, calls: C, o: MulticallOptions = {}): Promise<Results<C>> {
  const out: Result<unknown>[] = [];
  const size = o.chunk ?? CHUNK;
  for (let i = 0; i < calls.length; i += size) {
    const slice = calls.slice(i, i + size);
    const data = encodeFunctionData({
      abi: multicall3Abi,
      functionName: 'aggregate3',
      args: [slice.map((c) => ({ target: c.to, allowFailure: true, callData: encodeFunctionData({ abi: c.abi, functionName: c.fn, args: c.args as never }) }))],
    });
    const raw = await reader.call(mc, data, { block: o.block, code: o.code });
    const rows = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: raw }) as readonly { success: boolean; returnData: Hex }[];
    if (rows.length !== slice.length) throw new Error('multicall: wrong number of answers');
    slice.forEach((c, k) => {
      const row = rows[k];
      if (!row?.success) return void out.push({ ok: false });
      try {
        out.push({ ok: true, value: decodeFunctionResult({ abi: c.abi, functionName: c.fn, data: row.returnData }) });
      } catch {
        out.push({ ok: false });
      }
    });
  }
  return out as unknown as Results<C>;
}

/** The value of a result, or the fallback when the read failed. */
export const val = <T, F = undefined>(r: Result<T>, fallback?: F): T | F => (r.ok ? r.value : (fallback as F));
