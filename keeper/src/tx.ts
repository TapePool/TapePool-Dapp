// Transaction sending (SPEC-PHASE3-KEEPER §6): simulate first, one transaction in flight per chain,
// gas-price caps (10x for guardian actions and seize), replace-by-fee for stuck transactions, and dry
// mode that never broadcasts.
import { BaseError, ContractFunctionRevertedError, HttpRequestError, TimeoutError, decodeFunctionData, encodeFunctionData, keccak256, type TransactionReceipt, type Abi, type Address, type Hex } from "viem";
import { reporterAbi } from "./abi.js";
import type { ChainClients } from "./chains.js";
import type { Mode } from "./config.js";
import { log } from "./log.js";

export type Urgency = "routine" | "urgent";

export interface Call {
  label: string; // for logs and alerts, e.g. "harvest [1,5,16]"
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  urgency: Urgency;
}

export type SendResult =
  | { status: "sent"; hash: Hex }
  | { status: "dry" }
  | { status: "reverted"; reason: string }
  | { status: "waiting"; reason: string };

interface Pending {
  call: Call;
  hash: Hex;
  nonce: number;
  gasPrice: bigint;
  sentAt: number;
  createdAt: number;
  noncePassedAt?: number;
  ageAlerted?: boolean;
  capAlerted?: boolean;
  data?: Hex;
  raw?: Hex;
  hashes: Hex[];
}

export interface PendingTx {
  label: string; address: Address; data: Hex; value: string; urgency: Urgency;
  hash: Hex; hashes: Hex[]; nonce: number; gasPrice: string; sentAt: number;
  createdAt?: number; noncePassedAt?: number; ageAlerted?: boolean; capAlerted?: boolean; raw?: Hex;
}

export interface SenderOptions {
  mode: Mode;
  capWei: bigint; // routine cap
  stuckAfterSec: number; // 180 on BSC, 60 on X Layer
  alert: (text: string) => void;
  now?: () => number;
  journal?: PendingTx[];
  persist?: () => void;
  mined?: (call: Call, receipt: TransactionReceipt) => void;
}

/** Short revert reason (custom error name when the ABI knows it). */
/** True when `err` is the RPC failing (HTTP error, timeout), not the contract reverting. */
export function isTransportError(err: unknown): boolean {
  return err instanceof BaseError && err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError) !== null;
}

export function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? r.shortMessage;
    return err.shortMessage;
  }
  return String(err);
}

