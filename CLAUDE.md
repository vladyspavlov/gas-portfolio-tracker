# CLAUDE.md — GAS Portfolio Tracker v2

## Project overview

Google Apps Script that fetches raw DeFi position data (Fluid/Base, Aave/Arbitrum, GMX/Arb+Base) every hour and writes one snapshot row to Google Sheets. All calculations happen in Sheets formulas — the script is a pure data writer.

**Stack:** Google Apps Script (V8 runtime) · clasp · GitHub Actions CI/CD · Google Sheets (formula engine)

---

## Architecture — core constraint

```
GAS Script                     Google Sheets
──────────────                 ─────────────
HTTP fetches     →  raw nums → Snapshots tab  →  Metrics tab (ARRAYFORMULA)
(Fluid, Aave,                                 →  Dashboard tab (INDEX/COUNTA)
 GMX, RPC)                                    →  Charts (native editor)
```

**GAS writes only raw numbers. Zero calculations in script code.** If you find yourself computing NAV, carry, or any ratio inside JS — stop and move it to a Sheets formula.

---

## File structure

```
gas-portfolio/
├── .claude/
│   ├── commands/
│   │   ├── check-secrets.md
│   │   ├── validate-columns.md
│   │   └── add-data-source.md
│   └── settings.json
├── .github/
│   └── workflows/
│       └── deploy.yml
├── src/
│   ├── appsscript.json      ← GAS manifest (timeZone, runtimeVersion)
│   ├── Main.js              ← snapshotPortfolio() entry point
│   ├── Config.js            ← Config tab reader + PropertiesService
│   ├── Fluid.js             ← POST to fluid-data-reader service
│   ├── Aave.js              ← Aave subgraph GraphQL
│   ├── GMX.js               ← GMX API + eth_call balanceOf via RPC
│   ├── Lido.js              ← wstETH stEthPerToken() rate (noise-free staking yield)
│   ├── Transactions.js      ← DORMANT auto-scanner (eth_getLogs); superseded by the MANUAL ledger
│   ├── Utils.js             ← hexToDecimal, retry, safeNull, lastDataRow, logger
│   └── migrations/          ← one-time, manually-run schema migrations (NNN_ prefix)
│       ├── 001_tall_schema.js                 ← positions→13-col tall + Metrics A–W formulas
│       ├── 002_transactions_pnl.js            ← Transactions tab + Metrics X/Y (net_capital_in, pnl)
│       ├── 003_transactions_price_formulas.js ← (interim) per-row price formulas + cursor reset
│       └── 004_manual_ledger.js               ← Transactions → manual ledger (value/flow array-formulas)
├── .clasp.json.example      ← template for local dev (committed)
├── .gitignore
├── CLAUDE.md
└── package.json
```

---

## Key commands

```bash
# Install clasp globally (once)
npm install -g @google/clasp

# Authenticate clasp locally (creates ~/.clasprc.json — never commit)
clasp login

# Copy example config and fill in your SCRIPT_ID
cp .clasp.json.example .clasp.json
# then edit .clasp.json with your actual scriptId

# Push code to GAS (local dev)
clasp push

# Open GAS editor in browser
clasp open

# Tail execution logs
clasp logs --watch

# CI/CD deploy (automatic on push to main)
git push origin main
```

---

## Security rules — CRITICAL for public repo

> These rules are non-negotiable. The repository is public.

1. **Never hardcode** wallet addresses, RPC URLs with API keys, subgraph URLs with auth, or any numeric identifier that could link to a real account.
2. **Config tab** in Google Sheets holds all addresses and URLs — the script reads them at runtime via `Config.getAll()`. No defaults in code.
3. **Script Properties** (GAS PropertiesService) hold secrets: `ALCHEMY_ARB_KEY`, `ALCHEMY_BASE_KEY`, `COINGECKO_KEY`. Never log these values.
4. **`.clasp.json`** is gitignored — it contains `scriptId`. Use `.clasp.json.example` as the committed template.
5. **`.clasprc.json`** (clasp OAuth tokens) is gitignored globally via `~/.gitignore_global` — confirm this is set up locally.
6. **Logger.log()** calls must never include: API keys, full addresses, raw HTTP responses with sensitive data. Log summaries only (e.g., `"Fluid OK: 4 prices, 2 positions"`).
7. Before each commit: run `/check-secrets` (see `.claude/commands/`).

