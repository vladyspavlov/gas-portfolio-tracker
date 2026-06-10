function snapshotPortfolio() {
  const config = Config.getAll();

  if ((config.ENABLED || '').toLowerCase() !== 'true') {
    Logger.log('Snapshot skipped: ENABLED != true');
    return;
  }

  const timestamp  = new Date();
  const errorFlags = [];

  // GMX market/token lists — comma-separated in Config tab
  const arbMarkets = (config.GMX_ARB_MARKETS    || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  const baseTokens = (config.GMX_BASE_GM_TOKENS || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);

  // Build parallel request array dynamically
  const requests = [
    Fluid.buildRequest(config),             // [0]
    Aave.buildRequest(config),              // [1]
    Aave.buildAccountDataRequest(config),   // [2]
    GMX.buildMarketsInfoRequest(),          // [3]
    GMX.buildApyRequest(),                  // [4]
  ];

  // Arbitrum GM: one balanceOf + one totalSupply per market
  const arbBalStart    = requests.length; // 5
  arbMarkets.forEach(function(m) { requests.push(GMX.buildArbBalanceRequest(config, m)); });

  const arbSupplyStart = requests.length; // 5 + N
  arbMarkets.forEach(function(m) { requests.push(GMX.buildArbTotalSupplyRequest(config, m)); });

  // Base GM: one balanceOf per receipt token
  const baseBalStart   = requests.length; // 5 + 2N
  baseTokens.forEach(function(t) { requests.push(GMX.buildBaseBalanceRequest(config, t)); });

  // GMX Account balance (optional — requires GMX_ACCOUNT_KEY_ARB in Config tab)
  const acctBalReq     = GMX.buildArbAccountBalanceRequest(config);
  const acctBalIdx     = acctBalReq ? requests.length : -1;
  if (acctBalReq) requests.push(acctBalReq);

  // Lido wstETH exchange rate (optional — requires RPC_ETH_URL + RPC_ETH_KEY).
  // Noise-free staking-rate source; never blocks the snapshot if absent or failing.
  const lidoRateReq    = Lido.buildRateRequest(config);
  const lidoRateIdx    = lidoRateReq ? requests.length : -1;
  if (lidoRateReq) requests.push(lidoRateReq);

  // Lido published 7-day SMA APR — public, no key. Used as the warm-up fallback for the
  // staking-yield metric (before the on-chain rate has a full 7-day window).
  const lidoAprIdx     = requests.length;
  requests.push(Lido.buildAprRequest());

  const responses = UrlFetchApp.fetchAll(requests);

  // Parse — Fluid first: its oracle prices are passed to Aave for value_usd computation
  const fluid = Fluid.parseResponse(responses[0], timestamp);
  if (fluid.error) errorFlags.push(fluid.error);

  const aave = Aave.parseResponse(responses[1], responses[2], timestamp, fluid.prices);
  if (aave.error) errorFlags.push(aave.error);

  const gmx = GMX.parseResult(
    responses[3], responses[4],
    arbMarkets,
    responses.slice(arbBalStart,    arbBalStart    + arbMarkets.length),
    responses.slice(arbSupplyStart, arbSupplyStart + arbMarkets.length),
    baseTokens,
    responses.slice(baseBalStart,   baseBalStart   + baseTokens.length),
    acctBalIdx >= 0 ? responses[acctBalIdx] : null,
    config.GMX_ACCOUNT_MARKET_ARB || null,
    timestamp
  );
  if (gmx.error) errorFlags.push(gmx.error);

  // Optional, non-blocking: null if not configured or read failed (no error_flags entry)
  const wstethRate = lidoRateIdx >= 0 ? Lido.parseRate(responses[lidoRateIdx]) : null;
  const lidoApr    = Lido.parseApr(responses[lidoAprIdx]);  // non-blocking; null on failure

  // Skip entirely if any data source failed — partial snapshots pollute the time series
  if (errorFlags.length > 0) {
    Logger.log('Snapshot skipped — will retry next hour. Errors: ' + errorFlags.join(', '));
    return;
  }

  // Open tabs
  const ss             = SpreadsheetApp.getActiveSpreadsheet();
  const snapshotsSheet = ss.getSheetByName('Snapshots');
  const positionsSheet = ss.getSheetByName('Positions');
  const riskSheet      = ss.getSheetByName('Risk');

  if (!snapshotsSheet || !positionsSheet || !riskSheet) {
    throw new Error('Missing required tabs: Snapshots, Positions, Risk');
  }

  // Snapshots — 1 row: prices + error flags
  snapshotsSheet.appendRow([
    timestamp,
    fluid.prices.eth_usd, fluid.prices.btc_usd,
    fluid.prices.wsteth_usd, fluid.prices.cbbtc_usd,
    errorFlags.join(','),
    wstethRate != null ? wstethRate : '',
    lidoApr != null ? lidoApr : ''
  ]);

  // Positions — batch write: Fluid + Aave + GMX rows
  const positionRows = fluid.positionRows.concat(aave.positionRows).concat(gmx.positionRows);
  if (positionRows.length > 0) {
    const lastPos = Utils.lastDataRow(positionsSheet);
    positionsSheet
      .getRange(lastPos + 1, 1, positionRows.length, positionRows[0].length)
      .setValues(positionRows);
  }

  // Risk — batch write: Fluid vaults + Aave account (GMX LP has no liquidation risk)
  const riskRows = fluid.riskRows.concat(aave.riskRows);
  if (riskRows.length > 0) {
    const lastRisk = Utils.lastDataRow(riskSheet);
    riskSheet
      .getRange(lastRisk + 1, 1, riskRows.length, riskRows[0].length)
      .setValues(riskRows);
  }

  Logger.log('Snapshot done: ' + timestamp +
             ' | positions: ' + positionRows.length +
             ' | risk: '      + riskRows.length +
             ' | errors: '    + (errorFlags.join(',') || 'none'));
}

// Run this manually from GAS UI or `clasp run debugState` to diagnose write issues
function debugState() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var snap = ss.getSheetByName('Snapshots');
  var pos  = ss.getSheetByName('Positions');
  var risk = ss.getSheetByName('Risk');

  Logger.log('=== Snapshots ===');
  Logger.log('getLastRow()   : ' + snap.getLastRow());
  Logger.log('lastDataRow()  : ' + Utils.lastDataRow(snap));
  var snapRows = snap.getLastRow() > 1
    ? snap.getRange(2, 1, Math.min(snap.getLastRow() - 1, 3), snap.getLastColumn()).getValues()
    : [];
  snapRows.forEach(function(r) { Logger.log('  ' + JSON.stringify(r)); });

  Logger.log('=== Positions ===');
  Logger.log('getLastRow()   : ' + pos.getLastRow());
  Logger.log('lastDataRow()  : ' + Utils.lastDataRow(pos));
  var posRows = Utils.lastDataRow(pos) > 1
    ? pos.getRange(2, 1, Math.min(Utils.lastDataRow(pos) - 1, 5), 13).getValues()
    : [];
  posRows.forEach(function(r) { Logger.log('  ' + JSON.stringify(r)); });

  Logger.log('=== Risk ===');
  Logger.log('getLastRow()   : ' + risk.getLastRow());
  Logger.log('lastDataRow()  : ' + Utils.lastDataRow(risk));
  var riskRows = Utils.lastDataRow(risk) > 1
    ? risk.getRange(2, 1, Math.min(Utils.lastDataRow(risk) - 1, 5), 6).getValues()
    : [];
  riskRows.forEach(function(r) { Logger.log('  ' + JSON.stringify(r)); });
}

function initHeaders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  var tabs = [
    {
      name: 'Snapshots',
      headers: ['timestamp', 'eth_usd', 'btc_usd', 'wsteth_usd', 'cbbtc_usd', 'error_flags', 'wsteth_steth_rate', 'lido_apr']
    },
    {
      name: 'Positions',
      headers: ['timestamp', 'protocol', 'chain', 'category', 'position_id', 'token', 'side', 'amount', 'price_usd', 'value_usd', 'value_signed_usd', 'apy', 'daily_carry_usd']
    },
    {
      name: 'Risk',
      headers: ['timestamp', 'protocol', 'chain', 'position_id', 'health_factor', 'ltv']
    }
  ];

  tabs.forEach(function(t) {
    var sheet = ss.getSheetByName(t.name);
    if (!sheet) throw new Error(t.name + ' tab not found');
    sheet.getRange(1, 1, 1, t.headers.length).setValues([t.headers]);
    Logger.log(t.name + ' headers written: ' + t.headers.length + ' columns');
  });
}
