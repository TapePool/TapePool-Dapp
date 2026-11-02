// Generate the committed ABIs under src/chain/abi/ from forge's out/ (SPEC-PHASE5-APP §3).
//
//   forge build && node scripts/gen-abi.mjs        writes src/chain/abi/*.ts
//
// Only the functions, events and errors the app uses are kept, so the bundle stays small. `out/` is git-ignored,
// which is why the result is committed; test/abi.test.ts regenerates it in memory and compares when `out/` exists.
// Entries that no artifact can supply (the voucher's ERC-721 Enumerable call, the Circuits contract's ERC-721
// name and symbol) are written here by hand and checked with a live read (test/live.test.ts).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(APP_ROOT, '..');
export const OUT_DIR = path.join(REPO_ROOT, 'out');
export const ABI_DIR = path.join(APP_ROOT, 'src', 'chain', 'abi');

const fn = (name, inputs, outputs, stateMutability = 'view') => ({
  type: 'function',
  name,
  inputs: inputs.map(([n, t]) => ({ name: n, type: t })),
  outputs: outputs.map(([n, t]) => ({ name: n, type: t })),
  stateMutability,
});

const err = (name, inputs) => ({ type: 'error', name, inputs: inputs.map(([n, t]) => ({ name: n, type: t })) });

/** An event written by hand: `inputs` are [name, type, indexed]. */
const ev = (name, inputs) => ({ type: 'event', name, inputs: inputs.map(([n, t, indexed]) => ({ name: n, type: t, indexed })), anonymous: false });

