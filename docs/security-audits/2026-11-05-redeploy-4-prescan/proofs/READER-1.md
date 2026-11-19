# Separate reader review

Date: 2026-11-11. Reader: Codex, a fresh AI second-reader session, separate from the report writer. This is a private house-report review, not an independent audit or deployment approval.

I checked the four English reports against template section 7, the reader request, section 6, the owner answers and the supplied evidence. No installed skill was loaded. Report abbreviations below mean the main report and its `round-1.md`, `round-2.md` and `round-3.md` companions under `out/security-audits/`.

1. **Main, lines 1061 and 1070; round 2, lines 397 and 406 — obsolete cutoff disposition.** The rejection explanations call the configured horizon "incorrect", call its pin "wrong", and describe a retained finding. Owner Q3 makes this deliberate margin Invalid for code; I-01 correctly records that elsewhere. Replace both explanations with the approved first-halving-minus-30-days rule. Refer to I-01 as a historical Invalid code claim caused by SPEC wording. Keep these static alerts rejected and do not change the valid finding totals.

2. **Main, line 1117; round 1, line 1038 — obsolete retry limitation.** The `RigReporter.lock:already-pinned-library` explanation still says "Current fork retry limited by X Layer." The later `tests-gates-retry.txt` records a passing `test_round1AlreadyPinnedSameLibraryDataRecoveryAndBothOrders()`. Its fixture covers reporter and receiver recovery on BSC block 131934929 and X Layer block 75126506. State that this targeted retry passed and link the log. Preserve the earlier failed attempts as historical failures; do not imply a full fork campaign passed.

3. **All four reports, Methodology / Tools and roles — missing scanner version.** The reports name Slither but never print its supplied version, 0.11.6. The brief supplies that version, and template section 3 requires scanner names, versions and settings. Add "Slither 0.11.6" with one supplied scan pass. Record the supplied build settings that skip test and script directories, and retain the statement that the triager did not rerun Slither. Identify this as supplied provenance, not a fresh installation check.

4. **Main and round 1, line 358, H-01 title — ambiguous accepted bound.** "Restored income exceeds the accepted allocation bound" reads as a breach of the current accepted bound. Owner Q1 accepts the corrected bound; the reproduced gain exceeds the withdrawn 122 BEM statement. Rename it, for example, "Restored income exceeds the originally stated allocation bound". Retain High, confidence 100 and Acknowledged, together with the corrected 500 BEM hard / 8 BEM launch per-restoration limits and no lifetime cap.

5. **Main and round 1, line 910; round 3, line 362 — sentences exceed section 6's limit.** The inactive-harvest lead combines incorrect restoration, seizure and an unbounded external voucher value in one 29-word sentence, even before repairing its missing spaces. Round 3's sentence beginning "The earlier review's zero findings did not establish" has 28 words. Split these into sentences of at most 25 words, with one idea each. For the lead, separate the 500 BEM restoration bound from the 16-voucher seizure limit and the absence of an external-value cap. Check all writer-authored prose, not just finding summaries. Preserve the verbatim preparation facts.

6. **Main and round 1, Leads and Accepted risks, especially lines 908–972; main and round 2, Rejected by triage — missing spaces in prose.** Examples include `is500`, `and90%`, `at most16`, `Cached18+6=24`, `successful250/255`, `quoted8/4`, and `bases10/20`. Main lines 1050 and 1055, repeated at round 2 lines 386 and 391, contain `intentional300-second`, `and60-second` and `remains72h`. Restore spaces and articles and explain compressed arithmetic in ordinary sentences. For example, write "The cached decimal count is 18 + 6 = 24." Apply this to prose throughout those appendices; preserve actual identifiers, paths and quoted preparation facts.

7. **Main and round 1, line 999 — explicitly prohibited wording.** The malformed-answer rejection says "reverts atomically". Template section 6 explicitly replaces "atomically" with "in one transaction". A clearer correction here is: "The malformed answer makes activation revert. The queue, policy, tracked balance and unreleased income remain unchanged." Preserve the rejected disposition.

The numerical and disposition checks otherwise reconcile. The combined funnel is 207 = 11 valid findings + 1 Invalid + 27 accepted risks + 164 rejected + 4 leads. Round 1 is 117 = 11 + 1 + 27 + 74 + 4. Slither's 100 raw alerts map to 92 rejected roots, with two roots shared with round 1. I checked those IDs against the raw Slither JSON. Round 3 contributes no candidate roots. Unit provenance counts agree with the decision data.

The valid findings retain High 1 Acknowledged, Medium 1 Open and Low 9 Acknowledged. Their confidence values agree with triage: M-01 and L-09 are 75; the other valid findings are 100. I-01 retains historical Low/100 and is Invalid for code. There are no Fixed or below-threshold findings. Reserve rounding and the separate accepted cross-loan order effect remain distinct. The replacement-policy and evaluator cases remain conditional Low findings. Runtime parity is an owner attestation; the decimals check, sample clamp and RefBench rehearsal remain planned. The inactive-harvest trace remains a lead.

