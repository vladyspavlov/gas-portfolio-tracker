const Fluid = {
  buildRequest: function(config) {
    return {
      url: config.FLUID_SERVICE_URL + '/positions',
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ address: config.BASE_ADDRESS }),
      muteHttpExceptions: true
    };
  },

  parseResponse: function(response, timestamp) {
    try {
      const code = response.getResponseCode();
      if (code !== 200) throw new Error('Fluid HTTP ' + code);

      const data      = JSON.parse(response.getContentText());
      const rawPrices = data.prices    || {};
      const positions = data.positions || [];

      const prices = {
        eth_usd    : rawPrices.ETH_USD    != null ? rawPrices.ETH_USD    : null,
        btc_usd    : rawPrices.BTC_USD    != null ? rawPrices.BTC_USD    : null,
        wsteth_usd : rawPrices.wstETH_USD != null ? rawPrices.wstETH_USD : null,
        cbbtc_usd  : rawPrices.cbBTC_USD  != null ? rawPrices.cbBTC_USD  : null
      };

      const positionRows = [];
      const riskRows     = [];

      for (const p of positions) {
        const posId        = p.nftId || p.vault || 'unknown';
        const collAmt      = Number(p.collateral.amount);
        const debtAmt      = Number(p.debt.amount);
        const collUSD      = p.collateral.valueUSD != null ? p.collateral.valueUSD : null;
        const debtUSD      = p.debt.valueUSD       != null ? p.debt.valueUSD       : null;

        positionRows.push([
          timestamp, 'fluid', 'base', posId,
          p.collateral.token, 'supply',
          collAmt, collUSD,
          p.rates.supplyAPY != null ? p.rates.supplyAPY : null
        ]);

        positionRows.push([
          timestamp, 'fluid', 'base', posId,
          p.debt.token, 'borrow',
          debtAmt, debtUSD,
          p.rates.borrowAPY != null ? p.rates.borrowAPY : null
        ]);

        const hf  = p.health && p.health.healthFactor != null ? p.health.healthFactor : null;
        const ltv = collUSD && debtUSD                        ? debtUSD / collUSD     : null;

        riskRows.push([timestamp, 'fluid', 'base', posId, hf, ltv]);
      }

      Logger.log('Fluid OK: ' + positions.length + ' positions → ' + positionRows.length + ' rows');

      return { prices: prices, positionRows: positionRows, riskRows: riskRows, error: null };
    } catch (e) {
      Logger.log('Fluid.parseResponse error: ' + e.message);
      return {
        prices: { eth_usd: null, btc_usd: null, wsteth_usd: null, cbbtc_usd: null },
        positionRows: [],
        riskRows: [],
        error: 'FLUID_ERR'
      };
    }
  }
};
