// The single-file build (SPEC-PHASE5-APP §13, the fallback if the DeWEB gateway cannot serve several files or rejects
// 'self'): one HTML file with the script and the stylesheet inside it, and a Content-Security-Policy that allows exactly
// those two by SHA-256 hash. Pure functions; scripts/build-single.mjs does the I/O.

import { extractMeta, hashSource, parse, replaceMeta, serialize } from './csp.mjs';

const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const SCRIPT_TAG = /<script type="module" crossorigin src="\.\/assets\/([^"]+\.js)"><\/script>/g;
const STYLE_TAG = /<link rel="stylesheet" crossorigin href="\.\/assets\/([^"]+\.css)">/g;

/** Text that would end or confuse an inline <script> or <style> element, or that the HTML parser would rewrite before the browser hashes it. */
function unsafeInline(text, kind) {
  const bad = kind === 'script' ? [/<\/script/i, /<script/i, /<!--/] : [/<\/style/i, /<!--/];
  for (const re of bad) if (re.test(text)) return `contains ${re.source}`;
  if (text.includes('\r')) return 'contains a carriage return, which the HTML parser would turn into a newline and so change the hash';
  if (text.includes('\0')) return 'contains a NUL character';
  return null;
}

/**
 * Fold the built script and stylesheet into the page and rewrite the policy: script-src and style-src become the hash of
 * the inline text, font-src becomes data: (fonts are data: URIs in the stylesheet), and nothing else changes.
 * Fails closed: if the page has not exactly one of each tag, or the text could not be inlined safely, it throws.
 */
export function inlineSingle({ html, js, css, assets = {} }) {
  const scripts = [...html.matchAll(SCRIPT_TAG)];
  const styles = [...html.matchAll(STYLE_TAG)];
  if (scripts.length !== 1 || styles.length !== 1) throw new Error(`single-file build: expected one script and one stylesheet tag, found ${scripts.length} and ${styles.length}`);
  for (const [text, kind] of [
    [js, 'script'],
    [css, 'style'],
  ]) {
    const why = unsafeInline(text, kind);
    if (why) throw new Error(`single-file build: the ${kind} cannot be inlined: it ${why}`);
  }
  const csp = extractMeta(html);
  if (csp === null) throw new Error('single-file build: the built page has no Content-Security-Policy meta tag');
  const p = parse(csp);
  p['script-src'] = [hashSource(js)];
  p['style-src'] = [hashSource(css)];
  p['font-src'] = ['data:'];
  let out = html.replace(SCRIPT_TAG, () => `<script type="module">${js}</script>`).replace(STYLE_TAG, () => `<style>${css}</style>`);
  // the page's own references to a file (the icon): Vite does not inline those, so they become data: URIs here
  const used = new Set();
  out = out.replace(/(href|src)="\.\/assets\/([^"]+)"/g, (_whole, attr, name) => {
    const bytes = assets[name];
    const mime = MIME[name.slice(name.lastIndexOf('.')).toLowerCase()];
    if (!bytes || !mime) throw new Error(`single-file build: the page refers to ./assets/${name}, which cannot be inlined`);
    used.add(name);
    return `${attr}="data:${mime};base64,${Buffer.from(bytes).toString('base64')}"`;
  });
  const unused = Object.keys(assets).filter((n) => !used.has(n));
  if (unused.length) throw new Error(`single-file build: files the page does not use: ${unused.join(', ')}`);
  out = replaceMeta(out, serialize(p));
  return out;
}

/**
 * Check a single-file page the way a browser will: exactly one inline script and one inline style, and a policy that
 * names the SHA-256 of each as its only script and style source. Returns the problems found (none = good).
 */
export function verifySingle(html) {
  const problems = [];
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  const styles = [...html.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)];
  if (scripts.length !== 1 || scripts[0][1] !== ' type="module"') problems.push(`expected one <script type="module">, found ${scripts.length}`);
  if (styles.length !== 1 || styles[0][1] !== '') problems.push(`expected one <style>, found ${styles.length}`);
  if (/<script[^>]*\ssrc=/i.test(html) || /<link[^>]*rel="stylesheet"/i.test(html)) problems.push('the page still loads a script or a stylesheet by URL');
  if (/(?:href|src)="\.\/assets\//.test(html)) problems.push('the page still refers to a file under ./assets/');
  const csp = extractMeta(html);
  if (csp === null) return [...problems, 'no Content-Security-Policy meta tag'];
  const p = parse(csp);
  if (scripts.length === 1 && (p['script-src'] ?? []).join(' ') !== hashSource(scripts[0][2])) problems.push(`script-src is ${(p['script-src'] ?? []).join(' ')}, not the hash of the inline script`);
  if (styles.length === 1 && (p['style-src'] ?? []).join(' ') !== hashSource(styles[0][2])) problems.push(`style-src is ${(p['style-src'] ?? []).join(' ')}, not the hash of the inline style`);
  if ((p['font-src'] ?? []).join(' ') !== 'data:') problems.push(`font-src is ${(p['font-src'] ?? []).join(' ')}, expected data:`);
  return problems;
}
