# Triage evidence — `ceed0a2`

Supporting decision records for [TRIAGE-TABLE.md](TRIAGE-TABLE.md), not the final security audit reports. Input verdicts are preserved as provenance, not adopted as authority. Severity uses the template §4 row named in each finding; risk questions remain for the owner.

<a id="entry-001"></a>

## TapePool._restore:restored-income-redistribution-bound

**Finding; High; confidence 100.**

A later lender receives 249.44962306 BEM of restored income; the stated 122 BEM acceptance bound does not cover that amount.

G1: seize an old loan, forward 500 BEM of its later receipts, flag two genuine 250 BEM loans, lapse, clear with health, deposit, and wait for release. _absorb (TapePool:811) and _restore (820) make the release shareable by new shares. G2: the fixture uses the real v1 policy, actual delayed raises to 1000 BEM supply/500 BEM total borrowing/90% admission, 20,000 H mock reports and a retained backstop. No live inventory of that size is established, but no hard code bound excludes it. G3: a later depositor needs no role once loans clear. G4: 249.44962306 BEM goes to the entrant instead of prior holders; this is an asset allocation effect, not just a wrong sentence. §4 High: loss of lender assets with the hard precondition of absorbed income being restored. The accepted sharing mechanism does not silently enlarge its stated numerical bound. At this fixture r=499.94957010 BEM, entry=498.94957009 BEM, gain exceeds 122 by 127.44962306 BEM. Per restoration wave r cannot exceed marked principal, hence 500 BEM; entrant gain is less than r. Repeated waves have no lifetime cap. Q1 asks whether the owner accepts the larger scope. Original 0.0046/4.3 inputs remain a separate coverage gap, merged into this cause. No claim that the entrant steals already paid principal.

**Strongest retained input / provenance:** system/FINDINGS.md I-01, L-01, F5-B; system/LEDGER.md R16-24.5. Units: system.

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. No person has confirmed this disposition.

**Current verification:** [test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Conflict/break rows:** system:R16-24.5 (line168).

<a id="entry-002"></a>

## RigAgent._verdict:discarded-report-revives-old-health

**Finding; Medium; confidence 75.**

A delayed healthy report discards a newer impairment block and lets an older positive record restore doubtful principal.

G1: VC at the seize floor is blocked by B at floor+1. The actual receiver accepts a healthy packet at floor+2 after its 300-second freshness expires. _verdict gives that packet no H/B/U role, sets reported=false, and admits the older VC. clearExpiredFlag restores 1 BEM. G2: delayed authentic packets are permitted; the local reproduction uses the real receiver/policy/agent but a test endpoint and report producer. G3: any caller can clear, and any holder can then exit available idle at the restored price. G4: the fail-closed impairment block opens without fresh H or a newer VC. §4 Medium covers a rare reachable fail-open rule. The full authenticated producer-to-lender-loss trace is unfinished; §5 promotes the reachable unguarded path at 75, without a recommendation. The passing local test proves accounting, not a completed external loss attack. SPEC §16 “Stored impaired report blocks a clear” explicitly describes U protecting brake-time overwrites; it does not explicitly accept stale/insane on-feed overwrites reviving disproven VC. Its phrase “for as long as it stays the stored report” needs the owner’s answer, Q2. Same root for C3-02, but a sane-to-insane upstream transition is unestablished and is not an additional finding. Exposure is at most 500 BEM currently outstanding, with exits additionally bounded by idle and shares. The 60-second reflag floor can delay a fresh corrective flag.

**Strongest retained input / provenance:** feed/CRITIC-3.md C3-01/C3-02; RigAgent.sol:664–688. Units: feed.

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. No person has confirmed this disposition.

**Current verification:** [test_critic3StaleHealthyDeliveryErasesBlockAndRevivesOlderRecord()](../runs/tests/feed/critic/Critic3Sequences.t.sol) (tests-initial.txt)

<a id="entry-003"></a>

## TapePool.maxMint:share-conversion-overflow

**Finding; Low; confidence 100.**

Nine loan-loss/recapitalization cycles make the maximum quotient overflow, so even mint(1) reverts.

G1: maxMint converts the whole remaining supply cap before inherited mint compares its small request. G2: the test uses real factory loans, nine losses, a retained 0.01 BEM dead seed and no backstop exits; eligible/impairment reports are mocks. The state is a severe credit-loss history, not arbitrary storage writes. G3: any caller requesting mint reaches the overflow; an outsider can operate loss-bearing loans subject to screening. G4: small mint fails despite representable previewMint; deposit still works. §4 Low: limited reach and unlikely trigger. Two critic passes and rechecks independently flagged this demoted area; §5 therefore forbids retaining it merely as a lead. S=103019296356454950081780425431896511341288806181963447721196296385035, A=0; S+10^6 fits, cap conversion does not. At the hard 1000 BEM supply cap the arithmetic boundary is no safer. One raw BEM donated and released after one second repairs the demonstrated state. No extra principal loss or universal exit freeze is proved.

**Strongest retained input / provenance:** pool-books/FINDINGS.md L-C1; CRITIC-1 L-C1; LEDGER C09/P02. Units: pool-books.

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. No person has confirmed this disposition.

**Current verification:** [test_repeatedLossMaxMintOverflowWithoutBackstopExit()](../runs/tests/pool-books/critic/AccountingCritic.t.sol) (tests-initial.txt)<br>[test_R1_repeatedLossMaxMintOverflowWithoutBackstopExit()](../runs/tests/pool-books/review/Round1Review.t.sol) (tests-initial.txt)

**Conflict/break rows:** pool-books:P02 (line115); pool-books:C09 (line127).

<a id="entry-004"></a>

## TapePool.maxRedeem:eager-liquidity-conversion-overflow

**Finding; Low; confidence 100.**

The idle-to-share conversion overflows before the finite holder clamp, blocking redeem while withdraw still pays.

G1: maxRedeem evaluates _convertToShares(idle) before min(holder shares,...). G2: after the preceding nine-loss history, a genuine 1 BEM deposit and 30 BEM donated income produce S≈5.151e75, A=1.00000001, idle=31.00000001 and unvested=30 BEM. G3: the donation and sync need no role. G4: redeem and even a zero-holder maximum panic; maxWithdraw and withdrawal of 1 BEM succeed. §4 Low for limited reach and unlikely history; §5 repeated-pass/pattern promotion applies. It persists at one hour and resolves by the tested one-day point as income vests. Hard bounds do not bound share count, so launch-only caps are not a defense.

**Strongest retained input / provenance:** pool-books/FINDINGS.md C3-1; CRITIC-3 C3-1; LEDGER C07/P02. Units: pool-books.

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. No person has confirmed this disposition.

**Current verification:** [test_R3_largeSupplyIncomeBlocksRedeemButNotWithdraw()](../runs/tests/pool-books/review/Round1Review.t.sol) (tests-initial.txt)

**Conflict/break rows:** pool-books:C07 (line93); pool-books:P02 (line115).

<a id="entry-005"></a>

## DeployPool.emissionEnd:early-halving-cutoff

**Finding; Low; confidence 100.**

The configured cutoff denies otherwise eligible 7- and 14-day loans thirty days before the specified halving boundary.

G1: Addresses:76 and DeployPool:59–61 pin 1910726132; CreditPolicy._gather:140 rejects maturity at that pin. G2: PodMining start 1787318132 plus period 126000000 is 1913318132, independently reread by passing current-BSC tests. G3: an eligible borrower reaches EMISSION through the real agent. G4: 30 days of borrowing availability are lost. §4 Medium availability, reduced once to Low for the hard future-2030 trigger. First denial is 1910121332/1909516532 for 7/14 days, instead of 1912713332/1912108532. Q3 asks whether the margin was deliberate; following a shared constant does not decide it. Deployment fork reproductions were attempted but X Layer RPC was blocked; local policy/lens borrow reproductions and current BSC arithmetic passed.

**Strongest retained input / provenance:** policy L-01; feed L-01; lens-factory LF-03; deploy F01; system L-02. Units: policy, feed, lens-factory, deploy, system.

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. No person has confirmed this disposition.

**Current verification:** [test_round3NormativePinActualBorrowAndInclusiveHalvingBoundary()](../runs/tests/lens-factory/review/Round3Review.t.sol) (tests-initial.txt)<br>[testReview_configuredHalvingMarginDeniesThirtyDaysEarly()](../runs/tests/policy/review/PolicyReview.t.sol) (tests-initial.txt)

**Conflict/break rows:** policy:U03 (line45); policy:E21 (line131); policy:A07 (line173); feed:2.06 (line28); lens-factory:R032 (line44); deploy:E01 (line123).

<a id="entry-006"></a>

## TapeLens.principalFor:unbounded-debt-inversion

**Finding; Low; confidence 100.**

An installable policy’s large debt limit overflows before the lens applies the pool’s finite lending room.

G1: TapeLens:96–105 adds fee to max-minus-minFee or multiplies debt by 10000, before _size:150 clamps room. G2: the test installs a higher-version, downward-closed unlimited policy through the real seven-day queue. A finite debt bound floor(uint256.max/10000)+1 also fails. G3: ordinary quote callers trigger it. G4: maximum quote panics while exact quote and a 4 BEM borrow work; §4 Low view/limited availability. The absolute hard principal bound is 500 BEM, not uint256.max. This is distinct from gaps in allowed debts.

**Strongest retained input / provenance:** lens-factory LF-01; system L-03/CL-01. Units: lens-factory, system.

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. No person has confirmed this disposition.

**Current verification:** [test_boundaryFiniteReplacementOverflowsMultiplicationBeforePoolRoom()](../runs/tests/lens-factory/review/BoundaryReview.t.sol) (tests-initial.txt)<br>[test_leadUnlimitedReplacementRevertsMaxQuoteButExactQuoteAndBorrowWork()](../runs/tests/lens-factory/review/BoundaryReview.t.sol) (tests-initial.txt)

**Conflict/break rows:** lens-factory:R079 (line91); lens-factory:R106 (line118).

<a id="entry-007"></a>

## TapeLens._size:gapped-policy-maximum

**Finding; Low; confidence 100.**

A valid policy with gaps makes the lens return zero even though a smaller executable loan exists.

G1: _size inverts maxDebt, clamps to pool room, and tests only that one debt. G2: a real queued replacement allows debt≤2 BEM or exactly10 BEM; maxDebt=10 is truthful and no interface rule requires downward closure. G3: ordinary quote call. G4: pool room4 gives DENIED/0 instead of executable principal1.99501246 (7d) or1.99004975 (14d) BEM. Exact quote/borrow succeeds; contiguous control passes. §4 Low view misreport. At hard bounds as much as500 BEM of principal can be hidden; no cap is bypassed. N19 shows that merely adding a ceiling argument need not solve fee-induced unreachable debt points.

**Strongest retained input / provenance:** lens-factory LF-02, CR-C01; LEDGER R225. Units: lens-factory.

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. No person has confirmed this disposition.

**Current verification:** [test_round1TieredPolicyMissesExecutableMaximum()](../runs/tests/lens-factory/review/Round1Review.t.sol) (tests-initial.txt)<br>[test_redoTieredBothTermsAndBothFactoriesCreate()](../runs/tests/lens-factory/review/RecheckReview.t.sol) (tests-initial.txt)

**Conflict/break rows:** lens-factory:R079 (line91); lens-factory:R225 (line237).

<a id="entry-008"></a>

## CheckStack.checkReporter:reporter-build-not-attested

**Finding; Low; confidence 100.**

The gate’s multiplier-one sample cannot distinguish an incompatible reporter build.

G1: readTapeOut validates locally compiled normalized data, then expects the reporter to quote that one multiplier-one payload; no reporter build attestation exists. G2: an accidentally reused implementation at a fresh locked address can meet pins. G3: a gate operator running the normal read-only script receives PASS; this is deployment assurance, not a claimed adversarial transaction. G4: a wrong-stack false positive is limited assurance harm, §4 Low. Multiple passes flag this area; the targeted retry now independently passes the complete full-gate reproduction, giving confidence100. The strongest supplied full-gate test etches the saved earlier runtime and then shows actual quoted base384 H versus24 H for456 weight/72 raw bonus/bstar4/mult6 (16×). It mocks only that sample’s vault mapping, not normalization. I independently traced the gate and reproduced that live-runtime execution in tests-gates-retry.txt. L1’s asset-loss extension is merged, not double counted: it needs actual screened bridged mult>1 collateral, authentication/delivery, admitted borrowing and loss. Exposure could reach500 BEM/90% assets, bounded also by backstop; no such loss is established. No recommendation for that unfinished extension.

**Strongest retained input / provenance:** deploy F02/C1/L1; CRITIC-1/3/4; CheckStack.s.sol:123–137. Units: deploy.

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. No person has confirmed this disposition.

**Current verification:** [test_round1_C1_oldRuntimePassesGateButIndependentBuildCheckRejects()](../runs/tests/deploy/review/Round1Gate.t.sol) (tests-gates-retry.txt)

**Conflict/break rows:** deploy:6-08 (line100); deploy:B07 (line120); deploy:C1 (line166).

<a id="entry-009"></a>

## TapePool.repay:fragmented-reserve-rounding

**Finding; Low; confidence 100.**

Small repayments repeatedly floor the reserve share to zero and route that fee income to shares instead.

G1: reserve receives floor(feePayment*storedShareBps/10000) independently on every payment. G2: positive tiny repayments are admitted and the fee waterfall pays them. G3: any payer can fragment payments; a payer holding shares can recover a portion of the shifted income. G4: the reproduced500 raw fee sends100 raw to reserve in one payment, but0 over125 payments of4 raw; debt and total backing are unchanged. §4 Low: wrong rounding of dust, with cumulative allocation rather than forgiven debt. §16 accepts a stored reserve base, not deliberate fragmentation of reserve share. At50% hard share, each one-raw payment can shift0.5 raw versus aggregate allocation; an initial500 BEM/14d/600bps fee is30 BEM, up to15 BEM nominal reserve, requiring3 billion one-raw payments to divert all. Late fees at30bps/day on500 BEM add1.5 BEM/day before reserve allocation; no lifetime bound. Gas-cost feasibility of a material extraction is unproved, so no higher rating. Q4 asks for intended aggregate rounding.

**Strongest retained input / provenance:** pool-loans/CRITIC-3.md CR3-03; TapePool.sol:371–377. Units: pool-loans.

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. No person has confirmed this disposition.

**Current verification:** [test_critic3FragmentedFeeConservesValueWithoutForgivingDebt()](../runs/tests/pool-loans/critic/PoolLoansCritic3.t.sol) (tests-initial.txt)

<a id="entry-010"></a>

## TapeLens._blocker:foreign-factory-quote

**Finding; Low; confidence 100.**

The lens quotes a genuine clone whose factory lacks the pool’s lending authority.

G1: quote trusts the agent’s pool/borrower fields and never authenticates factory.borrowerOf; pool.lend does. G2: any caller can deploy the real second factory with the same immutable assets and existing pool. G3: any quote caller can supply its real clone. G4: quotes allow1 BEM and maxima2.64075498/4 BEM, but both borrows revert NotAgent and roll back. §4 Low view misreport, not theft. Two passes retain the same area, so §5 promotion applies instead of leaving an integration lead. Whether the omitted app can select the clone is unproved; Q5 asks for supported input validation, not permission to invent a client exploit. At most500 BEM can be falsely advertised under hard room.

**Strongest retained input / provenance:** lens-factory C-03; CRITIC-3 C3-C01. Units: lens-factory.

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. No person has confirmed this disposition.

**Current verification:** [test_critic3ForeignFactoryQuoteHasNoPoolAuthority()](../runs/tests/lens-factory/critic/Critic3Review.t.sol) (tests-initial.txt)

<a id="entry-011"></a>

## CreditPolicy.maxDebt:partial-evaluator-maximum

**Finding; Low; confidence 100.**

A boundary-only evaluator disagreement makes maxDebt return zero while smaller check calls still allow debt.

G1: maxDebt probes only the policy boundary and returns0 after a mirror mismatch; check at a smaller bucket can agree and allow. G2: current evaluator agrees across4096 vectors; the characterized partial disagreement needs an external evaluator change/error, within the documented mutable evaluator boundary. G3: ordinary view caller. G4: largest-debt view misreports; it does not overadvance. §4 Low view/limited reach. Multiple passes explicitly flag the same demoted area, invoking §5 promotion. The passing reproduction proves0 versus allowed1,100,000 raw debt, not a current live disagreement. Q5 asks whether the interface promises a maximum under partial failure or a conservative failure sentinel.

**Strongest retained input / provenance:** policy/LEDGER.md A19; CRITIC-1/3 partial evaluator. Units: policy.

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. No person has confirmed this disposition.

**Current verification:** [testReview_maxDebtConservativeAfterPartialEvaluatorDisagreement()](../runs/tests/policy/review/PolicyReview.t.sol) (tests-initial.txt)

**Conflict/break rows:** policy:A19 (line185).

<a id="entry-012"></a>

## TapePool._deposit:pull-before-effects

**Rejected; —; confidence —.**

Gate4: the observer sees old supply/tracked during the inbound pull, but guarded mutations reject and no live token hook or unpaid shares are demonstrated.

**Strongest retained input / provenance:** pool-books C-01/I10/P11; system C-01. Units: pool-books, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_I10_conflict_DepositPullPrecedesPoolEffects()](../runs/tests/system/review/OrderAndRisk.t.sol) (tests-initial.txt)<br>[test_depositCEIConflictAndAllEightCallbackGuards()](../runs/tests/pool-books/review/BoundaryReview.t.sol) (tests-initial.txt)

