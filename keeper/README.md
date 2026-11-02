# Tape Pool keeper

Off-chain keeper and guardian for Tape Pool.
Every 60 s it checks the TapeOut implementations against reviewed constants (and pulls the guardian
brakes on a confirmed upgrade), follows admin events, harvests rigs with open loans on BSC, runs the
per-loan impairment machine (suspend, push, flag, seize, clear), sweeps repayments, and alerts the owner
on Telegram. `POST /v1/push` pushes fresh rig reports for borrowers, within limits.

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
- Our contract addresses live in `src/addresses.ts` (`DEPLOYMENT`), filled after deployment. Until then
  only the upgrade watch and the balance checks run.

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
