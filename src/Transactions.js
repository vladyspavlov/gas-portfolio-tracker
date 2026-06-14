// Transaction history → cost-basis P&L.
//
// The hourly snapshot only records CURRENT position state, so it can show NAV but not profit/loss
// (no cost basis). This module reconstructs the cost basis from on-chain capital movements:
//
//   P&L(t) = NAV(t) − Net Capital Invested(≤ t)
//
// A "capital flow" is a base-asset ERC-20 Transfer between the wallet and a RECOGNIZED protocol
// contract. Direction sets the sign (matches NAV's signed convention exactly):
//   • token leaves wallet → protocol (supply / repay)   ⇒ direction 'out', flow POSITIVE (capital in)
//   • token enters wallet ← protocol (borrow / withdraw) ⇒ direction 'in',  flow NEGATIVE (returned)
//
// Source: Infura eth_getLogs for ERC-20 Transfer events, filtered by the indexed from/to topic =
// wallet (Infura does NOT support Alchemy's getAssetTransfers). Price-at-tx: CoinGecko KEYLESS
// public API (no key, no x-cg-* header) daily close. Stablecoins are pegged at $1 (no call).
//
// Runs OUTSIDE snapshotPortfolio() via its own entry syncTransactions() on a separate ~6h trigger,
// so the hourly snapshot stays < 15s. Writes the literal-only, append-only Transactions tab
// (same append-cursor constraint as the other data tabs — Utils.lastDataRow guard). Idempotent:
// rows are keyed by (tx_hash, log_index); re-runs never duplicate. Resumable: per-chain scan
// progress is persisted in Script Properties, so a backfill that nears the GAS time limit just
// continues on the next run.

