import { BOND, DUST, MAX_HARVEST_VALUE, REQUIRED_SHARE_PCT } from '../constants';
import type { AgentView, GateRecord, RigView, Sec, Snapshot } from '../model';
import type { UiState } from '../state';
import { gateOpen, isStuck, isUnresolved, landingLate } from './gates';
import { borrowsOpen } from './selectors';

/**
 * BEM a rig mined before a loan (SPEC-PHASE5-PRELOAN): the numbers, and what the borrow screen asks about them.
 *
 * `mined` is what the rig has mined and nobody harvested: `PodMining.pending` plus the BEM in the rig's cell. A harvest sends
 * each rig's share rounded down to a multiple of the vault's dust (`minedR`), and the bridge keeps its fee on the way to
 * X Layer, so what reaches the wallet, or the agent, is `landed`. If that BEM reaches the agent while a loan is open it repays
 * the loan first, and the borrower has paid the whole flat fee for a loan that lasts minutes.
 */

/** A rig, as far as these numbers need it. */
export interface Minable {
  id: number;
  mined: bigint | null;
}

/** `round_down(mined, DUST)`: what a harvest would send for the rig. */
export const minedR = (mined: bigint): bigint => (mined / DUST) * DUST;

/** The rigs whose mined BEM is unknown. They are never counted as zero. */
export const unknownOf = (rigs: readonly Minable[]): number[] => rigs.filter((r) => r.mined === null).map((r) => r.id);

/**
 * `collectable(S)`: the sum of the per-rig rounded amounts, the number the vault compares with `BOND`. A rig with an unknown
 * amount adds nothing; callers ask `unknownOf` first.
 */
export const collectable = (rigs: readonly Minable[]): bigint => rigs.reduce((s, r) => s + (r.mined === null ? 0n : minedR(r.mined)), 0n);

/** `landed(S)`: what would reach X Layer, rounded per rig after the bridge fee. */
export function landed(rigs: readonly Minable[], feeBps: number): bigint {
  const keep = BigInt(10_000 - Math.min(10_000, Math.max(0, feeBps)));
  return rigs.reduce((s, r) => s + (r.mined === null ? 0n : (minedR(r.mined) * keep) / 10_000n), 0n);
}

/** `share`: a whole percentage, rounded down, of the debt the landed BEM would repay. Null when the debt is 0. */
export const sharePct = (landedAmount: bigint, debt: bigint): bigint | null => (debt > 0n ? (landedAmount * 100n) / debt : null);

/** "37%", "> 999%", or "—" when there is no debt to measure against. */
export function shareText(landedAmount: bigint, debt: bigint): string {
  const p = sharePct(landedAmount, debt);
  if (p === null) return '—';
  return p > 999n ? '> 999%' : `${p}%`;
}

/** From the required share of the debt (O-1). With no debt it counts as below the line. */
export const shareRequired = (landedAmount: bigint, debt: bigint): boolean => debt > 0n && landedAmount * 100n >= debt * REQUIRED_SHARE_PCT;

/** `covers`: the landed BEM is at least the debt plus one percent, which is the keeper's rule for its covered harvest. */
export const covers = (landedAmount: bigint, debt: bigint): boolean => debt > 0n && landedAmount * 100n >= debt * 101n;

const byId = (a: number, b: number): number => a - b;
const sameSet = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && [...a].sort(byId).every((v, i) => v === [...b].sort(byId)[i]);
const union = <T extends { id: number }>(a: readonly T[], b: readonly T[]): T[] => [...new Map([...a, ...b].map((r) => [r.id, r])).values()];
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/* ───────── what the borrow screen asks ───────── */

/** Why "Harvest it to my wallet first" is off, in the order the screen checks them. */
export type HarvestOff = 'storage' | 'paused' | 'contracts' | 'unreadable' | 'mark' | 'cap';

export interface HarvestOption {
  off: HarvestOff | null;
  /** `quoteHarvest(n) × 11 / 10`, the BNB the harvest sends; null when the quote is unknown. */
  value: bigint | null;
}

/** What the step says while a harvest's record keeps the voucher where it is. */
export type GateWait = 'prompting' | 'in-flight' | 'settle';

export type Step2Kind = 'none' | 'unreadable' | 'tiny' | 'info' | 'choice';

