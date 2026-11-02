import aboutHome from '../assets/wallets/about-home.svg';
import aboutLogin from '../assets/wallets/about-login.svg';
import binanceLogo from '../assets/wallets/binance.svg';
import metamaskLogo from '../assets/wallets/metamask.svg';
import okxLogo from '../assets/wallets/okx.svg';
import phantomLogo from '../assets/wallets/phantom.svg';
import rabbyLogo from '../assets/wallets/rabby.svg';
import trustLogo from '../assets/wallets/trust.svg';
import { errorDetails, errorText, type AppError } from '../chain/errors';
import { explorerAddress } from '../config';
import { EMPTY, html, raw, type Html } from '../html';
import { t } from '../i18n';
import { menuAddr, shortAddr } from '../logic/format';
import { cleanName, groupWallets, knownWallet, recommendedByKey, RECOMMENDED_SHOWN, safeIcon, type Recommended, type RecommendedKey } from '../logic/wallets';
import type { WalletOption } from '../model';
import type { PickerView } from '../state';
import type { Ctx } from './ui';

/**
 * The connect dialog and the menu on the wallet pill (`data-a="connect"` opens the first, `data-a="menu"` the second).
 *
 * Everything a wallet announces about itself is untrusted. The name is cleaned and escaped; the icon is used only if it is a base64
 * image data URI (`logic/wallets.ts`, the policy allows `data:` images) and only as an escaped `src`, never as markup. When it is not
 * usable, a wallet the app knows (by the `rdns` it announced) gets the logo that ships with the app, and any other a letter badge.
 * The shipped logos (`assets/wallets/`) are only ever `<img src>` files: never inlined into the page, so none of their ids can clash.
 */

/** The logos that ship with the app, one per wallet in `RECOMMENDED`. */
const LOGO: Record<RecommendedKey, string> = { okx: okxLogo, metamask: metamaskLogo, rabby: rabbyLogo, binance: binanceLogo, trust: trustLogo, phantom: phantomLogo };

/** Where "Learn More" goes. */
const LEARN_MORE = 'https://ethereum.org/en/wallets/';

const X_ICON = raw('<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>');
const BACK_ICON = raw('<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>');
const CARET = raw('<svg class="caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5L5 6.5L8 3.5" stroke="#8A9AB2" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"></path></svg>');
const COPY_ICON = raw('<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.8" stroke="currentColor" stroke-width="1.4"></rect><path d="M10.5 3.6V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9A1.5 1.5 0 0 0 3.5 10.5h.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>');
const LINK_ICON = raw('<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M8 2h4v4M12 2L6.5 7.5M10.5 8.5V11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1h2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path></svg>');
const POWER_ICON = raw('<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 1.5v5M3.8 3.6a4.6 4.6 0 1 0 6.4 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>');

/** The person icon on the pill of a connected wallet (and in the menu when the wallet announced no icon). Constant markup. */
export const USER_ICON = raw('<span class="uav" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5.3" r="2.9" stroke="currentColor" stroke-width="1.5"></circle><path d="M2.6 14c.5-2.7 2.6-4.2 5.4-4.2s4.9 1.5 5.4 4.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path></svg></span>');

/** The name the screen shows: the plain `window.ethereum` has no name of its own to trust. */
const nameOf = (o: WalletOption): string => (o.fallback ? t('Browser wallet', '浏览器钱包') : cleanName(o.name));

const logoBox = (src: string, size: '' | 'wic-m' | 'wic-l'): Html => html`<span class="wic${size ? ` ${size}` : ''}"><img src="${src}" alt=""></span>`;

/** A wallet's own icon if it announced a usable one, else the logo of the wallet it says it is, else a badge with its first letter. */
function iconOf(o: WalletOption, size: '' | 'wic-m' | 'wic-l' = ''): Html {
  const own = safeIcon(o.icon);
  if (own !== null) return logoBox(own, size);
  const known = knownWallet(o);
  if (known) return logoBox(LOGO[known.key], size);
  const first = [...nameOf(o)][0] ?? '?';
  return html`<span class="wic wb wb-n${size ? ` ${size}` : ''}" aria-hidden="true">${first.toUpperCase()}</span>`;
}

const logoOfRecommended = (r: Recommended, size: '' | 'wic-m' | 'wic-l' = ''): Html => logoBox(LOGO[r.key], size);

const newTab = (): Html => html`<span class="sr"> ${t('(opens in a new tab)', '（在新标签页打开）')}</span>`;

/* ───────── the left column ───────── */

function installedRow(o: WalletOption, recent: boolean, picker: NonNullable<Ctx['ui']['picker']>): Html {
  const on = picker.view.kind === 'connect' && picker.view.id === o.id;
  return html`<button type="button" class="wopt" data-a="pick-wallet" data-v="${o.id}"${on ? raw(' aria-current="true"') : EMPTY}${picker.busy !== null ? raw(' aria-disabled="true"') : EMPTY}>${iconOf(o)}<span class="wcol"><span class="wn">${nameOf(o)}</span>${
    recent ? html`<span class="wtag">${t('Recent', '最近使用')}</span>` : EMPTY
  }</span></button>`;
}

