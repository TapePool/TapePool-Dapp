import { errorText } from '../chain/errors';
import { TAPEOUT_URL } from '../config';
import { BOND } from '../constants';
import { bem4, native } from '../logic/format';
import { EMPTY, html, type Html } from '../html';
import { t } from '../i18n';
import type { BorrowView } from '../logic/borrow';
import type { HarvestOff, Step2, Step3 } from '../logic/harvest';
import { act, actLink, cl, type Ctx } from './ui';

/**
 * What the borrow screen says about BEM a rig mined before the loan (SPEC-PHASE5-PRELOAN §4, §6, §7): the choice at step 2, the
 * state of a harvest that is on its way, the question about rigs that are already in the agent at step 3, and the review. The
 * copy is the table of §7. The numbers (`x`, `s`) are landed BEM and its share of the debt on screen, from `logic/harvest.ts`.
 */

const spinner = (): Html => html`<span class="spin" aria-hidden="true"></span>`;

const harvestLink = (label: string): Html => html`<a class="lnk" href="${TAPEOUT_URL}" target="_blank" rel="noopener noreferrer">${label}</a>`;

/** "x BEM mined and not harvested (≈ s of the debt) goes to this loan unless you harvest it first." */
const infoLine = (x: bigint, s: string): string =>
  t(`${bem4(x)} BEM mined and not harvested (≈ ${s} of the debt) goes to this loan unless you harvest it first.`, `${bem4(x)} BEM 已挖出但未领取（约占债务的 ${s}），除非先领取，否则将计入本笔贷款。`);

/** The same, when it is too little to harvest from here. */
const tinyLine = (x: bigint, s: string): string =>
  t(`${bem4(x)} BEM mined and not harvested (≈ ${s} of the debt) goes to this loan. It is too little to harvest from here.`, `${bem4(x)} BEM 已挖出但未领取（约占债务的 ${s}），将计入本笔贷款。数额太小，无法在此领取。`);

const coversWarning = (): string =>
  t(
    'It covers the whole debt: while the keeper runs, it usually repays this loan within 10–15 minutes of borrowing, so the fees buy credit that lasts minutes.',
    '这部分已足以还清全部债务：keeper 正常运行时，通常在借款后 10–15 分钟内完成还款，相当于为仅持续几分钟的贷款支付全部费用。',
  );

const keepLabel = (): string => t('Keep it in this loan', '保留在本笔贷款中');

/** Why "Harvest it to my wallet first" is off. */
function offReason(off: HarvestOff, value: bigint | null): string {
  return errorText({ kind: 'harvest', why: off, params: { bnb: value === null ? undefined : native(value, 4, 6) } });
}

/** The cost line of the harvest option: about `v` BNB, the message fee plus 10% and gas. */
function costLine(value: bigint): string {
  const v = native(value, 4, 6);
  return t(
    `About ${v} BNB on BSC: the bridge message fee plus 10% (the extra 10% comes back) and gas. The OKB operating fee does not cover it. The BEM usually reaches your wallet on X Layer in about a minute, less the bridge fee.`,
    `在 BSC 上约需 ${v} BNB：跨链消息费加 10%（多付的 10% 会退还）以及 gas。OKB 运营费不涵盖这笔费用。BEM 通常约一分钟后到达您在 X Layer 上的钱包（扣除跨链费）。`,
  );
}

/** The "Harvest it to my wallet first" control, with its cost, or the reason it is off, and the way to harvest on tapeout.net. */
function harvestOption(c: Ctx, s2: Step2): Html {
  const { option } = s2;
  const off = option.off !== null;
  const button = act(c, { a: 'harvest-first', kind: 's', block: true, needs: ['rigs', 'wallet'], disabled: off }, t('Harvest it to my wallet first', '先领取到我的钱包'));
  const detail = option.off === null && option.value !== null ? html`<span class="mut t12">${costLine(option.value)}</span>` : off ? html`<span class="why">${offReason(option.off as HarvestOff, option.value)}</span>` : EMPTY;
  return html`${button}${detail}${harvestLink(t('or harvest on tapeout.net', '或前往 tapeout.net 领取'))}`;
}

/** "Could not read the BEM mined on BSC for #ids." */
const unreadableLine = (ids: readonly number[]): string => errorText({ kind: 'harvest', why: 'mined-unreadable', params: { ids: ids.map((i) => `#${i}`).join(', ') } });

/** What the step says while the harvest of one of its rigs is on its way. */
function waitLine(s2: Step2): Html {
  switch (s2.wait) {
    case 'prompting':
      return html`<p>${spinner()} ${t('Confirm the harvest in your wallet…', '请在钱包中确认领取…')}</p>`;
    case 'in-flight':
      return html`<p>${spinner()} ${errorText({ kind: 'harvest', why: 'busy' })}</p>`;
    case 'settle':
      return html`<p>${spinner()} ${t('Waiting for the harvest to settle on BSC…', '正在等待 BSC 上的领取交易最终确认…')}</p>`;
    default:
      return EMPTY;
  }
}

/** A harvest that has not settled for ten minutes: wait on, or move anyway and let it repay the loan. */
function stuckOffer(c: Ctx): Html {
  return html`<p class="why">${t('The harvest has had no receipt for 10 minutes.', '领取交易已 10 分钟未确认。')}</p>
    ${actLink(c, { a: 'hold', needs: ['rigs'] }, t('Keep waiting', '继续等待'))}
    ${act(c, { a: 'move-stuck', kind: 's', block: true, needs: ['rigs', 'wallet'] }, t('Move anyway: the pending harvest may then repay this loan', '仍然转入：待确认的领取可能会用于偿还本笔贷款'))}`;
}

