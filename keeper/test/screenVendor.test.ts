// SPEC-PHASE5-REGISTER D-1 and §6.4: the keeper runs the screen tool's own code, vendored byte for byte, and names it by
// the hash of those sources. Railway uploads only keeper/, so these copies are what runs in production.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADDR as KEEPER_ADDR, EXPECTED_IMPL } from "../src/addresses.js";
import { KEEPER_TOOL } from "../src/screens.js";
import { SCREEN_SOURCE } from "../src/screen/source.js";
import { ADDR, PROCESSORS, REVIEWED } from "../src/screen/vendor/constants.js";
// @ts-expect-error the sync script is a plain ES module without types
import { VENDORED, lf, sourceHash } from "../scripts/sync-screen.mjs";

const vendor = (name: string) => new URL(`../src/screen/vendor/${name}`, import.meta.url);
const upstream = (name: string) => new URL(`../../screen/src/${name}`, import.meta.url);
const haveScreen = existsSync(upstream("checks.ts"));
const files = VENDORED as string[];

describe("the vendored screen tool", () => {
  it.skipIf(!haveScreen)("equals screen/src byte for byte (run `node scripts/sync-screen.mjs` after a change there)", () => {
    for (const name of files) expect(readFileSync(vendor(name), "utf8"), name).toBe((lf as (s: string) => string)(readFileSync(upstream(name), "utf8")));
  });

  it("names every source the checks need, and nothing else", () => {
    expect([...files].sort()).toEqual(["abi.ts", "artifact.ts", "chain.ts", "checks.ts", "constants.ts", "evaluator.ts", "jcs.ts", "netlist.ts", "vectors.ts", "verify.ts"]);
    for (const name of files) expect(existsSync(vendor(name)), name).toBe(true);
  });

  it("is named by the hash of the vendored files, which the keeper's artifacts carry as their tool commit", () => {
    const hash = (sourceHash as (read: (n: string) => string) => string)((n) => readFileSync(vendor(n), "utf8"));
    expect(SCREEN_SOURCE.sha256).toBe(hash);
    expect(KEEPER_TOOL).toEqual({ name: "tape-pool-screen", version: SCREEN_SOURCE.version, commit: `keeper-src-sha256:${hash}` });
    if (haveScreen) expect(SCREEN_SOURCE.version).toBe(JSON.parse(readFileSync(new URL("../../screen/package.json", import.meta.url), "utf8")).version);
  });

  it("judges against the same reviewed constants as the keeper's upgrade watch", () => {
    const lc = (a: string) => a.toLowerCase();
    expect(lc(REVIEWED.podMiningImpl)).toBe(lc(EXPECTED_IMPL.podMining));
    expect(lc(REVIEWED.circuitsBeacon)).toBe(lc(EXPECTED_IMPL.bscCircuitsBeacon));
    expect(lc(REVIEWED.circuitsImpl)).toBe(lc(EXPECTED_IMPL.bscCircuitsImpl));
    expect(lc(ADDR.podMining)).toBe(lc(KEEPER_ADDR.podMining));
    expect(lc(ADDR.rigVault)).toBe(lc(KEEPER_ADDR.rigVault));
    expect(lc(ADDR.voucher)).toBe(lc(KEEPER_ADDR.voucher));
    expect(lc(ADDR.multicall3)).toBe(lc(KEEPER_ADDR.multicall3));
    expect(Object.values(PROCESSORS).map(lc).sort()).toEqual(KEEPER_ADDR.bscCircuits.map(lc).sort());
  });
});
