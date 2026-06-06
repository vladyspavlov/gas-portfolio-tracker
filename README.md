# GAS Portfolio Tracker

Google Apps Script that snapshots DeFi positions every hour into Google Sheets. Fetches live data from Fluid (Base), Aave v3 (Arbitrum), and GMX v2 (Arbitrum + Base) — writes raw numbers only, all calculations live in Sheets formulas.

## Architecture

```
GAS Script                        Google Sheets
──────────────                    ─────────────
Fluid  (Base RPC)    ──┐
Aave   (Subgraph +   ──┤  raw     Snapshots  →  Metrics  (ARRAYFORMULA)
        Arb RPC)     ──┤  nums →  Positions  →  Dashboard (INDEX/COUNTA)
GMX    (API + RPC)   ──┘          Risk       →  Charts
```

Three output tabs:
- **Snapshots** — one row per hour: oracle prices + error flags
- **Positions** — one row per token position (supply/borrow/LP) per snapshot
- **Risk** — one row per vault/account per snapshot: health factor + LTV

## Stack

- Google Apps Script (V8 runtime) — no Node.js, no external packages
- [clasp](https://github.com/google/clasp) — local development + push
- GitHub Actions — CI/CD auto-deploy on push to `main`
- Google Sheets — formula engine for all derived metrics

## Data sources

| Protocol | Chain | Data |
|----------|-------|------|
| Fluid | Base | Prices, collateral/debt positions, health factors |
| Aave v3 | Arbitrum | Reserve balances, APYs, account health (getUserAccountData) |
| GMX v2 | Arbitrum | GM token balances, pool prices, APYs |
| GMX v2 | Base | GM receipt token balances (priced via Arbitrum pool) |
| GMX Account | Arbitrum | Internal vault balance (DataStore.getUint) |

## Setup

### 1. Prerequisites

```bash
npm install -g @google/clasp
clasp login
```

### 2. Clone and configure

```bash
git clone <this-repo>
cd gas-portfolio-tracker
npm install

cp .clasp.json.example .clasp.json
# Edit .clasp.json and set your scriptId
```

### 3. Google Sheets — Config tab

Create a tab named `Config` with two columns (key, value):

| Key | Value |
|-----|-------|
| `ENABLED` | `true` |
| `BASE_ADDRESS` | your Base wallet address |
| `ARB_ADDRESS` | your Arbitrum wallet address |
| `FLUID_SERVICE_URL` | URL of your fluid-data-reader instance |
| `AAVE_SUBGRAPH_ID` | The Graph subgraph ID for Aave v3 Arbitrum |
| `RPC_ARB_URL` | Arbitrum RPC base URL (without key) |
| `RPC_BASE_URL` | Base RPC base URL (without key) |
| `GMX_ARB_MARKETS` | Comma-separated Arbitrum GM market token addresses |
| `GMX_BASE_GM_TOKENS` | Comma-separated Base GM receipt token addresses |
| `GMX_ACCOUNT_KEY_ARB` | Precomputed DataStore key for GMX Account balance (optional) |
| `GMX_ACCOUNT_MARKET_ARB` | Arbitrum GM market address matching the GMX Account (optional) |

### 4. Script Properties (secrets)

In the GAS editor → Project Settings → Script Properties:

| Key | Value |
|-----|-------|
| `RPC_ARB_KEY` | Alchemy / Infura key for Arbitrum |
| `RPC_BASE_KEY` | Alchemy / Infura key for Base |
| `GRAPH_API_KEY` | The Graph API key |

### 5. Deploy and initialize

```bash
clasp push
```

In the GAS editor, run `initHeaders()` once to write column headers to all three tabs. Then set a time-driven trigger on `snapshotPortfolio()` (every hour) via the GAS Triggers menu.

### 6. GMX Account balance (optional)

If you deposit GM tokens into GMX Account (cross-chain via Stargate), compute the DataStore key once:

```bash
node -e "
const { ethers } = require('ethers');
const ARB_ADDRESS  = 'YOUR_ARB_ADDRESS';
const GM_MARKET    = 'YOUR_GM_MARKET_ADDRESS';

const MULTICHAIN_BALANCE = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['MULTICHAIN_BALANCE'])
);
const key = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'address', 'address'],
    [MULTICHAIN_BALANCE, ARB_ADDRESS, GM_MARKET]
  )
);
console.log('GMX_ACCOUNT_KEY_ARB:', key);
"
```

Add the output to `GMX_ACCOUNT_KEY_ARB` in your Config tab.

## CI/CD

Push to `main` automatically deploys to GAS via GitHub Actions.

Required GitHub Secrets:

| Secret | Value |
|--------|-------|
| `CLASP_TOKEN` | Contents of `~/.clasprc.json` after `clasp login` |
| `SCRIPT_ID` | Your GAS script ID |

## Local development

```bash
clasp push          # push to GAS
clasp open          # open GAS editor
clasp logs --watch  # tail execution logs
```

## Security

This is a public repository. No secrets, wallet addresses, or API keys are ever committed:

- Wallet addresses and URLs live in the **Config tab** (Google Sheets, not in code)
- API keys live in **Script Properties** (GAS PropertiesService)
- `.clasp.json` (contains `scriptId`) is gitignored
- Logs never include key values or raw addresses

Before each commit, run `/project:check-secrets`.

## License

MIT — see [LICENSE](LICENSE).