**Conflict/break rows:** pool-books:I10 (line107); pool-books:P11 (line124); system:I10.1 (line34); system:T8-Order_and_rounding.1 (line240).

<a id="entry-013"></a>

## TapePool.repay:pull-before-cash-tracking

**Rejected; —; confidence —.**

Gate4: principal effects precede the pull; tracked follows it. Hookless pinned BEM, nonReentrant and rollback prevent the alleged backing loss.

**Strongest retained input / provenance:** pool-loans C-01/11.2-17/15-10/A8-15. Units: pool-loans.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_transferBoundaryShowsAccountingOrderConflict()](../runs/tests/pool-loans/review/PoolLoansReview.t.sol) (tests-initial.txt)

**Conflict/break rows:** pool-loans:11.2-17 (line69); pool-loans:15-10 (line186); pool-loans:A8-15 (line212).

<a id="entry-014"></a>

## RigAgent.repay:pull-before-debt-effects

**Rejected; —; confidence —.**

Gate4: old agent debt is observable during payer pull, but the immutable token has no demonstrated hook exploit and no victim loses assets.

**Strongest retained input / provenance:** agent-loan C-01/I10/P-Order; system C-01. Units: agent-loan, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_I10_conflict_ThirdPartyPullPrecedesAgentEffects()](../runs/tests/system/review/OrderAndRisk.t.sol) (tests-initial.txt)

**Conflict/break rows:** agent-loan:I10 (line156); agent-loan:P-Order (line182); system:I10.1 (line34); system:T8-Order_and_rounding.1 (line240).

<a id="entry-015"></a>

## TapePool.maxDeposit:zero-entry-during-doubt

**Rejected; —; confidence —.**

Gate4: zero deposit/mint changes zero BEM and zero shares; positive requests revert. Literal §15.15 conflict remains.

**Strongest retained input / provenance:** pool-books C-02/A44/I15; system I15.1. Units: pool-books, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_doubtfulRejectsPositiveDepositAndMint()](../runs/tests/pool-books/review/BooksReview.t.sol) (tests-initial.txt)<br>[test_I15_zeroAmountEntriesDoNotRevertWhileDoubtful()](../runs/tests/system/review/SystemReview.t.sol) (tests-initial.txt)

**Conflict/break rows:** pool-books:A44 (line82); pool-books:I15 (line109); system:I15.1 (line42).

<a id="entry-016"></a>

## TapePool.maxDeposit:zero-assets-supply-cap-wording

**Rejected; —; confidence —.**

Gate4: zero assets still permit paid recapitalization while borrowing room is zero; no cap bypass or unbacked mint follows.

**Strongest retained input / provenance:** pool-books C-03/C05. Units: pool-books.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_zeroAssetStateAndMaxInputReverts()](../runs/tests/pool-books/review/BoundaryReview.t.sol) (tests-initial.txt)

**Conflict/break rows:** pool-books:C05 (line91).

<a id="entry-017"></a>

## TapePool.writeOff:unmarked-agent-impersonation

**Rejected; —; confidence —.**

Gate2: the synthetic unmarked write-off impersonates an agent; real clones reach writeOff only through guarded, flagged seize.

**Strongest retained input / provenance:** pool-books rejected test-generated path; CRITIC-1. Units: pool-books.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_R1_zeroAssetPositiveIdleAfterWriteOffCanRedeemForZero()](../runs/tests/pool-books/review/Round1Review.t.sol) (tests-initial.txt)<br>[test_totalLossZeroAssetsWithSharesAndReentryAfterWriteOff()](../runs/tests/pool-books/review/BooksReview.t.sol) (tests-initial.txt)

<a id="entry-018"></a>

## TapePool.executeParam:early-calendar-late-rate

**Rejected; —; confidence —.**

Gate3: owner must queue against its dated promise; old loans keep snapshots and new borrowers bound maxLate. No outsider amplifier is shown.

**Strongest retained input / provenance:** pool-loans C-02; pool-admin C-01/4.4.PO3; agent-loan C-02. Units: pool-loans, pool-admin, agent-loan.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_LateRateCanExecuteBeforeDecember7()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_PO3_calendar_commitment_is_not_enforced_by_parameter_queue()](../runs/tests/pool-admin/review/PoolAdmin.t.sol) (tests-initial.txt)

**Conflict/break rows:** pool-loans:4.4-05 (line45); pool-admin:12.38 (line199); pool-admin:4.4.PO3 (line221); agent-loan:4.4-05 (line19).

<a id="entry-019"></a>

## TapePool.queueParam:lapsed-overwrite-event

**Rejected; —; confidence —.**

§5 do-not-report: lapsed requeue emits ParamLapsed instead of ParamCancelled; state, ETA and authority remain correct.

**Strongest retained input / provenance:** pool-admin C-02/12.06. Units: pool-admin.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_parameter_overwrite_cancel_and_event_order()](../runs/tests/pool-admin/review/PoolAdmin.t.sol) (tests-initial.txt)<br>[test_policy_queue_eta_grace_pause_cancel_lapse_and_overwrite()](../runs/tests/pool-admin/review/PoolAdmin.t.sol) (tests-initial.txt)

**Conflict/break rows:** pool-admin:12.06 (line167).

<a id="entry-020"></a>

## TapePool.expiryOf:expired-flag-revival

**Rejected; —; confidence —.**

Gate1: binary-search clock logic leaves already expired flags expired; later brakes cannot reset their evidence floor.

**Strongest retained input / provenance:** pool-admin C-03/C3-K1; agent-evidence C-01; system C-03. Units: pool-admin, agent-loan, agent-evidence, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_R1LiveFlagAndAlreadyExpiredEnableException()](../runs/tests/agent-loan/review/Round1Corrections.t.sol) (tests-initial.txt)<br>[test_RedoBrakeAtExactExpiryDoesNotRevive()](../runs/tests/agent-loan/review/RedoBoundaries.t.sol) (tests-initial.txt)

**Conflict/break rows:** pool-admin:8.20 (line241); agent-loan:P-SeizeEnableException (line187); agent-evidence:P10 (line210); system:T8-Seize.6 (line224).

<a id="entry-021"></a>

## RigAgent.seize:closed-loan-error-selector

**Rejected; —; confidence —.**

Gate4: funded open loan returns NoDebt, deleted loan NoLoan; both prohibit seizure and move no voucher.

**Strongest retained input / provenance:** agent-evidence C-02/P11; system C-06. Units: agent-evidence, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_RecheckSeizeNoDebtAtCurrentAccruedFunding()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_CriticSeizeFundedOpenVsRepaidClosedSelectors()](../runs/tests/system/critic/ContinuationChecks.t.sol) (tests-initial.txt)

**Conflict/break rows:** agent-evidence:P11 (line211); system:T8-Seize.7 (line225).

<a id="entry-022"></a>

## RigAgent.forwardVouchers:permissionless-list-reconciliation

**Rejected; —; confidence —.**

Gate1: only a closed agent forwards seized collateral to the immutable pool; no caller-controlled destination or borrower release exists.

**Strongest retained input / provenance:** agent-loan P-RepayEgress; system C-04/C-05. Units: agent-loan, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_CriticKeeperCanRemoveCollateralThroughForwardVouchers()](../runs/tests/system/critic/ContinuationChecks.t.sol) (tests-initial.txt)<br>[test_R1ForwardSeizeRecoveredRetryBothOrders()](../runs/tests/agent-loan/review/Round1Ordering.t.sol) (tests-initial.txt)

**Conflict/break rows:** agent-loan:P-RepayEgress (line183); system:T8-Repayment.3 (line212); system:T8-Collateral.1 (line216).

<a id="entry-023"></a>

## RigAgent.withdrawVoucher:unknown-owner-forgets-entry

**Rejected; —; confidence —.**

Gate4: borrower-only, no-loan withdrawal drops an unreadable entry but does not transfer it elsewhere; register/withdraw recovers it once reads work.

**Strongest retained input / provenance:** agent-loan CL-01; system F5-D. Units: agent-loan, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_FreshUnreadableWithdrawIsRecoverable()](../runs/tests/system/critic/FreshChecks.t.sol) (tests-initial.txt)

<a id="entry-024"></a>

## RigAgent._add:full-list-duplicate-return

**Rejected; —; confidence —.**

Gate4: an already listed id can return to a full list, but its length stays16 and no loan/cap/ownership limit is bypassed.

**Strongest retained input / provenance:** agent-loan L-02/10.2-05/10.2-07. Units: agent-loan.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_FullSetAcceptsReturningListedVoucher()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)

**Conflict/break rows:** agent-loan:10.2-05 (line41); agent-loan:10.2-07 (line43).

<a id="entry-025"></a>

## RigAgent._forward:short-token-success

**Rejected; —; confidence —.**

Gate2: a synthetic31-byte no-op token leaves100 raw temporarily, but the pinned canonical BEM cannot produce this response; later claim recovers the fixture.

**Strongest retained input / provenance:** agent-loan R1-TOKEN. Units: agent-loan.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_R1ShortReturnSurplusObservationAndRecovery()](../runs/tests/agent-loan/review/Round1Modes.t.sol) (tests-initial.txt)

<a id="entry-026"></a>

## RigAgent._accrue:tiny-principal-late-rounding

**Rejected; —; confidence —.**

Gate4: ten voluntarily paid intervals charge40 raw versus35 without reductions; only the payer pays extra dust, no unpaid debt compounds.

**Strongest retained input / provenance:** agent-loan C3-R. Units: agent-loan.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_R3DustPrincipalIntervalsChargeOnlyPaidFees()](../runs/tests/agent-loan/review/Round3Settlement.t.sol) (tests-initial.txt)

<a id="entry-027"></a>

## RigAgent._moveCollateral:restore-kept-list-before-callbacks

**Rejected; —; confidence —.**

Gate1: movement loops finish before retained ids are restored; closed/no-loan/empty-list/wasSeized effects precede callbacks.

**Strongest retained input / provenance:** agent-loan C3-E1/C3-E2; evidence movement candidates. Units: agent-loan, agent-evidence, slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_ClosedFirstReadUnknownAndOtherOwnerAreKept()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)<br>[test_C3KeptIdsStayInvisibleUntilLastMovementCall()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S014. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-028"></a>

## RigAgent.withdrawVoucher:seized-voucher-to-borrower

**Rejected; —; confidence —.**

Gate1: permanent wasSeized is checked before membership, forwarding targets the pool, and factory.create binds msg.sender; borrower=pool is unreachable through this stack.

**Strongest retained input / provenance:** agent-loan destination-address hypothesis. Units: agent-loan, agent-evidence.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_SeizeAndForwardKeepEveryUnconfirmedId()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)<br>[test_ClosedRoutingAndSeizedProtection()](../runs/tests/agent-loan/review/AgentConformance.t.sol) (tests-initial.txt)

<a id="entry-029"></a>

## CreditPolicy._report:successful-malformed-feed-abi

**Rejected; —; confidence —.**

Gate2: caller-side short-data decode escapes catch, but the immutable typed receiver always encodes its480-byte tuple; no malformed producer path exists.

**Strongest retained input / provenance:** policy A01/E03/R11. Units: policy.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [testReview_feedDecodeFailureIsNotCaught_characterization()](../runs/tests/policy/review/PolicyReview.t.sol) (tests-initial.txt)

**Conflict/break rows:** policy:A01 (line48); policy:E03 (line113); policy:R11 (line217).

<a id="entry-030"></a>

## RigAgent._report:successful-malformed-feed-abi

**Rejected; —; confidence —.**

Gate2: same hypothetical decode boundary, but the fixed typed feed cannot return a successful one-byte report.

