import { TAPEOUT_URL } from '../config';
import { HOUR, LATE_HARVEST_EVERY, MAX_COLLATERAL } from '../constants';
import { bem4, dur, fd, native, pctBps, ringPct, shortAddr, win } from '../logic/format';
import { EMPTY, html, join, type Html } from '../html';
import { t } from '../i18n';
import { estimateLimit } from '../logic/borrow';
import { claimableAgents, debtOf, isOpen, loanForRig, orderedRigs, readyRigs, rigById } from '../logic/selectors';
import type { AgentView, LoanView, RigView } from '../model';
import { flow, assetSeg, rigInfo, rigMeta } from './borrow';
import { alerts, elig, help } from './cards';
import { releaseEntries } from './release';
import { loanActions, loanCard, loanChip } from './loan';
import { poolNotice } from './shell';
import { B, act, back, bar, chip, cl, type ChipKind, type Ctx } from './ui';


/* ───────── the reason a rig cannot borrow (cards and the rig page) ───────── */

export function rigWhy(r: RigView): string {
  const s = r.state;
  switch (s.kind) {
    case 'no-data':
      return t('No data about this rig has reached the app yet, so it cannot borrow.', '应用尚未取得这台矿机的数据，暂时无法借款。');
    case 'not-mining':
      return t('This rig is not mining on BSC: it is stopped, revoked or not in custody. There is nothing to borrow against.', '这台矿机在 BSC 上没有在挖矿：已停止、被撤销或不在托管中，无法借款。');
    case 'processor':
      return t('Its processor is not supported. Only TapeOut, Behemoth and RefBench rigs can borrow.', '不支持该矿机的处理器。只有 TapeOut、Behemoth 和 RefBench 的矿机可以借款。');
    case 'not-synced':
      return t('The voucher on X Layer has not synced with the rig yet. Harvest once on tapeout.net to sync it.', 'X Layer 上的凭证尚未与矿机同步。请先在 tapeout.net 上领取一次收益以完成同步。');
    case 'mismatch':
      return t('This voucher no longer matches its rig on BSC.', '这张凭证与其在 BSC 上的矿机已不再匹配。');
    case 'too-new':
      return t(`A rig needs to be at least 3 days old. This one can borrow from ${fd(s.readyAt, true)}.`, `矿机需上线满 3 天，本矿机 ${fd(s.readyAt, true)} 起可借。`);
    case 'no-base-power':
      return t('Its base power is 0, so there is nothing to borrow against. Only base power counts; the design bonus is left out.', '基础算力为 0，无法借款。只计算基础算力，不计设计加成。');
    case 'not-screened':
      if (s.why === 'suspended') return t('The screen pass of this rig is suspended, so it cannot borrow until it is screened again.', '这台矿机的筛查通过记录已被暂停，重新筛查前无法借款。');
      if (s.why === 'changed') return t('This rig changed since it was screened, so the pass no longer applies. It needs a new screen.', '这台矿机在筛查之后发生了变化，原有的通过记录不再适用，需要重新筛查。');
      return screenNote();
    case 'screen-pending':
      return t(`The screen passed. It counts from ${fd(s.effectiveAt, true)}, 48 h after it was recorded on-chain.`, `筛查已通过，${fd(s.effectiveAt, true)} 起生效（链上记录 48 小时后）。`);
    default:
      return '';
  }
}

/** Option C of SPEC-PHASE5-APP §12: a static note, no request. */
export const screenNote = (): string =>
  t(
    'Every rig needs a screen pass before it can borrow. The TapePool team screens new rigs; a pass counts 48 h after it is recorded on-chain.',
    '每台矿机借款前都需要通过筛查。TapePool 团队会为新矿机做筛查；筛查结果记录上链 48 小时后生效。',
  );

