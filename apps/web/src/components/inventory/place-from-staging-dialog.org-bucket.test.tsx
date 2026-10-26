/**
 * B38: Place for a holding in the organization-level Staging or Unplaced
 * bucket (migration 0194), which belongs to no warehouse.
 *
 * Its destinations used to be the holding's own warehouse's racks, and it had
 * none, so the table never opened this dialog for it. Now the dialog asks for
 * the warehouse first (opening on the item's own, where order readiness counts
 * the stock once it is placed), lists that warehouse's racks and crates, and
 * creates a new rack or crate in it. The write is the same placeStockAction a
 * holding with a warehouse uses.
 */
import { type BookStorageInfo } from '@stockpilot/core';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { mockPlaceStockAction, mockToast } = vi.hoisted(() => ({
  mockPlaceStockAction: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/server/actions/inventory', () => ({ placeStockAction: mockPlaceStockAction }));
vi.mock('sonner', () => ({ toast: mockToast }));

import { PlaceFromStagingDialog } from './place-from-staging-dialog';

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

const WAREHOUSES = [
  { id: 'wh-annex', name: 'Annex' },
  { id: 'wh-main', name: 'Main Warehouse' },
];
const BY_WAREHOUSE = {
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
    {
      id: 'c-main-red4',
      name: 'Red #4 on rack 38-B',
      kind: 'crate',
      rackNumber: '38',
      rackRow: 'B',
      crateColor: 'red',
      crateNumber: '4',
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

function renderDialog(
  opts: {
    itemType?: string;
    defaultWarehouseId?: string | null;
    warehouses?: Array<{ id: string; name: string }>;
    bookStorage?: BookStorageInfo | null;
  } = {},
) {
  return render(
    <PlaceFromStagingDialog
      itemId="item-org"
      itemName="Trail Runner"
      itemType={opts.itemType ?? 'product'}
      sourceLocationId="org-staging"
      sourceKind="staging"
      warehouseId={null}
      availableQuantity={6}
      destinations={[]}
      warehouseChoice={{
        warehouses: opts.warehouses ?? WAREHOUSES,
        destinationsByWarehouse: BY_WAREHOUSE,
        defaultWarehouseId:
          opts.defaultWarehouseId === undefined ? 'wh-main' : opts.defaultWarehouseId,
      }}
      bookStorage={opts.bookStorage ?? null}
    />,
  );
}

const warehousePicker = () => screen.getByRole('combobox', { name: 'To warehouse' });
const placeButton = () => screen.getByRole('button', { name: /place stock/i });

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^place$/i }));
}

async function pick(
  user: ReturnType<typeof userEvent.setup>,
  combobox: HTMLElement,
  option: string | RegExp,
) {
  await user.click(combobox);
  await user.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => {
  mockPlaceStockAction.mockReset();
  mockPlaceStockAction.mockResolvedValue({ ok: true, data: { toLocationId: 'x' } });
  mockToast.success.mockReset();
  mockToast.error.mockReset();
  mockToast.warning.mockReset();
});

describe('PlaceFromStagingDialog: a holding with no warehouse (B38)', () => {
  it("says where the stock is, opens on the item's own warehouse, and lists only that warehouse's racks and crates", async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    expect(screen.getByText('Staging (no warehouse)')).toBeInTheDocument();
    expect(warehousePicker()).toHaveTextContent('Main Warehouse');
    expect(
      screen.getByText(
        'This stock is not in any warehouse yet. Choose the warehouse it goes to, then its rack or crate.',
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'To location' }));
    const listbox = await screen.findByRole('listbox');
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['1-A', 'Red #4 on rack 38-B', '+ New rack / crate']);
  });

  it('places from the organization bucket into the picked rack through placeStockAction', async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);
    await pick(user, screen.getByRole('combobox', { name: 'To location' }), '1-A');
    await user.click(placeButton());

    expect(mockPlaceStockAction).toHaveBeenCalledOnce();
    expect(mockPlaceStockAction.mock.calls[0]![0]).toMatchObject({
      itemId: 'item-org',
      fromLocationId: 'org-staging',
      quantity: 6,
      destination: { existingLocationId: 'r-main-1a' },
    });
  });

  it('with several warehouses and no preference, nothing is picked and Place is off until one is', async () => {
    const user = userEvent.setup();
    renderDialog({ defaultWarehouseId: null });
    await open(user);

    expect(warehousePicker()).toHaveTextContent('Select a warehouse');
    // No destination controls before a warehouse: nothing to scope them by.
    expect(screen.queryByRole('combobox', { name: 'To location' })).toBeNull();
    expect(placeButton()).toBeDisabled();

    await pick(user, warehousePicker(), 'Annex');
    await pick(user, screen.getByRole('combobox', { name: 'To location' }), '9-C');
    expect(placeButton()).toBeEnabled();
    await user.click(placeButton());
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      existingLocationId: 'r-annex-9c',
    });
  });

  it("never opens on the item's warehouse when it is not one the viewer can place into", async () => {
    const user = userEvent.setup();
    renderDialog({
      warehouses: [
        { id: 'wh-annex', name: 'Annex' },
        { id: 'wh-other', name: 'Other' },
      ],
    });
    await open(user);
    expect(warehousePicker()).toHaveTextContent('Select a warehouse');
  });

  it('opens on the only warehouse offered', async () => {
    const user = userEvent.setup();
    renderDialog({ defaultWarehouseId: null, warehouses: [{ id: 'wh-annex', name: 'Annex' }] });
    await open(user);
    expect(warehousePicker()).toHaveTextContent('Annex');
  });

  it("switching the warehouse drops a rack picked in the previous one (it is not this warehouse's)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);
    await pick(user, screen.getByRole('combobox', { name: 'To location' }), '1-A');
    expect(placeButton()).toBeEnabled();

    await pick(user, warehousePicker(), 'Annex');
    expect(screen.getByRole('combobox', { name: 'To location' })).toHaveTextContent(
      'Select destination',
    );
    expect(placeButton()).toBeDisabled();
  });

  it('a new rack is created in the picked warehouse, and the confirmation names it', async () => {
    const user = userEvent.setup();
    renderDialog({ defaultWarehouseId: null });
    await open(user);
    await pick(user, warehousePicker(), 'Annex');
    await pick(user, screen.getByRole('combobox', { name: 'To location' }), /new rack \/ crate/i);
    await user.type(screen.getByLabelText(/rack number/i), '14-D');
    await user.click(placeButton());

    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Create new rack 14-D?');
    expect(confirm).toHaveTextContent('does not exist in Annex yet');
    await user.click(within(confirm).getByRole('button', { name: /create and place/i }));
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      newRack: { warehouseId: 'wh-annex', rackNumber: '14-D' },
    });
  });

  it("a book's recorded crate is placed into in the picked warehouse, by name", async () => {
    const user = userEvent.setup();
    const storage: BookStorageInfo = {
      rackNumber: '38',
      rackRow: 'B',
      crateColor: 'red',
      crateNumber: '4',
      grade: null,
      rackLabel: '38-B',
      crateLabel: 'Red 4',
    };
    renderDialog({ itemType: 'book', bookStorage: storage });
    await open(user);
    await user.click(placeButton());

    // The four fields were seeded from the recorded crate and go to the server
    // to resolve in Main Warehouse, where "Red #4 on rack 38-B" already is.
    expect(mockPlaceStockAction).toHaveBeenCalledOnce();
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      newRack: {
        warehouseId: 'wh-main',
        crateNumber: '4',
        crateColor: 'red',
        rackNumber: '38',
        rackRow: 'B',
      },
    });
  });
});
