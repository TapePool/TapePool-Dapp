// Shared harness for the keeper's anvil integration tests and the app's end-to-end tests: two LOCAL anvil
// forks (BSC and X Layer) with the Phase 3 stack deployed by script/test/AnvilStack.s.sol, auto-impersonated
// accounts, a simulated DVN step, and the keeper wired to the forks. Nothing here sends to a real chain.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeAbiParameters,
  encodePacked,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  slice,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscChain, xlayerChain, type Clients } from "../../src/chains.js";
import { loadConfig, type Config } from "../../src/config.js";
import { Keeper, LOG_LAG } from "../../src/keeper.js";
import { PushLimiter } from "../../src/logic/pushLimits.js";
import { PushService } from "../../src/push.js";
import { emptyState } from "../../src/state.js";
import { Sender } from "../../src/tx.js";
import { ADDR, type Deployment } from "../../src/addresses.js";
import { agentAbi, podAbi, poolAbi, receiverAbi, vaultAbi } from "../../src/abi.js";
import type { Alerts } from "../../src/alerts.js";

export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const exe = (n: string) => (process.platform === "win32" ? `${n}.exe` : n);
const BSC_BLOCK = 128_369_002n;
const XL_BLOCK = 73_558_380n;
export const LOAN_TIME = 1_793_368_800; // 2026-10-30 14:00 UTC, past rig #16's 3-day age rule

export const DEPLOYER = "0x7e57000000000000000000000000000000000001" as Address;
export const OWNER = "0x7e57000000000000000000000000000000000002" as Address;
// the keeper signs locally as in production, so the guardian is a test key rather than an impersonated address
const GUARDIAN_KEY = `0x${"22".repeat(32)}` as Hex;
export const GUARDIAN = privateKeyToAccount(GUARDIAN_KEY).address;
export const LP = "0x7e57000000000000000000000000000000000004" as Address;
export const BIG_HOLDER = "0x571d447f4f24688eC35Ccf07f1D6993655F6aF15" as Address; // BEM on X Layer
export const SAFE = "0xB3D85b42A045c1A88D800CAD0F55d2566a4D3138" as Address;
export const HOLDER_C905 = "0xC9059E0F59F40920E5BD24307eaa4DeFd81Df145" as Address; // holds rig #5
export const RIG = 16n;

export const erc20 = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const pool4626 = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function transfer(address to, uint256 shares) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
]);
export const factoryCreate = parseAbi([
  "function create(uint256 index) returns (address)",
  "function predictAgent(address borrower, uint256 index) view returns (address)",
]);
export const voucherAbi = parseAbi([
  "function safeTransferFrom(address from, address to, uint256 id)",
  "function ownerOf(uint256 id) view returns (address)",
  "function rigs(uint256 id) view returns (address circuits, uint64 syncedAt, uint256 circuitId, uint256 power)",
]);
export const borrowAbi = parseAbi(["function borrow(uint8 term, uint256 principal, uint256 maxFee, uint16 maxLateBps) payable"]);
const stopAbi = parseAbi(["function stop(bytes32 key)"]);
const oftAbi = parseAbi(["function decimalConversionRate() view returns (uint256)"]);
const composeAbi = parseAbi(["function lzCompose(address from, bytes32 guid, bytes message, address executor, bytes extraData) payable"]);
export const BEM_ADAPTER_BSC = "0xa84B8D3893De6e9922f2B29bE1e1b115845F5E72" as Address;
const recordAbi = parseAbi(["function recordPass(uint256 rigId, address circuits, uint64 circuitId, uint32 taskId, bytes32 artifactHash)"]);
export const rescueAbi = parseAbi(["function rescue(uint256 id, address to)"]);
export const ownerPoolAbi = parseAbi(["function disableFeed()", "function enableFeed()", "function unpauseBorrows()"]);
const endpointAbi = parseAbi([
  "struct Origin { uint32 srcEid; bytes32 sender; uint64 nonce; }",
  "function getReceiveLibrary(address receiver, uint32 srcEid) view returns (address lib, bool isDefault)",
  "function verify(Origin origin, address receiver, bytes32 payloadHash)",
  "function lzReceive(Origin origin, address receiver, bytes32 guid, bytes message, bytes extraData) payable",
]);
const PACKET_SENT = keccak256(encodePacked(["string"], ["PacketSent(bytes,bytes,address)"]));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Upstream rate for anvil: the public X Layer node throttles hard; a keyed archive endpoint takes more. */
const CUPS_PUBLIC = 100;
const CUPS_KEYED = 300;

