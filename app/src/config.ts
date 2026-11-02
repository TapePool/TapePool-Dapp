import { getAddress, isAddress } from 'viem/utils';
import type { Address } from './model';

/** Links the screens point to. */
export const EXPLORER = 'https://www.oklink.com/xlayer';
export const explorerAddress = (a: string): string => `${EXPLORER}/address/${a}`;

/** Where a miner harvests by hand, and the one confirmed TapePool handle. */
export const TAPEOUT_URL = 'https://tapeout.net';
export const TWITTER_URL = 'https://x.com/Tape_Pool';

/* ───────── address book (SPEC-PHASE5-APP §3) ───────── */

/** Pinned constants copied from CLAUDE.md; test/config.test.ts checks them against it. Nothing on chain or in a URL can change them. */
export interface AddressBook {
  network: 'mainnet' | 'fork' | 'redeploy';
  /** Selects the bounded borrow and the new pool reads. */
  redeploy?: boolean;
  lens?: Address;
  factoryDeployBlock?: bigint;
  reporterDeployBlock?: bigint;
  chainId: 196;
  bscChainId: 56;
  /** X Layer. */
  pool: Address;
  factory: Address;
  policy: Address;
  screen: Address;
  receiver: Address;
  voucher: Address;
  bem: Address;
  /** BSC. */
  reporter: Address;
  bscVault: Address;
  podMining: Address;
  /** BEM on BSC, and the OFT adapter that bridges it (`feeBps()` is its bridge fee). */
  bemBsc: Address;
  bemAdapter: Address;
  /**
   * The implementations behind the vault (BSC) and the voucher (X Layer) proxies that the harvest-first rules were reviewed against
   * (SPEC-PHASE5-PRELOAN P8). The TapeOut Safe can upgrade both; harvest from here is off while a slot holds anything else.
   */
  implVault: Address;
  implVoucher: Address;
  /** On both chains. */
  multicall3: Address;
  /** First block of the pool's code: where history searches start (73,824,866 is RigScreen's). */
  poolDeployBlock: bigint;
}

export const MAINNET: AddressBook = {
  network: 'mainnet',
  chainId: 196,
  bscChainId: 56,
  pool: '0xD54673E73448584E86C61f45203ab507F3F2c3eC',
  factory: '0xC365a30740c17b93fE92581667A2d60bD4b92355',
  policy: '0xBfE81f1e0D91e8D2C03ce4A015e9E096558f561D',
  screen: '0xc336C0a710e99D5BD72417B35f0E70Cff063918C',
  receiver: '0x8bd22956fdcfebA48dD37a4fB4c33b226273b4b6',
  voucher: '0x9cfc959cd42B2e1d39a0d850c528210E818AE520',
  bem: '0x60e62Efa9405d6873C5deaBD4E6CC91c25363952',
  reporter: '0xCdD7E66c51633255C944DDC43dAe7285a300f1B7',
  bscVault: '0x48D43345656f0f9510dC3c06CBa99dFf597617C2',
  podMining: '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46',
  bemBsc: '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',
  bemAdapter: '0xa84B8D3893De6e9922f2B29bE1e1b115845F5E72',
  implVault: '0xeB3F0614e37d995a96fA41908de8D47A57F56463',
  implVoucher: '0x66FB7d52C4931B48776D9019f88F7f58fB0d85E1',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  poolDeployBlock: 73_824_872n,
};

/* ───────── configuration ───────── */

// The redeployed stack (redeploy 3, 2026-11-02, docs/redeploy-3/deploy-log.md); select with VITE_NETWORK=redeploy.
// MAINNET stays the default until the coordinator completes the cutover checks.
// Redeploy 3 (docs/SPEC-REDEPLOY-3.md RC3-01, RD3-10): after RD3-04 the deploy runbook replaced `pool`, `factory`,
// `policy`, `screen`, `lens`, `factoryDeployBlock` and `poolDeployBlock` with the new stack. `receiver`, `reporter`
// and `reporterDeployBlock` stay: the feed is reused. test/config.test.ts checks this book against the latest
// DeployPool broadcast. The redeploy 3 reads (`feedEnabledAt`, `FEED_SETTLE`) only drive the settling note, so a
// failed read hides it and nothing else.
export const REDEPLOY: AddressBook | null = {
  network: 'redeploy',
  redeploy: true,
  chainId: 196,
  bscChainId: 56,
  pool: '0x68c1D5e6f193cE5a5060BF7540Ae391cbC1939ca',
  factory: '0xCB63a96929A28b2F826cD9d5eA67b6f4D200C3B8',
  policy: '0x8983589e7575738c54339e6BDaddb63375EbFF23',
  screen: '0x3ed768Ba7A72Ce8E9091097ED93616C2560f3ddf',
  receiver: '0xB96847a3af4C9eC658cDC77dB98801AF399cFA1d',
  voucher: '0x9cfc959cd42B2e1d39a0d850c528210E818AE520',
  bem: '0x60e62Efa9405d6873C5deaBD4E6CC91c25363952',
  reporter: '0x24b5a7CA358Af29C51d16F801BbEcF746247AF0e',
  bscVault: '0x48D43345656f0f9510dC3c06CBa99dFf597617C2',
  podMining: '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46',
  bemBsc: '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',
  bemAdapter: '0xa84B8D3893De6e9922f2B29bE1e1b115845F5E72',
  implVault: '0xeB3F0614e37d995a96fA41908de8D47A57F56463',
  implVoucher: '0x66FB7d52C4931B48776D9019f88F7f58fB0d85E1',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  lens: '0xa66148be3353D85a5b4B028862C5EE9987dd0D84',
  factoryDeployBlock: 74_859_490n,
  reporterDeployBlock: 130_864_778n,
  poolDeployBlock: 74_859_491n,
};

