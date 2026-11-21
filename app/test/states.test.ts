// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../src/fixtures/catalog';
import { make, must, mustNot } from './helpers';

/** Every named fixture shows the state it stands for, in English and in Chinese. */
const SHOWS: Record<string, [string, string][]> = {
  disconnected: [['Connect your wallet', '连接钱包']],
  'wrong-network': [['Switch to X Layer', '切换到 X Layer'], ['Wrong network', '网络错误']],
  connected: [['Your supplies', '我的存款']],
  'low-okb': [['Add at least', '请在 X Layer 上至少补充']],
  view: [['Read-only view', '只读视图']],
  markets: [['Total Supplied', '存款总额'], ['Coming soon', '即将上线']],
  'markets-disconnected': [['Total Supplied', '存款总额']],
  'pool-page': [['Credit rule', '信用规则'], ['Contracts and admin', '合约与管理权限']],
  'keeper-absent': [['Supply APY', '近 7 天增长']],
  stale: [['could not be refreshed', '未能刷新']],
  paused: [['New borrows are paused.', '新借款已暂停。']],
  'feed-off': [['The rig data feed is off.', '矿机数据源已关闭。']],
  'feed-settling': [['Borrowing reopens a few minutes after the data feed is turned back on.', '数据源重新开启后，借款将在几分钟后恢复。']],
  'swap-queued': [['A new credit rule is queued.', '新信用规则排队中。'], ['stay paused until the owner resumes them', '切换后需由所有者恢复借款']],
  'no-room': [['No borrowing capacity available.', '暂无可借额度。']],
  'deposits-closed': [['Deposits are closed while a loan is under review.', '有贷款处于待处理状态，存款暂停']],
  'fee-queued': [['An operating fee change is queued.', '运营费变更排队中。'], ['once someone executes it after', '有人执行即对新借款生效']],
  'ops-fee-zero': [['Cost in BEM', 'BEM 成本']],
  'loan-active': [['Repay with BEM', '用 BEM 还款'], ['WHERE REPAYMENT COMES FROM', '还款来源'], ['when output covers the debt · at the latest', '产出足以还清时 · 最迟'], ['Estimated repaid', '预计还清'], ['The design bonus can make it sooner', '设计加成可能使其提前'], ['mined, not yet harvested (after the bridge fee) · the keeper harvests at 100.5%', '（扣除跨链费） · 达到 100.5% 时 keeper 领取'], ['it reaches the loan when the keeper harvests it', 'keeper 领取后才会用于还款']],
  'loan-late': [['with 0.1180 BEM left', '剩余 0.1180 BEM'], ['Nothing is seized for being slow', '产出慢不会导致没收'], ['the keeper harvests about every 72 h.', 'keeper 约每 72 小时领取一次。']],
  'loan-flagged': [['is flagged', '已被标记'], ['Repay 0.3080 BEM', '偿还 0.3080 BEM']],
  'loan-seize': [['The cure window ended', '补救窗口已于']],
  'loan-seized': [['Seized on', '已于'], ['was written off', '债务已核销']],
  'loan-cleared': [['Debt cleared on', '债务已于'], ['Release voucher', '取回凭证']],
  'loan-grouped': [['#6030', '#6030'], ['#6031', '#6031']],
  'repay-modal': [['Repay loan', '偿还贷款'], ['1 · Allow BEM', '1 · 授权 BEM']],
  'rigs-all': [['In the loan of #6030', '在 #6030 的贷款中'], ['At the latest; earlier once output covers the debt', '最迟时间；产出足以还清债务时会提前']],
  'rig-ready': [['Credit rule: estimate', '信用规则：预估']],
  'rig-screen-pending': [['Recorded on-chain. Borrowable in 43:37 (from Oct 21, 08:00 UTC).', '已记录上链，43:37 后可借（10月21日 08:00 UTC 起）。']],
  'rig-screen-suspended': [['is suspended', '已被暂停']],
  'rig-screen-changed': [['needs a new screen', '需重新筛查']],
  'rig-not-screened': [['Every rig needs a screen pass before it can borrow. Register this rig and the keeper checks it automatically. Nothing to sign, nothing to pay.', '每台矿机借款前都需要通过筛查。提交申请后，keeper 会自动检查这台矿机，您无需签名，也无需付费。'], ['Register to borrow', '申请借款资格']],
  'rig-no-base-power': [['Its base power is 0', '基础算力为 0']],
  'rig-too-new': [['at least 3 days old', '上线满 3 天'], ['Recorded on-chain. Borrowable in 73:37 (from Oct 22, 14:00 UTC).', '已记录上链，73:37 后可借（10月22日 14:00 UTC 起）。']],
  'rig-mismatch': [['This voucher no longer matches its rig on BSC.', '这张凭证与其在 BSC 上的矿机已不再匹配']],
  'rig-not-synced': [['Harvest once on tapeout.net to sync it', '领取一次收益以完成同步']],
  'rig-processor': [['processor is not supported', '不支持该矿机的处理器']],
  'rig-not-mining': [['not mining on BSC', '没有在挖矿']],
  'rig-no-data': [['No data about this rig', '尚未取得这台矿机的数据']],
  'rig-loose-open': [['This voucher is not collateral.', '这张凭证不计入担保。'], ['Register', '登记凭证']],
  'rig-loose-closed': [['closed Rig Agent', '已关闭的矿机代理'], ['Take back', '取回凭证']],
  'rig-in-agent': [['Refresh rig data', '刷新矿机数据'], ['Not borrowing now?', '暂时不借款？']],
  'rig-stuck': [['Moving to the pool.', '正在转入资金池。']],
  'rig-seized': [['now belongs to the pool', '现归资金池所有']],
  'rig-loan': [['Repay with BEM', '用 BEM 还款']],
  'flow-idle': [['Create agent', '创建代理'], ['Use my empty agent', '改用我空闲的代理']],
  'flow-reuse': [['Using your empty agent', '使用您空闲的代理'], ['waiting is sent to you when you borrow', '会在借款时转给您']],
  'flow-agent': [['created.', '已创建代理'], ['Move voucher', '转入凭证']],
  'flow-moved': [['Voucher in the agent.', '凭证已在代理中'], ['Refresh rig data', '刷新矿机数据']],
  'flow-waiting': [['Waiting for the report from BSC', '正在等待 BSC 数据报告']],
  'flow-fresh': [['Report fresh', '数据已更新'], ['Borrow within', '请在'], ['Credit rule: allow', '信用规则：允许'], ['checks every 10 minutes and harvests when net output covers the debt', 'keeper 每 10 分钟检查一次。扣除跨链费后的产出足以还清债务时即领取']],
  'flow-expired': [['older than 5 minutes', '已超过 5 分钟'], ['Refresh again', '重新刷新']],
  'flow-deny': [['Credit rule: deny', '信用规则：拒绝'], ['The credit rule says no', '信用规则拒绝了这笔借款']],
  'flow-deny-small': [['too small for the minimum advance', '太低，达不到']],
  'flow-cant-check': [["Credit rule: can't check", '信用规则：无法验证'], ['could not be checked', '无法验证信用规则']],
  'flow-mined-choice': [
    ['is mined and not harvested yet (≈ 63% of the debt)', '已挖出、尚未领取的 BEM：0.4080（约占债务的 63%）'],
    ['Harvest it to my wallet first', '先领取到我的钱包'],
    ['the bridge message fee plus 10% (the extra 10% comes back) and gas. The OKB operating fee does not cover it. The BEM usually reaches your wallet on X Layer in about a minute, less the bridge fee.', '跨链消息费加 10%（多付的 10% 会退还）以及 gas。OKB 运营费不涵盖这笔费用。BEM 通常约一分钟后到达您在 X Layer 上的钱包（扣除跨链费）。'],
    ['or harvest on tapeout.net', '或前往 tapeout.net 领取'],
    ['Keep it in this loan', '保留在本笔贷款中'],
    ['repays this loan first once the voucher is in the agent. The flat BEM fee stays owed in full, and the OKB operating fee is not refunded.', '将优先用于还款。固定 BEM 费用仍需全额支付，OKB 运营费不予退还。'],
  ],
  'flow-mined-info': [['0.0179 BEM mined and not harvested (≈ 1% of the debt) goes to this loan unless you harvest it first.', '0.0179 BEM 已挖出但未领取（约占债务的 1%），除非先领取，否则将计入本笔贷款。'], ['Harvest it to my wallet first', '先领取到我的钱包']],
  'flow-mined-covers': [
    ['It covers the whole debt: while the keeper runs, it usually repays this loan within 10–15 minutes of borrowing, so the fees buy credit that lasts minutes.', '这部分已足以还清全部债务：keeper 正常运行时，通常在借款后 10–15 分钟内完成还款，相当于为仅持续几分钟的贷款支付全部费用。'],
  ],
  'flow-mined-tiny': [['It is too little to harvest from here.', '数额太小，无法在此领取。']],
  'flow-harvest-prompting': [
    ['Confirm the harvest in your wallet…', '请在钱包中确认领取…'],
    ['harvest([#4128])', 'harvest([#4128])'],
    ["If the rig's BEM drops below 0.0001 before this lands on BSC, the vault also takes a 0.0001 BEM bond from your BSC wallet. It comes back on X Layer, less the bridge fee.", '如果在交易上链前该矿机的 BEM 降到 0.0001 以下，金库还会从您的 BSC 钱包收取 0.0001 BEM 保证金，之后会在 X Layer 上退还（扣除跨链费）。'],
    ['transactions on X Layer · 1 on BSC', 'X Layer 上需 2 笔交易 · BSC 上需 1 笔'],
  ],
  'flow-harvest-inflight': [['Harvest sent on BSC, waiting for it to be included…', '已在 BSC 上发起领取，等待上链…'], ['· 1 on BSC', 'X Layer 上需 2 笔交易 · BSC 上需 1 笔']],
  'flow-harvest-gate': [['Waiting for the harvest to settle on BSC…', '正在等待 BSC 上的领取交易最终确认…']],
  'flow-harvest-passed': [['Move voucher', '转入凭证']],
  'flow-agent-mined': [
    ['0.4080 BEM mined before this loan (≈ 63% of the debt) will repay it first. To keep it, take the voucher back, harvest, and move it again.', '借款前已挖出的 0.4080 BEM（约占债务的 63%）将优先用于还款。如需保留，请先取回凭证、领取收益，再重新转入。'],
    ['Take back to harvest first', '取回凭证，先领取'],
    ['Keep it in this loan', '保留在本笔贷款中'],
  ],
  'flow-mined-unreadable': [
    ['Could not read the BEM mined on BSC for #4128.', '无法读取 #4128 在 BSC 上已挖出的 BEM。'],
    ['Retry', '重试'],
    ['Move anyway (keep any mined BEM in this loan)', '仍然转入（已挖出的 BEM 计入本笔贷款）'],
  ],
  'flow-harvest-contracts-changed': [["TapeOut's contracts changed, so harvest from here is off. You can harvest on tapeout.net.", 'TapeOut 合约已变更，暂停在此领取。您可以前往 tapeout.net 领取。']],
  'group-flow': [['One loan for several rigs', '多台矿机合并借款'], ['Grouped rigs share one fate.', '合并后的矿机共担风险。']],
  picker: [['Connect a Wallet', '连接钱包'], ['Installed', '已安装'], ['Recent', '最近使用'], ['Recommended', '推荐'], ['What is a Wallet?', '什么是钱包？'], ['Get a Wallet', '获取钱包'], ['Learn More', '了解更多']],
  'picker-fallback': [['Browser wallet', '浏览器钱包']],
  'picker-none': [['No wallet found in this browser.', '此浏览器中未检测到钱包。']],
  'picker-connecting': [['Opening MetaMask…', '正在打开 MetaMask…'], ['Confirm the connection in your wallet.', '请在钱包中确认连接。']],
  'picker-get': [['Install one, then reload this page.', '安装任一钱包后，请刷新本页面。'], ['Binance Wallet', 'Binance Wallet']],
  'picker-get-wallet': [['Get Binance Wallet', '获取 Binance Wallet'], ['Install it from its official page', '请从官方页面安装']],
  'picker-error': [['This wallet cannot switch to X Layer. Try OKX Wallet, MetaMask or Rabby.', '该钱包无法切换到 X Layer。请改用 OKX Wallet、MetaMask 或 Rabby。']],
  menu: [['Copy address', '复制地址'], ['View on explorer', '在区块浏览器中查看'], ['Disconnect', '断开连接'], ['0x3f1C....009A2e', '0x3f1C....009A2e']],
  'menu-copied': [['Copied!', '已复制']],
  'menu-copy-failed': [['0x3f1C000000000000000000000000000000009A2e', '0x3f1C000000000000000000000000000000009A2e']],
  'menu-wrong-network': [['On another network', '在其他网络上'], ['Wrong network', '网络错误']],
  'supply-modal': [['Supply BEM', '存入 BEM']],
  'withdraw-modal': [['Withdraw BEM', '提取 BEM']],
  'screen-note': [['Register to borrow', '申请借款资格'], ['the TapePool team records the pass on-chain; a pass counts 48 h after it is recorded on-chain.', '由 TapePool 团队将结果记录上链；筛查结果记录上链 48 小时后生效。'], ['Register this rig and the keeper checks it automatically.', '提交申请后，keeper 会自动检查这台矿机']],
  'screen-note-closed': [['The TapePool team screens new rigs', 'TapePool 团队会为新矿机做筛查'], ['https://x.com/Tape_Pool', 'https://x.com/Tape_Pool']],
  'register-closed': [['The TapePool team screens new rigs; a pass counts 48 h after it is recorded on-chain.', 'TapePool 团队会为新矿机做筛查；筛查结果记录上链 48 小时后生效。'], ['TapePool on X', 'X 上的 TapePool'], ['Not screened', '尚未筛查']],
  'register-closed-delay-unread': [['a pass counts after a public waiting period once it is recorded on-chain', '筛查结果记录上链并经过公开等待期后生效']],
  'register-queued': [['Registered. The check starts shortly.', '已提交申请，检查即将开始。'], ['Checking', '检查中']],
  'register-paused': [['Checks are paused while the team reviews a change on TapeOut. Your rig keeps its place.', '团队正在审查 TapeOut 的一项变更，检查暂停，您的矿机保留排队位置。']],
  'register-checking': [['Checking the rig. This usually takes a few minutes.', '正在检查矿机，通常需要几分钟。'], ['Checking', '检查中']],
  'register-passed': [['The rig passed the screen. The TapePool team records it on-chain next. It can borrow 48 h after that.', '矿机已通过筛查，接下来由 TapePool 团队将结果记录上链，记录 48 小时后即可借款。'], ['Waiting for the team', '等待团队记录']],
  'register-fail': [['This rig cannot borrow.', '这台矿机无法借款。'], ['This rig cannot borrow: it gives a wrong answer on an official test vector, so it can be revoked.', '这台矿机无法借款：它在一个官方测试向量上输出错误，可能被撤销。'], ['Cannot borrow', '无法借款']],
  'register-revoked': [["The TapePool team removed this rig's screen pass, so it cannot borrow.", 'TapePool 团队已撤销这台矿机的筛查通过记录，因此无法借款。']],
  'register-error': [['The check could not finish. The team has been told. You can try again from Oct 19, 18:23 UTC.', '检查未能完成，已通知团队。您可在 10月19日 18:23 UTC 之后重新检查。'], ['Check did not finish', '检查未完成']],
  'register-retry': [['The check could not finish. You can try again now.', '检查未能完成，您现在可以重新检查。'], ['Try again', '重新检查']],
  'register-too-new': [['at least 3 days old', '上线满 3 天'], ['Register this rig and the keeper checks it automatically.', '提交申请后，keeper 会自动检查这台矿机'], ['Register to borrow', '申请借款资格']],
  'register-cards': [['Checking the rig. This usually takes a few minutes.', '正在检查矿机，通常需要几分钟。']],
  'owner-page': [["Recording a screen pass is owner-only: RigScreen.recordPass can only be sent by the pool owner's wallet (0x3f1C…9A2e).", '记录筛查通过结果仅限所有者操作：只有资金池所有者的钱包（0x3f1C…9A2e）才能调用 RigScreen.recordPass。'], ['Your wallet is the pool owner.', '您的钱包是资金池所有者。'], ['data-a="record-pass" data-v="4301"', 'data-a="record-pass" data-v="4301"'], ['The pass counts 48 h after you sign.', '签名 48 小时后生效。'], ['it is too large to check completely', '它的规模过大，无法完整检查'], ['The second provider did not reproduce it.', '第二数据源未能复现结果。'], ['Recorded, counts from Oct 20, 12:23 UTC', '已记录，10月20日 12:23 UTC 起生效'], ['https://keeper.example/v1/screens/4301/artifact', 'https://keeper.example/v1/screens/4301/artifact'], ['Checked Oct 19, 12:18 UTC', '检查时间 10月19日 12:18 UTC'], ['BSC binance.org → blastapi.io · X Layer drpc.org → xlayer.tech', '数据源 BSC binance.org → blastapi.io · X Layer drpc.org → xlayer.tech']],
  'owner-page-other': [['Your wallet is not the pool owner, so it cannot sign.', '您的钱包不是资金池所有者，无法签名。'], ['Waiting for a signature', '等待签名']],
};