| Template section 7 check | Reader result |
|---|---|
| Frozen commit and matching scope | Only the supplied `ceed0a2` is an audit target. Historical hashes are explicitly labelled provenance. Missing Git history prevents authentication of the label or the requested diff. I recomputed all 372 original-file hashes: no differences. |
| One named nSLOC tool for every scope file | Recomputed every measurement using the supplied lexical counter. Main/round 1: 3,238 across 28 files. Rounds 2/3: 2,529 across 19 files. The nine scripts explain the difference. |
| Test counts and skipped suites | Raw run summaries reconcile to 1,352 passing executions and 1,346 distinct passing identities before this reader's runs. Historical 434 and present 21-test rerun are distinguished. No complete current fork or invariant campaign is claimed. Correction 2 updates one stale local explanation. |
| Coverage gaps and funnel | All 1,493 reconciliation rows match their cited input ledger lines. Counts are 83 settled, 24 partial and 1,386 unresolved. The 1,281 system state/order rows are present. Owner answers do not create execution coverage. Interrupted turns and unrun passes remain disclosed. |
| Critical/High/Medium proof | No Critical finding. The Medium has three failing intended-behaviour tests and two passing controls, reproduced below. H-01 has a stated reason for no failing intended-behaviour test: Q1 accepts the mechanism without a code change. This satisfies section 7's stated-reason alternative, while remaining a departure from the original blanket requirement. |
| Status and resolution | Finding fields match the triage and later owner answers. Corrections 1 and 4 remove inconsistent surrounding wording. No fixing commit, future green suite or human fix reread is asserted. |
| Summary counts | Eleven valid finding blocks and one separate Invalid block in main/round 1; zero finding blocks in rounds 2/3. Summary totals match. |
| Attribution and safety claims | Reports identify house work, AI tracing and owner decisions. No firm's authorship, independent verification or guarantee of safety is claimed. No human exploit-path rerun is documented. |
| Forbidden research names | Case-insensitive check against the names prohibited in `work/CLAUDE.md` found no occurrence in any of the four reports. |
| Publication boundary | Every report is marked private. No public copy or owner publication approval is claimed. Required provenance remains private and would require the stated publication/redaction gate. |
| Separate reader | This session performs that check and reports corrections. The drafts may record this review after delivery, but must not describe the corrections as addressed before the writer makes them. |

Every report contains all four `inputs/prep/` files in full; comparison ignores only line-ending differences and surrounding whitespace. The owner changes, calibration failures and limits, wrong-setting turns and redo, restarts, stops and scope omissions are preserved. All local Markdown link targets resolve. Each report includes the required next-step sentence exactly once. Finding summaries contain two to four sentences, and finding titles meet the 12-word limit; correction 4 concerns meaning. The historical-commit, unavailable k/N, single-pass and missing-human-rerun qualifications remain necessary and are not silently treated as completed workflow requirements.

I ran the following from `work/` on 2026-11-11. Both runs used the existing artifacts and reported "No files changed, compilation skipped". Failure persistence went to the Windows null device. No production source, original test, imported test or draft report was edited.

```powershell
$env:FOUNDRY_OUT='../out/build'
$env:FOUNDRY_CACHE_PATH='../out/cache'
$env:FOUNDRY_TEST_FAILURES_FILE='NUL'
forge test --offline --no-storage-caching --match-path 'test/audit/2026-11-05-redeploy-4-prescan/owner/OwnerEvidenceRegression.t.sol' --match-test '^test_M01_' -vv
```

Exit 1. The stale, insane and equal-timestamp positive-record tests each failed with `next call did not revert as expected`. The strictly newer positive-record and zero-power-at-floor controls passed. Total: two passed, three failed, zero skipped. I also read the regression and inherited fixture, and checked the `_verdict` branch that discards the reports. These local results do not complete an authenticated external loss trace or justify raising confidence above 75.

```powershell
forge test --offline --no-storage-caching --match-path 'test/audit/2026-11-05-redeploy-4-prescan/system/review/RestoreAmount.t.sol' --match-test '^test_S16_' -vv
```

Exit 0. One passed, zero failed, zero skipped. The logged raw values were:

```text
S16 recovery income raw 50000000000
S16 absorbed raw 49994957010
S16 entrant deposit raw 49894957009
S16 entrant gain raw 24944962306
```

At eight decimals, these confirm 499.94957010 BEM absorbed, 498.94957009 BEM deposited and 249.44962306 BEM gained. The gain is approximately 49.895% of absorbed income. This is an accepted income-allocation characterization, not a fixed-behaviour regression or proof of principal theft. The withdrawn examples were not rerun.

These reader executions are additional verification, not part of the writer's historical 1,352-pass total. Seven numbered corrections remain for the writer.

**FAIL**
