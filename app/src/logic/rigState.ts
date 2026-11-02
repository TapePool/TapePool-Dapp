import { MIN_RIG_AGE } from '../constants';
import type { RigFacts, RigState, RigView, Sec } from '../model';

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The state of one rig: the first matching row of the SPEC-PHASE5-APP §5.2 table.
 * Rows 6 to 14 mirror the flags of `CreditPolicy._rig`, so a "ready" rig is very unlikely to meet a DENIED answer.
 */
export function deriveRigState(f: RigFacts, now: Sec): RigState {
  const p = f.place;
  if (p.kind === 'agent' && p.collateral && p.loanOpen) return { kind: 'loan', row: '1', agent: p.agent };
  if (p.kind === 'pool') return { kind: 'seized', row: '2', agent: p.agent };
  if (p.kind === 'agent') {
    if (p.collateral && p.closed) return { kind: 'stuck', row: '3', agent: p.agent };
    if (p.collateral) return { kind: 'in-agent', row: '4', agent: p.agent };
    return { kind: 'loose', row: '5', agent: p.agent, agentClosed: p.closed };
  }

  const b = f.bsc;
  if (!b) return { kind: 'no-data', row: '6' };
  if (b.status !== 1 || b.stopBlock !== 0n || !b.custodied) return { kind: 'not-mining', row: '7' };
  if (f.processor === null) return { kind: 'processor', row: '8' };
  if (f.voucher.power === 0n) return { kind: 'not-synced', row: '9a' };
  if (!same(f.voucher.circuits, b.circuits) || f.voucher.circuitId !== b.circuitId) return { kind: 'mismatch', row: '9b' };
  const readyAt = b.since + MIN_RIG_AGE;
  if (now < readyAt) return { kind: 'too-new', row: '10', readyAt };
  if (b.verifWeight <= b.bonus) return { kind: 'no-base-power', row: '11' };
  const pass = f.screen.pass;
  if (!pass) return { kind: 'not-screened', row: '12', why: 'none' };
  if (f.screen.suspended) return { kind: 'not-screened', row: '12', why: 'suspended' };
  if (!same(pass.circuits, b.circuits) || pass.circuitId !== b.circuitId || pass.taskId !== b.taskId)
    return { kind: 'not-screened', row: '12', why: 'changed' };
  if (now < pass.effectiveAt) return { kind: 'screen-pending', row: '13', effectiveAt: pass.effectiveAt };
  return { kind: 'ready', row: '14' };
}

export function buildRigView(facts: RigFacts, now: Sec): RigView {
  const b = facts.bsc;
  return {
    id: facts.id,
    facts,
    state: deriveRigState(facts, now),
    basePower: b ? (b.verifWeight > b.bonus ? b.verifWeight - b.bonus : 0n) : null,
    age: b ? Math.max(0, now - b.since) : null,
    mined: b?.mined ?? null,
    processor: facts.processor,
  };
}

export const isReady = (r: RigView): boolean => r.state.kind === 'ready';
