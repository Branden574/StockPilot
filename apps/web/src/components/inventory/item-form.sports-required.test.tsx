import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// 2026-09-29, L4L: a Product in "Jerseys" failed three times with the toast
// "A size is required for this product." while the form said "Sizes
// (optional)" and, in "Jerseys details", "Size (optional)" with placeholder
// "10.5" (not even a size on the Jerseys letter scale).
//
// Under test: the form reads the category's RESOLVED profile (the same rule the
// server uses, @stockpilot/core), labels the required attributes as required,
// refuses the submit inline before any request, fits the placeholder to the
// size scale, and puts a server refusal under the field it names.
// ---------------------------------------------------------------------------

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

import { DEFAULT_SUBCATEGORY_PROFILES } from '@stockpilot/core';

import { ItemForm, type ItemFormDefaults } from './item-form';

type Category = Parameters<typeof ItemForm>[0]['categories'][number];

const JERSEYS_ID = '22222222-2222-2222-2222-222222222222';
const SHOES_ID = '11111111-1111-1111-1111-111111111111';
const CUSTOM_ID = '33333333-3333-3333-3333-333333333333';
const WAREHOUSE_ID = '66666666-6666-6666-6666-666666666666';
const APPAREL_SCALE = '5ca1e000-0000-0000-0000-000000000001';
const SHOE_SCALE = '5ca1e000-0000-0000-0000-000000000002';

/** L4L's Jerseys, as production has it: sized, on the letter scale. */
const JERSEYS: Category = {
  id: JERSEYS_ID,
  name: 'Jerseys',
  supports_sizes: true,
  sports_subcategory_key: 'jerseys',
  tracking_mode: 'NUMBERED_VARIANT',
  size_scale_id: APPAREL_SCALE,
};

const SHOES: Category = {
  id: SHOES_ID,
  name: 'Shoes',
  supports_sizes: true,
  sports_subcategory_key: 'shoes',
  size_scale_id: SHOE_SCALE,
};

const SIZE_SCALES = {
  [APPAREL_SCALE]: ['XS', 'S', 'M', 'L', 'XL'].map((value) => ({ value, isHalf: false })),
  [SHOE_SCALE]: ['9', '9.5', '10', '10.5'].map((value) => ({
    value,
    isHalf: value.endsWith('.5'),
  })),
};

function renderForm(opts: {
  categories: Category[];
  defaults?: ItemFormDefaults;
  sizeScaleSystems?: Record<string, string | null>;
  sportsEnabled?: boolean;
}) {
  return render(
    <ItemForm
      defaults={{ name: 'Wildcats home', warehouseId: WAREHOUSE_ID, ...opts.defaults }}
      categories={opts.categories}
      sportsEnabled={opts.sportsEnabled ?? true}
      sizeScales={SIZE_SCALES}
      sizeScaleSystems={opts.sizeScaleSystems ?? { [APPAREL_SCALE]: null, [SHOE_SCALE]: 'US_MENS' }}
      locations={[]}
      suppliers={[]}
      warehouses={[{ id: WAREHOUSE_ID, name: 'Main' }]}
      warehouseCharters={[]}
      charters={[]}
      warehouseLabel="Warehouse"
      charterLabel="Charter"
    />,
  );
}

const SIZE_HINT = 'Enter a size, or pick sizes above to add one item per size.';

beforeEach(() => vi.clearAllMocks());

