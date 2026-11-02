// DeWEB publishing tool for the TapePool app (SPEC-PHASE5-APP §13).
//
//   node scripts/deweb.mjs plan      [--dir dist] --months N [--chunk-bytes 24000] [--prune] [--rpc URL] [--offline] [--out DIR]
//   node scripts/deweb.mjs verify    [--dir dist] [--rpc URL]          read-only: is the build on chain, byte for byte?
//   node scripts/deweb.mjs rehearse  [--dir dist [--dir dist-single]] [--months N] [--chunk-bytes N] [--update-test] [--fee-test] [--script]
//                                    [--rpc http://127.0.0.1:PORT | --port N --fork-url URL]
//
// `plan` and `verify` only read the chain. They contain no signing code. `rehearse` is the only command that sends, and it
// sends only to a local anvil node (it checks that the node says it is anvil, on chain 196, and refuses any other address).
// The real publish is the circuit holder's own action: this tool never holds a key.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeFunctionData, formatEther, getAddress, toHex } from 'viem';
import { getBlockNumber, readContract } from 'viem/actions';
import { CHUNK_BYTES, chunkRanges, fileGas, readDist, sha256Hex, shellContentType } from './lib/dist.mjs';
import { ABI, SUBMISSION_DEADLINE, TARGET, buildPlan, castScript, gatewayHost, gatewayOpenHost, landing, l1FeeFor, makeClient, planTotals, readPrices, readState, offlineState, sameFile, verifyFiles } from './lib/deweb.mjs';

/* ───────── arguments and printing ───────── */

function parseArgs(argv) {
  const o = { dirs: [], flags: new Set(), kv: {} };
  const bool = new Set(['prune', 'offline', 'json', 'update-test', 'fee-test', 'script', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (bool.has(k)) o.flags.add(k);
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`--${k} needs a value`);
      if (k === 'dir') o.dirs.push(v);
      else o.kv[k] = v;
    }
  }
  return o;
}

const comma = (n) => Number(n).toLocaleString('en-US');
const okb = (wei) => {
  const s = formatEther(BigInt(wei));
  return `${s.includes('.') ? s.replace(/(\.\d{0,6})\d*$/, '$1') : s} OKB`;
};
const short = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function filesTable(files, chunkBytes) {
  const lines = [`  ${pad('file', 52)}${padL('bytes', 9)}${padL('chunks', 7)}${padL('est. gas', 13)}  sha256`];
  for (const f of files) lines.push(`  ${pad(f.path, 52)}${padL(comma(f.size), 9)}${padL(chunkRanges(f.size, chunkBytes).length, 7)}${padL(comma(fileGas(f.size, chunkBytes)), 13)}  ${f.sha256.slice(0, 12)}…`);
  return lines.join('\n');
}

/* ───────── plan ───────── */

