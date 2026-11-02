import { html, type Html } from '../html';
import { t } from '../i18n';
import { dashboard } from './dashboard';
import { markets } from './markets';
import { repayModal, screenModal, supplyModal } from './modals';
import { poolPage } from './pool';
import { groupPage, rigPage, rigsPage } from './rigs';
import { bootCard, footer, gate, header, notFound, pageNotices } from './shell';
import { resetIds, type Ctx } from './ui';
import { connectModal } from './wallets';

export interface Rendered {
  /** The page: header, content and footer. */
  screen: Html;
  /** The open modal: the connect dialog while it is open, else the route's own modal if the page is not gated. */
  modal: Html | null;
  /** The modal is the wide one (the wallet picker has two columns). */
  wide: boolean;
  title: string;
}

const NAV: Record<string, string> = { dash: '', markets: 'markets', pool: 'markets', rigs: 'rigs', group: 'rigs', rig: 'rigs', notfound: '', trace: 'tape' };

/** Pages that show the connected account's data. Markets and the pool page read without a wallet. */
const NEEDS_WALLET = new Set(['dash', 'rigs', 'group', 'rig']);

export function renderApp(c: Ctx): Rendered {
  resetIds();
  const r = c.route;
  const st = c.snap.wallet.status;
  const gated = NEEDS_WALLET.has(r.page) && st !== 'connected' && st !== 'view';
  let content: Html;
  let title: string;
  switch (r.page) {
    case 'dash':
      title = t('Dashboard', '总览');
      content = gated ? gate(c, title) : dashboard(c);
      break;
    case 'markets':
      title = t('Markets', '市场');
      content = markets(c);
      break;
    case 'pool':
      title = t('BEM pool', 'BEM 资金池');
      content = poolPage(c);
      break;
    case 'rigs':
      title = t('Rigs', '矿机');
      content = gated ? gate(c, title) : rigsPage(c);
      break;
    case 'group':
      title = t('Rigs', '矿机');
      content = gated ? gate(c, title) : groupPage(c);
      break;
    case 'rig':
      title = `${t('Rig', '矿机')} #${r.id ?? ''}`;
      content = gated ? gate(c, t('Rigs', '矿机')) : rigPage(c, r.id ?? 0);
      break;
    case 'trace':
      title = 'Tape';
      content = html`<div data-trace-owned></div>`;
      break;
    default:
      title = t('Not found', '未找到页面');
      content = notFound(c);
  }
  // the first read has not finished (or could not): say so instead of drawing zeros as if they were real
  const boot = c.snap.boot;
  const bootState = r.page === 'notfound' || r.page === 'trace' ? undefined : (boot?.pool ?? (NEEDS_WALLET.has(r.page) && !gated ? boot?.account : undefined));
  if (bootState) content = bootCard(title, bootState);
  const screen = html`<div class="v2">${header(c, NAV[r.page] ?? '')}<main class="v2-main${r.page === 'trace' ? ' trace-main' : ''}">${r.page === 'trace' ? html`` : pageNotices(c)}${content}</main>${footer(c)}</div>`;
  let modal: Html | null = null;
  // the connect dialog is on top of any page, gated or not, and never in a frame
  const picking = c.ui.picker !== null && c.readOnly !== 'frame';
  if (picking) modal = connectModal(c);
  else if (!gated && !bootState && r.modal) {
    if (r.modal === 'repay') modal = repayModal(c, r.id ?? 0);
    else if (r.modal === 'screen') modal = screenModal(c, r.id ?? 0);
    else modal = supplyModal(c, r.modal);
  }
  return { screen, modal, wide: picking, title: `TapePool · ${title}` };
}
