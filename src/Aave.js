const Aave = {
  AAVE_POOL_ARB: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',

  buildRequest: function(config) {
    const address = (config.ARB_ADDRESS || '').toLowerCase();
    const query = `{
      user(id: "${address}") {
        reserves {
          reserve { symbol decimals liquidityRate variableBorrowRate }
          currentATokenBalance
          currentVariableDebt
        }
      }
    }`;
    const url = 'https://gateway.thegraph.com/api/' + config.GRAPH_API_KEY +
                '/subgraphs/id/' + config.AAVE_SUBGRAPH_ID;
    return {
      url: url,
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ query: query }),
      muteHttpExceptions: true
    };
  },

  buildAccountDataRequest: function(config) {
    const rpcUrl     = (config.RPC_ARB_URL || '').replace(/\/?$/, '/') + config.RPC_ARB_KEY;
    const paddedAddr = '000000000000000000000000' + (config.ARB_ADDRESS || '').replace('0x', '');
    return {
      url: rpcUrl,
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        jsonrpc: '2.0', id: 2,
        method: 'eth_call',
        params: [{ to: Aave.AAVE_POOL_ARB, data: '0xbf92857c' + paddedAddr }, 'latest']
      }),
      muteHttpExceptions: true
    };
  },

  // prices: { eth_usd, wsteth_usd, ... } from Fluid — used to compute per-reserve value_usd
  parseResponse: function(response, accountDataResp, timestamp, prices) {
    try {
      const code = response.getResponseCode();
      if (code !== 200) throw new Error('Aave HTTP ' + code);

      const body = JSON.parse(response.getContentText());
      if (body.errors) throw new Error('Aave GraphQL: ' + JSON.stringify(body.errors));

      const reserves     = (body.data && body.data.user && body.data.user.reserves) || [];
      const positionRows = [];

      for (const r of reserves) {
        const sym       = (r.reserve.symbol || '').toUpperCase();
        const decimals  = Number(r.reserve.decimals) || 18;
        const supplyApy = Number(r.reserve.liquidityRate)      / 1e27;
        const borrowApy = Number(r.reserve.variableBorrowRate) / 1e27;
        const balance   = Number(r.currentATokenBalance) / Math.pow(10, decimals);
        const debt      = Number(r.currentVariableDebt)  / Math.pow(10, decimals);

        // Price from Fluid oracle (same-block prices); stablecoins treated as $1
        var tokenPrice = null;
        if (sym === 'WSTETH')                                      tokenPrice = prices && prices.wsteth_usd;
        else if (sym === 'WETH' || sym === 'ETH')                  tokenPrice = prices && prices.eth_usd;
        else if (sym === 'USDT' || sym === 'USDC' || sym === 'USDC.E') tokenPrice = 1;

        if (balance > 0) {
          positionRows.push([
            timestamp, 'aave', 'arbitrum', 'user',
            sym, 'supply',
            balance, tokenPrice != null ? balance * tokenPrice : null,
            supplyApy
          ]);
        }

        if (debt > 0) {
          positionRows.push([
            timestamp, 'aave', 'arbitrum', 'user',
            sym, 'borrow',
            debt, tokenPrice != null ? debt * tokenPrice : null,
            borrowApy
          ]);
        }
      }

      // Account-level risk from getUserAccountData eth_call
      const riskRows = [];
      if (accountDataResp) {
        try {
          const acctBody = JSON.parse(accountDataResp.getContentText());
          if (acctBody.error) throw new Error('accountData RPC: ' + acctBody.error.message);
          const hex = acctBody.result.slice(2);
          if (hex.length >= 6 * 64) {
            const totalCollateralBase = BigInt('0x' + hex.slice(0 * 64, 1 * 64));
            const totalDebtBase       = BigInt('0x' + hex.slice(1 * 64, 2 * 64));
            const ZERO = BigInt(0);
            const hf  = totalDebtBase       === ZERO ? null : Utils.hexToDecimal('0x' + hex.slice(5 * 64, 6 * 64), 18);
            const ltv = totalCollateralBase  === ZERO ? null : Number(totalDebtBase) / Number(totalCollateralBase);
            riskRows.push([timestamp, 'aave', 'arbitrum', 'user', hf, ltv]);
          }
        } catch (acctErr) {
          Logger.log('Aave accountData parse error: ' + acctErr.message);
        }
      }

      Logger.log('Aave OK: ' + reserves.length + ' reserves → ' + positionRows.length + ' rows');

      return { positionRows: positionRows, riskRows: riskRows, error: null };
    } catch (e) {
      Logger.log('Aave.parseResponse error: ' + e.message);
      return { positionRows: [], riskRows: [], error: 'AAVE_ERR' };
    }
  }
};
