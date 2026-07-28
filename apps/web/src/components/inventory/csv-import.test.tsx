import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Radix Select needs pointer-capture APIs happy-dom doesn't implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/import', () => ({
  importItemsAction: vi.fn(),
  prepareItemImportAction: vi.fn(),
}));

import { importItemsAction, prepareItemImportAction } from '@/server/actions/import';

/** The default server review: one clean row, nothing to confirm. */
function preview(over: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    data: {
      sportsEnabled: false,
      mappings: [
        { header: 'name', status: 'mapped', field: 'name', candidates: [] },
        { header: 'sku', status: 'mapped', field: 'sku', candidates: [] },
      ],
      unresolvedHeaders: [],
      rows: [
        {
          sourceRow: 2,
          name: 'Wireless Mouse',
          group: null,
          variant: null,
          quantity: '',
          result: 'ready',
          message: null,
        },
      ],
      duplicate: null,
      ...over,
    },
  };
}

import { CsvImport } from './csv-import';

/**
 * The CSV template's sports block is gated like every other sports surface.
 *
 * It shipped unconditionally, so an org with no sports module downloaded a
 * template naming jerseys, colorways and size systems it has no screens for —
 * and read a paragraph about product-group identity that means nothing to it.
 */

/** The generated CSV, captured off the object URL the download creates. */
function capturedCsv(): string {
  const blob = createdBlobs.at(-1);
  if (!blob) throw new Error('no template was generated');
  return blob;
}

let createdBlobs: string[] = [];

beforeEach(() => {
  createdBlobs = [];
  vi.clearAllMocks();
  vi.mocked(prepareItemImportAction).mockResolvedValue(preview() as never);
  // happy-dom has no Blob.text() sync path and no real object URLs; capture the
  // CSV as it is handed to URL.createObjectURL instead.
  const OriginalBlob = globalThis.Blob;
  vi.stubGlobal(
    'Blob',
    class extends OriginalBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        createdBlobs.push(String(parts[0] ?? ''));
      }
    },
  );
  // Patch the two statics on the REAL URL constructor — replacing the global
  // wholesale breaks happy-dom's own navigation ("URL is not a constructor").
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  // The anchor click would ask happy-dom to navigate to the blob URL.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

async function downloadTemplate(sportsEnabled: boolean) {
  const user = userEvent.setup();
  render(<CsvImport sportsEnabled={sportsEnabled} />);
  await user.click(screen.getByRole('button', { name: /download csv template/i }));
  return capturedCsv();
}

describe('CsvImport — the template is module-gated', () => {
  const SPORTS_COLUMNS = [
    'jersey_number',
    'player_name',
    'size_system',
    'colorway',
    'counting_unit',
    'tracking_mode',
    'asset_tag',
  ];

  it('offers no sports column to an org without the module', async () => {
    const csv = await downloadTemplate(false);
    const header = csv.split('\n')[0] ?? '';
    for (const col of SPORTS_COLUMNS) {
      expect(header, col).not.toContain(col);
    }
    // …while every column that predates the branch is still there, in order.
    expect(header).toContain('name');
    expect(header).toContain('unit_of_measure');
    expect(header).toContain('category_name');
    expect(header.trimEnd().endsWith('warehouse_name,location_name')).toBe(true);
  });

  it('offers the whole sports block once the module is on', async () => {
    const csv = await downloadTemplate(true);
    const header = csv.split('\n')[0] ?? '';
    for (const col of SPORTS_COLUMNS) {
      expect(header, col).toContain(col);
    }
    // The jersey sample row demonstrates the columns, so it ships with them.
    expect(csv).toContain('Falcons Home Jersey');
  });

  it('ships only the plain sample row to a non-sports org', async () => {
    const csv = await downloadTemplate(false);
    expect(csv).toContain('Wireless Mouse');
    expect(csv).not.toContain('Falcons Home Jersey');
  });

  it('names no sports column in the "applied on import" note when the module is off', () => {
    render(<CsvImport sportsEnabled={false} />);
    const note = screen.getByText(/Applied on import:/);
    expect(note.textContent).not.toMatch(/jersey_number|size_system|product group/i);
    render(<CsvImport sportsEnabled />);
    expect(screen.getAllByText(/Applied on import:/).at(-1)?.textContent).toMatch(
      /jersey_number/,
    );
  });
});