async function startAnvil(forkUrl: string, block: bigint, port: number, cups = CUPS_PUBLIC): Promise<ChildProcess> {
  const p = spawn(
    exe("anvil"),
    [
      "--fork-url", forkUrl, "--fork-block-number", block.toString(), "--port", String(port),
      "--auto-impersonate", "--slots-in-an-epoch", "1", "--silent",
      // stay under the upstream RPC's rate limit instead of being throttled into long backoffs
      "--compute-units-per-second", String(cups), "--retries", "10", "--timeout", "60000",
    ],
    { stdio: "ignore" },
  );
  const client = createPublicClient({ transport: http(`http://127.0.0.1:${port}`) });
  for (let i = 0; i < 60; i++) {
    try {
      await client.getChainId();
      return p;
    } catch {
      await sleep(1_000);
    }
  }
  throw new Error(`anvil on ${port} did not start`);
}

function forge(sig: string, args: string[], rpc: string): string {
  return execFileSync(
    exe("forge"),
    ["script", "script/test/AnvilStack.s.sol", "--rpc-url", rpc, "--sig", sig, ...args, "--unlocked", "--sender", DEPLOYER, "--broadcast"],
    { cwd: ROOT, encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 },
  );
}

const grab = (out: string, label: string): string => {
  const m = out.match(new RegExp(`${label} (\\S+)`));
  if (!m?.[1]) throw new Error(`${label} not found in forge output`);
  return m[1];
};

export const RELAY = "0x7e57000000000000000000000000000000000005" as Address;

export interface StackOpts {
  /**
   * Open the borrower's agent on rig #16 (create it and move the voucher in) before the clock moves to LOAN_TIME. The keeper's
   * own scenarios want this; the app's end-to-end tests leave it to the miner, who does it through the UI.
   */
  openAgent?: boolean;
  /** BEM (raw) the lender LP deposits at the start. The MVP supply cap is 20 BEM, so the keeper scenarios fill it. */
  lpSeed?: bigint;
  /**
   * Make the stack's "now" follow the wall clock between `sync` calls, as the anvil forks do: the value is the time of the last
   * `sync` plus the seconds elapsed since. Off, "now" stays at the last `sync` (the keeper scenarios move time by hand).
   */
  liveClock?: boolean;
  /** The account that lands report packets on X Layer (calls `lzReceive`). Default LP; the app tests give it its own. */
  relay?: Address;
}

/**
 * Start both forks, deploy the stack, fund the actors, seed the lender, record rig #16's screen pass and move both clocks to
 * LOAN_TIME. With `openAgent` (the default) it also opens a borrower agent on rig #16 and moves the voucher in. That step
 * stays where it always was in the transaction sequence, so the keeper's scenarios get exactly what they did before.
 */
