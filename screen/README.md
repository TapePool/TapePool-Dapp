# Tape Pool revocation screen

Proves that a bridged TapeOut rig **cannot be revoked** by PodMining on BSC, and writes the artifact
whose hash the owner records with `RigScreen.recordPass`.

PodMining revokes a miner only through `challenge`, with one of its task's frozen official vectors.
For each rig the tool:

1. checks the rig's identity on X Layer and BSC, and that PodMining, its module and the circuits
   evaluator are the reviewed versions;
2. rebuilds the task's Merkle root from the published vectors and compares it with the chain;
3. runs every official vector through its own TAP-02 evaluator (V1) and cross-checks that evaluator
   against the processor's `eval` / `step`;
4. simulates `challenge` for every official vector with `eth_call` and requires `Corr()` each time
   (V2: PodMining's own code is the judge);
5. under option A (the owner's choice), also requires exhaustive equivalence with the task's
   reference circuit (up to 20 input bits) and `passesCounterexamples`.

It is **read-only**: no key, no signing, no transaction.

```bash
npm ci --ignore-scripts
npm run build
npm test                                   # unit tests, offline
SCREEN_LIVE=1 BSC_RPC=... npm test         # plus live read-only tests (archive BSC endpoint; uses a local anvil fork once)
BSC_RPC=... node dist/cli.js check 16      # screen rig 16 at the finalized block; writes artifacts/
BSC_RPC=... node dist/cli.js verify artifacts/rig-16-*.json         # reproduce at the pinned block
BSC_RPC=... node dist/cli.js verify artifacts/rig-16-*.json --now   # and re-run at the current block
```

Options: `--block N` (BSC), `--xblock N` (X Layer), `--vectors <file>` (a local copy of
`https://tapeout.net/pod/pod-vectors-all.json`; the default downloads it), `--out <dir>`, `--screen
<RigScreen address>` (fills in the printed `recordPass` call). Option A is the owner's rule; `--mode B
--allow-mode-b` exists for experiments only and never prints a `recordPass` call. `check` and `verify`
refuse to run when `dist/` is older than `src/` (run `npm run build`).

`XLAYER_RPC` defaults to the public RPC, which may not keep old state: to verify an artifact weeks
later, set it (and `BSC_RPC`) to archive endpoints. Before each `recordPass`, consider running
`verify` once more against a second archive provider: every chain fact comes from one RPC, and the
artifact's block hashes make the comparison exact. `verify --now` writes its re-verification artifact
and an `INDEX.md` row into `artifacts/` by default; pass `--out <dir>` unless you mean to commit it.

Artifacts are canonical JSON (RFC 8785, every integer a decimal string, no trailing newline);
`artifactHash` is the keccak256 of the file bytes. `artifacts/INDEX.md` lists them. For a PASS the
tool prints the `recordPass` call for the owner's browser wallet (`cast send … --browser`) and the
raw calldata. Commit the artifact first, then record; the pass takes effect 48 h later.

After an upgrade of PodMining or of the BSC circuits evaluator the keeper pauses borrows. Then: review
the upgrade, update `src/constants.ts` (and `keeper/src/addresses.ts`), run `verify --now` on every
recorded pass, revoke any pass whose results changed, and only then unpause (spec §6).

`scripts/fixtures.ts` rebuilds `test/fixtures/` from BSC at a pinned block.