/**
 * The destination picker. `InventoryService.create()` demands a warehouse and
 * this screen never offered one, so every CSV row died on
 * "A warehouse must be selected before creating an item." — verified live in
 * Demo Co at 0 imported / 4 failed, twice.
 *
 * The picker names the DEFAULT for the file; the template's `warehouse_name`
 * column overrides it per row on the server.
 */
describe('CsvImport — the destination warehouse', () => {
  const WAREHOUSES = [
    { id: 'wh-main', name: 'Main Warehouse' },
    { id: 'wh-demo', name: 'Demo Distribution Center' },
  ];

  async function uploadOneRow(user: ReturnType<typeof userEvent.setup>) {
    const file = new File(['name,sku\nWireless Mouse,SP-MOUSE-001\n'], 'items.csv', {
      type: 'text/csv',
    });
    // happy-dom's File has no text(); the component awaits it.
    Object.defineProperty(file, 'text', {
      value: async () => 'name,sku\nWireless Mouse,SP-MOUSE-001\n',
    });
    await user.upload(document.getElementById('csv-upload') as HTMLInputElement, file);
  }

  it('sends the chosen warehouse with the import', async () => {
    vi.mocked(importItemsAction).mockResolvedValue({
      ok: true,
      data: { total: 1, created: 1, failed: 0, errors: [] },
    } as never);
    const user = userEvent.setup();
    render(<CsvImport sportsEnabled={false} warehouses={WAREHOUSES} forcedWarehouseId={null} />);
    await uploadOneRow(user);
    await user.click(screen.getByRole('button', { name: /import 1 item/i }));

    expect(importItemsAction).toHaveBeenCalledWith(
      expect.objectContaining({ warehouseId: 'wh-main' }),
    );
  });

  it('locks the picker to the assignment of a warehouse-scoped user', () => {
    render(
      <CsvImport sportsEnabled={false} warehouses={WAREHOUSES} forcedWarehouseId="wh-demo" />,
    );
    expect(screen.getByRole('combobox').getAttribute('data-disabled')).not.toBeNull();
  });

  it('says the warehouse_name column is applied, because it now is', () => {
    render(<CsvImport sportsEnabled={false} warehouses={WAREHOUSES} forcedWarehouseId={null} />);
    expect(screen.getByText(/Applied on import:/).textContent).toMatch(/warehouse_name/);
  });

  it('an org with no warehouses cannot start an import it could only fail', async () => {
    const user = userEvent.setup();
    render(<CsvImport sportsEnabled={false} warehouses={[]} forcedWarehouseId={null} />);
    await uploadOneRow(user);
    expect(
      screen.getByRole('button', { name: /import 1 item/i }).hasAttribute('disabled'),
    ).toBe(true);
    expect(importItemsAction).not.toHaveBeenCalled();
  });
});

/**
 * LIVE-VERIFIED FAIL (Demo Co, 2026-07-28, report lines 10 + 11).
 *
 * The review table's headers were literally the file's first eight CSV columns
 * (`NAME | SKU | BARCODE | …`) with "no Group column, no Variant column, no
 * per-row Result column"; an extra column headed `Number` was echoed once and
 * then silently ignored with Import enabled immediately; and a byte-identical
 * re-upload produced no duplicate warning at all.
 */
