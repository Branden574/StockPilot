import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40: Assign (delivery and picker) and Cancel request set their busy flags,
// awaited the action with no catch and cleared them only when it answered. A
// call that got no answer (offline, a server error, a deploy) left the button
// spinning with no message, and the dialog or the confirm refused to close,
// since both stay open while their call is pending.
// ---------------------------------------------------------------------------

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/order-requests', () => ({
  assignDeliveryAction: vi.fn(),
  assignPickingAction: vi.fn(),
  cancelOrderRequestAction: vi.fn(),
}));

import { toast } from 'sonner';

import {
  assignDeliveryAction,
  assignPickingAction,
  cancelOrderRequestAction,
} from '@/server/actions/order-requests';

import { AssignDeliveryDialog } from './assign-delivery-dialog';
import { AssignPickerDialog } from './assign-picker-dialog';
import { CancelOrderButton } from './cancel-order-button';

const ORDER = '11111111-1111-4111-8111-111111111111';
const PEOPLE = [{ userId: 'u-1', fullName: 'Driver One', email: 'driver.one@example.com' }];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('order assign and cancel controls when the request gets no answer', () => {
  it('Assign delivery says the delivery was not assigned, and the dialog can be used or closed', async () => {
    vi.mocked(assignDeliveryAction).mockRejectedValueOnce(offline());
    render(
      <AssignDeliveryDialog
        orderId={ORDER}
        drivers={PEOPLE}
        currentDriverId="u-1"
        trigger={<button type="button">Assign driver</button>}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Assign driver' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Assign/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('assign the delivery')),
    );
    expect(within(dialog).getByRole('button', { name: /Assign/ })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Assign picker says the picker was not assigned, and the dialog can be used or closed', async () => {
    vi.mocked(assignPickingAction).mockRejectedValueOnce(offline());
    render(
      <AssignPickerDialog
        orderId={ORDER}
        pickers={PEOPLE}
        currentPickerId="u-1"
        trigger={<button type="button">Assign picker</button>}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Assign picker' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Assign$/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('assign the picker')),
    );
    expect(within(dialog).getByRole('button', { name: /^Assign$/ })).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Cancel request says the request was not cancelled, and the confirm works again', async () => {
    vi.mocked(cancelOrderRequestAction).mockRejectedValueOnce(offline());
    render(<CancelOrderButton orderId={ORDER} status="approved" />);
    fireEvent.click(screen.getByRole('button', { name: /Cancel request/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel request' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('cancel the request')),
    );
    expect(within(dialog).getByRole('button', { name: 'Cancel request' })).toBeEnabled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
