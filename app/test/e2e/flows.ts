import type { Page } from '@playwright/test';
import { getAddress, parseAbi, type Address } from 'viem';
import { ADDR } from '../../../keeper/src/addresses';
import { agentAbi, poolAbi } from '../../../keeper/src/abi';
import { RIG } from '../../../keeper/test/anvil/harness';
import { expect, type Session } from './fixtures';
import { PORTS, type E2e } from './stack';

/** The steps of the borrow flow as a miner presses them, shared by the scenarios. Each waits for what the page says when it is done. */

const voucherOwner = parseAbi(['function ownerOf(uint256 id) view returns (address)']);

export const agentsOf = (e2e: E2e, who: Address) => e2e.s.xl.readContract({ address: e2e.s.d.factory, abi: parseAbi(['function agentsOf(address) view returns (address[])']), functionName: 'agentsOf', args: [who] });
export const ownerOfRig = async (e2e: E2e, id: bigint): Promise<Address> => getAddress(await e2e.s.xl.readContract({ address: ADDR.voucher, abi: voucherOwner, functionName: 'ownerOf', args: [id] }));
export const loanOf = (e2e: E2e, agent: Address) => e2e.s.xl.readContract({ address: agent, abi: agentAbi, functionName: 'loanOf' });
export const opsFeeOf = (e2e: E2e, term = 0) => e2e.s.xl.readContract({ address: e2e.s.d.pool, abi: poolAbi, functionName: 'opsFee', args: [term] });

/** Open the rig page and connect the wallet; the borrow flow is there once the rig reads as ready or in the user's agent. */
export async function openRig(s: Session, id = Number(RIG)): Promise<void> {
  await s.open(`#/app/rigs/${id}`);
  await s.connect();
  await expect(s.page.locator('[data-a="create"], [data-a="move"], [data-a="refresh"], [data-a="borrow"], .stp')).not.toHaveCount(0);
}

/** Step 1 by creating a new agent. Returns its address from the chain. */
export async function createAgentUi(s: Session, e2e: E2e): Promise<Address> {
  const before = (await agentsOf(e2e, s.account)).length;
  await s.send('create');
  await expect(s.page.getByText(/Agent 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4} created\./)).toBeVisible();
  const after = await agentsOf(e2e, s.account);
  expect(after.length).toBe(before + 1);
  return getAddress(after[after.length - 1] as Address);
}

/** Step 1 by reusing the miner's empty agent (the app offers it when there is one). */
export async function reuseAgentUi(s: Session, agent: Address): Promise<void> {
  await s.act('reuse', agent);
  await expect(s.page.getByText(/Using your empty agent/)).toBeVisible();
}

/**
 * The choice about the BEM the rig mined before the loan (SPEC-PHASE5-PRELOAN §4.2). The BSC read decides whether the screen
 * requires one, so wait for what it shows: the Move button, or the choice with "Keep it in this loan" (a disabled button has no
 * `data-a`). When the choice is required, keep the BEM in the loan, which sends nothing, and wait for Move to turn on.
 */
export async function keepIfAsked(s: Session): Promise<void> {
  const move = s.page.locator('button[data-a="move"]');
  const keep = s.page.locator('button[data-a="keep"]');
  await expect(move.or(keep).first()).toBeVisible({ timeout: 60_000 });
  if ((await keep.count()) > 0) {
    await s.act('keep');
    await expect(move).toBeVisible();
  }
}

/** Read the chain again and wait until the page has read X Layer's head (its clock decides the move gate), so what is asserted next is on that head. */
export async function rereadHead(s: Session): Promise<void> {
  const head = s.page.waitForResponse((r) => r.url().includes(`:${PORTS.xlayer}`) && (r.request().postData() ?? '').includes('eth_getBlockByNumber'));
  await s.reread();
  await head;
}

export async function moveUi(s: Session): Promise<void> {
  await keepIfAsked(s);
  await s.send('move');
  await expect(s.page.getByText(/in the agent\. You can take/)).toBeVisible();
}

/** Step 3 through the keeper; resolves once the page says the report is fresh. */
export async function refreshUi(s: Session): Promise<void> {
  await s.send('refresh');
  await expect(s.page.getByText('Report fresh')).toBeVisible({ timeout: 120_000 });
}

export async function borrowUi(s: Session): Promise<void> {
  await expect(s.page.locator('[data-a="borrow"]')).toBeEnabled();
  await s.send('borrow');
  await expect(s.page.getByText(/It is in your wallet/)).toBeVisible({ timeout: 60_000 });
}

/** Repay the whole debt from the loan card: the miner is given the BEM for the flat fee first. */
export async function repayUi(s: Session, e2e: E2e, page: Page = s.page): Promise<void> {
  await e2e.s.fundBem(s.account, 50_000_000n);
  await s.act('repay');
  await expect(page.locator('[data-a="approve-repay"]')).toBeVisible();
  await s.send('approve-repay');
  await expect(page.getByText('1 · BEM allowed')).toBeVisible();
  await s.send('repay-do');
  await expect(page.getByText(/Debt cleared/).first()).toBeVisible({ timeout: 60_000 });
}

export async function releaseUi(s: Session): Promise<void> {
  await s.send('release');
  await expect(s.page.getByText(/is back in your wallet/)).toBeVisible({ timeout: 60_000 });
}
