// `npm run build:single` -> dist-single/index.html: the whole app in one file (SPEC-PHASE5-APP §13, the DeWEB fallback).
// It runs the normal build with everything turned into data: URIs (TP_SINGLE=1), folds the one script and the one stylesheet
// into the page, and swaps the policy's script-src and style-src for their SHA-256 hashes. Fails closed on anything odd.
//
//   node scripts/build-single.mjs [--out dist-single]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlineSingle, verifySingle } from './lib/single.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const at = argv.indexOf('--out');
if (at !== -1 && !argv[at + 1]) throw new Error('--out needs a folder');
const out = path.resolve(root, at === -1 ? 'dist-single' : argv[at + 1]);
const stage = path.join(root, '.cache', 'single-stage');

fs.rmSync(stage, { recursive: true, force: true });
execFileSync(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], {
  cwd: root,
  env: { ...process.env, TP_SINGLE: '1', TP_OUT_DIR: stage },
  stdio: 'inherit',
});

const assets = path.join(stage, 'assets');
const names = fs.existsSync(assets) ? fs.readdirSync(assets) : [];
const js = names.filter((n) => n.endsWith('.js'));
const css = names.filter((n) => n.endsWith('.css'));
const other = names.filter((n) => !n.endsWith('.js') && !n.endsWith('.css'));
if (js.length !== 1 || css.length !== 1) throw new Error(`single-file build: expected one script and one stylesheet, found ${JSON.stringify(names)}`);
const strays = fs.readdirSync(stage).filter((n) => n !== 'assets' && n !== 'index.html');
if (strays.length) throw new Error(`single-file build: unexpected files next to index.html: ${strays.join(', ')}`);

const html = inlineSingle({
  html: fs.readFileSync(path.join(stage, 'index.html'), 'utf8'),
  js: fs.readFileSync(path.join(assets, js[0]), 'utf8'),
  css: fs.readFileSync(path.join(assets, css[0]), 'utf8'),
  // whatever else is left (the favicon) must be one the page itself refers to; inlineSingle turns it into a data: URI or fails
  assets: Object.fromEntries(other.map((n) => [n, fs.readFileSync(path.join(assets, n))])),
});
const problems = verifySingle(html);
if (problems.length) throw new Error(`single-file build: ${problems.join('; ')}`);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`single-file build: ${path.relative(root, path.join(out, 'index.html'))}, ${Buffer.byteLength(html).toLocaleString('en-US')} bytes`);
