import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeCtx } from '../src/ctx';
import { createFixture } from '../src/fixtures/catalog';
import { setLang, type Lang } from '../src/i18n';
import type { ImpairmentKind, Snapshot } from '../src/model';
import { renderApp } from '../src/render';
import { impairmentClause } from '../src/render/loan';
import { parseHash } from '../src/route';
import type { DataSource } from '../src/source';
import { must, mustNot, textOf } from './helpers';

/** Render a fixture page after `patch` changed its snapshot, the way a chain source with such data would show it. */
function show(fixture: string, hash: string, patch: (s: Snapshot) => Snapshot, lang: Lang = 'en'): { html: string; text: string } {
  const f = createFixture(fixture, { clock: () => 0, reportDelayMs: 0 });
  const source: DataSource = { snapshot: (v) => patch(f.store.snapshot(v)), now: () => f.store.now(), subscribe: () => () => undefined };
  setLang(lang, false);
  const out = renderApp(makeCtx(source, f.ui, parseHash(hash), false));
  const html = out.screen.value + (out.modal?.value ?? '');
  return { html, text: textOf(html) };
}

describe('the flagged banner names what is wrong with the rig', () => {
  const EN: Record<ImpairmentKind, string> = {
    stopped: 'it stopped on BSC',
    inactive: 'it is no longer active on BSC',
    rescued: 'it is no longer in the vault on BSC',
    'no-power': 'it has no base power on BSC',
    unknown: 'it was proven impaired on-chain',
  };
  const CN: Record<ImpairmentKind, string> = {
    stopped: '在 BSC 上已停止',
    inactive: '在 BSC 上已不再处于活跃状态',
    rescued: '在 BSC 上已不在托管中',
    'no-power': '在 BSC 上已没有基础算力',
    unknown: '已被链上证明受损',
  };

  for (const kind of Object.keys(EN) as ImpairmentKind[]) {
    it(`${kind}, in both languages, in the cure window and in the seize window`, () => {
      const patch = (s: Snapshot): Snapshot => ({ ...s, loans: s.loans.map((l) => ({ ...l, impairment: kind })) });
      must(show('loan-flagged', '#/app/rigs/3871', patch, 'en').text, `is flagged: ${EN[kind]}`, `${kind} en`);
      must(show('loan-flagged', '#/app/rigs/3871', patch, 'cn').text, `已被标记：${CN[kind]}`, `${kind} cn`);
      // the other kinds do not leak into the banner
      const flagged = show('loan-flagged', '#/app/rigs/3871', patch, 'en').text;
      for (const other of ['stopped', 'inactive', 'rescued', 'no-power'] as const) if (other !== kind) mustNot(flagged, EN[other], `${kind} shows ${other}`);
      // the seize window does not word it again, but the page still renders
      must(show('loan-seize', '#/app/rigs/3871', patch, 'en').text, 'The cure window ended', 'seize');
      setLang('en', false);
      expect(impairmentClause(kind)).toBe(EN[kind]);
      setLang('cn', false);
      expect(impairmentClause(kind)).toBe(CN[kind]);
      setLang('en', false);
    });
  }

  it('a flag with no kind uses the generic line', () => {
    setLang('en', false);
    expect(impairmentClause(null)).toBe('it was proven impaired on-chain');
  });
});

describe('the first read', () => {
  const loading = (boot: NonNullable<Snapshot['boot']>) => (s: Snapshot): Snapshot => ({ ...s, boot });

  it('every page says it is reading, and draws no figure, until the pool is in', () => {
    for (const hash of ['#/app', '#/app/markets', '#/app/markets/bem', '#/app/rigs', '#/app/rigs/3871']) {
      const m = show('connected', hash, loading({ pool: 'loading' }));
      must(m.text, 'Reading from X Layer', hash);
      mustNot(m.text, 'Total Supplied', hash);
      mustNot(m.html, 'style=', hash);
    }
    must(show('connected', '#/app/markets', loading({ pool: 'loading' }), 'cn').text, '正在读取 X Layer 数据', 'cn');
  });

  it('says so when the first read failed, and keeps the page frame (header, language, footer)', () => {
    const m = show('connected', '#/app/markets', loading({ pool: 'failed' }));
    must(m.text, 'Could not reach X Layer.', 'failed');
    must(m.html, 'class="v2-hd"', 'header');
    must(m.html, 'class="v2-ft"', 'footer');
    must(show('connected', '#/app/markets', loading({ pool: 'failed' }), 'cn').text, '无法连接 X Layer', 'cn');
  });

  it('the account loading holds back the pages that are about the account, not the markets', () => {
    const acct = loading({ account: 'loading' });
    must(show('connected', '#/app', acct).text, 'Reading from X Layer', 'dashboard');
    must(show('connected', '#/app/rigs', acct).text, 'Reading from X Layer', 'rigs');
    const markets = show('connected', '#/app/markets', acct);
    must(markets.text, 'Total Supplied', 'markets');
    mustNot(markets.text, 'Reading from X Layer', 'markets');
    // a wallet page that is gated shows the connect card, not a loading card
    const gated = show('disconnected', '#/app', acct);
    must(gated.text, 'Connect your wallet', 'gate');
  });

  it('no modal opens over a loading page', () => {
    const m = show('connected', '#/app/supply', loading({ pool: 'loading' }));
    mustNot(m.text, 'Withdraw', 'modal');
  });
});

