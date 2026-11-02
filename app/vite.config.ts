import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { injectMeta, originOf, policy, serialize } from './scripts/lib/csp.mjs';
import { readConfig } from './src/config';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * `VITE_NETWORK=fork` bakes the address book of the local forks into the bundle (src/config.ts reads it). Every other
 * build, the mainnet one included, gets `null` and carries no trace of the file or its path.
 */
const fork = process.env.VITE_NETWORK === 'fork' ? fs.readFileSync(path.join(here, 'test', 'fork-addresses.json'), 'utf8') : null;

/**
 * The Content-Security-Policy of SPEC-PHASE5-APP §10, written into `index.html` at build time only (the dev server needs inline
 * styles). `connect-src` is built from the very configuration the running app reads (`readConfig`), so the two can never
 * disagree: the two RPCs, plus the keeper's origin when `VITE_KEEPER_URL` is set and the app accepts it.
 */
function securityMeta(): Plugin {
  let connect: string[] = [];
  return {
    name: 'tapepool-security-meta',
    apply: 'build',
    configResolved(resolved) {
      const cfg = readConfig(resolved.env as Record<string, string | undefined>, fork);
      connect = [cfg.rpc.xlayer, cfg.rpc.bsc, cfg.keeperUrl].filter((u): u is string => u !== null).map(originOf);
    },
    transformIndexHtml: { order: 'post', handler: (html) => injectMeta(html, serialize(policy({ connect }))) },
  };
}

/**
 * `TP_SINGLE=1` is the first half of the single-file build (scripts/build-single.mjs): everything small or large becomes a data:
 * URI and nothing is split, so the script and the stylesheet can be folded into the page.
 */
const single = process.env.TP_SINGLE === '1';

export default defineConfig({
  base: './',
  plugins: [securityMeta()],
  define: { __TP_FORK__: JSON.stringify(fork) },
  build: {
    target: 'es2022',
    sourcemap: false,
    outDir: process.env.TP_OUT_DIR || 'dist',
    ...(single ? { assetsInlineLimit: () => true, cssCodeSplit: false, modulePreload: { polyfill: false } } : {}),
  },
  test: {
    include: ['test/**/*.test.ts'],
    // the render tests draw every page of a fixture in two languages; on a busy machine the two heaviest take more than the default 5 s
    testTimeout: 20_000,
    environment: 'node',
  },
});
