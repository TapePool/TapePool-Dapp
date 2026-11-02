// DeWEB publishing, in functions: read what the chain says about the TapePool circuit's container, plan the transactions that
// put a build folder there, check the result, and (on a local anvil fork only) run the plan. Nothing in this file signs.
// The sources are TAP-10 (Appendix A, §6, §7) and the contracts' own selectors; the rehearsal on a fork is the test of both.

import { createClient, encodeFunctionData, formatEther, getAddress, http, parseAbi } from 'viem';
import { call, getBalance, getBlock, getGasPrice, getStorageAt, readContract } from 'viem/actions';
import { CHUNK_BYTES, chunkGas, chunkRanges, sha256Hex } from './dist.mjs';

/** X Layer, as TAP-10 (Deployments) and the owner's research list them, plus TapePool's own circuit. */
export const TARGET = Object.freeze({
  chainId: 196,
  /** The area code of X Layer in a DeWEB name (TAP-10 §2.1). */
  areaCode: 2,
  /** Index of TapePool's processor in the factory's list: the third number of the name. Checked against `cpuAt` before use. */
  processorNumber: 382,
  circuits: '0xdc76f123838b5398A173D215a2c8338Ad189C9a8',
  circuitId: 1n,
  factory: '0x1f09DAeFA827f02CBb40967cc91b259763760761',
  opener: '0x536adD8F30f03b69f6fbF29d425A816A0dC50106',
  registry: '0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6',
  binding: '0x68809Fd2fb343aA57D0aeB7f33Defe477c9666f9',
  /** The implementations behind the two proxies that TAP-10 accepts: a client (and this tool) refuses anything else. */
  registryImpl: '0xa85c4143d1D4A77f54b8e4ecC9E6D1418Afea45f',
  bindingImpl: '0x5eBF29b80789e548907C707530C3C7607C4347Df',
  /** Who held the circuit when this was written (CLAUDE.md). The tool reads the real holder from the chain and warns on a difference. */
  expectedHolder: '0x04974a7F899813dBaf0046469Ea73Ff0a5E352F3',
  gatewayDomain: 'tapekit.org',
  /** The OP Stack gas price oracle: its `getL1Fee` says whether X Layer charges a data fee on top of gas. */
  l1Oracle: '0x420000000000000000000000000000000000000F',
  publicRpc: 'https://rpc.xlayer.tech',
});

const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

export const ABI = {
  opener: parseAbi([
    'function open(address circuits, uint256 id) payable',
    'function FEE() view returns (uint256)',
    'function accountOf(address circuits, uint256 id) view returns (address)',
    'function isOpened(address circuits, uint256 id) view returns (bool)',
  ]),
  registry: parseAbi([
    'function putFile(address container, string path, string contentType, bytes32 sha256Hash, bytes data)',
    'function appendChunk(address container, string path, uint256 expectIndex, bytes data)',
    'function removeFile(address container, string path)',
    'function setFallback(address container, string path)',
    'function setOperator(address container, address op, uint256 ttl)',
    'function fileInfo(address container, string path) view returns (uint32 size, string contentType, bytes32 sha256Hash, uint40 updatedAt, uint256 chunkCount)',
    'function read(address container, string path) view returns (bytes)',
    'function readRange(address container, string path, uint256 offset, uint256 len) view returns (bytes)',
    'function pathCount(address container) view returns (uint256)',
    'function pathsRange(address container, uint256 from, uint256 n) view returns (string[])',
    'function fallbackPath(address container) view returns (string)',
  ]),
  binding: parseAbi([
    'function bind(string name, address container, uint256 months) payable',
    'function monthlyFee() view returns (uint256)',
    'function isLive(string name, address container) view returns (bool)',
    'function isContainerLive(address container) view returns (bool)',
    'function containerPaidUntil(address container) view returns (uint40)',
    'function owner() view returns (address)',
    'function setMonthlyFee(uint256 fee)',
  ]),
  factory: parseAbi(['function cpuAt(uint256 i) view returns (address)']),
  circuits: parseAbi(['function ownerOf(uint256 id) view returns (address)', 'function name() view returns (string)']),
  oracle: parseAbi(['function getL1Fee(bytes data) view returns (uint256)']),
};

/** Gas of the three single-shot steps, from the same rehearsal that fixed `GAS` in dist.mjs. */
export const STEP_GAS = { open: 170_000, setFallback: 115_000, bind: 195_000, removeFile: 110_000 };

