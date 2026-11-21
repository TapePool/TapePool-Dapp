# Tape Pool keeper

Off-chain keeper and guardian for Tape Pool.
Every 60 s it checks the TapeOut implementations against reviewed constants (and pulls the guardian
brakes on a confirmed upgrade), follows admin events, harvests rigs with open loans on BSC, runs the
per-loan impairment machine (suspend, push, flag, seize, clear), sweeps repayments, and alerts the owner
on Telegram. `POST /v1/push` pushes fresh rig reports for borrowers, within limits.

During a brake, a transient report-read failure can use the incident's single brake alert with "unreadable clear source" in its text; re-read the state before re-enabling the feed.

Two read-only routes serve the web app, from memory
only (no chain read per request), behind their own in-memory limiter (60 requests per IP and 600 in total per
minute) and with CORS for `APP_ORIGINS`:
- `GET /v1/stats`: the pool's share price (`convertToAssets(10^14)`), one snapshot per UTC day (the last 60) and the
  7-day APY.
- `GET /v1/position/<address>`: what an address put in and took out (`netDeposited`, `transferred`,
  `firstDepositAt`, `indexedTo`, `indexedToTime`), from an index of the pool's Deposit, Withdraw and Transfer events.

Both are built at the end of each cycle, after every guardian job, with a cap on days and pages and a time budget.
They rebuild from archive reads and from the pool's deploy block if `state.json` is lost.

- **Dry by default.** `KEEPER_MODE=dry` simulates every transaction and never broadcasts. `live` is set
  only after the owner's go-ahead.
- Secrets come only from the environment (`KEEPER_PRIVATE_KEY`, `TELEGRAM_BOT_TOKEN`, `BSC_RPC`, and
  `XLAYER_RPC` when it is not the public node) and are redacted from logs and alerts.
- `XLAYER_RPC` is a comma-separated list. Reads fall back across it in order (no ranking, one try per URL);
  transactions go only through the first URL. Every URL must serve `eth_getLogs` over 100-block ranges at
  about a request a second. On Railway the public `rpc.xlayer.tech` rate-limits the shared egress IP, and
  QuickNode's free plan caps `eth_getLogs` at 5 blocks; the Railway value is
  `https://xlayer.drpc.org,https://xlayerrpc.okx.com,https://rpc.xlayer.tech` (part E, 2026-10-24). Log scans
  trail the head by 16 blocks so a lagging endpoint cannot skip events.
- Harvests: once as soon as a loan's bridged output covers its debt (checked every 10 minutes), otherwise in
  the last hour before maturity, then every 72 h while a shortfall remains. A failing job alerts only after
  10 minutes without a success, then sends "recovered"; the daily summary counts each job's failed cycles.
  In dry mode a covered harvest is never recorded (only one that went out is), so a covered loan shows a
  "would send" harvest every 10 minutes in the log. Other settings: `TELEGRAM_CHAT_ID`, `XLAYER_RPC`, `SEIZED_HARVEST_EVERY_H`,
  `BNB_RESERVE`, `SWEEP_MIN`, `PUSH_DAILY_MAX`, `OKB_PER_BNB` (required in `live` mode for the fee
  coverage watch), `APP_ORIGINS`, `PORT`, `STATE_PATH` (a Railway volume at `/data`),
  `SUSPEND_ON_REVOKE`, `HOLD_HARVEST_ON_VAULT_FREEZE`.
- The legacy address book lives in `src/addresses.ts` (`DEPLOYMENT`). Redeploys use a complete environment
  replacement through `loadDeployment`; see the cutover steps below.

```bash
npm ci --ignore-scripts
npm test                     # unit tests
KEEPER_LIVE_READ=1 BSC_RPC=... npm test   # plus a read-only cycle against the real chains
KEEPER_ANVIL=1 BSC_RPC=... npm test       # plus three end-to-end scenarios on local anvil forks (~6 min)
KEEPER_PUBLIC_DATA_LIVE=1 npm test       # plus a read-only run of the app routes' data on the public X Layer node (~45 s)
npm run build && npm start
```

