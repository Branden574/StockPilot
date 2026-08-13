import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { StagingTable, type StagingTableProps } from './staging-table';

// StagingTable reads the URL via next/navigation for its type filter.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function makeRow(itemId: string, name: string, sourceLocationId: string): StagingTableProps['rows'][number] {
  return {
    itemId,
    name,
    sku: `SKU-${itemId}`,
    itemType: 'book',
    warehouseId: 'wh1',
    sourceLocationId,
    sourceKind: 'staging',
    quantity: 5,
    sourceReceiptId: null,
    sourcePoNumber: null,
    receiptNumber: null,
    receivedAt: null,
    ageDays: null,
    bookStorage: null,
  };
}

describe('StagingTable selection', () => {
  // Regression: the bulk-place Set was keyed by sourceLocationId, but a staging
  // area holds many items (shared location_id) — so checking one row selected
  // every row in that location. Selection is now keyed by itemId+location.
  it('selecting one row does not select other rows sharing a staging location', () => {
    render(
      <StagingTable
        // Two DIFFERENT items in the SAME staging location.
        rows={[makeRow('item-a', 'Book A', 'stg-1'), makeRow('item-b', 'Book B', 'stg-1')]}
        destinationsMap={{ wh1: [{ id: 'r1', name: 'Rack 1', kind: 'rack', rackNumber: '1', rackRow: null, crateColor: null, crateNumber: null }] }}
        warehouseNames={{ wh1: 'WH One' }}
        canPlace
        activeItemType="all"
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Book A' }));

    // Only the clicked row is selected — not its neighbour in the same location.
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Book A' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('checkbox', { name: 'Select Book B' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('select-all still selects every placeable row', () => {
    render(
      <StagingTable
        rows={[makeRow('item-a', 'Book A', 'stg-1'), makeRow('item-b', 'Book B', 'stg-1')]}
        destinationsMap={{ wh1: [{ id: 'r1', name: 'Rack 1', kind: 'rack', rackNumber: '1', rackRow: null, crateColor: null, crateNumber: null }] }}
        warehouseNames={{ wh1: 'WH One' }}
        canPlace
        activeItemType="all"
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all placeable rows' }));

    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });
});