function chipFor(c: Ctx, r: RigView): Html {
  const L = loanForRig(c.snap, r.id);
  const s = r.state;
  const k = (kind: ChipKind, en: string, cn: string): Html => chip(kind, t(en, cn));
  switch (s.kind) {
    case 'loan':
    case 'seized':
      return L ? loanChip(L) : k('n', 'In a loan', '贷款中');
    case 'stuck':
      return k('w', 'Moving to the pool', '正在转入资金池');
    case 'in-agent':
      return L?.phase === 'cleared' ? loanChip(L) : k('a', 'In your Rig Agent', '在您的矿机代理中');
    case 'loose':
      return k('w', 'not collateral', '不计入担保');
    case 'no-data':
      return k('n', 'No data yet', '暂无数据');
    case 'not-mining':
      return k('n', 'Not mining', '未在挖矿');
    case 'processor':
      return k('n', 'Processor not supported', '处理器不受支持');
    case 'not-synced':
      return k('w', 'Voucher not synced', '凭证未同步');
    case 'mismatch':
      return k('bad', 'Voucher mismatch', '凭证不匹配');
    case 'too-new':
      return k('n', 'Too new', '未满 3 天');
    case 'no-base-power':
      return k('n', 'No base power', '无基础算力');
    case 'not-screened':
      return s.why === 'none' ? k('w', 'Not screened', '尚未筛查') : s.why === 'suspended' ? k('w', 'Screen suspended', '筛查已暂停') : k('w', 'Screen changed', '筛查需更新');
    case 'screen-pending':
      return k('w', 'Screen passed', '筛查已通过');
    case 'ready':
      return k('ok', 'Ready', '可借');
  }
}

const agentOf = (c: Ctx, r: RigView): AgentView | undefined => {
  const p = r.facts.place;
  return p.kind === 'wallet' ? undefined : c.snap.agents.find((a) => a.address === p.agent);
};

const harvestLink = (): Html => html`<a class="btn btn-s btn-sm" href="${TAPEOUT_URL}" target="_blank" rel="noopener noreferrer">${t('Harvest on tapeout.net', '前往 tapeout.net 领取')}</a>`;

/** "Take back" on a card or a page: the whole agent when it holds only this voucher, else this voucher. */
function registerButton(c: Ctx, r: RigView): Html {
  const p = r.facts.place;
  const open = p.kind === 'agent' && p.loanOpen;
  return html`${act(c, { a: 'register', v: r.id, size: 'sm', needs: ['rigs'], disabled: open }, t('Register', '登记凭证'))}${open ? html`<p class="note">${t('Rigs you add now stay outside this loan. Register them after it closes.', '现在加入的矿机不计入本笔贷款，请在贷款结束后登记。')}</p>` : EMPTY}`;
}

function takeBack(c: Ctx, r: RigView, size: 'sm' | undefined = 'sm'): Html {
  const ag = agentOf(c, r);
  const only = ag !== undefined && ag.collateral.length === 1 && ag.collateral[0] === r.id;
  return act(c, { a: only ? 'release' : 'take-back', v: r.id, kind: 's', size, needs: ['rigs'] }, t('Take back', '取回凭证'));
}

/* ───────── the card of one rig ───────── */

function repaidPct(L: LoanView): number | null {
  if (L.feePaid === null) return null;
  const total = L.advance + L.feePaid;
  return total === 0n ? null : ringPct(total - debtOf(L), total);
}

