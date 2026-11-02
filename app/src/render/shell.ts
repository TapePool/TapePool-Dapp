import { hourglassFrame, TERMINAL } from '../ascii';
import { errorDetails, errorText } from '../chain/errors';
import { explorerAddress } from '../config';
import { fd, shortAddr } from '../logic/format';
import { EMPTY, html, raw, type Html } from '../html';
import { getLang, t, th } from '../i18n';
import { depositsClosed, feedSettling, poolBanner, stale } from '../logic/selectors';
import { cl, img, type Ctx } from './ui';
import { accountMenu, USER_ICON } from './wallets';

const NAV: readonly [string, () => string][] = [
  ['', () => t('Dashboard', '总览')],
  ['markets', () => t('Markets', '市场')],
  ['rigs', () => t('Rigs', '矿机')],
];

export function header(c: Ctx, current: string): Html {
  const items = NAV.map(([path, label]) => html`<a href="${c.link(path ? `/${path}` : '')}"${current === path ? raw(' aria-current="page"') : EMPTY}>${label()}</a>`);
  // Tape is an ordinary route of this app in development: a hash link keeps the document, wallet and game session.
  if (import.meta.env.DEV) items.push(html`<a data-local-tape href="${c.link('/tape')}"${current === 'tape' ? raw(' aria-current="page"') : EMPTY}>Tape</a>`);
  const w = c.snap.wallet;
  const lang = getLang();
  const noWalletButtons = c.readOnly === 'frame';
  let net: Html = html`<span class="v2-pillbtn">${img('xlayer', 'i-net')}<span class="hide-m">X Layer</span></span>`;
  if (w.status === 'wrong-network') {
    net = noWalletButtons
      ? html`<span class="v2-pillbtn netw">${t('Wrong network', '网络错误')}</span>`
      : html`<button type="button" class="v2-pillbtn netw pointer" data-a="switchnet">${t('Wrong network', '网络错误')}</button>`;
  }
  let who: Html;
  if (w.status === 'disconnected') {
    who = noWalletButtons ? EMPTY : html`<button type="button" class="btn btn-p btn-h40" data-a="connect">${t('Connect wallet', '连接钱包')}</button>`;
  } else if (w.status === 'view') {
    who = html`<span class="v2-pillbtn">${USER_ICON}<span class="mono hide-m">${shortAddr(w.account ?? '')}</span></span>`;
  } else {
    who = noWalletButtons
      ? html`<span class="v2-pillbtn">${USER_ICON}<span class="mono hide-m">${shortAddr(w.account ?? '')}</span></span>`
      : accountMenu(c);
  }
  const lng = html`<span class="lng" role="group" aria-label="Language"><button type="button" data-a="lang" data-v="en" aria-pressed="${String(lang === 'en')}">EN</button><button type="button" data-a="lang" data-v="cn" lang="zh-CN" aria-pressed="${String(lang === 'cn')}">中文</button></span>`;
  return html`<header class="v2-hd"${import.meta.env.DEV ? raw(' data-local-nav') : EMPTY}><a class="logo" href="${c.link()}" aria-label="TapePool home">${img('logo', 'logo-img')}</a><nav class="v2-nav" aria-label="App">${items}</nav><div class="right">${lng}${net}${who}</div></header>`;
}

export function footer(c: Ctx): Html {
  const p = c.snap.pool;
  const dot = (cls: 'g' | 'y' | 'r' | 'n', label: string): Html => html`<span class="dot"><i class="dot-${cls}"></i>${label}</span>`;
  if (import.meta.env.DEV && c.route.page === 'trace') return html`<footer class="v2-ft"><span class="dot"><i class="dot-g"></i>${t('Demo with virtual BEM', '虚拟 BEM 演示')}</span><span class="built"><span>${t('Built on', '构建于')}</span>${img('tapeout')}<span class="c-soft">TapeOut</span><span aria-hidden="true">·</span>${img('xlayer')}<span class="c-soft">X Layer</span><span aria-hidden="true">·</span>${img('fabx')}<span class="c-soft">FabX</span></span></footer>`;
  const swap = p.pendingPolicy;
  const closed = depositsClosed(p);
  return html`<footer class="v2-ft" aria-label="${t('Pool status', '资金池状态')}">${[
    p.borrowsPaused
      ? dot('r', t('Borrows paused', '借款已暂停'))
      : feedSettling(p, c.snap.now)
        ? dot('y', t('Borrows reopen in a few minutes', '借款将在几分钟后恢复')) // RC3-02: lend waits FEED_SETTLE
        : dot('g', t('Borrows open', '借款开放')),
    dot(p.feedDisabled ? 'r' : 'g', p.feedDisabled ? t('Rig data feed off', '矿机数据源已关闭') : t('Rig data feed on', '矿机数据源已开启')),
    dot(swap ? 'y' : 'n', swap ? t(`New credit rule queued · ${fd(swap.eta)}`, `新信用规则排队中 · ${fd(swap.eta)}生效`) : t('No credit rule change queued', '信用规则无待生效变更')),
    dot(closed ? 'y' : 'g', closed ? t('Deposits closed · a loan is under review', '存款暂停 · 有贷款待处理') : t('Deposits open', '存款开放')),
  ]}<span class="built"><span>${t('Built on', '构建于')}</span>${img('tapeout')}<span class="c-soft">TapeOut</span><span aria-hidden="true">·</span>${img('xlayer')}<span class="c-soft">X Layer</span><span aria-hidden="true">·</span>${img('fabx')}<span class="c-soft">FabX</span></span></footer>`;
}

