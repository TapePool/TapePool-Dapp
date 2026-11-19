// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Live addresses and ids every deploy script uses (CLAUDE.md, SPEC-PHASE3 P1–P4). Reviewed like code.
library Addresses {
    // ── chains and LayerZero
    uint256 internal constant BSC_CHAIN_ID = 56;
    uint256 internal constant XLAYER_CHAIN_ID = 196;
    uint32 internal constant BSC_EID = 30102;
    uint32 internal constant XLAYER_EID = 30274;
    address internal constant ENDPOINT = 0x1a44076050125825900e736c501f859c50fE728c; // same on both chains

    // ── BSC
    address internal constant RIG_VAULT = 0x48D43345656f0f9510dC3c06CBa99dFf597617C2;
    address internal constant POD_MINING = 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46;
    address internal constant BEM_ADAPTER_BSC = 0xa84B8D3893De6e9922f2B29bE1e1b115845F5E72;
    address internal constant CPU_TAPEOUT = 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C;
    address internal constant CPU_BEHEMOTH = 0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C;
    address internal constant CPU_REFBENCH = 0xF4412C52ec3DDf7CAf5f518B6662F77B02Bde28E;

    // ── X Layer
    address internal constant RIG_VOUCHER = 0x9cfc959cd42B2e1d39a0d850c528210E818AE520;
    address internal constant BEM_OFT_XLAYER = 0x60e62Efa9405d6873C5deaBD4E6CC91c25363952;

    // ── our policy circuit (SPEC-PHASE3 §2.3), taped out 2026-10-21 at X Layer blocks 73,801,997–73,801,999;
    //    `verify`, `verifyHolder` passed on the live chain (all 4,096 vectors through the real `eval`)
    address internal constant POLICY_CIRCUITS = 0xdc76f123838b5398A173D215a2c8338Ad189C9a8;
    uint256 internal constant POLICY_CIRCUIT_ID = 1;

    // ── our rig data feed (SPEC-PHASE3 §5), deployed and locked 2026-10-21; first 16-rig push delivered
    address internal constant FEED_REPORTER_BSC = 0xCdD7E66c51633255C944DDC43dAe7285a300f1B7;
    address internal constant FEED_RECEIVER_XLAYER = 0x8bd22956fdcfebA48dD37a4fB4c33b226273b4b6;

    // ── the rig data feed of the redeploy, deployed and locked 2026-10-31 (docs/redeploy/deploy-log.md
    //    RD-03): reporter BSC block 130,864,778, receiver X Layer blocks 74,684,257–74,684,262. Redeploy 3
    //    reuses it (SPEC-REDEPLOY-3 O3-4); its owner and delegate are 0 on both chains
    address internal constant FEED_REPORTER_BSC_2 = 0x24b5a7CA358Af29C51d16F801BbEcF746247AF0e;
    address internal constant FEED_RECEIVER_XLAYER_2 = 0xB96847a3af4C9eC658cDC77dB98801AF399cFA1d;

    // ── our pool stack (SPEC-PHASE3 §6 steps 3–7), deployed 2026-10-21 at X Layer blocks 73,824,866–73,824,872
    //    by the deployer with the owner's go-ahead; owner and guardian set in the constructors
    address internal constant RIG_SCREEN = 0xc336C0a710e99D5BD72417B35f0E70Cff063918C;
    address internal constant CREDIT_POLICY = 0xBfE81f1e0D91e8D2C03ce4A015e9E096558f561D;
    address internal constant AGENT_FACTORY = 0xC365a30740c17b93fE92581667A2d60bD4b92355;
    address internal constant TAPE_POOL = 0xD54673E73448584E86C61f45203ab507F3F2c3eC;
    uint256 internal constant FACTORY_DEPLOY_BLOCK = 73_824_869;

    // ── the redeploy pool stack (docs/redeploy/deploy-log.md RD-04), deployed 2026-10-31 at X Layer blocks
    //    74,685,767–74,685,774 on the feed above; redeploy 3 retires it (SPEC-REDEPLOY-3 §7.1, RD3-06)
    address internal constant AGENT_FACTORY_2 = 0x123B9EAaAeae5047a9E5c96e3b9C81177d57607c;
    address internal constant TAPE_POOL_2 = 0xFD48226e11FCFF465033305574D87bCE004314BA;
    uint256 internal constant FACTORY_DEPLOY_BLOCK_2 = 74_685_770;

    // ── retired 2026-11-02 stack (redeploy 4, RD4-08); its feed is the historical pair above
    address internal constant RIG_SCREEN_3 = 0x3ed768Ba7A72Ce8E9091097ED93616C2560f3ddf;
    address internal constant CREDIT_POLICY_3 = 0x8983589e7575738c54339e6BDaddb63375EbFF23;
    address internal constant AGENT_FACTORY_3 = 0xCB63a96929A28b2F826cD9d5eA67b6f4D200C3B8;
    address internal constant TAPE_POOL_3 = 0x68c1D5e6f193cE5a5060BF7540Ae391cbC1939ca;
    address internal constant TAPE_LENS_3 = 0xa66148be3353D85a5b4B028862C5EE9987dd0D84;
    uint256 internal constant FACTORY_DEPLOY_BLOCK_3 = 74_859_490;

    // ── redeploy 4 feed, deployed and locked 2026-11-16 (docs/redeploy-4/deploy-log.md RD4-03): reporter BSC
    //    block 133,949,050, receiver X Layer blocks 76,073,325–76,073,332; owner and delegate 0 on both chains
    address internal constant FEED_REPORTER_BSC_4 = 0xD54673E73448584E86C61f45203ab507F3F2c3eC;
    address internal constant FEED_RECEIVER_XLAYER_4 = 0xc94C9Cc912203c29C2c1b3534e0852BF4aFAeA10;

    // ── redeploy 4 pool stack, deployed 2026-11-16 at X Layer blocks 76,074,240–76,074,248 on the feed above
    //    (docs/redeploy-4/deploy-log.md RD4-05); agent implementation 0x0D4BA9992B2b887ea1f55E59925339547C772259
    address internal constant RIG_SCREEN_4 = 0xc2bBc2f2EC90e16f8a9619D26A51144Eb0AC1744;
    address internal constant CREDIT_POLICY_4 = 0xBBFe498158b6A234f4f63B17673f6e8226656D34;
    address internal constant AGENT_FACTORY_4 = 0xA9014E27dD17ea30E4Fa4f71934645b9DCEF8ac8;
    address internal constant TAPE_POOL_4 = 0x1a9A9850D597D8e3a03AFae48E3ac8E2D4aeC9d7;
    address internal constant TAPE_LENS_4 = 0xFcc669BC9cCa397CB01804035D5Be981d7389ef2;
    uint256 internal constant FACTORY_DEPLOY_BLOCK_4 = 76_074_244;

    // ── our roles (SPEC §3, DERISK §5)
    address internal constant OWNER = 0x19a953e83C4CFDffFf2Fd336f3857c52D99045ba;
    address internal constant KEEPER_GUARDIAN = 0xB61e09c96B66c02D9518e8f0f9Ce645b8589dBC8;

    /// First PodMining halving minus 30 days (SPEC-PHASE3 §4.1), checked against BSC at deploy.
    uint256 internal constant EMISSION_VALID_UNTIL = 1_910_726_132;
}