function recommendedRow(r: Recommended, picker: NonNullable<Ctx['ui']['picker']>): Html {
  const on = picker.view.kind === 'get' && picker.view.key === r.key;
  return html`<button type="button" class="wopt" data-a="picker-get" data-v="${r.key}"${on ? raw(' aria-current="true"') : EMPTY}>${logoOfRecommended(r)}<span class="wcol"><span class="wn">${r.name}</span></span></button>`;
}

/* ───────── the right column ───────── */

function aboutView(): Html {
  return html`<div class="wv wv-about">
    <h3 class="wv-h">${t('What is a Wallet?', '什么是钱包？')}</h3>
    <div class="wv-items">
      <div class="wv-item"><img class="wv-illu" src="${aboutHome}" alt=""><div><b>${t('A home for your BEM, OKB and RIG vouchers', '存放 BEM、OKB 和 RIG 凭证的地方')}</b><p>${t(
        'Your wallet keeps your tokens and your rig vouchers, and shows what you supply and borrow on X Layer.',
        '钱包保管您的代币和矿机凭证，并显示您在 X Layer 上的存款与借款。',
      )}</p></div></div>
      <div class="wv-item"><img class="wv-illu" src="${aboutLogin}" alt=""><div><b>${t('It signs every transaction', '每笔交易都由它签名')}</b><p>${t(
        'You approve each action in your wallet. TapePool never sees your keys.',
        '每一步操作都由您在钱包中确认，TapePool 不会接触您的私钥。',
      )}</p></div></div>
    </div>
    <div class="wv-acts">
      <button type="button" class="wv-btn" data-a="picker-get">${t('Get a Wallet', '获取钱包')}</button>
      <a class="wv-link" href="${LEARN_MORE}" target="_blank" rel="noopener noreferrer">${t('Learn More', '了解更多')}${newTab()}</a>
    </div>
  </div>`;
}

/** Why the last try failed: the line for the reader, and the wallet's own words under Details. */
function errorBlock(err: AppError): Html {
  const det = errorDetails(err);
  return html`<div class="wv-err" role="alert"><b>${errorText(err)}</b>${det === null ? EMPTY : html`<details class="det"><summary>${t('Details', '详情')}</summary><pre>${det}</pre></details>`}</div>`;
}

/** The wallet being asked, or why it did not connect, with a way to try again. */
function connectView(o: WalletOption, picker: NonNullable<Ctx['ui']['picker']>): Html {
  const err = picker.error;
  const name = nameOf(o);
  if (err) {
    return html`<div class="wv wv-conn">
      <span class="wv-logo">${iconOf(o, 'wic-l')}</span>
      ${errorBlock(err)}
      <button type="button" class="wv-btn" data-a="pick-wallet" data-v="${o.id}"${picker.busy !== null ? raw(' aria-disabled="true"') : EMPTY}>${t('Retry', '重试')}</button>
    </div>`;
  }
  return html`<div class="wv wv-conn">
    <span class="wv-logo${picker.busy !== null ? ' wv-busy' : ''}">${iconOf(o, 'wic-l')}</span>
    <h3 class="wv-h" role="status">${t(`Opening ${name}…`, `正在打开 ${name}…`)}</h3>
    <p class="wv-sub">${t('Confirm the connection in your wallet.', '请在钱包中确认连接。')}</p>
  </div>`;
}

const getLink = (r: Recommended, cls: string, label: string): Html =>
  html`<a class="${cls}" href="${r.url}" target="_blank" rel="noopener noreferrer">${label}<span class="sr"> ${r.name} ${t('(opens in a new tab)', '（在新标签页打开）')}</span></a>`;

/** "Get <wallet>" for one, or "Get a Wallet" with every recommended one. */
function getView(key: string | null): Html {
  const one = recommendedByKey(key);
  if (one) {
    return html`<div class="wv wv-conn">
      <span class="wv-logo">${logoOfRecommended(one, 'wic-l')}</span>
      <h3 class="wv-h">${t(`Get ${one.name}`, `获取 ${one.name}`)}</h3>
      <p class="wv-sub">${t('Install it from its official page, then reload this page to connect.', '请从官方页面安装，然后刷新本页面再连接。')}</p>
      ${getLink(one, 'wv-btn', t('Get', '获取'))}
    </div>`;
  }
  return html`<div class="wv wv-get">
    <h3 class="wv-h">${t('Get a Wallet', '获取钱包')}</h3>
    <ul class="wv-list">${RECOMMENDED_SHOWN.map((r) => html`<li class="wv-row">${logoOfRecommended(r, 'wic-m')}<span class="wv-name">${r.name}</span>${getLink(r, 'wv-gb', t('Get', '获取'))}</li>`)}</ul>
    <p class="wv-sub">${t('Install one, then reload this page.', '安装任一钱包后，请刷新本页面。')}</p>
  </div>`;
}

