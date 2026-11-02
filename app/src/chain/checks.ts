import type { AddressBook } from '../config';
import type { Address, Hex } from '../model';
import { agentFactoryAbi, creditPolicyAbi, tapePoolAbi } from './abi';
import type { AppError } from './errors';
import { call, multicall, type Result } from './multicall';
import type { Reader } from './reader';

/**
 * The entry checks of SPEC-PHASE5-APP §10. They run before the actions that put something into the pool's
 * contracts (supply, create, move, borrow) and never before an exit (repay, withdraw, release, claim late, sweep,
 * take back). Anything that cannot be read counts as a failed check: the app fails closed.
 *
 * The Borrow button also waits for them (`checkEntries`, read with every refresh), and the click runs them again.
 *
 * The pinned addresses come from the address book of this build; nothing on chain or in a URL can change them.
 * A change of the pool's owner (Ownable2Step) or a voucher upgrade by the Safe changes none of these checks.
 */

const PREFIX = '363d3d373d3d3d363d73';
const SUFFIX = '5af43d82803e903d91602b57fd5bf3';

/** The runtime code of an EIP-1167 minimal proxy that delegates to `implementation`. */
export function cloneRuntime(implementation: Address): Hex {
  return `0x${PREFIX}${implementation.slice(2).toLowerCase()}${SUFFIX}`;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const fail = (check: string): AppError => ({ kind: 'entry', check });
const get = <T>(r: Result<T>): T | null => (r.ok ? r.value : null);

export interface CheckEnv {
  x: Reader;
  book: AddressBook;
}

/** The five reads of the wiring, in the order `judgeWiring` takes them. */
const wiringCalls = (book: AddressBook) =>
  [
    call<Address>(book.pool, tapePoolAbi, 'asset'),
    call<Address>(book.pool, tapePoolAbi, 'factory'),
    call<Address>(book.factory, agentFactoryAbi, 'pool'),
    call<Address>(book.pool, tapePoolAbi, 'policy'),
    call<Address>(book.policy, creditPolicyAbi, 'feed'),
  ] as const;

/**
 * The contract wiring: `pool.asset()` is BEM, `pool.factory()` and `factory.pool()` point at each other, and the
 * pinned credit rule feeds from the pinned report feed. With `borrow`, `pool.policy()` must also be the pinned
 * rule; if the owner swapped it, only borrow is blocked, with its own message (SPEC-PHASE5-APP §10).
 * Returns null when everything matches.
 */
function judgeWiring(book: AddressBook, rows: readonly Result<Address>[], borrow: boolean): AppError | null {
  const [asset, factory, factoryPool, policy, feed] = rows.map(get);
  if (!asset || !same(asset, book.bem)) return fail('pool.asset() is not the BEM token');
  if (!factory || !same(factory, book.factory)) return fail('pool.factory() is not the AgentFactory');
  if (!factoryPool || !same(factoryPool, book.pool)) return fail('factory.pool() is not the TapePool');
  if (borrow) {
    if (!policy) return fail('read failed: pool.policy()');
    if (!same(policy, book.policy)) return { kind: 'policy-changed' };
    if (!feed || !same(feed, book.receiver)) return fail('policy.feed() is not the pinned report feed');
  }
  return null;
}

/**
 * The agent is a clone of the factory's implementation (its code is exactly the EIP-1167 runtime for
 * `factory.implementation()`) and the factory recorded the connected account as its borrower.
 */
function judgeAgent(impl: Address | null, borrower: Address | null, code: Hex, account: Address): AppError | null {
  if (!impl) return fail('read failed: factory.implementation()');
  if (code.toLowerCase() !== cloneRuntime(impl)) return fail('the agent code is not a clone of the factory implementation');
  if (!borrower || !same(borrower, account)) return fail('factory.borrowerOf(agent) is not the connected account');
  return null;
}

export async function checkWiring(env: CheckEnv, o: { borrow: boolean }): Promise<AppError | null> {
  try {
    const rows = await multicall(env.x, env.book.multicall3, wiringCalls(env.book));
    return judgeWiring(env.book, rows as unknown as Result<Address>[], o.borrow);
  } catch {
    return fail('read failed: wiring');
  }
}

export async function checkAgent(env: CheckEnv, agent: Address, account: Address): Promise<AppError | null> {
  const { book } = env;
  try {
    const [i, b] = await multicall(env.x, book.multicall3, [call<Address>(book.factory, agentFactoryAbi, 'implementation'), call<Address>(book.factory, agentFactoryAbi, 'borrowerOf', [agent])] as const);
    return judgeAgent(get(i as Result<Address>), get(b as Result<Address>), await env.x.getCode(agent), account);
  } catch {
    return fail('read failed: agent');
  }
}

/**
 * The checks before a borrow for several agents at once, in one Multicall3 round pinned to `block` (the wiring, the
 * factory's implementation and each agent's borrower) plus one code read per agent. `null` is a pass, an error a
 * failure; every agent gets an entry, and a read that fails fails them all.
 */
export async function checkEntries(env: CheckEnv, agents: readonly Address[], account: Address, block?: bigint): Promise<Record<string, AppError | null>> {
  const { book } = env;
  const out: Record<string, AppError | null> = {};
  try {
    const rows = (await multicall(
      env.x,
      book.multicall3,
      [...wiringCalls(book), call<Address>(book.factory, agentFactoryAbi, 'implementation'), ...agents.map((a) => call<Address>(book.factory, agentFactoryAbi, 'borrowerOf', [a]))],
      { block },
    )) as unknown as Result<Address>[];
    const wiring = judgeWiring(book, rows.slice(0, 5), true);
    const impl = get(rows[5] as Result<Address>);
    for (const [i, a] of agents.entries()) {
      if (wiring) {
        out[a.toLowerCase()] = wiring;
        continue;
      }
      const code = await env.x.getCode(a);
      out[a.toLowerCase()] = judgeAgent(impl, get(rows[6 + i] as Result<Address>), code, account);
    }
  } catch {
    for (const a of agents) out[a.toLowerCase()] = fail('read failed: entry checks');
  }
  return out;
}
