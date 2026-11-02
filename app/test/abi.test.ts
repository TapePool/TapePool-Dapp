import fs from 'node:fs';
import path from 'node:path';
import { toFunctionSelector, toEventSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import * as abis from '../src/chain/abi';
// @ts-expect-error the generator is a plain ES module without types
import { ABI_DIR, buildAbiFiles, OUT_DIR, SPECS } from '../scripts/gen-abi.mjs';

const haveOut = fs.existsSync(OUT_DIR as string);

describe('the committed ABIs', () => {
  it.skipIf(!haveOut)('equal what the generator makes from out/ (run `npm run gen:abi` after `forge build`)', () => {
    const files = buildAbiFiles() as Record<string, string>;
    for (const [name, text] of Object.entries(files)) {
      const committed = fs.readFileSync(path.join(ABI_DIR as string, name), 'utf8');
      expect(committed, name).toBe(text);
    }
    // and nothing else is in the folder
    expect(fs.readdirSync(ABI_DIR as string).sort()).toEqual(Object.keys(files).sort());
  });

  it.skipIf(!haveOut)("TapeLens's committed runtime code is the deployed bytecode in out/", () => {
    const art = JSON.parse(fs.readFileSync(path.join(OUT_DIR as string, 'TapeLens.sol', 'TapeLens.json'), 'utf8')) as { deployedBytecode: { object: string; immutableReferences: object } };
    expect(abis.tapeLensRuntime).toBe(art.deployedBytecode.object);
    expect(Object.keys(art.deployedBytecode.immutableReferences ?? {})).toHaveLength(0); // so the code works at any address
  });

  it('exports every ABI the generator lists', () => {
    for (const s of SPECS as { name: string; bytecode?: string }[]) {
      expect(abis, s.name).toHaveProperty(s.name);
      if (s.bytecode) expect(abis, s.bytecode).toHaveProperty(s.bytecode);
    }
  });

  it('has the selectors the live contracts answer to', () => {
    const sel = (abi: readonly { type: string; name?: string; inputs?: readonly { type: string }[] }[], name: string): string => {
      const f = abi.find((i) => i.type === 'function' && i.name === name);
      if (!f) throw new Error(`no ${name}`);
      return toFunctionSelector(`${name}(${(f.inputs ?? []).map((i) => i.type).join(',')})`);
    };
    // ERC-721 Enumerable, written by hand and checked against a live read in test/live.test.ts
    expect(sel(abis.voucherAbi, 'tokenOfOwnerByIndex')).toBe('0x2f745c59');
    expect(sel(abis.circuitsAbi, 'name')).toBe('0x06fdde03');
    expect(sel(abis.circuitsAbi, 'symbol')).toBe('0x95d89b41');
    expect(sel(abis.erc20Abi, 'balanceOf')).toBe('0x70a08231');
    expect(toFunctionSelector('aggregate3((address,bool,bytes)[])')).toBe('0x82ad56cb');
    expect(abis.multicall3Abi.find((i) => i.name === 'aggregate3')?.inputs[0]?.components.map((c) => c.type)).toEqual(['address', 'bool', 'bytes']);
    expect(sel(abis.multicall3Abi, 'getEthBalance')).toBe('0x4d2301cc');
    expect(sel(abis.tapePoolAbi, 'convertToAssets')).toBe('0x07a2d13a');
    expect(sel(abis.rigAgentAbi, 'loanOf')).toBe(toFunctionSelector('loanOf()'));
  });

  it('has what harvest first reads and sends (SPEC-PHASE5-PRELOAN): the vault, the voucher and the adapter, as the live contracts name them', () => {
    const sel = (abi: readonly { type: string; name?: string; inputs?: readonly { type: string }[] }[], name: string): string => {
      const f = abi.find((i) => i.type === 'function' && i.name === name);
      if (!f) throw new Error(`no ${name}`);
      return toFunctionSelector(`${name}(${(f.inputs ?? []).map((i) => i.type).join(',')})`);
    };
    expect(sel(abis.bscVaultAbi, 'harvest')).toBe(toFunctionSelector('harvest(uint256[])'));
    expect(sel(abis.bscVaultAbi, 'quoteHarvest')).toBe(toFunctionSelector('quoteHarvest(uint256)'));
    expect(sel(abis.voucherAbi, 'payeeAt')).toBe(toFunctionSelector('payeeAt(uint256,uint256)'));
    expect(sel(abis.adapterAbi, 'feeBps')).toBe(toFunctionSelector('feeBps()'));
    expect(abis.bscBemAbi.map((i) => i.name)).toEqual(['FailedCall', 'FailedInnerCall']);
    // the ERC-20 errors of a bond that cannot be pulled are in TapePool's list, which the revert union holds
    expect(abis.tapePoolAbi.filter((i) => i.type === 'error').map((i) => i.name)).toEqual(expect.arrayContaining(['ERC20InsufficientBalance', 'ERC20InsufficientAllowance']));
    // the voucher's Paid event is the `0x4f2d1832…` topic seen on the live voucher (research/notes/lending/rig_escrow_check.md)
    expect(toEventSelector('Paid(uint256,address,uint256)').slice(0, 10)).toBe('0x4f2d1832');
    expect(abis.voucherAbi.find((i) => i.type === 'event' && i.name === 'Paid')?.inputs.map((i) => [i.name, i.indexed])).toEqual([['id', true], ['to', true], ['amount', false]]);
    expect(abis.bscVaultAbi.find((i) => i.type === 'event' && i.name === 'Harvested')?.inputs.map((i) => i.name)).toEqual(['guid', 'ids', 'packed']);
    // BadBatch() of the vault and of the reporter are one selector, which is why the revert names are mapped per action
    expect(abis.reporterAbi.some((i) => i.type === 'error' && i.name === 'BadBatch' && i.inputs.length === 0)).toBe(true);
    expect(abis.bscVaultAbi.filter((i) => i.type === 'error').map((i) => i.name)).toEqual(['BadBatch']);
  });

  it('has the events the history search reads, with the indexed agent first', () => {
    const ev = (name: string) => abis.rigAgentAbi.find((i) => i.type === 'event' && i.name === name);
    expect(ev('Borrowed')?.inputs.map((i) => i.name)).toEqual(['agent', 'borrower', 'term', 'principal', 'fee', 'maturity', 'ids']);
    expect(ev('OpsFeePaid')?.inputs.map((i) => i.name)).toEqual(['agent', 'term', 'amount', 'to']);
    expect(ev('Seized')?.inputs.map((i) => i.name)).toEqual(['agent', 'movedIds', 'stuckIds', 'writtenOff']);
    expect(toEventSelector('Seized(address,uint256[],uint256[],uint256)')).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('carries the custom errors the later steps decode, once each', () => {
    const names = (abi: readonly { type: string; name?: string }[]) => abi.filter((i) => i.type === 'error').map((i) => i.name);
    expect(names(abis.rigAgentAbi)).toEqual(expect.arrayContaining(['WrongOpsFee', 'PolicyDenied', 'NoLoan', 'NotBorrower']));
    expect(names(abis.tapePoolAbi)).toEqual(expect.arrayContaining(['ExceedsBorrowCap', 'ERC4626ExceededMaxDeposit']));
    expect(names(abis.reporterAbi)).toContain('BadBatch');
    const sigs = abis.rigAgentAbi.filter((i) => i.type === 'error').map((i) => `${i.name}(${i.inputs.map((x) => x.type).join(',')})`);
    expect(new Set(sigs).size).toBe(sigs.length);
  });
});
