import { DAY, HOUR } from '../constants';
import {
  bem4,
  bem4Floor,
  bemAuto,
  bemTrim,
  fd,
  mmss,
  native,
  native4,
  pctBps,
  pctOf,
  shortAddr,
  win,
  yearlyOf,
} from '../logic/format';
import { EMPTY, html, join, type Html } from '../html';
import { t } from '../i18n';
import { errorText, limitText } from '../chain/errors';
import { debtBarPct, isRoomReason, type BorrowView } from '../logic/borrow';
import type { ParamKey, QueuedChange, RigView } from '../model';
import { step2Body, step3Body, reviewRow, reviewSentence } from './mined';
import { act, actLink, bar, chip, cl, img, proc, soon, soonTip, tip, type Ctx } from './ui';

const hexBits = (n: number): string => `0x${n.toString(16).toUpperCase()}`;

export function rigMeta(r: RigView): Html {
  const bp = r.basePower;
  const days = r.age === null ? null : Math.floor(r.age / DAY);
  const parts: Html[] = [];
  parts.push(bp === null ? html`${t('No rig data yet', '暂无矿机数据')}` : html`${t(`${bp} H base power`, `基础算力 ${bp} H`)}`);
  if (r.facts.bsc) parts.push(proc(r.processor));
  if (days !== null) parts.push(html`${t(`${days} days old`, `已上线 ${days} 天`)}`);
  // BSC could not be read, so these figures come from the last report the feed holds
  if (r.facts.bscAsOf !== null) parts.push(html`${t(`BSC data as of ${fd(r.facts.bscAsOf, true)}`, `BSC 数据截至 ${fd(r.facts.bscAsOf, true)}`)}`);
  return join(parts, ' · ');
}

/** The screen pass as the chain has it: a rig in an agent can be shown before its pass counts (or without one). */
function screenChip(c: Ctx, r: RigView): Html {
  const s = r.facts.screen;
  if (!s.pass) return chip('w', t('Not screened', '尚未筛查'));
  if (s.suspended) return chip('w', t('Screen suspended', '筛查已暂停'));
  if (c.now < s.pass.effectiveAt) return chip('w', t(`Counts from ${fd(s.pass.effectiveAt, true)}`, `${fd(s.pass.effectiveAt, true)} 起生效`));
  return chip('ok', t('Recorded on-chain', '已上链'));
}

export function rigInfo(c: Ctx, r: RigView): Html {
  const days = r.age === null ? 0 : Math.floor(r.age / DAY);
  return html`<section class="v2-card" aria-labelledby="a1"><div class="v2-card-h"><h2 id="a1"><span class="uid" aria-hidden="true">1</span>${t('Rig', '矿机')} <span class="mono">#${r.id}</span></h2><a class="lnk" href="${c.link('/rigs')}">${t('Change rig', '更换矿机')}</a></div><div class="v2-card-b col g10"><dl class="kv pi m0">
    <div><dt>${t('Base power', '基础算力')}</dt><dd class="mono">${r.basePower ?? 0n} H</dd></div>
    <div><dt>${t('Processor', '处理器')}</dt><dd>${proc(r.processor)}</dd></div>
    <div><dt>${t('Age', '上线时间')}</dt><dd>${t(`${days} days`, `${days} 天`)}</dd></div>
    <div><dt>${t('Screen pass', '筛查')}</dt><dd>${screenChip(c, r)}</dd></div>
    <div><dt>${t('Not harvested on BSC', 'BSC 上待领取')}</dt><dd>${r.mined === null ? '—' : html`<span class="nw"><span class="mono">${bem4(r.mined)}</span> <span class="u">BEM</span></span>`}</dd></div></dl>
    <span class="mut t12">${t('This rig gets its own Rig Agent, so a problem with one rig never puts your other rigs at risk.', '这台矿机使用独立的“矿机代理”（Rig Agent），一台矿机出问题不会牵连其他矿机。')}</span></div></section>`;
}