/** The banner for the pool state that stops new borrows. */
export function poolNotice(c: Ctx): Html {
  const k = poolBanner(c.snap);
  const pool = c.snap.pool;
  switch (k) {
    case 'paused':
      return cl('w', html`<b>${t('New borrows are paused.', '新借款已暂停。')}</b> ${t('The guardian paused them. Repaying, sweeping and withdrawals keep working.', '守护者已暂停新借款。还款、归集（sweep）和提款不受影响。')}`);
    case 'feedoff':
      return cl('w', html`<b>${t('The rig data feed is off.', '矿机数据源已关闭。')}</b> ${t('New borrows wait until it is back. Open loans keep repaying.', '在恢复之前新借款暂停，进行中的贷款照常还款。')}`);
    case 'settling':
      return cl('w', html`<b>${t('The rig data feed was just turned back on.', '矿机数据源刚刚重新开启。')}</b> ${t('New borrows reopen in a few minutes. Open loans keep repaying.', '新借款将在几分钟后恢复，进行中的贷款照常还款。')}`);
    case 'swap': {
      const eta = pool.pendingPolicy?.eta ?? 0;
      const target = pool.pendingPolicy?.address;
      return cl(
        'w',
        html`<b>${t('A new credit rule is queued.', '新信用规则排队中。')}</b> ${t(
          `It can take effect from ${fd(eta, true)}. New borrows are paused while it waits, so everyone can read it first, and stay paused until the owner resumes them after the switch.`,
          `最早于 ${fd(eta, true)} 生效。排队期间新借款暂停，以便所有人先阅读新规则；切换后需由所有者恢复借款。`,
        )}`,
        target ? html`<a class="btn btn-s btn-sm" href="${explorerAddress(target)}" target="_blank" rel="noopener noreferrer">${t('Read the queued rule', '查看新规则')}</a>` : null,
      );
    }
    case 'noroom':
      return cl('w', html`<b>${t('The pool has no room for a new advance right now.', '资金池当前没有可借额度。')}</b> ${t('The borrow cap, your per-borrower cap or the idle BEM is used up. Room comes back as loans are repaid or lenders supply.', '借款总额上限、单个借款人上限或闲置 BEM 已用完。贷款偿还或出借人存入后额度会恢复。')}`);
    default:
      return EMPTY;
  }
}

/**
 * What the wallet is about to ask (SPEC-PHASE5-APP §6.0 rule 4): the contract, the function and the value, in one line.
 * It is on screen before the wallet is asked and stays until the transaction is confirmed. The values come from the
 * transaction the app is sending, so an approval reads as an approval and a borrow shows its exact fee.
 */
export function walletAsk(c: Ctx): Html {
  const p = c.snap.pending;
  const a = p?.ask;
  if (!p || !a) return EMPTY;
  // a harvest from here can also pull a bond when the rig's BEM drops below it before the transaction lands (SPEC-PHASE5-PRELOAN P3)
  const note = a.note === 'bond' ? html`<br><span class="mut t12">${t("If the rig's BEM drops below 0.0001 before this lands on BSC, the vault also takes a 0.0001 BEM bond from your BSC wallet. It comes back on X Layer, less the bridge fee.", '如果在交易上链前该矿机的 BEM 降到 0.0001 以下，金库还会从您的 BSC 钱包收取 0.0001 BEM 保证金，之后会在 X Layer 上退还（扣除跨链费）。')}</span>` : EMPTY;
  return cl(
    'i',
    html`<span class="ask"><b>${p.hash ? t('Waiting for confirmation:', '等待确认：') : t('Your wallet will ask you to confirm:', '您的钱包将请您确认：')}</b> <span class="mono">${a.contract}</span> · <span class="mono">${a.fn}</span> · ${t('value', '金额')} <span class="mono">${a.value}</span></span>${note}`,
  );
}

