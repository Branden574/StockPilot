import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reopenPickingAction } from '@/server/actions/order-requests';

import { ManagerActionsPanel } from './manager-actions-panel';

// Next's Link does navigation gymnastics we don't care about here — stub it
// down to a plain anchor (the "Open digital pick" affordance uses it).
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// The panel + its dialogs import the server-action module; stub every action
// it references so the client component renders without pulling server deps.
vi.mock('@/server/actions/order-requests', () => ({
  approveOrderPartialAction: vi.fn(),
  approveOrderRequestAction: vi.fn(),
  closePartialAction: vi.fn(),
  confirmPhysicalSignatureAction: vi.fn(),
  resumeFulfillmentAction: vi.fn(),
  assignDeliveryAction: vi.fn(),
  assignPickingAction: vi.fn(),
  claimPickingAction: vi.fn(),
  completePickingAction: vi.fn(),
  denyOrderRequestAction: vi.fn(),
  generatePackingSlipsAction: vi.fn(),
  generatePickSlipAction: vi.fn(),
  markInTransitAction: vi.fn(),
  releasePickingAction: vi.fn(),
  reopenPickingAction: vi.fn(),
  setOrderInternalNotesAction: vi.fn(),
  setOrderNeededByAction: vi.fn(),
  stageOrderAction: vi.fn(),
  suggestNeededByAction: vi.fn(),
}));

const reopenPicking = vi.mocked(reopenPickingAction);

type PanelProps = React.ComponentProps<typeof ManagerActionsPanel>;

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    orderId: 'order-1',
    status: 'pick_slip_generated',
    internalNotes: null,
    neededBy: null,
    hasRequesterNote: false,
    fulfillmentType: 'pickup',
    assignedDeliveryUserId: null,
    signatureToken: null,
    hasSignature: false,
    signedByName: null,
    signedAt: null,
    drivers: [],
    canApprove: false,
    viewerRole: 'staff',
    viewerUserId: 'me',
    assignedPickerId: null,
    assignedPickerName: null,
    pickers: [],
    viewerCanPick: true,
    ...overrides,
  };
}

describe('ManagerActionsPanel — picking claim/lock states', () => {
  it('staff + unassigned: Claim only, chip shows Unassigned', () => {
    render(
      <ManagerActionsPanel
        {...baseProps({ viewerRole: 'staff', assignedPickerId: null })}
      />,
    );
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Claim picking/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Print pick slip')).toBeInTheDocument();
    expect(screen.queryByText('Open digital pick')).not.toBeInTheDocument();
    expect(screen.queryByText('Mark picking complete')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Release/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /(Assign|Reassign) picker/ }),
    ).not.toBeInTheDocument();
  });

  it('staff assigned to me: pick + complete + release, chip names the picker', () => {
    render(
      <ManagerActionsPanel
        {...baseProps({
          viewerRole: 'staff',
          assignedPickerId: 'me',
          assignedPickerName: 'Dana Diaz',
        })}
      />,
    );
    expect(screen.getByText(/Being picked by Dana Diaz/)).toBeInTheDocument();
    expect(screen.getByText('Open digital pick')).toBeInTheDocument();
    expect(screen.getByText('Mark picking complete')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Release/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Claim picking/ }),
    ).not.toBeInTheDocument();
  });

  it('staff assigned to someone else: print only', () => {
    render(
      <ManagerActionsPanel
        {...baseProps({
          viewerRole: 'staff',
          viewerUserId: 'me',
          assignedPickerId: 'other-picker',
          assignedPickerName: 'Sam Lee',
        })}
      />,
    );
    expect(screen.getByText(/Being picked by Sam Lee/)).toBeInTheDocument();
    expect(screen.getByText('Print pick slip')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Claim picking/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Open digital pick')).not.toBeInTheDocument();
    expect(screen.queryByText('Mark picking complete')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Release/ })).not.toBeInTheDocument();
  });

  it('manager + unassigned: pick, complete, assign picker; no claim; no release', () => {
    render(
      <ManagerActionsPanel
        {...baseProps({
          canApprove: true,
          viewerRole: 'manager',
          assignedPickerId: null,
        })}
      />,
    );
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByText('Open digital pick')).toBeInTheDocument();
    expect(screen.getByText('Mark picking complete')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Assign picker/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Claim picking/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Release/ })).not.toBeInTheDocument();
  });

  it('manager + assigned: reassign + release, chip names the picker', () => {
    render(
      <ManagerActionsPanel
        {...baseProps({
          canApprove: true,
          viewerRole: 'manager',
          assignedPickerId: 'other-picker',
          assignedPickerName: 'Sam Lee',
        })}
      />,
    );
    expect(screen.getByText(/Being picked by Sam Lee/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Reassign picker/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Release/ })).toBeInTheDocument();
  });
});