function queuedLabel(k: ParamKey): string {
  switch (k) {
    case 'feeBps7d':
      return t('The 7-day fee', '7 天期限的费用');
    case 'feeBps14d':
      return t('The 14-day fee', '14 天期限的费用');
    case 'minFee':
      return t('The minimum fee', '最低费用');
    case 'minAdvance':
      return t('The minimum advance', '最低借款金额');
    case 'lateFee':
      return t('The late fee', '滞纳金');
    default:
      return t('The operating fee', '运营费');
  }
}

function queuedValue(q: QueuedChange): string {
  switch (q.key) {
    case 'feeBps7d':
    case 'feeBps14d':
    case 'lateFee':
      return pctBps(Number(q.value));
    case 'minFee':
    case 'minAdvance':
      return `${bemAuto(q.value)} BEM`;
    default:
      return `${native(q.value)} OKB`;
  }
}

/** The warning for parameter changes that wait in the queue (SPEC-PHASE5-APP §5.1). */
export function queuedNotice(c: Ctx, b: BorrowView): Html {
  const list = c.snap.pool.queued;
  if (list.length === 0) return EMPTY;
  const ops = list.filter((q) => q.key === (b.term === 0 ? 'opsFee7d' : 'opsFee14d'));
  const rest = list.filter((q) => !ops.includes(q) && !(q.key === 'opsFee7d' || q.key === 'opsFee14d'));
  const out: Html[] = [];
  const first = ops[0];
  if (first)
    out.push(
      cl(
        'w',
        html`<b>${t('An operating fee change is queued.', '运营费变更排队中。')}</b> ${t(
          `The fee becomes ${native(first.value)} OKB for new loans once someone executes it after ${fd(first.eta, true)}. A borrow that lands before then pays ${native(b.opsFee)} OKB; the app always sends the fee in force when you sign.`,
          `运营费将调整为 ${native(first.value)} OKB，在 ${fd(first.eta, true)} 之后有人执行即对新借款生效。在此之前完成的借款仍支付 ${native(b.opsFee)} OKB；应用始终按您签名时生效的费用发送。`,
        )}`,
      ),
    );
  for (const q of rest)
    out.push(
      cl(
        'w',
        html`<b>${t(`${queuedLabel(q.key)} change is queued.`, `${queuedLabel(q.key)}变更排队中。`)}</b> ${t(
          `It becomes ${queuedValue(q)} for new loans once someone executes it after ${fd(q.eta, true)}.`,
          `将调整为 ${queuedValue(q)}，在 ${fd(q.eta, true)} 之后有人执行即对新借款生效。`,
        )}`,
      ),
    );
  return html`${out}`;
}

