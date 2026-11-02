import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, keccak256, parseAbi, parseEther, type Address, type Hex } from 'viem';
import { bscVaultAbi, podMiningAbi, tapeLensAbi } from '../../src/chain/abi';
import { ADDR, EXPECTED_IMPL } from '../../../keeper/src/addresses';
import { startHttp } from '../../../keeper/src/http';
import { ReadLimiter } from '../../../keeper/src/logic/readLimits';
import type { PushService } from '../../../keeper/src/push';
import { emptyState, saveState } from '../../../keeper/src/state';
import { BEM_ADAPTER_BSC, HOLDER_C905, OWNER, RELAY, startBase } from '../../../keeper/test/anvil/harness';

/**
 * The setup of the fork end-to-end tests (SPEC-PHASE5-APP §14.2). One call starts, in this process:
 *   - two anvil forks (BSC and X Layer) with a fresh stack, a pool seeded with 15 of the 20 BEM its supply cap allows, a lender
 *     with 5 BEM, and the miner who holds rig #16 (the harness, part (a); the miner opens the agent through the UI);
 *   - the relay that lands report packets on X Layer for the whole run;
 *   - the keeper, in process, with the forks' clock, stub alerts, a guardian that signs through auto-impersonation, and its
 *     HTTP routes on a local port (CORS for the preview origin only);
 *   - the app, built for the forks (`VITE_NETWORK=fork`) and served from a small static server.
 * Nothing here touches a real chain except the read-only fork source, and no key exists anywhere.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(here, '..', '..');

export const PORTS = { bsc: 8845, xlayer: 8846, keeper: 8847, app: 8848 } as const;
export const HOST = '127.0.0.1';
export const APP_ORIGIN = `http://${HOST}:${PORTS.app}`;
export const KEEPER_URL = `http://${HOST}:${PORTS.keeper}`;
export const RPC = { xlayer: `http://${HOST}:${PORTS.xlayer}`, bsc: `http://${HOST}:${PORTS.bsc}` } as const;

export const LENDER = '0x7e57000000000000000000000000000000000006' as Address;
/** The second rig of the grouped loan (SPEC-PHASE5-APP §14.2) and the voucher id the harness hard-codes for rig #16's task. */
export const RIG_B = 5n;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

