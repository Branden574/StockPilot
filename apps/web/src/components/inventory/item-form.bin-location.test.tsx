import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Movement/Activity P3 task 3 — data-loss bug fix.
//
// Repro (caught live via the audit diff drawer in Demo Co): item
// "Dell XPS 13 Laptop" had bin_location = "D2" (set manually / by CSV
// import / by put-away stamping — NOT rack-derived) and EMPTY rack
// number/row. Editing an unrelated field (reorder point 8 -> 12) on the
// item EDIT form silently wiped bin_location to null, because the
// non-book submit-merge branch in item-form.tsx unconditionally set
// `binLocation: composedBin`, and composedBin is null whenever the rack
// number input is empty — regardless of whether the rack inputs were
// ever touched this session.
//
// Required semantics (dirty-tracking against the rack inputs' values at
// mount, since rack number/row are plain useState, not registered RHF
// fields with dirtyFields support):
//   1. Rack fields SET (non-empty) -> compose + submit the rack-derived
//      bin label.
//   2. Rack fields CLEARED this session (defaults HAD rack values, now
//      empty) -> submit the cleared/derived value so the stale rack
//      label actually clears.
//   3. Rack fields UNTOUCHED AND empty (defaults had NO rack values —
//      the Dell XPS case) -> do NOT overwrite bin_location; omit it
//      from the patch entirely.
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
}));

vi.mock('@/server/actions/item-images', () => ({
  createImageUploadAction: vi.fn(),
  recordImageAction: vi.fn(),
}));

vi.mock('@/server/actions/tags', () => ({
  setItemTagsAction: vi.fn(),
}));

import { ItemForm } from './item-form';

function renderForm(defaults?: Parameters<typeof ItemForm>[0]['defaults']) {
  return render(
    <ItemForm
      defaults={defaults}
      categories={[]}
      locations={[]}
      suppliers={[]}
      warehouses={[]}
      warehouseCharters={[]}
      charters={[]}
      warehouseLabel="Warehouse"
      charterLabel="Charter"
    />,
  );
}

function getRackNumberInput(): HTMLInputElement {
  return screen.getByPlaceholderText('38') as HTMLInputElement;
}

function getRackRowInput(): HTMLInputElement {
  return screen.getByPlaceholderText('A') as HTMLInputElement;
}

function getReorderPointInput(): HTMLInputElement {
  const field = screen.getByText('Reorder at').closest('div');
  const input = field?.querySelector('input');
  if (!input) throw new Error('Reorder at input not found');
  return input as HTMLInputElement;
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /save changes/i }));
}

describe('ItemForm — bin_location dirty-tracking (Movement/Activity P3 task 3)', () => {
  it('does NOT clear bin_location when an unrelated field is edited and rack inputs were never touched (Dell XPS repro)', async () => {
    const { updateItemAction } = await import('@/server/actions/inventory');
    vi.mocked(updateItemAction).mockResolvedValue({ ok: true, data: { id: 'item-1' } } as never);

    // Dell XPS 13 Laptop: bin_location = "D2", set outside the
    // rack-derivation flow (manually / CSV import / put-away stamping).
    // No rack_number / rack_row in custom_fields.
    renderForm({
      id: 'item-1',
      name: 'Dell XPS 13 Laptop',
      binLocation: 'D2',
      reorderPoint: 8,
      customFields: {},
    });

    const user = userEvent.setup();
    // Sanity: rack inputs render empty (defaults had no rack values).
    expect(getRackNumberInput().value).toBe('');
    expect(getRackRowInput().value).toBe('');

    // Edit ONLY the reorder point — rack inputs are never touched.
    const reorderInput = getReorderPointInput();
    await user.clear(reorderInput);
    await user.type(reorderInput, '12');
    await submit(user);

    expect(updateItemAction).toHaveBeenCalledTimes(1);
    const [, patch] = vi.mocked(updateItemAction).mock.calls[0] as [string, Record<string, unknown>];
    expect(patch.reorderPoint).toBe(12);
    // The bug: binLocation came back null/empty here, wiping "D2".
    // Required: either omit the key entirely, or pass the existing
    // value through unchanged — never null, never ''.
    expect(patch.binLocation === undefined || patch.binLocation === 'D2').toBe(true);
  });

  it('composes and submits the rack-derived bin label when rack fields are set', async () => {
    const { updateItemAction } = await import('@/server/actions/inventory');
    vi.mocked(updateItemAction).mockResolvedValue({ ok: true, data: { id: 'item-2' } } as never);

    renderForm({
      id: 'item-2',
      name: 'Widget',
      binLocation: '',
      customFields: {},
    });

    const user = userEvent.setup();
    await user.type(getRackNumberInput(), '12');
    await user.type(getRackRowInput(), 'b');
    await submit(user);

    expect(updateItemAction).toHaveBeenCalledTimes(1);
    const [, patch] = vi.mocked(updateItemAction).mock.calls[0] as [string, Record<string, unknown>];
    expect(patch.binLocation).toBe('12-B');
    expect((patch.customFields as Record<string, unknown>).rack_number).toBe('12');
    expect((patch.customFields as Record<string, unknown>).rack_row).toBe('B');
  });

  it('clears the stale rack-derived bin label when rack fields are cleared this session', async () => {
    const { updateItemAction } = await import('@/server/actions/inventory');
    vi.mocked(updateItemAction).mockResolvedValue({ ok: true, data: { id: 'item-3' } } as never);

    renderForm({
      id: 'item-3',
      name: 'Widget',
      binLocation: '5-C',
      customFields: { rack_number: '5', rack_row: 'C' },
    });

    const user = userEvent.setup();
    expect(getRackNumberInput().value).toBe('5');
    expect(getRackRowInput().value).toBe('C');

    await user.clear(getRackNumberInput());
    await user.clear(getRackRowInput());
    await submit(user);

    expect(updateItemAction).toHaveBeenCalledTimes(1);
    const [, patch] = vi.mocked(updateItemAction).mock.calls[0] as [string, Record<string, unknown>];
    expect(patch.binLocation).toBeNull();
    expect((patch.customFields as Record<string, unknown>).rack_number).toBeUndefined();
    expect((patch.customFields as Record<string, unknown>).rack_row).toBeUndefined();
  });
});
