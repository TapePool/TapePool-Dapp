import { decodeEventLog, parseEther, type TransactionReceipt } from "viem";
import { reporterAbi } from "../abi.js";
import type { Call } from "../tx.js";

export const STARTUP_DAILY_SPEND = parseEther("0.0068");
export const BEM_FLOAT = 100_000n; // 0.001 BEM, refundable bonds, never BNB spend
export interface Spend { at: number; amount: string }

/** Actual gas, including reverts. Pushes use Pushed.nativeFee; harvest value bounds the fee before refunds. */
export function bnbSpent(call: Call, receipt: TransactionReceipt): bigint | null {
  if (!/push|harvest/.test(call.label)) return null;
  let fee = receipt.status === "success" ? call.value ?? 0n : 0n;
  if (receipt.status === "success" && call.label.startsWith("push")) {
    for (const entry of receipt.logs) {
      if (entry.address.toLowerCase() !== call.address.toLowerCase()) continue;
      try { fee = decodeEventLog({ abi: reporterAbi, eventName: "Pushed", data: entry.data, topics: entry.topics }).args.fee; }
      catch { /* unrelated log */ }
    }
  }
  return receipt.gasUsed * receipt.effectiveGasPrice + fee;
}

/** Startup estimate for the first day; thereafter always divide trailing seven-day spend by seven. */
export function dailySpend(spend: Spend[], startedAt: number, now: number): bigint {
  const elapsed = Math.min(7 * 86_400, Math.max(0, now - startedAt));
  if (elapsed < 86_400) return STARTUP_DAILY_SPEND;
  const sum = spend.filter((s) => s.at > now - 7 * 86_400 && s.at <= now).reduce((v, s) => v + BigInt(s.amount), 0n);
  return (sum + 6n) / 7n;
}
