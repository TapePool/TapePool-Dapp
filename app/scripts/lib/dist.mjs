// What the size check, the DeWEB tooling and the tests all need to know about a build folder: its files, their hashes and
// content types, how DeWEB would chunk them, what that costs, and what must never be inside them. No network, no signing.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** DeWEB writes a file in chunks of at most this many bytes: `putFile` carries the first, `appendChunk` each later one (TAP-10 Appendix A). */
export const CHUNK_BYTES = 24_000;
/** A file has at most 350 chunks, and a shell refuses to read more than 8,400,000 bytes (TAP-10 §7.1). */
export const MAX_CHUNKS = 350;
/** SPEC-PHASE5-APP §13: at most 600 KB (1 KB = 1,000 bytes, the way the spec counted the 408 KB build) for everything a build holds; raised from 500 KB by the owner on 2026-10-24. */
export const BUDGET_BYTES = 600_000;

/**
 * What a publish costs in gas. Measured on an X Layer fork (anvil, Cancun) by `deweb.mjs rehearse` on 2026-10-23: a chunk costs a
 * fixed part plus a part per byte, and the first chunk (`putFile`) also pays for the new path and its metadata. `deweb.mjs
 * rehearse` prints the model next to what it measured, so a drift shows up the next time someone rehearses.
 */
export const GAS = {
  /** `putFile`, fixed part: the transaction, the new path with its content type and hash, and the first chunk's own overhead (fitted to 13 `putFile` transactions of 436 to 24,000 bytes). */
  putFixed: 300_000,
  /** `appendChunk`, fixed part (fitted to 12 transactions of 3,149 to 24,000 bytes). */
  appendFixed: 170_000,
  /** Gas per byte of data in a chunk: 16 for the calldata plus 200 for the storage of the byte (the chunk is kept as contract code). */
  perByte: 217,
};

/* ───────── files ───────── */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

/** The content type DeWEB stores for a path; an unknown extension is an error, never a guess. */
export function contentTypeOf(p) {
  const t = TYPES[path.posix.extname(p).toLowerCase()];
  if (!t) throw new Error(`no content type for ${p}: add its extension to scripts/lib/dist.mjs`);
  return t;
}

/** TAP-10 §7.1 step 6: what a shell makes of a stored content type. */
export function shellContentType(stored) {
  const clean = stored.replace(/[^A-Za-z0-9_.+/;= -]/g, '').slice(0, 100);
  return /^[^/\s;]+\/[^/\s;]+/.test(clean) ? clean : 'application/octet-stream';
}

/** Gateway-reserved paths (TapeKit sw-gateway): a site file there would never be read. */
export function isReservedPath(p) {
  return p === 'sw.js' || p === '.tape' || p.startsWith('.tape/');
}

function checkPath(p) {
  if (!/^[A-Za-z0-9._\-/]+$/.test(p) || p.startsWith('/') || p.endsWith('/') || p.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`bad file path in the build: ${JSON.stringify(p)}`);
  }
  if (isReservedPath(p)) throw new Error(`${p} is a path the DeWEB gateway keeps for itself; a site file there is never served`);
}

export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * The chunk ranges of a file of `size` bytes: [{ index, offset, length }]. An empty file is one empty chunk. `chunkBytes` may be
 * lower than the protocol's 24,000 (a command line on Windows cannot carry a 24,000-byte chunk as hex).
 */
export function chunkRanges(size, chunkBytes = CHUNK_BYTES) {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > CHUNK_BYTES) throw new Error(`chunk size must be 1 to ${CHUNK_BYTES} bytes`);
  const n = Math.max(1, Math.ceil(size / chunkBytes));
  return Array.from({ length: n }, (_, index) => ({ index, offset: index * chunkBytes, length: Math.min(chunkBytes, size - index * chunkBytes) }));
}

/** Estimated gas of one chunk transaction: the first chunk is a `putFile`, each later one an `appendChunk`. */
export function chunkGas(length, first) {
  return (first ? GAS.putFixed : GAS.appendFixed) + GAS.perByte * length;
}

