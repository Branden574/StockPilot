// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

import {
  removeOrderRequestLineAction,
  updateOrderRequestLineQuantityAction,
} from '@/server/actions/order-requests';

import {
  OrderLineActions,
  quantityBlockedReason,
  removalBlockedReason,
} from './order-line-actions';

const refreshSpy = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshSpy, push: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/server/actions/order-requests', () => ({
  updateOrderRequestLineQuantityAction: vi.fn(),
  removeOrderRequestLineAction: vi.fn(),
}));

const updateLine = vi.mocked(updateOrderRequestLineQuantityAction);
const removeLine = vi.mocked(removeOrderRequestLineAction);
const toastMock = vi.mocked(toast);

type Props = React.ComponentProps<typeof OrderLineActions>;

function baseProps(over: Partial<Props> = {}): Props {
  return {
    orderId: '11111111-1111-4111-8111-111111111111',
    lineId: '22222222-2222-4222-8222-222222222222',
    itemName: 'Blue widget',
    quantityRequested: 4,
    quantityFulfilled: 0,
    quantityPicked: null,
    hasActiveReservation: false,
    isOnlyLine: false,
    ...over,
  };
}

function renderRow(over: Partial<Props> = {}) {
  const user = userEvent.setup();
  render(<OrderLineActions {...baseProps(over)} />);
  return user;
}

/** Open the inline editor and return the quantity field. */
async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /change quantity for blue widget/i }));
  return screen.getByLabelText(/requested quantity for blue widget/i);
}

beforeEach(() => {
  vi.clearAllMocks();
  updateLine.mockResolvedValue({
    ok: true,
    data: { pickSlipStale: false, quantity: 9 },
  } as Awaited<ReturnType<typeof updateOrderRequestLineQuantityAction>>);
  removeLine.mockResolvedValue({
    ok: true,
    data: { pickSlipStale: false, removedItemId: 'item-1' },
  } as Awaited<ReturnType<typeof removeOrderRequestLineAction>>);
});

describe('quantityBlockedReason', () => {
  it('allows RAISING past everything already handed over or staged', () => {
    expect(
      quantityBlockedReason({ quantity: 25, fulfilled: 6, picked: 8 }),
    ).toBeNull();
  });

  it('blocks a drop below what was handed over, naming the number', () => {
    const reason = quantityBlockedReason({ quantity: 2, fulfilled: 6, picked: 8 });
    expect(reason).toContain('6');
    expect(reason).toMatch(/handed over/i);
  });

  it('blocks a drop below what is staged, and says to unstage', () => {
    const reason = quantityBlockedReason({ quantity: 5, fulfilled: 0, picked: 8 });
    expect(reason).toMatch(/unstage/i);
  });

  it('blocks zero, pointing at removal instead', () => {
    expect(quantityBlockedReason({ quantity: 0, fulfilled: 0, picked: null })).toMatch(
      /remove the line/i,
    );
  });

  it('treats a null picked quantity as nothing staged', () => {
    expect(quantityBlockedReason({ quantity: 1, fulfilled: 0, picked: null })).toBeNull();
  });
});

describe('removalBlockedReason', () => {
  it('permits removal of an untouched line on a multi-line order', () => {
    expect(
      removalBlockedReason({
        fulfilled: 0,
        picked: null,
        hasActiveReservation: false,
        isOnlyLine: false,
      }),
    ).toBeNull();
  });

  it.each([
    [
      'handed over',
      { fulfilled: 3, picked: null, hasActiveReservation: false, isOnlyLine: false },
      /handed over/i,
    ],
    [
      'staged',
      { fulfilled: 0, picked: 2, hasActiveReservation: false, isOnlyLine: false },
      /unstage/i,
    ],
    [
      'reserved',
      { fulfilled: 0, picked: null, hasActiveReservation: true, isOnlyLine: false },
      /reserved/i,
    ],
    [
      'last line',
      { fulfilled: 0, picked: null, hasActiveReservation: false, isOnlyLine: true },
      /cancel the order/i,
    ],
  ])('refuses a %s line', (_label, input, expected) => {
    expect(removalBlockedReason(input)).toMatch(expected);
  });
});

