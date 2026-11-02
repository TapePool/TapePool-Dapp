// `npm run check:size`: what a build costs to publish, and what must not be in it (SPEC-PHASE5-APP §13).
//
//   node scripts/check-size.mjs [dir ...] [--gas-price-gwei 0.02] [--keeper https://origin]
//
// No folder given: dist (must exist) and dist-single (checked when it exists). It reports every file with its DeWEB chunk count
// and estimated gas, and FAILS when
//   - the total is above 600 KB (1 KB = 1,000 bytes);
//   - a keyed RPC pattern, a value from the repository's .env, an address or URL of the fork/test build, or a host that is not
//     on the allowed list is in any file (findings give file, rule and line, never the matched text);
//   - index.html has no Content-Security-Policy meta tag, or the policy is not the one of SPEC-PHASE5-APP §10, or the page
//     has an inline script or style the policy does not cover, a style attribute, or a reference that is not relative or does not exist.
// It also prints what a shell's static "100% on-chain" scan (TAP-10 §9) would flag. That is information, not a failure.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMeta, originOf, parse } from './lib/csp.mjs';
import { BUDGET_BYTES, CHUNK_BYTES, addressesIn, chunkRanges, fileGas, purityScan, readDist, scanForkLeak, scanHosts, scanKeyedRpc } from './lib/dist.mjs';
import { verifySingle } from './lib/single.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const comma = (n) => Number(n).toLocaleString('en-US');
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

/** open + setFallback + bind, from the rehearsal (scripts/lib/deweb.mjs STEP_GAS). */
const STEPS_GAS = 480_000;
const RPC_ORIGINS = ['https://rpc.xlayer.tech', 'https://bsc-dataseed.bnbchain.org'];

/** The values in the repository's .env (names are never printed): none of them may appear in a build. `TP_ENV_FILE` points at another file (the tests use that). */
function envSecrets() {
  const out = [];
  const file = process.env.TP_ENV_FILE ? path.resolve(process.env.TP_ENV_FILE) : path.resolve(root, '..', '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const v = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (v.length >= 8) out.push({ name: m[1], value: v });
    }
  }
  return out;
}

function scanEnvValues(files, secrets) {
  const out = [];
  for (const f of files) {
    const text = f.data.toString('utf8');
    for (const s of secrets) {
      const i = text.indexOf(s.value);
      if (i !== -1) out.push({ file: f.path, rule: `a value of .env (${s.name}) is in the build`, offset: i, line: text.slice(0, i).split('\n').length });
    }
  }
  return out;
}

