'use strict';

const { BASE_URL } = require('../constants');

/** Find an inventory item by SKU or name — useful as a step before an action. */
module.exports = {
  key: 'find_item',
  noun: 'Item',
  display: {
    label: 'Find Item',
    description: 'Finds an inventory item by SKU or name.',
  },
  operation: {
    inputFields: [
      { key: 'search', label: 'SKU or name', type: 'string', required: true },
    ],
    perform: async (z, bundle) => {
      const res = await z.request({
        url: `${BASE_URL}/api/public/v1/items`,
        params: { search: bundle.inputData.search, limit: 5 },
      });
      return (res.data && res.data.data) || [];
    },
    sample: {
      id: 'itm_123',
      sku: 'SP-1234',
      name: 'Foldable Tote',
      status: 'active',
      quantity_on_hand: 42,
      reorder_point: 10,
      unit_cost: 5.0,
    },
  },
};
