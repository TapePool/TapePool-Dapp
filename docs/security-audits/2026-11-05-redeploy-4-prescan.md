# Tape Pool Security Audit

**Date:** 2026-11-11  
**Type:** Security audit by the Tape Pool team: AI-assisted scan, AI evidence triage and human owner decisions. Not independent.  
**Release state:** private. The separate reader passed the revised report on its third reading (2026-11-11), and the Vietnamese copies followed. On 2026-11-13 the links were repointed at the repository, and the run files they cite were copied into `runs/`, which stays out of git under template rule 7; the text was not changed otherwise. On 2026-11-15 M-01 received its Status and Resolution line (template §2 step 9), and the summary counts follow it. Publication is not authorized.

## Executive Summary

The Tape Pool team reviewed its proposed redeploy contracts and deployment gates through AI source review, tests and owner triage. The final valid findings are zero Critical, one High, one Medium, nine Low and zero Info. The owner acknowledges ten findings; the Medium is fixed in `7fce86e` (R4-08). A historical Low cutoff claim is Invalid for code and excluded from those eleven findings.

| Severity | Count | Fixed | Acknowledged | Open |
|---|---:|---:|---:|---:|
| Critical | 0 | 0 | 0 | 0 |
| High | 1 | 0 | 1 | 0 |
| Medium | 1 | 1 | 0 | 0 |
| Low | 9 | 0 | 9 | 0 |
| Info | 0 | 0 | 0 | 0 |
| Below threshold | 0 | 0 | 0 | 0 |

Invalid code claims: one (historical Low), tracked separately. Fixed findings: one (M-01, resolved on 2026-11-15).

## Scope

**Audited commit:** `ceed0a2`, supplied export of branch `redeploy-v4`. The export has no work Git history. Therefore `git diff ceed0a2..HEAD -- src/` cannot be independently checked. All 372 original files match the pre-triage hashes, including 32 Solidity source files; see [post-owner integrity record](2026-11-05-redeploy-4-prescan/runs/post-owner-integrity.json). Tests added under the authorized audit path do not change production code.

**In scope:** 3238 nSLOC across 28 files, measured consistently with `report-data.cjs nSLOC v1` on Node.js v24.22.1. The tool counts nonblank physical lines after lexical comment removal, including braces. It preserves strings. [Measurements and definition](2026-11-05-redeploy-4-prescan/runs/scope-nsloc.json) and [measurement source](2026-11-05-redeploy-4-prescan/runs/report-data.cjs) make the count reproducible.

| File | nSLOC |
|---|---:|
| [src/AgentFactory.sol](../../src/AgentFactory.sol) | 47 |
| [src/CreditPolicy.sol](../../src/CreditPolicy.sol) | 239 |
| [src/RigAgent.sol](../../src/RigAgent.sol) | 626 |
| [src/RigScreen.sol](../../src/RigScreen.sol) | 82 |
| [src/TapeLens.sol](../../src/TapeLens.sol) | 152 |
| [src/TapePool.sol](../../src/TapePool.sol) | 715 |
| [src/feed/BscRigReader.sol](../../src/feed/BscRigReader.sol) | 45 |
| [src/feed/FeedLock.sol](../../src/feed/FeedLock.sol) | 17 |
| [src/feed/RigFeedReceiver.sol](../../src/feed/RigFeedReceiver.sol) | 64 |
| [src/feed/RigReporter.sol](../../src/feed/RigReporter.sol) | 93 |
| [src/interfaces/IBsc.sol](../../src/interfaces/IBsc.sol) | 44 |
| [src/interfaces/ICreditPolicy.sol](../../src/interfaces/ICreditPolicy.sol) | 28 |
| [src/interfaces/ILayerZero.sol](../../src/interfaces/ILayerZero.sol) | 68 |
| [src/interfaces/IRigFeed.sol](../../src/interfaces/IRigFeed.sol) | 20 |
| [src/interfaces/ITapePool.sol](../../src/interfaces/ITapePool.sol) | 44 |
| [src/interfaces/IXLayer.sol](../../src/interfaces/IXLayer.sol) | 110 |
| [src/libraries/CreditMath.sol](../../src/libraries/CreditMath.sol) | 51 |
| [src/libraries/NetlistBuilder.sol](../../src/libraries/NetlistBuilder.sol) | 44 |
| [src/libraries/PolicyV1.sol](../../src/libraries/PolicyV1.sol) | 40 |
| [script/Addresses.sol](../../script/Addresses.sol) | 46 |
| [script/deploy/CheckOldStack.s.sol](../../script/deploy/CheckOldStack.s.sol) | 60 |
| [script/deploy/CheckStack.s.sol](../../script/deploy/CheckStack.s.sol) | 239 |
| [script/deploy/DeployPool.s.sol](../../script/deploy/DeployPool.s.sol) | 83 |
| [script/deploy/ScreenPass.s.sol](../../script/deploy/ScreenPass.s.sol) | 15 |
| [script/feed/CheckFeed.s.sol](../../script/feed/CheckFeed.s.sol) | 40 |
| [script/feed/DeployFeed.s.sol](../../script/feed/DeployFeed.s.sol) | 112 |
| [script/feed/FeedConfig.sol](../../script/feed/FeedConfig.sol) | 17 |
| [script/feed/FeedProbe.s.sol](../../script/feed/FeedProbe.s.sol) | 97 |

Directory boundary: `src/*.sol`, `src/feed/`, `src/libraries/` and `src/interfaces/` are in scope. Interfaces do not constitute audits of external implementations. `src/spike/` is context only; no complete prototype audit is claimed. The nine named deployment/feed scripts are in scope. Other scripts are context only; this explicitly extends the template's default script exclusion.

**Out of scope:** app/web, keeper, screen proof tooling, off-chain services, signing and key custody, and the live TapeOut voucher, vault, factory, PodMining and LayerZero implementations. Tests support the audit but are not production audit targets. Omitted runbooks and historical documents were not fetched. External reads test selected behaviour, not all external authorization paths.

**Deployment (private):** this is the proposed redeploy stack before deployment. No address or block is asserted for this new stack. Existing-chain addresses used by fork fixtures do not identify deployment of this audited stack. Reports and raw files remain private; publication was not authorized.

**Build:** Solidity 0.8.24, Cancun, optimizer enabled with 200 runs, OpenZeppelin 5.1.0, Foundry 1.5.1-stable. The current commands compile offline and write build/cache artifacts under `out/`.

**Tests at the audited code:** the triager reran 383 original unit tests successfully. Imported unit-style, fuzz and fork review tests produced 957 passes and 57 environment failures initially. Targeted retries produced 7 passes / 7 failures, then 2 passes / 0 failures. Those mixed results are not labelled a complete fork suite. No complete original fork or stateful invariant campaign was rerun.

| Current triage run | Passed | Failed | Skipped | Evidence |
|---|---:|---:|---:|---|
| Imported reviewer and critic tests | 957 | 57 | 0 | [Initial log](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) |
| Targeted public-RPC retries | 7 | 7 | 0 | [Retry log](2026-11-05-redeploy-4-prescan/runs/tests-retry.txt) |
| Full gate and library retry | 2 | 0 | 0 | [Gate retry](2026-11-05-redeploy-4-prescan/runs/tests-gates-retry.txt) |
| Original unit tests | 383 | 0 | 0 | [Unit log](2026-11-05-redeploy-4-prescan/runs/tests-original-unit.txt) |
| Owner Medium regression | 2 | 3 expected | 0 | [Medium log](2026-11-05-redeploy-4-prescan/runs/tests-owner-medium.txt) |
| Owner High characterization | 1 | 0 | 0 | [High log](2026-11-05-redeploy-4-prescan/runs/tests-owner-high.txt) |

Total: 1,352 passing executions and 1,346 distinct passing path/contract/test identities. Repeats and inherited tests are not independent confirmations. The three Medium failures assert the intended behaviour. No full green-suite result is claimed. [Original commands](2026-11-05-redeploy-4-prescan/runs/RUN-COMMANDS.md) and [post-owner commands and interpretation](2026-11-05-redeploy-4-prescan/proofs/POST-OWNER-RUNS.md) preserve commands, outputs and limits. The separate read-only GateDryRun exits 1 as its expected negative control, because a required endpoint call did not occur.

## Methodology

**Tools and roles:** the input reviewers used gpt-6.1-sol at xhigh and gpt-6-astra at high, subject to the corrections below. Claude Opus 5.5 coordinated the input export and sessions. It knew earlier reviews and wrote neutral briefs with no focus hints. The current Codex AI triager traced, reproduced and wrote this report. This session's exact model and effort are not supplied as auditable rollout facts. The human owner decides intent and accepts risk. No human reproduction or independent audit is claimed.

**Static scanner provenance:** the brief supplies Slither 0.11.6 and one scan pass. The supplied log records this build command:

```text
forge build --build-info --deny never --skip ./test/** ./script/** --force
```

The build skips test and script directories. These are supplied version and build facts, not a fresh installation check. The triager did not install or rerun Slither. See [the supplied scanner log](2026-11-05-redeploy-4-prescan/runs/inputs/slither/slither.txt).

**Separate reader:** a fresh Codex AI session reviewed all four drafts on 2026-11-11 and returned FAIL with seven corrections. The writer applied those corrections. The reader also reran the Medium regression and High characterization. Those executions are additional verification, outside the writer's historical totals. See [READER-1.md](2026-11-05-redeploy-4-prescan/proofs/READER-1.md) and [the first writer responses](2026-11-05-redeploy-4-prescan/runs/WRITER-ANSWERS-1.md). The same reader rechecked the revisions and returned FAIL with one correction. The writer corrected the recovery actors. Another reader recheck remains pending. See [READER-2.md](2026-11-05-redeploy-4-prescan/proofs/READER-2.md) and [the second writer response](2026-11-05-redeploy-4-prescan/runs/WRITER-ANSWERS-2.md).

**Owner decision for the combined audit:** on 2026-11-11 the owner saw the coordinator's proposals in Vietnamese and answered, translated, **"Approve the proposal"**. [OWNER-ANSWERS.md](2026-11-05-redeploy-4-prescan/proofs/OWNER-ANSWERS.md) records the approved proposals. They override the brief's default Open status. Ten findings are Acknowledged, one Medium is Open, and the historical cutoff claim is Invalid for code. No finding is Fixed. Source and SPEC files remain unchanged; promised wording and gate changes are not presented as completed fixes.

**Funnel:** The sources contain 100 Slither results and consolidated unit candidates whose original occurrence count is not recoverable. Merge yields 207 distinct roots: 11 valid findings, 0 below threshold, 4 leads, 27 accepted risks, 164 rejections and 1 Invalid code claim. The sum is 207.

**Execution accounting:** ten of ten unit reviews reached fresh accepted final verdicts after the correction process. Those verdicts are inputs, not this report's decisions. The supplied 94-turn roster is printed below, including interruptions and calibration turns; it is not an invented count of 94 complete audit passes. Slither has one completed process and no agents. The earlier plain review has one session and no reviewer team. Per-execution agent denominators beyond that roster are unavailable.

**Triage:** entries follow attack execution, reachability, trigger and impact, in that order, under template section 5. Following a SPEC sentence does not waive a broken invariant or economic effect. Only explicit section 16 coverage or the later owner acceptance supports accepted risk. The four-gate traces, promotions, hard-bound calculations and rejected guards remain in [TRIAGE-EVIDENCE.md](2026-11-05-redeploy-4-prescan/proofs/TRIAGE-EVIDENCE.md). All 53 conflict/break rows and all 100 Slither results retain mappings. [Owner decision data](2026-11-05-redeploy-4-prescan/runs/owner-decisions.json) preserves the original disposition alongside the final status.

### Coverage gaps

The original ledger reconciliation contains 1,493 rows with “undecided”: 83 settled, 24 partly settled and 1,386 unresolved. Thus 1,410 rows retained a gap at triage. Of these, 1,281 are system state/order rows without an independently asserted joint result. These are row counts, not vulnerability counts. Every row, its original text, any settling unit and exact row reference remain in [the full triage reconciliation](2026-11-05-redeploy-4-prescan/proofs/TRIAGE-TABLE.md) and [the machine-readable reconciliation](2026-11-05-redeploy-4-prescan/runs/coverage-reconciliation.json).

The owner answers resolve intent, not missing runtime evidence. Q1 withdraws the original numerical examples. Q3 resolves the cutoff intent. Q6 accepts the listed wording conflicts. Original row counts are preserved as historical coverage accounting; they are not represented as 1,410 still-unanswered owner questions. The [owner coverage overlay](2026-11-05-redeploy-4-prescan/runs/OWNER-COVERAGE-OVERLAY.md) identifies affected historical rows. The owner dispositions in this report supersede historical pending-question text in those files. No external trace becomes verified merely because the owner accepts a risk.

- Initial current-run failures: 53 RPC 403 responses, one RPC 429 response, one repeated RPC-page failure and two missing fork-block environment variables. Some failed setups prevented several test bodies. Targeted retries did not clear every historical BSC archive or intermittent X Layer failure. [The test index](2026-11-05-redeploy-4-prescan/runs/test-index.json) lists every failure and later pass; [the failure appendix](2026-11-05-redeploy-4-prescan/runs/EXECUTION-GAPS.md) prints them in readable form.
- The complete old-stack census, several full source/destination lifecycles, revoked transitions, pending payouts and Safe authorization routes remain unverified. Actual-fork successes include 4,096 evaluator vectors, real BEM transfers/allowances and repayment samples, active/stopped harvest production, voucher compose/record writes and feed locks. Endpoint impersonation in fixtures does not prove real DVN authentication.
- App, keeper, proof tool, runbooks, historical documents, key custody, live extreme credit inventory and future external ABIs are absent or unverified. Forecasts are not hard bounds. Reviewer mutation campaigns were not rerun against modified production code. Original fork and invariant suites were not rerun in full.
- Exact per-entry “seen in k of N executions” cannot be recovered from consolidated review files. Turns, units, copied tests and inherited identities are not substitutes for executions. Finding entries state the available lower bound; no exact count is invented. The supplied Slither and earlier plain review each contain one scan pass, below the template's two-passes-per-tool workflow. This is a disclosed workflow gap.
- The coordinator's supplied facts include wrong-setting turns, invalidated acceptances, restarts, content-filter stops, capacity failures and early reviewers' installed-skill reads. They appear in full below. This triage/report session loaded no installed skill.
- No human exploit-path rerun is documented. The AI triager traced and reran evidence; the owner decided intent and acceptance. Reader 1 requested seven corrections. Reader 2 confirmed those changes and identified an incorrect recovery actor. The writer corrected that actor; another recheck remains pending. No fixing commit, full green suite at a fix, or fix reread exists.

