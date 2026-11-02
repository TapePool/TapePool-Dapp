import type { SessionStore } from './source';

/** `sessionStorage`, with every access guarded: storage can be blocked, full or absent (a private window, a test). */
export function browserSession(): SessionStore {
  return {
    get(k) {
      try {
        return globalThis.sessionStorage?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        globalThis.sessionStorage?.setItem(k, v);
      } catch {
        /* blocked or full */
      }
    },
    remove(k) {
      try {
        globalThis.sessionStorage?.removeItem(k);
      } catch {
        /* blocked */
      }
    },
  };
}
