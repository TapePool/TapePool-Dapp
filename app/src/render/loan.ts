import { TAPEOUT_URL } from '../config';
import { DAY, HOUR, LATE_HARVEST_EVERY } from '../constants';
import { bem4, dur, fd, native, pctBps, pctOf, ringPct, shortAddr, win } from '../logic/format';
import { EMPTY, html, join, type Html } from '../html';
import { t } from '../i18n';
import { debtOf, isOpen } from '../logic/selectors';
import { debtProgress, payoffEstimate, type DebtProgress, type PayoffKind } from '../logic/loan';
import type { ImpairmentKind, LoanView } from '../model';
import { B, M, act, actLink, chip, cl, img, proc, type Ctx } from './ui';

export function loanChip(L: LoanView): Html {
  switch (L.phase) {
    case 'active':
      return chip('a', t('Active', '进行中'));
    case 'late':
      return chip('w', t('Past maturity', '已到期未还清'));
    case 'flagged':
      return chip('bad', t('Flagged', '已标记'));
    case 'seize':
      return chip('bad', t('Seize window', '没收窗口'));
    case 'seized':
      return chip('n', t('Seized', '已没收'));
    case 'cleared':
      return chip('ok', t('Debt cleared', '已还清'));
  }
}

/** What the flag says about the rig, as a clause: "it stopped on BSC". The generic line is the fallback (the evidence can be a voucher that synced power 0). */
export function impairmentClause(kind: ImpairmentKind | null): string {
  switch (kind) {
    case 'stopped':
      return t('it stopped on BSC', '在 BSC 上已停止');
    case 'inactive':
      return t('it is no longer active on BSC', '在 BSC 上已不再处于活跃状态');
    case 'rescued':
      return t('it is no longer in the vault on BSC', '在 BSC 上已不在托管中');
    case 'no-power':
      return t('it has no base power on BSC', '在 BSC 上已没有基础算力');
    default:
      return t('it was proven impaired on-chain', '已被链上证明受损');
  }
}

const ids = (L: LoanView, sep: string): string => L.rigIds.map((i) => `#${i}`).join(sep);

