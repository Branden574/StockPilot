/**
 * B38: stock in the organization-level Staging or Unplaced bucket (migration
 * 0194, a location with no warehouse) can be placed from the web Staging page.
 *
 * The table used to offer Place only for a row with a warehouse
 * (`canPlace && r.warehouseId !== null`, for the button and the checkbox), so a
 * row in the organization's bucket showed a disabled Place titled "No
 * warehouse — cannot place". Order readiness counts that Staging as "here" and
 * offers "Put away" for it (0377), so the order page's put-away led to a row
 * nobody could place. The row now offers Place whenever there is a warehouse
 * to choose, and the dialog asks for the warehouse first.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const { mockPlaceStockAction, mockBulkPlaceStockAction } = vi.hoisted(() => ({
  mockPlaceStockAction: vi.fn(),
  mockBulkPlaceStockAction: vi.fn(),
}));
vi.mock('@/server/actions/inventory', () => ({
  placeStockAction: mockPlaceStockAction,
  bulkPlaceStockAction: mockBulkPlaceStockAction,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { StagingTable, type StagingTableProps } from './staging-table';

// Radix Select needs pointer-capture APIs happy-dom doesn't implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

type Row = StagingTableProps['rows'][number];

const ORG_STAGING = 'org-staging-loc';

function row(itemId: string, name: string, extra: Partial<Row> = {}): Row {
  return {
    itemId,
    name,
    sku: `SKU-${itemId}`,
    itemType: 'product',
    warehouseId: 'wh-main',
    sourceLocationId: `stg-${itemId}`,
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
    ...extra,
  };
}

/** A row in the organization's Staging bucket: no warehouse on the holding,
 *  and the item's own warehouse is Main (the only way the row is readable). */
const ORG_ROW = row('i-org', 'Trail Runner', {
  warehouseId: null,
  itemWarehouseId: 'wh-main',
  sourceLocationId: ORG_STAGING,
  quantity: 6,
});
const MAIN_ROW = row('i-main', 'Desk Lamp');

const DESTINATIONS = {
  'wh-main': [
    {
      id: 'r-main-1a',
      name: '1-A',
      kind: 'rack',
      rackNumber: '1',
      rackRow: 'A',
      crateColor: null,
      crateNumber: null,
    },
  ],
  'wh-annex': [
    {
      id: 'r-annex-9c',
      name: '9-C',
      kind: 'rack',
      rackNumber: '9',
      rackRow: 'C',
      crateColor: null,
      crateNumber: null,
    },
  ],
};

function renderTable(props: Partial<StagingTableProps> = {}) {
  return render(
    <StagingTable
      rows={[MAIN_ROW, ORG_ROW]}
      destinationsMap={DESTINATIONS}
      warehouseNames={{ 'wh-main': 'Main Warehouse', 'wh-annex': 'Annex' }}
      canPlace
      activeItemType="all"
      {...props}
    />,
  );
}

const placeButtonIn = (name: string) =>
  within(screen.getByText(name).closest('tr')!).getByRole('button', { name: /^place$/i });

beforeEach(() => {
  mockPlaceStockAction.mockReset();
  mockPlaceStockAction.mockResolvedValue({ ok: true, data: { toLocationId: 'r-main-1a' } });
  mockBulkPlaceStockAction.mockReset();
});

describe('Staging: a row in the organization-level bucket (B38)', () => {
  it('offers Place, and its checkbox, when there is a warehouse to place it in', () => {
    renderTable();
    expect(placeButtonIn('Trail Runner')).toBeEnabled();
    expect(placeButtonIn('Trail Runner')).not.toHaveAttribute('title');
    expect(screen.getByRole('checkbox', { name: 'Select Trail Runner' })).toBeEnabled();
  });

  it('select-all takes it too', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole('checkbox', { name: 'Select all placeable rows' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('with no warehouse to choose, Place stays disabled and says why, and the row cannot be ticked', () => {
    renderTable({ warehouseNames: {}, destinationsMap: {} });
    const place = placeButtonIn('Trail Runner');
    expect(place).toBeDisabled();
    expect(place).toHaveAttribute('title', 'No warehouse to place it in');
    expect(screen.getByRole('checkbox', { name: 'Select Trail Runner' })).toBeDisabled();
    // A row with a warehouse is unaffected by the names map.
    expect(placeButtonIn('Desk Lamp')).toBeEnabled();
  });

  it("opens on the item's own warehouse and places through the same action, from the organization's bucket into the chosen rack", async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(placeButtonIn('Trail Runner'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: 'To warehouse' })).toHaveTextContent(
      'Main Warehouse',
    );
    // Main's racks, not the Annex's.
    await user.click(within(dialog).getByRole('combobox', { name: 'To location' }));
    expect(await screen.findByRole('option', { name: '1-A' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '9-C' })).toBeNull();
    await user.click(screen.getByRole('option', { name: '1-A' }));
    await user.click(within(dialog).getByRole('button', { name: /place stock/i }));

    expect(mockPlaceStockAction).toHaveBeenCalledOnce();
    expect(mockPlaceStockAction.mock.calls[0]![0]).toMatchObject({
      itemId: 'i-org',
      fromLocationId: ORG_STAGING,
      quantity: 6,
      destination: { existingLocationId: 'r-main-1a' },
    });
  });

  it("Place selected gets the item's own warehouse with the row: the picker opens on it and the bucket's units go to its rack", async () => {
    const user = userEvent.setup();
    mockBulkPlaceStockAction.mockResolvedValue({ ok: true, data: { placed: 1, failed: [] } });
    renderTable();
    await user.click(screen.getByRole('checkbox', { name: 'Select Trail Runner' }));
    await user.click(screen.getByRole('button', { name: /place selected/i }));

    // Two warehouses are offered and Annex sorts first, so only the item's own
    // warehouse, handed to the dialog with the row, opens the picker on Main.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: 'To warehouse' })).toHaveTextContent(
      'Main Warehouse',
    );
    await user.click(within(dialog).getByRole('combobox', { name: 'To location' }));
    await user.click(await screen.findByRole('option', { name: '1-A' }));
    await user.click(within(dialog).getByRole('button', { name: /^place 1$/i }));

    expect(mockBulkPlaceStockAction).toHaveBeenCalledOnce();
    expect(mockBulkPlaceStockAction.mock.calls[0]![0]).toMatchObject({
      destination: { existingLocationId: 'r-main-1a' },
      placements: [{ itemId: 'i-org', fromLocationId: ORG_STAGING, quantity: 6 }],
    });
  });

  it('a person without stock:transfer gets no Place on it, as on any row', () => {
    renderTable({ canPlace: false });
    expect(screen.queryByRole('button', { name: /^place$/i })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
