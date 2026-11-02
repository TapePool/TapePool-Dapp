import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeFunctionData, getAddress } from 'viem';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { extractMeta, hashSource, hostHeaders, injectMeta, originOf, parse, policy, replaceMeta, serialize } from '../scripts/lib/csp.mjs';
import { ABI, SUBMISSION_DEADLINE, TARGET, buildPlan, castScript, gatewayHost, gatewayOpenHost, landing, nameOf, offlineState, planTotals, sameFile } from '../scripts/lib/deweb.mjs';
import {
  ALLOWED_HOSTS,
  BUDGET_BYTES,
  CHUNK_BYTES,
  GAS,
  addressesIn,
  chunkRanges,
  contentTypeOf,
  fileGas,
  isReservedPath,
  purityScan,
  readDist,
  scanForkLeak,
  scanHosts,
  scanKeyedRpc,
  shellContentType,
} from '../scripts/lib/dist.mjs';
import { inlineSingle, verifySingle } from '../scripts/lib/single.mjs';
import { MAINNET, PUBLIC_RPC } from '../src/config';

/**
 * B5: the Content-Security-Policy and how it is built, the size and secret checks, the single-file build, and the DeWEB
 * publish plan. The fork rehearsal itself (scripts/deweb.mjs rehearse) needs anvil and the network, so it is run by hand
 * and its results are recorded in docs; everything that does not need them is tested here.
 */

const APP = path.resolve(__dirname, '..');
const REPO = path.resolve(APP, '..');
const tmpDirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-b5-'));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const write = (dir: string, rel: string, data: string | Buffer): void => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), data);
};

