import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The item form in the redesign (P4.A1, matrix W-IT-05): the sectioned card
// form keeps every field and note, and these pin what the redesign fixed on
// the way:
//  - every field's label names its control (the labels used to float free of
//    their inputs, so a screen reader announced "edit text" for each box);
//  - the New item tour's "Quantity on hand" and "Reorder point" steps have
//    their inputs to point at again (the inputs had lost their name when they
//    moved to the blank-zero number box, so both steps were skipped);
//  - a staged photo's Remove button is always shown (it was invisible until a
//    mouse hovered the tile, so phones, tablets and keyboards could not see it);
//  - the shared-SKU banner follows the theme's caution tokens;
//  - an org custom checkbox field is the shared checkbox, named by its label,
//    and toggling it still counts as unsaved work.

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
  findGroupCandidatesAction: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock('@/server/actions/item-images', () => ({
  createImageUploadAction: vi.fn(),
  recordImageAction: vi.fn(),
}));
vi.mock('@/server/actions/tags', () => ({ setItemTagsAction: vi.fn() }));

import { getUnsavedSources, resetUnsavedSourcesForTests } from '@/lib/unsaved-work';

import { NEW_ITEM_TOUR } from '@/lib/onboarding/tours';

import { ItemForm } from './item-form';

type Props = Parameters<typeof ItemForm>[0];

function renderForm(overrides: Partial<Props> = {}) {
  return render(
    <ItemForm
      categories={[{ id: 'cat-1', name: 'Apparel' }]}
      locations={[{ id: 'loc-1', name: 'Front room' }]}
      suppliers={[{ id: 'sup-1', name: 'Acme' }]}
      warehouses={[{ id: 'wh-1', name: 'North DC' }]}
      warehouseCharters={[]}
      charters={[]}
      warehouseLabel="Warehouse"
      charterLabel="Charter"
      {...overrides}
    />,
  );
}

beforeAll(() => {
  // jsdom has no object URLs; the staged-photo preview only needs a string.
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:preview', writable: true });
  }
  if (!URL.revokeObjectURL) {
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, writable: true });
  }
});
afterEach(() => resetUnsavedSourcesForTests());

describe('ItemForm (redesign): labels name their controls', () => {
  it('names the create form fields by their labels', () => {
    renderForm();
    expect(screen.getByLabelText('Name')).toHaveAttribute('name', 'name');
    expect(screen.getByLabelText(/^SKU/)).toHaveAttribute('name', 'sku');
    expect(screen.getByLabelText(/^Barcode/)).toHaveAttribute('name', 'barcode');
    expect(screen.getByLabelText(/^Model number/)).toHaveAttribute('name', 'modelNumber');
    expect(screen.getByLabelText(/^Description/)).toHaveAttribute('name', 'description');
    expect(screen.getByLabelText('Item type')).toHaveAttribute('role', 'combobox');
    expect(screen.getByLabelText(/^Category/)).toHaveAttribute('role', 'combobox');
    expect(screen.getByLabelText(/^Supplier/)).toHaveAttribute('role', 'combobox');
    expect(screen.getByLabelText(/^Primary location/)).toHaveAttribute('role', 'combobox');
    expect(screen.getByLabelText(/^Rack number/)).toHaveAttribute('placeholder', '38');
    expect(screen.getByLabelText(/^Rack row/)).toHaveAttribute('placeholder', 'A');
    expect(screen.getByLabelText('Warehouse')).toHaveAttribute('role', 'combobox');
    expect(screen.getByLabelText(/^Charter/)).toHaveAttribute('role', 'combobox');
    expect(screen.getByLabelText('Unit cost')).toHaveAttribute('name', 'unitCost');
    expect(screen.getByLabelText('Retail price')).toHaveAttribute('name', 'retailPrice');
    expect(screen.getByLabelText('On hand')).toHaveAttribute('name', 'quantityOnHand');
    expect(screen.getByLabelText('Reorder at')).toHaveAttribute('name', 'reorderPoint');
    expect(screen.getByLabelText('Reorder qty')).toHaveAttribute('name', 'reorderQuantity');
    expect(screen.getByLabelText('Unit of measure')).toHaveAttribute('name', 'unitOfMeasure');
  });

  it('names the book fields, and the locked On hand and its Adjust on edit', () => {
    renderForm({
      itemType: 'book',
      defaults: { id: 'item-1', name: 'Beloved', quantityOnHand: 7 },
    });
    expect(screen.getByLabelText(/^ISBN/)).toHaveAttribute('name', 'barcode');
    expect(screen.getByLabelText(/^Author/)).toHaveAttribute('placeholder', 'e.g. Toni Morrison');
    expect(screen.getByLabelText(/^Grade level/)).toHaveAttribute('role', 'combobox');
    expect(screen.getByLabelText(/^Bin \/ shelf/)).toHaveAttribute('name', 'binLocation');
    expect(screen.getByLabelText(/^Crate color/)).toHaveAttribute('role', 'combobox');
    expect(screen.getByLabelText(/^Crate number/)).toHaveAttribute('placeholder', 'e.g. 12');
    const onHand = screen.getByLabelText('On hand');
    expect(onHand).toBeDisabled();
    expect(onHand).toHaveValue(7);
    expect(screen.getByRole('button', { name: 'Adjust' })).toBeInTheDocument();
  });

  it('names the warehouse-scoped member’s locked warehouse as text, not a control', () => {
    renderForm({ forcedWarehouseId: 'wh-1' });
    expect(screen.queryByLabelText('Warehouse')).not.toBeInTheDocument();
    expect(screen.getByText('North DC')).toBeInTheDocument();
    expect(
      screen.getByText('You can only create items at your assigned warehouse.'),
    ).toBeInTheDocument();
  });
});