async function cmdPlan(o) {
  const dir = o.dirs[0] ?? 'dist';
  const chunkBytes = Number(o.kv['chunk-bytes'] ?? CHUNK_BYTES);
  const months = o.kv.months === undefined ? undefined : Number(o.kv.months);
  const rpc = o.kv.rpc ?? TARGET.publicRpc;
  const files = readDist(dir);
  let state;
  let prices = null;
  if (o.flags.has('offline')) state = offlineState();
  else {
    const client = makeClient(rpc);
    try {
      state = await readState(client);
      prices = await readPrices(client, state.holder);
    } catch (e) {
      throw new Error(`cannot read the chain at ${rpc} (${e.shortMessage ?? e.message}); use --offline to plan for a container that is not opened yet`);
    }
  }
  const plan = buildPlan({ files, state, months, chunkBytes, prune: o.flags.has('prune') });
  const tot = planTotals(plan);

  // does X Layer add a data fee? Ask the oracle about the biggest transaction of the plan (read-only; 0 means no fee)
  let l1 = null;
  if (prices && plan.txs.length) {
    const big = plan.txs.reduce((m, t) => (t.data.length > m.data.length ? t : m));
    l1 = await l1FeeFor(makeClient(rpc), big.data);
  }

  const warnings = [];
  if (!state.processorOk) warnings.push(`cpuAt(${TARGET.processorNumber}) is not the circuits contract: the name ${state.name} would not belong to this circuit`);
  if (!state.registryImplOk) warnings.push('the site store proxy runs an implementation TAP-10 does not list: a shell answers store-changed and shows nothing');
  if (!state.bindingImplOk) warnings.push('the payment proxy runs an implementation TAP-10 does not list: a shell answers store-changed and shows nothing');
  if (state.holder.toLowerCase() !== TARGET.expectedHolder.toLowerCase()) warnings.push(`the circuit is held by ${state.holder}, not by ${TARGET.expectedHolder}: the holder signs every step`);
  if (state.offline) warnings.push('OFFLINE plan: it assumes the container is not opened and the monthly fee is 0; run it online before signing');
  const bind = plan.txs.find((t) => t.kind === 'bind');
  if (bind && bind.expiresAt < SUBMISSION_DEADLINE) warnings.push(`the name would stop being live on ${new Date(bind.expiresAt * 1000).toISOString().slice(0, 10)}, before the submission deadline of 2026-12-07 (and a Demo Day follows it): bind for more months`);
  if (!bind && state.live) warnings.push(`the name is already live until ${new Date(Number(state.paidUntil) * 1000).toISOString().slice(0, 10)}${Number(state.paidUntil) < SUBMISSION_DEADLINE ? ', which is before the submission deadline of 2026-12-07: pass --months to extend it' : ''}`);
  if (chunkBytes < CHUNK_BYTES) warnings.push(`chunks of ${chunkBytes} bytes (the protocol allows up to ${CHUNK_BYTES}): more transactions, same result`);

  const out = [];
  out.push(`DeWEB plan for ${dir}   (read-only: nothing is signed or sent)`);
  out.push('');
  out.push(`  site name     ${state.name}`);
  out.push(`  address       https://${gatewayHost()}/     compatibility tier https://${gatewayOpenHost()}/`);
  out.push(`  circuit       Circuits ${TARGET.circuits} id ${TARGET.circuitId}, held by ${state.holder}`);
  out.push(`  container     ${state.container}   ${state.opened ? 'opened' : 'NOT opened yet'}   live: ${state.live ? 'yes' : 'no'}   monthlyFee: ${okb(state.monthlyFee)}`);
  out.push(`  on chain now  ${state.files.size} file(s); fallback ${JSON.stringify(state.fallback)}`);
  out.push('');
  out.push(filesTable(files, chunkBytes));
  out.push(`  ${pad('total', 52)}${padL(comma(files.reduce((s, f) => s + f.size, 0)), 9)}${padL(files.reduce((s, f) => s + chunkRanges(f.size, chunkBytes).length, 0), 7)}`);
  if (plan.skipped.length) out.push(`\n  already on chain, unchanged (skipped): ${plan.skipped.join(', ')}`);
  if (plan.stale.length) out.push(`\n  on chain but not in this build: ${plan.stale.join(', ')}   ${o.flags.has('prune') ? '(removeFile steps added)' : '(use --prune to remove them)'}`);
  out.push('');
  out.push(`  transactions, in this order, all signed by the holder (${plan.txs.length}):`);
  for (const t of plan.txs) {
    out.push(`  ${padL(t.n, 3)}  ${pad(t.fn.split('(')[0], 12)}${pad(short(t.to), 16)}${pad(t.value ? okb(t.value) : '-', 12)}${padL(comma((t.data.length - 2) / 2), 9)} B  ${t.label}`);
  }
  out.push('');
  out.push(`  transactions ${tot.txs}, calldata ${comma(tot.calldataBytes)} B (largest ${comma(tot.largest)} B; the node limit in question is 128 KiB), estimated gas ${comma(tot.gas)}`);
  if (prices) {
    const gasCost = BigInt(tot.gas) * prices.gasPrice;
    const needed = tot.value + (gasCost * 3n) / 2n;
    out.push(`  gas price now ${Number(prices.gasPrice) / 1e9} gwei: gas ≈ ${okb(gasCost)}; values sent ${okb(tot.value)}`);
    out.push(`  L1 data fee   ${l1 === null ? 'could not be read' : l1 === 0n ? '0 for the largest transaction (the oracle charges nothing today)' : `${okb(l1)} for the largest transaction: add it for every chunk`}`);
    out.push(`  holder balance ${okb(prices.holderBalance)}; this plan needs about ${okb(needed)} (values + 1.5 x gas)  ->  ${prices.holderBalance >= needed ? 'enough' : 'NOT ENOUGH'}`);
  }
  if (bind) out.push(`  bind: ${bind.args[2]} month(s) of 30 days, live until ${new Date(bind.expiresAt * 1000).toISOString().slice(0, 10)} (${Math.round((bind.expiresAt - state.now) / 86400)} days from now); the fee can change at any time, so the value is re-read when you plan again`);
  for (const w of warnings) out.push(`  WARNING: ${w}`);

  if (o.kv.out) {
    const dirOut = path.resolve(o.kv.out);
    fs.mkdirSync(path.join(dirOut, 'calldata'), { recursive: true });
    fs.mkdirSync(path.join(dirOut, 'chunks'), { recursive: true });
    for (const t of plan.txs) fs.writeFileSync(path.join(dirOut, 'calldata', `${String(t.n).padStart(3, '0')}-${t.kind}.hex`), `${t.data}\n`);
    const { script, chunkFiles } = castScript(plan);
    for (const [f, hex] of chunkFiles) fs.writeFileSync(path.join(dirOut, f), hex);
    fs.writeFileSync(path.join(dirOut, 'publish.sh'), script);
    fs.writeFileSync(
      path.join(dirOut, 'plan.json'),
      JSON.stringify({ name: state.name, container: state.container, chunkBytes, txs: plan.txs.map((t) => ({ n: t.n, kind: t.kind, label: t.label, to: t.to, fn: t.fn, value: t.value.toString(), gasEstimate: t.gas, data: t.data })) }, null, 1),
    );
    out.push('');
    out.push(`  written to ${dirOut}: plan.json, calldata/*.hex (raw calldata per transaction), publish.sh (cast send lines; nothing has been run) and chunks/*.hex`);
    out.push('  keep that folder out of the repository (it is large and is not source).');
  }
  console.log(out.join('\n'));
  return plan;
}

