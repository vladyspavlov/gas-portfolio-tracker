const Config = {
  getAll: function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Config');
    if (!sheet) throw new Error('Config tab not found in spreadsheet');

    const rows = sheet.getDataRange().getValues();
    const config = {};

    for (let i = 0; i < rows.length; i++) {
      const key = String(rows[i][0]).trim();
      const val = String(rows[i][1]).trim();
      if (key) config[key] = val;
    }

    // Overlay secrets from PropertiesService (never stored in Config tab)
    const props = PropertiesService.getScriptProperties();
    const secretKeys = ['RPC_ARB_KEY', 'RPC_BASE_KEY', 'GRAPH_API_KEY', 'COINGECKO_KEY'];
    for (const k of secretKeys) {
      const v = props.getProperty(k);
      if (v) config[k] = v;
    }

    return config;
  }
};
