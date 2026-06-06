# src/CLAUDE.md — GAS source module context

This file supplements the root `CLAUDE.md`. It is loaded automatically when Claude Code works with files in `src/`.

---

## Runtime constraints (V8, GAS-specific)

- **No `require()`, no `import`** — GAS uses its own module system; all files in `src/` share one global scope. Functions defined in any `.js` file are available in all others without import.
- **No `async/await`** — GAS is synchronous. `UrlFetchApp.fetch()` blocks until response. Use `UrlFetchApp.fetchAll([])` for parallel requests.
- **`BigInt` is available** — V8 runtime supports it. Use for uint256 hex parsing in `GMX.fetchBalance()`.
- **No `fetch()`** — use `UrlFetchApp.fetch(url, options)` and `UrlFetchApp.fetchAll(requests)`.
- **Execution time limit: 6 minutes** — target < 15 seconds for `snapshotPortfolio()`.
- **No file system** — no `fs`, no local storage. State lives in Sheets or PropertiesService only.
- **`console.log` does not exist** — use `Logger.log()`. Logs visible in GAS UI → Execution log, or via `clasp logs`.

---

## Module boundaries

Each file defines functions on a plain object (namespace pattern). No classes needed.

```js
// Correct pattern
const Fluid = {
  fetch: function(config) { ... }
};

// Also acceptable (GAS hoists function declarations)
function fluidFetch(config) { ... }
```

Prefer the namespace object pattern (`const ModuleName = { ... }`) — it makes dependency direction explicit when reading `Main.js`.

---

## UrlFetchApp patterns

```js
// Single request
const response = UrlFetchApp.fetch(url, {
  method: 'post',
  contentType: 'application/json',
  payload: JSON.stringify(body),
  muteHttpExceptions: true   // ← always set; lets you handle non-2xx yourself
});
const data = JSON.parse(response.getContentText());

// Parallel requests (use for the 4 main API calls in Main.js)
const requests = [
  { url: fluidUrl, method: 'post', payload: JSON.stringify(fluidBody), muteHttpExceptions: true },
  { url: aaveUrl,  method: 'post', payload: JSON.stringify(aaveBody),  muteHttpExceptions: true },
];
const responses = UrlFetchApp.fetchAll(requests);
// responses[0] → fluid, responses[1] → aave
```

Always use `muteHttpExceptions: true` and check `response.getResponseCode()` manually.

---

## PropertiesService pattern

```js
// Read a secret
const key = PropertiesService.getScriptProperties().getProperty('ALCHEMY_ARB_KEY');
if (!key) throw new Error('ALCHEMY_ARB_KEY not set in Script Properties');

// Never log the value of a secret — only log that it was found
Logger.log('ALCHEMY_ARB_KEY: ' + (key ? 'present' : 'MISSING'));
```

---

## Error handling convention

Every module's `fetch()` function must:
1. Wrap the entire body in `try/catch`
2. On catch: return an array of `null` values (same length as the success return)
3. Return an error tag string for `error_flags` assembly in Main.js

```js
const Aave = {
  fetch: function(config) {
    try {
      // ... fetch and parse ...
      return [val1, val2, ...val8];
    } catch (e) {
      Logger.log('Aave.fetch error: ' + e.message);
      return { values: [null, null, null, null, null, null, null, null], error: 'AAVE_ERR' };
    }
  }
};
```

Main.js assembles `error_flags` by collecting `.error` from each module result.

---

## APY / Ray format (Aave)

Aave subgraph returns rates in **Ray format** (1e27 = 100%).

```js
// Ray → decimal (e.g. 0.0005 = 0.05%)
const supplyApy = Number(currentLiquidityRate) / 1e27;
// Do NOT multiply by 100 — Sheets formulas expect decimal
```

---

## uint256 hex → Number (GMX balanceOf)

```js
// result is "0x" + 64 hex chars
function hexToDecimal(hexStr, decimals) {
  const raw = BigInt(hexStr);          // BigInt handles uint256 safely
  const divisor = BigInt(10 ** decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;
  return Number(whole) + Number(remainder) / (10 ** decimals);
}
// GM tokens have 18 decimals
```

---

## No sub-agents for this project

See root `CLAUDE.md` → "Agents" section for the rationale. All work in `src/` is sequential. Do not attempt to spawn parallel tasks.