// @vitest-environment happy-dom
// Redeploy 3, Part C (docs/SPEC-REDEPLOY-3.md §6): the settling window after a feed re-enable (RC3-02) and the
// seized-voucher message (RC3-01).
import { encodeErrorResult } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { rigAgentAbi, tapePoolAbi } from '../src/chain/abi';
import { FEED_SETTLING, errorText, limitText } from '../src/chain/errors';
import { mapPool } from '../src/chain/map';
import { readCore, type ReadEnv } from '../src/chain/reads';
import { decodeRevert } from '../src/chain/revert';
import { MAINNET } from '../src/config';
import { setLang } from '../src/i18n';
import { feedSettling, poolBanner } from '../src/logic/selectors';
import { make, must, mustNot } from './helpers';
import { A, ACCOUNT, NOW, addAccount, buildWorld } from './world';

const SETTLING_EN = 'Borrowing reopens a few minutes after the data feed is turned back on.';
const SETTLING_CN = '数据源重新开启后，借款将在几分钟后恢复。';
beforeEach(() => setLang('en', false));

describe('RC3-02 the settling window after the feed is turned back on', () => {
  it('maps FeedSettling() and the keeper refusal to the settling line, in English and Chinese', () => {
    expect(errorText({ kind: 'revert', name: 'FeedSettling' })).toBe(SETTLING_EN);
    expect(errorText({ kind: 'keeper', reason: 'feed settling: borrowing reopens a few minutes after the data feed is turned back on' })).toBe(SETTLING_EN);
    expect(decodeRevert(encodeErrorResult({ abi: tapePoolAbi, errorName: 'FeedSettling' }))).toMatchObject({ kind: 'revert', name: 'FeedSettling' });
    setLang('cn', false);
    expect(errorText({ kind: 'revert', name: 'FeedSettling' })).toBe(SETTLING_CN);
    expect(FEED_SETTLING.cn({})).toBe(SETTLING_CN);
  });

  it('is open from feedEnabledAt + FEED_SETTLE on chain time, and never while the feed is off', () => {
    const pool = { ...make('connected').ctx.snap.pool, feedSettleUntil: NOW + 360 };
    expect(feedSettling(pool, NOW + 359)).toBe(true);
    expect(feedSettling(pool, NOW + 360)).toBe(false);
    expect(feedSettling({ ...pool, feedDisabled: true }, NOW)).toBe(false);
    expect(feedSettling({ ...pool, feedSettleUntil: 0 }, NOW)).toBe(false);
  });

  it('keeps the binding 5 copy outside the window', () => {
    expect(limitText(5, true)).toBe(SETTLING_EN);
    expect(limitText(5, false)).toBe('Paused or feed off');
    expect(limitText(4, true)).toBe('Backstop');
  });

  it('reads feedEnabledAt and FEED_SETTLE on the redeploy stack, and a failed read only hides the note', async () => {
    const circuit = { name: 'Policy', symbol: 'P', gates: 44, netlistHash: `0x${'00'.repeat(32)}` as const };
    const w = buildWorld();
    addAccount(w, ACCOUNT);
    const env: ReadEnv = { x: w.x, book: { ...MAINNET, redeploy: true }, lens: A(99) };
    w.x.on(MAINNET.pool, tapePoolAbi, { unvestedNow: 0n, vestEnd: 0n, perBorrowerAbs: 400_000_000n, lendLimit: [0n, 5], feedEnabledAt: BigInt(NOW - 100), FEED_SETTLE: 360n });
    const core = await readCore(env, w.x.number, ACCOUNT, null);
    expect(core.pool).toMatchObject({ feedEnabledAt: BigInt(NOW - 100), feedSettle: 360n });
    expect(mapPool(core.pool, core.pins!, circuit, env.book, NOW).feedSettleUntil).toBe(NOW + 260);
    const legacy = await readCore({ ...env, book: MAINNET }, w.x.number, ACCOUNT, null);
    expect(legacy.pool.feedEnabledAt).toBeUndefined();
    const cold = buildWorld();
    addAccount(cold, ACCOUNT);
    cold.x.on(MAINNET.pool, tapePoolAbi, { unvestedNow: 0n, vestEnd: 0n, perBorrowerAbs: 400_000_000n, lendLimit: [0n, 5] });
    const unread = await readCore({ ...env, x: cold.x }, cold.x.number, ACCOUNT, null);
    expect(unread.pool.feedEnabledAt).toBeNull();
    expect(mapPool(unread.pool, unread.pins!, circuit, env.book, NOW).feedSettleUntil).toBe(0);
  });

  it('shows the settling line on the borrow page instead of the binding 5 copy, and keeps Borrow off', () => {
    for (const [lang, line] of [['en', SETTLING_EN], ['cn', SETTLING_CN]] as const) {
      const m = make('feed-settling', { lang });
      must(m.text, line, `${lang} settling line`);
      const b = m.ctx.borrow!;
      expect(b.settling).toBe(true);
      expect(b.poolOpen).toBe(true);
      expect(b.canBorrow).toBe(false);
      mustNot(m.text, lang === 'en' ? 'Paused or feed off' : '借款暂停或数据源关闭', `${lang} binding 5 copy inside the window`);
    }
  });

  it('keeps the binding 5 copy once the window has passed', () => {
    const m = make('feed-settling');
    const snap = { ...m.ctx.snap, pool: { ...m.ctx.snap.pool, feedSettleUntil: m.ctx.snap.now } };
    expect(feedSettling(snap.pool, snap.now)).toBe(false);
    expect(limitText(snap.wallet.binding ?? 0, feedSettling(snap.pool, snap.now))).toBe('Paused or feed off');
  });
});

