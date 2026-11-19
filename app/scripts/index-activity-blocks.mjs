// node --env-file=../.env scripts/index-activity-blocks.mjs POOL DEPLOY_BLOCK
// Index finalized event locations only. Wallets, amounts, hashes and times are read in the browser.
import { writeFile } from 'node:fs/promises';
import { createPublicClient, getAddress, http } from 'viem';
import { activityEvents } from '../src/chain/activityEvents.ts';

const pool = getAddress(process.argv[2]);
const start = BigInt(process.argv[3]);
const rpc = createPublicClient({ transport: http(process.env.XLAYER_RPC) });
try {
  if (await rpc.getChainId() !== 196) throw Error();
  const head = await rpc.getBlock({ blockTag: 'finalized' });
  if (start < 0n || start > head.number || !(await rpc.getCode({ address: pool, blockNumber: head.number }))) throw Error();
  const blocks = new Set();
  for (let from = start; from <= head.number; from += 10000n) {
    const end = from + 9999n;
    const logs = await rpc.getLogs({ address: pool, events: activityEvents, fromBlock: from, toBlock: end < head.number ? end : head.number, strict: true });
    for (const log of logs) blocks.add(Number(log.blockNumber));
  }
  const index = { pool, start: Number(start), through: Number(head.number), blocks: [...blocks].sort((a, b) => a - b) };
  await writeFile(new URL('../src/chain/activityBlocks.json', import.meta.url), JSON.stringify(index, null, 2) + '\n');
  console.log(`Indexed ${blocks.size} active blocks through ${head.number}.`);
} catch {
  // RPC errors can include a private endpoint. Never print them.
  console.error('Could not complete the X Layer event scan.');
  process.exitCode = 1;
}