/* ───────── verify (read-only) ───────── */

async function cmdVerify(o) {
  const dir = o.dirs[0] ?? 'dist';
  const files = readDist(dir);
  const client = makeClient(o.kv.rpc ?? TARGET.publicRpc);
  const state = await readState(client);
  const problems = [];
  if (!state.opened) problems.push('the container is not opened');
  else {
    const r = await verifyFiles(client, files, state.container);
    problems.push(...r.problems);
    for (const c of r.checked) console.log(`  ok  ${pad(c.path, 52)}${padL(comma(c.size), 9)} B  ${c.chunks} chunk(s)  via ${c.via}`);
    const extra = [...state.files.keys()].filter((p) => !files.some((f) => f.path === p));
    if (extra.length) console.log(`  note: on chain but not in ${dir}: ${extra.join(', ')}`);
    if (state.fallback !== 'index.html') problems.push(`fallback is ${JSON.stringify(state.fallback)}, expected "index.html"`);
    if (!state.live) problems.push(`${state.name} is not live (isLive false)`);
  }
  if (!state.registryImplOk || !state.bindingImplOk) problems.push('a proxy runs an implementation TAP-10 does not list');
  console.log(problems.length ? `\nFAILED:\n  ${problems.join('\n  ')}` : `\nverified: ${files.length} files match ${dir}; ${state.name} is live at https://${gatewayHost()}/`);
  if (problems.length) process.exitCode = 1;
}

/* ───────── rehearse: only on a local anvil fork ───────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The sending node must be a local anvil on chain 196: not merely a local URL, which could be a tunnel to a real node. */
async function assertLocalAnvil(client, url) {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.protocol !== 'http:') throw new Error(`refusing ${url}: the rehearsal sends only to a local anvil node (http://127.0.0.1:<port>)`);
  const version = String(await client.request({ method: 'web3_clientVersion' }));
  if (!/anvil/i.test(version)) throw new Error(`refusing ${url}: web3_clientVersion is ${JSON.stringify(version)}, not anvil`);
  const chain = Number(BigInt(await client.request({ method: 'eth_chainId' })));
  if (chain !== TARGET.chainId) throw new Error(`refusing ${url}: chain id ${chain}, expected ${TARGET.chainId}`);
  await client.request({ method: 'anvil_nodeInfo' });
  return version;
}

async function startAnvil({ forkUrl, port, forkBlock }) {
  const args = ['--fork-url', forkUrl, '--port', String(port), '--host', '127.0.0.1', '--auto-impersonate', '--hardfork', 'cancun', '--silent', '--compute-units-per-second', '100', '--retries', '10', '--timeout', '60000'];
  if (forkBlock) args.push('--fork-block-number', String(forkBlock));
  const child = spawn('anvil', args, { stdio: 'ignore', windowsHide: true });
  const stop = () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
  process.on('exit', stop);
  const url = `http://127.0.0.1:${port}`;
  const client = makeClient(url);
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`anvil exited with code ${child.exitCode} (is port ${port} taken?)`);
    try {
      await client.request({ method: 'eth_chainId' });
      return { url, stop };
    } catch {
      await sleep(250);
    }
  }
  stop();
  throw new Error('anvil did not start within 60 s');
}