/** The banner on top of the loan card, for the phases that need words. */
export function loanBanner(c: Ctx, L: LoanView): Html {
  const d = debtOf(L);
  const lead = L.rigIds[0] ?? 0;
  const need = d > L.agentBem ? d - L.agentBem : 0n;
  const cureEnd = L.seizeStart ?? 0;
  const seizeEnd = L.deadline ?? 0;
  const flagRig = L.impairedRig ?? lead;
  const repayBtn = act(c, { a: 'repay', v: lead, kind: 'd', needs: ['loans'] }, t(`Repay ${bem4(need)} BEM`, `偿还 ${bem4(need)} BEM`));
  if (L.deadlinePaused && (L.phase === 'flagged' || L.phase === 'seize')) return cl('bad', html`<b>${t('The seize deadline is paused while the feed is off. A seize is still possible on voucher evidence.', '数据源关闭期间，没收截止时间暂停。仍可根据凭证记录没收。')}</b><p>${t(`Cure window ends ${fd(cureEnd, true)}.`, `补救窗口于 ${fd(cureEnd, true)} 结束。`)}</p>`, repayBtn);
  if (L.expired && L.doubtful) return cl('w', t('The flag expired. This loan remains doubtful until it is cleared or repaid.', '标记已过期。解除标记或还款前，贷款仍记为存疑。'), repayBtn);
  switch (L.phase) {
    case 'late':
      return cl(
        'w',
        html`<b>${t(`Matured ${fd(L.maturity)} with ${bem4(d)} BEM left.`, `已于 ${fd(L.maturity)}到期，剩余 ${bem4(d)} BEM。`)}</b> ${t(
          `Output fell, so the maturity harvest did not cover the debt. Nothing is seized for being slow: the voucher stays in the agent and keeps repaying. The keeper harvests about every ${LATE_HARVEST_EVERY / HOUR} h. Late fee: ${pctBps(L.lateBpsPerDay)} per day, fixed when you borrowed.`,
          `产出下降，到期领取的收益不足以还清。产出慢不会导致没收：凭证留在代理中继续还款。keeper 约每 ${LATE_HARVEST_EVERY / HOUR} 小时领取一次。滞纳金：每天 ${pctBps(L.lateBpsPerDay)}，借款时已固定。`,
        )}`,
      );
    case 'flagged':
      return cl(
        'bad',
        html`<b>${t(`Rig #${flagRig} is flagged: ${impairmentClause(L.impairment)} (seen ${fd(L.impairedAt ?? c.now, true)}).`, `矿机 #${flagRig} 已被标记：${impairmentClause(L.impairment)}（${fd(L.impairedAt ?? c.now, true)} 观察到）。`)}</b><p>${t(
          `Repay the debt within ${dur(cureEnd - c.now)} (before ${fd(cureEnd, true)}) to keep your rig. After that a 24 h seize window opens. Lenders see this loan as doubtful until it is resolved, and new deposits stay closed meanwhile.`,
          `请在 ${dur(cureEnd - c.now)} 内（${fd(cureEnd, true)} 前）还清债务以保留矿机，之后将进入 24 小时没收窗口。在问题解决前，该贷款在出借人一侧记为存疑，期间暂停新存款。`,
        )}</p>`,
        repayBtn,
      );
    case 'seize':
      return cl(
        'bad',
        html`<b>${t(`The cure window ended ${fd(cureEnd, true)}.`, `补救窗口已于 ${fd(cureEnd, true)} 结束。`)}</b><p>${t(
          `Until ${fd(seizeEnd, true)} (${dur(seizeEnd - c.now)} left) anyone can hand the rig to the pool if it is still impaired. Repaying in full now still keeps it.`,
          `在 ${fd(seizeEnd, true)} 之前（剩余 ${dur(seizeEnd - c.now)}），如果矿机仍处于受损状态，任何人都可以把它没收给资金池。现在全额还款仍可保留矿机。`,
        )}</p>`,
        repayBtn,
      );
    case 'seized':
      return cl(
        'n',
        html`<b>${t(`Seized on ${fd(L.seizedAt ?? c.now, true)}.`, `已于 ${fd(L.seizedAt ?? c.now, true)} 没收。`)}</b> ${t(
          `Voucher${L.rigIds.length > 1 ? 's' : ''} ${ids(L, ', ')} now belong${L.rigIds.length > 1 ? '' : 's'} to the pool and mine${L.rigIds.length > 1 ? '' : 's'} for lenders. The ${bem4(L.writtenOff ?? 0n)} BEM left was written off; you keep the advance.`,
          `凭证 ${ids(L, '、')} 现归资金池所有，为出借人挖矿。剩余 ${bem4(L.writtenOff ?? 0n)} BEM 债务已核销，借款金额归您所有。`,
        )}`,
      );
    case 'cleared':
      return cl(
        'ok',
        html`<b>${t(`Debt cleared on ${fd(L.clearedAt ?? c.now, true)}.`, `债务已于 ${fd(L.clearedAt ?? c.now, true)} 还清。`)}</b> ${L.surplus ? t(`${bem4(L.surplus)} BEM above the debt went back to your wallet. `, `超出债务的 ${bem4(L.surplus)} BEM 已退回您的钱包。`) : ''}${t(
          'Take your rig back: release the voucher (1 transaction), or leave it in the agent to borrow again without moving it.',
          '取回矿机：取回凭证（1 笔交易）；也可以留在代理中，下次借款无需再次转入。',
        )}`,
        act(c, { a: 'release', v: lead, needs: ['loans'] }, t('Release voucher', '取回凭证')),
      );
    default:
      return EMPTY;
  }
}

/** Tenths of a percent as "15.6%". */
const pc = (tenths: number): string => `${Math.floor(tenths / 10)}.${tenths % 10}%`;

/**
 * The repayment bar of an open loan (SPEC-PHASE5-PROGRESS): what is repaid, then what is mined toward the debt and not
 * harvested yet, on a scale of 0 to 110% of the debt, with a marker where the keeper's covered harvest fires.
 */
function progressBar(L: LoanView, p: DebtProgress): Html {
  const SCALE = 1_100; // tenths of a percent: the bar runs to 110% of the debt
  const w = (v: number): number => (Math.min(Math.max(v, 0), SCALE) / SCALE) * 100;
  const repaidW = w(p.repaid);
  const minedW = p.mined === null ? 0 : Math.min(w(p.mined), 100 - repaidW);
  const active = L.phase === 'active';
  const now = p.repaid + (p.mined ?? 0);
  const covered = active && p.mined !== null && now >= p.trigger;
  const base =
    p.mined === null
      ? t(`${pc(p.repaid)} repaid · mined BEM unknown`, `已还 ${pc(p.repaid)} · 已挖出数额未知`)
      : t(`${pc(p.repaid)} repaid · ${pc(p.mined)} mined, not yet harvested (after the bridge fee)`, `已还 ${pc(p.repaid)} · 已挖出待领取 ${pc(p.mined)}（扣除跨链费）`);
  const tail =
    p.mined === null
      ? ''
      : active
        ? covered
          ? t(' · covered: the keeper harvests at its next check', ' · 已足够：keeper 将在下次检查时领取')
          : t(` · the keeper harvests at ${pc(p.trigger)}`, ` · 达到 ${pc(p.trigger)} 时 keeper 领取`)
        : L.phase === 'late'
          ? t(` · the keeper harvests about every ${LATE_HARVEST_EVERY / HOUR} h`, ` · keeper 约每 ${LATE_HARVEST_EVERY / HOUR} 小时领取一次`)
          : '';
  const legend = t('Mined, not yet harvested, is not repaid: it reaches the loan when the keeper harvests it.', '已挖出待领取的 BEM 尚未还款，keeper 领取后才会用于还款。');
  return html`<div class="bar bar2" role="progressbar" aria-label="${t('Repaid and mined toward the debt', '已还及已挖出')}" aria-valuemin="0" aria-valuemax="110" aria-valuenow="${(Math.min(now, SCALE) / 10).toFixed(1)}" title="${legend}"><span class="seg-r" data-pct="${repaidW.toFixed(1)}"></span><span class="seg-m" data-pct="${minedW.toFixed(1)}"></span>${active ? html`<i class="bar-mk" data-pct="${w(p.trigger).toFixed(1)}"></i>` : EMPTY}</div>
      <p class="mut m0 t12 bar2-t">${base}${tail}${t('. ', '。')}${legend}</p>`;
}

export function loanCard(c: Ctx, L: LoanView): Html {
  const d = debtOf(L);
  const lead = L.rigIds[0] ?? 0;
  const known = L.feePaid !== null;
  const total = L.advance + (L.feePaid ?? 0n);
  const repaid = !known ? null : L.phase === 'seized' ? (L.writtenOff === null ? null : total - L.writtenOff) : total - d;
  const rp = repaid === null || total === 0n ? 0 : ringPct(repaid, total);
  const span = Math.max(1, L.maturity - L.start);
  const elapsed = Math.max(0, Math.min(1, (c.now - L.start) / span));
  const day = Math.floor((c.now - L.start) / DAY);
  const days = c.snap.pool.params.termDays[L.term];
  const past = c.now > L.maturity;
  const todayLbl = past
    ? t(`Today · ${Math.floor((c.now - L.maturity) / DAY + 1)} d past maturity`, `今天 · 已过期 ${Math.floor((c.now - L.maturity) / DAY + 1)} 天`)
    : t(`Today · day ${day} of ${days}`, `今天 · 第 ${day} / ${days} 天`);

  let src: Html = EMPTY;
  if (isOpen(L)) {
    const flagged = L.phase === 'flagged' || L.phase === 'seize';
    const horizon = L.phase === 'late' ? LATE_HARVEST_EVERY / DAY : Math.max(0, (L.maturity - c.now) / DAY);
    // the forecast needs the BEM mined on BSC; without it (unreadable) there is nothing honest to say
    const avail = L.minedBsc === null ? 0n : L.minedBsc + L.agentBem + (L.expectedPerDay * BigInt(Math.round(horizon * 1000))) / 1000n;
    const pay = payoffEstimate(L, c.snap.harvest.feeBps, c.now);
    const when = pay.at === null ? '' : fd(pay.at, true);
    const payValue: Record<Exclude<PayoffKind, 'none'>, () => string> = {
      sweep: () => t(`≈ ${when} · the BEM in the agent covers it`, `约 ${when} · 代理中的 BEM 已足够还清`),
      covered: () => t(`≈ ${when} · output covers the debt now`, `约 ${when} · 产出现已足以还清`),
      before: () => t(`≈ ${when}`, `约 ${when}`),
      maturity: () => t(`≈ ${when} · at the maturity harvest`, `约 ${when} · 于到期领取时`),
      short: () => t('after maturity · output falls short', '到期后 · 产出不足'),
      unknown: () => '—',
    };
    const payRow = pay.kind === 'none' ? EMPTY : html`<div><span>${t('Estimated repaid', '预计还清')}</span><span class="mono">${payValue[pay.kind]()}</span></div>`;
    // rounded up to ten minutes like the row, so the line does not tick with the page's clock
    const coverAt = pay.kind === 'before' && pay.cover !== null ? fd(Math.ceil(pay.cover / 600) * 600, true) : null;
    const coverLine = coverAt === null
      ? ''
      : `${t(
          `At this pace the rig's mined BEM covers the debt, plus the 1% margin and the bridge fee, around ${coverAt}. The keeper then harvests it, and the loan usually closes within about 20 minutes.`,
          `按当前速度，矿机已挖出的 BEM 约在 ${coverAt} 足以还清债务（含 1% 余量和跨链费）。届时 keeper 会领取收益，贷款通常在约 20 分钟内结清。`,
        )} `;
    const forecast = flagged || L.minedBsc === null
      ? EMPTY
      : html`<p class="mut m0 t12">${coverLine}${avail >= d
          ? t(
              `At this pace about ${bem4(avail)} BEM is ready by the ${L.phase === 'late' ? 'next' : 'maturity'} harvest, more than the ${bem4(d)} BEM debt, so it should clear the loan. Anything above the debt goes back to you.`,
              `按当前速度，到${L.phase === 'late' ? '下次' : '到期'}领取时约有 ${bem4(avail)} BEM，超过 ${bem4(d)} BEM 的债务，应可还清贷款，多出部分退还给您。`,
            )
          : t(
              `At this pace about ${bem4(avail)} BEM is ready by the next harvest, short of the ${bem4(d)} BEM debt. The rest keeps repaying after it.`,
              `按当前速度，下次领取时约有 ${bem4(avail)} BEM，不足以偿还 ${bem4(d)} BEM 的债务，剩余部分之后继续偿还。`,
            )} ${L.phase === 'active'
          ? t("An estimate from the rig's current base power. The design bonus can make it sooner; a fall in output, later.", '根据矿机当前基础算力估算。设计加成可能使其提前，产出下降则会推迟。')
          : t("An estimate from the rig's current base power; output can fall.", '根据矿机当前基础算力估算，产出可能下降。')}</p>`;
    src = html`<div class="src"><div><h3>${t('WHERE REPAYMENT COMES FROM', '还款来源')}</h3></div>
      <div><span>${t('Mined on BSC, not harvested yet', 'BSC 上已挖出、尚未领取')}</span>${L.minedBsc === null ? html`<span class="mono">—</span>` : B(L.minedBsc)}</div>
      <div><span>${t('Harvested, waiting in the agent', '已领取、在代理中待归集')}</span><span>${B(L.agentBem)}${L.agentBem > 0n ? html` ${actLink(c, { a: 'sweep', v: lead, needs: ['loans'] }, t('Apply now', '立即归集'))}` : EMPTY}</span></div>
      ${flagged ? EMPTY : html`<div><span>${t('Keeper harvest', 'keeper 领取')}</span><span class="mono">${L.phase === 'late' ? t(`about every ${LATE_HARVEST_EVERY / HOUR} h`, `约每 ${LATE_HARVEST_EVERY / HOUR} 小时`) : t(`when output covers the debt · at the latest ${win(L.maturity - HOUR, L.maturity)}`, `产出足以还清时 · 最迟 ${win(L.maturity - HOUR, L.maturity)}`)}</span></div>`}
      ${flagged ? EMPTY : payRow}
    </div>${forecast}
    <div class="row-wrap g8-12 ai-c"><a class="btn btn-s" href="${TAPEOUT_URL}" target="_blank" rel="noopener noreferrer">${t('Harvest early on tapeout.net', '提前在 tapeout.net 领取')}</a><span class="mut t12">${t('Repays sooner. You pay the BNB gas on BSC.', '可更早还款，由您支付 BSC 上的 BNB gas。')}</span></div>`;
  }

  const rows = L.collateral.map((r) => {
    const status = L.phase === 'seized' ? chip('n', t('With the pool', '归资金池')) : r.mining ? chip('ok', t('Mining', '挖矿中')) : chip('bad', t('Stopped', '已停止'));
    return html`<tr><td class="mono" data-l="${t('Collateral', '凭证')}">#${r.id}</td><td class="r mono" data-l="${t('Base power', '基础算力')}">${r.basePower} H</td><td data-l="${t('Processor', '处理器')}"><span class="inl6">${r.processor === 'TapeOut' ? img('tapeout', 'i-18') : EMPTY}${r.processor ?? proc(null)}</span></td><td class="r mono" data-l="${t('Age', '上线时间')}">${t(`${Math.floor(r.age / DAY)} days`, `${Math.floor(r.age / DAY)} 天`)}</td><td data-l="${t('Rig', '矿机')}">${status}</td></tr>`;
  });

  const grid: [string, Html | string][] = [
    [t('Term', '期限'), t(`${days} days`, `${days} 天`)],
    [t('Advance', '借款金额'), `${bem4(L.advance)} BEM`],
    [t('Flat fee, paid', '固定费用（已付）'), L.feePaid === null ? '—' : `${bem4(L.feePaid)} · ${pctOf(L.feePaid, L.advance, 2)}`],
    [t('Late fee rate', '滞纳金费率'), t(`${pctBps(L.lateBpsPerDay)} per day`, `每天 ${pctBps(L.lateBpsPerDay)}`)],
  ];
  grid.push([t('Operating fee, paid', '运营费（已付）'), L.opsFeePaid === null ? '—' : L.opsFeePaid === 0n ? t('no fee', '无费用') : `${native(L.opsFeePaid)} OKB`]);

  return html`<section class="v2-card" aria-labelledby="ld"><div class="v2-card-h"><h2 id="ld"><span class="uid" aria-hidden="true">L2</span>${t('Loan', '贷款')}</h2><span class="meta">${t('Rig Agent', '矿机代理')} <span class="mono c-soft" title="${L.agent}">${shortAddr(L.agent)}</span></span></div>
    <div class="v2-card-b loan-b">${loanBanner(c, L)}
      <div class="loan-top"><div><span class="mut t12">${t('Debt now', '当前债务')}</span><div class="mono debt-n">${bem4(L.phase === 'seized' ? 0n : d)} <span class="u t15">BEM</span></div><span class="mut t12">${t('Principal', '本金')} ${M(bem4(L.principal))} + ${t('fee left', '剩余费用')} ${M(bem4(L.feeLeft))} + ${t('late fee', '滞纳金')} ${M(bem4(L.lateFee))}</span></div>
        <div class="ta-r"><span class="mut t12">${t('Repaid so far', '已还')}</span><div>${repaid === null ? M('—') : html`${M(bem4(repaid))} <span class="mut">${t('of', '/')}</span> ${M(bem4(total))} BEM`}</div></div></div>
      ${isOpen(L) ? progressBar(L, debtProgress(L, c.snap.harvest.feeBps)) : html`<div class="bar" role="progressbar" aria-label="${t('Repaid', '已还')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${rp.toFixed(1)}"><span data-pct="${rp.toFixed(1)}"></span></div>`}
      <div class="tl-box"><div class="tl"><span data-pct="${(elapsed * 100).toFixed(1)}"></span><i class="tl-s"></i><i class="tl-now" data-pct="${(elapsed * 100).toFixed(1)}"></i><i class="tl-e"></i></div>
        <div class="tl-grid t12"><div><span class="mut">${t('Start', '开始')}</span><br><span class="mono">${fd(L.start, true)}</span></div><div class="ta-c"><span class="mut">${todayLbl}</span><br><span class="mono">${fd(c.now, true)}</span></div><div class="ta-r"><span class="mut">${t('Maturity', '到期')}</span><br><span class="mono">${fd(L.maturity, true)}</span></div></div></div>
      ${src}
      <table class="v2-tbl stack tbl-box"><thead><tr><th>${t('Collateral', '凭证')}</th><th class="r">${t('Base power', '基础算力')}</th><th>${t('Processor', '处理器')}</th><th class="r">${t('Age', '上线时间')}</th><th>${t('Rig', '矿机')}</th></tr></thead><tbody>${join(rows)}</tbody></table>
      <dl class="loan-grid">${join(grid.map(([k, v]) => html`<div><dt class="mut t12">${k}</dt><dd class="mono">${v}</dd></div>`))}</dl></div></section>`;
}

