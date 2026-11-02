import { decodeErrorResult, toFunctionSelector, type Abi } from 'viem';
import { bemTrim, native } from '../logic/format';
import type { Hex } from '../model';
import { agentFactoryAbi, bscBemAbi, bscVaultAbi, extraErrorsAbi, reporterAbi, rigAgentAbi, tapePoolAbi } from './abi';
import { POLICY_DENIED, type AppError, type MsgParams } from './errors';

/**
 * Turning what a failed call or a wallet answers into one of the messages of SPEC-PHASE5-APP §9.
 *
 * A revert is decoded against the union of the errors of RigAgent, TapePool (which carries the ERC-20 and ERC-4626
 * errors of BEM and the share), AgentFactory, RigReporter and the hand-written list (the voucher's ERC-721 errors and
 * the LayerZero endpoint's fee error). Errors bubble up through calls, so one union covers every transaction.
 */

type ErrorItem = { type: 'error'; name: string; inputs: readonly { name?: string; type: string }[] };

const signatureOf = (e: ErrorItem): string => `${e.name}(${e.inputs.map((i) => i.type).join(',')})`;

function union(...abis: readonly (readonly unknown[])[]): Abi {
  const seen = new Set<string>();
  const out: ErrorItem[] = [];
  for (const abi of abis) {
    for (const item of abi as readonly { type: string }[]) {
      if (item.type !== 'error') continue;
      const e = item as ErrorItem;
      const sel = toFunctionSelector(signatureOf(e));
      if (seen.has(sel)) continue;
      seen.add(sel);
      out.push(e);
    }
  }
  return out as unknown as Abi;
}

export const revertAbi: Abi = union(rigAgentAbi, tapePoolAbi, agentFactoryAbi, reporterAbi, extraErrorsAbi, bscVaultAbi, bscBemAbi);

/** What the messages of a revert may need. */
export interface RevertCtx {
  /** `pool.minAdvance()` in raw BEM. */
  minAdvance?: bigint;
  terms?: readonly [number, number];
  /** The credit rule's input bits from the last quote, to name the failed flag of a `PolicyDenied(DENIED)`. */
  inputBits?: number;
  /** The date of a queued credit rule, already formatted. */
  eta?: string;
  /** The action the revert belongs to, when its names mean something else there (see `decodeRevert`). */
  action?: 'harvest';
}

const isHex = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v);

/**
 * The revert data inside an error from a node or a wallet. Nodes and wallets nest it differently (`data`,
 * `data.data`, `error.data`, `cause.data`), so this walks a few levels and takes the first hex string that is at
 * least a selector long.
 */
export function revertDataOf(e: unknown, depth = 0): Hex | null {
  if (depth > 4 || e === null || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  for (const key of ['data', 'error', 'cause', 'originalError']) {
    const v = o[key];
    if (isHex(v) && v.length >= 10) return v;
    const nested = revertDataOf(v, depth + 1);
    if (nested) return nested;
  }
  return null;
}

export const codeOf = (e: unknown): number | null => (typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'number' ? (e as { code: number }).code : null);

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) : String(e));

/** The `AppError` for decoded revert data; anything the union does not know is an unknown error with the raw data as its details. */
export function decodeRevert(data: Hex, ctx: RevertCtx = {}): AppError {
  let name: string;
  let args: readonly unknown[] = [];
  try {
    const d = decodeErrorResult({ abi: revertAbi, data });
    name = d.errorName;
    args = (d.args ?? []) as readonly unknown[];
  } catch {
    return { kind: 'unknown', details: `Unrecognised revert: ${data.slice(0, 200)}` };
  }
  if (ctx.action === 'harvest') return harvestRevert(name, args);
  const params: MsgParams = {};
  if (ctx.minAdvance !== undefined) params.minAdvance = bemTrim(ctx.minAdvance);
  if (ctx.terms) params.terms = ctx.terms;
  if (ctx.eta) params.eta = ctx.eta;
  if (name === 'WrongOpsFee') params.expectedFee = native(args[0] as bigint);
  if (name === 'NotOwned' || name === 'AlreadyCollateral' || name === 'SeizedVoucher') params.id = Number(args[0]);
  if (name === POLICY_DENIED) {
    if (ctx.inputBits !== undefined) params.inputBits = ctx.inputBits;
    return { kind: 'revert', name, reason: Number(args[0]), params };
  }
  // `Error(string)` and `Panic(uint256)` are not ours: show them as details, not as a made-up message
  if (name === 'Error' || name === 'Panic') return { kind: 'unknown', details: `${name}: ${String(args[0] ?? '')}`.slice(0, 300) };
  return { kind: 'revert', name, params };
}

/**
 * What a revert of `RigVault.harvest` means (SPEC-PHASE5-PRELOAN §7, "Revert mapping"). Names are mapped per action, not by
 * selector alone: `BadBatch()` is the same selector in RigReporter and RigVault, and in a harvest it says the vault knows none
 * of the rigs. The bond is pulled with `safeTransferFrom` from the caller, so a caller without the BEM or the allowance reverts
 * with an ERC-20 error, a failed SafeERC20 call or a bare failed call, and a token that reverts with a string with that string.
 * All of those are the sub-bond case, which the app decides from its own re-read and never from a revert; it never shows
 * "Approve again" here. The LayerZero fee error keeps its message; anything else is the generic one, with the name as details.
 */
function harvestRevert(name: string, args: readonly unknown[]): AppError {
  if (name === 'BadBatch') return { kind: 'harvest', why: 'unknown-rig' };
  if (BOND_PULL.has(name) || (name === 'Error' && /allowance|balance|erc20/i.test(String(args[0] ?? '')))) return { kind: 'harvest', why: 'sub-bond' };
  if (name === 'LZ_InsufficientFee') return { kind: 'revert', name };
  return { kind: 'unknown', details: `Reverted: ${name}${name === 'Error' || name === 'Panic' ? ` ${String(args[0] ?? '')}` : ''}`.slice(0, 300) };
}

const BOND_PULL: ReadonlySet<string> = new Set(['ERC20InsufficientBalance', 'ERC20InsufficientAllowance', 'SafeERC20FailedOperation', 'FailedCall', 'FailedInnerCall']);

/**
 * Whatever a wallet or a node threw when a call or a transaction failed. A rejected prompt (code 4001) is the
 * user's choice, not a failure; a revert is decoded; anything else is unknown, with the message as its details.
 */
export function fromFailure(e: unknown, ctx: RevertCtx = {}): AppError {
  if (codeOf(e) === 4001) return { kind: 'wallet-rejected' };
  const data = revertDataOf(e);
  if (data) return decodeRevert(data, ctx);
  return { kind: 'unknown', details: messageOf(e).slice(0, 300) };
}
