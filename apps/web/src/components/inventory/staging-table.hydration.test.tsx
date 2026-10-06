/**
 * The Staging page server-renders its table, and the Received column prints
 * a relative time. A minute between the server render and hydration changes
 * the words and React throws error #418; the element holding it carries
 * suppressHydrationWarning.
 *
 * Its own file, so small fixes slice 3 (which edits the other staging-table
 * tests) rebases without touching it.
 */
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { StagingTable, type StagingTableProps } from './staging-table';

const T0 = Date.parse('2026-10-05T21:00:00.000Z');

const ROW: StagingTableProps['rows'][number] = {
  itemId: 'item-a',
  name: 'Science Dimensions Earth & Space Science',
  sku: 'SP-0WK2L-LY1',
  itemType: 'book',
  warehouseId: 'wh1',
  sourceLocationId: 'stg-1',
  sourceKind: 'staging',
  quantity: 10,
  sourceReceiptId: 'rcpt-1',
  sourcePoNumber: 'PO-1001',
  receiptNumber: 'RCV-1',
  receivedAt: new Date(T0 - 210_000).toISOString(),
  ageDays: 0,
  barcode: null,
  modelNumber: null,
  bookStorage: null,
};

describe('StagingTable hydrates across a clock tick', () => {
  it('the received time rendered on the server and hydrated a minute later: no hydration error', async () => {
    const run = await hydrateAcrossClockShift(
      () => (
        <StagingTable
          rows={[ROW]}
          destinationsMap={{ wh1: [] }}
          warehouseNames={{ wh1: 'WH One' }}
          canPlace
          activeItemType="all"
        />
      ),
      { serverNow: T0, browserNow: T0 + 60_000 },
    );
    try {
      expect(run.html).toContain('3 minutes ago');
      expect(run.errors).toEqual([]);
    } finally {
      run.unmount();
    }
  });
});