/** Step 2 ("Move voucher"): the selection's rigs still in the wallet (`W`). */
export interface Step2 {
  kind: Step2Kind;
  /** `W`, ascending. */
  ids: number[];
  /** The rigs of `W` with something to harvest, ascending: what "Harvest it first" sends. */
  harvestIds: number[];
  /** The rigs of `W` whose mined BEM could not be read. */
  unreadable: number[];
  /** `landed(W)`, the `x` of the messages, and its share of the debt. */
  amount: bigint;
  share: string;
  /** `landed(kept ∪ W) ≥ debt × 1.01`. */
  covers: boolean;
  /** "Keep" was chosen for exactly this selection. */
  keep: boolean;
  records: GateRecord[];
  wait: GateWait | null;
  gateOpen: boolean;
  /** The app's own harvest of one of these rigs is unresolved: the choice is made, and the screen shows where it stands. */
  busy: boolean;
  /** A harvest has been waited on for ten minutes and the user has not said "Keep waiting". */
  stuck: boolean;
  option: HarvestOption;
  /** The Move voucher button is on. */
  canMove: boolean;
}

export type Step3Kind = 'none' | 'tiny' | 'info' | 'ask' | 'unreadable';

/** Step 3: the selection's rigs that are already in the flow's agent (§4.7). */
export interface Step3 {
  kind: Step3Kind;
  /** `I`: in-agent rigs of the selection with BEM mined, that had no choice in this flow yet. */
  ids: number[];
  amount: bigint;
  share: string;
  covers: boolean;
  /** Borrow stays off until the user takes the vouchers back or keeps the BEM in the loan. */
  blocks: boolean;
}

/** The BEM mined before this loan that sits in the agent's rigs: the review row. */
export interface Kept {
  collectable: bigint;
  amount: bigint;
  share: string;
  covers: boolean;
}

export interface MinedView {
  feeBps: number;
  /** `debtShown`. */
  debt: bigint;
  step2: Step2;
  step3: Step3;
  kept: Kept;
  /** A harvest was paid to the agent (§4.5): Borrow waits until it lands there. */
  mismatch: { ids: number[]; late: boolean } | null;
  /** Harvest first is chosen and its BSC transaction is not behind us: the steps header counts one on BSC. */
  bscTx: boolean;
  /** The mined BEM of the whole selection, for the details row; null when any rig is unknown. */
  total: bigint | null;
}

export interface MinedInputs {
  snap: Snapshot;
  ui: UiState;
  now: Sec;
  /** The selection: ready rigs and rigs already in one of the user's open agents. */
  rigs: readonly RigView[];
  agent: AgentView | null;
  /** `debtShown`: the debt of the amount on screen, or the largest debt of the term when no amount is valid. */
  debt: bigint;
}

function harvestOption(snap: Snapshot, harvestIds: readonly number[]): HarvestOption {
  const h = snap.harvest;
  if (harvestIds.length === 0) return { off: null, value: null }; // nothing to harvest, nothing to read
  if (!h.storage) return { off: 'storage', value: null };
  if (!borrowsOpen(snap.pool)) return { off: 'paused', value: null };
  const prep = h.prep;
  if (!prep) return { off: 'unreadable', value: null };
  if (prep.contracts === 'changed') return { off: 'contracts', value: null };
  if (prep.contracts === null) return { off: 'unreadable', value: null };
  const quote = prep.quotes[harvestIds.length - 1] ?? null;
  const marks = harvestIds.map((id) => prep.mark[String(id)] ?? null);
  if (quote === null || marks.some((m) => m === null)) return { off: 'unreadable', value: null };
  const value = (quote * 11n) / 10n;
  if (marks.some((m) => m === false)) return { off: 'mark', value };
  if (value > MAX_HARVEST_VALUE) return { off: 'cap', value };
  return { off: null, value };
}

