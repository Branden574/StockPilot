import { describe, expect, it } from 'vitest';

import { classifyIntent, intentNudge } from './intent';

describe('classifyIntent', () => {
  it.each([
    // Order writes
    ['approve order abc', 'order_write'],
    ['deny this request', 'order_write'],
    ['cancel order 123', 'order_write'],
    ['yes, confirm', 'order_write'],
    ['go ahead', 'order_write'],

    // Order queries
    ['what orders are pending', 'order_query'],
    ['show me the order queue', 'order_query'],
    ['orders for sequoia elementary', 'order_query'],

    // Cost / value ranking
    ['lowest costing item', 'inventory_ranking'],
    ['cheapest items', 'inventory_ranking'],
    ['top 10 by quantity', 'inventory_ranking'],
    ['most expensive products', 'inventory_ranking'],
    ['priciest items', 'inventory_ranking'],
    ['sort by cost', 'inventory_ranking'],

    // Low stock
    ['what is running low', 'low_stock'],
    ['out of stock items', 'low_stock'],
    ['what do we need to reorder', 'low_stock'],

    // Inventory count
    ['how many items do we have', 'inventory_count'],
    ['total inventory count', 'inventory_count'],

    // Value
    ['total inventory value', 'value_question'],
    ['how much is our stock worth', 'value_question'],

    // Time window
    ['what was received yesterday', 'recent_activity'],
    ['movements today', 'recent_activity'],
    ['this week', 'recent_activity'],

    // Warehouse / category / supplier
    ['which warehouse has the most', 'warehouse_query'],
    ['biggest category', 'category_query'],
    ['who supplies this', 'supplier_query'],

    // Forecasting
    ['when will we run out', 'forecasting'],
    ['burn rate', 'forecasting'],

    // Semantic
    ['something like a cleaning supply', 'semantic_search'],

    // Lookup
    ['do we have chromebooks', 'inventory_lookup'],
    ['find SKU LAP-001', 'inventory_lookup'],

    // Book import / ISBN
    ['import these ISBNs 9780000000001 9780000000002', 'book_import'],
    ['what book is ISBN 9780000000001', 'isbn_lookup'],

    // General
    ['hi', 'general'],
    ['hello there', 'general'],
  ])('classifies %j → %s', (msg, expected) => {
    expect(classifyIntent(msg)).toBe(expected);
  });

  it('returns "general" for empty input', () => {
    expect(classifyIntent('')).toBe('general');
    expect(classifyIntent('   ')).toBe('general');
  });
});

describe('intentNudge', () => {
  it('returns empty string for general', () => {
    expect(intentNudge('general')).toBe('');
  });

  it('returns a directive starting with INTENT HINT for known intents', () => {
    expect(intentNudge('inventory_ranking')).toMatch(/^INTENT HINT/);
    expect(intentNudge('order_write')).toMatch(/^INTENT HINT/);
    expect(intentNudge('low_stock')).toMatch(/^INTENT HINT/);
  });

  it('cost-ranking nudge mentions cost_asc / cost_desc', () => {
    const nudge = intentNudge('inventory_ranking');
    expect(nudge).toMatch(/cost_asc/);
    expect(nudge).toMatch(/cost_desc/);
  });
});
