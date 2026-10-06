import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { seedRecurringTemplateFromPoAction } from '@/server/actions/recurring-pos';

import { MakeRecurringButton } from './make-recurring-button';

// "Make recurring" seeds a template from a PO. A line whose item was deleted,
// or that is a kit's pre-assembled stock, can never be ordered, so the seed
// leaves it out; the button says how many instead of dropping them silently.
// The seed is stored under the PO's id and the page is opened for that PO
// (?from=), so the recurring page uses it once and only for this PO
// (recurring-templates-seed-loader.test.tsx).

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/recurring-pos', () => ({ seedRecurringTemplateFromPoAction: vi.fn() }));

const SEED = {
  supplierId: 'sup-1',
  destinationLocationId: null,
  lineItems: [{ itemId: 'item-1', quantityOrdered: 2, unitCost: 3 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('MakeRecurringButton', () => {
  it('says how many lines were left out, stores the seed under this PO and opens the page for it', async () => {
    vi.mocked(seedRecurringTemplateFromPoAction).mockResolvedValue({
      ok: true,
      data: { ...SEED, linesLeftOff: 2 },
    } as never);
    render(<MakeRecurringButton poId="po-1" />);

    await userEvent.click(screen.getByRole('button', { name: /make recurring/i }));

    // The page opens the form only with the seed of the PO its address names.
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('/dashboard/purchase-orders/recurring?from=po-1'),
    );
    expect(toast.info).toHaveBeenCalledWith(
      '2 lines were left out: the item was deleted or is a pre-assembled kit, which is never ordered.',
    );
    expect(JSON.parse(sessionStorage.getItem('recurring-po-seed') ?? 'null')).toEqual({
      poId: 'po-1',
      ...SEED,
    });
  });

  it('when the browser refuses to store the seed, says so and stays on the purchase order', async () => {
    vi.mocked(seedRecurringTemplateFromPoAction).mockResolvedValue({
      ok: true,
      data: { ...SEED, linesLeftOff: 0 },
    } as never);
    const setItem = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    try {
      render(<MakeRecurringButton poId="po-1" />);

      await userEvent.click(screen.getByRole('button', { name: /make recurring/i }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "This browser blocked passing the purchase order's details to Recurring purchase orders. Allow site data for StockPilot and try again.",
        ),
      );
      expect(push).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });

  it('says nothing extra when every line was kept', async () => {
    vi.mocked(seedRecurringTemplateFromPoAction).mockResolvedValue({
      ok: true,
      data: { ...SEED, linesLeftOff: 0 },
    } as never);
    render(<MakeRecurringButton poId="po-1" />);

    await userEvent.click(screen.getByRole('button', { name: /make recurring/i }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(toast.info).not.toHaveBeenCalled();
  });
});