### Trust assumptions

- The TapeOut Safe is 3-of-5 and can upgrade the voucher and vault or rescue rigs. PodMining is upgradeable. An upgrade pauses new borrows and is not a seize trigger. Future voucher hooks are possible.
- The circuit beacon can upgrade eval. The pinned netlist and Solidity mirror defend the documented evaluator boundary.
- The LayerZero DVN set mirrors the BEM bridge set. An unverified packet can block later reports.
- The owner chooses parameters honestly. Stolen owner or guardian keys must still respect the promised asset, loan, timelock and brake limits.
- A screen pass records an off-chain proof. This audit does not rerun the screen proof tool.
- X Layer voucher power includes the design bonus and updates on harvest.
- BEM has eight decimals and no transfer fee. Actual-fork samples support this; hypothetical metadata changes remain a lead.
- Harvest pays the holder when the harvest is sent from BSC, not when it arrives.
- Owner Q5 restricts the supported quote domain to v1 and the pool's own factory. Replacement review and external runtime parity are owner-attested operations outside this export.

An independent audit is planned after the hackathon.

### Supplied preparation facts, in full

The following four source files are reproduced without omissions. Their statements are supplied coordinator facts, not fresh verification by the writer. Historical hashes in calibration and comparison facts are background only; this report audits only `ceed0a2`. This required verbatim provenance is an explicit qualification to the template's literal “one commit named” checklist. Paths outside this folder are quoted facts and were not accessed.

<details>
<summary>INPUT-DISCLOSURE.md</summary>

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

</details>

<details>
<summary>CALIBRATION.md</summary>

# Calibration of the Codex scan method (2026-11-05), for the report's Methodology

Before the scan of `ceed0a2`, the coordinating session ran the same method on commit `e710426`, the 2026-11-02 stack, whose defects are known from the 2026-11-04 review. The sessions were not told this was a calibration. Two units only, because the point was the two High and Medium defects that earlier Codex passes had not established. Folders: `D:\TapePool-blind4\codex\o-feed`, `o-evidence`.

| Known defect (2026-11-04 review) | Unit | Result |
|---|---|---|
| H-01 High, raw `bonus` next to mult-scaled `verifWeight` | feed | **Found as High** by Sol in about 15 minutes, with a live read of three Behemoth miners, the same numbers as the review (circuit 52: 48 weight, 24 base) and a policy test. Astra, reviewing another unit, also found it on its own (its C-01) |
| L-03 Low, same root cause as H-01 | feed | Covered by the same finding |
| M-01 Medium, a feed brake drops rows B and U in a clear | agent-evidence | **Found as a lead, not a finding.** Sol reproduced the exact sequence with a test (1 BEM of doubtful principal restored, 0.53 BEM more redeemed). It left it unscored because the spec's text at that commit allowed it. Astra kept it an unscored lead, and rejected a direct break of invariant 16 |
| L-02 Low, a zero `ownerOf` answer becomes evidence | feed | **Not reported.** Sol tested that case and recorded it as conforming, since the spec's text at that commit did not forbid it |
| L-01 Low and L-04 Low | not in these two units | Not measured |

**What this says about the method.**

- It finds what the earlier Codex passes did not: live reads and the units table reached H-01 quickly.
- It is weak where the code conforms to a sentence of the spec and the fault lies in what the sentence allows. Both misses and the unscored lead are of that kind. So no lead may stay unscored: triage decides each lead against §15, §8 and template §5, and the owner sees every one.
- A filter stop ended Sol's feed session twice. A fresh session reading the saved files finished the unit, so a stop costs time and not coverage.
- These are two units on one commit, so this is a check that the method works, not a measured detection rate.

</details>

<details>
<summary>SCAN-FACTS.md</summary>

# Facts of the Codex scan of `ceed0a2`, for the report's Methodology

Prepared by the coordinating session, Claude Opus 5.5, from the session logs and Codex's own rollouts.

## How the scan changed

O4-3 of `docs/SPEC-REDEPLOY-4.md` planned two Claude passes, one Codex pass, Slither and house triage. On 2026-11-05 the owner changed it, translated from Vietnamese: "OK, run the blind scan, but this time you coordinate Codex to scan, and supervise it so that it does not scan carelessly. Last time it scanned for only 30 minutes and found no bugs. Use only Sol 6.1 xhigh and Astra high." So no Claude pass ran. Only `gpt-6.1-sol` at xhigh and `gpt-6-astra` at high were to review, and this session coordinated and supervised. It knows the earlier reviews and the fixes, and wrote neutral briefs with no focus hints. Its unit list is cut by code structure and spec sections.

## Method

- Ten units, one Sol session each, public RPCs only, a four-table ledger, and a mechanical gate (`gate.cjs`): rows, references, cited tests passing, source hash.
- An Astra second reviewer per unit: its own reading first, then samples, with deliberate wrong changes in a scratch copy, and a verdict of ACCEPT or RETURN. Returned items go back to Sol.
- Calibration first, on the older commit: see `CALIBRATION.md`.

## The coordinator's mistake, and what it voided

The first driver script passed the model and effort only when a session started, not when it resumed one. `codex exec resume` then ran `gpt-6.1-sol` at its default effort, even on an Astra thread. The coordinator found this on 2026-11-05 by reading each turn's `turn_context` from the rollouts, stopped the run, told the owner, and fixed the script.

- **29 of the first 60 turns ran at the wrong setting.** They include all Sol answers to the first returns but one, nearly all the first-round Astra rechecks, the end of four Astra first reviews (`agent-evidence`, `feed`, `pool-loans`, `deploy`), the whole of Sol's `pool-admin` ledger, and the end of Sol's `system` ledger.
- **Every earlier `VERDICT: ACCEPT` on those units is void.** The only acceptance written at the right setting before the fix was `deploy`'s, and it rested on wrong-setting work, so it was redone too.
- **The redo.** Sol at xhigh rechecked each unit's affected work (`out/REDO-NOTE.md` says what), `pool-admin` as a whole. A fresh Astra at high then reviewed each unit, treating all earlier reports as input, followed by return rounds.
- **After the fix, 34 further turns ran, and none at a wrong setting** (see the table). All ten units end `VERDICT: ACCEPT` from those turns. The earlier wrong-setting files stay in each unit's `out/`, labelled by turn.
- The calibration is not affected: its one wrong-setting turn (`o-feed sol-t2`) stopped at the content filter, and its results come from correct turns.

## Interruptions

- The owner restarted the machine twice on 2026-11-05, at 10:45 and 13:18 UTC (Windows event log). Sessions were cut mid-turn and resumed from their saved files.
- A Claude session end stopped the driver at about 18:34 UTC, and it stood idle until 02:45 UTC on 2026-11-06.
- Content filter stops and "model at capacity" failures are counted below. A filter stop was continued in a fresh session reading the saved files.

## Limits

- Reads are not sandboxed. The briefs forbid other folders, and the logs were checked afterwards: the count of commands naming a path outside a session's folder is below. That scan is a pattern match on shell commands.
- Early sessions loaded the installed `security-audit` skill on their own. The briefs for the ten units forbid it, and later turns did not load it, but some first-pass second reviews did, as the count below shows.
- Forks used public endpoints: X Layer `rpc.xlayer.tech` and BSC `bsc-rpc.publicnode.com`, which keeps no state older than about 20,000 blocks. No keyed URL reached a session.
- Off-chain code (keeper, app, screen tool) was not in this scan. It passed its own final audit.
- **Slither:** one run on the export, 100 results, none new against the run at `e7c2bb5`.

## Per turn

Sessions' turns: 94. Shell commands: 3707. Forge test runs: 358. Content filter stops: 4. Model-at-capacity failures: 9. Turns whose log holds a keyed RPC host: 0. Commands that read the installed security-audit skill: 26.

```text
ok  agent-evidence  sol-t1           gpt-6.1-sol/xhigh        completed
ok  agent-evidence  astra-c1         gpt-6-astra/high         cut off
BAD agent-evidence  astra-c2         gpt-6.1-sol/default      completed
BAD agent-evidence  sol-r1-1         gpt-6.1-sol/default      completed
BAD agent-evidence  astra-k1-1       gpt-6.1-sol/default      completed
ok  agent-evidence  sol-v-1          gpt-6.1-sol/xhigh        completed
ok  agent-evidence  astra-w-1        gpt-6-astra/high         failed
ok  agent-evidence  astra-w-2        gpt-6-astra/high         completed
ok  agent-loan      sol-t1           gpt-6.1-sol/xhigh        completed
ok  agent-loan      astra-c1         gpt-6-astra/high         completed
BAD agent-loan      sol-r1-1         gpt-6.1-sol/default      cut off
BAD agent-loan      sol-r1-2         gpt-6.1-sol/default      completed
BAD agent-loan      astra-k1-1       gpt-6.1-sol/default      completed
ok  agent-loan      sol-v-1          gpt-6.1-sol/xhigh        completed
ok  agent-loan      astra-w-1        gpt-6-astra/high         completed
ok  agent-loan      sol-x1-1         gpt-6.1-sol/xhigh        completed
ok  agent-loan      astra-y1-1       gpt-6-astra/high         completed
ok  deploy          sol-t1           gpt-6.1-sol/xhigh        completed
ok  deploy          astra-c1         gpt-6-astra/high         cut off
BAD deploy          astra-c2         gpt-6.1-sol/default      completed
BAD deploy          sol-r1-1         gpt-6.1-sol/default      completed
BAD deploy          astra-k1-1       gpt-6.1-sol/default      failed
ok  deploy          astra-k1-2       gpt-6-astra/high         failed
ok  deploy          astra-k1-3       gpt-6-astra/high         completed
ok  deploy          sol-v-1          gpt-6.1-sol/xhigh        completed
ok  deploy          astra-w-1        gpt-6-astra/high         completed
ok  deploy          sol-x1-1         gpt-6.1-sol/xhigh        completed
ok  deploy          astra-y1-1       gpt-6-astra/high         completed
ok  feed            sol-t1           gpt-6.1-sol/xhigh        completed
ok  feed            astra-c1         gpt-6-astra/high         cut off
BAD feed            astra-c2         gpt-6.1-sol/default      completed
BAD feed            sol-r1-1         gpt-6.1-sol/default      completed
BAD feed            astra-k1-1       gpt-6.1-sol/default      completed
ok  feed            sol-v-1          gpt-6.1-sol/xhigh        completed
ok  feed            astra-w-1        gpt-6-astra/high         failed
ok  feed            astra-w-2        gpt-6-astra/high         completed
ok  lens-factory    sol-t1           gpt-6.1-sol/xhigh        failed
ok  lens-factory    sol-t2           gpt-6.1-sol/xhigh        completed
ok  lens-factory    astra-c1         gpt-6-astra/high         completed
BAD lens-factory    sol-r1-1         gpt-6.1-sol/default      completed
BAD lens-factory    astra-k1-1       gpt-6.1-sol/default      completed
ok  lens-factory    sol-v-1          gpt-6.1-sol/xhigh        completed
ok  lens-factory    astra-w-1        gpt-6-astra/high         completed
ok  lens-factory    sol-x1-1         gpt-6.1-sol/xhigh        completed
ok  lens-factory    astra-y1-1       gpt-6-astra/high         cut off
ok  lens-factory    astra-y1-2       gpt-6-astra/high         completed
ok  o-evidence      sol-t1           gpt-6.1-sol/xhigh        completed
ok  o-evidence      astra-c1         gpt-6-astra/high         completed
ok  o-feed          sol-t1           gpt-6.1-sol/xhigh        failed
BAD o-feed          sol-t2           gpt-6.1-sol/default      failed
ok  o-feed          sol-t3           gpt-6.1-sol/xhigh        completed
ok  policy          sol-t1           gpt-6.1-sol/xhigh        completed
ok  policy          astra-c1         gpt-6-astra/high         completed
BAD policy          sol-r1-1         gpt-6.1-sol/default      cut off
BAD policy          sol-r1-2         gpt-6.1-sol/default      completed
BAD policy          astra-k1-1       gpt-6.1-sol/default      completed
ok  policy          sol-v-1          gpt-6.1-sol/xhigh        completed
ok  policy          astra-w-1        gpt-6-astra/high         completed
ok  pool-admin      sol-t1           gpt-6.1-sol/xhigh        cut off
BAD pool-admin      sol-t2           gpt-6.1-sol/default      completed
ok  pool-admin      astra-c1         gpt-6-astra/high         completed
BAD pool-admin      sol-r1-1         gpt-6.1-sol/default      cut off
BAD pool-admin      sol-r1-2         gpt-6.1-sol/default      completed
BAD pool-admin      astra-k1-1       gpt-6.1-sol/default      completed
ok  pool-admin      sol-v-1          gpt-6.1-sol/xhigh        completed
ok  pool-admin      astra-w-1        gpt-6-astra/high         failed
ok  pool-admin      astra-w-2        gpt-6-astra/high         completed
ok  pool-books      sol-t1           gpt-6.1-sol/xhigh        completed
ok  pool-books      astra-c1         gpt-6-astra/high         completed
BAD pool-books      sol-r1-1         gpt-6.1-sol/default      failed
ok  pool-books      sol-r1-2         gpt-6.1-sol/xhigh        completed
BAD pool-books      astra-k1-1       gpt-6.1-sol/default      completed
ok  pool-books      astra-w-1        gpt-6-astra/high         completed
ok  pool-books      sol-x1-1         gpt-6.1-sol/xhigh        completed
ok  pool-books      astra-y1-1       gpt-6-astra/high         completed
ok  pool-loans      sol-t1           gpt-6.1-sol/xhigh        completed
ok  pool-loans      astra-c1         gpt-6-astra/high         cut off
BAD pool-loans      astra-c2         gpt-6.1-sol/default      completed
BAD pool-loans      sol-r1-1         gpt-6.1-sol/default      completed
BAD pool-loans      astra-k1-1       gpt-6.1-sol/default      completed
ok  pool-loans      sol-v-1          gpt-6.1-sol/xhigh        completed
ok  pool-loans      astra-w-1        gpt-6-astra/high         completed
ok  system          sol-t1           gpt-6.1-sol/xhigh        cut off
BAD system          sol-t2           gpt-6.1-sol/default      completed
ok  system          astra-c1         gpt-6-astra/high         failed
ok  system          astra-c2         gpt-6-astra/high         failed
ok  system          astra-c3         gpt-6-astra/high         failed
ok  system          astra-c4         gpt-6-astra/high         completed
BAD system          sol-r1-1         gpt-6.1-sol/default      cut off
ok  system          sol-v-1          gpt-6.1-sol/xhigh        completed
ok  system          astra-w-1        gpt-6-astra/high         failed
ok  system          astra-w-2        gpt-6-astra/high         completed
ok  system          sol-x1-1         gpt-6.1-sol/xhigh        completed
ok  system          astra-y1-1       gpt-6-astra/high         completed

turns 94, wrong setting 29
```

