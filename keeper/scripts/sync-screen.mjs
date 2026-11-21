// Copy the screen tool's sources into the keeper (SPEC-PHASE5-REGISTER D-1) and fix their hash in src/screen/source.ts.
//
//   node scripts/sync-screen.mjs          copy ../screen/src/<file>.ts to src/screen/vendor/ and rewrite source.ts
//
// Railway uploads only keeper/ (`railway up keeper --path-as-root`), so the keeper cannot import ../screen at run time.
// The copies are byte for byte (LF line endings); test/screenVendor.test.ts fails when they drift from ../screen/src.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const KEEPER = join(HERE, "..");
const SCREEN_SRC = join(KEEPER, "..", "screen", "src");
const VENDOR = join(KEEPER, "src", "screen", "vendor");

/** Everything `runChecks` and `verifyFile` need; the CLI (cli.ts) is not part of the keeper. */
export const VENDORED = ["abi.ts", "artifact.ts", "chain.ts", "checks.ts", "constants.ts", "evaluator.ts", "jcs.ts", "netlist.ts", "vectors.ts", "verify.ts"];

export const lf = (text) => text.replace(/\r\n/g, "\n");

/** sha256 over `name\0content\0` of each file, names sorted, content with LF endings. */
export function sourceHash(read) {
  const h = createHash("sha256");
  for (const name of [...VENDORED].sort()) h.update(`${name}\0${lf(read(name))}\0`);
  return h.digest("hex");
}

export function sourceFile(hash, version) {
  return `// Written by scripts/sync-screen.mjs. Do not edit; run \`node scripts/sync-screen.mjs\` after a change in screen/src.
// The hash of the vendored screen sources (SPEC-PHASE5-REGISTER §6.4): keeper-made artifacts name it as their tool commit.
export const SCREEN_SOURCE = { version: ${JSON.stringify(version)}, sha256: ${JSON.stringify(hash)} } as const;
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(VENDOR, { recursive: true });
  for (const name of VENDORED) writeFileSync(join(VENDOR, name), lf(readFileSync(join(SCREEN_SRC, name), "utf8")));
  const version = JSON.parse(readFileSync(join(KEEPER, "..", "screen", "package.json"), "utf8")).version;
  const hash = sourceHash((name) => readFileSync(join(VENDOR, name), "utf8"));
  writeFileSync(join(KEEPER, "src", "screen", "source.ts"), sourceFile(hash, version));
  console.log(`vendored ${VENDORED.length} files, sha256 ${hash}`);
}
