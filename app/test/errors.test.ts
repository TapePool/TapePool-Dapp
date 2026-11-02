import { describe, expect, it } from 'vitest';
import { errorDetails, errorText, KEEPER, QUOTE_REASONS, REVERTS, UNKNOWN, WALLET_REJECTED, type AppError } from '../src/chain/errors';
import { setLang } from '../src/i18n';

/** Every row of the §9 table: one English line, one Chinese line. */

const QUOTE_CODES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

const REVERT_NAMES = [
  'BorrowsArePaused',
  'FeedIsDisabled',
  'NoCollateral',
  'NotOwned',
  'LoanOpen',
  'AgentClosed',
  'BadTerm',
  'ExceedsBorrowCap',
  'ExceedsBorrowerCap',
  'ExceedsIdle',
  'BelowMinAdvance',
  'WrongOpsFee',
  'OpsFeeTransferFailed',
  'AlreadyCollateral',
  'CollateralFull',
  'NotBorrower',
  'NotFromBorrower',
  'NoLoan',
  'NoDebt',
  'ERC20InsufficientBalance',
  'ERC20InsufficientAllowance',
  'ERC721InsufficientApproval',
  'ERC721IncorrectOwner',
  'ERC4626ExceededMaxDeposit',
  'ERC4626ExceededMaxWithdraw',
  'ERC4626ExceededMaxRedeem',
  'LZ_InsufficientFee',
  'BadBatch',
];

const KEEPER_REASONS = [
  'fresh',
  'queued',
  'not eligible',
  'rig daily limit',
  'borrower daily limit',
  'daily push budget used, push it yourself',
  'too many requests from this address',
  'busy, try again shortly',
  'busy, try again in a minute',
  'keeper reserve',
  'upgrade pending',
  'dry mode',
  'not deployed',
  'not an agent',
  'bad agent address',
  'collateral must hold 1-16 vouchers',
];

const params = { minAdvance: '0.02', eta: 'Nov 3, 15:00 UTC', expectedFee: '0.052', id: 4127, terms: [7, 14] as const, inputBits: 0b11111 << 7 };

function both(e: AppError): [string, string] {
  setLang('en', false);
  const en = errorText(e);
  setLang('cn', false);
  const cn = errorText(e);
  setLang('en', false);
  return [en, cn];
}

