import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Sports Task 11 — Add Item sports fields + the grouping preview.
//
// BINDING constraints under test:
//   - fields render from the resolved tracking PROFILE, never a hardcoded
//     per-category conditional (proven by driving two different profiles —
//     shoes and jerseys — through the SAME component with no special-casing
//     in this test file itself);
//   - the jersey-number field is NEVER labeled "Serial Number";
//   - existing non-sports item creation is PIXEL-UNCHANGED — no new fields
//     render without a resolved sports profile, even when the org has the
//     module on;
//   - candidate linking never happens without an explicit "Use this group"
//     click (requirement 6/13).
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock('@/server/actions/inventory', () => ({
  createItemAction: vi.fn(),
  updateItemAction: vi.fn(),
  bulkCreateSizedVariantsAction: vi.fn(),
  findGroupCandidatesAction: vi.fn(),
}));

vi.mock('@/server/actions/item-images', () => ({
  createImageUploadAction: vi.fn(),
  recordImageAction: vi.fn(),
}));

vi.mock('@/server/actions/tags', () => ({
  setItemTagsAction: vi.fn(),
}));

import { ItemForm, type ItemFormDefaults } from './item-form';

type Category = Parameters<typeof ItemForm>[0]['categories'][number];

// createItemSchema's categoryId/warehouseId are `uuidSchema` — a non-UUID id
// here would fail CLIENT validation silently (handleSubmit's onValid never
// runs, with no onInvalid wired), so every fixture id must be a real UUID.
const SHOES_CATEGORY_ID = '11111111-1111-1111-1111-111111111111';
const JERSEYS_CATEGORY_ID = '22222222-2222-2222-2222-222222222222';
const PLAIN_CATEGORY_ID = '33333333-3333-3333-3333-333333333333';
const SPORTS_ROOT_ID = '44444444-4444-4444-4444-444444444444';
const SPORTS_ROOT_CHILD_ID = '55555555-5555-5555-5555-555555555555';
const WAREHOUSE_ID = '66666666-6666-6666-6666-666666666666';

const SHOES_CATEGORY: Category = {
  id: SHOES_CATEGORY_ID,
  name: 'Shoes',
  sports_subcategory_key: 'shoes',
};

const JERSEYS_CATEGORY: Category = {
  id: JERSEYS_CATEGORY_ID,
  name: 'Jerseys',
  sports_subcategory_key: 'jerseys',
};

const PLAIN_CATEGORY: Category = {
  id: PLAIN_CATEGORY_ID,
  name: 'Electronics',
};

const SPORTS_ROOT: Category = { id: SPORTS_ROOT_ID, name: 'Sports' };
const SPORTS_ROOT_CHILD: Category = {
  id: SPORTS_ROOT_CHILD_ID,
  name: 'Shoes',
  parent_id: SPORTS_ROOT_ID,
  sports_subcategory_key: 'shoes',
};

function renderForm(opts: {
  categories: Category[];
  sportsEnabled?: boolean;
  canManageSports?: boolean;
  defaults?: ItemFormDefaults;
  warehouses?: Array<{ id: string; name: string }>;
  sizeScales?: Record<string, Array<{ value: string; isHalf: boolean }>>;
}) {
  return render(
    <ItemForm
      defaults={opts.defaults}
      categories={opts.categories}
      sportsEnabled={opts.sportsEnabled ?? false}
      canManageSports={opts.canManageSports ?? false}
      sizeScales={opts.sizeScales}
      locations={[]}
      suppliers={[]}
      warehouses={opts.warehouses ?? []}
      warehouseCharters={[]}
      charters={[]}
      warehouseLabel="Warehouse"
      charterLabel="Charter"
    />,
  );
}

/** Radix Select: open the trigger and click one of its options. */
async function pickFromSelect(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement,
  optionName: string | RegExp,
) {
  await user.click(trigger);
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: optionName }));
}

