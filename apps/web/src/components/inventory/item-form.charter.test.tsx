import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Changing the charter on the item form (B26). The charter list offers the
// charters the record's warehouse services (warehouse_charters), and a
// warehouse change clears a charter the new warehouse does not service.
//
// That clearing also ran when the form LOADED: a record whose charter its own
// warehouse no longer lists (an admin unlinked it after the record got it)
// opened showing Generic, and saving any other field sent Generic and quietly
// took the record's charter away. The form now shows that charter and sends
// it back unchanged; only a change of warehouse clears it.

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));
vi.mock('@/server/actions/inventory', () => ({
  createItemAction: vi.fn(),
  updateItemAction: vi.fn(),
  bulkCreateSizedVariantsAction: vi.fn(),
}));
vi.mock('@/server/actions/item-images', () => ({
  createImageUploadAction: vi.fn(),
  recordImageAction: vi.fn(),
}));
vi.mock('@/server/actions/tags', () => ({ setItemTagsAction: vi.fn() }));

import { toast } from 'sonner';

import { updateItemAction } from '@/server/actions/inventory';

import { ItemForm } from './item-form';

const ITEM = '44444444-4444-4444-8444-444444444444';
const MAIN_DC = '11111111-1111-4111-8111-111111111111';
const EAST_DC = '55555555-5555-4555-8555-555555555555';
const NORTH = '22222222-2222-4222-8222-222222222222';
const SOUTH = '33333333-3333-4333-8333-333333333333';

function renderForm(pairs: Array<{ warehouse_id: string; charter_id: string }>) {
  render(
    <ItemForm
      defaults={{
        id: ITEM,
        name: 'Chromebook',
        sku: 'CB-1',
        warehouseId: MAIN_DC,
        charterId: NORTH,
        customFields: {},
      }}
      categories={[]}
      locations={[]}
      suppliers={[]}
      warehouses={[
        { id: MAIN_DC, name: 'Main DC' },
        { id: EAST_DC, name: 'East DC' },
      ]}
      warehouseCharters={pairs}
      charters={[
        { id: NORTH, name: 'North Campus' },
        { id: SOUTH, name: 'South Campus' },
      ]}
      warehouseLabel="Warehouse"
      charterLabel="Charter"
    />,
  );
}

const charterBox = () => screen.getByRole('combobox', { name: /charter/i });

async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /save changes/i }));
  expect(updateItemAction).toHaveBeenCalledTimes(1);
  return vi.mocked(updateItemAction).mock.calls[0]![1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(updateItemAction).mockResolvedValue({ ok: true, data: { id: ITEM } } as never);
});

describe('ItemForm: the charter', () => {
  it('sends the newly picked charter on Save', async () => {
    renderForm([
      { warehouse_id: MAIN_DC, charter_id: NORTH },
      { warehouse_id: MAIN_DC, charter_id: SOUTH },
    ]);
    const user = userEvent.setup();
    expect(charterBox()).toHaveTextContent('North Campus');

    await user.click(charterBox());
    await user.click(await screen.findByRole('option', { name: 'South Campus' }));
    expect(charterBox()).toHaveTextContent('South Campus');

    expect(await save(user)).toMatchObject({ charterId: SOUTH });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows a charter its warehouse no longer lists, and saves it unchanged', async () => {
    // Main DC services South only; the record still carries North.
    renderForm([{ warehouse_id: MAIN_DC, charter_id: SOUTH }]);
    const user = userEvent.setup();

    expect(charterBox()).toHaveTextContent('North Campus');
    expect(charterBox()).toHaveTextContent(/not linked to this warehouse/i);

    expect(await save(user)).toMatchObject({ charterId: NORTH });
  });

  it('still lets a charter the warehouse lists replace it', async () => {
    renderForm([{ warehouse_id: MAIN_DC, charter_id: SOUTH }]);
    const user = userEvent.setup();

    await user.click(charterBox());
    await user.click(await screen.findByRole('option', { name: 'South Campus' }));

    expect(await save(user)).toMatchObject({ charterId: SOUTH });
  });

  it('does not carry a charter to a warehouse that does not service it and back', async () => {
    // Main DC services North; East DC services South only.
    renderForm([
      { warehouse_id: MAIN_DC, charter_id: NORTH },
      { warehouse_id: EAST_DC, charter_id: SOUTH },
    ]);
    const user = userEvent.setup();

    await user.click(screen.getByRole('combobox', { name: /warehouse/i }));
    await user.click(await screen.findByRole('option', { name: 'East DC' }));
    await user.click(charterBox());
    await user.click(await screen.findByRole('option', { name: 'South Campus' }));
    await user.click(screen.getByRole('combobox', { name: /warehouse/i }));
    await user.click(await screen.findByRole('option', { name: 'Main DC' }));

    // South is not Main DC's: it is cleared, not kept as "not linked".
    expect(charterBox()).not.toHaveTextContent('South Campus');
    expect(await save(user)).toMatchObject({ warehouseId: MAIN_DC, charterId: null });
  });

  it('clears the charter when the warehouse changes to one that does not service it', async () => {
    renderForm([
      { warehouse_id: MAIN_DC, charter_id: NORTH },
      { warehouse_id: EAST_DC, charter_id: SOUTH },
    ]);
    const user = userEvent.setup();

    await user.click(screen.getByRole('combobox', { name: /warehouse/i }));
    await user.click(await screen.findByRole('option', { name: 'East DC' }));

    expect(charterBox()).not.toHaveTextContent('North Campus');
    expect(await save(user)).toMatchObject({ warehouseId: EAST_DC, charterId: null });
  });
});