**Strongest retained input / provenance:** feed consumer boundary; RigAgent.sol:694. Units: feed, agent-evidence.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** Agent _report source trace plus typed RigFeedReceiver.latest source; malformed-feed characterization was executed on the policy/lens consumers. No separate agent short-success reproduction is supplied.

**Conflict/break rows:** policy:A01 (line48); policy:E03 (line113); policy:R11 (line217).

<a id="entry-031"></a>

## TapeLens._pending:successful-malformed-feed-abi

**Rejected; —; confidence —.**

Gate2: the current immutable typed receiver has no path to short successful returndata; synthetically replacing it does not establish an executable production state.

**Strongest retained input / provenance:** lens-factory C-02/N04 feed component. Units: lens-factory.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_completionInvalidPolicyAndFeedABIExplicitBoundary()](../runs/tests/lens-factory/review/CompletionReview.t.sol) (tests-initial.txt)

**Conflict/break rows:** policy:A01 (line48); policy:E03 (line113); policy:R11 (line217).

<a id="entry-032"></a>

## TapeLens._decision:malformed-replacement-abi

**Finding; Low; confidence 75.**

Successful malformed policy answers escape catch; repeated reviews promote this conditional replacement compatibility area.

G1: caller-side decode can revert outside try/catch at both quote entry points; a maxDebt revert with an allowing check also produces inconsistent maxima. G2: no supplied v1 implementation does this; an installed higher-version policy would need to answer the activation probe canonically and another runtime query badly. No normal such policy is established. G3: public quote caller after installation. G4: view-only availability, §4 Low. This is explicitly the §5 two-pass demotion promotion at75, not a claim that arbitrary malformed mocks are a current live exploit. No recommendation while the normal implementation trace is unfinished. Current feed short-data premise is separately rejected at gate2 because that dependency is immutable. Worst quoted principal under hard room500 BEM; no token transfer occurs. Q5 asks for the supported replacement response contract.

**Strongest retained input / provenance:** lens-factory C-02/N04; CRITIC-1/2/3. Units: lens-factory.

**Seen in:** At least 2 tool executions: supplied reviewer/critic characterization and this triage. Exact k/N unavailable from consolidated records. No person has confirmed this disposition.

**Current verification:** [test_completionInvalidPolicyAndFeedABIExplicitBoundary()](../runs/tests/lens-factory/review/CompletionReview.t.sol) (tests-initial.txt)

<a id="entry-033"></a>

## NetlistBuilder.leConst:out-of-width-constant

**Rejected; —; confidence —.**

Gate1: k=32 on five bits truncates semantically, but the only production callers use16/17; all4096 v1 vectors agree.

**Strongest retained input / provenance:** policy M-WIDTH; CRITIC-1/3. Units: policy.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [testReview_comparatorAboveWidth_characterization()](../runs/tests/policy/review/MathCircuitReview.t.sol) (tests-initial.txt)

<a id="entry-034"></a>

## CreditMath.bucket:full-width-numerator

**Rejected; —; confidence —.**

Gate2: the helper counterexample needs expected near uint256.max; production uint64 sane reports/16 rigs/14d bound expected to155929790016000 raw.

**Strongest retained input / provenance:** policy C-01/R1-WIDE/C13. Units: policy.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [testReview_round1FullWidthBucketCounterexampleAndReachableBound()](../runs/tests/policy/review/Round1Review.t.sol) (tests-initial.txt)<br>[testRecheck_adapterReachesExpectedBoundAndRejectsOverflowDebt()](../runs/tests/policy/review/RecheckReview.t.sol) (tests-initial.txt)

<a id="entry-035"></a>

## CreditPolicy._gather:zero-agent-owner-equality

**Rejected; —; confidence —.**

Gate1: real agents are nonzero and independently require ownerOf(id)==this before lend; a hypothetical zero-agent view cannot borrow.

**Strongest retained input / provenance:** policy CRITIC-3 C3-01. Units: policy.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [testCritic3_zeroOwnerOnlyApprovesZeroHypotheticalAgent()](../runs/tests/policy/critic/Pass3Critic.t.sol) (tests-initial.txt)

<a id="entry-036"></a>

## CreditPolicy._rig:nominal-emission-dust

**Rejected; —; confidence —.**

Gate4: the whole-day emission approximation is28512 raw/network/day, about4e-8 relative; no material loss or amplification beyond the85%/80% margin is shown.

**Strongest retained input / provenance:** policy L-02; lens dependency observation. Units: policy, lens-factory.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** No separate executable test supplied for this allegation; source trace and enclosing suites reviewed.

<a id="entry-037"></a>

## CreditPolicy._rig:refbench-external-semantics

**Lead; —; confidence —.**

Registered RefBench mineability and every upstream status/authorization route are not established.

Need a real registered RefBench miner with active status/base/custody and matching screen, or a complete mandatory registration/default-multiplier authorization trace. Current reads show multiplier0 and no miner in bounded censuses; mocks cannot settle mineability. Producer evidence narrows status0/stopped behavior but does not cover every verifier/status or Safe path. No unguarded credit path is established, so repeated mention of this external fact is not a §5 attack-pattern promotion. Worst conditional principal exposure is500 BEM total and90% assets, further limited by backstop and per-borrower caps. A false denial would instead hide eligible credit.

**Strongest retained input / provenance:** policy L-03; agent-loan L-01; evidence outside limits. Units: policy, agent-loan, agent-evidence, deploy.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_LiveRefBenchFirst64RegistrationCensus()](../runs/tests/agent-loan/review/LiveFacts.t.sol) (tests-initial.txt)<br>[test_RedoAllAssignedRefBenchIdsAtOneBlock()](../runs/tests/agent-loan/review/RedoExternal.t.sol) (tests-initial.txt)

<a id="entry-038"></a>

## RigAgent._voucherRecord:inactive-bridged-harvest

**Lead; —; confidence —.**

A stopped-rig producer test narrows the gap, but a real revoked bridged packet and full destination transition remain unproved.

Need a real bridged inactive/revoked harvest through actual source vault/endpoint, inspect power and pending payout, then execute through actual destination endpoint/OFT/voucher. agent-loan Round1Producer tests stopped public state and zero power; it does not settle every revoked transition or forfeiture claim. No exploit path is established. Incorrect positive health could restore at most500 BEM outstanding; incorrect zero evidence could seize loan collateral, at most16 vouchers per agent, with no BEM-denominated cap on their external value. Current-run X Layer403 blocks destination corroboration.

**Strongest retained input / provenance:** agent-evidence V-01/E21; agent-loan L-01/Round1Producer; system D16-06.1. Units: agent-evidence, agent-loan, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_CriticLiveUnitsAcrossTwoProcessorsAndRevokedMiner()](../runs/tests/system/critic/LiveRead.t.sol) (tests-initial.txt)<br>[test_R1LiveHarvestProducerActiveAndStoppedPower()](../runs/tests/agent-loan/review/Round1Producer.t.sol) (tests-initial.txt)

<a id="entry-039"></a>

## TapePool.decimals:cached-asset-metadata-failure

**Lead; —; confidence —.**

A failed token decimals read caches24 share decimals, but no actual completing deployment with such a BEM failure and harmed consumer is established.

Need an EVM-level failure or changed decimals return from the pinned BEM during successful construction, then an affected client operation. An HTTP outage is not such a token failure. Cached18+6=24 persists after token read recovers; successful250/255 answers make display getter addition panic. Raw deposit1e6 still mints1e12 shares, and redemption converts back1e6. Thus no raw loss bound is proved; the hard1000 BEM supply/500 BEM borrow limits still apply to actual accounting. Both subset gates omit a display assertion; no full two-chain gate pass for these fixtures is claimed. Multiple passes corrected an external-read statement, but did not identify a reachable normal token failure; §5 unguarded-path promotion is not met.

**Strongest retained input / provenance:** deploy L2/C4-1; Round4Decimals. Units: deploy.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_critic4_decimalsFailuresUseFallbackAndPassPoolGate()](../runs/tests/deploy/critic/Critic4Evidence.t.sol) (tests-initial.txt)<br>[test_round4_decimalsZeroMaximumAndUint8AdditionBoundaries()](../runs/tests/deploy/review/Round4Decimals.t.sol) (tests-initial.txt)

<a id="entry-040"></a>

## TapePool.lendLimit:fractional-backstop-round-up

**Rejected; —; confidence —.**

Gate1: floor conversion, independent backstop room and final lend recheck reject one raw above the fractional claim.

**Strongest retained input / provenance:** pool-loans CC-01; pool-admin K1. Units: pool-loans, pool-admin.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_backstopFractionalClaimRoundsDownBeforeAdmission()](../runs/tests/pool-loans/review/Round1LoansReview.t.sol) (tests-initial.txt)

<a id="entry-041"></a>

## TapePool._restore:double-release-on-seize

**Rejected; —; confidence —.**

Gate1: partial restoration reduces absorbed once; write-off deletes the rest without booking it again.

**Strongest retained input / provenance:** pool-loans CR3-01. Units: pool-loans, pool-books.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_critic3PartialRestorationThenSeizeDoesNotReleaseIncomeTwice()](../runs/tests/pool-loans/critic/PoolLoansCritic3.t.sol) (tests-initial.txt)

<a id="entry-042"></a>

## TapePool._book:release-schedule-postponement

**Rejected; —; confidence —.**

Gate1: absorb preserves the current end; restore uses the weighted remaining schedule. The hypothesized extra delay is absent.

**Strongest retained input / provenance:** pool-loans CC-02; pool-books critic restore candidates. Units: pool-loans, pool-books.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_partialAbsorptionPreservesOriginalReleaseEnd()](../runs/tests/pool-loans/review/Round1LoansReview.t.sol) (tests-initial.txt)<br>[test_principalRestoreUsesWeightedRemainingReleaseTime()](../runs/tests/pool-loans/review/Round1LoansReview.t.sol) (tests-initial.txt)

<a id="entry-043"></a>

## TapePool.repay:zero-assets-resolution-block

**Rejected; —; confidence —.**

Gate1: repay, clear and write-off operate at zero assets; only new positive lending is denied.

**Strongest retained input / provenance:** pool-loans CC-03. Units: pool-loans.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_zeroAssetsWithOpenDoubtfulLoansIsReachableAndCanResolve()](../runs/tests/pool-loans/review/Round1LoansReview.t.sol) (tests-initial.txt)

<a id="entry-044"></a>

## TapePool.lend:forwarded-income-reserve-base

**Rejected; —; confidence —.**

Gate1: lend checkpoints new cash into equal idle and unvested amounts, so same-block net reserve base does not rise.

**Strongest retained input / provenance:** pool-loans CR3-02. Units: pool-loans.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_critic3ClosedForwardBeforeLendCannotInflateSameBlockBase()](../runs/tests/pool-loans/critic/PoolLoansCritic3.t.sol) (tests-initial.txt)

<a id="entry-045"></a>

## TapePool.maxRedeem:fractional-exit-round-up

**Rejected; —; confidence —.**

Gate1: ordinary finite liquidity conversion floors shares and respects idle; distinct large-range overflow is retained above.

**Strongest retained input / provenance:** pool-loans CR3-04; pool-books floor controls. Units: pool-loans, pool-books.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_maxRedeemFloorsAtNonIntegralScarceIdle()](../runs/tests/pool-books/critic/AccountingCritic.t.sol) (tests-initial.txt)<br>[test_critic3FractionalExitQuotesUseFloorAndExitStillWorks()](../runs/tests/pool-loans/critic/PoolLoansCritic3.t.sol) (tests-initial.txt)

<a id="entry-046"></a>

## TapePool._book:zero-duration-release

**Rejected; —; confidence —.**

Gate1: a weighted average of positive remaining durations is at least one second; booking does not vest instantly.

**Strongest retained input / provenance:** system critic last-second hypothesis. Units: system, pool-books.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_CriticVestingLastSecondNeverReleasesInBookingBlock()](../runs/tests/system/review/R4Checks.t.sol) (tests-initial.txt)

<a id="entry-047"></a>

## RigAgent._accrue:empty-checkpoint-compounding

**Rejected; —; confidence —.**

Gate1: unchanged-principal checkpoints use cumulative ceiling minus lateBooked, not a new rounded fee each call.

**Strongest retained input / provenance:** system CRITIC-4 repeated empty checkpoints. Units: system, agent-loan.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_CriticLateFeeEmptyCheckpointsEqualSingleCeiling()](../runs/tests/system/review/R4Checks.t.sol) (tests-initial.txt)

<a id="entry-048"></a>

## RigReporter.options:standalone-length-cast

**Rejected; —; confidence —.**

Gate1: standalone n narrows before gas arithmetic, but quote/push reject17 ids; no sent packet bypasses the16-id limit.

**Strongest retained input / provenance:** system CQ-02. Units: system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_CriticOptionsNarrowsBeforeCheckedGasArithmetic()](../runs/tests/system/critic/MetadataChecks.t.sol) (tests-initial.txt)

<a id="entry-049"></a>

## TapePool.lendLimit:ratio-excess-equality

**Rejected; —; confidence —.**

Gate4: corrected evidence formula is max(0,L-floor(A*r/10000)); atA550/L500/r9000 the excess is5, not55 BEM.

**Strongest retained input / provenance:** system CQ-01/Q35. Units: system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_CriticRatioExcessWithBackstopAboveOutstanding()](../runs/tests/system/review/R4Completion.t.sol) (tests-initial.txt)

<a id="entry-050"></a>

## RigAgent.borrow:cross-agent-native-callback

**Rejected; —; confidence —.**

Gate1: exact operating-fee callback is last, both principal records are settled, and another no-loan agent sends its own cash to its borrower.

**Strongest retained input / provenance:** system F5-E. Units: system, slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_FreshCrossAgentCallbackSeesSettledBorrow()](../runs/tests/system/critic/FreshChecks.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S091. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-051"></a>

## CreditPolicy._decide:omitted-external-call-in-ledger

**Rejected; —; confidence —.**

Gate4: this was a review-table omission; source calls the capped external evaluator and requires mirror agreement.

**Strongest retained input / provenance:** system F5-G. Units: system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_FreshDecisionCallsExternalEvaluator()](../runs/tests/system/critic/FreshChecks.t.sol) (tests-initial.txt)

<a id="entry-052"></a>

## TapeLens._size:donation-checkpoint-quote-drift

**Rejected; —; confidence —.**

Gate1: checkpoint adds equal idle and unvested income, preserving assets/room/quote at the same timestamp; quoted borrow succeeds.

**Strongest retained input / provenance:** lens-factory C3-C02. Units: lens-factory.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [testFuzz_critic3DonationCheckpointPreservesExecutableQuote(uint256,uint256,uint32)](../runs/tests/lens-factory/critic/Critic3Review.t.sol) (tests-initial.txt)

<a id="entry-053"></a>

