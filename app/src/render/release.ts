import { EMPTY, html, join, type Html } from '../html';
import { t } from '../i18n';
import { openLoanOfAgent } from '../logic/selectors';
import type { AgentView } from '../model';
import { act, cl, type Ctx } from './ui';

/** Keep retries reachable even when a listed voucher has moved to another owner. */
export function releaseEntries(c: Ctx, agent: AgentView): Html {
  if ((!agent.releaseAttempted && agent.collateral.length < 2) || agent.closed || !agent.collateral.length || openLoanOfAgent(c.snap, agent.address)) return EMPTY;
  const entries = agent.collateral.map((id) => {
    const owner = agent.owners?.[String(id)];
    const removable = agent.releaseRetried && owner !== undefined && (owner === null || owner.toLowerCase() !== agent.address.toLowerCase());
    return html`<div class="row-wrap g10"><span class="mono">#${id}</span>${removable ? html`${act(c, { a: 'forget-entry', v: agent.address + '/' + id, kind: 's', needs: ['rigs'] }, t('Remove from the collateral list', '从担保列表移除'))}<span class="mut t12">${t('This only removes the entry. It does not move the voucher.', '这只会移除记录，不会转移凭证。')}</span>` : EMPTY}</div>`;
  });
  return cl('n', html`<b>${t('Vouchers still listed in the agent', '代理中仍列出的凭证')}</b>${join(entries)}${act(c, { a: 'release-entry', v: agent.address, kind: 's', needs: ['rigs'] }, agent.releaseAttempted ? t('Release again', '再次取回') : t('Release voucher', '取回凭证'))}`);
}
