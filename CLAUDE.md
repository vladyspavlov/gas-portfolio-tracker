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
│   └── Utils.js             ← hexToDecimal, retry, safeNull, logger
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

## Data flow — Snapshots tab (27 columns, A–AA)

| Range | Source module | Content |
|-------|--------------|---------|
| A | Main.js | `timestamp` (ISO string) |
| B–E | Fluid.js | ETH, BTC, wstETH, cbBTC prices (USD) |
| F–M | Aave.js | wstETH collateral, USDT/USDC/ETH debt amounts + APYs |
| N–T | Fluid.js | cbBTC + wstETH positions (amounts, debt, APYs) |
| U–Z | GMX.js | GM balances + prices + APRs (Arb + Base) |
| AA | Main.js | `error_flags` (empty string = OK) |

`appendRow()` order must exactly match column order. See TZ section 3 for full column-to-field mapping.

---

## Module contracts

### `Config.getAll()` → `{[key: string]: string}`
- Reads Config tab as two-column key-value table
- Secrets fetched from PropertiesService (not from tab)
- Returns merged object; caller checks for missing keys

### `Fluid.fetch(config)` → array of 11 values `[eth_usd, btc_usd, wsteth_usd, cbbtc_usd, fluid_cbbtc_amount, fluid_debt_usdc_cbbtc, fluid_supply_apy_cbbtc, fluid_borrow_apy_usdc, fluid_wsteth_amount, fluid_debt_usdc_wsteth, fluid_supply_apy_wsteth]`
- POST to `config.FLUID_SERVICE_URL + "/positions"` with `{ address: config.BASE_ADDRESS }`
- On error: returns array of 11 `null` values, appends `"FLUID_ERR"` to error_flags

### `Aave.fetch(config)` → array of 8 values `[aave_wsteth_amount, aave_wsteth_supply_apy, aave_debt_usdt, aave_debt_usdc, aave_debt_eth, aave_borrow_apy_usdt, aave_borrow_apy_usdc, aave_borrow_apy_eth]`
- POST GraphQL to `config.AAVE_SUBGRAPH_URL`
- Address must be lowercase in the query
- APY conversion: `rayValue / 1e27` (keep as decimal, not percent)
- Token amounts: divide by `10^decimals`
- On error: 8 nulls + `"AAVE_ERR"`

### `GMX.fetch(config, chain)` → array of 3 values `[gm_balance, gm_price_usd, pool_apr]`
- `chain`: `"arb"` or `"base"` — selects correct config keys
- `gm_balance` comes from `GMX.fetchBalance()` (separate RPC call)
- `gm_price_usd` and `pool_apr` from GMX HTTP API
- On error: 3 nulls per chain + `"GMX_ARB_ERR"` or `"GMX_BASE_ERR"`

### `Utils`
- `hexToDecimal(hexStr, decimals)` — uint256 hex string → JS Number with given decimal places
- `retry(fn, times, delayMs)` — wraps any function, returns last error if all attempts fail
- `safeNull(fn)` — wraps fn, catches exceptions, returns null instead of throwing

---

## `snapshotPortfolio()` execution flow

```
1. config = Config.getAll()
2. if config.ENABLED !== "true" → return early
3. Parallel: UrlFetchApp.fetchAll([fluid_req, aave_req, gmx_arb_req, gmx_base_req])
4. Sequential: GMX.fetchBalance(arb), GMX.fetchBalance(base)  ← separate RPC calls
5. Assemble row[27] in column order A–AA
6. sheet.appendRow(row)
7. Logger.log(summary)
```

Target execution time: < 15 seconds. GAS timeout is 6 minutes, but hourly trigger rejects runs > ~30s.

---

## `initHeaders()` — one-time setup function

Writes column headers to row 1 of Snapshots tab. Run once manually after first deploy. Must not be called by the trigger.

---

## Sheets formulas — quick reference

**Metrics tab pattern (row 2, extends automatically):**
```
=ARRAYFORMULA(IF(Snapshots!A2:A="", "", {formula referencing Snapshots columns}))
```

**Dashboard tab pattern (always last row):**
```
=INDEX(Metrics!O:O, COUNTA(Metrics!O:O))
```

Do not add formulas to GAS. If a calculation is needed, confirm it belongs in Sheets and reference the TZ for the correct formula.

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
| Scope exceeds single context | ❌ 6 files, 1–2 sessions |
| Isolated research tasks | ❌ none |

**Condition for revisiting:** if there is a need to explore several new APIs in parallel (e.g. adding 3 independent protocols simultaneously), or the project grows to 20+ files — then orchestrator + sub-agents per module would be justified.

---

## Slash commands — correct prefix

Commands in `.claude/commands/` are invoked with the `/project:` prefix:

```
/project:check-secrets      ← scans src/ before commit
/project:validate-columns   ← checks the 27-column order in Main.js
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
- New row in Snapshots every hour
- All 27 columns populated or explicitly `null`
- `error_flags` column (AA) is empty string during normal operation
- `git push main` → code updated in GAS via CI/CD

**Sheets formulas:**
- Metrics row 2 uses ARRAYFORMULA (no manual drag-down needed)
- New Snapshots row → Metrics row appears automatically
- Dashboard always reflects the latest snapshot
- `nav_usd` = aave_net_usd + fluid_net_usd + gmx_arb_position_usd + gmx_base_position_usd
- `net_carry_daily_usd` is non-zero (positive or negative depending on rates)
- `wsteth_eth_ratio` slowly increases over time (visible on weekly chart)