describe('ManagerActionsPanel — reopen picking', () => {
  beforeEach(() => {
    reopenPicking.mockReset();
    reopenPicking.mockResolvedValue({ ok: true, data: undefined });
  });

  it('offers Reopen picking to a manager at picking_complete', () => {
    render(
      <ManagerActionsPanel
        {...baseProps({ status: 'picking_complete', canApprove: true, viewerRole: 'manager' })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Reopen picking' })).toBeInTheDocument();
  });

  it('offers Reopen picking to a manager at packing_slip_generated', () => {
    render(
      <ManagerActionsPanel
        {...baseProps({
          status: 'packing_slip_generated',
          canApprove: true,
          viewerRole: 'manager',
          fulfillmentType: 'pickup',
        })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Reopen picking' })).toBeInTheDocument();
  });

  it('hides Reopen picking from staff — manager-or-above override only', () => {
    render(
      <ManagerActionsPanel
        {...baseProps({ status: 'picking_complete', canApprove: false, viewerRole: 'staff' })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Reopen picking' })).not.toBeInTheDocument();
  });

  it('keeps confirm disabled until a reason is typed, then submits id + reason', async () => {
    const user = userEvent.setup();
    render(
      <ManagerActionsPanel
        {...baseProps({ status: 'picking_complete', canApprove: true, viewerRole: 'manager' })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Reopen picking' }));
    const dialog = await screen.findByRole('dialog');
    const confirmButton = within(dialog).getByRole('button', { name: 'Reopen picking' });
    expect(confirmButton).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Reason'), 'Miscount on line 2');
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);
    expect(reopenPicking).toHaveBeenCalledWith({ id: 'order-1', reason: 'Miscount on line 2' });
  });

  it('blocks submit on a whitespace-only reason', async () => {
    const user = userEvent.setup();
    render(
      <ManagerActionsPanel
        {...baseProps({ status: 'picking_complete', canApprove: true, viewerRole: 'manager' })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Reopen picking' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Reason'), '   ');

    expect(within(dialog).getByRole('button', { name: 'Reopen picking' })).toBeDisabled();
    expect(reopenPicking).not.toHaveBeenCalled();
  });

  it('closes the dialog and refreshes on success; shows the error toast and keeps it open on failure', async () => {
    reopenPicking.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: "This order has been signed for and can't be reopened." },
    });
    const user = userEvent.setup();
    render(
      <ManagerActionsPanel
        {...baseProps({ status: 'picking_complete', canApprove: true, viewerRole: 'manager' })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Reopen picking' }));
    let dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Reason'), 'Miscount on line 2');
    await user.click(within(dialog).getByRole('button', { name: 'Reopen picking' }));

    // Failure: dialog stays open, reason is preserved.
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Reason')).toHaveValue('Miscount on line 2');

    await user.click(within(dialog).getByRole('button', { name: 'Reopen picking' }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});

describe('ManagerActionsPanel — reason dialogs clear on cancel', () => {
  // Regression coverage: Cancel used to call setXOpen(false) directly,
  // bypassing the onOpenChange handler that clears the typed reason.
  // Escape/backdrop already routed through onOpenChange and worked; the
  // Cancel button did not — so the stale reason resurfaced (and was
  // submittable) against a later, unrelated open of the same dialog.

  it('reopen dialog: typing a reason then hitting Cancel leaves it empty on the next open', async () => {
    const user = userEvent.setup();
    render(
      <ManagerActionsPanel
        {...baseProps({ status: 'picking_complete', canApprove: true, viewerRole: 'manager' })}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Reopen picking' }));
    let dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Reason'), 'Miscount on line 2');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(reopenPicking).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Reopen picking' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Reason')).toHaveValue('');
  });

  it('deny dialog: typing a reason then hitting Cancel leaves it empty on the next open', async () => {
    const user = userEvent.setup();
    render(
      <ManagerActionsPanel
        {...baseProps({ status: 'pending_approval', canApprove: true, viewerRole: 'manager' })}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Deny' }));
    let dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Reason'), 'Duplicate request');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Deny' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Reason')).toHaveValue('');
  });
});

/**
 * The stock-dependent actions (F2-1): the page hands the panel core's
 * orderStockGates, fed by readiness. Each action is hidden, enabled, or
 * DISABLED with the reason shown under the actions; a failed check never
 * reads as "stock is fine" (the old booleans defaulted to false and hid the
 * action silently).
 */
describe('ManagerActionsPanel — stock gates from readiness', () => {
  const manager = { canApprove: true, viewerRole: 'manager' as const };
  const gates = (over: Partial<NonNullable<PanelProps['stockGates']>> = {}): PanelProps['stockGates'] => ({
    approvePartial: 'hidden',
    resume: 'waiting',
    notice: null,
    canRetry: false,
    ...over,
  });

  beforeEach(() => routerRefresh.mockReset());

  it('pending, short: Approve partial is offered, and the note under Approve says why a strict Approve fails', () => {
    render(
      <ManagerActionsPanel
        {...baseProps({
          ...manager,
          status: 'pending_approval',
          stockGates: gates({ approvePartial: 'enabled' }),
          approveNotice: '2 lines are short, so Approve will be refused. Use Approve partial or change the lines.',
        })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Approve partial' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.getByTestId('approve-short-notice')).toHaveTextContent(
      '2 lines are short, so Approve will be refused. Use Approve partial or change the lines.',
    );
  });

  it('pending, not short: no Approve partial and no note', () => {
    render(<ManagerActionsPanel {...baseProps({ ...manager, status: 'pending_approval', stockGates: gates() })} />);
    expect(screen.queryByRole('button', { name: 'Approve partial' })).toBeNull();
    expect(screen.queryByTestId('approve-short-notice')).toBeNull();
    expect(screen.queryByTestId('order-stock-notice')).toBeNull();
  });

  it('pending, the check failed: Approve partial is shown DISABLED with the reason and a Try again that re-reads', async () => {
    const user = userEvent.setup();
    const notice = 'Could not check stock for this order. Approve partial is unavailable until it loads.';
    render(
      <ManagerActionsPanel
        {...baseProps({
          ...manager,
          status: 'pending_approval',
          stockGates: gates({ approvePartial: 'disabled', notice, canRetry: true }),
        })}
      />,
    );
    const partial = screen.getByRole('button', { name: 'Approve partial' });
    expect(partial).toBeDisabled();
    expect(partial).toHaveAttribute('aria-describedby', 'order-stock-notice');
    expect(screen.getByTestId('order-stock-notice')).toHaveTextContent(notice);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('a reason no re-read can fix (a hidden item) has no Try again', () => {
    render(
      <ManagerActionsPanel
        {...baseProps({
          ...manager,
          status: 'pending_approval',
          stockGates: gates({
            approvePartial: 'disabled',
            notice: 'Some items on this order are not visible to you, so stock could not be checked. Approve partial is unavailable.',
          }),
        })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Approve partial' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('backordered: Resume enabled, disabled with the reason, or waiting for stock', () => {
    const { rerender } = render(
      <ManagerActionsPanel {...baseProps({ ...manager, status: 'backordered', stockGates: gates({ resume: 'enabled' }) })} />,
    );
    expect(screen.getByRole('button', { name: 'Resume fulfillment' })).toBeEnabled();

    const notice = 'Could not check stock for this order. Resume fulfillment is unavailable until it loads.';
    rerender(
      <ManagerActionsPanel
        {...baseProps({
          ...manager,
          status: 'backordered',
          stockGates: gates({ resume: 'disabled', notice, canRetry: true }),
        })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Resume fulfillment' })).toBeDisabled();
    expect(screen.getByTestId('order-stock-notice')).toHaveTextContent(notice);

    rerender(<ManagerActionsPanel {...baseProps({ ...manager, status: 'backordered', stockGates: gates() })} />);
    expect(screen.queryByRole('button', { name: 'Resume fulfillment' })).toBeNull();
    expect(screen.getByText('Resume unlocks when owed items are back in stock.')).toBeInTheDocument();
  });

  it('without gates (not a stock-dependent status), nothing is offered or said', () => {
    render(<ManagerActionsPanel {...baseProps({ ...manager, status: 'pending_approval' })} />);
    expect(screen.queryByRole('button', { name: 'Approve partial' })).toBeNull();
    expect(screen.queryByTestId('order-stock-notice')).toBeNull();
  });

  it('the notices belong to the approver on the two stock-dependent statuses only', () => {
    render(
      <ManagerActionsPanel
        {...baseProps({
          status: 'approved',
          canApprove: true,
          viewerRole: 'manager',
          stockGates: gates({ notice: 'stale notice' }),
          approveNotice: 'stale note',
        })}
      />,
    );
    expect(screen.queryByTestId('order-stock-notice')).toBeNull();
    expect(screen.queryByTestId('approve-short-notice')).toBeNull();
  });
});
