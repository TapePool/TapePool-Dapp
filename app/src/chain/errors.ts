import { MAX_COLLATERAL } from '../constants';
import { getLang, t } from '../i18n';
import { firstFailedFlag, type FlagName } from '../logic/inputBits';

/**
 * Every message of SPEC-PHASE5-APP §9: one English line and one Chinese line each.
 * B1 holds the table; B2 and B4 decode reverts and keeper answers into these keys.
 */

export interface MsgParams {
  binding?: number;
  minAdvance?: string; // BEM, formatted
  eta?: string; // formatted date and time
  expectedFee?: string; // OKB, formatted
  id?: number;
  terms?: readonly [number, number];
  inputBits?: number;
  bnb?: string; // BNB, formatted
  ids?: string; // rig ids, formatted ("#12, #14")
}

interface Row {
  en: (p: MsgParams) => string;
  cn: (p: MsgParams) => string;
}

const row = (en: string | Row['en'], cn: string | Row['cn']): Row => ({
  en: typeof en === 'string' ? () => en : en,
  cn: typeof cn === 'string' ? () => cn : cn,
});

const FLAGS: Record<FlagName, { en: string; cn: string }> = {
  fresh: { en: 'its rig data is not fresh', cn: '矿机数据不够新' },
  unimpaired: { en: 'the rig is impaired', cn: '矿机已受损' },
  processor: { en: 'its processor is not allowed', cn: '处理器不在允许范围内' },
  age: { en: 'it is younger than 3 days', cn: '矿机上线不满 3 天' },
  screened: { en: 'it has no valid screen pass', cn: '矿机尚无有效的筛查通过记录' },
};

const unreadable = row('The rigs in this agent could not be read. Refresh the page.', '无法读取该矿机代理中的矿机，请刷新页面。');
const cannotCheck = row(
  'The credit rule could not be checked, so the answer is no. This protects lenders. Try again later.',
  '无法验证信用规则，因此按拒绝处理（异常即拒绝），以保护出借人。请稍后重试。',
);
const noRoom = row('The pool has no room for this amount right now.', '资金池目前没有足够额度容纳这个金额。');
const notBorrower = row('Only the wallet that owns this agent can do this.', '只有拥有该矿机代理的钱包才能执行此操作。');
const noLoan = row('There is no open loan.', '当前没有进行中的贷款。');
const voucherMoves = row('This voucher is not in your wallet, or cannot move right now.', '这张凭证不在您的钱包中，或暂时无法转移。');
const aboveMax = row('Above what the pool accepts right now (cap, or idle BEM).', '超出资金池当前可接受的数额（上限或闲置 BEM）。');
const pushYourself = row(
  'The keeper cannot refresh right now. You can push it yourself on BSC.',
  'keeper 暂时无法刷新，您可以自行在 BSC 上推送。',
);
const dailyUsed = row(
  'Free refreshes are used up for today. You can push it yourself on BSC.',
  '今日免费刷新次数已用完，您可以自行在 BSC 上推送。',
);
const keeperBusy = row('The keeper is busy. Try again in a minute.', 'keeper 正忙，请一分钟后重试。');
/** Redeploy 3 RC3-02: `lend` waits `FEED_SETTLE` after `enableFeed` (`FeedSettling()`). */
export const FEED_SETTLING = row(
  'Borrowing reopens a few minutes after the data feed is turned back on.',
  '数据源重新开启后，借款将在几分钟后恢复。',
);
const agentUnreadable = row('The agent could not be read. Refresh the page.', '无法读取该矿机代理，请刷新页面。');

