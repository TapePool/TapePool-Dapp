import { TWITTER_URL } from '../config';
import { EMPTY, html, type Html } from '../html';
import { t } from '../i18n';
import { fd } from '../logic/format';
import { delayParts, hhmm, registerLine, type RegisterLine } from '../logic/screen';
import type { RigView, ScreenFailCode } from '../model';
import { act, chip, type CalloutKind, type Ctx } from './ui';

/**
 * "Register to borrow" on the miner's side (SPEC-PHASE5-REGISTER §5, §7, §9): the state line of a rig at §5.2 row 10, 12 (no
 * pass) or 13, its chip and its one button. The delay is named only as `RigScreen.DELAY()` reads it; the countdown comes from
 * the pass on chain and the rig-age rule, never from that delay.
 */

export const lineOf = (c: Ctx, r: RigView): RegisterLine | null => registerLine(r, c.snap.screens, c.now);

/** "48 h", "90 min"; null when the delay is unread or 0 (the sentences then say so without a number). */
function delayText(c: Ctx): string | null {
  const d = delayParts(c.snap.screenDelay);
  if (!d) return null;
  if ('h' in d) return d.h === 0 ? null : t(`${d.h} h`, `${d.h} 小时`);
  return d.min === 0 ? null : t(`${d.min} min`, `${d.min} 分钟`);
}

const zeroDelay = (c: Ctx): boolean => c.snap.screenDelay === 0;

/** The closing words of "a pass counts … after it is recorded", from the chain's own delay. */
export function countsLine(c: Ctx): string {
  const d = delayText(c);
  if (zeroDelay(c)) return t('a pass counts as soon as it is recorded on-chain', '筛查结果记录上链后立即生效');
  return d
    ? t(`a pass counts ${d} after it is recorded on-chain`, `筛查结果记录上链 ${d}后生效`)
    : t('a pass counts after a public waiting period once it is recorded on-chain', '筛查结果记录上链并经过公开等待期后生效');
}

/** S2, the fallback when the keeper cannot take registrations: the note of SPEC-PHASE5-APP §12 option C, without a fixed number. */
export const screenNote = (c: Ctx): string =>
  t(
    `Every rig needs a screen pass before it can borrow. The TapePool team screens new rigs; ${countsLine(c)}.`,
    `每台矿机借款前都需要通过筛查。TapePool 团队会为新矿机做筛查；${countsLine(c)}。`,
  );

/** The plain words of a FAIL code (§9). Unknown codes never reach here: the keeper client drops them. */
export function failReason(code: string | null): string {
  switch (code as ScreenFailCode | null) {
    case 'no-voucher':
      return t('the voucher has no rig on X Layer', '这张凭证在 X Layer 上没有对应的矿机');
    case 'voucher-mismatch':
      return t('the voucher does not match its rig on BSC', '凭证与其在 BSC 上的矿机不匹配');
    case 'processor':
      return t('its processor is not supported', '不支持该矿机的处理器');
    case 'not-mining':
      return t('it is not mining on BSC', '这台矿机在 BSC 上没有在挖矿');
    case 'task':
      return t('its task cannot be checked', '无法检查该矿机的任务');
    case 'circuit':
      return t('its circuit does not fit its task', '该矿机的电路与其任务不符');
    case 'wrong-output':
      return t('it gives a wrong answer on an official test vector, so it can be revoked', '它在一个官方测试向量上输出错误，可能被撤销');
    case 'differs':
      return t("it differs from its task's reference circuit", '它与任务的参考电路不一致');
    case 'counterexample':
      return t('it fails a registered counterexample', '它未通过一个已登记的反例');
    case 'too-wide':
      return t('it is too large to check completely', '它的规模过大，无法完整检查');
    default:
      return t('the screen found a problem with it', '筛查发现了问题');
  }
}

