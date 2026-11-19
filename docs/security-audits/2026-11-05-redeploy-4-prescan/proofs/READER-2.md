# Separate reader recheck

Date: 2026-11-11. Reader: Codex, the separate AI reader continuing the review recorded in `READER-1.md`. Private house-report review; not an independent audit or deployment approval.

I read `WRITER-ANSWERS-1.md`, checked all seven responses in the reports themselves, and reread all four reports against template sections 6 and 7. I also checked the rewritten passages against the supplied evidence. No installed skill was loaded. Only this reader report was written.

One correction remains:

1. **Main report and round 1, line 958, Accepted risks / `RigAgent.flagImpaired:rescued-rig-feed-off` — the recovery instruction names the wrong actor.** Both reports now say, "A keeper must re-enable the feed and push a report." `TapePool.enableFeed()` is `onlyOwner` at `work/src/TapePool.sol:564`. SPEC section 12 assigns that action to the owner at line 1142. The cited section 16 row at line 1380 explicitly separates the owner's re-enable from the keeper's subsequent flag on a fresh report. Replace the sentence with: "The owner reviews the cause and re-enables the feed when reporter data is trusted. The keeper then flags the rig using a fresh report." Keep the accepted-risk disposition and the stated evidence limits. This is a report correction, not a new contract finding.

The seven previous corrections are addressed in the revised text. The new actor error above arose in the broader prose rewrite.

| Reader 1 item | Verification in the revised reports |
|---|---|
| Cutoff disposition | Main lines 1071 and 1080, and round 2 lines 407 and 416, identify the approved margin and historical Invalid claim. The static alerts remain rejected. |
| Fork retry | Main line 1127 and round 1 line 1048 record the passing targeted recovery test, both block numbers and the log link. Historical failures and the incomplete campaign remain disclosed. |
| Slither version | All four Methodology sections print Slither 0.11.6, one supplied pass and the build command excluding tests and scripts. They distinguish provenance from a fresh installation check. |
| H-01 title | Main and round 1 line 368 now say "originally stated allocation bound". High, confidence 100, Acknowledged and the corrected bounds remain intact. |
| Sentence length | The inactive-harvest lead separates restoration, seizure and external voucher value. Round 3 line 372 separates the missing traces. The fresh sentence check found no writer-authored sentence above 25 words. |
| Spacing and arithmetic | The cited joined words and numbers are repaired. Expanded decimal, share, reserve, ratio and timing statements preserve the quantities in the evidence. Correction 1 above addresses the changed actor. |
| Prohibited wording | Main and round 1 line 1009 replace "atomically" with separate rollback statements. The gate-1 rejection remains. |

The section 7 recheck found no other correction:

- The audit target remains the supplied `ceed0a2`; historical hashes remain provenance. Missing Git history and the unavailable Git diff remain explicit qualifications. All 372 original-file hashes still match.
- Every nSLOC measurement agrees with the supplied lexical counter. Main and round 1 retain 3,238 nSLOC across 28 files; rounds 2 and 3 retain 2,529 across 19.
- Test totals remain 1,352 passing executions and 1,346 distinct passing identities. The historical 434 tests and the earlier reader's additional executions remain separate. Skipped campaigns, failed attempts and the targeted retry are distinguished.
- Coverage accounting remains 1,493 rows: 83 settled, 24 partial and 1,386 unresolved. The reports retain the 1,281 system state/order gaps and explain that owner decisions do not supply missing execution evidence.
- The combined funnel remains 207 roots. Round 1 contributes 117; Slither's 92 rejected roots include two overlaps and add 90. Round 3 adds none.
- The Medium retains its three intended failures, two passing controls, Open status and confidence 75. H-01 retains its accepted-mechanism characterization and stated reason for no failing intended-behaviour test. The limitations recorded in `READER-1.md` still apply.
- Finding fields match the owner decisions: one High Acknowledged, one Medium Open and nine Low Acknowledged. One historical Low is Invalid for code. No finding is Fixed or below threshold. Summary counts match the blocks.
- No report claims independence, a firm's authorship or guaranteed safety. Human owner decisions remain distinct from AI tracing and reproduction. No fixing commit or completed fix verification is claimed.
- All four preparation files remain complete in every report. The tool change, calibration limits, coordinator mistake, redo, restarts, stops and exclusions remain disclosed.
- Forbidden research names remain absent. All four reports remain private; publication is not authorized. Local Markdown links resolve, and the exact next-step sentence occurs once per report.
- The reports accurately record reader 1's FAIL verdict and the pending recheck. This result does not establish that the remaining correction has been applied.

The section 6 reread found no additional title, summary-length, prohibited-word or numerical-formatting correction. The required preparation quotations remain verbatim. No code test was rerun for this documentation recheck; the reader's actual High and Medium runs remain recorded in `READER-1.md`.

**FAIL**
