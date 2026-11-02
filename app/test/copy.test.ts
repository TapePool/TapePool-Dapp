import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allHashes, fixtureNames, make, must, mustNot } from './helpers';

const ROOT = path.resolve(__dirname, '..');
const AUDIT = /audit|审计/i;

describe('settled copy decisions', () => {
  it('S-3: no audit wording anywhere, in English or Chinese', () => {
    const pages = [
      ...fixtureNames.map((n): [string, string] => [n, '']),
      ...allHashes('rigs-all').map((h): [string, string] => ['rigs-all', h]),
    ];
    for (const [name, hash] of pages) {
      for (const lang of ['en', 'cn'] as const) {
        const m = make(name, { hash: hash || undefined, lang });
        mustNot(m.text, AUDIT, `${name} ${hash} ${lang}`);
      }
    }
  });

  it('S-3: the risk line is the plain one', () => {
    must(make('pool-page', { lang: 'en' }).text, 'Smart contracts carry risk. You can lose funds.', 'risk');
    must(make('pool-page', { lang: 'cn' }).text, '智能合约存在风险，您可能损失资金。', 'risk');
  });

  it('S-2: every FabX and FAB placeholder stays, with its Coming soon tag', () => {
    for (const lang of ['en', 'cn'] as const) {
      const soon = lang === 'en' ? 'Coming soon' : '即将上线';
      for (const hash of ['#/app', '#/app/markets', '#/app/rigs', '#/app/supply']) {
        const m = make('connected', { hash, lang });
        must(m.text, 'FAB', `${hash} ${lang}`);
        must(m.text, soon, `${hash} ${lang}`);
        must(m.html, 'fabx', `${hash} ${lang}`);
      }
      // the footer names FabX on every page
      must(make('connected', { hash: '#/app/markets/bem', lang }).text, 'FabX', 'footer');
    }
    must(make('connected', { hash: '#/app/markets', lang: 'cn' }).text, 'FabX 矿机的 FAB 资金池正在计划中，尚未上线，目前无法存入或借款。', 'tooltip');
  });

  it('S-6: the Alerts card keeps its button, off, with a Coming soon tag', () => {
    const m = make('connected', { hash: '#/app/rigs' });
    must(m.html, '<button type="button" class="btn btn-x" disabled>Turn on Telegram alerts</button>', 'alerts');
    must(m.html, 'Telegram alerts are planned. They are not live yet.', 'alerts tag');
    // the tag on this card must not carry the FAB pool tooltip
    const tag = /<span class="soon" title="Telegram alerts[^"]*">Coming soon<\/span>/;
    expect(tag.test(m.html)).toBe(true);
    mustNot(make('connected', { hash: '#/app/rigs/3871' }).html.split('Alerts')[1] ?? '', /FAB pool/, 'alerts tooltip');
    mustNot(m.html, 'data-a="alerts"', 'alerts');
  });

  it('O-5 option C: a static note with the one confirmed handle, and no request button', () => {
    for (const lang of ['en', 'cn'] as const) {
      const m = make('screen-note', { lang });
      must(m.html, 'https://x.com/Tape_Pool', 'link');
      mustNot(m.text, /Send request|提交申请|Prototype|原型/, 'request');
    }
    must(make('screen-note', { lang: 'en' }).text, 'Every rig needs a screen pass before it can borrow. The TapePool team screens new rigs; a pass counts 48 h after it is recorded on-chain.', 'note');
  });

  it('the prototype states panel and the prototype notices are gone', () => {
    for (const name of ['connected', 'flow-fresh', 'loan-active']) {
      const m = make(name);
      mustNot(m.html, /Prototype states|tp-pp|\(Not in this prototype/, name);
    }
  });

  it('§17: the corrected sentences are in', () => {
    const pool = make('pool-page').text;
    must(pool, 'The owner can lower caps at once. Every other change, fees included, waits 48 h in a public queue, within hard limits in the code. No one can move pool funds or vouchers.', 'admin line');
    const swap = make('swap-queued').text;
    must(swap, 'stay paused until the owner resumes them after the switch', 'swap banner');
    for (const n of ['flow-idle', 'flow-fresh', 'flow-expired', 'flow-waiting']) mustNot(make(n).text, /refreshes left|No free refreshes/i, n);
  });

  it('§7.4: the cost line is the BEM part and the OKB fee beside it, with no price', () => {
    const t = make('flow-fresh').text;
    must(t, 'BEM fee ', 'cost line');
    must(t, 'of the advance, ≈ ', 'cost line');
    must(t, 'a year', 'cost line');
    must(t, 'Plus 0.031 OKB per loan, not included in this percentage', 'cost line');
    mustNot(t, /\$/, 'price');
    const cn = make('flow-fresh', { lang: 'cn' }).text;
    must(cn, '折合每年约', 'cost line cn');
    must(cn, '另付 0.031 OKB 运营费，不计入此百分比', 'cost line cn');
  });

  it('keeps the Chinese words the checker bans out of the markup too', () => {
    for (const name of ['connected', 'flow-fresh', 'loan-late', 'loan-flagged', 'rigs-all']) {
      const t = make(name, { lang: 'cn' }).text;
      mustNot(t, /年化|APY|APR|收益率|已审计|经审计|无清算|零清算|无风险|[!！]/, `${name} cn`);
    }
  });
});

