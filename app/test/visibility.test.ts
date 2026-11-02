// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createKeeperClient } from '../src/chain/keeper';
import { ChainSource, STALE_AFTER_MS } from '../src/chain/source';
import { memoryStore } from '../src/logic/history';
import { NOW, buildWorld } from './world';

describe('a tab that comes back', () => {
  it('reads again at once and does not call its old data stale while it does', async () => {
    const w = buildWorld();
    const clock = { ms: 0 };
    const src = new ChainSource({
      config: w.config,
      x: w.x,
      b: w.b,
      wallet: { account: null, chainId: null, subscribe: () => () => undefined },
      keeper: createKeeperClient(null),
      store: memoryStore(),
      clock: () => clock.ms,
      wall: () => NOW * 1000,
    });
    src.start();
    await src.refresh();
    expect(src.snapshot(null).stale).toEqual({});

    // the tab sits hidden for ten minutes: nothing refreshed it
    clock.ms += 10 * 60_000;
    expect(src.snapshot(null).stale).toEqual({ pool: true });

    // it comes back: the first paint is not stale, and the read it started clears the age
    const before = w.x.calls.length;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(src.snapshot(null).stale).toEqual({});
    await src.refresh();
    expect(w.x.calls.length).toBeGreaterThan(before);
    expect(src.snapshot(null).stale).toEqual({});
    clock.ms += STALE_AFTER_MS + 1;
    expect(src.snapshot(null).stale).toEqual({ pool: true }); // the grace ended with the read
    src.dispose();
  });
});