export function rigCard(c: Ctx, r: RigView): Html {
  const { snap } = c;
  const L = loanForRig(snap, r.id);
  const link = c.link(`/rigs/${r.id}`);
  const s = r.state;
  let body: Html;
  let actions: Html = EMPTY;
  let cls = '';

  if (s.kind === 'loan' && L) {
    const lead = L.rigIds[0] ?? r.id;
    if (lead !== r.id) {
      body = html`<p class="mut">${t(`In the loan of #${lead}`, `在 #${lead} 的贷款中`)}</p>`;
      actions = html`<a class="btn btn-s" href="${c.link(`/rigs/${lead}`)}">${t('View loan', '查看贷款')}</a>`;
    } else {
      const d = debtOf(L);
      const pct = repaidPct(L);
      const bad = L.phase === 'flagged' || L.phase === 'seize';
      const left = (L.phase === 'flagged' ? L.seizeStart : L.deadline) ?? c.now;
      const due = L.deadlinePaused && bad
        ? html`${t('Seize deadline paused', '没收截止时间已暂停')}`
        : bad
        ? html`<span class="c-neg">${t(`Repay within ${dur(left - c.now)}`, `请在 ${dur(left - c.now)} 内还款`)}</span>`
        : L.phase === 'late'
          ? html`${t(`Matured ${fd(L.maturity)}, still repaying`, `${fd(L.maturity)}已到期，继续还款中`)}`
          : html`${t(`Matures ${fd(L.maturity)}`, `${fd(L.maturity)}到期`)}`;
      cls = bad ? ' alert' : '';
      body = html`<div class="row"><span class="mut">${t('Debt', '债务')}</span>${B(d)}</div>${pct === null ? EMPTY : bar(pct)}<div class="row t12"><span class="mut">${pct === null ? '—' : t(`${pct.toFixed(1)}% repaid`, `已还 ${pct.toFixed(1)}%`)}</span><span>${due}</span></div>${L.rigIds.length > 1 ? html`<span class="mut t12">${t(`${L.rigIds.length} rigs back this loan`, `${L.rigIds.length} 台矿机共同担保`)}</span>` : EMPTY}`;
      actions = html`${act(c, { a: 'repay', v: lead, kind: bad ? 'd' : 'p', needs: ['loans'] }, t('Repay', '还款'))}<a class="btn btn-s" href="${link}">${t('View loan', '查看贷款')}</a>`;
    }
  } else if (s.kind === 'seized') {
    cls = ' off';
    body = html`<p class="mut">${L?.seizedAt ? t(`Seized on ${fd(L.seizedAt)}. The voucher now belongs to the pool and mines for lenders.`, `已于 ${fd(L.seizedAt)}被没收，凭证现归资金池所有，为出借人挖矿。`) : t('Seized. The voucher now belongs to the pool and mines for lenders.', '已被没收，凭证现归资金池所有，为出借人挖矿。')}</p>`;
    actions = html`<a class="btn btn-s" href="${link}">${t('View', '查看')}</a>`;
  } else if (s.kind === 'stuck') {
    body = html`<p class="mut">${t('This agent was closed by a seize. The voucher is moving to the pool; anyone can finish the move.', '该矿机代理已因没收而关闭，凭证正在转入资金池，任何人都可以完成转移。')}</p>`;
  } else if (s.kind === 'in-agent') {
    if (L?.phase === 'cleared') {
      cls = ' good';
      body = html`<p>${t('Debt cleared. Take the voucher back, or leave it in the agent to borrow again.', '债务已还清。可以取回凭证，也可以留在代理中再次借款。')}</p>`;
      actions = html`${act(c, { a: 'release', v: r.id, needs: ['rigs'] }, t('Release voucher', '取回凭证'))}<a class="btn btn-s" href="${link}">${t('View', '查看')}</a>`;
    } else {
      body = html`<p class="mut">${t(`In your Rig Agent ${shortAddr(s.agent)}. No loan is open.`, `在您的矿机代理 ${shortAddr(s.agent)} 中，当前没有进行中的贷款。`)}</p>`;
      actions = html`<a class="btn btn-p" href="${link}">${t('Borrow again', '再次借款')}</a>${takeBack(c, r)}`;
    }
  } else if (s.kind === 'loose') {
    body = html`<p class="mut">${s.agentClosed ? t(`This voucher is in the closed Rig Agent ${shortAddr(s.agent)}. Take it back to your wallet.`, `这张凭证在已关闭的矿机代理 ${shortAddr(s.agent)} 中，请取回到您的钱包。`) : t(`This voucher is in your Rig Agent ${shortAddr(s.agent)} but does not count as collateral. Register it to borrow against it, or take it back.`, `这张凭证在您的矿机代理 ${shortAddr(s.agent)} 中，但不计入担保。登记后才能用它借款，也可以取回。`)}</p>`;
    actions = html`${s.agentClosed ? EMPTY : registerButton(c, r)}${act(c, { a: 'take-back', v: r.id, kind: 's', size: 'sm', needs: ['rigs'] }, t('Take back', '取回凭证'))}`;
  } else if (s.kind === 'ready') {
    const lim = estimateLimit(snap, [r], 0, c.now);
    const p = snap.pool.params;
    const max = (lim.maxPrincipal / 10_000n) * 10_000n;
    const ops = p.opsFee[0];
    body = html`<div class="row"><span class="mut">${t('Borrow up to', '最多可借')}</span>${B(max)}</div><div class="row t12"><span class="mut">${ops > 0n ? t(`${p.termDays[0]} days · fee ${pctBps(p.feeBps[0])} + ${native(ops)} OKB`, `${p.termDays[0]} 天 · 费用 ${pctBps(p.feeBps[0])} + ${native(ops)} OKB`) : t(`${p.termDays[0]} days · fee ${pctBps(p.feeBps[0])}`, `${p.termDays[0]} 天 · 费用 ${pctBps(p.feeBps[0])}`)}</span></div>`;
    actions = html`<a class="btn btn-p" href="${link}">${t('Borrow', '借款')}</a>`;
  } else {
    body = html`<p class="mut">${rigWhy(r)}</p>`;
    if (s.kind === 'not-synced') actions = harvestLink();
    if (s.kind === 'not-screened') actions = html`<a class="btn btn-s" href="${link}/screen">${t('Ask for a screen', '申请筛查')}</a>`;
  }
  return html`<article class="rcard${cls}"><a class="rcard-h" href="${link}"><b class="mono">#${r.id}</b>${chipFor(c, r)}</a><div class="rcard-m pi">${rigMeta(r)}</div><div class="rcard-b">${body}</div>${actions === EMPTY ? EMPTY : html`<div class="rcard-f">${actions}</div>`}</article>`;
}

