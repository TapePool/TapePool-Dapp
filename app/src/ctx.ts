import { deriveBorrow } from './logic/borrow';
import { rigById } from './logic/selectors';
import type { Snapshot } from './model';
import type { Ctx } from './render/ui';
import { linker, type Route } from './route';
import type { DataSource } from './source';
import { resetFlow, type UiState } from './state';

/** Keep the borrow selection on the rig the page shows. */
export function syncUi(ui: UiState, r: Route, snap: Snapshot): void {
  if (r.page === 'rig' && r.id !== null) {
    const rig = rigById(snap, r.id);
    const can = rig !== undefined && (rig.state.kind === 'ready' || rig.state.kind === 'in-agent');
    if (can && (ui.group || ui.sel.length !== 1 || ui.sel[0] !== r.id)) {
      ui.sel = [r.id];
      ui.group = false;
      resetFlow(ui);
    }
  } else if (r.page === 'group') {
    if (!ui.group) {
      ui.group = true;
      ui.sel = [];
      resetFlow(ui);
    }
  } else ui.group = false;
  if (ui.flash && !(r.page === 'rig' && r.id === ui.flash.rigId)) ui.flash = null;
  // the connect dialog is for a disconnected wallet and the pill menu for a connected one: when the wallet changes state under
  // an open one (a silent reconnect that finished, an account change), it closes
  const st = snap.wallet.status;
  if (ui.picker && st !== 'disconnected') ui.picker = null;
  if (ui.menu && st !== 'connected' && st !== 'wrong-network') ui.menu = false;
}

/** Everything a page needs, from the source and the screen state. */
export function makeCtx(source: DataSource, ui: UiState, route: Route, inFrame: boolean): Ctx {
  const snap = source.snapshot(route.view);
  syncUi(ui, route, snap);
  const borrow = route.page === 'rig' || route.page === 'group' ? deriveBorrow(snap, ui, snap.now) : null;
  return { snap, ui, route, now: snap.now, borrow, link: linker(route.view), readOnly: inFrame ? 'frame' : route.view ? 'view' : null };
}
