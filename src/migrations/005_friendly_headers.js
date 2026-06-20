// Migration 005 — friendly Ukrainian headers + a net-% (return) column on Metrics.
//
// One-time, run MANUALLY from the GAS editor (never by a trigger). See 001–004 for the convention.
//
// Two independent changes (run either/both; both are idempotent and re-runnable):
//
//   relabelFriendlyHeaders() — renames the row-1 HEADER LABELS on all five tabs to human-friendly
//                              Ukrainian (the sheet is monitored by people, not just formulas).
//   addNetPctColumn()        — appends Metrics Z = pnl_pct = pnl_usd(Y) / net_capital_in_usd(X):
//                              overall return % per snapshot, for a dedicated "net %" chart.
//
// WHY THIS IS SAFE (load-bearing): every Metrics/Dashboard formula keys off COLUMN LETTERS
// (Snapshots!B, Positions!K, …) and off literal DATA VALUES (Positions!B="aave", G="supply",
// F="WSTETH"; Transactions!F="in"/"out"). Header TEXT is referenced nowhere. So renaming a header is
// purely cosmetic and breaks no formula. The flip side: the DATA VALUES above MUST stay English —
// this migration translates labels only, never the protocol/side/token/direction values in the rows.
//
// Two header styles, handled differently:
//   • Plain header cells (Snapshots, Positions, Risk; Transactions A–H + K): overwrite row-1 text.
//   • Formula-bundled headers (all Metrics cols; Transactions I/J) — the label is the first element
//     of an `={"label"; ARRAYFORMULA(...)}` cell, so we relabel IN PLACE: read the formula, swap only
//     the leading `{"label";` segment, write it back (body untouched → no divergence from 001/002/004).

