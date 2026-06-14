// Migration 003 — convert existing Transactions value/flow to per-row formulas of price.
//
// One-time, run MANUALLY from the GAS editor (never by a trigger). Ships in the bundle; no runtime
// code calls it. See 001/002 for the convention.
//
// WHY: rows written before the price-formula change hold LITERAL value_usd (I) / capital_flow (J),
// so typing a price into a blank H cell would NOT update them. This rewrites I and J for every
// existing data row as the same same-row formulas the writer now emits:
//   I (value_usd)            = IF($H#="","",$G#*$H#)
//   J (capital_flow_signed)  = IF($I#="","",$I#*IF($F#="in",1,-1))   // in=+ (received), out=−
// After running this, fill any blank H (price_usd_at_tx) cells manually — value, signed flow, and
// the Metrics net_capital_in / pnl columns all update automatically.
//
// Append-safe: column A (the lastDataRow cursor) stays literal; these are per-row formulas, not
// column-wide ARRAYFORMULAs, so they never auto-extend. Idempotent — re-running just rewrites I/J.

const Migrate003 = {
  reformulaTransactions: function() {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Transactions');
    if (!sheet) throw new Error('Transactions tab not found — run initTransactionsTab() first');

    const lastRow = Utils.lastDataRow(sheet);   // scans col A (literal timestamps)
    if (lastRow < 2) {
      Logger.log('reformulaTransactions: no data rows — nothing to do');
      return;
    }

    const valueFormulas = [];   // column I
    const flowFormulas  = [];   // column J
    for (var r = 2; r <= lastRow; r++) {
      valueFormulas.push(['=IF($H' + r + '="","",$G' + r + '*$H' + r + ')']);
      flowFormulas.push(['=IF($I' + r + '="","",$I' + r + '*IF($F' + r + '="in",1,-1))']);
    }
    sheet.getRange(2, 9,  valueFormulas.length, 1).setValues(valueFormulas);  // I = value_usd
    sheet.getRange(2, 10, flowFormulas.length,  1).setValues(flowFormulas);   // J = capital_flow_signed

    Logger.log('reformulaTransactions: rewrote I/J as formulas for rows 2–' + lastRow);
  },

  // Reset per-chain scan cursors so the NEXT syncTransactions re-scans from TX_START_BLOCK_<CODE>.
  // Needed after switching from protocol-only to the full "everything in/out" ledger: the early
  // blocks holding your exchange-funding transfers were already scanned past (and discarded) under
  // the old filter, so they must be re-scanned. Safe & non-duplicating — rows are keyed by
  // (tx_hash, log_index), so protocol rows already written are skipped; only new external transfers
  // are added. Also clears the orphaned full-name cursor from the early genesis-crawl bug.
  resetScanCursors: function() {
    const props = PropertiesService.getScriptProperties();
    ['TX_SCANNED_ARB', 'TX_SCANNED_BASE', 'TX_SCANNED_ARBITRUM'].forEach(function(k) {
      const had = props.getProperty(k);
      props.deleteProperty(k);
      Logger.log('resetScanCursors: ' + k + (had != null ? ' deleted (was ' + had + ')' : ' (not set)'));
    });
    Logger.log('resetScanCursors: next syncTransactions will re-scan from TX_START_BLOCK_<CODE>');
  }
};

// Top-level wrappers — object methods don't appear in the GAS editor's Run dropdown.
function reformulaTransactions() { Migrate003.reformulaTransactions(); }
function resetScanCursors()      { Migrate003.resetScanCursors(); }