/** `TapeLens.quote().reason` codes. DENIED (6) has two lines: a failed flag, or all five flags set. */
export const QUOTE_REASONS: Record<number, Row> = {
  1: unreadable,
  2: row('This term would end after the next halving window, so it is not offered.', '该期限会在下一个减半窗口之后结束，因此不提供。'),
  3: cannotCheck,
  4: cannotCheck,
  5: cannotCheck,
  6: row(
    (p) => {
      const f = failedFlag(p);
      return f
        ? `The credit rule says no: ${FLAGS[f].en}.`
        : `This rig's expected output is too small for the minimum advance of ${p.minAdvance ?? '—'} BEM over this term.`;
    },
    (p) => {
      const f = failedFlag(p);
      return f
        ? `信用规则拒绝了这笔借款：${FLAGS[f].cn}。`
        : `该矿机在此期限内的预期产出太低，达不到 ${p.minAdvance ?? '—'} BEM 的最低借款金额。`;
    },
  ),
  7: row('New borrows are paused. Repaying and withdrawals keep working.', '新借款已暂停。还款和提款不受影响。'),
  8: row('The rig data feed is off, so new borrows wait.', '矿机数据源已关闭，新借款暂缓。'),
  9: row(
    (p) => `A new credit rule is queued for ${p.eta ?? '—'}. New borrows stay paused until the owner resumes them after the switch.`,
    (p) => `新信用规则已排队，最早于 ${p.eta ?? '—'} 生效。切换后需由所有者恢复借款，在此之前新借款保持暂停。`,
  ),
  10: row('A voucher is not in the agent. Move it in first.', '有凭证不在矿机代理中，请先转入。'),
  11: row('This agent already has an open loan.', '该矿机代理已有进行中的贷款。'),
  12: row('This agent was closed by a seize.', '该矿机代理已因没收而关闭。'),
  13: row(
    (p) => `Pick ${(p.terms ?? [7, 14])[0]} or ${(p.terms ?? [7, 14])[1]} days.`,
    (p) => `请选择 ${(p.terms ?? [7, 14])[0]} 天或 ${(p.terms ?? [7, 14])[1]} 天。`,
  ),
  14: noRoom,
  15: row((p) => `The minimum advance is ${p.minAdvance ?? '—'} BEM.`, (p) => `最低借款金额为 ${p.minAdvance ?? '—'} BEM。`),
  16: row((p) => `This amount exceeds the current limit: ${bindingText(p.binding ?? 0)}.`, (p) => `金额超过当前上限：${bindingText(p.binding ?? 0)}。`),
};

function failedFlag(p: MsgParams): FlagName | null {
  return p.inputBits === undefined ? null : firstFailedFlag(p.inputBits);
}

const minAdvanceRow = row(
  (p) => `The minimum advance is ${p.minAdvance ?? '—'} BEM.`,
  (p) => `最低借款金额为 ${p.minAdvance ?? '—'} BEM。`,
);

/** Revert reasons by custom-error name, across RigAgent, TapePool, AgentFactory, BEM, the voucher, RigReporter and LayerZero. */
export const REVERTS: Record<string, Row> = {
  BorrowsArePaused: QUOTE_REASONS[7] as Row,
  FeedIsDisabled: QUOTE_REASONS[8] as Row,
  FeedSettling: FEED_SETTLING,
  // redeploy 3 R3-02: a voucher that was collateral at the seize never goes back to the borrower
  SeizedVoucher: row(
    (p) => `Voucher #${p.id ?? '—'} was seized with the loan. It belongs to the pool and cannot be taken back.`,
    (p) => `凭证 #${p.id ?? '—'} 已随贷款被没收，归资金池所有，无法取回。`,
  ),
  NoCollateral: QUOTE_REASONS[10] as Row,
  NotOwned: QUOTE_REASONS[10] as Row,
  LoanOpen: QUOTE_REASONS[11] as Row,
  AgentClosed: QUOTE_REASONS[12] as Row,
  BadTerm: QUOTE_REASONS[13] as Row,
  ExceedsBorrowCap: noRoom,
  FeeAboveBound: row('The fee changed. Review the new quote.', '费用已变更，请查看新报价。'),
  CustodyUnreadable: row('Custody cannot be read for this rig. It cannot back a loan now.', '无法读取这台矿机的托管状态，暂时不能用它借款。'),
  ExceedsBackstop: row('The backstop limit is reached.', '已达后备资金上限。'),
  ExceedsBorrowerCap: noRoom,
  ExceedsIdle: noRoom,
  BelowMinAdvance: minAdvanceRow,
  WrongOpsFee: row(
    (p) => `The operating fee changed. It is now ${p.expectedFee ?? '—'} OKB. Review and sign again.`,
    (p) => `运营费已变更，现为 ${p.expectedFee ?? '—'} OKB。请确认后重新签名。`,
  ),
  OpsFeeTransferFailed: row(
    'The operating fee could not be delivered, so nothing happened. Try again later.',
    '运营费未能送达，因此本次操作未执行。请稍后重试。',
  ),
  AlreadyCollateral: row((p) => `#${p.id ?? '—'} is already in this agent.`, (p) => `#${p.id ?? '—'} 已在该矿机代理中。`),
  CollateralFull: row(
    `An agent holds at most ${MAX_COLLATERAL} vouchers.`,
    `一个矿机代理最多可持有 ${MAX_COLLATERAL} 张凭证。`,
  ),
  NotBorrower: notBorrower,
  NotFromBorrower: notBorrower,
  NoLoan: noLoan,
  NoDebt: noLoan,
  ERC20InsufficientBalance: row('Not enough BEM in your wallet.', '钱包中的 BEM 不足。'),
  ERC20InsufficientAllowance: row('The approval is too small. Approve again.', '授权额度不足，请重新授权。'),
  ERC721InsufficientApproval: voucherMoves,
  ERC721IncorrectOwner: voucherMoves,
  ERC721NonexistentToken: voucherMoves,
  ERC721InvalidOwner: voucherMoves,
  ERC721InvalidSender: voucherMoves,
  ERC721InvalidReceiver: voucherMoves,
  ERC721InvalidApprover: voucherMoves,
  ERC721InvalidOperator: voucherMoves,
  ERC4626ExceededMaxDeposit: aboveMax,
  ERC4626ExceededMaxMint: aboveMax,
  ERC4626ExceededMaxWithdraw: aboveMax,
  ERC4626ExceededMaxRedeem: aboveMax,
  LZ_InsufficientFee: row('The BSC fee changed. Try again.', 'BSC 上的费用已变化，请重试。'),
  BadBatch: row('Too many rigs for one push.', '一次推送的矿机过多。'),
};

