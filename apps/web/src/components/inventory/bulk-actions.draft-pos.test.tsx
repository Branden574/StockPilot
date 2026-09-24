import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BulkActions } from './bulk-actions';

import { createDraftPosFromItemsAction } from '@/server/actions/purchase-orders';

// "Create draft POs" drafts exactly the selection (the user chose it), so it
// does NOT skip items already on an open PO (S3, owner decision D5). It warns
// instead, and says so when it could not check.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/dashboard/inventory',
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/server/actions/inventory', () => ({ bulkUpdateInventoryAction: vi.fn() }));
vi.mock('@/server/actions/purchase-orders', () => ({ createDraftPosFromItemsAction: vi.fn() }));

function resolveWith(
  alreadyOnOpenPo: number | null,
  skippedBy: { skippedNoSupplier?: number; skippedNotOrderable?: number } = {},
) {
  const skippedNoSupplier = skippedBy.skippedNoSupplier ?? 0;
  const skippedNotOrderable = skippedBy.skippedNotOrderable ?? 0;
  vi.mocked(createDraftPosFromItemsAction).mockResolvedValue({
    ok: true,
    data: {
      createdPoIds: ['po-1'],
      skipped: skippedNoSupplier + skippedNotOrderable,
      skippedNoSupplier,
      skippedNotOrderable,
      alreadyOnOpenPo,
      supplierFailures: [],
      supplierCount: 1,
    },
  } as never);
}

async function clickCreate() {
  render(
    <BulkActions
      selectedIds={['a', 'b', 'c']}
      categories={[]}
      suppliers={[]}
      locations={[]}
      tags={[]}
      onClear={() => {}}
      onCycleCount={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: /Create draft POs/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BulkActions — Create draft POs and items already on order', () => {
  it('warns how many of the drafted items were already on an open PO', async () => {
    resolveWith(2);
    await clickCreate();
    expect(toast.success).toHaveBeenCalledWith(
      'Created 1 draft PO across 1 supplier · 2 were already on an open PO — review before sending.',
    );
  });

  it('uses the singular for one', async () => {
    resolveWith(1);
    await clickCreate();
    expect(toast.success).toHaveBeenCalledWith(
      'Created 1 draft PO across 1 supplier · 1 was already on an open PO — review before sending.',
    );
  });

  it('says it could not check, rather than implying none were on order', async () => {
    resolveWith(null);
    await clickCreate();
    expect(toast.success).toHaveBeenCalledWith(
      "Created 1 draft PO across 1 supplier · couldn't check which items are already on open POs.",
    );
  });

  it('adds nothing when none were on order', async () => {
    resolveWith(0);
    await clickCreate();
    expect(toast.success).toHaveBeenCalledWith('Created 1 draft PO across 1 supplier.');
  });
});

describe('BulkActions — Create draft POs says why chosen items were skipped', () => {
  it('names items left out because they are deleted or a pre-assembled kit', async () => {
    resolveWith(0, { skippedNotOrderable: 2 });
    await clickCreate();
    expect(toast.success).toHaveBeenCalledWith(
      'Created 1 draft PO across 1 supplier · 2 skipped (deleted, or a pre-assembled kit).',
    );
  });

  it('keeps the no-supplier reason separate from it', async () => {
    resolveWith(0, { skippedNoSupplier: 1, skippedNotOrderable: 1 });
    await clickCreate();
    expect(toast.success).toHaveBeenCalledWith(
      'Created 1 draft PO across 1 supplier · 1 skipped (no supplier) · 1 skipped (deleted, or a pre-assembled kit).',
    );
  });
});

describe('BulkActions — Create draft POs counts the suppliers actually drafted', () => {
  it('leaves a failed supplier out of the count (one draft per supplier)', async () => {
    vi.mocked(createDraftPosFromItemsAction).mockResolvedValue({
      ok: true,
      data: {
        createdPoIds: ['po-1'],
        skipped: 0,
        skippedNoSupplier: 0,
        skippedNotOrderable: 0,
        alreadyOnOpenPo: 0,
        supplierFailures: [
          { supplierId: 'sup-b', supplierName: 'Beta', error: '"Blue pens" was deleted, so it can\'t be ordered.' },
        ],
        supplierCount: 2,
      },
    } as never);
    await clickCreate();
    expect(toast.success).toHaveBeenCalledWith('Created 1 draft PO across 1 supplier · failed: Beta.');
  });
});