/** Estimated gas to write one file with the given chunk size. */
export function fileGas(size, chunkBytes = CHUNK_BYTES) {
  return chunkRanges(size, chunkBytes).reduce((sum, c) => sum + chunkGas(c.length, c.index === 0), 0);
}

/**
 * Every file of a build folder, in upload order: assets first, `index.html` last, so that nothing a visitor can open is ever
 * half uploaded (the page that points at the assets arrives after them).
 * @returns {{ path: string, size: number, sha256: string, contentType: string, chunks: number, data: Buffer }[]}
 */
export function readDist(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`${dir} is not a folder; build first`);
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) throw new Error(`${full} is a symbolic link`);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        checkPath(rel);
        const data = fs.readFileSync(full);
        const chunks = chunkRanges(data.length).length;
        if (chunks > MAX_CHUNKS) throw new Error(`${rel} has ${chunks} chunks; DeWEB allows ${MAX_CHUNKS}`);
        out.push({ path: rel, size: data.length, sha256: sha256Hex(data), contentType: contentTypeOf(rel), chunks, data });
      }
    }
  };
  walk(root);
  if (!out.some((f) => f.path === 'index.html')) throw new Error(`${dir} has no index.html`);
  const rank = (f) => (f.path === 'index.html' ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/* ───────── what must not be in a build ───────── */

/**
 * Names of RPC providers that hand out keyed URLs, and the shapes keys take. The list is deliberately specific where a bare
 * word would hit ordinary code: viem has a `getBlock` action, so only the provider's domain counts for getblock and blastapi.
 */
export const KEYED_RPC_PATTERNS = [
  ['quiknode', /quiknode/i],
  ['alchemy', /alchemy/i],
  ['infura', /infura/i],
  ['nodereal', /nodereal/i],
  ['ankr keyed path', /ankr\.com\/[a-z0-9_-]+\/[0-9a-f]{16,}/i],
  ['getblock', /getblock\.(io|us|net)/i],
  ['blastapi', /blastapi\.io/i],
  ['/v2/<key>', /\/v2\/[A-Za-z0-9_-]{16,}/],
  ['?key= / &key=', /[?&]key=/i],
  ['apikey', /api[-_]?key/i],
];

/** A local address with a port: where a fork build points. (The words localhost and 127.0.0.1 alone are in every build, in the keeper URL check.) */
const LOCAL_URL = /(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\]|[A-Za-z0-9-]+\.localhost|[A-Za-z0-9-]+\.test)(?::\d+)/i;
/** The harness's test lender and friends: addresses made of a readable prefix and zeros. */
const TEST_ADDRESS = /0x7e57[0]{30,}[0-9a-fA-F]{0,6}/i;

const textOf = (f) => f.data.toString('utf8');
/** A finding never carries the matched text: a key that got into a build must not be copied into a log. */
const finding = (file, rule, text, index) => ({ file: file.path, rule, offset: index, line: text.slice(0, index).split('\n').length });

/** @returns {{ file: string, rule: string, offset: number, line: number }[]} */
export function scanKeyedRpc(files) {
  const out = [];
  for (const f of files) {
    const text = textOf(f);
    for (const [rule, re] of KEYED_RPC_PATTERNS) {
      const m = re.exec(text);
      if (m) out.push(finding(f, `keyed RPC: ${rule}`, text, m.index));
    }
  }
  return out;
}

/**
 * Anything that belongs to a fork or test build: a local URL with a port, a harness test address, any address the fork book
 * holds that the mainnet book does not (`forkText` is the content of test/fork-addresses.json, when it exists), and files that
 * only exist for tests.
 */
