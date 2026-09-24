import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DraftPosFromReorderButton } from './draft-pos-from-reorder-button';

import { createDraftPosFromReorderForecastAction } from '@/server/actions/purchase-orders';

// "Draft PO from suggestions" skips items already on an open PO (S3 F1). The
// toast must say so: when every below-par item is already on order it is not
// "Nothing to reorder" (there was), and not an error (nothing failed).

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/server/actions/purchase-orders', () => ({
  createDraftPosFromReorderForecastAction: vi.fn(),
}));

type Data = {
  createdPoIds: string[];
  unassignedCount: number;
  skipped: number;
  skippedOnOpenPo: number;
  supplierFailures: Array<{ supplierId: string | null; supplierName: string; error: string }>;
  supplierCount: number;
};

function resolveWith(data: Partial<Data>) {
  vi.mocked(createDraftPosFromReorderForecastAction).mockResolvedValue({
    ok: true,
    data: {
      createdPoIds: [],
      unassignedCount: 0,
      skipped: 0,
      skippedOnOpenPo: 0,
      supplierFailures: [],
      supplierCount: 0,
      ...data,
    },
  } as never);
}

async function click() {
  render(<DraftPosFromReorderButton itemCount={5} />);
  await userEvent.click(screen.getByRole('button', { name: /Draft PO from suggestions/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DraftPosFromReorderButton', () => {
  it('says every below-par item is already on order (info, not an error) and navigates nowhere', async () => {
    resolveWith({ skippedOnOpenPo: 4 });
    await click();
    expect(toast.info).toHaveBeenCalledWith(
      'All 4 below-par items are already on open purchase orders.',
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('uses the singular for one item already on order', async () => {
    resolveWith({ skippedOnOpenPo: 1 });
    await click();
    expect(toast.info).toHaveBeenCalledWith(
      'The 1 below-par item is already on an open purchase order.',
    );
  });

  it('adds the skipped count to the success toast when some drafts were created', async () => {
    resolveWith({ createdPoIds: ['po-1'], supplierCount: 1, skippedOnOpenPo: 2 });
    await click();
    expect(toast.success).toHaveBeenCalledWith(
      'Created 1 draft PO across 1 supplier · 2 already on open POs (skipped). Review before sending.',
    );
    expect(push).toHaveBeenCalledWith('/dashboard/purchase-orders/po-1');
  });

  it('says nothing about open POs when none were skipped', async () => {
    resolveWith({ createdPoIds: ['po-1', 'po-2'], supplierCount: 2 });
    await click();
    expect(toast.success).toHaveBeenCalledWith(
      'Created 2 draft POs across 2 suppliers. Review before sending.',
    );
  });

  it('still reports a real failure as an error, even with items skipped', async () => {
    resolveWith({
      skippedOnOpenPo: 3,
      supplierFailures: [{ supplierId: 's1', supplierName: 'Acme', error: 'Boom.' }],
    });
    await click();
    expect(toast.error).toHaveBeenCalledWith("Couldn't create any draft POs. Boom.");
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('keeps "Nothing to reorder" for the genuinely empty case', async () => {
    resolveWith({});
    await click();
    expect(toast.error).toHaveBeenCalledWith(
      'Nothing to reorder — no items are below their reorder point.',
    );
  });

  it('is disabled when there is nothing to draft', () => {
    render(<DraftPosFromReorderButton itemCount={0} />);
    expect(screen.getByRole('button', { name: /Draft PO from suggestions/i })).toBeDisabled();
  });

  it('stays enabled at 0 when the count covers only part of the catalog (Planning past its cap)', () => {
    render(<DraftPosFromReorderButton itemCount={0} countIsPartial />);
    expect(screen.getByRole('button', { name: /Draft PO from suggestions/i })).toBeEnabled();
  });
});

describe('DraftPosFromReorderButton — the created drafts, in words', () => {
  it('only the no-supplier draft: says so, never "across 0 suppliers"', async () => {
    resolveWith({ createdPoIds: ['po-u'], unassignedCount: 1, supplierCount: 0 });
    await click();
    expect(toast.success).toHaveBeenCalledWith(
      'Created 1 draft PO for 1 item with no supplier yet (set one on the draft). Review before sending.',
    );
    expect(push).toHaveBeenCalledWith('/dashboard/purchase-orders/po-u');
  });

  it('only the no-supplier draft, several items, some skipped', async () => {
    resolveWith({ createdPoIds: ['po-u'], unassignedCount: 3, supplierCount: 0, skippedOnOpenPo: 1 });
    await click();
    expect(toast.success).toHaveBeenCalledWith(
      'Created 1 draft PO for 3 items with no supplier yet (set one on the draft) · 1 already on open POs (skipped). Review before sending.',
    );
  });

  it('supplier drafts and the no-supplier draft together', async () => {
    resolveWith({ createdPoIds: ['po-1', 'po-2', 'po-u'], unassignedCount: 4, supplierCount: 2 });
    await click();
    expect(toast.success).toHaveBeenCalledWith(
      'Created 3 draft POs: 2 across 2 suppliers and 1 for 4 items with no supplier yet (set one on the draft). Review before sending.',
    );
  });

  it('counts suppliers from the drafts created, not from those attempted (one failed)', async () => {
    resolveWith({
      createdPoIds: ['po-1'],
      supplierCount: 2,
      supplierFailures: [{ supplierId: 's2', supplierName: 'Beta', error: 'Boom.' }],
    });
    await click();
    expect(toast.success).toHaveBeenCalledWith(
      'Created 1 draft PO across 1 supplier · failed: Beta. Review before sending.',
    );
  });
});
