import { bem4, bemAuto, fd, native, pctBps, pctFromDecimalString, ringPct, shortAddr, tp4 } from '../logic/format';
import { explorerAddress } from '../config';
import { html, join, type Html, type Part } from '../html';
import { t } from '../i18n';
import { borrowCapOf } from '../logic/selectors';
import { totals, apyTooltip } from './markets';
import { supplyBody } from './supply';
import { B, M, back, cl, img, ring, tip, type Ctx } from './ui';

const kv = (rows: [Part, Part][]): Html => html`<dl class="kv m0">${join(rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`))}</dl>`;

const big = (pct: number, label: string, val: bigint, sub: string): Html =>
  html`<div class="big">${ring(pct, 56)}<div><span class="mut t12">${label}</span><div class="v mono">${bem4(val)} <span class="u">BEM</span></div><span class="mut t12">${sub}</span></div></div>`;

const addr = (a: string): Html => html`<a class="addr nodeco" href="${explorerAddress(a)}" target="_blank" rel="noopener noreferrer">${shortAddr(a)}</a>`;

/** The operating fee as the pool page lists it. */
export function opsFeeCell(c: Ctx): Html {
  const [a, b] = c.snap.pool.params.opsFee;
  if (a === 0n && b === 0n) return html`${t('0 OKB (sponsored)', '0 OKB（由赞助方支付）')}`;
  if (a === b) return html`<span class="mono">${native(a)}</span> OKB ${t('per loan, to the operator', '每笔，归运营方')}`;
  const [d0, d1] = c.snap.pool.params.termDays;
  const value = (v: bigint): Html => v === 0n ? html`${t('0 OKB (sponsored)', '0 OKB（由赞助方支付）')}` : html`<span class="mono">${native(v)}</span> OKB`;
  return html`${value(a)} (${t(`${d0} days`, `${d0} 天`)}) · ${value(b)} (${t(`${d1} days`, `${d1} 天`)}) ${t('per loan, to the operator', '每笔，归运营方')}`;
}

export function poolPage(c: Ctx): Html {
  const { snap } = c;
  const pool = snap.pool;
  const p = pool.params;
  const apy = snap.keeper.apy7d;
  const borrowCap = borrowCapOf(pool);

  const supplyCard = html`<section class="v2-card" aria-labelledby="p1"><div class="v2-card-h"><h2 id="p1"><span class="uid" aria-hidden="true">P1</span>${t('Supply', '存款')}</h2><span class="meta">${t('Lenders receive tpBEM', '出借人获得 tpBEM')}</span></div><div class="v2-card-b col g14">
    ${big(ringPct(pool.totalAssets, p.supplyCap), t('Total supplied', '存款总额'), pool.totalAssets, t(`of the ${bem4(p.supplyCap)} BEM supply cap`, `存款上限：${bem4(p.supplyCap)} BEM`))}
    ${kv([
      [html`${t('Supply APY', '近 7 天增长（按年折算）')} ${tip(apyTooltip())}`, html`<span class="mono ${apy === null ? '' : 'c-pos'}">${apy === null ? '—' : pctFromDecimalString(apy)}</span>`],
      [t('tpBEM value', 'tpBEM 价值'), html`${M(bem4(pool.tpbemValue))} BEM`],
      [t('Idle BEM, available to withdraw', '闲置 BEM（可提取）'), B(pool.idle)],
      ...(pool.unvested == null ? [] : [[t('Income still being released', '待释放收入'), B(pool.unvested)], [t('Release schedule ends', '释放计划结束时间'), pool.vestEnd ? fd(pool.vestEnd, true) : '—']] as [Part, Part][]),
    ])}</div><div class="v2-card-f">${t('Caps only block new deposits, never withdrawals.', '上限只限制新存款，不影响提款。')}</div></section>`;

  const borrowCard = html`<section class="v2-card" aria-labelledby="p2"><div class="v2-card-h"><h2 id="p2"><span class="uid" aria-hidden="true">P2</span>${t('Borrow', '借款')}</h2><span class="meta">${t('Miners borrow against RIG vouchers', '矿工以 RIG 凭证借款')}</span></div><div class="v2-card-b col g14">
    ${big(ringPct(pool.outstanding, borrowCap), t('Total borrowed', '借款总额'), pool.outstanding, t(`of the ${bem4(borrowCap)} BEM borrow cap (${bemAuto(p.borrowCapAbs)} BEM or ${pctBps(p.borrowCapBps)} of the pool, the lower)`, `借款上限：${bem4(borrowCap)} BEM（不超过资金池资产的 ${pctBps(p.borrowCapBps)}）`))}
    <table class="terms"><thead><tr><th>${t('Term', '期限')}</th><th>${t('Flat fee', '固定费用')}</th><th>${t('Debt cap', '债务上限')} ${tip(t('Debt (advance + fee) as a share of what the rig is expected to mine over the term, on base power.', '债务（借款金额 + 固定费用）占矿机在期限内预期基础产出的比例。'))}</th></tr></thead><tbody>${join(
      ([0, 1] as const).map((i) => html`<tr><td>${t(`${p.termDays[i]} days`, `${p.termDays[i]} 天`)}</td><td class="mono">${pctBps(p.feeBps[i])}</td><td class="mono">${pctBps(p.maxDebtBps[i])}</td></tr>`),
    )}</tbody></table>
    ${kv([
      [t('Operating fee', '运营费'), opsFeeCell(c)],
      [t('Minimum advance · fee', '最低借款 · 费用'), html`${M(bemAuto(p.minAdvance))} · ${M(bemAuto(p.minFee))} BEM`],
      [t('Late fee', '滞纳金'), t(`${pctBps(p.lateFeeBpsPerDay)} per day`, `每天 ${pctBps(p.lateFeeBpsPerDay)}`)],
      [t('Per-borrower cap', '单个借款人上限'), t(`${pctBps(p.perBorrowerBps)} of pool assets`, `资金池资产的 ${pctBps(p.perBorrowerBps)}`)],
    ])}</div><div class="v2-card-f">${t('Debt is in BEM and repaid in BEM, so the BEM price never triggers a liquidation. A slow rig is never seized; only a rig proven impaired on-chain can be.', '债务以 BEM 计价、以 BEM 偿还，因此 BEM 价格永远不会触发清算。产出慢的矿机绝不会被没收；只有被链上证明受损的矿机才可能被没收。')}</div></section>`;

  const ck = pool.circuit;
  const ruleCard = html`<section class="v2-card" aria-labelledby="p3"><div class="v2-card-h"><h2 id="p3"><span class="uid" aria-hidden="true">P3</span>${t('Credit rule', '信用规则')}</h2><span class="meta pi">${img('tapeout')}${t('TapeOut circuit on X Layer', 'X Layer 上的 TapeOut 电路')}</span></div><div class="v2-card-b col g12"><p class="m0 c-soft">${t('Every advance must pass a public TapeOut circuit, evaluated on X Layer. Anyone can read and verify the rule; no one can change it quietly.', '每笔借款都必须通过在 X Layer 上执行的公开 TapeOut 电路。任何人都可以读取并验证这条信用规则，没有人能悄悄修改它。')}</p>
    ${kv([
      [t('Processor', '处理器'), `${ck.processorName} (${ck.processorSymbol})`],
      [t('Circuits contract', 'Circuits 合约'), addr(ck.circuits)],
      [t('Circuit ID', '电路 ID'), M(ck.circuitId)],
      [t('Size', '规模'), t(`${ck.gates} NAND gates`, `${ck.gates} 个 NAND 门`)],
      [t('Netlist hash', '网表哈希'), html`<span class="addr">${shortAddr(ck.netlistHash)}</span>`],
      [t('Changing it', '变更'), t('7-day queue, borrows pause meanwhile', '排队 7 天，期间暂停借款')],
    ])}
    <p class="mut m0 t12">${t('Inputs: the term, debt against expected output, fresh rig data, no impairment, an allowed processor, age of at least 3 days and a screen pass. Any unexpected answer means no.', '输入：期限、债务占预期产出、矿机数据新鲜、未受损、处理器允许、上线至少 3 天、筛查通过。任何异常结果都按拒绝处理。')}</p>
    <div><a class="btn btn-s" href="${explorerAddress(ck.circuits)}" target="_blank" rel="noopener noreferrer">${t('Verify on the explorer', '在区块浏览器中验证')}</a></div></div></section>`;

  const k = pool.contracts;
  const contractsCard = html`<section class="v2-card" aria-labelledby="p4"><div class="v2-card-h"><h2 id="p4"><span class="uid" aria-hidden="true">P4</span>${t('Contracts and admin', '合约与管理权限')}</h2></div><div class="v2-card-b col g12">
    ${kv([['TapePool (tpBEM)', addr(k.pool)], ['AgentFactory', addr(k.factory)], ['CreditPolicy', addr(k.policy)], ['RigScreen', addr(k.screen)], ['BEM (OFT)', addr(k.bem)]])}
    <p class="mut m0 t12">${t('The owner can lower caps at once. Every other change, fees included, waits 48 h in a public queue, within hard limits in the code. No one can move pool funds or vouchers.', '所有者可以立即降低上限；其他所有变更（包括费用）都需在公开队列中等待 48 小时，并受代码中的硬性上限约束。任何人都无法挪用资金池资金或凭证。')}</p>
    ${cl('w', t('Smart contracts carry risk. You can lose funds.', '智能合约存在风险，您可能损失资金。'))}</div></section>`;

  return html`${back(c.link('/markets'), t('Markets', '市场'))}
    <div class="v2-title"><div class="head-id">${img('bem', 'i-44')}<div><h1>${t('BEM pool', 'BEM 资金池')}</h1><p>${t('TapePool on X Layer · lend BEM to TapeOut miners', 'TapePool · X Layer · 向 TapeOut 矿工出借 BEM')}</p></div></div>${totals(c)}</div>
    <div class="pw"><div class="v2-stack">${supplyCard}${borrowCard}${ruleCard}${contractsCard}</div><aside>${sideCard(c)}</aside></div>`;
}

function sideCard(c: Ctx): Html {
  const st = c.snap.wallet.status;
  const pos = c.snap.position;
  if (st === 'disconnected' || st === 'wrong-network') {
    return html`<section class="v2-card"><div class="empty empty-c"><b>${t('Supply BEM, receive tpBEM', '存入 BEM，获得 tpBEM')}</b><span>${t('Connect your wallet on X Layer to supply or withdraw.', '在 X Layer 上连接钱包即可存入或提取。')}</span>${
      c.readOnly === 'frame'
        ? ''
        : st === 'wrong-network'
          ? html`<button type="button" class="btn btn-p btn-lg" data-a="switchnet">${t('Switch network', '切换网络')}</button>`
          : html`<button type="button" class="btn btn-p btn-lg" data-a="connect">${t('Connect wallet', '连接钱包')}</button>`
    }</div></section>`;
  }
  const sup = c.ui.sup.tab !== 'withdraw';
  return html`<section class="v2-card" aria-labelledby="p5"><div class="v2-card-h"><h2 id="p5">${t('Your position', '我的存款')}</h2><span class="meta">${M(pos ? tp4(pos.tpbem) : '—')} tpBEM ≈ ${M(pos ? bem4(pos.value) : '—')} BEM</span></div><div class="v2-card-b col g14">
    <div class="seg seg-full" role="tablist" aria-label="Action"><button type="button" role="tab" data-a="suptab" data-v="supply" aria-selected="${String(sup)}" class="seg-half">${t('Supply', '存入')}</button><button type="button" role="tab" data-a="suptab" data-v="withdraw" aria-selected="${String(!sup)}" class="seg-half">${t('Withdraw', '提取')}</button></div>${supplyBody(c, sup)}</div></section>`;
}

