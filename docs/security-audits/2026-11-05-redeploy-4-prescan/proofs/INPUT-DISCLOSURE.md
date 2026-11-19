# What the blind scan sessions could see (redeploy 4, before the deploy, for the report's Methodology)

Prepared on 2026-11-05 by the coordinating session. O4-3 of `docs/SPEC-REDEPLOY-4.md`, approved by the owner on 2026-11-05, planned this step as two Claude passes, one Codex pass with Forge allowed, Slither and house triage on the frozen commit. The owner changed it the same day to Codex only (Sol 6.1 xhigh and Astra high) under this session's supervision: see SCAN-FACTS.md. Any High or Medium finding returns to the build before RD4-03.

- **Audited commit.** `ceed0a2` on branch `redeploy-v4`. It is not deployed yet. Parts A, B and C passed their Fable 5.1 final audits before this scan.
- **Who prepared the export.** The coordinating session knows the earlier reviews, the spec and the fixes, so it takes no part in hunting, verification or triage, and it does not write the report. It built the export, ran the build, tests and Slither, wrote the briefs, supervised the sessions and added no review content of its own. The briefs describe the process and give no focus hints.
- **`docs/SPEC.md` as amended for redeploy 4**, with these edits (normative text unchanged):
  - the pointers to the redeploy spec documents and build notes removed;
  - requirement and decision ids removed (`R4-xx`, `RB4-xx`, `RD4-xx`, `O4-x`, `R3-xx`, `RA-xx`, `RB-xx`, `RB3-xx`, `RD-xx`, `O-x`, `O3-x`, `D-4`, `D-O1`, `G-xx`), with "the keeper" or "the deploy runbook" where an id named such a rule;
  - spec version labels (`v4`, `v5`), "Part A re-audit L-04" and "gap check U3" removed;
  - §17 (where the frozen spec was applied and amended) removed;
  - the Annex's opening sentence shortened. The Annex keeps its definitions, rows and decisions.
  - The script is `scrub-spec4.cjs`. A pattern scan of the result finds none of those ids.
  - §16 keeps its accepted-risk rows, including those added for this redeploy. So a scan can read that these risks were accepted, and can also read which areas changed from the rows that say "Redeploy 4".
- **`docs/SECURITY-AUDIT-TEMPLATE.md`** as at `ceed0a2`, with its live-value table and the amended exit, share-price, owner and stale-data lines.
- **`src/` verbatim**, for bytecode and metadata parity. Its NatSpec cites requirement ids, such as `R3-xx` in `RigAgent.sol` and `TapePool.sol`, and row letters.
- **Tests and scripts.** Ordinary tests and their NatSpec stay. File and test names such as `Redeploy4Evidence`, `Redeploy4Custody`, `Redeploy4Reserve`, `Redeploy4Bonus`, `Redeploy4Rehearsal`, and the `Redeploy3*` files line up with the areas each redeploy changed. Comments that named earlier reviews were edited, test code unchanged (`sanitize4.cjs`):
  - `script/app/ParityVectors.s.sol`: "(v5, L-04)", "v5 (L-04)";
  - `test/fork/Redeploy4Bonus.t.sol`: "the H-01 reproduction";
  - `test/invariant/PoolHandler.sol`: "(L-04)";
  - `test/mocks/Hostile.sol` and `test/unit/Rounding.t.sol`: pointers to the Phase 4 review spec;
  - `test/unit/EdgeCases.t.sol`: "added after audit round 1" and six "round 1, finding N" labels;
  - `test/unit/PolicyIntegration.t.sol`: "review finding F6";
  - `test/unit/Redeploy3EvidenceTable.t.sol`: "(v5, L-04)", "(L-04)";
  - `test/unit/Redeploy3StoredImpaired.t.sol`: "The final audit's L-01", "L-04".
  Other comments keep spec pointers such as `R4-xx`, `SPEC-PHASE3 §…`, `DERISK Q…` and `RD3-0x`.
- **`foundry.toml`**: the `[fmt]` block that ignored a file under `test/audit/` and its comment naming the 2026-11-01 review were removed. Build settings unchanged.
- **`CLAUDE.md` verbatim** as at `ceed0a2`. Its address tables name the 2026-10-21 stack.
- **Removed:** `test/audit/`, `test/unit/ConformanceMatrix.t.sol`, every other document, `app/`, `keeper/`, `screen/`, `research/`, `broadcast/`, `.github/`, `README.md`, `app-dev.cmd` and the git history.
- **Dependencies:** `lib/` copied from the build checkout's submodules without their `.git` links; `node_modules/` as in `package-lock.json`. The review folders' `.env` holds public endpoints only.
- **Session isolation.** Each review session works in its own folder outside the repository, and Codex memories are off. Reads are not sandboxed. Logs are checked afterwards for reads outside the folder, and rollouts for each turn's model and effort.
- **Earlier reviews are known to exist.** The briefs say so, and forbid looking for them. The owner has run several reviews of this code base, and the export cannot hide that the code was reviewed.
- **First Codex pass (`codex-1`).** Before the owner's change: one plain review through the CLI in its own copy of the export, with Forge and no network, about 21 minutes, zero findings. Its facts are in CODEX-PASS-FACTS.md. That copy's `.env` held the keyed RPC URLs; a search of its log finds no sign that it read them. The ten units then ran with public endpoints and with network on.
