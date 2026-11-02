import type { AppError } from './chain/errors';
import type { Address, PrincipalQuote, TermIndex } from './model';
import type { Flash } from './source';

/** What the right column of the connect dialog shows. */
export type PickerView =
  /** "What is a Wallet?" and the way to get one. */
  | { kind: 'about' }
  /** Asking this wallet (`WalletOption.id`) to connect, or why it did not. */
  | { kind: 'connect'; id: string }
  /** How to get a wallet: the recommended ones, or one of them (`RecommendedKey`). */
  | { kind: 'get'; key: string | null };

/**
 * Screen state that no chain read can tell: what the user selected and typed.
 * Everything about agents, vouchers and reports comes from the snapshot, so a reload resumes the borrow flow.
 */
export interface UiState {
  /** Rig ids picked for the borrow flow. */
  sel: number[];
  /** The group page lets several rigs be picked. */
  group: boolean;
  term: TermIndex;
  /** The advance box; null shows the default. */
  amt: string | null;
  principalQuote: { agent: Address; term: TermIndex; principal: bigint; value: PrincipalQuote | null } | null;
  /** The agent the user created or chose to reuse in step 1. */
  agent: Address | null;
  reuse: boolean;
  sup: { tab: 'supply' | 'withdraw'; amount: string; wamount: string; /** MAX was pressed and the box still holds that value. */ wmax: boolean };
  rep: { amount: string | null };
  flash: Flash | null;
  /** The last failed action, shown under the step it belongs to. */
  error: AppError | null;
  /** After a keeper refusal or timeout: offer the self-push on BSC. */
  selfPush: boolean;
  /**
   * "Keep it in this loan" was pressed for this selection: the rig ids it applies to, ascending. It stands only for exactly
   * that selection and only until the page is reloaded (SPEC-PHASE5-PRELOAN §4.2); it is never stored.
   */
  keep: number[] | null;
  /** Rig ids that already had their choice in this flow (kept, or harvested first): the in-agent question does not ask about them again. */
  decided: number[];
  /** "Keep waiting" on a harvest that is stuck: the offer to move anyway stays hidden until this chain time. */
  hold: number;
  /** The connect dialog, while it is open: the wallet being asked (`WalletOption.id`), why the last try failed, and what the right column shows. */
  picker: { busy: string | null; error: AppError | null; view: PickerView } | null;
  /** The menu on the wallet pill is open. */
  menu: boolean;
  /** The last "copy address" in the menu: it worked (the "Copied!" bubble is up) or nothing could copy (the full address is shown to select). */
  copied: 'ok' | 'fail' | null;
}

export function freshUi(): UiState {
  return {
    sel: [],
    group: false,
    term: 0,
    amt: null,
    principalQuote: null,
    agent: null,
    reuse: false,
    sup: { tab: 'supply', amount: '2.0000', wamount: '1.0000', wmax: false },
    rep: { amount: null },
    flash: null,
    error: null,
    selfPush: false,
    keep: null,
    decided: [],
    hold: 0,
    picker: null,
    menu: false,
    copied: null,
  };
}

/** Clear what belongs to one borrow flow, keeping the selection and the term. */
export function resetFlow(ui: UiState): void {
  ui.amt = null;
  ui.principalQuote = null;
  ui.agent = null;
  ui.reuse = false;
  ui.error = null;
  ui.selfPush = false;
  ui.keep = null;
  ui.decided = [];
  ui.hold = 0;
}