/** One entry per file. `fns`, `events` and `errors` select from the artifact; `extra` is written by hand. */
export const SPECS = [
  {
    file: 'tapePool',
    name: 'tapePoolAbi',
    artifact: 'TapePool.sol/TapePool.json',
    fns: [
      'stats', 'fee', 'opsFee', 'feeBps7d', 'feeBps14d', 'minFee', 'minAdvance', 'lateFeeBpsPerDay', 'maxLend',
      'maxDeposit', 'maxMint', 'maxWithdraw', 'maxRedeem', 'convertToAssets', 'convertToShares', 'balanceOf',
      'totalSupply', 'totalAssets', 'decimals', 'asset', 'factory', 'policy', 'owner', 'guardian', 'queued',
      'QUEUE_GRACE', 'idle', 'doubtful', 'reserve', 'outstandingPrincipal', 'principalOf', 'borrowsPaused',
      'feedDisabled', 'policySwapQueued', 'deposit', 'withdraw', 'redeem',
      'tracked', 'unvestedNow', 'vestEnd', 'frozenClock', 'frozenBetween', 'expiryOf', 'frozenCount', 'frozenAt',
      'perBorrowerAbs', 'backstop', 'absorbedOf', 'loanReserveTerms', 'lendLimit', 'sync', 'bounds',
      'feedEnabledAt', 'FEED_SETTLE',
    ],
    events: ['Deposit', 'Withdraw', 'Synced', 'IncomeBooked', 'LossAbsorbed', 'ToReserve', 'FeedEnabled'],
    errors: true,
  },
  {
    file: 'rigAgent',
    name: 'rigAgentAbi',
    artifact: 'RigAgent.sol/RigAgent.json',
    fns: [
      'closed', 'collateralOf', 'loanOf', 'borrower', 'hasLoan', 'pool', 'borrow', 'repay', 'sweep', 'release',
      'withdrawVoucher', 'register', 'claimLate', 'forget', 'flagEvidenceFrom', 'seizeEvidenceFrom', 'OWNER_READ_GAS',
    ],
    events: ['Borrowed', 'OpsFeePaid', 'Seized', 'Swept', 'LoanClosed', 'Repaid', 'Released', 'CollateralRemoved'],
    errors: true,
  },
  {
    file: 'agentFactory',
    name: 'agentFactoryAbi',
    artifact: 'AgentFactory.sol/AgentFactory.json',
    fns: ['agentsOf', 'borrowerOf', 'isAgent', 'predictAgent', 'create', 'pool', 'implementation', 'bem', 'feed', 'voucher'],
    events: ['AgentCreated'],
    errors: true,
  },
  {
    file: 'creditPolicy',
    name: 'creditPolicyAbi',
    artifact: 'CreditPolicy.sol/CreditPolicy.json',
    fns: [
      'circuits', 'circuitId', 'cpuTapeOut', 'cpuBehemoth', 'cpuRefBench', 'emissionValidUntil', 'screen', 'feed',
      'voucher', 'pinsOk', 'check', 'maxDebt', 'MIN_RIG_AGE', 'version',
    ],
  },
  { file: 'rigScreen', name: 'rigScreenAbi', artifact: 'RigScreen.sol/RigScreen.json', fns: ['passOf', 'isEffective'] },
  { file: 'tapeLens', name: 'tapeLensAbi', artifact: 'TapeLens.sol/TapeLens.json', fns: ['quote', 'quoteFor'], bytecode: 'tapeLensRuntime' },
  { file: 'feedReceiver', name: 'feedReceiverAbi', artifact: 'RigFeedReceiver.sol/RigFeedReceiver.json', fns: ['latest'] },
  { file: 'reporter', name: 'reporterAbi', artifact: 'RigReporter.sol/RigReporter.json', fns: ['quote', 'push'], errors: true },
  {
    file: 'voucher',
    name: 'voucherAbi',
    artifact: 'IXLayer.sol/IRigVoucher.json',
    fns: ['ownerOf', 'balanceOf', 'rigs', 'safeTransferFrom', 'bem', 'payeeAt'],
    extra: [
      // ERC-721 Enumerable: the voucher is an Enumerable token (verified live: totalSupply 16, tokenByIndex works)
      fn('tokenOfOwnerByIndex', [['owner', 'address'], ['index', 'uint256']], [['', 'uint256']]),
      // `RigVoucher._payYield` emits it for each rig a harvest pays (topic 0x4f2d1832, test/spike/T2_YieldRouting.t.sol)
      ev('Paid', [['id', 'uint256', true], ['to', 'address', true], ['amount', 'uint256', false]]),
    ],
  },
  {
    file: 'circuits',
    name: 'circuitsAbi',
    artifact: 'IXLayer.sol/ITapeOutCircuits.json',
    fns: ['circuitInfo', 'netlist', 'ownerOf'],
    // the Circuits contract is an ERC-721: name and symbol read "Tape Pool Policy" and "TPPOL" (verified live)
    extra: [fn('name', [], [['', 'string']]), fn('symbol', [], [['', 'string']])],
  },
  {
    file: 'bscVault',
    name: 'bscVaultAbi',
    artifact: 'IBsc.sol/IRigVaultBsc.json',
    fns: ['rigs', 'cellOf', 'quoteHarvest', 'harvest'],
    extra: [
      // the receipt of a harvest: `packed[i] >> 128` is the BEM (raw) sent for `ids[i]` (research/notes/miners/bridge_xlayer.md, Q2)
      ev('Harvested', [['guid', 'bytes32', true], ['ids', 'uint256[]', false], ['packed', 'uint256[]', false]]),
      // 0 ids, more than MAX_BATCH, or no id the vault knows: the same selector as RigReporter's BadBatch
      err('BadBatch', []),
    ],
  },
  // the BEM OFT adapter on BSC, for the bridge fee a harvest pays on its way to X Layer
  { file: 'adapter', name: 'adapterAbi', artifact: 'IXLayer.sol/IOFTLike.json', fns: ['feeBps'] },
  {
    // BEM on BSC (its balance and allowance are read with the ERC-20 ABI above). A bond that cannot be pulled reverts with the ERC-20
    // errors of OpenZeppelin v5 (they are in TapePool's list, and the revert union is by selector) or, when a SafeERC20 call fails
    // without data, with these two of the Address library (SafeERC20FailedOperation is in RigReporter's list)
    file: 'bscBem',
    name: 'bscBemAbi',
    hand: true,
    extra: [err('FailedCall', []), err('FailedInnerCall', [])],
  },
  { file: 'podMining', name: 'podMiningAbi', artifact: 'IBsc.sol/IPodMining.json', fns: ['minerKey', 'getMiner', 'pending', 'totalVerifWeight'] },
  { file: 'ownerOf', name: 'ownerOfAbi', artifact: 'IBsc.sol/IERC721OwnerOf.json', fns: ['ownerOf'] },
  { file: 'erc20', name: 'erc20Abi', artifact: 'IERC20.sol/IERC20.json', fns: ['balanceOf', 'allowance', 'approve'] },
  { file: 'multicall3', name: 'multicall3Abi', artifact: 'IMulticall3.sol/IMulticall3.json', fns: ['aggregate3', 'getEthBalance'] },
  {
    // Reverts that no artifact of ours declares but a transaction can still hit: the voucher's ERC-721 errors (ERC-6093)
    // and the LayerZero endpoint's fee error, which bubbles up through RigReporter.push. A revert is decoded against the
    // union of this list and the errors of RigAgent, TapePool, AgentFactory and RigReporter (src/chain/revert.ts).
    file: 'extraErrors',
    name: 'extraErrorsAbi',
    hand: true,
    extra: [
      err('ERC721InvalidOwner', [['owner', 'address']]),
      err('ERC721NonexistentToken', [['tokenId', 'uint256']]),
      err('ERC721IncorrectOwner', [['sender', 'address'], ['tokenId', 'uint256'], ['owner', 'address']]),
      err('ERC721InvalidSender', [['sender', 'address']]),
      err('ERC721InvalidReceiver', [['receiver', 'address']]),
      err('ERC721InsufficientApproval', [['operator', 'address'], ['tokenId', 'uint256']]),
      err('ERC721InvalidApprover', [['approver', 'address']]),
      err('ERC721InvalidOperator', [['operator', 'address']]),
      err('LZ_InsufficientFee', [['requiredNative', 'uint256'], ['suppliedNative', 'uint256'], ['requiredLzToken', 'uint256'], ['suppliedLzToken', 'uint256']]),
    ],
  },
];

