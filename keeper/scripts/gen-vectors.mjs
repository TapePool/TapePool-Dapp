// Generate the R4-00 parity vectors for the keeper (SPEC-REDEPLOY-4 RB4-01, RB4-02): run the forge script that
// computes each case with the real evidence code and reader, keeping the `evidence`, `clearPair` and `bonus` groups.
//
//   npm run gen:vectors        needs forge; writes test/fixtures/{evidence,clear-pair,bonus}-vectors.json
//
// The script reads no chain and sends nothing. The output is captured from stdout (lines behind a `VEC ` marker).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const keeperRoot = path.resolve(here, "..");
const repoRoot = path.resolve(keeperRoot, "..");
const outDir = path.join(keeperRoot, "test", "fixtures");

// A file keeps stdout capture usable when Windows denies child-process pipes.
const capture = path.join(os.tmpdir(), `tape-pool-vectors-${process.pid}.log`);
const fd = fs.openSync(capture, "wx");
let run;
try {
  const opts = { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", fd, "inherit"], windowsHide: true };
  run = spawnSync("forge", ["script", "--offline", "script/app/ParityVectors.s.sol:ParityVectors"], opts);
  if (run.error?.code === "ENOENT") run = spawnSync("forge script --offline script/app/ParityVectors.s.sol:ParityVectors", { ...opts, shell: true });
  run.stdout = fs.readFileSync(capture, "utf8");
} finally {
  fs.closeSync(fd);
  fs.unlinkSync(capture);
}
if (run.status !== 0) {
  if (run.error) console.error(run.error);
  console.error(run.stdout, run.stderr);
  console.error("forge script failed");
  process.exit(1);
}

const cases = run.stdout
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.startsWith("VEC "))
  .map((l) => JSON.parse(l.slice(4)));
const groups = [
  { kind: "evidence", name: "evidence-vectors.json", count: 103 },
  { kind: "clearPair", name: "clear-pair-vectors.json", count: 3 },
  { kind: "bonus", name: "bonus-vectors.json", count: 6 },
].map((g) => ({ ...g, vectors: cases.filter((v) => v.k === g.kind).map(({ k: _k, ...rest }) => rest) }));
for (const g of groups) {
  if (g.vectors.length !== g.count) {
    console.error(`expected ${g.count} ${g.kind} vectors, got ${g.vectors.length}`);
    process.exit(1);
  }
}

fs.mkdirSync(outDir, { recursive: true });
for (const g of groups) {
  fs.writeFileSync(path.join(outDir, g.name), `[\n${g.vectors.map((v) => `  ${JSON.stringify(v)}`).join(",\n")}\n]\n`);
  console.log(`wrote ${g.vectors.length} ${g.kind} vectors to test/fixtures/${g.name}`);
}