async function sendTx(client, from, tx) {
  const hash = await client.request({ method: 'eth_sendTransaction', params: [{ from, to: tx.to, data: tx.data, value: toHex(tx.value ?? 0n) }] });
  for (let i = 0; i < 400; i++) {
    const r = await client.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (r) {
      if (r.status !== '0x1') throw new Error(`transaction ${tx.n ?? ''} (${tx.label ?? tx.kind}) reverted: ${hash}`);
      return { gasUsed: Number(BigInt(r.gasUsed)), effectiveGasPrice: BigInt(r.effectiveGasPrice), hash };
    }
    await sleep(25);
  }
  throw new Error('no receipt');
}

/** Run a call that must revert (from anyone, for a write): true when it reverts. */
async function reverts(client, from, tx) {
  try {
    await client.request({ method: 'eth_call', params: [{ from, to: tx.to, data: tx.data, value: toHex(tx.value ?? 0n) }, 'latest'] });
    return false;
  } catch {
    return true;
  }
}

async function runPlan(client, plan, holder, label, log) {
  const rows = [];
  for (const t of plan.txs) {
    const r = await sendTx(client, holder, t);
    t.measuredGas = r.gasUsed;
    rows.push({ t, gas: r.gasUsed });
  }
  log(`  ${label}: ${plan.txs.length} transactions sent, all succeeded`);
  return rows;
}

function gasReport(rows, files, chunkBytes, livePrice, log) {
  const byKind = new Map();
  for (const { t, gas } of rows) {
    const k = t.kind;
    const e = byKind.get(k) ?? { n: 0, gas: 0, min: Infinity, max: 0 };
    e.n++;
    e.gas += gas;
    e.min = Math.min(e.min, gas);
    e.max = Math.max(e.max, gas);
    byKind.set(k, e);
  }
  log('  gas per transaction (measured on the fork):');
  for (const { t, gas } of rows) log(`    ${padL(t.n, 3)}  ${pad(t.kind, 12)}${padL(comma((t.data.length - 2) / 2), 9)} B  ${padL(comma(gas), 10)} gas  ${t.label}`);
  log('  by kind:');
  for (const [k, e] of byKind) log(`    ${pad(k, 12)} x${padL(e.n, 3)}   total ${padL(comma(e.gas), 11)}   min ${padL(comma(e.min), 10)}   max ${padL(comma(e.max), 10)}`);
  const total = rows.reduce((s, r) => s + r.gas, 0);
  const modelTotal = rows.reduce((s, r) => s + r.t.gas, 0);
  log(`  total gas ${comma(total)}   (model said ${comma(modelTotal)}, ${modelTotal ? (((modelTotal - total) / total) * 100).toFixed(1) : '-'}% off)`);
  log(`  at the live gas price ${Number(livePrice) / 1e9} gwei: ${okb(BigInt(total) * livePrice)}   (at 1 gwei it would be ${okb(BigInt(total) * 1_000_000_000n)})`);
  const biggest = rows.reduce((m, r) => (r.gas > m.gas ? r : m), rows[0]);
  log(`  the most expensive single transaction: ${comma(biggest.gas)} gas (${biggest.t.label}); the Osaka per-transaction cap, which X Layer does not have, would be 16,777,216 -> headroom ${comma(16_777_216 - biggest.gas)}`);
  return total;
}

