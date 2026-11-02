import { describe, expect, it } from 'vitest';
import { allHashes, fixtureNames, make } from './helpers';

describe('every page in every fixture', () => {
  for (const name of fixtureNames) {
    it(`${name}: renders in English and Chinese with no style attribute`, () => {
      for (const hash of allHashes(name)) {
        for (const lang of ['en', 'cn'] as const) {
          const { html } = make(name, { hash, lang });
          expect(html, `${name} ${hash} ${lang}`).not.toMatch(/\sstyle\s*=/i);
          expect(html.length).toBeGreaterThan(200);
        }
      }
    });
  }
});
