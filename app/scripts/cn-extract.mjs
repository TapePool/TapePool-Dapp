// Pull every piece of Chinese text out of app/src/**/*.ts, so check-cn.js can read it one piece per line.
// Strings in single or double quotes and template literals are all covered; a template is split at each ${}
// (the same way the prototype's concatenation split the text). Comments are skipped because the compiler never makes them nodes.
//
//   node scripts/cn-extract.mjs        writes .cache/cn-strings.txt

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAN = /[一-鿿]/;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) yield p;
  }
}

/** Markup around the text: drop the tags, and the half tag a `${}` cut open. */
function clean(piece) {
  let s = piece.replace(/\n\s*/g, '');
  const firstClose = s.indexOf('>');
  const firstOpen = s.indexOf('<');
  if (firstClose !== -1 && (firstOpen === -1 || firstClose < firstOpen)) s = s.slice(firstClose + 1);
  s = s.replace(/<[^>]*$/, '').replace(/<[^>]*>/g, '');
  return s;
}

const out = [];
const files = [...walk(path.join(root, 'src'))].sort();
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const take = (s) => {
    if (HAN.test(s)) {
      const c = clean(s);
      if (HAN.test(c)) out.push(c);
    }
  };
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) take(node.text);
    else if (ts.isTemplateExpression(node)) {
      take(node.head.text);
      for (const span of node.templateSpans) take(span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
fs.writeFileSync(path.join(root, '.cache', 'cn-strings.txt'), `${out.join('\n')}\n`);
console.log(`${out.length} Chinese pieces from ${files.length} files`);
