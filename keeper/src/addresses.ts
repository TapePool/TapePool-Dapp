// Live addresses and the expected implementations the upgrade watch compares against
// (SPEC-PHASE3-KEEPER §1 K8, §4.1). Reviewed like code: nothing on-chain or in an HTTP request can
// change them. After the owner reviews an upgrade, update EXPECTED_IMPL and redeploy the keeper.
import type { Address, Hex } from "viem";

export const CHAIN = {
  bsc: { id: 56, eid: 30102 },
  xlayer: { id: 196, eid: 30274 },
} as const;

export const ADDR = {
  endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  // BSC
  rigVault: "0x48D43345656f0f9510dC3c06CBa99dFf597617C2",
  podMining: "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46",
  bemBsc: "0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a",
  bemAdapter: "0xa84B8D3893De6e9922f2B29bE1e1b115845F5E72", // BEM OFT adapter: its feeBps() is the bridge fee
  bscCircuits: [
    "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C", // TapeOut
    "0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C", // Behemoth
    "0xF4412C52ec3DDf7CAf5f518B6662F77B02Bde28E", // RefBench
  ],
  // X Layer
  voucher: "0x9cfc959cd42B2e1d39a0d850c528210E818AE520",
  bemXLayer: "0x60e62Efa9405d6873C5deaBD4E6CC91c25363952",
  xlayerCircuitsBeacon: "0xf70d1ed4f62CF3780157B0b421b7E2F45bD0991C",
} as const satisfies Record<string, Address | readonly Address[]>;

/** Expected implementations on 2026-10-19 (K8). */
export const EXPECTED_IMPL = {
  voucher: "0x66FB7d52C4931B48776D9019f88F7f58fB0d85E1",
  rigVault: "0xeB3F0614e37d995a96fA41908de8D47A57F56463",
  podMining: "0xa3dBe873dA37CD4E4a13C7Cef23A7DB6cA60F898",
  bscCircuitsBeacon: "0xf8d6d8eb894d6971c8976ad8b4971cbefe028156",
  bscCircuitsImpl: "0x8E1D125Def6d3826C278299273a0760D47626068",
  xlayerCircuitsImpl: "0x977f217887E085D298Cb3819cDAD5A0ee35F29B2",
} as const satisfies Record<string, Address>;

export const SLOT = {
  /** EIP-1967 implementation slot. */
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  /** EIP-1967 beacon slot. */
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
} as const satisfies Record<string, Hex>;

/**
 * Our own contracts. Filled when they are deployed (feed in Phase 3, pool in Phase 6).
 *
 * The redeploy address book is the `KEEPER_*` environment of `loadDeployment` (config.ts). Redeploy 3
 * (SPEC-REDEPLOY-3 RB3-05) fills it after RD3-04 with the new `KEEPER_POOL`, `KEEPER_FACTORY`, `KEEPER_SCREEN`,
 * `KEEPER_LENS`, `KEEPER_POOL_DEPLOY_BLOCK` and `KEEPER_FACTORY_DEPLOY_BLOCK`, and keeps the reused feed:
 * `KEEPER_RECEIVER`, `KEEPER_REPORTER` and their deploy blocks stay the 2026-10-31 values. The keeper never
 * calls the credit policy, so it has no policy address. A non-legacy deployment must be a redeploy 3 pool
 * (`checkStack` in reads.ts); this build cannot serve the 2026-10-31 pool, which has no `feedEnabledAt`.
 */
export interface Deployment {
  /** Only the existing mainnet stack uses the legacy evidence/accounting rules. */
  legacy?: boolean;
  pool: Address;
  factory: Address;
  screen: Address;
  receiver: Address; // RigFeedReceiver on X Layer
  reporter: Address; // RigReporter on BSC
  lens?: Address;
  reporterDeployBlock?: bigint;
  receiverDeployBlock?: bigint;
  factoryDeployBlock: bigint;
  /** First block with the pool's code: where the app routes' snapshots and position index start. Defaults to `factoryDeployBlock`. */
  poolDeployBlock?: bigint;
}

/** Deployed 2026-10-21 (X Layer blocks 73,824,866–73,824,872; feed locked the same day). */
export const DEPLOYMENT: Deployment | null = {
  legacy: true,
  pool: "0xD54673E73448584E86C61f45203ab507F3F2c3eC",
  factory: "0xC365a30740c17b93fE92581667A2d60bD4b92355",
  screen: "0xc336C0a710e99D5BD72417B35f0E70Cff063918C",
  receiver: "0x8bd22956fdcfebA48dD37a4fB4c33b226273b4b6",
  reporter: "0xCdD7E66c51633255C944DDC43dAe7285a300f1B7",
  factoryDeployBlock: 73_824_869n,
  // TapePool itself landed in block 73,824,872 (the batch of deploys began at 73,824,866 with RigScreen);
  // an archive read of the pool at an earlier block finds no code.
  poolDeployBlock: 73_824_872n,
};