/* ───────── the Rigs page ───────── */

function keeperStat(c: Ctx): { label: string; value: string; sub: string } {
  const open = c.snap.loans.filter(isOpen);
  const pick = open.find((l) => l.phase === 'seize') ?? open.find((l) => l.phase === 'flagged') ?? open.find((l) => l.phase === 'late') ?? [...open].sort((a, b) => a.maturity - b.maturity)[0];
  const base = { label: t('Next keeper harvest', '下次 keeper 领取'), value: '—', sub: t('No open loan', '暂无进行中的贷款') };
  if (!pick) return base;
  switch (pick.phase) {
    case 'active':
      return { ...base, value: fd(pick.maturity - HOUR), sub: t('At the latest; earlier once output covers the debt', '最迟时间；产出足以还清债务时会提前') };
    case 'late':
      return { ...base, sub: t(`About every ${LATE_HARVEST_EVERY / HOUR} h while debt is left`, `有欠款时约每 ${LATE_HARVEST_EVERY / HOUR} 小时一次`) };
    case 'flagged':
      return { label: t('Cure window ends', '补救窗口结束'), value: fd(pick.seizeStart ?? c.now), sub: t(`${dur((pick.seizeStart ?? c.now) - c.now)} left`, `剩余 ${dur((pick.seizeStart ?? c.now) - c.now)}`) };
    default:
      if (pick.deadlinePaused) return { label: t('Seize window ends', '没收窗口结束'), value: t('Paused', '已暂停'), sub: t('Voucher evidence can still allow a seize', '仍可根据凭证记录没收') };
      return { label: t('Seize window ends', '没收窗口结束'), value: fd(pick.deadline ?? c.now), sub: t(`${dur((pick.deadline ?? c.now) - c.now)} left`, `剩余 ${dur((pick.deadline ?? c.now) - c.now)}`) };
  }
}

function claimBanners(c: Ctx): Html {
  const flowAgent = c.borrow?.reused ? c.borrow.agent?.address : undefined;
  return html`${join(
    claimableAgents(c.snap)
      .filter((a) => a.address !== flowAgent)
      .map((a) =>
        cl(
          'i',
          html`<b>${t(`${bem4(a.bem)} BEM is waiting in your empty Rig Agent ${shortAddr(a.address)}.`, `您空闲的矿机代理 ${shortAddr(a.address)} 中有 ${bem4(a.bem)} BEM 待领取。`)}</b> ${t('A harvest sent before you released a voucher landed after that loan closed.', '在您取回凭证之前发起的一次领取收益，在贷款结清后才到账。')}`,
          act(c, { a: 'claim', v: a.address, size: 'sm', needs: ['rigs'] }, t('Claim late BEM', '领取迟到的 BEM')),
        ),
      ),
  )}`;
}

