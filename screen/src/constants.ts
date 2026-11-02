// Addresses and reviewed constants (SPEC-PHASE3-SCREEN §4.1). The tool refuses to judge when the chain
// differs from a reviewed value: a new value needs a human review of the upgrade first (§6).
import type { Address, Hex } from "viem";

export const BSC_CHAIN_ID = 56;
export const XLAYER_CHAIN_ID = 196;

export const ADDR = {
  podMining: "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46",
  rigVault: "0x48D43345656f0f9510dC3c06CBa99dFf597617C2",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  voucher: "0x9cfc959cd42B2e1d39a0d850c528210E818AE520", // X Layer
} as const satisfies Record<string, Address>;

/** The PoD-mineable BSC processors (SPEC §7.2). Rigs and REF targets must be on one of them. */
export const PROCESSORS = {
  TapeOut: "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C",
  Behemoth: "0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C",
  RefBench: "0xF4412C52ec3DDf7CAf5f518B6662F77B02Bde28E",
} as const satisfies Record<string, Address>;

/** Reviewed on 2026-10-21 (part B K8 and part C S10). */
export const REVIEWED = {
  podMiningImpl: "0xa3dBe873dA37CD4E4a13C7Cef23A7DB6cA60F898",
  module: "0xfbb661fe281112c601954abb0a3cdcc697a6e6ba",
  moduleCodeHash: "0x028ff888dc6b7505d507ffd33ef99d8541a23852d36a0463de235af6772e4737",
  circuitsBeacon: "0xf8d6d8eb894d6971c8976ad8b4971cbefe028156",
  circuitsImpl: "0x8E1D125Def6d3826C278299273a0760D47626068",
} as const;

export const SLOT = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
} as const satisfies Record<string, Hex>;

/** PodMining custom errors (S4). */
export const ERR = {
  Corr: "0xe915f0ea", // the miner's output is correct: no revocation
  Prf: "0x7e409b38", // the Merkle proof does not match the task's root
  Nomn: "0x5f9bb3be", // the miner is not mining
} as const;

/** An unrelated caller for the `challenge` simulations (§4.3.3). */
export const CHALLENGER: Address = "0x000000000000000000000000000000000000dEaD";

export const MINER_ACTIVE = 1;
export const MAX_EQUIV_BITS = 20;
/** Calls per Multicall3 request; spec ceiling 64, kept low so a batch stays far below gas caps. */
export const BATCH = 16;
export const VECTORS_URL = "https://tapeout.net/pod/pod-vectors-all.json";
export const ZERO: Address = "0x0000000000000000000000000000000000000000";