/** The actions card next to the loan card. */
export function loanActions(c: Ctx, L: LoanView): Html {
  const lead = L.rigIds[0] ?? 0;
  let body: Html;
  if (isOpen(L)) {
    body = html`<div class="act">${act(c, { a: 'repay', v: lead, size: 'lg', needs: ['loans'] }, t('Repay with BEM', '用 BEM 还款'))}<small>${t('Any time. Repaying early does not reduce the flat fee.', '随时可还。提前还款不会减少固定费用。')}</small></div>
      <div class="act">${c.readOnly === 'frame' ? EMPTY : html`<button type="button" class="btn btn-x btn-lg" disabled>${t('Release voucher', '取回凭证')}</button>`}<small>${t('After the debt reaches 0.', '债务清零后可用。')}</small></div>
      ${L.agentBem > 0n ? html`<div class="act">${act(c, { a: 'sweep', v: lead, kind: 's', needs: ['loans'] }, html`${t('Apply harvested BEM now', '立即归集已领取的 BEM')} <span class="mono c-blue">${bem4(L.agentBem)}</span>`)}<small>${t('Optional. The keeper does this (sweep) every 10 minutes, and anyone may call it.', '可选操作。keeper 每 10 分钟自动执行归集（sweep），任何人都可以调用。')}</small></div>` : EMPTY}`;
  } else if (L.phase === 'cleared') {
    body = html`<div class="act">${act(c, { a: 'release', v: lead, size: 'lg', needs: ['loans'] }, t('Release voucher', '取回凭证'))}<small>${t('Sends the voucher to your wallet. A harvest sent while the agent still holds it pays the agent; claim that later with Claim late BEM.', '将凭证转回您的钱包。代理持有凭证期间发起的领取收益仍会进入代理，之后可通过“领取迟到的 BEM”取回。')}</small></div>`;
  } else {
    body = html`<p class="mut m0">${t('The loan is closed. Nothing is left to repay.', '贷款已关闭，无需再还款。')}</p>`;
  }
  return html`<section class="v2-card" aria-labelledby="la"><div class="v2-card-h"><h2 id="la"><span class="uid" aria-hidden="true">L3</span>${t('Actions', '操作')}</h2></div><div class="v2-card-b col g12">${body}</div></section>`;
}

