import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/import', () => ({ importItemsAction: vi.fn() }));

import { importItemsAction } from '@/server/actions/import';

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
