import { decodeFunctionData, parseAbi, parseEther, type Address, type Hex } from 'viem';
import { ADDR } from '../../../keeper/src/addresses';
import { OWNER, RELAY, RIG } from '../../../keeper/test/anvil/harness';
import { bscVaultAbi, reporterAbi, rigAgentAbi, tapeLensAbi, tapePoolAbi } from '../../src/chain/abi';
import { POOL_PARAMS } from '../../src/chain/map';
import { bindingText } from '../../src/chain/errors';
import { setLang } from '../../src/i18n';
import { borrowUi, loanOf, moveUi, openRig, ownerOfRig, refreshUi, releaseUi, repayUi, reuseAgentUi } from './flows';
import { expect, test } from './fixtures';
import { RIG_B, type E2e } from './stack';

const admin = parseAbi(['function queueParam(uint8,uint256)', 'function executeParam(uint8)']);
const transfer = parseAbi(['function transferFrom(address,address,uint256)']);
const helper: Address = '0x00000000000000000000000000000000c0de0001';

async function emptyAgent(e2e: E2e): Promise<Address> {
  const agents = await e2e.s.xl.readContract({ address: e2e.s.d.factory, abi: parseAbi(['function agentsOf(address) view returns (address[])']), functionName: 'agentsOf', args: [e2e.miner] });
  if (!agents[0]) throw new Error('The earlier lifecycle scenarios must create an agent first');
  return agents[0];
}

/** Local test runtime: ownerOf(id) reverts; other calls delegate to the saved runtime at target. */
function unreadableOwner(id: bigint, target: Address): Hex {
  const condition = `60003560e01c636352211e146004357f${id.toString(16).padStart(64, '0')}1416`;
  const size = condition.length / 2 + 4;
  const prefix = `${condition}61${(size + 45).toString(16).padStart(4, '0')}57`;
  const proxy = `363d3d373d3d3d363d73${target.slice(2)}5af43d82803e903d9160${(size + 43).toString(16).padStart(2, '0')}57fd5bf3`;
  return `0x${prefix}${proxy}5b5f5ffd`;
}

