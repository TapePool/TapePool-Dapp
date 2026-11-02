import { TWITTER_URL } from '../config';
import { bem4, bemExact, parseAmount } from '../logic/format';
import { EMPTY, html, raw, type Html } from '../html';
import { t } from '../i18n';
import { debtOf, isOpen, loanForRig } from '../logic/selectors';
import { screenNote } from './rigs';
import { assetSeg, supplyBody } from './supply';
import { walletAsk } from './shell';
import { B, act, cl, img, type Ctx } from './ui';

const X_ICON = raw('<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2L12 12M12 2L2 12" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round"></path></svg>');
const closeLink = (href: string): Html => html`<a class="mdl-x" href="${href}" aria-label="Close">${X_ICON}</a>`;
const frame = (c: Ctx, inner: Html): Html => html`<section class="mdl" role="dialog" aria-modal="true" aria-labelledby="mdl-t">${inner}${walletAsk(c)}</section>`;

export function supplyModal(c: Ctx, tab: 'supply' | 'withdraw'): Html {
  const sup = tab === 'supply';
  return frame(c, html`<div class="mdl-h"><h2 id="mdl-t">${sup ? t('Supply BEM', '存入 BEM') : t('Withdraw BEM', '提取 BEM')}</h2>${closeLink(c.link())}</div>
    <div class="seg seg-full" role="tablist" aria-label="Action"><a role="tab" href="${c.link('/supply')}" aria-selected="${sup ? 'true' : 'false'}" class="seg-half">${t('Supply', '存入')}</a><a role="tab" href="${c.link('/withdraw')}" aria-selected="${sup ? 'false' : 'true'}" class="seg-half">${t('Withdraw', '提取')}</a></div>
    ${assetSeg()}${supplyBody(c, sup)}`);
}

export function repayModal(c: Ctx, id: number): Html {
  const L = loanForRig(c.snap, id);
  const back = c.link(`/rigs/${id}`);
  if (!L || !isOpen(L))
    return frame(c, html`<div class="mdl-h"><h2 id="mdl-t">${t('Repay loan', '偿还贷款')}</h2>${closeLink(back)}</div><p class="mut m0">${t('This loan has nothing left to repay.', '这笔贷款已无需还款。')}</p>`);
  const d = debtOf(L);
  const need = d > L.agentBem ? d - L.agentBem : 0n;
  const text = c.ui.rep.amount ?? bemExact(need);
  const v = parseAmount(text, 8);
  const ok = v !== null && v > 0n;
  let err = '';
  if (!ok) err = t('Enter an amount.', '请输入金额。');
  else if (v > c.snap.wallet.bem) err = t('More than your wallet balance.', '超过钱包余额。');
  const pay = ok ? (v < need ? v : need) : 0n;
  const after = d > L.agentBem + pay ? d - L.agentBem - pay : 0n;
  const allowed = (c.snap.wallet.allowanceAgent[L.agent.toLowerCase()] ?? 0n) >= pay && pay > 0n;
  const off = err !== '' || need === 0n;
  return frame(c, html`<div class="mdl-h"><h2 id="mdl-t">${t('Repay loan', '偿还贷款')} · <span class="mono t15">${L.rigIds.map((i) => `#${i}`).join(', ')}</span></h2>${closeLink(back)}</div>
    <div class="amt"><div class="amt-row"><label for="rep-amt" class="mut t12">${t('Amount', '金额')}</label><span class="mut ml-a t12">${t('Wallet', '钱包')} <span class="mono c-w">${bem4(c.snap.wallet.bem)}</span> BEM</span></div><div class="amt-row"><input id="rep-amt" type="text" inputmode="decimal" data-in="rep.amount" value="${text}"><span class="tok">${img('bem')}BEM</span><button type="button" class="maxb" data-a="repmax">${t('FULL', '全部')}</button></div>${err ? html`<span class="err" role="alert">${err}</span>` : EMPTY}</div>
    <dl class="kv m0"><div><dt>${t('Debt now', '当前债务')}</dt><dd>${B(d)}</dd></div><div><dt>${t('Already in the agent', '代理中已有')}</dt><dd>${B(L.agentBem)}</dd></div><div><dt>${t('You pay', '您支付')}</dt><dd>${B(pay)}</dd></div><div><dt>${t('Debt after', '还款后债务')}</dt><dd>${B(after)}</dd></div></dl>
    <p class="note m0">${t("The agent's own BEM is used first, so the pool never takes more than the debt. Repaying early does not reduce the flat fee. Two transactions: allow BEM, then repay.", '代理中已有的 BEM 优先用于还款，资金池不会多收。提前还款不会减少固定费用。需要两笔交易：先授权 BEM，再还款。')}${after === 0n ? ` ${t('Once the debt is 0, release the voucher on the rig page.', '债务清零后，请在矿机页面取回凭证。')}` : ''}</p>
    ${need === 0n ? html`<div class="steps">${act(c, { a: 'sweep', v: L.rigIds[0] ?? id, size: 'lg', needs: ['loans'] }, t("Apply the agent's BEM", '用代理中的 BEM 还款'))}</div>` : html`<div class="steps">${act(c, { a: 'approve-repay', v: id, size: 'lg', offKind: allowed ? 's' : 'x', disabled: off || allowed, needs: ['loans', 'wallet'] }, allowed ? t('1 · BEM allowed', '1 · 已授权 BEM') : t('1 · Allow BEM', '1 · 授权 BEM'))}${act(c, { a: 'repay-do', v: id, size: 'lg', disabled: !(allowed && !off), needs: ['loans', 'wallet'] }, t('2 · Repay', '2 · 还款'))}</div>`}`);
}

/** The note that replaces the request form (option C of SPEC-PHASE5-APP §12). */
export function screenModal(c: Ctx, id: number): Html {
  return frame(c, html`<div class="mdl-h"><h2 id="mdl-t">${t('Ask for a screen', '申请筛查')} · <span class="mono">#${id}</span></h2>${closeLink(c.link(`/rigs/${id}`))}</div>
    <p class="m0 c-soft">${t('Revocation is the main risk for lenders, so every rig needs a screen pass before it can borrow.', '撤销是出借人面临的主要风险，因此每台矿机借款前都需要通过筛查。')}</p>
    <p class="mut m0">${t(`The screen checks that #${id} matches every official vector of its task, locally and through PodMining's own challenge. It only reads data: you send no transaction. If it passes, the pass is recorded on-chain and counts 48 h later.`, `筛查会在本地并通过 PodMining 自身的 challenge 验证 #${id} 与其任务的全部官方测试向量一致。筛查只读取数据，您无需发起交易。通过后，结果记录在链上，48 小时后生效。`)}</p>
    ${cl('i', html`${screenNote()}`, html`<a class="btn btn-s btn-sm" href="${TWITTER_URL}" target="_blank" rel="noopener noreferrer">${t('TapePool on X', 'X 上的 TapePool')}</a>`)}`);
}
