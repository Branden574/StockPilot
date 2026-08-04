import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExportMenu } from './inventory-table';

// Task 17 fix wave: the inventory toolbar's export path (ExportMenu, mounted
// inside the giant InventoryTable component) was migrated onto
// ExportBuilderDialog with ZERO regression coverage — a hardcoded itemType
// or a dropped filters object would survive the whole suite. ExportMenu is
// a standalone top-level function in inventory-table.tsx (same seam as the
// already-exported Pagination/MultiSelectFilter siblings, both tested the
// same way in this directory) — it was not exported before this change; the
// only change made to production code is adding that `export` so this real
// component can be rendered directly, with no behavior change. This file
// pins the PROPS THREADING between ExportMenu and ExportBuilderDialog; the
// dialog's own behavior is covered by export-builder-dialog.test.tsx.

const exportDialogSpy = vi.fn();
vi.mock('./export-builder/export-builder-dialog', () => ({
  ExportBuilderDialog: (props: Record<string, unknown>) => {
    exportDialogSpy(props);
    return <div data-testid="export-dialog-mock" />;
  },
}));

beforeEach(() => {
  exportDialogSpy.mockClear();
});

async function openExportMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Export$/i }));
}

describe('ExportMenu -> ExportBuilderDialog wiring (Task 17 caller pinning)', () => {
  it('Export filtered threads itemType, scope "filtered", and the active URL params into filters', async () => {
    const user = userEvent.setup();
    const params = new URLSearchParams(
      'q=widget&status=active&stock=low&expected=1&sort=name&cat=c1&cat=c2&loc=l1&charter=ch1',
    );
    render(<ExportMenu params={params} itemType="product" />);

    // No dialog mounted until a scope is picked.
    expect(exportDialogSpy).not.toHaveBeenCalled();

    await openExportMenu(user);
    await user.click(screen.getByRole('button', { name: /Export filtered/i }));

    expect(exportDialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        open: true,
        scope: 'filtered',
        itemType: 'product',
        filters: expect.objectContaining({
          q: 'widget',
          status: 'active',
          stock: 'low',
          expected: true,
          sort: 'name',
          categoryIds: ['c1', 'c2'],
          locationIds: ['l1'],
          charterIds: ['ch1'],
        }),
      }),
    );
  });

  it('Export all threads scope "all" with itemType carried through and no filters object', async () => {
    const user = userEvent.setup();
    render(<ExportMenu params={new URLSearchParams('q=widget')} itemType="book" />);

    await openExportMenu(user);
    await user.click(screen.getByRole('button', { name: /Export all/i }));

    expect(exportDialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        open: true,
        scope: 'all',
        itemType: 'book',
        filters: undefined,
      }),
    );
  });
});
