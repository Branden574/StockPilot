import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORDER_ITEMS_ACCESS_ALLOW_SCOPE_COPY,
  ORDER_ITEMS_ACCESS_BUSY_COPY,
  ORDER_ITEMS_ACCESS_CHANGED_COPY,
  ORDER_ITEMS_ACCESS_DISABLED_COPY,
  ORDER_ITEMS_ACCESS_KEPT_ON_REINVITE_COPY,
  ORDER_ITEMS_ACCESS_MANAGER_NEEDS_DENY_COPY,
  ORDER_ITEMS_ACCESS_MEMBER_NOT_FOUND_COPY,
  ORDER_ITEMS_ACCESS_MODULE_OFF_COPY,
  ORDER_ITEMS_ACCESS_PHONE_ENTRY_COPY,
  ORDER_ITEMS_ACCESS_ROLE_DEFAULT_COPY,
  ORDER_ITEMS_ACCESS_SAVE_FAILED_COPY,
} from '@stockpilot/core';

/**
 * God Admin's Order items access dialog (orders:manage_catalog_visibility,
 * migration 0413), opened from a member's row on the console Users tab.
 *
 * Pinned: the member, their role default and their current exception are
 * shown; the three choices; a live "After saving" preview from the same core
 * function as the column; the explanations that apply; Save sends the chosen
 * state with the state the dialog showed (compare-and-set); a stale step-up
 * re-prompts and retries once; a lost compare-and-set says the row changed
 * (never "not authorized") and moves the dialog to what it is now; busy and
 * failure keep the dialog open; a member who left closes it; and nothing can
 * close or resend it while a save is out.
 */