function amtCard(c: Ctx, b: BorrowView): Html {
  const p = c.snap.pool.params;
  const { limits, term, amount: a } = b;
  const lim = limits[term];
  const termBtn = (i: 0 | 1): Html => {
    const l = limits[i];
    const matures = c.now + p.termDays[i] * DAY;
    return html`<button type="button" class="term" data-a="term" data-v="${i}" aria-pressed="${term === i ? 'true' : 'false'}"${l.offered ? EMPTY : html` disabled`}><b>${t(`${p.termDays[i]} days`, `${p.termDays[i]} 天`)}</b><small>${t(`Fee ${pctBps(p.feeBps[i])} · debt up to ${pctBps(p.maxDebtBps[i])} of expected output`, `费用 ${pctBps(p.feeBps[i])} · 债务上限为预期产出的 ${pctBps(p.maxDebtBps[i])}`)}</small><small>${
      l.offered ? t(`Matures ${fd(matures)} · max ${bem4Floor(l.maxPrincipal)} BEM`, `${fd(matures)}到期 · 上限 ${bem4Floor(l.maxPrincipal)} BEM`) : t('Not offered: it would end after the next halving window', '暂不提供：该期限会在下一个减半窗口之后结束')
    }</small></button>`;
  };
  const max = lim.maxPrincipal;
  const okMax = max >= p.minAdvance;
  const sliderVal = a.value < p.minAdvance ? p.minAdvance : a.value > max ? max : a.value;
  const body = html`<div class="row-wrap g10">${termBtn(0)}${termBtn(1)}</div>${
    okMax
      ? html`<div class="amt"><div class="amt-row"><label for="bamt" class="mut t12">${t('Advance', '借款金额')}</label><span class="mut ml-a t12">${t('Max', '上限')} <span class="mono c-w">${bem4Floor(max)}</span> BEM</span></div>
          <div class="amt-row"><input id="bamt" type="text" inputmode="decimal" data-in="b.amt" value="${a.text}"><span class="tok">${img('bem')}BEM</span><button type="button" class="maxb" data-a="max">MAX</button></div>
          <input class="range" type="range" min="${bemAuto(p.minAdvance)}" max="${bem4Floor(max)}" step="0.0001" value="${bem4Floor(sliderVal)}" data-in="b.amt" aria-label="${t('Advance amount', '借款金额')}">
          <div class="row-sb mut"><span class="mono t11">${bem4(p.minAdvance)}</span><span class="mono t11">${bem4Floor(max)}</span></div>${a.error ? html`<span class="err" role="alert">${a.error}</span>` : EMPTY}</div>
          ${a.minFeeApplies && a.valid ? html`<p class="note m0">${t(`The ${bemAuto(p.minFee)} BEM minimum fee applies at this size, so the fee is a larger share of a small advance.`, `该金额适用 ${bemAuto(p.minFee)} BEM 最低费用，小额借款的费用占比更高。`)}</p>` : EMPTY}
          ${lim.roomLimited ? html`<p class="note m0">${t("Your max is set by the pool's room for you, not by your rig.", '您的上限受资金池可借额度限制，而非矿机产出。')}</p>` : EMPTY}`
      : cl('n', t('Nothing to borrow for this choice right now.', '当前选择暂无可借额度。'))
  }`;
  return html`<section class="v2-card" aria-labelledby="a2"><div class="v2-card-h"><h2 id="a2"><span class="uid" aria-hidden="true">2</span>${t('Term and amount', '期限和金额')}</h2><span class="meta">${t('The term sets the maturity', '期限决定到期时间')}</span></div><div class="v2-card-b col g14">${body}${c.snap.wallet.binding ? html`<p class="note m0">${t('Pool limit', '资金池上限')}: ${limitText(c.snap.wallet.binding, b.settling)}</p>` : EMPTY}</div></section>`;
}

function ruleChip(b: BorrowView): Html {
  switch (b.rule) {
    case 'allow':
      return chip('ok', t('Credit rule: allow', '信用规则：允许'));
    case 'deny':
      return chip('bad', t('Credit rule: deny', '信用规则：拒绝'));
    case 'cant':
      return chip('bad', t("Credit rule: can't check", '信用规则：无法验证'));
    default:
      return html`${chip('n', t('Credit rule: estimate', '信用规则：预估'))} ${tip(t('An estimate from the latest data. The real answer comes from the credit rule on X Layer once your voucher is in the agent and its data is fresh (steps 1 to 3).', '根据最新数据预估。凭证转入矿机代理并刷新数据后（第 1–3 步），由 X Layer 上的信用规则给出正式结果。'), 'end')}`;
  }
}