## RigAgent.loanOf:original-principal-view

**Rejected; —; confidence —.**

Gate1: original principal remains100000000 while remaining falls to50000000; source field is correct.

**Strongest retained input / provenance:** lens-factory critic E2. Units: lens-factory.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_criticLoanOriginalPrincipalAfterPartialRepaymentBothTerms()](../runs/tests/lens-factory/critic/CriticReview.t.sol) (tests-initial.txt)

<a id="entry-054"></a>

## TapePool.stats:missing-nonzero-field-evidence

**Rejected; —; confidence —.**

Gate1: strengthened nonzero fixtures confirm the six fields and cap changes; the source has no omitted field.

**Strongest retained input / provenance:** lens-factory critic E3. Units: lens-factory.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_round1StatsEveryFieldNonzeroBrakedAndChangedCaps()](../runs/tests/lens-factory/review/Round1Review.t.sol) (tests-initial.txt)<br>[test_criticStatsEveryFieldInNonzeroAndBrakeStates()](../runs/tests/lens-factory/critic/CriticReview.t.sol) (tests-initial.txt)

<a id="entry-055"></a>

## TapeLens._blocker:reason-code-abi

**Rejected; —; confidence —.**

Gate1: independent numeric checks confirm reason values0–16; earlier shared-constant testing was weak, not a code defect.

**Strongest retained input / provenance:** lens-factory critic E4. Units: lens-factory.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_round1LiteralReasonsZeroThroughSixteen()](../runs/tests/lens-factory/review/Round1Review.t.sol) (tests-initial.txt)<br>[test_criticLiteralReasonCodeABI()](../runs/tests/lens-factory/critic/CriticReview.t.sol) (tests-initial.txt)

<a id="entry-056"></a>

## TapePool._write:parameter-field-isolation

**Rejected; —; confidence —.**

Gate1: each of14 bounded keys writes only its own field; queue writes no live value.

**Strongest retained input / provenance:** pool-admin K4. Units: pool-admin.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_critic_each_parameter_write_preserves_other_thirteen_fields()](../runs/tests/pool-admin/critic/PoolAdminCritic.t.sol) (tests-initial.txt)<br>[test_round1_each_parameter_write_preserves_all_other_thirteen_fields()](../runs/tests/pool-admin/review/PoolAdminRound1.t.sol) (tests-initial.txt)

<a id="entry-057"></a>

## TapePool._checkPolicy:version-read-order

**Rejected; —; confidence —.**

Gate4: observed current.version then candidate.version changes only error precedence; there is no admission bypass.

**Strongest retained input / provenance:** pool-admin K6. Units: pool-admin.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_critic_version_comparison_reads_current_policy_first()](../runs/tests/pool-admin/critic/PoolAdminCritic.t.sol) (tests-initial.txt)

<a id="entry-058"></a>

## TapePool.activatePolicy:malformed-answer-rollback

**Rejected; —; confidence —.**

Gate1: dirty bool/reason/bits or short tuple reverts atomically and preserves queue, policy, tracked and unvested state.

**Strongest retained input / provenance:** pool-admin C3-K4. Units: pool-admin.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_c3_malformed_policy_outputs_preserve_queue_and_income()](../runs/tests/pool-admin/critic/PoolAdminCritic3.t.sol) (tests-initial.txt)

<a id="entry-059"></a>

## TapePool.cancelPolicy:stale-slot-execution

**Rejected; —; confidence —.**

Gate1: expired activation reverts QueueLapsed; cancellation clears the slot and cannot shorten a new queue.

**Strongest retained input / provenance:** pool-admin C3-K3. Units: pool-admin.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_c3_stale_policy_cancel_and_failed_activation_event_paths()](../runs/tests/pool-admin/critic/PoolAdminCritic3.t.sol) (tests-initial.txt)

<a id="entry-060"></a>

## TapePool.setGuardian:former-role-authority

**Rejected; —; confidence —.**

Gate1: authority is read dynamically; prior guardian/owner loses access and a queued policy prevents unpause in either order.

**Strongest retained input / provenance:** pool-admin K3. Units: pool-admin.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_access_matrix_outsider_guardian_pending_owner()](../runs/tests/pool-admin/review/PoolAdmin.t.sol) (tests-initial.txt)<br>[test_queues_survive_ownership_transfer_and_guardian_rotation()](../runs/tests/pool-admin/review/PoolAdmin.t.sol) (tests-initial.txt)

<a id="entry-061"></a>

## TapePool.queuePolicy:announced-candidate-eta

**Rejected; —; confidence —.**

Gate1: indexed candidate and eta equal the queued values; lowerCap cancellation and independent queue slots are correct.

**Strongest retained input / provenance:** pool-admin K5. Units: pool-admin.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_round1_checkpoint_precedes_policy_probe_and_public_events()](../runs/tests/pool-admin/review/PoolAdminRound1.t.sol) (tests-initial.txt)

<a id="entry-062"></a>

## TapePool._checkpoint:admin-income-double-book

**Rejected; —; confidence —.**

Gate1: surplus is booked exactly once, with no-share income in reserve; failed calls roll all checkpoint effects back.

**Strongest retained input / provenance:** pool-admin K2. Units: pool-admin.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_critic_checkpoint_blends_active_income_and_preserves_doubt()](../runs/tests/pool-admin/critic/PoolAdminCritic.t.sol) (tests-initial.txt)

<a id="entry-063"></a>

## TapePool._feedSettling:epoch-and-uint64-horizon

**Rejected; —; confidence —.**

Gate2: the initial360 Unix seconds and uint64 timestamp horizon are outside these live chains; saturating expiry does not wrap.

**Strongest retained input / provenance:** pool-admin CRITIC-3 domain probes. Units: pool-admin.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_freeze_no_brake_edges_and_saturation()](../runs/tests/pool-admin/review/PoolAdmin.t.sol) (tests-initial.txt)

<a id="entry-064"></a>

## RigAgent._impairment:pre-cure-evidence-after-shield-loss

**Rejected; —; confidence —.**

Gate1: losing S at a brake does not remove the impairedAt+72h+60 floor; floor-minus-one remains rejected.

**Strongest retained input / provenance:** pool-admin C3-K2. Units: pool-admin, agent-evidence.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_c3_shield_loss_does_not_admit_pre_cure_zero_record()](../runs/tests/pool-admin/critic/PoolAdminCritic3.t.sol) (tests-initial.txt)

<a id="entry-065"></a>

## RigAgent.flagImpaired:omitted-late-accrual

**Rejected; —; confidence —.**

Gate1: source accrues before the funded waterfall and rounds up; earlier tests missed the discriminator, repaired tests pass.

**Strongest retained input / provenance:** agent-evidence CRITIC-1 L14/P25. Units: agent-evidence.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_CriticFlagAccruesBeforePartialWaterfall()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_CriticFlagRoundsLateFeeUpAtOneSecond()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)

<a id="entry-066"></a>

## RigAgent.seize:omitted-late-accrual

**Rejected; —; confidence —.**

Gate1: source accrues before NoDebt and loss settlement; funded test confirms remaining principal and reserve cover.

**Strongest retained input / provenance:** agent-evidence CRITIC-1 L45. Units: agent-evidence.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)

<a id="entry-067"></a>

## TapePool.fee:pending-backlog-waives-fee

**Rejected; —; confidence —.**

Gate1: the fixed fee is stored and paid even with prefunded pending output and early repayment.

**Strongest retained input / provenance:** feed RC-01. Units: feed.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_round1BacklogCannotWaiveStoredOrPaidFlatFee()](../runs/tests/feed/review/Round1Coverage.t.sol) (tests-initial.txt)

<a id="entry-068"></a>

## CreditPolicy._rig:missing-processor-alternative

**Rejected; —; confidence —.**

Gate1: all three immutable processor alternatives set the eligibility bit independently; actual RefBench mineability remains a separate lead.

**Strongest retained input / provenance:** feed RC-02; lens-factory E1. Units: feed, lens-factory.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_round1EachProcessorAlternativeIndependentlyAdmits()](../runs/tests/feed/review/Round1Coverage.t.sol) (tests-initial.txt)<br>[test_round1AllThreeProcessorsBorrowBothTerms()](../runs/tests/lens-factory/review/Round1Review.t.sol) (tests-initial.txt)

<a id="entry-069"></a>

## RigAgent._plusSkew:evidence-floor-wrap

**Rejected; —; confidence —.**

Gate1: actual enable/seize/evidence floors saturate at uint64.max, including the no-flag sentinel.

**Strongest retained input / provenance:** feed RC-03. Units: feed.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_round1Uint64SaturationEnableSeizeAndNoFlagSentinel()](../runs/tests/feed/review/Round1Coverage.t.sol) (tests-initial.txt)

<a id="entry-070"></a>

## RigAgent.borrow:permissive-policy-ownership-bypass

**Rejected; —; confidence —.**

Gate1: nonempty collateral and ownership checks run independently of the replacement policy before factory-gated lend.

**Strongest retained input / provenance:** feed RC-04; system rogue-policy tests. Units: feed, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_round1ApprovingPolicyCannotBypassAgentOwnership()](../runs/tests/feed/review/Round1Coverage.t.sol) (tests-initial.txt)<br>[test_I04_I11_I14_collateralAndRoguePolicy()](../runs/tests/system/review/SystemReview.t.sol) (tests-initial.txt)

<a id="entry-071"></a>

## TapePool.lend:feed-off-borrow

**Rejected; —; confidence —.**

Gate1: agent and pool independently reject while disabled and pool room is(0,5); pause=false does not bypass the feed brake.

**Strongest retained input / provenance:** feed RC-05. Units: feed.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_round1DisabledFeedRejectsBorrowLendAndLimit()](../runs/tests/feed/review/Round1Coverage.t.sol) (tests-initial.txt)<br>[test_redoAgentRejectsDisabledFeedBeforeFeeOrPoolLend()](../runs/tests/feed/review/RedoAdmission.t.sol) (tests-initial.txt)

<a id="entry-072"></a>

## RigReporter.setPeer:rotation-ignored

**Rejected; —; confidence —.**

Gate1: before lock, last distinct peer wins; after lock, updates reject; receiver authenticates the current peer.

**Strongest retained input / provenance:** feed RC-06 reporter. Units: feed.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_round1DistinctPeersBothOrdersAuthenticateAndRestore()](../runs/tests/feed/review/Round1Coverage.t.sol) (tests-initial.txt)

<a id="entry-073"></a>

## RigFeedReceiver.setPeer:rotation-ignored

**Rejected; —; confidence —.**

Gate1: receiver applies last distinct peer before lock and denies unauthorized old peers.

**Strongest retained input / provenance:** feed RC-06 receiver. Units: feed.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_round1DistinctPeersBothOrdersAuthenticateAndRestore()](../runs/tests/feed/review/Round1Coverage.t.sol) (tests-initial.txt)

<a id="entry-074"></a>

## RigReporter.lock:already-pinned-library

**Rejected; —; confidence —.**

Gate3: authorized setup can unpin then lock after SameValue; no outsider bypass or permanent loss is established. Current fork retry limited by X Layer.

**Strongest retained input / provenance:** feed critic pre-pinned candidate. Units: feed.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_round1AlreadyPinnedSameLibraryDataRecoveryAndBothOrders()](../runs/tests/feed/review/Round1Coverage.t.sol) (tests-gates-retry.txt)

<a id="entry-075"></a>

## RigFeedReceiver.lock:already-pinned-library

**Rejected; —; confidence —.**

Gate3: same recoverable pre-lock configuration issue; authority is not silently dropped before the revert.

**Strongest retained input / provenance:** feed critic pre-pinned candidate. Units: feed.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_round1AlreadyPinnedSameLibraryDataRecoveryAndBothOrders()](../runs/tests/feed/review/Round1Coverage.t.sol) (tests-gates-retry.txt)

<a id="entry-076"></a>

## RigFeedReceiver.lock:old-library-timeout

**Rejected; —; confidence —.**

Gate1: setReceiveLibrary with grace0 clears prior timeout and lock removes delegate; the targeted current rerun passes timeout removal and denied restoration.

**Strongest retained input / provenance:** feed CRITIC-3 C3-03; FeedLock and pinned dependency trace. Units: feed.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_critic3LockDeletesExistingReceiveTimeoutAndRejectsRestoration()](../runs/tests/feed/critic/Critic3Timeout.t.sol) (tests-retry.txt)

<a id="entry-077"></a>

## BscRigReader.read:ignored-miner-metadata

**Rejected; —; confidence —.**

Gate1: ignored metadata does not enter loan inputs; typed decoding still rejects13 malformed narrow words. No wrong used field is shown.

**Strongest retained input / provenance:** feed ignored Miner/Context candidates. Units: feed.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_round1CanonicalUnusedMinerFieldsCannotChangeReport()](../runs/tests/feed/review/Round1Coverage.t.sol) (tests-initial.txt)<br>[test_round1NoncanonicalUnusedMinerFieldsStillAbortDecoding()](../runs/tests/feed/review/Round1Coverage.t.sol) (tests-initial.txt)

<a id="entry-078"></a>

## BscRigReader.read:raw-bonus-normalization

**Rejected; —; confidence —.**

Gate1: current reader uses weight minus min(weight,bstar*mult);456 weight yields432 normalized bonus and24 base. Wrong-build gate is separate.

**Strongest retained input / provenance:** feed bonus controls; deploy F02 distinction. Units: feed, deploy, agent-evidence.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_pipelineSameFeedAndNormalizedBaseDetermineActualExpectedDebt()](../runs/tests/feed/critic/Critic3Sequences.t.sol) (tests-initial.txt)<br>[testFuzz_readerBaseUsesSameUnits(uint64,uint64,uint32)](../runs/tests/feed/review/FeedConformance.t.sol) (tests-initial.txt)

<a id="entry-079"></a>

## CheckStack.readTapeOut:expect-call-not-enforced

**Rejected; —; confidence —.**

Gate1: vm.expectCall is enforced when forge script ends; an internal return before that failure is not a passed gate.

**Strongest retained input / provenance:** deploy expected-call hypothesis/GateDryRun.s.sol. Units: deploy.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [GateDryRun.s.sol](../runs/tests/deploy/review/GateDryRun.s.sol), [output](../runs/gate-dry-run.txt): expected exit1, required call1 / actual0.

<a id="entry-080"></a>

## CheckStack.checkOnForks:historical-helper-bypass

**Rejected; —; confidence —.**

Gate1: the full gate rejects four retired feed identities; checkPool is a subset and checkReusedFeed is not called by the production entry.