/** A bound "month" is 30 days (measured on the fork: 2 months paid 60.0 days). */
export const MONTH_SECONDS = 30 * 86_400;
/** The hackathon's submission deadline (CLAUDE.md, provisional); a Demo Day follows it. */
export const SUBMISSION_DEADLINE = Date.UTC(2026, 11, 7, 23, 59, 0) / 1000;

/** When the name stops being live after a `bind` of `months`: from now, or from the current expiry if that is later. */
export const bindExpiry = (state, months) => Math.max(state.now, Number(state.paidUntil)) + months * MONTH_SECONDS;

export const nameOf = (t = TARGET) => `${t.circuitId}.${t.areaCode}.${t.processorNumber}.tape`;
export const gatewayHost = (t = TARGET) => `${t.circuitId}-${t.areaCode}-${t.processorNumber}.${t.gatewayDomain}`;
/** The compatibility tier of the gateway, for browsers that cannot install a service worker (TapeKit: `-open` suffix). */
export const gatewayOpenHost = (t = TARGET) => `${t.circuitId}-${t.areaCode}-${t.processorNumber}-open.${t.gatewayDomain}`;

export const makeClient = (url) => createClient({ transport: http(url, { timeout: 60_000, retryCount: 3 }) });

/* ───────── what the chain says ───────── */

/**
 * Read-only: everything the plan depends on. `files` maps each path the container holds to its `fileInfo`.
 * Nothing here needs a key; it works against the public RPC and against a fork alike.
 */
export async function readState(client, t = TARGET) {
  const rc = (address, abi, functionName, args = []) => readContract(client, { address, abi, functionName, args });
  const [block, holder, cpu, container, opened, openFee, monthlyFee, regImpl, bindImpl] = await Promise.all([
    getBlock(client),
    rc(t.circuits, ABI.circuits, 'ownerOf', [t.circuitId]),
    rc(t.factory, ABI.factory, 'cpuAt', [BigInt(t.processorNumber)]),
    rc(t.opener, ABI.opener, 'accountOf', [t.circuits, t.circuitId]),
    rc(t.opener, ABI.opener, 'isOpened', [t.circuits, t.circuitId]),
    rc(t.opener, ABI.opener, 'FEE'),
    rc(t.binding, ABI.binding, 'monthlyFee'),
    getStorageAt(client, { address: t.registry, slot: IMPL_SLOT }),
    getStorageAt(client, { address: t.binding, slot: IMPL_SLOT }),
  ]);
  const impl = (slot) => getAddress(`0x${(slot ?? '0x').slice(-40).padStart(40, '0')}`);
  const name = nameOf(t);
  const state = {
    /** Chain time: the timestamp of the latest block. */
    now: Number(block.timestamp),
    holder: getAddress(holder),
    processorOk: getAddress(cpu) === getAddress(t.circuits),
    container: getAddress(container),
    opened,
    openFee,
    monthlyFee,
    registryImplOk: impl(regImpl) === getAddress(t.registryImpl),
    bindingImplOk: impl(bindImpl) === getAddress(t.bindingImpl),
    name,
    live: false,
    containerLive: false,
    paidUntil: 0n,
    fallback: '',
    files: new Map(),
  };
  if (opened) {
    const [live, containerLive, paidUntil, fallback, count] = await Promise.all([
      rc(t.binding, ABI.binding, 'isLive', [name, state.container]),
      rc(t.binding, ABI.binding, 'isContainerLive', [state.container]).catch(() => false),
      rc(t.binding, ABI.binding, 'containerPaidUntil', [state.container]).catch(() => 0n),
      rc(t.registry, ABI.registry, 'fallbackPath', [state.container]),
      rc(t.registry, ABI.registry, 'pathCount', [state.container]),
    ]);
    Object.assign(state, { live, containerLive, paidUntil: BigInt(paidUntil), fallback });
    for (let from = 0n; from < count; from += 50n) {
      const page = await rc(t.registry, ABI.registry, 'pathsRange', [state.container, from, 50n]);
      for (const p of page) {
        const [size, contentType, hash, updatedAt, chunkCount] = await rc(t.registry, ABI.registry, 'fileInfo', [state.container, p]);
        state.files.set(p, { size, contentType, sha256: hash.slice(2), updatedAt: BigInt(updatedAt), chunkCount: Number(chunkCount) });
      }
    }
  }
  return state;
}

