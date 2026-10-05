// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createAction = vi.hoisted(() => vi.fn());
vi.mock('@/server/actions/returns', () => ({ createReturnFromOrderAction: createAction }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { CreateReturnDialog } from './create-return-dialog';

/**
 * The create dialog's request key (returns RX-1, desk check F6). The key is
 * minted when the dialog OPENS and kept for that open, whatever the body: a
 * create that committed but whose answer was lost, followed by an edited
 * resubmit, must meet idempotency_conflict, never make a second RMA. A
 * refused create rolls its key back in the database, so keeping the key after
 * a refusal loses nothing. Closing and reopening the dialog mints a new key.
 */

const ORDER = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const LINES = [
  {
    orderRequestLineId: LINE,
    itemId: '33333333-3333-4333-8333-333333333333',
    itemName: 'Walk Shirt M',
    itemSku: 'WS-M',
    quantityFulfilled: 3,
    quantityRemaining: 3,
  },
];

function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: /create return/i }));
  return screen.getByRole('dialog');
}

function submit(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: /create return/i }));
}

const keyOf = (call: unknown[]) => (call[0] as { idempotencyKey: string }).idempotencyKey;

beforeEach(() => {
  createAction.mockReset();
});

describe('CreateReturnDialog request key', () => {
  it('keeps one key for the whole open, even when the body changes after a refusal', async () => {
    createAction
      .mockResolvedValueOnce({ ok: false, error: { message: 'Busy. Try again.' } })
      .mockResolvedValueOnce({ ok: true, data: { id: 'r1', replay: false } });
    render(<CreateReturnDialog orderId={ORDER} lines={LINES} />);
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.change(within(dialog).getByLabelText('Return quantity'), { target: { value: '2' } });
    submit(dialog);
    await waitFor(() => expect(createAction).toHaveBeenCalledTimes(1));
    // The answer was a refusal; the user edits the quantity and sends again.
    fireEvent.change(within(dialog).getByLabelText('Return quantity'), { target: { value: '1' } });
    submit(dialog);
    await waitFor(() => expect(createAction).toHaveBeenCalledTimes(2));
    const [first, second] = createAction.mock.calls;
    expect((first![0] as { lines: Array<{ quantity: number }> }).lines[0]!.quantity).toBe(2);
    expect((second![0] as { lines: Array<{ quantity: number }> }).lines[0]!.quantity).toBe(1);
    expect(keyOf(second!)).toBe(keyOf(first!));
    expect(keyOf(first!)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('mints a new key when the dialog is opened again', async () => {
    createAction.mockResolvedValue({ ok: false, error: { message: 'Busy. Try again.' } });
    render(<CreateReturnDialog orderId={ORDER} lines={LINES} />);
    let dialog = openDialog();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    submit(dialog);
    await waitFor(() => expect(createAction).toHaveBeenCalledTimes(1));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dialog = openDialog();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    submit(dialog);
    await waitFor(() => expect(createAction).toHaveBeenCalledTimes(2));
    expect(keyOf(createAction.mock.calls[1]!)).not.toBe(keyOf(createAction.mock.calls[0]!));
  });
});