/** The Content-Security-Policy the app is meant to run under (SPEC-PHASE5-APP §10), with the local RPCs and keeper in `connect-src`. */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${RPC.xlayer} ${RPC.bsc} ${KEEPER_URL}`,
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const pass = parseAbi(['function recordPass(uint256 rigId, address circuits, uint64 circuitId, uint32 taskId, bytes32 artifactHash)']);
const voucher = parseAbi(['function transferFrom(address from, address to, uint256 id)', 'function ownerOf(uint256 id) view returns (address)']);

export type Stack = Awaited<ReturnType<typeof startBase>>;

export interface E2e {
  s: Stack;
  lens: Address;
  /** The miner: the holder of rig #16 at the fork block. */
  miner: Address;
  lender: Address;
  /** The keeper's cycle, run only when a scenario asks for it, so a keeper job never races a UI action. */
  cycle(): Promise<void>;
  /** Swap in a fresh push limiter (every request comes from 127.0.0.1, so the per-IP and per-day counts would otherwise fill up). */
  freshPushLimits(): void;
  /** Move both forks and the keeper clock together. */
  sync(ts: number): Promise<void>;
  now(): number;
  /** Give the miner the aged second rig and record its screen pass, then move past the pass's 48 hours. */
  addSecondRig(): Promise<void>;
  /** Everything the keeper's alerts said. */
  alerts: string[];
  stop(): Promise<void>;
}

function runVite(outDir: string): void {
  const vite = path.join(APP_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  execFileSync(process.execPath, [vite, 'build', '--logLevel', 'warn'], {
    cwd: APP_ROOT,
    env: { ...process.env, VITE_NETWORK: 'fork', VITE_KEEPER_URL: KEEPER_URL, TP_OUT_DIR: outDir },
    stdio: 'inherit',
  });
}

function serve(root: string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', APP_ORIGIN);
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) file = path.join(root, 'index.html');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORTS.app, HOST, () => resolve(server)));
}

export async function startE2e(): Promise<E2e> {
  if (!process.env.BSC_RPC) throw new Error('the fork e2e needs BSC_RPC (an archive endpoint) in the environment');

  // 1. forks and the fresh stack; the lender holds 15 of the 20 BEM the supply cap allows, so a UI supply has room
  const s = await startBase(PORTS.bsc, PORTS.xlayer, { lpSeed: 1_500_000_000n, liveClock: true, relay: RELAY });
  const miner = s.borrower;
  await s.xlTest.setBalance({ address: LENDER, value: parseEther('10') });
  await s.fundBem(LENDER, 500_000_000n);
  await s.xlTest.setBalance({ address: miner, value: parseEther('10') });

  const artifact = JSON.parse(fs.readFileSync(path.join(APP_ROOT, '..', 'out', 'TapeLens.sol', 'TapeLens.json'), 'utf8')) as { bytecode: { object: Hex } };
  const deployment = await s.as('xl', OWNER).deployContract({ abi: tapeLensAbi, bytecode: artifact.bytecode.object });
  const lensReceipt = await s.xl.waitForTransactionReceipt({ hash: deployment });
  if (!lensReceipt.contractAddress || !s.d.reporterDeployBlock) throw new Error('The redeploy fork needs the deployed lens and reporter block');
  const lens = getAddress(lensReceipt.contractAddress);

  // 2. the fork address book the app is built with
  const book = {
    redeploy: true,
    lens,
    pool: s.d.pool,
    factory: s.d.factory,
    policy: s.policy,
    screen: s.d.screen,
    receiver: s.d.receiver,
    voucher: ADDR.voucher,
    bem: ADDR.bemXLayer,
    reporter: s.d.reporter,
    bscVault: ADDR.rigVault,
    podMining: ADDR.podMining,
    // BEM mined before a loan: BEM and its OFT adapter on BSC, and the implementations behind the vault and the voucher (the forks hold the real ones)
    bemBsc: ADDR.bemBsc,
    bemAdapter: BEM_ADAPTER_BSC,
    implVault: EXPECTED_IMPL.rigVault,
    implVoucher: EXPECTED_IMPL.voucher,
    multicall3: ADDR.multicall3,
    poolDeployBlock: s.poolBlock.toString(),
    factoryDeployBlock: s.d.factoryDeployBlock.toString(),
    reporterDeployBlock: s.d.reporterDeployBlock.toString(),
    rpc: RPC,
  };
  fs.writeFileSync(path.join(APP_ROOT, 'test', 'fork-addresses.json'), `${JSON.stringify(book, null, 2)}\n`);

  // 3. the relay for the whole run, then the keeper in process
  const relay = await s.startRelay();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-e2e-'));
  const statePath = path.join(tmp, 'state.json');
  const keeper = s.makeKeeper(emptyState(s.d.factoryDeployBlock, s.d.factory), { ...s.d, poolDeployBlock: s.poolBlock });
  s.holder.keeper = keeper;
  const cycle = async () => {
    await s.holder.keeper.cycle();
    saveState(statePath, s.holder.keeper.state);
  };
  // /v1/stats answers 503 until a first cycle has run, and the browser logs that as a console error: one cycle, with nothing to do
  await cycle();
  const current = { push: s.makePush({}) };
  const pushProxy = { request: (agent: unknown, ip: string) => current.push.request(agent, ip) } as unknown as PushService;
  const permissive = { admit: () => ({ ok: true as const }) } as unknown as ReadLimiter;
  const keeperHttp = startHttp(PORTS.keeper, [APP_ORIGIN], pushProxy, () => ({ ok: true }), s.holder.keeper.publicData ?? undefined, permissive);

  // 4. the app, built for the forks, and its static server
  const outDir = path.join(APP_ROOT, 'dist-fork');
  runVite(outDir);
  const appServer = await serve(outDir);

  const e2e: E2e = {
    s,
    lens,
    miner,
    lender: LENDER,
    cycle,
    freshPushLimits: () => {
      current.push = s.makePush({});
    },
    sync: (ts) => s.sync(ts),
    now: () => s.now(),
    async addSecondRig() {
      // the aged second rig goes to the miner by impersonation
      const owner = getAddress(await s.xl.readContract({ address: ADDR.voucher, abi: voucher, functionName: 'ownerOf', args: [RIG_B] }));
      if (owner.toLowerCase() === HOLDER_C905.toLowerCase()) {
        await s.as('xl', HOLDER_C905).writeContract({ address: ADDR.voucher, abi: voucher, functionName: 'transferFrom', args: [HOLDER_C905, miner, RIG_B] });
      }
      // the pass is recorded with what PodMining says about the rig's miner: processor, circuit id and task id
      const [circuits, circuitId] = await s.bsc.readContract({ address: ADDR.rigVault, abi: bscVaultAbi, functionName: 'rigs', args: [RIG_B] });
      const key = await s.bsc.readContract({ address: ADDR.podMining, abi: podMiningAbi, functionName: 'minerKey', args: [circuits, circuitId] });
      const m = await s.bsc.readContract({ address: ADDR.podMining, abi: podMiningAbi, functionName: 'getMiner', args: [key] });
      await s.as('xl', OWNER).writeContract({ address: s.d.screen, abi: pass, functionName: 'recordPass', args: [RIG_B, m.circuits, m.circuitId, m.taskId, keccak256('0x05')] });
      // both clocks past the 48 hours the pass waits
      await s.sync(s.now() + 49 * 3_600);
    },
    alerts: s.alertsSeen,
    async stop() {
      await relay.stop();
      keeperHttp.close();
      appServer.close();
      s.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(path.join(APP_ROOT, 'test', 'fork-addresses.json'), { force: true });
    },
  };
  return e2e;
}

