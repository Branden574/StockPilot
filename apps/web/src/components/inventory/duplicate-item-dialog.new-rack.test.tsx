import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { newRackConfirmationDetail, type NewRackBlocker } from '@stockpilot/core';

// "Create new rack 1-B?" on Duplicate (2026-10-24). A product's copy is moved
// onto the rack typed here, and when no such rack exists the server refuses
// before the copy is made. The dialog asks in the server's words and saves
// again with the answer, as the New item form does. A duplicated book is never
// placed by the duplicate, so it is never asked.

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/server/actions/duplicate-item', () => ({
  duplicateItemAction: vi.fn(),
}));

import { toast } from 'sonner';

import { duplicateItemAction } from '@/server/actions/duplicate-item';
import { pressWhenEnabled } from '@/test/press-when-enabled';

import { DuplicateItemDialog } from './duplicate-item-dialog';

const ITEM_ID = '33333333-3333-4333-8333-333333333333';

function askedAbout(label: string, units: number, blockedBy: NewRackBlocker | null = null) {
  const detail = newRackConfirmationDetail({
    label,
    warehouseName: 'DC4',
    quantity: units,
    existingLabels: ['17-B', '18-B', '20-A'],
    blockedBy,
  })!;
  return {
    ok: false,
    error: { code: 'conflict', message: detail.message, details: { ...detail } },
  };
}

function call(n: number): Record<string, unknown> {
  return vi.mocked(duplicateItemAction).mock.calls[n]?.[0] as unknown as Record<string, unknown>;
}

