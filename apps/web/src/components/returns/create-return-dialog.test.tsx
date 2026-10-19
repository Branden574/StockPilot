// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createAction = vi.hoisted(() => vi.fn());
const candidatesAction = vi.hoisted(() => vi.fn());
vi.mock('@/server/actions/returns', () => ({
  createReturnFromOrderAction: createAction,
  orderExchangeCandidatesAction: candidatesAction,
}));
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
// Re-pinned by returns RX-2 review fix (counter taps): the only returnable
// line starts ticked, so these tests no longer tick it (that would untick it);
// each asserts it is ticked instead. Claims kept.
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

// The dialog is busy while a request is in flight (Create return and Cancel
// disabled), so a step taken before the refusal has rendered is ignored. With
// answers that resolved at once these tests passed or failed on scheduling
// alone: under load in security:test (2026-10-11) "mints a new key when the
// dialog is opened again" clicked Cancel before the refusal rendered and timed
// out waiting for the dialog to close (returns RX-2 review fix, test race).
// The first answer is now held until the test releases it, and every next step
// waits until the dialog takes input again.
const REFUSAL = { ok: false, error: { message: 'Busy. Try again.' } };

function heldAnswer() {
  let release: (value: unknown) => void = () => {};
  const promise = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  return { promise, release: (value: unknown) => release(value) };
}

/** Wait until the refusal has rendered and the dialog takes input again. */
async function settled(dialog: HTMLElement) {
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled());
}

beforeEach(() => {
  createAction.mockReset();
});

