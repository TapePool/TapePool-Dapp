import { defineConfig } from '@playwright/test';

/**
 * The read-only mainnet smoke test (SPEC-PHASE5-APP §14.3). It builds the mainnet app (the multi-file build and the single-file
 * build), serves each one locally with the hosting headers of app/README.md, and loads real pages against the public RPCs in the
 * installed Edge. No wallet, no key, no transaction. Opt-in, because it needs the network: `npm run smoke:mainnet`.
 */
export default defineConfig({
  testDir: 'test/smoke',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 3 * 60_000,
  expect: { timeout: 60_000 },
  reporter: [['list']],
  outputDir: '.cache/smoke-results',
  use: { channel: 'msedge', headless: true, trace: 'off', viewport: { width: 1280, height: 900 }, actionTimeout: 30_000, navigationTimeout: 30_000 },
});
