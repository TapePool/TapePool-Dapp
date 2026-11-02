# TapePool app

The web app of TapePool: lenders supply BEM and receive tpBEM, and TapeOut miners borrow against the rigs they bridged to
X Layer. It is a static page (vanilla TypeScript, Vite, viem). It reads the deployed contracts through public RPCs and
signs only through the user's own browser wallet. There is no server of its own, no key, no analytics and no third-party
script.

```bash
npm ci --ignore-scripts      # exact versions, no install scripts
npm run dev                  # dev server; add ?fixture=<name> to render a page from fixtures, no chain
npm run build                # typecheck + production build into dist/
```

Node 22 or newer. Windows, macOS and Linux all work; the Playwright tests drive the Edge that is installed on the machine.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server (no Content-Security-Policy: the dev server needs inline styles) |
| `npm run build` | `tsc --noEmit`, then `vite build` into `dist/` (multi-file; policy inside `index.html`) |
| `npm run build:single` | the whole app in one file, `dist-single/index.html` (the DeWEB fallback, below) |
| `npm test` | unit tests (vitest): render, reads, writes, parity with the Solidity maths, and the build tooling |
| `npm run typecheck`, `typecheck:e2e` | TypeScript for the app and tests, and for the Playwright code |
| `npm run check:cn` | the Chinese copy must pass the settled-terms checker with 0 errors |
| `npm run check:size` | size, DeWEB chunks and gas per file; fails on a total above 500 KB, a keyed RPC, a value from `.env`, fork or test content, a host not on the allowed list, or a weaker policy |
| `npm run verify` | typecheck, typecheck:e2e, tests, build, build:single, check:cn, check:size |
| `npm run headers` | the response headers a static host should send, taken from the built page |
| `npm run e2e` | the fork end-to-end tests on anvil forks of X Layer and BSC (below) |
| `npm run smoke:mainnet` | read-only smoke test of the mainnet builds against the public RPCs (below) |
| `npm run deweb:plan`, `deweb:verify`, `deweb:rehearse` | DeWEB publishing tools (below) |
| `npm run gen:abi` | rewrite `src/chain/abi/*.ts` from forge's `out/` (`forge build` first) |
| `npm run gen:vectors` | rewrite the parity vectors in `test/vectors/` from the Solidity code (needs forge) |

## Configuration

Build-time settings, read by Vite from the environment (names only; none of them is a secret):

| Variable | Meaning |
|---|---|
| `VITE_NETWORK` | `mainnet` (default: the retired 2026-10-21 stack), `redeploy` (the live 2026-11-02 stack; use it for every build you publish) or `fork`. `fork` bakes in `test/fork-addresses.json`, written by the e2e setup, and talks only to local nodes. Never publish a fork build: `check:size` fails on one. |
| `VITE_KEEPER_URL` | base URL of the keeper's read-only routes and the push route. `https`, or `http` on a local host; anything else is ignored. Unset: the app calls no keeper. It is **baked into the build**, so changing it means a new build (and, on DeWEB, an update transaction set). Its origin is added to the policy's `connect-src` automatically. |
| `VITE_TAPELENS_ADDRESS` | a deployed `TapeLens`. Unset: the app places TapeLens's runtime code at a dummy address for its `eth_call` quotes (SPEC O-1). |

The e2e tests need one more name in the environment, never bundled and never printed: `BSC_RPC`, an archive BSC endpoint
(it lives in the git-ignored `../.env`). The mainnet app itself uses only the two public RPCs
`https://rpc.xlayer.tech` and `https://bsc-dataseed.bnbchain.org`. A keyed RPC URL must never be put in the app;
`check:size` fails if one, or any value of `../.env`, is in a build.

## Content-Security-Policy

