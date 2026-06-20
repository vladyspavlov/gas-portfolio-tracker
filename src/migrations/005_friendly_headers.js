// Migration 005 — friendly Ukrainian headers on all five tabs.
//
// One-time, run MANUALLY from the GAS editor (never by a trigger). See 001–004 for the convention.
//
//   relabelFriendlyHeaders() — renames the row-1 HEADER LABELS on all five tabs to human-friendly
//                              Ukrainian (the sheet is monitored by people, not just formulas).
//                              Idempotent and re-runnable.
//
// (A net-% column on Metrics Z was added here originally, then reverted: it was identical to col U
//  `net_carry_yield_pct` = M*365/L, so it was pure duplication. Chart col U instead.)
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
  }
};

// Top-level wrapper — object methods don't appear in the GAS editor's Run dropdown.
function relabelFriendlyHeaders() { Migrate005.relabelFriendlyHeaders(); }