function summary(c: Ctx, b: BorrowView): Html {
  const { snap } = c;
  const p = snap.pool.params;
  const a = b.amount;
  const lim = b.limits[b.term];
  const days = p.termDays[b.term];
  const head = html`<div class="v2-card-h"><h2 id="q1"><span class="uid" aria-hidden="true">Q</span>${t('Your borrow', '借款摘要')}</h2><span>${ruleChip(b)}</span></div>`;
  // while the feed settles after a re-enable the room is 0, so the lens can only say the pool has no room and the
  // estimate finds nothing to borrow: say why instead (RC3-02)
  const roomOnly = b.source === 'quote' && b.quote ? isRoomReason(b.quote.reason) : b.limits.every((l) => l.maxPrincipal < p.minAdvance);
  if (b.settling && roomOnly)
    return html`<section class="v2-card" aria-labelledby="q1">${head}<div class="v2-card-b">${cl('w', errorText({ kind: 'revert', name: 'FeedSettling' }))}</div></section>`;
  if (b.source === 'quote' && b.quote && b.quote.reason !== 0)
    return html`<section class="v2-card" aria-labelledby="q1">${head}<div class="v2-card-b">${cl('w', errorText({ kind: 'quote', reason: b.quote.reason, params: { minAdvance: bemTrim(p.minAdvance), inputBits: b.quote.inputBits, terms: p.termDays, eta: snap.pool.pendingPolicy ? fd(snap.pool.pendingPolicy.eta, true) : undefined } }))}</div></section>`;
  if (lim.maxPrincipal < p.minAdvance && b.limits.every((l) => l.maxPrincipal < p.minAdvance))
    return html`<section class="v2-card" aria-labelledby="q1">${head}<div class="empty">${t('Choose a ready rig to see your advance and its full cost.', '选择一台可借的矿机，查看可借金额和全部成本。')}</div></section>`;
  const maturity = c.now + days * DAY;
  const hasOps = b.opsFee > 0n;
  const okbLine = b.okbEnough
    ? html`<li>${t(`Your wallet holds ${native4(snap.wallet.okb)} OKB, enough for the fee and gas.`, `您的钱包有 ${native4(snap.wallet.okb)} OKB，足够支付运营费和 gas。`)}</li>`
    : html`<li class="c-warn">${t(`Your wallet holds ${native4(snap.wallet.okb)} OKB. Add at least ${native4(b.okbShort)} OKB on X Layer for the fee and gas.`, `您的钱包只有 ${native4(snap.wallet.okb)} OKB，请在 X Layer 上至少补充 ${native4(b.okbShort)} OKB，用于运营费和 gas。`)}</li>`;
  const feeNote = hasOps
    ? html`<span class="mut t12">${t(`Plus ${native(b.opsFee)} OKB per loan, not included in this percentage`, `另付 ${native(b.opsFee)} OKB 运营费，不计入此百分比`)}</span>`
    : EMPTY;
  const queuedFees = snap.pool.queued;
  const shown = lim.expected;
  return html`<section class="v2-card" aria-labelledby="q1">${head}<div class="v2-card-b col g14">
    <dl class="kv m0">
      <div><dt>${t('You receive', '到账金额')}</dt><dd><span class="mono t18">${bem4(a.value)}</span> BEM</dd></div>
      <div><dt>${t('BEM fee, flat', '固定费用（BEM）')}</dt><dd><span class="mono">${bem4(a.fee)}</span> BEM <span class="mut">· ${a.value > 0n ? pctOf(a.fee, a.value, 2) : '0%'}</span></dd></div>
      <div><dt>${t('Debt to repay', '应还债务')}</dt><dd><span class="mono">${bem4(a.debt)}</span> BEM</dd></div>
      <div><dt>${t('Operating fee', '运营费')}</dt><dd>${hasOps ? html`<span class="mono">${native(b.opsFee)}</span> OKB` : t('0 OKB (sponsored)', '0 OKB（由赞助方支付）')}</dd></div>
      <div><dt>${t('BEM fee rate · minimum', 'BEM 费率 · 最低费用')}</dt><dd>${pctBps(p.feeBps[b.term])} · ${bemAuto(p.minFee)} BEM</dd></div>
      <div><dt>${t('Late fee rate', '滞纳金费率')}</dt><dd>${t(`${pctBps(b.lateBps)} per day`, `每天 ${pctBps(b.lateBps)}`)}</dd></div>
      <div><dt>${t('Cost in BEM', 'BEM 成本')}</dt><dd>${a.value > 0n ? html`${t(`BEM fee ${pctOf(a.fee, a.value, 2)} of the advance, ≈ ${yearlyOf(a.fee, a.value, days)} a year`, `BEM 费用占借款金额 ${pctOf(a.fee, a.value, 2)}，折合每年约 ${yearlyOf(a.fee, a.value, days)}`)}` : '—'}<br>${feeNote}</dd></div>
      <div><dt>${t('Maturity', '到期时间')}</dt><dd class="mono">${fd(maturity, true)}</dd></div>
      ${reviewRow(b)}
    </dl>
    <div class="col g6"><div class="row-sb t12"><span class="mut">${t('Debt vs expected output', '债务占预期产出')}</span><span><span class="mono">${shown > 0n ? pctOf(a.debt, shown, 1) : '0.0%'}</span> <span class="mut">${t(`of max ${pctBps(p.maxDebtBps[b.term])}`, `上限 ${pctBps(p.maxDebtBps[b.term])}`)}</span></span></div>${bar(debtBarPct(a.debt, shown, p.maxDebtBps[b.term]))}</div>
    <p class="mut m0 t12"><b class="c-soft fw6">${t('How it is repaid: ', '还款方式：')}</b>${t(`the keeper harvests your rig as soon as its mined BEM, after the bridge fee, covers the debt (checked every 10 minutes), otherwise ${win(maturity - HOUR, maturity)}. The mined BEM pays the debt, fee first. Harvest earlier on tapeout.net to repay sooner (you pay the BNB gas).${reviewSentence(b)}`, `一旦矿机已挖出的 BEM（扣除跨链费后）足以还清债务，keeper 即为您的矿机领取收益（每 10 分钟检查一次），否则在 ${win(maturity - HOUR, maturity)} 领取。挖出的 BEM 先付费用、再还本金。也可以提前在 tapeout.net 领取以更早还款（由您支付 BNB gas）。${reviewSentence(b)}`)}</p>
    ${
      hasOps
        ? cl(
            'i',
            html`<b>${t(`About the ${native(b.opsFee)} OKB operating fee`, `关于 ${native(b.opsFee)} OKB 运营费`)}</b><ul class="ul-box"><li>${t("It goes to the operator's wallet, not to lenders or the pool.", '运营费进入运营方钱包，不进入资金池，也不归出借人。')}</li><li>${t('It is never refunded, also if you repay early. Pushing the data yourself does not lower it.', '运营费不退还，提前还款也不退；自行推送数据也不会减少运营费。')}</li><li>${t('If the borrow transaction fails, the OKB stays in your wallet.', '如果借款交易失败，OKB 会留在您的钱包中。')}</li>${okbLine}</ul>`,
          )
        : b.okbEnough
          ? EMPTY
          : cl('w', html`${t(`Your wallet holds ${native4(snap.wallet.okb)} OKB. Add at least ${native4(b.okbShort)} OKB on X Layer for gas.`, `您的钱包只有 ${native4(snap.wallet.okb)} OKB，请在 X Layer 上至少补充 ${native4(b.okbShort)} OKB，用于 gas。`)}`)
    }
    ${queuedNotice(c, b)}
    <details class="det"><summary>${t('Details', '详情')}</summary><dl class="kv">
      <div><dt>${t(`Expected base output, ${days} days`, `${days} 天预期基础产出`)}</dt><dd class="mono">${bem4(shown)} BEM</dd></div>
      <div><dt>${t('Pool room for you', '您的可借额度')} ${tip(t('The most the pool can lend you now, after the borrow cap, your per-borrower cap and idle BEM.', '扣除借款总额上限、单个借款人上限和闲置 BEM 限制后，资金池当前最多可借给您的金额。'))}</dt><dd class="mono">${bem4(snap.wallet.room)} BEM</dd></div>
      <div><dt>${t('Not harvested on BSC', 'BSC 上待领取')}</dt><dd class="mono">${b.mined.total === null ? '—' : html`${bem4(b.mined.total)} BEM`}</dd></div>
      <div><dt>${t('Credit rule input', '信用规则输入')}</dt><dd>${b.quote ? html`<span class="mono">${hexBits(b.quote.inputBits)}</span> <span class="mut">${t('at the max advance', '按最大借款金额')}</span>` : '—'}</dd></div>
      <div><dt>${t('Fee change queued', '待生效的费用变更')}</dt><dd>${queuedFees.length ? join(queuedFees.map((q) => html`<span class="nw">${queuedLabel(q.key)}: ${queuedValue(q)} · ${fd(q.eta, true)}</span>`), html`<br>`) : t('None', '无')}</dd></div>
    </dl></details></div></section>`;
}

