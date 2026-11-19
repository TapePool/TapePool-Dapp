import fs from 'node:fs';
import path from 'node:path';
import { isAddress } from 'viem/utils';
import { describe, expect, it } from 'vitest';
import { MAINNET, PUBLIC_RPC, REDEPLOY, readConfig } from '../src/config';
import { IMPLEMENTATION_SLOT } from '../src/constants';

const REPO = path.resolve(__dirname, '..', '..');
// CLAUDE.md holds internal notes and is not in every checkout: the checks against it skip where it is absent.
const claudePath = path.join(REPO, 'CLAUDE.md');
const claude = fs.existsSync(claudePath) ? fs.readFileSync(claudePath, 'utf8') : '';
const lineWith = (re: RegExp): string => claude.split('\n').find((l) => re.test(l)) ?? '';

describe('the address book', () => {
  it('has only checksummed addresses', () => {
    for (const [k, v] of Object.entries(MAINNET)) {
      if (typeof v === 'string' && v.startsWith('0x')) expect(isAddress(v, { strict: true }), k).toBe(true);
    }
  });

  it.skipIf(claude === '')('matches the redeploy 4 tables of CLAUDE.md, row by row', () => {
    expect(REDEPLOY).not.toBeNull();
    const rows: [string, RegExp, string][] = [
      ['voucher', /RIG voucher \(UUPS proxy/, REDEPLOY!.voucher],
      ['bem', /\| BEM OFT \| X Layer/, REDEPLOY!.bem],
      ['pool', /`TapePool` \(tpBEM\)/, REDEPLOY!.pool],
      ['factory', /Tape Pool contracts\*\* \(redeploy 4, deployed/, REDEPLOY!.factory],
      ['policy', /Tape Pool contracts\*\* \(redeploy 4, deployed/, REDEPLOY!.policy],
      ['screen', /Tape Pool contracts\*\* \(redeploy 4, deployed/, REDEPLOY!.screen],
      ['lens', /Tape Pool contracts\*\* \(redeploy 4, deployed/, REDEPLOY!.lens!],
      ['receiver', /Tape Pool rig data feed/, REDEPLOY!.receiver],
      ['reporter', /Tape Pool rig data feed/, REDEPLOY!.reporter],
      ['bscVault', /Rig vault \(`harvest\(ids\)`/, REDEPLOY!.bscVault],
      ['podMining', /PodMining \(sealed proxy\)/, REDEPLOY!.podMining],
      ['bemBsc', /\| BEM token \| BSC/, REDEPLOY!.bemBsc],
      ['bemAdapter', /\| BEM OFT adapter \| BSC/, REDEPLOY!.bemAdapter],
      ['implVoucher', /RIG voucher \(UUPS proxy/, REDEPLOY!.implVoucher],
    ];
    for (const [name, row, address] of rows) {
      const line = lineWith(row);
      expect(line, `${name}: row not found in CLAUDE.md`).not.toBe('');
      expect(line.toLowerCase(), name).toContain(address.toLowerCase());
    }
  });

  it('pins the legacy book independently and uses the redeploy blocks CLAUDE.md gives', () => {
    expect(MAINNET).toEqual({
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
    });
    if (claude !== '') expect(lineWith(/Tape Pool contracts\*\* \(redeploy 4, deployed/)).toContain('blocks 76,074,240–76,074,248');
    expect(REDEPLOY!.factoryDeployBlock).toBe(76_074_244n);
    expect(REDEPLOY!.poolDeployBlock).toBe(76_074_246n);
    if (claude !== '') expect(lineWith(/Tape Pool rig data feed/)).toContain('block 133,949,050');
    expect(REDEPLOY!.reporterDeployBlock).toBe(133_949_050n);
    const keeperAddresses = fs.readFileSync(path.join(REPO, 'keeper', 'src', 'addresses.ts'), 'utf8');
    expect(keeperAddresses).toContain(MAINNET.multicall3);
  });

  it("pins the implementations the harvest rules were reviewed against to the keeper's own (SPEC-PHASE5-PRELOAN P8)", () => {
    const keeperAddresses = fs.readFileSync(path.join(REPO, 'keeper', 'src', 'addresses.ts'), 'utf8');
    expect(keeperAddresses).toContain(MAINNET.implVault);
    expect(keeperAddresses).toContain(MAINNET.implVoucher);
    expect(keeperAddresses).toContain(IMPLEMENTATION_SLOT);
  });

  it('agrees with the deployment script output, when the file is there', () => {
    const file = path.join(REPO, 'broadcast', 'DeployPool.s.sol', '196', 'run-latest.json');
    if (!fs.existsSync(file)) return; // untracked: skipped where it is absent
    const run = JSON.parse(fs.readFileSync(file, 'utf8')) as { transactions: { contractName: string; contractAddress: string }[] };
    const by = (n: string): string => (run.transactions.find((t) => t.contractName === n)?.contractAddress ?? '').toLowerCase();
    // the last broadcast is either the first deployment or the redeploy: its book must match it address by address
    const book = by('TapePool') === MAINNET.pool.toLowerCase() ? MAINNET : REDEPLOY;
    expect(book, 'the broadcast pool is in no configured book').not.toBeNull();
    expect(by('TapePool')).toBe(book!.pool.toLowerCase());
    expect(by('AgentFactory')).toBe(book!.factory.toLowerCase());
    expect(by('CreditPolicy')).toBe(book!.policy.toLowerCase());
    expect(by('RigScreen')).toBe(book!.screen.toLowerCase());
    if (book!.lens) expect(by('TapeLens')).toBe(book!.lens.toLowerCase());
  });
});

describe('the configuration', () => {
  it('defaults to mainnet, the two public RPCs, no keeper and no deployed TapeLens', () => {
    const c = readConfig({});
    expect(c.book).toBe(MAINNET);
    expect(c.rpc).toEqual({ xlayer: 'https://rpc.xlayer.tech', bsc: 'https://bsc-dataseed.bnbchain.org' });
    expect(c.keeperUrl).toBeNull();
    expect(c.tapeLens).toBeNull();
  });

  it('takes a keeper URL and a deployed TapeLens from the environment, checked', () => {
    const lens = '0x00000000000000000000000000000000000fe115';
    expect(readConfig({ VITE_KEEPER_URL: 'https://keeper.example/', VITE_TAPELENS_ADDRESS: lens })).toMatchObject({ keeperUrl: 'https://keeper.example', tapeLens: lens });
    expect(readConfig({ VITE_KEEPER_URL: 'http://evil.example', VITE_TAPELENS_ADDRESS: '0x12' })).toMatchObject({ keeperUrl: null, tapeLens: null });
  });

  it('refuses a network it has no address book for, and a fork build without its book', () => {
    expect(() => readConfig({ VITE_NETWORK: 'sepolia' })).toThrow(/only mainnet, redeploy and fork/);
    expect(() => readConfig({ VITE_NETWORK: 'fork' }, null)).toThrow(/fork-addresses\.json/);
  });

  describe('the fork address book', () => {
    const addr = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
    const book = {
      pool: addr(1),
      factory: addr(2),
      policy: addr(3),
      screen: addr(4),
      receiver: addr(5),
      voucher: addr(6),
      bem: addr(7),
      reporter: addr(8),
      bscVault: addr(9),
      podMining: addr(10),
      bemBsc: addr(12),
      bemAdapter: addr(13),
      implVault: addr(14),
      implVoucher: addr(15),
      multicall3: addr(11),
      poolDeployBlock: '73558390',
      rpc: { xlayer: 'http://127.0.0.1:8546', bsc: 'http://127.0.0.1:8545' },
    };

    it('is read from the JSON the e2e setup writes, with local RPCs and the same chain ids', () => {
      const c = readConfig({ VITE_NETWORK: 'fork', VITE_KEEPER_URL: 'http://127.0.0.1:8790' }, JSON.stringify(book));
      expect(c.book).toMatchObject({ network: 'fork', chainId: 196, bscChainId: 56, poolDeployBlock: 73_558_390n });
      expect(c.book.pool.toLowerCase()).toBe(book.pool);
      expect(c.rpc).toEqual(book.rpc);
      expect(c.keeperUrl).toBe('http://127.0.0.1:8790');
    });

    it('refuses a book with a bad address, a missing block or an RPC that is not local', () => {
      const bad = (patch: object): (() => unknown) => () => readConfig({ VITE_NETWORK: 'fork' }, JSON.stringify({ ...book, ...patch }));
      expect(bad({ pool: '0x12' })).toThrow(/pool is not an address/);
      expect(bad({ poolDeployBlock: 'x' })).toThrow(/poolDeployBlock/);
      expect(bad({ rpc: { xlayer: 'https://rpc.xlayer.tech', bsc: 'http://127.0.0.1:8545' } })).toThrow(/two local http URLs/);
      expect(bad({ rpc: { xlayer: 'http://127.0.0.1:8546', bsc: 'http://evil.example:8545' } })).toThrow(/two local http URLs/);
    });

    it('is ignored by a mainnet build, whatever the define holds', () => {
      expect(readConfig({}, JSON.stringify(book)).book).toBe(MAINNET); // the book is only read when VITE_NETWORK=fork
    });
  });

  it('has no keyed RPC URL anywhere in the source (SPEC-PHASE5-APP §3)', () => {
    const bad = /quiknode|alchemy|infura|\/v2\/|\?key=|apikey/i;
    expect(JSON.stringify(PUBLIC_RPC)).not.toMatch(bad);
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
    for (const f of walk(path.resolve(__dirname, '..', 'src'))) expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(bad);
  });
});