describe('rig data that came from the feed, not from BSC', () => {
  it('says "BSC data as of" with the time of the report, in both languages', () => {
    const patch = (s: Snapshot): Snapshot => ({
      ...s,
      rigs: s.rigs.map((r) => (r.id === 4127 ? { ...r, facts: { ...r.facts, bscAsOf: s.now - 3_600 } } : r)),
    });
    must(show('rigs-all', '#/app/rigs', patch).text, 'BSC data as of', 'en');
    must(show('rigs-all', '#/app/rigs', patch, 'cn').text, 'BSC 数据截至', 'cn');
    mustNot(show('rigs-all', '#/app/rigs', (s) => s).text, 'BSC data as of', 'no label when BSC was read');
  });
});

describe('a seized rig whose loan could not be recovered', () => {
  it('still says it was seized, instead of "cannot borrow yet"', () => {
    const noLoans = (s: Snapshot): Snapshot => ({ ...s, loans: s.loans.filter((l) => l.phase !== 'seized') });
    const m = show('rigs-all', '#/app/rigs/6020', noLoans);
    must(m.text, 'The voucher now belongs to the pool', 'seized');
    must(m.text, 'could not be read right now', 'details');
    mustNot(m.text, 'This rig cannot borrow yet', 'seized');
    must(show('rigs-all', '#/app/rigs/6020', noLoans, 'cn').text, '暂时无法读取该贷款的详细信息', 'cn');
  });
});

describe('production does not carry the fixtures', () => {
  const src = path.resolve(__dirname, '..', 'src');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));

  it('nothing outside src/fixtures and src/dev imports a fixture', () => {
    for (const f of walk(src)) {
      const rel = path.relative(src, f).replace(/\\/g, '/');
      if (rel.startsWith('fixtures/') || rel.startsWith('dev/')) continue;
      expect(fs.readFileSync(f, 'utf8'), rel).not.toMatch(/from '[./]+\/(fixtures|dev)\//);
    }
  });

  it('main.ts reaches the fixtures only through a dynamic import behind import.meta.env.DEV', () => {
    const main = fs.readFileSync(path.join(src, 'main.ts'), 'utf8');
    expect(main).not.toMatch(/import .* from '\.\/(fixtures|dev)/);
    expect(main).toMatch(/import\.meta\.env\.DEV && fixtureName !== null/);
    expect(main).toMatch(/import\('\.\/dev\/fixture'\)/);
  });

  it('sends transactions from one place only, simulates before it asks the wallet, and never signs a message', () => {
    const files = walk(src).map((f) => ({ rel: path.relative(src, f).replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }));
    // the app never asks a wallet to sign anything but a transaction
    for (const f of files) expect(f.text, f.rel).not.toMatch(/personal_sign|eth_signTypedData|eth_sign\b|signMessage|eth_sendRawTransaction/);
    // and only the transaction runner names eth_sendTransaction
    expect(files.filter((f) => /eth_sendTransaction/.test(f.text)).map((f) => f.rel)).toEqual(['chain/tx.ts']);
    const tx = files.find((f) => f.rel === 'chain/tx.ts')?.text ?? '';
    expect(tx.indexOf('this.preview(')).toBeGreaterThan(-1);
    expect(tx.indexOf('this.preview(')).toBeLessThan(tx.indexOf("method: 'eth_sendTransaction'"));
  });
});
