import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StagingTable, type StagingTableProps } from './staging-table';

// StagingTable reads the URL via next/navigation for its type filter.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// ---------------------------------------------------------------------------
// The incident: the Source column shows an EM DASH for every holding that did
// not arrive on a purchase order, so nobody could tell who moved stock, when,
// from where, or why — the controller rebuilt the story in SQL. Each staging
// row now opens that item's movement history.
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      itemId: 'item-a',
      itemName: 'Science Dimensions Earth & Space Science',
      itemSku: 'SP-0WK2L-LY1',
      rows: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
    }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeRow(
  itemId: string,
  name: string,
  over: Partial<StagingTableProps['rows'][number]> = {},
): StagingTableProps['rows'][number] {
  return {
    itemId,
    name,
    sku: `SKU-${itemId}`,
    itemType: 'book',
    warehouseId: 'wh1',
    sourceLocationId: 'stg-1',
    sourceKind: 'staging',
    quantity: 10,
    sourceReceiptId: null,
    sourcePoNumber: null,
    receiptNumber: null,
    receivedAt: null,
    ageDays: 30,
    bookStorage: null,
    ...over,
  };
}

function renderTable(props: Partial<StagingTableProps> = {}) {
  return render(
    <StagingTable
      rows={[
        makeRow('item-a', 'Science Dimensions Earth & Space Science'),
        makeRow('item-b', 'Other Book', { sourceLocationId: 'stg-2' }),
      ]}
      destinationsMap={{ wh1: [{ id: 'r1', name: 'Rack 1', kind: 'rack', rackNumber: '1', rackRow: null, crateColor: null, crateNumber: null }] }}
      warehouseNames={{ wh1: 'WH One' }}
      canPlace
      activeItemType="all"
      {...props}
    />,
  );
}

describe('StagingTable history entry point', () => {
  it('opens the history for the row that was clicked, not its neighbour', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(
      screen.getByRole('button', {
        name: 'View history for Science Dimensions Earth & Space Science',
      }),
    );

    // REWRITTEN 2026-07-22 (D2): the dialog now ALSO asks
    // /api/v1/items/lookup which other item records share this SKU, because a
    // history is per item RECORD and its header may no longer claim to be
    // showing every movement for the SKU. So this asserts the history call
    // itself rather than "exactly one fetch happened" — the property under
    // test (the clicked row's item is the one read) is unchanged and is now
    // asserted more precisely.
    const historyCalls = () =>
      fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/history'));
    await waitFor(() => expect(historyCalls()).toHaveLength(1));
    expect(historyCalls()[0]).toContain('/api/v1/items/item-a/history');
    expect(historyCalls()[0]).not.toContain('item-b');
    expect(await screen.findByText('Movement history')).toBeInTheDocument();
  });

  it('offers history even to a user who cannot place stock', async () => {
    // History answers "who moved this and why" — that question is not gated on
    // the transfer permission, and hiding it would leave a read-only viewer
    // with only the em dash they complained about.
    renderTable({ canPlace: false });

    expect(
      screen.getByRole('button', { name: 'View history for Other Book' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Place' })).not.toBeInTheDocument();
  });

  it('still exposes history on a row with no PO attribution at all', async () => {
    const user = userEvent.setup();
    render(
      <StagingTable
        // The exact shape that renders an em dash in Source / Received: a
        // manual add that never touched a purchase order.
        rows={[makeRow('item-a', 'Manually added book')]}
        destinationsMap={{}}
        warehouseNames={{ wh1: 'WH One' }}
        canPlace={false}
        activeItemType="all"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'View history for Manually added book' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(await screen.findByText('Movement history')).toBeInTheDocument();
  });
});
