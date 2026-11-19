import { describe, expect, it, vi } from 'vitest';
import { WalletActivity } from '../src/chain/activity';
import type { DecodedLog, Reader } from '../src/chain/reader';
import { MAINNET } from '../src/config';
import { memoryStore } from '../src/logic/history';
import type { Address } from '../src/model';

const book = { ...MAINNET, poolDeployBlock: 100n };
const wallet: Address = '0x0000000000000000000000000000000000000011';
const agent: Address = '0x0000000000000000000000000000000000000022';
const other: Address = '0x0000000000000000000000000000000000000033';
const log = (blockNumber: bigint, eventName: string, args: Record<string, unknown>): DecodedLog => ({
  blockNumber, eventName, args, transactionHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
});
const events = [
  log(100n, 'Deposit', { owner: wallet, assets: 42n }),
  log(200n, 'Lent', { agent, borrower: wallet, amount: 17n }),
  log(201n, 'RepaymentReceived', { agent, fee: 2n, principal: 17n, toReserve: 1n }),
  log(201n, 'RepaymentReceived', { agent: other, fee: 1n, principal: 200n }),
  log(202n, 'Withdraw', { owner: wallet, assets: 13n }),
];
const read = () => ({
  logs: vi.fn<Reader['logs']>(async ({ fromBlock, toBlock }) => {
    expect(toBlock - fromBlock).toBeLessThan(100n);
    return events.filter(e => e.blockNumber >= fromBlock && e.blockNumber <= toBlock);
  }),
  blockTime: async (block: bigint) => Number(block) + 1000,
});

describe('wallet history from pool events', () => {
  it('reads prior activity, attributes a sweep to the borrower and resumes from the cached block', async () => {
    const db = memoryStore();
    const r = read();
    const first = new WalletActivity(book, wallet, db);
    await first.refresh(r, 201n, [agent], 100n, () => true, () => {});
    expect(first.view?.rows.map(({ kind, amount }) => [kind, amount])).toEqual([['repay', 19n], ['borrow', 17n], ['supply', 42n]]);
    const reopened = new WalletActivity(book, wallet, db);
    r.logs.mockClear();
    await reopened.refresh(r, 202n, [agent], 100n, () => true, () => {});
    expect(r.logs).toHaveBeenCalledTimes(1);
    expect(r.logs.mock.calls[0]?.[0]).toMatchObject({ fromBlock: 202n, toBlock: 202n });
    expect(reopened.view?.rows).toHaveLength(4);
    expect(reopened.view?.rows[0]).toMatchObject({ kind: 'withdraw', time: 1202 });
    const unrelated = new WalletActivity(book, other, db);
    await unrelated.refresh(r, 202n, [], 100n, () => true, () => {});
    expect(unrelated.view).toEqual({ rows: [], syncing: false });
  });

  it('retries an interrupted scan without losing or duplicating rows', async () => {
    const r = read();
    const activity = new WalletActivity(book, wallet, memoryStore());
    const fetchPage = r.logs.getMockImplementation()!;
    r.logs.mockImplementationOnce(fetchPage).mockRejectedValueOnce(Error('RPC unavailable'));
    await activity.refresh(r, 201n, [agent], 100n, () => true, () => {});
    expect(activity.view?.syncing).toBe(true);
    await activity.refresh(r, 201n, [agent], 100n, () => true, () => {});
    expect(activity.view?.rows).toHaveLength(3);
    expect(activity.view?.syncing).toBe(false);
  });
});