/** Read the site back as a shell would, then look at the whole container. */
async function verifyAll(client, files, state, chunkBytes, log, expectPaths) {
  const v = await verifyFiles(client, files, state.container, { chunkBytes });
  for (const c of v.checked) log(`    ok  ${pad(c.path, 52)}${padL(comma(c.size), 9)} B  ${padL(c.chunks, 2)} chunk(s)  via ${c.via}`);
  const after = await readState(client);
  const problems = [...v.problems];
  const want = expectPaths ?? files.map((f) => f.path);
  if (after.files.size !== want.length) problems.push(`pathCount ${after.files.size}, expected ${want.length}`);
  for (const p of want) if (!after.files.has(p)) problems.push(`${p} missing from pathsRange`);
  if (after.fallback !== 'index.html') problems.push(`fallbackPath ${JSON.stringify(after.fallback)}`);
  if (!after.live) problems.push(`isLive(${after.name}) is false`);
  if (!after.processorOk) problems.push('cpuAt does not match the circuits contract');
  if (!after.opened) problems.push('container not opened');
  log(`    pathCount ${after.files.size}   fallbackPath ${JSON.stringify(after.fallback)}   isLive(${after.name}) ${after.live}   isContainerLive ${after.containerLive}   paidUntil ${after.paidUntil}`);
  // the lookups a shell would make (TAP-10 §7.2)
  const paths = [...after.files.keys()];
  const probes = [
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/?x=1', 'index.html'],
    ['/app/markets', 'index.html'],
    ['/missing.js', null],
    ...files.filter((f) => f.path !== 'index.html').slice(0, 2).map((f) => [`/${f.path}`, f.path]),
  ];
  for (const [req, expect] of probes) {
    const got = landing(req, paths, after.fallback);
    if (got !== expect) problems.push(`path ${req} lands on ${got}, expected ${expect}`);
  }
  log(`    path lookups (${probes.map((p) => p[0]).join(' ')}) ${problems.some((p) => p.startsWith('path ')) ? 'WRONG' : 'ok'}`);
  // content types after the shell's cleaning (TAP-10 §7.1 step 6)
  for (const f of files) if (shellContentType(f.contentType) !== f.contentType) problems.push(`${f.path}: a shell would change the content type ${f.contentType} to ${shellContentType(f.contentType)}`);
  return { problems, after };
}