async function openAndFill(
  user: ReturnType<typeof userEvent.setup>,
  rack: { number: string; row: string },
  quantity: string,
) {
  await user.click(screen.getByRole('button', { name: 'Duplicate' }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText(/Rack number/), rack.number);
  await user.type(within(dialog).getByLabelText(/Row/), rack.row);
  // "Quantity at this rack" for a product, "Quantity" for a book (B28: a book
  // copy's stock waits in Unplaced).
  const qty = within(dialog).getByRole('spinbutton', { name: /^Quantity/ });
  await user.clear(qty);
  await user.type(qty, quantity);
  return dialog;
}

beforeEach(() => vi.clearAllMocks());

describe('DuplicateItemDialog: the copy is typed onto a rack that does not exist', () => {
  it('asks before the copy is made, and makes it with the yes', async () => {
    vi.mocked(duplicateItemAction)
      .mockResolvedValueOnce(askedAbout('1-B', 4) as never)
      .mockResolvedValueOnce({ ok: true, data: { id: 'dup-1' } } as never);
    render(<DuplicateItemDialog itemId={ITEM_ID} itemName="Polo" itemType="product" />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    const dialog = await openAndFill(user, { number: '1', row: 'B' }, '4');
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate' }));

    const question = await screen.findByRole('alertdialog');
    expect(within(question).getByText('Create new rack 1-B?')).toBeInTheDocument();
    expect(call(0)).toMatchObject({
      itemType: 'product',
      rackNumber: '1',
      rackRow: 'B',
      quantity: 4,
    });
    expect(call(0)).not.toHaveProperty('confirmNewRack');
    expect(toast.error).not.toHaveBeenCalled();

    await pressWhenEnabled(
      user,
      within(question).getByRole('button', { name: 'Create rack and save' }),
    );

    await waitFor(() => expect(duplicateItemAction).toHaveBeenCalledTimes(2));
    expect(call(1)).toMatchObject({
      originalId: ITEM_ID,
      itemType: 'product',
      rackNumber: '1',
      rackRow: 'B',
      quantity: 4,
      confirmNewRack: true,
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/inventory/dup-1'));
  });

  it('Go back makes no copy and keeps what was typed', async () => {
    vi.mocked(duplicateItemAction).mockResolvedValueOnce(askedAbout('1-B', 4) as never);
    render(<DuplicateItemDialog itemId={ITEM_ID} itemName="Polo" itemType="product" />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    const dialog = await openAndFill(user, { number: '1', row: 'B' }, '4');
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate' }));
    await pressWhenEnabled(
      user,
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Go back' }),
    );

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(duplicateItemAction).toHaveBeenCalledTimes(1);
    const still = screen.getByRole('dialog');
    expect(within(still).getByLabelText(/Rack number/)).toHaveValue('1');
    expect(within(still).getByLabelText(/Row/)).toHaveValue('B');
    expect(push).not.toHaveBeenCalled();
  });

  it('"Use 17-B instead" copies onto the existing rack, sends no yes, and shows it', async () => {
    vi.mocked(duplicateItemAction)
      .mockResolvedValueOnce(askedAbout('1-B', 4) as never)
      .mockResolvedValueOnce({ ok: true, data: { id: 'dup-1' } } as never);
    render(<DuplicateItemDialog itemId={ITEM_ID} itemName="Polo" itemType="product" />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    const dialog = await openAndFill(user, { number: '1', row: 'B' }, '4');
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate' }));
    await pressWhenEnabled(
      user,
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Use 17-B instead',
      }),
    );

    await waitFor(() => expect(duplicateItemAction).toHaveBeenCalledTimes(2));
    expect(call(1)).toMatchObject({ rackNumber: '17', rackRow: 'B', quantity: 4 });
    expect(call(1)).not.toHaveProperty('confirmNewRack');
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/inventory/dup-1'));
  });

  it('an existing rack is copied straight away, with no question and no yes sent', async () => {
    vi.mocked(duplicateItemAction).mockResolvedValueOnce({
      ok: true,
      data: { id: 'dup-1' },
    } as never);
    render(<DuplicateItemDialog itemId={ITEM_ID} itemName="Polo" itemType="product" />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    const dialog = await openAndFill(user, { number: '17', row: 'B' }, '4');
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/inventory/dup-1'));
    expect(duplicateItemAction).toHaveBeenCalledTimes(1);
    expect(call(0)).not.toHaveProperty('confirmNewRack');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  // 2026-10-25 review: a Staff member's yes cannot create the rack, and the
  // copy's stock then stayed at the original's site while the dialog said
  // "Duplicated". The question says so first, and the result says it after.
  it('for a member who cannot create racks, offers Save anyway and then says the stock is not on the rack', async () => {
    vi.mocked(duplicateItemAction)
      .mockResolvedValueOnce(askedAbout('1-B', 4, 'create_rack') as never)
      .mockResolvedValueOnce({
        ok: true,
        data: { id: 'dup-1', placementFailed: { rackName: '1-B', count: 1 } },
      } as never);
    render(<DuplicateItemDialog itemId={ITEM_ID} itemName="Polo" itemType="product" />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    const dialog = await openAndFill(user, { number: '1', row: 'B' }, '4');
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate' }));

    const question = await screen.findByRole('alertdialog');
    expect(within(question).getByText('Rack 1-B does not exist')).toBeInTheDocument();
    expect(
      within(question).queryByRole('button', { name: 'Create rack and save' }),
    ).not.toBeInTheDocument();
    await pressWhenEnabled(user, within(question).getByRole('button', { name: 'Save anyway' }));

    await waitFor(() => expect(duplicateItemAction).toHaveBeenCalledTimes(2));
    expect(call(1)).toMatchObject({ rackNumber: '1', rackRow: 'B', confirmNewRack: true });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/inventory/dup-1'));
    expect(toast.warning).toHaveBeenCalledWith(
      'Duplicated "Polo", but its stock could not be placed on rack 1-B — it is still where it started. Check before picking.',
      { duration: 10000 },
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says so when a copy onto an existing rack did not reach it', async () => {
    vi.mocked(duplicateItemAction).mockResolvedValueOnce({
      ok: true,
      data: { id: 'dup-1', placementFailed: { rackName: '17-B', count: 1 } },
    } as never);
    render(<DuplicateItemDialog itemId={ITEM_ID} itemName="Polo" itemType="product" />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    const dialog = await openAndFill(user, { number: '17', row: 'B' }, '4');
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/inventory/dup-1'));
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining('could not be placed on rack 17-B'),
      { duration: 10000 },
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('a book copy is never asked, and never sends a yes', async () => {
    // Even a refusal shaped like the question is only said: a duplicated book
    // keeps its crate-aware path, which this question is not about.
    vi.mocked(duplicateItemAction).mockResolvedValueOnce(askedAbout('1-B', 4) as never);
    render(<DuplicateItemDialog itemId={ITEM_ID} itemName="Maus I" itemType="book" />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    const dialog = await openAndFill(user, { number: '1', row: 'B' }, '4');
    await user.type(within(dialog).getByLabelText(/Crate number/), '4');
    // The crate colour is a select; pick one so the book form is complete.
    await user.click(within(dialog).getByRole('combobox', { name: /Crate color/ }));
    await user.click(await screen.findByRole('option', { name: /Blue/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(duplicateItemAction).toHaveBeenCalledTimes(1));
    expect(call(0)).toMatchObject({ itemType: 'book', rackNumber: '1', rackRow: 'B' });
    expect(call(0)).not.toHaveProperty('confirmNewRack');
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