describe('ItemForm — sports fields render from the resolved profile (Task 11)', () => {
  it('renders no sports fields and no grouping preview for a plain category, even with the module on', () => {
    renderForm({
      categories: [PLAIN_CATEGORY],
      sportsEnabled: true,
      defaults: { categoryId: PLAIN_CATEGORY_ID },
    });

    expect(screen.queryByTestId('sports-fields')).not.toBeInTheDocument();
    expect(screen.queryByText('This will be saved as')).not.toBeInTheDocument();
  });

  it('renders no sports fields for a resolved sports category when the module is OFF (double gate)', () => {
    renderForm({
      categories: [SHOES_CATEGORY],
      sportsEnabled: false,
      defaults: { categoryId: SHOES_CATEGORY_ID },
    });

    expect(screen.queryByTestId('sports-fields')).not.toBeInTheDocument();
    expect(screen.queryByText('This will be saved as')).not.toBeInTheDocument();
  });

  it('renders no sports fields when the module is on but no category is selected at all', () => {
    renderForm({ categories: [SHOES_CATEGORY], sportsEnabled: true });

    expect(screen.queryByTestId('sports-fields')).not.toBeInTheDocument();
    expect(screen.queryByText('This will be saved as')).not.toBeInTheDocument();
  });

  it('renders the shoes profile fields and the grouping preview once the module is on and a shoes category is picked', () => {
    renderForm({
      categories: [SHOES_CATEGORY],
      sportsEnabled: true,
      defaults: { categoryId: SHOES_CATEGORY_ID },
    });

    expect(screen.getByTestId('sports-fields')).toBeInTheDocument();
    // Subcategory-driven: shoes offers brand/model/colorway/size/width/fit,
    // NOT jersey number or team — proving the fields come from the profile,
    // not a hardcoded per-category block.
    expect(screen.getByPlaceholderText('Nike')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Pegasus 41')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Black/White')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('D')).toBeInTheDocument();
    expect(screen.queryByLabelText(/jersey number/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^team$/i)).not.toBeInTheDocument();

    // The grouping preview: shoes defaults to QUANTITY_BY_VARIANT (no serial)
    // counted in pairs.
    expect(screen.getByText('This will be saved as')).toBeInTheDocument();
    expect(screen.getByText('Serial: not required')).toBeInTheDocument();
    expect(screen.getByText('pairs')).toBeInTheDocument();
  });

  it('labels the jerseys number field "Jersey number" and NEVER "Serial Number"', () => {
    renderForm({
      categories: [JERSEYS_CATEGORY],
      sportsEnabled: true,
      defaults: { categoryId: JERSEYS_CATEGORY_ID },
    });

    expect(screen.getByPlaceholderText('e.g. 07')).toBeInTheDocument();
    expect(screen.getByText('Jersey number')).toBeInTheDocument();
    expect(screen.queryByText(/serial number/i)).not.toBeInTheDocument();
    // Jerseys default to NUMBERED_VARIANT, which stamps tracking_type='none' —
    // a jersey number is not a serial, so the preview must say so.
    expect(screen.getByText('Serial: not required')).toBeInTheDocument();
  });

  it('blocks submit with SPORTS_SUBCATEGORY_REQUIRED when the selected category is the bare Sports root', async () => {
    const { createItemAction } = await import('@/server/actions/inventory');
    const { toast } = await import('sonner');

    renderForm({
      categories: [SPORTS_ROOT, SPORTS_ROOT_CHILD],
      sportsEnabled: true,
      defaults: { name: 'Some sports item', categoryId: SPORTS_ROOT_ID },
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /create item/i }));

    expect(createItemAction).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'Pick a Sports subcategory',
      expect.objectContaining({ description: expect.any(String) }),
    );
  });

  it('does NOT block submit once a real subcategory (not the bare root) is selected', async () => {
    const { createItemAction } = await import('@/server/actions/inventory');
    vi.mocked(createItemAction).mockResolvedValue({ ok: true, data: { id: 'item-1' } } as never);

    renderForm({
      categories: [SPORTS_ROOT, SHOES_CATEGORY],
      sportsEnabled: true,
      defaults: { name: 'Nike Shoe', categoryId: SHOES_CATEGORY_ID, warehouseId: WAREHOUSE_ID },
      warehouses: [{ id: WAREHOUSE_ID, name: 'Main' }],
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /create item/i }));

    await waitFor(() => expect(createItemAction).toHaveBeenCalledTimes(1));
  });

  it('attaches a computed productGroup (name defaults from the item, brand/model from the typed fields) on create', async () => {
    const { createItemAction, findGroupCandidatesAction } = await import(
      '@/server/actions/inventory'
    );
    vi.mocked(createItemAction).mockResolvedValue({ ok: true, data: { id: 'item-1' } } as never);
    vi.mocked(findGroupCandidatesAction).mockResolvedValue({ ok: true, data: [] } as never);

    renderForm({
      categories: [SHOES_CATEGORY],
      sportsEnabled: true,
      defaults: { name: 'Nike Pegasus 41', categoryId: SHOES_CATEGORY_ID, warehouseId: WAREHOUSE_ID },
      warehouses: [{ id: WAREHOUSE_ID, name: 'Main' }],
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Nike'), 'Nike');
    await user.type(screen.getByPlaceholderText('Pegasus 41'), 'Pegasus 41');
    await user.click(screen.getByRole('button', { name: /create item/i }));

    await waitFor(() => expect(createItemAction).toHaveBeenCalledTimes(1));
    const [payload] = vi.mocked(createItemAction).mock.calls[0] as [Record<string, unknown>];
    // No candidate was linked, so groupId stays whatever the (unset) default
    // is — never populated — while productGroup carries the new identity.
    expect(payload.groupId).toBeFalsy();
    expect(payload.productGroup).toMatchObject({
      name: 'Nike Pegasus 41',
      brand: 'Nike',
      model: 'Pegasus 41',
    });
  });

  it('never links to a candidate group without an explicit "Use this group" click, and submits groupId (not productGroup) once one is chosen', async () => {
    const { createItemAction, findGroupCandidatesAction } = await import(
      '@/server/actions/inventory'
    );
    vi.mocked(createItemAction).mockResolvedValue({ ok: true, data: { id: 'item-1' } } as never);
    vi.mocked(findGroupCandidatesAction).mockResolvedValue({
      ok: true,
      data: [{ id: '77777777-7777-7777-7777-777777777777', name: 'Nike Pegasus 41 (existing)' }],
    } as never);

    renderForm({
      categories: [SHOES_CATEGORY],
      sportsEnabled: true,
      defaults: { name: 'Nike Pegasus 41', categoryId: SHOES_CATEGORY_ID, warehouseId: WAREHOUSE_ID },
      warehouses: [{ id: WAREHOUSE_ID, name: 'Main' }],
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Nike'), 'Nike');
    await user.type(screen.getByPlaceholderText('Pegasus 41'), 'Pegasus 41');

    // Candidates are advisory only — nothing links until the explicit click.
    // Before the click, the preview's "Product group" line still shows the
    // item's OWN typed name (distinct from the candidate's), proving the
    // candidate is a suggestion, not an automatic link.
    await waitFor(() =>
      expect(screen.getByText('Nike Pegasus 41 (existing)')).toBeInTheDocument(),
    );
    expect(screen.getByText('Nike Pegasus 41')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use this group' }));
    // After the explicit click, the candidate list clears and the preview
    // switches to the linked group's own name.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Use this group' })).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Nike Pegasus 41 (existing)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /create item/i }));
    await waitFor(() => expect(createItemAction).toHaveBeenCalledTimes(1));
    const [payload] = vi.mocked(createItemAction).mock.calls[0] as [Record<string, unknown>];
    expect(payload.groupId).toBe('77777777-7777-7777-7777-777777777777');
    expect(payload.productGroup).toBeUndefined();
  });
});

describe('ItemForm — size chips driven by sizeScales, existing apparel flow unchanged (Task 11)', () => {
  const SCALE_ID = '88888888-8888-8888-8888-888888888888';

  it('falls back to the nine apparel letters when the category carries no size_scale_id', () => {
    const category: Category = {
      id: PLAIN_CATEGORY_ID,
      name: 'Shirts',
      supports_sizes: true,
    };
    renderForm({ categories: [category], defaults: { categoryId: PLAIN_CATEGORY_ID } });

    for (const s of ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL']) {
      expect(screen.getByRole('button', { name: s })).toBeInTheDocument();
    }
  });

  it("renders the category's own size scale instead of the apparel letters when one is set", () => {
    const category: Category = {
      id: SHOES_CATEGORY_ID,
      name: 'Shoes',
      supports_sizes: true,
      size_scale_id: SCALE_ID,
    };
    renderForm({
      categories: [category],
      defaults: { categoryId: SHOES_CATEGORY_ID },
      sizeScales: {
        [SCALE_ID]: [
          { value: '9', isHalf: false },
          { value: '9.5', isHalf: true },
          { value: '10', isHalf: false },
        ],
      },
    });

    expect(screen.getByRole('button', { name: '9' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '9.5' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '10' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'XS' })).not.toBeInTheDocument();
  });

  it('still creates one bulk row per picked size — the existing supports_sizes flow is unchanged', async () => {
    const { bulkCreateSizedVariantsAction } = await import('@/server/actions/inventory');
    vi.mocked(bulkCreateSizedVariantsAction).mockResolvedValue({
      ok: true,
      data: { created: 2, ids: ['item-1', 'item-2'] },
    } as never);

    const category: Category = {
      id: PLAIN_CATEGORY_ID,
      name: 'Shirts',
      supports_sizes: true,
    };
    renderForm({
      categories: [category],
      defaults: { name: 'Team Tee', categoryId: PLAIN_CATEGORY_ID, warehouseId: WAREHOUSE_ID },
      warehouses: [{ id: WAREHOUSE_ID, name: 'Main' }],
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'S' }));
    await user.click(screen.getByRole('button', { name: 'M' }));
    await user.click(screen.getByRole('button', { name: /create item/i }));

    await waitFor(() => expect(bulkCreateSizedVariantsAction).toHaveBeenCalledTimes(1));
    const [payload] = vi.mocked(bulkCreateSizedVariantsAction).mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(payload.variants).toEqual([
      { size: 'S', quantity: 0 },
      { size: 'M', quantity: 0 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Task 11 review fixes.
// ---------------------------------------------------------------------------

describe('ItemForm — the SIZED bulk path carries the sports values (review finding 1)', () => {
  const SCALE_ID = '99999999-9999-9999-9999-999999999999';
  const SIZED_SHOES: Category = {
    id: SHOES_CATEGORY_ID,
    name: 'Shoes',
    supports_sizes: true,
    sports_subcategory_key: 'shoes',
    size_scale_id: SCALE_ID,
  };
  const SIZE_SCALES = {
    [SCALE_ID]: [
      { value: '9', isHalf: false },
      { value: '10', isHalf: false },
    ],
  };

  async function renderSizedShoesAndPickSizes(
    opts: { candidates?: Array<{ id: string; name: string }>; canManageSports?: boolean } = {},
  ) {
    const { bulkCreateSizedVariantsAction, findGroupCandidatesAction } = await import(
      '@/server/actions/inventory'
    );
    vi.mocked(bulkCreateSizedVariantsAction).mockResolvedValue({
      ok: true,
      data: { created: 2, ids: ['item-1', 'item-2'] },
    } as never);
    vi.mocked(findGroupCandidatesAction).mockResolvedValue({
      ok: true,
      data: opts.candidates ?? [],
    } as never);

    renderForm({
      categories: [SIZED_SHOES],
      sportsEnabled: true,
      canManageSports: opts.canManageSports ?? false,
      sizeScales: SIZE_SCALES,
      defaults: {
        name: 'Nike Pegasus 41',
        categoryId: SHOES_CATEGORY_ID,
        warehouseId: WAREHOUSE_ID,
      },
      warehouses: [{ id: WAREHOUSE_ID, name: 'Main' }],
    });

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: '9' }));
    await user.click(screen.getByRole('button', { name: '10' }));
    return { user, bulkCreateSizedVariantsAction };
  }

  it('sends the inline productGroup with the size run — the preview promised a group, so one must be saved', async () => {
    const { user, bulkCreateSizedVariantsAction } = await renderSizedShoesAndPickSizes();

    await user.type(screen.getByPlaceholderText('Nike'), 'Nike');
    await user.type(screen.getByPlaceholderText('Pegasus 41'), 'Pegasus 41');
    await user.click(screen.getByRole('button', { name: /create item/i }));

    await waitFor(() => expect(bulkCreateSizedVariantsAction).toHaveBeenCalledTimes(1));
    const [payload] = vi.mocked(bulkCreateSizedVariantsAction).mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(payload.variants).toEqual([
      { size: '9', quantity: 0 },
      { size: '10', quantity: 0 },
    ]);
    expect(payload.productGroup).toMatchObject({
      name: 'Nike Pegasus 41',
      brand: 'Nike',
      model: 'Pegasus 41',
    });
    expect(payload.groupId).toBeFalsy();
  });

  it('sends groupId (and no productGroup) with the size run once a candidate is explicitly linked', async () => {
    const { user, bulkCreateSizedVariantsAction } = await renderSizedShoesAndPickSizes({
      candidates: [
        { id: '77777777-7777-7777-7777-777777777777', name: 'Nike Pegasus 41 (existing)' },
      ],
    });
    await user.type(screen.getByPlaceholderText('Nike'), 'Nike');
    await user.type(screen.getByPlaceholderText('Pegasus 41'), 'Pegasus 41');
    await user.click(await screen.findByRole('button', { name: 'Use this group' }));
    await user.click(screen.getByRole('button', { name: /create item/i }));

    await waitFor(() => expect(bulkCreateSizedVariantsAction).toHaveBeenCalledTimes(1));
    const [payload] = vi.mocked(bulkCreateSizedVariantsAction).mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(payload.groupId).toBe('77777777-7777-7777-7777-777777777777');
    expect(payload.productGroup).toBeUndefined();
  });

  it('sends the authorized trackingModeOverride with the size run', async () => {
    const { user, bulkCreateSizedVariantsAction } = await renderSizedShoesAndPickSizes({
      canManageSports: true,
    });

    await pickFromSelect(user, screen.getByLabelText('Tracking mode'), 'Optional serial');
    await user.click(screen.getByRole('button', { name: /create item/i }));

    await waitFor(() => expect(bulkCreateSizedVariantsAction).toHaveBeenCalledTimes(1));
    const [payload] = vi.mocked(bulkCreateSizedVariantsAction).mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(payload.trackingModeOverride).toBe('OPTIONAL_SERIALIZED');
  });
});

describe('ItemForm — sports UI is create-only (review finding 2)', () => {
  it('renders neither the sports fields nor the grouping preview in EDIT mode', () => {
    renderForm({
      categories: [SHOES_CATEGORY],
      sportsEnabled: true,
      canManageSports: true,
      defaults: {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        name: 'Nike Pegasus 41',
        categoryId: SHOES_CATEGORY_ID,
      },
    });

    expect(screen.queryByTestId('sports-fields')).not.toBeInTheDocument();
    expect(screen.queryByText('This will be saved as')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Tracking mode')).not.toBeInTheDocument();
  });
});

describe('ItemForm — the authorized tracking-mode override (review finding 3)', () => {
  it('is hidden from a user without sports:manage', () => {
    renderForm({
      categories: [SHOES_CATEGORY],
      sportsEnabled: true,
      canManageSports: false,
      defaults: { categoryId: SHOES_CATEGORY_ID },
    });

    expect(screen.getByTestId('sports-fields')).toBeInTheDocument();
    expect(screen.queryByLabelText('Tracking mode')).not.toBeInTheDocument();
  });

  it('offers only the modes the subcategory allows, and feeds the preview + the payload', async () => {
    const { createItemAction, findGroupCandidatesAction } = await import(
      '@/server/actions/inventory'
    );
    vi.mocked(createItemAction).mockResolvedValue({ ok: true, data: { id: 'item-1' } } as never);
    vi.mocked(findGroupCandidatesAction).mockResolvedValue({ ok: true, data: [] } as never);

    renderForm({
      categories: [SHOES_CATEGORY],
      sportsEnabled: true,
      canManageSports: true,
      defaults: {
        name: 'Nike Pegasus 41',
        categoryId: SHOES_CATEGORY_ID,
        warehouseId: WAREHOUSE_ID,
      },
      warehouses: [{ id: WAREHOUSE_ID, name: 'Main' }],
    });

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // Shoes allow QUANTITY_BY_VARIANT / QUANTITY / OPTIONAL_SERIALIZED — and
    // nothing else. SERIALIZED must not even be offered.
    await user.click(screen.getByLabelText('Tracking mode'));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).queryByRole('option', { name: 'Serialized' })).not.toBeInTheDocument();
    expect(
      within(listbox).queryByRole('option', { name: 'Individually tagged' }),
    ).not.toBeInTheDocument();
    await user.click(within(listbox).getByRole('option', { name: 'Optional serial' }));

    // The preview's serial line follows the override immediately.
    await waitFor(() => expect(screen.getByText('Serial: optional')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /create item/i }));
    await waitFor(() => expect(createItemAction).toHaveBeenCalledTimes(1));
    const [payload] = vi.mocked(createItemAction).mock.calls[0] as [Record<string, unknown>];
    expect(payload.trackingModeOverride).toBe('OPTIONAL_SERIALIZED');
  });
});

describe('ItemForm — the preview mirrors the SERVER variant key (review finding 4)', () => {
  it('leaves the player name out of the variant identity, exactly as the server key does', async () => {
    const { findGroupCandidatesAction } = await import('@/server/actions/inventory');
    vi.mocked(findGroupCandidatesAction).mockResolvedValue({ ok: true, data: [] } as never);

    renderForm({
      categories: [JERSEYS_CATEGORY],
      sportsEnabled: true,
      defaults: { name: 'Wildcats home', categoryId: JERSEYS_CATEGORY_ID },
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('e.g. Vega'), 'Vega');

    // A player name alone is NOT a variant: InventoryService.create() omits it
    // from buildVariantKey, so the preview must not promise otherwise.
    expect(screen.queryByText(/Player Vega/)).not.toBeInTheDocument();
    expect(screen.getByText('Single variant')).toBeInTheDocument();

    // A real variant attribute still shows up.
    await user.type(screen.getByPlaceholderText('e.g. 07'), '07');
    await waitFor(() => expect(screen.getByText('#07')).toBeInTheDocument());
  });
});

describe('ItemForm — the Sports-root block is module-gated (review finding 6)', () => {
  it('does not block submit for a Sports-root category when the module is OFF', async () => {
    const { createItemAction } = await import('@/server/actions/inventory');
    vi.mocked(createItemAction).mockResolvedValue({ ok: true, data: { id: 'item-1' } } as never);

    renderForm({
      categories: [SPORTS_ROOT, SPORTS_ROOT_CHILD],
      sportsEnabled: false,
      defaults: {
        name: 'Some item',
        categoryId: SPORTS_ROOT_ID,
        warehouseId: WAREHOUSE_ID,
      },
      warehouses: [{ id: WAREHOUSE_ID, name: 'Main' }],
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /create item/i }));

    await waitFor(() => expect(createItemAction).toHaveBeenCalledTimes(1));
  });
});

// ---------------------------------------------------------------------------
// Final-review wave C: Unit of measure initialized BLANK for every org after
// Task 8 dropped the schema's `.default('unit')` and this form's '' leaked out
// with it — a visible non-sports regression on the most-used create form.
// ---------------------------------------------------------------------------

describe('ItemForm — Unit of measure', () => {
  const uom = () => screen.getByPlaceholderText('unit, kg, lb, hr…') as HTMLInputElement;

  it("seeds 'unit' for a plain org, exactly as it did before the sports branch", () => {
    renderForm({ categories: [PLAIN_CATEGORY] });
    expect(uom().value).toBe('unit');
  });

  it("still reads 'unit' with a plain category selected", () => {
    renderForm({ categories: [PLAIN_CATEGORY], defaults: { categoryId: PLAIN_CATEGORY_ID } });
    expect(uom().value).toBe('unit');
  });

  it("shows the category's own counting unit rather than sending an explicit 'unit'", async () => {
    // The reason the blank existed: an explicit 'unit' WINS over the category
    // default on the server, so a shoes item would have been counted in units.
    // Showing 'pair' makes the stored value visible before submit instead.
    renderForm({
      categories: [SHOES_CATEGORY],
      sportsEnabled: true,
      defaults: { categoryId: SHOES_CATEGORY_ID },
    });
    await waitFor(() => expect(uom().value).toBe('pair'));
  });

  it('stops following the category once the user types a unit', async () => {
    const user = userEvent.setup();
    renderForm({ categories: [SHOES_CATEGORY], sportsEnabled: true });
    await user.clear(uom());
    await user.type(uom(), 'kg');
    // Selecting a category must not overwrite what the user typed.
    const categoryTrigger = screen
      .getAllByRole('combobox')
      .find((el) => el.textContent?.includes('Uncategorized'));
    await pickFromSelect(user, categoryTrigger!, /shoes/i);
    await waitFor(() => expect(uom().value).toBe('kg'));
  });

  it("keeps an EDIT form's stored unit untouched", () => {
    renderForm({
      categories: [SHOES_CATEGORY],
      sportsEnabled: true,
      defaults: {
        id: '77777777-7777-7777-7777-777777777777',
        categoryId: SHOES_CATEGORY_ID,
        unitOfMeasure: 'each',
      },
    });
    expect(uom().value).toBe('each');
  });
});