describe('the named fixtures', () => {
  const names = Object.keys(FIXTURES).filter((n) => !n.startsWith('param-shift'));

  it('has a check for every fixture, and a fixture for every check', () => {
    expect(Object.keys(SHOWS).sort()).toEqual(names.sort());
  });

  for (const name of Object.keys(SHOWS)) {
    it(`${name}: shows what it stands for`, () => {
      for (const [en, cn] of SHOWS[name] ?? []) {
        const e = make(name, { lang: 'en' });
        must(`${e.text} ${e.html}`, en, `${name} en`);
        const c = make(name, { lang: 'cn' });
        must(`${c.text} ${c.html}`, cn, `${name} cn`);
      }
    });
  }

  it('covers every row of the §5.2 table, 9a and 9b included', () => {
    const rows = new Set<string>();
    const { ctx } = make('rigs-all');
    for (const r of ctx.snap.rigs) rows.add(r.state.row);
    expect([...rows].sort()).toEqual(['1', '10', '11', '12', '13', '14', '2', '3', '4', '5', '6', '7', '8', '9a', '9b']);
  });

  it('covers every loan phase', () => {
    const phases = new Set(make('rigs-all').ctx.snap.loans.map((l) => l.phase));
    for (const n of ['loan-late', 'loan-flagged', 'loan-seize', 'loan-seized', 'loan-cleared']) {
      for (const l of make(n).ctx.snap.loans) phases.add(l.phase);
    }
    expect([...phases].sort()).toEqual(['active', 'cleared', 'flagged', 'late', 'seize', 'seized']);
  });

  it('covers the wallet states', () => {
    const status = (n: string) => make(n).ctx.snap.wallet.status;
    expect(status('disconnected')).toBe('disconnected');
    expect(status('wrong-network')).toBe('wrong-network');
    expect(status('connected')).toBe('connected');
    expect(make('view').ctx.snap.wallet.status).toBe('view');
    expect(make('view').ctx.readOnly).toBe('view');
  });

  it('the grouped loan shows once, on its lowest id', () => {
    const { html } = make('rigs-all', { hash: '#/app/rigs' });
    expect(html.match(/rigs\/6030"/g)?.length).toBeGreaterThan(0);
    expect(html).toContain('In the loan of #6030');
    expect(html).toContain('2 rigs back this loan');
  });

  it('the mined-BEM fixtures put the buttons where the spec says (SPEC-PHASE5-PRELOAN §4)', () => {
    const buttons = (name: string, label: string) => [...new DOMParser().parseFromString(make(name).html, 'text/html').querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);
    // the required choice: both options, Move voucher off
    for (const label of ['Harvest it to my wallet first', 'Keep it in this loan']) expect(buttons('flow-mined-choice', label)[0]?.hasAttribute('data-a'), label).toBe(true);
    expect(buttons('flow-mined-choice', 'Move voucher')[0]?.hasAttribute('disabled')).toBe(true);
    // nothing is preselected: Keep is not the primary button
    expect(buttons('flow-mined-choice', 'Keep it in this loan')[0]?.className).not.toContain('btn-p');
    // below the line: an optional harvest, Move voucher on
    expect(buttons('flow-mined-info', 'Move voucher')[0]?.hasAttribute('disabled')).toBe(false);
    expect(buttons('flow-mined-info', 'Harvest it to my wallet first')).toHaveLength(1);
    // too little to harvest: no harvest button
    expect(buttons('flow-mined-tiny', 'Harvest it to my wallet first')).toHaveLength(0);
    // the contracts changed: the harvest button is off, the tapeout.net link stays
    expect(buttons('flow-harvest-contracts-changed', 'Harvest it to my wallet first')[0]?.hasAttribute('disabled')).toBe(true);
    expect(make('flow-harvest-contracts-changed').html).toContain('https://tapeout.net');
    // a harvest on its way: the choice is gone, Move voucher is off; once it passed Move voucher is on
    for (const name of ['flow-harvest-prompting', 'flow-harvest-inflight', 'flow-harvest-gate']) {
      expect(buttons(name, 'Keep it in this loan'), name).toHaveLength(0);
      expect(buttons(name, 'Move voucher')[0]?.hasAttribute('disabled'), name).toBe(true);
    }
    const passed = make('flow-harvest-passed');
    expect(buttons('flow-harvest-passed', 'Move voucher')[0]?.hasAttribute('disabled')).toBe(false);
    expect(passed.text).not.toContain('Waiting for the harvest');
    expect(passed.ctx.snap.harvest.gates['4128']?.state).toBe('passed');
    // an unreadable amount: no Move voucher, a Retry, and Move anyway
    expect(buttons('flow-mined-unreadable', 'Move voucher')).toHaveLength(0);
    expect(buttons('flow-mined-unreadable', 'Retry')).toHaveLength(1);
    // the voucher is in the agent: Borrow is off until one is chosen
    expect(buttons('flow-agent-mined', 'Borrow')[0]?.hasAttribute('disabled')).toBe(true);
  });

  it('a stale section turns its buttons off', () => {
    const { html } = make('stale', { hash: '#/app/rigs/3871' });
    must(html, 'disabled', 'stale');
    mustNot(html, 'data-a="sweep"', 'stale');
    mustNot(html, 'data-a="repay"', 'stale');
  });
});
