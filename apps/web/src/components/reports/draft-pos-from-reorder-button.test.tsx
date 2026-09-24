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
});