/** Notices that apply to every page: a frame, a read-only view, stale data. */
export function pageNotices(c: Ctx): Html {
  const out: Html[] = [];
  if (c.readOnly === 'frame')
    out.push(cl('w', html`<b>${t('This page is shown inside another site, so actions are turned off.', '此页面显示在其他网站内，因此已关闭所有操作。')}</b> ${t('Open TapePool directly to use it.', '请直接打开 TapePool 使用。')}`));
  if (c.readOnly === 'view') {
    const who = html`<span class="mono">${shortAddr(c.snap.wallet.account ?? '')}</span>`;
    out.push(
      cl(
        'n',
        th(
          html`<b>Read-only view</b> of ${who}. Actions are turned off. Connect your own wallet to act.`,
          html`<b>只读视图</b>：正在查看 ${who}。操作已关闭。请连接您自己的钱包后再操作。`,
        ),
      ),
    );
  }
  if (c.ui.error) {
    const raw = errorDetails(c.ui.error);
    out.push(cl('bad', html`<b>${errorText(c.ui.error)}</b>${raw === null ? EMPTY : html`<details class="det"><summary>${t('Details', '详情')}</summary><pre>${raw}</pre></details>`}`));
  }
  out.push(walletAsk(c));
  if (stale(c.snap))
    out.push(cl('w', html`<b>${t('Some data could not be refreshed and may be out of date.', '部分数据未能刷新，可能已过期。')}</b> ${t('Actions that depend on it are turned off.', '依赖这些数据的操作已关闭。')}`));
  return html`${out}`;
}

/** The pages that need a connected wallet show this until there is one. */
export function gate(c: Ctx, title: string): Html {
  const wrong = c.snap.wallet.status === 'wrong-network';
  const lock = c.readOnly === 'frame';
  return html`<div class="v2-title"><div><h1>${title}</h1></div></div><section class="v2-card"><div class="empty v2-connect"><div class="ic"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2" stroke="#6FC3EC" stroke-width="1.6"></rect><path d="M16 12.5H18" stroke="#6FC3EC" stroke-width="1.6" stroke-linecap="round"></path><path d="M6 6V5.5A1.5 1.5 0 0 1 7.5 4H17" stroke="#6FC3EC" stroke-width="1.6"></path></svg></div>${
    wrong
      ? html`<h2>${t('Switch to X Layer', '切换到 X Layer')}</h2><p>${t('Your wallet is on another network. TapePool runs on X Layer (chain 196).', '您的钱包当前在其他网络。TapePool 运行在 X Layer（链 ID 196）上。')}</p>${lock ? EMPTY : html`<button type="button" class="btn btn-p btn-lg" data-a="switchnet">${t('Switch network', '切换网络')}</button>`}`
      : html`<h2>${t('Connect your wallet', '连接钱包')}</h2><p>${t('Connect your wallet on X Layer to see your supplies, your loans and your Rig Agents.', '在 X Layer 上连接钱包，查看您的存款、贷款和“矿机代理”（Rig Agent）。')}</p>${lock ? EMPTY : html`<button type="button" class="btn btn-p btn-lg" data-a="connect">${t('Connect wallet', '连接钱包')}</button>`}`
  }</div></section>`;
}

/** Shown instead of a page while its first read is running or has failed. */
export function bootCard(title: string, state: 'loading' | 'failed'): Html {
  const body =
    state === 'loading'
      ? html`<div class="ascii-art" aria-hidden="true"><pre data-ascii="sand">${hourglassFrame(0)}</pre></div><h2 class="ascii" data-ascii="loop" data-ascii-preset="art" data-ascii-text="${t('Reading from X Layer…', '正在读取 X Layer 数据…')}">${t('Reading from X Layer…', '正在读取 X Layer 数据…')}</h2><p>${t('The app reads the contracts directly. This takes a few seconds.', '应用直接读取链上合约，需要几秒钟。')}</p><div class="ascii-art bp" aria-hidden="true"><pre data-ascii="loop" data-ascii-preset="blueprint" data-ascii-text="${TERMINAL}">${TERMINAL}</pre></div>`
      : html`<h2>${t('Could not reach X Layer.', '无法连接 X Layer。')}</h2><p>${t('The app reads the chain directly and got no answer. It tries again every few seconds.', '应用直接读取链上数据但未得到响应，会每隔几秒自动重试。')}</p>`;
  return html`<div class="v2-title"><div><h1>${title}</h1></div></div><section class="v2-card"><div class="empty v2-connect${state === 'loading' ? ' boot' : ''}">${body}</div></section>`;
}

export function notFound(c: Ctx): Html {
  return html`<div class="v2-title"><div><h1>${t('Not found', '未找到页面')}</h1><p>${t('This page does not exist.', '该页面不存在。')}</p></div></div><a class="back" href="${c.link()}">← ${t('Dashboard', '总览')}</a>`;
}