export async function startStack(bscPort: number, xlPort: number, opts: StackOpts = {}) {
  const openAgent = opts.openAgent ?? true;
  const lpSeed = opts.lpSeed ?? 2_000_000_000n;
  const relay = opts.relay ?? LP;
  const BSC_URL = `http://127.0.0.1:${bscPort}`;
  const XL_URL = `http://127.0.0.1:${xlPort}`;
  // XLAYER_RPC (an archive endpoint, from the developer's environment) replaces the throttled public node when set
  const xlUpstream = process.env.XLAYER_RPC || "https://rpc.xlayer.tech";
  const anvils = [
    await startAnvil(process.env.BSC_RPC!, BSC_BLOCK, bscPort, CUPS_KEYED),
    await startAnvil(xlUpstream, XL_BLOCK, xlPort, process.env.XLAYER_RPC ? CUPS_KEYED : CUPS_PUBLIC),
  ];
  // no block-number cache: marks and log ranges must see blocks mined a moment ago
  const bsc = createPublicClient({ chain: bscChain, transport: http(BSC_URL), cacheTime: 0 });
  const xl = createPublicClient({ chain: xlayerChain, transport: http(XL_URL), cacheTime: 0 });
  const bscTest = createTestClient({ mode: "anvil", chain: bscChain, transport: http(BSC_URL) });
  const xlTest = createTestClient({ mode: "anvil", chain: xlayerChain, transport: http(XL_URL) });
  const as = (chain: "bsc" | "xl", account: Address) =>
    createWalletClient({ account, chain: chain === "bsc" ? bscChain : xlayerChain, transport: http(chain === "bsc" ? BSC_URL : XL_URL) });

  for (const a of [DEPLOYER, GUARDIAN]) {
    await bscTest.setBalance({ address: a, value: parseEther("100") });
    await xlTest.setBalance({ address: a, value: parseEther("100") });
  }
  for (const a of [OWNER, LP, RELAY, BIG_HOLDER, HOLDER_C905, SAFE]) await xlTest.setBalance({ address: a, value: parseEther("10") });
  await bscTest.setBalance({ address: SAFE, value: parseEther("10") });

  const trace = (m: string) => {
    if (process.env.KEEPER_TRACE) appendFileSync(process.env.KEEPER_TRACE, `  ${m} ${new Date().toISOString()}
`);
  };
  trace("anvils up");
  const reporter = getAddress(grab(forge("bsc()", [], BSC_URL), "ANVIL_REPORTER"));
  const reporterDeployBlock = await bsc.getBlockNumber();
  trace("reporter deployed");
  const xOut = forge("xlayer(address,address,address)", [reporter, OWNER, GUARDIAN], XL_URL);
  const d: Deployment = {
    pool: getAddress(grab(xOut, "ANVIL_POOL")),
    factory: getAddress(grab(xOut, "ANVIL_FACTORY")),
    screen: getAddress(grab(xOut, "ANVIL_SCREEN")),
    receiver: getAddress(grab(xOut, "ANVIL_RECEIVER")),
    reporter,
    legacy: false,
    reporterDeployBlock,
    factoryDeployBlock: BigInt(grab(xOut, "ANVIL_FACTORY_BLOCK")),
  };
  const policy = getAddress(grab(xOut, "ANVIL_POLICY"));
  /** A block no later than the pool's code and no earlier than the fork: where the app's history searches may start. */
  const poolBlock = await xl.getBlockNumber();
  d.poolDeployBlock = poolBlock;
  trace("x layer stack deployed");
  forge("finishBsc(address,address)", [reporter, d.receiver], BSC_URL);
  trace("reporter locked");

  // time: both chains move together; BSC also mines two extra blocks so `finalized` catches up, and X Layer
  // LOG_LAG more at the same timestamp so the keeper's log scan (head − LOG_LAG, part E §3.2) reaches the
  // events of the last step
  const clock = { now: 0, at: Date.now() };
  /** Calls that change the chains one after the other, so a relay transaction can never land between `setNextBlockTimestamp` and `mine`. */
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
  const sync = (ts: number) =>
    exclusive(async () => {
      clock.now = ts;
      await xlTest.setNextBlockTimestamp({ timestamp: BigInt(ts) });
      await xlTest.mine({ blocks: 1 });
      await xlTest.mine({ blocks: Number(LOG_LAG), interval: 0 });
      await bscTest.setNextBlockTimestamp({ timestamp: BigInt(ts) });
      await bscTest.mine({ blocks: 3 });
      clock.at = Date.now();
    });
  /**
   * One chain alone, for the app's tests of the move gate. Each runs inside `exclusive`, so no relay transaction lands between
   * `setNextBlockTimestamp` and `mine`. Anvil refuses a time at or below the head's, so a test moves forward only. Do not use
   * `sync` for this: it also sets BSC's next timestamp.
   *   - `xlAt`: one X Layer block at `ts`;
   *   - `bscAt`: three BSC blocks from `ts` (the last two let `finalized` catch up);
   *   - `bscFinalize`: three BSC blocks and no time move, for a block mined a moment ago.
   */
  const xlAt = (ts: number) =>
    exclusive(async () => {
      await xlTest.setNextBlockTimestamp({ timestamp: BigInt(ts) });
      await xlTest.mine({ blocks: 1 });
    });
  const bscAt = (ts: number) =>
    exclusive(async () => {
      await bscTest.setNextBlockTimestamp({ timestamp: BigInt(ts) });
      await bscTest.mine({ blocks: 3 });
    });
  const bscFinalize = () =>
    exclusive(async () => {
      await bscTest.mine({ blocks: 3 });
    });
  /** The head's time on each chain, in seconds. */
  const headTimes = async () => ({
    xl: Number((await xl.getBlock()).timestamp),
    bsc: Number((await bsc.getBlock()).timestamp),
  });
  /** The stack's time: the last `sync`, plus the seconds since when `liveClock` is on (the forks keep running on wall time). */
  const nowSec = () => (opts.liveClock ? clock.now + Math.floor((Date.now() - clock.at) / 1000) : clock.now);

  // lenders, borrower agent with rig #16, screen pass (recorded 12 days before the loan time)
  await as("xl", BIG_HOLDER).writeContract({ address: ADDR.bemXLayer, abi: erc20, functionName: "transfer", args: [LP, lpSeed] });
  await as("xl", LP).writeContract({ address: ADDR.bemXLayer, abi: erc20, functionName: "approve", args: [d.pool, lpSeed] });
  // The total seed stays inside the supply cap; dead shares and backstop shares are separate from LP.
  const deadSeed = lpSeed >= 1_000_000n ? 1_000_000n : 0n;
  if (deadSeed > 0n) await as("xl", LP).writeContract({ address: d.pool, abi: pool4626, functionName: "deposit", args: [deadSeed, "0x000000000000000000000000000000000000dEaD"] });
  await as("xl", LP).writeContract({ address: d.pool, abi: pool4626, functionName: "deposit", args: [lpSeed - deadSeed, LP] });
  const shares = await xl.readContract({ address: d.pool, abi: pool4626, functionName: "balanceOf", args: [LP] });
  await as("xl", LP).writeContract({ address: d.pool, abi: pool4626, functionName: "transfer", args: [OWNER, shares / 2n] });
  await as("xl", OWNER).writeContract({ address: d.pool, abi: ownerPoolAbi, functionName: "unpauseBorrows" });
  const borrower = getAddress(await xl.readContract({ address: ADDR.voucher, abi: voucherAbi, functionName: "ownerOf", args: [RIG] }));
  await xlTest.setBalance({ address: borrower, value: parseEther("10") });
  const agent = getAddress(await xl.readContract({ address: d.factory, abi: factoryCreate, functionName: "predictAgent", args: [borrower, 0n] }));
  /** Part (b): the borrower creates agent number 0 and moves rig #16's voucher into it. */
  const openBorrowerAgent = async () => {
    await as("xl", borrower).writeContract({ address: d.factory, abi: factoryCreate, functionName: "create", args: [0n] });
    await as("xl", borrower).writeContract({ address: ADDR.voucher, abi: voucherAbi, functionName: "safeTransferFrom", args: [borrower, agent, RIG] });
  };
  if (openAgent) await openBorrowerAgent();
  const [circuits, , circuitId] = await xl.readContract({ address: ADDR.voucher, abi: voucherAbi, functionName: "rigs", args: [RIG] });
  await as("xl", OWNER).writeContract({ address: d.screen, abi: recordAbi, functionName: "recordPass", args: [RIG, circuits, circuitId, 4, keccak256("0x16")] });
  await sync(LOAN_TIME);

  // the keeper, live against the forks, signing locally with the guardian's test key
  const keeperAccount = privateKeyToAccount(GUARDIAN_KEY);
  const clients: Clients = {
    account: keeperAccount,
    bsc: { name: "bsc", public: bsc, wallet: createWalletClient({ account: keeperAccount, chain: bscChain, transport: http(BSC_URL) }) },
    xlayer: { name: "xlayer", public: xl, wallet: createWalletClient({ account: keeperAccount, chain: xlayerChain, transport: http(XL_URL) }) },
  } as unknown as Clients;
  const cfg: Config = loadConfig({
    KEEPER_MODE: "live",
    KEEPER_PRIVATE_KEY: GUARDIAN_KEY,
    BSC_RPC: BSC_URL,
    XLAYER_RPC: XL_URL,
    TELEGRAM_BOT_TOKEN: "1:test",
    TELEGRAM_CHAT_ID: "1",
  });
  const alertsSeen: string[] = [];
  const alerts = { send: async (_k: string, t: string) => void alertsSeen.push(t) } as unknown as Alerts;
  const now = nowSec;
  const cap = parseEther("0.00001"); // generous gas cap on local forks
  const senders = {
    bsc: new Sender(clients.bsc, { mode: "live", capWei: cap, stuckAfterSec: 180, alert: (t) => alertsSeen.push(t), now }),
    xlayer: new Sender(clients.xlayer, { mode: "live", capWei: cap, stuckAfterSec: 60, alert: (t) => alertsSeen.push(t), now }),
  };
  const state = emptyState(d.factoryDeployBlock, d.factory);
  const makeKeeper = (s = emptyState(d.factoryDeployBlock, d.factory), dep: Deployment = d) => new Keeper(cfg, clients, dep, alerts, senders, s, now);
  const keeper = makeKeeper(state);
  const holder = { keeper };
  const makePush = (counts: Record<string, number> = state.pushCounts) =>
    new PushService(cfg, clients, d, senders.bsc, new PushLimiter(counts), () => holder.keeper.frozen, (_k, t) => void alertsSeen.push(t), now);
  const push = makePush();

  /** Land every new report packet sent to our receiver since `fromBlock`, waiting up to 30 s for `want`. */
  const delivered = new Set<string>();
  /**
   * Endpoint logs in [fromBlock, local head]. The range is always bounded by the fork's own head: an
   * open or future range makes anvil forward the query to the real RPC (real logs, or a hang).
   */
  const localLogs = async (fromBlock: bigint) => {
    const head = await bsc.getBlockNumber();
    if (fromBlock > head) return [];
    return bsc.getLogs({ address: ADDR.endpoint, fromBlock, toBlock: head });
  };
  /** One pass: land every report packet to our receiver sent since `fromBlock` that has not landed yet. Returns how many landed. */
  const deliverOnce = (fromBlock: bigint) =>
    exclusive(async () => {
      let landed = 0;
      for (const log of await localLogs(fromBlock)) {
        if (log.topics[0] !== PACKET_SENT) continue;
        const [payload] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "address" }], log.data);
        const p = payload as Hex;
        if (getAddress(slice(slice(p, 49, 81), 12)) !== d.receiver) continue; // a harvest's OFT message
        const guid = slice(p, 81, 113);
        if (delivered.has(guid)) continue;
        delivered.add(guid);
        const origin = { srcEid: Number(BigInt(slice(p, 9, 13))), sender: slice(p, 13, 45), nonce: BigInt(slice(p, 1, 9)) };
        const message = slice(p, 113);
        const [lib] = await xl.readContract({ address: ADDR.endpoint, abi: endpointAbi, functionName: "getReceiveLibrary", args: [d.receiver, 30102] });
        await xlTest.setBalance({ address: lib, value: parseEther("1") });
        await as("xl", lib).writeContract({ address: ADDR.endpoint, abi: endpointAbi, functionName: "verify", args: [origin, d.receiver, keccak256(encodePacked(["bytes32", "bytes"], [guid, message]))] });
        await as("xl", relay).writeContract({ address: ADDR.endpoint, abi: endpointAbi, functionName: "lzReceive", args: [origin, d.receiver, guid, message, "0x"] });
        landed++;
      }
      return landed;
    });
  const deliverSince = async (fromBlock: bigint, want = 1) => {
    let landed = 0;
    for (let tries = 0; tries < 30 && landed < want; tries++) {
      if (tries > 0) await sleep(1_000);
      landed += await deliverOnce(fromBlock);
    }
    return landed;
  };
  /**
   * The relay for a whole run: every second, land the report packets sent from BSC since it started (the keeper's pushes and
   * the app's self-pushes alike). Separate forks deliver no LayerZero messages by themselves, and the UI cannot trigger this.
   */
  const startRelay = async () => {
    const from = await bsc.getBlockNumber();
    let running = true;
    const loop = (async () => {
      while (running) {
        try {
          await deliverOnce(from);
        } catch {
          /* a read or a send that fails is tried again on the next pass */
        }
        await sleep(500);
      }
    })();
    return {
      async stop() {
        running = false;
        await loop;
      },
    };
  };
  /** Report packets to our receiver since `fromBlock` that were not delivered yet. */
  const countSince = async (fromBlock: bigint) => {
    const logs = await localLogs(fromBlock);
    return logs.filter((log) => {
      if (log.topics[0] !== PACKET_SENT) return false;
      const [payload] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "address" }], log.data);
      const p = payload as Hex;
      return getAddress(slice(slice(p, 49, 81), 12)) === d.receiver && !delivered.has(slice(p, 81, 113));
    }).length;
  };
  const reportTime = async () => {
    const [r, ok] = await xl.readContract({ address: d.receiver, abi: receiverAbi, functionName: "latest", args: [RIG] });
    return ok ? Number(r.observedAt) : 0;
  };
  const loan = () => xl.readContract({ address: agent, abi: agentAbi, functionName: "loanOf" });

  /** Borrow `principal` for 7 days, paying the operating fee in OKB. */
  const borrow = async (principal: bigint) => {
    const fee = await xl.readContract({ address: d.pool, abi: poolAbi, functionName: "opsFee", args: [0] });
    const maxFee = await xl.readContract({ address: d.pool, abi: poolAbi, functionName: "fee", args: [0, principal] });
    await as("xl", borrower).writeContract({ address: agent, abi: borrowAbi, functionName: "borrow", args: [0, principal, maxFee, 0], value: fee });
    return fee;
  };

  /** Push on request for the agent, deliver it, and borrow `principal`. */
  const pushAndBorrow = async (principal: bigint) => {
    const mark = await bsc.getBlockNumber();
    const r = await push.request(agent, "1.2.3.4");
    if (r.status !== "queued") throw new Error(`push request ${r.status} ${r.reason ?? ""}`);
    if ((await deliverSince(mark)) !== 1) throw new Error("push on request did not land");
    return borrow(principal);
  };

  /** Stop `rig`'s miner on BSC, as its vault cell (the circuit owner) would. */
  const stopMiner = async (rig: bigint) => {
    const [circuits, circuitId] = await bsc.readContract({ address: ADDR.rigVault, abi: vaultAbi, functionName: "rigs", args: [rig] });
    const key = await bsc.readContract({ address: ADDR.podMining, abi: podAbi, functionName: "minerKey", args: [circuits, circuitId] });
    const cell = await bsc.readContract({ address: ADDR.rigVault, abi: vaultAbi, functionName: "cellOf", args: [key] });
    await bscTest.setBalance({ address: cell, value: parseEther("1") });
    await as("bsc", cell).writeContract({ address: ADDR.podMining, abi: stopAbi, functionName: "stop", args: [key] });
  };

  /**
   * Land every new harvest sent since `fromBlock` on the X Layer voucher, as the executor would: the
   * OFT credit is simulated with a BEM transfer, then the endpoint calls the voucher's `lzCompose`
   * with the message the OFT would compose (nonce | srcEid | amountLD | composeFrom | body).
   */
  const deliverHarvests = async (fromBlock: bigint) => {
    let landed = 0;
    const rate = await xl.readContract({ address: ADDR.bemXLayer, abi: oftAbi, functionName: "decimalConversionRate" });
    for (const log of await localLogs(fromBlock)) {
      if (log.topics[0] !== PACKET_SENT) continue;
      const [payload] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "address" }], log.data);
      const p = payload as Hex;
      if (getAddress(slice(slice(p, 13, 45), 12)) !== BEM_ADAPTER_BSC) continue;
      if (getAddress(slice(slice(p, 49, 81), 12)) !== getAddress(ADDR.bemXLayer)) continue;
      const guid = slice(p, 81, 113);
      if (delivered.has(guid)) continue;
      const message = slice(p, 113);
      if (getAddress(slice(slice(message, 0, 32), 12)) !== getAddress(ADDR.voucher)) continue; // not a harvest
      delivered.add(guid);
      const amountLD = BigInt(slice(message, 32, 40)) * rate;
      const compose = encodePacked(["uint64", "uint32", "uint256", "bytes"], [BigInt(slice(p, 1, 9)), Number(BigInt(slice(p, 9, 13))), amountLD, slice(message, 40)]);
      if (amountLD > 0n) await as("xl", BIG_HOLDER).writeContract({ address: ADDR.bemXLayer, abi: erc20, functionName: "transfer", args: [ADDR.voucher, amountLD] });
      await xlTest.setBalance({ address: ADDR.endpoint, value: parseEther("1") });
      await as("xl", ADDR.endpoint).writeContract({ address: ADDR.voucher, abi: composeAbi, functionName: "lzCompose", args: [ADDR.bemXLayer, guid, compose, zeroAddress, "0x"] });
      landed++;
    }
    return landed;
  };

  /** Give `to` BNB on the BSC fork (a miner who harvests from the app pays the LayerZero fee and gas). */
  const fundBnb = async (to: Address, wei: bigint) => {
    await bscTest.setBalance({ address: to, value: wei });
  };

  /** Harvest `ids` on BSC as an outside caller (the deployer), paying the fee plus 10%. */
  const harvest = async (ids: bigint[]) => {
    const fee = await bsc.readContract({ address: ADDR.rigVault, abi: vaultAbi, functionName: "quoteHarvest", args: [BigInt(ids.length)] });
    await as("bsc", DEPLOYER).writeContract({ address: ADDR.rigVault, abi: vaultAbi, functionName: "harvest", args: [ids], value: (fee * 11n) / 10n });
  };

  /** Give the keeper a BEM float on BSC (from the OFT adapter's locked BEM) for evidence-harvest bonds. */
  const fundKeeperBem = async (amount: bigint) => {
    await bscTest.setBalance({ address: BEM_ADAPTER_BSC, value: parseEther("1") });
    await as("bsc", BEM_ADAPTER_BSC).writeContract({ address: ADDR.bemBsc, abi: erc20, functionName: "transfer", args: [GUARDIAN, amount] });
  };

  /** Put BEM in `rig`'s vault cell on BSC (from the OFT adapter's locked BEM): output a later harvest collects, as mining adds it. */
  const fundCell = async (rig: bigint, amount: bigint) => {
    const [circuits, circuitId] = await bsc.readContract({ address: ADDR.rigVault, abi: vaultAbi, functionName: "rigs", args: [rig] });
    const key = await bsc.readContract({ address: ADDR.podMining, abi: podAbi, functionName: "minerKey", args: [circuits, circuitId] });
    const cell = await bsc.readContract({ address: ADDR.rigVault, abi: vaultAbi, functionName: "cellOf", args: [key] });
    await bscTest.setBalance({ address: BEM_ADAPTER_BSC, value: parseEther("1") });
    await as("bsc", BEM_ADAPTER_BSC).writeContract({ address: ADDR.bemBsc, abi: erc20, functionName: "transfer", args: [cell, amount] });
  };

  /** Give `to` BEM on X Layer from the big holder (a fork stand-in for bridging or buying it). */
  const fundBem = async (to: Address, amount: bigint) => {
    await as("xl", BIG_HOLDER).writeContract({ address: ADDR.bemXLayer, abi: erc20, functionName: "transfer", args: [to, amount] });
  };

  const stop = () => {
    for (const a of anvils) a.kill();
    rmSync(`${ROOT}/broadcast/AnvilStack.s.sol`, { recursive: true, force: true });
  };

  return {
    bsc, xl, bscTest, xlTest, as, d, agent, borrower, clock, sync, holder, makeKeeper, push, alertsSeen,
    deliverSince, countSince, reportTime, loan, borrow, pushAndBorrow, stopMiner, harvest, deliverHarvests, fundKeeperBem, fundCell, stop,
    // for the app's end-to-end tests
    cfg, clients, senders, policy, poolBlock, makePush, deliverOnce, startRelay, exclusive, fundBem, openBorrowerAgent, now: nowSec,
    // the move gate of the app: one chain at a time, BNB for the miner, and the harvests landed inside `exclusive`
    xlAt, bscAt, bscFinalize, headTimes, fundBnb, landHarvests: (fromBlock: bigint) => exclusive(() => deliverHarvests(fromBlock)),
  };
}

/** Part (a) of the setup alone: forks, stack, funding, lender, rig #16's screen pass, both clocks at LOAN_TIME. The miner opens the agent. */
export function startBase(bscPort: number, xlPort: number, opts: Omit<StackOpts, "openAgent"> = {}) {
  return startStack(bscPort, xlPort, { ...opts, openAgent: false });
}
