import { test as base, expect, type Page } from '@playwright/test';
import type { Address } from 'viem';
import { APP_ORIGIN, startE2e, type E2e } from './stack';
import { installWallet, type TestWallet } from './wallet';

/**
 * Fixtures of the fork e2e: the stack is started once per worker (and torn down at the end), and every test opens its own
 * browser context with the test wallet of the account it plays. Each session collects what a clean run must not have: console
 * errors, page errors, failed or error responses, and Content-Security-Policy violations.
 */

export interface Session {
  page: Page;
  wallet: TestWallet;
  account: Address;
  /** Console errors, page errors, failed requests, responses of 400 and above, and CSP violations seen so far. */
  problems: string[];
  /** Load the app at a hash route (a full page load). */
  open(hash: string): Promise<void>;
  /** Move to another hash route inside the loaded app, as a click on a link would. */
  go(hash: string): Promise<void>;
  /**
   * Press the Connect wallet button, pick the test wallet (announced over EIP-6963 as `io.metamask`, named "Test wallet") in the
   * dialog that opens, and wait until the dialog has closed because the wallet is connected.
   */
  connect(): Promise<void>;
  /** Read the chain again now (the tab "came back"), instead of waiting for the 15 s timer. */
  reread(): Promise<void>;
  /** Click the enabled control with this `data-a` (and `data-v`): a page control that sends nothing. */
  act(a: string, v?: string | number): Promise<void>;
  /**
   * Click a control that makes the app do something (a transaction, a keeper request) and wait until the app has finished it:
   * every such action ends with a toast, and a click while one is still running is ignored by design. The toast is cleared first,
   * so the one that appears is the answer to this click.
   */
  send(a: string, v?: string | number): Promise<void>;
  /** The visible text of the page, for assertions. */
  text(): Promise<string>;
}

export const test = base.extend<{ session: (account: Address) => Promise<Session> }, { e2e: E2e }>({
  e2e: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const e2e = await startE2e();
      try {
        await use(e2e);
      } finally {
        await e2e.stop();
      }
    },
    { scope: 'worker', timeout: 15 * 60_000 },
  ],
  session: async ({ browser, e2e: _stack }, use) => {
    const contexts: { close: () => Promise<void> }[] = [];
    await use(async (account) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      contexts.push(context);
      const page = await context.newPage();
      const problems: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(`console: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      // a request the app itself gave up on (its 15 s timeout on a slow fork read) is aborted, not failed, and logs nothing in the console
      page.on('requestfailed', (r) => r.failure()?.errorText !== 'net::ERR_ABORTED' && problems.push(`requestfailed: ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''} ${(r.postData() ?? '').slice(0, 300)}`));
      page.on('response', (r) => {
        if (r.status() >= 400) problems.push(`response ${r.status()}: ${r.request().method()} ${r.url()}`);
      });
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
      });
      const wallet = await installWallet(page, { account });
      const session: Session = {
        page,
        wallet,
        account,
        problems,
        async open(hash) {
          await page.goto(`${APP_ORIGIN}/${hash}`);
        },
        async go(hash) {
          await page.evaluate((h) => {
            location.hash = h;
          }, hash);
        },
        async connect() {
          await page.locator('[data-a="connect"]').first().click();
          const dialog = page.getByRole('dialog', { name: 'Connect a Wallet' });
          await expect(dialog).toBeVisible();
          // the test wallet announces the rdns of MetaMask but a name and an icon of its own: find its row by the name (the "Installed" rows are the only `pick-wallet` buttons)
          await dialog.locator('button[data-a="pick-wallet"]', { hasText: 'Test wallet' }).click();
          await expect(dialog).toBeHidden();
        },
        async reread() {
          await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        },
        async act(a, v) {
          const sel = v === undefined ? `[data-a="${a}"]` : `[data-a="${a}"][data-v="${v}"]`;
          await page.locator(sel).first().click();
        },
        async send(a, v) {
          await page.evaluate(() => document.getElementById('tp-toast')?.classList.remove('tp-show'));
          const sel = v === undefined ? `[data-a="${a}"]` : `[data-a="${a}"][data-v="${v}"]`;
          await page.locator(sel).first().click();
          await page.waitForFunction(() => document.getElementById('tp-toast')?.classList.contains('tp-show') === true, undefined, { timeout: 150_000 });
        },
        async text() {
          return page.locator('body').innerText();
        },
      };
      return session;
    });
    for (const c of contexts) await c.close();
  },
});

export { expect };
