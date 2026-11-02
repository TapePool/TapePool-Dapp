import { bem4, bemTrim, pctBps, pctFromDecimalString, ringPct, yearlyFromBps } from '../logic/format';
import { html, join, type Html } from '../html';
import { t } from '../i18n';
import { borrowCapOf, depositsClosed } from '../logic/selectors';
import { img, ring, soon, soonTip, tip, type Ctx } from './ui';

/** The three totals shown at the top of the Markets and BEM pool pages. */
export function totals(c: Ctx): Html {
  const p = c.snap.pool;
  const cell = (label: string, v: bigint): Html => html`<div><dt>${label}</dt><dd class="mono">${bem4(v)} <span class="u">BEM</span></dd></div>`;
  return html`<dl class="v2-tot" aria-label="${t('BEM pool totals', 'BEM 资金池概况')}">${cell(t('Total supply', '存款总额'), p.totalAssets)}${cell(t('Total borrow', '借款总额'), p.outstanding)}${cell(t('Available liquidity', '可用流动性'), p.idle)}</dl>`;
}

/** The tooltip on the Borrow Fee column and the same figures on the pool page. */
export function feeTooltip(c: Ctx): string {
  const p = c.snap.pool.params;
  const [d0, d1] = p.termDays;
  const [f0, f1] = p.feeBps;
  return t(
    `One flat fee per loan: ${pctBps(f0)} for ${d0} days or ${pctBps(f1)} for ${d1} days. That is ${yearlyFromBps(f0, d0)} a year. Minimum fee ${bemTrim(p.minFee)} BEM.`,
    `每笔借款收取一次固定费用：${d0} 天 ${pctBps(f0)}，${d1} 天 ${pctBps(f1)}，折合每年 ${yearlyFromBps(f0, d0)}。最低费用 ${bemTrim(p.minFee)} BEM。`,
  );
}

export const apyTooltip = (): string =>
  t('How much tpBEM grew in the last 7 days, shown as a yearly rate. It moves with the fees borrowers pay.', '过去 7 天 tpBEM 的增长，按年折算。随借款人支付的费用变化。');

export function markets(c: Ctx): Html {
  const { snap } = c;
  const pool = snap.pool;
  const p = pool.params;
  const apy = snap.keeper.apy7d;
  const supply = depositsClosed(pool)
    ? html`<span class="btn btn-x" aria-disabled="true">${t('Supply', '存入')}</span>`
    : html`<a class="btn btn-p" href="${c.link('/supply')}">${t('Supply', '存入')}</a>`;
  const H = [t('Total Supplied', '存款总额'), t('Supply APY', '近 7 天增长（按年折算）'), t('Total Borrowed', '借款总额'), t('Borrow Fee', '借款费用')];
  const borrowCap = borrowCapOf(pool);
  return html`<div class="v2-title"><div><h1>${t('Markets', '市场')}</h1><p>${t('Lend BEM to TapeOut miners and earn the fees they pay.', '向 TapeOut 矿工出借 BEM，获得借款人支付的费用。')}</p></div>${totals(c)}</div>
    <section class="v2-card" aria-labelledby="mk"><div class="v2-card-h"><h2 id="mk"><span class="uid" aria-hidden="true">M1</span>${t('Pools', '资金池')}</h2><span class="meta">${t('1 live · 1 coming soon', '1 个已上线 · 1 个即将上线')}</span></div><div class="xs">
      <table class="v2-tbl stack"><thead><tr><th>${t('Asset', '资产')}</th><th class="r">${H[0]}</th><th class="r">${H[1]} ${tip(apyTooltip(), 'end')}</th><th class="r">${H[2]}</th><th class="r"><span>${H[3]}</span> ${tip(feeTooltip(c), 'end')}</th><th></th></tr></thead><tbody>
        <tr class="agrow" data-a="go" data-v="${c.link('/markets/bem')}"><td><div class="asset">${img('bem', 'i-r9')}<span><a class="nodeco" href="${c.link('/markets/bem')}"><b>BEM</b></a><small>${t('TapePool · on X Layer', 'TapePool · X Layer')}</small></span></div></td>
          <td class="r" data-l="${H[0]}"><span class="inl10"><span class="mono">${bem4(pool.totalAssets)}</span>${ring(ringPct(pool.totalAssets, p.supplyCap), 34)}</span></td>
          <td class="r" data-l="${H[1]}"><span class="mono ${apy === null ? '' : 'c-pos'}">${apy === null ? '—' : pctFromDecimalString(apy)}</span></td>
          <td class="r" data-l="${H[2]}"><span class="inl10"><span class="mono">${bem4(pool.outstanding)}</span>${ring(ringPct(pool.outstanding, borrowCap), 34)}</span></td>
          <td class="r" data-l="${H[3]}"><span><span class="mono">${pctBps(p.feeBps[0])}</span> <span class="u">${t(`/ ${p.termDays[0]} days`, `/ ${p.termDays[0]} 天`)}</span></span></td>
          <td><div class="acts"><a class="btn btn-s" href="${c.link('/rigs')}">${t('Borrow', '借款')}</a>${supply}</div></td></tr>
        <tr class="row-soon"><td class="dim"><div class="asset">${img('fabx', 'i-r9')}<span><b>FAB</b><small>${t('For FabX rigs · on X Layer', 'FabX 矿机 · X Layer')}</small></span></div></td>${join(H.map((l) => html`<td class="r dim mut" data-l="${l}">—</td>`))}<td><div class="acts">${soon()}</div></td></tr></tbody></table></div>
      <div class="v2-card-f">${soonTip()}</div></section>`;
}
