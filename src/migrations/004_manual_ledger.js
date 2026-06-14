// Migration 004 — convert Transactions into a MANUAL, formula-driven ledger.
//
// One-time, run MANUALLY from the GAS editor (never by a trigger). See 001/002 for the convention.
//
// Decision: capital-flow history is now entered BY HAND (no eth_getLogs scanning, no CoinGecko) —
// the automated syncTransactions path can't see native-ETH exchange funding and the keyless price
// API is unreliable from GAS. You type each real money-in/out event; Sheets does the P&L math.
//
// What this sets up on the Transactions tab:
//   • value_usd (I) and capital_flow_signed_usd (J) become COLUMN array-formulas in row 1, so they
//     auto-compute for every row you add — no per-row formulas to copy down. This is safe now: with
//     scanning disabled, nothing appends to this tab programmatically, so the append-cursor
//     constraint that kept the data tabs formula-free no longer applies here.
//   • value_usd            = amount (G) × price_usd_at_tx (H)
//   • capital_flow_signed  = value × sign(direction):  in = + (received), out = − (sent)
//
// You fill, per row:  A timestamp · B chain · E token · F direction(in/out) · G amount · H price_usd
// (C protocol / D counterparty / K tx_hash / L log_index / M block_number are optional notes.)
//
// WARNING: this CLEARS all existing data rows (2+) so the column formulas can spill cleanly. The
// rows currently there are auto-scanned protocol-internal moves, which are NOT what overall P&L
// wants anyway (you want your exchange deposits/withdrawals). Back them up first if you want them.
//
// After running this, run migrateMetricsPnl() (002) so Metrics X/Y pick up net_capital_in + pnl,
// then set TX_SYNC_ENABLED=false in Config and remove any syncTransactions trigger.

const Migrate004 = {
  // header bundled in (Metrics pattern); array spills from row 2 down as you add rows.
  VALUE_FORMULA: '={"value_usd"; ARRAYFORMULA(IF($A2:$A="","",IFERROR($G2:$G*$H2:$H,"")))}',
  FLOW_FORMULA:  '={"capital_flow_signed_usd"; ARRAYFORMULA(IF($A2:$A="","",IFERROR($G2:$G*$H2:$H*(($F2:$F="in")-($F2:$F="out")),"")))}',

  setupManualLedger: function() {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Transactions');
    if (!sheet) throw new Error('Transactions tab not found — run initTransactionsTab() first');

    // Clear existing data rows so the I/J array-formulas can spill without #REF collisions.
    const lastRow = Utils.lastDataRow(sheet);
    if (lastRow >= 2) {
      sheet.getRange(2, 1, lastRow - 1, 11).clearContent();
      Logger.log('setupManualLedger: cleared ' + (lastRow - 1) + ' old data rows');
    }

    // Install the auto-extending value/flow formulas (overwrites the I1/J1 header cells).
    sheet.getRange(1, 9).setValue(Migrate004.VALUE_FORMULA);   // I = value_usd
    sheet.getRange(1, 10).setValue(Migrate004.FLOW_FORMULA);   // J = capital_flow_signed_usd
    Logger.log('setupManualLedger: installed value_usd (I) + capital_flow_signed_usd (J) array-formulas');
    Logger.log('setupManualLedger: now run migrateMetricsPnl(), set TX_SYNC_ENABLED=false, enter rows by hand');
  }
};

// Top-level wrapper — object methods don't appear in the GAS editor's Run dropdown.
function setupManualLedger() { Migrate004.setupManualLedger(); }