/** Probes of how the store behaves when a site is updated or an upload is interrupted. */
async function updateProbes(client, holder, files, srcDir, state, chunkBytes, livePrice, log) {
  const results = [];
  const note = (ok, text) => {
    results.push(ok);
    log(`    ${ok ? 'ok  ' : 'FAIL'} ${text}`);
  };
  const reg = (functionName, args) => ({ to: TARGET.registry, data: encode(ABI.registry, functionName, args) });
  const container = state.container;

  // 1. a rebuilt app: new hashed script, new index.html; everything else unchanged
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-deweb-'));
  fs.cpSync(srcDir, tmp, { recursive: true });
  const js = fs.readdirSync(path.join(tmp, 'assets')).find((n) => n.endsWith('.js'));
  if (js) {
    const newName = js.replace(/\.js$/, '-v2.js');
    fs.writeFileSync(path.join(tmp, 'assets', newName), Buffer.concat([fs.readFileSync(path.join(tmp, 'assets', js)), Buffer.from('\n/* rebuilt */\n')]));
    fs.rmSync(path.join(tmp, 'assets', js));
    fs.writeFileSync(path.join(tmp, 'index.html'), fs.readFileSync(path.join(tmp, 'index.html'), 'utf8').replace(js, newName));
  } else {
    // a single-file build: change the page itself
    fs.writeFileSync(path.join(tmp, 'index.html'), Buffer.concat([fs.readFileSync(path.join(tmp, 'index.html')), Buffer.from('\n<!-- rebuilt -->\n')]));
  }
  const files2 = readDist(tmp);
  const state1 = await readState(client);
  const plan2 = buildPlan({ files: files2, state: state1, chunkBytes, prune: true });
  const kinds = plan2.txs.map((t) => t.kind);
  const changed = files2.filter((f) => !sameFile(state1.files.get(f.path), f)).map((f) => f.path);
  note(plan2.skipped.length === files2.length - changed.length && !kinds.includes('open') && !kinds.includes('bind') && !kinds.includes('setFallback'), `update plan skips ${plan2.skipped.length} unchanged file(s), uploads ${changed.join(' + ')}, no open/bind/fallback step`);
  note(plan2.txs.at(-1)?.kind === 'removeFile' || plan2.stale.length === 0, `index.html is uploaded before the prune: last upload ${[...plan2.txs].reverse().find((t) => t.file)?.file}`);
  const rows2 = await runPlan(client, plan2, holder, 'update', log);
  const g2 = rows2.reduce((s, r) => s + r.gas, 0);
  const v2 = await verifyAll(client, files2, state1, chunkBytes, () => {}, files2.map((f) => f.path));
  note(v2.problems.length === 0, `after the update the container holds exactly the new build (${files2.length} files)${v2.problems.length ? ': ' + v2.problems.join('; ') : ''}`);
  log(`    update cost: ${plan2.txs.length} transactions, ${comma(g2)} gas = ${okb(BigInt(g2) * livePrice)} at the live price`);
  fs.rmSync(tmp, { recursive: true, force: true });

  // 2. replacing a multi-chunk file by a small one at the same path
  const big = Buffer.alloc(60_000, 7);
  const small = Buffer.from('hello, smaller');
  const put = (data, h, contentType = 'text/plain; charset=utf-8') => ({ to: TARGET.registry, data: encode(ABI.registry, 'putFile', [container, 'rehearsal/probe.txt', contentType, `0x${h}`, `0x${data.toString('hex')}`]) });
  await sendTx(client, holder, put(big.subarray(0, 24_000), sha256Hex(big)));
  await sendTx(client, holder, { to: TARGET.registry, data: encode(ABI.registry, 'appendChunk', [container, 'rehearsal/probe.txt', 1n, `0x${big.subarray(24_000, 48_000).toString('hex')}`]) });
  const mid = await readOne(client, container, 'rehearsal/probe.txt');
  note(mid.chunkCount === 2 && mid.size === 48_000 && mid.sha256 === sha256Hex(big), `an interrupted upload shows size ${mid.size} (not 60000) under the declared hash, so it can never be mistaken for the finished file`);
  note(!sameFile(mid, { size: 60_000, sha256: sha256Hex(big), contentType: 'text/plain; charset=utf-8' }), 'the update plan would not skip a half-uploaded file');
  note(await reverts(client, holder, { to: TARGET.registry, data: encode(ABI.registry, 'appendChunk', [container, 'rehearsal/probe.txt', 5n, '0x00']) }), 'appendChunk with a wrong expectIndex reverts');
  await sendTx(client, holder, put(small, sha256Hex(small)));
  const rep = await readOne(client, container, 'rehearsal/probe.txt');
  note(rep.chunkCount === 1 && rep.size === small.length && rep.sha256 === sha256Hex(small), `putFile on an existing path replaces it completely (chunks ${mid.chunkCount} -> ${rep.chunkCount}, size ${mid.size} -> ${rep.size})`);
  const back = Buffer.from((await readContract(client, { address: TARGET.registry, abi: ABI.registry, functionName: 'read', args: [container, 'rehearsal/probe.txt'] })).slice(2), 'hex');
  note(back.equals(small), 'read returns the new bytes only');

  // 3. who may write: nobody but the holder (or an operator the holder set)
  const stranger = getAddress('0x00000000000000000000000000000000000dEaD1');
  note(await reverts(client, stranger, put(small, sha256Hex(small))), 'putFile from an address that is not the holder reverts');
  note(await reverts(client, stranger, reg('removeFile', [container, 'index.html'])), 'removeFile from an address that is not the holder reverts');
  note(await reverts(client, stranger, reg('setFallback', [container, 'index.html'])), 'setFallback from an address that is not the holder reverts');

  // 4. tidy up the probe path, and removing a path
  const before = (await readState(client)).files.size;
  const rm = await sendTx(client, holder, reg('removeFile', [container, 'rehearsal/probe.txt']));
  const gone = await readOne(client, container, 'rehearsal/probe.txt');
  const after = (await readState(client)).files.size;
  note(gone.chunkCount === 0 && after === before - 1, `removeFile drops the path (pathCount ${before} -> ${after}, fileInfo chunkCount 0; gas ${comma(rm.gasUsed)})`);
  return results.every(Boolean);
}

const encode = (abi, functionName, args) => encodeFunctionData({ abi, functionName, args });

async function readOne(client, container, p) {
  const [size, contentType, hash, , chunkCount] = await readContract(client, { address: TARGET.registry, abi: ABI.registry, functionName: 'fileInfo', args: [container, p] });
  return { size, contentType, sha256: hash.slice(2), chunkCount: Number(chunkCount) };
}

