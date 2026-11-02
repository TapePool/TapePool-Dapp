// Opt-in, deterministic local Anvil: real Part A pool/factory/agents with mock external sources.
// The existing two-chain fork scenarios exercise the bridge separately. Never run against a remote RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createTestClient, createWalletClient, getContractAddress, http, parseEther, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ADDR, type Deployment } from "../src/addresses.js";
import { agentAbi, poolAbi } from "../src/abi.js";
import { xlayerChain, type Clients } from "../src/chains.js";
import { loadConfig } from "../src/config.js";
import { Keeper } from "../src/keeper.js";
import { FEED_SETTLE } from "../src/logic/evidence.js";
import { checkStack, readLoans, type LoanSnapshot } from "../src/reads.js";
import { emptyState } from "../src/state.js";
import { Sender } from "../src/tx.js";
import type { Alerts } from "../src/alerts.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RPC = "http://127.0.0.1:8759";
const KEY = `0x${"11".repeat(32)}` as Hex;
const owner = privateKeyToAccount(KEY), guardian = privateKeyToAccount(`0x${"22".repeat(32)}`);
const pub = createPublicClient({ chain: xlayerChain, transport: http(RPC), cacheTime: 0 });
const local = createTestClient({ chain: xlayerChain, mode: "anvil", transport: http(RPC) });
const wallet = createWalletClient({ account: owner, chain: xlayerChain, transport: http(RPC) });
const artifact = (file: string, name: string, custom = false) => JSON.parse(readFileSync(`${ROOT}/keeper/${custom ? ".anvil-out" : "../out"}/${file}.sol/${name}.json`, "utf8")) as { abi: Abi; bytecode: { object: Hex }; deployedBytecode: { object: Hex } };
const write = async (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => {
  const hash = await wallet.writeContract({ address, abi, functionName, args } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
};

describe.skipIf(process.env.KEEPER_ANVIL !== "1").sequential("redeploy keeper on local Anvil", () => {
  let process: ChildProcess;
  beforeAll(async () => {
    const exe = (name: string) => globalThis.process.platform === "win32" ? `${name}.exe` : name;
    execFileSync(exe("forge"), ["build", "keeper/test/anvil/RefreshSources.sol", "--out", "keeper/.anvil-out", "--cache-path", "keeper/.anvil-cache"], { cwd: ROOT, stdio: "pipe", windowsHide: true });
    process = spawn(exe("anvil"), ["--port", "8759", "--chain-id", "196", "--silent"], { stdio: "ignore", windowsHide: true });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error("local Anvil did not start");
  }, 60_000);
  afterAll(() => process?.kill());

  async function setup() {
    await local.setBalance({ address: owner.address, value: parseEther("100") });
    await local.setBalance({ address: guardian.address, value: parseEther("100") });
    const deploy = async (file: string, name: string, args: unknown[] = []) => {
      const a = artifact(file, name);
      const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args } as never);
      return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
    };
    const bem = artifact("Mocks", "MockBEM"), voucher = artifact("Mocks", "MockVoucher"), feed = artifact("Mocks", "MockRigFeed");
    const bemDeployed = await deploy("Mocks", "MockBEM");
    await local.setCode({ address: ADDR.bemXLayer, bytecode: (await pub.getCode({ address: bemDeployed }))! });
    const voucherDeployed = await deploy("Mocks", "MockVoucher", [ADDR.bemXLayer]);
    await local.setCode({ address: ADDR.voucher, bytecode: (await pub.getCode({ address: voucherDeployed }))! });
    const source = artifact("RefreshSources", "RefreshSources", true);
    for (const address of [ADDR.rigVault, ADDR.podMining, ADDR.bscCircuits[0]]) await local.setCode({ address, bytecode: source.deployedBytecode.object });
    await write(ADDR.podMining, source.abi, "setStopped", [false]);
    const receiver = await deploy("Mocks", "MockRigFeed");
    const policy = await deploy("Mocks", "MockCreditPolicy", [receiver, 1]);
    const nonce = await pub.getTransactionCount({ address: owner.address });
    const predictedPool = getContractAddress({ from: owner.address, nonce: BigInt(nonce + 1) });
    const factory = await deploy("AgentFactory", "AgentFactory", [predictedPool, ADDR.voucher, ADDR.bemXLayer, receiver]);
    const pool = await deploy("TapePool", "TapePool", [ADDR.bemXLayer, factory, policy, owner.address, guardian.address, owner.address]);
    const screen = await deploy("RigScreen", "RigScreen", [pool]);
    expect(pool.toLowerCase()).toBe(predictedPool.toLowerCase());
    const fullPool = artifact("TapePool", "TapePool").abi, factoryAbi = artifact("AgentFactory", "AgentFactory").abi;
    await write(ADDR.bemXLayer, bem.abi, "mint", [owner.address, 1_001_000_000n]);
    await write(ADDR.bemXLayer, bem.abi, "approve", [pool, 1_001_000_000n]);
    await write(pool, fullPool, "deposit", [1_000_000n, "0x000000000000000000000000000000000000dEaD"]);
    await write(pool, fullPool, "deposit", [1_000_000_000n, owner.address]);
    await write(pool, fullPool, "unpauseBorrows");
    await write(factory, factoryAbi, "create", [0n]);
    const agent = await pub.readContract({ address: factory, abi: factoryAbi, functionName: "predictAgent", args: [owner.address, 0n] }) as Address;
    for (const id of [16n, 17n]) {
      await write(ADDR.voucher, voucher.abi, "mint", [owner.address, id, 500n]);
      await write(ADDR.voucher, voucher.abi, "safeTransferFrom", [owner.address, agent, id]);
    }
    const time = async () => Number((await pub.getBlock()).timestamp);
    const at = async (timestamp: number) => { await local.setNextBlockTimestamp({ timestamp: BigInt(timestamp) }); await local.mine({ blocks: 1 }); };
    const report = async (id: bigint, healthy = true, observedAt?: number) => write(receiver, feed.abi, "set", [{ rigId: id, circuitId: id, since: 1n, stopBlock: 0n, circuits: ADDR.bscCircuits[0], observedAt: BigInt(observedAt ?? await time()), status: healthy ? 1 : 3, custodied: true, verifWeight: healthy ? 500n : 0n, bonus: 0n, totalVerifWeight: 1000n, bscBlock: 1n, pending: 0n, taskId: 4 }]);
    await report(16n); await report(17n);
    await write(agent, agentAbi, "borrow", [0, 1_000_000n, 100_000n, 0]);
    const d: Deployment = { pool, factory, receiver, reporter: receiver, screen, factoryDeployBlock: 1n };
    const guardianWallet = createWalletClient({ account: guardian, chain: xlayerChain, transport: http(RPC) });
    // A fresh local chain has no Multicall3; use direct EVM reads with the same result shape.
    const reads = { ...pub, multicall: async (q: { contracts: { address: Address; abi: Abi; functionName: string; args?: unknown[] }[]; blockNumber?: bigint; allowFailure?: boolean }) => Promise.all(q.contracts.map(async (contract) => {
      try {
        const result = await pub.readContract({ ...contract, blockNumber: q.blockNumber } as never);
        return q.allowFailure === false ? result : { status: "success", result };
      } catch (error) {
        if (q.allowFailure === false) throw error;
        return { status: "failure", error };
      }
    })) };
    const c = { account: guardian, bsc: { name: "bsc", public: reads, wallet: guardianWallet }, xlayer: { name: "xlayer", public: reads, wallet: guardianWallet } } as unknown as Clients;
    const alerts: string[] = [];
    const senders = { bsc: new Sender(c.bsc, { mode: "live", capWei: parseEther("1"), stuckAfterSec: 180, alert: (s) => alerts.push(s) }), xlayer: new Sender(c.xlayer, { mode: "live", capWei: parseEther("1"), stuckAfterSec: 60, alert: (s) => alerts.push(s) }) };
    let now = await time();
    const cfg = loadConfig({ KEEPER_MODE: "live", KEEPER_PRIVATE_KEY: KEY, BSC_RPC: RPC, TELEGRAM_BOT_TOKEN: "test", TELEGRAM_CHAT_ID: "1" });
    const k = new Keeper(cfg, c, d, { send: async (_kind: string, text: string) => void alerts.push(text) } as unknown as Alerts, senders, emptyState(1n, factory), () => now);
    const impairment = async () => {
      now = await time();
      const loans = await readLoans(c, [agent]);
      await (k as unknown as { impairment(d: Deployment, loans: LoanSnapshot[], block: bigint, now: number): Promise<void> }).impairment(d, loans, await pub.getBlockNumber(), now);
      await senders.bsc.poll(); await senders.xlayer.poll();
      return loans[0]!;
    };
    const loan = () => pub.readContract({ address: agent, abi: agentAbi, functionName: "loanOf" });
    const flag = async () => {
      const floor = await pub.readContract({ address: agent, abi: agentAbi, functionName: "flagEvidenceFrom" });
      await at(Number(floor) + 1);
      await write(ADDR.voucher, voucher.abi, "setRig", [16n, floor, 0n]);
      await write(agent, agentAbi, "flagImpaired", [16n]);
      return loan();
    };
    return { k, d, c, agent, alerts, bem, voucher, source, write, time, at, report, impairment, loan, flag };
  }

  it("RA-08: keeper flag applies BEM and re-reads a closed loan", async () => {
    const snapshot = await local.snapshot();
    try {
      const s = await setup();
      const floor = await pub.readContract({ address: s.agent, abi: agentAbi, functionName: "flagEvidenceFrom" });
      await s.at(Number(floor) + 1);
      await write(ADDR.podMining, s.source.abi, "setStopped", [true]);
      await s.report(16n, false);
      await write(ADDR.bemXLayer, s.bem.abi, "mint", [s.agent, (await s.loan()).debt]);
      await s.impairment();
      await s.at((await s.time()) + 60);
      expect((await s.impairment()).loan.open).toBe(false);
      expect((await s.loan()).impairedAt).toBe(0n);
      expect(s.alerts.some((s) => s.startsWith("sent flagImpaired"))).toBe(true);
    } finally { await local.revert({ id: snapshot }); }
  });

  it("RA-19: every Param ordinal reads within its bounds, with PerBorrowerAbs appended at 13", async () => {
    const snapshot = await local.snapshot();
    try {
      const s = await setup();
      for (let key = 0; key <= 13; key++) {
        const [lo, hi] = await pub.readContract({ address: s.d.pool, abi: poolAbi, functionName: "bounds", args: [key] });
        const value = await pub.readContract({ address: s.d.pool, abi: poolAbi, functionName: "param", args: [key] });
        expect(value).toBeGreaterThanOrEqual(lo); expect(value).toBeLessThanOrEqual(hi);
      }
      expect(await pub.readContract({ address: s.d.pool, abi: poolAbi, functionName: "param", args: [13] })).toBe(400_000_000n);
      expect(await pub.readContract({ address: s.d.pool, abi: poolAbi, functionName: "bounds", args: [13] })).toEqual([0n, 50_000_000_000n]);
    } finally { await local.revert({ id: snapshot }); }
  });

  it("RB3-05: the keeper's stack check accepts the redeploy 3 pool, whose FEED_SETTLE is the keeper's", async () => {
    const snapshot = await local.snapshot();
    try {
      const s = await setup();
      await checkStack(s.c, s.d);
      expect(await pub.readContract({ address: s.d.pool, abi: poolAbi, functionName: "FEED_SETTLE" })).toBe(BigInt(FEED_SETTLE));
      expect(await pub.readContract({ address: s.d.pool, abi: poolAbi, functionName: "feedEnabledAt" })).toBe(0n);
    } finally { await local.revert({ id: snapshot }); }
  });

  it("RA-05: a brake after expiry keeps expiry and the keeper only alerts", async () => {
    const snapshot = await local.snapshot();
    try {
      const s = await setup(), flagged = await s.flag();
      await s.at(Number(flagged.deadline) + 1);
      await write(s.d.pool, artifact("TapePool", "TapePool").abi, "disableFeed");
      expect((await s.loan()).expired).toBe(true);
      await s.impairment();
      expect(s.alerts.some((s) => s.includes("expired impairment flag while the feed is disabled"))).toBe(true);
      expect((await s.loan()).impairedAt).toBe(flagged.impairedAt);
    } finally { await local.revert({ id: snapshot }); }
  });

  it("RA-07: a non-flagged rig needs a refresh harvest before the keeper clears", async () => {
    const snapshot = await local.snapshot();
    try {
      const s = await setup(), flagged = await s.flag();
      await s.at(Number(flagged.deadline) + 60);
      const now = await s.time();
      await write(ADDR.voucher, s.voucher.abi, "setRig", [16n, BigInt(now), 500n]);
      await s.report(16n, true, now); await s.report(17n, true, now);
      await write(ADDR.voucher, s.voucher.abi, "setRig", [17n, BigInt(now + 1), 0n]);
      await s.impairment();
      expect(Object.values(s.k.state.refresh).some((r) => r.sentAt !== undefined)).toBe(true);
      const record = await pub.readContract({ address: ADDR.voucher, abi: s.voucher.abi, functionName: "rigs", args: [17n] }) as readonly [Address, bigint, bigint, bigint];
      expect(record[3]).toBe(500n);
      await s.impairment();
      expect((await s.loan()).impairedAt).toBe(0n);
      expect(await pub.readContract({ address: s.d.pool, abi: poolAbi, functionName: "doubtful" })).toBe(0n);
    } finally { await local.revert({ id: snapshot }); }
  });
});