const Txns = {
  // keccak256("Transfer(address,address,uint256)") — topic[0] of every ERC-20 Transfer
  TRANSFER_SIG: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  CG_BASE:      'https://api.coingecko.com/api/v3',  // keyless public API base

  // Scan tuning. getLogs is topic-filtered (tiny result set) so the real risk is the 10s query
  // timeout on a wide range — handled by adaptive halving down to MIN_CHUNK. MAX_CHUNKS_PER_RUN
  // bounds execution time; the rest resumes next run.
  // getLogs is topic-filtered to the wallet → tiny result sets, so the binding limit is request
  // RATE (429), not result size. Large chunks mean FEWER requests covering MORE blocks per run —
  // the adaptive-halving below still backs off if a provider caps the block range or result count.
  DEFAULT_CHUNK:       2000000,
  MIN_CHUNK:           2000,
  MAX_CHUNKS_PER_RUN:  60,
  CG_THROTTLE_MS:      2600,   // keyless is IP-throttled; space distinct price calls out
  CG_RETRIES:          3,      // best-effort only — GAS shares throttled IPs, so retries rarely win
  CG_BACKOFF_MS:       2500,   // 429 backoff base (×2^i: 2.5s, 5s) — bounded so a run can't stall out

  // RPC (Infura) also IP/credit rate-limits eth_getLogs with HTTP 429. A 429 is transient — back
  // off and retry the SAME block range rather than aborting the chain. Distinct from the "more than
  // 10000 results" / "query timeout" errors (those mean the range is too WIDE → halve it instead).
  RPC_RETRIES:         5,      // attempts per range on 429 before giving up (resume next run)
  RPC_BACKOFF_MS:      2000,   // ×2^i exponential: 2s, 4s, 8s, 16s
  RPC_THROTTLE_MS:     250,    // gentle pacing between successful chunks to avoid bursts

  // Base-asset ERC-20s treated as "capital", keyed by LOWERCASE contract address.
  // peg:1 → stablecoin, valued at $1 (no CoinGecko call). coingeckoId → keyless /history id.
  TOKENS: {
    arbitrum: {
      '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH',   decimals: 18, coingeckoId: 'weth',            peg: null },
      '0x5979d7b546e38e414f7e9822514be443a4800529': { symbol: 'WSTETH', decimals: 18, coingeckoId: 'wrapped-steth',   peg: null },
      '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': { symbol: 'WBTC',   decimals: 8,  coingeckoId: 'wrapped-bitcoin', peg: null },
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC',   decimals: 6,  coingeckoId: null,             peg: 1 },
      '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': { symbol: 'USDC.E', decimals: 6,  coingeckoId: null,             peg: 1 },
      '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT',   decimals: 6,  coingeckoId: null,             peg: 1 }
    },
    base: {
      '0x4200000000000000000000000000000000000006': { symbol: 'WETH',   decimals: 18, coingeckoId: 'weth',                peg: null },
      '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': { symbol: 'WSTETH', decimals: 18, coingeckoId: 'wrapped-steth',       peg: null },
      '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { symbol: 'CBBTC',  decimals: 8,  coingeckoId: 'coinbase-wrapped-btc', peg: null },
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC',   decimals: 6,  coingeckoId: null,                  peg: 1 }
    }
  },

  // Recognized protocol counterparties, keyed by LOWERCASE address → label. A Transfer counts as a
  // capital flow only when the OTHER side is one of these. Adding a venue = add its contract(s) here.
  // A chain whose map is EMPTY is skipped entirely (no wasted scanning) — see syncTransactions().
  PROTOCOLS: {
    arbitrum: {
      '0x794a61358d6845594f94dc1db02a252b5b4814ad': 'aave',  // Aave v3 Pool      (verified — same as Aave.AAVE_POOL_ARB)
      '0xf89e77e8dc11691c9e8757e84aafbcd8a67d7a55': 'gmx',   // GMX v2 DepositVault    (deposits land here)
      '0x0628d46b5d145f183adb6ef1f2c97ed1c4701c55': 'gmx'    // GMX v2 WithdrawalVault (withdrawals leave here)
    },
    base: {
      // Fluid Liquidity layer — deterministic address, identical on every chain (verified vs the
      // Fluid deployments file). It custodies all funds. NOTE: a deposit may route the underlying
      // through your per-market Fluid VAULT contract instead of landing directly here — if Fluid
      // rows are missing after the first sync, check a Fluid deposit tx's token-Transfer `To` on
      // Basescan and add that vault address below with label 'fluid'.
      '0x52aa899454998be5b000ad077a46bbe360f4e497': 'fluid'
    }
  },

  // Config keys for the per-chain RPC endpoint (built like Aave.buildAccountDataRequest) and wallet.
  CHAIN_RPC:    { arbitrum: ['RPC_ARB_URL', 'RPC_ARB_KEY'], base: ['RPC_BASE_URL', 'RPC_BASE_KEY'] },
  CHAIN_WALLET: { arbitrum: 'ARB_ADDRESS',                  base: 'BASE_ADDRESS' },

  // Short chain code for the TX_START_BLOCK_<CODE> Config key and TX_SCANNED_<CODE> Script Property.
  // Must match the module's existing convention (ARB, not ARBITRUM — same as RPC_ARB_*/ARB_ADDRESS)
  // and the docs. NEVER derive these from chain.toUpperCase() (that yields ARBITRUM and silently
  // reads an empty start block → scans from genesis).
  CHAIN_CODE:   { arbitrum: 'ARB',                          base: 'BASE' },

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────
  _rpcUrl: function(config, chain) {
    const keys = Txns.CHAIN_RPC[chain];
    const base = config[keys[0]], secret = config[keys[1]];
    if (!base || !secret) return null;
    return base.replace(/\/?$/, '/') + secret;
  },

  // address → 32-byte topic (left-padded), lowercase
  _paddedTopic: function(addr) {
    return '0x' + '000000000000000000000000' + String(addr).replace(/^0x/i, '').toLowerCase();
  },

  // 32-byte topic → 20-byte address, lowercase
  _topicToAddress: function(topic) {
    return '0x' + String(topic).slice(-40).toLowerCase();
  },

  _hexToInt: function(hex) {
    return Number(BigInt(hex));
  },

  // JS Date (UTC) → "dd-mm-yyyy" for CoinGecko /history
  _dateKey: function(date) {
    const dd = ('0' + date.getUTCDate()).slice(-2);
    const mm = ('0' + (date.getUTCMonth() + 1)).slice(-2);
    return dd + '-' + mm + '-' + date.getUTCFullYear();
  },

  // ── request builders (UrlFetchApp objects) ───────────────────────────────────────────────────
  buildBlockNumberRequest: function(config, chain) {
    return { url: Txns._rpcUrl(config, chain), method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      muteHttpExceptions: true };
  },

  // direction 'out' → wallet is sender (topic1); 'in' → wallet is receiver (topic2)
  buildLogsRequest: function(config, chain, fromBlock, toBlock, direction) {
    const padded = Txns._paddedTopic(config[Txns.CHAIN_WALLET[chain]]);
    const topics = direction === 'out'
      ? [Txns.TRANSFER_SIG, padded, null]
      : [Txns.TRANSFER_SIG, null, padded];
    return { url: Txns._rpcUrl(config, chain), method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_getLogs', params: [{
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock:   '0x' + toBlock.toString(16),
        topics:    topics   // no `address` → all token contracts; filtered to TOKENS[chain] in parse
      }] }),
      muteHttpExceptions: true };
  },

  buildBlockTimeRequest: function(config, chain, blockHex) {
    return { url: Txns._rpcUrl(config, chain), method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'eth_getBlockByNumber',
        params: [blockHex, false] }),
      muteHttpExceptions: true };
  },

  buildPriceRequest: function(coingeckoId, dateKey) {
    return { url: Txns.CG_BASE + '/coins/' + coingeckoId + '/history?date=' + dateKey + '&localization=false',
      method: 'get', muteHttpExceptions: true };
  },

  // ── parsers ──────────────────────────────────────────────────────────────────────────────────
  // Throws on RPC error so the scan loop can detect "more than 10000 results" / "query timeout"
  // and adaptively halve the block range. Returns EVERY base-asset transfer touching the wallet
  // (token filter only — no protocol filter), so the ledger captures exchange funding, bridges and
  // swaps too. Each transfer is labelled with its recognized protocol or 'external' so rows can be
  // filtered when computing P&L.
  parseLogs: function(response, chain, direction) {
    if (response.getResponseCode() !== 200) throw new Error('getLogs HTTP ' + response.getResponseCode());
    const body = JSON.parse(response.getContentText());
    if (body.error) throw new Error('getLogs: ' + (body.error.message || JSON.stringify(body.error)));

    const tokens    = Txns.TOKENS[chain]    || {};
    const protocols = Txns.PROTOCOLS[chain] || {};
    const out = [];
    (body.result || []).forEach(function(log) {
      const tokenAddr = String(log.address).toLowerCase();
      const token = tokens[tokenAddr];
      if (!token) return;   // base assets only — ignores random/unknown ERC-20s

      const cpTopic      = direction === 'out' ? log.topics[2] : log.topics[1];
      const counterparty = Txns._topicToAddress(cpTopic);
      const protocol     = protocols[counterparty] || 'external';   // label, don't filter

      out.push({
        chain:       chain,
        protocol:    protocol,
        counterparty: counterparty,
        token:       token.symbol,
        coingeckoId: token.coingeckoId,
        peg:         token.peg,
        direction:   direction,
        amount:      Utils.hexToDecimal(log.data, token.decimals),
        txHash:      String(log.transactionHash).toLowerCase(),
        logIndex:    Txns._hexToInt(log.logIndex),
        blockNumber: Txns._hexToInt(log.blockNumber),
        blockHex:    log.blockNumber
      });
    });
    return out;
  },

  parseBlockTime: function(response) {
    if (response.getResponseCode() !== 200) return null;
    const body = JSON.parse(response.getContentText());
    if (body.error || !body.result || !body.result.timestamp) return null;
    return new Date(Txns._hexToInt(body.result.timestamp) * 1000);
  },

  // CoinGecko keyless /history → USD daily close, or throws (so Utils.retry backs off on 429)
  parsePrice: function(response) {
    const code = response.getResponseCode();
    if (code === 429) throw new Error('CoinGecko 429 (rate limited)');
    if (code !== 200) throw new Error('CoinGecko HTTP ' + code);
    const body = JSON.parse(response.getContentText());
    const usd = body && body.market_data && body.market_data.current_price &&
                body.market_data.current_price.usd;
    if (usd == null) throw new Error('CoinGecko: no price in response');
    return Number(usd);
  },

  // ── orchestrator (manual entry + ~6h trigger) ────────────────────────────────────────────────
  // Idempotent + resumable. Advances the persisted scan cursor ONLY after rows are written, so any
  // failure before the append just re-scans next run (dedup prevents duplicates — no data loss).
  syncTransactions: function() {
    const config = Config.getAll();
    if ((config.TX_SYNC_ENABLED || '').toLowerCase() !== 'true') {
      Logger.log('syncTransactions skipped: TX_SYNC_ENABLED != true');
      return;
    }

    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Transactions');
    if (!sheet) throw new Error('Transactions tab not found — run initTransactionsTab() first');

    // Existing (tx_hash, log_index) keys for idempotency (cols K, L)
    const seen     = {};
    const lastRow  = Utils.lastDataRow(sheet);
    if (lastRow >= 2) {
      const keys = sheet.getRange(2, 11, lastRow - 1, 2).getValues();  // K=tx_hash, L=log_index
      keys.forEach(function(r) { seen[String(r[0]).toLowerCase() + '#' + r[1]] = true; });
    }

    const props = PropertiesService.getScriptProperties();
    const newScannedByChain = {};   // chain → highest fully-scanned block this run (persist at end)
    let   transfers = [];

    Object.keys(Txns.PROTOCOLS).forEach(function(chain) {
      // Skip a chain with no recognized counterparties (e.g. Base before Fluid's address is added)
      if (Object.keys(Txns.PROTOCOLS[chain]).length === 0) {
        Logger.log('syncTransactions: ' + chain + ' has no PROTOCOLS entries — skipped');
        return;
      }
      const rpcUrl = Txns._rpcUrl(config, chain);
      const wallet = config[Txns.CHAIN_WALLET[chain]];
      if (!rpcUrl || !wallet) {
        Logger.log('syncTransactions: ' + chain + ' missing RPC/wallet config — skipped');
        return;
      }

      // latest head — also rate-limited by Infura, so retry on 429 and skip the chain (don't crash
      // the whole run) if it never returns a usable result. A null .result is what previously threw
      // "Cannot convert undefined to a BigInt" downstream.
      let latest;
      try {
        latest = Utils.retry(function() {
          const headReq  = Txns.buildBlockNumberRequest(config, chain);
          const headResp = UrlFetchApp.fetch(headReq.url, headReq);
          if (headResp.getResponseCode() === 429) throw new Error('eth_blockNumber HTTP 429');
          const result = JSON.parse(headResp.getContentText()).result;
          if (!result) throw new Error('eth_blockNumber: no result (HTTP ' + headResp.getResponseCode() + ')');
          return Txns._hexToInt(result);
        }, Txns.RPC_RETRIES, Txns.RPC_BACKOFF_MS, 2);
      } catch (e) {
        Logger.log('syncTransactions: ' + chain + ' head block unavailable — skipped this run: ' + e.message);
        return;
      }

      const code       = Txns.CHAIN_CODE[chain];
      const scannedKey = 'TX_SCANNED_' + code;
      const startCfg   = Number(config['TX_START_BLOCK_' + code] || 0);
      const scanned    = Number(props.getProperty(scannedKey) || 0);
      let   from       = Math.max(scanned + 1, startCfg);
      let   chunk      = Txns.DEFAULT_CHUNK;
      let   chunks     = 0;
      let   highest    = scanned;

      while (from <= latest && chunks < Txns.MAX_CHUNKS_PER_RUN) {
        const to = Math.min(from + chunk - 1, latest);

        // Fetch with exponential backoff on HTTP 429 (transient rate limit). Retry the SAME range;
        // only a real provider/network failure or exhausted retries falls through to the catch.
        let resp;
        try {
          resp = Utils.retry(function() {
            const r = UrlFetchApp.fetchAll([
              Txns.buildLogsRequest(config, chain, from, to, 'out'),
              Txns.buildLogsRequest(config, chain, from, to, 'in')
            ]);
            if (r[0].getResponseCode() === 429 || r[1].getResponseCode() === 429) {
              throw new Error('getLogs HTTP 429 (rate limited)');
            }
            return r;
          }, Txns.RPC_RETRIES, Txns.RPC_BACKOFF_MS, 2);
        } catch (e) {
          // 429 survived all backoff attempts → stop this chain; cursor stays at `highest`,
          // so the next scheduled run resumes from here (no data loss, no duplicates).
          Logger.log('syncTransactions: ' + chain + ' rate-limited at block ' + from +
                     ' after ' + Txns.RPC_RETRIES + ' retries — will resume next run: ' + e.message);
          break;
        }

        // Parse (throws on JSON-RPC errors like "more than 10000 results" — those mean too WIDE).
        try {
          transfers = transfers
            .concat(Txns.parseLogs(resp[0], chain, 'out'))
            .concat(Txns.parseLogs(resp[1], chain, 'in'));
          highest = to;
          from    = to + 1;
          chunks++;
          Utilities.sleep(Txns.RPC_THROTTLE_MS);  // pace successive chunks to avoid bursts
        } catch (e) {
          // Range too wide (result cap, timeout, or a provider block-range limit) → halve and retry
          // the SAME `from`; otherwise stop this chain here.
          if (/more than 10000|query timeout|10 second|block range|limited to|too large|exceed/i.test(e.message) && chunk > Txns.MIN_CHUNK) {
            chunk = Math.max(Txns.MIN_CHUNK, Math.floor(chunk / 2));
            Logger.log('syncTransactions: ' + chain + ' range narrowed to ' + chunk + ' blocks');
            continue;
          }
          Logger.log('syncTransactions: ' + chain + ' getLogs stopped at block ' + from + ': ' + e.message);
          break;
        }
      }
      newScannedByChain[chain] = highest;
    });

    // Drop already-written and intra-run duplicates
    const fresh = [];
    transfers.forEach(function(t) {
      const key = t.txHash + '#' + t.logIndex;
      if (seen[key]) return;
      seen[key] = true;
      fresh.push(t);
    });

    if (fresh.length === 0) {
      Object.keys(newScannedByChain).forEach(function(c) {
        props.setProperty('TX_SCANNED_' + Txns.CHAIN_CODE[c], String(newScannedByChain[c]));
      });
      Logger.log('syncTransactions: no new transfers (scan cursor advanced)');
      return;
    }

    // Block timestamps — one eth_getBlockByNumber per UNIQUE (chain, block)
    const blockReqs = [];
    const blockKeys = [];
    const blockSeen = {};
    fresh.forEach(function(t) {
      const bk = t.chain + ':' + t.blockHex;
      if (blockSeen[bk]) return;
      blockSeen[bk] = true;
      blockKeys.push(bk);
      blockReqs.push(Txns.buildBlockTimeRequest(config, t.chain, t.blockHex));
    });
    const blockResps = UrlFetchApp.fetchAll(blockReqs);
    const blockTime  = {};
    blockResps.forEach(function(r, i) { blockTime[blockKeys[i]] = Txns.parseBlockTime(r); });

    // Prices — daily close, deduped by (coingeckoId, date); stables pegged at $1
    const priceCache = {};   // "id|dd-mm-yyyy" → number
    fresh.forEach(function(t) {
      const date = blockTime[t.chain + ':' + t.blockHex];
      if (t.peg != null || !t.coingeckoId || !date) return;
      const dk  = Txns._dateKey(date);
      const key = t.coingeckoId + '|' + dk;
      if (priceCache.hasOwnProperty(key)) return;
      try {
        const priceReq = Txns.buildPriceRequest(t.coingeckoId, dk);
        // Exponential backoff on 429 (keyless CoinGecko is IP-throttled — docs recommend this).
        const price = Utils.retry(function() {
          return Txns.parsePrice(UrlFetchApp.fetch(priceReq.url, priceReq));
        }, Txns.CG_RETRIES, Txns.CG_BACKOFF_MS, 2);
        priceCache[key] = price;
      } catch (e) {
        priceCache[key] = null;
        Logger.log('syncTransactions: price failed ' + key + ': ' + e.message);
      }
      Utilities.sleep(Txns.CG_THROTTLE_MS);  // respect keyless IP throttle between distinct calls
    });

    // Build 13-col rows. price_usd_at_tx (H) is the SINGLE editable source of truth: a number when
    // known (stable peg or CoinGecko), '' when CoinGecko failed (an obvious "fill me in" gap you can
    // type into). value_usd (I) and capital_flow_signed_usd (J) are SAME-ROW formulas of H, so a
    // manual price entry flows straight through to NAV/P&L with no re-run. Append-safe: only column
    // A is scanned by lastDataRow, and these are per-row (not column-wide) formulas — no auto-extend.
    const writeAt = Utils.lastDataRow(sheet) + 1;
    const rows = fresh.map(function(t, i) {
      const r     = writeAt + i;   // absolute sheet row → build the H/G/F references for this row
      const date  = blockTime[t.chain + ':' + t.blockHex];
      const price = t.peg != null ? t.peg
                  : (t.coingeckoId && date ? priceCache[t.coingeckoId + '|' + Txns._dateKey(date)] : null);
      return [
        date || '', t.chain, t.protocol, t.counterparty, t.token, t.direction,
        t.amount,
        price != null ? price : '',                                        // H price_usd_at_tx
        '=IF($H' + r + '="","",$G' + r + '*$H' + r + ')',                   // I value_usd = amount*price
        '=IF($I' + r + '="","",$I' + r + '*IF($F' + r + '="in",1,-1))',     // J signed: in=+ (received), out=−
        t.txHash, t.logIndex, t.blockNumber
      ];
    });

    // Append (lastDataRow guard, never appendRow). setValues enters the leading-"=" strings as
    // formulas; H stays a literal you can overwrite.
    sheet.getRange(writeAt, 1, rows.length, 13).setValues(rows);

    // Advance the scan cursor only now that rows are safely written
    Object.keys(newScannedByChain).forEach(function(c) {
      props.setProperty('TX_SCANNED_' + Txns.CHAIN_CODE[c], String(newScannedByChain[c]));
    });

    Logger.log('syncTransactions: wrote ' + rows.length + ' new transfer rows');
  }
};

// Top-level trigger entry (set a ~6h time-driven trigger on THIS function in the GAS Triggers UI).
function syncTransactions() {
  Txns.syncTransactions();
}
