# Separate reader request

Date: 2026-11-11. The English drafts are ready for the coordinator's separate session. The writer has not performed or claimed that separate review. Do not translate yet. Return your findings to the coordinator so the writer can correct the English drafts before making faithful `.vi.md` copies.

## Files to read

1. [Main report](../../2026-11-05-redeploy-4-prescan.md)
2. [Round 1: ten units](../round-1.md)
3. [Round 2: Slither](../round-2.md)
4. [Round 3: earlier plain review](../round-3.md)

Read the complete [house template](../../../SECURITY-AUDIT-TEMPLATE.md), [brief](../runs/TRIAGE-BRIEF.md), [owner answers](OWNER-ANSWERS.md) and relevant normative SPEC. Follow the owner's later status and sequencing overrides. Read only this folder. Do not load an installed skill, fetch omitted documents, install anything, broadcast, send transactions, use signing material, commit or publish. Production code and original tests must remain unchanged. The coordinator requested a separate reader session; this file does not claim one has run.

## Section 7 checklist

- Check the audited target is only the supplied `ceed0a2` copy and the named scope matches the evidence. The export lacks work Git history, so the report cannot independently authenticate the label or execute the requested Git diff. All original files were hash-checked unchanged.
- Check every scoped file has nSLOC from the same named tool. Inspect [measurement data](../runs/scope-nsloc.json) and [measurement code](../runs/report-data.cjs). The definition is nonblank physical lines after lexical comment removal, with strings preserved and braces counted. Distinguish the nine deployment/feed scripts in the main/unit scope from scripts outside the Slither/plain-review scope.
- Check test counts and limits against [original commands](../runs/RUN-COMMANDS.md), [test index](../runs/test-index.json), [post-owner commands](POST-OWNER-RUNS.md) and raw logs. Current triage totals are 1,352 passing executions and 1,346 distinct passing identities. The Medium adds three intended failures. Historical supplied counts, including the earlier 434, must not be represented as new runs.
- Check every failed, skipped or unfinished execution and unrun campaign is disclosed. [Execution gaps](../runs/EXECUTION-GAPS.md) prints failure identities. [Original reconciliation](../runs/coverage-reconciliation.json) preserves all 1,493 ledger rows, with 83 settled and 1,410 historically retaining gaps. [Owner overlay](../runs/OWNER-COVERAGE-OVERLAY.md) resolves intent without inventing execution coverage. Check the 1,281 system state/order gap count.
- Check funnel arithmetic. Combined: 207 = 11 valid findings + 1 Invalid + 27 accepted risks + 164 rejected + 4 leads. Round 1: 117 = 11 + 1 + 27 + 74 + 4. Slither: 100 raw alerts become 92 rejected roots; two overlap round 1, so it adds 90. Plain review: zero candidates. Below threshold is zero throughout. Do not add overlapping unit counts as independent findings.
- Check the Critical/High/Medium reproduction rule. Critical is absent. M-01 has three intended-behaviour tests that fail at the audited code and two passing controls. H-01 has a stated reason for no failing intended-behaviour test: the owner accepts the mechanism and corrected bound without a code change. A 122 BEM assertion would encode a withdrawn requirement. Evaluate this disclosed exception under section 7; do not hide the departure from the original blanket requirement.
- Check every finding's status and resolution. Valid counts: High 1 Acknowledged; Medium 1 Open; Low 9 Acknowledged. No Fixed. One historical Low is Invalid for code and excluded from the valid summary. No fixing commit, future passing result, full green suite at a fix or human fix reread exists.
- Check the summary counts against the finding blocks. H-01, M-01 and L-01 through L-09 are valid; I-01 is the historical Invalid claim. Accepted risks and leads are excluded from severity totals.
- Check no page claims independence, a firm's authorship or guaranteed safety. Technical tracing and reproduction were by AI; the human owner approved intent and acceptance, not a documented exploit-path rerun. A source reviewer's acceptance is not substituted for owner triage.
- Check forbidden internal research names from `work/CLAUDE.md` are absent from every report. The writer's preflight checks this without printing the names.
- Check private/public boundaries. These are private drafts, not authorized public copies. Preparation facts are included in full and contain addresses, circuit references, historical hashes and deployment wording. Do not publish them without the owner's permission and any required redaction.
- Record your own separate-reader identity/role, date, verdict and every correction needed. The drafts currently say this step is pending. That status may only change after your result is delivered and addressed.

