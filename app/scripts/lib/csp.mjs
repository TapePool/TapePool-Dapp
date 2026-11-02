// The Content-Security-Policy of the app (SPEC-PHASE5-APP §10), built in one place so that the build, the size check, the
// single-file build, the smoke test and the hosting notes all agree. Pure functions, no I/O.

import { createHash } from 'node:crypto';

/** Directive order of the policy the app ships. */
const ORDER = ['default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'connect-src', 'base-uri', 'form-action'];

/**
 * The policy of the multi-file build. `connect` is the list of origins the app talks to: the two RPCs and the keeper (when
 * there is one). Everything else is the same-origin files of the build, with images also allowed as data: URIs.
 * No 'unsafe-inline', no 'unsafe-eval', no inline script or style (the single-file build swaps in SHA-256 hashes instead).
 * @param {{ connect?: readonly string[], script?: readonly string[], style?: readonly string[], font?: readonly string[], img?: readonly string[] }} [opts]
 * @returns {Record<string, string[]>}
 */
export function policy(opts = {}) {
  return {
    'default-src': ["'self'"],
    'script-src': [...(opts.script ?? ["'self'"])],
    'style-src': [...(opts.style ?? ["'self'"])],
    'img-src': [...(opts.img ?? ["'self'", 'data:'])],
    'font-src': [...(opts.font ?? ["'self'"])],
    'connect-src': [...new Set(opts.connect ?? [])],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  };
}

/** @param {Record<string, string[]>} p */
export function serialize(p) {
  const names = [...ORDER.filter((n) => n in p), ...Object.keys(p).filter((n) => !ORDER.includes(n))];
  // an empty connect-src is written as 'none', never left out (a missing directive would fall back to default-src 'self')
  return names.map((n) => `${n} ${(p[n].length ? p[n] : ["'none'"]).join(' ')}`).join('; ');
}

/** @param {string} text */
export function parse(text) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const part of text.split(';')) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const [name, ...values] = words;
    if (name in out) throw new Error(`CSP: directive ${name} appears twice`);
    out[name] = values;
  }
  return out;
}

/** The CSP source expression for an inline script or style: `'sha256-<base64 of the SHA-256 of the exact text>'`. */
export function hashSource(text) {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/** Origin of a URL: scheme, host and port, no path. Throws on anything that is not an absolute http(s) URL. */
export function originOf(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`CSP: not an http(s) URL: ${url}`);
  return u.origin;
}

const META_RE = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g;

/** The CSP of an HTML page's meta tag; null when there is none, and an error when there are several. */
export function extractMeta(html) {
  const all = [...html.matchAll(META_RE)];
  if (all.length > 1) throw new Error('CSP: more than one Content-Security-Policy meta tag');
  return all.length === 1 ? all[0][1] : null;
}

/**
 * Put the policy (and a no-referrer policy, for hosts that cannot send the header) right after the charset tag, so that it
 * comes before every script, style and link, which is where a meta policy starts to count. Throws unless the page has
 * exactly one charset tag and no policy yet.
 */
export function injectMeta(html, csp) {
  if (extractMeta(html) !== null) throw new Error('CSP: the page already has a Content-Security-Policy meta tag');
  const charset = '<meta charset="utf-8">';
  if (html.split(charset).length !== 2) throw new Error('CSP: expected exactly one <meta charset="utf-8"> to anchor the policy');
  return html.replace(charset, `${charset}\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<meta name="referrer" content="no-referrer">`);
}

/** Replace the policy of a page that has one. */
export function replaceMeta(html, csp) {
  if (extractMeta(html) === null) throw new Error('CSP: the page has no Content-Security-Policy meta tag');
  return html.replace(META_RE, () => `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
}

/**
 * The response headers a static host should send with the page (SPEC-PHASE5-APP §4, §13): the same policy as the meta tag,
 * plus frame-ancestors, which a meta tag cannot carry.
 */
export function hostHeaders(csp) {
  return {
    'Content-Security-Policy': `${csp}; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}
