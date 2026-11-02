import { describe, expect, it } from 'vitest';
import { linker, parseHash } from '../src/route';

const ADDR = '0x3f1c0000000000000000000000000000000093a2';
const CHECKSUMMED = '0xde709f2102306220921060314715629080e2fb77';

describe('routes (§4)', () => {
  it('knows every page', () => {
    expect(parseHash('#/app').page).toBe('dash');
    expect(parseHash('#/app/markets').page).toBe('markets');
    expect(parseHash('#/app/markets/bem').page).toBe('pool');
    expect(parseHash('#/app/rigs').page).toBe('rigs');
    expect(parseHash('#/app/rigs/group').page).toBe('group');
    expect(parseHash('#/app/rigs/4127')).toMatchObject({ page: 'rig', id: 4127, modal: null });
    expect(parseHash('#/app/rigs/4127/repay')).toMatchObject({ page: 'rig', id: 4127, modal: 'repay' });
    expect(parseHash('#/app/rigs/4127/screen')).toMatchObject({ page: 'rig', id: 4127, modal: 'screen' });
    expect(parseHash('#/app/supply')).toMatchObject({ page: 'dash', modal: 'supply' });
    expect(parseHash('#/app/withdraw')).toMatchObject({ page: 'dash', modal: 'withdraw' });
  });

  it('redirects the old Borrow and Loans tabs to Rigs', () => {
    expect(parseHash('#/app/borrow')).toMatchObject({ page: 'rigs', redirect: '#/app/rigs' });
    expect(parseHash('#/app/loans')).toMatchObject({ page: 'rigs', redirect: '#/app/rigs' });
    expect(parseHash(`#/app/view/${ADDR}/borrow`).redirect).toBe(`#/app/view/${ADDR}/rigs`);
  });

  it('sends anything outside the app to the dashboard', () => {
    expect(parseHash('')).toMatchObject({ page: 'dash', redirect: '#/app' });
    expect(parseHash('#/')).toMatchObject({ redirect: '#/app' });
    expect(parseHash('#/other')).toMatchObject({ redirect: '#/app' });
  });

  it('accepts only decimal integers as rig ids', () => {
    for (const bad of ['abc', '-1', '1.5', '0x10', '1e3', ' 7', '007', '99999999999999999999', '4127abc']) {
      expect(parseHash(`#/app/rigs/${bad}`).page, bad).toBe('notfound');
    }
    expect(parseHash('#/app/rigs/0').page).toBe('rig');
    expect(parseHash('#/app/rigs/4127/other').page).toBe('notfound');
    expect(parseHash('#/app/rigs/group/extra').page).toBe('notfound');
  });

  it('validates the address of a read-only view with isAddress', () => {
    expect(parseHash(`#/app/view/${ADDR}`)).toMatchObject({ page: 'dash', view: ADDR });
    expect(parseHash(`#/app/view/${ADDR}/rigs/4127`)).toMatchObject({ page: 'rig', id: 4127, view: ADDR });
    expect(parseHash(`#/app/view/${ADDR}/markets`)).toMatchObject({ page: 'markets', view: ADDR });
    expect(parseHash(`#/app/view/${CHECKSUMMED}`).page).toBe('dash');
    // a mixed-case address with a wrong checksum is refused
    expect(parseHash('#/app/view/0xDE709F2102306220921060314715629080e2fb77').page).toBe('notfound');
    for (const bad of ['', '0x123', 'vitalik.eth', `${ADDR}00`, '<img src=x onerror=alert(1)>']) {
      expect(parseHash(`#/app/view/${bad}`).page, bad).toBe('notfound');
    }
    expect(parseHash('#/app/view').page).toBe('notfound');
  });

  it('shows "Not found" for unknown paths', () => {
    expect(parseHash('#/app/nothing').page).toBe('notfound');
    expect(parseHash('#/appx').page).toBe('notfound');
    expect(parseHash('#/app/markets/other').page).toBe('notfound');
  });

  it('keeps the read-only prefix in links', () => {
    expect(linker(null)('/rigs')).toBe('#/app/rigs');
    expect(linker(ADDR)('/rigs')).toBe(`#/app/view/${ADDR}/rigs`);
    expect(linker(ADDR)()).toBe(`#/app/view/${ADDR}`);
  });
});
