import { bem4, fd, native, pctBps, ringPct, tp4 } from '../logic/format';
import { EMPTY, html, join, type Html } from '../html';
import { getLang, t } from '../i18n';
import type { LoanView, PoolParams } from '../model';
import { debtOf, depositsClosed, isOpen, readyRigs, walletRigs } from '../logic/selectors';
import { B, M, act, bar, cl, img, ring, soon, soonTip, tip, type Ctx } from './ui';
import { loanChip } from './loan';

/** "Each loan also pays a 0.031 OKB operating fee": the figure is read from the pool, and the sentence is dropped when the fee is 0. */
export function opsSentence(p: PoolParams): string {
  const [a, b] = p.opsFee;
  if (a === 0n && b === 0n) return '';
  const sentence =
    a === b
      ? t(`Each loan also pays a ${native(a)} OKB operating fee.`, `每笔借款另付 ${native(a)} OKB 运营费。`)
      : t(
          `Each loan also pays an operating fee: ${native(a)} OKB for ${p.termDays[0]} days, ${native(b)} OKB for ${p.termDays[1]} days.`,
          `每笔借款另付运营费：${p.termDays[0]} 天 ${native(a)} OKB，${p.termDays[1]} 天 ${native(b)} OKB。`,
        );
  return (getLang() === 'cn' ? '' : ' ') + sentence;
}

/** A value that scrambles into place when it first appears (src/ascii.ts). */
const reveal = (text: string): Html => html`<span data-ascii="reveal" data-ascii-text="${text}">${text}</span>`;

/** The terms in one line each: `7 d · 0.75%`. */
export const termLine = (p: PoolParams, i: 0 | 1): string => t(`${p.termDays[i]} d · ${pctBps(p.feeBps[i])}`, `${p.termDays[i]} 天 · ${pctBps(p.feeBps[i])}`);

function loanRows(c: Ctx, loans: LoanView[]): Html[] {
  return loans.map((L) => {
    const lead = L.rigIds[0] ?? 0;
    const repaid = L.feePaid === null ? null : L.advance + L.feePaid - debtOf(L);
    const total = L.feePaid === null ? 0n : L.advance + L.feePaid;
    const pct = repaid === null || total === 0n ? null : ringPct(repaid, total);
    const power = L.collateral.reduce((s, r) => s + r.basePower, 0n);
    let actions: Html = html`<a class="btn btn-s" href="${c.link(`/rigs/${lead}`)}">${t('View', '查看')}</a>`;
    if (isOpen(L)) actions = html`${actions}${act(c, { a: 'repay', v: lead }, t('Repay', '还款'))}`;
    if (L.phase === 'cleared') actions = html`<a class="btn btn-p" href="${c.link(`/rigs/${lead}`)}">${t('Release voucher', '取回凭证')}</a>`;
    const debtCell =
      L.phase === 'seized'
        ? html`<span class="mut">${t('Written off', '已核销')}</span>`
        : html`${B(debtOf(L))}${pct === null ? EMPTY : html`<span class="bar-line">${bar(pct, 'bar-72')}<span class="mono mut t11">${pct.toFixed(1)}%</span></span>`}`;
    return html`<tr><td data-l="${t('Rig', '矿机')}"><span><a class="mono nodeco fw6" href="${c.link(`/rigs/${lead}`)}">${L.rigIds.map((id) => `#${id}`).join(', ')}</a><br><span class="mut t12">${power.toString()} H · ${t(`${loanDays(c, L)} days`, `${loanDays(c, L)} 天`)}</span></span></td><td data-l="${t('Debt · repaid', '债务 · 已还')}"><span>${debtCell}</span></td><td data-l="${t('Maturity', '到期')}"><span>${M(fd(L.maturity))}<br>${loanChip(L)}</span></td><td><div class="acts">${actions}</div></td></tr>`;
  });
}

export const loanDays = (c: Ctx, L: LoanView): number => c.snap.pool.params.termDays[L.term];