/** Offline stand-in for `readState`, for planning without a network: a container that is not opened yet. */
export function offlineState(t = TARGET, { monthlyFee = 0n, openFee = 80_000_000_000_000_000n } = {}) {
  return {
    now: Math.floor(Date.now() / 1000),
    holder: getAddress(t.expectedHolder),
    processorOk: true,
    container: '0xB309F98E699cE69A50A2136700337bA656bc145E',
    opened: false,
    openFee,
    monthlyFee,
    registryImplOk: true,
    bindingImplOk: true,
    name: nameOf(t),
    live: false,
    containerLive: false,
    paidUntil: 0n,
    fallback: '',
    files: new Map(),
    offline: true,
  };
}

/** The balance and prices a publish is judged against: read-only calls to a real RPC. */
export async function readPrices(client, holder, t = TARGET) {
  const [gasPrice, balance] = await Promise.all([getGasPrice(client), getBalance(client, { address: holder })]);
  return { gasPrice, holderBalance: balance };
}

/** `getL1Fee` of the oracle for some calldata: 0 when X Layer charges no data fee (the fork cannot show one). */
export async function l1FeeFor(client, dataHex, t = TARGET) {
  try {
    const data = encodeFunctionData({ abi: ABI.oracle, functionName: 'getL1Fee', args: [dataHex] });
    const r = await call(client, { to: t.l1Oracle, data });
    return r.data ? BigInt(r.data) : null;
  } catch {
    return null;
  }
}

/* ───────── the plan ───────── */

const enc = (abi, functionName, args) => encodeFunctionData({ abi, functionName, args });
const chunkHex = (data, c) => `0x${data.subarray(c.offset, c.offset + c.length).toString('hex')}`;

/** Is the file that is on chain exactly the one in the build? Size and hash, the content type stored, and nothing left to append. */
export function sameFile(on, f) {
  return Boolean(on) && on.size === f.size && on.sha256 === f.sha256 && on.contentType === f.contentType && on.chunkCount >= 1;
}

/**
 * The ordered transactions that put `files` (from `readDist`, assets first and `index.html` last) in the container:
 *   open (only if the container does not exist yet), each changed file chunk by chunk, setFallback, bind (only while the name
 *   is not live, or when `months` is given), and with `prune` a removeFile for every path on chain that the build no longer has.
 * Files that are already on chain with the same size, hash and content type are skipped, so an update sends only what changed.
 * Each step carries its calldata and an estimated gas; `value` is in wei.
 */