describe('the §9 message table', () => {
  it('has a line for every quote reason code', () => {
    for (const code of QUOTE_CODES) {
      expect(QUOTE_REASONS[code], `code ${code}`).toBeDefined();
      const [en, cn] = both({ kind: 'quote', reason: code, params });
      expect(en.length).toBeGreaterThan(5);
      expect(cn).toMatch(/[一-鿿]/);
      expect(en).not.toBe(UNKNOWN.en({}));
    }
  });

  it('has a line for every revert, each in both languages', () => {
    for (const name of REVERT_NAMES) {
      expect(REVERTS[name], name).toBeDefined();
      const [en, cn] = both({ kind: 'revert', name, params });
      expect(en, name).not.toBe(UNKNOWN.en({}));
      expect(cn, name).toMatch(/[一-鿿]/);
    }
  });

  it('has a line for every keeper answer and refusal', () => {
    for (const reason of KEEPER_REASONS) {
      expect(KEEPER[reason], reason).toBeDefined();
      const [en, cn] = both({ kind: 'keeper', reason });
      expect(en, reason).not.toBe(UNKNOWN.en({}));
      expect(cn, reason).toMatch(/[一-鿿]/);
    }
  });

  it('shows the wallet rejection', () => {
    const [en, cn] = both({ kind: 'wallet-rejected' });
    expect(en).toBe('You cancelled in your wallet. Nothing was sent.');
    expect(cn).toMatch(/[一-鿿]/);
    expect(WALLET_REJECTED.en({})).toBe(en);
  });

  it('says clearly when a wallet cannot go to X Layer, and keeps its own words under "Details"', () => {
    const [en, cn] = both({ kind: 'wallet-no-xlayer', details: 'Unrecognized chain ID' });
    expect(en).toBe('This wallet cannot switch to X Layer. Try OKX Wallet, MetaMask or Rabby.');
    expect(cn).toBe('该钱包无法切换到 X Layer。请改用 OKX Wallet、MetaMask 或 Rabby。');
    expect(errorDetails({ kind: 'wallet-no-xlayer', details: 'Unrecognized chain ID' })).toBe('Unrecognized chain ID');
    expect(errorDetails({ kind: 'wallet-no-xlayer', details: '' })).toBeNull();
  });

  it('says so when the wallet picked in the dialog is gone', () => {
    const [en, cn] = both({ kind: 'no-wallet' });
    expect(en).toContain('No wallet found.');
    expect(cn).toMatch(/[一-鿿]/);
    expect(errorDetails({ kind: 'no-wallet' })).toBeNull();
  });

  it('shows the generic line for anything unknown and keeps the raw text for "Details"', () => {
    const [en, cn] = both({ kind: 'unknown', details: 'execution reverted: 0xdeadbeef' });
    expect(en).toBe('Something went wrong. Nothing was sent.');
    expect(cn).toMatch(/[一-鿿]/);
    expect(errorDetails({ kind: 'unknown', details: 'execution reverted: 0xdeadbeef' })).toBe('execution reverted: 0xdeadbeef');
    expect(both({ kind: 'keeper', reason: 'something new' })[0]).toBe('Something went wrong. Nothing was sent.');
    expect(errorDetails({ kind: 'keeper', reason: 'something new' })).toBe('something new');
    expect(both({ kind: 'revert', name: 'NeverHeardOfIt' })[0]).toBe('Something went wrong. Nothing was sent.');
  });

  it('fills in the parameters', () => {
    expect(both({ kind: 'revert', name: 'BelowMinAdvance', params })[0]).toContain('0.02');
    expect(both({ kind: 'revert', name: 'WrongOpsFee', params })[0]).toContain('0.052');
    expect(both({ kind: 'revert', name: 'AlreadyCollateral', params })[0]).toContain('#4127');
    expect(both({ kind: 'quote', reason: 9, params })[1]).toContain('Nov 3, 15:00 UTC');
    expect(both({ kind: 'quote', reason: 13, params: { terms: [7, 14] } })[1]).toContain('7 天');
  });

  it('DENIED names the first failed flag, or the minimum advance when all five are set', () => {
    const flag = (bits: number) => both({ kind: 'quote', reason: 6, params: { ...params, inputBits: bits } })[0];
    expect(flag(0b11110 << 7)).toContain('rig data is not fresh');
    expect(flag(0b11101 << 7)).toContain('impaired');
    expect(flag(0b11011 << 7)).toContain('processor');
    expect(flag(0b10111 << 7)).toContain('younger than 3 days');
    expect(flag(0b01111 << 7)).toContain('screen pass');
    expect(flag(0b11111 << 7)).toContain('minimum advance of 0.02 BEM');
    // the first failed flag wins
    expect(flag(0b01100 << 7)).toContain('rig data is not fresh');
  });

  it('PolicyDenied shows the line of its reason', () => {
    const [en] = both({ kind: 'revert', name: 'PolicyDenied', reason: 7 });
    expect(en).toBe('New borrows are paused. Repaying and withdrawals keep working.');
  });

  it('never uses audit wording, an exclamation mark or half-width punctuation next to Chinese', () => {
    const all: AppError[] = [
      ...QUOTE_CODES.map((reason): AppError => ({ kind: 'quote', reason, params })),
      ...REVERT_NAMES.map((name): AppError => ({ kind: 'revert', name, params })),
      ...KEEPER_REASONS.map((reason): AppError => ({ kind: 'keeper', reason })),
    ];
    for (const e of all) {
      const [en, cn] = both(e);
      expect(en + cn).not.toMatch(/audit|审计|!|！/i);
      expect(cn).not.toMatch(/[一-鿿][,;:?()]|[,;:?()][一-鿿]/);
    }
  });
});
