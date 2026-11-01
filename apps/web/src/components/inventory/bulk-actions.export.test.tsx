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
  it('mounts the dialog with the REAL selection (not []) and scope "selected" even before Export is clicked (for a member who can export)', () => {
    render(
      <BulkActions
        selectedIds={['item-1', 'item-2', 'item-3']}
        categories={categories}
        suppliers={suppliers}
        locations={[]}
        tags={[]}
        onClear={() => {}}
        onCycleCount={() => {}}
        canExport
        itemType="all"
      />,
    );

    // For a member who can export, BulkActions renders <ExportBuilderDialog>
    // whether or not it is open (open toggles via state) — the selection must
    // already be threaded through on mount, not swapped in later.
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
        canExport
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
        canExport
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
        canExport
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

// B68: Export showed to every member, and the export answers only items:export
// (staff and viewers lack it by default), so they were shown a sample that
// failed and then the bare code "forbidden". The page passes the member's
// EFFECTIVE permission through the table (can(ctx, 'items:export')).
describe('BulkActions: Export only for a member who can export (B68)', () => {
  function bar(canExport?: boolean) {
    return (
      <BulkActions
        selectedIds={['item-1', 'item-2']}
        categories={categories}
        suppliers={suppliers}
        locations={[]}
        tags={[]}
        onClear={() => {}}
        onCycleCount={() => {}}
        itemType="all"
        {...(canExport === undefined ? {} : { canExport })}
      />
    );
  }

  it.each([
    ['omitted', undefined],
    ['false', false],
  ])(
    'with canExport %s there is no Export, and the dialog is never rendered',
    (_label, canExport) => {
      render(bar(canExport));
      expect(screen.queryByRole('button', { name: /^Export$/i })).toBeNull();
      expect(exportDialogSpy).not.toHaveBeenCalled();
      // The rest of the bar is still there.
      expect(screen.getByRole('link', { name: /Print labels/ })).toBeInTheDocument();
    },
  );

  it('a revoke closes an open dialog, and a later grant does not bring it back open', async () => {
    const user = userEvent.setup();
    const { rerender } = render(bar(true));
    await user.click(screen.getByRole('button', { name: /^Export$/i }));
    expect(screen.getByTestId('export-dialog-mock')).toBeInTheDocument();

    // Revoked (PermissionsRealtime refreshes the page): Export and its dialog go.
    exportDialogSpy.mockClear();
    rerender(bar(false));
    expect(screen.queryByRole('button', { name: /^Export$/i })).toBeNull();
    expect(screen.queryByTestId('export-dialog-mock')).toBeNull();
    expect(exportDialogSpy).not.toHaveBeenCalled();

    // Granted again: Export is back, its dialog closed until it is clicked.
    rerender(bar(true));
    expect(screen.getByRole('button', { name: /^Export$/i })).toBeInTheDocument();
    expect(exportDialogSpy).toHaveBeenLastCalledWith(expect.objectContaining({ open: false }));
    expect(screen.queryByTestId('export-dialog-mock')).toBeNull();
  });
});
