// Read-only chain access pinned to one block (SPEC-PHASE3-SCREEN §3). Raw JSON-RPC, one request at a
// time, so a revert's data is seen exactly as the node returns it. Nothing here signs or sends.
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  keccak256,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { multicallAbi } from "./abi.js";
import { ADDR, BATCH } from "./constants.js";

/** An `eth_call` outcome: `ok` false is a revert, and `data` is its revert data ("0x" if none). */
export interface CallResult {
  ok: boolean;
  data: Hex;
}

/** Everything the checks read, at one pinned block. */
export interface ChainView {
  readonly chainId: number;
  readonly block: bigint;
  readonly blockHash: Hex;
  call(to: Address, data: Hex, gas?: bigint): Promise<CallResult>;
  storage(address: Address, slot: Hex): Promise<Hex>;
  codeHash(address: Address): Promise<Hex>;
  /** Several calls in one request (Multicall3 `aggregate3`, failures allowed); same order as `calls`. */
  batch(calls: { to: Address; data: Hex }[]): Promise<CallResult[]>;
}

/** A transport failure (not a revert). Its message never contains the RPC URL. */
export class RpcError extends Error {}

interface RpcErrorBody {
  code?: number;
  message?: string;
  data?: unknown;
}

const RETRIES = 3;
const TIMEOUT_MS = 60_000;

/** Minimal JSON-RPC client: serial, retried, revert-aware. */
export class Rpc {
  private queue: Promise<unknown> = Promise.resolve();
  private id = 0;

  constructor(
    private readonly url: string,
    private readonly label: string,
  ) {}

  /** Run `method` after every earlier request has finished (FINDINGS F25). */
  request<T>(method: string, params: unknown[]): Promise<T> {
    const run = this.queue.then(() => this.withRetries<T>(method, params));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async withRetries<T>(method: string, params: unknown[]): Promise<T> {
    let last = "";
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1_000 * 2 ** (attempt - 1)));
      try {
        return await this.once<T>(method, params);
      } catch (e) {
        if (e instanceof RevertError) throw e; // a revert is an answer, not a failure
        last = e instanceof Error ? e.message : String(e);
      }
    }
    throw new RpcError(`${this.label} ${method} failed after ${RETRIES} attempts: ${last}`);
  }

  private async once<T>(method: string, params: unknown[]): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      // fetch errors can echo the URL (an API key): keep only the error's name
      throw new Error(`network error (${e instanceof Error ? e.name : "unknown"})`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: RpcErrorBody };
    if (body.error) {
      const msg = String(body.error.message ?? "");
      const data = typeof body.error.data === "string" && /^0x[0-9a-fA-F]*$/.test(body.error.data) ? (body.error.data as Hex) : null;
      if (body.error.code === 3 || /execution reverted/i.test(msg)) throw new RevertError(data ?? "0x");
      throw new Error(`RPC error ${body.error.code ?? "?"}: ${msg.slice(0, 120)}`);
    }
    if (body.result === undefined) throw new Error("RPC answer without result");
    return body.result;
  }
}

/** A node's revert answer to `eth_call`. */
export class RevertError extends Error {
  constructor(readonly data: Hex) {
    super(`reverted ${data.slice(0, 10)}`);
  }
}

const toQuantity = (n: bigint): Hex => `0x${n.toString(16)}`;

/** `ChainView` over a JSON-RPC endpoint at a pinned block. */
export class RpcView implements ChainView {
  private constructor(
    private readonly rpc: Rpc,
    readonly chainId: number,
    readonly block: bigint,
    readonly blockHash: Hex,
  ) {}

  /**
   * Pin `block` (a number, or "finalized" / "latest") on the endpoint and check its chain id.
   * `label` names the chain in errors, so the URL is never printed.
   */
  static async open(url: string, label: string, expectChainId: number, block: bigint | "finalized" | "latest"): Promise<RpcView> {
    const rpc = new Rpc(url, label);
    const chainId = Number(await rpc.request<Hex>("eth_chainId", []));
    if (chainId !== expectChainId) throw new RpcError(`${label}: chain id ${chainId}, expected ${expectChainId}`);
    const tag = typeof block === "bigint" ? toQuantity(block) : block;
    const b = await rpc.request<{ number: Hex; hash: Hex } | null>("eth_getBlockByNumber", [tag, false]);
    if (!b) throw new RpcError(`${label}: block ${String(block)} not found`);
    return new RpcView(rpc, chainId, BigInt(b.number), b.hash);
  }

  async call(to: Address, data: Hex, gas?: bigint): Promise<CallResult> {
    const tx: Record<string, string> = { to, data };
    if (gas !== undefined) tx.gas = toQuantity(gas);
    try {
      const out = await this.rpc.request<Hex>("eth_call", [tx, toQuantity(this.block)]);
      return { ok: true, data: out };
    } catch (e) {
      if (e instanceof RevertError) return { ok: false, data: e.data };
      throw e;
    }
  }

  storage(address: Address, slot: Hex): Promise<Hex> {
    return this.rpc.request<Hex>("eth_getStorageAt", [address, slot, toQuantity(this.block)]);
  }

  async codeHash(address: Address): Promise<Hex> {
    const code = await this.rpc.request<Hex>("eth_getCode", [address, toQuantity(this.block)]);
    return keccak256(code);
  }

  batch(calls: { to: Address; data: Hex }[]): Promise<CallResult[]> {
    return batchViaMulticall(this, calls);
  }
}

/** Split `calls` into Multicall3 `aggregate3` requests of at most BATCH calls. */
export async function batchViaMulticall(view: ChainView, calls: { to: Address; data: Hex }[]): Promise<CallResult[]> {
  const out: CallResult[] = [];
  for (let i = 0; i < calls.length; i += BATCH) {
    const chunk = calls.slice(i, i + BATCH);
    const data = encodeFunctionData({
      abi: multicallAbi,
      functionName: "aggregate3",
      args: [chunk.map((c) => ({ target: c.to, allowFailure: true, callData: c.data }))],
    });
    const r = await view.call(ADDR.multicall3, data);
    if (!r.ok) throw new RpcError(`multicall reverted (${r.data.slice(0, 10)})`);
    const results = decodeFunctionResult({ abi: multicallAbi, functionName: "aggregate3", data: r.data });
    if (results.length !== chunk.length) throw new RpcError("multicall returned a wrong number of results");
    for (const x of results) out.push({ ok: x.success, data: x.returnData });
  }
  return out;
}

/** Call a view function and decode it; a revert or a bad answer throws (the check fails closed). */
export async function read<const A extends Abi>(
  view: ChainView,
  to: Address,
  abi: A,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<unknown> {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const r = await view.call(to, data);
  if (!r.ok) throw new RpcError(`${functionName} reverted (${r.data.slice(0, 10)}) on ${to}`);
  try {
    return decodeFunctionResult({ abi, functionName, data: r.data } as never);
  } catch {
    throw new Error(`undecodable answer to ${functionName} on ${to} (${r.data.length > 2 ? "malformed" : "empty, no code there?"})`);
  }
}

/** The address held in a storage word (right-aligned), or null if the word is not an address. */
export function wordToAddress(word: Hex): Address | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(word)) return null;
  if (!/^0x0{24}/.test(word)) return null;
  return getAddress(`0x${word.slice(26)}`);
}

/** Decode calldata against `abi` (used by the test fake and the CLI summary). */
export function decodeCall(abi: Abi, data: Hex) {
  return decodeFunctionData({ abi, data });
}