/** The whole mined-BEM state of a borrow screen. */
export function deriveMined(i: MinedInputs): MinedView {
  const { snap, ui, now, agent, debt } = i;
  const feeBps = snap.harvest.feeBps;
  // the gate and the stuck time are read against the last head of X Layer, not the clock that keeps counting between two reads
  const head = snap.harvest.headTime;
  const collateralIds = agent ? agent.collateral : [];
  const keptRigs = collateralIds.map((id) => snap.rigs.find((r) => r.id === id)).filter((r): r is RigView => r !== undefined);

  /* step 2: W */
  const W = i.rigs.filter((r) => r.facts.place.kind === 'wallet').sort((a, b) => a.id - b.id);
  const wIds = W.map((r) => r.id);
  const unreadable = unknownOf(W);
  const harvestRigs = W.filter((r) => r.mined !== null && minedR(r.mined) > 0n);
  const harvestIds = harvestRigs.map((r) => r.id).slice(0, 16);
  const col = collectable(W);
  const amount = landed(W, feeBps);
  const records = wIds.map((id) => snap.harvest.gates[String(id)]).filter((r): r is GateRecord => r !== undefined);
  const open = records.every((r) => gateOpen(r, head));
  const keep = ui.keep !== null && wIds.length > 0 && sameSet(ui.keep, wIds);
  const states = records.map((r) => r.state);
  const wait: GateWait | null = states.includes('prompting') ? 'prompting' : states.includes('in-flight') ? 'in-flight' : open ? null : 'settle';
  const busy = records.some((r) => isUnresolved(r.state));
  const stuck = records.some((r) => isStuck(r, head)) && now >= ui.hold;

  let kind: Step2Kind;
  if (W.length === 0 || (unreadable.length === 0 && col === 0n)) kind = 'none';
  else if (unreadable.length > 0) kind = 'unreadable';
  else if (col < BOND) kind = 'tiny';
  else if (shareRequired(amount, debt)) kind = 'choice';
  else kind = 'info';

  const option = harvestOption(snap, harvestIds);
  const keptAndW = union(keptRigs, W);
  const step2: Step2 = {
    kind,
    ids: wIds,
    harvestIds,
    unreadable,
    amount,
    share: shareText(amount, debt),
    covers: covers(landed(keptAndW, feeBps), debt),
    keep,
    records,
    wait,
    gateOpen: open,
    busy,
    stuck,
    option,
    canMove: open && kind !== 'unreadable' && (kind !== 'choice' || keep),
  };

  /* step 3: I, the rigs in the agent that nobody asked about */
  const I = i.rigs.filter((r) => agent !== null && r.facts.place.kind === 'agent' && r.facts.place.agent !== undefined && same(r.facts.place.agent, agent.address) && agent.collateral.includes(r.id) && !ui.decided.includes(r.id)).sort((a, b) => a.id - b.id);
  const iUnknown = unknownOf(I);
  const iRigs = I.filter((r) => r.mined === null || minedR(r.mined) > 0n);
  const iCol = collectable(iRigs);
  const iAmount = landed(iRigs, feeBps);
  let kind3: Step3Kind = 'none';
  if (iUnknown.length > 0) kind3 = 'unreadable';
  else if (iRigs.length > 0 && iCol > 0n) kind3 = iCol < BOND ? 'tiny' : shareRequired(iAmount, debt) ? 'ask' : 'info';
  const step3: Step3 = {
    kind: kind3,
    ids: iRigs.map((r) => r.id),
    amount: iAmount,
    share: shareText(iAmount, debt),
    covers: covers(landed(keptRigs, feeBps), debt),
    blocks: kind3 === 'ask' || kind3 === 'unreadable',
  };

  /* the review: every collateral rig of the agent */
  const keptCol = collectable(keptRigs);
  const keptAmount = landed(keptRigs, feeBps);
  const kept: Kept = { collectable: keptCol, amount: keptAmount, share: shareText(keptAmount, debt), covers: covers(keptAmount, debt) };

  /* a harvest paid to the agent keeps Borrow off for it */
  const bad = Object.values(snap.harvest.gates).filter((r) => r.state === 'payee-mismatch' && r.agent !== null && agent !== null && same(r.agent, agent.address));
  const mismatch = bad.length > 0 ? { ids: bad.map((r) => r.id).sort(byId), late: bad.some((r) => landingLate(r, head)) } : null;

  const all = i.rigs.map((r) => r.mined);
  const total = all.some((m) => m === null) ? null : all.reduce<bigint>((s, m) => s + (m ?? 0n), 0n);
  const bscTx = records.some((r) => r.state === 'prompting' || r.state === 'in-flight' || r.state === 'mined' || (r.state === 'final' && r.hash !== null));
  return { feeBps, debt, step2, step3, kept, mismatch, bscTx, total };
}
