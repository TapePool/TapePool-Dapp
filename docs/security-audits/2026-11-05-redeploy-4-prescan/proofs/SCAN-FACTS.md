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

