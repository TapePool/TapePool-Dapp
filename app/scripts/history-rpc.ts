import type { Plugin } from 'vite';
import { loadEnv } from 'vite';
import type { AddressBook } from '../src/config';
import { readConfig } from '../src/config';
import { toEventSelector } from 'viem';
import { activityEvents } from '../src/chain/activityEvents';

/** Development-only access to the configured X Layer node. The browser may only request pool events or block headers. */
export function historyRpc(root: string): Plugin {
  let endpoint = '';
  let book: AddressBook;
  const topics = activityEvents.map((event) => toEventSelector(event));
  const block = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{1,12}$/i.test(v);
  return {
    name: 'pool-history-rpc',
    config(_, env) {
      if (env.command === 'serve' && !env.isPreview) {
        const cfg = loadEnv(env.mode, root, 'VITE_');
        if ((process.env.VITE_NETWORK ?? cfg.VITE_NETWORK) !== 'fork') {
          book = readConfig({ ...cfg, VITE_NETWORK: process.env.VITE_NETWORK ?? cfg.VITE_NETWORK }).book;
          endpoint = process.env.XLAYER_RPC || loadEnv(env.mode, root + '/..', 'XLAYER_RPC').XLAYER_RPC || '';
        }
      }
      return { define: { __TP_HISTORY_RPC__: JSON.stringify(Boolean(endpoint)) } };
    },
    configureServer(server) {
      if (!endpoint) return;
      server.middlewares.use('/__pool-history', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        try {
          const peer = req.socket.remoteAddress;
          if (req.method !== 'POST' || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '') ||
              (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) ||
              !req.headers['content-type']?.startsWith('application/json')) {
            res.statusCode = 403;
            res.end('{}');
            return;
          }
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 2048) throw Error();
          }
          const { method, params, id } = JSON.parse(body);
          let query;
          if (method === 'eth_getBlockByNumber' && block(params?.[0]) && params[1] === false) {
            query = [params[0], false];
          } else if (method === 'eth_getLogs' && params?.[0]?.address?.toLowerCase() === book.pool.toLowerCase()) {
            const { fromBlock, toBlock } = params[0];
            if (!block(fromBlock) || !block(toBlock) || BigInt(fromBlock) < book.poolDeployBlock ||
                BigInt(toBlock) < BigInt(fromBlock) || BigInt(toBlock) - BigInt(fromBlock) >= 10000n) throw Error();
            query = [{ address: book.pool, topics: [topics], fromBlock, toBlock }];
          } else throw Error();
          const reply = await fetch(endpoint, {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(12000),
            body: JSON.stringify({ jsonrpc: '2.0', id, method, params: query }),
          });
          const data = await reply.json();
          if (!reply.ok || data.error || data.result == null) throw Error();
          res.end(JSON.stringify({ jsonrpc: '2.0', id, result: data.result }));
        } catch {
          res.statusCode = 502;
          res.end('{"error":"History read failed"}');
        }
      });
    },
  };
}
