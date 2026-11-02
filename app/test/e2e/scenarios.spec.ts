import { decodeFunctionData, getAddress, parseAbi, parseAbiItem, parseEther, type Address } from 'viem';
import { agentAbi, poolAbi } from '../../../keeper/src/abi';
import { ADDR } from '../../../keeper/src/addresses';
import { GUARDIAN, OWNER, RELAY, RIG, SAFE, rescueAbi } from '../../../keeper/test/anvil/harness';
import { bscVaultAbi, creditPolicyAbi, feedReceiverAbi, reporterAbi, tapePoolAbi, voucherAbi } from '../../src/chain/abi';
import { expectedOutput, maxDebt } from '../../src/logic/creditMath';
import { expect, test } from './fixtures';
import { agentsOf, borrowUi, createAgentUi, keepIfAsked, loanOf, moveUi, openRig, opsFeeOf, ownerOfRig, refreshUi, releaseUi, repayUi, reuseAgentUi, rereadHead } from './flows';
import { APP_ORIGIN, type E2e } from './stack';
import { registerRedeployScenarios } from './redeploy-scenarios';

/**
 * The fork end-to-end scenarios of SPEC-PHASE5-APP §14.2. They run in order on one stack, and each ends with rig #16 back in
 * the miner's wallet, so the next one starts from the same place (the rescue of scenario 7 is last, since nothing recovers
 * from it). Every one asserts that the browser saw no console error, no failed request and no Content-Security-Policy
 * violation, under the Content-Security-Policy header of SPEC-PHASE5-APP §10 that the static server sends.
 */

test.describe.configure({ mode: 'serial' });

/** Make every stored report older than the five minutes the credit rule accepts, so the scenario has to ask for a new one. */
const staleReports = (e2e: E2e): Promise<void> => e2e.sync(e2e.now() + 400);

const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const bemOf = (e2e: E2e, who: Address): Promise<bigint> => e2e.s.xl.readContract({ address: ADDR.bemXLayer, abi: erc20, functionName: 'balanceOf', args: [who] });