## Particular judgments to check

**H-01:** owner Q1 accepts shared income up to absorbed income, up to marked principal: 500 BEM hard and 8 BEM launch per restoration, with no lifetime cap. Keep High Acknowledged and say the bound was misstated when the scan ran. The reproduced entrant gain is 249.44962306 BEM. The 0.0046 and 4.3 examples are withdrawn, not claimed reproduced. Verify the distinction between income allocation and principal theft.

**M-01:** inspect [intended-behaviour regressions](../../../../test/audit/2026-11-05-redeploy-4-prescan/owner/OwnerEvidenceRegression.t.sol) and [output](../runs/tests-owner-medium.txt). Stale, insane and equal-time positive-record cases must reject a clear. A zero-power record at the floor must remain impaired; a strictly newer positive record can clear. The local endpoint and records are mocked; a full authenticated external loss trace remains unfinished. Confidence remains 75 and no speculative patch recommendation is supplied. Owner-approved intended behaviour is recorded separately. Imported ancestor tests characterize the old bug and will need separate treatment at a fixing commit; no future full green suite is promised.

**I-01:** the owner attests the deliberate first-halving-minus-30-days margin from an omitted document. That assertion supports Invalid for code and a SPEC wording correction. The omitted document was not fetched or independently authenticated.

**Reserve and lens:** per-payment dust and cross-loan order effects are separately accepted. The latter remains one of the 27 accepted risks, not another scored finding. Replacement-policy/evaluator/foreign-factory findings remain Low Acknowledged. Their unsupported external traces are not upgraded to current live exploits by owner acceptance.

**Deploy gate and four leads:** runtime parity is an owner-attested runbook step outside the export, not a verified operation. The sample clamp and decimals assertion are planned checks; their leads remain leads. RefBench screen passes wait for a successful rehearsal; no such successful rehearsal is claimed. Inactive bridged harvest remains a lead.

**Provenance exceptions:** every report reproduces all four preparation files in full. They mention historical commits as calibration/comparison facts; only `ceed0a2` is audited. This is explicitly disclosed against the template's literal one-commit-named check. Exact per-entry k/N execution counts are unavailable; lower bounds and the complete turn roster must not become invented exact counts. Slither and the earlier plain review each have only one supplied scan pass. No human exploit rerun is documented. Please assess these limitations rather than silently marking the corresponding checklist items complete.

**Writing and links:** check template section 6, finding titles and short summaries, source locations, proof paths, status reasons and all Markdown links. Supplied facts are verbatim provenance and may not follow the writer's short-sentence rules. All four reports must contain the exact next-step sentence: "An independent audit is planned after the hackathon." It must not turn into a broader assurance or additional audit promise.

## Supporting evidence

- [All final owner dispositions](../runs/OWNER-DISPOSITIONS.md) and [machine-readable decisions](../runs/owner-decisions.json)
- [Original triage table](TRIAGE-TABLE.md) and [gate evidence](TRIAGE-EVIDENCE.md)
- [All 100 Slither mappings](../runs/slither-mapping.json) and [53 conflict mappings](../runs/conflict-mapping.json)
- [Post-owner source integrity](../runs/post-owner-integrity.json)
- [Writer's mechanical preflight](../runs/REPORT-PREFLIGHT.md), which is not the separate reader review

The writer stops here as requested. No Vietnamese report has been written, and no production fix, commit or publication has been performed.
