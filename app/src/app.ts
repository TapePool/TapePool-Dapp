import { isAddress } from 'viem/utils';
import { errorText } from './chain/errors';
import { copyText, type ClipboardLike } from './clipboard';
import { stopAscii, syncAscii } from './ascii';
import { applyDynamic, put } from './dom';
import { bem4Floor, parseAmount } from './logic/format';
import { getLang, setLang, t } from './i18n';
import { recommendedByKey } from './logic/wallets';
import { makeCtx } from './ctx';
import { deriveBorrow } from './logic/borrow';
import { debtOf, depositsClosed, isOpen, loanForRig, openLoanOfAgent, rigById } from './logic/selectors';
import { renderApp } from './render';
import type { Ctx } from './render/ui';
import { linker, parseHash, type Route } from './route';
import type { ActionResult, Actions, DataSource, Notice } from './source';
import { freshUi, resetFlow, type UiState } from './state';
import { supplyMaxText, withdrawMaxText } from './render/supply';

export interface AppDeps {
  /** The elements of `index.html`. */
  screen: HTMLElement;
  modal: HTMLElement;
  modalBox: HTMLElement;
  toast: HTMLElement;
  source: DataSource;
  actions: Actions;
  ui?: UiState;
  /** Shown inside another site? Write controls stay off. */
  inFrame: boolean;
  win?: Window;
  /** Where "Copy address" writes; the browser's clipboard when absent. */
  clipboard?: ClipboardLike;
  /** Run the hourglass text effects (src/ascii.ts). Off in tests, so the text stays plain. */
  ascii?: boolean;
}

/**
 * UI-only actions never reach `Actions`; the rest send something and are refused in a frame and in a read-only view.
 * `connect` (the Connect button) only opens the dialog; `pick-wallet` is the click on a wallet in it, `picker-get` and `picker-back`
 * change what its right column shows.
 */
const WALLET_ACTIONS = new Set(['pick-wallet', 'disconnect', 'switchnet']);
const WRITE_UI = new Set([
  'create',
  'move',
  'move-anyway',
  'move-stuck',
  'harvest-first',
  'take-back-harvest',
  'keep',
  'keep-agent',
  'hold',
  'refresh',
  'selfpush',
  'borrow',
  'approve-repay',
  'repay-do',
  'sweep',
  'release',
  'take-back',
  'register',
  'forget',
  'release-entry',
  'forget-entry',
  'claim',
  'approve-supply',
  'supply',
  'withdraw',
]);

/** How long "Keep waiting" hides the offer to move anyway (seconds): another ten minutes. */
const HOLD_FOR = 600;
const withIds = (a: readonly number[], b: readonly number[]): number[] => [...new Set([...a, ...b])].sort((x, y) => x - y);

/** How long the "Copied!" bubble beside the copy icon stays up. */
export const COPIED_MS = 1500;

export interface App {
  render(): void;
  dispatch(a: string, v: string | null): Promise<void>;
  ctx(): Ctx;
  destroy(): void;
  ui: UiState;
}

