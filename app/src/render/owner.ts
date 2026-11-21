import { EMPTY, html, join, type Html } from '../html';
import { t } from '../i18n';
import { fd, shortAddr } from '../logic/format';
import { canSign, delayParts } from '../logic/screen';
import type { ScreenRecord } from '../model';
import { failReason } from './register';
import { act, chip, cl, type Ctx } from './ui';

/**
 * The owner's screen passes (SPEC-PHASE5-REGISTER §8): `#/app/owner`, linked from the keeper's Telegram message. Anyone can
 * read it; Sign is drawn only for the pool owner's wallet, and the page never hides that `recordPass` is owner-only.
 */

function statusChip(r: ScreenRecord): Html {
  switch (r.status) {
    case 'pass':
      return chip('ok', 'PASS');
    case 'fail':
      return chip('bad', 'FAIL');
    case 'error':
      return chip('w', t('Did not finish', '未完成'));
    case 'recorded':
      return chip('a', t('Recorded', '已记录'));
    case 'revoked':
      return chip('n', t('Revoked', '已撤销'));
    default:
      return chip('a', t('Checking', '检查中'));
  }
}

function codeLine(r: ScreenRecord): string {
  if (r.status === 'fail') return failReason(r.code);
  switch (r.code) {
    case 'transient':
      return t('The endpoints did not answer.', '数据源未响应。');
    case 'verify':
      return t('The second provider did not reproduce it.', '第二数据源未能复现结果。');
    default:
      return t('The check could not decide.', '检查无法得出结论。');
  }
}

/** What signing starts: the delay as `RigScreen.DELAY()` reads it. */
function signNote(c: Ctx): string {
  const d = delayParts(c.snap.screenDelay);
  if (!d) return t("The pass counts after RigScreen's waiting period. The artifact stays public so anyone can check it first.", '签名后需经过 RigScreen 的等待期才生效。筛查报告保持公开，任何人都可以先行核验。');
  const n = 'h' in d ? d.h : d.min;
  if (n === 0) return t('The pass counts as soon as you sign.', '签名后立即生效。');
  const span = 'h' in d ? t(`${n} h`, `${n} 小时`) : t(`${n} min`, `${n} 分钟`);
  return t(`The pass counts ${span} after you sign. The artifact stays public so anyone can check it first.`, `签名 ${span}后生效。筛查报告保持公开，任何人都可以先行核验。`);
}

function chainLine(c: Ctx, r: ScreenRecord): string {
  const ch = c.snap.ownerScreens?.chain[String(r.rigId)];
  if (!ch) return '—';
  if (ch.suspended) return t('Suspended', '已暂停');
  if (!ch.pass) return t('No pass', '无记录');
  return t(`Recorded, counts from ${fd(ch.pass.effectiveAt, true)}`, `已记录，${fd(ch.pass.effectiveAt, true)} 起生效`);
}

function rowCard(c: Ctx, r: ScreenRecord): Html {
  const a = r.artifact;
  const base = c.snap.ownerScreens?.keeperUrl ?? null;
  const download = a && base ? html` <a class="lnk" href="${base}/v1/screens/${r.rigId}/artifact" target="_blank" rel="noopener noreferrer">${t('Download', '下载')}</a>` : EMPTY;
  const kv = html`<dl class="kv m0">
    <div><dt>${t('Task', '任务')}</dt><dd class="mono">${a?.taskId?.toString() ?? '—'}</dd></div>
    <div><dt>${t('Processor', '处理器')}</dt><dd class="mono">${a?.circuits ? shortAddr(a.circuits) : '—'}</dd></div>
    <div><dt>${t('Circuit id', '电路 ID')}</dt><dd class="mono">${a?.circuitId?.toString() ?? '—'}</dd></div>
    <div><dt>${t('Artifact', '筛查报告')}</dt><dd><span class="mono">${a ? `${a.hash.slice(0, 10)}…` : '—'}</span>${download}</dd></div>
    <div><dt>${t('Checked at BSC block', '检查时的 BSC 区块')}</dt><dd class="mono">${a?.bscBlock?.toString() ?? '—'}</dd></div>
    <div><dt>${t('Checked', '检查时间')}</dt><dd>${a ? fd(r.updatedAt, true) : '—'}</dd></div>
    <div><dt>${t('Second provider', '第二数据源')}</dt><dd>${a ? (a.verified ? t('Reproduced', '已复现') : t('Not reproduced', '未复现')) : '—'}</dd></div>
    <div><dt>${t('Providers', '数据源')}</dt><dd class="mono">${r.hosts ? `BSC ${r.hosts.checkBsc} → ${r.hosts.verifyBsc ?? '—'} · X Layer ${r.hosts.checkXlayer} → ${r.hosts.verifyXlayer ?? '—'}` : '—'}</dd></div>
    <div><dt>${t('On-chain', '链上状态')}</dt><dd>${chainLine(c, r)}</dd></div>
  </dl>`;
  const problem = r.status === 'fail' || r.status === 'error'
    ? html`<p class="mut t12 m0">${codeLine(r)}</p>${r.reasons.length ? html`<details><summary class="t12">${t('Details', '详情')}</summary><ul class="t12">${join(r.reasons.map((x) => html`<li>${x}</li>`))}</ul></details>` : EMPTY}`
    : EMPTY;
  const sign = canSign(c.snap, r) ? html`<div class="rcard-f">${act(c, { a: 'record-pass', v: r.rigId }, t('Sign', '签名'))}</div>` : EMPTY;
  return html`<article class="rcard"><div class="rcard-h"><b class="mono">#${r.rigId}</b>${statusChip(r)}</div><div class="rcard-b">${kv}${problem}</div>${sign}</article>`;
}

