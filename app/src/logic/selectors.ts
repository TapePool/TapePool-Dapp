import type { AgentView, Address, LoanPhase, LoanView, PoolView, RigView, Snapshot } from '../model';

export const OPEN_PHASES: readonly LoanPhase[] = ['active', 'late', 'flagged', 'seize'];

export const isOpen = (l: LoanView): boolean => OPEN_PHASES.includes(l.phase);
export const debtOf = (l: LoanView): bigint => l.principal + l.feeLeft + l.lateFee;

/** `min(borrowCapAbs, totalAssets x borrowCapBps / 10^4)`. */
export function borrowCapOf(pool: PoolView): bigint {
  const share = (pool.totalAssets * BigInt(pool.params.borrowCapBps)) / 10_000n;
  return share < pool.params.borrowCapAbs ? share : pool.params.borrowCapAbs;
}

/** Deposits are closed while any loan is doubtful. */
export const depositsClosed = (pool: PoolView): boolean => pool.doubtful > 0n;

/** New borrows are open: not paused, the feed is on and no credit-rule swap is queued. */
export const borrowsOpen = (pool: PoolView): boolean => !pool.borrowsPaused && !pool.feedDisabled && pool.pendingPolicy === null;

/** Redeploy 3 RC3-02: `lend` waits `FEED_SETTLE` after the feed is turned back on (`FeedSettling()`). */
export const feedSettling = (pool: PoolView, now: number): boolean => !pool.feedDisabled && now < (pool.feedSettleUntil ?? 0);

export type PoolBanner = 'swap' | 'paused' | 'feedoff' | 'settling' | 'noroom';

export function poolBanner(snap: Snapshot): PoolBanner | null {
  const p = snap.pool;
  if (p.pendingPolicy) return 'swap';
  if (p.borrowsPaused) return 'paused';
  if (p.feedDisabled) return 'feedoff';
  // lendLimit answers (0, 5) while the feed settles, so the room is 0 for the settling window, not for a cap (RC3-02)
  if (feedSettling(p, snap.now)) return 'settling';
  if (snap.wallet.status === 'connected' || snap.wallet.status === 'view') {
    if (snap.wallet.room < p.params.minAdvance) return 'noroom';
  }
  return null;
}

export const agentByAddress = (snap: Snapshot, a: Address): AgentView | undefined =>
  snap.agents.find((x) => x.address.toLowerCase() === a.toLowerCase());

export const loanOfAgent = (snap: Snapshot, a: Address): LoanView | undefined =>
  snap.loans.find((l) => l.agent.toLowerCase() === a.toLowerCase());

export const openLoanOfAgent = (snap: Snapshot, a: Address): LoanView | undefined => {
  const l = loanOfAgent(snap, a);
  return l && isOpen(l) ? l : undefined;
};

/** The loan a rig belongs to, whatever its phase. */
export const loanForRig = (snap: Snapshot, id: number): LoanView | undefined => snap.loans.find((l) => l.rigIds.includes(id));

export const rigById = (snap: Snapshot, id: number): RigView | undefined => snap.rigs.find((r) => r.id === id);

/** Rigs that sit in the wallet (states 6 to 14). */
export const walletRigs = (snap: Snapshot): RigView[] => snap.rigs.filter((r) => r.facts.place.kind === 'wallet');

export const readyRigs = (snap: Snapshot): RigView[] => snap.rigs.filter((r) => r.state.kind === 'ready');

/** An open agent that holds nothing and owes nothing: it can be reused. */
export function reusableAgent(snap: Snapshot): AgentView | undefined {
  return snap.agents.find((a) => !a.closed && a.collateral.length === 0 && !openLoanOfAgent(snap, a.address));
}

/** Empty agents that hold BEM no loan is waiting for (Claim late). */
export const claimableAgents = (snap: Snapshot): AgentView[] =>
  snap.agents.filter((a) => !a.closed && a.bem > 0n && !openLoanOfAgent(snap, a.address));

const RANK: Record<RigView['state']['kind'], number> = {
  loan: 0,
  seized: 1,
  stuck: 2,
  'in-agent': 3,
  loose: 4,
  ready: 5,
  'screen-pending': 5,
  'not-screened': 5,
  'too-new': 5,
  'no-base-power': 5,
  mismatch: 5,
  'not-synced': 5,
  processor: 5,
  'not-mining': 5,
  'no-data': 5,
};

/** Rigs in a loan first, then the rest in the order they were read. */
export function orderedRigs(snap: Snapshot): RigView[] {
  return [...snap.rigs].sort((a, b) => RANK[a.state.kind] - RANK[b.state.kind]);
}

/** A grouped loan shows on the card of its lowest id; the others point to it. */
export function groupLead(loan: LoanView): number {
  return loan.rigIds[0] ?? 0;
}

export const stale = (snap: Snapshot): boolean => Object.keys(snap.stale).length > 0;