/** `PolicyDenied(reason)` shows the line of its reason code. */
export const POLICY_DENIED = 'PolicyDenied';

/** Keeper answers and refusal reasons, as the keeper spells them. */
export const KEEPER: Record<string, Row> = {
  fresh: row('Rig data is already fresh.', '矿机数据已是最新。'),
  queued: row('Rig data requested. It usually arrives in 30–40 s.', '已请求刷新矿机数据，通常 30–40 秒内到达。'),
  'not eligible': row(
    "The keeper only refreshes rigs that can borrow. Check the rig's status.",
    'keeper 只刷新可借款的矿机，请查看矿机状态。',
  ),
  'rig daily limit': dailyUsed,
  'rig daily limit, push it yourself': dailyUsed,
  'rig weekly limit, push it yourself': row('The free refresh quota is used up. You can push it yourself on BSC.', '免费刷新次数已用完，您可以自行在 BSC 上推送。'),
  'borrower daily limit': dailyUsed,
  'daily push budget used, push it yourself': dailyUsed,
  'too many requests from this address': row('Too many requests. Wait a little.', '请求过多，请稍等片刻。'),
  'busy, try again shortly': keeperBusy,
  'busy, try again in a minute': keeperBusy,
  'keeper reserve': row(
    'The keeper is low on BNB right now. You can push it yourself on BSC.',
    'keeper 的 BNB 暂时不足，您可以自行在 BSC 上推送。',
  ),
  'feed settling: borrowing reopens a few minutes after the data feed is turned back on': FEED_SETTLING,
  'upgrade pending': pushYourself,
  'dry mode': pushYourself,
  'not deployed': pushYourself,
  'not an agent': agentUnreadable,
  'bad agent address': agentUnreadable,
  'collateral must hold 1-16 vouchers': agentUnreadable,
  // not the keeper's words: what the app saw while asking it (SPEC-PHASE5-APP §6.1 step 3: on a timeout, offer the self-push)
  timeout: row(
    'The report did not arrive in time. You can push it yourself on BSC.',
    '数据报告未能及时送达，您可以自行在 BSC 上推送。',
  ),
  unreachable: pushYourself,
};

/** Why "Harvest it to my wallet first" did not go ahead (SPEC-PHASE5-PRELOAN §4.3, §7). */
export type HarvestWhy =
  | 'storage'
  | 'paused'
  | 'contracts'
  | 'unreadable'
  | 'busy'
  | 'mark'
  | 'sub-bond'
  | 'cap'
  | 'bnb-short'
  | 'unknown-rig'
  | 'mined-unreadable'
  | 'choose'
  | 'landing';