/**
 * What the right column shows. A reason a try failed is never dropped: it is on the wallet's own panel, and when the reader has gone
 * to another panel meanwhile it is a line above that one.
 */
function rightView(view: PickerView, target: WalletOption | null, picker: NonNullable<Ctx['ui']['picker']>): Html {
  if (view.kind === 'connect' && target) return connectView(target, picker);
  const banner = picker.error ? errorBlock(picker.error) : EMPTY;
  return html`${banner}${view.kind === 'get' ? getView(view.key) : aboutView()}`;
}

/** The dialog that opens on "Connect wallet": the wallets found in this browser and the ones worth installing, and a panel on the right. */
export function connectModal(c: Ctx): Html {
  const picker = c.ui.picker ?? { busy: null, error: null, view: { kind: 'about' } as PickerView };
  const w = c.snap.wallet;
  const options = w.options ?? [];
  const groups = groupWallets(options, w.recent ?? null);
  // the wallet whose panel is open; if it went away meanwhile, the panel is the intro (and a reason it failed stays on it)
  const wanted = picker.view.kind === 'connect' ? picker.view.id : null;
  const target = options.find((o) => o.id === wanted) ?? null;
  const view: PickerView = picker.view.kind === 'connect' && target === null ? { kind: 'about' } : picker.view;
  const installed =
    groups.installed.length > 0
      ? html`<div class="wgrp"><h3 class="wlab wlab-acc">${t('Installed', '已安装')}</h3><div class="wlist">${groups.installed.map((g) => installedRow(g.option, g.recent, picker))}</div></div>`
      : html`<p class="wnone">${t('No wallet found in this browser. Install one below, then reload this page.', '此浏览器中未检测到钱包。请安装下方任一钱包，然后刷新页面。')}</p>`;
  const recommended =
    groups.recommended.length > 0
      ? html`<div class="wgrp"><h3 class="wlab">${t('Recommended', '推荐')}</h3><div class="wlist">${groups.recommended.map((r) => recommendedRow(r, picker))}</div></div>`
      : EMPTY;
  return html`<section class="mdl mdl-wallet" role="dialog" aria-modal="true" aria-labelledby="mdl-t" tabindex="-1" data-view="${view.kind}">
    <button type="button" class="wx" data-a="picker-close" aria-label="${t('Close', '关闭')}">${X_ICON}</button>
    <div class="wl">
      <h2 id="mdl-t" class="wtitle">${t('Connect a Wallet', '连接钱包')}</h2>
      <div class="wscroll">${installed}${recommended}</div>
    </div>
    <div class="wr">
      <button type="button" class="wback" data-a="picker-back" aria-label="${t('Back', '返回')}">${BACK_ICON}</button>
      <div class="wview" tabindex="-1">${rightView(view, target, picker)}</div>
    </div>
  </section>`;
}

/* ───────── the account pill and its menu ───────── */

/** The pill with the account, and under it the menu while it is open. The caller draws a plain pill in a frame. */
export function accountMenu(c: Ctx): Html {
  const w = c.snap.wallet;
  const who = w.account ?? '';
  const open = c.ui.menu;
  const a = w.active ?? null;
  const name = a ? nameOf(a) : t('Connected wallet', '已连接的钱包');
  const sub = w.status === 'wrong-network' ? t('On another network', '在其他网络上') : t('Connected', '已连接');
  const copied = c.ui.copied;
  const panel = open
    ? html`<div class="acct-menu" id="acct-menu" role="group" aria-label="${t('Wallet', '钱包')}">
        <div class="acct-id">${a ? iconOf(a) : USER_ICON}<div class="col"><b>${name}</b><small class="mut">${sub}</small></div></div>
        <div class="acct-ar"><span class="acct-addr mono" title="${who}" aria-hidden="true">${menuAddr(who)}</span><span class="sr">${who}</span><button type="button" class="acct-cp" data-a="copy-addr" aria-label="${t('Copy address', '复制地址')}" title="${t('Copy address', '复制地址')}">${COPY_ICON}</button><span class="acct-copied" role="status" aria-live="polite">${copied === 'ok' ? t('Copied!', '已复制') : ''}</span></div>
        ${copied === 'fail' ? html`<div class="acct-full mono">${who}</div>` : EMPTY}
        <div class="acct-acts">
          <a class="btn btn-s" href="${explorerAddress(who)}" target="_blank" rel="noopener noreferrer">${LINK_ICON}${t('View on explorer', '在区块浏览器中查看')}</a>
          <button type="button" class="btn btn-s acct-off" data-a="disconnect">${POWER_ICON}${t('Disconnect', '断开连接')}</button>
        </div>
      </div>`
    : EMPTY;
  return html`<div class="acct"><button type="button" class="v2-pillbtn pointer" data-a="menu" aria-expanded="${String(open)}" aria-controls="acct-menu" aria-label="${t('Wallet menu', '钱包菜单')} · ${shortAddr(who)}">${USER_ICON}<span class="mono hide-m">${shortAddr(who)}</span>${CARET}</button>${panel}</div>`;
}