export function dashboard(c: Ctx): Html {
  const { snap } = c;
  const pool = snap.pool;
  const p = pool.params;
  const pos = snap.position;
  const loans = snap.loans;
  const open = loans.filter(isOpen);
  const debt = open.reduce((s, L) => s + debtOf(L), 0n);
  const nextMat = open.length ? Math.min(...open.map((L) => L.maturity)) : 0;
  const mineRigs = walletRigs(snap);
  const ready = readyRigs(snap).filter((r) => r.facts.place.kind === 'wallet').length;
  const closed = depositsClosed(pool);
  const capRoom = pool.params.supplyCap > pool.totalAssets ? pool.params.supplyCap - pool.totalAssets : 0n;
  const supplyBtn = closed ? html`<span class="btn btn-x" aria-disabled="true">${t('Supply', '存入')}</span>` : html`<a class="btn btn-p" href="${c.link('/supply')}">${t('Supply', '存入')}</a>`;
  const supNote = closed ? cl('w', t('Deposits are closed while a loan is under review. Withdrawals keep working.', '有贷款处于待处理状态，存款暂停；提款不受影响。')) : EMPTY;
  const growth = pos?.growth ?? null;
  const rows = loanRows(c, loans);

  return html`<div class="v2-title"><div><h1 data-ascii="reveal" data-ascii-text="${t('Dashboard', '总览')}">${t('Dashboard', '总览')}</h1><p>${t('Your supplies and your loans in one place.', '您的存款和贷款，一页查看。')}</p></div><div class="seg" role="tablist" aria-label="Pool"><a role="tab" aria-selected="true" href="${c.link()}">${img('bem')}${t('BEM pool', 'BEM 资金池')}</a><a role="tab" aria-selected="false" aria-disabled="true" title="${soonTip()}">${img('fabx', 'i-dim')}${t('FAB pool', 'FAB 资金池')} ${soon()}</a></div></div>
    <section class="v2-stats" aria-label="${t('Your position', '您的仓位')}">
      <div class="v2-stat"><span class="l">${t('Supplied', '已存入')}</span><span class="v mono">${reveal(pos ? bem4(pos.value) : '—')} <span class="u">BEM</span></span><span class="s">${pos ? tp4(pos.tpbem) : '—'} tpBEM</span></div>
      <div class="v2-stat"><span class="l">${t('Growth since deposit', '存入以来增长')}</span><span class="v mono ${growth !== null && growth >= 0n ? 'c-pos' : ''}">${growth === null ? '—' : html`${reveal(`${growth >= 0n ? '+' : ''}${bem4(growth)}`)} <span class="u">BEM</span>`}</span><span class="s">${t('From fees borrowers paid', '来自借款人支付的费用')}</span></div>
      <div class="v2-stat"><span class="l">${t('Debt', '债务')}</span><span class="v mono">${reveal(bem4(debt))} <span class="u">BEM</span></span><span class="s">${t(`${open.length} open ${open.length === 1 ? 'loan' : 'loans'}`, `${open.length} 笔进行中的贷款`)}</span></div>
      <div class="v2-stat"><span class="l">${t('Next maturity', '下次到期')}</span><span class="v mono">${reveal(nextMat ? fd(nextMat) : '—')}</span><span class="s">${nextMat ? t('Harvested once output covers the debt, at the latest in the last hour before it', '产出足以还清债务时即领取收益，最迟在到期前最后一小时') : t('No open loan', '暂无进行中的贷款')}</span></div>
    </section>
    <div class="v2-quad">
      <section class="v2-card" aria-labelledby="ys"><div class="v2-card-h"><h2 id="ys"><span class="uid" aria-hidden="true">S1</span>${t('Your supplies', '我的存款')}</h2><span class="meta">${t('tpBEM value', 'tpBEM 价值')} <span class="mono c-w">${bem4(pool.tpbemValue)}</span> BEM</span></div>
        <table class="v2-tbl stack"><thead><tr><th>${t('Asset', '资产')}</th><th class="r">${t('Balance', '余额')}</th><th></th></tr></thead><tbody><tr><td><div class="asset">${img('tpbem', 'i-tp')}<span><a class="nodeco" href="${c.link('/markets/bem')}"><b>tpBEM</b></a><small>${t('Your share of the BEM pool', '您在 BEM 资金池中的份额')}</small></span></div></td><td class="r" data-l="${t('Balance', '余额')}"><span><span class="mono">${pos ? tp4(pos.tpbem) : '—'}</span><br><span class="mut t12">≈ <span class="mono">${pos ? bem4(pos.value) : '—'}</span> BEM</span></span></td><td><div class="acts"><a class="btn btn-s" href="${c.link('/withdraw')}">${t('Withdraw', '提取')}</a>${supplyBtn}</div></td></tr></tbody></table>
        <div class="v2-card-f">${t('Withdrawable now', '当前可提取')} <span class="mono c-w">${pos ? bem4(pos.withdrawable) : '—'}</span> BEM ${tip(t('Paid from idle BEM, the part of the pool that is not lent out.', '提款由闲置 BEM（资金池中未借出的部分）支付。'), 'up')}</div></section>
      <section class="v2-card" aria-labelledby="yl"><div class="v2-card-h"><h2 id="yl"><span class="uid" aria-hidden="true">B1</span>${t('Your loans', '我的贷款')}</h2><a href="${c.link('/rigs')}" class="meta c-blue nodeco fw6">${t('All rigs', '全部矿机')}</a></div>
        ${rows.length ? html`<table class="v2-tbl stack"><thead><tr><th>${t('Rig', '矿机')}</th><th>${t('Debt · repaid', '债务 · 已还')}</th><th>${t('Maturity', '到期')}</th><th></th></tr></thead><tbody>${join(rows)}</tbody></table>` : html`<div class="empty"><b>${t('No open loan', '暂无进行中的贷款')}</b></div>`}
        <div class="v2-card-f">${t('Mined BEM repays a loan once it is harvested: by the keeper as soon as the output covers the debt (checked every 10 minutes), otherwise in the last hour before maturity, or earlier by you on tapeout.net. A slow rig is never seized.', '挖出的 BEM 在领取收益后用于还款：产出足以还清债务时 keeper 即领取（每 10 分钟检查一次），否则在到期前最后一小时领取；您也可以提前在 tapeout.net 上领取。产出慢的矿机绝不会被没收。')}</div></section>
      <section class="v2-card" aria-labelledby="ats"><div class="v2-card-h"><h2 id="ats"><span class="uid" aria-hidden="true">S2</span>${t('Assets to supply', '可存入资产')}</h2><span class="meta">${t('Supply BEM, receive tpBEM', '存入 BEM，获得 tpBEM')}</span></div>
        <table class="v2-tbl stack"><thead><tr><th>${t('Asset', '资产')}</th><th class="r">${t('Wallet balance', '钱包余额')}</th><th class="r">${t('Room in supply cap', '存款上限剩余')}</th><th></th></tr></thead><tbody><tr><td><div class="asset">${img('bem', 'i-r9')}<span><a class="nodeco" href="${c.link('/markets/bem')}"><b>BEM</b></a><small>${t('TapePool BEM pool', 'TapePool BEM 资金池')}</small></span></div></td><td class="r mono" data-l="${t('Wallet balance', '钱包余额')}">${bem4(snap.wallet.bem)}</td><td class="r" data-l="${t('Room in supply cap', '存款上限剩余')}"><span class="inl10"><span class="mono">${bem4(capRoom)}</span>${ring(ringPct(pool.totalAssets, p.supplyCap), 30)}</span></td><td><div class="acts">${closed ? html`<span class="btn btn-x" aria-disabled="true">${t('Supply', '存入')}</span>` : html`<a class="btn btn-p" href="${c.link('/supply')}">${t('Supply', '存入')}</a>`}</div></td></tr>
          <tr class="row-soon"><td class="dim"><div class="asset">${img('fabx', 'i-r9')}<span><b>FAB</b><small>${t('FabX rigs pool', 'FabX 矿机资金池')}</small></span></div></td><td class="r dim mut" data-l="${t('Wallet balance', '钱包余额')}">—</td><td class="r dim mut" data-l="${t('Room in supply cap', '存款上限剩余')}">—</td><td><div class="acts">${soon()}</div></td></tr></tbody></table>
        <div class="v2-card-b pt0">${supNote}</div>
        <div class="v2-card-f">${t('Deposits stop at the supply cap. Smart contracts carry risk: you can lose funds.', '存款达到存款上限即停止。智能合约存在风险，您可能损失资金。')}</div></section>
      <section class="v2-card" aria-labelledby="atb"><div class="v2-card-h"><h2 id="atb"><span class="uid" aria-hidden="true">B2</span>${t('Borrow against your rigs', '用矿机借款')}</h2><span class="meta">${t('Pool room for you', '您的可借额度')} <span class="mono c-w">${bem4(snap.wallet.room)}</span> BEM</span></div>
        <table class="v2-tbl stack"><thead><tr><th>${t('Asset', '资产')}</th><th>${t('Terms', '借贷条款')}</th><th>${t('Ready rigs', '可借矿机')}</th><th></th></tr></thead><tbody><tr><td><div class="asset">${img('bem', 'i-r9')}<span><b>BEM</b><small>${t('Against TapeOut RIG vouchers', '以 TapeOut RIG 凭证借款')}</small></span></div></td><td data-l="${t('Terms', '借贷条款')}"><span><span class="mono">${termLine(p, 0)}</span><br><span class="mono">${termLine(p, 1)}</span></span></td><td data-l="${t('Ready rigs', '可借矿机')}"><span><span class="mono">${ready}</span> <span class="mut">${t(`of ${mineRigs.length}`, `/ ${mineRigs.length}`)}</span></span></td><td><div class="acts"><a class="btn btn-p" href="${c.link('/rigs')}">${t('Borrow', '借款')}</a></div></td></tr>
          <tr class="row-soon"><td class="dim"><div class="asset">${img('fabx', 'i-r9')}<span><b>FAB</b><small>${t('Against FabX rigs', '以 FabX 矿机借款')}</small></span></div></td><td class="dim mut" data-l="${t('Terms', '借贷条款')}">—</td><td class="dim mut" data-l="${t('Ready rigs', '可借矿机')}">—</td><td><div class="acts">${soon()}</div></td></tr></tbody></table>
        <div class="v2-card-f">${t(`Debt is capped at ${pctBps(p.maxDebtBps[0])} (${p.termDays[0]} days) or ${pctBps(p.maxDebtBps[1])} (${p.termDays[1]} days) of what your rig is expected to mine over the term.${opsSentence(p)}`, `债务上限为矿机在期限内预期基础产出的 ${pctBps(p.maxDebtBps[0])}（${p.termDays[0]} 天）或 ${pctBps(p.maxDebtBps[1])}（${p.termDays[1]} 天）。${opsSentence(p)}`)}</div></section>
    </div>`;
}