export const HARVEST: Record<HarvestWhy, Row> = {
  storage: row('This browser blocks local storage, so harvest from here is off. You can harvest on tapeout.net.', '此浏览器禁用了本地存储，暂停在此领取。您可以前往 tapeout.net 领取。'),
  paused: row('New borrows are paused, so harvest from here is off. You can harvest on tapeout.net.', '新借款已暂停，暂停在此领取。您可以前往 tapeout.net 领取。'),
  contracts: row("TapeOut's contracts changed, so harvest from here is off. You can harvest on tapeout.net.", 'TapeOut 合约已变更，暂停在此领取。您可以前往 tapeout.net 领取。'),
  // not in the table of SPEC-PHASE5-PRELOAN §7: a read that failed disables the action with its reason (§4.8)
  unreadable: row('Harvest from here is off because BSC could not be read just now. You can harvest on tapeout.net.', '暂时无法读取 BSC 上的数据，暂停在此领取。您可以前往 tapeout.net 领取。'),
  // a harvest of this voucher is already unresolved (§4.3 precondition 1): the line of the state it is in
  busy: row('Harvest sent on BSC, waiting for it to be included…', '已在 BSC 上发起领取，等待上链…'),
  mark: row('Waiting for BSC to pass the time your voucher came back…', '正在等待 BSC 时间越过凭证取回的时间…'),
  'sub-bond': row('Someone harvested this rig meanwhile; there is too little left to harvest from here.', '该矿机刚被他人领取过，剩余数额太少，无法在此领取。'),
  cap: row((p) => `The BSC fee is unusually high (${p.bnb ?? '—'} BNB). Harvest on tapeout.net or try later.`, (p) => `BSC 手续费异常偏高（${p.bnb ?? '—'} BNB）。请前往 tapeout.net 领取或稍后再试。`),
  'bnb-short': row((p) => `Add at least ${p.bnb ?? '—'} BNB on BSC to harvest from here, or harvest on tapeout.net.`, (p) => `如需在此领取，请在 BSC 上至少补充 ${p.bnb ?? '—'} BNB，或前往 tapeout.net 领取。`),
  'unknown-rig': row('The vault on BSC no longer knows this rig.', 'BSC 金库已不再记录这台矿机。'),
  'mined-unreadable': row((p) => `Could not read the BEM mined on BSC for ${p.ids ?? '—'}.`, (p) => `无法读取 ${p.ids ?? '—'} 在 BSC 上已挖出的 BEM。`),
  // not in the table either: the move found BEM that needs a choice, which the screen did not show yet
  choose: row(
    'Choose first: harvest the BEM mined before this loan to your wallet, or keep it in the loan.',
    '请先选择：先把借款前已挖出的 BEM 领取到钱包，或保留在本笔贷款中。',
  ),
  // §4.5, checked again inside the borrow action: a harvest the app sent will be paid to the agent and has not landed yet
  landing: row(
    'The harvest you sent will be paid to the agent. Borrowing waits until it lands there; borrowing then sends it to you.',
    '您发起的领取将付给矿机代理。借款将等到这笔 BEM 到账后再进行，届时借款会把它转给您。',
  ),
};

/** The app's own checks and outcomes, which no contract or keeper says for it. */
export const ENTRY = row(
  'The app does not recognise this contract. Do not continue; check the official links.',
  '应用无法识别此合约，请勿继续，并请核对官方链接。',
);
export const POLICY_CHANGED = row(
  'The credit rule changed; this app version must be updated.',
  '信用规则已变更，需要更新此应用版本。',
);
export const WRONG_CHAIN = row('Your wallet is on another network. Switch to X Layer first.', '您的钱包在其他网络上，请先切换到 X Layer。');
export const WRONG_CHAIN_BSC = row('Your wallet is on another network. Switch to BNB Smart Chain first.', '您的钱包在其他网络上，请先切换到 BNB Smart Chain。');
export const REPORT_LATE = row(
  'The report from BSC is taking longer than usual. It can take a few minutes: check again shortly.',
  'BSC 的数据报告比平时慢，可能需要几分钟，请稍后再查看。',
);
export const TX_FAILED = row(
  'The transaction failed on-chain. Nothing changed except the network fee.',
  '交易在链上执行失败，除网络费用外没有任何变化。',
);

/** The wallet refused `wallet_switchEthereumChain` and `wallet_addEthereumChain` for X Layer: some multi-chain wallets cannot add it. */
export const NO_XLAYER = row(
  'This wallet cannot switch to X Layer. Try OKX Wallet, MetaMask or Rabby.',
  '该钱包无法切换到 X Layer。请改用 OKX Wallet、MetaMask 或 Rabby。',
);
/** The wallet picked in the list is gone (it was removed or locked between the list and the click). */
export const NO_WALLET = row(
  'No wallet found. Install OKX Wallet, MetaMask or Rabby, then reload.',
  '未检测到钱包。请安装 OKX Wallet、MetaMask 或 Rabby 后刷新页面。',
);

export const WALLET_REJECTED = row('You cancelled in your wallet. Nothing was sent.', '您已在钱包中取消，未发送任何交易。');
export const UNKNOWN = row('Something went wrong. Nothing was sent.', '出现问题，未发送任何交易。');

