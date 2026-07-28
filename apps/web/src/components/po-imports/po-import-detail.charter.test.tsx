import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Radix Select needs pointer-capture APIs happy-dom doesn't implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const approvePoImportAction = vi.fn();
const createItemsFromPoLinesAction = vi.fn();
const findDuplicatesForPoLinesAction = vi.fn();

vi.mock('@/server/actions/po-imports', () => ({
  approvePoImportAction: (...args: unknown[]) => approvePoImportAction(...args),
  cancelPoImportAction: vi.fn(),
  parsePoImportAction: vi.fn(),
  createItemsFromPoLinesAction: (...args: unknown[]) => createItemsFromPoLinesAction(...args),
  findDuplicatesForPoLinesAction: (...args: unknown[]) => findDuplicatesForPoLinesAction(...args),
  resolvePoImportLineResultsAction: vi.fn(async () => ({ ok: true, data: {} })),
}));

import { PoImportDetail, type LineWithSuggestion } from './po-import-detail';

import type { ComponentProps } from 'react';

import type { PoImportLineRow, PoImportRow } from '@/server/services/po-imports';

const HEADER: PoImportRow = {
  id: 'imp-1',
  organization_id: 'org-1',
  uploaded_by: 'user-1',
  source_type: 'csv',
  extraction_confidence: null,
  extraction_model: null,
  vendor_id: null,
  warehouse_id: null,
  file_name: 'po.csv',
  file_mime_type: 'text/csv',
  file_size: 2048,
  storage_path: 'imports/po.csv',
  sha256: 'abc',
  status: 'parsed',
  parse_error: null,
  approved_po_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as PoImportRow;

const CHARTERS = [
  { id: 'chr-kva', name: 'KVA' },
  { id: 'chr-bill', name: 'Bill Co' },
];
const LOCATIONS = [{ id: 'loc-1', name: 'Dock A', warehouseId: 'wh-1' }];

// Plain unmapped inventory line (no suggestion at all).
const PLAIN_LINE: PoImportLineRow = {
  id: 'l-plain',
  po_import_id: 'imp-1',
  line_number: 1,
  line_type: 'inventory',
  qty_ordered_original: 5,
  uom_original: 'EA',
  description: 'Blue Widget carton',
  unit_cost: 2,
  line_total: 10,
  vendor_item_number: 'V-BW-1',
  vendor_product_number: null,
  auxiliary_number: null,
  coa_code: null,
  item_id: null,
  suggested_item_id: null,
  match_status: 'needs_review',
  match_confidence: null,
  extraction_confidence: null,
  exception_reason: null,
  // Sports variant columns (0301) — null on a non-sports import, which is
  // every line these tests exercise.
  variant_size: null,
  variant_size_original: null,
  variant_size_system: null,
  variant_width: null,
  variant_fit: null,
  variant_color: null,
  jersey_number: null,
  player_name: null,
  group_hint: null,
  serial_hint: null,
  suggested_group_id: null,
  mapping_confidence: null,
} as PoImportLineRow;

// Arrived with an advisory match (barcode/ISBN/vendor-mapping hit) but the
// user has NOT accepted it — item_id stays null, so it's still unresolved.
// This is the case Task 5 must prove reaches the create flow (and the
// chosen item-charter) exactly like any other unmapped line.
const SUGGESTED_LINE: LineWithSuggestion = {
  id: 'l-suggested',
  po_import_id: 'imp-1',
  line_number: 2,
  line_type: 'inventory',
  qty_ordered_original: 10,
  uom_original: 'EA',
  description: 'Chromebook 11 G9',
  unit_cost: 200,
  line_total: 2000,
  vendor_item_number: 'V-CB-1',
  vendor_product_number: null,
  auxiliary_number: null,
  coa_code: null,
  item_id: null,
  suggested_item_id: 'itm-cvw',
  suggestionLabel: 'Chromebook · SKU-X · CVW',
  match_status: 'suggested',
  match_confidence: null,
  extraction_confidence: null,
  exception_reason: null,
  // Sports variant columns (0301) — null on a non-sports import, which is
  // every line these tests exercise.
  variant_size: null,
  variant_size_original: null,
  variant_size_system: null,
  variant_width: null,
  variant_fit: null,
  variant_color: null,
  jersey_number: null,
  player_name: null,
  group_hint: null,
  serial_hint: null,
  suggested_group_id: null,
  mapping_confidence: null,
};

const MAPPED_LINE: PoImportLineRow = {
  ...PLAIN_LINE,
  id: 'l-mapped',
  item_id: 'itm-mapped',
  match_status: 'mapped',
} as PoImportLineRow;

type DetailItems = ComponentProps<typeof PoImportDetail>['items'];

const ITEMS: DetailItems = [
  { id: 'itm-cvw', sku: 'SKU-X', name: 'Chromebook', quantityOnHand: 500, createdAt: '2024-01-01T00:00:00Z' },
  { id: 'itm-mapped', sku: 'BW-01', name: 'Blue Widget', quantityOnHand: 250, createdAt: '2024-01-01T00:00:00Z' },
];

function renderDetail(lines: LineWithSuggestion[]) {
  return render(
    <PoImportDetail
      header={HEADER}
      lines={lines}
      suppliers={[{ id: 'sup-1', name: 'Acme' }]}
      warehouses={[{ id: 'wh-1', name: 'Main' }]}
      charters={CHARTERS}
      locations={LOCATIONS}
      items={ITEMS}
    />,
  );
}

/** Finds a Radix Select trigger by its rendered text (value or placeholder). */
function getSelectTrigger(text: RegExp): HTMLElement {
  const trigger = screen
    .getAllByRole('combobox')
    .find((el) => text.test(el.textContent ?? ''));
  if (!trigger) throw new Error(`No select trigger showing ${String(text)}`);
  return trigger;
}

/** The two charter Selects both start as "No charter" — disambiguate by the
 *  field label they sit next to instead of by trigger text. */
function getSelectTriggerByLabel(labelText: RegExp): HTMLElement {
  const label = screen.getByText(labelText);
  const container = label.parentElement;
  if (!container) throw new Error(`No container for label matching ${String(labelText)}`);
  const trigger = within(container).queryByRole('combobox');
  if (!trigger) throw new Error(`No select trigger under label ${String(labelText)}`);
  return trigger;
}

async function pickFromTrigger(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement,
  optionName: string | RegExp,
) {
  await user.click(trigger);
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: optionName }));
}

