import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

const downloadSpy = vi.fn(async (..._args: unknown[]) => {});
const previewSpy = vi.fn(async (..._args: unknown[]) => ({
  total: 111,
  truncated: false,
  slug: 'books' as const,
  sampleRows: [],
  readiness: { rows: 111, withIsbn: 97, missingIsbn: 14, withImage: 84, missingImage: 27 },
}));
vi.mock('@/lib/download-export', () => ({
  downloadInventoryExport: (...a: unknown[]) => downloadSpy(...a),
  fetchExportPreview: (...a: unknown[]) => previewSpy(...a),
}));

import { ExportBuilderDialog } from './export-builder-dialog';

function renderDialog(overrides: Partial<Parameters<typeof ExportBuilderDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  render(
    <ExportBuilderDialog
      open
      onOpenChange={onOpenChange}
      scope="filtered"
      itemType="book"
      filters={{ q: 'algebra' }}
      rowCountHint={111}
      {...overrides}
    />,
  );
  return { onOpenChange };
}

beforeEach(() => {
  downloadSpy.mockClear();
  previewSpy.mockClear();
  toastError.mockClear();
  window.localStorage.clear();
});

describe('ExportBuilderDialog — chrome', () => {
  it('is titled "Customize export" with the books description', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Customize export' })).toBeTruthy();
    expect(
      screen.getByText(
        'Choose the file format, book information, images, and layout to include in your export.',
      ),
    ).toBeTruthy();
  });

  it('uses the inventory wording for an items export', () => {
    renderDialog({ itemType: 'product' });
    expect(
      screen.getByText(
        'Choose the file format, inventory information, images, and layout to include in your export.',
      ),
    ).toBeTruthy();
  });

  it('states the scope in the brief\'s words', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText('Exporting: 111 filtered books')).toBeTruthy());
  });

  it('states a selected scope with the count', () => {
    renderDialog({ scope: 'selected', itemType: 'product', selectedIds: ['a', 'b'], rowCountHint: 2 });
    expect(screen.getByText('Exporting: 2 selected items')).toBeTruthy();
  });
});

