import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// B28 (2026-10-25): a duplicated book is never placed by the duplicate (its
// crate is chosen at put-away), and its stock used to stay at the original's
// site, counted as placed and missing from the put-away list. It now waits in
// Unplaced. The dialog says so before the save, and after it says where the
// stock is; when the server could not move it, the warning names the place the
// stock was left.

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

import { DuplicateItemDialog } from './duplicate-item-dialog';

const ITEM_ID = '33333333-3333-4333-8333-333333333333';

async function duplicate(
  user: ReturnType<typeof userEvent.setup>,
  opts: { book: boolean; quantity: string },
) {
  await user.click(screen.getByRole('button', { name: 'Duplicate' }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText(/Rack number/), '40');
  await user.type(within(dialog).getByLabelText(/Row/), 'B');
  if (opts.book) {
    await user.type(within(dialog).getByLabelText(/Crate number/), '4');
    await user.click(within(dialog).getByRole('combobox', { name: /Crate color/ }));
    await user.click(await screen.findByRole('option', { name: /Blue/ }));
  }
  const qty = within(dialog).getByLabelText('Quantity at this rack');
  await user.clear(qty);
  await user.type(qty, opts.quantity);
  await user.click(within(dialog).getByRole('button', { name: 'Duplicate' }));
}

beforeEach(() => vi.clearAllMocks());

describe('DuplicateItemDialog: a book copy waits in Unplaced', () => {
  it('says before the save that a book copy waits in Unplaced for put-away', async () => {
    render(<DuplicateItemDialog itemId={ITEM_ID} itemName="Maus I" itemType="book" />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: 'Duplicate' }));
    const dialog = await screen.findByRole('dialog');

    expect(
      within(dialog).getByText(
        'Defaults to 0. The stock waits in Unplaced until it is put away into this crate.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps the rack words for a product', async () => {
    render(<DuplicateItemDialog itemId={ITEM_ID} itemName="Polo" itemType="product" />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: 'Duplicate' }));
    const dialog = await screen.findByRole('dialog');

    expect(
      within(dialog).getByText('Defaults to 0. Set the actual on-hand count at the new rack.'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/Unplaced/)).not.toBeInTheDocument();
  });

  it('after the save, says where a book copy with stock is', async () => {
    vi.mocked(duplicateItemAction).mockResolvedValueOnce({
      ok: true,
      data: { id: 'dup-b' },
    } as never);
    render(<DuplicateItemDialog itemId={ITEM_ID} itemName="Maus I" itemType="book" />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await duplicate(user, { book: true, quantity: '3' });

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/inventory/dup-b'));
    expect(toast.success).toHaveBeenCalledWith(
      'Duplicated "Maus I". Its stock is in Unplaced, awaiting put-away.',
    );
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('says only "Duplicated" for a book copy with no stock', async () => {
    vi.mocked(duplicateItemAction).mockResolvedValueOnce({
      ok: true,
      data: { id: 'dup-b' },
    } as never);
    render(<DuplicateItemDialog itemId={ITEM_ID} itemName="Maus I" itemType="book" />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await duplicate(user, { book: true, quantity: '0' });

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Duplicated "Maus I"'));
  });

  it('names the place a book copy stock was left when it could not be moved', async () => {
    vi.mocked(duplicateItemAction).mockResolvedValueOnce({
      ok: true,
      data: { id: 'dup-b', stockLeftAt: { locationName: 'DC4' } },
    } as never);
    render(<DuplicateItemDialog itemId={ITEM_ID} itemName="Maus I" itemType="book" />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await duplicate(user, { book: true, quantity: '3' });

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/inventory/dup-b'));
    expect(toast.warning).toHaveBeenCalledWith(
      'Duplicated "Maus I", but its stock could not be moved to Unplaced: it is still at DC4. Check before picking.',
      { duration: 10000 },
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says it is still where it started when the place is not known', async () => {
    vi.mocked(duplicateItemAction).mockResolvedValueOnce({
      ok: true,
      data: { id: 'dup-b', stockLeftAt: { locationName: null } },
    } as never);
    render(<DuplicateItemDialog itemId={ITEM_ID} itemName="Maus I" itemType="book" />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await duplicate(user, { book: true, quantity: '3' });

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'Duplicated "Maus I", but its stock could not be moved to Unplaced: it is still where it started. Check before picking.',
        { duration: 10000 },
      ),
    );
  });

  it('keeps "Duplicated" alone for a product copy that reached its rack', async () => {
    vi.mocked(duplicateItemAction).mockResolvedValueOnce({
      ok: true,
      data: { id: 'dup-p' },
    } as never);
    render(<DuplicateItemDialog itemId={ITEM_ID} itemName="Polo" itemType="product" />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await duplicate(user, { book: false, quantity: '4' });

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Duplicated "Polo"'));
  });
});