**Strongest retained input / provenance:** deploy historical/subset candidates. Units: deploy.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_R4_06_checkOnForksRefusesTheFirstReceiver()](../../../../test/unit/Redeploy4Scripts.t.sol) (tests-original-unit.txt)<br>[test_R4_06_checkOnForksRefusesTheSecondReporter()](../../../../test/unit/Redeploy4Scripts.t.sol) (tests-original-unit.txt)

<a id="entry-081"></a>

## CheckOldStack.run:arbitrary-range-census

**Rejected; —; confidence —.**

Gate1: production run pins the third stack/start block; arbitrary helper inputs are not its call path. Current full census could not reread RPC pages.

**Strongest retained input / provenance:** deploy incomplete old-factory scan candidate. Units: deploy.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** OldStackCensus.test_completeThirdFactoryScanWithOldAgentReadback: attempted, RPC page failure; fixed-range source trace and local page controls reviewed.

<a id="entry-082"></a>

## CheckStack.checkPool:pre-seed-donation

**Rejected; —; confidence —.**

Gate4: with no shares, synchronized donations become reserve; zero idle/supply with positive tracked/reserve is valid and no caller can withdraw it.

**Strongest retained input / provenance:** deploy pre-seed candidate. Units: deploy.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_N01_checkStackAcceptsSyncedPreSeedDonation()](../../../../test/unit/DeployScripts.t.sol) (tests-original-unit.txt)

<a id="entry-083"></a>

## CheckStack.checkPoolSeeded:negligible-backstop-seed

**Rejected; —; confidence —.**

Gate4: source enforces nonzero backstop and later lend enforces its actual claim; approximate10 BEM deployment prose is not a bypass of an exact hard minimum.

**Strongest retained input / provenance:** deploy seed-boundary/cover-drift candidate. Units: deploy.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_RA18_backstopBoundaryAndOrdinaryLenderExit()](../../../../test/unit/RedeployPool.t.sol) (tests-original-unit.txt)

<a id="entry-084"></a>

## FeedProbe.setupReceiver:prototype-order-and-owner

**Rejected; —; confidence —.**

Gate2: separate legacy spike contracts are not the production feed; repeated setup can mismatch peers, but production CheckFeed rejects retained owner.

**Strongest retained input / provenance:** deploy legacy/prototype setup candidates. Units: deploy.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_legacyPrototypeSessionAndStatusBranches()](../runs/tests/deploy/review/Round1Modes.t.sol) (tests-initial.txt)<br>[test_recheck_prototypeSetupCanPrecedeProductionReporterCreation()](../runs/tests/deploy/review/RecheckPrototype.t.sol) (tests-initial.txt)

<a id="entry-085"></a>

## FeedProbe.status:prototype-arithmetic

**Rejected; —; confidence —.**

Gate2: prototype raw-bonus/future-time diagnostic panics have no production deployment path; production status saturates.

**Strongest retained input / provenance:** deploy prototype raw bonus/future timestamp. Units: deploy.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_statusReadBranchesAndSubtractionSaturates()](../runs/tests/deploy/review/ManifestReview.t.sol) (tests-initial.txt)<br>[test_legacyPrototypeSessionAndStatusBranches()](../runs/tests/deploy/review/Round1Modes.t.sol) (tests-initial.txt)

<a id="entry-086"></a>

## FeedConfig.mirror:setup-order-confirmations

**Rejected; —; confidence —.**

Gate1: official deployment mirrors/locks before sending; send-before-mirror21 versus20 confirmations is outside that entry sequence, not a hidden live downgrade.

**Strongest retained input / provenance:** deploy mirror/send/NIL candidate. Units: deploy.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [testFuzz_nilSentinelsPreserveNonzeroFields(uint64,uint8,uint8,uint8)](../runs/tests/deploy/review/Round4Decimals.t.sol) (tests-initial.txt)<br>[test_bothRealEndpointsMirrorAndLockIrreversibly()](../runs/tests/deploy/critic/CriticGate.t.sol) (tests-initial.txt)

<a id="entry-087"></a>

## RigReporter.push:batch-read-error-suppression

**Rejected; —; confidence —.**

Gate1: readable16/15/0 produce1/1/0 packets; unrelated errors propagate and batch size guards remain.

**Strongest retained input / provenance:** deploy batching/read-error candidate. Units: deploy.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_manifestUnrelatedEmptyShortBatchAndPushErrorsPropagate()](../runs/tests/deploy/review/ManifestReview.t.sol) (tests-initial.txt)

<a id="entry-088"></a>

## CheckStack.readTapeOut:inactive-sample-rejects-gate

**Lead; —; confidence —.**

The unclamped sample equality can reject a legitimate impaired rig, but an otherwise-valid launch exclusion was not established.

Need an otherwise valid complete launch with rig5 in a real inactive/zero-weight state, demonstrating rejection solely at the equality verifWeight-bonus==bstar*mult. Current reader clamps base correctly; the gate comparison does not. The scope is deployment availability, not borrowing against invented base. Worst effect is inability to pass the launch gate until the sample/check changes; no direct BEM loss.

**Strongest retained input / provenance:** deploy inactive sample observation. Units: deploy.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** Source readTapeOut comparison; no complete inactive-launch reproduction supplied. Existing reader inactive control passes, but does not complete this lead.

<a id="entry-089"></a>

## RigAgent._accrue:late-face-value

**Accepted risk; —; confidence —.**

SPEC §16 “PO-3, late fee 0 at launch”: inside: slow loans are not impaired solely by maturity; zero late rate gives no compensation. Later rates are snapshotted.

**Strongest retained input / provenance:** unit accepted-risk sections. Units: agent-loan, agent-evidence, pool-loans, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_CriticFlagRoundsLateFeeUpAtOneSecond()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_LateRateCanExecuteBeforeDecember7()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)

<a id="entry-090"></a>

## TapePool.fee:minimum-fee-subsidy

**Accepted risk; —; confidence —.**

SPEC §16 “PO-4, `minFee` below one harvest’s cost”: inside on-chain fee routing; keeper funding and spending are unverified off-chain obligations.

**Strongest retained input / provenance:** unit accepted-risk sections. Units: agent-loan, feed, policy, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_FeeCeilingAboveMinimumOnBothTerms()](../runs/tests/agent-loan/review/AgentOps.t.sol) (tests-initial.txt)<br>[test_round1DisabledFeedRejectsBorrowLendAndLimit()](../runs/tests/feed/review/Round1Coverage.t.sol) (tests-initial.txt)

<a id="entry-091"></a>

## RigReporter.push:unbounded-sponsored-loan-count

**Accepted risk; —; confidence —.**

SPEC §16 “Sponsorship subsidy”: inside: reusable/self-pushed reports do not cap loan count; no keeper implementation is supplied to verify quotas or spend alerts.

**Strongest retained input / provenance:** system R16-03; agent-loan accepted risks. Units: agent-loan, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_reporterBatchBoundsQuotePushAndSixteenRoundtrip()](../runs/tests/feed/review/FeedConformance.t.sol) (tests-initial.txt)

<a id="entry-092"></a>

## RigAgent.sweep:unharvested-safe-rescue-output

**Accepted risk; —; confidence —.**

SPEC §16 “The keeper harvests once at maturity”: inside the trusted-Safe mechanism; quoted8/4 BEM are launch caps, while hard principal exposure is500 BEM and collateral/output value is not capped by that number. Keeper early-harvest execution is unverified.

**Strongest retained input / provenance:** system R16-04; evidence accepted risks. Units: agent-evidence, deploy, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_realRescueAndMissingReadsFailClosed()](../runs/tests/deploy/critic/CriticGate.t.sol) (tests-initial.txt)<br>[test_flag_on_a_rescued_report_marks_doubtful()](../../../../test/unit/RigAgent.t.sol) (tests-original-unit.txt)

<a id="entry-093"></a>

## CreditPolicy._rig:screen-error-credit-loss

**Accepted risk; —; confidence —.**

SPEC §16 “`MIN_RIG_AGE` 3 days, with the Q16 screen (2026-10-21)”: inside: age is calendar time and a screen error can lose admitted debt; hard total principal500 BEM, v1 debt sizing85%/80%. The proof tool/historical12 revocations are not supplied.

**Strongest retained input / provenance:** policy accepted risks; system R16-05. Units: policy, agent-evidence, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_policyAgeExactlyThreeDaysAndPendingNeverSizesDebt()](../runs/tests/feed/critic/Critic3Sequences.t.sol) (tests-initial.txt)<br>[test_realPolicyAgeScreenBonusAndHalvingDenyBeforeLend()](../runs/tests/pool-loans/review/PolicyLoansReview.t.sol) (tests-initial.txt)

<a id="entry-094"></a>

## TapePool.markDoubtful:deposit-gate-liveness

**Accepted risk; —; confidence —.**

SPEC §16 “Deposit gate (§11.1)”: inside: marks close positive entry until resolution; overlapping bad rigs can prolong it. At hard minAdvance1 BEM the launch0.01 example is not a universal bound.

**Strongest retained input / provenance:** books/evidence accepted risks. Units: pool-books, agent-evidence, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_partialRestoreStillClosesDeposits()](../runs/tests/pool-books/critic/AccountingCritic.t.sol) (tests-initial.txt)<br>[test_R1_distinctPayerDepositAndMint()](../runs/tests/pool-books/review/Round1Review.t.sol) (tests-initial.txt)

<a id="entry-095"></a>

## RigAgent._verdict:stored-bu-block

**Accepted risk; —; confidence —.**

SPEC §16 “Stored impaired report blocks a clear (row B, redeploy 3)”: inside for B/U retaining a block, including feed-off and stale data; stale healthy overwrite opening it is separately retained as a finding.

**Strongest retained input / provenance:** evidence C-03/P14; system C-02. Units: agent-evidence, feed, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_C3_StaleHealthyOtherRigBecomesMissingButBrakeUnknownNeverAgesOut()](../runs/tests/agent-evidence/critic/Critic3Independent.t.sol) (tests-initial.txt)<br>[test_C3_StaleShieldLostAtBrakeHasExactlyAcceptedSeizeEffect()](../runs/tests/agent-evidence/critic/Critic3Independent.t.sol) (tests-initial.txt)

**Conflict/break rows:** agent-evidence:P14 (line214); system:T8-Feed.2 (line235).

<a id="entry-096"></a>

## RigAgent._report:dead-versus-unreadable-feed

**Accepted risk; —; confidence —.**

SPEC §16 “Dead feed with a flagged, rescued rig”: inside: a dead but readable feed retains B/U; a reverting feed leaves no report candidate. A marked rescued rig may keep deposits closed indefinitely.

**Strongest retained input / provenance:** evidence/system accepted risks. Units: agent-evidence, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_S16_feedUnreadableDiffersFromDeadFeed()](../runs/tests/system/review/SystemReview.t.sol) (tests-initial.txt)

<a id="entry-097"></a>

## TapePool.maxWithdraw:unmarked-impairment-exit

**Accepted risk; —; confidence —.**

SPEC §16 “Rescue seen on BSC first”: inside: an existing holder exits before a flag, including during brakes, bounded by its claim/idle; reserve is not a maximum lender loss.

**Strongest retained input / provenance:** system/evidence accepted risks. Units: pool-books, agent-evidence, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_orderFlagAndWithdrawChangesExitValueAsAccepted()](../runs/tests/pool-books/review/BooksReview.t.sol) (tests-initial.txt)

<a id="entry-098"></a>

## RigAgent._impairment:stale-shield-and-brake-loss

**Accepted risk; —; confidence —.**

SPEC §16 “Feed re-enable pauses live flags”: inside: stale sane S can shield older VE while on; brakes remove S and can allow seizure if the post-cure VE floor already holds. Pre-cure bypass is rejected separately.

**Strongest retained input / provenance:** agent-evidence C-03; system C-02; pool-admin C3-K2. Units: pool-admin, agent-evidence, feed, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_C3_StaleShieldLostAtBrakeHasExactlyAcceptedSeizeEffect()](../runs/tests/agent-evidence/critic/Critic3Independent.t.sol) (tests-initial.txt)<br>[test_c3_shield_loss_does_not_admit_pre_cure_zero_record()](../runs/tests/pool-admin/critic/PoolAdminCritic3.t.sol) (tests-initial.txt)

**Conflict/break rows:** agent-evidence:P14 (line214); system:T8-Feed.2 (line235).

<a id="entry-099"></a>

## TapePool.disableFeed:repeated-live-flag-freeze

**Accepted risk; —; confidence —.**

SPEC §16 “Feed re-enable pauses live flags”: inside: repeated brakes prolong live expiry and deposit closure, never cure time or an already expired flag.

**Strongest retained input / provenance:** pool-admin/evidence/system accepted risks. Units: pool-admin, agent-evidence, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_c3_expired_history_keeps_reflag_floor_through_later_brakes()](../runs/tests/pool-admin/critic/PoolAdminCritic3.t.sol) (tests-initial.txt)<br>[test_exit_paths_all_sixteen_combinations_of_brakes_and_caps()](../runs/tests/pool-admin/review/PoolAdminStates.t.sol) (tests-initial.txt)

<a id="entry-100"></a>

## RigAgent._verdict:bonus-only-positive-record

**Accepted risk; —; confidence —.**

SPEC §16 “Bonus in path (b) health”: inside when a newer VC wins and no rig is impaired; B/ties still block. Later flag/clear cycles are accepted; no blanket waiver for older VC resurrection.

**Strongest retained input / provenance:** agent-evidence accepted risks. Units: agent-evidence, agent-loan, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_E_H_B_U_S_VE_VC_DirectedBoundaries()](../runs/tests/agent-evidence/review/EvidenceReview.t.sol) (tests-initial.txt)<br>[test_R3_05_aNewerPositiveRecordOvertakesRowB()](../../../../test/unit/Redeploy3StoredImpaired.t.sol) (tests-original-unit.txt)

<a id="entry-101"></a>

## TapePool._book:post-seize-income-sharing

**Accepted risk; —; confidence —.**

SPEC §16 “Income release after seize”: inside: later entrants share later seized income over VEST and early exits leave unreleased income. Restoration beyond the stated122 bound is a separate entry.

**Strongest retained input / provenance:** system/evidence/books accepted risks. Units: pool-books, agent-evidence, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

<a id="entry-102"></a>

## TapePool.lendLimit:admission-only-backstop

**Accepted risk; —; confidence —.**

SPEC §16 “Backstop wait after a loss”: inside the admission rule; losses/withdrawals can reduce cover afterward. Seed retention, alerts and later top-ups remain operational gaps, not proven promises.

**Strongest retained input / provenance:** unit accepted risks. Units: pool-loans, pool-admin, agent-evidence, deploy, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_backstopRoomBoundaryAndPostAdmissionWithdrawal()](../runs/tests/pool-loans/review/PoolLoansReview.t.sol) (tests-initial.txt)

