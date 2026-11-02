import { createApp, type AppDeps } from '../app';
import { createFixture, DEFAULT_FIXTURE } from '../fixtures/catalog';

/**
 * Development only: run the app on a fixture (`?fixture=<name>`, see src/fixtures/catalog.ts) so every page and
 * state can be looked at without a chain. `main.ts` reaches this module through a dynamic import behind
 * `import.meta.env.DEV`, so the production build contains neither this file nor the fixtures.
 */
export function bootFixture(name: string | null, els: Pick<AppDeps, 'screen' | 'modal' | 'modalBox' | 'toast'>, inFrame: boolean): void {
  const fixture = createFixture(name || DEFAULT_FIXTURE);
  if (!location.hash) history.replaceState(null, '', `${location.pathname}${location.search}${fixture.def.hash}`);
  createApp({ ...els, source: fixture.store, actions: fixture.store, ui: fixture.ui, inFrame, ascii: true });
}