describe('ItemForm — required sports attributes are labelled from the resolved profile', () => {
  it('labels a Jersey size as required, and keeps the rest optional', () => {
    renderForm({ categories: [JERSEYS], defaults: { categoryId: JERSEYS_ID } });
    const panel = screen.getByTestId('sports-fields');

    // Required: no "(optional)" on the Size label.
    expect(within(panel).getByLabelText('Size')).toBeInTheDocument();
    // Optional attributes still say so.
    expect(within(panel).getByLabelText(/^Team\s*\(optional\)$/)).toBeInTheDocument();
    expect(within(panel).getByLabelText(/^Jersey number\s*\(optional\)$/)).toBeInTheDocument();
    expect(within(panel).getByLabelText(/^Size system\s*\(optional\)$/)).toBeInTheDocument();
    expect(within(panel).queryByLabelText(/^Size\s*\(optional\)$/)).not.toBeInTheDocument();
  });

  it('does not call the Sizes row optional when the category needs a size', () => {
    renderForm({ categories: [JERSEYS], defaults: { categoryId: JERSEYS_ID } });
    expect(screen.queryByText('Sizes', { exact: false, selector: 'label' })?.textContent).toBe(
      'Sizes',
    );
    expect(
      screen.getByText('Pick sizes to add one item per size, or enter one size in Jerseys details below.'),
    ).toBeInTheDocument();
  });

  it('labels both Shoes attributes as required', () => {
    renderForm({ categories: [SHOES], defaults: { categoryId: SHOES_ID } });
    const panel = screen.getByTestId('sports-fields');
    expect(within(panel).getByLabelText('Size')).toBeInTheDocument();
    expect(within(panel).getByText('Size system', { selector: 'label' }).textContent).toBe(
      'Size system',
    );
  });

  it("fits the placeholder to the category's scale: a letter for Jerseys, 10.5 only for shoes", () => {
    const { unmount } = renderForm({ categories: [JERSEYS], defaults: { categoryId: JERSEYS_ID } });
    expect(screen.getByLabelText('Size')).toHaveAttribute('placeholder', 'e.g. M');
    expect(screen.queryByPlaceholderText('10.5')).not.toBeInTheDocument();
    unmount();

    renderForm({ categories: [SHOES], defaults: { categoryId: SHOES_ID } });
    expect(screen.getByLabelText('Size')).toHaveAttribute('placeholder', 'e.g. 10.5');
  });

  it("reads a CUSTOM subcategory's own profile, exactly as the server does", () => {
    const custom: Category = {
      id: CUSTOM_ID,
      name: 'Singlets',
      sports_subcategory_key: 'custom_singlets',
      tracking_profile: {
        ...DEFAULT_SUBCATEGORY_PROFILES.jerseys,
        key: 'custom_singlets',
        label: 'Singlets',
        requiredAttributes: ['jersey_number'],
      },
    };
    renderForm({ categories: [custom], defaults: { categoryId: CUSTOM_ID } });
    const panel = screen.getByTestId('sports-fields');
    expect(within(panel).getByText('Singlets details')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Jersey number')).toBeInTheDocument();
    expect(within(panel).getByLabelText(/^Size\s*\(optional\)$/)).toBeInTheDocument();
  });
});

describe('ItemForm — a missing required attribute is caught inline, before any request', () => {
  it('refuses a Jersey with no size under the Size field, and sends nothing (the reported case)', async () => {
    const { createItemAction, bulkCreateSizedVariantsAction } = await import(
      '@/server/actions/inventory'
    );
    const { toast } = await import('sonner');
    renderForm({ categories: [JERSEYS], defaults: { categoryId: JERSEYS_ID } });

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: /create item/i }));

    expect(await screen.findByText(SIZE_HINT)).toBeInTheDocument();
    expect(screen.getByLabelText('Size')).toHaveAttribute('aria-invalid', 'true');
    expect(createItemAction).not.toHaveBeenCalled();
    expect(bulkCreateSizedVariantsAction).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('clears the error and saves once a size is typed', async () => {
    const { createItemAction } = await import('@/server/actions/inventory');
    vi.mocked(createItemAction).mockResolvedValue({ ok: true, data: { id: 'item-1' } } as never);
    renderForm({ categories: [JERSEYS], defaults: { categoryId: JERSEYS_ID } });

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: /create item/i }));
    expect(await screen.findByText(SIZE_HINT)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Size'), 'M');
    await waitFor(() => expect(screen.queryByText(SIZE_HINT)).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /create item/i }));

    await waitFor(() => expect(createItemAction).toHaveBeenCalledTimes(1));
    const [payload] = vi.mocked(createItemAction).mock.calls[0] as [Record<string, unknown>];
    expect(payload.variantSize).toBe('M');
  });

  it('accepts picked sizes instead of a typed one: one item per size', async () => {
    const { bulkCreateSizedVariantsAction, createItemAction } = await import(
      '@/server/actions/inventory'
    );
    vi.mocked(bulkCreateSizedVariantsAction).mockResolvedValue({
      ok: true,
      data: { created: 2, ids: ['a', 'b'] },
    } as never);
    renderForm({ categories: [JERSEYS], defaults: { categoryId: JERSEYS_ID } });

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: 'S' }));
    await user.click(screen.getByRole('button', { name: 'M' }));
    await user.click(screen.getByRole('button', { name: /create item/i }));

    await waitFor(() => expect(bulkCreateSizedVariantsAction).toHaveBeenCalledTimes(1));
    expect(createItemAction).not.toHaveBeenCalled();
    expect(screen.queryByText(SIZE_HINT)).not.toBeInTheDocument();
  });

  it("lets the shoe category's size scale supply the size system, as the server now does", async () => {
    const { createItemAction } = await import('@/server/actions/inventory');
    vi.mocked(createItemAction).mockResolvedValue({ ok: true, data: { id: 'item-1' } } as never);
    renderForm({ categories: [SHOES], defaults: { name: 'Pegasus', categoryId: SHOES_ID } });

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.type(screen.getByLabelText('Size'), '10.5');
    await user.click(screen.getByRole('button', { name: /create item/i }));

    await waitFor(() => expect(createItemAction).toHaveBeenCalledTimes(1));
  });

  it('asks for a size system when the shoe scale sets none', async () => {
    const { createItemAction } = await import('@/server/actions/inventory');
    renderForm({
      categories: [SHOES],
      defaults: { name: 'Pegasus', categoryId: SHOES_ID },
      sizeScaleSystems: { [SHOE_SCALE]: null },
    });

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.type(screen.getByLabelText('Size'), '10.5');
    await user.click(screen.getByRole('button', { name: /create item/i }));

    expect(
      await screen.findByText("Pick a size system, such as US Men's, UK or EU."),
    ).toBeInTheDocument();
    expect(createItemAction).not.toHaveBeenCalled();
  });

  it("never asks for a size system the page could not tell about (the server reads the scale itself)", async () => {
    const { createItemAction } = await import('@/server/actions/inventory');
    vi.mocked(createItemAction).mockResolvedValue({ ok: true, data: { id: 'item-1' } } as never);
    renderForm({
      categories: [SHOES],
      defaults: { name: 'Pegasus', categoryId: SHOES_ID },
      sizeScaleSystems: {},
    });

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.type(screen.getByLabelText('Size'), '10.5');
    await user.click(screen.getByRole('button', { name: /create item/i }));
    await waitFor(() => expect(createItemAction).toHaveBeenCalledTimes(1));
  });

  it('does not demand sports attributes when the module is off (no fields are shown)', async () => {
    const { createItemAction } = await import('@/server/actions/inventory');
    vi.mocked(createItemAction).mockResolvedValue({ ok: true, data: { id: 'item-1' } } as never);
    renderForm({
      categories: [JERSEYS],
      defaults: { categoryId: JERSEYS_ID },
      sportsEnabled: false,
    });

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: /create item/i }));
    await waitFor(() => expect(createItemAction).toHaveBeenCalledTimes(1));
  });
});

describe('ItemForm — a server refusal lands under the field it names', () => {
  it('shows the server sentence under Size when details.field says so', async () => {
    const { createItemAction } = await import('@/server/actions/inventory');
    const message = 'Size is required for Jerseys: enter a size, or pick sizes to add one item per size.';
    vi.mocked(createItemAction).mockResolvedValue({
      ok: false,
      error: {
        code: 'validation_error',
        message,
        details: { code: 'SHOE_SIZE_REQUIRED', field: 'variantSize' },
      },
    } as never);
    renderForm({
      categories: [JERSEYS],
      defaults: { categoryId: JERSEYS_ID, variantSize: 'M' },
    });

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: /create item/i }));

    const panel = screen.getByTestId('sports-fields');
    expect(await within(panel).findByText(message)).toBeInTheDocument();
    expect(within(panel).getByLabelText('Size')).toHaveAttribute('aria-invalid', 'true');
  });
});
