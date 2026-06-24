'use strict';

// StockPilot production base URL. Override locally with STOCKPILOT_BASE_URL
// (e.g. a preview deployment) when developing the app.
const BASE_URL = process.env.STOCKPILOT_BASE_URL || 'https://stockpilotusa.com';

module.exports = { BASE_URL };