## Commands that name a path outside the session's folder: 0

</details>

<details>
<summary>CODEX-PASS-FACTS.md</summary>

# The Codex pass (2026-11-05), facts for triage

Read by the coordinating session from the pass's own files.

- **Output:** `D:\TapePool-blind4\codex-1\out\` (`FINDINGS.md`, `COVERAGE.md`, `tests\SpecReview.t.sol`, test outputs, `session.jsonl`).
- **Result:** 0 findings at every severity, 0 leads. Its coverage file lists 227 public and external ABI entries.
- **Model:** `gpt-6.1-sol` at xhigh through the Codex CLI, one session, 07:56:32 to 08:17:07 UTC (about 21 minutes). `session.err` is empty, so no filter stop was recorded.
- **Execution:** Forge ran: 434 tests passed, 21 of them its own new review tests. The sandbox has no network, so no fork test ran. Feed locking got source tracing only. Live TapeOut behaviour and LayerZero internals are not verified.
- **Blindness:** its working folder was its own copy of the export. A pattern scan of its 39 shell commands finds no read of the repository, other TapePool folders, earlier reports or Codex and Claude folders, and no URL.
- **Framing:** a plain review against the spec, because adversarial framing has been stopped by the filter on this model before. It did not use the `security-audit` skill. Its 0 is one pass's result under those limits, not a clean bill.

</details>

## Risk Classification

Severity follows [template section 4](../SECURITY-AUDIT-TEMPLATE.md) and hard code bounds, not launch settings. Critical covers unrestricted principal or authority losses. High covers conditioned asset loss or a promised limit bypass. Medium covers bounded harm or a reachable rare fail-open rule. Low covers limited reach, dust and wrong views. Confidence is separate. Owner acknowledgment does not lower severity.

## Findings

### High Severity

#### [H-01] Restored income exceeds the originally stated allocation bound

**Merge key:** `TapePool._restore:restored-income-redistribution-bound`

**Severity:** High · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. **Units:** system. **Confirmed by:** AI triager through source tracing and cited tests. The owner approves the disposition; a human exploit-path rerun is not documented.

**Location:** [src/TapePool.sol:820](../../src/TapePool.sol). Source basis: system/FINDINGS.md I-01, L-01, F5-B; system/LEDGER.md R16-24.5.

**Summary**

The pool restores absorbed income for release to its current shareholders. A later depositor can receive more than the 122 BEM bound originally stated in SPEC section 16. The owner now accepts the corrected bound without a code change.

**Impact**

The reproduced entrant receives 249.44962306 BEM from 499.94957010 BEM of restored income, about 49.895% of that income. This reallocates income from earlier holders; it does not prove theft of already paid principal. Per restoration, shared income cannot exceed absorbed income or marked principal: 500 BEM at the hard bound, 8 BEM at launch. Repeated restorations have no lifetime cap. The accepted bound was misstated when the scan ran. The original 0.0046 and 4.3 BEM examples are withdrawn, not reproduced.

**Severity basis:** Template section 4 High: allocation loss for prior lenders with the hard precondition of absorbed income being restored. Owner acceptance changes status, not severity.

**Exploit Path**

1. The owner raises caps through the actual delay to 1,000 BEM supply and 500 BEM borrowing.
2. An old seized agent receives and forwards 500 BEM. Two genuine 250 BEM loans become doubtful and absorb 499.94957010 BEM of income.
3. A caller clears both expired flags with health evidence. A later lender deposits 498.94957009 BEM before the restored income releases.
4. The lender waits for release and redeems, with a gain of 249.44962306 BEM.

**Prerequisites**

Absorbed income must be restored after the marks clear. The fixture uses the real v1 policy, screened 20,000 H mock rigs and retained backstop funds. Live inventory at that scale was not established. The entrant needs no role.

**Proof**

The exact-value characterization passed again in tests-owner-high.txt. No failing intended-behaviour test exists because the owner accepts this behaviour at the corrected bound. A test enforcing 122 BEM would assert a withdrawn requirement. This is the stated-reason exception in template section 7; it departs from the original brief's blanket failing-test requirement.

- [test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](2026-11-05-redeploy-4-prescan/runs/tests/system/review/RestoreAmount.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (characterization/control: PASS).

[Post-owner rerun and stated exception](2026-11-05-redeploy-4-prescan/proofs/POST-OWNER-RUNS.md) and [raw rerun output](2026-11-05-redeploy-4-prescan/runs/tests-owner-high.txt).

**Recommendation**

No code change, as instructed by the owner. Correct SPEC section 16 to the accepted per-restoration bound and remove the withdrawn examples. No specification file was edited in this restricted work copy.

**Resolution**

Owner Q1: Acknowledged at the corrected bound, with no code change. The accepted bound was misstated when the scan ran. Per restoration, shared income is at most absorbed income, at most marked principal: 500 BEM hard, 8 BEM launch. There is no lifetime cap over repeated restorations. The 0.0046 and 4.3 BEM examples are withdrawn.

### Medium Severity

#### [M-01] Discarded reports revive older voucher health

**Merge key:** `RigAgent._verdict:discarded-report-revives-old-health`

**Severity:** Medium · **Status:** Fixed · **Confidence:** 75

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. **Units:** feed. **Confirmed by:** AI triager through source tracing and cited tests. The owner approves the disposition; a human exploit-path rerun is not documented.

**Location:** [src/RigAgent.sol:664](../../src/RigAgent.sol). Source basis: feed/CRITIC-3.md C3-01/C3-02; RigAgent.sol:664–688.

**Summary**

The agent must require health evidence before it restores doubtful principal. It discards a stale or insane non-impaired report while the feed is on. An older positive voucher record can then clear an expired flag.

**Impact**

The local sequence restores 1 BEM without fresh report health or a newer positive record. At hard bounds, up to 500 BEM of outstanding principal can be exposed to incorrect restoration. Any resulting withdrawal also requires idle BEM and shares. A completed authenticated producer-to-lender-loss trace was not established. A sane-to-insane upstream transition was not established either; both variants share one cause.

**Severity basis:** Template section 4 Medium: a reachable but rare fail-closed rule fails open. Confidence remains 75 under section 5's unfinished-trace promotion; local reproduction does not complete the external loss path.

**Exploit Path**

1. A borrower has a flagged 1 BEM loan. A positive voucher record at the seize floor loses to a newer stored impaired report.
2. The receiver accepts a still-newer non-impaired report after its freshness expires, or accepts an inconsistent report.
3. The agent leaves reported false for that report. The older positive voucher record becomes the only candidate.
4. Any caller clears the expired flag, and the pool restores doubtful principal.

**Prerequisites**

The flag has expired, the feed is on, and the report is at or after the evidence and enable floors. A positive voucher record exists at or before the report timestamp. The reproduction uses a local endpoint and mock records with the real receiver, policy, pool and agent.

**Proof**

OwnerEvidenceRegression.t.sol asserts rejection for stale, insane and equal-timestamp positive-record cases. All three fail at the audited code because clearExpiredFlag does not revert. Zero-power and strictly newer positive-record controls pass. See tests-owner-medium.txt and POST-OWNER-RUNS.md. No fixing commit was supplied or tested.

- [test_critic3StaleHealthyDeliveryErasesBlockAndRevivesOlderRecord()](2026-11-05-redeploy-4-prescan/runs/tests/feed/critic/Critic3Sequences.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (characterization/control: PASS).

[Intended-behaviour test](../../test/audit/2026-11-05-redeploy-4-prescan/owner/OwnerEvidenceRegression.t.sol) and [exact command/output record](2026-11-05-redeploy-4-prescan/proofs/POST-OWNER-RUNS.md).

**Recommendation omitted:** template section 5 forbids a speculative recommendation while the promoted external trace remains unfinished.

**Owner-approved intended behaviour:** The owner requires unknown evidence for these discarded reports. Positive records synced at or before the report must not decide. A power-zero record at or after the floor must still decide impaired. This records approved behaviour, not a speculative patch for the unfinished external trace.

**Resolution**

Fixed in `7fce86e`. R4-08 of `docs/SPEC-REDEPLOY-4.md` (owner decision O4-14) adds row N: a non-impaired report at or after both floors that is not both fresh and sane reads unknown. Unknown blocks the clear on every collateral rig, so an older positive record no longer decides. A power-zero record at or after the floor still decides impaired. The keeper mirrors row N in `d14585d` (RB4-08). The five tests of `OwnerEvidenceRegression.t.sol` pass from `7fce86e` on. With the old `_verdict` branches restored, its three safety regressions fail. The full Forge suite (unit, fork, invariant) is green at `4bac093`, whose `src/` is the final build's (`docs/redeploy-4/acceptance-v13.md`). The Part A2 final audit (AI, Claude Fable 5.2) re-read the fix and passed it. The keeper's final audit (AI, Claude Fable 5.2) failed RB4-08 in round 1, and its follow-up RB4-09 passed in round 4 with no finding. The owner approved the freeze in chat on 2026-11-14. The audited commit `ceed0a2` was never deployed.

### Low Severity

#### [L-01] Large share supply makes small mints revert

**Merge key:** `TapePool.maxMint:share-conversion-overflow`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. **Units:** pool-books. **Confirmed by:** AI triager through source tracing and cited tests. The owner approves the disposition; a human exploit-path rerun is not documented.

**Location:** [src/TapePool.sol:269](../../src/TapePool.sol). Source basis: pool-books/FINDINGS.md L-C1; CRITIC-1 L-C1; LEDGER C09/P02.

**Summary**

The pool computes maxMint from the whole remaining supply cap. Repeated losses and recapitalizations can make that conversion overflow. A caller cannot mint even one share although its individual conversion fits.

**Impact**

The mint path and its maximum view revert after nine demonstrated loss cycles. Deposit still works, and one raw BEM donation released after one second repairs the tested state. No additional principal loss or complete exit block was proved. The 1,000 BEM hard supply cap does not cap the number of shares.

**Severity basis:** Template section 4 Low: limited reach and an unlikely trigger. Repeated-pass promotion prevents discarding the issue merely because the history is severe.

**Exploit Path**

1. Borrowers complete nine loss and recapitalization cycles using real factory loans. The dead seed and backstop remain.
2. Share supply becomes 103019296356454950081780425431896511341288806181963447721196296385035 while accounted assets reach zero.
3. A user calls mint(1). The inherited entry check first converts the entire remaining cap and overflows.

**Prerequisites**

An extreme but code-reachable loss history; mocked eligible and impaired rigs. The test does not assign arbitrary share storage.

**Proof**

The following passing tests characterize the behaviour; they are not assertions of fixed behaviour. Low findings do not require failing regressions under the brief.

- [test_repeatedLossMaxMintOverflowWithoutBackstopExit()](2026-11-05-redeploy-4-prescan/runs/tests/pool-books/critic/AccountingCritic.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (characterization/control: PASS).
- [test_R1_repeatedLossMaxMintOverflowWithoutBackstopExit()](2026-11-05-redeploy-4-prescan/runs/tests/pool-books/review/Round1Review.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (characterization/control: PASS).

**Recommendation**

Saturate the maximum-share conversion when its mathematical result exceeds uint256, while retaining exact conversion checks for the requested mint. The owner accepts the present limited behaviour; no patch was made.

**Resolution**

Owner general answer: Acknowledged for the limited reach and unlikely loss history described in this row; the alternate deposit or withdraw path remains available.

#### [L-02] Idle conversion overflows before the holder balance clamp

**Merge key:** `TapePool.maxRedeem:eager-liquidity-conversion-overflow`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. **Units:** pool-books. **Confirmed by:** AI triager through source tracing and cited tests. The owner approves the disposition; a human exploit-path rerun is not documented.

**Location:** [src/TapePool.sol:279](../../src/TapePool.sol). Source basis: pool-books/FINDINGS.md C3-1; CRITIC-3 C3-1; LEDGER C07/P02.

**Summary**

The pool computes the share equivalent of all idle BEM before it caps maxRedeem to the holder balance. Large share supply makes this intermediate value overflow. Redeem fails even when a smaller asset withdrawal remains available.

**Impact**

The tested state has about 5.151e75 shares, 1.00000001 BEM accounted assets and 31.00000001 BEM idle funds. Redeem and even a zero-holder maximum revert; withdrawal of 1 BEM succeeds. The failure persists after one hour and clears by the tested one-day point as income releases. Hard asset caps do not bound share supply.

**Severity basis:** Template section 4 Low: a limited exit-path failure under an unlikely history. The same arithmetic pattern and repeated passes support promotion.

**Exploit Path**

1. Users reach the preceding loss history and make a genuine 1 BEM deposit.
2. A caller donates 30 BEM and syncs the pool.
3. A holder calls redeem. maxRedeem overflows in the idle conversion before applying the finite holder limit.

**Prerequisites**

The large-supply loss history plus unreleased income. Donation and sync need no role.

**Proof**

The following passing tests characterize the behaviour; they are not assertions of fixed behaviour. Low findings do not require failing regressions under the brief.

- [test_R3_largeSupplyIncomeBlocksRedeemButNotWithdraw()](2026-11-05-redeploy-4-prescan/runs/tests/pool-books/review/Round1Review.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (characterization/control: PASS).

**Recommendation**

Compare the holder claim with idle assets before converting all idle assets, or saturate the intermediate maximum. Preserve the vault-favouring rounding rules. The owner accepts the current behaviour.

**Resolution**

Owner general answer: Acknowledged for the limited reach and unlikely loss history described in this row; the alternate deposit or withdraw path remains available.

#### [L-03] Large replacement limits overflow before the pool clamp

**Merge key:** `TapeLens.principalFor:unbounded-debt-inversion`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. **Units:** lens-factory, system. **Confirmed by:** AI triager through source tracing and cited tests. The owner approves the disposition; a human exploit-path rerun is not documented.

**Location:** [src/TapeLens.sol:96](../../src/TapeLens.sol). Source basis: lens-factory LF-01; system L-03/CL-01.

**Summary**

The lens converts a policy debt limit to principal before it clamps the result to pool room. A valid replacement can return a limit large enough to overflow. Maximum quotes then fail although exact quotes and borrowing work.

**Impact**

The test borrows 4 BEM after a maximum quote panics. Both an unlimited debt limit and floor(uint256.max / 10000) + 1 reach arithmetic failures. The real principal hard cap remains 500 BEM. No asset transfer depends on this failing maximum view.

**Severity basis:** Template section 4 Low: a view failure with limited reach.

**Exploit Path**

1. The owner installs a higher-version replacement through the real seven-day queue.
2. A user asks for the maximum quote. The lens adds a fee or multiplies the limit by 10,000 before applying pool room.
3. The view reverts, while a representable exact quote and the corresponding borrow succeed.

**Prerequisites**

An unusual replacement with very large debt limits. The owner now limits the supported domain to reviewed replacements.

**Proof**

The following passing tests characterize the behaviour; they are not assertions of fixed behaviour. Low findings do not require failing regressions under the brief.

- [test_boundaryFiniteReplacementOverflowsMultiplicationBeforePoolRoom()](2026-11-05-redeploy-4-prescan/runs/tests/lens-factory/review/BoundaryReview.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (characterization/control: PASS).
- [test_leadUnlimitedReplacementRevertsMaxQuoteButExactQuoteAndBorrowWork()](2026-11-05-redeploy-4-prescan/runs/tests/lens-factory/review/BoundaryReview.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (characterization/control: PASS).

**Recommendation**

Bound debt inversion by executable pool room before arithmetic can overflow, or use checked saturating inversion. Review replacement-policy limits before activation, as the owner requires.

**Resolution**

Owner Q5: Acknowledged. Supported inputs use the v1 policy and the pool's own factory. Each replacement gets its own review before queuing. The lens is a view, the app uses the pool's own factory, and no transfer depends on its answers. Those app/review practices are owner attestations, not verified omitted code. SPEC section 16 will gain a row.

#### [L-04] Gapped policies hide executable smaller loans

**Merge key:** `TapeLens._size:gapped-policy-maximum`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. **Units:** lens-factory. **Confirmed by:** AI triager through source tracing and cited tests. The owner approves the disposition; a human exploit-path rerun is not documented.

**Location:** [src/TapeLens.sol:142](../../src/TapeLens.sol). Source basis: lens-factory LF-02, CR-C01; LEDGER R225.

**Summary**

The lens tests only the debt derived from the policy maximum and pool room. A replacement can allow smaller debts but deny that selected debt. The lens reports no loan although a smaller loan works.

**Impact**

With 4 BEM of pool room, the test policy permits debt up to 2 BEM or exactly 10 BEM. The lens returns DENIED and zero. Executable principal is 1.99501246 BEM for seven days or 1.99004975 BEM for fourteen days. Hard bounds allow up to 500 BEM of principal to be hidden by a wrong quote, but no cap is bypassed.

**Severity basis:** Template section 4 Low: a view misreports executable credit.

**Exploit Path**

1. The owner queues and activates a truthful replacement whose allowed debts contain a gap.
2. A user requests a maximum quote with room inside that gap.
3. The lens tests one denied point and returns zero; an exact smaller borrow succeeds.

**Prerequisites**

An unusual replacement without downward-closed allowed debts. The interface does not require that property.

**Proof**

The following passing tests characterize the behaviour; they are not assertions of fixed behaviour. Low findings do not require failing regressions under the brief.

- [test_round1TieredPolicyMissesExecutableMaximum()](2026-11-05-redeploy-4-prescan/runs/tests/lens-factory/review/Round1Review.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (characterization/control: PASS).
- [test_redoTieredBothTermsAndBothFactoriesCreate()](2026-11-05-redeploy-4-prescan/runs/tests/lens-factory/review/RecheckReview.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (characterization/control: PASS).

**Recommendation**

Specify and check the monotonic debt domain for supported replacements, or provide a bounded maximum query that accounts for executable debt and fee rounding. A ceiling argument alone need not resolve unreachable debt points.

**Resolution**

Owner Q5: Acknowledged. Supported inputs use the v1 policy and the pool's own factory. Each replacement gets its own review before queuing. The lens is a view, the app uses the pool's own factory, and no transfer depends on its answers. Those app/review practices are owner attestations, not verified omitted code. SPEC section 16 will gain a row.

#### [L-05] The gate accepts an incompatible reporter runtime

**Merge key:** `CheckStack.checkReporter:reporter-build-not-attested`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. **Units:** deploy. **Confirmed by:** AI triager through source tracing and cited tests. The owner approves the disposition; a human exploit-path rerun is not documented.

**Location:** [script/deploy/CheckStack.s.sol:111](../../script/deploy/CheckStack.s.sol). Source basis: deploy F02/C1/L1; CRITIC-1/3/4; CheckStack.s.sol:123–137.

**Summary**

The gate checks a locally normalized sample and asks the reporter to quote it. The sample cannot distinguish the incompatible reporter build. The full gate passes for that build in the reproduced fork fixture.

**Impact**

The incompatible runtime reports 384 H of base instead of 24 H for a multiplier-six sample, a factor of sixteen. The Low finding concerns a false deployment assurance result. No actual borrowing or lender loss from that runtime was established. Such an extension would require screened collateral, delivery, admitted borrowing and loss; principal remains bounded by 500 BEM and admission checks.

**Severity basis:** Template section 4 Low: limited assurance harm. Repeated passes and the passing full-gate reproduction support confidence 100.

**Exploit Path**

1. The test places the saved incompatible runtime at a fresh reporter address with otherwise valid locked pins.
2. The normal read-only gate passes on its multiplier-one sample.
3. A multiplier-six sample with 456 weight, 72 raw bonus and bstar 4 exposes the incompatible 384 H answer.

**Prerequisites**

Accidental use of the incompatible implementation. The full-gate test uses actual runtime execution and mocks only the discriminating sample's vault mapping. This is an assurance failure, not a proved unprivileged asset attack.

**Proof**

The following passing tests characterize the behaviour; they are not assertions of fixed behaviour. Low findings do not require failing regressions under the brief.

- [test_round1_C1_oldRuntimePassesGateButIndependentBuildCheckRejects()](2026-11-05-redeploy-4-prescan/runs/tests/deploy/review/Round1Gate.t.sol); [tests-gates-retry.txt](2026-11-05-redeploy-4-prescan/runs/tests-gates-retry.txt) (characterization/control: PASS).

**Recommendation**

Require runtime parity with the frozen build. The owner says the external runbook already does this on both chains, with immutables masked and metadata retained. This session did not inspect that runbook or verify its execution.

**Resolution**

Owner Q7: Acknowledged because the external runbook compares every new runtime with the frozen build on both chains, masks immutables and retains metadata. That runbook and its execution are outside the export and were not verified.

#### [L-06] Payment fragmentation shifts reserve dust into lender income

**Merge key:** `TapePool.repay:fragmented-reserve-rounding`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. **Units:** pool-loans. **Confirmed by:** AI triager through source tracing and cited tests. The owner approves the disposition; a human exploit-path rerun is not documented.

**Location:** [src/TapePool.sol:371](../../src/TapePool.sol). Source basis: pool-loans/CRITIC-3.md CR3-03; TapePool.sol:371–377.

**Summary**

The pool floors the reserve share separately for each fee payment. A payer can divide a fee into small payments that each allocate zero reserve. The same fee then sends more BEM to lender income.

**Impact**

One payment of 500 raw BEM units allocates 100 raw units to reserve. Across 125 payments of four raw units, reserve receives zero and income receives all 500. Debt and total backing remain unchanged. At the hard 50% reserve share, a 500 BEM loan with a 30 BEM initial fee has up to 15 BEM nominal reserve allocation. Diverting it all with one-unit payments requires three billion payments. Material extraction after gas costs was not established. Maximum late fees add 1.5 BEM daily on 500 BEM principal, with no lifetime bound.

**Severity basis:** Template section 4 Low: dust rounding with cumulative allocation effects, not debt forgiveness.

**Exploit Path**

1. A payer divides a fee into tiny admitted payments.
2. Each payment rounds its reserve share down.
3. Lenders receive the shifted income; a payer who also owns shares receives its share.

**Prerequisites**

Fragmented repayment and a positive stored reserve share. A payer needs shares to recover any shifted income personally.

**Proof**

The following passing tests characterize the behaviour; they are not assertions of fixed behaviour. Low findings do not require failing regressions under the brief.

- [test_critic3FragmentedFeeConservesValueWithoutForgivingDebt()](2026-11-05-redeploy-4-prescan/runs/tests/pool-loans/critic/PoolLoansCritic3.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (characterization/control: PASS).

**Recommendation**

The owner accepts per-payment flooring as dust and requires a new SPEC section 16 row. No code change is requested. An aggregate allocation rule would require a different accepted design.

**Resolution**

Owner Q4: Acknowledged. Per-payment flooring is accepted as dust; the cross-loan stored-cap order effect is also accepted. SPEC section 16 will gain separate rows. The latter remains an accepted risk, not another scored finding.

#### [L-07] The lens quotes clones that the pool rejects

**Merge key:** `TapeLens._blocker:foreign-factory-quote`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. **Units:** lens-factory. **Confirmed by:** AI triager through source tracing and cited tests. The owner approves the disposition; a human exploit-path rerun is not documented.

**Location:** [src/TapeLens.sol:160](../../src/TapeLens.sol). Source basis: lens-factory C-03; CRITIC-3 C3-C01.

**Summary**

The lens trusts an agent's pool and borrower fields without checking the pool's factory registry. A genuine clone from another factory passes the quote checks. The pool rejects its borrow with NotAgent.

**Impact**

The reproduced foreign clone receives an allowed 1 BEM quote and maximum quotes of 2.64075498 or 4 BEM. Both actual borrows revert and roll back. A quote could advertise up to the 500 BEM hard room, but cannot transfer it. Whether the omitted app permits this input was not established.

**Severity basis:** Template section 4 Low: view misreport without asset loss. Repeated-pass promotion applies.

**Exploit Path**

1. Any caller deploys the real factory with the same assets and existing pool.
2. Its clone owns valid collateral and requests a quote.
3. The lens permits the quote; pool.lend rejects the clone because it is absent from the authentic factory registry.

**Prerequisites**

A supplied agent from a foreign factory. The owner says the app uses only the pool's own factory.

**Proof**

The following passing tests characterize the behaviour; they are not assertions of fixed behaviour. Low findings do not require failing regressions under the brief.

- [test_critic3ForeignFactoryQuoteHasNoPoolAuthority()](2026-11-05-redeploy-4-prescan/runs/tests/lens-factory/critic/Critic3Review.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (characterization/control: PASS).

**Recommendation**

Authenticate the agent against the pool's factory before returning an executable quote, or enforce the supported input domain in the caller. The owner accepts the latter domain; the omitted app was not verified.

**Resolution**

Owner Q5: Acknowledged. Supported inputs use the v1 policy and the pool's own factory. Each replacement gets its own review before queuing. The lens is a view, the app uses the pool's own factory, and no transfer depends on its answers. Those app/review practices are owner attestations, not verified omitted code. SPEC section 16 will gain a row.

#### [L-08] Partial evaluator disagreement hides allowed debt

**Merge key:** `CreditPolicy.maxDebt:partial-evaluator-maximum`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 100

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. **Units:** policy. **Confirmed by:** AI triager through source tracing and cited tests. The owner approves the disposition; a human exploit-path rerun is not documented.

**Location:** [src/CreditPolicy.sol:116](../../src/CreditPolicy.sol). Source basis: policy/LEDGER.md A19; CRITIC-1/3 partial evaluator.

**Summary**

The policy checks its boundary bucket when it computes maxDebt. A mismatch there makes the result zero. The evaluator and mirror can still agree at a smaller debt that check permits.

**Impact**

The test returns zero maximum while check allows 1,100,000 raw BEM units of debt. This does not overadvance a loan. The live v1 evaluator agreed on all 4,096 tested vectors; the mismatch fixture models a changed or faulty evaluator. The hard 500 BEM principal limit remains.

**Severity basis:** Template section 4 Low: a conservative view misreports under limited conditions. Repeated passes promote the area.

**Exploit Path**

1. A changed evaluator disagrees with the mirror at the maximum bucket but agrees at a lower bucket.
2. A user asks for maxDebt and receives zero.
3. The lower debt passes check despite the zero maximum.

**Prerequisites**

Partial disagreement after an external evaluator change or fault. No current live disagreement was proved.

**Proof**

The following passing tests characterize the behaviour; they are not assertions of fixed behaviour. Low findings do not require failing regressions under the brief.

- [testReview_maxDebtConservativeAfterPartialEvaluatorDisagreement()](2026-11-05-redeploy-4-prescan/runs/tests/policy/review/PolicyReview.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (characterization/control: PASS).

**Recommendation**

Specify whether zero means no executable debt or only failure at the preferred boundary. Review changed evaluators before using their maximum quotes. The owner accepts the limited supported domain.

**Resolution**

Owner Q5: Acknowledged. Supported inputs use the v1 policy and the pool's own factory. Each replacement gets its own review before queuing. The lens is a view, the app uses the pool's own factory, and no transfer depends on its answers. Those app/review practices are owner attestations, not verified omitted code. SPEC section 16 will gain a row.

#### [L-09] Malformed replacement answers escape the lens catch

**Merge key:** `TapeLens._decision:malformed-replacement-abi`

**Severity:** Low · **Status:** Acknowledged · **Confidence:** 75

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. **Units:** lens-factory. **Confirmed by:** AI triager through source tracing and cited tests. The owner approves the disposition; a human exploit-path rerun is not documented.

**Location:** [src/TapeLens.sol:67](../../src/TapeLens.sol). Source basis: lens-factory C-02/N04; CRITIC-1/2/3.

**Summary**

The lens catches external call failures but cannot catch all caller-side ABI decoding failures. A replacement can return malformed successful data and make the quote revert. The review did not establish such a normal installed implementation.

**Impact**

The fixture proves view-only unavailability and inconsistent maximum answers for malformed policies. No token transfer occurs. Quoted principal is bounded by 500 BEM of hard room. The current v1 policy does not supply these malformed answers.

**Severity basis:** Template section 4 Low, confidence 75 under section 5's repeated-demotion promotion. The normal implementation trace remains unfinished.

**Exploit Path**

1. A hypothetical higher-version policy answers the activation probe canonically.
2. It later returns malformed successful data to a quote query.
3. Caller-side decoding reverts outside the try/catch. The fixture reaches this local behaviour; a normal installed policy with this behaviour remains unproved.

**Prerequisites**

An unusual replacement with inconsistent runtime ABI behaviour. The repeated-pass promotion is explicit; this is not a current live exploit claim.

**Proof**

The following passing tests characterize the behaviour; they are not assertions of fixed behaviour. Low findings do not require failing regressions under the brief.

- [test_completionInvalidPolicyAndFeedABIExplicitBoundary()](2026-11-05-redeploy-4-prescan/runs/tests/lens-factory/review/CompletionReview.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (characterization/control: PASS).

**Recommendation omitted:** template section 5 forbids a speculative recommendation while the promoted external trace remains unfinished.

**Resolution**

Owner Q5: Acknowledged. Supported inputs use the v1 policy and the pool's own factory. Each replacement gets its own review before queuing. The lens is a view, the app uses the pool's own factory, and no transfer depends on its answers. Those app/review practices are owner attestations, not verified omitted code. SPEC section 16 will gain a row.


### Below threshold

None. There are no findings below confidence 75.

### Invalid after the owner answer

#### [I-01] The specification omits the deliberate cutoff margin

**Merge key:** `DeployPool.emissionEnd:early-halving-cutoff`

**Severity:** Low (historical triage; excluded from valid counts) · **Status:** Invalid · **Confidence:** 100

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. **Units:** policy, feed, lens-factory, deploy, system. **Confirmed by:** AI triager through source tracing and cited tests. The owner approves the disposition; a human exploit-path rerun is not documented.

**Location:** [script/deploy/DeployPool.s.sol:59](../../script/deploy/DeployPool.s.sol). Source basis: policy L-01; feed L-01; lens-factory LF-03; deploy F01; system L-02.

**Summary**

The deployment sets the cutoff thirty days before the first halving. The exported specification calls the cutoff the first halving. The owner confirms that the earlier cutoff is deliberate.

**Impact**

The configured time is 1910726132; the observed first-halving calculation gives 1913318132, a difference of 2,592,000 seconds. This is the approved margin. The historical Low triage rating is retained for traceability and excluded from current finding totals.

**Severity basis:** Invalid for code after owner Q3. The cause is specification wording. The owner attests the omitted 2026-10-19 decision; no omitted document was fetched.

**Exploit Path**

1. A borrower requests a term that reaches the configured early cutoff.
2. The policy denies it as designed.
3. The exported wording makes that deliberate denial appear to violate the cutoff requirement.

**Prerequisites**

A future maturity near the configured cutoff.

**Proof**

The following passing tests characterize the behaviour; they are not assertions of fixed behaviour. Low findings do not require failing regressions under the brief.

- [test_round3NormativePinActualBorrowAndInclusiveHalvingBoundary()](2026-11-05-redeploy-4-prescan/runs/tests/lens-factory/review/Round3Review.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (characterization/control: PASS).
- [testReview_configuredHalvingMarginDeniesThirtyDaysEarly()](2026-11-05-redeploy-4-prescan/runs/tests/policy/review/PolicyReview.t.sol); [tests-initial.txt](2026-11-05-redeploy-4-prescan/runs/tests-initial.txt) (characterization/control: PASS).

**Recommendation**

Correct SPEC section 2 to say first halving minus 30 days. The work copy remains frozen.

**Resolution**

Owner Q3: the first-halving-minus-30-days margin was deliberate. The owner attests approval on 2026-10-19 in omitted decision O3. The cause is SPEC section 2 wording, not a code defect. That omitted document was not fetched or independently verified.


## Leads

- **CreditPolicy._rig:refbench-external-semantics**. The reviewer needs a real registered RefBench miner with active status, base power, custody and a matching screen pass. A complete trace of mandatory registration and default-multiplier authorization could also settle the gap. Current reads show a multiplier of zero and no miner in the bounded censuses. Mocks cannot establish mineability. Producer tests narrow the status-zero and stopped-miner cases. They do not cover every verifier, status or Safe authorization path. No unguarded credit path is established, so repeated mention does not meet the section 5 promotion rule. Conditional principal exposure cannot exceed 500 BEM total or 90% of assets at admission. Backstop and per-borrower caps further limit exposure. A false denial would instead hide eligible credit. Owner: no RefBench rig receives a screen pass until a rehearsal passes. The lead remains unscored. Source: policy L-03; agent-loan L-01; evidence outside limits.

- **RigAgent._voucherRecord:inactive-bridged-harvest**. The reviewer needs an actual inactive or revoked harvest through the source vault and endpoint. The trace must inspect power and pending payout, then continue through the actual destination endpoint, OFT and voucher. The agent-loan Round1Producer tests cover stopped public state and zero power. They do not settle every revoked transition or forfeiture claim. No exploit path is established. Incorrect positive health could restore at most 500 BEM of outstanding principal. Incorrect zero-power evidence could allow seizure of up to 16 collateral vouchers per agent. The code places no BEM-denominated cap on their external value. Some destination samples passed, but the complete relevant lifecycle remains unverified. Owner: retain the lead. Some destination samples passed, but the complete inactive/revoked source-to-destination path remains unproved. Source: agent-evidence V-01/E21; agent-loan L-01/Round1Producer; system D16-06.1.

- **TapePool.decimals:cached-asset-metadata-failure**. The reviewer needs an EVM-level failure or changed decimals answer from the pinned BEM during successful construction. The trace must then show harm to a client operation. An HTTP outage is not such a token failure. The cached decimal count is 18 + 6 = 24. It persists after the token read recovers. Successful answers of 250 or 255 make the display getter overflow when it adds the offset. A deposit of 1,000,000 raw BEM units still mints 1,000,000,000,000 raw share units. Redemption converts those shares back to 1,000,000 raw BEM units. No loss of raw units is proved. The hard supply and borrowing limits remain 1,000 BEM and 500 BEM. Both subset gates omit a display assertion. The review does not claim a full two-chain gate pass for these fixtures. Multiple passes corrected an external-read statement but did not establish a token failure reachable in normal operation. The section 5 promotion rule for an unguarded path therefore does not apply. Owner Q7: CheckStack will assert the share token decimals. This is planned, not implemented or tested here. The lead remains unscored. Source: deploy L2/C4-1; Round4Decimals.

- **CheckStack.readTapeOut:inactive-sample-rejects-gate**. The reviewer needs an otherwise valid complete launch with rig 5 in an actual inactive or zero-weight state. The trace must show that only the sample equality rejects the launch. That equality compares verifWeight minus bonus with bstar multiplied by mult. The current reader clamps base correctly, but the gate comparison does not. The potential effect is a blocked deployment gate until the sample or check changes. No direct BEM loss is established. Owner Q7: the sample will compare base with the smaller of verifWeight and bstar multiplied by mult. This check is planned, not implemented or tested here. The lead remains unscored. Source: deploy inactive sample observation.

## Accepted risks

These 27 roots retain their accepted-risk classification. Each row names the touched SPEC section 16 acceptance and whether the code stays inside it. Acknowledged findings remain findings above and are not counted again here. Pending specification changes are owner decisions, not edits already present at the audited code.

- **RigAgent._accrue:late-face-value** — SPEC §16: “PO-3, late fee 0 at launch”. The code stays inside this row. A slow loan is not impaired solely because it matures. The zero launch late rate provides no compensation. Later loans snapshot their late rates. 

- **TapePool.fee:minimum-fee-subsidy** — SPEC §16: “PO-4, `minFee` below one harvest’s cost”. The code stays inside this row. The code follows the accepted fee routing. Keeper funding and spending remain unverified off-chain obligations. 

- **RigReporter.push:unbounded-sponsored-loan-count** — SPEC §16: “Sponsorship subsidy”. The code stays inside this row. Reusable reports and borrower-funded pushes do not cap loan count. No keeper implementation is supplied to verify quotas or spending alerts. 

- **RigAgent.sweep:unharvested-safe-rescue-output** — SPEC §16: “The keeper harvests once at maturity”. The code stays inside this row. The code follows the trusted-Safe mechanism. The quoted 8 BEM and 4 BEM limits are launch caps. Hard principal exposure is 500 BEM. That limit does not cap the value of collateral or mining output. The keeper's early-harvest operation remains unverified. 

- **CreditPolicy._rig:screen-error-credit-loss** — SPEC §16: “`MIN_RIG_AGE` 3 days, with the Q16 screen (2026-10-21)”. The code stays inside this row. The age check measures calendar time. A screen error can lose admitted debt. Hard total principal is 500 BEM. The v1 debt limits are 85% and 80% of expected output for the two terms. The proof tool and evidence for the 12 historical revocations are not supplied. 

- **TapePool.markDoubtful:deposit-gate-liveness** — SPEC §16: “Deposit gate (§11.1)”. The code stays inside this row. Marks close positive entry until resolution. Overlapping impaired rigs can prolong the closure. The hard maximum for minAdvance is 1 BEM. The launch example of 0.01 BEM is therefore not a universal bound. 

- **RigAgent._verdict:stored-bu-block** — SPEC §16: “Stored impaired report blocks a clear (row B, redeploy 3)”. The code stays inside this row. Rows B and U retain the block, including their feed-off and stale-data cases. M-01 separately records the stale healthy overwrite that opens the block. 

- **RigAgent._report:dead-versus-unreadable-feed** — SPEC §16: “Dead feed with a flagged, rescued rig”. The code stays inside this row. A dead but readable feed retains rows B and U. A reverting feed leaves no report candidate. A marked rescued rig may keep deposits closed indefinitely. 

- **TapePool.maxWithdraw:unmarked-impairment-exit** — SPEC §16: “Rescue seen on BSC first”. The code stays inside this row. An existing holder can exit before a flag, including during a brake. Its claim and available idle funds bound the exit. The reserve does not bound total lender loss. 

- **RigAgent._impairment:stale-shield-and-brake-loss** — SPEC §16: “Feed re-enable pauses live flags”. The code stays inside this row. While the feed is on, a stale sane report under row S can shield older voucher evidence under row VE. A brake removes that shield. Seizure can then proceed if the post-cure voucher-evidence floor already holds. The separate claim of a pre-cure bypass remains rejected. 

- **TapePool.disableFeed:repeated-live-flag-freeze** — SPEC §16: “Feed re-enable pauses live flags”. The code stays inside this row. Repeated brakes can prolong live expiry and deposit closure. They do not extend cure time or revive an expired flag. 

- **RigAgent._verdict:bonus-only-positive-record** — SPEC §16: “Bonus in path (b) health”. The code stays inside this row. A newer positive voucher record can decide health when no rig is impaired. Row B and impairment ties still block the clear. Later flag and clear cycles are accepted. This row does not waive the older-record resurrection in M-01. 

- **TapePool._book:post-seize-income-sharing** — SPEC §16: “Income release after seize”. The code stays inside this row. Later entrants share later seized income over VEST. Early exits leave unreleased income. H-01 separately records the original bound error and the owner's corrected acceptance. 

- **TapePool.lendLimit:admission-only-backstop** — SPEC §16: “Backstop wait after a loss”. The code stays inside this row. The backstop rule governs admission. Losses and withdrawals can reduce cover later. Seed retention, alerts and later top-ups remain operational gaps. 

- **RigAgent.flagImpaired:rescued-rig-feed-off** — SPEC §16: “Rescued rig while the feed is off”. The code stays inside this row. The brake disables report evidence under row E. Rescued rigs cannot harvest voucher evidence under row VE. The owner reviews the cause and re-enables the feed when reporter data is trusted. The keeper then flags the rig using a fresh report. Rows B and U still block clears. 

- **RigFeedReceiver._lzReceive:verification-gap-lock** — SPEC §16: “Feed liveness after `lock` (Phase 3 part A, 2026-10-19)”. The code stays inside this row. Unordered application delivery does not bypass endpoint verification continuity. Zero owner and delegate addresses prevent skipping the verification gap. The full fork revalidation remains blocked in the writer's run. 

- **RigScreen.suspendPass:future-pass-presuspension** — SPEC §16: “Guardian pre-suspension (Phase 3 part A, 2026-10-19)”. The code stays inside this row. The guardian can pre-suspend an id. Only the owner can lift suspension or rotate the guardian. These actions move no asset and change no open loan. 

- **RigAgent._voucherRecord:future-record-becomes-evidence** — SPEC §16: “Future-dated voucher record (redeploy 3)”. The code stays inside this row. A record from a Safe upgrade becomes admissible within 60 seconds of its timestamp. The post-cure floor still applies. This row promises no additional freshness check. 

- **RigAgent.forwardVouchers:safe-returned-unlisted-voucher** — SPEC §16: “Seized voucher returned by the Safe (redeploy 3)”. The code stays inside this row. An unlisted seized id returned to a closed agent stays protected from borrower withdrawal. Only the external Safe can recover it. 

- **TapePool.activatePolicy:arbitrary-policy-within-caps** — SPEC §16: “A policy swap can approve loans up to the caps (§9.2, the owner’s decision of 2026-11-05)”. The code stays inside this row. The seven-day queue and borrowing pause still apply. Independent ownership checks, the 500 BEM and 90% hard limits, and the backstop remain. The v1 expected-output ceiling does not apply to every replacement. 

- **RigFeedReceiver._lzReceive:same-second-first-report** — SPEC §16: “Same-second reports (§6, the owner’s decision of 2026-11-04)”. The code stays inside this row. Strictly increasing timestamps retain the first report in a second. A push in a later second can correct it. Report health under row H expires after 300 seconds. 

- **RigAgent.clearExpiredFlag:older-other-rig-missing** — SPEC §16: “A report older than the floor on another rig (§10.5, the owner’s decision of 2026-11-04)”. The code stays inside this row. A pre-floor impaired report on another rig counts as missing. A clear can restore the whole loan. A holder can exit before a fresh flag becomes possible 60 seconds after the clear. 

- **TapePool.lendLimit:self-funded-ratio-exit** — SPEC §16: “Percentage ratios after a self-funded deposit (§11.3, the owner’s decision of 2026-11-04)”. The code stays inside this row. The ratios govern admission. At the 90% hard ratio, the maximum excess is 50 BEM when principal and remaining assets are each 500 BEM. The independent backstop limit still applies. 

- **TapePool.repay:stored-reserve-base** — SPEC §16: “Reserve base is stored at `lend`”. The code stays inside this row. Deposits before a loan widen its stored reserve base. Later deposits and withdrawals do not resize it. The frozen row does not cover fragmented reserve allocation; owner Q4 accepts that separately. 

- **CreditPolicy._rig:duplicate-circuit-after-safe-action** — SPEC §16: “Two vault ids for one circuit after `rescueFromCell`”. The code stays inside this row. The code follows the stated Safe dependency. Duplicate sizing or redemption under a loan can precede detection. Off-chain refusal, monitoring and the complete Safe authorization path were not audited here. 

- **RigAgent._verdict:positive-record-without-custody** — SPEC §16: “A positive voucher record means active with weight, not in custody”. The code stays inside this row. A Safe action and missed seize can let a newer positive record clear the flag. The relevant fork reproduction remains blocked, so this behaviour was not independently confirmed live. 

- **TapePool.repay:cross-loan-reserve-cap-order** — SPEC §16: “Reserve base is stored at `lend`”. The code stays inside this row. Each loan uses its stored cap against the current global reserve. The test loans have reserve bases of 10 BEM and 20 BEM. Each pays 3 BEM of fees. One order produces 1 BEM of reserve; the reverse order produces 0.6 BEM. Lender income differs by the offsetting 0.4 BEM. Neither order withdraws existing reserve. This effect is separate from per-payment rounding. Owner Q4 confirms acceptance and requires a separate section 16 row. Owner Q4: Acknowledged. Per-payment flooring is accepted as dust; the cross-loan stored-cap order effect is also accepted. SPEC section 16 will gain separate rows. The latter remains an accepted risk, not another scored finding.

## Rejected by triage

### Gate 1

- `TapePool.expiryOf:expired-flag-revival` — Gate 1: binary-search clock logic leaves already expired flags expired; later brakes cannot reset their evidence floor. Source: pool-admin C-03/C3-K1; agent-evidence C-01; system C-03.
- `RigAgent.forwardVouchers:permissionless-list-reconciliation` — Gate 1: only a closed agent forwards seized collateral to the immutable pool; no caller-controlled destination or borrower release exists. Source: agent-loan P-RepayEgress; system C-04/C-05.
- `RigAgent._moveCollateral:restore-kept-list-before-callbacks` — Gate 1: movement loops finish before retained ids are restored; closed/no-loan/empty-list/wasSeized effects precede callbacks. Source: agent-loan C3-E1/C3-E2; evidence movement candidates.
- `RigAgent.withdrawVoucher:seized-voucher-to-borrower` — Gate 1: The permanent wasSeized check precedes membership checks. Forwarding targets the pool, and factory.create binds msg.sender. This stack cannot create an agent whose borrower is the pool. Source: agent-loan destination-address hypothesis.
- `NetlistBuilder.leConst:out-of-width-constant` — Gate 1: A constant of 32 cannot fit in five bits and truncates. The production callers use only 16 or 17. All 4,096 v1 vectors agree. Source: policy M-WIDTH; CRITIC-1/3.
- `CreditPolicy._gather:zero-agent-owner-equality` — Gate 1: Real agents have nonzero addresses and independently verify voucher ownership before lending. The ownerOf answer must equal the agent address. A hypothetical zero-agent view cannot borrow. Source: policy CRITIC-3 C3-01.
- `TapePool.lendLimit:fractional-backstop-round-up` — Gate 1: floor conversion, independent backstop room and final lend recheck reject one raw above the fractional claim. Source: pool-loans CC-01; pool-admin K1.
- `TapePool._restore:double-release-on-seize` — Gate 1: partial restoration reduces absorbed once; write-off deletes the rest without booking it again. Source: pool-loans CR3-01.
- `TapePool._book:release-schedule-postponement` — Gate 1: absorb preserves the current end; restore uses the weighted remaining schedule. The hypothesized extra delay is absent. Source: pool-loans CC-02; pool-books critic restore candidates.
- `TapePool.repay:zero-assets-resolution-block` — Gate 1: repay, clear and write-off operate at zero assets; only new positive lending is denied. Source: pool-loans CC-03.
- `TapePool.lend:forwarded-income-reserve-base` — Gate 1: lend checkpoints new cash into equal idle and unvested amounts, so same-block net reserve base does not rise. Source: pool-loans CR3-02.
- `TapePool.maxRedeem:fractional-exit-round-up` — Gate 1: ordinary finite liquidity conversion floors shares and respects idle; distinct large-range overflow is retained above. Source: pool-loans CR3-04; pool-books floor controls.
- `TapePool._book:zero-duration-release` — Gate 1: a weighted average of positive remaining durations is at least one second; booking does not vest instantly. Source: system critic last-second hypothesis.
- `RigAgent._accrue:empty-checkpoint-compounding` — Gate 1: unchanged-principal checkpoints use cumulative ceiling minus lateBooked, not a new rounded fee each call. Source: system CRITIC-4 repeated empty checkpoints.
- `RigReporter.options:standalone-length-cast` — Gate 1: The standalone options helper narrows n before gas arithmetic. Both quote and push reject 17 ids. No sent packet bypasses the 16-id limit. Source: system CQ-02.
- `RigAgent.borrow:cross-agent-native-callback` — Gate 1: exact operating-fee callback is last, both principal records are settled, and another no-loan agent sends its own cash to its borrower. Source: system F5-E.
- `TapeLens._size:donation-checkpoint-quote-drift` — Gate 1: checkpoint adds equal idle and unvested income, preserving assets/room/quote at the same timestamp; quoted borrow succeeds. Source: lens-factory C3-C02.
- `RigAgent.loanOf:original-principal-view` — Gate 1: Original principal remains 100,000,000 raw BEM units while remaining principal falls to 50,000,000. The source field is correct. Source: lens-factory critic E2.
- `TapePool.stats:missing-nonzero-field-evidence` — Gate 1: strengthened nonzero fixtures confirm the six fields and cap changes; the source has no omitted field. Source: lens-factory critic E3.
- `TapeLens._blocker:reason-code-abi` — Gate 1: Independent numeric checks confirm reason values from 0 through 16. Earlier tests reused shared constants, which weakened those tests. This is not a code defect. Source: lens-factory critic E4.
- `TapePool._write:parameter-field-isolation` — Gate 1: Each of the 14 bounded keys writes only its own field. Queuing changes no live parameter value. Source: pool-admin K4.
- `TapePool.activatePolicy:malformed-answer-rollback` — Gate 1: A dirty Boolean, reason, bits field or short tuple makes activation revert. The queue, policy, tracked balance and unreleased income remain unchanged. Source: pool-admin C3-K4.
- `TapePool.cancelPolicy:stale-slot-execution` — Gate 1: expired activation reverts QueueLapsed; cancellation clears the slot and cannot shorten a new queue. Source: pool-admin C3-K3.
- `TapePool.setGuardian:former-role-authority` — Gate 1: authority is read dynamically; prior guardian/owner loses access and a queued policy prevents unpause in either order. Source: pool-admin K3.
- `TapePool.queuePolicy:announced-candidate-eta` — Gate 1: indexed candidate and eta equal the queued values; lowerCap cancellation and independent queue slots are correct. Source: pool-admin K5.
- `TapePool._checkpoint:admin-income-double-book` — Gate 1: surplus is booked exactly once, with no-share income in reserve; failed calls roll all checkpoint effects back. Source: pool-admin K2.
- `RigAgent._impairment:pre-cure-evidence-after-shield-loss` — Gate 1: A brake can remove the row S shield without removing the post-cure evidence floor. That floor is impairedAt plus 72 hours and 60 seconds. Evidence one second before the floor remains rejected. Source: pool-admin C3-K2.
- `RigAgent.flagImpaired:omitted-late-accrual` — Gate 1: source accrues before the funded waterfall and rounds up; earlier tests missed the discriminator, repaired tests pass. Source: agent-evidence CRITIC-1 L14/P25.
- `RigAgent.seize:omitted-late-accrual` — Gate 1: source accrues before NoDebt and loss settlement; funded test confirms remaining principal and reserve cover. Source: agent-evidence CRITIC-1 L45.
- `TapePool.fee:pending-backlog-waives-fee` — Gate 1: the fixed fee is stored and paid even with prefunded pending output and early repayment. Source: feed RC-01.
- `CreditPolicy._rig:missing-processor-alternative` — Gate 1: all three immutable processor alternatives set the eligibility bit independently; actual RefBench mineability remains a separate lead. Source: feed RC-02; lens-factory E1.
- `RigAgent._plusSkew:evidence-floor-wrap` — Gate 1: actual enable/seize/evidence floors saturate at uint64.max, including the no-flag sentinel. Source: feed RC-03.
- `RigAgent.borrow:permissive-policy-ownership-bypass` — Gate 1: nonempty collateral and ownership checks run independently of the replacement policy before factory-gated lend. Source: feed RC-04; system rogue-policy tests.
- `TapePool.lend:feed-off-borrow` — Gate 1: The agent and pool independently reject borrowing while the feed is disabled. Pool room is zero and the blocker code is 5. Clearing the pause does not bypass the feed brake. Source: feed RC-05.
- `RigReporter.setPeer:rotation-ignored` — Gate 1: before lock, last distinct peer wins; after lock, updates reject; receiver authenticates the current peer. Source: feed RC-06 reporter.
- `RigFeedReceiver.setPeer:rotation-ignored` — Gate 1: receiver applies last distinct peer before lock and denies unauthorized old peers. Source: feed RC-06 receiver.
- `RigFeedReceiver.lock:old-library-timeout` — Gate 1: setReceiveLibrary clears the prior timeout when its grace argument is zero. Locking removes the delegate. The targeted rerun confirms timeout removal and rejects restoration. Source: feed CRITIC-3 C3-03; FeedLock and pinned dependency trace.
- `BscRigReader.read:ignored-miner-metadata` — Gate 1: The ignored metadata does not enter loan inputs. Typed decoding still rejects 13 malformed narrow words. No used field is shown to be wrong. Source: feed ignored Miner/Context candidates.
- `BscRigReader.read:raw-bonus-normalization` — Gate 1: The reader subtracts the smaller of weight and bstar multiplied by mult from weight to calculate bonus. The sample weight of 456 yields 432 normalized bonus and 24 base. L-05 separately records the incompatible-build gate result. Source: feed bonus controls; deploy F02 distinction.
- `CheckStack.readTapeOut:expect-call-not-enforced` — Gate 1: vm.expectCall is enforced when forge script ends; an internal return before that failure is not a passed gate. Source: deploy expected-call hypothesis/GateDryRun.s.sol.
- `CheckStack.checkOnForks:historical-helper-bypass` — Gate 1: the full gate rejects four retired feed identities; checkPool is a subset and checkReusedFeed is not called by the production entry. Source: deploy historical/subset candidates.
- `CheckOldStack.run:arbitrary-range-census` — Gate 1: production run pins the third stack/start block; arbitrary helper inputs are not its call path. Current full census could not reread RPC pages. Source: deploy incomplete old-factory scan candidate.
- `FeedConfig.mirror:setup-order-confirmations` — Gate 1: The deployment entry points mirror and lock before sending. Sending first produces the tested difference between 21 and 20 confirmations. That sequence lies outside these entry points and does not establish a hidden live downgrade. Source: deploy mirror/send/NIL candidate.
- `RigReporter.push:batch-read-error-suppression` — Gate 1: Batches with 16 or 15 readable rigs each produce one packet. A batch with no readable rig produces none. Unrelated errors propagate, and batch-size guards remain. Source: deploy batching/read-error candidate.
- `CreditPolicy.constructor:divide-before-multiply` — Gate 1: NETLIST_RET rounds byte length up to a 32-byte ABI word. Division before multiplication supplies the required padding. It does not lose economic precision. Source: src/CreditPolicy.sol:19.
- `TapePool._book:incorrect-equality` — Gate 1: Zero receipt/zero residual/zero supply select no-op or reserve/vesting branches; nonzero surplus cannot evade balance-based checkpointing. Source: src/TapePool.sol:796.
- `RigAgent.seizeEvidenceFrom:incorrect-equality` — Gate 1: the zero flag sentinel returns uint64.max; actual flags use the post-cure floor. Source: src/RigAgent.sol:600.
- `TapePool.lend:incorrect-equality` — Gate 1: The equality compares an explicit sentinel or enum and does not authorize value movement. Source: src/TapePool.sol:325.
- `TapePool.stats:incorrect-equality` — Gate 1: The zero-gross check prevents division by zero. Otherwise utilization divides outstanding principal by the sum of idle assets and outstanding principal. Source: src/TapePool.sol:470.
- `TapePool._sync:incorrect-equality` — Gate 1: A zero surplus leaves nothing to book. The pool books a positive surplus exactly once. Source: src/TapePool.sol:788.
- `RigAgent.seize:incorrect-equality` — Gate 1: Equality between prin and remaining principal detects fully funded debt. The agent rejects seizure in that case; it does not unlock assets. Source: src/RigAgent.sol:437.
- `RigAgent.flagEvidenceFrom:incorrect-equality` — Gate 1: the zero prior-clear/expiry sentinel selects the initial floor; subsequent floors include skew. Source: src/RigAgent.sol:593.
- `TapePool.unvestedNow:incorrect-equality` — Gate 1: zero residual/end selects a fully vested schedule; elapsed-time arithmetic handles positive income. Source: src/TapePool.sol:783.
- `TapePool.fee:uninitialized-local` — Gate 1: bps is assigned by both valid term branches; the invalid branch reverts BadTerm before it is read. Source: src/TapePool.sol:294.
- `TapePool._frozenUntil:uninitialized-local` — Gate 1: lo starts at zero as the lower binary-search bound. No stale memory is read. Source: src/TapePool.sol:847.
- `RigAgent._verdict:uninitialized-local` — Gate 1: reported defaults to false until a report qualifies under row H, B or U. The local variable at defaults to zero. Its uses depend on reported or defined short-circuit conditions. M-01 covers the unsafe evidence semantics, not uninitialized storage. Source: src/RigAgent.sol:664.
- `TapePool.expiryOf:uninitialized-local` — Gate 1: lo defaults to zero as the lower binary-search bound. Source: src/TapePool.sol:861.
- `RigAgent._impairment:uninitialized-local` — Gate 1: healthyAt defaults to zero, which means no shield. Admissible dated records deliberately compare against that value. Source: src/RigAgent.sol:633.
- `RigAgent.seize:uninitialized-local` — Gate 1: evidence starts false, is set by qualified collateral evidence, and otherwise causes NoEvidence; it is fail-closed. Source: src/RigAgent.sol:437.
- `TapeLens._decision:unused-return` — Gate 1: the lens uses allowed/reason/expected from the policy; ignored encoded diagnostic bits are not a missing loan guard. Source: src/TapeLens.sol:67.
- `RigAgent.borrow:unused-return` — Gate 1: borrow uses allowed and reason, then independently enforces ownership/term/caps; unused diagnostic bits and expected output are not authoritative after an accepted policy swap. Source: src/RigAgent.sol:276.
- `TapePool._checkPolicy:unused-return` — Gate 1: the activation probe checks a canonical typed response; ignored diagnostics do not bypass code/version checks, timelock or remaining loan guards. Source: src/TapePool.sol:920.
- `RigFeedReceiver.lock:unused-return` — Gate 1: The receiver pins its explicit library and validates the mirrored configuration. The BEM reference default flag does not permit a mutable receiver default. Source: src/feed/RigFeedReceiver.sol:83.
- `PolicyV1.build:unused-return` — Gate 1: build mutates the netlist by appending the final output record; it intentionally need not use the returned signal index. Source: src/libraries/PolicyV1.sol:29.
- `TapeLens._size:unused-return` — Gate 1: the room amount bounds sizing; ignoring its diagnostic binding code in _size cannot enlarge that amount. Source: src/TapeLens.sol:142.
- `RigAgent.initialize:missing-zero-check` — Gate 1: initialize accepts only its immutable factory, whose create passes msg.sender as borrower; the implementation is already closed. Zero borrower is not a reachable factory input. Source: src/RigAgent.sol:186.
- `TapeLens.principalFor:calls-loop` — Gate 1: The function calculates principal from the debt limit and fee rate, then checks the rounded-up fee. Representable valid inputs need at most a rounding correction. The fee calculation is a bounded pure call. L-03 separately covers arithmetic failure for large inputs. Source: src/TapeLens.sol:96.
- `CreditPolicy._report:calls-loop` — Gate 1: The policy reads at most 16 collateral reports from the fixed typed receiver. This is bounded view work, not a reentrant mutation. Source: src/CreditPolicy.sol:294.
- `TapeLens._pending:calls-loop` — Gate 1: At most 16 uint128 pending values sum to less than two to the power of 132. Fixed typed receiver calls cannot trigger an unbounded state change. Source: src/TapeLens.sol:189.
- `RigAgent.borrow:calls-loop` — Gate 1: The agent makes at most 16 ownership reads, each capped at 100,000 gas. It verifies ownership before borrowing, and the reentrancy guard remains active. Source: src/RigAgent.sol:276.
- `RigAgent._report:calls-loop` — Gate 1: _verdict reads at most 16 reports from the fixed feed. No unbounded user loop or mutable callback is established. Source: src/RigAgent.sol:687.
- `AgentFactory.create:reentrancy-events` — Gate 1: a newly cloned initialize only binds borrower/index and performs no untrusted interaction before AgentCreated. Source: src/AgentFactory.sol:48.
- `RigAgent._fresh:timestamp` — Gate 1: Tests cover the intended 300-second lifetime and 60-second skew, at equality and one second beyond. No alternate clock bypass is identified. Source: src/RigAgent.sol:749.
- `TapeLens._blocker:timestamp` — Gate 1: The 360-second wait after feed re-enable mirrors pool.lend. A quote cannot bypass the final pool check. Source: src/TapeLens.sol:160.
- `TapePool._sync:timestamp` — Gate 1: Time only checkpoints vested income; zero-surplus handling cannot create cash. Source: src/TapePool.sol:788.
- `TapePool._book:timestamp` — Gate 1: The weighted positive release duration cannot exceed VEST. Rounding cannot release income in the same block. Source: src/TapePool.sol:796.
- `TapePool.disableFeed:timestamp` — Gate 1: The new interval records current time once; repeated disable rejects and cannot erase prior history. Source: src/TapePool.sol:545.
- `RigAgent.seize:timestamp` — Gate 1: Cure lasts 72 hours of wall time. The current expiry and evidence floors limit seizure. Source: src/RigAgent.sol:437.
- `TapePool.stats:timestamp` — Gate 1: The queue view includes the expiry endpoint seven days after eta. It grants no execution privilege. Source: src/TapePool.sol:470.
- `TapePool._feedSettling:timestamp` — Gate 1: Borrowing waits 360 seconds after feed enable. New borrowers cannot control the recorded enable timestamp. Source: src/TapePool.sol:894.
- `RigAgent._lateSince:timestamp` — Gate 1: Late duration starts at the later of maturity and last accrual interval; stored rate/principal bound the formula. Source: src/RigAgent.sol:533.
- `TapePool.lend:timestamp` — Gate 1: Time is an intentional bounded protocol clock; no caller-controlled timestamp bypass was established. Source: src/TapePool.sol:325.
- `RigAgent.flagEvidenceFrom:timestamp` — Gate 1: Evidence floor uses clear/old-expiry+skew with saturation, rather than an attacker-supplied time. Source: src/RigAgent.sol:593.
- `CreditPolicy.constructor:timestamp` — Gate 1: The policy constructor requires a future emission horizon. The approved cutoff is the first halving minus 30 days. I-01 is a historical Invalid code claim caused by SPEC wording. Source: src/CreditPolicy.sol:73.
- `RigAgent.seizeEvidenceFrom:timestamp` — Gate 1: The post-cure floor includes the intended clock skew. Without a flag, the function returns the maximum uint64 value. Source: src/RigAgent.sol:600.
- `RigFeedReceiver._lzReceive:timestamp` — Gate 1: Authenticated reports reject excess future skew and only strictly newer timestamps replace storage; same-second risk is separately accepted. Source: src/feed/RigFeedReceiver.sol:59.
- `TapePool.unvestedNow:timestamp` — Gate 1: The function returns zero at or after vestEnd. Before that time, bounded linear decay does not spend unavailable cash. Source: src/TapePool.sol:783.
- `RigAgent._expired:timestamp` — Gate 1: Already expired flags remain expired and live flags use the pool freeze clock, not report timestamps. Source: src/RigAgent.sol:588.
- `TapePool.activatePolicy:timestamp` — Gate 1: Only queued candidates activate in the public eta/grace interval after renewed code/version checks. Source: src/TapePool.sol:666.
- `RigAgent.flagImpaired:timestamp` — Gate 1: Existing live flags cannot reset cure; replacements require evidence past the prior expiry/clear floor. Source: src/RigAgent.sol:385.
- `TapePool.policySwapQueued:timestamp` — Gate 1: The view reports a live queue through the inclusive grace endpoint; lapse does not permit early activation. Source: src/TapePool.sol:465.
- `RigAgent._voucherRecord:timestamp` — Gate 1: Future record skew is checked against now; becoming admissible later is explicitly accepted under the Safe-upgrade row. Source: src/RigAgent.sol:700.
- `CreditPolicy._gather:timestamp` — Gate 1: Maturity must precede the configured cutoff. The terms remain seven or fourteen days. The approved cutoff is the first halving minus 30 days. I-01 is a historical Invalid code claim caused by SPEC wording. Source: src/CreditPolicy.sol:134.
- `TapePool.queueParam:timestamp` — Gate 1: Authority and hard-bound checks precede a fresh 48-hour delay. The caller cannot choose the timestamp. Source: src/TapePool.sol:610.
- `TapePool.executeParam:timestamp` — Gate 1: Execution accepts only the stored value from eta through seven days after eta, including both endpoints. It rechecks the hard bounds. Source: src/TapePool.sol:626.
- `RigAgent._accrue:timestamp` — Gate 1: Simple late fee uses stored rate, remaining principal and elapsed interval, subtracting lateBooked to avoid repeated ceiling charges. Source: src/RigAgent.sol:524.
- `TapePool._lapsePolicyIfStale:timestamp` — Gate 1: Time is an intentional bounded protocol clock; no caller-controlled timestamp bypass was established. Source: src/TapePool.sol:909.
- `TapePool.maxDeposit:timestamp` — Gate 1: Doubt and supply-room checks use checkpoint-consistent assets; no time-only entry bypass is shown. Source: src/TapePool.sol:262.
- `TapePool.expiryOf:timestamp` — Gate 1: Binary search sums frozen intervals, preserves expired flags and saturates the uint64 result. Source: src/TapePool.sol:861.
- `CreditPolicy._rig:timestamp` — Gate 1: Age/freshness/skew and sane-weight checks are intentional admission requirements. Source: src/CreditPolicy.sol:155.
- `TapePool._sub:timestamp` — Gate 1: Saturating subtraction prevents underflow when computing paused-clock intervals. Source: src/TapePool.sol:880.
- `RigAgent._base:timestamp` — Gate 1: Report id and upper skew bound are checked before role classification. Source: src/RigAgent.sol:744.
- `RigAgent.hasLoan:timestamp` — Gate 1: Remaining principal/fee/elapsed late fee are evaluated consistently; maturity alone does not close a loan. Source: src/RigAgent.sol:517.
- `RigAgent._verdict:timestamp` — Gate 1: Timestamps select qualified H/B/U/VC and impairment wins ties; the discarded-report semantic finding is separately retained. Source: src/RigAgent.sol:664.
- `RigAgent._impairment:timestamp` — Gate 1: Only qualified E/VE can trigger flag/seize; stale S shielding and brake loss are explicit accepted risks. Source: src/RigAgent.sol:633.
- `TapePool._frozenUntil:timestamp` — Gate 1: Binary search uses monotone stored intervals, not user-supplied history. Source: src/TapePool.sol:847.
- `TapePool.repay:timestamp` — Gate 1: Accrual/checkpoint time does not alter stored reserve base/share/cap; amount and debt effects remain guarded. Source: src/TapePool.sol:352.
- `TapePool.writeOff:timestamp` — Gate 1: Factory-agent-only write-off uses stored principal/mark and min reserve cover; no timestamp grants caller access. Source: src/TapePool.sol:410.
- `TapePool.lendLimit:timestamp` — Gate 1: Pause/feed/settle and queued-swap checks close admission; lend repeats the checks. Source: src/TapePool.sol:436.
- `RigScreen.isEffective:timestamp` — Gate 1: The check requires an exact tuple, a pass that has matured for 48 hours, and no suspension. Source: src/RigScreen.sol:121.
- `BscRigReader._owns:assembly` — Gate 1: The capped staticcall requires success, at least 32 return bytes and a canonical address width before the reader uses custody. Source: src/feed/BscRigReader.sol:46.
- `CreditPolicy._voucherMatches:assembly` — Gate 1: capped read copies bounded words and validates tuple identity; short/reverting answers clear eligibility. Source: src/CreditPolicy.sol:255.
- `RigAgent._voucherRecord:assembly` — Gate 1: The capped read copies four words, requires 128 bytes and checks future skew. The record remains unknown if those checks fail. Source: src/RigAgent.sol:700.
- `CreditPolicy._eval:assembly` — Gate 1: bounded staticcall accepts exactly canonical Boolean output and requires agreement with the local mirror. Source: src/CreditPolicy.sol:236.
- `CreditPolicy._pinsOk:assembly` — Gate 1: pin reads use bounded return copying and compare canonical lengths/values/netlist hash; assembly does not waive the checks. Source: src/CreditPolicy.sol:197.
- `RigAgent._tryMove:assembly` — Gate 1: a token return is not trusted as movement proof; post-transfer canonical ownership determines moved versus kept, with a gas cap. Source: src/RigAgent.sol:827.
- `RigAgent._moveCollateral:assembly` — Gate 1: The result arrays shrink only to their counted lengths. Those lengths cannot exceed the allocated collateral length of at most 16. Source: src/RigAgent.sol:799.
- `TapeLens._owns:assembly` — Gate 1: ownerOf is a capped staticcall; success/length/canonical address checks precede the equality. Source: src/TapeLens.sol:176.
- `RigAgent._ownerOf:assembly` — Gate 1: ownerOf requires success/32 bytes/nonzero/canonical width; dirty, missing and short replies are unknown. Source: src/RigAgent.sol:728.
- `CreditPolicy._screened:assembly` — Gate 1: The bounded screen read requires the canonical true word, 1. Other data fail closed. Source: src/CreditPolicy.sol:283.
- `TapePool._withdraw:dead-code` — Gate 1: inherited ERC4626 withdraw/redeem call the override; Slither’s dead-code label misses inherited dispatch. Source: src/TapePool.sol:766.
- `TapePool._deposit:dead-code` — Gate 1: inherited ERC4626 deposit/mint call the override; the hook is reachable, not dead code. Source: src/TapePool.sol:759.
- `TapePool.owner:interface-implementation` — Gate 1: TapePool.owner explicitly overrides Ownable and ITapePool at source line 315. Deployment and role tests exercise it. Source: src/interfaces/ITapePool.sol:65.

### Gate 2

- `TapePool.writeOff:unmarked-agent-impersonation` — Gate 2: the synthetic unmarked write-off impersonates an agent; real clones reach writeOff only through guarded, flagged seize. Source: pool-books rejected test-generated path; CRITIC-1.
- `RigAgent._forward:short-token-success` — Gate 2: A synthetic no-op token returns 31 bytes and temporarily leaves 100 raw BEM units. The pinned canonical BEM cannot produce this response. A later claim recovers the fixture balance. Source: agent-loan R1-TOKEN.
- `CreditPolicy._report:successful-malformed-feed-abi` — Gate 2: Caller-side decoding of short data escapes the catch. The immutable typed receiver always encodes its 480-byte tuple. No malformed producer path exists. Source: policy A01/E03/R11.
- `RigAgent._report:successful-malformed-feed-abi` — Gate 2: same hypothetical decode boundary, but the fixed typed feed cannot return a successful one-byte report. Source: feed consumer boundary; RigAgent.sol:694.
- `TapeLens._pending:successful-malformed-feed-abi` — Gate 2: the current immutable typed receiver has no path to short successful returndata; synthetically replacing it does not establish an executable production state. Source: lens-factory C-02/N04 feed component.
- `CreditMath.bucket:full-width-numerator` — Gate 2: The helper counterexample needs expected near uint256.max. Production uses sane uint64 reports, at most 16 rigs and terms of at most 14 days. These bounds limit expected to 155,929,790,016,000 raw BEM units. Source: policy C-01/R1-WIDE/C13.
- `TapePool._feedSettling:epoch-and-uint64-horizon` — Gate 2: The first 360 Unix seconds and the uint64 timestamp limit lie outside the current lifetimes of these chains. Saturating expiry does not wrap. Source: pool-admin CRITIC-3 domain probes.
- `FeedProbe.setupReceiver:prototype-order-and-owner` — Gate 2: separate legacy spike contracts are not the production feed; repeated setup can mismatch peers, but production CheckFeed rejects retained owner. Source: deploy legacy/prototype setup candidates.
- `FeedProbe.status:prototype-arithmetic` — Gate 2: prototype raw-bonus/future-time diagnostic panics have no production deployment path; production status saturates. Source: deploy prototype raw bonus/future timestamp.

### Gate 3

- `TapePool.executeParam:early-calendar-late-rate` — Gate 3: owner must queue against its dated promise; old loans keep snapshots and new borrowers bound maxLate. No outsider amplifier is shown. Source: pool-loans C-02; pool-admin C-01/4.4.PO3; agent-loan C-02.
- `RigReporter.lock:already-pinned-library` — Gate 3: Authorized setup can unpin the library, then lock after SameValue. No outsider bypass or permanent loss is established. The targeted reporter and receiver recovery retry passed at BSC block 131934929 and X Layer block 75126506. Earlier failed attempts remain historical failures. This result does not establish a complete fork campaign. See [the passing targeted retry](2026-11-05-redeploy-4-prescan/runs/tests-gates-retry.txt) for test_round1AlreadyPinnedSameLibraryDataRecoveryAndBothOrders(). Source: feed critic pre-pinned candidate.
- `RigFeedReceiver.lock:already-pinned-library` — Gate 3: same recoverable pre-lock configuration issue; authority is not silently dropped before the revert. Source: feed critic pre-pinned candidate.

### Gate 4

- `TapePool._deposit:pull-before-effects` — Gate 4: the observer sees old supply/tracked during the inbound pull, but guarded mutations reject and no live token hook or unpaid shares are demonstrated. Source: pool-books C-01/I10/P11; system C-01.
- `TapePool.repay:pull-before-cash-tracking` — Gate 4: principal effects precede the pull; tracked follows it. Hookless pinned BEM, nonReentrant and rollback prevent the alleged backing loss. Source: pool-loans C-01/11.2-17/15-10/A8-15.
- `RigAgent.repay:pull-before-debt-effects` — Gate 4: old agent debt is observable during payer pull, but the immutable token has no demonstrated hook exploit and no victim loses assets. Source: agent-loan C-01/I10/P-Order; system C-01.
- `TapePool.maxDeposit:zero-entry-during-doubt` — Gate 4: zero deposit/mint changes zero BEM and zero shares; positive requests revert. Literal §15.15 conflict remains. Source: pool-books C-02/A44/I15; system I15.1.
- `TapePool.maxDeposit:zero-assets-supply-cap-wording` — Gate 4: zero assets still permit paid recapitalization while borrowing room is zero; no cap bypass or unbacked mint follows. Source: pool-books C-03/C05.
- `RigAgent.seize:closed-loan-error-selector` — Gate 4: funded open loan returns NoDebt, deleted loan NoLoan; both prohibit seizure and move no voucher. Source: agent-evidence C-02/P11; system C-06.
- `RigAgent.withdrawVoucher:unknown-owner-forgets-entry` — Gate 4: borrower-only, no-loan withdrawal drops an unreadable entry but does not transfer it elsewhere; register/withdraw recovers it once reads work. Source: agent-loan CL-01; system F5-D.
- `RigAgent._add:full-list-duplicate-return` — Gate 4: An already listed id can return to a full list. The list stays at 16 entries. No loan, cap or ownership limit is bypassed. Source: agent-loan L-02/10.2-05/10.2-07.
- `RigAgent._accrue:tiny-principal-late-rounding` — Gate 4: Ten voluntarily paid intervals charge 40 raw units, versus 35 without principal reductions. Only the payer pays extra dust. No unpaid debt compounds. Source: agent-loan C3-R.
- `CreditPolicy._rig:nominal-emission-dust` — Gate 4: The whole-day emission approximation differs by 28,512 raw BEM units per network day. The relative difference is about 0.00000004. No material loss or amplification beyond the 85% and 80% margins is shown. Source: policy L-02; lens dependency observation.
- `TapePool.lendLimit:ratio-excess-equality` — Gate 4: Excess equals outstanding principal minus the rounded-down asset allowance, with negative results set to zero. At 550 BEM of assets, 500 BEM lent and a 90% ratio, the excess is 5 BEM. The earlier 55 BEM claim is incorrect. Source: system CQ-01/Q35.
- `CreditPolicy._decide:omitted-external-call-in-ledger` — Gate 4: this was a review-table omission; source calls the capped external evaluator and requires mirror agreement. Source: system F5-G.
- `TapePool._checkPolicy:version-read-order` — Gate 4: observed current.version then candidate.version changes only error precedence; there is no admission bypass. Source: pool-admin K6.
- `CheckStack.checkPool:pre-seed-donation` — Gate 4: with no shares, synchronized donations become reserve; zero idle/supply with positive tracked/reserve is valid and no caller can withdraw it. Source: deploy pre-seed candidate.
- `CheckStack.checkPoolSeeded:negligible-backstop-seed` — Gate 4: Construction requires a nonzero backstop address. Lending later enforces the backstop's actual claim. Deployment prose describes approximately 10 BEM; it does not impose an exact hard minimum. Source: deploy seed-boundary/cover-drift candidate.
- `TapePool.lendLimit:sybil-borrower-cap` — Gate 4: Separate addresses have separate limits. The global 500 BEM limit, 90% ratio and backstop limit still apply. The code promises no limit per human identity. Contrary to the lens unit's claim, SPEC section 16 has no separate acceptance row for this address-splitting risk. Source: lens-factory accepted boundaries; SPEC11.3.

### Template exclusion / safe pattern

- `TapePool.queueParam:lapsed-overwrite-event` — §5 do-not-report: lapsed requeue emits ParamLapsed instead of ParamCancelled; state, ETA and authority remain correct. Source: pool-admin C-02/12.06.
- `TapePool.writeOff:reserve-release-at-winddown` — §5 safe pattern: the reserve is locked by design, and SPEC §16 defers releasing it. No unauthorized reserve-release path is established. Source: pool-loans accepted behavior; template5.
- `RigAgent.initialize:events-access` — §5 do-not-report: an initialization event suggestion has no unauthorized state change or asset effect. Source: src/RigAgent.sol:186.
- `TapePool._write:cyclomatic-complexity` — §5 do-not-report: cyclomatic complexity is not an exploit; each parameter key has independent bounds and authority/queue controls. Source: src/TapePool.sol:935.
- `RigAgent.borrow:cyclomatic-complexity` — §5 do-not-report: complexity alone does not establish a bypass of borrow guards. Source: src/RigAgent.sol:276.
- `ITapeOutTransistors.NAND:naming-convention` — §5 do-not-report: interface spelling/naming is not an exploit. Source: src/interfaces/IXLayer.sol:107.
- `ITapeOutCircuits.TAPEOUT_FEE:naming-convention` — §5 do-not-report: interface spelling/naming is not an exploit. Source: src/interfaces/IXLayer.sol:121.
- `IPodMining.HALVING_PERIOD:naming-convention` — §5 do-not-report: interface spelling/naming is not an exploit. Source: src/interfaces/IBsc.sol:50.
- `ITapeOutTransistors.LATCH:naming-convention` — §5 do-not-report: interface spelling/naming is not an exploit. Source: src/interfaces/IXLayer.sol:108.
- `ITapePool.FEED_SETTLE:naming-convention` — §5 do-not-report: interface spelling/naming is not an exploit. Source: src/interfaces/ITapePool.sol:17.
- `TapeLens._owns:too-many-digits` — §5 do-not-report:100000 is an intentional owner-read gas budget; formatting its digits has no security effect. Source: src/TapeLens.sol:176.
- `RigReporter.lock:unindexed-event-address` — §5 do-not-report: unindexed Locked event parameters affect log filtering, not lock authorization. Source: src/feed/RigReporter.sol:31.
- `RigFeedReceiver.lock:unindexed-event-address` — §5 do-not-report: unindexed Locked event parameters affect log filtering, not lock authorization. Source: src/feed/RigFeedReceiver.sol:27.

**Owner Q6:** zero late rate until 2026-12-07 is an operational commitment, not a calendar guard. The owner accepts the existing withdrawal, inbound-transfer order, zero-entry, cap and evidence exceptions listed in Q6. The original rejected/accepted decisions remain; the SPEC and template wording was aligned on 2026-11-13 (`docs/SPEC.md` §17). This answer does not convert every literal conflict into verified conformance.

## Supporting reports and evidence

- [Round 1: ten units](2026-11-05-redeploy-4-prescan/round-1.md)
- [Round 2: Slither](2026-11-05-redeploy-4-prescan/round-2.md)
- [Round 3: earlier plain review](2026-11-05-redeploy-4-prescan/round-3.md)
- [Owner decisions for every merged root](2026-11-05-redeploy-4-prescan/runs/OWNER-DISPOSITIONS.md)
- [Original triage table](2026-11-05-redeploy-4-prescan/proofs/TRIAGE-TABLE.md) and [detailed gate evidence](2026-11-05-redeploy-4-prescan/proofs/TRIAGE-EVIDENCE.md)
- [Reader request](2026-11-05-redeploy-4-prescan/proofs/READER-REQUEST.md), [reader 1 result](2026-11-05-redeploy-4-prescan/proofs/READER-1.md), [reader 2 result](2026-11-05-redeploy-4-prescan/proofs/READER-2.md) and [latest writer response](2026-11-05-redeploy-4-prescan/runs/WRITER-ANSWERS-2.md): corrections applied; [reader 3 result](2026-11-05-redeploy-4-prescan/proofs/READER-3.md): PASS. Vietnamese copies: [this report](2026-11-05-redeploy-4-prescan.vi.md) and each round.
- [Scan materials](2026-11-05-redeploy-4-prescan/runs/README.md): the unit ledgers, the scan's tests and the logs this report cites, copied as produced. They are run files, kept on the owner's machine and out of git (template rule 7), so these links resolve only there. Source links point at the repository tree; their line numbers refer to the audited commit `ceed0a2`.

## Disclaimer

A security audit cannot show that vulnerabilities are absent. It is limited in time, tools and expertise. This report gives no guarantee of safety. Supplied review verdicts, passing local tests and owner acceptance do not prove all external or future behaviour.
