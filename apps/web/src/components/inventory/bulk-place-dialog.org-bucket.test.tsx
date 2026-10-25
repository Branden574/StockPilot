/**
 * B38: Place selected with rows in the organization-level Staging or Unplaced
 * bucket (migration 0194), which belong to no warehouse.
 *
 * The bulk dialog required every selected row to share one non-null warehouse
 * ("The selected items span multiple warehouses (or have none)"), and the
 * table never let such a row be ticked. Now a row with no warehouse joins the
 * one warehouse the other selected rows share (the dialog says so), and a
 * selection with no warehouse at all picks one first. Rows from two
 * warehouses are still refused. The write is the same bulkPlaceStockAction.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { mockBulkPlace, mockToast } = vi.hoisted(() => ({
  mockBulkPlace: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/server/actions/inventory', () => ({ bulkPlaceStockAction: mockBulkPlace }));
vi.mock('sonner', () => ({ toast: mockToast }));

import { BulkPlaceDialog, type BulkPlaceRow } from './bulk-place-dialog';

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

const DESTINATIONS_MAP = {
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
const NAMES = { 'wh-main': 'Main Warehouse', 'wh-annex': 'Annex' };

function row(itemId: string, extra: Partial<BulkPlaceRow> = {}): BulkPlaceRow {
  return {
    itemId,
    name: `Item ${itemId}`,
    itemType: 'product',
    sourceLocationId: 'org-staging',
    quantity: 2,
    warehouseId: null,
    itemWarehouseId: 'wh-main',
    bookStorage: null,
    ...extra,
  };
}

function renderDialog(rows: BulkPlaceRow[], names: Record<string, string> = NAMES) {
  return render(
    <BulkPlaceDialog
      rows={rows}
      destinationsMap={DESTINATIONS_MAP}
      warehouseNames={names}
      onPlaced={() => {}}
      trigger={<button>Place selected</button>}
    />,
  );
}

const warehousePicker = () => screen.getByRole('combobox', { name: 'To warehouse' });
const placeButton = (n: number) =>
  screen.getByRole('button', { name: new RegExp(`^place ${n}$`, 'i') });

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /place selected/i }));
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
  mockBulkPlace.mockReset();
  mockBulkPlace.mockResolvedValue({ ok: true, data: { placed: 2, failed: [] } });
});

describe('BulkPlaceDialog: rows with no warehouse (B38)', () => {
  it("none of the selection has a warehouse: it opens on the items' shared warehouse and places into its rack", async () => {
    const user = userEvent.setup();
    renderDialog([row('a'), row('b')]);
    await open(user);

    expect(warehousePicker()).toHaveTextContent('Main Warehouse');
    await pick(user, screen.getByRole('combobox', { name: 'To location' }), '1-A');
    await user.click(placeButton(2));

    expect(mockBulkPlace).toHaveBeenCalledOnce();
    const input = mockBulkPlace.mock.calls[0]![0];
    expect(input.destination).toEqual({ existingLocationId: 'r-main-1a' });
    expect(input.placements).toEqual([
      { itemId: 'a', fromLocationId: 'org-staging', quantity: 2 },
      { itemId: 'b', fromLocationId: 'org-staging', quantity: 2 },
    ]);
  });

  it('items of different warehouses: nothing is picked, and Place is off until a warehouse is', async () => {
    const user = userEvent.setup();
    renderDialog([row('a'), row('b', { itemWarehouseId: 'wh-annex' })]);
    await open(user);

    expect(warehousePicker()).toHaveTextContent('Select a warehouse');
    expect(screen.queryByRole('combobox', { name: 'To location' })).toBeNull();
    expect(placeButton(2)).toBeDisabled();

    await pick(user, warehousePicker(), 'Annex');
    await pick(user, screen.getByRole('combobox', { name: 'To location' }), '9-C');
    expect(placeButton(2)).toBeEnabled();
  });

  it('a new rack is created in the picked warehouse', async () => {
    const user = userEvent.setup();
    renderDialog([row('a'), row('b')]);
    await open(user);
    await pick(user, warehousePicker(), 'Annex');
    await pick(user, screen.getByRole('combobox', { name: 'To location' }), /new rack/i);
    await user.type(screen.getByLabelText(/rack number/i), '14-D');
    await user.click(placeButton(2));

    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('does not exist in Annex yet');
    await user.click(within(confirm).getByRole('button', { name: /create and place/i }));
    expect(mockBulkPlace.mock.calls[0]![0].destination).toEqual({
      newRack: { warehouseId: 'wh-annex', rackNumber: '14-D' },
    });
  });

  it('rows with no warehouse join the one the other rows share, and the dialog says so (no picker)', async () => {
    const user = userEvent.setup();
    renderDialog([
      row('a', {
        warehouseId: 'wh-annex',
        itemWarehouseId: 'wh-annex',
        sourceLocationId: 'annex-staging',
      }),
      row('b'),
    ]);
    await open(user);

    expect(screen.queryByRole('combobox', { name: 'To warehouse' })).toBeNull();
    expect(screen.getByText('Annex')).toBeInTheDocument();
    expect(
      screen.getByText('1 selected row is not in any warehouse yet and goes to Annex too.'),
    ).toBeInTheDocument();

    await pick(user, screen.getByRole('combobox', { name: 'To location' }), '9-C');
    await user.click(placeButton(2));
    const input = mockBulkPlace.mock.calls[0]![0];
    expect(input.destination).toEqual({ existingLocationId: 'r-annex-9c' });
    expect(input.placements.map((p: { fromLocationId: string }) => p.fromLocationId)).toEqual([
      'annex-staging',
      'org-staging',
    ]);
  });

  it('rows from two warehouses are still refused, in words that no longer blame rows with no warehouse', async () => {
    const user = userEvent.setup();
    renderDialog([
      row('a', { warehouseId: 'wh-annex' }),
      row('b', { warehouseId: 'wh-main' }),
      row('c'),
    ]);
    await open(user);

    expect(
      screen.getByText(
        'The selected items span multiple warehouses. Select items from a single warehouse to place them together.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(placeButton(3)).toBeDisabled();
  });

  it('a selection whose rows all have a warehouse is unchanged: no warehouse line at all', async () => {
    const user = userEvent.setup();
    renderDialog([
      row('a', { warehouseId: 'wh-main', sourceLocationId: 'main-staging' }),
      row('b', { warehouseId: 'wh-main', sourceLocationId: 'main-staging' }),
    ]);
    await open(user);
    expect(screen.queryByText('To warehouse')).toBeNull();
    expect(screen.queryByText(/not in any warehouse yet/)).toBeNull();
  });
});
