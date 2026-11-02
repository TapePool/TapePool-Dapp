// Generate the R3-00 evidence vectors for the keeper's mirror (SPEC-REDEPLOY-3 R3-07, RB3-01): run the forge
// script that computes each case with the real `RigAgent` evidence code and keep the `evidence` lines.
//
//   npm run gen:vectors        needs forge; writes test/fixtures/evidence-vectors.json
//
// The script reads no chain and sends nothing. The output is captured from stdout (lines behind a `VEC ` marker).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const keeperRoot = path.resolve(here, "..");
const repoRoot = path.resolve(keeperRoot, "..");
const out = path.join(keeperRoot, "test", "fixtures", "evidence-vectors.json");

const opts = { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true };
let run = spawnSync("forge", ["script", "script/app/ParityVectors.s.sol:ParityVectors"], opts);
if (run.error?.code === "ENOENT") run = spawnSync("forge script script/app/ParityVectors.s.sol:ParityVectors", { ...opts, shell: true });
if (run.status !== 0) {
  console.error(run.stdout, run.stderr);
  console.error("forge script failed");
  process.exit(1);
}

const vectors = run.stdout
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.startsWith("VEC "))
  .map((l) => JSON.parse(l.slice(4)))
  .filter((v) => v.k === "evidence")
  .map(({ k: _k, ...rest }) => rest);
if (vectors.length < 70) {
  console.error(`only ${vectors.length} evidence vectors came back`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `[\n${vectors.map((v) => `  ${JSON.stringify(v)}`).join(",\n")}\n]\n`);
const rows = [...new Set(vectors.map((v) => v.row))].join(", ");
console.log(`wrote ${vectors.length} evidence vectors to test/fixtures/evidence-vectors.json (rows ${rows})`);