export interface AppConfig {
  book: AddressBook;
  /** Public endpoints only. A keyed URL never goes here (SPEC-PHASE5-APP §3). */
  rpc: { xlayer: string; bsc: string };
  /** Base URL of the keeper's routes, without a trailing slash; null when there is none. */
  keeperUrl: string | null;
  /** Required on the redeploy; null uses the frozen legacy runtime only on the old stack. */
  tapeLens: Address | null;
}

export const PUBLIC_RPC = { xlayer: 'https://rpc.xlayer.tech', bsc: 'https://bsc-dataseed.bnbchain.org' } as const;

/** A keeper URL must be https, or http on a local host. Anything else reads as "no keeper". */
export function cleanKeeperUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * The text of `test/fork-addresses.json`, put into the bundle at build time when `VITE_NETWORK=fork` (vite.config.ts), and
 * null in every other build. The e2e setup writes the file after it has deployed a fresh stack on two local anvil forks.
 */
declare const __TP_FORK__: string | null | undefined;
const forkBookText = (): string | null => (typeof __TP_FORK__ === 'string' ? __TP_FORK__ : null);

const FORK_ADDRESSES = ['pool', 'factory', 'policy', 'screen', 'receiver', 'voucher', 'bem', 'reporter', 'bscVault', 'podMining', 'bemBsc', 'bemAdapter', 'implVault', 'implVoucher', 'multicall3'] as const;
const LOCAL_RPC = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/;

/**
 * The address book and the RPC URLs of the two local forks. Everything is checked: a fork build talks only to
 * a local node, so a mistaken file can never point it at a real network.
 */
export function parseForkBook(text: string | null): { book: AddressBook; rpc: { xlayer: string; bsc: string } } {
  if (text === null) throw new Error('VITE_NETWORK=fork needs test/fork-addresses.json at build time; the e2e setup writes it');
  const j = JSON.parse(text) as Record<string, unknown>;
  const addr = (k: string): Address => {
    const v = j[k];
    if (typeof v !== 'string' || !isAddress(v, { strict: false })) throw new Error(`fork-addresses.json: ${k} is not an address`);
    return getAddress(v) as Address;
  };
  const rpc = j.rpc as { xlayer?: unknown; bsc?: unknown } | undefined;
  if (typeof rpc?.xlayer !== 'string' || typeof rpc.bsc !== 'string' || !LOCAL_RPC.test(rpc.xlayer) || !LOCAL_RPC.test(rpc.bsc)) throw new Error('fork-addresses.json: rpc must be two local http URLs');
  if (typeof j.poolDeployBlock !== 'string' || !/^\d+$/.test(j.poolDeployBlock)) throw new Error('fork-addresses.json: poolDeployBlock must be a decimal string');
  const book = { network: 'fork', chainId: 196, bscChainId: 56, poolDeployBlock: BigInt(j.poolDeployBlock) } as AddressBook;
  for (const k of FORK_ADDRESSES) (book as unknown as Record<string, unknown>)[k] = addr(k);
  book.redeploy = j.redeploy === true;
  if (book.redeploy) {
    book.lens = addr('lens');
    for (const k of ['factoryDeployBlock', 'reporterDeployBlock'] as const) {
      if (typeof j[k] !== 'string' || !/^\d+$/.test(j[k])) throw new Error(`fork-addresses.json: ${k} must be a decimal string`);
      book[k] = BigInt(j[k]);
    }
  }
  return { book, rpc: { xlayer: rpc.xlayer, bsc: rpc.bsc } };
}

export function readConfig(env: { VITE_NETWORK?: string; VITE_KEEPER_URL?: string; VITE_TAPELENS_ADDRESS?: string }, forkText: string | null = forkBookText(), redeployBook: AddressBook | null = REDEPLOY): AppConfig {
  const network = env.VITE_NETWORK ?? 'mainnet';
  if (network !== 'mainnet' && network !== 'fork' && network !== 'redeploy') throw new Error(`VITE_NETWORK=${network}: only mainnet, redeploy and fork exist`);
  const lens = env.VITE_TAPELENS_ADDRESS?.trim();
  const tapeLens = lens && isAddress(lens) ? (lens as Address) : null;
  if (network === 'fork') {
    const f = parseForkBook(forkText);
    return { book: f.book, rpc: f.rpc, keeperUrl: cleanKeeperUrl(env.VITE_KEEPER_URL), tapeLens: f.book.lens ?? tapeLens };
  }
  if (network === 'redeploy') {
    if (!redeployBook?.redeploy || !redeployBook.lens || redeployBook.poolDeployBlock <= 0n || !redeployBook.factoryDeployBlock || !redeployBook.reporterDeployBlock) throw new Error('The redeploy address book, lens and deployment blocks must be configured before cutover');
    return { book: redeployBook, rpc: { ...PUBLIC_RPC }, keeperUrl: cleanKeeperUrl(env.VITE_KEEPER_URL), tapeLens: redeployBook.lens };
  }
  return { book: MAINNET, rpc: { ...PUBLIC_RPC }, keeperUrl: cleanKeeperUrl(env.VITE_KEEPER_URL), tapeLens };
}