`vite build` writes this policy into `index.html` as a meta tag (and a `no-referrer` policy next to it). It is built from the
same configuration the app reads, so it always names exactly the endpoints the app will call:

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self';
connect-src https://rpc.xlayer.tech https://bsc-dataseed.bnbchain.org [<keeper origin>]; base-uri 'none'; form-action 'none'
```

No `'unsafe-inline'`, no `'unsafe-eval'`, no inline script, no `style` attribute anywhere (dynamic sizes are applied through
the CSS object model, which the policy allows). The single-file build swaps `script-src` and `style-src` for the SHA-256 hash
of its one inline script and style, and `font-src` for `data:`.

## HTTPS hosting

The same `dist/` works on any static host: relative paths only (`base: './'`), hash routing (`#/app/...`), so the host needs
no rewrite rule and no server code. This README does not choose a host.

Send these headers (`npm run headers` prints them from the built page, so they cannot drift from the meta tag):

```
Content-Security-Policy: <the policy above>; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

- `frame-ancestors` can only be sent as a header; a meta tag ignores it. The app also refuses to show any write control inside a
  frame, but the header stops the framing in the first place.
- `Content-Type` must be right for scripts (`text/javascript`), styles, fonts and SVG: `nosniff` makes the browser obey it.
- `Cache-Control: public, max-age=31536000, immutable` for `/assets/*` (their names carry a content hash) and `no-cache` for `index.html`.
- **Keeper CORS.** The keeper answers only the origins in its `APP_ORIGINS` (comma-separated). Add the origin of every place the
  app is served from: the HTTPS host, and for DeWEB both gateway origins, `https://1-2-382.tapekit.org` and its compatibility
  tier `https://1-2-382-open.tapekit.org`. A browser sends the origin with no path.

## The mainnet smoke test

`npm run smoke:mainnet` is opt-in (it needs the network and Edge). It builds the mainnet app in a clean environment (no
`VITE_*`, no `BSC_RPC`), both multi-file and single-file, serves each with the headers above and, in Edge, loads
`#/app/markets`, `#/app/markets/bem`, `#/app/view/0x65C0eC42E1dB3a92727ccD3cb3aF3aCb1b97C8dF` and its `/rigs`. For each page it
requires live data on screen and **no** console error, page error, failed request, policy violation, request to anything but
the two RPCs, wallet in the page, or JSON-RPC method outside a read-only list. No transaction is sent and no wallet exists.

## Fork end-to-end tests

`npm run e2e` (needs `BSC_RPC` in the environment, for example `node --env-file=../.env ./node_modules/@playwright/test/cli.js test`)
starts two anvil forks, deploys a fresh stack, runs the keeper in process and drives the built fork app in Edge with an
injected test wallet that signs as the impersonated miner. Nothing touches a live chain. The scenarios are listed in
SPEC-PHASE5-APP §14.2; `-g "exit criterion"` runs the first one (the whole borrow flow).

## Publishing on DeWEB

DeWEB stores a site as files on X Layer, in the container of a TapeOut circuit, and serves it at the circuit's name through
a gateway whose service worker reads the files from the chain and checks their SHA-256 (TAP-10, TapeKit). TapePool's site lives in
the container of its own circuit, "Tape Pool Policy": Circuits `0xdc76f123838b5398A173D215a2c8338Ad189C9a8`, circuit id 1, held by
`0x04974a7F899813dBaf0046469Ea73Ff0a5E352F3`.

| | |
|---|---|
| name | `1.2.382.tape` (circuit 1, X Layer area code 2, processor number 382) |
| address | `https://1-2-382.tapekit.org/`; browsers that cannot install a service worker are sent to `https://1-2-382-open.tapekit.org/` |
| container | `0xB309F98E699cE69A50A2136700337bA656bc145E` (the ERC-6551 account; it exists only after `open`) |
| store | SiteRegistry `0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6`; payment DomainBinding `0x68809Fd2fb343aA57D0aeB7f33Defe477c9666f9`; opener `0x536adD8F30f03b69f6fbF29d425A816A0dC50106` |

A file is written in chunks of at most 24,000 bytes, one transaction each: `putFile` carries the first, `appendChunk` each later
one. There is no per-file size limit below 8.4 MB, so the build is not split by size. Everything is signed by the circuit holder.

### What the tools do

All three commands live in `scripts/deweb.mjs`. `plan` and `verify` only read the chain (the public RPC by default) and contain
no signing code. `rehearse` is the only command that sends, and only to a local anvil node: it requires a local `http` address,
`web3_clientVersion` saying anvil, and chain id 196, and refuses everything else.

```bash
npm run build && npm run build:single

# 1. what would be sent, in order, with calldata, gas and the holder's balance check (read-only)
npm run deweb:plan -- --dir dist --months 3 --out deweb-out   # --chunk-bytes 12000 for a Windows command line, see below
# 2. the same plan, run for real on a local fork of X Layer, then read back byte for byte
npm run deweb:rehearse -- --dir dist --dir dist-single --update-test --fee-test --script
# 3. after the real publish: is the chain's content exactly this build? (read-only)
npm run deweb:verify -- --dir dist
```

`plan` prints, and with `--out DIR` writes: `plan.json`, one raw calldata file per transaction, and `publish.sh`, a bash script
of `cast send` lines. Nothing in it runs by itself. Keep that folder out of git (`deweb-out/` is ignored).

### The owner's steps

1. **Decide the keeper URL first.** `VITE_KEEPER_URL` is baked into the build. Build with it set, or accept a later update.
2. **Build** (`npm run build`, or `npm run build:single` for the one-file form) and run `npm run check:size`.
3. **Fund the holder.** The holder needs the 0.08 OKB open fee, the monthly fee (`monthlyFee()`, 0 when this was written) and gas
   (about 0.002 OKB; the plan prints the figure and compares it with the holder's balance).
4. **Choose how long the name stays live.** `plan` requires `--months N` while a `bind` step is planned; there is no default.
   A month is 30 days. The plan prints the date the name stops being live and warns when that is before the submission deadline
   of 2026-12-07 (a Demo Day follows it): a name bound for one month in late October would show "unpaid" to the judges.
   `monthlyFee()` is 0 when this was written but the contract owner can change it at any time. Run `plan` again right before
   signing: it re-reads the container state, the fee and the gas price. `bind` takes exactly `months x monthlyFee()` as its
   value: the contract reverts on less and on more.
5. **Sign the transactions in the plan order.** The order matters: `open` first (only while the container does not exist),
   every asset, `index.html` last, `setFallback`, and `bind` last, so that nothing a visitor can open is ever half uploaded. How
   to sign is the owner's call; the holder is a cast keystore, and the options are:
   - `bash publish.sh` with `CAST_SIGN_ARGS="--account <keystore name>"`. Cast asks for the keystore password for each
     transaction: 28 prompts, or 44 at the Windows chunk size. A 24,000-byte chunk is
     48,000 hex characters, which is more than a Windows command line can carry, so on Windows plan with
     `--chunk-bytes 12000` (a smaller chunk is allowed by the protocol: 44 transactions instead of 28). Under WSL or Linux the
     default size works.
   - `CAST_SIGN_ARGS="--browser"` to approve each transaction in a browser wallet, if the circuit NFT is moved to that wallet.
   - `setOperator(container, operator, ttl)` from the holder, so that another wallet uploads the files while the holder keeps
     `open` and `bind`. It can only be sent after `open`, because the container must exist.
   **If a step fails, do not run `publish.sh` again from the top** (`open` would revert, and finished files would be sent
   twice). Run `plan --out` again: it reads the chain, skips every file that is complete, re-sends a half-uploaded file from its
   first chunk, and writes a new script for what is left.
6. **Check**: `npm run deweb:verify -- --dir dist`, then open `https://1-2-382.tapekit.org/`, the same with `-open`, and
   `https://1-2-382.tapekit.org/.tape/status` (the gateway's own status page: identity, activation, verification, off-chain
   requests). Add both origins to the keeper's `APP_ORIGINS`.

### Updating

Rebuild and run `plan` again. Files already on chain with the same size, hash and content type are skipped, so an update sends
only the changed script (new content hash, so a new path) and `index.html`; `--prune` adds a `removeFile` for paths the new build
no longer has. Upload order again puts `index.html` last. A half-uploaded file shows a shorter size under the declared hash, so
`plan` always re-sends it and a shell never shows it as complete.

**The multi-file form updates without a gap; the single-file form does not.** In the multi-file form the new script goes to a
new path while the old page keeps working, and the page that points at it is one chunk, swapped in a single transaction.
`putFile` on an existing path replaces the file at once, and a half-written file is `incomplete`, which a shell refuses to show.
So updating the one 19-chunk `index.html` of the single-file form leaves the live site unservable until its last chunk lands
(about 19 transactions). Do such an update at a quiet time, or prefer the multi-file form for a site that is already being used.
An update of the multi-file form measured 14 transactions and 63.8 M gas (about 0.0013 OKB) when only the script changed.

### The single-file fallback

`npm run build:single` makes `dist-single/index.html`: the script, the stylesheet, the fonts and the images all inside one file
(about 440 KB, 19 chunks), with a policy that allows the one script and the one style by SHA-256. Use it if the gateway rejects
`'self'`, serves multi-file sites badly, or the module scripts do not load. `plan` and `rehearse` take `--dir dist-single`.
Publish only one of the two forms: they use the same path `index.html`, so switching later is an ordinary update.

### What a fork cannot check

The rehearsal proves the contracts' behaviour with the real code: opening, chunked upload, read back with `read` and `readRange`
the way a shell does, SHA-256 of every file, `pathCount`, the fallback, `isLive`, replacing and removing files, who may write,
and the gas of every step. It cannot check:

- the real gateway: its service worker, module scripts, MIME handling, how its own response policy combines with the page's
  meta policy, whether a page may be shown in a frame, the `-open` tier. What is known of the gateway comes from TapeKit's
  reference `sw-gateway` source (its `serve.js` sends a policy with every site file: scripts from the site, `unsafe-inline`,
  `connect-src https:`, `frame-ancestors 'self'`), not from observing tapekit.org. Both policies apply, so the page's stricter
  meta policy is the one that counts;
- a real node's input limit (reth may refuse input above 128 KiB; the largest transaction here is 24,324 bytes) and public-node rate limits;
- a data fee on top of gas (X Layer's gas price oracle reports 0 today; the fork shows none either way; `plan` asks the oracle each time),
  and the block-level data-size limit that X Layer's receipts hint at (`daFootprintGasScalar` 400): the fork does not model it, and
  the gas per transaction above does not depend on it;
- the wallet's own handling of a 24 KB `data` field.

The "100% on-chain" badge is not expected: a service-worker gateway never claims it (TAP-10 §9), and the app calls two public
RPCs (and the keeper) at runtime. The static scan of the page's HTML and CSS, which `check:size` repeats, finds nothing off chain.

## Known limits

- No WalletConnect. "Connect wallet" opens a two-column dialog in the style of a common wallet-connect modal: on the left "Installed"
  lists every wallet found in the browser (EIP-6963, or the plain `window.ethereum` as "Browser wallet" when none announced itself; the
  one used last carries "Recent" under its name) and "Recommended" lists Binance Wallet, Trust Wallet, Rabby Wallet, MetaMask and OKX
  Wallet when they are not installed. On the right it explains what a wallet is (with "Get a Wallet" and "Learn More"), shows the wallet
  being asked ("Opening ..." and, if it refuses, the reason with a Retry button), or shows "Get a Wallet" / "Get <wallet>" with a link
  to the official download page. On a phone it is a bottom sheet with one column at a time and a back arrow. The links are on the
  `check:size` host allow-list (six hosts); they open in a new tab and are never requested.
  The logos of the six wallets (Phantom only as a logo for an installed one, never recommended) and the two illustrations are SVG files copied from the MIT-licensed `@rainbow-me/rainbowkit` 2.2.11
  package into `src/assets/wallets/` (licence and provenance in `LICENSE-rainbowkit.txt`; `test/walletAssets.test.ts` checks that no file
  holds a script, handler, link or external reference). They are only ever `<img src>` files, never fetched at run time. A wallet's name
  and icon are untrusted: its own icon is used only if it is a base64 image data URI; a wallet that announced a known `rdns` but an
  unusable icon gets the shipped logo; any other gets a letter badge. The silent reconnect on load goes to the wallet used last, else
  OKX Wallet, MetaMask, Rabby in that order. A wallet that refuses both the switch to X Layer and the add says so. Mobile wallets outside
  OKX's in-app browser are later.
- The connected wallet pill (a person icon and the short address) opens a menu: wallet name and icon, the address as first six and last
  six characters on one line (the whole address as its tooltip) with a copy icon that says "Copied!" for a moment, View on explorer,
  Disconnect. Where nothing can copy, the whole address is shown to select by hand.
- A CLI or hardware-only holder cannot connect a browser wallet: `#/app/view/<address>` shows everything read-only, with every
  write control off. Calldata export for CLI wallets is a recorded debt.
- No USD prices: the OKB operating fee is shown in OKB, and the total-cost percentage waits for a price source (SPEC §7.4).
- The FabX / FAB entries are "Coming soon" placeholders on purpose.
- Borrower Telegram alerts are not built (the Alerts card shows its button off).
- `redeploy` builds call the deployed `TapeLens`. On `mainnet` (the retired stack) `TapeLens` is not deployed, so quotes use a state override on `eth_call`, which works on `rpc.xlayer.tech`.

### Local Tape demo

Run `app-dev.cmd` and open **Tape** from the normal app navigation, or go straight to `http://localhost:5173/#/app/tape`. Tape is an ordinary route of the development app: the link only changes the hash, so the page, its query (language included), the wallet connection and the in-memory game all stay as they are when you move between Tape and the other tabs. The production app does not include it.

It also works inside a fixture session (`?fixture=disconnected#/app/tape`). The game uses a separate virtual BEM balance and never uses the wallet. Select a stake and click a future target. A ticket wins when an observed price sample touches its half-open price range during its half-open five-second window. Payout is gross, rounded down to one 8-decimal BEM unit. The fixed row size is five cents, the earliest target opens at least 10 seconds ahead (two to three columns from the price), and quotes expire after one second of game time.

Prices are real and come from one source only: the OKB-USD index from OKX's public WebSocket `wss://ws.okx.com/ws/v5/public`, channel `index-tickers`. Public market data needs no account and no API key. The opening line is the last 120 s of 1 s index candles from `GET /api/v5/market/index-candles`. Every 200 ms sample holds the newest index price. The feed pings after 20 s of silence (OKX drops a socket after 30 s), reconnects with growing delays, and reconnects when OKX announces a service upgrade (notice code `64008`; other notices are informational). When no price is fresher than 5 s, or before the first one, the game waits: no samples and no deadlines pass until a price returns. Bets are taken only while live samples are flowing: waiting or just back on the tab, the grid dims and a click is refused, because the real market keeps moving while game time stands still, and quotes from before such a stop are void. Leaving Tape closes the socket. Development has no Content-Security-Policy; a production build would need `wss://ws.okx.com` in `connect-src`, and the DeWEB gateway allows only `https:`. There is no simulated price: without OKX, Tape waits.

Multipliers follow the recent volatility of the price shown: the model takes the chance that a random walk, with the spread of the last 120 s measured over 10 s changes, touches the target during its window, and pays 95% of the fair price for that chance, between 1.01× and 8×. The model is conservative. Measured on 2026-10-30, every group of targets by distance and lead returned less than the stake on average: 0 to 0.85 per 1 BEM staked replaying 24 minutes of the real index, and 0.46 to 0.70 on seeded trending price paths, which a test keeps below 1. These are demo prices, not an offer. On a quiet OKX index most targets more than a row away sit at 8×. Settled targets stay marked Won or Lost on the board until they scroll off, and the Open and History tables list every ticket with a session summary. There is no pause or reset control: a hidden tab and leaving Tape freeze game time and deadlines without catch-up, and reloading the page starts a new session. The session exists only in memory and the feature is absent from production builds.
