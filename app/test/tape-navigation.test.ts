// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHash } from '../src/route';
import { make } from './helpers';

const VIEW = '0x3f1c0000000000000000000000000000000093a2';
const ORIGIN = 'http://localhost:5173';

function header(search: string, hash = '#/app'): HTMLElement {
  vi.stubGlobal('location', { search });
  const root = document.createElement('div');
  root.innerHTML = make('disconnected', { hash }).html;
  return root.querySelector('header')!;
}
const tapeHref = (root: HTMLElement): string => root.querySelector<HTMLAnchorElement>('[data-local-tape]')!.getAttribute('href')!;

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('development Tape navigation', () => {
  it('exposes Tape as an ordinary route of the main app, with no fixture query', () => {
    const root = header('');
    const href = tapeHref(root), target = new URL(href, `${ORIGIN}/#/app`);
    expect(root.querySelector('[data-local-tape]')!.textContent).toBe('Tape');
    expect(href).toBe('#/app/tape');
    expect(target.origin).toBe(ORIGIN); expect(target.search).toBe(''); expect(target.hash).toBe('#/app/tape');
    expect(root.hasAttribute('data-local-nav')).toBe(true);
    expect(root.querySelector('.v2-nav a')!.getAttribute('href')).toBe('#/app');
  });

  it('keeps the current document, path and query, so the wallet and game session survive', () => {
    for (const search of ['?lang=cn&mode=compact', '?fixture=disconnected&lang=cn']) {
      const root = header(search, '#/app/markets'), base = new URL(`${ORIGIN}/nested/index.html${search}#/app/markets`);
      const target = new URL(tapeHref(root), base);
      expect(tapeHref(root)).toBe('#/app/tape');
      expect(target.pathname).toBe(base.pathname); expect(target.search).toBe(base.search); expect(target.hash).toBe('#/app/tape');
    }
  });

  it('keeps a read-only account view prefix like every other tab', () => {
    for (const search of ['', '?fixture=disconnected&lang=cn']) {
      const root = header(search, `#/app/view/${VIEW}`);
      const destinations = [...root.querySelectorAll<HTMLAnchorElement>('.v2-nav a')].map(a => a.getAttribute('href'));
      expect(destinations).toEqual([`#/app/view/${VIEW}`, `#/app/view/${VIEW}/markets`, `#/app/view/${VIEW}/rigs`, `#/app/view/${VIEW}/tape`]);
    }
    expect(parseHash(`#/app/view/${VIEW}/tape`)).toMatchObject({ page: 'trace', view: VIEW });
    expect(parseHash(`#/app/view/${VIEW}/trace`).redirect).toBe(`#/app/view/${VIEW}/tape`);
  });

  it('omits Tape navigation and both game routes in production', () => {
    vi.stubEnv('DEV', false);
    const root = header('?fixture=disconnected');
    expect(root.querySelector('[data-local-tape]')).toBeNull();
    expect(root.hasAttribute('data-local-nav')).toBe(false);
    expect([...root.querySelectorAll('.v2-nav a')].map(a => a.textContent)).not.toContain('Tape');
    expect(parseHash('#/app/tape').page).toBe('notfound');
    expect(parseHash('#/app/trace').page).toBe('notfound');
    expect(parseHash(`#/app/view/${VIEW}/tape`).page).toBe('notfound');
  });
});
