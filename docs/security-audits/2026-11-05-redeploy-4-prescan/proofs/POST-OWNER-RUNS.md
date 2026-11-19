# Post-owner reproduction record

Target: supplied `work/` copy of `ceed0a2`. Date: 2026-11-11. Production code unchanged.

From `work/`, set:

```powershell
$env:FOUNDRY_OUT='../out/build'
$env:FOUNDRY_CACHE_PATH='../out/cache'
$env:FOUNDRY_FUZZ_FAILURE_PERSIST_DIR='../out/fuzz'
$env:FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR='../out/invariant'
$env:FOUNDRY_TEST_FAILURES_FILE='../out/test-failures'
```

## M-01 intended-behaviour regression

```powershell
forge test --offline --no-storage-caching --match-path 'test/audit/2026-11-05-redeploy-4-prescan/owner/OwnerEvidenceRegression.t.sol' --match-test '^test_M01_' -vv *> ../out/tests-owner-medium.txt
```

Exit 1, as expected: two passed, three failed, zero skipped. All three failures say `next call did not revert as expected`.

- Stale report plus older positive record: FAIL.
- Insane report plus older positive record: FAIL.
- Stale report plus equal-timestamp positive record: FAIL.
- Zero-power record at the floor still decides impaired: PASS.
- Strictly newer positive record can clear: PASS.

The three failures assert the owner's intended protection. They do not assert the vulnerable behaviour. The inherited fixture uses the real receiver, policy, pool and agent, with a local endpoint and mock external records. No complete live authenticated packet-to-lender-loss path is claimed. No fixing commit was supplied or tested; the Medium remains Open at confidence 75.

The imported ancestor also contains characterization tests that expect vulnerable behaviour. The command deliberately selects only `test_M01_` for the future regression. The builder must update obsolete characterizations separately when testing a fix; this report does not claim that every imported review test will pass unchanged after a fix.

## H-01 accepted mechanism characterization

```powershell
forge test --offline --no-storage-caching --match-path 'test/audit/2026-11-05-redeploy-4-prescan/system/review/RestoreAmount.t.sol' --match-test '^test_S16_' -vv *> ../out/tests-owner-high.txt
```

Exit 0: one passed, zero failed, zero skipped. Absorbed income: 499.94957010 BEM. Entrant deposit: 498.94957009 BEM. Entrant gain: 249.44962306 BEM. The test asserts exact values and that gain does not exceed absorbed income.

There is no failing intended-behaviour test for H-01. The owner accepts this mechanism at the corrected bound and requires no code change. A test demanding at most 122 BEM would assert a withdrawn requirement. This is the stated-reason exception in template section 7, and a disclosed departure from the original brief's blanket failing-test requirement. No fixing commit or future passing result is claimed. The withdrawn 0.0046 and 4.3 BEM examples were not reproduced.

## Counts and limits

This step adds three passing executions and three expected failing executions. Together with the earlier triage runs: 1,352 passing executions, representing 1,346 distinct passing `(path, contract, test)` identities. Repeated runs and inherited tests do not constitute independent confirmations. Earlier environment failures remain recorded in `test-index.json`; these totals do not erase them. No full fork or invariant rerun was performed after the owner answer, and no green full-suite result is claimed.
