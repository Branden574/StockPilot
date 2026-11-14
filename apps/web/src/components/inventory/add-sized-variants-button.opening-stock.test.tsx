import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Add more sizes, when the variants were SAVED but their opening quantities
// could not be recorded: the dialog shows the sentence, closes and goes to the
// list, as a saved run does, so a second press never saves a second set.

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/server/actions/inventory', () => ({
  bulkCreateSizedVariantsAction: vi.fn(),
}));

import { toast } from 'sonner';

import { bulkCreateSizedVariantsAction } from '@/server/actions/inventory';

import { AddSizedVariantsButton } from './add-sized-variants-button';

const SOURCE = {
  name: 'Team Jersey - M',
  sku: 'JER-M',
  barcode: null,
  description: null,
  categoryId: 'cat-1',
  supplierId: null,
  warehouseId: 'wh-1',
  charterId: null,
  primaryLocationId: null,
  binLocation: null,
  retailPrice: 0,
  unitCost: 0,
  reorderPoint: 0,
  reorderQuantity: 0,
};

const SENTENCE =
  'These variants were saved with zero on hand: their opening quantities could not be recorded. Open each one and use Adjust stock to set its quantity.';

async function pickLargeAndCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Add more sizes' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'L' }));
  const qty = within(dialog).getByRole('spinbutton', { name: 'On hand for size L' });
  await user.clear(qty);
  await user.type(qty, '5');
  await user.click(within(dialog).getByRole('button', { name: 'Create variants' }));
}

beforeEach(() => vi.clearAllMocks());

describe('AddSizedVariantsButton: saved, but the opening quantities were not recorded', () => {
  it('shows the sentence, closes the dialog and goes to the list', async () => {
    vi.mocked(bulkCreateSizedVariantsAction).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message: SENTENCE,
        details: { reason: 'opening_stock_not_recorded', cause: 'not_recorded', outcome: 'zero', itemIds: ['v-l'], notOpened: 1, total: 1 },
      },
    } as never);
    render(<AddSizedVariantsButton source={SOURCE} />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await pickLargeAndCreate(user);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/inventory'));
    expect(toast.error).toHaveBeenCalledWith(SENTENCE, expect.anything());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bulkCreateSizedVariantsAction).toHaveBeenCalledTimes(1);
  });

  it('any other refusal keeps the dialog open with its sentence', async () => {
    vi.mocked(bulkCreateSizedVariantsAction).mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: 'One or more variant SKUs already exist. Pick a different base SKU.' },
    } as never);
    render(<AddSizedVariantsButton source={SOURCE} />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await pickLargeAndCreate(user);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('One or more variant SKUs already exist. Pick a different base SKU.'),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
