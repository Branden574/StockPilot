import { describe, expect, it } from 'vitest';

import * as core from '../index';

/**
 * The name an order line shows for its item, on the web order page and the
 * phone order screen. The web said "Deleted item" and the phone "Unknown
 * item" for the same row, and neither was true: order_request_lines.item_id
 * is ON DELETE RESTRICT, so a line's item row always exists, and a missing
 * item embed means the reader's inventory_items policy hid it.
 */
describe('orderLineItemName', () => {
  it('is exported from core, with the one label both platforms show', () => {
    expect(core.ORDER_LINE_HIDDEN_ITEM_NAME).toBe("An item you can't see");
    expect(typeof core.orderLineItemName).toBe('function');
  });

  it('an item the reader can read is named as itself', () => {
    expect(core.orderLineItemName({ name: 'Crayons (24)' })).toBe('Crayons (24)');
  });

  it('a missing embed (the reader cannot read the item) says so, never deleted or unknown', () => {
    for (const hidden of [null, undefined]) {
      const label = core.orderLineItemName(hidden);
      expect(label).toBe("An item you can't see");
      expect(label).not.toMatch(/deleted|unknown/i);
    }
  });
});