describe('RC3-02 the page banner and status while the feed settles', () => {
  const BANNER = [
    ['en', 'The rig data feed was just turned back on.', 'New borrows reopen in a few minutes. Open loans keep repaying.', 'The pool has no room for a new advance right now.'],
    ['cn', '矿机数据源刚刚重新开启。', '新借款将在几分钟后恢复，进行中的贷款照常还款。', '资金池当前没有可借额度。'],
  ] as const;

  it('gives the settling banner, never the no-room one, and the no-room fixtures keep theirs', () => {
    const settling = make('feed-settling').ctx.snap;
    expect(poolBanner(settling)).toBe('settling');
    expect(poolBanner(make('no-room').ctx.snap)).toBe('noroom');
    // once the window has passed, a room of 0 is a cap again
    expect(poolBanner({ ...settling, pool: { ...settling.pool, feedSettleUntil: settling.now } })).toBe('noroom');
    // a disabled feed still reads as feed off
    expect(poolBanner({ ...settling, pool: { ...settling.pool, feedDisabled: true } })).toBe('feedoff');
  });

  for (const hash of ['#/app/rigs/4127', '#/app/rigs']) {
    it(`shows the settling banner on ${hash} in English and Chinese`, () => {
      for (const [lang, bold, rest, noRoom] of BANNER) {
        const m = make('feed-settling', { hash, lang });
        must(m.text, bold, `${hash} ${lang} banner`);
        must(m.text, rest, `${hash} ${lang} banner line`);
        mustNot(m.text, noRoom, `${hash} ${lang} no-room banner`);
      }
    });
  }

  it('says why in the borrow summary and in the footer status instead of an empty or open state', () => {
    const m = make('feed-settling');
    mustNot(m.text, 'Choose a ready rig to see your advance and its full cost.', 'summary empty state');
    must(m.text, 'Borrows reopen in a few minutes', 'footer status');
    mustNot(m.text, 'Borrows open', 'footer open status');
    must(make('feed-settling', { lang: 'cn' }).text, '借款将在几分钟后恢复', 'footer status cn');
    must(make('connected').text, 'Borrows open', 'footer outside the window');
  });
});

describe('RC3-01 a seized voucher', () => {
  it('decodes SeizedVoucher(id) and says plainly that the voucher belongs to the pool', () => {
    const e = decodeRevert(encodeErrorResult({ abi: rigAgentAbi, errorName: 'SeizedVoucher', args: [4127n] }));
    expect(e).toMatchObject({ kind: 'revert', name: 'SeizedVoucher', params: { id: 4127 } });
    expect(errorText(e)).toBe('Voucher #4127 was seized with the loan. It belongs to the pool and cannot be taken back.');
    setLang('cn', false);
    expect(errorText(e)).toBe('凭证 #4127 已随贷款被没收，归资金池所有，无法取回。');
  });
});