const MAIN_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src https://rpc.xlayer.tech https://bsc-dataseed.bnbchain.org; base-uri 'none'; form-action 'none'";
const PAGE = (csp: string, extra = ''): string =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<link rel="icon" href="./assets/a.svg">\n<script type="module" crossorigin src="./assets/a.js"></script>\n<link rel="stylesheet" crossorigin href="./assets/a.css">\n</head>\n<body>${extra}</body>\n</html>\n`;

/** A minimal valid multi-file build folder. */
function miniDist(csp = MAIN_CSP, extra = ''): string {
  const d = tmp();
  write(d, 'index.html', PAGE(csp, extra));
  write(d, 'assets/a.js', 'console.log(1)');
  write(d, 'assets/a.css', 'body{margin:0}');
  write(d, 'assets/a.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return d;
}

describe('the policy (SPEC-PHASE5-APP §10)', () => {
  it('is exactly the one the spec lists, with the two public RPCs and nothing inline', () => {
    expect(serialize(policy({ connect: [originOf(PUBLIC_RPC.xlayer), originOf(PUBLIC_RPC.bsc)] }))).toBe(MAIN_CSP);
    expect(MAIN_CSP).not.toMatch(/unsafe-|\*/);
  });

  it('keeps the RPC origins in step with the app configuration', () => {
    expect(PUBLIC_RPC).toEqual({ xlayer: 'https://rpc.xlayer.tech', bsc: 'https://bsc-dataseed.bnbchain.org' });
    expect(MAIN_CSP).toContain(`connect-src ${PUBLIC_RPC.xlayer} ${PUBLIC_RPC.bsc};`);
  });

  it('never writes an empty connect-src as a missing directive (that would fall back to default-src)', () => {
    expect(serialize(policy())).toContain("connect-src 'none'");
  });

  it('parses what it serialises, and refuses a repeated directive', () => {
    expect(serialize(parse(MAIN_CSP))).toBe(MAIN_CSP);
    expect(() => parse("default-src 'self'; default-src 'none'")).toThrow(/twice/);
  });

  it('turns a URL into an origin and refuses anything but http(s)', () => {
    expect(originOf('https://keeper.example.com/api/v1')).toBe('https://keeper.example.com');
    expect(originOf('http://127.0.0.1:8847/')).toBe('http://127.0.0.1:8847');
    expect(() => originOf('ftp://x.example.com')).toThrow();
    expect(() => originOf('not a url')).toThrow();
  });

  it('is injected right after the charset tag, once, and replaced in place', () => {
    const html = '<!doctype html><html><head>\n<meta charset="utf-8">\n<title>t</title></head><body></body></html>';
    const out = injectMeta(html, MAIN_CSP);
    expect(out.indexOf('Content-Security-Policy')).toBeGreaterThan(out.indexOf('charset'));
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<title>'));
    expect(out).toContain('<meta name="referrer" content="no-referrer">');
    expect(extractMeta(out)).toBe(MAIN_CSP);
    expect(() => injectMeta(out, MAIN_CSP)).toThrow(/already/);
    expect(() => injectMeta('<html></html>', MAIN_CSP)).toThrow(/charset/);
    expect(extractMeta(replaceMeta(out, "default-src 'none'"))).toBe("default-src 'none'");
    expect(() => extractMeta(out + out.match(/<meta http-equiv[^>]*>/)![0])).toThrow(/more than one/);
  });

  it('is sent as a header with frame-ancestors, which a meta tag cannot carry', () => {
    const h = hostHeaders(MAIN_CSP) as Record<string, string>;
    expect(h['Content-Security-Policy']).toBe(`${MAIN_CSP}; frame-ancestors 'none'`);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('no-referrer');
    expect(MAIN_CSP).not.toContain('frame-ancestors');
  });

  it('hashes script text the way a browser does', () => {
    // sha256("") in base64, a well-known constant
    expect(hashSource('')).toBe("'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='");
  });
});

describe('the build puts the policy in index.html (a real vite build)', () => {
  const buildWith = async (env: Record<string, string>): Promise<string> => {
    const out = tmp();
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      await build({ root: APP, logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    return extractMeta(fs.readFileSync(path.join(out, 'index.html'), 'utf8')) ?? '';
  };

  it('has the mainnet policy, adds the keeper origin only when the app accepts the URL, and drops a path', async () => {
    delete process.env.VITE_NETWORK;
    expect(await buildWith({ VITE_KEEPER_URL: '' })).toBe(MAIN_CSP);
    expect(await buildWith({ VITE_KEEPER_URL: 'https://keeper.example.com/base/' })).toBe(MAIN_CSP.replace('bnbchain.org;', 'bnbchain.org https://keeper.example.com;'));
    // the app refuses a plain-http keeper that is not local, so the policy must not name it either
    expect(await buildWith({ VITE_KEEPER_URL: 'http://evil.example.com' })).toBe(MAIN_CSP);
  }, 60_000);
});

describe('the files of a build', () => {
  it('splits a file into chunks of at most 24,000 bytes, and honours a smaller size', () => {
    expect(chunkRanges(0)).toEqual([{ index: 0, offset: 0, length: 0 }]);
    expect(chunkRanges(24_000).length).toBe(1);
    expect(chunkRanges(24_001).map((c: { length: number }) => c.length)).toEqual([24_000, 1]);
    expect(chunkRanges(282_415).length).toBe(12);
    expect(chunkRanges(30_000, 12_000).map((c: { length: number }) => c.length)).toEqual([12_000, 12_000, 6_000]);
    expect(() => chunkRanges(10, 24_001)).toThrow();
    expect(() => chunkRanges(10, 0)).toThrow();
    expect(CHUNK_BYTES).toBe(24_000);
  });

  it('lists assets first and index.html last, with hashes, content types and chunk counts', () => {
    const d = miniDist();
    const files = readDist(d) as { path: string; sha256: string; contentType: string; chunks: number }[];
    expect(files.map((f) => f.path)).toEqual(['assets/a.css', 'assets/a.js', 'assets/a.svg', 'index.html']);
    expect(files.at(-1)!.contentType).toBe('text/html; charset=utf-8');
    expect(files.find((f) => f.path === 'assets/a.js')!.contentType).toBe('text/javascript; charset=utf-8');
    expect(files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.chunks === 1)).toBe(true);
  });

  it('refuses what DeWEB would not serve: reserved paths, odd names, unknown types, a folder with no index.html', () => {
    for (const bad of ['sw.js', '.tape/x.html']) {
      const d = miniDist();
      write(d, bad, 'x');
      expect(() => readDist(d), bad).toThrow();
    }
    const d2 = miniDist();
    write(d2, 'assets/has space.js', 'x');
    expect(() => readDist(d2)).toThrow(/bad file path/);
    const d3 = miniDist();
    write(d3, 'assets/data.bin', 'x');
    expect(() => readDist(d3)).toThrow(/no content type/);
    const d4 = tmp();
    write(d4, 'a.js', 'x');
    expect(() => readDist(d4)).toThrow(/no index.html/);
    expect(isReservedPath('sw.js') && isReservedPath('.tape/status') && !isReservedPath('assets/sw.js')).toBe(true);
  });

  it('keeps the content types a shell will not rewrite (TAP-10 §7.1 step 6)', () => {
    for (const p of ['a.html', 'a.js', 'a.css', 'a.svg', 'a.png', 'a.jpg', 'a.woff2', 'a.json']) expect(shellContentType(contentTypeOf(p)), p).toBe(contentTypeOf(p));
    expect(shellContentType('text/html<script>')).toBe('text/htmlscript');
    expect(shellContentType('garbage')).toBe('application/octet-stream');
  });

  it('estimates gas from the fork measurement: about 217 gas per byte, 5.5 M for a full chunk', () => {
    // measured on an anvil fork on 2026-10-23: a 24,324-byte putFile cost 5,492,100 and a 24,228-byte appendChunk 5,366,627
    expect(fileGas(24_000)).toBeGreaterThan(5_400_000);
    expect(fileGas(24_000)).toBeLessThan(5_600_000);
    expect(GAS.perByte).toBe(217);
    // the multi-file build, 13 files: the putFile and appendChunk transactions of the fork rehearsal cost 94,414,498 gas in all
    const sizes = [10_357, 6_473, 436, 27_149, 282_415, 21_832, 6_275, 14_724, 15_000, 10_466, 6_944, 5_570, 937];
    const model = sizes.reduce((s, n) => s + fileGas(n), 0);
    expect(Math.abs(model - 94_414_498) / 94_414_498).toBeLessThan(0.01);
    expect(BUDGET_BYTES).toBe(600_000);
    // the budget in the spec (about 370 M gas) overstated the cost by about 4x; a full budget costs about this much
    expect(fileGas(BUDGET_BYTES)).toBeLessThan(140_000_000);
  });
});

describe('what must not be in a build', () => {
  const file = (text: string, p = 'assets/x.js') => ({ path: p, data: Buffer.from(text) });

  it('finds a keyed RPC URL, whatever the provider, and never repeats the key', () => {
    const secretKey = 'abcdef0123456789abcdef0123456789';
    const bad = [
      `fetch("https://eth-mainnet.g.alchemy.com/v2/${secretKey}")`,
      `x="https://bsc-mainnet.nodereal.io/v1/${secretKey}"`,
      `x="https://foo.quiknode.pro/${secretKey}/"`,
      `x="https://mainnet.infura.io/v3/${secretKey}"`,
      `x="https://rpc.ankr.com/bsc/${secretKey}"`,
      `x="https://go.getblock.io/${secretKey}"`,
      `x="https://bsc.blastapi.io/${secretKey}"`,
      `x="https://example.com/rpc?key=${secretKey}"`,
      `const apiKey = "${secretKey}"`,
      `x="https://unknown-provider.example/v2/${secretKey}"`,
    ];
    for (const t of bad) {
      const found = scanKeyedRpc([file(t)]) as { rule: string; line: number }[];
      expect(found.length, t).toBeGreaterThan(0);
      expect(JSON.stringify(found)).not.toContain(secretKey);
    }
  });

  it('does not trip over ordinary code (viem has a getBlock action; the app names the public RPCs)', () => {
    const ok = 'const getBlock=async()=>1;export{getBlock};fetch("https://rpc.xlayer.tech");fetch("https://bsc-dataseed.bnbchain.org");a="/v2/"';
    expect(scanKeyedRpc([file(ok)])).toEqual([]);
  });

  it('finds what belongs to a fork build, but not the words localhost or 127.0.0.1 that every build holds', () => {
    const main = [...addressesIn(fs.readFileSync(path.join(APP, 'src', 'config.ts'), 'utf8').split('export interface AppConfig')[0])];
    expect(main.length).toBe(22); // the fifteen addresses of the mainnet book and the seven new ones of the redeploy book
    const fork = JSON.stringify({ pool: '0x1111111111111111111111111111111111111111', voucher: MAINNET.voucher });
    const run = (text: string, forkText: string | null = null) => scanForkLeak([file(text)], { mainnetAddresses: main, forkText }) as { rule: string }[];
    expect(run('u.hostname==="localhost"||u.hostname==="127.0.0.1";/^http:\\/\\/(127\\.0\\.0\\.1|localhost):\\d{2,5}$/')).toEqual([]);
    expect(run('rpc:{xlayer:"http://127.0.0.1:8846"}').map((f) => f.rule)).toEqual(['fork: local URL with a port']);
    expect(run('lender="0x7e57000000000000000000000000000000000006"').map((f) => f.rule)).toEqual(['fork: harness test address']);
    expect(run(`pool="0x1111111111111111111111111111111111111111"`, fork).map((f) => f.rule)).toEqual(['fork: an address of the fork book']);
    expect(run(`voucher="${MAINNET.voucher}"`, fork)).toEqual([]); // a real address that the fork book shares is fine
    expect(scanForkLeak([{ path: 'assets/x.js.map', data: Buffer.from('{}') }], { mainnetAddresses: main, forkText: null }).length).toBe(1);
  });

  it('allows only the hosts the app is known to name', () => {
    expect(scanHosts([file('a="https://rpc.xlayer.tech"; b="https://www.oklink.com/xlayer"; c="http://www.w3.org/2000/svg"')])).toEqual([]);
    const found = scanHosts([file('a="https://evil.example/x"')]) as { rule: string }[];
    expect(found.map((f) => f.rule)).toEqual(['unexpected host: evil.example']);
    expect(scanHosts([file('a="https://keeper.example.com/v1"')], ['keeper.example.com'])).toEqual([]);
    expect(ALLOWED_HOSTS.has('rpc.xlayer.tech') && ALLOWED_HOSTS.has('bsc-dataseed.bnbchain.org')).toBe(true);
  });

  it('allows the five wallet download pages of the connect dialog and its "Learn More" page, and no other host for them', () => {
    const pages = ['https://web3.okx.com/download', 'https://metamask.io/download/', 'https://rabby.io/', 'https://www.binance.com/en/web3wallet', 'https://trustwallet.com/download', 'https://ethereum.org/en/wallets/'];
    expect(scanHosts([file(pages.map((p, i) => `l${i}="${p}"`).join('; '))])).toEqual([]);
    // a look-alike is still a finding
    const found = scanHosts([file('a="https://metamask.io.evil.example/download"; b="https://rabby.io.example.com/"')]) as { rule: string }[];
    expect(found.map((f) => f.rule)).toEqual(['unexpected host: metamask.io.evil.example', 'unexpected host: rabby.io.example.com']);
    expect((scanHosts([file('a="https://ethereum.org.evil.example/wallets"')]) as { rule: string }[]).map((f) => f.rule)).toEqual(['unexpected host: ethereum.org.evil.example']);
  });

  it('applies the static scan of TAP-10 §9 to HTML and CSS only', () => {
    const files = [
      { path: 'index.html', data: Buffer.from('<a href="https://tapeout.net">x</a><img src="./a.png"><link href="//cdn.example/x.css">') },
      { path: 'a.css', data: Buffer.from('a{background:url(https://x.example/i.png)} b{background:url(data:image/png;base64,AA==)}') },
      { path: 'a.js', data: Buffer.from('fetch("https://rpc.xlayer.tech")') },
    ];
    const urls = (purityScan(files) as { url: string }[]).map((e) => e.url).sort();
    expect(urls).toEqual(['//cdn.example/x.css', 'https://tapeout.net', 'https://x.example/i.png']);
  });
});

describe('the single-file build', () => {
  const built = (js = 'console.log(1);', css = 'body{margin:0}'): string => inlineSingle({ html: PAGE(MAIN_CSP), js, css, assets: { 'a.svg': Buffer.from('<svg/>') } });

  it('folds the script, the stylesheet and the icon into the page, with the policy naming their hashes', () => {
    const js = 'const a="$&";console.log(a)';
    const out = built(js);
    expect(out).toContain(`<script type="module">${js}</script>`); // a "$&" in the script is not a replacement pattern
    expect(out).toContain('<style>body{margin:0}</style>');
    expect(out).toContain('href="data:image/svg+xml;base64,');
    const p = parse(extractMeta(out)!) as Record<string, string[]>;
    expect(p['script-src']).toEqual([hashSource(js)]);
    expect(p['style-src']).toEqual([hashSource('body{margin:0}')]);
    expect(p['font-src']).toEqual(['data:']);
    expect(p['connect-src']).toEqual(['https://rpc.xlayer.tech', 'https://bsc-dataseed.bnbchain.org']);
    expect(verifySingle(out)).toEqual([]);
  });

  it('is caught if either inline text changes after the policy was written', () => {
    const out = built();
    expect(verifySingle(out.replace('console.log(1);', 'console.log(2);')).join()).toMatch(/script-src/);
    expect(verifySingle(out.replace('margin:0', 'margin:1px')).join()).toMatch(/style-src/);
    expect(verifySingle(out.replace('<script type="module">', '<script type="module"> ')).join()).toMatch(/script-src/);
  });

  it('fails closed on text that would break out of the element or change under the HTML parser', () => {
    expect(() => built('a="</script>"')).toThrow(/cannot be inlined/);
    expect(() => built('a="<script>"')).toThrow(/cannot be inlined/);
    expect(() => built('a="<!--"')).toThrow(/cannot be inlined/);
    expect(() => built('a=1;\r\nb=2')).toThrow(/carriage return/);
    expect(() => built('ok', 'a{}/*</style>*/')).toThrow(/cannot be inlined/);
    expect(() => inlineSingle({ html: PAGE(MAIN_CSP).replace('<script type="module" crossorigin src="./assets/a.js"></script>', ''), js: 'x', css: 'y' })).toThrow(/one script/);
    expect(() => inlineSingle({ html: PAGE(MAIN_CSP), js: 'x', css: 'y', assets: { 'a.svg': Buffer.from('s'), 'b.png': Buffer.from('p') } })).toThrow(/does not use/);
    expect(() => inlineSingle({ html: PAGE(MAIN_CSP).replace('a.svg', 'a.bin'), js: 'x', css: 'y', assets: { 'a.bin': Buffer.from('s') } })).toThrow(/cannot be inlined/);
  });
});

describe('the DeWEB plan', () => {
  const files = (readDist(miniDist()) as { path: string; data: Buffer }[]).map((f) => f);
  const big = Buffer.alloc(60_000, 1);

  it('names the circuit as CLAUDE.md (or, where it is absent, the README) does, and the site as TAP-10 builds names', () => {
    const notes = path.join(REPO, 'CLAUDE.md');
    const claude = fs.readFileSync(fs.existsSync(notes) ? notes : path.join(REPO, 'README.md'), 'utf8');
    expect(claude).toContain(TARGET.circuits);
    expect(getAddress(TARGET.circuits)).toBe(TARGET.circuits);
    for (const a of [TARGET.opener, TARGET.registry, TARGET.binding, TARGET.factory, TARGET.registryImpl, TARGET.bindingImpl, TARGET.expectedHolder]) expect(getAddress(a), a).toBe(a);
    expect(nameOf()).toBe('1.2.382.tape');
    expect(gatewayHost()).toBe('1-2-382.tapekit.org');
    expect(gatewayOpenHost()).toBe('1-2-382-open.tapekit.org');
    // TAP-10 §3.3: a gateway label must match this pattern
    expect(gatewayHost().split('.')[0]).toMatch(/^[1-9][0-9]*-(?:[1-9][0-9]*-)?(0|[1-9][0-9]*)$/);
  });

  it('opens first, uploads assets before index.html, sets the fallback, and binds last', () => {
    const plan = buildPlan({ files, state: offlineState(), months: 1 });
    expect(plan.txs.map((t: { kind: string }) => t.kind)).toEqual(['open', 'putFile', 'putFile', 'putFile', 'putFile', 'setFallback', 'bind']);
    expect(plan.txs[0].value).toBe(80_000_000_000_000_000n);
    expect(plan.txs[0].to).toBe(TARGET.opener);
    const uploads = plan.txs.filter((t: { file?: string }) => t.file).map((t: { file: string }) => t.file);
    expect(uploads.at(-1)).toBe('index.html');
    expect(plan.txs.at(-1).args).toEqual(['1.2.382.tape', '0xB309F98E699cE69A50A2136700337bA656bc145E', '1']);
  });

  it('prices bind as months x the monthly fee and encodes calldata that decodes back', () => {
    const plan = buildPlan({ files, state: offlineState(TARGET, { monthlyFee: 10n ** 16n }), months: 3 });
    expect(plan.txs.at(-1).value).toBe(3n * 10n ** 16n);
    const first = plan.txs.find((t: { kind: string }) => t.kind === 'putFile');
    const d = decodeFunctionData({ abi: ABI.registry, data: first.data });
    expect(d.functionName).toBe('putFile');
    expect(d.args![1]).toBe(first.file);
    // no silent default: the length of the bind decides whether the site is up on judging day
    expect(() => buildPlan({ files, state: offlineState() })).toThrow(/--months is required/);
    expect(() => buildPlan({ files, state: offlineState(), months: 0 })).toThrow(/months/);
    expect(() => buildPlan({ files, state: offlineState(), months: 1.5 })).toThrow(/months/);
    expect(() => buildPlan({ files, state: offlineState(), months: 121 })).toThrow(/months/);
  });

  it('works out when a bind ends: 30-day months from now, or from the current expiry when that is later', () => {
    const state = offlineState();
    const plan = buildPlan({ files, state, months: 3 });
    expect(plan.txs.at(-1).expiresAt).toBe(state.now + 3 * 30 * 86_400);
    const live = { ...state, opened: true, live: true, fallback: 'index.html', paidUntil: BigInt(state.now + 10 * 86_400) };
    expect(buildPlan({ files, state: live, months: 1 }).txs.at(-1).expiresAt).toBe(state.now + 10 * 86_400 + 30 * 86_400);
    expect(buildPlan({ files, state: { ...live, paidUntil: 5n }, months: 1 }).txs.at(-1).expiresAt).toBe(state.now + 30 * 86_400);
    expect(buildPlan({ files: [], state: live }).txs).toEqual([]); // already live and no months given: nothing to bind
    expect(SUBMISSION_DEADLINE).toBe(Date.UTC(2026, 11, 7, 23, 59) / 1000);
  });

  it('puts a big file in ordered chunks that add up to the file, none above the limit', () => {
    const bigFile = { path: 'assets/big.js', size: big.length, sha256: 'aa'.repeat(32), contentType: 'text/javascript; charset=utf-8', chunks: 3, data: big };
    for (const chunkBytes of [24_000, 12_000]) {
      const plan = buildPlan({ files: [bigFile], state: { ...offlineState(), opened: true, fallback: 'index.html', live: true }, chunkBytes });
      const parts = plan.txs.filter((t: { file?: string }) => t.file === 'assets/big.js');
      expect(parts.map((t: { kind: string }) => t.kind)).toEqual(['putFile', ...Array(parts.length - 1).fill('appendChunk')]);
      expect(parts.map((t: { chunkIndex: number }) => t.chunkIndex)).toEqual(parts.map((_: unknown, i: number) => i));
      const hex = parts.map((t: { chunkHex: string }) => t.chunkHex.slice(2)).join('');
      expect(Buffer.from(hex, 'hex').equals(big)).toBe(true);
      expect(Math.max(...parts.map((t: { chunkHex: string }) => (t.chunkHex.length - 2) / 2))).toBeLessThanOrEqual(chunkBytes);
      for (const t of parts.slice(1)) expect(decodeFunctionData({ abi: ABI.registry, data: t.data }).args![2]).toBe(BigInt(t.chunkIndex));
      expect(planTotals(plan).largest).toBeLessThan(131_072); // reth's default input limit
    }
  });

  it('skips what is already on chain, re-sends a half-uploaded file, and prunes only when asked', () => {
    const f = files[0] as { path: string; size: number; sha256: string; contentType: string; chunks: number; data: Buffer };
    const on = { size: f.size, sha256: f.sha256, contentType: f.contentType, updatedAt: 0n, chunkCount: 1 };
    expect(sameFile(on, f)).toBe(true);
    expect(sameFile({ ...on, size: f.size - 1 }, f)).toBe(false); // half uploaded: shorter under the declared hash
    expect(sameFile({ ...on, sha256: '00'.repeat(32) }, f)).toBe(false);
    expect(sameFile({ ...on, contentType: 'text/plain' }, f)).toBe(false);
    expect(sameFile(undefined, f)).toBe(false);
    const state = { ...offlineState(), opened: true, live: true, fallback: 'index.html', files: new Map([[f.path, on], ['old.js', on]]) };
    const plan = buildPlan({ files, state });
    expect(plan.skipped).toEqual([f.path]);
    expect(plan.txs.map((t: { kind: string }) => t.kind)).toEqual(['putFile', 'putFile', 'putFile']); // no open, fallback or bind
    expect(plan.stale).toEqual(['old.js']);
    expect(buildPlan({ files, state, prune: true }).txs.at(-1)).toMatchObject({ kind: 'removeFile', args: [state.container, 'old.js'] });
  });

  it('looks paths up the way a shell does (TAP-10 §7.2)', () => {
    const paths = ['index.html', 'assets/a.js', 'docs/index.html'];
    const at = (p: string) => landing(p, paths, 'index.html');
    expect(at('/')).toBe('index.html');
    expect(at('/index.html?x=1#y')).toBe('index.html');
    expect(at('/assets/a.js')).toBe('assets/a.js');
    expect(at('/docs')).toBe('docs/index.html');
    expect(at('/app/markets')).toBe('index.html'); // no extension: the fallback
    expect(at('/missing.js')).toBeNull(); // an extension: not found
    expect(at('/a/../b')).toBeNull();
    expect(at('/%zz')).toBeNull();
    expect(landing('/app', paths, '')).toBeNull();
  });

  it('writes a script that sends nothing by itself and needs a signer', () => {
    const plan = buildPlan({ files, state: offlineState(), months: 1 });
    const { script, chunkFiles } = castScript(plan) as { script: string; chunkFiles: Map<string, string> };
    expect(script).toContain('set -euo pipefail');
    expect(script).toMatch(/do NOT run this script again from the top/);
    expect(script).toContain(': "${CAST_SIGN_ARGS:?');
    expect(script).not.toMatch(/--private-key|--mnemonic|0x[0-9a-fA-F]{64}\b(?!.*chunks)/);
    expect(script.match(/^send /gm)!.length).toBe(plan.txs.length);
    expect(chunkFiles.size).toBe(plan.txs.filter((t: { chunkHex?: string }) => t.chunkHex).length);
  });
});

describe('the rehearsal and the plan never reach a live chain by accident', () => {
  const run = (args: string[]) => spawnSync(process.execPath, [path.join(APP, 'scripts', 'deweb.mjs'), ...args], { encoding: 'utf8', cwd: APP, timeout: 60_000 });

  it('refuses a rehearsal against any node that is not a local one', () => {
    for (const url of ['https://rpc.xlayer.tech', 'http://rpc.xlayer.tech', 'http://203.0.113.5:8545', 'https://127.0.0.1:8545']) {
      const r = run(['rehearse', '--rpc', url, '--dir', 'dist']);
      expect(r.status, url).toBe(1);
      expect(r.stderr, url).toMatch(/refusing/);
    }
  }, 120_000);

  it('has no way to sign: the plan and verify code contains no key handling', () => {
    for (const f of ['scripts/deweb.mjs', 'scripts/lib/deweb.mjs']) {
      const text = fs.readFileSync(path.join(APP, f), 'utf8');
      expect(text, f).not.toMatch(/privateKeyToAccount|mnemonicToAccount|signTransaction|eth_sendRawTransaction|process\.env\.(PRIVATE|MNEMONIC|SEED)/i);
    }
    // eth_sendTransaction exists in one place only: the rehearsal's sender, behind the local-anvil check
    const cli = fs.readFileSync(path.join(APP, 'scripts', 'deweb.mjs'), 'utf8');
    expect(cli.match(/eth_sendTransaction/g)!.length).toBe(1);
    expect(cli.indexOf('assertLocalAnvil(client, url)')).toBeGreaterThan(0);
  });
});

describe('check:size as a command', () => {
  const run = (dir: string, extra: string[] = []) =>
    spawnSync(process.execPath, [path.join(APP, 'scripts', 'check-size.mjs'), dir, ...extra], { encoding: 'utf8', cwd: APP, env: { ...process.env, VITE_KEEPER_URL: '' }, timeout: 60_000 });

  it('passes a clean build and reports chunks and gas', () => {
    const r = run(miniDist());
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/chunks/);
    expect(r.stdout).toMatch(/est\. gas/);
    expect(r.stdout).toMatch(/check:size passed/);
  });

  it('fails above the budget', () => {
    const d = miniDist();
    write(d, 'assets/big.js', Buffer.alloc(BUDGET_BYTES, 97));
    const r = run(d);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/above the budget/);
  });

  it('fails on a keyed RPC and does not print the key', () => {
    const d = miniDist();
    const key = 'k3yk3yk3yk3yk3yk3yk3yk3yk3yk3y12';
    write(d, 'assets/a.js', `fetch("https://eth-mainnet.g.alchemy.com/v2/${key}")`);
    const r = run(d);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/keyed RPC/);
    expect(r.stdout + r.stderr).not.toContain(key);
  });

  it('fails on a fork build (a local URL with a port) and on an unexpected host', () => {
    const d = miniDist();
    write(d, 'assets/a.js', 'x="http://127.0.0.1:8846"');
    expect(run(d).stdout).toMatch(/fork: local URL with a port/);
    const e = miniDist();
    write(e, 'assets/a.js', 'x="https://elsewhere.example/api"');
    expect(run(e).stdout).toMatch(/unexpected host: elsewhere.example/);
  });

  it('fails when the policy is weaker, missing, or names an origin nobody configured', () => {
    expect(run(miniDist(MAIN_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"))).stdout).toMatch(/script-src/);
    expect(run(miniDist(MAIN_CSP + "; frame-ancestors 'none'")).stdout).toMatch(/unexpected directive frame-ancestors/);
    const none = tmp();
    write(none, 'index.html', '<!doctype html><meta charset="utf-8">');
    expect(run(none).stdout).toMatch(/no Content-Security-Policy/);
    const rogue = miniDist(MAIN_CSP.replace('bnbchain.org;', 'bnbchain.org https://rogue.example;'));
    expect(run(rogue).stdout).toMatch(/connect-src names https:\/\/rogue.example/);
    expect(run(rogue, ['--keeper', 'https://rogue.example']).stdout).not.toMatch(/connect-src names/);
  });

  it('fails on an inline style, an inline script, or a reference that is not relative or not in the build', () => {
    expect(run(miniDist(MAIN_CSP, '<div style="color:red"></div>')).stdout).toMatch(/style attribute/);
    expect(run(miniDist(MAIN_CSP, '<script>alert(1)</script>')).stdout).toMatch(/inline script/);
    expect(run(miniDist(MAIN_CSP, '<img src="/abs.png"><img src="./gone.png">')).stdout).toMatch(/not a relative path[\s\S]*not in the build/);
  });

  it('fails on a value from the .env file, and says only which variable it was', () => {
    const envFile = path.join(tmp(), 'fake.env');
    const value = 'https://bsc.example-node.test/rpc/0123456789abcdef';
    fs.writeFileSync(envFile, `# a comment
BSC_RPC=${value}
SHORT=abc
`);
    const d = miniDist();
    write(d, 'assets/a.js', `x=${JSON.stringify(value)}`);
    const r = spawnSync(process.execPath, [path.join(APP, 'scripts', 'check-size.mjs'), d], { encoding: 'utf8', cwd: APP, env: { ...process.env, VITE_KEEPER_URL: '', TP_ENV_FILE: envFile }, timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('a value of .env (BSC_RPC) is in the build');
    expect((r.stdout + r.stderr).includes(value)).toBe(false);
  });

  it('fails the committed fork build, when there is one (the negative control)', () => {
    const forkBuild = path.join(APP, 'dist-fork');
    if (!fs.existsSync(path.join(forkBuild, 'index.html'))) return; // gitignored; made by the e2e run
    const r = run(forkBuild);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/fork: local URL with a port/);
  });
});

