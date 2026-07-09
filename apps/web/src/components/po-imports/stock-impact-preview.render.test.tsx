// @vitest-environment happy-dom
//
// Display regression for the honest import preview: at import time we do NOT
// know which charter/rack the incoming units land in (that's chosen at
// receiving), so the preview must NOT show a guessed "placement current /
// placement after". It shows only (a) a WORDED "+N units" (not a bare "Δ"
// triangle) and (b) the SKU total before → after, which is true regardless of
// where the units eventually land.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StockImpactPreview, type PreviewItem } from './stock-impact-preview';

import type { PoImportLineRow } from '@/server/services/po-imports';

const ITEM: PreviewItem = {
  id: 'item-lenovo',
  sku: 'SP-G69UU-05H',
  name: 'Lenovo 300e',
  quantityOnHand: 100, // this placement's own qty
};

function line(id: string, overrides: Partial<PoImportLineRow> = {}): PoImportLineRow {
  return {
    id,
    line_number: 5,
    description: 'Student Supplies - Chromebook 511',
    qty_ordered_original: 100,
    uom_original: 'ea',
    line_total: 46995,
    item_id: 'item-lenovo',
    line_type: 'inventory',
    vendor_item_number: null,
    ...overrides,
  } as unknown as PoImportLineRow;
}

describe('StockImpactPreview — honest display (no guessed placement)', () => {
  // SKU total across all placements is 281; this line adds 100 → 381.
  const skuTotalBySku = new Map<string, number>([['SP-G69UU-05H', 281]]);

  it('shows the worded "+100 units" adding column and the 281 → 381 SKU total', () => {
    render(
      <StockImpactPreview
        lines={[line('l5')]}
        overrides={{}}
        items={[ITEM]}
        skuTotalBySku={skuTotalBySku}
      />,
    );
    // Worded delta, not a bare triangle.
    expect(screen.getByText(/\+100 units/)).toBeTruthy();
    // Honest SKU total before → after.
    expect(screen.getByText(/281/)).toBeTruthy();
    expect(screen.getByText(/381/)).toBeTruthy();
  });

  it('does NOT render the guessed placement columns or the raw Δ symbol', () => {
    const { container } = render(
      <StockImpactPreview
        lines={[line('l5')]}
        overrides={{}}
        items={[ITEM]}
        skuTotalBySku={skuTotalBySku}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).not.toContain('Placement current');
    expect(text).not.toContain('Placement after');
    // The bare math triangle is gone in favor of the word "Adding".
    expect(text).not.toContain('Δ');
    expect(screen.getByText('Adding')).toBeTruthy();
    // And it must NOT show a fabricated single-placement "100 → 200" for this
    // line (that was the guess). The projected placement value 200 must not
    // appear anywhere.
    expect(text).not.toContain('200');
  });
});