export function rigsPage(c: Ctx): Html {
  const { snap } = c;
  const open = snap.loans.filter(isOpen);
  const debt = open.reduce((a, L) => a + debtOf(L), 0n);
  const mine = orderedRigs(snap);
  const ready = readyRigs(snap).filter((r) => r.facts.place.kind === 'wallet').length;
  const k = keeperStat(c);
  return html`<div class="v2-title"><div><h1>${t('Rigs', '矿机')}</h1><p>${t('Your TapeOut rigs on X Layer. Borrow against a ready rig; a rig in a loan repays it once it is harvested.', '您在 X Layer 上的 TapeOut 矿机。可用就绪的矿机借款；贷款中的矿机在领取收益后自动还款。')}</p></div>${assetSeg()}</div>
    ${poolNotice(c)}
    <section class="v2-stats" aria-label="${t('Your rigs', '我的矿机')}">
      <div class="v2-stat"><span class="l">${t('Total debt', '债务合计')}</span><span class="v mono">${bem4(debt)} <span class="u">BEM</span></span><span class="s">${t('Principal, fee and late fee left', '剩余本金、费用和滞纳金')}</span></div>
      <div class="v2-stat"><span class="l">${t('Rigs in a loan', '贷款中的矿机')}</span><span class="v mono">${open.reduce((a, L) => a + L.rigIds.length, 0)} <span class="u">${t(`of ${mine.length}`, `/ ${mine.length}`)}</span></span><span class="s">${t('One rig, one loan', '一台矿机，一笔贷款')}</span></div>
      <div class="v2-stat"><span class="l">${k.label}</span><span class="v mono">${k.value}</span><span class="s">${k.sub}</span></div>
      <div class="v2-stat"><span class="l">${t('Ready to borrow', '可借矿机')}</span><span class="v mono">${ready} <span class="u">${t('rigs', '台')}</span></span><span class="s">${t('Pool room for you', '您的可借额度')} ${bem4(snap.wallet.room)} BEM</span></div></section>
    ${claimBanners(c)}${join(snap.agents.map((a) => releaseEntries(c, a)))}
    <div class="rgrid">${join(mine.map((r) => rigCard(c, r)))}</div>
    <div class="row-wrap g8-14 ai-c"><a class="btn btn-s" href="${c.link('/rigs/group')}">${t('Borrow against several rigs in one loan', '多台矿机合并为一笔借款')}</a><span class="mut t12">${t('Advanced. Grouped rigs are seized together if one of them is impaired.', '进阶功能。合并后只要一台受损，全组矿机都可能被没收。')}</span></div>
    <div class="rg3">${elig()}${alerts(c)}${help()}</div>`;
}

/* ───────── the rig page ───────── */

export function flashBanner(c: Ctx, id: number): Html {
  const f = c.ui.flash;
  if (!f || f.rigId !== id) return EMPTY;
  const list = f.ids.map((i) => `#${i}`);
  if (f.kind === 'borrowed') {
    return cl(
      'ok',
      html`<b>${t(`Borrowed ${bem4(f.amount)} BEM. It is in your wallet.`, `借款成功：${bem4(f.amount)} BEM 已到账。`)}</b> ${t(
        `The keeper harvests ${list.join(', ')} as soon as the mined BEM covers the debt (checked every 10 minutes), otherwise ${win(f.maturity - HOUR, f.maturity)}.${f.opsFee > 0n ? ` You paid the ${native(f.opsFee)} OKB operating fee.` : ''}`,
        `一旦 ${list.join('、')} 已挖出的 BEM 足以还清债务，keeper 即领取收益（每 10 分钟检查一次），否则在 ${win(f.maturity - HOUR, f.maturity)} 领取。${f.opsFee > 0n ? `${native(f.opsFee)} OKB 运营费已支付。` : ''}`,
      )}`,
    );
  }
  return cl('ok', html`<b>${t(`Voucher ${list.join(', ')} is back in your wallet.`, `凭证 ${list.join('、')} 已回到您的钱包。`)}</b> ${t('You can borrow against it again below.', '您可以在下方再次用它借款。')}`);
}

