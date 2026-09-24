import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Add-items sheet — WIRING PINS. The query plan is pure and tested in
 * add-order-items.test.ts, but the sheet applies the rest of the item filter
 * to the Supabase builder inline. These pins keep every predicate addLines
 * enforces on the picker, so the sheet never offers an item the server will
 * refuse.
 */

const sheet = readFileSync(path.resolve(__dirname, './add-order-items-sheet.tsx'), 'utf8');

describe('add-order-items-sheet.tsx — item query wiring', () => {
  it('offers only items addLines accepts', () => {
    // The order's warehouse, received stock, not deleted.
    expect(sheet).toContain(".eq('warehouse_id', warehouseId)");
    expect(sheet).toContain(".eq('awaiting_first_receipt', plan.awaitingFirstReceipt)");
    expect(sheet).toContain(".is('deleted_at', null)");
    // Rental items go out through Rentals; addLines refuses them (2026-09-24).
    expect(sheet).toContain(".eq('is_rental', false)");
  });
});
