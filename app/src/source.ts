import type { AppError } from './chain/errors';
import type { Address, PrincipalQuote, Sec, Snapshot, TermIndex } from './model';

/**
 * The two seams between the screens and the world.
 * B1 implements both with fixtures; B2 adds chain reads behind `DataSource`; B4 adds the wallet behind `Actions`.
 */

export interface DataSource {
  /** The current read. With `view` set, the read is for that address and the wallet is read-only. */
  snapshot(view: Address | null): Snapshot;
  quoteFor?(agent: Address, term: TermIndex, principal: bigint): Promise<PrincipalQuote | null>;
  /** X Layer time in seconds, advancing between reads. Never the browser clock alone. */
  now(): Sec;
  /** Called whenever `snapshot` has new content. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Re-read now (a refresh timer, or after a confirmed transaction). Optional for static sources. */
  refresh?(): Promise<void>;
  /** A transaction that was in flight when the page was reloaded has been mined. Optional for static sources. */
  onSettled?(listener: (s: Settled) => void): () => void;
}

/** The outcome of a transaction the page found pending after a reload. */
export interface Settled {
  action: string;
  success: boolean;
  hash: string;
}

/** A toast, translated when it is shown. */
export type Notice = () => string;

/** A one-line result banner on the rig page, kept as data so a language switch re-translates it. */
export type Flash =
  | { kind: 'borrowed'; rigId: number; ids: number[]; amount: bigint; maturity: Sec; opsFee: bigint }
  | { kind: 'released'; rigId: number; ids: number[]; agent?: Address };

export interface ActionResult {
  ok: boolean;
  notice?: Notice;
  error?: AppError;
  /** The agent that was created (step 1). */
  agent?: Address;
  flash?: Flash;
  /** An app path to open next, such as `/rigs/3871`. */
  go?: string;
  /** The keeper timed out or refused: offer the self-push on BSC. */
  offerSelfPush?: boolean;
  /** The agent is empty and in use again (its vouchers were taken back): the first step reads "Using your empty agent". */
  reuse?: boolean;
  /** Rig ids whose BEM mined before the loan had its choice made in this flow (a harvest was sent for them). */
  decided?: number[];
}

/**
 * What the move needs to know from the screen (SPEC-PHASE5-PRELOAN §4.1, §4.4). The action cannot see the screen, but it checks
 * the requirement again from fresh reads, so the screen tells it the debt the share is measured against and which button led
 * here: the choice "Keep it in this loan", the "Move anyway" of a read that failed, the "Move anyway" of a harvest that never
 * settled, or none of them.
 */
export interface MoveOptions {
  debt: bigint;
  via: 'keep' | 'read-failed' | 'stuck' | null;
}

export interface BorrowArgs {
  agent: Address;
  term: TermIndex;
  principal: bigint;
  maxFee: bigint;
  maxLateBps: number;
  /** The operating fee, in wei of OKB, that was read in this session. */
  opsFee: bigint;
  ids: number[];
}

/** One method per button in SPEC-PHASE5-APP §6. All are async, and none throws: a failure is `ok: false` with an `AppError`. */
export interface Actions {
  /** `id` is the `WalletOption.id` picked in the connect dialog: connect through that wallet. */
  connect(id?: string): Promise<ActionResult>;
  disconnect(): Promise<ActionResult>;
  switchNetwork(): Promise<ActionResult>;
  /** The connect dialog is open: look for wallets that announce themselves late. The list reaches the screen through the snapshot. */
  rescanWallets?(): Promise<void>;

  createAgent(): Promise<ActionResult>;
  moveVouchers(agent: Address, ids: number[], o: MoveOptions): Promise<ActionResult>;
  /** Harvest the BEM these rigs mined to the wallet first: `RigVault.harvest(ids)` on BSC, from the user's wallet (§4.3). `agent` is the flow's agent, if it has one. */
  harvestFirst(ids: number[], agent: Address | null): Promise<ActionResult>;
  /** §4.7: take rigs out of the agent to harvest them before they work for a loan. The agent stays the flow's agent. */
  takeBackToHarvest(agent: Address, ids: number[]): Promise<ActionResult>;
  refreshRigData(agent: Address, ids: number[]): Promise<ActionResult>;
  selfPush(ids: number[]): Promise<ActionResult>;
  borrow(args: BorrowArgs): Promise<ActionResult>;

  approveRepay(agent: Address, amount: bigint): Promise<ActionResult>;
  repay(agent: Address, amount: bigint, full: boolean): Promise<ActionResult>;
  sweep(agent: Address): Promise<ActionResult>;
  release(agent: Address): Promise<ActionResult>;
  takeBack(agent: Address, id: number): Promise<ActionResult>;
  register(agent: Address, id: number): Promise<ActionResult>;
  forget(agent: Address, id: number): Promise<ActionResult>;
  claimLate(agent: Address): Promise<ActionResult>;

  approveSupply(amount: bigint): Promise<ActionResult>;
  supply(amount: bigint): Promise<ActionResult>;
  withdraw(amount: bigint, max: boolean): Promise<ActionResult>;
}

