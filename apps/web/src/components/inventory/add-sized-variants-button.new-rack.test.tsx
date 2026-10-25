import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { newRackConfirmationDetail } from '@stockpilot/core';

// "Create new rack 1-B?" on Add more sizes (2026-10-24). The new sizes inherit
// this item's rack label, so their stock is placed on that rack, and when no
// such rack exists the server refuses before anything is written. The dialog
// asks in the server's words and saves again with the answer, as the New item
// form does (item-form.new-rack.test.tsx).

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
  binLocation: '1-B',
  retailPrice: 0,
  unitCost: 0,
  reorderPoint: 0,
  reorderQuantity: 0,
};

function askedAbout(label: string, units: number) {
  const detail = newRackConfirmationDetail({
    label,
    warehouseName: 'DC4',
    quantity: units,
    existingLabels: ['17-B', '18-B', '20-A'],
  })!;
  return {
    ok: false,
    error: { code: 'conflict', message: detail.message, details: { ...detail } },
  };
}

function call(n: number): Record<string, unknown> {
  return vi.mocked(bulkCreateSizedVariantsAction).mock.calls[n]?.[0] as unknown as Record<
    string,
    unknown
  >;
}

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

describe('AddSizedVariantsButton: the inherited rack does not exist', () => {
  it('asks before it creates the rack, and saves again with the yes', async () => {
    vi.mocked(bulkCreateSizedVariantsAction)
      .mockResolvedValueOnce(askedAbout('1-B', 5) as never)
      .mockResolvedValueOnce({ ok: true, data: { created: 1, ids: ['v-l'] } } as never);
    render(<AddSizedVariantsButton source={SOURCE} />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await pickLargeAndCreate(user);

    const question = await screen.findByRole('alertdialog');
    expect(within(question).getByText('Create new rack 1-B?')).toBeInTheDocument();
    expect(
      within(question).getByText(
        '1-B does not exist in DC4 yet. Continuing creates it and moves 5 units into it. Did you mean 17-B or 18-B?',
      ),
    ).toBeInTheDocument();
    expect(call(0)).not.toHaveProperty('confirmNewRack');
    expect(toast.error).not.toHaveBeenCalled();

    await user.click(within(question).getByRole('button', { name: 'Create rack and save' }));

    await waitFor(() => expect(bulkCreateSizedVariantsAction).toHaveBeenCalledTimes(2));
    expect(call(1)).toMatchObject({
      binLocation: '1-B',
      confirmNewRack: true,
      variants: [{ size: 'L', quantity: 5 }],
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/inventory'));
    expect(toast.success).toHaveBeenCalledWith('Created 1 variant.');
  });

  it('Go back saves nothing and leaves the sizes dialog as it was', async () => {
    vi.mocked(bulkCreateSizedVariantsAction).mockResolvedValueOnce(askedAbout('1-B', 5) as never);
    render(<AddSizedVariantsButton source={SOURCE} />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await pickLargeAndCreate(user);
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Go back' }),
    );

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(bulkCreateSizedVariantsAction).toHaveBeenCalledTimes(1);
    const sizes = screen.getByRole('dialog');
    expect(within(sizes).getByRole('spinbutton', { name: 'On hand for size L' })).toHaveValue(5);
    expect(push).not.toHaveBeenCalled();
  });

  it('"Use 17-B instead" puts the new sizes on the existing rack and sends no yes', async () => {
    vi.mocked(bulkCreateSizedVariantsAction)
      .mockResolvedValueOnce(askedAbout('1-B', 5) as never)
      .mockResolvedValueOnce({ ok: true, data: { created: 1, ids: ['v-l'] } } as never);
    render(<AddSizedVariantsButton source={SOURCE} />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await pickLargeAndCreate(user);
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Use 17-B instead',
      }),
    );

    await waitFor(() => expect(bulkCreateSizedVariantsAction).toHaveBeenCalledTimes(2));
    expect(call(1)).toMatchObject({ binLocation: '17-B' });
    expect(call(1)).not.toHaveProperty('confirmNewRack');
  });

  it('an existing rack is saved straight away, and any other refusal is said as before', async () => {
    vi.mocked(bulkCreateSizedVariantsAction).mockResolvedValueOnce({
      ok: false,
      error: { code: 'validation_error', message: 'Pick a category first.' },
    } as never);
    render(<AddSizedVariantsButton source={SOURCE} />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await pickLargeAndCreate(user);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Pick a category first.'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(call(0)).toMatchObject({ binLocation: '1-B' });
    expect(call(0)).not.toHaveProperty('confirmNewRack');
  });
});