describe('ItemForm (redesign): the New item tour has its inputs', () => {
  it('finds the quantity and reorder point targets on the create form', () => {
    const { container } = renderForm();
    for (const step of NEW_ITEM_TOUR.steps) {
      if (!step.target) continue;
      expect(container.querySelector(step.target), step.target).not.toBeNull();
    }
  });
});

describe('ItemForm (redesign): sections', () => {
  it('keeps each section heading with its own notes and fields, in the order they were', () => {
    renderForm();
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual([
      'Photos',
      'Basics',
      'Classification',
      'Warehouse & charter',
      'Pricing & stock',
    ]);
    const pricing = screen.getByRole('heading', { name: 'Pricing & stock' }).parentElement!;
    expect(pricing).toHaveAttribute('data-slot', 'item-form-section');
    expect(within(pricing).getByLabelText('Unit cost')).toBeInTheDocument();
  });

  it('lays the sections and field pairs out by the form’s own width, not the window’s', () => {
    // Beside the sidebar on a 768 px tablet the form is about 440 px wide: a
    // window breakpoint split it into a title column and two field columns
    // anyway, leaving the barcode box no room beside Scan and Lookup. The
    // split now follows the form (`item-form`) and each section's field
    // column (`fields`), which the browser measures as size containers.
    const { container } = renderForm();
    const form = container.querySelector('form')!;
    expect(form).toHaveClass('@container/item-form');
    const sections = container.querySelectorAll('[data-slot="item-form-section"]');
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section).toHaveClass('@min-[880px]/item-form:grid');
      expect(section.className).not.toMatch(/(^|\s)(sm|md|lg):grid/);
      expect(section.lastElementChild).toHaveClass('@container/fields');
    }
    const pricing = screen.getByRole('heading', { name: 'Pricing & stock' }).parentElement!;
    const grids = Array.from(pricing.querySelectorAll<HTMLElement>('.grid'));
    expect(grids.length).toBeGreaterThan(0);
    for (const grid of grids) {
      expect(grid.className).toMatch(/@min-\[480px\]\/fields:grid-cols-[23]/);
      expect(grid.className).not.toMatch(/(^|\s)sm:grid-cols-/);
    }
  });

  it('puts Cancel and the submit button in the form’s footer bar', () => {
    renderForm({ returnHref: '/dashboard/inventory' });
    const footer = screen.getByRole('button', { name: 'Create item' }).parentElement!;
    expect(footer).toHaveAttribute('data-slot', 'item-form-footer');
    expect(within(footer).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});

describe('ItemForm (redesign): staged photos', () => {
  it('shows each staged photo’s Remove button without a hover, and Primary on the first', async () => {
    const { container } = renderForm();
    const input = container.querySelector<HTMLInputElement>('#item-form-photos')!;
    const file = new File(['x'], 'shirt.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    const remove = await screen.findByRole('button', { name: 'Remove photo' });
    // It used to be opacity-0 until the tile was hovered.
    expect(remove.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(remove.className).not.toMatch(/group-hover:opacity-100/);
    expect(screen.getByText('Primary')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create item & upload 1 photo' }),
    ).toBeInTheDocument();
  });
});

describe('ItemForm (redesign): the shared-SKU banner', () => {
  it('draws on the caution tokens, not a fixed amber palette, and keeps its link', () => {
    renderForm({
      defaults: { id: 'item-1', name: 'Tee', quantityOnHand: 1 },
      sharedSkuOthers: 2,
      itemPageHref: '/dashboard/inventory/item-1',
    });
    const banner = screen.getByRole('note');
    expect(banner.className).not.toMatch(/amber/);
    expect(banner.className).toMatch(/bg-warning-wash/);
    expect(within(banner).getByRole('link', { name: 'Open the item page' })).toHaveAttribute(
      'href',
      '/dashboard/inventory/item-1',
    );
  });
});

describe('ItemForm (redesign): a custom checkbox field', () => {
  it('is the shared checkbox, named by its label, and ticking it is unsaved work', async () => {
    const user = userEvent.setup();
    renderForm({
      customFieldDefs: [
        {
          id: 'def-1',
          organizationId: 'org-1',
          entity: 'item',
          fieldKey: 'fragile',
          label: 'Fragile',
          fieldType: 'checkbox',
          required: false,
          options: null,
          sortOrder: 0,
          archived: false,
        } as unknown as NonNullable<Props['customFieldDefs']>[number],
      ],
    });
    const box = screen.getByRole('checkbox', { name: 'Fragile' });
    expect(box).toHaveAttribute('aria-checked', 'false');
    expect(getUnsavedSources()).toEqual([]);
    await user.click(box);
    expect(box).toHaveAttribute('aria-checked', 'true');
    expect(getUnsavedSources()).toEqual([{ id: 'item-form', label: 'New item' }]);
  });
});