---

## Data flow — four "tall" tabs (one row per position/event, not per protocol)

The script writes to three **append-only data tabs** (Snapshots/Positions/Risk). They hold **literal
values only — never formulas** (see "Append-cursor constraint" below). Adding/removing a venue means
adding/removing rows, not columns, so Metrics/Dashboard formulas never need editing.

The three data tabs are written by the **hourly** `snapshotPortfolio()`. A fourth tab,
**Transactions**, is a **manually-maintained capital-flow ledger** — you type your real money-in/out
events by hand and Sheets computes the P&L (see "Transactions — manual ledger" below). It is NOT
written by any trigger; the old `syncTransactions()` auto-scanner is **dormant** (it cannot see
native-ETH exchange funding and the keyless price API is unreliable from GAS — see that section).

**Snapshots** — 7 cols, 1 row per snapshot (headline prices + status):

| Col | Field |
|-----|-------|
| A | timestamp |
| B–E | eth_usd, btc_usd, wsteth_usd, cbbtc_usd |
| F | error_flags (`""` = OK) |
| G | wsteth_steth_rate — Lido on-chain `stEthPerToken()`; optional, blank if RPC_ETH not set |
| H | lido_apr — Lido published 7-day SMA APR (decimal); warm-up fallback for staking yield |

**Positions** — 13 cols, N rows per snapshot (one per position):