describe('CreateReturnDialog request key', () => {
  it('keeps one key for the whole open, even when the body changes after a refusal', async () => {
    const answer = heldAnswer();
    createAction
      .mockImplementationOnce(() => answer.promise)
      .mockResolvedValueOnce({ ok: true, data: { id: 'r1', replay: false } });
    render(<CreateReturnDialog orderId={ORDER} lines={LINES} />);
    const dialog = openDialog();
    expect(within(dialog).getByRole('checkbox')).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText('Return quantity'), { target: { value: '2' } });
    submit(dialog);
    await waitFor(() => expect(createAction).toHaveBeenCalledTimes(1));
    answer.release(REFUSAL);
    await settled(dialog);
    // The answer was a refusal; the user edits the quantity and sends again.
    fireEvent.change(within(dialog).getByLabelText('Return quantity'), { target: { value: '1' } });
    submit(dialog);
    await waitFor(() => expect(createAction).toHaveBeenCalledTimes(2));
    const [first, second] = createAction.mock.calls;
    expect((first![0] as { lines: Array<{ quantity: number }> }).lines[0]!.quantity).toBe(2);
    expect((second![0] as { lines: Array<{ quantity: number }> }).lines[0]!.quantity).toBe(1);
    expect(keyOf(second!)).toBe(keyOf(first!));
    expect(keyOf(first!)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('mints a new key when the dialog is opened again', async () => {
    const answer = heldAnswer();
    createAction.mockImplementationOnce(() => answer.promise).mockResolvedValue(REFUSAL);
    render(<CreateReturnDialog orderId={ORDER} lines={LINES} />);
    let dialog = openDialog();
    expect(within(dialog).getByRole('checkbox')).toBeChecked();
    submit(dialog);
    await waitFor(() => expect(createAction).toHaveBeenCalledTimes(1));
    // While the request is in flight the dialog cannot be closed.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    answer.release(REFUSAL);
    await settled(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dialog = openDialog();
    expect(within(dialog).getByRole('checkbox')).toBeChecked();
    submit(dialog);
    await waitFor(() => expect(createAction).toHaveBeenCalledTimes(2));
    expect(keyOf(createAction.mock.calls[1]!)).not.toBe(keyOf(createAction.mock.calls[0]!));
  });
});

describe('CreateReturnDialog exchange choice (returns RX-2)', () => {
  const ITEM_L = '44444444-4444-4444-8444-444444444444';

  it('per line: Return only or Exchange; the REPLACEMENT siblings load on the first Exchange and the choice is sent', async () => {
    candidatesAction.mockResolvedValue({
      ok: true,
      data: {
        orderId: ORDER,
        orderRequestLineId: LINE,
        returnedItemId: 'm',
        groupId: 'g',
        siblings: [
          {
            itemId: ITEM_L,
            name: 'Walk Shirt',
            sku: 'WS-L',
            variantSize: 'L',
            variantKey: 'l',
            groupId: 'g',
            sibling: true,
            isReturnedItem: false,
            onHand: 5,
            held: 1,
            free: 4,
          },
        ],
        matches: [],
      },
    });
    createAction.mockResolvedValue({ ok: true, data: { id: 'r1', replay: false } });
    render(<CreateReturnDialog orderId={ORDER} lines={LINES} exchangesEnabled />);
    const dialog = openDialog();
    expect(within(dialog).getByRole('checkbox')).toBeChecked();
    expect(candidatesAction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByLabelText('Exchange for another size or item'));
    await waitFor(() =>
      expect(candidatesAction).toHaveBeenCalledWith({ orderRequestId: ORDER, line: LINE, q: '' }),
    );
    fireEvent.click(await within(dialog).findByLabelText(/Walk Shirt, L/));
    submit(dialog);
    await waitFor(() => expect(createAction).toHaveBeenCalledTimes(1));
    expect((createAction.mock.calls[0]![0] as { lines: unknown[] }).lines[0]).toMatchObject({
      orderRequestLineId: LINE,
      quantity: 3,
      exchange: { itemId: ITEM_L, quantity: 3 },
    });
  });

  it('an Exchange without a chosen replacement is not sent', async () => {
    candidatesAction.mockResolvedValue({ ok: true, data: { siblings: [], matches: [] } });
    render(<CreateReturnDialog orderId={ORDER} lines={LINES} exchangesEnabled />);
    const dialog = openDialog();
    expect(within(dialog).getByRole('checkbox')).toBeChecked();
    fireEvent.click(within(dialog).getByLabelText('Exchange for another size or item'));
    submit(dialog);
    await new Promise((r) => setTimeout(r, 10));
    expect(createAction).not.toHaveBeenCalled();
  });

  it('with the kill switch off there is no Exchange choice', () => {
    render(<CreateReturnDialog orderId={ORDER} lines={LINES} exchangesEnabled={false} />);
    const dialog = openDialog();
    expect(within(dialog).getByRole('checkbox')).toBeChecked();
    expect(within(dialog).queryByLabelText('Exchange for another size or item')).toBeNull();
  });
});

// RX-2 review fix (counter taps): the counter's most common return has one
// line; it starts ticked. With several returnable lines nothing is ticked for
// the person.
describe('CreateReturnDialog starts the only returnable line ticked', () => {
  const second = {
    ...LINES[0]!,
    orderRequestLineId: '55555555-5555-4555-8555-555555555555',
    itemName: 'Walk Shirt L',
    itemSku: 'WS-L',
  };

  it('one returnable line: ticked, and Create return sends it with no other tap', async () => {
    createAction.mockResolvedValue({ ok: true, data: { id: 'r1', replay: false } });
    render(<CreateReturnDialog orderId={ORDER} lines={LINES} />);
    const dialog = openDialog();
    expect(within(dialog).getByRole('checkbox')).toBeChecked();
    submit(dialog);
    await waitFor(() => expect(createAction).toHaveBeenCalledTimes(1));
    expect((createAction.mock.calls[0]![0] as { lines: unknown[] }).lines).toEqual([
      expect.objectContaining({ orderRequestLineId: LINE, quantity: 3 }),
    ]);
  });

  it('two returnable lines: none ticked; one of them fully returned: the other is ticked', () => {
    const { unmount } = render(<CreateReturnDialog orderId={ORDER} lines={[LINES[0]!, second]} />);
    let dialog = openDialog();
    expect(
      within(dialog)
        .getAllByRole('checkbox')
        .map((c) => (c as HTMLInputElement).checked),
    ).toEqual([false, false]);
    unmount();
    render(
      <CreateReturnDialog
        orderId={ORDER}
        lines={[{ ...LINES[0]!, quantityRemaining: 0 }, second]}
      />,
    );
    dialog = openDialog();
    expect(
      within(dialog)
        .getAllByRole('checkbox')
        .map((c) => (c as HTMLInputElement).checked),
    ).toEqual([false, true]);
  });
});

// Fix round 1 (verification L7, pattern 20; completeness C-2): a refusal is
// said inside the dialog too, and a call that rejects never leaves it busy.
describe('CreateReturnDialog refusals stay in the dialog', () => {
  it('a refused create shows its words in the dialog as an alert, cleared on the next try', async () => {
    createAction.mockResolvedValueOnce({
      ok: false,
      error: {
        message: 'Only 1 of these can still be exchanged; the rest can be returned, not exchanged.',
      },
    });
    render(<CreateReturnDialog orderId={ORDER} lines={LINES} />);
    const dialog = openDialog();
    submit(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Only 1 of these can still be exchanged; the rest can be returned, not exchanged.',
    );
    await settled(dialog);
    createAction.mockReturnValueOnce(new Promise(() => {}));
    submit(dialog);
    await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull());
  });

  it('an Exchange with no replacement chosen says so in the dialog', async () => {
    candidatesAction.mockResolvedValue({ ok: true, data: { siblings: [], matches: [] } });
    render(<CreateReturnDialog orderId={ORDER} lines={LINES} exchangesEnabled />);
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByLabelText('Exchange for another size or item'));
    submit(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Choose the replacement');
    expect(createAction).not.toHaveBeenCalled();
  });

  it('a call that rejects frees the dialog and says so', async () => {
    createAction.mockRejectedValueOnce(new Error('fetch failed'));
    render(<CreateReturnDialog orderId={ORDER} lines={LINES} />);
    const dialog = openDialog();
    submit(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Something went wrong. Try again.',
    );
    await settled(dialog);
  });
});

// Redesign (P4.B3): "The item is here" is the shared switch. It starts off,
// it is named by its words with the help as its description, its words turn
// it on, and the create sends what it shows; reopening the dialog puts it back
// off. The line checkbox stays a native checkbox (its `checked`, its label).
describe('CreateReturnDialog "The item is here" switch', () => {
  it('starts off, is named by its words, and sends itemIsHere as shown', async () => {
    createAction.mockResolvedValue({ ok: true, data: { id: 'r1', replay: false } });
    render(<CreateReturnDialog orderId={ORDER} lines={LINES} />);
    const dialog = openDialog();
    const sw = within(dialog).getByRole('switch', { name: 'The item is here' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAccessibleDescription(/./);
    fireEvent.click(within(dialog).getByText('The item is here'));
    expect(sw).toHaveAttribute('aria-checked', 'true');
    submit(dialog);
    await waitFor(() => expect(createAction).toHaveBeenCalledTimes(1));
    expect(createAction.mock.calls[0]![0]).toMatchObject({ itemIsHere: true });
  });

  it('sends itemIsHere false when left off, and is off again after reopening', async () => {
    createAction.mockResolvedValue({ ok: false, error: { message: 'Busy. Try again.' } });
    render(<CreateReturnDialog orderId={ORDER} lines={LINES} />);
    let dialog = openDialog();
    submit(dialog);
    await waitFor(() => expect(createAction).toHaveBeenCalledTimes(1));
    expect(createAction.mock.calls[0]![0]).toMatchObject({ itemIsHere: false });
    await settled(dialog);
    fireEvent.click(within(dialog).getByRole('switch', { name: 'The item is here' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    dialog = openDialog();
    expect(within(dialog).getByRole('switch', { name: 'The item is here' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    const box = within(dialog).getByRole('checkbox');
    expect(box.tagName).toBe('INPUT');
    expect(box).toBeChecked();
  });
});