async function upload(user: ReturnType<typeof userEvent.setup>, text = 'name,sku\nWireless Mouse,SP-MOUSE-001\n') {
  const file = new File([text], 'items.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: async () => text });
  await user.upload(document.getElementById('csv-upload') as HTMLInputElement, file);
}

const WH = [{ id: 'wh-main', name: 'Main Warehouse' }];

describe('CsvImport — the review table says what will happen', () => {
  it('REGRESSION: the table headers are review columns, not the file’s raw headers', async () => {
    const user = userEvent.setup();
    render(<CsvImport sportsEnabled={false} warehouses={WH} />);
    await upload(user);

    const table = await screen.findByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((th) => th.textContent?.trim().toLowerCase());
    expect(headers).toContain('result');
    expect(headers).not.toContain('barcode');
    expect(headers).not.toContain('unit_cost');
  });

  it('renders the per-row Result label from the shared vocabulary', async () => {
    vi.mocked(prepareItemImportAction).mockResolvedValue(
      preview({
        rows: [
          {
            sourceRow: 2,
            name: 'No Name Row',
            group: null,
            variant: null,
            quantity: '',
            result: 'missing_required_attribute',
            message: 'This row has no name. Every item needs one.',
          },
        ],
      }) as never,
    );
    const user = userEvent.setup();
    render(<CsvImport sportsEnabled={false} warehouses={WH} />);
    await upload(user);

    // The Task 14 label, not "Invalid".
    expect(await screen.findByText('Missing attribute')).toBeTruthy();
  });

  it('shows Group and Variant columns to a sports org', async () => {
    vi.mocked(prepareItemImportAction).mockResolvedValue(
      preview({
        sportsEnabled: true,
        rows: [
          {
            sourceRow: 2,
            name: 'Pegasus 41',
            group: 'Nike Pegasus 41',
            variant: 'Size 10',
            quantity: '4',
            result: 'add_new_variant',
            message: null,
          },
        ],
      }) as never,
    );
    const user = userEvent.setup();
    render(<CsvImport sportsEnabled warehouses={WH} />);
    await upload(user);

    const table = await screen.findByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((th) => th.textContent?.trim().toLowerCase());
    expect(headers).toContain('group');
    expect(headers).toContain('variant');
    expect(screen.getByText('Nike Pegasus 41')).toBeTruthy();
    expect(screen.getByText('Size 10')).toBeTruthy();
  });

  it('shows NO group or variant column to an org without the module', async () => {
    const user = userEvent.setup();
    render(<CsvImport sportsEnabled={false} warehouses={WH} />);
    await upload(user);

    const table = await screen.findByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((th) => th.textContent?.trim().toLowerCase());
    expect(headers).not.toContain('group');
    expect(headers).not.toContain('variant');
  });
});

describe('CsvImport — an ambiguous column must be confirmed', () => {
  const ambiguousPreview = preview({
    sportsEnabled: true,
    mappings: [
      { header: 'name', status: 'mapped', field: 'name', candidates: [] },
      {
        header: 'Number',
        status: 'ambiguous',
        field: null,
        candidates: ['jersey_number', 'quantity', 'serial', 'style_number', 'ignore'],
      },
    ],
    unresolvedHeaders: ['Number'],
    rows: [
      {
        sourceRow: 2,
        name: 'Falcons Jersey',
        group: null,
        variant: null,
        quantity: '',
        result: 'mapping_review_required',
        message: 'Confirm what the highlighted column means before importing.',
      },
    ],
  });

  it('PROBE: names the ambiguous column and blocks Import until it is answered', async () => {
    vi.mocked(prepareItemImportAction).mockResolvedValue(ambiguousPreview as never);
    const user = userEvent.setup();
    render(<CsvImport sportsEnabled warehouses={WH} />);
    await upload(user, 'name,Number\nFalcons Jersey,07\n');

    expect(await screen.findByText(/Confirm what 1 column means/i)).toBeTruthy();
    const importBtn = screen.getByRole('button', { name: /import 1 item/i });
    expect(importBtn.hasAttribute('disabled')).toBe(true);
    expect(importItemsAction).not.toHaveBeenCalled();
  });

  it('offers the candidate meanings rather than guessing one', async () => {
    vi.mocked(prepareItemImportAction).mockResolvedValue(ambiguousPreview as never);
    const user = userEvent.setup();
    render(<CsvImport sportsEnabled warehouses={WH} />);
    await upload(user, 'name,Number\nFalcons Jersey,07\n');

    await user.click(await screen.findByRole('combobox', { name: /Number/i }));
    expect(await screen.findByRole('option', { name: 'Jersey / uniform number' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Quantity' })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Ignore/ })).toBeTruthy();
  });

  it('sends the answer with the import once the column is confirmed', async () => {
    vi.mocked(prepareItemImportAction)
      .mockResolvedValueOnce(ambiguousPreview as never)
      // Re-reviewed with the answer applied: nothing outstanding any more.
      .mockResolvedValue(
        preview({
          sportsEnabled: true,
          unresolvedHeaders: [],
          mappings: ambiguousPreview.data.mappings,
          rows: [
            {
              sourceRow: 2,
              name: 'Falcons Jersey',
              group: null,
              variant: '#07',
              quantity: '',
              result: 'add_new_variant',
              message: null,
            },
          ],
        }) as never,
      );
    vi.mocked(importItemsAction).mockResolvedValue({
      ok: true,
      data: { total: 1, created: 1, failed: 0, errors: [] },
    } as never);

    const user = userEvent.setup();
    render(<CsvImport sportsEnabled warehouses={WH} />);
    await upload(user, 'name,Number\nFalcons Jersey,07\n');

    await user.click(await screen.findByRole('combobox', { name: /Number/i }));
    await user.click(await screen.findByRole('option', { name: 'Jersey / uniform number' }));

    const importBtn = await screen.findByRole('button', { name: /import 1 item/i });
    await waitFor(() => expect(importBtn.hasAttribute('disabled')).toBe(false));
    await user.click(importBtn);

    expect(importItemsAction).toHaveBeenCalledWith(
      expect.objectContaining({ headerDecisions: { Number: 'jersey_number' } }),
    );
  });
});

describe('CsvImport — the same file, uploaded twice', () => {
  const dupPreview = preview({
    duplicate: {
      batchId: 'batch-0',
      fileName: 'items.csv',
      rowCount: 4,
      createdCount: 4,
      importedAt: '2026-07-28T10:00:00.000Z',
    },
  });

  it('PROBE: warns that the file was already imported and blocks Import', async () => {
    vi.mocked(prepareItemImportAction).mockResolvedValue(dupPreview as never);
    const user = userEvent.setup();
    render(<CsvImport sportsEnabled={false} warehouses={WH} />);
    await upload(user);

    expect(await screen.findByText(/already imported/i)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /import 1 item/i }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('requires an explicit override, then sends it — a hash is never a dead end', async () => {
    vi.mocked(prepareItemImportAction).mockResolvedValue(dupPreview as never);
    vi.mocked(importItemsAction).mockResolvedValue({
      ok: true,
      data: { total: 1, created: 1, failed: 0, errors: [] },
    } as never);
    const user = userEvent.setup();
    render(<CsvImport sportsEnabled={false} warehouses={WH} />);
    await upload(user);

    await user.click(await screen.findByRole('checkbox', { name: /import it again/i }));
    const importBtn = screen.getByRole('button', { name: /import 1 item/i });
    await waitFor(() => expect(importBtn.hasAttribute('disabled')).toBe(false));
    await user.click(importBtn);

    expect(importItemsAction).toHaveBeenCalledWith(
      expect.objectContaining({ acknowledgeDuplicate: true }),
    );
  });

  it('says nothing about duplicates when the file is new', async () => {
    const user = userEvent.setup();
    render(<CsvImport sportsEnabled={false} warehouses={WH} />);
    await upload(user);

    await screen.findByRole('table');
    expect(screen.queryByText(/already imported/i)).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /import it again/i })).toBeNull();
  });
});

describe('CsvImport — the upload guard knows the mapping vocabulary', () => {
  it('accepts a file whose name column is headed "Item Name"', async () => {
    const user = userEvent.setup();
    render(<CsvImport sportsEnabled={false} warehouses={WH} />);
    await upload(user, 'Item Name,SKU\nWireless Mouse,SP-1\n');

    // It reached review rather than being refused for want of a literal
    // `name` header — the alias IS a name column.
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(prepareItemImportAction).toHaveBeenCalled();
  });

  it('still refuses a file with no name column at all', async () => {
    const user = userEvent.setup();
    render(<CsvImport sportsEnabled={false} warehouses={WH} />);
    await upload(user, 'colour,weight\nred,4\n');

    expect(prepareItemImportAction).not.toHaveBeenCalled();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('CsvImport — no review, no import', () => {
  it('keeps Import disabled when the server review failed', async () => {
    vi.mocked(prepareItemImportAction).mockResolvedValue({
      ok: false,
      error: { code: 'internal_error', message: 'Review unavailable' },
    } as never);
    const user = userEvent.setup();
    render(<CsvImport sportsEnabled={false} warehouses={WH} />);
    await upload(user);

    const importBtn = await screen.findByRole('button', { name: /import 1 item/i });
    expect(importBtn.hasAttribute('disabled')).toBe(true);
    await user.click(importBtn);
    expect(importItemsAction).not.toHaveBeenCalled();
  });
});
