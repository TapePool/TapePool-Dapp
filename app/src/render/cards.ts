import { html, type Html } from '../html';
import { t, th } from '../i18n';
import { chip, soon, type Ctx } from './ui';

export function elig(): Html {
  return html`<section class="v2-card" aria-labelledby="el"><div class="v2-card-h"><h2 id="el"><span class="uid" aria-hidden="true">R1</span>${t('When a rig can borrow', '矿机可借条件')}</h2></div><div class="v2-card-b"><ol class="ol-elig">
    <li>${t('It runs on TapeOut, Behemoth or RefBench, the processors that can be PoD-mined.', '处理器为 TapeOut、Behemoth 或 RefBench（可 PoD 挖矿的处理器）。')}</li>
    <li>${t('It is at least 3 days old.', '矿机上线至少 3 天。')}</li>
    <li>${t('It has a screen pass on-chain: the rig matches every official vector of its task, so it cannot be revoked. A pass counts 48 h after it is recorded.', '链上已记录筛查通过：矿机与其任务的全部官方测试向量一致，因此不会被撤销。筛查结果记录 48 小时后生效。')}</li>
    <li>${t('Its base power is above 0, and it is not stopped, revoked or rescued by the TapeOut Safe. Only base power counts; the design bonus is left out.', '基础算力大于 0，且未停止、未被撤销、未被 TapeOut 多签强制取回（rescue）。只计算基础算力，不计设计加成。')}</li></ol></div>
    <div class="v2-card-f">${t('Rig missing? Bridge it to X Layer on tapeout.net, to your own wallet. Never bridge it straight to a Rig Agent.', '没有看到您的矿机？请在 tapeout.net 上把矿机跨链到 X Layer 上您自己的钱包，不要直接跨链到矿机代理。')}</div></section>`;
}

/** The Telegram alerts card stays, with its button off (SPEC-PHASE5-APP S-6). */
export function alerts(_c: Ctx): Html {
  return html`<section class="v2-card" aria-labelledby="lal"><div class="v2-card-h"><h2 id="lal"><span class="uid" aria-hidden="true">L4</span>${t('Alerts', '提醒')}</h2>${chip('n', t('Off', '未开启'))}</div><div class="v2-card-b col g10"><p class="mut m0">${t('Get a Telegram message if a loan is flagged, with the rig, the debt to repay and the time left in the cure window. Also when a debt is cleared, so you can release the voucher.', '贷款被标记时通过 Telegram 通知您，包括矿机、应还债务和补救窗口剩余时间；债务还清时也会提醒您取回凭证。')}</p>
    <div class="row-wrap g10 ai-c"><button type="button" class="btn btn-x" disabled>${t('Turn on Telegram alerts', '开启 Telegram 提醒')}</button>${soon(t('Telegram alerts are planned. They are not live yet.', 'Telegram 提醒正在计划中，尚未上线。'))}</div></div></section>`;
}

export function help(): Html {
  return html`<section class="v2-card" aria-labelledby="lt"><div class="v2-card-h"><h2 id="lt"><span class="uid" aria-hidden="true">L5</span>${t('If something goes wrong', '出现问题时')}</h2></div><div class="v2-card-b col g10">
    <p class="m0 c-soft">${t('A slow rig is never seized. Past maturity, the voucher stays in the agent and keeps repaying; the keeper harvests about every 72 h until the debt is clear.', '产出慢的矿机绝不会被没收。到期后若仍有欠款，凭证留在代理中继续还款，keeper 约每 72 小时领取一次收益，直到还清。')}</p>
    <p class="mut m0">${th(
      html`Only a rig proven impaired on-chain is flagged: revoked, stopped, rescued by the TapeOut Safe, or with no base power. Then you have <span class="mono c-w">72 h</span> to repay before a <span class="mono c-w">24 h</span> seize window opens.`,
      html`只有被链上证明受损的矿机才会被标记：被撤销、已停止、被 TapeOut 多签强制取回（rescue）或基础算力为 0。标记后您有 <span class="mono c-w">72 小时</span>补救窗口可以还款，之后进入 <span class="mono c-w">24 小时</span>没收窗口。`,
    )}</p></div></section>`;
}
