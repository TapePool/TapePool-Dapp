import { EXPLORER } from '../config';
import { EMPTY, html, type Html } from '../html';
import { getLang, t } from '../i18n';
import { bemTrim } from '../logic/format';
import type { TransactionKind } from '../model';
import { img, type Ctx } from './ui';

export function transactions(c: Ctx): Html {
  const history = c.snap.transactions;
  const labels = {
    all: t('All transactions', '全部交易'),
    supply: t('Supply', '存入'),
    withdraw: t('Withdraw', '提取'),
    borrow: t('Borrow', '借款'),
    repay: t('Repay', '还款'),
  };
  const filter = c.ui.transactionKind;
  const matches = history?.rows.filter((row) => filter === 'all' || row.kind === filter) ?? [];
  const locale = getLang() === 'cn' ? 'zh-CN' : 'en-US';
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short' });
  const groups = new Map<string, Html[]>();
  for (const row of matches.slice(0, c.ui.transactionLimit)) {
    const when = new Date(row.time * 1000);
    const day = date.format(when);
    const entries = groups.get(day) ?? [];
    const intoPool = row.kind === 'supply' || row.kind === 'repay';
    entries.push(html`<li class="tx-row">
      <span class="tx-direction" aria-hidden="true">${intoPool ? '↓' : '↑'}</span>
      <div><strong>${labels[row.kind]}</strong><time datetime="${when.toISOString()}">${time.format(when)}</time></div>
      <span class="tx-value">${img('bem')}<span class="mono">${bemTrim(row.amount)} BEM</span></span>
      <a class="tx-link" href="${EXPLORER}/tx/${row.hash}" target="_blank" rel="noopener noreferrer" aria-label="${t('View transaction', '查看交易')} ${row.hash}">${row.hash.slice(0, 6)}…${row.hash.slice(-4)} ↗</a>
    </li>`);
    groups.set(day, entries);
  }
  const kinds: ('all' | TransactionKind)[] = ['all', 'supply', 'withdraw', 'borrow', 'repay'];
  const empty = !history ? t('Transaction history is unavailable.', '暂时无法读取交易记录。')
    : history.syncing ? t('Syncing transaction history…', '正在同步交易记录…')
    : filter === 'all' ? t('No transactions yet.', '暂无交易。') : t('No matching transactions.', '没有符合条件的交易。');
  return html`<section class="v2-card tx-card" aria-labelledby="tx-title">
    <div class="v2-card-h"><h2 id="tx-title">${t('Transactions', '交易记录')}</h2>
      <select id="transaction-kind" aria-label="${t('Transaction type', '交易类型')}">${kinds.map((k) =>
        html`<option value="${k}"${k === filter ? html` selected` : EMPTY}>${labels[k]}</option>`)}</select></div>
    ${groups.size ? html`<div class="tx-days">${Array.from(groups, ([day, entries]) => html`<div><h3>${day}</h3><ul>${entries}</ul></div>`)}</div>` : html`<p class="tx-empty">${empty}</p>`}
    ${history?.syncing && groups.size ? html`<div class="v2-card-f">${t('Syncing newer transactions…', '正在同步后续交易…')}</div>` : EMPTY}
    ${matches.length > c.ui.transactionLimit ? html`<div class="v2-card-f"><button type="button" class="btn btn-s" data-a="more-transactions">${t('Show more', '查看更多')}</button></div>` : EMPTY}
    ${history?.rows.length === 100 ? html`<div class="v2-card-f">${t('Latest 100 transactions', '最近 100 笔交易')}</div>` : EMPTY}
  </section>`;
}