async function pickFromSelect(
  user: ReturnType<typeof userEvent.setup>,
  triggerText: RegExp,
  optionName: string | RegExp,
) {
  await pickFromTrigger(user, getSelectTrigger(triggerText), optionName);
}

describe('PoImportDetail charter routing (item-charter -> create, bill-to -> approve)', () => {
  it('applies the chosen item-charter to createItemsFromPoLinesAction for EVERY created line, including a suggested-but-unaccepted one', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    findDuplicatesForPoLinesAction.mockResolvedValue({ ok: true, data: { matches: {} } });
    createItemsFromPoLinesAction.mockResolvedValue({
      ok: true,
      data: { created: 2, mapped: 0, linked: 0, skipped: 0 },
    });

    renderDetail([PLAIN_LINE, SUGGESTED_LINE]);

    // Vendor is required before the create-items flow will open.
    await pickFromSelect(user, /pick vendor/i, 'Acme');

    // Pick the item-charter — distinct from the bill-to charter picked below.
    await pickFromTrigger(user, getSelectTriggerByLabel(/charter for items/i), 'KVA');
    await pickFromTrigger(user, getSelectTriggerByLabel(/bill to charter/i), 'Bill Co');

    // Both lines are still unresolved (SUGGESTED_LINE's suggestion was never
    // accepted), so the bulk banner must offer to create BOTH of them —
    // suggested-but-unaccepted lines must not be excluded from this set.
    const createButton = await screen.findByRole('button', { name: /create 2 as new items/i });
    await user.click(createButton);

    await screen.findByText(/review 2 lines from po/i);
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(createItemsFromPoLinesAction).toHaveBeenCalledTimes(1);
    const call = createItemsFromPoLinesAction.mock.calls[0]![0] as {
      charterId: string | null;
      lineIds: string[];
    };
    expect(call.charterId).toBe('chr-kva');
    expect(new Set(call.lineIds)).toEqual(new Set(['l-plain', 'l-suggested']));
  });

  it('sends the bill-to charter to approvePoImportAction — never the item charter', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    approvePoImportAction.mockResolvedValue({ ok: true, data: { poId: 'po-1' } });

    renderDetail([MAPPED_LINE]);

    await pickFromSelect(user, /pick vendor/i, 'Acme');
    await pickFromSelect(user, /pick warehouse/i, 'Main');
    await pickFromSelect(user, /pick a location/i, 'Dock A');
    await pickFromTrigger(user, getSelectTriggerByLabel(/charter for items/i), 'KVA');
    await pickFromTrigger(user, getSelectTriggerByLabel(/bill to charter/i), 'Bill Co');

    await user.click(screen.getByRole('button', { name: /review & approve/i }));
    await screen.findByText(/approve this import\?/i);
    await user.click(screen.getByRole('button', { name: /approve & create po/i }));

    expect(approvePoImportAction).toHaveBeenCalledTimes(1);
    const call = approvePoImportAction.mock.calls[0]![0] as {
      charterId: string | null;
      itemCharterId?: string | null;
    };
    // Bill-to charter reaches purchase_orders.charter_id...
    expect(call.charterId).toBe('chr-bill');
    // ...and the item-charter (a distinct value) is never the value sent.
    expect(call.charterId).not.toBe('chr-kva');
    // The ownership charter now travels to approve() too, on its OWN key.
    // (This line previously asserted `not.toHaveProperty('itemCharterId')` —
    // it was pinning the defect: because the ownership choice never reached
    // approve, the server had nothing to use and fell back to the bill-to
    // value, silently re-chartering the stock. Two independent keys, carrying
    // two independent values, is the stronger contract.)
    expect(call.itemCharterId).toBe('chr-kva');
  });

  it('omits itemCharterId entirely when the ownership select is left on "Keep" — a bill-to pick alone rewrites no ownership', async () => {
    // The reported field failure, at the form layer: the user chooses who to
    // bill and never touches the ownership control. Before the fix, the empty
    // ownership state was simply absent from the payload and the server fell
    // back to the bill-to charter, re-chartering every item to it. Doing
    // nothing must stay the harmless path (B3).
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    approvePoImportAction.mockResolvedValue({ ok: true, data: { poId: 'po-1' } });

    renderDetail([MAPPED_LINE]);

    await pickFromSelect(user, /pick vendor/i, 'Acme');
    await pickFromSelect(user, /pick warehouse/i, 'Main');
    await pickFromSelect(user, /pick a location/i, 'Dock A');
    await pickFromTrigger(user, getSelectTriggerByLabel(/bill to charter/i), 'Bill Co');

    await user.click(screen.getByRole('button', { name: /review & approve/i }));
    await screen.findByText(/approve this import\?/i);
    await user.click(screen.getByRole('button', { name: /approve & create po/i }));

    const call = approvePoImportAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.charterId).toBe('chr-bill');
    // Absent, not null: null would be an explicit "move ownership to Generic".
    expect(call).not.toHaveProperty('itemCharterId');
    // Operational placement came from the operational field, not the billing one.
    expect(call.locationId).toBe('loc-1');
  });

  it('sends itemCharterId: null when the user explicitly picks "No charter (Generic)"', async () => {
    // Distinct from "Keep": this is a real ownership decision and must reach
    // the server as one, so approve() moves ownership to Generic on purpose.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    approvePoImportAction.mockResolvedValue({ ok: true, data: { poId: 'po-1' } });

    renderDetail([MAPPED_LINE]);

    await pickFromSelect(user, /pick vendor/i, 'Acme');
    await pickFromSelect(user, /pick warehouse/i, 'Main');
    await pickFromSelect(user, /pick a location/i, 'Dock A');
    await pickFromTrigger(
      user,
      getSelectTriggerByLabel(/charter for items/i),
      /no charter \(generic\)/i,
    );

    await user.click(screen.getByRole('button', { name: /review & approve/i }));
    await screen.findByText(/approve this import\?/i);
    await user.click(screen.getByRole('button', { name: /approve & create po/i }));

    const call = approvePoImportAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(call).toHaveProperty('itemCharterId');
    expect(call.itemCharterId).toBeNull();
  });
});