/** The sentence of one state. */
export function lineText(c: Ctx, line: RegisterLine): string {
  const d = delayText(c);
  switch (line.kind) {
    case 'recorded':
      return t(`Recorded on-chain. Borrowable in ${hhmm(line.at - c.now)} (from ${fd(line.at, true)}).`, `已记录上链，${hhmm(line.at - c.now)} 后可借（${fd(line.at, true)} 起）。`);
    case 'closed':
      return screenNote(c);
    case 'register':
      return t(
        'Every rig needs a screen pass before it can borrow. Register this rig and the keeper checks it automatically. Nothing to sign, nothing to pay.',
        '每台矿机借款前都需要通过筛查。提交申请后，keeper 会自动检查这台矿机，您无需签名，也无需付费。',
      );
    case 'queued':
      return line.paused
        ? t('Registered. Checks are paused while the team reviews a change on TapeOut. Your rig keeps its place.', '已提交申请。团队正在审查 TapeOut 的一项变更，检查暂停，您的矿机保留排队位置。')
        : t('Registered. The check starts shortly.', '已提交申请，检查即将开始。');
    case 'checking':
      return t('Checking the rig. This usually takes a few minutes.', '正在检查矿机，通常需要几分钟。');
    case 'passed':
      if (zeroDelay(c)) return t('The rig passed the screen. The TapePool team records it on-chain next. It can borrow right after that.', '矿机已通过筛查，接下来由 TapePool 团队将结果记录上链，记录后即可借款。');
      return d
        ? t(`The rig passed the screen. The TapePool team records it on-chain next. It can borrow ${d} after that.`, `矿机已通过筛查，接下来由 TapePool 团队将结果记录上链，记录 ${d}后即可借款。`)
        : t('The rig passed the screen. The TapePool team records it on-chain next. It can borrow after a public waiting period.', '矿机已通过筛查，接下来由 TapePool 团队将结果记录上链，经过公开等待期后即可借款。');
    case 'fail':
      return t(`This rig cannot borrow: ${failReason(line.record.code)}.`, `这台矿机无法借款：${failReason(line.record.code)}。`);
    case 'revoked':
      return t("The TapePool team removed this rig's screen pass, so it cannot borrow.", 'TapePool 团队已撤销这台矿机的筛查通过记录，因此无法借款。');
    case 'error':
      return t(`The check could not finish. The team has been told. You can try again from ${fd(line.retryAt, true)}.`, `检查未能完成，已通知团队。您可在 ${fd(line.retryAt, true)} 之后重新检查。`);
    case 'retry':
      return t('The check could not finish. You can try again now.', '检查未能完成，您现在可以重新检查。');
  }
}

/** The chip of a rig at row 12 with no pass; rows 10 and 13 keep their own chips. */
export function lineChip(line: RegisterLine): Html | null {
  switch (line.kind) {
    case 'queued':
    case 'checking':
      return chip('a', t('Checking', '检查中'));
    case 'passed':
      return chip('w', t('Waiting for the team', '等待团队记录'));
    case 'fail':
    case 'revoked':
      return chip('bad', t('Cannot borrow', '无法借款'));
    case 'error':
    case 'retry':
      return chip('w', t('Check did not finish', '检查未完成'));
    default:
      return null;
  }
}

/** The callout look of a state on the rig page. */
export const lineKind = (line: RegisterLine): CalloutKind => (line.kind === 'fail' || line.kind === 'revoked' ? 'bad' : line.kind === 'checking' || line.kind === 'queued' ? 'i' : 'w');

/** The one button of a state: Register (S3), Try again (S10), or the TapePool link of the fallback (S2). */
export function lineAction(c: Ctx, r: RigView, line: RegisterLine, size: 'sm' | undefined = 'sm'): Html {
  if (line.kind === 'register') return act(c, { a: 'screen-register', v: r.id, size, needs: ['rigs'] }, t('Register to borrow', '申请借款资格'));
  if (line.kind === 'retry') return act(c, { a: 'screen-register', v: r.id, kind: 's', size, needs: ['rigs'] }, t('Try again', '重新检查'));
  if (line.kind === 'closed') return html`<a class="btn btn-s btn-sm" href="${TWITTER_URL}" target="_blank" rel="noopener noreferrer">${t('TapePool on X', 'X 上的 TapePool')}</a>`;
  return EMPTY;
}