<a id="entry-103"></a>

## RigAgent.flagImpaired:rescued-rig-feed-off

**Accepted risk; —; confidence —.**

SPEC §16 “Rescued rig while the feed is off”: inside: E is disabled, rescued rigs cannot harvest VE, and keeper re-enable/push is required. B/U still block clears.

**Strongest retained input / provenance:** evidence/system accepted risks. Units: agent-evidence, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_flag_on_a_rescued_report_marks_doubtful()](../../../../test/unit/RigAgent.t.sol) (tests-original-unit.txt)<br>[test_R4_03_rowBRecordMatrixFeedOff()](../../../../test/unit/Redeploy4Evidence.t.sol) (tests-original-unit.txt)

<a id="entry-104"></a>

## RigFeedReceiver._lzReceive:verification-gap-lock

**Accepted risk; —; confidence —.**

SPEC §16 “Feed liveness after `lock` (Phase 3 part A, 2026-10-19)”: inside: unordered app delivery does not bypass endpoint verification continuity; owner/delegate zero prevents skipping the gap. Current full fork revalidation is blocked.

**Strongest retained input / provenance:** system F5-C; deploy/feed accepted risks. Units: feed, deploy, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** No separate executable test supplied for this allegation; source trace and enclosing suites reviewed.

<a id="entry-105"></a>

## RigScreen.suspendPass:future-pass-presuspension

**Accepted risk; —; confidence —.**

SPEC §16 “Guardian pre-suspension (Phase 3 part A, 2026-10-19)”: inside: guardian can pre-suspend ids, but only owner lifts/rotates and no asset/loan moves.

**Strongest retained input / provenance:** policy/admin/system accepted risks. Units: policy, pool-admin, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_CriticSuspendLiftAndBorrowHaveSpecifiedOrderEffects()](../runs/tests/system/review/R4Checks.t.sol) (tests-initial.txt)<br>[testReview_suspensionDoesNotRepriceOpenLoanOrBlockRepay()](../runs/tests/policy/review/PolicyReview.t.sol) (tests-initial.txt)

<a id="entry-106"></a>

## RigAgent._voucherRecord:future-record-becomes-evidence

**Accepted risk; —; confidence —.**

SPEC §16 “Future-dated voucher record (redeploy 3)”: inside: a Safe-upgraded record becomes known within60 seconds of its timestamp; post-cure floor still applies. No extra freshness promise is inferred.

**Strongest retained input / provenance:** evidence/system accepted risks. Units: agent-evidence, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_VoucherRecordLengthsFutureRevertGasAndMaximumPower()](../runs/tests/agent-evidence/review/EvidenceReview.t.sol) (tests-initial.txt)<br>[test_R3_03_rowVC_futureRecordIsMissingNotHealth()](../../../../test/unit/Redeploy3FutureRecord.t.sol) (tests-original-unit.txt)

<a id="entry-107"></a>

## RigAgent.forwardVouchers:safe-returned-unlisted-voucher

**Accepted risk; —; confidence —.**

SPEC §16 “Seized voucher returned by the Safe (redeploy 3)”: inside: an unlisted seized id returned to a closed agent stays protected from borrower withdrawal; only the external Safe can recover it.

**Strongest retained input / provenance:** agent-loan/evidence accepted risks. Units: agent-loan, agent-evidence, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_ClosedRoutingAndSeizedProtection()](../runs/tests/agent-loan/review/AgentConformance.t.sol) (tests-initial.txt)

<a id="entry-108"></a>

## TapePool.activatePolicy:arbitrary-policy-within-caps

**Accepted risk; —; confidence —.**

SPEC §16 “A policy swap can approve loans up to the caps (§9.2, the owner’s decision of 2026-11-05)”: inside: seven-day paused queue, independent ownership,500 BEM/90% hard limits and backstop still hold; v1 expected-output ceiling is not universal after replacement.

**Strongest retained input / provenance:** system C-07/F5-F; agent-loan P-Debt. Units: agent-loan, pool-admin, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_FreshReplacementDebtExceedsZeroBaseOutput()](../runs/tests/system/critic/FreshChecks.t.sol) (tests-initial.txt)

**Conflict/break rows:** agent-loan:P-Debt (line174); system:T8-Debt_and_maturity.1 (line206).

<a id="entry-109"></a>

## RigFeedReceiver._lzReceive:same-second-first-report

**Accepted risk; —; confidence —.**

SPEC §16 “Same-second reports (§6, the owner’s decision of 2026-11-04)”: inside: strictly increasing timestamps retain the first report in one second; a later-second push can correct it and H ages out after300 seconds.

**Strongest retained input / provenance:** feed equal-time controls. Units: feed, agent-evidence, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_receiverOlderEqualNeverReplaceIncludingSameSecondImpairment()](../runs/tests/feed/review/FeedConformance.t.sol) (tests-initial.txt)

<a id="entry-110"></a>

## RigAgent.clearExpiredFlag:older-other-rig-missing

**Accepted risk; —; confidence —.**

SPEC §16 “A report older than the floor on another rig (§10.5, the owner’s decision of 2026-11-04)”: inside: pre-floor other-rig B is missing, clear can restore the whole loan, and a holder can exit before fresh reflag at clear+60.

**Strongest retained input / provenance:** system F5-A; evidence accepted risks. Units: agent-evidence, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_FreshOldImpairedOtherRigClearsThenNeedsNewFlagEvidence()](../runs/tests/system/critic/FreshChecks.t.sol) (tests-initial.txt)

<a id="entry-111"></a>

## TapePool.lendLimit:self-funded-ratio-exit

**Accepted risk; —; confidence —.**

SPEC §16 “Percentage ratios after a self-funded deposit (§11.3, the owner’s decision of 2026-11-04)”: inside: ratios are admission checks; max excess at90% is50 BEM at500 lent/500 remaining assets. Independent backstop room still binds.

**Strongest retained input / provenance:** system CQ-01; unit accepted risks. Units: pool-loans, pool-admin, deploy, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_CriticRatioExcessWithBackstopAboveOutstanding()](../runs/tests/system/review/R4Completion.t.sol) (tests-initial.txt)<br>[test_S16_SelfFundedDepositLaunchRatioIsEightyPercent()](../runs/tests/system/review/OrderAndRisk.t.sol) (tests-initial.txt)

<a id="entry-112"></a>

## TapePool.repay:stored-reserve-base

**Accepted risk; —; confidence —.**

SPEC §16 “Reserve base is stored at `lend`”: inside: pre-lend deposits widen the stored base; later deposits/withdrawals do not resize it. Per-payment reserve fragmentation is not accepted by this row.

**Strongest retained input / provenance:** pool-loans/admin/system accepted risks. Units: pool-loans, pool-admin, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_reserveCapBindingAfterAssetsMoveUsesStoredBase()](../runs/tests/pool-loans/review/Round1LoansReview.t.sol) (tests-initial.txt)<br>[test_orderLendClearRestoredPrincipalChangesNewReserveBase()](../runs/tests/pool-loans/review/PoolLoansReview.t.sol) (tests-initial.txt)

<a id="entry-113"></a>

## CreditPolicy._rig:duplicate-circuit-after-safe-action

**Accepted risk; —; confidence —.**

SPEC §16 “Two vault ids for one circuit after `rescueFromCell`”: inside the stated Safe dependency: duplicate sizing/redeeming under a loan can precede detection. Off-chain refusal/monitoring and actual complete Safe authorization were not audited here.

**Strongest retained input / provenance:** deploy/evidence/system accepted risks. Units: policy, deploy, agent-evidence, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_realRescueAndMissingReadsFailClosed()](../runs/tests/deploy/critic/CriticGate.t.sol) (tests-initial.txt)<br>[test_flag_on_a_rescued_report_marks_doubtful()](../../../../test/unit/RigAgent.t.sol) (tests-original-unit.txt)

<a id="entry-114"></a>

## RigAgent._verdict:positive-record-without-custody

**Accepted risk; —; confidence —.**

SPEC §16 “A positive voucher record means active with weight, not in custody”: inside: Safe action plus a missed seize can permit a newer positive record to clear. Current positive-record fork reproduction is blocked, not independently confirmed live.

**Strongest retained input / provenance:** system PositiveRecordFork; evidence accepted risks. Units: agent-evidence, system.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_live_PositiveRecordAfterCustodyLossClearsExpiredFlag()](../runs/tests/system/review/PositiveRecordFork.t.sol) (tests-initial.txt): attempted; RPC403 (archive access or CloudFront).

<a id="entry-115"></a>

## TapePool.lendLimit:sybil-borrower-cap

**Rejected; —; confidence —.**

Gate4: separate addresses have separate per-address limits, but global500 BEM/90% and backstop limits still apply; no human-identity limit is promised or bypassed. There is no separate §16 Sybil acceptance row, despite the lens unit claiming one.

**Strongest retained input / provenance:** lens-factory accepted boundaries; SPEC11.3. Units: lens-factory, pool-loans.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_lend_per_borrower_cap_sums_agents()](../../../../test/unit/TapePool.t.sol) (tests-original-unit.txt)

<a id="entry-116"></a>

## TapePool.writeOff:reserve-release-at-winddown

**Rejected; —; confidence —.**

§5 safe pattern: the reserve is locked by design, and SPEC §16 defers releasing it. No unauthorized reserve-release path is established.

**Strongest retained input / provenance:** pool-loans accepted behavior; template5. Units: pool-loans, pool-books.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_partialAbsorptionPreservesOriginalReleaseEnd()](../runs/tests/pool-loans/review/Round1LoansReview.t.sol) (tests-initial.txt)<br>[test_reserveCapBindingAfterAssetsMoveUsesStoredBase()](../runs/tests/pool-loans/review/Round1LoansReview.t.sol) (tests-initial.txt)

<a id="entry-117"></a>

## TapePool.repay:cross-loan-reserve-cap-order

**Accepted risk; —; confidence —.**

SPEC §16 “Reserve base is stored at `lend`”: inside the stored per-loan cap rule: against current global reserve, bases10/20 BEM and3 BEM fees each produce1 BEM reserve versus0.6 BEM in reverse order, with an offsetting0.4 BEM lender-income difference. Existing reserve is never withdrawn. This is distinct from per-payment rounding; Q4 asks the owner to confirm the intended order-dependent allocation.

**Strongest retained input / provenance:** pool-loans accepted behavior, fee-order tests. Units: pool-loans.

**Seen in:** At least 1 supplied unit review record, plus this triage disposition; exact execution k/N unavailable. No person has confirmed this disposition.

**Current verification:** [test_orderSameFunctionTwoRepaymentsWithDifferentStoredCaps()](../runs/tests/pool-loans/review/PoolLoansReview.t.sol) (tests-initial.txt)

<a id="entry-118"></a>

## CreditPolicy.constructor:divide-before-multiply

**Rejected; —; confidence —.**

Gate1: NETLIST_RET rounds byte length up to a32-byte ABI word; division before multiplication is the required padding, not lost economic precision.