/** The policy must be the one of SPEC-PHASE5-APP §10, with `connect-src` limited to the two RPCs and the keeper's origin. */
function checkPolicy(html, keeperOrigin, single) {
  const problems = [];
  let csp;
  try {
    csp = extractMeta(html);
  } catch (e) {
    return [e.message];
  }
  if (csp === null) return ['index.html has no Content-Security-Policy meta tag'];
  const p = parse(csp);
  const want = { 'default-src': ["'self'"], 'img-src': ["'self'", 'data:'], 'base-uri': ["'none'"], 'form-action': ["'none'"] };
  if (!single) Object.assign(want, { 'script-src': ["'self'"], 'style-src': ["'self'"], 'font-src': ["'self'"] });
  for (const [d, v] of Object.entries(want)) if ((p[d] ?? []).join(' ') !== v.join(' ')) problems.push(`${d} is "${(p[d] ?? []).join(' ')}", expected "${v.join(' ')}"`);
  const known = new Set(['default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'connect-src', 'base-uri', 'form-action']);
  for (const d of Object.keys(p)) if (!known.has(d)) problems.push(`unexpected directive ${d} (a meta tag cannot carry frame-ancestors, and the spec lists no other)`);
  for (const [d, v] of Object.entries(p)) {
    if (v.some((t) => /unsafe-|^\*$|^https?:$/.test(t))) problems.push(`${d} allows ${v.filter((t) => /unsafe-|^\*$|^https?:$/.test(t)).join(' ')}`);
  }
  const connect = p['connect-src'] ?? [];
  const extra = connect.filter((t) => !RPC_ORIGINS.includes(t));
  for (const r of RPC_ORIGINS) if (!connect.includes(r)) problems.push(`connect-src lacks ${r}`);
  for (const t of extra) {
    if (!keeperOrigin) problems.push(`connect-src names ${t}, which is neither RPC: set VITE_KEEPER_URL (or pass --keeper) to the value the build used if that is the keeper`);
    else if (t !== keeperOrigin) problems.push(`connect-src names ${t}, not the keeper origin ${keeperOrigin}`);
    else if (!t.startsWith('https://')) problems.push(`the keeper origin ${t} is not https`);
  }
  if (single) problems.push(...verifySingle(html));
  return problems;
}

/** Shell of the page: inline scripts and styles, style attributes, and references that are not relative or do not exist. */
function checkPage(html, files, single) {
  const problems = [];
  const shell = single ? html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '<script></script>').replace(/<style[^>]*>[\s\S]*?<\/style>/g, '<style></style>') : html;
  if (/\sstyle\s*=/i.test(shell)) problems.push('index.html has a style attribute (the policy blocks it)');
  if (!single) {
    if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(shell)) problems.push('index.html has an inline script');
    if (/<style[\s>]/i.test(shell)) problems.push('index.html has an inline style element');
  }
  if (/\son[a-z]+\s*=\s*["']/i.test(shell)) problems.push('index.html has an inline event handler');
  const have = new Set(files.map((f) => f.path));
  for (const m of shell.matchAll(/\b(?:src|href)="([^"]*)"/g)) {
    const u = m[1];
    if (u.startsWith('data:') || u.startsWith('#')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//') || u.startsWith('/')) problems.push(`index.html refers to ${u.slice(0, 60)}, which is not a relative path`);
    else if (!have.has(u.replace(/^\.\//, '').split(/[?#]/)[0])) problems.push(`index.html refers to ${u}, which is not in the build`);
  }
  return problems;
}

function checkDir(dir, opts) {
  const files = readDist(dir);
  const single = files.length === 1 && /<script type="module">/.test(files[0].data.toString('utf8'));
  const total = files.reduce((s, f) => s + f.size, 0);
  const gas = files.reduce((s, f) => s + fileGas(f.size), 0);
  const chunks = files.reduce((s, f) => s + chunkRanges(f.size).length, 0);
  const lines = [`${dir}${single ? '  (single file)' : ''}`];
  lines.push(`  ${pad('file', 52)}${padL('bytes', 9)}${padL('chunks', 7)}${padL('est. gas', 13)}  content type`);
  for (const f of files) lines.push(`  ${pad(f.path, 52)}${padL(comma(f.size), 9)}${padL(chunkRanges(f.size).length, 7)}${padL(comma(fileGas(f.size)), 13)}  ${f.contentType}`);
  lines.push(`  ${pad('total', 52)}${padL(comma(total), 9)}${padL(chunks, 7)}${padL(comma(gas), 13)}`);
  const okb = (g, gwei) => `${((g * gwei) / 1e9).toFixed(6)} OKB`;
  lines.push(`  budget ${comma(BUDGET_BYTES)} B: ${((total / BUDGET_BYTES) * 100).toFixed(0)}% used.  DeWEB: ${chunks} chunk transaction(s) of at most ${comma(CHUNK_BYTES)} B (+ open, fallback, bind).`);
  lines.push(`  estimated publish gas ${comma(gas)} + steps = ${okb(gas + STEPS_GAS, opts.gwei)} at ${opts.gwei} gwei (${okb(gas + STEPS_GAS, 1)} at 1 gwei), plus the 0.08 OKB open fee`);

  const problems = [];
  if (total > BUDGET_BYTES) problems.push(`total ${comma(total)} B is above the budget of ${comma(BUDGET_BYTES)} B`);
  const keeperOrigin = opts.keeper ? originOf(opts.keeper) : null;
  const html = files.find((f) => f.path === 'index.html').data.toString('utf8');
  problems.push(...checkPolicy(html, keeperOrigin, single), ...checkPage(html, files, single));

  const mainnet = addressesIn(fs.readFileSync(path.join(root, 'src', 'config.ts'), 'utf8').split('export interface AppConfig')[0]);
  const forkFile = path.join(root, 'test', 'fork-addresses.json');
  const forkText = fs.existsSync(forkFile) ? fs.readFileSync(forkFile, 'utf8') : null;
  const findings = [
    ...scanKeyedRpc(files),
    ...scanEnvValues(files, opts.secrets),
    ...scanForkLeak(files, { mainnetAddresses: mainnet, forkText }),
    ...scanHosts(files, keeperOrigin ? [new URL(keeperOrigin).hostname] : []),
  ];
  for (const f of findings) problems.push(`${f.file} line ${f.line}: ${f.rule}`);

  const external = purityScan(files);
  const uniq = [...new Set(external.map((e) => `${e.file}: ${e.url}`))];
  lines.push(`  "100% on-chain" static scan (TAP-10 §9, HTML and CSS only): ${uniq.length === 0 ? 'no off-chain reference' : `${uniq.length} reference(s) a shell would list`}${uniq.length ? ' - ' + uniq.slice(0, 6).join('; ') + (uniq.length > 6 ? '; ...' : '') : ''}`);
  lines.push(problems.length ? `  FAILED:\n${problems.map((p) => `    - ${p}`).join('\n')}` : '  OK: within budget, policy as specified, no keyed RPC, no fork or test content, no unexpected host');
  return { text: lines.join('\n'), ok: problems.length === 0 };
}

function main() {
  const args = process.argv.slice(2);
  const dirs = [];
  const opts = { gwei: 0.02, keeper: process.env.VITE_KEEPER_URL || null, secrets: envSecrets() };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--gas-price-gwei') opts.gwei = Number(args[++i]);
    else if (args[i] === '--keeper') opts.keeper = args[++i];
    else if (args[i].startsWith('--')) throw new Error(`unknown option ${args[i]}`);
    else dirs.push(args[i]);
  }
  const targets = dirs.length ? dirs : ['dist', ...(fs.existsSync(path.join(root, 'dist-single')) ? ['dist-single'] : [])];
  let ok = true;
  for (const d of targets) {
    const r = checkDir(d, opts);
    console.log(r.text + '\n');
    ok &&= r.ok;
  }
  console.log(ok ? 'check:size passed' : 'check:size FAILED');
  if (!ok) process.exit(1);
}

try {
  main();
} catch (e) {
  console.error(`check:size error: ${e.message}`);
  process.exit(1);
}
