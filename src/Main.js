function snapshotPortfolio() {
  const config = Config.getAll();

  if ((config.ENABLED || '').toLowerCase() !== 'true') {
    Logger.log('Snapshot skipped: ENABLED != true');
    return;
  }

  const timestamp  = new Date().toISOString();
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
    errorFlags.join(',')
  ]);

  // Positions — batch write: Fluid + Aave + GMX rows
  const positionRows = fluid.positionRows.concat(aave.positionRows).concat(gmx.positionRows);
  if (positionRows.length > 0) {
    const lastPos = positionsSheet.getLastRow();
    positionsSheet
      .getRange(lastPos + 1, 1, positionRows.length, positionRows[0].length)
      .setValues(positionRows);
  }

  // Risk — batch write: Fluid vaults + Aave account (GMX LP has no liquidation risk)
  const riskRows = fluid.riskRows.concat(aave.riskRows);
  if (riskRows.length > 0) {
    const lastRisk = riskSheet.getLastRow();
    riskSheet
      .getRange(lastRisk + 1, 1, riskRows.length, riskRows[0].length)
      .setValues(riskRows);
  }

  Logger.log('Snapshot done: ' + timestamp +
             ' | positions: ' + positionRows.length +
             ' | risk: '      + riskRows.length +
             ' | errors: '    + (errorFlags.join(',') || 'none'));
}

function initHeaders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  var tabs = [
    {
      name: 'Snapshots',
      headers: ['timestamp', 'eth_usd', 'btc_usd', 'wsteth_usd', 'cbbtc_usd', 'error_flags']
    },
    {
      name: 'Positions',
      headers: ['timestamp', 'protocol', 'chain', 'position_id', 'token', 'side', 'amount', 'value_usd', 'apy']
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
