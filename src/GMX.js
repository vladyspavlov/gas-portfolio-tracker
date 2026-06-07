const GMX = {
  MARKETS_INFO_URL: 'https://arbitrum.gmxapi.io/v1/markets/info',
  APY_URL:          'https://arbitrum-api.gmxinfra.io/apy',
  DATASTORE_ARB:    '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8',

  buildMarketsInfoRequest: function() {
    return { url: GMX.MARKETS_INFO_URL, method: 'get', muteHttpExceptions: true };
  },

  buildApyRequest: function() {
    return { url: GMX.APY_URL, method: 'get', muteHttpExceptions: true };
  },

  _rpcRequest: function(rpcUrl, to, data) {
    return {
      url: rpcUrl,
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_call',
        params: [{ to: to, data: data }, 'latest']
      }),
      muteHttpExceptions: true
    };
  },

  _arbRpcUrl: function(config) {
    return (config.RPC_ARB_URL || '').replace(/\/?$/, '/') + config.RPC_ARB_KEY;
  },

  _baseRpcUrl: function(config) {
    return (config.RPC_BASE_URL || '').replace(/\/?$/, '/') + config.RPC_BASE_KEY;
  },

  // balanceOf(ARB_ADDRESS) on an Arbitrum GM market contract
  buildArbBalanceRequest: function(config, marketAddr) {
    const padded = '000000000000000000000000' + (config.ARB_ADDRESS || '').replace('0x', '');
    return GMX._rpcRequest(GMX._arbRpcUrl(config), marketAddr, '0x70a08231' + padded);
  },

  // totalSupply() on an Arbitrum GM market contract (for price calculation)
  buildArbTotalSupplyRequest: function(config, marketAddr) {
    return GMX._rpcRequest(GMX._arbRpcUrl(config), marketAddr, '0x18160ddd');
  },

  // balanceOf(BASE_ADDRESS) on a Base GM receipt token contract
  buildBaseBalanceRequest: function(config, tokenAddr) {
    const padded = '000000000000000000000000' + (config.BASE_ADDRESS || '').replace('0x', '');
    return GMX._rpcRequest(GMX._baseRpcUrl(config), tokenAddr, '0x70a08231' + padded);
  },

  // DataStore.getUint(GMX_ACCOUNT_KEY_ARB) — reads GMX Account balance on Arbitrum.
  // GMX_ACCOUNT_KEY_ARB is the precomputed multichainBalanceKey(ARB_ADDRESS, gmMarketToken).
  // Returns null if config key is absent (feature disabled).
  buildArbAccountBalanceRequest: function(config) {
    if (!config.GMX_ACCOUNT_KEY_ARB) return null;
    const key = config.GMX_ACCOUNT_KEY_ARB.replace('0x', '').padStart(64, '0');
    return GMX._rpcRequest(GMX._arbRpcUrl(config), GMX.DATASTORE_ARB, '0xbd02d0f5' + key);
  },

  // arbMarkets, baseTokens — string arrays from Config (comma-separated, same-index mapping)
  // arbBalResps[i] / arbSupResps[i] — fetchAll responses for each Arb market
  // baseBalResps[i]                 — fetchAll responses for each Base token
  // accountResp                     — DataStore.getUint response, or null if not configured
  // accountMarket                   — Config.GMX_ACCOUNT_MARKET_ARB (for price lookup), or null
  // Base tokens share price/APY with their same-index Arb market (same underlying pool)
  parseResult: function(marketsInfoResp, apyResp,
                        arbMarkets, arbBalResps, arbSupResps,
                        baseTokens, baseBalResps,
                        accountResp, accountMarket,
                        timestamp) {
    const positionRows = [];

    // Parse shared API responses first
    var marketsInfo, apyData;
    try {
      marketsInfo = JSON.parse(marketsInfoResp.getContentText());
      if (!Array.isArray(marketsInfo)) throw new Error('markets/info not an array');
      apyData = JSON.parse(apyResp.getContentText());
    } catch (e) {
      Logger.log('GMX shared API parse error: ' + e.message);
      arbMarkets.forEach(function(addr) {
        positionRows.push([timestamp, 'gmx', 'arbitrum', addr, 'GM', 'lp', null, null, null, null]);
      });
      baseTokens.forEach(function(addr) {
        positionRows.push([timestamp, 'gmx', 'base', addr, 'GM', 'lp', null, null, null, null]);
      });
      return { positionRows: positionRows, error: 'GMX_ERR' };
    }

    // price and APY per Arb market index — reused for corresponding Base tokens
    const arbCache = [];

    arbMarkets.forEach(function(marketAddr, i) {
      try {
        const market = marketsInfo.find(function(m) {
          return (m.marketTokenAddress || '').toLowerCase() === marketAddr.toLowerCase();
        });
        if (!market) throw new Error('market not found: ' + marketAddr);

        const poolVal     = BigInt(market.poolValueMax);

        const balBody = JSON.parse(arbBalResps[i].getContentText());
        if (balBody.error) throw new Error('balanceOf RPC: ' + balBody.error.message);
        const balance = Utils.hexToDecimal(balBody.result, 18);

        const supBody = JSON.parse(arbSupResps[i].getContentText());
        if (supBody.error) throw new Error('totalSupply RPC: ' + supBody.error.message);
        const totalSupply = BigInt(supBody.result);

        // poolValueMax is in 10^30 USD; totalSupply in 10^18 → price in 10^12 → divide by 1e12
        const priceE12  = poolVal / totalSupply;
        const price     = Number(priceE12) / 1e12;
        const value_usd = balance * price;

        const apyEntry = apyData.markets && apyData.markets[market.marketTokenAddress];
        const apy      = apyEntry ? apyEntry.apy : null;

        arbCache[i] = { price: price, apy: apy };

        positionRows.push([timestamp, 'gmx', 'arbitrum', marketAddr, 'GM', 'lp', balance, value_usd, apy,
          value_usd != null && apy != null ? value_usd * apy / 365 : null]);

        Logger.log('GMX ARB [' + marketAddr.slice(0, 8) + ']: bal=' + balance.toFixed(2) +
                   ' price=$' + price.toFixed(4) + ' apy=' + (apy !== null ? (apy * 100).toFixed(2) + '%' : 'null'));
      } catch (e) {
        Logger.log('GMX ARB market error [' + marketAddr.slice(0, 8) + ']: ' + e.message);
        arbCache[i] = null;
        positionRows.push([timestamp, 'gmx', 'arbitrum', marketAddr, 'GM', 'lp', null, null, null, null]);
      }
    });

    // Base GM receipt tokens — balance from Base RPC, price/APY from same-index Arb market
    baseTokens.forEach(function(tokenAddr, i) {
      try {
        const balBody = JSON.parse(baseBalResps[i].getContentText());
        if (balBody.error) throw new Error('Base balanceOf RPC: ' + balBody.error.message);
        const balance   = Utils.hexToDecimal(balBody.result, 18);
        const cached    = arbCache[i];
        const value_usd = cached ? balance * cached.price : null;
        const apy       = cached ? cached.apy             : null;

        positionRows.push([timestamp, 'gmx', 'base', tokenAddr, 'GM', 'lp', balance, value_usd, apy,
          value_usd != null && apy != null ? value_usd * apy / 365 : null]);

        Logger.log('GMX BASE [' + tokenAddr.slice(0, 8) + ']: bal=' + balance.toFixed(2));
      } catch (e) {
        Logger.log('GMX BASE token error [' + tokenAddr.slice(0, 8) + ']: ' + e.message);
        positionRows.push([timestamp, 'gmx', 'base', tokenAddr, 'GM', 'lp', null, null, null, null]);
      }
    });

    // GMX Account balance — tokens deposited via cross-chain / same-chain into GMX's internal vault.
    // Price is reused from the matching Arb market (same token, same pool).
    if (accountResp) {
      try {
        const acctBody = JSON.parse(accountResp.getContentText());
        if (acctBody.error) throw new Error('DataStore getUint: ' + acctBody.error.message);
        const balance = Utils.hexToDecimal(acctBody.result, 18);

        // Look up price from arbCache using accountMarket address
        var acctPrice = null;
        if (accountMarket) {
          var matchIdx = -1;
          arbMarkets.forEach(function(m, i) {
            if (m.toLowerCase() === accountMarket.toLowerCase()) matchIdx = i;
          });
          if (matchIdx >= 0 && arbCache[matchIdx]) acctPrice = arbCache[matchIdx].price;
        }
        const value_usd = acctPrice !== null ? balance * acctPrice : null;
        const acctApy   = (matchIdx >= 0 && arbCache[matchIdx]) ? arbCache[matchIdx].apy : null;

        positionRows.push([timestamp, 'gmx', 'arbitrum', 'gmx_account', 'GM', 'lp', balance, value_usd, acctApy,
          value_usd != null && acctApy != null ? value_usd * acctApy / 365 : null]);
        Logger.log('GMX Account: bal=' + balance.toFixed(2) + (value_usd ? ' val=$' + value_usd.toFixed(2) : ''));
      } catch (e) {
        Logger.log('GMX Account balance error: ' + e.message);
        positionRows.push([timestamp, 'gmx', 'arbitrum', 'gmx_account', 'GM', 'lp', null, null, null, null]);
      }
    }

    return { positionRows: positionRows, error: null };
  }
};