/** Registered before the destructive rescue scenario; every test returns both vouchers. */
export function registerRedeployScenarios(): void {
  test('6a. a below-maximum quote keeps its BEM bounds when a queued fee executes at the wallet', async ({ e2e, session }) => {
    const { s } = e2e;
    const previous = await s.xl.readContract({ address: s.d.pool, abi: tapePoolAbi, functionName: 'minFee' });
    await s.as('xl', OWNER).writeContract({ address: s.d.pool, abi: admin, functionName: 'queueParam', args: [6, previous + 1n] });
    await e2e.sync(e2e.now() + 48 * 3600 + 120);
    await e2e.addSecondRig();
    e2e.freshPushLimits();
    const m = await session(e2e.miner);
    await openRig(m);
    const agent = await emptyAgent(e2e);
    await reuseAgentUi(m, agent);
    await moveUi(m);
    await refreshUi(m);
    await m.page.locator('[data-in="b.amt"]').first().fill('0.0100');
    await expect(m.page.locator('[data-a="borrow"]')).toBeEnabled();
    const maximum = await s.xl.readContract({ address: e2e.lens, abi: tapeLensAbi, functionName: 'quote', args: [agent, 0] });
    expect(maximum.maxPrincipal).toBeGreaterThan(1_000_000n);
    const quote = await s.xl.readContract({ address: e2e.lens, abi: tapeLensAbi, functionName: 'quoteFor', args: [agent, 0, 1_000_000n] });
    expect(quote[3]).toBe(true);
    let executed = false;
    m.wallet.setBeforeSend(async (tx) => {
      if (tx.to.toLowerCase() !== agent.toLowerCase() || executed) return;
      const decoded = decodeFunctionData({ abi: rigAgentAbi, data: tx.data });
      if (decoded.functionName !== 'borrow') return;
      expect(decoded.args).toEqual([0, 1_000_000n, quote[0], quote[1]]);
      executed = true;
      await s.as('xl', RELAY).writeContract({ address: s.d.pool, abi: admin, functionName: 'executeParam', args: [6] });
    });
    await m.send('borrow');
    await expect(m.page.getByText('The fee changed. Review the new quote.').first()).toBeVisible();
    expect((await loanOf(e2e, agent)).open).toBe(false);
    expect(executed).toBe(true);
    m.wallet.setBeforeSend(undefined);
    await m.reread();
    await borrowUi(m);
    await s.as('xl', e2e.miner).writeContract({ address: ADDR.voucher, abi: transfer, functionName: 'transferFrom', args: [e2e.miner, agent, RIG_B] });
    await m.go(`#/app/rigs/${RIG_B}`);
    await m.reread();
    await expect(m.page.getByText('Rigs you add now stay outside this loan. Register them after it closes.')).toBeVisible();
    await expect(m.page.locator('[data-a="register"]')).toHaveCount(0);
    await m.send('take-back', Number(RIG_B));
    await m.go(`#/app/rigs/${RIG}`);
    await repayUi(m, e2e);
    await releaseUi(m);
    expect(m.problems).toEqual([]);
  });

  test('6b. live lendLimit bindings, all Param bounds and the lender income schedule', async ({ e2e, session }) => {
    setLang('en', false);
    const { s } = e2e;
    for (const [ordinal, [, low, high]] of POOL_PARAMS.entries()) {
      expect(await s.xl.readContract({ address: s.d.pool, abi: tapePoolAbi, functionName: 'bounds', args: [ordinal] })).toEqual([low, high]);
    }
    const m = await session(e2e.miner);
    await openRig(m);
    const [, binding] = await s.xl.readContract({ address: s.d.pool, abi: tapePoolAbi, functionName: 'lendLimit', args: [e2e.miner] });
    await expect(m.page.getByText(bindingText(binding), { exact: false }).first()).toBeVisible();
    const lender = await session(e2e.lender);
    await lender.open('#/app/markets/bem');
    await lender.connect();
    await expect(lender.page.getByText('Income still being released')).toBeVisible();
    await expect(lender.page.getByText('Release schedule ends')).toBeVisible();
    expect(lender.problems).toEqual([]);
  });

  test('6c. unreadable custody isolates a self-push; partial release retries and forget reconcile the list', async ({ e2e, session }) => {
    const { s } = e2e;
    await e2e.addSecondRig();
    await s.bscTest.setBalance({ address: e2e.miner, value: parseEther('10') });
    const m = await session(e2e.miner);
    await openRig(m);
    const agent = await emptyAgent(e2e);
    await reuseAgentUi(m, agent);
    await moveUi(m);
    await s.as('xl', e2e.miner).writeContract({ address: ADDR.voucher, abi: transfer, functionName: 'transferFrom', args: [e2e.miner, agent, RIG_B] });
    await s.as('xl', e2e.miner).writeContract({ address: agent, abi: rigAgentAbi, functionName: 'register', args: [RIG_B] });
    const [processor, circuitId] = await s.bsc.readContract({ address: ADDR.rigVault, abi: bscVaultAbi, functionName: 'rigs', args: [RIG_B] });
    const processorCode = await s.bsc.getCode({ address: processor });
    const voucherCode = await s.xl.getCode({ address: ADDR.voucher });
    if (!processorCode || !voucherCode) throw new Error('The fork must contain both runtimes');
    try {
      await s.bscTest.setCode({ address: helper, bytecode: processorCode });
      await s.bscTest.setCode({ address: processor, bytecode: unreadableOwner(circuitId, helper) });
      await e2e.sync(e2e.now() + 400);
      await m.reread();
      // `reread` does not wait for the refresh: the price disappears from the link only once the page has read both rigs
      // as collateral (the batch quote of #5 and #16 reverts), so the click below uses that snapshot
      await expect(m.page.locator('[data-a="selfpush"]')).toBeVisible();
      await expect(m.page.locator('[data-a="selfpush"]').first()).not.toContainText('BNB');
      const cost = await s.bsc.readContract({ address: s.d.reporter, abi: reporterAbi, functionName: 'quote', args: [[RIG]] });
      await m.send('selfpush');
      await expect(m.page.locator('#tp-toast')).toContainText('Custody cannot be read for #5');
      const pushed = m.wallet.sent.filter((tx) => tx.to.toLowerCase() === s.d.reporter.toLowerCase());
      expect(pushed).toHaveLength(1);
      expect(pushed[0]?.value).toBe(cost * 11n / 10n);
      expect(pushed[0]?.ask).toMatch(/push\(\[#16\]\).*BNB/s);
      await s.bscTest.setCode({ address: processor, bytecode: processorCode });
      await s.xlTest.setCode({ address: helper, bytecode: voucherCode });
      await s.xlTest.setCode({ address: ADDR.voucher, bytecode: unreadableOwner(RIG_B, helper) });
      await m.send('release-entry', agent);
      expect(await ownerOfRig(e2e, RIG)).toBe(e2e.miner);
      expect(await s.xl.readContract({ address: agent, abi: rigAgentAbi, functionName: 'collateralOf' })).toEqual([RIG_B]);
      await m.go(`#/app/rigs/${RIG_B}`);
      await expect(m.page.getByRole('button', { name: 'Release again' })).toBeVisible();
      await m.send('release-entry', agent);
      await expect(m.page.getByText('This only removes the entry. It does not move the voucher.')).toBeVisible();
      await m.send('forget-entry', `${agent}/${RIG_B}`);
      expect(await s.xl.readContract({ address: agent, abi: rigAgentAbi, functionName: 'collateralOf' })).toEqual([]);
    } finally {
      await s.bscTest.setCode({ address: processor, bytecode: processorCode });
      await s.xlTest.setCode({ address: ADDR.voucher, bytecode: voucherCode });
    }
    await s.as('xl', e2e.miner).writeContract({ address: agent, abi: rigAgentAbi, functionName: 'withdrawVoucher', args: [RIG_B] });
    expect(await ownerOfRig(e2e, RIG_B)).toBe(e2e.miner);
    expect(m.problems).toEqual([]);
  });
}