const h = vi.hoisted(() => ({
  action: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  ensure: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('sonner', () => ({ toast: { success: h.success, error: h.error } }));
vi.mock('@/server/actions/platform/permission-exceptions', () => ({
  setOrderItemsAccessAction: (...a: unknown[]) => h.action(...a),
}));

import { OrderItemsAccessDialog, type OrderItemsAccessTarget } from './order-items-access-dialog';

const ORG = '0413c000-0000-4000-8000-000000000001';
const USER = '0413c000-0000-4000-8000-0000000000a1';

function target(over: Partial<OrderItemsAccessTarget> = {}): OrderItemsAccessTarget {
  return {
    organizationId: ORG,
    userId: USER,
    name: 'Riley Example',
    role: 'manager',
    disabled: false,
    exception: 'default',
    ordersModuleEnabled: true,
    canRequestOrders: true,
    ...over,
  };
}

function Harness({
  initial,
  onOpenChange,
}: {
  initial: OrderItemsAccessTarget;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = React.useState(true);
  return (
    <OrderItemsAccessDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange?.(next);
        setOpen(next);
      }}
      target={initial}
      ensureStepUp={h.ensure}
    />
  );
}

function setup(over: Partial<OrderItemsAccessTarget> = {}, onOpenChange?: (o: boolean) => void) {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const utils = render(<Harness initial={target(over)} onOpenChange={onOpenChange} />);
  return { user, ...utils };
}

const saveButton = () => screen.getByRole('button', { name: /^(save|saving\.\.\.)$/i });
const choice = (name: RegExp) => screen.getByRole('radio', { name });

beforeEach(() => {
  vi.clearAllMocks();
  h.ensure.mockResolvedValue(true);
  h.action.mockResolvedValue({
    ok: true,
    data: { before: 'default', after: 'deny', targetRole: 'manager', changed: true },
  });
});

describe('OrderItemsAccessDialog: what it shows', () => {
  it('names the member, their role, the role default and the current exception', () => {
    setup({ exception: 'deny' });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Riley Example')).toBeInTheDocument();
    expect(within(dialog).getByText('Manager')).toBeInTheDocument();
    expect(within(dialog).getByText(ORDER_ITEMS_ACCESS_ROLE_DEFAULT_COPY)).toBeInTheDocument();
    expect(within(dialog).getByTestId('order-items-access-now')).toHaveTextContent(
      'Now: Deny. Not allowed.',
    );
    expect(choice(/^deny$/i)).toBeChecked();
    expect(choice(/follow role default/i)).not.toBeChecked();
    expect(choice(/^allow$/i)).not.toBeChecked();
  });

  it('says Disabled for a disabled account, and why it has no access', () => {
    setup({ disabled: true });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Disabled')).toBeInTheDocument();
    expect(within(dialog).getByText(ORDER_ITEMS_ACCESS_DISABLED_COPY)).toBeInTheDocument();
  });

  it('keeps Save off until a different choice is made', async () => {
    const { user } = setup();
    expect(saveButton()).toBeDisabled();
    await user.click(choice(/^deny$/i));
    expect(saveButton()).toBeEnabled();
    await user.click(choice(/follow role default/i));
    expect(saveButton()).toBeDisabled();
  });
});

describe('OrderItemsAccessDialog: the live preview and explanations', () => {
  it('Deny on a manager: not allowed, stays through role changes, and a manager needs Deny', async () => {
    const { user } = setup({ role: 'manager' });
    expect(screen.getByTestId('order-items-access-after')).toHaveTextContent(
      'After saving: Allowed (role default).',
    );
    await user.click(choice(/^deny$/i));
    expect(screen.getByTestId('order-items-access-after')).toHaveTextContent(
      'After saving: Not allowed (denied by StockPilot). This stays until StockPilot changes it, even if their role changes.',
    );
    expect(screen.getByText(ORDER_ITEMS_ACCESS_MANAGER_NEEDS_DENY_COPY)).toBeInTheDocument();
    expect(screen.getByText(ORDER_ITEMS_ACCESS_KEPT_ON_REINVITE_COPY)).toBeInTheDocument();
  });

  it('Allow on staff: allowed, only this capability, inside their existing scope', async () => {
    const { user } = setup({ role: 'staff' });
    expect(screen.getByTestId('order-items-access-after')).toHaveTextContent(
      'After saving: Not allowed (role default).',
    );
    await user.click(choice(/^allow$/i));
    expect(screen.getByTestId('order-items-access-after')).toHaveTextContent(
      'After saving: Allowed (allowed by StockPilot).',
    );
    expect(screen.getByText(ORDER_ITEMS_ACCESS_ALLOW_SCOPE_COPY)).toBeInTheDocument();
    expect(screen.queryByText(ORDER_ITEMS_ACCESS_MANAGER_NEEDS_DENY_COPY)).toBeNull();
  });

  it('Follow role default on a denied manager previews the default coming back', async () => {
    const { user } = setup({ role: 'manager', exception: 'deny' });
    await user.click(choice(/follow role default/i));
    expect(screen.getByTestId('order-items-access-after')).toHaveTextContent(
      'After saving: Allowed (role default).',
    );
    expect(screen.queryByText(ORDER_ITEMS_ACCESS_KEPT_ON_REINVITE_COPY)).toBeNull();
  });

  it('explains the prerequisites it does not grant: the Orders module and the phone entry', async () => {
    const { user } = setup({ role: 'staff', ordersModuleEnabled: false, canRequestOrders: false });
    await user.click(choice(/^allow$/i));
    expect(screen.getByTestId('order-items-access-after')).toHaveTextContent(
      'After saving: Not allowed (the Orders module is off).',
    );
    expect(screen.getByText(ORDER_ITEMS_ACCESS_MODULE_OFF_COPY)).toBeInTheDocument();
    expect(screen.getByText(ORDER_ITEMS_ACCESS_PHONE_ENTRY_COPY)).toBeInTheDocument();
  });
});

describe('OrderItemsAccessDialog: saving', () => {
  it('sends the choice with the state it showed, then closes, confirms and re-reads the page', async () => {
    const onOpenChange = vi.fn();
    const { user } = setup({ role: 'manager' }, onOpenChange);
    await user.click(choice(/^deny$/i));
    await user.click(saveButton());

    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    expect(h.action).toHaveBeenCalledTimes(1);
    expect(h.action).toHaveBeenCalledWith({
      organizationId: ORG,
      targetUserId: USER,
      state: 'deny',
      expectedState: 'default',
    });
    expect(h.success).toHaveBeenCalledWith(
      'Order items access saved: Not allowed for Riley Example.',
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a stale step-up re-prompts for the authenticator and retries once', async () => {
    h.action
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'forbidden',
          message: 'Not authorized.',
          details: { reason: 'aal2_required' },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { before: 'default', after: 'allow', targetRole: 'staff', changed: true },
      });
    const { user } = setup({ role: 'staff' });
    await user.click(choice(/^allow$/i));
    await user.click(saveButton());

    await waitFor(() => expect(h.success).toHaveBeenCalled());
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.action).toHaveBeenCalledTimes(2);
    expect(h.success).toHaveBeenCalledWith('Order items access saved: Allowed for Riley Example.');
  });

  it('a cancelled step-up saves nothing and keeps the dialog open', async () => {
    h.ensure.mockResolvedValue(false);
    h.action.mockResolvedValue({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Not authorized.',
        details: { reason: 'aal2_required' },
      },
    });
    const { user } = setup({ role: 'staff' });
    await user.click(choice(/^allow$/i));
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Confirm with your authenticator to save this change.',
    );
    expect(h.action).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('a lost compare-and-set says the row changed, never "not authorized", and moves to what it is now', async () => {
    h.action.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message: ORDER_ITEMS_ACCESS_CHANGED_COPY,
        details: { reason: 'permission_exception_changed', current: 'allow' },
      },
    });
    const { user } = setup({ role: 'staff', exception: 'default' });
    await user.click(choice(/^deny$/i));
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(ORDER_ITEMS_ACCESS_CHANGED_COPY);
    expect(screen.queryByText(/not authorized/i)).toBeNull();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('order-items-access-now')).toHaveTextContent('Now: Allow. Allowed.');
    // The operator's choice is kept; the next save compares against the new state.
    expect(choice(/^deny$/i)).toBeChecked();
    h.action.mockResolvedValueOnce({
      ok: true,
      data: { before: 'allow', after: 'deny', targetRole: 'staff', changed: true },
    });
    // As in the busy case: Save comes back one commit after the sentence.
    await waitFor(() => expect(saveButton()).toBeEnabled());
    await user.click(saveButton());
    await waitFor(() => expect(h.action).toHaveBeenCalledTimes(2));
    expect(h.action).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'deny', expectedState: 'allow' }),
    );
  });

  it('busy keeps the dialog open with the try-again sentence', async () => {
    h.action.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message: ORDER_ITEMS_ACCESS_BUSY_COPY,
        details: { reason: 'busy' },
      },
    });
    const { user } = setup({ role: 'manager' });
    await user.click(choice(/^deny$/i));
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(ORDER_ITEMS_ACCESS_BUSY_COPY);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // The sentence lands one commit before the save's transition ends: the
    // dialog sets it after an await, so for that commit Save is still off.
    // findByRole can resolve on it, so wait for Save to come back.
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('an unexpected failure claims nothing and keeps the dialog open', async () => {
    h.action.mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal_error', message: ORDER_ITEMS_ACCESS_SAVE_FAILED_COPY },
    });
    const { user } = setup({ role: 'manager' });
    await user.click(choice(/^deny$/i));
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(ORDER_ITEMS_ACCESS_SAVE_FAILED_COPY);
    expect(h.success).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('a member who left closes the dialog and re-reads the page', async () => {
    h.action.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'not_found',
        message: ORDER_ITEMS_ACCESS_MEMBER_NOT_FOUND_COPY,
        details: { reason: 'member_not_found' },
      },
    });
    const onOpenChange = vi.fn();
    const { user } = setup({ role: 'manager' }, onOpenChange);
    await user.click(choice(/^deny$/i));
    await user.click(saveButton());

    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    expect(h.error).toHaveBeenCalledWith(ORDER_ITEMS_ACCESS_MEMBER_NOT_FOUND_COPY);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cannot be closed or sent twice while a save is out', async () => {
    let resolve!: (v: unknown) => void;
    h.action.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const onOpenChange = vi.fn();
    const { user } = setup({ role: 'manager' }, onOpenChange);
    await user.click(choice(/^deny$/i));
    await user.click(saveButton());

    await waitFor(() => expect(saveButton()).toHaveTextContent('Saving...'));
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(h.action).toHaveBeenCalledTimes(1);

    resolve({
      ok: true,
      data: { before: 'default', after: 'deny', targetRole: 'manager', changed: true },
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
