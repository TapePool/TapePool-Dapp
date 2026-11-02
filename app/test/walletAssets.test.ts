import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RECOMMENDED } from '../src/logic/wallets';

/**
 * The wallet logos and the two "What is a Wallet?" illustrations in src/assets/wallets/ were copied from an npm package, so they
 * are treated as untrusted files: every one of them must be a plain drawing (shapes, gradients and clip paths) with nothing that
 * can run, load or link. They are used only as `<img src>`, and the policy would block the rest, but nothing here depends on that.
 */

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'wallets');
const LICENSE = 'LICENSE-rainbowkit.txt';
const LOGO_MAX = 10_000;
const ILLUSTRATION_MAX = 20_000;
const ILLUSTRATIONS = ['about-home.svg', 'about-login.svg'];

/** The elements a plain drawing needs. Anything else (`script`, `foreignObject`, `image`, `style`, `use`, `a`, `animate`, `set`...) is refused. */
const ELEMENTS = new Set(['svg', 'path', 'g', 'defs', 'clipPath', 'linearGradient', 'radialGradient', 'stop', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'mask']);

/** Everything wrong with an SVG file's text; an empty list is a clean file. */
export function problemsIn(svg: string): string[] {
  const out: string[] = [];
  const bad = (cond: boolean, what: string): void => {
    if (cond) out.push(what);
  };
  bad(!/^<svg[\s>]/.test(svg) || !svg.trimEnd().endsWith('</svg>'), 'is not one <svg> element');
  bad(!/\sviewBox="[\d.\s-]+"/.test(svg), 'has no viewBox');
  bad(/<script/i.test(svg), '<script>');
  bad(/\son[a-z]+\s*=/i.test(svg), 'an on* handler');
  bad(/foreignObject/i.test(svg), '<foreignObject>');
  bad(/<image/i.test(svg), '<image>');
  bad(/<style/i.test(svg), '<style>');
  bad(/<use[\s>]/i.test(svg), '<use>');
  bad(/<a[\s>]/i.test(svg), '<a>');
  bad(/<(animate|set)/i.test(svg), 'an animation element');
  bad(/href/i.test(svg), 'an href');
  bad(/javascript:/i.test(svg), 'javascript:');
  bad(/data:/i.test(svg), 'a data: URI');
  bad(/@import/i.test(svg), '@import');
  bad(/<!(ENTITY|DOCTYPE)|<\?xml-stylesheet/i.test(svg), 'an entity, doctype or stylesheet declaration');
  bad(/url\(\s*(?!#)/i.test(svg), 'a url( that is not a #fragment');
  for (const m of svg.matchAll(/https?:\/\/[^\s"'<>)]*/gi)) bad(m[0] !== 'http://www.w3.org/2000/svg', `an address (${m[0].slice(0, 40)})`);
  for (const m of svg.matchAll(/<\/?([A-Za-z][\w:-]*)/g)) bad(!ELEMENTS.has(m[1] ?? ''), `the element <${m[1]}>`);
  // every #fragment a paint refers to is defined in the same file
  const ids = new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) bad(!ids.has(m[1] ?? ''), `url(#${m[1]}) points at nothing in the file`);
  return out;
}

const files = fs.readdirSync(DIR).sort();
const svgs = files.filter((f) => f.endsWith('.svg'));

describe('the files in src/assets/wallets', () => {
  it('are the logos of the recommended wallets, the two illustrations and the licence, and nothing else', () => {
    const want = [...RECOMMENDED.map((r) => `${r.key}.svg`), ...ILLUSTRATIONS, LICENSE].sort();
    expect(files).toEqual(want);
  });

  it('are every one of them used by the app', () => {
    const source = fs.readFileSync(path.resolve(DIR, '..', '..', 'render', 'wallets.ts'), 'utf8');
    for (const f of svgs) expect(source, f).toContain(`assets/wallets/${f}`);
  });

  for (const f of svgs) {
    it(`${f} is a plain drawing: no script, handler, foreignObject, image, link or external reference`, () => {
      expect(problemsIn(fs.readFileSync(path.join(DIR, f), 'utf8')), f).toEqual([]);
    });

    it(`${f} is small`, () => {
      const size = fs.statSync(path.join(DIR, f)).size;
      expect(size, f).toBeLessThanOrEqual(ILLUSTRATIONS.includes(f) ? ILLUSTRATION_MAX : LOGO_MAX);
    });
  }

  it('together stay well inside the size budget of the build', () => {
    const total = svgs.reduce((n, f) => n + fs.statSync(path.join(DIR, f)).size, 0);
    expect(total).toBeLessThan(40_000);
  });

  it('come with the licence text of the package they were taken from', () => {
    const text = fs.readFileSync(path.join(DIR, LICENSE), 'utf8');
    expect(text).toContain('MIT License');
    expect(text).toContain('Copyright (c) 2024 Rainbow');
    expect(text).toContain('Permission is hereby granted, free of charge');
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(text).toContain('@rainbow-me/rainbowkit');
    expect(text).toContain('2.2.11');
    for (const f of svgs) expect(text, f).toContain(f);
  });
});

describe('the check itself', () => {
  const clean = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><defs><linearGradient id="a"><stop offset="0"/></linearGradient></defs><path fill="url(#a)" d="M0 0h8v8H0z"/></svg>';
  const wrap = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">${inner}</svg>`;

  it('passes a plain drawing', () => {
    expect(problemsIn(clean)).toEqual([]);
  });

  it('flags everything an untrusted drawing must not have', () => {
    const cases: [string, string][] = [
      ['<script>alert(1)</script>', '<script>'],
      ['<path d="M0 0" onload="alert(1)"/>', 'an on* handler'],
      ['<path d="M0 0" onclick = "x"/>', 'an on* handler'],
      ['<foreignObject><div/></foreignObject>', '<foreignObject>'],
      ['<image href="https://example.com/x.png"/>', '<image>'],
      ['<image xlink:href="data:image/png;base64,AA=="/>', '<image>'],
      ['<style>@import url(https://example.com/a.css);</style>', '<style>'],
      ['<use href="#a"/>', '<use>'],
      ['<a href="https://example.com"><path d="M0 0"/></a>', '<a>'],
      ['<animate attributeName="x"/>', 'an animation element'],
      ['<set attributeName="x"/>', 'an animation element'],
      ['<path fill="url(https://example.com/a.svg#b)" d="M0 0"/>', 'a url( that is not a #fragment'],
      ['<path fill="url( http://example.com/a)" d="M0 0"/>', 'a url( that is not a #fragment'],
      ['<path d="M0 0" fill="url(#missing)"/>', 'url(#missing) points at nothing in the file'],
      ['<path d="M0 0" stroke="url(data:image/svg+xml;base64,AA==)"/>', 'a data: URI'],
      ['<text>javascript:alert(1)</text>', 'javascript:'],
      ['<path d="M0 0"/><metadata>https://example.com/x</metadata>', 'an address (https://example.com/x)'],
    ];
    for (const [inner, what] of cases) expect(problemsIn(wrap(inner)), inner).toContain(what);
  });

  it('flags a file that is not one <svg>, or has no viewBox, or declares an entity', () => {
    expect(problemsIn('<html></html>')).toContain('is not one <svg> element');
    expect(problemsIn('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')).toContain('has no viewBox');
    expect(problemsIn(`<!DOCTYPE svg [<!ENTITY x "y">]>${clean}`)).toContain('an entity, doctype or stylesheet declaration');
    expect(problemsIn(`${clean}<script/>`)).toContain('is not one <svg> element');
  });
});
