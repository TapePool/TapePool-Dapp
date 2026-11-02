import { TPBEM_DECIMALS } from '../constants';
import { bem4, bemExact, fd, parseAmount, tp4 } from '../logic/format';
import { html, type Html } from '../html';
import { t } from '../i18n';
import { depositsClosed } from '../logic/selectors';
import { act, cl, img, soon, soonTip, type Ctx } from './ui';

/** The shared body of the Supply and Withdraw panels (the BEM pool page and the dashboard modal). */
export function supplyBody(c: Ctx, supplying: boolean): Html {
  const { snap, ui } = c;
  const pool = snap.pool;
  const pos = snap.position;
  const closed = depositsClosed(pool);
  const s = ui.sup;
  const cap = pool.params.supplyCap;
  const capRoom = cap > pool.totalAssets ? cap - pool.totalAssets : 0n;
  const room = pos ? (pos.maxDeposit < capRoom ? pos.maxDeposit : capRoom) : capRoom;
  const price = pool.tpbemValue;

  if (supplying) {
    const v = parseAmount(s.amount, 8);
    const ok = v !== null && v > 0n;
    const a = ok ? v : 0n;
    let err = '';
    if (!ok) err = t('Enter an amount.', '请输入金额。');
    else if (a > snap.wallet.bem) err = t('More than your wallet balance.', '超过钱包余额。');
    else if (a > room) err = t('Above the room left in the supply cap.', '超过存款上限剩余额度。');
    const afterRaw = pool.totalAssets + a;
    const after = afterRaw < cap ? afterRaw : cap;
    const off = closed || err !== '';
    const approved = ok && snap.wallet.allowancePool >= a;
    const shares = price > 0n ? (a * 10n ** BigInt(TPBEM_DECIMALS)) / price : 0n;
    const pctAfter = cap > 0n ? Number((after * 100n) / cap) : 0;
    return html`${pool.unvested == null ? '' : html`<p class="note m0">${t(`The share price includes released income only. ${bem4(pool.unvested)} BEM is still being released; the schedule ends ${pool.vestEnd ? fd(pool.vestEnd, true) : '—'}.`, `份额价格只计入已释放收入。另有 ${bem4(pool.unvested)} BEM 待释放，计划于 ${pool.vestEnd ? fd(pool.vestEnd, true) : '—'} 结束。`)}</p>`}${closed ? cl('w', html`<b>${t('Deposits are closed while a loan is under review.', '有贷款处于待处理状态，存款暂停。')}</b> ${t('They reopen when it is resolved. Withdrawals keep working.', '问题解决后恢复。提款不受影响。')}`) : ''}
      <div class="amt"><div class="amt-row"><label for="sup-amt" class="mut t12">${t('Amount', '金额')}</label><span class="mut ml-a t12">${t('Wallet', '钱包')} <span class="mono c-w">${bem4(snap.wallet.bem)}</span> BEM</span></div><div class="amt-row"><input id="sup-amt" type="text" inputmode="decimal" data-in="sup.amount" value="${s.amount}"${closed ? html` disabled` : ''}><span class="tok">${img('bem')}BEM</span><button type="button" class="maxb" data-a="supmax">MAX</button></div>${err && !closed ? html`<span class="err" role="alert">${err}</span>` : ''}</div>
      <dl class="kv m0"><div><dt>${t('You receive about', '预计获得')}</dt><dd><span class="mono">${tp4(shares)}</span> tpBEM</dd></div><div><dt>${t('tpBEM value', 'tpBEM 价值')}</dt><dd><span class="mono">${bem4(price)}</span> BEM</dd></div><div><dt>${t('Supply cap after', '存入后上限占用')}</dt><dd><span class="mono">${bem4(after)}</span> <span class="mut">/</span> <span class="mono">${bem4(cap)}</span> · <span class="mono">${pctAfter}%</span></dd></div><div><dt>${t('Room left after', '剩余额度')}</dt><dd><span class="mono">${bem4(room > a ? room - a : 0n)}</span> BEM</dd></div></dl>
      <p class="note m0">${t('Supplying takes two transactions: allow the pool to use your BEM, then supply it. Withdrawals are paid from idle BEM and are never blocked by caps or pauses. Smart contracts carry risk: you can lose funds.', '存入需要两笔交易：先授权资金池使用您的 BEM，再存入。提款由闲置 BEM 支付，不受上限或暂停影响。智能合约存在风险，您可能损失资金。')}</p>
      <div class="steps">${act(c, { a: 'approve-supply', size: 'lg', offKind: approved ? 's' : 'x', disabled: off || approved, needs: ['pool', 'wallet'] }, approved ? t('1 · BEM allowed', '1 · 已授权 BEM') : t('1 · Allow BEM', '1 · 授权 BEM'))}${act(c, { a: 'supply', size: 'lg', disabled: !(approved && !off), needs: ['pool', 'wallet'] }, t('2 · Supply BEM', '2 · 存入 BEM'))}</div>`;
  }

  const maxW = pos?.withdrawable ?? 0n;
  const w = parseAmount(s.wamount, 8);
  const wok = w !== null && w > 0n && w <= maxW;
  const burn = wok && price > 0n ? (w * 10n ** BigInt(TPBEM_DECIMALS) + price - 1n) / price : 0n;
  return html`<div class="amt"><div class="amt-row"><label for="wd-amt" class="mut t12">${t('Amount', '金额')}</label><span class="mut ml-a t12">${t('Withdrawable now', '当前可提取')} <span class="mono c-w">${bem4(maxW)}</span> BEM</span></div><div class="amt-row"><input id="wd-amt" type="text" inputmode="decimal" data-in="sup.wamount" value="${s.wamount}"><span class="tok">${img('bem')}BEM</span><button type="button" class="maxb" data-a="wdmax">MAX</button></div>${!wok && s.wamount !== '' ? html`<span class="err" role="alert">${t('More than you can withdraw right now.', '超过当前可提取金额。')}</span>` : ''}</div>
    <dl class="kv m0"><div><dt>${t('tpBEM burned, about', '预计销毁')}</dt><dd><span class="mono">${tp4(burn)}</span> tpBEM</dd></div><div><dt>${t('Still supplied after', '提取后剩余存款')}</dt><dd><span class="mono">${bem4(wok ? maxW - (w ?? 0n) : maxW)}</span> BEM</dd></div><div><dt>${t('Paid from idle BEM', '由闲置 BEM 支付')}</dt><dd>${t(`${bem4(pool.idle)} BEM in the pool`, `资金池中 ${bem4(pool.idle)} BEM`)}</dd></div></dl>
    <p class="note m0">${t('You can withdraw up to the idle BEM in the pool. BEM that is lent out comes back as loans are repaid. Withdrawals stay open during pauses and reviews.', '最多可提取资金池中的闲置 BEM。已借出的 BEM 会随贷款偿还回到资金池。暂停和贷款待处理期间提款照常开放。')}</p>
    ${act(c, { a: 'withdraw', size: 'lg', disabled: !wok, needs: ['pool', 'wallet'] }, t('Withdraw BEM', '提取 BEM'))}`;
}

/** Fill the amount boxes for the MAX buttons. */
export const supplyMaxText = (wallet: bigint, room: bigint): string => bemExact(wallet < room ? wallet : room);
export const withdrawMaxText = (withdrawable: bigint): string => bemExact(withdrawable);

export function assetSeg(): Html {
  return html`<div class="seg seg-full" role="radiogroup" aria-label="${t('Asset', '资产')}"><button type="button" role="radio" aria-checked="true" aria-pressed="true" class="seg-half">${img('bem')}BEM</button><button type="button" role="radio" aria-checked="false" aria-disabled="true" title="${soonTip()}" class="seg-half">${img('fabx', 'i-dim5')}FAB ${soon()}</button></div>`;
}