describe('OrderLineActions — changing the quantity', () => {
  it('sends the typed quantity and refreshes on success', async () => {
    const user = renderRow();
    const field = await openEditor(user);
    await user.clear(field);
    await user.type(field, '9');
    await user.click(screen.getByRole('button', { name: /save quantity for blue widget/i }));

    expect(updateLine).toHaveBeenCalledWith({
      id: '11111111-1111-4111-8111-111111111111',
      lineId: '22222222-2222-4222-8222-222222222222',
      quantity: 9,
    });
    expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining('9'));
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('keeps Save disabled below the handed-over floor and never calls the server', async () => {
    const user = renderRow({ quantityRequested: 10, quantityFulfilled: 6 });
    const field = await openEditor(user);
    await user.clear(field);
    await user.type(field, '2');

    const save = screen.getByRole('button', { name: /save quantity for blue widget/i });
    expect(save).toBeDisabled();
    expect(screen.getByText(/handed over/i)).toBeInTheDocument();
    await user.click(save);
    expect(updateLine).not.toHaveBeenCalled();
  });

  it('keeps Save disabled below the staged floor', async () => {
    const user = renderRow({ quantityRequested: 10, quantityPicked: 7 });
    const field = await openEditor(user);
    await user.clear(field);
    await user.type(field, '3');

    expect(screen.getByRole('button', { name: /save quantity for blue widget/i })).toBeDisabled();
    expect(screen.getByText(/unstage/i)).toBeInTheDocument();
  });

  it('still allows RAISING a line that is already part-fulfilled and part-staged', async () => {
    const user = renderRow({ quantityRequested: 10, quantityFulfilled: 6, quantityPicked: 8 });
    const field = await openEditor(user);
    await user.clear(field);
    await user.type(field, '25');

    expect(
      screen.getByRole('button', { name: /save quantity for blue widget/i }),
    ).not.toBeDisabled();
  });

  it('does not offer to save an unchanged quantity', async () => {
    const user = renderRow({ quantityRequested: 4 });
    await openEditor(user);
    expect(screen.getByRole('button', { name: /save quantity for blue widget/i })).toBeDisabled();
  });

  it('renders the server refusal verbatim and leaves the editor open', async () => {
    updateLine.mockResolvedValue({
      ok: false,
      error: {
        code: 'conflict',
        message: '6 of these are already picked and staged — unstage them first.',
      },
    } as Awaited<ReturnType<typeof updateOrderRequestLineQuantityAction>>);
    const user = renderRow();
    const field = await openEditor(user);
    await user.clear(field);
    await user.type(field, '9');
    await user.click(screen.getByRole('button', { name: /save quantity for blue widget/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      '6 of these are already picked and staged — unstage them first.',
    );
    expect(screen.getByLabelText(/requested quantity for blue widget/i)).toBeInTheDocument();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('warns that a printed pick slip is now stale', async () => {
    updateLine.mockResolvedValue({
      ok: true,
      data: { pickSlipStale: true, quantity: 9 },
    } as Awaited<ReturnType<typeof updateOrderRequestLineQuantityAction>>);
    const user = renderRow();
    const field = await openEditor(user);
    await user.clear(field);
    await user.type(field, '9');
    await user.click(screen.getByRole('button', { name: /save quantity for blue widget/i }));

    expect(toastMock.warning).toHaveBeenCalledWith(
      expect.stringMatching(/pick slip is now out of date/i),
      expect.objectContaining({ duration: 8000 }),
    );
  });

  it('shows a spinner instead of a saved value while the write is in flight', async () => {
    type UpdateResult = Awaited<ReturnType<typeof updateOrderRequestLineQuantityAction>>;
    let release: (v: UpdateResult) => void = () => {};
    updateLine.mockReturnValue(
      new Promise<UpdateResult>((resolve) => {
        release = resolve;
      }),
    );
    const user = renderRow();
    const field = await openEditor(user);
    await user.clear(field);
    await user.type(field, '9');
    await user.click(screen.getByRole('button', { name: /save quantity for blue widget/i }));

    // Not optimistic: the row is still in its editing state, nothing has been
    // refreshed, and both controls are locked until the server answers.
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/requested quantity for blue widget/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /save quantity for blue widget/i })).toBeDisabled();

    release({ ok: true, data: { pickSlipStale: false, quantity: 9 } });
  });
});

describe('OrderLineActions — removing a line', () => {
  it('confirms by name before deleting anything', async () => {
    const user = renderRow();
    await user.click(screen.getByRole('button', { name: /remove blue widget/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Blue widget');
    expect(removeLine).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /remove item/i }));
    expect(removeLine).toHaveBeenCalledWith({
      id: '11111111-1111-4111-8111-111111111111',
      lineId: '22222222-2222-4222-8222-222222222222',
    });
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringContaining('Blue widget'),
    );
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('renders the server refusal verbatim', async () => {
    removeLine.mockResolvedValue({
      ok: false,
      error: { code: 'conflict', message: 'Stock is still reserved for this item.' },
    } as Awaited<ReturnType<typeof removeOrderRequestLineAction>>);
    const user = renderRow();
    await user.click(screen.getByRole('button', { name: /remove blue widget/i }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /remove item/i }));

    expect(toastMock.error).toHaveBeenCalledWith('Stock is still reserved for this item.');
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['already handed over', { quantityFulfilled: 3 }, /handed over/i],
    ['staged by a picker', { quantityPicked: 2 }, /unstage/i],
    ['still holding a reservation', { hasActiveReservation: true }, /reserved/i],
    ['the only line left', { isOnlyLine: true }, /cancel the order/i],
  ])('disables Remove on a line that is %s, with the reason attached', async (
    _label,
    over,
    expected,
  ) => {
    const user = renderRow(over);
    const button = screen.getByRole('button', { name: /remove blue widget/i });
    expect(button).toBeDisabled();
    // The reason is readable by hover (wrapper title) and by screen reader
    // (aria-describedby), and clicking opens nothing.
    expect(screen.getByTitle(expected)).toBeInTheDocument();
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toMatch(expected);
    await user.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('still lets a blocked line have its quantity changed', () => {
    renderRow({ quantityFulfilled: 3 });
    expect(
      screen.getByRole('button', { name: /change quantity for blue widget/i }),
    ).not.toBeDisabled();
  });
});
