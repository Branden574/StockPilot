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

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// The panel + its dialogs import the server-action module; stub every action
// it references so the client component renders without pulling server deps.
vi.mock('@/server/actions/order-requests', () => ({
  approveOrderRequestAction: vi.fn(),
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