test('1. the exit criterion: connect, create an agent, move the voucher, refresh the data, borrow with the OKB fee, repay and release; a lender supplies and withdraws', async ({ e2e, session }) => {
  e2e.freshPushLimits();
  const { s, miner } = e2e;
  const m = await session(miner);
  const page = m.page;

  // connect, and pick the ready rig
  await openRig(m);
  await expect(page.getByText('Ready').first()).toBeVisible();
  const max = async () => (await page.locator('.amt-row .ml-a').first().innerText()).replace(/\s+/g, ' ').trim();
  const estimate = await max();
  await expect(page.getByText('Credit rule: estimate')).toBeVisible();

  // 1. create the agent
  const agent = await createAgentUi(m, e2e);
  expect(m.wallet.sent[0]).toMatchObject({ to: s.d.factory, chain: 'xlayer', value: 0n });
  expect(m.wallet.sent[0]?.ask).toMatch(/AgentFactory.*create\(0\).*0 OKB/s);
  expect(agent.toLowerCase()).toBe(s.agent.toLowerCase());

  // 2. move the voucher in (safeTransferFrom: the agent's hook adds the collateral)
  await moveUi(m);
  expect(await ownerOfRig(e2e, RIG)).toBe(agent);
  expect(m.wallet.sent[1]?.ask).toMatch(/RIG voucher.*safeTransferFrom.*#16/s);
  expect(await s.xl.readContract({ address: agent, abi: agentAbi, functionName: 'collateralOf' })).toEqual([RIG]);

  // 3. refresh the data through the keeper: the relay delivers the push, the page waits until the report is timely
  await refreshUi(m);
  expect(await s.reportTime()).toBeGreaterThan(0);
  await expect(page.getByText('Credit rule: allow')).toBeVisible();
  // the estimate of the first screens and the lens quote agree on the maximum advance
  expect(await max()).toBe(estimate);

  // fork parity (SPEC-PHASE5-APP §5.3): the policy's own maxDebt, with the timely report, equals the TypeScript port
  const [report] = await s.xl.readContract({ address: s.d.receiver, abi: feedReceiverAbi, functionName: 'latest', args: [RIG] });
  const base = report.verifWeight - report.bonus;
  for (const term of [0, 1] as const) {
    const onChain = await s.xl.readContract({ address: s.policy, abi: creditPolicyAbi, functionName: 'maxDebt', args: [agent, [RIG], term] });
    const ts = maxDebt(expectedOutput(base, report.totalVerifWeight, term), term);
    expect(onChain, `maxDebt term ${term}`).toBe(ts);
    expect(onChain).toBeGreaterThan(0n);
  }

  // 4. borrow, paying the OKB fee as the exact value
  const fee = await opsFeeOf(e2e);
  const operator = await s.xl.readContract({ address: s.d.pool, abi: tapePoolAbi, functionName: 'owner' });
  const operatorBefore = await s.xl.getBalance({ address: operator });
  const bemBefore = await bemOf(e2e, miner);
  const okbBefore = await s.xl.getBalance({ address: miner });
  // the wallet asks for exactly the advance on the screen (the default moves with the fee schedule)
  const shown = await page.locator('[data-in="b.amt"]').first().inputValue();
  expect(shown).toMatch(/^\d+\.\d{4}$/);
  await borrowUi(m);
  const borrowTx = m.wallet.sent[m.wallet.sent.length - 1];
  expect(borrowTx).toMatchObject({ to: agent, value: fee, chain: 'xlayer' });
  expect(borrowTx?.ask).toMatch(new RegExp(`RigAgent.*borrow\\(7 days, ${shown.replace('.', '\\.')} BEM\\)`, 's'));
  expect(borrowTx?.value).toBe(fee);
  const loan = await loanOf(e2e, agent);
  expect(loan.open).toBe(true);
  if (fee === 0n) await expect(page.getByText('no fee', { exact: true })).toBeVisible();
  expect(await bemOf(e2e, miner)).toBe(bemBefore + loan.principal0);
  expect((await s.xl.getBalance({ address: operator })) - operatorBefore).toBe(fee); // the OKB fee reached the operator's wallet
  const okbSpent = okbBefore - (await s.xl.getBalance({ address: miner }));
  console.log(`borrow: principal ${loan.principal0}, flat fee ${loan.feeLeft}, debt ${loan.debt}, ops fee ${fee} wei OKB, miner paid ${okbSpent} wei in total (gas ${okbSpent - fee} wei)`);
  await expect(page.getByText('Active').first()).toBeVisible();

  // 5. repay the whole debt from the loan card (approve the agent, then repay), and release the voucher
  await repayUi(m, e2e);
  expect((await loanOf(e2e, agent)).open).toBe(false);
  await expect(page.getByText(/Debt cleared on/)).toBeVisible(); // the receipt of this session gives the date
  await releaseUi(m);
  expect(await ownerOfRig(e2e, RIG)).toBe(miner);

  // a lender supplies and withdraws on the same forks
  const l = await session(e2e.lender);
  await l.open('#/app/supply');
  await l.connect();
  await expect(l.page.locator('[data-a="approve-supply"]')).toBeVisible();
  const lenderBem = await bemOf(e2e, e2e.lender);
  await l.send('approve-supply');
  await expect(l.page.getByText('1 · BEM allowed')).toBeVisible();
  await l.send('supply');
  await expect.poll(() => bemOf(e2e, e2e.lender), { timeout: 60_000 }).toBe(lenderBem - 200_000_000n);
  expect(await s.xl.readContract({ address: s.d.pool, abi: tapePoolAbi, functionName: 'balanceOf', args: [e2e.lender] })).toBeGreaterThan(0n);
  await l.go('#/app/withdraw');
  await l.act('wdmax');
  await l.send('withdraw');
  await expect.poll(() => bemOf(e2e, e2e.lender), { timeout: 60_000 }).toBeGreaterThanOrEqual(lenderBem - 1n);
  expect(await s.xl.readContract({ address: s.d.pool, abi: tapePoolAbi, functionName: 'balanceOf', args: [e2e.lender] })).toBe(0n);

  expect(m.problems, 'miner session').toEqual([]);
  expect(l.problems, 'lender session').toEqual([]);
});

const poolAdmin = parseAbi(['function pauseBorrows()', 'function unpauseBorrows()', 'function queueParam(uint8 key, uint256 value)', 'function executeParam(uint8 key)']);
const OPS_FEE_7D = 11;
const BEEF = '0x000000000000000000000000000000000000bEEF' as const;

/** The empty agent the miner has left over from an earlier scenario. */
const emptyAgent = async (e2e: E2e): Promise<Address> => {
  const list = await agentsOf(e2e, e2e.miner);
  return getAddress(list[list.length - 1] as Address);
};

test('2. an expired report: the page asks to refresh again, and a second push makes it fresh', async ({ e2e, session }) => {
  await staleReports(e2e);
  e2e.freshPushLimits();
  const m = await session(e2e.miner);
  await openRig(m);
  await reuseAgentUi(m, await emptyAgent(e2e));
  await moveUi(m);
  await refreshUi(m);
  await expect(m.page.locator('[data-a="borrow"]')).toBeEnabled();
  // six minutes pass on both chains: the report is older than the five the credit rule accepts
  await e2e.sync(e2e.now() + 400);
  await m.reread();
  await expect(m.page.getByText(/older than 5 minutes/)).toBeVisible();
  await expect(m.page.locator('[data-a="borrow"]')).toHaveCount(0); // the Borrow button is off until the data is refreshed
  await expect(m.page.getByRole('button', { name: 'Refresh again' })).toBeVisible();
  await refreshUi(m); // the second request
  await expect(m.page.locator('[data-a="borrow"]')).toBeEnabled();
  await releaseUi(m); // "Take back": the rig goes back to the wallet for the next scenario
  expect(await ownerOfRig(e2e, RIG)).toBe(e2e.miner);
  expect(m.problems).toEqual([]);
});

test('3. WrongOpsFee: the fee changes between the simulation and the prompt, and the app asks again with the new fee', async ({ e2e, session }) => {
  const { s } = e2e;
  const oldFee = await opsFeeOf(e2e);
  const newFee = parseEther('0.04');
  // the owner queued a change; the 48 hours pass; nobody has executed it yet
  await s.as('xl', OWNER).writeContract({ address: s.d.pool, abi: poolAdmin, functionName: 'queueParam', args: [OPS_FEE_7D, newFee] });
  await e2e.sync(e2e.now() + 48 * 3_600 + 120);
  e2e.freshPushLimits();
  const m = await session(e2e.miner);
  await openRig(m);
  await reuseAgentUi(m, await emptyAgent(e2e));
  await moveUi(m);
  await refreshUi(m);
  await expect(m.page.getByText(/An operating fee change is queued/)).toBeVisible();
  expect(await opsFeeOf(e2e)).toBe(oldFee); // still the old fee on chain

  // between the simulation and the prompt, someone executes the queued change
  // a borrow is told apart by its call, not its value: at launch the old fee is 0, like every other prompt
  const isBorrow = (t: { ask: string | null }) => /· borrow\(/.test(t.ask ?? '');
  let executed = 0;
  m.wallet.setBeforeSend(async (tx) => {
    if (isBorrow(tx) && tx.value === oldFee && executed === 0) {
      executed++;
      await s.as('xl', RELAY).writeContract({ address: s.d.pool, abi: poolAdmin, functionName: 'executeParam', args: [OPS_FEE_7D] });
    }
  });
  await m.send('borrow');
  await expect(m.page.getByText('The operating fee changed. It is now 0.040 OKB. Review and sign again.').first()).toBeVisible();
  expect(executed).toBe(1);
  expect(await opsFeeOf(e2e)).toBe(newFee);
  const attempts = m.wallet.sent.filter((t) => isBorrow(t) && t.value === oldFee);
  expect(attempts).toHaveLength(1); // one prompt, refused by the chain, never retried by the app
  expect((await loanOf(e2e, await emptyAgent(e2e))).open).toBe(false);

  // the page read the new fee: it sends exactly that, once the user signs again
  m.wallet.setBeforeSend(undefined);
  await expect(m.page.getByText(/It sends exactly 0\.040 OKB/)).toBeVisible();
  await m.reread();
  const ownerBefore = await s.xl.getBalance({ address: OWNER });
  await borrowUi(m);
  expect(m.wallet.sent[m.wallet.sent.length - 1]?.value).toBe(newFee);
  expect((await s.xl.getBalance({ address: OWNER })) - ownerBefore).toBe(newFee);
  await repayUi(m, e2e);
  await releaseUi(m);
  expect(m.problems).toEqual([]);
});

test('4. a paused pool: borrow is off with the reason, and the flow resumes when the pool does', async ({ e2e, session }) => {
  const { s } = e2e;
  e2e.freshPushLimits();
  await s.as('xl', GUARDIAN).writeContract({ address: s.d.pool, abi: poolAdmin, functionName: 'pauseBorrows' });
  const m = await session(e2e.miner);
  await m.open('#/app/rigs/16');
  await m.connect();
  // the pool lends nothing while paused (maxLend is 0), so the page says why and offers no step at all
  await expect(m.page.getByText('New borrows are paused.').first()).toBeVisible();
  await expect(m.page.getByText('Borrows paused')).toBeVisible();
  await expect(m.page.getByText('Nothing to borrow for this choice right now.')).toBeVisible();
  await expect(m.page.locator('[data-a="create"], [data-a="move"], [data-a="refresh"], [data-a="borrow"], [data-a="reuse"]')).toHaveCount(0);
  // the owner resumes borrows: the flow is back, and nothing was sent by the miner meanwhile
  await s.as('xl', OWNER).writeContract({ address: s.d.pool, abi: poolAdmin, functionName: 'unpauseBorrows' });
  await m.reread();
  await expect(m.page.getByText('New borrows are paused.')).toHaveCount(0);
  await expect(m.page.getByText('Borrows open')).toBeVisible();
  await expect(m.page.locator('[data-a="reuse"], [data-a="create"]').first()).toBeVisible();
  expect(m.wallet.sent).toHaveLength(0);
  expect(m.problems).toEqual([]);
});

test('5. one loan for two rigs', async ({ e2e, session }) => {
  const { s } = e2e;
  await e2e.addSecondRig();
  e2e.freshPushLimits();
  const m = await session(e2e.miner);
  await m.open('#/app/rigs/group');
  await m.connect();
  await expect(m.page.locator('[data-pick="16"]')).toBeVisible();
  await expect(m.page.locator('[data-pick="5"]')).toBeEnabled();
  await m.page.locator('[data-pick="5"]').check();
  await m.page.locator('[data-pick="16"]').check();
  const agent = await emptyAgent(e2e);
  await reuseAgentUi(m, agent);
  const sentBefore = m.wallet.sent.length;
  await keepIfAsked(m); // the BEM the rigs mined before the loan may need a choice (SPEC-PHASE5-PRELOAN §4.2)
  await m.send('move');
  await expect(m.page.getByText(/in the agent\. You can take/)).toBeVisible();
  expect(m.wallet.sent.length - sentBefore).toBe(2); // one transfer per rig
  expect((await s.xl.readContract({ address: agent, abi: agentAbi, functionName: 'collateralOf' })).map(Number)).toEqual([5, 16]);
  await refreshUi(m);
  const fee = await opsFeeOf(e2e);
  await borrowUi(m);
  expect(m.wallet.sent[m.wallet.sent.length - 1]).toMatchObject({ to: agent, value: fee }); // one fee for both rigs
  const loan = await loanOf(e2e, agent);
  expect(loan.open).toBe(true);
  console.log(`grouped loan: rigs 5 and 16, principal ${loan.principal0}, flat fee ${loan.feeLeft}`);
  await expect(m.page.getByText('#5').first()).toBeVisible();
  await repayUi(m, e2e);
  await releaseUi(m);
  expect(await ownerOfRig(e2e, 5n)).toBe(e2e.miner);
  expect(await ownerOfRig(e2e, RIG)).toBe(e2e.miner);
  expect(m.problems).toEqual([]);
});

test('6. claim late: BEM that lands in the empty agent after the loan is claimable, and the UI claim lands', async ({ e2e, session }) => {
  await staleReports(e2e);
  e2e.freshPushLimits();
  const m = await session(e2e.miner);
  await openRig(m);
  const agent = await emptyAgent(e2e);
  await reuseAgentUi(m, agent);
  await moveUi(m);
  await refreshUi(m);
  await borrowUi(m);
  await repayUi(m, e2e);
  await releaseUi(m);
  // a harvest sent before the release lands after it: the agent is empty and holds BEM
  await e2e.s.fundBem(agent, 200_000n);
  await m.go('#/app/rigs');
  await expect(m.page.getByText(/is waiting in your empty Rig Agent/)).toBeVisible();
  const before = await bemOf(e2e, e2e.miner);
  await m.send('claim', agent); // the keeper does not cycle here, so nothing else touches the agent
  await expect(m.page.getByText(/is waiting in your empty Rig Agent/)).toHaveCount(0);
  expect(await bemOf(e2e, e2e.miner)).toBe(before + 200_000n);
  expect(await bemOf(e2e, agent)).toBe(0n);
  expect(m.problems).toEqual([]);
});

test('8. take a voucher back before borrowing', async ({ e2e, session }) => {
  e2e.freshPushLimits();
  const m = await session(e2e.miner);
  await openRig(m);
  await reuseAgentUi(m, await emptyAgent(e2e));
  await moveUi(m);
  expect(await ownerOfRig(e2e, RIG)).not.toBe(e2e.miner);
  await expect(m.page.getByText('Not borrowing now?')).toBeVisible();
  await m.send('release', 16);
  await expect(m.page.getByText(/Voucher #16 is back in your wallet/)).toBeVisible({ timeout: 60_000 });
  expect(await ownerOfRig(e2e, RIG)).toBe(e2e.miner);
  expect(m.wallet.sent[m.wallet.sent.length - 1]?.ask).toMatch(/RigAgent.*release\(\)/s);
  expect(m.problems).toEqual([]);
});

test('9. the self-push on BSC: the keeper refuses, the wallet switches to BSC, pushes, the report lands, the wallet comes back', async ({ e2e, session }) => {
  const { s } = e2e;
  await staleReports(e2e);
  e2e.freshPushLimits();
  await s.bscTest.setBalance({ address: e2e.miner, value: parseEther('1') });
  const m = await session(e2e.miner);
  // the keeper's answer is a refusal at the HTTP layer (its real limits are the keeper's own tests); everything else is real
  await m.page.route('**/v1/push', (route) => {
    const cors = { 'access-control-allow-origin': APP_ORIGIN, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ status: 'refused', reason: 'daily push budget used, push it yourself' }) });
  });
  await openRig(m);
  await reuseAgentUi(m, await emptyAgent(e2e));
  await moveUi(m);
  await m.send('refresh');
  await expect(m.page.getByText('Free refreshes are used up for today. You can push it yourself on BSC.').first()).toBeVisible();
  await expect(m.page.getByText(/does not lower the OKB fee/).first()).toBeVisible(); // the cost and what it does not change are said before the push
  const quote = await s.bsc.readContract({ address: s.d.reporter, abi: reporterAbi, functionName: 'quote', args: [[RIG]] });
  const before = await s.reportTime();

  // while the wallet is on BSC the page must not turn into the wrong-network gate
  let gated = -1;
  m.wallet.setBeforeSend(async (tx) => {
    if (tx.chain === 'bsc') gated = await m.page.getByText('Switch to X Layer').count();
  });
  await m.send('selfpush');
  const push = m.wallet.sent[m.wallet.sent.length - 1];
  expect(push).toMatchObject({ chain: 'bsc', to: s.d.reporter, value: (quote * 11n) / 10n });
  expect(push?.ask).toMatch(/RigReporter.*push\(\[#16\]\).*BNB/s);
  expect(gated).toBe(0);
  expect(m.wallet.chainId()).toBe(196); // switched back
  expect(await s.reportTime()).toBeGreaterThan(before);
  await expect(m.page.getByText('Report fresh')).toBeVisible();
  await expect(m.page.locator('[data-a="borrow"]')).toBeEnabled();
  console.log(`self-push: quote ${quote} wei BNB, sent ${push?.value} wei BNB`);
  await releaseUi(m);
  expect(await ownerOfRig(e2e, RIG)).toBe(e2e.miner);
  expect(m.problems).toEqual([]);
});

const harvestedEvent = parseAbiItem('event Harvested(bytes32 indexed guid, uint256[] ids, uint256[] packed)');
const RIG_N = Number(RIG);

/** Move both clocks and the stack's clock past every head, so the next scenario's `sync` has room (anvil only moves forward). */
async function realign(e2e: E2e): Promise<void> {
  const h = await e2e.s.headTimes();
  await e2e.sync(Math.max(h.xl, h.bsc) + 60);
}

test('10. harvest first: the miner harvests the BEM mined before the loan to the wallet, the voucher waits for BSC time to pass on X Layer, and the BEM reaches the wallet and not the agent', async ({ e2e, session }) => {
  const { s, miner } = e2e;
  e2e.freshPushLimits();
  // 0.05 BEM in the rig's vault cell is far more than a tenth of the debt of a 0.01 BEM advance: the choice is required
  await s.fundCell(RIG, 5_000_000n);
  await s.fundBnb(miner, parseEther('1'));
  // BSC time passes the moment the voucher came back to the wallet, and BSC then runs 400 s ahead of X Layer, so that T_h + 2 is still ahead of X Layer's head
  await e2e.sync(e2e.now() + 120);
  const before = await s.headTimes();
  await s.bscAt(Math.max(before.xl, before.bsc) + 400);

  const m = await session(miner);
  await openRig(m);
  const agent = await emptyAgent(e2e);
  await reuseAgentUi(m, agent);
  // the choice is required: Move voucher is off (a disabled button has no data-a), both options are there, nothing is preselected
  await expect(m.page.getByText(/BEM is mined and not harvested yet/)).toBeVisible({ timeout: 60_000 });
  await expect(m.page.locator('[data-a="move"]')).toHaveCount(0);
  await expect(m.page.locator('button[data-a="keep"]')).toBeVisible();
  await expect(m.page.locator('button[data-a="harvest-first"]')).toBeEnabled();

  // harvest first: the harvest is sent from the miner's wallet, on BSC, with the quote plus 10%
  const markBlock = await s.bsc.getBlockNumber();
  const quote = await s.bsc.readContract({ address: ADDR.rigVault, abi: bscVaultAbi, functionName: 'quoteHarvest', args: [1n] });
  await m.send('harvest-first');
  const sent = m.wallet.sent[m.wallet.sent.length - 1];
  expect(sent).toMatchObject({ chain: 'bsc', to: ADDR.rigVault, from: miner, value: (quote * 11n) / 10n });
  expect(decodeFunctionData({ abi: bscVaultAbi, data: sent?.data as `0x${string}` })).toMatchObject({ functionName: 'harvest', args: [[RIG]] });
  expect(sent?.ask).toMatch(/RigVault.*harvest\(\[#16\]\).*BNB/s);
  expect(m.wallet.chainId()).toBe(196); // back on X Layer
  // T_h: the BSC time of the block that holds the harvest
  const [harvested] = await s.bsc.getLogs({ address: ADDR.rigVault, event: harvestedEvent, fromBlock: markBlock, toBlock: await s.bsc.getBlockNumber() });
  expect(harvested).toBeDefined();
  const sentAmount = ((harvested?.args.packed?.[0] ?? 0n) as bigint) >> 128n;
  expect(sentAmount).toBeGreaterThan(0n);
  const tH = Number((await s.bsc.getBlock({ blockNumber: harvested?.blockNumber as bigint })).timestamp);

  // the harvest's block is final once BSC has mined past it; until X Layer's clock passes T_h + 2 the voucher stays in the wallet
  await s.bscFinalize();
  await rereadHead(m);
  await expect(m.page.getByText('Waiting for the harvest to settle on BSC…')).toBeVisible();
  expect((await s.headTimes()).xl).toBeLessThan(tH + 2); // the setup: X Layer is behind
  await s.xlAt(tH + 2); // X Layer alone, inside the harness's `exclusive`
  await rereadHead(m);
  await expect(m.page.getByText('Waiting for the harvest to settle on BSC…')).toBeVisible();
  await expect(m.page.locator('[data-a="move"]')).toHaveCount(0); // off at T_h + 2
  // the page's own clock runs on, X Layer's does not (no block comes): the gate is measured against the head, so it stays off
  await m.page.waitForTimeout(3_500);
  await expect(m.page.getByText('Waiting for the harvest to settle on BSC…')).toBeVisible();
  await expect(m.page.locator('[data-a="move"]')).toHaveCount(0);
  await s.xlAt(tH + 3);
  await rereadHead(m);
  await expect(m.page.locator('button[data-a="move"]')).toBeEnabled({ timeout: 60_000 }); // on at T_h + 3

  // move: the mark of the transfer is after T_h, so the payee of the harvest at T_h is the wallet
  await m.send('move');
  expect(await ownerOfRig(e2e, RIG)).toBe(agent);
  expect(getAddress(await s.xl.readContract({ address: ADDR.voucher, abi: voucherAbi, functionName: 'payeeAt', args: [RIG, BigInt(tH)] }))).toBe(miner);
  // and the borrow. The clocks first meet again: with BSC 400 s ahead, a push's report would carry a BSC time more than
  // 60 s in X Layer's future and would never be timely. The harvest's payee is fixed by T_h already.
  await realign(e2e);
  await refreshUi(m);
  await borrowUi(m);
  const loan = await loanOf(e2e, agent);
  expect(loan.open).toBe(true);

  // the harvest lands: on the miner's WALLET, not in the agent, and the debt is unchanged
  const walletBefore = await bemOf(e2e, miner);
  const agentBefore = await bemOf(e2e, agent);
  await s.landHarvests(markBlock);
  const landed = (await bemOf(e2e, miner)) - walletBefore;
  expect(landed).toBeGreaterThan(0n);
  expect(landed).toBeLessThanOrEqual(sentAmount);
  // the BEM adapter keeps its bridge fee (feeBps 50 on the fork) and the OFT rounds down to a dust of 100 raw
  const feeBps = BigInt(await s.bsc.readContract({ address: ADDR.bemAdapter, abi: parseAbi(['function feeBps() view returns (uint16)']), functionName: 'feeBps' }));
  expect(landed).toBeGreaterThanOrEqual((sentAmount * (10_000n - feeBps)) / 10_000n - 100n);
  expect(await bemOf(e2e, agent)).toBe(agentBefore);
  expect((await loanOf(e2e, agent)).debt).toBe(loan.debt);

  // the way back for the next scenario
  await repayUi(m, e2e);
  await releaseUi(m);
  expect(await ownerOfRig(e2e, RIG)).toBe(miner);
  await realign(e2e);
  expect(m.problems).toEqual([]);
});

test('11. keep: the miner keeps the BEM mined before the loan in the loan, a harvest lands in the agent, and a sweep repays from it', async ({ e2e, session }) => {
  const { s, miner } = e2e;
  e2e.freshPushLimits();
  await s.fundCell(RIG, 5_000_000n);
  // the app reads BSC two blocks behind the head, and the fork mines only on a transaction: blocks after the funding make it visible
  await e2e.sync(e2e.now() + 60);
  const m = await session(miner);
  await openRig(m);
  const agent = await emptyAgent(e2e);
  await reuseAgentUi(m, agent);
  await expect(m.page.getByText(/BEM is mined and not harvested yet/)).toBeVisible({ timeout: 60_000 });
  const sentBefore = m.wallet.sent.length;
  await m.act('keep'); // "Keep it in this loan" sends nothing
  await expect(m.page.locator('button[data-a="move"]')).toBeVisible();
  expect(m.wallet.sent.length).toBe(sentBefore);
  await m.send('move');
  expect(await ownerOfRig(e2e, RIG)).toBe(agent);
  // the report scenario 10 pushed can still be timely here; refresh only when the step asks for it
  if ((await m.page.locator('[data-a="refresh"]').count()) > 0) await refreshUi(m);
  else await expect(m.page.getByText('Report fresh')).toBeVisible();
  // the review says that BEM mined before the loan goes first
  await expect(m.page.getByText('Mined before this loan')).toBeVisible();
  await borrowUi(m);
  const loan = await loanOf(e2e, agent);
  expect(loan.open).toBe(true);

  // a harvest sent while the agent holds the voucher is paid to the agent (the keeper's covered harvest does the same)
  const mark = await s.bsc.getBlockNumber();
  await s.harvest([RIG]);
  await s.landHarvests(mark);
  const inAgent = await bemOf(e2e, agent);
  expect(inAgent).toBeGreaterThan(loan.debt);
  await m.reread();
  const walletBefore = await bemOf(e2e, miner);
  await m.send('sweep', RIG_N); // the keeper does not cycle here, so the miner applies it
  expect((await loanOf(e2e, agent)).open).toBe(false);
  await expect(m.page.getByText(/Debt cleared/).first()).toBeVisible({ timeout: 60_000 });
  expect((await bemOf(e2e, miner)) - walletBefore).toBe(inAgent - loan.debt); // what is above the debt goes back to the miner
  await releaseUi(m);
  expect(await ownerOfRig(e2e, RIG)).toBe(miner);
  await realign(e2e);
  expect(m.problems).toEqual([]);
});

registerRedeployScenarios();

test('7. deposits close while a loan is doubtful: a rescue, the keeper\'s flag, and the lender sees it', async ({ e2e, session }) => {
  const { s } = e2e;
  await staleReports(e2e);
  e2e.freshPushLimits();
  // the lender has 2 BEM in the pool before anything goes wrong
  const l = await session(e2e.lender);
  await l.open('#/app/supply');
  await l.connect();
  const lenderBem = await bemOf(e2e, e2e.lender);
  await l.send('approve-supply');
  await l.send('supply');
  await expect.poll(() => bemOf(e2e, e2e.lender), { timeout: 60_000 }).toBe(lenderBem - 200_000_000n);

  const m = await session(e2e.miner);
  await openRig(m);
  const agent = await emptyAgent(e2e);
  await reuseAgentUi(m, agent);
  await moveUi(m);
  await refreshUi(m);
  await borrowUi(m);

  // the TapeOut Safe rescues rig #16 on BSC; the keeper confirms it over two cycles, suspends the pass, pushes the evidence,
  // and flags the loan on the next cycle (the keeper's scenario B, driven by the test: no cycle runs on its own)
  await s.as('bsc', SAFE).writeContract({ address: ADDR.rigVault, abi: rescueAbi, functionName: 'rescue', args: [RIG, BEEF] });
  await e2e.sync(e2e.now() + 60);
  await e2e.cycle(); // first sight
  const sentAt = e2e.now();
  await e2e.sync(sentAt + 60);
  await e2e.cycle(); // confirmed: suspend and push
  await expect.poll(() => s.reportTime(), { timeout: 60_000 }).toBeGreaterThanOrEqual(sentAt);
  await e2e.sync(e2e.now() + 30);
  await e2e.cycle(); // the flag, on the timely report
  const flagged = await loanOf(e2e, agent);
  expect(flagged.doubtful).toBe(true);
  expect(flagged.impairedAt).toBeGreaterThan(0n);

  // the miner sees the flag and why; the lender sees deposits closed, with withdrawals still open
  await m.reread();
  await expect(m.page.getByText('Flagged').first()).toBeVisible();
  await expect(m.page.getByText(/no longer in the vault on BSC/).first()).toBeVisible();
  const brake = parseAbi(['function disableFeed()', 'function enableFeed()']);
  await s.as('xl', GUARDIAN).writeContract({ address: s.d.pool, abi: brake, functionName: 'disableFeed' });
  expect((await loanOf(e2e, agent)).deadline).toBe((1n << 64n) - 1n);
  await m.reread();
  await expect(m.page.getByText('The seize deadline is paused while the feed is off. A seize is still possible on voucher evidence.')).toBeVisible();
  expect(await m.text()).not.toMatch(/Invalid Date|NaN|184467/);
  await s.as('xl', OWNER).writeContract({ address: s.d.pool, abi: brake, functionName: 'enableFeed' });
  await l.reread();
  await expect(l.page.getByText('Deposits are closed while a loan is under review.').first()).toBeVisible();
  await expect(l.page.getByText('Deposits closed')).toBeVisible(); // the footer says so too
  await expect(l.page.locator('[data-a="approve-supply"], [data-a="supply"]')).toHaveCount(0); // both buttons are off
  expect(await s.xl.readContract({ address: s.d.pool, abi: tapePoolAbi, functionName: 'maxDeposit', args: [e2e.lender] })).toBe(0n);
  const doubtful = await s.xl.readContract({ address: s.d.pool, abi: tapePoolAbi, functionName: 'stats' }).then((x) => x.doubtful);
  expect(doubtful).toBeGreaterThan(0n);
  // the lender's part of the mark: unreleased income absorbs some of it first, so the loss is at most this
  const lenderShares = await s.xl.readContract({ address: s.d.pool, abi: tapePoolAbi, functionName: 'balanceOf', args: [e2e.lender] });
  const allShares = await s.xl.readContract({ address: s.d.pool, abi: tapePoolAbi, functionName: 'totalSupply' });
  const lenderMark = (doubtful * lenderShares) / allShares + 10n; // + rounding of the deposit and the withdrawal
  // withdrawals keep working: the lender takes everything out through the UI
  await l.go('#/app/withdraw');
  await l.act('wdmax');
  await l.send('withdraw');
  // the doubtful principal is marked down in the share price: the lender's 2 BEM come back short by at most their part of it
  await expect.poll(() => bemOf(e2e, e2e.lender), { timeout: 60_000 }).toBeGreaterThanOrEqual(lenderBem - lenderMark);
  expect(await bemOf(e2e, e2e.lender)).toBeLessThan(lenderBem);
  expect(await s.xl.readContract({ address: s.d.pool, abi: tapePoolAbi, functionName: 'balanceOf', args: [e2e.lender] })).toBe(0n);
  expect(m.problems).toEqual([]);
  expect(l.problems).toEqual([]);
});