/** Keeper reasons that mean "offer the self-push on BSC" (SPEC-PHASE5-APP §6.1 step 3). */
export const KEEPER_SELF_PUSH: readonly string[] = [
  'rig daily limit',
  'rig daily limit, push it yourself',
  'rig weekly limit, push it yourself',
  'borrower daily limit',
  'daily push budget used, push it yourself',
  'keeper reserve',
  'upgrade pending',
  'dry mode',
  'not deployed',
];

/** What a failed action reports. `details` is raw external text: always escape it. */
export type AppError =
  | { kind: 'quote'; reason: number; params?: MsgParams }
  | { kind: 'revert'; name: string; params?: MsgParams; reason?: number }
  | { kind: 'keeper'; reason: string }
  | { kind: 'wallet-rejected' }
  /** The wallet cannot move to X Layer (it refused the switch and the add). `details` is its own text. */
  | { kind: 'wallet-no-xlayer'; details: string }
  /** The wallet chosen in the picker is no longer there. */
  | { kind: 'no-wallet' }
  /** An entry check of SPEC-PHASE5-APP §10 failed: `check` names it (for the details line). */
  | { kind: 'entry'; check: string }
  /** `pool.policy()` is not the policy this app version pins: borrow only. */
  | { kind: 'policy-changed' }
  | { kind: 'wrong-chain'; want: 'xlayer' | 'bsc' }
  /** "Harvest it to my wallet first" did not go ahead, or a move refused because of BEM mined before the loan. */
  | { kind: 'harvest'; why: HarvestWhy; params?: MsgParams }
  /** The report did not show up on X Layer after a self-push. */
  | { kind: 'report-late' }
  /** The transaction was mined and reverted, and a replay gave no reason. `hash` goes to the details. */
  | { kind: 'tx-failed'; hash: string }
  | { kind: 'unknown'; details: string };

export function errorText(e: AppError): string {
  const lang = getLang();
  const pick = (r: Row, p: MsgParams = {}): string => (lang === 'cn' ? r.cn(p) : r.en(p));
  switch (e.kind) {
    case 'quote':
      return pick(QUOTE_REASONS[e.reason] ?? UNKNOWN, e.params);
    case 'revert': {
      if (e.name === POLICY_DENIED && e.reason !== undefined) return pick(QUOTE_REASONS[e.reason] ?? UNKNOWN, e.params);
      return pick(REVERTS[e.name] ?? UNKNOWN, e.params);
    }
    case 'keeper':
      return pick(KEEPER[e.reason] ?? UNKNOWN);
    case 'wallet-rejected':
      return pick(WALLET_REJECTED);
    case 'wallet-no-xlayer':
      return pick(NO_XLAYER);
    case 'no-wallet':
      return pick(NO_WALLET);
    case 'entry':
      return pick(ENTRY);
    case 'policy-changed':
      return pick(POLICY_CHANGED);
    case 'wrong-chain':
      return pick(e.want === 'bsc' ? WRONG_CHAIN_BSC : WRONG_CHAIN);
    case 'harvest':
      return pick(HARVEST[e.why], e.params);
    case 'report-late':
      return pick(REPORT_LATE);
    case 'tx-failed':
      return pick(TX_FAILED);
    case 'unknown':
      return pick(UNKNOWN);
  }
}

/** The raw text to show under "Details" for errors we do not know. */
export const errorDetails = (e: AppError): string | null =>
  e.kind === 'unknown' ? e.details : e.kind === 'wallet-no-xlayer' ? e.details || null : e.kind === 'keeper' && !(e.reason in KEEPER) ? e.reason : e.kind === 'entry' ? e.check : e.kind === 'tx-failed' ? e.hash : null;


/** The binding code of TapePool.lendLimit; while the feed settles after a re-enable, binding 5 says so (RC3-02). */
export function limitText(binding: number, settling: boolean): string {
  return binding === 5 && settling ? errorText({ kind: 'revert', name: 'FeedSettling' }) : bindingText(binding);
}

/** The binding code comes from TapePool.lendLimit. */
export function bindingText(binding: number): string {
  switch (binding) {
    case 1: return t('Idle BEM', '闲置 BEM');
    case 2: return t('Borrow cap', '借款总额上限');
    case 3: return t('Per-borrower cap', '单个借款人上限');
    case 4: return t('Backstop', '后备资金');
    case 5: return t('Paused or feed off', '借款暂停或数据源关闭');
    default: return t('Pool room', '资金池额度');
  }
}
