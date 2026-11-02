import { isAddress } from 'viem/utils';
import type { Address } from './model';

export type Page = 'dash' | 'markets' | 'pool' | 'rigs' | 'group' | 'rig' | 'notfound' | 'trace';
export type Modal = 'supply' | 'withdraw' | 'repay' | 'screen';

export interface Route {
  page: Page;
  /** Rig id for the rig page. */
  id: number | null;
  modal: Modal | null;
  /** The address of a read-only view (`#/app/view/<address>`). */
  view: Address | null;
  /** Set when the hash should be replaced by this one. */
  redirect: string | null;
}

const base = (page: Page, view: Address | null, extra: Partial<Route> = {}): Route => ({
  page,
  id: null,
  modal: null,
  view,
  redirect: null,
  ...extra,
});

/** `#/app` plus the read-only prefix, so links keep the view mode. */
export function linker(view: Address | null): (path?: string) => string {
  const prefix = view ? `#/app/view/${view}` : '#/app';
  return (path = '') => prefix + path;
}

const isRigId = (s: string): boolean => /^(0|[1-9]\d{0,14})$/.test(s);

export function parseHash(hash: string): Route {
  if (!hash.startsWith('#/app')) return base('dash', null, { redirect: '#/app' });
  const rest = hash.slice(5);
  if (rest !== '' && !rest.startsWith('/')) return base('notfound', null);
  let p = rest.split('/').filter(Boolean);
  let view: Address | null = null;
  if (p[0] === 'view') {
    const a = p[1];
    if (a === undefined || !isAddress(a)) return base('notfound', null);
    view = a;
    p = p.slice(2);
  }
  const to = linker(view);
  const [a, b, c] = p;
  if (a === undefined) return base('dash', view);
  if ((a === 'supply' || a === 'withdraw') && p.length === 1) return base('dash', view, { modal: a });
  if (import.meta.env.DEV && a === 'trace' && p.length === 1) return base('trace', view, { redirect: to('/tape') });
  if (import.meta.env.DEV && a === 'tape' && p.length === 1) return base('trace', view);
  if (a === 'markets' && p.length === 1) return base('markets', view);
  if (a === 'markets' && b === 'bem' && p.length === 2) return base('pool', view);
  if ((a === 'borrow' || a === 'loans') && p.length === 1) return base('rigs', view, { redirect: to('/rigs') });
  if (a === 'rigs') {
    if (p.length === 1) return base('rigs', view);
    if (b === 'group' && p.length === 2) return base('group', view);
    if (b !== undefined && isRigId(b)) {
      const id = Number(b);
      if (p.length === 2) return base('rig', view, { id });
      if ((c === 'repay' || c === 'screen') && p.length === 3) return base('rig', view, { id, modal: c });
    }
  }
  return base('notfound', view);
}
