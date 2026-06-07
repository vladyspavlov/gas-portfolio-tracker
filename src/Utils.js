const Utils = {
  // uint256 hex string → JS Number with given decimal places
  hexToDecimal: function(hexStr, decimals) {
    const raw = BigInt(hexStr);
    const divisor = BigInt(10 ** decimals);
    const whole = raw / divisor;
    const remainder = raw % divisor;
    return Number(whole) + Number(remainder) / (10 ** decimals);
  },

  // Retry fn up to `times` attempts with `delayMs` between each
  retry: function(fn, times, delayMs) {
    let lastError;
    for (let i = 0; i < times; i++) {
      try {
        return fn();
      } catch (e) {
        lastError = e;
        if (i < times - 1) Utilities.sleep(delayMs);
      }
    }
    throw lastError;
  },

  // Wrap fn; return null instead of throwing
  safeNull: function(fn) {
    try {
      return fn();
    } catch (e) {
      return null;
    }
  },

  // Last row in column A that has actual data — ignores formula-only rows that return ""
  // Use this instead of sheet.getLastRow() when other columns have ARRAYFORMULA
  lastDataRow: function(sheet) {
    var vals = sheet.getRange(1, 1, sheet.getMaxRows(), 1).getValues();
    for (var i = vals.length - 1; i >= 0; i--) {
      if (vals[i][0] !== '') return i + 1;
    }
    return 0;
  },

  logger: {
    log: function(msg) {
      Logger.log(msg);
    }
  }
};
