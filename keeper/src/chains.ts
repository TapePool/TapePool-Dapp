// viem clients for both chains. One signer (the keeper / guardian key) on both.
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ADDR, CHAIN } from "./addresses.js";
import type { Config } from "./config.js";

export const bscChain = defineChain({
  id: CHAIN.bsc.id,
  name: "BNB Smart Chain",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: { default: { http: [] } },
  contracts: { multicall3: { address: ADDR.multicall3 } },
});

export const xlayerChain = defineChain({
  id: CHAIN.xlayer.id,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.xlayer.tech"] } },
  contracts: { multicall3: { address: ADDR.multicall3 } },
});

export interface ChainClients {
  name: "bsc" | "xlayer";
  public: PublicClient<Transport, Chain>;
  wallet: WalletClient<Transport, Chain, Account>;
}

export interface Clients {
  account: Account;
  bsc: ChainClients;
  xlayer: ChainClients;
}

/**
 * Reads over one URL retry it twice; over several, viem's fallback tries each once, in order (no
 * ranking, no inner retries: at most one pass of 20 s per URL), and never falls through on a contract
 * revert (part E §3.2).
 */
export function readTransport(urls: string[]): Transport {
  if (urls.length > 1) return fallback(urls.map((u) => http(u, { timeout: 20_000 })), { rank: false, retryCount: 0 });
  return http(urls[0], { retryCount: 2, timeout: 20_000 });
}

export function makeClients(cfg: Pick<Config, "privateKey" | "bscRpc" | "xlayerRpc"> & { xlayerRpcs?: string[] }): Clients {
  const account = privateKeyToAccount(cfg.privateKey);
  // writes go through the first URL only: a raw transaction retried elsewhere could be broadcast twice
  const mk = (name: "bsc" | "xlayer", chain: Chain, urls: string[]): ChainClients => ({
    name,
    public: createPublicClient({ chain, transport: readTransport(urls) }),
    wallet: createWalletClient({ account, chain, transport: http(urls[0], { retryCount: 0, timeout: 20_000 }) }),
  });
  return {
    account,
    bsc: mk("bsc", bscChain, [cfg.bscRpc]),
    xlayer: mk("xlayer", xlayerChain, cfg.xlayerRpcs && cfg.xlayerRpcs.length > 0 ? cfg.xlayerRpcs : [cfg.xlayerRpc]),
  };
}
