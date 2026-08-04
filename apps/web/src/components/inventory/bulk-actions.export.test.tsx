import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BulkActions } from './bulk-actions';

// Task 17 fix wave: the two export callers (this file's ExportBuilderDialog
// mount and inventory-table.tsx's ExportMenu) were migrated onto the single
// ExportBuilderDialog with ZERO regression coverage — mutating
// selectedIds={selectedIds} to selectedIds={[]}, or bypassing the dialog
// entirely and calling downloadInventoryExport directly, survived the whole
// suite. This file pins the PROPS THREADING between BulkActions and
// ExportBuilderDialog; the dialog's own behavior is covered by
// export-builder-dialog.test.tsx's 25-test suite, so ExportBuilderDialog is
// mocked here and its received props captured.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/dashboard/inventory',
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

vi.mock('@/server/actions/inventory', () => ({
  bulkUpdateInventoryAction: vi.fn(async () => ({
    ok: true as const,
    data: { ok: 0, skipped: 0 },
  })),
}));

vi.mock('@/server/actions/purchase-orders', () => ({
  createDraftPosFromItemsAction: vi.fn(),
}));

const exportDialogSpy = vi.fn();
vi.mock('./export-builder/export-builder-dialog', () => ({
  ExportBuilderDialog: (props: Record<string, unknown>) => {
    exportDialogSpy(props);
    return props.open ? <div data-testid="export-dialog-mock" /> : null;
  },
}));

const categories = [{ id: 'c1', name: 'Books' }];
const suppliers = [{ id: 's1', name: 'Acme' }];

beforeEach(() => {
  exportDialogSpy.mockClear();
});

describe('BulkActions -> ExportBuilderDialog wiring (Task 17 caller pinning)', () => {
  it('mounts the dialog with the REAL selection (not []) and scope "selected" even before Export is clicked', () => {
    render(
      <BulkActions
        selectedIds={['item-1', 'item-2', 'item-3']}
        categories={categories}
        suppliers={suppliers}
        locations={[]}
        tags={[]}
        onClear={() => {}}
        onCycleCount={() => {}}
        itemType="all"
      />,
    );

    // BulkActions renders <ExportBuilderDialog> unconditionally (open toggles
    // via state) — the selection must already be threaded through on mount,
    // not swapped in later.
    expect(exportDialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        open: false,
        scope: 'selected',
        itemType: 'all',
        selectedIds: ['item-1', 'item-2', 'item-3'],
        rowCountHint: 3,
      }),
    );
  });

  it('clicking Export flips the dialog open while keeping the same selection threaded', async () => {
    const user = userEvent.setup();
    render(
      <BulkActions
        selectedIds={['item-1', 'item-2', 'item-3']}
        categories={categories}
        suppliers={suppliers}
        locations={[]}
        tags={[]}
        onClear={() => {}}
        onCycleCount={() => {}}
        itemType="all"
      />,
    );

    await user.click(screen.getByRole('button', { name: /^Export$/i }));

    expect(exportDialogSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        open: true,
        scope: 'selected',
        itemType: 'all',
        selectedIds: ['item-1', 'item-2', 'item-3'],
        rowCountHint: 3,
      }),
    );
    expect(screen.getByTestId('export-dialog-mock')).toBeInTheDocument();
  });

  it('threads a different selection correctly (guards against a hardcoded/stale array)', () => {
    render(
      <BulkActions
        selectedIds={['only-one']}
        categories={categories}
        suppliers={suppliers}
        locations={[]}
        tags={[]}
        onClear={() => {}}
        onCycleCount={() => {}}
      />,
    );

    expect(exportDialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({ selectedIds: ['only-one'], rowCountHint: 1 }),
    );
  });

  it('threads itemType "book" to the dialog (Books-page bulk export regression guard)', () => {
    render(
      <BulkActions
        selectedIds={['book-1', 'book-2']}
        categories={categories}
        suppliers={suppliers}
        locations={[]}
        tags={[]}
        onClear={() => {}}
        onCycleCount={() => {}}
        itemType="book"
      />,
    );

    // inventory-table.tsx passes itemType="book" on the Books tab
    // (showBookFields=true) so a bulk-selected export still offers
    // ISBN/Author/Grade/Rack/Crate fields and the catalog layout instead of
    // silently falling back to the generic "items" experience.
    expect(exportDialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({ itemType: 'book' }),
    );
  });
});