describe('ExportBuilderDialog — format selection', () => {
  it('offers the three formats with the brief descriptions', () => {
    renderDialog();
    const group = screen.getByRole('radiogroup', { name: /file format/i });
    expect(
      within(group).getByText(
        'Formatted document for printing, sharing, and visual inventory reviews.',
      ),
    ).toBeTruthy();
    expect(
      within(group).getByText(
        'Editable spreadsheet with filters, formatting, column widths, and optional images.',
      ),
    ).toBeTruthy();
    expect(
      within(group).getByText(
        'Simple data file for imports, databases, and spreadsheet applications.',
      ),
    ).toBeTruthy();
  });

  it('starts on PDF and switches on click', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getByRole('radio', { name: /PDF/ })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: /CSV/ }));
    expect(screen.getByRole('radio', { name: /CSV/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('shows PDF layout options only for PDF, and Excel options only for Excel', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getByLabelText('Paper size')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: /Excel/ }));
    expect(screen.queryByLabelText('Paper size')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Include summary sheet' })).toBeTruthy();
  });

  it('labels the CSV image option "Include image URL", never "Include images"', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('radio', { name: /CSV/ }));
    expect(screen.getByRole('checkbox', { name: 'Include image URL' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Include cover images' })).toBeNull();
  });

  it('defaults cover images ON for a books PDF and OFF for an items PDF', () => {
    renderDialog();
    expect(screen.getByRole('checkbox', { name: 'Include cover images' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    window.localStorage.clear();
    renderDialog({ itemType: 'product' });
    const boxes = screen.getAllByRole('checkbox', { name: 'Include images' });
    expect(boxes.at(-1)).toHaveAttribute('aria-checked', 'false');
  });
});

describe('ExportBuilderDialog — presets', () => {
  it('lists the built-in presets for the item type', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('combobox', { name: /preset/i }));
    expect(screen.getByRole('option', { name: 'Books ISBN list' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Reorder report' })).toBeNull();
  });

  it('applying a preset replaces the field selection', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('combobox', { name: /preset/i }));
    await user.click(screen.getByRole('option', { name: 'Books ISBN list' }));
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await waitFor(() => expect(downloadSpy).toHaveBeenCalled());
    const req = downloadSpy.mock.calls[0]![0] as { fields: string[]; options: { presetName: string } };
    expect(req.fields).toEqual(['name', 'isbn', 'sku', 'author', 'grade', 'quantity_on_hand']);
    expect(req.options.presetName).toBe('Books ISBN list');
  });
});

describe('ExportBuilderDialog — submission', () => {
  it('posts the chosen scope, filters, fields and options', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await waitFor(() => expect(downloadSpy).toHaveBeenCalledTimes(1));
    const req = downloadSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(req.scope).toBe('filtered');
    expect(req.itemType).toBe('book');
    expect(req.filters).toEqual({ q: 'algebra' });
    expect((req.fields as string[])[0]).toBe('image');
  });

  it('prevents a duplicate submission while one is in flight', async () => {
    const user = userEvent.setup();
    // Definite-assignment `let x!: T`, not `T | null`, matching the house
    // idiom for a manually-held mock promise (count-item-picker.test.tsx's
    // `releaseStale`) — `T | null` narrows to `never` at the call site under
    // this repo's strict tsconfig, since TypeScript's control-flow analysis
    // doesn't credit the reassignment happening inside the Promise executor
    // closure below.
    let release!: () => void;
    downloadSpy.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderDialog();
    const button = screen.getByRole('button', { name: 'Export file' });
    await user.click(button);
    expect(button).toHaveProperty('disabled', true);
    await user.click(button);
    expect(downloadSpy).toHaveBeenCalledTimes(1);
    release();
  });

  it('announces the stage it is actually in, with no fake percentage', async () => {
    const user = userEvent.setup();
    // A manually-held promise, same idiom as "prevents a duplicate
    // submission" above: `await user.click(...)` flushes act()'s microtask
    // queue AND drains any already-scheduled real timers before its own
    // promise settles, so a plain `setTimeout(0)` inside the mock resolves —
    // and the dialog's `finally` clears `stage` back to null — before this
    // test ever gets to look. Holding the promise open until we explicitly
    // release it is the only way to observe the "preparing" render without
    // guessing at timing.
    let release!: () => void;
    downloadSpy.mockImplementationOnce(async (_req: unknown, opts: unknown) => {
      (opts as { onStage: (s: string) => void }).onStage('preparing');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Preparing 111 books'),
    );
    expect(screen.getByRole('status').textContent).not.toMatch(/\d+%/);
    release();
  });

  it('keeps every setting and shows the error INSIDE the dialog when the export fails', async () => {
    const user = userEvent.setup();
    downloadSpy.mockRejectedValueOnce(new Error('Too many exports — please wait a few minutes.'));
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole('radio', { name: /CSV/ }));
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Too many exports'),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole('radio', { name: /CSV/ })).toHaveAttribute('aria-checked', 'true');
    // And it can be retried without rebuilding anything.
    expect(screen.getByRole('button', { name: 'Export file' })).toHaveProperty('disabled', false);
  });

  it('closes on success', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('blocks export and explains why when no identifying field is selected', async () => {
    const user = userEvent.setup();
    renderDialog();
    // The default books preset carries three identifying fields (Title,
    // ISBN, SKU) — uncheck all three via the real field-picker checkboxes
    // Task 15 built, leaving none.
    await user.click(screen.getByRole('checkbox', { name: 'Title' }));
    await user.click(screen.getByRole('checkbox', { name: 'ISBN' }));
    await user.click(screen.getByRole('checkbox', { name: 'SKU' }));
    expect(screen.getByRole('alert').textContent).toContain(
      'Include at least one identifying field: Name, SKU, ISBN or Barcode.',
    );
    expect(screen.getByRole('button', { name: 'Export file' })).toHaveProperty('disabled', true);
  });
});
