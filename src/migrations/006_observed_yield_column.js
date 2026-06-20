// Migration 006 — observed (on-chain) annual-yield column on Metrics.
//
// One-time, run MANUALLY from the GAS editor (never by a trigger). Ships in the bundle; no runtime
// code calls it. See 001_tall_schema.js for the convention.
//
//   addObservedYieldColumn() — APPENDS Metrics Z = annualized total yield using the OBSERVED on-chain
//                              wstETH-rate growth over a trailing 7-day window, falling back to the
//                              published lido_apr when there isn't 7 days of rate history yet.
//                              Idempotent: re-running only rewrites Z1.
//
// This is the Dashboard's single-cell "true annual yield" LET formula, re-expressed as a per-row
// Metrics column so it can be charted as a time series. Distinct from col W (true_annual_yield_pct),
// which always uses the *published* lido_apr; Z prefers the *observed* on-chain rate when available.
//
// CADENCE-SAFE (load-bearing): the Dashboard cell used MAX(p-168,2) + *(1/7), i.e. "168 rows = 7 days
// = hourly cadence". This column instead finds the 7-days-ago snapshot by TIMESTAMP
// (MATCH(ts-7, Snapshots!A, 1)) and divides by the ACTUAL elapsed days (ts - tpast), so it stays
// correct at any snapshot cadence — per the root CLAUDE.md rule against any "N rows = T hours" window.
//
// Existing Metrics layout (001 + 002): C=wsteth_usd, L=nav_usd, M=net_carry_daily_usd,
// R=wsteth_amount, S=wsteth_rate, T=lido_apr. Source rate column is Snapshots!G (= Metrics!S).
// New column lands at Z (26).

const Migrate006 = {
  OBS_YIELD_COL: 26,  // Z
  // MAP walks the row-aligned Metrics columns in lockstep (no circular ref: Z reads A/R/C/M/L/S/T only).
  //   v      = wstETH value in USD (amount × price)
  //   pos    = row of the latest snapshot whose timestamp ≤ ts−7 days (0 = no 7-day history yet)
  //   spast  = wstETH rate then; tpast = its timestamp (for exact elapsed-day divisor)
  //   branch 1 (spast>0): (net_carry_daily + v × observed-daily-staking) × 365 / NAV
  //   branch 2 (lido_apr): (net_carry_daily + v × apr/365) × 365 / NAV   ← cadence-free fallback
  //   else "warming up…"
  OBS_YIELD_FORMULA:
    '={"Річна дохідність (факт.), %"; MAP(Metrics!A2:A,Metrics!R2:R,Metrics!C2:C,Metrics!M2:M,Metrics!L2:L,Metrics!S2:S,Metrics!T2:T,LAMBDA(ts,r,c,m,l,s,t,IF(ts="","",LET(v,r*c,pos,IFERROR(MATCH(ts-7,Snapshots!$A$2:$A,1),0),spast,IF(pos=0,0,INDEX(Snapshots!$G$2:$G,pos)),tpast,IF(pos=0,ts,INDEX(Snapshots!$A$2:$A,pos)),IF(N(spast)>0,(m+v*(s/spast-1)/(ts-tpast))*365/l,IF(ISNUMBER(t),(m+v*t/365)*365/l,"warming up…")))))))}',

  addObservedYieldColumn: function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const m  = ss.getSheetByName('Metrics');
    if (!m) throw new Error('Metrics tab not found — run 001 migrateMetricsFormulas() first');

    // Guard: the formula reads L (nav_usd) and S (wsteth_rate). Header label may be English (001/002)
    // or Ukrainian (005 relabel), so accept either spelling.
    const lHeader = String(m.getRange(1, 12).getValue());   // L
    if (lHeader.indexOf('nav') === -1 && lHeader.indexOf('NAV') === -1) {
      throw new Error('Metrics!L is "' + lHeader + '", expected nav_usd/NAV — run 001 migrateMetricsFormulas() first');
    }
    const sHeader = String(m.getRange(1, 19).getValue());   // S
    if (sHeader.indexOf('rate') === -1 && sHeader.indexOf('wstETH') === -1 && sHeader.indexOf('wsteth') === -1) {
      throw new Error('Metrics!S is "' + sHeader + '", expected wsteth_rate — run 001 migrateMetricsFormulas() first');
    }

    // setValues (not setFormulas): a leading-"=" string is entered verbatim so MAP/LAMBDA/LET parse.
    m.getRange(1, Migrate006.OBS_YIELD_COL).setValue(Migrate006.OBS_YIELD_FORMULA);
    Logger.log('addObservedYieldColumn: wrote observed annual-yield at Metrics Z (col 26)');
  }
};

// Top-level wrapper — object methods don't appear in the GAS editor's Run dropdown.
function addObservedYieldColumn() { Migrate006.addObservedYieldColumn(); }