export function createApp(deps: AppDeps): App {
  const win = deps.win ?? window;
  const doc = win.document;
  const ui = deps.ui ?? freshUi();
  const { source, actions } = deps;
  let traceController: { unmount(): void; translate(): void } | undefined;
  let traceModule: typeof import('./dev/trace/view') | undefined;
  let traceSession: ReturnType<typeof import('./dev/trace/view').createTraceSession> | undefined;
  let traceGeneration = 0;
  let destroyed = false;
  let route: Route = parseHash(win.location.hash);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  let inflight = false;
  let lastKey: string | null = null;
  let quoteKey = '';
  let quoteRevision = 0;
  let quoteRequest = 0;
  let quoteTimer: ReturnType<typeof setTimeout> | undefined;
  /** The connect dialog just opened: the next render puts the focus in it. */
  let focusDialog = false;
  /** What had the focus when the dialog opened, to give it back when it closes. */
  let returnTo: HTMLElement | null = null;
  /**
   * The dialog changed what its right column shows: the next render puts the focus there (the clicked row may be out of sight on
   * a phone, which shows one column at a time), or back on the list.
   */
  let focusPane: 'right' | 'list' | null = null;

  function notice(n: Notice | string): void {
    deps.toast.textContent = typeof n === 'string' ? n : n();
    deps.toast.classList.add('tp-show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => deps.toast.classList.remove('tp-show'), 3200);
  }

  const buildCtx = (): Ctx => makeCtx(source, ui, route, deps.inFrame);

  function clearCopied(): void {
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = undefined;
    ui.copied = null;
  }

  function render(): void {
    // the bubble and the full address belong to an open menu
    if (!ui.menu && ui.copied !== null) clearCopied();
    const c = buildCtx();
    const b = c.borrow;
    if (source.quoteFor && b?.agent && b.report === 'fresh') {
      const agent = b.agent.address;
      const { term, amount } = b;
      const key = [c.snap.wallet.account, agent, term, amount.value, quoteRevision].join(':');
      if (key !== quoteKey) {
        quoteKey = key;
        const request = ++quoteRequest;
        if (quoteTimer) clearTimeout(quoteTimer);
        quoteTimer = setTimeout(() => {
          void source.quoteFor!(agent, term, amount.value).catch(() => null).then((value) => {
            if (destroyed || key !== quoteKey || request !== quoteRequest) return;
            ui.principalQuote = { agent, term, principal: amount.value, value };
            render();
          });
        }, 150);
      }
    } else {
      quoteKey = '';
      quoteRequest++;
      if (quoteTimer) clearTimeout(quoteTimer);
    }
    const out = renderApp(c);
    doc.documentElement.lang = getLang() === 'cn' ? 'zh-CN' : 'en';
    put(deps.screen, out.screen);
    if (import.meta.env.DEV && route.page === 'trace') {
      traceController?.translate();
      if (!traceController) {
        const generation = ++traceGeneration;
        void (traceModule ? Promise.resolve(traceModule) : import('./dev/trace/view')).then((mod) => {
          traceModule = mod;
          const host = deps.screen.querySelector<HTMLElement>('[data-trace-owned]');
          if (!destroyed && generation === traceGeneration && route.page === 'trace' && host && !traceController) traceController = (traceSession ??= mod.createTraceSession(() => new mod.OkxFeed())).mount(host);
        });
      }
    }
    deps.modalBox.classList.toggle('wide', out.wide);
    if (out.modal) {
      deps.modal.hidden = false;
      put(deps.modalBox, out.modal);
      if (focusDialog && ui.picker) {
        focusDialog = false;
        focusPane = null;
        deps.modalBox.querySelector<HTMLElement>('[role="dialog"]')?.focus();
      } else if (focusPane && ui.picker) {
        const to = focusPane === 'right' ? '.wview' : '.wl .wopt';
        focusPane = null;
        deps.modalBox.querySelector<HTMLElement>(to)?.focus();
      }
    } else {
      deps.modal.hidden = true;
      deps.modalBox.innerHTML = '';
    }
    applyDynamic(doc);
    if (deps.ascii) syncAscii(deps.screen);
    doc.title = out.title;
  }

  function onRoute(): void {
    const next = parseHash(win.location.hash);
    if (next.redirect !== null) {
      win.location.replace(next.redirect);
      return;
    }
    if (route.page === 'trace' && next.page !== 'trace') { traceGeneration++; traceController?.unmount(); traceController = undefined; }
    route = next;
    ui.error = null;
    ui.selfPush = false;
    const key = `${route.page}:${route.id ?? ''}:${route.view ?? ''}`;
    if (route.modal === 'repay' && lastKey !== `${key}|repay`) ui.rep.amount = null;
    render();
    if (lastKey === null || lastKey.split('|')[0] !== key) win.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    lastKey = `${key}|${route.modal ?? ''}`;
  }

  const go = (path: string): void => {
    win.location.hash = linker(route.view)(path);
  };

  /* ───────── the connect dialog and the wallet menu ───────── */

  const focusable = (sel: string): HTMLElement | null => doc.querySelector<HTMLElement>(sel);

  function openPicker(): void {
    ui.menu = false;
    ui.picker = { busy: null, error: null, view: { kind: 'about' } };
    returnTo = doc.activeElement as HTMLElement | null;
    focusDialog = true;
    render();
    // a wallet that announces itself late shows up in the list through the snapshot
    void actions.rescanWallets?.();
  }

  /** Give the focus back to what had it, or to the wallet button that replaced it. */
  function restoreFocus(): void {
    const back = returnTo && returnTo !== doc.body && doc.contains(returnTo) ? returnTo : focusable('[data-a="connect"], [data-a="menu"]');
    returnTo = null;
    back?.focus();
  }

  function closePicker(): void {
    if (!ui.picker) return;
    ui.picker = null;
    focusDialog = false;
    focusPane = null;
    render();
    restoreFocus();
  }

  /** The click on a wallet in the dialog: connect through THAT wallet. The id comes from the markup, so it must be one the dialog lists. */
  async function pickWallet(id: string | null): Promise<void> {
    const picker = ui.picker;
    if (!picker || picker.busy !== null || id === null) return;
    if (!buildCtx().snap.wallet.options?.some((o) => o.id === id)) return;
    picker.busy = id;
    picker.error = null;
    picker.view = { kind: 'connect', id };
    focusPane = 'right';
    render();
    await run(() => actions.connect(id));
    if (lastOk) {
      // the wallet connecting closes the dialog by itself (the snapshot is no longer "disconnected"); make sure, and give the focus back
      if (ui.picker === picker) ui.picker = null;
      render();
      restoreFocus();
      return;
    }
    if (ui.picker !== picker) return; // closed while the wallet was asking
    // the reason belongs in the dialog (on the wallet's panel, or above the one the reader moved to), not in the banner behind it
    picker.busy = null;
    picker.error = ui.error;
    ui.error = null;
    render();
  }

  function closeMenu(refocus: boolean): void {
    if (!ui.menu) return;
    ui.menu = false;
    render();
    if (refocus) focusable('[data-a="menu"]')?.focus();
  }

  /** Tab stays inside the open dialog. */
  function trapTab(e: KeyboardEvent): void {
    const box = deps.modalBox;
    const all = Array.from(box.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], summary'));
    // the phone layout hides one column, and a hidden control cannot take the focus; a page without layout (the tests) keeps them all
    const shown = all.filter((el) => el.getClientRects().length > 0);
    const items = shown.length > 0 ? shown : all;
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const at = doc.activeElement;
    const dialog = box.querySelector('[role="dialog"]');
    if (e.shiftKey && (at === first || at === dialog || !box.contains(at))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (at === last || !box.contains(at))) {
      e.preventDefault();
      first.focus();
    }
  }

  /* ───────── results ───────── */

  function applyResult(res: ActionResult): void {
    if (res.agent) {
      ui.agent = res.agent;
      ui.reuse = res.reuse === true;
    }
    if (res.decided) ui.decided = withIds(ui.decided, res.decided);
    if (res.flash) ui.flash = res.flash;
    if (!res.ok && res.error) {
      ui.error = res.error;
      ui.selfPush = res.offerSelfPush === true;
      notice(errorText(res.error));
    } else {
      ui.error = null;
      if (res.notice) notice(res.notice);
    }
    if (res.go !== undefined) {
      const target = linker(route.view)(res.go);
      if (win.location.hash === target) render();
      else {
        win.location.hash = target;
        // the route is read now, not when `hashchange` fires: the render that ends this action must already be on the new page,
        // or the page the result belongs to (a grouped loan opens on its lowest rig) clears the result's banner as a stale one
        onRoute();
      }
    }
  }

  let lastOk = false;
  async function run(fn: () => Promise<ActionResult>): Promise<void> {
    inflight = true;
    lastOk = false;
    try {
      const res = await fn();
      lastOk = res.ok;
      applyResult(res);
    } finally {
      inflight = false;
      render();
    }
  }

  /* ───────── dispatch ───────── */

  async function dispatch(a: string, v: string | null): Promise<void> {
    const c = buildCtx();
    const snap = c.snap;
    // UI-only actions
    switch (a) {
      case 'connect':
        if (!deps.inFrame) openPicker();
        return;
      case 'picker-close':
        closePicker();
        return;
      case 'menu': {
        const st = snap.wallet.status;
        if (deps.inFrame || (st !== 'connected' && st !== 'wrong-network')) return;
        ui.menu = !ui.menu;
        render();
        return;
      }
      case 'picker-get': {
        const p = ui.picker;
        if (!p) return;
        // the key comes from the markup: only a recommended wallet's key opens its page, anything else is the list
        p.view = { kind: 'get', key: recommendedByKey(v)?.key ?? null };
        p.error = null;
        focusPane = 'right';
        render();
        return;
      }
      case 'picker-back': {
        const p = ui.picker;
        if (!p) return;
        p.view = { kind: 'about' };
        p.error = null;
        focusPane = 'list';
        render();
        return;
      }
      case 'copy-addr': {
        const st = snap.wallet.status;
        const who = snap.wallet.account;
        if (deps.inFrame || !who || (st !== 'connected' && st !== 'wrong-network')) return;
        const done = await copyText(doc, who, deps.clipboard ?? win.navigator?.clipboard);
        if (copiedTimer) clearTimeout(copiedTimer);
        copiedTimer = undefined;
        ui.copied = done ? 'ok' : 'fail';
        if (done) {
          // the bubble beside the icon says so for a moment
          copiedTimer = setTimeout(() => {
            copiedTimer = undefined;
            if (ui.copied === 'ok') {
              ui.copied = null;
              render();
            }
          }, COPIED_MS);
        } else notice(() => t('Could not copy. Select the address and copy it by hand.', '无法复制，请选中地址后手动复制。'));
        render();
        return;
      }
      case 'lang':
        if (v === 'en' || v === 'cn') {
          setLang(v);
          render();
        }
        return;
      case 'go':
        if (v?.startsWith('#/app')) win.location.hash = v;
        return;
      case 'term': {
        ui.term = v === '1' ? 1 : 0;
        const b = deriveBorrow(snap, ui, c.now);
        if (b && ui.amt !== null && (parseAmount(ui.amt, 8) ?? 0n) > b.limits[ui.term].maxPrincipal) ui.amt = bem4Floor(b.limits[ui.term].maxPrincipal);
        render();
        return;
      }
      case 'max': {
        const b = deriveBorrow(snap, ui, c.now);
        if (b) ui.amt = bem4Floor(b.limits[b.term].maxPrincipal);
        render();
        return;
      }
      case 'reuse':
        if (v && snap.agents.some((x) => x.address.toLowerCase() === v.toLowerCase())) {
          ui.agent = snap.agents.find((x) => x.address.toLowerCase() === v.toLowerCase())?.address ?? null;
          ui.reuse = true;
        }
        render();
        return;
      case 'undoagent':
        ui.agent = null;
        ui.reuse = false;
        render();
        return;
      case 'suptab':
        ui.sup.tab = v === 'withdraw' ? 'withdraw' : 'supply';
        render();
        return;
      case 'supmax': {
        const room = snap.position ? snap.position.maxDeposit : 0n;
        ui.sup.amount = supplyMaxText(snap.wallet.bem, room);
        render();
        return;
      }
      case 'wdmax':
        ui.sup.wamount = withdrawMaxText(snap.position?.withdrawable ?? 0n);
        ui.sup.wmax = true;
        render();
        return;
      case 'repmax':
        ui.rep.amount = null;
        render();
        return;
      case 'retry':
        // read BSC again (BEM mined before a loan could not be read): nothing is sent
        void source.refresh?.();
        return;
      case 'repay':
        go(`/rigs/${Number(v)}/repay`);
        return;
    }

    if (inflight) return;
    // wallet actions
    if (WALLET_ACTIONS.has(a)) {
      if (deps.inFrame) return;
      if (a === 'pick-wallet') return pickWallet(v);
      ui.menu = false;
      await run(() => (a === 'disconnect' ? actions.disconnect() : actions.switchNetwork()));
      return;
    }
    if (!WRITE_UI.has(a)) return;
    // never send from a frame or a read-only view, whatever the markup says
    if (c.readOnly !== null || snap.wallet.status !== 'connected') return;

    const b = c.borrow;
    const rigId = v !== null && /^\d+$/.test(v) ? Number(v) : null;
    const loanFor = (id: number | null) => (id === null ? undefined : loanForRig(snap, id));
    switch (a) {
      case 'create':
        return run(() => actions.createAgent());
      case 'move':
      case 'move-anyway':
      case 'move-stuck': {
        if (!b?.agent) return;
        const agent = b.agent;
        const todo = b.ids.filter((i) => !agent.collateral.includes(i));
        const s2 = b.mined.step2;
        // the button is off in these cases and nothing is sent from a click on a stale screen; the action checks them again from fresh reads
        if (a === 'move' && !s2.canMove) return;
        if (a === 'move-anyway' && !(s2.kind === 'unreadable' && s2.gateOpen)) return;
        if (a === 'move-stuck' && !s2.stuck) return;
        const via = a === 'move-stuck' ? 'stuck' : a === 'move-anyway' ? 'read-failed' : s2.keep ? 'keep' : null;
        return run(() => actions.moveVouchers(agent.address, todo, { debt: b.mined.debt, via }));
      }
      case 'keep': {
        // "Keep it in this loan": remembered for this selection until it changes or the page reloads; nothing is sent
        const s2 = b?.mined.step2;
        if (!s2 || s2.kind !== 'choice' || s2.busy) return;
        ui.keep = [...s2.ids];
        ui.decided = withIds(ui.decided, s2.ids);
        render();
        return;
      }
      case 'keep-agent': {
        // the same for rigs that are already in the agent (SPEC-PHASE5-PRELOAN §4.7)
        const s3 = b?.mined.step3;
        if (!s3 || (s3.kind !== 'ask' && s3.kind !== 'unreadable')) return;
        ui.decided = withIds(ui.decided, s3.ids);
        render();
        return;
      }
      case 'hold':
        ui.hold = c.now + HOLD_FOR;
        render();
        return;
      case 'harvest-first': {
        const s2 = b?.mined.step2;
        if (!b || !s2 || (s2.kind !== 'choice' && s2.kind !== 'info') || s2.option.off !== null || s2.busy || s2.harvestIds.length === 0) return;
        const agentAddr = b.agent?.address ?? null;
        return run(() => actions.harvestFirst(s2.harvestIds, agentAddr));
      }
      case 'take-back-harvest': {
        const s3 = b?.mined.step3;
        if (!b?.agent || !s3 || s3.kind !== 'ask' || s3.ids.length === 0) return;
        const agentAddr = b.agent.address;
        return run(() => actions.takeBackToHarvest(agentAddr, s3.ids));
      }
      case 'refresh': {
        if (!b?.agent) return;
        const agent = b.agent;
        return run(() => actions.refreshRigData(agent.address, [...agent.collateral]));
      }
      case 'selfpush': {
        if (!b?.agent) return;
        const agent = b.agent;
        return run(() => actions.selfPush([...agent.collateral]));
      }
      case 'borrow': {
        if (!b?.agent || !b.canBorrow) return;
        const args = { agent: b.agent.address, term: b.term, principal: b.amount.value, maxFee: b.amount.fee, maxLateBps: b.lateBps, opsFee: b.opsFee, ids: [...b.agent.collateral] };
        await run(async () => {
          const res = await actions.borrow(args);
          if (res.ok) {
            ui.sel = [];
            resetFlow(ui);
          }
          return res;
        });
        return;
      }
      case 'approve-repay':
      case 'repay-do': {
        const L = loanFor(rigId);
        if (!L || !isOpen(L)) return;
        const d = debtOf(L);
        const need = d > L.agentBem ? d - L.agentBem : 0n;
        const typed = ui.rep.amount === null ? need : (parseAmount(ui.rep.amount, 8) ?? 0n);
        const pay = typed < need ? typed : need;
        if (pay <= 0n || pay > snap.wallet.bem) return;
        const full = pay >= need;
        // the late fee grows by the day: a full repayment carries one more day, and `repay` never pulls more than owed
        const margin = full && L.lateBpsPerDay > 0 ? (L.principal * BigInt(L.lateBpsPerDay) + 9_999n) / 10_000n : 0n;
        const amount = pay + margin;
        return run(() => (a === 'approve-repay' ? actions.approveRepay(L.agent, amount) : actions.repay(L.agent, amount, full)));
      }
      case 'sweep': {
        const L = loanFor(rigId);
        if (L) return run(() => actions.sweep(L.agent));
        return;
      }
      case 'release-entry':
      case 'forget-entry': {
        const [address, id] = (v ?? '').split('/');
        const ag = snap.agents.find((x) => x.address.toLowerCase() === address?.toLowerCase());
        if (!ag || ag.closed || openLoanOfAgent(snap, ag.address)) return;
        if (a === 'release-entry') return run(() => actions.release(ag.address));
        if (ag.collateral.includes(Number(id))) return run(() => actions.forget(ag.address, Number(id)));
        return;
      }
      case 'release':
      case 'take-back':
      case 'register':
      case 'forget': {
        const r = rigId === null ? undefined : rigById(snap, rigId);
        const p = r?.facts.place;
        if (!r || !p || p.kind === 'wallet') return;
        const agent = p.agent;
        if (a === 'release') return run(() => actions.release(agent));
        if (a === 'register' && p.kind === 'agent' && !p.loanOpen) return run(() => actions.register(agent, r.id));
        if (a === 'forget' && p.kind === 'agent' && !p.loanOpen) return run(() => actions.forget(agent, r.id));
        if (a === 'register' || a === 'forget') return;
        return run(() => actions.takeBack(agent, r.id));
      }
      case 'claim': {
        const ag = v ? snap.agents.find((x) => x.address.toLowerCase() === v.toLowerCase() && isAddress(x.address)) : undefined;
        if (ag && !openLoanOfAgent(snap, ag.address)) return run(() => actions.claimLate(ag.address));
        return;
      }
      case 'approve-supply':
      case 'supply': {
        if (depositsClosed(snap.pool)) return;
        const amount = parseAmount(ui.sup.amount, 8);
        if (!amount || amount <= 0n || amount > snap.wallet.bem) return;
        await run(() => (a === 'supply' ? actions.supply(amount) : actions.approveSupply(amount)));
        if (a === 'supply' && lastOk && route.modal) go('');
        return;
      }
      case 'withdraw': {
        const amount = parseAmount(ui.sup.wamount, 8);
        const max = snap.position?.withdrawable ?? 0n;
        if (!amount || amount <= 0n || amount > max) return;
        const all = ui.sup.wmax && amount === max;
        await run(() => actions.withdraw(amount, all));
        if (lastOk && route.modal) go('');
        return;
      }
    }
  }

  /* ───────── events ───────── */

  function onClick(e: Event): void {
    const target = e.target as Element | null;
    // a click anywhere but the wallet pill and its menu closes the menu, and then does what it was going to do
    if (ui.menu && !target?.closest('.acct')) {
      ui.menu = false;
      render();
    }
    const el = target?.closest<HTMLElement>('[data-a]');
    if (!el || !deps.screen.parentElement?.contains(el)) return;
    if (el.tagName === 'INPUT') return; // checkboxes act on change
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return;
    if (el.tagName === 'TR' && target?.closest('button,a')) return; // row buttons have their own action
    if (el.tagName !== 'A') e.preventDefault();
    void dispatch(el.getAttribute('data-a') ?? '', el.getAttribute('data-v'));
  }

  function onChange(e: Event): void {
    const el = e.target as HTMLElement | null;
    const pick = el?.getAttribute('data-pick');
    if (!el || pick === null || pick === undefined) return;
    const id = Number(pick);
    if (ui.group) {
      const i = ui.sel.indexOf(id);
      if (i >= 0) ui.sel.splice(i, 1);
      else ui.sel.push(id);
    } else ui.sel = [id];
    ui.amt = null;
    resetFlow(ui);
    render();
  }

  function onInput(e: Event): void {
    const el = e.target as HTMLInputElement | null;
    const path = el?.getAttribute?.('data-in');
    if (!el || !path) return;
    const value = el.value;
    if (path === 'b.amt') ui.amt = value;
    else if (path === 'sup.amount') ui.sup.amount = value;
    else if (path === 'sup.wamount') {
      ui.sup.wamount = value;
      ui.sup.wmax = false;
    } else if (path === 'rep.amount') ui.rep.amount = value;
    else return;
    render();
  }

  function closeModal(): void {
    go(route.page === 'rig' && route.id !== null ? `/rigs/${route.id}` : '');
  }

  const onBackdrop = (e: Event): void => {
    if (e.target !== deps.modal) return;
    if (ui.picker) closePicker();
    else closeModal();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      // the innermost thing first: the connect dialog, then the wallet menu, then the page's own modal
      if (ui.picker) closePicker();
      else if (ui.menu) closeMenu(true);
      else if (!deps.modal.hidden) closeModal();
    } else if (e.key === 'Tab' && ui.picker) trapTab(e);
  };
  const onHash = (): void => {
    // another page closes the wallet menu; the same page (a hash set to what it already was) leaves it open
    const next = parseHash(win.location.hash);
    if (next.page !== route.page || next.id !== route.id || next.view !== route.view || next.modal !== route.modal) ui.menu = false;
    onRoute();
  };

  doc.addEventListener('click', onClick);
  doc.addEventListener('change', onChange);
  doc.addEventListener('input', onInput);
  doc.addEventListener('keydown', onKey);
  deps.modal.addEventListener('click', onBackdrop);
  win.addEventListener('hashchange', onHash);
  const unsubscribe = source.subscribe(() => { quoteRevision++; ui.principalQuote = null; render(); });
  // a transaction that was in flight when the page was reloaded has been mined: say how it ended
  const offSettled = source.onSettled?.((s) =>
    notice(() => (s.success ? t('Your earlier transaction was confirmed.', '您之前的交易已确认。') : t('Your earlier transaction failed on-chain. Nothing changed except the network fee.', '您之前的交易在链上执行失败，除网络费用外没有任何变化。'))),
  );
  // the borrow countdown and the "waiting" spinner move with the clock
  const tick = setInterval(() => {
    if ((route.page === 'rig' || route.page === 'group') && deps.screen.querySelector('.cd, .spin')) render();
  }, 1000);
  const poll = source.refresh ? setInterval(() => { if (doc.visibilityState !== 'hidden') void source.refresh?.(); }, 15_000) : undefined;

  onRoute();

  return {
    render,
    dispatch,
    ctx: buildCtx,
    ui,
    destroy() {
      destroyed = true; traceGeneration++; traceController?.unmount(); traceSession?.dispose();
      if (quoteTimer) clearTimeout(quoteTimer);
      stopAscii();
      doc.removeEventListener('click', onClick);
      doc.removeEventListener('change', onChange);
      doc.removeEventListener('input', onInput);
      doc.removeEventListener('keydown', onKey);
      deps.modal.removeEventListener('click', onBackdrop);
      win.removeEventListener('hashchange', onHash);
      unsubscribe();
      offSettled?.();
      clearInterval(tick);
      if (poll) clearInterval(poll);
      if (toastTimer) clearTimeout(toastTimer);
      if (copiedTimer) clearTimeout(copiedTimer);
    },
  };
}