export function rigPage(c: Ctx, id: number): Html {
  const { snap } = c;
  const r = rigById(snap, id);
  if (!r) return html`${back(c.link('/rigs'), t('All rigs', '全部矿机'))}${cl('n', t('This rig is not in your wallet.', '您的钱包中没有这台矿机。'))}`;
  const L = loanForRig(snap, id);
  const s = r.state;
  const head = html`${back(c.link('/rigs'), t('All rigs', '全部矿机'))}<div class="v2-title"><div><h1>${t('Rig', '矿机')} <span class="mono">#${id}</span></h1><p class="pi">${rigMeta(r)}</p></div>${chipFor(c, r)}</div>`;
  const side = html`${alerts(c)}${help()}`;
  let content: Html;
  if (L && (s.kind === 'loan' || s.kind === 'seized' || (s.kind === 'in-agent' && L.phase === 'cleared'))) {
    content = html`<div class="ln">${loanCard(c, L)}<div class="v2-stack">${loanActions(c, L)}${side}</div></div>`;
  } else if (s.kind === 'ready' || s.kind === 'in-agent') {
    const extra = s.kind === 'in-agent' ? html`<section class="v2-card"><div class="v2-card-h"><h2>${t('Not borrowing now?', '暂时不借款？')}</h2></div><div class="v2-card-b row-wrap g10 ai-c">${takeBack(c, r, undefined)}<span class="mut t12">${t('Takes the voucher out of the agent and back to your wallet. You can move it in again later.', '把凭证从代理中取回到您的钱包，之后可以再次转入。')}</span></div></section>` : EMPTY;
    content = html`${poolNotice(c)}${flow(c, rigInfo(c, r))}${extra}`;
  } else if (s.kind === 'loose') {
    content = html`${cl('w', html`<b>${t('This voucher is not collateral.', '这张凭证不计入担保。')}</b> ${rigWhy2(r)}`, html`${s.agentClosed ? EMPTY : registerButton(c, r)}${act(c, { a: 'take-back', v: r.id, kind: 's', size: 'sm', needs: ['rigs'] }, t('Take back', '取回凭证'))}`)}<div class="rg3">${elig()}${side}</div>`;
  } else if (s.kind === 'seized') {
    content = html`${cl('n', html`<b>${t('Seized.', '已被没收。')}</b> ${t('The voucher now belongs to the pool and mines for lenders. The details of the loan could not be read right now.', '凭证现归资金池所有，为出借人挖矿。暂时无法读取该贷款的详细信息。')}`)}<div class="rg3">${elig()}${side}</div>`;
  } else if (s.kind === 'stuck') {
    content = html`${cl('n', html`<b>${t('Moving to the pool.', '正在转入资金池。')}</b> ${t('This agent was closed by a seize. The voucher is moving to the pool; anyone can finish the move.', '该矿机代理已因没收而关闭，凭证正在转入资金池，任何人都可以完成转移。')}`)}<div class="rg3">${elig()}${side}</div>`;
  } else {
    const kind = s.kind === 'not-screened' || s.kind === 'screen-pending' || s.kind === 'not-synced' ? 'w' : 'n';
    const cta = s.kind === 'not-screened' ? html`<a class="btn btn-p btn-sm" href="${c.link(`/rigs/${id}/screen`)}">${t('Ask for a screen', '申请筛查')}</a>` : s.kind === 'not-synced' ? harvestLink() : null;
    content = html`${cl(kind, html`<b>${t('This rig cannot borrow yet.', '这台矿机暂时无法借款。')}</b> ${rigWhy(r)}`, cta)}<div class="rg3">${elig()}${side}</div>`;
  }
  const released = c.ui.flash?.kind === 'released' && c.ui.flash.rigId === id ? c.ui.flash.agent : null;
  return html`${head}${flashBanner(c, id)}${content}${join(snap.agents.filter((a) => a.collateral.includes(id) || a.address.toLowerCase() === released?.toLowerCase()).map((a) => releaseEntries(c, a)))}`;
}