The anvil scenarios (`test/anvil.int.test.ts`) fork BSC and X Layer locally, deploy the Phase 3 stack with
`script/test/AnvilStack.s.sol` (which refuses any node that is not anvil), and run the keeper live
against the forks with auto-impersonated accounts. `BSC_RPC` must be an archive endpoint; it is only read.
Set `KEEPER_TRACE=<file>` to log the stack's setup timings.

## Register to borrow (SPEC-PHASE5-REGISTER)

"Register to borrow" in the app asks the keeper to run the revocation screen for one voucher. The keeper runs the screen
tool's own code (vendored byte for byte in `src/screen/vendor/`; run `node scripts/sync-screen.mjs` after a change in
`../screen/src`, and `test/screenVendor.test.ts` fails on drift) in a worker thread, one run at a time, then reproduces the
artifact on a second provider (`verify` at the pinned blocks). It never sends a transaction: only the owner's wallet records
a pass, from the app's owner page (`#/app/owner`).

- `POST /v1/register` `{"rigId":"16"}`: `queued`, `known` (the current record), `recorded` or `refused` with a reason. Its own
  admission limits (10 per IP per hour, 30 per minute, persisted), one record per voucher, a queue of 20 and `SCREEN_DAILY_MAX`
  runs per UTC day. CORS for `APP_ORIGINS`, with a preflight.
- `GET /v1/screens`: the records (at most 500, by rig id), from memory; `GET /v1/screens/<rigId>/artifact`: the artifact's exact bytes, named by its
  hash, for anyone to `screen verify`. Both behind the read limiter.
- Telegram: PASS with the owner-page link, FAIL with its reason, errors, and a queue pause on a protocol change.
- After a change of the reviewed constants (or any vendored screen source), re-sync and redeploy: on start the keeper
  queues again every PASS still waiting for a signature, because its tool hash changed. Do not sign an older PASS.
- Artifacts live next to the state file (`<dirname(STATE_PATH)>/screen-artifacts/`); records in `state.json` (`screen`).
- Settings: `SCREEN_VERIFY_BSC_RPC` (required to open registration), `SCREEN_BSC_RPC` (default `BSC_RPC`),
  `SCREEN_XLAYER_RPC` (default the first `XLAYER_RPC`), `SCREEN_VERIFY_XLAYER_RPC` (default another public X Layer node),
  `SCREEN_APP_URL` (default `https://app.tapepool.io`), `SCREEN_DAILY_MAX` (default 20). Without `SCREEN_VERIFY_BSC_RPC` the
  route answers "registration is not open" and nothing changes.