export class Sender {
  /** Transactions in flight, oldest first. At most one routine one, any number of urgent ones. */
  private pending: Pending[] = [];
  private readonly now: () => number;
  private tail: Promise<unknown> = Promise.resolve();

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => {});
    return result;
  }

  constructor(
    private readonly chain: ChainClients,
    private readonly opt: SenderOptions,
  ) {
    this.now = opt.now ?? (() => Math.floor(Date.now() / 1000));
    this.pending = (opt.journal ?? []).map((p) => ({ call: { label: p.label, address: p.address, abi: [], functionName: "", value: BigInt(p.value), urgency: p.urgency }, data: p.data, raw: p.raw, hash: p.hash, hashes: p.hashes ?? [p.hash], nonce: p.nonce, gasPrice: BigInt(p.gasPrice), sentAt: p.sentAt, createdAt: p.createdAt ?? p.sentAt, noncePassedAt: p.noncePassedAt, ageAlerted: p.ageAlerted, capAlerted: p.capAlerted }));
  }

  private checkpoint(): void {
    if (!this.opt.journal) return;
    this.opt.journal.splice(0, this.opt.journal.length, ...this.pending.map((p) => ({ label: p.call.label, address: p.call.address, data: p.data ?? encodeFunctionData({ abi: p.call.abi, functionName: p.call.functionName, args: p.call.args }), value: (p.call.value ?? 0n).toString(), urgency: p.call.urgency, raw: p.raw, hash: p.hash, hashes: [...p.hashes], nonce: p.nonce, gasPrice: p.gasPrice.toString(), sentAt: p.sentAt, createdAt: p.createdAt, noncePassedAt: p.noncePassedAt, ageAlerted: p.ageAlerted, capAlerted: p.capAlerted })));
    this.opt.persist?.();
  }

  get busy(): boolean {
    return this.pending.length > 0;
  }

  /** True while a transaction with this label is in flight. */
  hasPending(label: string): boolean {
    return this.pending.some((p) => p.call.label === label);
  }

  pendingPushes(reporter: Address): { ids: bigint[]; at: number }[] {
    return this.pending.flatMap((p) => {
      if (p.call.address.toLowerCase() !== reporter.toLowerCase()) return [];
      try {
        const data = p.data ?? encodeFunctionData({ abi: p.call.abi, functionName: p.call.functionName, args: p.call.args });
        const decoded = decodeFunctionData({ abi: reporterAbi, data });
        return decoded.functionName === "push" ? [{ ids: [...decoded.args[0]], at: p.createdAt }] : [];
      } catch { return []; }
    });
  }

  private cap(u: Urgency): bigint {
    return u === "urgent" ? this.opt.capWei * 10n : this.opt.capWei;
  }

  /** Simulate `call`; true when it would succeed. */
  async simulate(call: Call): Promise<{ ok: true; request: unknown } | { ok: false; reason: string; transport: boolean }> {
    try {
      const { request } = await this.chain.public.simulateContract({
        account: this.chain.wallet.account,
        address: call.address,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
        value: call.value,
      } as never);
      return { ok: true, request };
    } catch (e) {
      return { ok: false, reason: revertReason(e), transport: isTransportError(e) };
    }
  }

  /**
   * Simulate, then send unless in dry mode. A routine call waits while anything is in flight. An urgent
   * call always takes the next nonce, so two guardian brakes in a row both land; a routine transaction
   * in flight is kept, and re-priced to at least the market (up to the urgent cap) when it would hold
   * the urgent one back. A passed nonce without a readable receipt gets a bounded grace period.
   */
  send(call: Call): Promise<SendResult> {
    return this.serialized(() => this.sendNow(call));
  }

  private async sendNow(call: Call): Promise<SendResult> {
    const sim = await this.simulate(call);
    if (!sim.ok && sim.transport) {
      log("warn", "simulation failed on the RPC, not sent", { chain: this.chain.name, call: call.label, reason: sim.reason });
      return { status: "waiting", reason: `simulation failed: ${sim.reason}` };
    }
    if (!sim.ok) {
      log("info", "simulation reverted, not sent", { chain: this.chain.name, call: call.label, reason: sim.reason });
      return { status: "reverted", reason: sim.reason };
    }
    if (this.opt.mode === "dry") {
      log("info", "dry mode: would send", { chain: this.chain.name, call: call.label });
      return { status: "dry" };
    }
    await this.pollNow(); // drop what is already mined before deciding
    if (this.pending.length > 0 && call.urgency === "routine") return { status: "waiting", reason: "transaction in flight" };

    const market = await this.chain.public.getGasPrice();
    const cap = this.cap(call.urgency);
    let gasPrice = market;
    const routine = this.pending.find((p) => p.call.urgency === "routine");
    if (routine && routine.gasPrice < market) await this.reprice(routine, market);
    // never reuse a nonce in flight, even if this node's pending count has not seen it (round-2 N2)
    const counted = await this.chain.public.getTransactionCount({ address: this.chain.wallet.account.address, blockTag: "pending" });
    const nonce = this.pending.reduce((n, p) => (p.nonce + 1 > n ? p.nonce + 1 : n), counted);
    if (gasPrice > cap) {
      if (call.urgency === "urgent") gasPrice = cap;
      else {
        this.opt.alert(`${this.chain.name}: gas price ${market} above the cap, ${call.label} waits`);
        return { status: "waiting", reason: "gas price above the cap" };
      }
    }
    try {
      const signed = await this.sign(call, nonce, gasPrice);
      const at = this.now();
      this.pending.push({ call, hash: signed.hash, hashes: [signed.hash], data: signed.data, raw: signed.raw, nonce, gasPrice, sentAt: at, createdAt: at });
      this.checkpoint(); // durable hash before the first byte reaches the RPC
      await this.broadcast(signed.raw, signed.hash, call);
      log("info", "sent", { chain: this.chain.name, call: call.label, hash: signed.hash, nonce, gasPrice });
      return { status: "sent", hash: signed.hash };
    } catch (e) {
      const reason = revertReason(e);
      log("error", "send failed", { chain: this.chain.name, call: call.label, reason });
      return { status: "waiting", reason: `send failed: ${reason}` };
    }
  }

  /** Re-send a routine transaction at its own nonce for at least `market` (+25%, up to the urgent cap). */
  private async reprice(p: Pending, market: bigint): Promise<void> {
    const bumped = (p.gasPrice * 125n) / 100n;
    const cap = this.cap("urgent");
    let price = bumped > market ? bumped : market;
    if (price > cap) price = cap;
    if (price <= p.gasPrice) return;
    try {
      await this.replace(p, price);
      log("warn", "re-priced a routine transaction ahead of an urgent one", { chain: this.chain.name, call: p.call.label, hash: p.hash, gasPrice: price });
    } catch (e) {
      // already mined, or the node refused the replacement: the urgent call still takes the next nonce
      log("warn", "re-pricing failed", { chain: this.chain.name, call: p.call.label, reason: revertReason(e) });
    }
  }

  private async sign(call: Call, nonce: number, gasPrice: bigint, data?: Hex) {
    const account = this.chain.wallet.account;
    if (!account.signTransaction) throw new Error("keeper requires a local signing account");
    data ??= encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args });
    const request = { to: call.address, data, value: call.value ?? 0n, nonce, gasPrice, type: "legacy" as const };
    const gas = await this.chain.public.estimateGas({ ...request, account: account.address });
    const raw = await account.signTransaction({ ...request, gas, chainId: this.chain.wallet.chain.id });
    return { raw, hash: keccak256(raw), data };
  }

  private async broadcast(raw: Hex, hash: Hex, call: Call): Promise<void> {
    try {
      await this.chain.wallet.sendRawTransaction({ serializedTransaction: raw });
    } catch (e) {
      // Acceptance is unknown. Keep the locally computed hash and report this attempt as sent so
      // callers also retain their push/refresh limits; receipts and replacement handle recovery.
      log("warn", "broadcast response unavailable; tracking signed hash", { chain: this.chain.name, call: call.label, hash, reason: revertReason(e) });
    }
  }

  private async replace(p: Pending, price: bigint): Promise<void> {
    const signed = await this.sign(p.call, p.nonce, price, p.data);
    p.hash = signed.hash;
    if (!p.hashes.includes(signed.hash)) p.hashes.push(signed.hash);
    p.data = signed.data;
    p.raw = signed.raw;
    p.gasPrice = price;
    p.sentAt = this.now();
    this.checkpoint(); // replacements have exactly the same write-before-broadcast ordering
    await this.broadcast(signed.raw, signed.hash, p.call);
  }

  /** Re-broadcast identical bytes; older journals need one signature at their recorded price first. */
  private async rebroadcast(p: Pending): Promise<void> {
    if (!p.raw) return this.replace(p, p.gasPrice);
    p.sentAt = this.now();
    this.checkpoint(); // keep write-before-broadcast ordering even when the hash is unchanged
    await this.broadcast(p.raw, p.hash, p.call);
  }

  /** Check the transactions in flight: clear mined ones, replace stuck ones, re-broadcast at the cap. */
  poll(): Promise<void> {
    return this.serialized(() => this.pollNow());
  }

  private async pollNow(): Promise<void> {
    if (this.pending.length === 0) return;
    const nonceNow = await this.chain.public.getTransactionCount({ address: this.chain.wallet.account.address });
    for (const p of [...this.pending]) {
      let receipt: TransactionReceipt | null = null;
      for (const hash of [...p.hashes].reverse()) {
        receipt = await this.chain.public.getTransactionReceipt({ hash }).catch(() => null);
        if (receipt) break;
      }
      if (receipt) {
        this.opt.mined?.(p.call, receipt);
        if (receipt.status !== "success") this.opt.alert(`${this.chain.name}: ${p.call.label} reverted on chain (${receipt.transactionHash})`);
        this.pending = this.pending.filter((q) => q !== p);
        this.checkpoint();
        continue;
      }
      if (!p.ageAlerted && this.now() - p.createdAt >= 3600) {
        p.ageAlerted = true;
        this.checkpoint();
        this.opt.alert(`${this.chain.name}: ${p.call.label} pending for over one hour (nonce ${p.nonce})`);
      }
      if (nonceNow > p.nonce) {
        p.noncePassedAt ??= this.now();
        if (this.now() - p.noncePassedAt >= this.opt.stuckAfterSec) {
          this.pending = this.pending.filter((q) => q !== p);
          this.checkpoint();
          this.opt.alert(`${this.chain.name}: ${p.call.label} dropped after nonce passed without a receipt (nonce ${p.nonce}); spend not recorded`);
        }
        continue;
      }
      delete p.noncePassedAt;
      if (this.opt.mode === "dry") continue;
      if (this.now() - p.sentAt < this.opt.stuckAfterSec) continue;
      // a routine transaction that an urgent one waits behind may go up to the urgent cap (round-2 N1)
      const blocking = this.pending.some((q) => q.nonce > p.nonce && q.call.urgency === "urgent");
      const cap = this.cap(blocking ? "urgent" : p.call.urgency);
      if (p.gasPrice >= cap) {
        if (!p.capAlerted) {
          p.capAlerted = true;
          this.opt.alert(`${this.chain.name}: ${p.call.label} stuck at the gas cap (nonce ${p.nonce})`);
        }
        try {
          await this.rebroadcast(p);
          log("warn", "re-broadcast a stuck transaction at the gas cap", { chain: this.chain.name, call: p.call.label, hash: p.hash, gasPrice: p.gasPrice });
        } catch (e) {
          log("error", "re-broadcast failed", { chain: this.chain.name, call: p.call.label, reason: revertReason(e) });
        }
        continue;
      }
      const next = (p.gasPrice * 125n) / 100n;
      const price = next > cap ? cap : next;
      try {
        await this.replace(p, price);
        log("warn", "replaced a stuck transaction", { chain: this.chain.name, call: p.call.label, hash: p.hash, gasPrice: price });
      } catch (e) {
        log("error", "replacement failed", { chain: this.chain.name, call: p.call.label, reason: revertReason(e) });
      }
    }
    this.checkpoint();
  }
}
