// Noise-free wstETH staking-rate source.
//
// The wstETH/ETH USD price ratio (Snapshots D/B) carries market+oracle noise, so annualizing a
// 7-day window of it over-reports staking yield by ~4x. Instead read Lido's on-chain accounting
// ratio stEthPerToken() — a pure exchange rate that only grows with staking rewards.
//
// Read from ETHEREUM MAINNET (the rate is global; L2 wstETH represents the same token).
// OPTIONAL: if RPC_ETH_URL / RPC_ETH_KEY are absent the snapshot still runs — the rate column
// just stays blank. A failed read NEVER adds to error_flags (must not skip the whole snapshot).

const Lido = {
  WSTETH_MAINNET:           '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
  STETH_PER_TOKEN_SELECTOR: '0x035faf82',  // keccak256("stEthPerToken()")[:4]; returns uint256 (1e18)
  APR_URL:                  'https://eth-api.lido.fi/v1/protocol/steth/apr/sma',  // public; no key

  _ethRpcUrl: function(config) {
    if (!config.RPC_ETH_URL || !config.RPC_ETH_KEY) return null;
    return config.RPC_ETH_URL.replace(/\/?$/, '/') + config.RPC_ETH_KEY;
  },

  // Returns a fetchAll request object, or null if mainnet RPC is not configured.
  buildRateRequest: function(config) {
    const url = Lido._ethRpcUrl(config);
    if (!url) return null;
    return {
      url: url,
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        jsonrpc: '2.0', id: 7,
        method: 'eth_call',
        params: [{ to: Lido.WSTETH_MAINNET, data: Lido.STETH_PER_TOKEN_SELECTOR }, 'latest']
      }),
      muteHttpExceptions: true
    };
  },

  // wstETH→stETH exchange rate as a JS Number (~1.2), or null on any problem.
  parseRate: function(response) {
    try {
      if (!response) return null;
      if (response.getResponseCode() !== 200) return null;
      const body = JSON.parse(response.getContentText());
      if (body.error || !body.result || body.result === '0x') return null;
      const rate = Utils.hexToDecimal(body.result, 18);
      Logger.log('Lido wstETH rate: ' + rate.toFixed(6));
      return rate;
    } catch (e) {
      Logger.log('Lido.parseRate error: ' + e.message);
      return null;
    }
  },

  // Lido's published 7-day SMA staking APR. Public GET, no key required.
  buildAprRequest: function() {
    return { url: Lido.APR_URL, method: 'get', muteHttpExceptions: true };
  },

  // Returns APR as a decimal (~0.027), or null on any problem. Never blocks the snapshot.
  // API shape: { data: { smaApr: <percent>, aprs: [...] }, meta: {...} }
  parseApr: function(response) {
    try {
      if (!response) return null;
      if (response.getResponseCode() !== 200) return null;
      const body = JSON.parse(response.getContentText());
      const sma  = body && body.data && body.data.smaApr;
      if (sma == null || isNaN(sma)) return null;
      const apr = Number(sma) / 100;  // percent -> decimal (matches the sheet's rate convention)
      Logger.log('Lido APR (7d SMA): ' + (apr * 100).toFixed(2) + '%');
      return apr;
    } catch (e) {
      Logger.log('Lido.parseApr error: ' + e.message);
      return null;
    }
  }
};