export function scanForkLeak(files, { mainnetAddresses, forkText }) {
  const out = [];
  const main = new Set(mainnetAddresses.map((a) => a.toLowerCase()));
  const forkOnly = [];
  if (forkText) for (const a of new Set(forkText.match(/0x[0-9a-fA-F]{40}/g) ?? [])) if (!main.has(a.toLowerCase())) forkOnly.push(a.toLowerCase());
  for (const f of files) {
    if (/(^|\/)fork-addresses\.json$/.test(f.path) || /\.map$/.test(f.path)) out.push({ file: f.path, rule: 'test or debug file in the build', offset: 0, line: 1 });
    const text = textOf(f);
    for (const [rule, re] of [
      ['fork: local URL with a port', LOCAL_URL],
      ['fork: harness test address', TEST_ADDRESS],
    ]) {
      const m = re.exec(text);
      if (m) out.push(finding(f, rule, text, m.index));
    }
    const lower = text.toLowerCase();
    for (const a of forkOnly) {
      const i = lower.indexOf(a);
      if (i !== -1) out.push(finding(f, 'fork: an address of the fork book', text, i));
    }
  }
  return out;
}

/** The hosts a build may name in its text. Anything else is a finding: a new endpoint should be a conscious change. */
export const ALLOWED_HOSTS = new Set([
  'rpc.xlayer.tech',
  'bsc-dataseed.bnbchain.org',
  'www.oklink.com',
  'bscscan.com',
  'tapeout.net',
  'x.com',
  // the official download pages of the recommended wallets in the connect dialog: links the reader opens in a new tab, never requested
  'web3.okx.com',
  'metamask.io',
  'rabby.io',
  'www.binance.com',
  'trustwallet.com',
  // "Learn More" in the connect dialog: a link the reader opens in a new tab, never requested
  'ethereum.org',
  // inside viem's error messages (a documentation link and a signature lookup hint): text, never requested
  'viem.sh',
  '4byte.sourcify.dev',
  // the SVG and XHTML namespace names: identifiers, never requested
  'www.w3.org',
]);

/** Hosts named in the build's text, minus the allowed ones, minus the keeper's origin(s). */
export function scanHosts(files, extraAllowed = []) {
  const allow = new Set([...ALLOWED_HOSTS, ...extraAllowed.map((h) => h.toLowerCase())]);
  const out = [];
  for (const f of files) {
    if (!/\.(html|js|css|svg|json|txt)$/.test(f.path)) continue;
    const text = textOf(f);
    for (const m of text.matchAll(/\b(?:https?|wss?):\/\/([A-Za-z0-9.-]+)/g)) {
      const host = m[1].toLowerCase();
      if (!allow.has(host)) out.push(finding(f, `unexpected host: ${host}`, text, m.index));
    }
  }
  return out;
}

/* ───────── "100% on-chain" static scan (TAP-10 §9) ───────── */

const ATTR = /\b(?:src|href|action|poster|data|formaction|background)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const SRCSET = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
const META_REFRESH = /<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*content\s*=\s*["'][^"']*url=([^"'>\s]+)/gi;
const isExternal = (u) => /^(?:https?|wss?|ftp):/i.test(u.trim()) || u.trim().startsWith('//');

/**
 * What a shell's static scan finds in the HTML and CSS of a site: references to something off chain. A shell that finds any
 * does not call the site "100% on-chain" (TAP-10 §9). The scan reads the whole HTML text, inline script included.
 * @returns {{ file: string, url: string }[]}
 */
export function purityScan(files) {
  const out = [];
  for (const f of files) {
    const html = /\.html?$/i.test(f.path);
    const css = /\.css$/i.test(f.path);
    if (!html && !css) continue;
    const text = textOf(f);
    const res = html ? [ATTR, SRCSET, CSS_URL, CSS_IMPORT, META_REFRESH] : [CSS_URL, CSS_IMPORT];
    for (const re of res) {
      for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
        const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
        if (!v) continue;
        for (const c of re === SRCSET ? v.split(',').map((s) => s.trim().split(/\s+/)[0]) : [v]) if (isExternal(c)) out.push({ file: f.path, url: c.slice(0, 120) });
      }
    }
  }
  return out;
}

/** Every 20-byte address written in a text, once each. */
export const addressesIn = (text) => [...new Set(text.match(/0x[0-9a-fA-F]{40}\b/g) ?? [])];
