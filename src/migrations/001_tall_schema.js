// Migration 001 — venue-agnostic "tall" schema.
//
// Convention: one-time migrations live in src/migrations/ with a NNN_ ordinal prefix and are run
// MANUALLY from the GAS editor (never by the trigger). They ship in the deployed bundle so they're
// runnable in the editor, but nothing in the runtime path calls them. Add the next one as 002_*.js.
//
//   migratePositions()        — converts the old 10-col Positions layout to the new 13-col layout
//                               (adds category + price_usd + value_signed_usd). Guards against
//                               double-runs; backs up the original tab to "Positions_old" first.
//   migrateMetricsFormulas()  — rewrites the Metrics tab row-1 array formulas (A–S) to the new
//                               Positions column letters (+ S = noise-free wsteth_rate passthrough).
//
// Run migratePositions() FIRST, then migrateMetricsFormulas().

const Migrate = {
  POSITIONS_HEADERS: [
    'timestamp', 'protocol', 'chain', 'category', 'position_id', 'token', 'side',
    'amount', 'price_usd', 'value_usd', 'value_signed_usd', 'apy', 'daily_carry_usd'
  ],

  // Old Positions layout (10 cols): A timestamp, B protocol, C chain, D position_id,
  // E token, F side, G amount, H value_usd (unsigned), I apy, J daily_carry_usd.
  migratePositions: function() {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Positions');
    if (!sheet) throw new Error('Positions tab not found');

    // Guard 1: already in the new layout? Bail before touching anything.
    // `value_signed_usd` exists only in the 13-col schema; `category` in D confirms it.
    if (sheet.getLastColumn() >= Migrate.POSITIONS_HEADERS.length) {
      const header = sheet.getRange(1, 1, 1, Migrate.POSITIONS_HEADERS.length).getValues()[0];
      if (header[3] === 'category' && header[10] === 'value_signed_usd') {
        throw new Error('Positions is already in the new 13-col layout — nothing to migrate.');
      }
    }

    // Guard 2: don't clobber an existing backup from a prior run.
    if (ss.getSheetByName('Positions_old')) {
      throw new Error('Positions_old already exists — migration already ran. ' +
                      'Delete it manually to re-run.');
    }

    const lastRow = Utils.lastDataRow(sheet);

    // Back up the entire original tab (data + formatting) before touching anything
    sheet.copyTo(ss).setName('Positions_old');

    const out = [];
    if (lastRow >= 2) {
      const old = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
      old.forEach(function(r) {
        const protocol  = r[1];
        const side      = String(r[5]).toLowerCase();
        const amount    = r[6];
        const oldValue  = r[7];                              // unsigned in the old layout
        const isNum     = typeof oldValue === 'number';

        const category  = String(protocol).toLowerCase() === 'gmx' ? 'lp' : 'lend';
        const price     = (isNum && amount) ? oldValue / amount : '';
        const unsigned  = isNum ? Math.abs(oldValue) : oldValue;
        const signed    = isNum ? (side === 'borrow' ? -Math.abs(oldValue) : Math.abs(oldValue)) : oldValue;

        out.push([
          r[0],        // timestamp
          protocol,    // protocol
          r[2],        // chain
          category,    // category (new)
          r[3],        // position_id
          r[4],        // token
          r[5],        // side
          amount,      // amount
          price,       // price_usd (new)
          unsigned,    // value_usd (unsigned)
          signed,      // value_signed_usd (new)
          r[8],        // apy
          r[9]         // daily_carry_usd (already signed in old data)
        ]);
      });
    }

    sheet.clearContents();
    sheet.getRange(1, 1, 1, Migrate.POSITIONS_HEADERS.length).setValues([Migrate.POSITIONS_HEADERS]);
    if (out.length > 0) {
      sheet.getRange(2, 1, out.length, Migrate.POSITIONS_HEADERS.length).setValues(out);
    }

    Logger.log('migratePositions: ' + out.length + ' rows converted. Backup tab: Positions_old');
  },

  // Metrics row-1 array formulas, re-lettered for the new Positions layout.
  // New Positions cols: B=protocol G=side H=amount J=value_usd K=value_signed_usd M=daily_carry_usd.
  // Risk is unchanged: B=protocol D=position_id E=health_factor F=ltv.
  METRICS_FORMULAS: [
    '={"Timestamp"; ARRAYFORMULA(IF(Snapshots!A2:A="","",Snapshots!A2:A))}',
    '={"eth_usd"; ARRAYFORMULA(IF(Snapshots!A2:A="","",Snapshots!B2:B))}',
    '={"wsteth_usd"; ARRAYFORMULA(IF(Snapshots!A2:A="","",Snapshots!D2:D))}',
    '={"wsteth_eth_ratio"; ARRAYFORMULA(IF(Snapshots!A2:A="","",Snapshots!D2:D/Snapshots!B2:B))}',
    '={"aave_supply_usd"; BYROW(Snapshots!A2:A,LAMBDA(ts,IF(ts="","",SUMPRODUCT((Positions!A$2:A=ts)*(Positions!B$2:B="aave")*(Positions!G$2:G="supply")*IFERROR(Positions!J$2:J,0)))))}',
    '={"aave_borrow_usd"; BYROW(Snapshots!A2:A,LAMBDA(ts,IF(ts="","",SUMPRODUCT((Positions!A$2:A=ts)*(Positions!B$2:B="aave")*(Positions!G$2:G="borrow")*IFERROR(Positions!J$2:J,0)))))}',
    '={"aave_net_usd"; ARRAYFORMULA(IF(A2:A="","",E2:E-F2:F))}',
    '={"fluid_supply_usd"; BYROW(Snapshots!A2:A,LAMBDA(ts,IF(ts="","",SUMPRODUCT((Positions!A$2:A=ts)*(Positions!B$2:B="fluid")*(Positions!G$2:G="supply")*IFERROR(Positions!J$2:J,0)))))}',
    '={"fluid_borrow_usd"; BYROW(Snapshots!A2:A,LAMBDA(ts,IF(ts="","",SUMPRODUCT((Positions!A$2:A=ts)*(Positions!B$2:B="fluid")*(Positions!G$2:G="borrow")*IFERROR(Positions!J$2:J,0)))))}',
    '={"fluid_net_usd"; ARRAYFORMULA(IF(A2:A="","",H2:H-I2:I))}',
    '={"gmx_usd"; BYROW(Snapshots!A2:A,LAMBDA(ts,IF(ts="","",SUMPRODUCT((Positions!A$2:A=ts)*(Positions!B$2:B="gmx")*IFERROR(Positions!J$2:J,0)))))}',
    '={"nav_usd"; BYROW(Snapshots!A2:A,LAMBDA(ts,IF(ts="","",SUMPRODUCT((Positions!A$2:A=ts)*IFERROR(Positions!K$2:K,0)))))}',
    '={"net_carry_daily_usd"; BYROW(Snapshots!A2:A,LAMBDA(ts,IF(ts="","",SUMPRODUCT((Positions!A$2:A=ts)*IFERROR(Positions!M$2:M,0)))))}',
    '={"aave_hf"; BYROW(Snapshots!A2:A,LAMBDA(ts,IF(ts="","",SUMPRODUCT((Risk!A$2:A=ts)*(Risk!B$2:B="aave")*(Risk!D$2:D="user")*IFERROR(Risk!E$2:E,0)))))}',
    '={"fluid_min_hf"; BYROW(Snapshots!A2:A,LAMBDA(ts,IF(ts="","",IFERROR(MINIFS(Risk!E$2:E,Risk!A$2:A,ts,Risk!B$2:B,"fluid"),""))))}',
    '={"aave_ltv"; BYROW(Snapshots!A2:A,LAMBDA(ts,IF(ts="","",SUMPRODUCT((Risk!A$2:A=ts)*(Risk!B$2:B="aave")*(Risk!D$2:D="user")*IFERROR(Risk!F$2:F,0)))))}',
    '={"fluid_ltv"; BYROW(Snapshots!A2:A,LAMBDA(ts,IF(ts="","",IFERROR(MIN(MAXIFS(Risk!F$2:F,Risk!A$2:A,ts,Risk!B$2:B,"fluid"),1),""))))}',
    '={"wsteth_amount"; BYROW(Snapshots!A2:A,LAMBDA(ts,IF(ts="","",SUMPRODUCT((Positions!A$2:A=ts)*(Positions!F$2:F="WSTETH")*(Positions!G$2:G="supply")*IFERROR(Positions!H$2:H,0)))))}',
    // S: noise-free wstETH->stETH exchange rate (passthrough of Snapshots G) for the staking-yield metric
    '={"wsteth_rate"; ARRAYFORMULA(IF(Snapshots!A2:A="","",Snapshots!G2:G))}'
  ],

  migrateMetricsFormulas: function() {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Metrics');
    if (!sheet) throw new Error('Metrics tab not found');

    sheet.clearContents();
    // Use setValues (not setFormulas): a leading-"=" string is entered exactly as typed, so
    // LAMBDA/BYROW parse correctly. setFormulas validates more strictly and throws on them.
    sheet.getRange(1, 1, 1, Migrate.METRICS_FORMULAS.length).setValues([Migrate.METRICS_FORMULAS]);

    Logger.log('migrateMetricsFormulas: ' + Migrate.METRICS_FORMULAS.length + ' column formulas written (A–R)');
  }
};