function rigWhy2(r: RigView): string {
  const s = r.state;
  if (s.kind !== 'loose') return '';
  return s.agentClosed
    ? t(`It is in the closed Rig Agent ${shortAddr(s.agent)}. Take it back to your wallet.`, `它在已关闭的矿机代理 ${shortAddr(s.agent)} 中，请取回到您的钱包。`)
    : t(`It is in your Rig Agent ${shortAddr(s.agent)} but does not count as collateral. Register it to borrow against it, or take it back.`, `它在您的矿机代理 ${shortAddr(s.agent)} 中，但不计入担保。登记后才能用它借款，也可以取回。`);
}

/* ───────── one loan for several rigs ───────── */

function rigRow(c: Ctx, r: RigView): Html {
  const can = r.state.kind === 'ready' || r.state.kind === 'in-agent';
  const on = c.ui.sel.includes(r.id);
  const type = c.ui.group ? 'checkbox' : 'radio';
  const pend = r.mined !== null && r.mined > 0n ? html` · ${t(`${bem4(r.mined)} BEM not harvested`, `待领取 ${bem4(r.mined)} BEM`)}` : EMPTY;
  const ask = r.state.kind === 'not-screened' && r.state.why === 'none' ? html`<a class="btn btn-s btn-sm" href="${c.link(`/rigs/${r.id}/screen`)}">${t('Ask for a screen', '申请筛查')}</a>` : EMPTY;
  return html`<label class="rig${on ? ' on' : ''}${can ? '' : ' dis'}"><input type="${type}" name="rig" data-pick="${r.id}"${on ? html` checked` : EMPTY}${can ? EMPTY : html` disabled`} aria-label="${t('Use rig', '选择矿机')} #${r.id}"><span class="rig-m"><b class="mono">#${r.id}</b><small>${rigMeta(r)}${pend}</small></span><span class="rig-c">${chipFor(c, r)}${ask}</span></label>`;
}

export function groupPage(c: Ctx): Html {
  const { snap } = c;
  const n = c.borrow?.ids.length ?? 0;
  const ops = snap.pool.params.opsFee[0];
  const rows = snap.rigs.filter((r) => r.facts.place.kind === 'wallet' || r.state.kind === 'in-agent');
  const picker = html`<section class="v2-card" aria-labelledby="a1"><div class="v2-card-h"><h2 id="a1"><span class="uid" aria-hidden="true">1</span>${t('Choose rigs', '选择矿机')}</h2><span class="meta">${t(`${n} selected · up to ${MAX_COLLATERAL}`, `已选 ${n} 台 · 最多 ${MAX_COLLATERAL} 台`)}</span></div><div class="rigs">${join(rows.map((r) => rigRow(c, r)))}</div>
    <div class="v2-card-b bt">${cl('w', html`<b>${t('Grouped rigs share one fate.', '合并后的矿机共担风险。')}</b> ${ops > 0n ? t(`Every rig in the group backs the whole loan. If any one of them is proven impaired, the pool can seize every rig in the group. Grouping saves the extra ${native(ops)} OKB fees and transactions of separate loans.`, `组内每台矿机都为整笔贷款担保。只要其中一台被链上证明受损，资金池可以没收该组全部矿机。合并可以省去分开借款所需的额外 ${native(ops)} OKB 运营费和交易。`) : t('Every rig in the group backs the whole loan. If any one of them is proven impaired, the pool can seize every rig in the group. Grouping saves the extra transactions of separate loans.', '组内每台矿机都为整笔贷款担保。只要其中一台被链上证明受损，资金池可以没收该组全部矿机。合并可以省去分开借款所需的额外交易。')}`)}</div></section>`;
  const sub = ops > 0n ? t('One debt and one OKB fee across rigs. Most miners should borrow rig by rig.', '多台矿机共用一笔债务和一笔 OKB 运营费。大多数矿工应逐台借款。') : t('One debt across rigs. Most miners should borrow rig by rig.', '多台矿机共用一笔债务。大多数矿工应逐台借款。');
  return html`${back(c.link('/rigs'), t('All rigs', '全部矿机'))}<div class="v2-title"><div><h1>${t('One loan for several rigs', '多台矿机合并借款')}</h1><p>${sub}</p></div></div>${poolNotice(c)}${flow(c, picker)}`;
}