export function buildPlan({ files, state, target = TARGET, months, chunkBytes = CHUNK_BYTES, prune = false, stepGas = STEP_GAS }) {
  const txs = [];
  const skipped = [];
  const add = (t) => txs.push({ n: txs.length + 1, value: 0n, ...t });
  const container = state.container;

  if (!state.opened) {
    add({
      kind: 'open',
      label: 'open the container of the circuit',
      to: target.opener,
      fn: 'open(address,uint256)',
      args: [target.circuits, target.circuitId.toString()],
      value: state.openFee,
      data: enc(ABI.opener, 'open', [target.circuits, target.circuitId]),
      gas: stepGas.open,
    });
  }

  for (const f of files) {
    if (sameFile(state.files.get(f.path), f)) {
      skipped.push(f.path);
      continue;
    }
    for (const c of chunkRanges(f.size, chunkBytes)) {
      const hex = chunkHex(f.data, c);
      if (c.index === 0) {
        add({
          kind: 'putFile',
          label: `${f.path}  chunk 1/${chunkRanges(f.size, chunkBytes).length}`,
          to: target.registry,
          fn: 'putFile(address,string,string,bytes32,bytes)',
          args: [container, f.path, f.contentType, `0x${f.sha256}`, `<${c.length} bytes>`],
          data: enc(ABI.registry, 'putFile', [container, f.path, f.contentType, `0x${f.sha256}`, hex]),
          gas: chunkGas(c.length, true),
          file: f.path,
          chunkIndex: 0,
          chunkHex: hex,
          raw: [container, f.path, f.contentType, `0x${f.sha256}`],
        });
      } else {
        add({
          kind: 'appendChunk',
          label: `${f.path}  chunk ${c.index + 1}/${chunkRanges(f.size, chunkBytes).length}`,
          to: target.registry,
          fn: 'appendChunk(address,string,uint256,bytes)',
          args: [container, f.path, String(c.index), `<${c.length} bytes>`],
          data: enc(ABI.registry, 'appendChunk', [container, f.path, BigInt(c.index), hex]),
          gas: chunkGas(c.length, false),
          file: f.path,
          chunkIndex: c.index,
          chunkHex: hex,
          raw: [container, f.path, String(c.index)],
        });
      }
    }
  }

  if (state.fallback !== 'index.html') {
    add({
      kind: 'setFallback',
      label: 'single-page fallback: unknown paths without an extension serve index.html',
      to: target.registry,
      fn: 'setFallback(address,string)',
      args: [container, 'index.html'],
      data: enc(ABI.registry, 'setFallback', [container, 'index.html']),
      gas: stepGas.setFallback,
    });
  }

  if (!state.live || months !== undefined) {
    // no default: how long the name stays live is the owner's decision (it decides whether the site is up on judging day)
    if (months === undefined) throw new Error('--months is required: it sets how long the name stays live, and nothing decides that for you');
    if (!Number.isInteger(months) || months < 1 || months > 120) throw new Error('months must be a whole number from 1 to 120');
    const m = BigInt(months);
    add({
      kind: 'bind',
      label: `bind ${state.name} to the container for ${m} month(s)`,
      to: target.binding,
      fn: 'bind(string,address,uint256)',
      args: [state.name, container, m.toString()],
      value: m * state.monthlyFee,
      data: enc(ABI.binding, 'bind', [state.name, container, m]),
      gas: stepGas.bind,
      expiresAt: bindExpiry(state, Number(m)),
      note: 'value = months x monthlyFee(), read when the plan was made; read it again right before signing',
    });
  }

  const stale = [...state.files.keys()].filter((p) => !files.some((f) => f.path === p));
  if (prune) {
    for (const p of stale) {
      add({ kind: 'removeFile', label: `remove ${p} (no longer in the build)`, to: target.registry, fn: 'removeFile(address,string)', args: [container, p], data: enc(ABI.registry, 'removeFile', [container, p]), gas: stepGas.removeFile });
    }
  }
  return { txs, skipped, stale, chunkBytes, name: state.name, container };
}

export const planTotals = (plan) => ({
  txs: plan.txs.length,
  gas: plan.txs.reduce((s, t) => s + (t.measuredGas ?? t.gas), 0),
  value: plan.txs.reduce((s, t) => s + t.value, 0n),
  calldataBytes: plan.txs.reduce((s, t) => s + (t.data.length - 2) / 2, 0),
  largest: plan.txs.reduce((m, t) => ((t.data.length - 2) / 2 > m ? (t.data.length - 2) / 2 : m), 0),
});

/* ───────── a script for the owner's own signer ───────── */

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * A bash script of `cast send` lines, one per transaction, that the circuit holder can read and run with their own signer
 * (`CAST_SIGN_ARGS`, for example `--account <keystore name>`). Chunk data goes in files next to the script and is read with
 * `$(cat ...)`. Nothing here is run by this tool outside a fork.
 * @returns {{ script: string, chunkFiles: Map<string, string> }}
 */