/** The required choice (§4.2): two options, nothing preselected. */
function choice(c: Ctx, s2: Step2): Html {
  const keep = act(c, { a: 'keep', kind: s2.keep ? 'p' : 's', block: true, needs: ['rigs', 'wallet'] }, keepLabel());
  return html`<p><b>${t(`${bem4(s2.amount)} BEM is mined and not harvested yet (≈ ${s2.share} of the debt)`, `已挖出、尚未领取的 BEM：${bem4(s2.amount)}（约占债务的 ${s2.share}）`)}</b></p>
    <div class="mopts"><div class="mopt">${harvestOption(c, s2)}</div>
    <div class="mopt">${keep}<span class="mut t12">${t(
      `${bem4(s2.amount)} BEM (≈ ${s2.share} of the debt) repays this loan first once the voucher is in the agent. The flat BEM fee stays owed in full, and the OKB operating fee is not refunded.`,
      `凭证转入矿机代理后，这 ${bem4(s2.amount)} BEM（约占债务的 ${s2.share}）将优先用于还款。固定 BEM 费用仍需全额支付，OKB 运营费不予退还。`,
    )}</span>${s2.covers ? cl('w', coversWarning()) : EMPTY}</div></div>`;
}

/** The body of step 2 ("Move voucher"): what to say about the mined BEM, and the buttons that move the vouchers. */
export function step2Body(c: Ctx, b: BorrowView, moveLabel: string): Html {
  const s2 = b.mined.step2;
  const waiting = waitLine(s2);
  const stuck = s2.stuck ? stuckOffer(c) : EMPTY;
  const move = act(c, { a: 'move', needs: ['rigs', 'wallet'], disabled: !s2.canMove }, moveLabel);
  // the choice is made once the app's own harvest is on its way: the screen shows where it stands, and nothing else to choose
  let note: Html = EMPTY;
  if (!s2.busy) {
    if (s2.kind === 'choice') note = choice(c, s2);
    else if (s2.kind === 'info') note = html`<p class="mut">${infoLine(s2.amount, s2.share)}</p>${harvestOption(c, s2)}`;
    else if (s2.kind === 'tiny') note = html`<p class="mut">${tinyLine(s2.amount, s2.share)}</p>`;
  }
  if (s2.kind === 'unreadable') {
    return html`<div class="mined">${waiting}${stuck}<p class="why">${unreadableLine(s2.unreadable)}</p></div>
      ${act(c, { a: 'retry', kind: 's' }, t('Retry', '重试'))}
      ${act(c, { a: 'move-anyway', kind: 's', needs: ['rigs', 'wallet'], disabled: !s2.gateOpen }, t('Move anyway (keep any mined BEM in this loan)', '仍然转入（已挖出的 BEM 计入本笔贷款）'))}`;
  }
  const lines = note === EMPTY && waiting === EMPTY && stuck === EMPTY ? EMPTY : html`<div class="mined">${waiting}${stuck}${note}</div>`;
  return html`${lines}${move}`;
}

/** The question about rigs that are already in the agent (§4.7), shown at step 3. */
export function step3Body(c: Ctx, b: BorrowView): Html {
  const s3: Step3 = b.mined.step3;
  switch (s3.kind) {
    case 'ask':
      return html`<div class="mined"><p>${t(
        `${bem4(s3.amount)} BEM mined before this loan (≈ ${s3.share} of the debt) will repay it first. To keep it, take the voucher back, harvest, and move it again.`,
        `借款前已挖出的 ${bem4(s3.amount)} BEM（约占债务的 ${s3.share}）将优先用于还款。如需保留，请先取回凭证、领取收益，再重新转入。`,
      )}</p>${s3.covers ? cl('w', coversWarning()) : EMPTY}</div>
        ${act(c, { a: 'take-back-harvest', kind: 's', needs: ['rigs', 'wallet'] }, t('Take back to harvest first', '取回凭证，先领取'))}
        ${act(c, { a: 'keep-agent', kind: 's', needs: ['rigs', 'wallet'] }, keepLabel())}`;
    case 'unreadable':
      return html`<div class="mined"><p class="why">${unreadableLine(s3.ids)}</p></div>
        ${act(c, { a: 'retry', kind: 's' }, t('Retry', '重试'))}
        ${act(c, { a: 'keep-agent', kind: 's', needs: ['rigs', 'wallet'] }, keepLabel())}`;
    case 'info':
      return html`<div class="mined"><p class="mut">${infoLine(s3.amount, s3.share)}</p></div>`;
    case 'tiny':
      return html`<div class="mined"><p class="mut">${tinyLine(s3.amount, s3.share)}</p></div>`;
    default:
      return EMPTY;
  }
}

/** The review row "Mined before this loan" (§6): what the agent's rigs hold, as a share of the debt. */
export function reviewRow(b: BorrowView): Html {
  const k = b.mined.kept;
  if (k.collectable === 0n) return EMPTY;
  return html`<div><dt>${t('Mined before this loan', '借款前已挖出')}</dt><dd><span class="mono">${bem4(k.amount)}</span> BEM <span class="mut">· ≈ ${k.share}</span>${k.covers ? html`<br><span class="why">${coversWarning()}</span>` : EMPTY}</dd></div>`;
}

/** "The x BEM mined before the loan goes first." for "How it is repaid", when it is at least the bond (§6). */
export function reviewSentence(b: BorrowView): string {
  const k = b.mined.kept;
  if (k.collectable < BOND) return '';
  return ` ${t(`The ${bem4(k.amount)} BEM mined before the loan goes first.`, `借款前已挖出的 ${bem4(k.amount)} BEM 将优先用于还款。`)}`;
}