const Migrate005 = {
  // ── Plain-header data tabs (overwrite the whole row-1 range) ──────────────────────────────────
  PLAIN_HEADERS: {
    Snapshots: ['Час', 'ETH, USD', 'BTC, USD', 'wstETH, USD', 'cbBTC, USD',
                'Помилки', 'Курс wstETH→stETH', 'APR Lido (7д)'],                       // A–H
    Positions: ['Час', 'Протокол', 'Мережа', 'Категорія', 'ID позиції', 'Токен', 'Сторона',
                'Кількість', 'Ціна, USD', 'Вартість, USD', 'Вартість зі знаком, USD',
                'APY', 'Денний дохід, USD'],                                            // A–M
    Risk:      ['Час', 'Протокол', 'Мережа', 'ID позиції', 'Health Factor', 'LTV']      // A–F
  },

  // ── Transactions: plain cells (by 1-based col) + formula-bundled I/J relabelled separately ─────
  TX_PLAIN: { 1: 'Час', 2: 'Мережа', 3: 'Протокол', 4: 'Контрагент', 5: 'Токен',
              6: 'Напрям (in/out)', 7: 'Кількість', 8: 'Ціна на дату, USD', 11: 'Хеш транзакції' },
  TX_FORMULA_LABELS: { 9: 'Вартість, USD', 10: 'Рух капіталу зі знаком, USD' },         // I, J

  // ── Metrics A–Y: formula-bundled headers, relabelled in place (index 0 = col A) ────────────────
  METRICS_LABELS: [
    'Час',                       // A  timestamp
    'ETH, USD',                  // B  eth_usd
    'wstETH, USD',               // C  wsteth_usd
    'wstETH/ETH',                // D  wsteth_eth_ratio
    'Aave: депозит, USD',        // E  aave_supply_usd
    'Aave: борг, USD',           // F  aave_borrow_usd
    'Aave: чисто, USD',          // G  aave_net_usd
    'Fluid: депозит, USD',       // H  fluid_supply_usd
    'Fluid: борг, USD',          // I  fluid_borrow_usd
    'Fluid: чисто, USD',         // J  fluid_net_usd
    'GMX, USD',                  // K  gmx_usd
    'NAV, USD',                  // L  nav_usd
    'Денний дохід, USD',         // M  net_carry_daily_usd
    'Aave: Health Factor',       // N  aave_hf
    'Fluid: мін. HF',            // O  fluid_min_hf
    'Aave: LTV',                 // P  aave_ltv
    'Fluid: LTV',                // Q  fluid_ltv
    'wstETH: кількість',         // R  wsteth_amount
    'Курс wstETH→stETH',         // S  wsteth_rate
    'APR Lido (7д)',             // T  lido_apr
    'Дохідність carry, %',       // U  net_carry_yield_pct
    'Дохідність стейкінгу, %',   // V  staking_yield_pct
    'Річна дохідність, %',       // W  true_annual_yield_pct
    'Внесений капітал, USD',     // X  net_capital_in_usd
    'P&L, USD'                   // Y  pnl_usd
  ],

  // ── Net-% column (Metrics Z = 26): annualized net carry yield, matching the Dashboard's "net %"
  // (=INDEX(Metrics!M:M,row)*365/INDEX(Metrics!L:L,row)) — i.e. net_carry_daily_usd(M)*365 / nav_usd(L).
  // Per snapshot, blank on empty rows. NB: this is the same formula as col U (net_carry_yield_pct);
  // Z just exposes it as a standalone "net %" series next to the P&L columns. Format as %.
  NET_PCT_COL: 26,
  NET_PCT_FORMULA:
    '={"Чиста дохідність, %"; ARRAYFORMULA(IF(Snapshots!A2:A="","",IFERROR(M2:M*365/L2:L,"")))}',

  // Swap only the `{"old"; ...` label on a formula-bundled header cell; leave the body intact.
  relabelFormulaHeader: function(sheet, col, label) {
    const cell = sheet.getRange(1, col);
    const f = cell.getFormula();
    if (!f) { Logger.log('relabel: ' + sheet.getName() + ' col ' + col + ' has no formula — skipped'); return; }
    const newF = f.replace(/^=\s*\{\s*"[^"]*"\s*;/, '={"' + label + '";');
    if (newF === f) { Logger.log('relabel: ' + sheet.getName() + ' col ' + col + ' label pattern not matched — left as-is'); return; }
    cell.setValue(newF);   // setValue (like setValues): a leading-"=" string enters verbatim so LAMBDA parses
  },

  relabelFriendlyHeaders: function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // 1. Plain-header data tabs
    Object.keys(Migrate005.PLAIN_HEADERS).forEach(function(name) {
      const sheet = ss.getSheetByName(name);
      if (!sheet) { Logger.log('relabel: ' + name + ' not found — skipped'); return; }
      const headers = Migrate005.PLAIN_HEADERS[name];
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      Logger.log('relabel: ' + name + ' → ' + headers.length + ' UA headers');
    });

    // 2. Transactions — plain cells + formula-bundled I/J (don't overwrite I/J as text: they're formulas)
    const tx = ss.getSheetByName('Transactions');
    if (tx) {
      Object.keys(Migrate005.TX_PLAIN).forEach(function(c) {
        tx.getRange(1, Number(c)).setValue(Migrate005.TX_PLAIN[c]);
      });
      Object.keys(Migrate005.TX_FORMULA_LABELS).forEach(function(c) {
        Migrate005.relabelFormulaHeader(tx, Number(c), Migrate005.TX_FORMULA_LABELS[c]);
      });
      Logger.log('relabel: Transactions → UA headers (plain A–H,K + formula I/J)');
    } else {
      Logger.log('relabel: Transactions not found — skipped');
    }

    // 3. Metrics A–Y — relabel each formula-bundled header in place
    const m = ss.getSheetByName('Metrics');
    if (!m) throw new Error('Metrics tab not found — run 001 migrateMetricsFormulas() first');
    Migrate005.METRICS_LABELS.forEach(function(label, i) {
      Migrate005.relabelFormulaHeader(m, i + 1, label);
    });
    Logger.log('relabel: Metrics A–Y → UA headers (formula labels swapped in place)');
  },

  addNetPctColumn: function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const m  = ss.getSheetByName('Metrics');
    if (!m) throw new Error('Metrics tab not found — run 001 first');

    // Guard: Z = M*365/L, so M (net_carry_daily_usd) and L (nav_usd) must exist (migration 001).
    const lHeader = String(m.getRange(1, 12).getValue());   // L row-1 spilled label
    if (lHeader.indexOf('nav') === -1 && lHeader.indexOf('NAV') === -1) {
      throw new Error('Metrics!L is "' + lHeader + '", expected nav_usd/NAV — run 001 migrateMetricsFormulas() first');
    }

    m.getRange(1, Migrate005.NET_PCT_COL).setValue(Migrate005.NET_PCT_FORMULA);
    Logger.log('addNetPctColumn: wrote net % at Metrics Z (col 26) = net_carry_daily(M)*365 / nav(L)');
  }
};

// Top-level wrappers — object methods don't appear in the GAS editor's Run dropdown.
// Run order doesn't matter; both are idempotent.
function relabelFriendlyHeaders() { Migrate005.relabelFriendlyHeaders(); }
function addNetPctColumn()        { Migrate005.addNetPctColumn(); }
