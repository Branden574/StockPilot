'use strict';

const { BASE_URL } = require('./constants');

/**
 * API-key auth. The user pastes a StockPilot key (sk_live_…) created under
 * Settings → Integrations → API keys with the scopes their Zaps need:
 *   - `webhooks:manage`  → required for every trigger (REST-hook subscribe)
 *   - `inventory:read`   → "Find item" search + low-stock trigger samples
 *   - `orders:read` / `purchase_orders:read` → order/PO trigger samples
 *
 * We store nothing but the key; StockPilot persists only its hash.
 */
const test = async (z, bundle) => {
  // A cheap authenticated call that proves the key is valid + the org has API
  // access. 401/403 here surfaces as a clear connection error in Zapier.
  const response = await z.request({
    url: `${BASE_URL}/api/public/v1/items`,
    params: { limit: 1 },
  });
  return response.data;
};

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'api_key',
      label: 'StockPilot API key',
      required: true,
      type: 'password',
      helpText:
        'Create a key in StockPilot → Settings → Integrations → API keys. Grant **Manage automation webhooks** (required) plus the read scopes for the data your Zaps use.',
    },
  ],
  test,
  // Shown on the connected-account chip in Zapier — keep the raw secret key OUT
  // of it (the chip is visible to every collaborator on the Zapier account).
  connectionLabel: 'StockPilot',
};
