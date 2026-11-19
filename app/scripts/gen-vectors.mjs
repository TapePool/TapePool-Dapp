// Generate the parity vectors (SPEC-PHASE5-APP §5.3): run the forge script that computes cases from the real
// Solidity (`CreditMath`, `TapePool.fee`, `TapeLens.principalFor`) and store them as JSON.
//
//   npm run gen:vectors        needs forge; writes test/vectors/{creditMath,fees,evidence,clearPair,bonus}.json
//
// The script reads no chain and sends nothing. foundry.toml is not touched: the output is captured from stdout
// (lines behind a `VEC ` marker), so no file permission is needed.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const repoRoot = path.resolve(appRoot, '..');
const outDir = path.join(appRoot, 'test', 'vectors');

// A file keeps stdout capture usable when Windows denies child-process pipes.
const capture = path.join(os.tmpdir(), `tape-pool-app-vectors-${process.pid}.log`);
const fd = fs.openSync(capture, 'wx');
let run;
try {
  const opts = { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', fd, 'inherit'], windowsHide: true };
  run = spawnSync('forge', ['script', '--offline', 'script/app/ParityVectors.s.sol:ParityVectors'], opts);
  if (run.error?.code === 'ENOENT') run = spawnSync('forge script --offline script/app/ParityVectors.s.sol:ParityVectors', { ...opts, shell: true }); // a launcher that is not an .exe
  run.stdout = fs.readFileSync(capture, 'utf8');
} finally {
  fs.closeSync(fd);
  fs.unlinkSync(capture);
}
if (run.status !== 0) {
  if (run.error) console.error(run.error);
  console.error(run.stdout, run.stderr);
  console.error('forge script failed');
  process.exit(1);
}

const cases = run.stdout
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.startsWith('VEC '))
  .map((l) => JSON.parse(l.slice(4)));
if (cases.length !== 902) {
  console.error(`expected 902 cases, got ${cases.length}`);
  process.exit(1);
}

const group = (kinds) =>
  Object.fromEntries(
    kinds.map((k) => [
      k,
      cases.filter((c) => c.k === k).map(({ k: _k, ...rest }) => rest),
    ]),
  );

const files = {
  'creditMath.json': group(['expectedOutput', 'maxDebt', 'debtBucket']),
  'fees.json': group(['fee', 'principalFor']),
  'evidence.json': group(['evidence']),
  'clearPair.json': group(['clearPair']),
  'bonus.json': group(['bonus']),
};
const counts = { expectedOutput: 134, maxDebt: 44, debtBucket: 232, fee: 200, principalFor: 180, evidence: 103, clearPair: 3, bonus: 6 };
for (const body of Object.values(files)) {
  for (const [kind, rows] of Object.entries(body)) {
    if (rows.length !== counts[kind]) throw new Error(`expected ${counts[kind]} ${kind} vectors, got ${rows.length}`);
  }
}
fs.mkdirSync(outDir, { recursive: true });
let total = 0;
for (const [name, body] of Object.entries(files)) {
  const lines = Object.entries(body).map(([k, rows]) => `  ${JSON.stringify(k)}: [\n${rows.map((r) => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]`);
  fs.writeFileSync(path.join(outDir, name), `{\n${lines.join(',\n')}\n}\n`);
  total += Object.values(body).reduce((n, rows) => n + rows.length, 0);
}
console.log(`wrote ${total} vectors to test/vectors (${Object.entries(files).flatMap(([, body]) => Object.entries(body).map(([kind, rows]) => `${kind} ${rows.length}`)).join(', ')})`);
