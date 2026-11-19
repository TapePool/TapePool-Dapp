// Harvest landing watch (SPEC-REDEPLOY-4 RB4-06). Receipt evidence is independent of the loan's lifetime.
import { decodeEventLog, type TransactionReceipt } from "viem";
import { vaultAbi } from "../abi.js";
import { ADDR } from "../addresses.js";
import type { Call } from "../tx.js";

export interface HarvestLanding { rigs: string[]; transaction: string; sentAt: number; alerted?: boolean }

/** Called before the sender removes the pending journal entry and checkpoints the state. */
export function recordHarvestReceipt(landings: Record<string, HarvestLanding>, call: Call, receipt: TransactionReceipt, sentAt: number): void {
  if (receipt.status !== "success" || call.address.toLowerCase() !== ADDR.rigVault.toLowerCase()) return;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ADDR.rigVault.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: vaultAbi, eventName: "Harvested", data: log.data, topics: log.topics });
      const { guid, ids } = event.args;
      landings[guid] ??= { rigs: ids.map(String), transaction: receipt.transactionHash, sentAt };
    } catch {
      // Other events and malformed logs are not harvest evidence.
    }
  }
}
