import { describe, expect, it } from 'vitest';
import { createFixture } from '../src/fixtures/catalog';
import { AGENT_C, T0, rigFacts } from '../src/fixtures/data';
import { deriveRigState } from '../src/logic/rigState';
import type { RigFacts, RigState } from '../src/model';

/** Each row of the SPEC-PHASE5-APP §5.2 table, from the fixture rig that stands for it. */
const ROWS: [string, number, RigState['kind'], string][] = [
  ['1', 3871, 'loan', '1'],
  ['1 (grouped)', 6031, 'loan', '1'],
  ['2', 6020, 'seized', '2'],
  ['3', 6010, 'stuck', '3'],
  ['4', 6001, 'in-agent', '4'],
  ['5 (open agent)', 6002, 'loose', '5'],
  ['5 (closed agent)', 6003, 'loose', '5'],
  ['6', 5101, 'no-data', '6'],
  ['7', 5102, 'not-mining', '7'],
  ['8', 5103, 'processor', '8'],
  ['9a', 5104, 'not-synced', '9a'],
  ['9b', 5105, 'mismatch', '9b'],
  ['10', 4233, 'too-new', '10'],
  ['11', 4019, 'no-base-power', '11'],
  ['12 (no pass)', 4301, 'not-screened', '12'],
  ['12 (suspended)', 5106, 'not-screened', '12'],
  ['12 (changed)', 5107, 'not-screened', '12'],
  ['13', 3990, 'screen-pending', '13'],
  ['14', 4127, 'ready', '14'],
];

describe('rig state precedence (§5.2)', () => {
  const snap = createFixture('rigs-all', { clock: () => 0 }).store.snapshot(null);

  for (const [row, id, kind, tableRow] of ROWS) {
    it(`row ${row}: rig #${id} is ${kind}`, () => {
      const r = snap.rigs.find((x) => x.id === id);
      expect(r?.state.kind).toBe(kind);
      expect(r?.state.row).toBe(tableRow);
    });
  }

  it('keeps the three variants of row 12 apart', () => {
    const why = (id: number) => {
      const s = snap.rigs.find((x) => x.id === id)?.state;
      return s?.kind === 'not-screened' ? s.why : null;
    };
    expect(why(4301)).toBe('none');
    expect(why(5106)).toBe('suspended');
    expect(why(5107)).toBe('changed');
  });

  it('knows whether the agent of row 5 is closed', () => {
    const closed = (id: number) => {
      const s = snap.rigs.find((x) => x.id === id)?.state;
      return s?.kind === 'loose' ? s.agentClosed : null;
    };
    expect(closed(6002)).toBe(false);
    expect(closed(6003)).toBe(true);
  });

  const wallet = (o: Parameters<typeof rigFacts>[0]): RigFacts => rigFacts(o);
  const kind = (f: RigFacts, now = T0): string => deriveRigState(f, now).kind;

  it('the place of a rig wins over everything about its data', () => {
    const inLoan = wallet({ id: 1, noBsc: true, status: 2, proc: null, place: { kind: 'agent', agent: AGENT_C, closed: false, collateral: true, loanOpen: true } });
    expect(kind(inLoan)).toBe('loan');
    const agentNoData = wallet({ id: 2, noBsc: true, place: { kind: 'agent', agent: AGENT_C, closed: false, collateral: true, loanOpen: false } });
    expect(kind(agentNoData)).toBe('in-agent');
    const seized = wallet({ id: 3, noBsc: true, place: { kind: 'pool', agent: AGENT_C } });
    expect(kind(seized)).toBe('seized');
  });

  it('an open loan on a closed agent still counts as a loan (row 1 before row 3)', () => {
    const f = wallet({ id: 1, place: { kind: 'agent', agent: AGENT_C, closed: true, collateral: true, loanOpen: true } });
    expect(kind(f)).toBe('loan');
  });

  it('a voucher outside the collateral set is row 5 whatever the agent state', () => {
    for (const closed of [false, true]) {
      const f = wallet({ id: 1, place: { kind: 'agent', agent: AGENT_C, closed, collateral: false, loanOpen: false } });
      expect(kind(f)).toBe('loose');
    }
  });

  it('data rows follow the table order', () => {
    expect(kind(wallet({ id: 1, noBsc: true, proc: null, voucherPower: 0n }))).toBe('no-data');
    expect(kind(wallet({ id: 1, status: 2, proc: null }))).toBe('not-mining');
    expect(kind(wallet({ id: 1, proc: null, voucherPower: 0n }))).toBe('processor');
    expect(kind(wallet({ id: 1, voucherPower: 0n, voucherCircuitId: 77n, age: 1 }))).toBe('not-synced');
    expect(kind(wallet({ id: 1, voucherCircuitId: 77n, age: 1 }))).toBe('mismatch');
    expect(kind(wallet({ id: 1, age: 1, base: 0, voucherPower: 1n, pass: 'none' }))).toBe('too-new');
    expect(kind(wallet({ id: 1, age: 20, base: 0, bonus: 0, voucherPower: 1n, pass: 'none' }))).toBe('no-base-power');
    expect(kind(wallet({ id: 1, age: 20, pass: 'none' }))).toBe('not-screened');
    expect(kind(wallet({ id: 1, age: 20, pass: 'suspended' }))).toBe('not-screened');
    expect(kind(wallet({ id: 1, age: 20, pass: 'pending', passAt: T0 + 100 }))).toBe('screen-pending');
    expect(kind(wallet({ id: 1, age: 20 }))).toBe('ready');
  });

  it('a suspended pass is row 12 even while it would still be pending (12 before 13)', () => {
    const f = wallet({ id: 1, age: 20, pass: 'pending', passAt: T0 + 100 });
    expect(kind({ ...f, screen: { ...f.screen, suspended: true } })).toBe('not-screened');
  });

  it('too new is judged by chain time, and the rig is ready at the boundary', () => {
    const f = wallet({ id: 1, since: T0 - 3 * 86_400 + 10, passAt: T0 - 1 });
    expect(kind(f, T0)).toBe('too-new');
    expect(kind(f, T0 + 9)).toBe('too-new');
    expect(kind(f, T0 + 10)).toBe('ready');
  });

  it('base power must exceed the bonus (compared, never subtracted)', () => {
    expect(kind(wallet({ id: 1, base: 5, bonus: 0 }))).toBe('ready');
    const f = wallet({ id: 1, base: 5, bonus: 0 });
    if (f.bsc) f.bsc.verifWeight = f.bsc.bonus; // equal: no base power
    expect(kind(f)).toBe('no-base-power');
  });

  it('the screen pass counts only when circuits, circuit id and task match the BSC read', () => {
    const f = wallet({ id: 1, age: 20 });
    expect(kind(f)).toBe('ready');
    if (f.screen.pass) f.screen.pass = { ...f.screen.pass, taskId: 99n };
    expect(kind(f)).toBe('not-screened');
  });
});