function steps(c: Ctx, b: BorrowView): Html {
  const { ui, snap } = c;
  const n = b.ids.length;
  const ids = b.ids.map((i) => `#${i}`);
  const hasOps = b.opsFee > 0n;
  const li = (cls: string, num: number, title: Html | string, desc: Html | string, body: Html): Html =>
    html`<li class="${cls}"><span class="n">${cls.includes('done') ? '✓' : num}</span><div><div class="tt">${title}</div><div class="dd">${desc}</div>${body === EMPTY ? EMPTY : html`<div class="stp-b">${body}</div>`}</div></li>`;

  // 1. the agent
  const ag = b.agent;
  const agentAddr = ag ? shortAddr(ag.address) : '';
  const waiting = ag && b.reused && ag.bem > 0n ? ` ${t(`Its ${bem4(ag.bem)} BEM waiting is sent to you when you borrow.`, `其中待领取的 ${bem4(ag.bem)} BEM 会在借款时转给您。`)}` : '';
  const st1 = li(
    b.agentDone ? 'done' : '',
    1,
    t('Create a Rig Agent', '创建矿机代理'),
    b.agentDone
      ? b.reused
        ? `${t(`Using your empty agent ${agentAddr}.`, `使用您空闲的代理 ${agentAddr}。`)}${waiting}`
        : t(`Agent ${agentAddr} created.`, `已创建代理 ${agentAddr}。`)
      : t('Your own contract. It holds the voucher while the loan is open and gives it back when the debt is 0. 1 transaction.', '您专属的合约：贷款期间持有凭证，债务清零后归还。1 笔交易。'),
    b.agentDone
      ? b.moved || ui.agent === null
        ? EMPTY
        : actLink(c, { a: 'undoagent' }, t('Change', '更改'))
      : html`${act(c, { a: 'create', needs: ['wallet'] }, t('Create agent', '创建代理'))}${b.reusable ? actLink(c, { a: 'reuse', v: b.reusable.address }, t(`Use my empty agent ${shortAddr(b.reusable.address)} instead`, `改用我空闲的代理 ${shortAddr(b.reusable.address)}`)) : EMPTY}`,
  );

  // 2. move the vouchers
  const todo = b.agent ? b.ids.filter((i) => !(b.agent?.collateral.includes(i) ?? false)).length : n;
  const st2 = li(
    b.moved ? 'done' : b.agentDone ? '' : 'lock',
    2,
    t(`Move ${ids.join(' and ')} into the agent`, `把 ${ids.join('、')} 转入矿机代理`),
    b.moved
      ? t(`Voucher${n > 1 ? 's' : ''} in the agent. You can take ${n > 1 ? 'them' : 'it'} back any time before you borrow.`, '凭证已在代理中，借款前可随时取回。')
      : t(`${todo} transaction${todo > 1 ? 's' : ''}, one per rig. You can take it back any time before you borrow.`, `${todo} 笔交易，每台矿机 1 笔。借款前可随时取回。`),
    b.moved ? EMPTY : step2Body(c, b, t(todo > 1 ? `Move ${todo} vouchers` : 'Move voucher', todo > 1 ? `转入 ${todo} 张凭证` : '转入凭证')),
  );

  // 3. refresh the rig data
  let d3: Html | string = t('The credit rule needs a report from BSC that is less than 5 minutes old. The keeper sends it for you: no transaction, no BNB.', '信用规则需要 5 分钟内的 BSC 数据报告。keeper 会替您推送：无需交易，无需 BNB。');
  const bnb = snap.keeper.selfPushBnb;
  const selfLabel =
    bnb === null ? t('Keeper busy? Push it yourself on BSC', 'keeper 繁忙？自行在 BSC 上推送') : t(`Keeper busy? Push it yourself on BSC (≈ ${native(bnb, 4, 4)} BNB)`, `keeper 繁忙？自行在 BSC 上推送（约 ${native(bnb, 4, 4)} BNB）`);
  // after a keeper refusal or a timeout the link becomes a button
  const selfPush = ui.selfPush ? act(c, { a: 'selfpush', kind: 's', size: 'sm', needs: ['wallet'] }, selfLabel) : actLink(c, { a: 'selfpush', needs: ['wallet'] }, selfLabel);
  let b3: Html = EMPTY;
  if (!b.poolOpen) b3 = html`<span class="why">${t('Waiting: new borrows are not open right now (see above).', '等待中：当前不开放新借款（见上方说明）。')}</span>`;
  else if (b.settling) b3 = html`<span class="why">${errorText({ kind: 'revert', name: 'FeedSettling' })}</span>`;
  else if (b.report === 'waiting') b3 = html`<span><span class="spin" aria-hidden="true"></span> ${t('Waiting for the report from BSC · usually 30–40 s', '正在等待 BSC 数据报告 · 通常需要 30–40 秒')}</span>`;
  else if (b.report === 'fresh') b3 = html`<span class="ok">${t('Report fresh', '数据已更新')}</span><span>${t('Borrow within', '请在')} <span class="cd${b.secondsLeft < 60 ? ' low' : ''}">${mmss(b.secondsLeft)}</span>${t('', ' 内完成借款')}</span>`;
  else {
    if (b.report === 'expired') d3 = html`<span class="c-warn">${t('The report is older than 5 minutes, so the credit rule will not use it. Refresh again.', '数据报告已超过 5 分钟，信用规则不会使用。请重新刷新。')}</span>`;
    // the cost of the self-push, and that it leaves the OKB fee as it is (SPEC-PHASE5-APP §6.4 step 1)
    const selfNote = ui.selfPush
      ? html`<span class="mut t12">${
          bnb === null
            ? t('Pushing it yourself costs BNB on BNB Smart Chain, paid from your wallet. It does not lower the OKB fee.', '自行推送需要在 BNB Smart Chain 上用您钱包中的 BNB 支付，不会减少 OKB 运营费。')
            : t(`Pushing it yourself costs about ${native(bnb, 4, 4)} BNB on BNB Smart Chain, paid from your wallet (a little extra is refunded). It does not lower the OKB fee.`, `自行推送约需 ${native(bnb, 4, 4)} BNB，在 BNB Smart Chain 上由您的钱包支付（多付的部分会退回），不会减少 OKB 运营费。`)
        }</span>`
      : EMPTY;
    b3 = html`${b.moved ? step3Body(c, b) : EMPTY}${act(c, { a: 'refresh', needs: ['rigs', 'wallet'] }, t(b.report === 'expired' ? 'Refresh again' : 'Refresh rig data', b.report === 'expired' ? '重新刷新' : '刷新矿机数据'))}${selfPush}${selfNote}`;
  }
  const st3 = li(b.report === 'fresh' ? 'done' : b.moved ? '' : 'lock', 3, t('Refresh rig data', '刷新矿机数据'), d3, b3);

  // 4. borrow
  const fresh = b.report === 'fresh';
  const borrowBtn = b.canBorrow
    ? act(c, { a: 'borrow', size: 'lg', block: true, needs: ['pool', 'rigs', 'wallet'] }, t('Borrow', '借款'))
    : c.readOnly === 'frame'
      ? EMPTY
      : html`<button type="button" class="btn btn-x btn-lg w100" disabled>${t('Borrow', '借款')}</button>`;
  const st4 = li(
    fresh ? '' : 'lock',
    4,
    t(`Borrow ${bem4(b.amount.value)} BEM for ${snap.pool.params.termDays[b.term]} days`, `借款 ${bem4(b.amount.value)} BEM，期限 ${snap.pool.params.termDays[b.term]} 天`),
    hasOps ? t(`1 transaction. It sends exactly ${native(b.opsFee)} OKB with it.`, `1 笔交易，同时支付 ${native(b.opsFee)} OKB 运营费。`) : t('1 transaction.', '1 笔交易。'),
    html`${borrowBtn}${b.blockers.length ? html`<span class="why">${b.blockers.join(' ')}</span>` : EMPTY}`,
  );

  return html`<section class="v2-card" aria-labelledby="a3"><div class="v2-card-h"><h2 id="a3"><span class="uid" aria-hidden="true">3</span>${t('Steps', '操作步骤')}</h2><span class="meta">${b.mined.bscTx ? t(`${b.txLeft} transaction${b.txLeft > 1 ? 's' : ''} on X Layer · 1 on BSC`, `X Layer 上需 ${b.txLeft} 笔交易 · BSC 上需 1 笔`) : t(`${b.txLeft} transaction${b.txLeft > 1 ? 's' : ''} on X Layer · none on BSC`, `X Layer 上还需 ${b.txLeft} 笔交易 · BSC 上无需交易`)}</span></div><div class="v2-card-b"><ol class="stp">${st1}${st2}${st3}${st4}</ol></div><div class="v2-card-f">${t('You can also repay with BEM at any time; the flat fee stays the same.', '您也可以随时用 BEM 还款，固定费用不变。')}</div></section>`;
}

