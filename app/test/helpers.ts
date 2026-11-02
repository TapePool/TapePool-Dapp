import { makeCtx } from '../src/ctx';
import { createFixture, FIXTURES, type Fixture } from '../src/fixtures/catalog';
import { setLang, type Lang } from '../src/i18n';
import { renderApp } from '../src/render';
import type { Ctx } from '../src/render/ui';
import { parseHash } from '../src/route';

export interface Made {
  fixture: Fixture;
  ctx: Ctx;
  /** Screen and modal markup, joined. */
  html: string;
  /** The same with the tags dropped and the entities decoded. */
  text: string;
}

/** Plain text of some markup. */
export const textOf = (markup: string): string =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

/** Fail with a short message instead of a dump of the page. */
export function must(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) throw new Error(`${label}: missing "${needle}"`);
}

export function mustNot(haystack: string, needle: string | RegExp, label: string): void {
  const found = typeof needle === 'string' ? haystack.includes(needle) : needle.test(haystack);
  if (found) throw new Error(`${label}: unexpected ${String(needle)}`);
}

/** Render one fixture on one hash, in one language, with a frozen clock. */
export function make(name: string, o: { hash?: string; lang?: Lang; inFrame?: boolean } = {}): Made {
  const fixture = createFixture(name, { clock: () => 0, reportDelayMs: 0 });
  setLang(o.lang ?? 'en', false);
  const route = parseHash(o.hash ?? fixture.def.hash);
  const ctx = makeCtx(fixture.store, fixture.ui, route, o.inFrame ?? false);
  const out = renderApp(ctx);
  const html = out.screen.value + (out.modal?.value ?? '');
  return { fixture, ctx, html, text: textOf(html) };
}

export const fixtureNames = Object.keys(FIXTURES);

/** Every page and modal a fixture can show, as hashes. */
export function allHashes(name: string): string[] {
  const fixture = createFixture(name, { clock: () => 0 });
  const snap = fixture.store.snapshot(null);
  const rigIds = snap.rigs.map((r) => r.id);
  const loanLead = snap.loans.map((l) => l.rigIds[0] ?? 0);
  return [
    fixture.def.hash,
    '#/app',
    '#/app/markets',
    '#/app/markets/bem',
    '#/app/rigs',
    '#/app/rigs/group',
    '#/app/supply',
    '#/app/withdraw',
    '#/app/rigs/99999',
    '#/app/nothing',
    ...rigIds.map((id) => `#/app/rigs/${id}`),
    ...rigIds.map((id) => `#/app/rigs/${id}/screen`),
    ...loanLead.map((id) => `#/app/rigs/${id}/repay`),
  ];
}