/** Keep the fields viem needs, in a fixed order. */
function slim(item) {
  const param = (p) => {
    const o = { name: p.name, type: p.type };
    if (p.indexed !== undefined) o.indexed = p.indexed;
    if (p.components) o.components = p.components.map(param);
    return o;
  };
  if (item.type === 'function') {
    return { type: 'function', name: item.name, inputs: item.inputs.map(param), outputs: item.outputs.map(param), stateMutability: item.stateMutability };
  }
  if (item.type === 'event') return { type: 'event', name: item.name, inputs: item.inputs.map(param), anonymous: item.anonymous ?? false };
  return { type: 'error', name: item.name, inputs: item.inputs.map(param) };
}

const signature = (item) => `${item.type} ${item.name}(${item.inputs.map(function typeOf(p) { return p.components ? `(${p.components.map(typeOf).join(',')})` : p.type; }).join(',')})`;

function pick(abi, spec) {
  const out = [];
  const want = (kind, names) => {
    for (const name of names) {
      const hits = abi.filter((i) => i.type === kind && i.name === name);
      if (hits.length === 0) throw new Error(`${spec.artifact}: no ${kind} named ${name}`);
      if (hits.length > 1) throw new Error(`${spec.artifact}: ${kind} ${name} is overloaded; select by hand`);
      out.push(slim(hits[0]));
    }
  };
  want('function', spec.fns ?? []);
  want('event', spec.events ?? []);
  if (spec.errors) {
    const seen = new Set();
    for (const e of abi.filter((i) => i.type === 'error')) {
      const sig = signature(e);
      if (seen.has(sig)) continue; // the same error declared in a library and a contract
      seen.add(sig);
      out.push(slim(e));
    }
  }
  for (const e of spec.extra ?? []) out.push(e);
  return out;
}

/** One entry per line, so a diff of the ABI reads like a diff of the list. */
function render(spec, items, bytecode) {
  const lines = items.map((i) => `  ${JSON.stringify(i)},`).join('\n');
  const head = `// Generated by scripts/gen-abi.mjs${spec.hand ? ' (written by hand in the generator)' : ` from forge out/${spec.artifact}`}. Do not edit; run \`npm run gen:abi\`.\n`;
  let text = `${head}export const ${spec.name} = [\n${lines}\n] as const;\n`;
  if (bytecode) text += `\n/** The deployed (runtime) code of the contract: the app places it at a dummy address with an eth_call state override. */\nexport const ${spec.bytecode} = '${bytecode}' as const;\n`;
  return text;
}

/** Every generated file as `{ 'tapePool.ts': text, ..., 'index.ts': text }`. Throws when `out/` lacks an artifact. */
export function buildAbiFiles(outDir = OUT_DIR) {
  const files = {};
  for (const spec of SPECS) {
    const art = spec.hand ? { abi: [] } : JSON.parse(fs.readFileSync(path.join(outDir, spec.artifact), 'utf8'));
    const items = pick(art.abi, spec);
    let code = null;
    if (spec.bytecode) {
      code = art.deployedBytecode.object;
      if (!/^0x[0-9a-f]+$/i.test(code)) throw new Error(`${spec.artifact}: no deployed bytecode`);
      if (Object.keys(art.deployedBytecode.immutableReferences ?? {}).length > 0) throw new Error(`${spec.artifact}: has immutables, so its runtime code cannot be placed at another address`);
      if (Object.keys(art.deployedBytecode.linkReferences ?? {}).length > 0) throw new Error(`${spec.artifact}: has unlinked libraries`);
    }
    files[`${spec.file}.ts`] = render(spec, items, code);
  }
  files['index.ts'] =
    `// Generated by scripts/gen-abi.mjs. Do not edit; run \`npm run gen:abi\`.\n` +
    SPECS.map((s) => `export { ${s.name}${s.bytecode ? `, ${s.bytecode}` : ''} } from './${s.file}';`).join('\n') +
    '\n';
  return files;
}

export function writeAbiFiles() {
  const files = buildAbiFiles();
  fs.mkdirSync(ABI_DIR, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(ABI_DIR, name), text);
  return Object.keys(files).length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!fs.existsSync(OUT_DIR)) {
    console.error(`no ${OUT_DIR}: run \`forge build\` in the repo root first`);
    process.exit(1);
  }
  console.log(`wrote ${writeAbiFiles()} files to src/chain/abi`);
}