/** The two-column borrow screen: the left card (the rig, or the picker), the amount, the summary and the steps. */
export function flow(c: Ctx, left: Html): Html {
  const b = c.borrow;
  if (!b) {
    return html`<div class="bw"><div class="v2-stack">${left}</div><div class="v2-stack"><section class="v2-card" aria-labelledby="q1"><div class="v2-card-h"><h2 id="q1"><span class="uid" aria-hidden="true">Q</span>${t('Your borrow', '借款摘要')}</h2></div><div class="empty">${t('Choose a ready rig to see your advance and its full cost.', '选择一台可借的矿机，查看可借金额和全部成本。')}</div></section></div></div>`;
  }
  // a lens answer of "no" still shows the steps, so the reason can be read next to the Borrow button
  const ok = b.source === 'quote' || b.limits.some((l) => l.maxPrincipal >= c.snap.pool.params.minAdvance);
  return html`<div class="bw"><div class="v2-stack">${left}${amtCard(c, b)}</div><div class="v2-stack">${summary(c, b)}${ok ? steps(c, b) : EMPTY}</div></div>`;
}

export function assetSeg(): Html {
  return html`<div class="seg" role="radiogroup" aria-label="${t('Borrow asset', '借款资产')}"><button type="button" role="radio" aria-checked="true" aria-pressed="true">${img('bem')}BEM <span class="mut fw4 t12">${t('TapeOut rigs', 'TapeOut 矿机')}</span></button><button type="button" role="radio" aria-checked="false" aria-disabled="true" title="${soonTip()}">${img('fabx', 'i-dim5')}FAB <span class="mut fw4 t12">${t('FabX rigs', 'FabX 矿机')}</span> ${soon()}</button></div>`;
}