export function castScript(plan, { target = TARGET } = {}) {
  const chunkFiles = new Map();
  const lines = [
    '#!/usr/bin/env bash',
    '# Generated by scripts/deweb.mjs plan. It sends REAL transactions from the signer you give it, one after the other.',
    '# Read it first. Set RPC_URL (default: X Layer public RPC) and CAST_SIGN_ARGS (for example: --account <keystore name>).',
    '# If a step fails, do NOT run this script again from the top: open would revert, and files would be sent twice. Run',
    '#   node scripts/deweb.mjs plan --out <folder> --months <N> [--chunk-bytes <N>]   again instead: it reads the chain, skips',
    '# every file that is already complete, re-sends a half-uploaded one from its first chunk, and writes a new script.',
    'set -euo pipefail',
    `: "\${CAST_SIGN_ARGS:?set CAST_SIGN_ARGS, for example --account <keystore name>}"`,
    `RPC_URL="\${RPC_URL:-${target.publicRpc}}"`,
    'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'send() { # to, value in wei, signature, args...',
    '  local to="$1" value="$2" sig="$3"; shift 3',
    '  # shellcheck disable=SC2086',
    '  cast send "$to" "$sig" "$@" --value "$value" --rpc-url "$RPC_URL" $CAST_SIGN_ARGS',
    '}',
    '',
  ];
  for (const t of plan.txs) {
    lines.push(`echo ${sq(`[${t.n}/${plan.txs.length}] ${t.label}`)}`);
    if (t.kind === 'putFile' || t.kind === 'appendChunk') {
      const f = `chunks/${String(t.n).padStart(3, '0')}.hex`;
      chunkFiles.set(f, t.chunkHex);
      lines.push(`send ${t.to} 0 ${sq(t.fn)} ${t.raw.map(sq).join(' ')} "$(cat "$HERE/${f}")"`);
    } else {
      lines.push(`send ${t.to} ${t.value} ${sq(t.fn)} ${t.args.map(sq).join(' ')}`);
    }
  }
  lines.push('', 'echo done');
  return { script: lines.join('\n') + '\n', chunkFiles };
}

/* ───────── checks after a publish (read-only) ───────── */

/** TAP-10 §7.2 step 4: where a request path lands, given the paths the container holds and its fallback. */
export function landing(requestPath, paths, fallback) {
  let p;
  try {
    p = decodeURIComponent(requestPath.split(/[?#]/)[0]).normalize('NFC').replace(/\/{2,}/g, '/');
  } catch {
    return null;
  }
  if (/[\u0000-\u001f\u007f]/.test(p) || p.split('/').some((s) => s === '.' || s === '..')) return null;
  if (p === '' || p.endsWith('/')) p += 'index.html';
  p = p.replace(/^\//, '');
  const set = new Set(paths);
  if (set.has(p)) return p;
  const last = p.split('/').pop() ?? '';
  const hasExt = last.includes('.');
  if (!hasExt && set.has(`${p}/index.html`)) return `${p}/index.html`;
  if (!hasExt && fallback && set.has(fallback)) return fallback;
  return null;
}

/**
 * Read every file back the way a shell does (TAP-10 §7.1): `fileInfo`, then `read` for files up to 96 KiB and `readRange`
 * segments of 98,304 bytes for larger ones, and compare length and SHA-256 with the build.
 * @returns {Promise<{ problems: string[], checked: { path: string, size: number, chunks: number, via: string }[] }>}
 */
export async function verifyFiles(client, files, container, { target = TARGET, chunkBytes } = {}) {
  const problems = [];
  const checked = [];
  const rc = (functionName, args) => readContract(client, { address: target.registry, abi: ABI.registry, functionName, args: [container, ...args] });
  for (const f of files) {
    const [size, contentType, hash, , chunkCount] = await rc('fileInfo', [f.path]);
    const want = chunkBytes ? chunkRanges(f.size, chunkBytes).length : undefined;
    if (size !== f.size) problems.push(`${f.path}: size on chain ${size}, build ${f.size}`);
    if (contentType !== f.contentType) problems.push(`${f.path}: content type on chain ${JSON.stringify(contentType)}, build ${JSON.stringify(f.contentType)}`);
    if (hash.slice(2) !== f.sha256) problems.push(`${f.path}: declared hash differs from the build`);
    if (want !== undefined && Number(chunkCount) !== want) problems.push(`${f.path}: ${chunkCount} chunks on chain, expected ${want}`);
    let bytes;
    let via;
    if (f.size <= 98_304) {
      bytes = Buffer.from((await rc('read', [f.path])).slice(2), 'hex');
      via = 'read';
    } else {
      const parts = [];
      for (let off = 0; off < f.size; off += 98_304) parts.push(Buffer.from((await rc('readRange', [f.path, BigInt(off), 98_304n])).slice(2), 'hex'));
      bytes = Buffer.concat(parts);
      via = `readRange x${parts.length}`;
    }
    if (bytes.length !== f.size) problems.push(`${f.path}: read ${bytes.length} bytes, expected ${f.size}`);
    else if (sha256Hex(bytes) !== f.sha256) problems.push(`${f.path}: SHA-256 of the bytes read differs from the build`);
    checked.push({ path: f.path, size: f.size, chunks: Number(chunkCount), via });
  }
  return { problems, checked };
}

export const fmtOkb = (wei) => `${formatEther(wei)} OKB`;