| Col | Field | Notes |
|-----|-------|-------|
| A | timestamp | batch key — identical across all rows of one snapshot |
| B | protocol | `fluid` / `aave` / `gmx` / … |
| C | chain | `base` / `arbitrum` |
| D | category | `lend` / `lp` (future: `perp` / `spot`) — derived in-module |
| E | position_id | `user` / nft id / market addr / `gmx_account` |
| F | token | asset symbol |
| G | side | `supply` / `borrow` / `lp` |
| H | amount | raw units |
| I | price_usd | per-row price (new tokens not tied to Snapshots' 4 price cols) |
| J | value_usd | **unsigned** (≥0) — gross value |
| K | value_signed_usd | **signed** (debt negative) — `NAV = SUM` of this |
| L | apy | decimal (not %) |
| M | daily_carry_usd | signed = `value_signed_usd * apy / 365` |

**Risk** — 6 cols: `timestamp · protocol · chain · position_id · health_factor · ltv`

**Transactions — manual ledger** — 11 cols, one row per real money-in/out event you enter by hand.
You fill **A, B, E, F, G, H**; `value_usd` (I) and `capital_flow_signed_usd` (J) are **column
array-formulas** installed by migration 004 (header bundled in row 1, auto-extend as you add rows):

| Col | Field | Notes |
|-----|-------|-------|
| A | timestamp | date of the tx (used to align with the P&L time series) — **you enter** |
| B | chain | `arbitrum` / `base` — you enter (reference only) |
| C | protocol | optional note (counterparty label) |
| D | counterparty | optional note (address) |
| E | token | asset symbol — you enter |
| F | direction | **`in`** = money into wallet (exchange→you) = **+**; **`out`** = money out = **−** — you enter |
| G | amount | token units — you enter |
| H | price_usd_at_tx | USD price that day — **you enter** (blank → I/J blank until filled) |
| I | value_usd | **formula** `=amount × price` (col array-formula) |
| J | capital_flow_signed_usd | **formula** `=value × sign(direction)`; **Net Capital In = SUM of this** |
| K | tx_hash | optional note — explorer reference (no `log_index`/`block_number`: those were scanner-only) |

Every `positionRows.push([...])` must have 13 elements; every `riskRows.push([...])` 6.
Run `/project:validate-columns` to check the Positions/Risk/Snapshots writers. (Transactions has no
writer — it's hand-entered.)

### Append-cursor constraint (load-bearing — applies to the 3 auto-written tabs)

A formula (ARRAYFORMULA/BYROW) on a tab that gets `appendRow`/`setValues` auto-extends down its
column, so `getLastRow()` returns the formula's last filled row and the next write lands past the
real data, leaving gaps. **Therefore the three auto-written data tabs (Snapshots/Positions/Risk)
stay formula-free; their aggregations live on the Metrics tab** (never appended to).
`Utils.lastDataRow()` (scans col A) is the append guard. This is why per-row Positions
`value_usd` / `value_signed_usd` / `daily_carry_usd` are computed in JS as literals.

**The Transactions tab is exempt** — nothing appends to it programmatically (it's hand-entered), so
its `value_usd` / `capital_flow_signed_usd` columns CAN safely be auto-extending array-formulas.

---

## Module contracts

### `Config.getAll()` → `{[key: string]: string}`
- Reads Config tab as two-column key-value table
- Secrets fetched from PropertiesService (not from tab)
- Returns merged object; caller checks for missing keys

Each data module exposes `buildRequest(...)` (returns a `UrlFetchApp.fetchAll` request object) and
`parseResponse(...)` / `parseResult(...)` (returns `{ positionRows, riskRows, prices?, error }`).
`positionRows` are 13-col arrays, `riskRows` 6-col. `error` is a tag string (`null` on success);
Main.js collects tags and **skips the whole snapshot** if any module errored (no partial rows).

### `Fluid.parseResponse(response, timestamp)` → `{ prices, positionRows, riskRows, error }`
- `buildRequest`: POST to `config.FLUID_SERVICE_URL + "/positions"` with `{ address: config.BASE_ADDRESS }`
- `prices` (eth/btc/wsteth/cbbtc) feed Snapshots **and** are passed into `Aave.parseResponse` for value_usd
- Emits a `supply` + a `borrow` position row per vault, `category='lend'`; one risk row per vault
- On error: empty rows + `'FLUID_ERR'`

### `Aave.parseResponse(response, accountDataResp, timestamp, prices)` → `{ positionRows, riskRows, error }`
- `buildRequest`: GraphQL to The Graph; address lowercased. `buildAccountDataRequest`: `getUserAccountData` via eth_call
- APY conversion: `rayValue / 1e27` (decimal, not percent); token amounts ÷ `10^decimals`
- `supply`/`borrow` rows with `category='lend'`; stablecoins priced at $1, others from Fluid `prices`
- Account-level HF/LTV → one risk row. On error: empty rows + `'AAVE_ERR'`

### `GMX.parseResult(marketsInfo, apy, arbMarkets, arbBal[], arbSup[], baseTokens, baseBal[], accountResp, accountMarket, timestamp)` → `{ positionRows, error }`
- Markets/APY come from GMX HTTP API; balances from per-market eth_call `balanceOf` (Arb) + Base RPC
- GM price = `poolValueMax / totalSupply`; Base tokens reuse the same-index Arb market's price/APY
- One `lp` row per market/token (`category='lp'`, value positive so unsigned == signed); no risk rows
- On error: null-filled rows + `'GMX_ERR'`

### `Lido.buildRateRequest(config)` / `Lido.parseRate(response)` → Number | null
- Mainnet `eth_call` to wstETH `stEthPerToken()` (0x035faf82) → noise-free wstETH→stETH rate (~1.2)
- **Optional & non-blocking**: `buildRateRequest` returns `null` if `RPC_ETH_URL`/`RPC_ETH_KEY` unset;
  `parseRate` returns `null` on any failure and never writes to `error_flags` (won't skip the snapshot)
- Written to Snapshots G; the staking-yield metric uses this instead of the noisy USD price ratio
- `Lido.buildAprRequest()` / `parseApr(response)` → published 7-day SMA APR (decimal) from a public
  GET (no key); written to Snapshots H as the warm-up fallback before G has a full 7-day window

### `Txns` (Transactions.js) — DORMANT auto-scanner (kept for reference, gated off)
- **Status: not used.** The capital-flow ledger is now **hand-entered** (see "Transactions — manual
  ledger" + migration 004). This scanner stays in the bundle, gated by `TX_SYNC_ENABLED` (keep it
  `false`) with no trigger. **Why it was abandoned:** `eth_getLogs` only sees ERC-20 `Transfer`
  events, so **native-ETH exchange funding** (e.g. ETH withdrawn from Kraken — the actual cost
  basis) is invisible to it; and the keyless CoinGecko price API is throttled hard from GAS's shared
  IPs. A block-explorer API (Etherscan V2: `txlist`+`txlistinternal`+`tokentx`) would be the right
  tool to revive automation, but manual entry was chosen instead (transactions are infrequent).
- If revived: it scans Infura `eth_getLogs` for `Transfer` topic-filtered by wallet, labels each
  base-asset transfer by `Txns.PROTOCOLS[chain]` (or `'external'`), prices via CoinGecko, and is
  idempotent (`tx_hash`,`log_index`) + resumable (`TX_SCANNED_<ARB|BASE>` cursor, short chain code —
  NOT `chain.toUpperCase()`). `direction 'in'` = **+** (received), `'out'` = **−** (sent).

### `Utils`
- `hexToDecimal(hexStr, decimals)` — uint256 hex string → JS Number with given decimal places
- `retry(fn, times, delayMs)` — wraps any function, returns last error if all attempts fail
- `safeNull(fn)` — wraps fn, catches exceptions, returns null instead of throwing

---

## `snapshotPortfolio()` execution flow

```
1. config = Config.getAll()
2. if config.ENABLED !== "true" → return early
3. Build request array dynamically (Fluid, Aave subgraph + accountData, GMX markets/apy,
   + one balanceOf/totalSupply per GM market) → UrlFetchApp.fetchAll(requests)
4. Parse Fluid first (its prices feed Aave), then Aave, then GMX
5. If any module returned an error tag → log and skip (no partial snapshot)
6. Snapshots.appendRow (6 cols); Positions/Risk batch setValues (13 / 6 cols) via lastDataRow()+1
7. Logger.log(summary)
```

Target execution time: < 15 seconds. GAS timeout is 6 minutes, but hourly trigger rejects runs > ~30s.

---

## `syncTransactions()` execution flow (DORMANT — kept for reference, no trigger)

> Not in use. The Transactions tab is hand-entered (see migration 004). Keep `TX_SYNC_ENABLED=false`
> and set no trigger on this function. Documented here only so the code is understandable if revived.

```
1. config = Config.getAll(); if TX_SYNC_ENABLED !== "true" → return early
2. Read existing (tx_hash, log_index) from Transactions K/L → idempotency set
3. For each chain with a non-empty PROTOCOLS map + RPC/wallet config:
   a. eth_blockNumber → head; from = max(TX_SCANNED_<CHAIN>+1, TX_START_BLOCK_<CHAIN>)
   b. Walk [from..head] in block chunks; per chunk fetchAll(2 eth_getLogs: out + in),
      adaptive-halve on "more than 10000 results"/"query timeout"; collect recognized transfers
4. Drop already-seen + intra-run dup transfers
5. eth_getBlockByNumber for each UNIQUE block → UTC timestamp
6. CoinGecko keyless /history per UNIQUE (coingeckoId, date); stables = $1; Utils.retry + throttle
7. Build 13-col rows (value_usd = amount*price; flow = value_usd * (out?+1:-1)); setValues append
8. Persist TX_SCANNED_<CHAIN> (only now — re-scan-safe on any earlier failure); Logger.log(summary)
```

Resumable: a backfill that nears the time limit just continues next run (cursor advances per run;
dedup prevents duplicates). Set this trigger on `syncTransactions` separately from the hourly one.

---

## `initHeaders()` — one-time setup function

Writes headers to row 1 of all four tabs (Snapshots 6, Positions 13, Risk 6, Transactions 13),
creating any tab that doesn't exist. Run once manually after first deploy. Must not be called by
a trigger.

## `src/migrations/` — one-time schema migrations (run manually, never from trigger)

Numbered (`NNN_`) helpers, run by hand from the GAS editor. They ship in the bundle but no runtime
code calls them. Add the next one-off as `005_*.js`.

**`001_tall_schema.js`:**
- `migratePositions()` — old 10-col Positions → new 13-col; guards double-runs; backs up to `Positions_old`
- `migrateMetricsFormulas()` — rewrites Metrics A–W row-1 array formulas (S = `wsteth_rate`,
  T = `lido_apr`, U/V/W = per-row net-carry / staking / true-annual-yield % series for charts)

Run `migratePositions()` then `migrateMetricsFormulas()` once after deploying the new schema.

**`002_transactions_pnl.js`:**
- `initTransactionsTab()` — creates the Transactions tab + writes its 13-col header (idempotent)
- `migrateMetricsPnl()` — APPENDS Metrics X = `net_capital_in_usd` (running SUM of **all**
  `Transactions!J` ≤ ts — no protocol filter, since the manual ledger holds only real flows) and
  Y = `pnl_usd` = `nav_usd(L) − net_capital_in_usd(X)`, without touching A–W (guards L is `nav_usd`)

**`003_transactions_price_formulas.js`** (interim, superseded by 004 — only needed if you ever ran
the auto-scanner): `reformulaTransactions()` rewrites per-row I/J price formulas; `resetScanCursors()`
clears `TX_SCANNED_*` Script Properties. Not part of the manual-ledger setup.

**`004_manual_ledger.js`:**
- `setupManualLedger()` — **clears existing Transactions data rows** and installs the auto-extending
  `value_usd` (I) and `capital_flow_signed_usd` (J, `in=+`/`out=−`) **column array-formulas**.

**Manual-ledger setup (run once, in order):** `initTransactionsTab()` → `setupManualLedger()` →
`migrateMetricsPnl()`. Then set `TX_SYNC_ENABLED=false` in Config and add **no** trigger on
`syncTransactions`. Enter capital flows by hand (A timestamp · B chain · E token · F `in`/`out` ·
G amount · H price_usd); I/J and the Metrics P&L update automatically.

---

## Sheets formulas — quick reference

Formulas live **on Metrics/Dashboard** (the three auto-written data tabs stay literal — see
Append-cursor constraint). The **manual Transactions tab** is the one exception: its `value_usd` (I)
and `capital_flow_signed_usd` (J) are column array-formulas (installed by migration 004), safe
because nothing appends to that tab programmatically.

**Metrics tab pattern** — one array formula per column in row 1, header bundled in:
```
={"col_name"; BYROW(Snapshots!A2:A, LAMBDA(ts, IF(ts="","",
   SUMPRODUCT((Positions!A$2:A=ts) * <attribute filters> * IFERROR(Positions!<col>$2:$,0)))))}
```
NAV is venue-agnostic — sums the signed column with no per-protocol terms:
```
={"nav_usd"; BYROW(Snapshots!A2:A, LAMBDA(ts, IF(ts="","",
   SUMPRODUCT((Positions!A$2:A=ts) * IFERROR(Positions!K$2:K,0)))))}
```
Overall P&L (Metrics X/Y, from migration 002) — venue-agnostic. Net capital in is the running signed
sum of your hand-entered capital flows (`in=+`/`out=−`) up to each snapshot; P&L is current NAV minus
that. NAV is DeFi positions only, so idle (undeployed) wallet balances are NOT included:
```
X ={"net_capital_in_usd"; BYROW(Snapshots!A2:A, LAMBDA(ts, IF(ts="","",
     SUMPRODUCT((Transactions!A$2:A<>"") * (Transactions!A$2:A<=ts) * IFERROR(Transactions!J$2:J,0)))))}
Y ={"pnl_usd"; ARRAYFORMULA(IF(Snapshots!A2:A="","", L2:L - X2:X))}   // nav_usd(L) − net_capital_in(X)
```

**Dashboard tab pattern (always last row):**
```
=INDEX(Metrics!L:L, COUNTA(Metrics!L:L))
```

Do not add formulas to GAS, and never to an **auto-written** data tab (Snapshots/Positions/Risk).
Aggregate by attribute (protocol/category/side), not by hardcoded column, so new venues are absorbed
without formula edits.

---

## CI/CD

- Deploy triggers on push to `main` branch
- GitHub Actions runs `clasp push --force` using stored credentials
- Required GitHub Secrets: `CLASP_TOKEN` (JSON string of clasp auth), `SCRIPT_ID`
- The workflow generates `.clasp.json` on the fly from `SCRIPT_ID` secret
- No manual deploy step needed after initial setup

---

## GAS-specific gotchas

- `UrlFetchApp.fetchAll()` runs requests in parallel — use it for the 4 main API calls
- `BigInt` is available in V8 runtime — use it for uint256 hex parsing
- `PropertiesService.getScriptProperties()` is per-script, not per-user
- GAS execution logs are in **Stackdriver** (Execution log in GAS UI or `clasp logs`)
- Time-driven trigger must be set via GAS UI (Triggers menu) — it is not in code
- `appendRow()` is atomic; no need for locking unless running concurrent triggers (avoid concurrent triggers)

---

## Agents — rationale for not using them

Claude Code supports sub-agents via the `Task` tool, which run in parallel in isolated contexts. For this project they are **intentionally not used**.

**Reasons:**

| Criterion for agents | This project |
|---|---|
| Parallel independent work | ❌ Utils → Config → modules → Main (sequential dependencies) |
| Agent can verify its own result | ❌ GAS has no local test runner |
| Scope exceeds single context | ❌ 7 files, 1–2 sessions |
| Isolated research tasks | ❌ none |

**Condition for revisiting:** if there is a need to explore several new APIs in parallel (e.g. adding 3 independent protocols simultaneously), or the project grows to 20+ files — then orchestrator + sub-agents per module would be justified.

---

## Slash commands — correct prefix

Commands in `.claude/commands/` are invoked with the `/project:` prefix:

```
/project:check-secrets      ← scans src/ before commit
/project:validate-columns   ← checks the tall-tab schema (Snapshots 6 / Positions 13 / Risk 6)
/project:add-data-source    ← step-by-step guide for adding a new protocol
/project:save-state         ← save session state to .claude/state.md
/project:restore-state      ← restore state at the start of a new session
```

Hooks (`.claude/hooks/`) run **automatically** — no manual invocation needed:
- `pre-write-secrets.sh` — blocks file write if secrets are detected
- `post-write-validate.sh` — checks column count after each save of `Main.js`

---



### Why this matters

Implementing all six modules in one session is likely to push the context window near its limit. When that happens mid-task, progress is lost and the next session starts blind. The solution is proactive state saving into `.claude/state.md` before the limit is reached.

### Signals that the context is getting full

Watch for any of these during a session:
- Responses start omitting details that were discussed earlier in the same conversation
- Claude asks to re-confirm something already decided
- A `/save-state` reminder appears (configured below as a habit trigger)
- The session has been running for 30+ minutes across many file edits

**Rule: after completing any full module (`Fluid.js`, `Aave.js`, etc.) or any significant milestone, run `/project:save-state` before continuing.**

### State file location

`.claude/state.md` — gitignored (contains working notes, not source code).

### What the state file must capture

```markdown
## Session state — {ISO timestamp}

### Completed
- [ list of files written and confirmed working ]

### In progress
- Current file:
- Current function:
- Stopped at: (line / decision point / waiting for input)

### Decisions made this session
- (key architectural or implementation decisions with brief rationale)

### Known issues / blockers
- (anything unresolved)

### Next steps (in order)
1.
2.
3.

### Context for next session
(anything the next Claude instance must know to continue without asking again)
```

### How to resume in a new session

Start the new session with:
```
Read CLAUDE.md and .claude/state.md, then continue from "Next steps".
```

Claude Code will load both files and resume without needing the full conversation history.

---

## Acceptance criteria checklist

**GAS:**
- `snapshotPortfolio()` completes without errors in Execution log
- New rows every hour: 1 in Snapshots (6 cols), N in Positions (13 cols), M in Risk (6 cols)
- All columns populated or explicitly `null`; Positions rows share one timestamp per snapshot
- `error_flags` (Snapshots F) empty during normal operation; any module error skips the whole snapshot
- `git push main` → code updated in GAS via CI/CD
- Transactions is a **manual ledger**: hand-entered rows compute `value_usd`/`capital_flow_signed_usd`
  via the col-I/J array-formulas (`in=+`/`out=−`); `syncTransactions` stays dormant (`TX_SYNC_ENABLED=false`,
  no trigger)

**Sheets formulas (Metrics + manual Transactions tab; auto-written data tabs stay formula-free):**
- Each Metrics column is one row-1 array formula (`={"header"; BYROW(...)}`); extends automatically
- New Positions/Risk rows → Metrics aggregates update with no manual edits
- Dashboard always reflects the latest snapshot
- `nav_usd` = `SUMPRODUCT((Positions!A=ts) * value_signed_usd)` — venue-agnostic, absorbs new protocols
- `net_carry_daily_usd` is non-zero (sum of signed `daily_carry_usd`)
- `wsteth_eth_ratio` slowly increases over time (visible on weekly chart)
- `net_capital_in_usd` is the running signed sum of `Transactions!J` (`in=+`/`out=−`); `pnl_usd` ≈ 0
  right after you log a deposit at its then-price, then drifts with price/yield. NAV excludes idle
  wallet balances — fold them in separately if you hold undeployed funds