/** A non-zero monthly fee, set on the fork by impersonating the payment contract's owner: does `bind` take months x fee? */
async function feeTest(client, holder, state, log) {
  const owner = await readContract(client, { address: TARGET.binding, abi: ABI.binding, functionName: 'owner' });
  await client.request({ method: 'anvil_setBalance', params: [owner, toHex(10n ** 20n)] });
  const fee = 10n ** 16n;
  await sendTx(client, owner, { to: TARGET.binding, data: encode(ABI.binding, 'setMonthlyFee', [fee]) });
  const open = { to: TARGET.opener, data: encode(ABI.opener, 'open', [TARGET.circuits, TARGET.circuitId]), value: state.openFee };
  if (!state.opened) await sendTx(client, holder, open);
  const bindTx = (months, value) => ({ to: TARGET.binding, data: encode(ABI.binding, 'bind', [state.name, state.container, months]), value });
  const results = [];
  const note = (ok, t) => {
    results.push(ok);
    log(`    ${ok ? 'ok  ' : 'FAIL'} ${t}`);
  };
  note(await reverts(client, holder, bindTx(2n, 0n)), `bind with value 0 while the fee is ${okb(fee)}/month reverts`);
  note(await reverts(client, holder, bindTx(2n, fee)), 'bind for 2 months with the value of 1 month reverts');
  const overpay = !(await reverts(client, holder, bindTx(2n, 3n * fee)));
  log(`    info bind for 2 months with 3 months of value ${overpay ? 'is accepted (the excess is not refunded: send the exact amount)' : 'reverts'}`);
  const r = await sendTx(client, holder, bindTx(2n, 2n * fee));
  const live = await readContract(client, { address: TARGET.binding, abi: ABI.binding, functionName: 'isLive', args: [state.name, state.container] });
  const until = await readContract(client, { address: TARGET.binding, abi: ABI.binding, functionName: 'containerPaidUntil', args: [state.container] });
  const blk = await client.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
  const days = (Number(until) - Number(BigInt(blk.timestamp))) / 86400;
  note(live && days > 59 && days < 61, `bind for 2 months with exactly 2 x fee succeeds (gas ${comma(r.gasUsed)}); isLive true, paid for ${days.toFixed(1)} days (30-day months)`);
  // paying again while live adds to the current expiry
  const before = Number(until);
  const monthsMore = 1n;
  await sendTx(client, holder, bindTx(monthsMore, monthsMore * fee));
  const after = Number(await readContract(client, { address: TARGET.binding, abi: ABI.binding, functionName: 'containerPaidUntil', args: [state.container] }));
  note(after - before === 30 * 86_400, `bind again while live adds 30 days to the current expiry (${(after - before) / 86_400} days), which is how the plan computes the new expiry`);
  return results.every(Boolean);
}

