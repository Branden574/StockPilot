import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { StagingTable, type StagingTableProps } from './staging-table';

// Pattern #18: a URL-rewriting effect runs on MOUNT too. The Staging page's
// ?item= and ?order= (F2-3, put away from an order) are read only: nothing on
// mount may rewrite them, and the one URL write the table makes (the type
// tab's ?type=) must carry them along.

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const ORDER = '0f0f0f0f-0000-4000-8000-000000000001';
const QUERY = `order=${ORDER}&item=${A}&item=${B}`;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(QUERY),
  usePathname: () => '/dashboard/inventory/staging',
}));

beforeEach(() => {
  router.push.mockReset();
  router.replace.mockReset();
  router.refresh.mockReset();
});

type Row = StagingTableProps['rows'][number];
const row = (itemId: string, over: Partial<Row> = {}): Row => ({
  itemId,
  name: `Item ${itemId.slice(-1)}`,
  sku: `SKU-${itemId.slice(-1)}`,
  itemType: 'product',
  warehouseId: 'wh1',
  sourceLocationId: `stg-${itemId.slice(-1)}`,
  sourceKind: 'staging',
  quantity: 4,
  sourceReceiptId: null,
  sourcePoNumber: null,
  receiptNumber: null,
  receivedAt: null,
  ageDays: null,
  barcode: null,
  modelNumber: null,
  bookStorage: null,
  ...over,
});

function renderTable() {
  return render(
    <StagingTable
      rows={[row(A), row(B, { sourceKind: 'unplaced', sourceLocationId: 'unp-1' })]}
      destinationsMap={{}}
      warehouseNames={{ wh1: 'WH One' }}
      canPlace
      activeItemType="all"
    />,
  );
}

describe('the Staging table leaves ?item and ?order alone (pattern #18)', () => {
  it('mounting with ?item and ?order writes no URL', async () => {
    renderTable();
    // Let every mount effect run.
    await new Promise((r) => setTimeout(r, 0));
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('the type tab keeps ?item and ?order when it sets ?type', async () => {
    renderTable();
    await userEvent.click(screen.getByRole('button', { name: 'Books' }));
    expect(router.push).toHaveBeenCalledTimes(1);
    const next = new URLSearchParams(String(router.push.mock.calls[0]![0]).replace(/^\?/, ''));
    expect(next.getAll('item')).toEqual([A, B]);
    expect(next.get('order')).toBe(ORDER);
    expect(next.get('type')).toBe('book');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('typing in search, the in-memory filters, writes no URL either', async () => {
    renderTable();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search staging items' }), 'Item');
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

// F2-3: a list filtered to an order's items says it is empty once, in the
// page's chip; the table's own empty state is for the whole worklist.
describe('the table empty state', () => {
  const empty = (hideEmptyState?: boolean) =>
    render(
      <StagingTable
        rows={[]}
        destinationsMap={{}}
        warehouseNames={{}}
        canPlace
        activeItemType="all"
        {...(hideEmptyState === undefined ? {} : { hideEmptyState })}
      />,
    );

  it('shows "Nothing to place" by default', () => {
    empty();
    expect(screen.getByText(/Nothing to place/)).toBeInTheDocument();
  });

  it('leaves it out when the page already says the list is empty', () => {
    empty(true);
    expect(screen.queryByText(/Nothing to place/)).toBeNull();
  });
});