const waiting = (c: Ctx, r: ScreenRecord): boolean => r.status === 'pass' && c.snap.ownerScreens?.chain[String(r.rigId)]?.pass == null;

export function ownerPage(c: Ctx): Html {
  const s = c.snap.screens;
  const o = c.snap.ownerScreens;
  const me = c.snap.wallet.account;
  const owner = o?.owner ?? null;
  const ownerShort = owner ? shortAddr(owner) : '—';
  const isOwner = owner !== null && me !== null && owner.toLowerCase() === me.toLowerCase();
  const who = c.snap.wallet.status === 'disconnected' || me === null
    ? t('Connect the owner wallet to sign.', '请连接所有者钱包后签名。')
    : isOwner
      ? t('Your wallet is the pool owner.', '您的钱包是资金池所有者。')
      : t('Your wallet is not the pool owner, so it cannot sign.', '您的钱包不是资金池所有者，无法签名。');
  const notice = cl('i', html`<b>${t(`Recording a screen pass is owner-only: RigScreen.recordPass can only be sent by the pool owner's wallet (${ownerShort}).`, `记录筛查通过结果仅限所有者操作：只有资金池所有者的钱包（${ownerShort}）才能调用 RigScreen.recordPass。`)}</b> ${who} ${signNote(c)}`);
  const records = s ? Object.values(s.records).sort((a, b) => a.rigId - b.rigId) : [];
  const first = records.filter((r) => waiting(c, r));
  const rest = records.filter((r) => !waiting(c, r) && r.status !== 'queued' && r.status !== 'checking');
  const warn = html`${s === null || s === undefined ? cl('n', t("The keeper's list could not be read. Try again later.", 'keeper 的列表暂时无法读取，请稍后重试。')) : EMPTY}${s?.paused ? cl('w', t('Checks are paused while a change on TapeOut is reviewed. Signing waits too.', '团队正在审查 TapeOut 的一项变更，检查已暂停，签名也需等待。')) : EMPTY}${o?.registryOk === false ? cl('bad', t('The app does not recognise this contract. Do not continue; check the official links.', '应用无法识别此合约，请勿继续，并请核对官方链接。')) : EMPTY}`;
  return html`<div class="v2-title"><div><h1>${t('Screen passes', '筛查通过记录')}</h1><p>${t('Rigs the keeper screened after their miners registered them. A PASS waits here for the owner to record it on-chain.', '矿工提交申请后由 keeper 完成筛查的矿机。筛查通过的结果在此等待所有者记录上链。')}</p></div></div>
    ${notice}${warn}
    <section class="v2-card"><div class="v2-card-h"><h2>${t('Waiting for a signature', '等待签名')}</h2></div><div class="v2-card-b">${first.length ? html`<div class="rgrid">${join(first.map((r) => rowCard(c, r)))}</div>` : html`<p class="mut m0">${t('Nothing to sign.', '暂无需要签名的记录。')}</p>`}</div></section>
    ${rest.length ? html`<section class="v2-card"><div class="v2-card-h"><h2>${t('Other results', '其他结果')}</h2></div><div class="v2-card-b"><div class="rgrid">${join(rest.map((r) => rowCard(c, r)))}</div></div></section>` : EMPTY}`;
}
