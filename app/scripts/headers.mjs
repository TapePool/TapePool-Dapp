// `npm run headers [dir]`: the response headers a static host should send with the app (app/README.md, "HTTPS hosting"),
// taken from the policy that is inside the built page, so the header and the meta tag cannot differ.
//
//   node scripts/headers.mjs [dist]

import fs from 'node:fs';
import path from 'node:path';
import { extractMeta, hostHeaders } from './lib/csp.mjs';

const dir = process.argv[2] ?? 'dist';
const file = path.resolve(dir, 'index.html');
if (!fs.existsSync(file)) {
  console.error(`headers: ${file} does not exist; build first`);
  process.exit(1);
}
const csp = extractMeta(fs.readFileSync(file, 'utf8'));
if (!csp) {
  console.error('headers: index.html has no Content-Security-Policy meta tag');
  process.exit(1);
}
const h = hostHeaders(csp);
console.log('# send these with index.html (and, for X-Content-Type-Options, with every file):');
for (const [k, v] of Object.entries(h)) console.log(`${k}: ${v}`);
console.log('');
console.log('# caching: /assets/* has a content hash in its name -> Cache-Control: public, max-age=31536000, immutable');
console.log('#          /index.html                           -> Cache-Control: no-cache');
