import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';

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

// Shared presets (export_presets, migration 0338). Default: the feature is
// AVAILABLE but the org has none — the pre-0338 dialog plus the save
// affordance. Tests override sharedState per scenario.
type SharedPresetDto = {
  id: string;
  name: string;
  createdBy: string | null;
  createdAt: string;
  config: {
    itemTypeKind: 'book' | 'other';
    fieldKeys: string[];
    format?: 'csv' | 'xlsx' | 'pdf';
    options?: Record<string, unknown>;
  } | null;
  droppedFieldKeys: string[];
  canDelete: boolean;
};
const sharedState: {
  available: boolean;
  presets: SharedPresetDto[];
  saveResult: unknown;
  deleteResult: unknown;
} = { available: true, presets: [], saveResult: null, deleteResult: null };
const listPresetsSpy = vi.fn(async () => ({
  ok: true as const,
  data: { available: sharedState.available, presets: sharedState.presets },
}));
const savePresetSpy = vi.fn(async () => sharedState.saveResult);
const deletePresetSpy = vi.fn(async () => sharedState.deleteResult);
vi.mock('@/server/actions/export-presets', () => ({
  listSharedExportPresetsAction: (...a: unknown[]) => listPresetsSpy(...(a as [])),
  saveSharedExportPresetAction: (...a: unknown[]) => savePresetSpy(...(a as [])),
  deleteSharedExportPresetAction: (...a: unknown[]) => deletePresetSpy(...(a as [])),
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
  listPresetsSpy.mockClear();
  savePresetSpy.mockClear();
  deletePresetSpy.mockClear();
  sharedState.available = true;
  sharedState.presets = [];
  sharedState.saveResult = null;
  sharedState.deleteResult = null;
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

describe('ExportBuilderDialog — shared team presets', () => {
  const teamPreset: SharedPresetDto = {
    id: 'p1',
    name: 'Warehouse walk',
    createdBy: 'user-2',
    createdAt: '2026-08-16T00:00:00Z',
    config: { itemTypeKind: 'book', fieldKeys: ['name', 'isbn', 'rack'], format: 'pdf' },
    droppedFieldKeys: [],
    canDelete: false,
  };

  it('lists shared presets under "Team presets" and applying one drives the export', async () => {
    sharedState.presets = [teamPreset];
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole('combobox', { name: /preset/i }));
    expect(screen.getByText('Team presets')).toBeTruthy();
    await user.click(screen.getByRole('option', { name: 'Warehouse walk' }));
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await waitFor(() => expect(downloadSpy).toHaveBeenCalled());
    const req = downloadSpy.mock.calls[0]![0] as {
      fields: string[];
      options: { presetName: string };
    };
    expect(req.fields).toEqual(['name', 'isbn', 'rack']);
    expect(req.options.presetName).toBe('Warehouse walk');
  });

  it('shows the VISIBLE dropped-fields note when an applied preset lost fields to the registry', async () => {
    sharedState.presets = [
      { ...teamPreset, droppedFieldKeys: ['lexile_level', 'binding_type'] },
    ];
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole('combobox', { name: /preset/i }));
    await user.click(screen.getByRole('option', { name: 'Warehouse walk' }));
    expect(
      screen.getByText(
        '"Warehouse walk" references 2 fields that no longer exist and were skipped: lexile_level, binding_type.',
      ),
    ).toBeTruthy();
  });

  it('shows no note when nothing was dropped', async () => {
    sharedState.presets = [teamPreset];
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole('combobox', { name: /preset/i }));
    await user.click(screen.getByRole('option', { name: 'Warehouse walk' }));
    expect(screen.queryByText(/no longer exist/)).toBeNull();
  });

  it('offers presets for THIS export only — an items preset never appears in the books dialog', async () => {
    sharedState.presets = [
      teamPreset,
      { ...teamPreset, id: 'p2', name: 'Items only', config: { itemTypeKind: 'other', fieldKeys: ['name', 'sku'] } },
      { ...teamPreset, id: 'p3', name: 'Broken row', config: null },
    ];
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole('combobox', { name: /preset/i }));
    expect(screen.getByRole('option', { name: 'Warehouse walk' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Items only' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Broken row' })).toBeNull();
  });

  it('shows the empty state when the org has no shared presets yet', async () => {
    renderDialog();
    await waitFor(() =>
      expect(
        screen.getByText(
          'No team presets yet. Set up an export and choose Save as team preset to share it with your organization.',
        ),
      ).toBeTruthy(),
    );
  });

  it('saves the CURRENT builder state as a shared preset and selects it', async () => {
    sharedState.saveResult = {
      ok: true,
      data: {
        id: 'p9',
        name: 'Friday count',
        createdBy: 'user-1',
        createdAt: 't',
        config: { itemTypeKind: 'book', fieldKeys: ['name'] },
        droppedFieldKeys: [],
        canDelete: true,
      },
    };
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole('button', { name: 'Save as team preset' }));
    await user.type(screen.getByRole('textbox', { name: 'Preset name' }), 'Friday count');
    await user.click(screen.getByRole('button', { name: 'Save preset' }));
    await waitFor(() => expect(savePresetSpy).toHaveBeenCalledTimes(1));
    const call = savePresetSpy.mock.calls[0]! as unknown as [
      { name: string; config: { itemTypeKind: string; fieldKeys: string[]; format: string } },
    ];
    expect(call[0].name).toBe('Friday count');
    expect(call[0].config.itemTypeKind).toBe('book');
    expect(call[0].config.format).toBe('pdf');
    expect(call[0].config.fieldKeys[0]).toBe('image'); // the books default, verbatim
    // The saved preset is now in the picker and active.
    await user.click(screen.getByRole('combobox', { name: /preset/i }));
    expect(screen.getByRole('option', { name: 'Friday count' })).toBeTruthy();
  });

  it('surfaces a duplicate-name refusal inside the dialog, keeping the form open', async () => {
    sharedState.saveResult = {
      ok: false,
      error: {
        code: 'conflict',
        message:
          'A preset with this name already exists in your organization. Delete it first, or pick another name.',
      },
    };
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole('button', { name: 'Save as team preset' }));
    await user.type(screen.getByRole('textbox', { name: 'Preset name' }), 'Warehouse walk');
    await user.click(screen.getByRole('button', { name: 'Save preset' }));
    expect(
      await screen.findByText(
        'A preset with this name already exists in your organization. Delete it first, or pick another name.',
      ),
    ).toBeTruthy();
    // The form is still there for a rename — nothing was lost.
    expect(screen.getByRole('textbox', { name: 'Preset name' })).toBeTruthy();
  });

  it('deletes only after an explicit confirm, and only where canDelete', async () => {
    sharedState.presets = [{ ...teamPreset, canDelete: true }];
    sharedState.deleteResult = { ok: true, data: { id: 'p1' } };
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole('combobox', { name: /preset/i }));
    await user.click(screen.getByRole('option', { name: 'Warehouse walk' }));
    await user.click(screen.getByRole('button', { name: 'Delete preset' }));
    // The confirm names the preset and the blast radius; nothing deleted yet.
    expect(screen.getByText(/for everyone in your organization\?/)).toBeTruthy();
    expect(deletePresetSpy).not.toHaveBeenCalled();
    // The destructive confirm button.
    const buttons = screen.getAllByRole('button', { name: 'Delete preset' });
    await user.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(deletePresetSpy).toHaveBeenCalledWith({ id: 'p1' }));
    // Gone from the picker.
    await user.click(screen.getByRole('combobox', { name: /preset/i }));
    expect(screen.queryByRole('option', { name: 'Warehouse walk' })).toBeNull();
  });

  it('offers no delete button for a preset the user cannot delete', async () => {
    sharedState.presets = [teamPreset]; // canDelete: false
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole('combobox', { name: /preset/i }));
    await user.click(screen.getByRole('option', { name: 'Warehouse walk' }));
    expect(screen.queryByRole('button', { name: 'Delete preset' })).toBeNull();
  });

  it('renders EXACTLY the pre-0338 dialog when the table is not migrated yet (available:false)', async () => {
    sharedState.available = false;
    renderDialog();
    await waitFor(() => expect(listPresetsSpy).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Save as team preset' })).toBeNull();
    expect(screen.queryByText(/No team presets yet/)).toBeNull();
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

  it('leaves only the stage announcement live after a reorder is followed by an export', async () => {
    // Reproduces the reviewer's sequence: reorder a field first (mounting the
    // field-picker's own "X moved to…" `role="status"` region), THEN start an
    // export (mounting the dialog's OWN `role="status"` stage region). Same
    // manually-held-promise idiom as "announces the stage it is actually in"
    // above — a plain resolved mock would let `finally` clear `stage` back to
    // null before this test can observe the overlap.
    const user = userEvent.setup();
    let release!: () => void;
    downloadSpy.mockImplementationOnce(async (_req: unknown, opts: unknown) => {
      (opts as { onStage: (s: string) => void }).onStage('preparing');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    renderDialog();

    await user.click(screen.getByRole('button', { name: /move title to top/i }));
    // The field picker's own announcement is live, on its own, before export
    // ever starts — confirms this test actually set up the collision.
    expect(screen.getByRole('status').textContent).toContain('Title');

    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await waitFor(() => {
      const nonEmptyStatuses = screen
        .getAllByRole('status')
        .filter((el) => (el.textContent ?? '').trim().length > 0);
      expect(nonEmptyStatuses).toHaveLength(1);
      expect(nonEmptyStatuses[0]!.textContent).toContain('Preparing 111 books');
    });
    release();
  });

  it('does not let a stale reorder announcement reappear once a failed export finishes', async () => {
    // Carry-forward gap from the reviewer's pass above: the previous test
    // proves the reorder announcement is SUPPRESSED while `busy` is true, but
    // export-builder-fields.tsx's `announcement && !busy` gate only ever
    // hides that stale text — it is never cleared. Once `busy` flips back to
    // false (a FAILED export does exactly that, right in front of the user,
    // dialog still open), the old "Title moved to the top." text would
    // reappear and re-announce itself to a screen reader for no reason. The
    // dialog resets the field picker (a fresh mount, not a state patch) the
    // moment an export attempt starts, which clears it before the fetch
    // rejection is even known.
    const user = userEvent.setup();
    downloadSpy.mockRejectedValueOnce(new Error('Too many exports — please wait a few minutes.'));
    renderDialog();

    await user.click(screen.getByRole('button', { name: /move title to top/i }));
    expect(screen.getByRole('status').textContent).toContain('Title');

    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Too many exports'));

    const nonEmptyStatuses = screen
      .queryAllByRole('status')
      .filter((el) => (el.textContent ?? '').trim().length > 0);
    expect(nonEmptyStatuses).toHaveLength(0);
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

describe('ExportBuilderDialog — preview fetch lifecycle', () => {
  it('aborts an in-flight preview fetch when the dialog unmounts', async () => {
    // Carry-forward gap: the preview effect has threaded an AbortController's
    // signal into fetchExportPreview since Task 14, with `return () =>
    // controller.abort();` as its cleanup — but nothing ever asserted that the
    // cleanup runs. Without it, a superseded or unmounted dialog's preview
    // fetch stays in flight and can call setState on an unmounted component,
    // or a later request can lose a race with an earlier, slower one.
    let capturedSignal: AbortSignal | undefined;
    previewSpy.mockImplementationOnce(async (_req: unknown, signal: unknown) => {
      capturedSignal = signal as AbortSignal | undefined;
      // Never resolves inside the test — if the cleanup did not abort it,
      // there would be nothing here to observe the difference.
      return new Promise(() => {});
    });
    const { unmount } = render(
      <ExportBuilderDialog
        open
        onOpenChange={vi.fn()}
        scope="filtered"
        itemType="book"
        filters={{ q: 'algebra' }}
        rowCountHint={111}
      />,
    );
    await waitFor(() => expect(capturedSignal).toBeDefined());
    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe('ExportBuilderDialog — accessibility and small screens', () => {
  it('returns focus to the trigger when it closes', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Export
          </button>
          <ExportBuilderDialog
            open={open}
            onOpenChange={setOpen}
            scope="filtered"
            itemType="book"
            rowCountHint={111}
          />
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Export' });
    await user.click(trigger);
    await screen.findByRole('dialog', { name: 'Customize export' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('every interactive control has an accessible name', () => {
    renderDialog();
    for (const el of [
      ...screen.getAllByRole('button'),
      ...screen.getAllByRole('checkbox'),
      ...screen.getAllByRole('radio'),
      ...screen.getAllByRole('combobox'),
    ]) {
      const name = el.getAttribute('aria-label') ?? el.textContent ?? '';
      expect(name.trim().length, el.outerHTML.slice(0, 80)).toBeGreaterThan(0);
    }
  });

  it('states state with text, never with colour alone', () => {
    renderDialog();
    // The selected format card carries aria-checked; the field checkboxes carry
    // aria-checked. Neither relies on a class to convey state.
    expect(
      screen.getAllByRole('radio').every((el) => el.getAttribute('aria-checked') !== null),
    ).toBe(true);
    expect(
      screen.getAllByRole('checkbox').every((el) => el.getAttribute('aria-checked') !== null),
    ).toBe(true);
  });

  it('keeps the dialog reachable on a narrow viewport — no fixed desktop width', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Customize export' });
    const className = dialog.getAttribute('class') ?? '';
    expect(className).toContain('w-[min(');
    expect(className).toContain('max-h-');
    expect(className).toContain('overflow-y-auto');
  });

  it('overrides the shared DialogContent max-w-lg clamp so the width class takes effect', () => {
    // The shared ui/dialog DialogContent bakes in `max-w-lg` (512px). Without a
    // call-site max-w override, tailwind-merge keeps that clamp and the
    // `w-[min(...)]` class silently never applies — the dialog shipped at
    // 512px wide until this was caught on a real display.
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Customize export' });
    const className = dialog.getAttribute('class') ?? '';
    expect(className).toContain('max-w-[min(');
    expect(className).not.toContain('max-w-lg');
  });

  it('cannot be dismissed mid-export', async () => {
    const user = userEvent.setup();
    // Definite-assignment `let x!: T`, not `T | null` (same house idiom as
    // the "prevents a duplicate submission" test above) — this repo's strict
    // tsconfig does not credit the reassignment inside the Promise executor
    // closure below, so `T | null` narrows to `never` at the call site.
    let release!: () => void;
    downloadSpy.mockImplementationOnce(
      async () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await user.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    release();
  });
});