async function cmdRehearse(o) {
  const log = (s = '') => console.log(s);
  const dirs = o.dirs.length ? o.dirs : ['dist'];
  const chunkBytes = Number(o.kv['chunk-bytes'] ?? CHUNK_BYTES);
  const months = Number(o.kv.months ?? 3);
  const forkUrl = o.kv['fork-url'] ?? TARGET.publicRpc;
  let node = null;
  let url = o.kv.rpc;
  if (!url) {
    node = await startAnvil({ forkUrl, port: Number(o.kv.port ?? 8560), forkBlock: o.kv['fork-block'] });
    url = node.url;
  }
  let ok = true;
  try {
    const client = makeClient(url);
    const version = await assertLocalAnvil(client, url);
    const live = makeClient(TARGET.publicRpc); // read-only: the real gas price
    const gasPrice = (await readPrices(live, TARGET.expectedHolder)).gasPrice;
    const head = await getBlockNumber(client);
    const state0 = await readState(client);
    const holder = state0.holder;
    log(`REHEARSAL on a local fork (${version}, hardfork cancun), X Layer block ${head}; nothing here touches a live chain`);
    log(`  circuit ${TARGET.circuits} #${TARGET.circuitId} held by ${holder}; container ${state0.container} (${state0.opened ? 'opened' : 'not opened'}); name ${state0.name}`);
    log(`  proxies: site store implementation listed by TAP-10: ${state0.registryImplOk}; payment contract implementation listed: ${state0.bindingImplOk}; cpuAt(${TARGET.processorNumber}) is the circuits contract: ${state0.processorOk}`);
    log(`  monthlyFee now ${okb(state0.monthlyFee)}; open fee ${okb(state0.openFee)}`);
    await client.request({ method: 'anvil_setBalance', params: [holder, toHex(10n ** 20n)] });
    const baseline = await client.request({ method: 'evm_snapshot' });
    let snap = baseline;
    let first = true;

    for (const dir of dirs) {
      const files = readDist(dir);
      log(`\n== ${dir}: ${files.length} file(s), ${comma(files.reduce((s, f) => s + f.size, 0))} bytes, chunks of up to ${chunkBytes} bytes`);
      const state = await readState(client);
      const plan = buildPlan({ files, state, months, chunkBytes });
      const tot = planTotals(plan);
      log(`  plan: ${tot.txs} transactions, calldata ${comma(tot.calldataBytes)} B, largest ${comma(tot.largest)} B (reth's default input limit is 128 KiB = 131,072 B)`);
      const rows = await runPlan(client, plan, holder, 'publish', log);
      const total = gasReport(rows, files, chunkBytes, gasPrice, log);
      const l1 = await l1FeeFor(live, plan.txs.reduce((m, t) => (t.data.length > m.data.length ? t : m)).data);
      log(`  L1 data fee on the live chain for the largest transaction: ${l1 === null ? 'unreadable' : l1 === 0n ? '0 (the fork shows none either way)' : okb(l1)}`);
      log('  read back as a shell does:');
      const v = await verifyAll(client, files, state, chunkBytes, log);
      if (v.problems.length) {
        ok = false;
        log(`  FAILED: ${v.problems.join('\n          ')}`);
      } else log(`  VERIFIED: all ${files.length} files match byte for byte (length and SHA-256), the name is live, lookups land as TAP-10 §7.2 says`);
      const openFee = state.opened ? 0n : state.openFee;
      log(`  ${dir} TOTAL: ${comma(total)} gas = ${okb(BigInt(total) * gasPrice)} at ${Number(gasPrice) / 1e9} gwei, plus the open fee ${okb(openFee)} and ${okb(state.monthlyFee)} per month bound  =  ${okb(BigInt(total) * gasPrice + openFee)} now`);
      if (first && o.flags.has('update-test')) {
        log('  update path and store behaviour:');
        if (!(await updateProbes(client, holder, files, path.resolve(dir), await readState(client), chunkBytes, gasPrice, log))) ok = false;
      }
      first = false;
      await client.request({ method: 'evm_revert', params: [snap] });
      snap = await client.request({ method: 'evm_snapshot' });
    }

    if (o.flags.has('fee-test')) {
      log('\n== bind with a non-zero monthly fee (the fee is set on the fork only, by impersonating the payment contract owner)');
      if (!(await feeTest(client, holder, await readState(client), log))) ok = false;
      await client.request({ method: 'evm_revert', params: [snap] });
      snap = await client.request({ method: 'evm_snapshot' });
    }

    if (o.flags.has('script')) {
      // the very script the owner would run, run against the fork with an impersonated signer
      const dir = dirs[0];
      const cb = Math.min(chunkBytes, 12_000);
      log(`\n== publish.sh generated by 'plan --out' for ${dir} (chunks of ${cb} bytes), run with cast against the fork`);
      const files = readDist(dir);
      const plan = buildPlan({ files, state: await readState(client), months, chunkBytes: cb });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-publish-'));
      fs.mkdirSync(path.join(tmp, 'chunks'));
      const { script, chunkFiles } = castScript(plan);
      fs.writeFileSync(path.join(tmp, 'publish.sh'), script);
      for (const [f, hex] of chunkFiles) fs.writeFileSync(path.join(tmp, f), hex);
      const env = { ...process.env, RPC_URL: url, CAST_SIGN_ARGS: `--unlocked --from ${holder}` };
      const bash = process.env.BASH_EXE || 'bash';
      try {
        execFileSync(bash, [path.join(tmp, 'publish.sh')], { env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 600_000 });
        log(`  publish.sh ran: ${plan.txs.length} cast send calls succeeded`);
        const v = await verifyAll(client, files, await readState(client), cb, () => {});
        if (v.problems.length) {
          ok = false;
          log(`  FAILED: ${v.problems.join('; ')}`);
        } else log(`  VERIFIED: the script's result matches ${dir} byte for byte, name live`);
      } catch (e) {
        ok = false;
        log(`  FAILED: publish.sh did not finish: ${String(e.stderr ?? e.message).split('\n').slice(0, 5).join(' | ')}`);
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      await client.request({ method: 'evm_revert', params: [snap] });
    }
  } finally {
    node?.stop();
  }
  log(`\n${ok ? 'REHEARSAL PASSED' : 'REHEARSAL FAILED'}`);
  if (!ok) process.exitCode = 1;
}

/* ───────── main ───────── */

const USAGE = 'usage: node scripts/deweb.mjs <plan|verify|rehearse> [options]   (see the header of this file)';

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help') {
    console.log(USAGE);
    return;
  }
  const o = parseArgs(rest);
  if (cmd === 'plan') await cmdPlan(o);
  else if (cmd === 'verify') await cmdVerify(o);
  else if (cmd === 'rehearse') await cmdRehearse(o);
  else throw new Error(USAGE);
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});

