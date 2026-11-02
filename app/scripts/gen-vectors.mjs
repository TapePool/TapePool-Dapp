// Generate the parity vectors (SPEC-PHASE5-APP §5.3): run the forge script that computes cases from the real
// Solidity (`CreditMath`, `TapePool.fee`, `TapeLens.principalFor`) and store them as JSON.
//
//   npm run gen:vectors        needs forge; writes test/vectors/creditMath.json and test/vectors/fees.json
//
// The script reads no chain and sends nothing. foundry.toml is not touched: the output is captured from stdout
// (lines behind a `VEC ` marker), so no file permission is needed.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const repoRoot = path.resolve(appRoot, '..');
const outDir = path.join(appRoot, 'test', 'vectors');

const opts = { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 };
let run = spawnSync('forge', ['script', 'script/app/ParityVectors.s.sol:ParityVectors'], opts);
if (run.error?.code === 'ENOENT') run = spawnSync('forge script script/app/ParityVectors.s.sol:ParityVectors', { ...opts, shell: true }); // a launcher that is not an .exe
if (run.status !== 0) {
  console.error(run.stdout, run.stderr);
  console.error('forge script failed');
  process.exit(1);
}

const cases = run.stdout
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.startsWith('VEC '))
  .map((l) => JSON.parse(l.slice(4)));
if (cases.length < 200) {
  console.error(`only ${cases.length} cases came back`);
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
};
fs.mkdirSync(outDir, { recursive: true });
let total = 0;
for (const [name, body] of Object.entries(files)) {
  const lines = Object.entries(body).map(([k, rows]) => `  ${JSON.stringify(k)}: [\n${rows.map((r) => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]`);
  fs.writeFileSync(path.join(outDir, name), `{\n${lines.join(',\n')}\n}\n`);
  total += Object.values(body).reduce((n, rows) => n + rows.length, 0);
}
console.log(`wrote ${total} vectors to test/vectors (expectedOutput ${files['creditMath.json'].expectedOutput.length}, maxDebt ${files['creditMath.json'].maxDebt.length}, debtBucket ${files['creditMath.json'].debtBucket.length}, fee ${files['fees.json'].fee.length}, principalFor ${files['fees.json'].principalFor.length})`);
