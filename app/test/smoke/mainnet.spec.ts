import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { extractMeta, hostHeaders } from '../../scripts/lib/csp.mjs';

/**
 * Read-only smoke test of the mainnet builds (SPEC-PHASE5-APP §14.3). For the multi-file build and the single-file build:
 * Markets, the BEM pool page and the read-only view of rig #16's holder (and its Rigs page) must load real data from the public
 * RPCs with no console error, no page error, no failed request, no Content-Security-Policy violation, no request to anything
 * but the two RPCs, and no JSON-RPC method that could change state. No wallet exists in the page and nothing is signed.
 *
 * The builds are made here, in a clean environment (no VITE_* settings, no BSC_RPC), into .cache/smoke. Each is served with the
 * response headers that app/README.md asks a host to send, so the headers are tested together with the page's own meta policy.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const OUT = path.join(ROOT, '.cache', 'smoke');
const HOLDER = '0x65C0eC42E1dB3a92727ccD3cb3aF3aCb1b97C8dF';
const RPC_ORIGINS = ['https://rpc.xlayer.tech', 'https://bsc-dataseed.bnbchain.org'];
/** Methods the app may call in these views. Anything else (above all eth_sendTransaction, eth_sendRawTransaction, eth_requestAccounts) fails the test. */
const READ_METHODS = new Set(['eth_call', 'eth_getBlockByNumber', 'eth_blockNumber', 'eth_chainId', 'eth_gasPrice', 'eth_getCode', 'eth_getLogs', 'eth_getBalance', 'eth_getStorageAt', 'eth_estimateGas', 'net_version']);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('VITE_') || k.startsWith('TP_') || k === 'BSC_RPC') delete env[k];
  return env;
}

function serve(root: string): Promise<{ origin: string; close(): void }> {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const csp = extractMeta(html);
  if (!csp) throw new Error('the build has no Content-Security-Policy meta tag');
  const headers = hostHeaders(csp);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() })));
}

interface Watch {
  problems: string[];
  methods: Map<string, number>;
}

/** Collect everything a clean run must not have, and every JSON-RPC method the page sends. */
function watch(page: Page, origin: string): Watch {
  const w: Watch = { problems: [], methods: new Map() };
  page.on('console', (m) => m.type() === 'error' && w.problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => w.problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => r.failure()?.errorText !== 'net::ERR_ABORTED' && w.problems.push(`requestfailed: ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => r.status() >= 400 && w.problems.push(`response ${r.status()}: ${r.request().method()} ${r.url()}`));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol === 'data:') return;
    if (u.origin !== origin && !RPC_ORIGINS.includes(u.origin)) w.problems.push(`request to an unexpected origin: ${u.origin}`);
    if (RPC_ORIGINS.includes(u.origin) && r.method() === 'POST') {
      try {
        const body = JSON.parse(r.postData() ?? 'null') as unknown;
        for (const call of Array.isArray(body) ? body : [body]) {
          const method = String((call as { method?: unknown } | null)?.method);
          w.methods.set(method, (w.methods.get(method) ?? 0) + 1);
        }
      } catch {
        w.problems.push(`a request to ${u.origin} that is not JSON`);
      }
    }
  });
  return w;
}

function finish(w: Watch): void {
  expect(w.problems, 'a clean run has no console error, page error, failed request, CSP violation or unexpected request').toEqual([]);
  const bad = [...w.methods.keys()].filter((m) => !READ_METHODS.has(m));
  expect(bad, 'only read-only JSON-RPC methods').toEqual([]);
  expect(w.methods.size, 'the page did read the chain').toBeGreaterThan(0);
}

const builds: { name: string; dir: string }[] = [
  { name: 'multi-file build', dir: path.join(OUT, 'multi') },
  { name: 'single-file build', dir: path.join(OUT, 'single') },
];
const servers: { close(): void }[] = [];
const origins = new Map<string, string>();

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  execFileSync(process.execPath, [vite, 'build', '--logLevel', 'warn'], { cwd: ROOT, env: { ...cleanEnv(), TP_OUT_DIR: builds[0]!.dir }, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-single.mjs'), '--out', builds[1]!.dir], { cwd: ROOT, env: cleanEnv(), stdio: 'inherit' });
  for (const b of builds) {
    const s = await serve(b.dir);
    servers.push(s);
    origins.set(b.name, s.origin);
  }
});

test.afterAll(() => {
  for (const s of servers) s.close();
});

for (const b of builds) {
  test.describe(b.name, () => {
    const open = async (page: Page, hash: string): Promise<Watch> => {
      const w = watch(page, origins.get(b.name)!);
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
      });
      await page.goto(`${origins.get(b.name)}/#${hash}`);
      expect(await page.evaluate(() => typeof (window as unknown as { ethereum?: unknown }).ethereum), 'no wallet in the page').toBe('undefined');
      return w;
    };

    test('Markets shows the live pool', async ({ page }) => {
      const w = await open(page, '/app/markets');
      await expect(page.getByRole('heading', { name: 'Markets' }).or(page.getByText('Lend BEM to TapeOut miners and earn the fees they pay.'))).toBeVisible();
      // a real total, read from the chain: "x.xxxx BEM", not the "—" a failed read leaves
      await expect(page.getByText('Total supply').first()).toBeVisible();
      await expect(page.locator('body')).toContainText(/Total supply\s*\n?\s*\d+\.\d{4} BEM/);
      await expect(page.locator('body')).toContainText('TapePool · on X Layer');
      await expect(page.locator('body')).toContainText('Coming soon');
      finish(w);
    });

    test('the BEM pool page shows the pool, the terms and the credit rule', async ({ page }) => {
      const w = await open(page, '/app/markets/bem');
      await expect(page.locator('body')).toContainText('BEM pool');
      await expect(page.locator('body')).toContainText(/of the \d+\.\d{4} BEM supply cap/);
      await expect(page.locator('body')).toContainText(/tpBEM value\s*\n?\s*\d+\.\d{4} BEM/);
      await expect(page.locator('body')).toContainText('Netlist hash');
      finish(w);
    });

    test("the read-only view of rig #16's holder", async ({ page }) => {
      const w = await open(page, `/app/view/${HOLDER}`);
      await expect(page.locator('body')).toContainText('Read-only view of 0x65C0…C8dF');
      await expect(page.locator('body')).toContainText('Actions are turned off');
      await expect(page.locator('body')).toContainText(/Pool room for you\s*\n?\s*\d+\.\d{4} BEM/);
      finish(w);
    });

    test('the Rigs page of that view lists the rig', async ({ page }) => {
      const w = await open(page, `/app/view/${HOLDER}/rigs`);
      await expect(page.locator('body')).toContainText('Read-only view of 0x65C0…C8dF');
      await expect(page.locator('body')).toContainText('#16');
      await expect(page.locator('body')).toContainText('TapeOut');
      finish(w);
    });
  });
}