describe('fonts and packaging (§10)', () => {
  it('has no web font or third-party link in the page', () => {
    const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    expect(page).not.toMatch(/googleapis|gstatic|cdn\.|https?:\/\/(?!x\.com)/);
    expect(page).not.toMatch(/<style|<script(?![^>]*src=)/);
    expect(page).not.toMatch(/\sstyle\s*=/);
  });

  it('self-hosts the latin subsets of Sora (400, 600) and JetBrains Mono (500) as woff2, and ships no weight the CSS never asks for', () => {
    const css = fs.readFileSync(path.join(ROOT, 'src/styles/fonts.css'), 'utf8');
    for (const f of ['sora-latin-400-normal', 'sora-latin-600-normal', 'jetbrains-mono-latin-500-normal']) {
      expect(css).toContain(`${f}.woff2`);
      expect(fs.existsSync(path.join(ROOT, 'src/assets/fonts', `${f}.woff2`))).toBe(true);
    }
    expect(css).not.toMatch(/https?:/);
    expect(css).not.toContain('sora-latin-300');
    expect(fs.existsSync(path.join(ROOT, 'src/assets/fonts/sora-latin-300-normal.woff2'))).toBe(false);
    // no rule of the app asks for Sora 300
    for (const sheet of ['design.css', 'app.css', 'utilities.css']) expect(fs.readFileSync(path.join(ROOT, 'src/styles', sheet), 'utf8')).not.toMatch(/font-weight:\s*300/);
    expect(fs.existsSync(path.join(ROOT, 'src/assets/fonts/OFL-Sora.txt'))).toBe(true);
  });

  it('keeps the CJK system font stack of the prototype', () => {
    const css = fs.readFileSync(path.join(ROOT, 'src/styles/app.css'), 'utf8');
    expect(css).toContain("'Sora','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC'");
  });

  it('puts no inline style anywhere in the source markup', () => {
    for (const dir of ['render', '.']) {
      for (const f of fs.readdirSync(path.join(ROOT, 'src', dir)).filter((x) => x.endsWith('.ts'))) {
        const src = fs.readFileSync(path.join(ROOT, 'src', dir, f), 'utf8');
        expect(src, `${dir}/${f}`).not.toMatch(/\sstyle=/);
      }
    }
  });

  it('pins every dependency to an exact version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
    for (const group of ['dependencies', 'devDependencies']) {
      for (const [name, v] of Object.entries(pkg[group] ?? {})) expect(v, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@ascii-reveal/core', 'viem']);
    expect(fs.existsSync(path.join(ROOT, 'package-lock.json'))).toBe(true);
    expect(fs.readFileSync(path.join(ROOT, '.npmrc'), 'utf8')).toContain('save-exact=true');
  });
});