- **Endpoint lists (owner, 2026-11-21: public first, QuickNode only as the fallback).** Each `SCREEN_*` RPC variable is an
  ordered, comma-separated list. Within a run, a transport failure (no answer after the retries, an HTTP error, a block
  the node does not have) moves that side to its next URL; a revert or any verdict never does. Every run starts again from
  the first URL. The reproduction never uses the provider that served the check (the last two host labels, so two
  QuickNode keys are one provider), also after a fallback: if no other provider answers, that run gives no PASS and is
  retried later. Each record shows which provider served each side (`hosts`, never a URL). Every BSC entry is redacted.
  Recommended Railway values (both public BSC endpoints served rig 19's check and reproduction on 2026-11-20):

  ```
  SCREEN_BSC_RPC=https://bsc-dataseed.binance.org,<the QuickNode BSC_RPC>
  SCREEN_VERIFY_BSC_RPC=https://bsc-mainnet.public.blastapi.io,<a second fallback of the owner's choice, or omit>
  ```

  Leave the X Layer variables unset: the check uses the first `XLAYER_RPC` (`https://xlayer.drpc.org` on Railway) and the
  reproduction `https://rpc.xlayer.tech`. The first entries of the check and verify lists must be different providers,
  or the keeper refuses to start.

## Redeploy 4 cutover (RB4-03, RD4-11)

The owner performs this cutover after the reviewed code and deployment gates pass. Code and environment move
together. The configuration key names are unchanged; `KEEPER_CUTOVER_RD02` retains its historical name and means
the old-stack check has passed. There is no `KEEPER_POLICY`: startup reads the selected pool's `policy()` and
refuses an unreadable, malformed or zero answer. The existing `FEED_SETTLE`/`feedEnabledAt` interface guard does
not prove redeploy 4 bytecode or feed pins; RD4-06 supplies that proof.

1. Have the new locked reporter/receiver and pool stack deployed, the RD4-06 parity and stack gates passed,
   and RD4-08 `CheckOldStack` passed on the retired 2026-11-02 stack. Take addresses and block heights from the
   reviewed deploy log. Keep the new pool's borrows paused while completing the launch steps.
2. Put the **old process in `KEEPER_MODE=dry` first**, keeping its old code, addresses and `STATE_PATH`.
   Confirm `/healthz` reports dry mode. Let it poll and reconcile every pending transaction on both chains.
   Inspect the old state file's `pendingTx.bsc` and `pendingTx.xlayer`; both must be empty, with every original
   and replacement hash accounted for. A journal entry removed because its nonce passed without a receipt is
   not proof of reconciliation: resolve its actual chain outcome before proceeding. Do not delete the journal
   to make it empty. Keep the existing signer credentials in the service environment; do not copy a key
   into a command, the repository or a chat.
3. Once reconciliation is complete, stop the old process and archive its state. If `harvestLandings` still
   contains unlanded guids, retain that watch: wait for their verified landing or preserve only those entries
   in the new state file. Do not abandon pending harvest deliveries when changing the state path, and do not
   copy the old pending-transaction journal, agent cursor or per-loan timers into the new file.
4. Stage the reviewed keeper code with this complete environment replacement, still in dry mode:

   | Key | New deployment value |
   |---|---|
   | `KEEPER_POOL` | New X Layer pool |
   | `KEEPER_FACTORY` | New X Layer factory |
   | `KEEPER_SCREEN` | New X Layer screen |
   | `KEEPER_LENS` | New X Layer lens |
   | `KEEPER_RECEIVER` | New X Layer feed receiver |
   | `KEEPER_REPORTER` | New BSC feed reporter |
   | `KEEPER_FACTORY_DEPLOY_BLOCK` | Actual new factory deployment block on X Layer |
   | `KEEPER_POOL_DEPLOY_BLOCK` | Actual new pool deployment block on X Layer |
   | `KEEPER_RECEIVER_DEPLOY_BLOCK` | Actual new receiver deployment block on X Layer |
   | `KEEPER_REPORTER_DEPLOY_BLOCK` | Actual new reporter deployment block on BSC |
   | `KEEPER_CUTOVER_RD02` | `confirmed`, only after the old-stack check |
   | `STATE_PATH` | A different file on the persistent volume, for example `/data/redeploy-4-state.json` |
   | `KEEPER_MODE` | `dry` |

   Retain the existing service secrets and RPC settings in the service environment. Set `APP_ORIGINS` for the
   matching app. Every address must be non-zero and every block a positive integer; a partial replacement is
   rejected. Do not reuse the retired feed addresses or heights. With no replacement keys, the legacy address
   book remains the default, so verify the selected addresses explicitly after starting.
5. Start the new process in dry mode on the new state path. After a full cycle, require no job errors and a
   non-zero `/healthz.lastCycleAt`. `/healthz` and `/v1/stats` must both show the deploy log's new `pool`,
   `receiver` and `reporter`, plus the `policy` read from that pool at startup. HTTP requests use cached data
   and perform no chain reads. `/v1/stats` can return 503 while warming up; its body still identifies the new
   stack. Once it returns 200, verify current `asOf`/`block` data. A fresh state rebuilds the pool's snapshots
   and position index instead of serving the retired pool's history.
6. The owner funds the keeper's BNB and OKB as required by RD4-11, confirms the dry-run results, and explicitly
   authorizes live mode. Only then set `KEEPER_MODE=live` for this new process. Check one complete live cycle
   without an error and recheck `/healthz` and `/v1/stats` identities. Keep the retired process stopped.
   Point the app's `VITE_KEEPER_URL` to this keeper together with its redeploy address book (RC4-01/RD4-12).
   Borrow unpausing remains the owner's separate RD4-13 action after its launch gates pass.

These steps are an operator runbook. Editing code or this document does not switch the running service,
change any deployment address, enable live mode, fund a wallet or authorize a transaction.
