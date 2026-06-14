// Migration 002 — Transactions tab + cost-basis P&L on Metrics.
//
// One-time, run MANUALLY from the GAS editor (never by a trigger). Ships in the bundle; no runtime
// code calls it. See 001_tall_schema.js for the convention.
//
//   initTransactionsTab()  — creates the Transactions sheet (if absent) and writes its 11-col header.
//                            Idempotent: re-running only (re)writes the header row.
//   migrateMetricsPnl()    — APPENDS two array-formula columns to Metrics WITHOUT clobbering A–W:
//                            X = net_capital_in_usd (running signed sum of capital flows ≤ ts),
//                            Y = pnl_usd            (nav_usd[L] − net_capital_in_usd[X]).
//
// Run initTransactionsTab() FIRST, then migrateMetricsPnl(). Existing Metrics layout (from 001):
// L = nav_usd. New columns land at X (24) and Y (25).

const Migrate002 = {
  TRANSACTIONS_HEADERS: [
    'timestamp', 'chain', 'protocol', 'counterparty', 'token', 'direction',
    'amount', 'price_usd_at_tx', 'value_usd', 'capital_flow_signed_usd',
    'tx_hash'
  ],

  // Net capital in: running signed sum of the MANUAL ledger's capital_flow_signed_usd (Transactions!J,
  // in=+ / out=−) up to each snapshot ts. You enter only real money-in/out rows, so every row counts —
  // no protocol/external filtering needed. P&L: current NAV (Metrics!L) minus net capital in.
  // NOTE: NAV (Metrics!L) is DeFi positions only; if you hold idle (undeployed) wallet balances,
  // overall P&L is understated by their value — fold them into NAV separately if that matters.
  METRICS_PNL: {
    col: 24,  // X
    formulas: [
      '={"net_capital_in_usd"; BYROW(Snapshots!A2:A,LAMBDA(ts,IF(ts="","",SUMPRODUCT((Transactions!A$2:A<>"")*(Transactions!A$2:A<=ts)*IFERROR(Transactions!J$2:J,0)))))}',
      '={"pnl_usd"; ARRAYFORMULA(IF(Snapshots!A2:A="","",L2:L-X2:X))}'
    ]
  },

  initTransactionsTab: function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName('Transactions');
    if (!sheet) {
      sheet = ss.insertSheet('Transactions');
      Logger.log('initTransactionsTab: created Transactions sheet');
    }
    sheet.getRange(1, 1, 1, Migrate002.TRANSACTIONS_HEADERS.length)
         .setValues([Migrate002.TRANSACTIONS_HEADERS]);
    Logger.log('initTransactionsTab: ' + Migrate002.TRANSACTIONS_HEADERS.length + ' headers written');
  },

  migrateMetricsPnl: function() {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Metrics');
    if (!sheet) throw new Error('Metrics tab not found — run 001 migrateMetricsFormulas() first');

    // Guard: confirm L is nav_usd (the layout these formulas reference) before writing.
    const navHeader = sheet.getRange(1, 12).getValue();   // L
    if (String(navHeader).indexOf('nav_usd') === -1) {
      throw new Error('Metrics!L is "' + navHeader + '", expected nav_usd — run 001 first / check layout');
    }

    // setValues (not setFormulas): a leading-"=" string is entered verbatim so BYROW/LAMBDA parse.
    sheet.getRange(1, Migrate002.METRICS_PNL.col, 1, Migrate002.METRICS_PNL.formulas.length)
         .setValues([Migrate002.METRICS_PNL.formulas]);
    Logger.log('migrateMetricsPnl: wrote net_capital_in_usd (X) + pnl_usd (Y)');
  }
};

// Top-level wrappers — object methods don't appear in the GAS editor's Run dropdown. Run in order.
function initTransactionsTab() { Migrate002.initTransactionsTab(); }
function migrateMetricsPnl()   { Migrate002.migrateMetricsPnl(); }