**Strongest retained input / provenance:** src/CreditPolicy.sol:19. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [testRecheck_netlistHasTwelvePaddingBytesAndPinsOnlyPayload()](../runs/tests/policy/review/RecheckReview.t.sol) (tests-initial.txt)<br>[test_FundedSeizeMustSweepInstead()](../runs/tests/agent-loan/review/AgentSupplement.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S001. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-119"></a>

## TapePool._book:incorrect-equality

**Rejected; —; confidence —.**

Gate1: Zero receipt/zero residual/zero supply select no-op or reserve/vesting branches; nonzero surplus cannot evade balance-based checkpointing.

**Strongest retained input / provenance:** src/TapePool.sol:796. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S002, S007, S012. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-120"></a>

## RigAgent.seizeEvidenceFrom:incorrect-equality

**Rejected; —; confidence —.**

Gate1: the zero flag sentinel returns uint64.max; actual flags use the post-cure floor.

**Strongest retained input / provenance:** src/RigAgent.sol:600. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S003. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-121"></a>

## TapePool.lend:incorrect-equality

**Rejected; —; confidence —.**

Gate1: The equality compares an explicit sentinel or enum and does not authorize value movement.

**Strongest retained input / provenance:** src/TapePool.sol:325. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S004, S005, S008. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-122"></a>

## TapePool.stats:incorrect-equality

**Rejected; —; confidence —.**

Gate1: gross==0 avoids division by zero; otherwise utilization divides outstanding by idle+outstanding.

**Strongest retained input / provenance:** src/TapePool.sol:470. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S006. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-123"></a>

## TapePool._sync:incorrect-equality

**Rejected; —; confidence —.**

Gate1: surplus==0 means there is nothing to book; positive surplus is booked exactly once.

**Strongest retained input / provenance:** src/TapePool.sol:788. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S009. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-124"></a>

## RigAgent.seize:incorrect-equality

**Rejected; —; confidence —.**

Gate1: prin==remaining principal detects fully funded debt and rejects seizure; it does not unlock assets.

**Strongest retained input / provenance:** src/RigAgent.sol:437. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S010. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-125"></a>

## RigAgent.flagEvidenceFrom:incorrect-equality

**Rejected; —; confidence —.**

Gate1: the zero prior-clear/expiry sentinel selects the initial floor; subsequent floors include skew.

**Strongest retained input / provenance:** src/RigAgent.sol:593. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S011. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-126"></a>

## TapePool.unvestedNow:incorrect-equality

**Rejected; —; confidence —.**

Gate1: zero residual/end selects a fully vested schedule; elapsed-time arithmetic handles positive income.

**Strongest retained input / provenance:** src/TapePool.sol:783. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S013. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-127"></a>

## TapePool.fee:uninitialized-local

**Rejected; —; confidence —.**

Gate1: bps is assigned by both valid term branches; the invalid branch reverts BadTerm before it is read.

**Strongest retained input / provenance:** src/TapePool.sol:294. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S015. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-128"></a>

## TapePool._frozenUntil:uninitialized-local

**Rejected; —; confidence —.**

Gate1: lo is intentionally initialized to0 as the lower binary-search bound; no stale memory is read.

**Strongest retained input / provenance:** src/TapePool.sol:847. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S016. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-129"></a>

## RigAgent._verdict:uninitialized-local

**Rejected; —; confidence —.**

Gate1: reported defaults false until a report qualifies as H/B/U. The separate stale-overwrite finding evaluates the unsafe semantic case, not uninitialized storage. Gate1: at defaults0 and is consulted only with reported or through defined short-circuit conditions. The stale-overwrite semantic case is retained separately.

**Strongest retained input / provenance:** src/RigAgent.sol:664. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S017, S019. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-130"></a>

## TapePool.expiryOf:uninitialized-local

**Rejected; —; confidence —.**

Gate1: lo defaults0 for the lower binary-search bound.

**Strongest retained input / provenance:** src/TapePool.sol:861. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S018. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-131"></a>

## RigAgent._impairment:uninitialized-local

**Rejected; —; confidence —.**

Gate1: healthyAt defaults0 to mean no shield; admissible dated records compare against0 deliberately.

**Strongest retained input / provenance:** src/RigAgent.sol:633. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S020. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-132"></a>

## RigAgent.seize:uninitialized-local

**Rejected; —; confidence —.**

Gate1: evidence starts false, is set by qualified collateral evidence, and otherwise causes NoEvidence; it is fail-closed.

**Strongest retained input / provenance:** src/RigAgent.sol:437. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S021. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-133"></a>

## TapeLens._decision:unused-return

**Rejected; —; confidence —.**

Gate1: the lens uses allowed/reason/expected from the policy; ignored encoded diagnostic bits are not a missing loan guard.

**Strongest retained input / provenance:** src/TapeLens.sol:67. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_leadUnlimitedReplacementRevertsMaxQuoteButExactQuoteAndBorrowWork()](../runs/tests/lens-factory/review/BoundaryReview.t.sol) (tests-initial.txt)<br>[test_CriticAcceptedPolicyMaxDebtCanRevertNormalQuote()](../runs/tests/system/review/R4Checks.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S022. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-134"></a>

## RigAgent.borrow:unused-return

**Rejected; —; confidence —.**

Gate1: borrow uses allowed and reason, then independently enforces ownership/term/caps; unused diagnostic bits and expected output are not authoritative after an accepted policy swap.

**Strongest retained input / provenance:** src/RigAgent.sol:276. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S023. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-135"></a>

## TapePool._checkPolicy:unused-return

**Rejected; —; confidence —.**

Gate1: the activation probe checks a canonical typed response; ignored diagnostics do not bypass code/version checks, timelock or remaining loan guards.

**Strongest retained input / provenance:** src/TapePool.sol:920. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S024. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-136"></a>

## RigFeedReceiver.lock:unused-return

**Rejected; —; confidence —.**

Gate1: the receiver pins its explicit library and validates explicit mirrored configuration; the BEM reference default flag is not permission to retain a mutable receiver default.

**Strongest retained input / provenance:** src/feed/RigFeedReceiver.sol:83. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_lockFailureIsAtomicAtEveryStepBothSides()](../runs/tests/feed/review/FeedConformance.t.sol) (tests-initial.txt)<br>[test_receiverAuthenticationAndMalformedMessageAtomicity()](../runs/tests/feed/review/FeedConformance.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S025. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-137"></a>

## PolicyV1.build:unused-return

**Rejected; —; confidence —.**

Gate1: build mutates the netlist by appending the final output record; it intentionally need not use the returned signal index.

**Strongest retained input / provenance:** src/libraries/PolicyV1.sol:29. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [testReview_all4096VectorsIndependentInterpreterAndFormula()](../runs/tests/policy/review/MathCircuitReview.t.sol) (tests-initial.txt)<br>[test_livePolicyAll4096Inputs()](../runs/tests/pool-loans/review/LiveFactsReview.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S026. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-138"></a>

## TapeLens._size:unused-return

**Rejected; —; confidence —.**

Gate1: the room amount bounds sizing; ignoring its diagnostic binding code in _size cannot enlarge that amount.

**Strongest retained input / provenance:** src/TapeLens.sol:142. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_leadUnlimitedReplacementRevertsMaxQuoteButExactQuoteAndBorrowWork()](../runs/tests/lens-factory/review/BoundaryReview.t.sol) (tests-initial.txt)<br>[test_CriticAcceptedPolicyMaxDebtCanRevertNormalQuote()](../runs/tests/system/review/R4Checks.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S027. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-139"></a>

## RigAgent.initialize:events-access

**Rejected; —; confidence —.**

§5 do-not-report: an initialization event suggestion has no unauthorized state change or asset effect.

**Strongest retained input / provenance:** src/RigAgent.sol:186. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S028. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-140"></a>

## RigAgent.initialize:missing-zero-check

**Rejected; —; confidence —.**

Gate1: initialize accepts only its immutable factory, whose create passes msg.sender as borrower; the implementation is already closed. Zero borrower is not a reachable factory input.

**Strongest retained input / provenance:** src/RigAgent.sol:186. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S029. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-141"></a>

## TapeLens.principalFor:calls-loop

**Rejected; —; confidence —.**

Gate1: for representable valid inputs, floor(debt*10000/(10000+bps)) and ceil fee require at most a rounding correction; fee is a bounded pure call. Large-input arithmetic failure is separately retained.

**Strongest retained input / provenance:** src/TapeLens.sol:96. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_leadUnlimitedReplacementRevertsMaxQuoteButExactQuoteAndBorrowWork()](../runs/tests/lens-factory/review/BoundaryReview.t.sol) (tests-initial.txt)<br>[test_CriticAcceptedPolicyMaxDebtCanRevertNormalQuote()](../runs/tests/system/review/R4Checks.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S030, S035. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-142"></a>

## CreditPolicy._report:calls-loop

**Rejected; —; confidence —.**

Gate1: at most16 collateral reports, each from the fixed typed receiver; this is bounded view work, not a reentrant mutation.

**Strongest retained input / provenance:** src/CreditPolicy.sol:294. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [testRecheck_netlistHasTwelvePaddingBytesAndPinsOnlyPayload()](../runs/tests/policy/review/RecheckReview.t.sol) (tests-initial.txt)<br>[test_FundedSeizeMustSweepInstead()](../runs/tests/agent-loan/review/AgentSupplement.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S031, S034. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-143"></a>

## TapeLens._pending:calls-loop

**Rejected; —; confidence —.**

Gate1: at most16 uint128 pending values sum below2^132; fixed typed receiver calls cannot trigger an unbounded state change.

**Strongest retained input / provenance:** src/TapeLens.sol:189. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_leadUnlimitedReplacementRevertsMaxQuoteButExactQuoteAndBorrowWork()](../runs/tests/lens-factory/review/BoundaryReview.t.sol) (tests-initial.txt)<br>[test_CriticAcceptedPolicyMaxDebtCanRevertNormalQuote()](../runs/tests/system/review/R4Checks.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S032. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-144"></a>

## RigAgent.borrow:calls-loop

**Rejected; —; confidence —.**

Gate1: at most16 ownership reads, each with100000 gas; ownership is verified before borrowing and the agent is guarded.

**Strongest retained input / provenance:** src/RigAgent.sol:276. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S033. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-145"></a>

## RigAgent._report:calls-loop

**Rejected; —; confidence —.**

Gate1: at most16 fixed-feed view reads inside _verdict; no unbounded user loop or mutable callback is established.

**Strongest retained input / provenance:** src/RigAgent.sol:687. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S036, S037. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-146"></a>

## AgentFactory.create:reentrancy-events

**Rejected; —; confidence —.**

Gate1: a newly cloned initialize only binds borrower/index and performs no untrusted interaction before AgentCreated.

**Strongest retained input / provenance:** src/AgentFactory.sol:48. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_completionCreateAndAgentActionsBothOrders()](../runs/tests/lens-factory/review/CompletionReview.t.sol) (tests-initial.txt)<br>[test_completionFactoryAdditionalEligibilityAndReadFailureModes()](../runs/tests/lens-factory/review/CompletionReview.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S038. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-147"></a>

## RigAgent._fresh:timestamp

**Rejected; —; confidence —.**

Gate1: The intentional300-second lifetime and60-second skew are tested at equality/one-over; no alternate clock bypass is identified.

**Strongest retained input / provenance:** src/RigAgent.sol:749. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S039. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-148"></a>

## TapeLens._blocker:timestamp

**Rejected; —; confidence —.**

Gate1: The360-second re-enable wait mirrors pool.lend; a quote cannot bypass the final pool check.

**Strongest retained input / provenance:** src/TapeLens.sol:160. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_leadUnlimitedReplacementRevertsMaxQuoteButExactQuoteAndBorrowWork()](../runs/tests/lens-factory/review/BoundaryReview.t.sol) (tests-initial.txt)<br>[test_CriticAcceptedPolicyMaxDebtCanRevertNormalQuote()](../runs/tests/system/review/R4Checks.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S040. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-149"></a>

## TapePool._sync:timestamp

**Rejected; —; confidence —.**

Gate1: Time only checkpoints vested income; zero-surplus handling cannot create cash.

**Strongest retained input / provenance:** src/TapePool.sol:788. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S041. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-150"></a>

## TapePool._book:timestamp

**Rejected; —; confidence —.**

Gate1: The weighted positive release duration is≤VEST; rounding cannot release same-block income.

**Strongest retained input / provenance:** src/TapePool.sol:796. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S042. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-151"></a>

## TapePool.disableFeed:timestamp

**Rejected; —; confidence —.**

Gate1: The new interval records current time once; repeated disable rejects and cannot erase prior history.

**Strongest retained input / provenance:** src/TapePool.sol:545. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S043. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-152"></a>

## RigAgent.seize:timestamp

**Rejected; —; confidence —.**

Gate1: Cure remains72h of wall time and seizure is limited by current expiry/evidence floors.

**Strongest retained input / provenance:** src/RigAgent.sol:437. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S044. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-153"></a>

## TapePool.stats:timestamp

**Rejected; —; confidence —.**

Gate1: Queued-view expiry is inclusive through eta+7d; it confers no execution privilege.

**Strongest retained input / provenance:** src/TapePool.sol:470. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S045. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-154"></a>

## TapePool._feedSettling:timestamp

**Rejected; —; confidence —.**

Gate1: Borrow waits360 seconds after enable; new borrowers cannot control the recorded enable timestamp.

**Strongest retained input / provenance:** src/TapePool.sol:894. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S046. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-155"></a>

## RigAgent._lateSince:timestamp

**Rejected; —; confidence —.**

Gate1: Late duration starts at the later of maturity and last accrual interval; stored rate/principal bound the formula.

**Strongest retained input / provenance:** src/RigAgent.sol:533. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S047. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-156"></a>

## TapePool.lend:timestamp

**Rejected; —; confidence —.**

Gate1: Time is an intentional bounded protocol clock; no caller-controlled timestamp bypass was established.

**Strongest retained input / provenance:** src/TapePool.sol:325. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S048. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-157"></a>

## RigAgent.flagEvidenceFrom:timestamp

**Rejected; —; confidence —.**

Gate1: Evidence floor uses clear/old-expiry+skew with saturation, rather than an attacker-supplied time.

**Strongest retained input / provenance:** src/RigAgent.sol:593. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S049. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-158"></a>

## CreditPolicy.constructor:timestamp

**Rejected; —; confidence —.**

Gate1: The policy constructor requires a future emission horizon; the incorrect configured horizon is a separate retained finding.

**Strongest retained input / provenance:** src/CreditPolicy.sol:73. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [testRecheck_netlistHasTwelvePaddingBytesAndPinsOnlyPayload()](../runs/tests/policy/review/RecheckReview.t.sol) (tests-initial.txt)<br>[test_FundedSeizeMustSweepInstead()](../runs/tests/agent-loan/review/AgentSupplement.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S050. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-159"></a>

## RigAgent.seizeEvidenceFrom:timestamp

**Rejected; —; confidence —.**

Gate1: Post-cure+skew floor is intentional; no-flag returns max64.

**Strongest retained input / provenance:** src/RigAgent.sol:600. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S051. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-160"></a>

## RigFeedReceiver._lzReceive:timestamp

**Rejected; —; confidence —.**

Gate1: Authenticated reports reject excess future skew and only strictly newer timestamps replace storage; same-second risk is separately accepted.

**Strongest retained input / provenance:** src/feed/RigFeedReceiver.sol:59. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_lockFailureIsAtomicAtEveryStepBothSides()](../runs/tests/feed/review/FeedConformance.t.sol) (tests-initial.txt)<br>[test_receiverAuthenticationAndMalformedMessageAtomicity()](../runs/tests/feed/review/FeedConformance.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S052. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-161"></a>

## TapePool.unvestedNow:timestamp

**Rejected; —; confidence —.**

Gate1: At/past vestEnd returns0; otherwise bounded linear decay does not spend unavailable cash.

**Strongest retained input / provenance:** src/TapePool.sol:783. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S053. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-162"></a>

## RigAgent._expired:timestamp

**Rejected; —; confidence —.**

Gate1: Already expired flags remain expired and live flags use the pool freeze clock, not report timestamps.

**Strongest retained input / provenance:** src/RigAgent.sol:588. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S054. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-163"></a>

## TapePool.activatePolicy:timestamp

**Rejected; —; confidence —.**

Gate1: Only queued candidates activate in the public eta/grace interval after renewed code/version checks.

**Strongest retained input / provenance:** src/TapePool.sol:666. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S055. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-164"></a>

## RigAgent.flagImpaired:timestamp

**Rejected; —; confidence —.**

Gate1: Existing live flags cannot reset cure; replacements require evidence past the prior expiry/clear floor.

**Strongest retained input / provenance:** src/RigAgent.sol:385. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S056. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-165"></a>

## TapePool.policySwapQueued:timestamp

**Rejected; —; confidence —.**

Gate1: The view reports a live queue through the inclusive grace endpoint; lapse does not permit early activation.

**Strongest retained input / provenance:** src/TapePool.sol:465. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S057. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-166"></a>

## RigAgent._voucherRecord:timestamp

**Rejected; —; confidence —.**

Gate1: Future record skew is checked against now; becoming admissible later is explicitly accepted under the Safe-upgrade row.

**Strongest retained input / provenance:** src/RigAgent.sol:700. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S058. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-167"></a>

## CreditPolicy._gather:timestamp

**Rejected; —; confidence —.**

Gate1: Maturity must precede the configured emission cutoff and terms are fixed7/14 days; the wrong pin is retained separately.

**Strongest retained input / provenance:** src/CreditPolicy.sol:134. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [testRecheck_netlistHasTwelvePaddingBytesAndPinsOnlyPayload()](../runs/tests/policy/review/RecheckReview.t.sol) (tests-initial.txt)<br>[test_FundedSeizeMustSweepInstead()](../runs/tests/agent-loan/review/AgentSupplement.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S059. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-168"></a>

## TapePool.queueParam:timestamp

**Rejected; —; confidence —.**

Gate1: Authority and hard bounds apply before a fresh48h ETA; timestamp is not chosen by the caller.

**Strongest retained input / provenance:** src/TapePool.sol:610. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S060. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-169"></a>

## TapePool.executeParam:timestamp

**Rejected; —; confidence —.**

Gate1: Execution accepts only the stored value within[eta,eta+7d] and rechecks hard bounds.

**Strongest retained input / provenance:** src/TapePool.sol:626. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S061. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-170"></a>

## RigAgent._accrue:timestamp

**Rejected; —; confidence —.**

Gate1: Simple late fee uses stored rate, remaining principal and elapsed interval, subtracting lateBooked to avoid repeated ceiling charges.

**Strongest retained input / provenance:** src/RigAgent.sol:524. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S062. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-171"></a>

## TapePool._lapsePolicyIfStale:timestamp

**Rejected; —; confidence —.**

Gate1: Time is an intentional bounded protocol clock; no caller-controlled timestamp bypass was established.

**Strongest retained input / provenance:** src/TapePool.sol:909. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S063. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-172"></a>

## TapePool.maxDeposit:timestamp

**Rejected; —; confidence —.**

Gate1: Doubt and supply-room checks use checkpoint-consistent assets; no time-only entry bypass is shown.

**Strongest retained input / provenance:** src/TapePool.sol:262. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S064. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-173"></a>

## TapePool.expiryOf:timestamp

**Rejected; —; confidence —.**

Gate1: Binary search sums frozen intervals, preserves expired flags and saturates the uint64 result.

**Strongest retained input / provenance:** src/TapePool.sol:861. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S065. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-174"></a>

## CreditPolicy._rig:timestamp

**Rejected; —; confidence —.**

Gate1: Age/freshness/skew and sane-weight checks are intentional admission requirements.

**Strongest retained input / provenance:** src/CreditPolicy.sol:155. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [testRecheck_netlistHasTwelvePaddingBytesAndPinsOnlyPayload()](../runs/tests/policy/review/RecheckReview.t.sol) (tests-initial.txt)<br>[test_FundedSeizeMustSweepInstead()](../runs/tests/agent-loan/review/AgentSupplement.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S066. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-175"></a>

## TapePool._sub:timestamp

**Rejected; —; confidence —.**

Gate1: Saturating subtraction prevents underflow when computing paused-clock intervals.

**Strongest retained input / provenance:** src/TapePool.sol:880. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S067. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-176"></a>

## RigAgent._base:timestamp

**Rejected; —; confidence —.**

Gate1: Report id and upper skew bound are checked before role classification.

**Strongest retained input / provenance:** src/RigAgent.sol:744. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S068. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-177"></a>

## RigAgent.hasLoan:timestamp

**Rejected; —; confidence —.**

Gate1: Remaining principal/fee/elapsed late fee are evaluated consistently; maturity alone does not close a loan.

**Strongest retained input / provenance:** src/RigAgent.sol:517. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S069. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-178"></a>

## RigAgent._verdict:timestamp

**Rejected; —; confidence —.**

Gate1: Timestamps select qualified H/B/U/VC and impairment wins ties; the discarded-report semantic finding is separately retained.

**Strongest retained input / provenance:** src/RigAgent.sol:664. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S070. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-179"></a>

## RigAgent._impairment:timestamp

**Rejected; —; confidence —.**

Gate1: Only qualified E/VE can trigger flag/seize; stale S shielding and brake loss are explicit accepted risks.

**Strongest retained input / provenance:** src/RigAgent.sol:633. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S071. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-180"></a>

## TapePool._frozenUntil:timestamp

**Rejected; —; confidence —.**

Gate1: Binary search uses monotone stored intervals, not user-supplied history.

**Strongest retained input / provenance:** src/TapePool.sol:847. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S072. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-181"></a>

## TapePool.repay:timestamp

**Rejected; —; confidence —.**

Gate1: Accrual/checkpoint time does not alter stored reserve base/share/cap; amount and debt effects remain guarded.

**Strongest retained input / provenance:** src/TapePool.sol:352. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S073. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-182"></a>

## TapePool.writeOff:timestamp

**Rejected; —; confidence —.**

Gate1: Factory-agent-only write-off uses stored principal/mark and min reserve cover; no timestamp grants caller access.

**Strongest retained input / provenance:** src/TapePool.sol:410. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S074. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-183"></a>

## TapePool.lendLimit:timestamp

**Rejected; —; confidence —.**

Gate1: Pause/feed/settle and queued-swap checks close admission; lend repeats the checks.

**Strongest retained input / provenance:** src/TapePool.sol:436. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S075. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-184"></a>

## RigScreen.isEffective:timestamp

**Rejected; —; confidence —.**

Gate1: An exact tuple, matured48h pass and not-suspended status are all required.

**Strongest retained input / provenance:** src/RigScreen.sol:121. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [testReview_repeatedRecordRestartsDelayAndRepeatedBrakesAreIdempotent()](../runs/tests/policy/review/PolicyReview.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S076. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-185"></a>

## BscRigReader._owns:assembly

**Rejected; —; confidence —.**

Gate1: capped staticcall checks success, at least32 return bytes and canonical address width before using custody.

**Strongest retained input / provenance:** src/feed/BscRigReader.sol:46. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_readerEveryNarrowingBoundary()](../runs/tests/feed/review/FeedConformance.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S077. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-186"></a>

## CreditPolicy._voucherMatches:assembly

**Rejected; —; confidence —.**

Gate1: capped read copies bounded words and validates tuple identity; short/reverting answers clear eligibility.

**Strongest retained input / provenance:** src/CreditPolicy.sol:255. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [testRecheck_netlistHasTwelvePaddingBytesAndPinsOnlyPayload()](../runs/tests/policy/review/RecheckReview.t.sol) (tests-initial.txt)<br>[test_FundedSeizeMustSweepInstead()](../runs/tests/agent-loan/review/AgentSupplement.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S078. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-187"></a>

## RigAgent._voucherRecord:assembly

**Rejected; —; confidence —.**

Gate1: capped read copies four words, requires128 bytes and checks future skew; known=false otherwise.

**Strongest retained input / provenance:** src/RigAgent.sol:700. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S079. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-188"></a>

## CreditPolicy._eval:assembly

**Rejected; —; confidence —.**

Gate1: bounded staticcall accepts exactly canonical Boolean output and requires agreement with the local mirror.

**Strongest retained input / provenance:** src/CreditPolicy.sol:236. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [testRecheck_netlistHasTwelvePaddingBytesAndPinsOnlyPayload()](../runs/tests/policy/review/RecheckReview.t.sol) (tests-initial.txt)<br>[test_FundedSeizeMustSweepInstead()](../runs/tests/agent-loan/review/AgentSupplement.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S080. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-189"></a>

## CreditPolicy._pinsOk:assembly

**Rejected; —; confidence —.**

Gate1: pin reads use bounded return copying and compare canonical lengths/values/netlist hash; assembly does not waive the checks.

**Strongest retained input / provenance:** src/CreditPolicy.sol:197. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [testRecheck_netlistHasTwelvePaddingBytesAndPinsOnlyPayload()](../runs/tests/policy/review/RecheckReview.t.sol) (tests-initial.txt)<br>[test_FundedSeizeMustSweepInstead()](../runs/tests/agent-loan/review/AgentSupplement.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S081. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-190"></a>

## RigAgent._tryMove:assembly

**Rejected; —; confidence —.**

Gate1: a token return is not trusted as movement proof; post-transfer canonical ownership determines moved versus kept, with a gas cap.

**Strongest retained input / provenance:** src/RigAgent.sol:827. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S082. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-191"></a>

## RigAgent._moveCollateral:assembly

**Rejected; —; confidence —.**

Gate1: in-memory result arrays shrink only to counters no greater than the allocated collateral length≤16.

**Strongest retained input / provenance:** src/RigAgent.sol:799. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S083. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-192"></a>

## TapeLens._owns:assembly

**Rejected; —; confidence —.**

Gate1: ownerOf is a capped staticcall; success/length/canonical address checks precede the equality.

**Strongest retained input / provenance:** src/TapeLens.sol:176. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_leadUnlimitedReplacementRevertsMaxQuoteButExactQuoteAndBorrowWork()](../runs/tests/lens-factory/review/BoundaryReview.t.sol) (tests-initial.txt)<br>[test_CriticAcceptedPolicyMaxDebtCanRevertNormalQuote()](../runs/tests/system/review/R4Checks.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S084. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-193"></a>

## RigAgent._ownerOf:assembly

**Rejected; —; confidence —.**

Gate1: ownerOf requires success/32 bytes/nonzero/canonical width; dirty, missing and short replies are unknown.

**Strongest retained input / provenance:** src/RigAgent.sol:728. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S085. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-194"></a>

## CreditPolicy._screened:assembly

**Rejected; —; confidence —.**

Gate1: screen read is bounded and requires the canonical true word1; other data fail closed.

**Strongest retained input / provenance:** src/CreditPolicy.sol:283. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [testRecheck_netlistHasTwelvePaddingBytesAndPinsOnlyPayload()](../runs/tests/policy/review/RecheckReview.t.sol) (tests-initial.txt)<br>[test_FundedSeizeMustSweepInstead()](../runs/tests/agent-loan/review/AgentSupplement.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S086. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-195"></a>

## TapePool._write:cyclomatic-complexity

**Rejected; —; confidence —.**

§5 do-not-report: cyclomatic complexity is not an exploit; each parameter key has independent bounds and authority/queue controls.

**Strongest retained input / provenance:** src/TapePool.sol:935. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S087. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-196"></a>

## RigAgent.borrow:cyclomatic-complexity

**Rejected; —; confidence —.**

§5 do-not-report: complexity alone does not establish a bypass of borrow guards.

**Strongest retained input / provenance:** src/RigAgent.sol:276. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_CriticSeizeAccruesBeforeNoDebtDecision()](../runs/tests/agent-evidence/review/Round1Accrual.t.sol) (tests-initial.txt)<br>[test_S16_SeizedIncomeCanRedistributeMoreThan122Bem()](../runs/tests/system/review/RestoreAmount.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S088. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-197"></a>

## TapePool._withdraw:dead-code

**Rejected; —; confidence —.**

Gate1: inherited ERC4626 withdraw/redeem call the override; Slither’s dead-code label misses inherited dispatch.

**Strongest retained input / provenance:** src/TapePool.sol:766. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S089. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-198"></a>

## TapePool._deposit:dead-code

**Rejected; —; confidence —.**

Gate1: inherited ERC4626 deposit/mint call the override; the hook is reachable, not dead code.

**Strongest retained input / provenance:** src/TapePool.sol:759. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S090. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-199"></a>

## ITapeOutTransistors.NAND:naming-convention

**Rejected; —; confidence —.**

§5 do-not-report: interface spelling/naming is not an exploit.

**Strongest retained input / provenance:** src/interfaces/IXLayer.sol:107. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; No separate executable test supplied for this allegation; source trace and enclosing suites reviewed.

**Raw Slither alerts:** S092. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-200"></a>

## ITapeOutCircuits.TAPEOUT_FEE:naming-convention

**Rejected; —; confidence —.**

§5 do-not-report: interface spelling/naming is not an exploit.

**Strongest retained input / provenance:** src/interfaces/IXLayer.sol:121. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; No separate executable test supplied for this allegation; source trace and enclosing suites reviewed.

**Raw Slither alerts:** S093. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-201"></a>

## IPodMining.HALVING_PERIOD:naming-convention

**Rejected; —; confidence —.**

§5 do-not-report: interface spelling/naming is not an exploit.

**Strongest retained input / provenance:** src/interfaces/IBsc.sol:50. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; No separate executable test supplied for this allegation; source trace and enclosing suites reviewed.

**Raw Slither alerts:** S094. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-202"></a>

## ITapeOutTransistors.LATCH:naming-convention

**Rejected; —; confidence —.**

§5 do-not-report: interface spelling/naming is not an exploit.

**Strongest retained input / provenance:** src/interfaces/IXLayer.sol:108. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; No separate executable test supplied for this allegation; source trace and enclosing suites reviewed.

**Raw Slither alerts:** S095. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-203"></a>

## ITapePool.FEED_SETTLE:naming-convention

**Rejected; —; confidence —.**

§5 do-not-report: interface spelling/naming is not an exploit.

**Strongest retained input / provenance:** src/interfaces/ITapePool.sol:17. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; No separate executable test supplied for this allegation; source trace and enclosing suites reviewed.

**Raw Slither alerts:** S096. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-204"></a>

## TapeLens._owns:too-many-digits

**Rejected; —; confidence —.**

§5 do-not-report:100000 is an intentional owner-read gas budget; formatting its digits has no security effect.

**Strongest retained input / provenance:** src/TapeLens.sol:176. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_leadUnlimitedReplacementRevertsMaxQuoteButExactQuoteAndBorrowWork()](../runs/tests/lens-factory/review/BoundaryReview.t.sol) (tests-initial.txt)<br>[test_CriticAcceptedPolicyMaxDebtCanRevertNormalQuote()](../runs/tests/system/review/R4Checks.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S097. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-205"></a>

## TapePool.owner:interface-implementation

**Rejected; —; confidence —.**

Gate1: TapePool.owner explicitly overrides Ownable and ITapePool at source315; deployment and role tests exercise it.

**Strongest retained input / provenance:** src/interfaces/ITapePool.sol:65. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_RepayPullPrecedesAgentDebtEffects()](../runs/tests/agent-loan/review/AgentConflicts.t.sol) (tests-initial.txt)<br>[test_C3SeizeEffectsPrecedeApprovalRepaymentAndWriteOff()](../runs/tests/agent-loan/critic/Critic3Evidence.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S098. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-206"></a>

## RigReporter.lock:unindexed-event-address

**Rejected; —; confidence —.**

§5 do-not-report: unindexed Locked event parameters affect log filtering, not lock authorization.

**Strongest retained input / provenance:** src/feed/RigReporter.sol:31. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_reporterBatchBoundsQuotePushAndSixteenRoundtrip()](../runs/tests/feed/review/FeedConformance.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S099. Full original descriptions and locations are preserved in slither-mapping.json.

<a id="entry-207"></a>

## RigFeedReceiver.lock:unindexed-event-address

**Rejected; —; confidence —.**

§5 do-not-report: unindexed Locked event parameters affect log filtering, not lock authorization.

**Strongest retained input / provenance:** src/feed/RigFeedReceiver.sol:27. Units: slither.

**Seen in:** 1 supplied Slither execution, plus this triage. Exact other-pass k/N unavailable. No person has confirmed this disposition.

**Current verification:** Static source trace; [test_lockFailureIsAtomicAtEveryStepBothSides()](../runs/tests/feed/review/FeedConformance.t.sol) (tests-initial.txt)<br>[test_receiverAuthenticationAndMalformedMessageAtomicity()](../runs/tests/feed/review/FeedConformance.t.sol) (tests-initial.txt)

**Raw Slither alerts:** S100. Full original descriptions and locations are preserved in slither-mapping.json.

