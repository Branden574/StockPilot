import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseStagingItemFilter, STAGING_FILTER_UNPLACED_NOTE, type StagingFilterParse } from '@stockpilot/core';

// The Staging page's data path (F2-3): ?item / ?order -> the worklist read for
// those items (the cookie ignored), the order's number read BESIDE it, and the
// chip. Services are mocked; what each is asked is the assertion.

const calls = vi.hoisted(() => ({
  worklist: [] as unknown[],
  orderLink: [] as string[],
  cookieReads: 0,
  order: { state: 'ok', id: '', orderNumber: 'SO-000123' } as Record<string, unknown>,
  rows: [{ itemId: 'x' }] as unknown[],
  tableProps: null as Record<string, unknown> | null,
  orderFactoryFails: false,
}));

vi.mock('@/server/services/inventory', () => ({
  InventoryService: {
    forCurrentUser: async () => ({
      stagedWorklist: async (opts: unknown) => {
        calls.worklist.push(opts);
        return calls.rows;
      },
    }),
  },
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: { forCurrentUser: async () => ({ list: async () => [] }) },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: { forCurrentUser: async () => ({ listNames: async () => [] }) },
}));
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: {
    forCurrentUser: async () => {
      if (calls.orderFactoryFails) throw new Error('no context');
      return {
        orderLinkLabel: async (id: string) => {
          calls.orderLink.push(id);
          return calls.order;
        },
      };
    },
  },
}));
vi.mock('@/lib/warehouse-filter', () => ({
  getActiveWarehouseFilter: async () => {
    calls.cookieReads += 1;
    return 'wh-cookie';
  },
}));
vi.mock('@/components/inventory/staging-table', () => ({
  StagingTable: (props: Record<string, unknown>) => {
    calls.tableProps = props;
    return <div data-testid="staging-table" />;
  },
}));

import { StagingTableSection } from './staging-table-section';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const ORDER = '0f0f0f0f-0000-4000-8000-000000000001';

async function renderSection(filter: StagingFilterParse, itemType?: 'book' | 'non-book') {
  render(await StagingTableSection({ itemType, filter, canPlace: true, canMintDestination: true }));
}

beforeEach(() => {
  calls.worklist = [];
  calls.orderLink = [];
  calls.cookieReads = 0;
  calls.order = { state: 'ok', id: ORDER, orderNumber: 'SO-000123' };
  calls.rows = [{ itemId: 'x' }];
  calls.tableProps = null;
  calls.orderFactoryFails = false;
});

describe('Staging page data path: ?item and ?order (F2-3)', () => {
  it('seeds the worklist from ?item, ignores the warehouse cookie, and shows the chip', async () => {
    await renderSection(parseStagingItemFilter({ item: [A, B], order: ORDER }));
    expect(calls.worklist).toEqual([{ itemType: undefined, itemIds: [A, B] }]);
    expect(calls.cookieReads).toBe(0);
    expect(calls.orderLink).toEqual([ORDER]);
    expect(screen.getByTestId('staging-item-filter-headline')).toHaveTextContent('Showing items from SO-000123');
    expect(screen.getByTestId('staging-item-filter-show-all')).toHaveAttribute('href', '/dashboard/inventory/staging');
    expect(screen.getByTestId('staging-item-filter-back')).toHaveAttribute('href', `/dashboard/orders/${ORDER}`);
    expect(screen.getByTestId('staging-item-filter-back')).toHaveTextContent('Back to the order');
    expect(screen.getByTestId('staging-item-filter-note')).toHaveTextContent(STAGING_FILTER_UNPLACED_NOTE);
    expect(screen.getByTestId('staging-item-filter')).toHaveTextContent(
      /Showing items from SO-000123\s*·\s*Show all\s*·\s*Back to the order/,
    );
  });

  it('without ?item: the whole worklist in the active warehouse, as before, no chip, no order read', async () => {
    await renderSection(parseStagingItemFilter({ order: ORDER }), 'book');
    expect(calls.worklist).toEqual([{ itemType: 'book', warehouseId: 'wh-cookie' }]);
    expect(calls.cookieReads).toBe(1);
    expect(calls.orderLink).toEqual([]);
    expect(screen.queryByTestId('staging-item-filter')).toBeNull();
    expect(calls.tableProps).toMatchObject({ activeItemType: 'book', canPlace: true });
  });

  it('keeps the type tab in "Show all"', async () => {
    await renderSection(parseStagingItemFilter({ item: A }), 'non-book');
    expect(screen.getByTestId('staging-item-filter-show-all')).toHaveAttribute(
      'href',
      '/dashboard/inventory/staging?type=non-book',
    );
    // No order named: no link back, and the headline counts the items.
    expect(screen.queryByTestId('staging-item-filter-back')).toBeNull();
    expect(screen.getByTestId('staging-item-filter-headline')).toHaveTextContent('Showing only 1 item');
  });

  it('an order that is not there has no link back; a failed read keeps it without a number', async () => {
    calls.order = { state: 'not_found' };
    await renderSection(parseStagingItemFilter({ item: A, order: ORDER }));
    expect(screen.queryByTestId('staging-item-filter-back')).toBeNull();
    expect(screen.getByTestId('staging-item-filter-headline')).toHaveTextContent('Showing only 1 item');
  });

  it('a failed order read (even the service failing to start) never fails the page', async () => {
    calls.orderFactoryFails = true;
    await renderSection(parseStagingItemFilter({ item: A, order: ORDER }));
    expect(screen.getByTestId('staging-item-filter-headline')).toHaveTextContent('Showing items from an order');
    expect(screen.getByTestId('staging-item-filter-back')).toHaveAttribute('href', `/dashboard/orders/${ORDER}`);
    expect(screen.getByTestId('staging-table')).toBeInTheDocument();
  });

  it('an unusable ?item shows every item and says why (never a silently different list)', async () => {
    await renderSection(parseStagingItemFilter({ item: 'nope', order: ORDER }));
    expect(calls.worklist).toEqual([{ itemType: undefined, warehouseId: 'wh-cookie' }]);
    expect(calls.orderLink).toEqual([]);
    expect(screen.getByTestId('staging-item-filter-invalid')).toHaveTextContent(
      "This link's item list couldn't be read, so every item is shown.",
    );
    expect(screen.queryByTestId('staging-item-filter')).toBeNull();
  });

  it('a filtered list with nothing in it says what is listed, not what is in stock', async () => {
    calls.rows = [];
    await renderSection(parseStagingItemFilter({ item: A, order: ORDER }));
    expect(screen.getByTestId('staging-item-filter-empty')).toHaveTextContent(
      'No Staging or Unplaced stock is listed for these items.',
    );
  });
});
