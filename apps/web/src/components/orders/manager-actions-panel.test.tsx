import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COMPLETION_CONFIRM_LABEL,
  COMPLETION_REVIEW_LABEL,
  describeCompletionConfirm,
  type CompletionConfirmCopy,
  type DepartureLine,
} from '@stockpilot/core';

import {
  completePickingAction,
  confirmPhysicalSignatureAction,
  markInTransitAction,
  reopenPickingAction,
  stageOrderAction,
} from '@/server/actions/order-requests';

import { toast } from 'sonner';

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
    orgTimeZone: 'America/Los_Angeles',
    hasRequesterNote: false,
    fulfillmentType: 'pickup',
    assignedDeliveryUserId: null,
    signatureToken: null,
    hasSignature: false,
    signedByName: null,
    signedAt: null,
    drivers: [],
    canApprove: false,
    canAssignDelivery: false,
    viewerRole: 'staff',
    viewerUserId: 'me',
    assignedPickerId: null,
    assignedPickerName: null,
    pickers: [],
    viewerCanPick: true,
    completionConfirm: null,
    departureLines: [],
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
          approveNotice: '2 lines ask for more than is available now, so Approve will be refused. Use Approve partial or change the lines.',
        })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Approve partial' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.getByTestId('approve-short-notice')).toHaveTextContent(
      '2 lines ask for more than is available now, so Approve will be refused. Use Approve partial or change the lines.',
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

// ── F2-2: caught before it leaves ───────────────────────────────────────────
//
// Call-site pins: each test clicks the real button and proves the confirm
// opens INSTEAD of the action. Deleting the confirm's call from a button (the
// SO-000100 shape: "Mark picking complete" zeroed a short line with no
// prompt) makes the action run on the first click, and the test fails.

/** The SO-000100 confirm, as the page builds it (core, from the projection). */
const SO_000100_CONFIRM: CompletionConfirmCopy = {
  title: 'Before you complete picking',
  paragraphs: [
    'Not everything will be picked. L4L - Pen Black & Rose Gold: 0 of 60. It will be owed at hand-over, or you can remove it from the order first.',
  ],
  reviewLabel: COMPLETION_REVIEW_LABEL,
  confirmLabel: COMPLETION_CONFIRM_LABEL,
  focusLineId: 'line-pens',
};

/** A settled pick with the pens line not picked at all (SO-000100). */
const SHORT_LINES: DepartureLine[] = [
  {
    lineId: 'line-notebooks',
    itemName: 'Notebook',
    quantityRequested: 60,
    quantityFulfilled: 0,
    quantityPicked: 60,
  },
  {
    lineId: 'line-pens',
    itemName: 'L4L - Pen Black & Rose Gold',
    quantityRequested: 60,
    quantityFulfilled: 0,
    quantityPicked: 0,
  },
];
const PICKED_LINES: DepartureLine[] = SHORT_LINES.map((l) => ({ ...l, quantityPicked: 60 }));

/** A stand-in for the order page's row of a line, with its first fix. */
function renderLineRow(lineId: string) {
  const row = document.createElement('div');
  row.id = `order-line-${lineId}`;
  row.tabIndex = -1;
  const fix = document.createElement('button');
  fix.setAttribute('data-short-line-fix', '');
  fix.textContent = 'Remove line';
  row.appendChild(fix);
  document.body.appendChild(row);
  return { row, fix, remove: () => row.remove() };
}

const completePicking = vi.mocked(completePickingAction);
const stageOrder = vi.mocked(stageOrderAction);
const markInTransit = vi.mocked(markInTransitAction);
const physicalSignature = vi.mocked(confirmPhysicalSignatureAction);

describe('ManagerActionsPanel — the confirm before Mark picking complete (F2-2, SO-000100)', () => {
  const manager = {
    canApprove: true,
    viewerRole: 'manager' as const,
    status: 'picking_in_progress' as const,
    assignedPickerId: 'me',
  };

  beforeEach(() => {
    completePicking.mockReset();
    completePicking.mockResolvedValue({ ok: true, data: undefined });
  });

  it('opens the confirm INSTEAD of completing when a line will come up short, then completes on "Complete picking"', async () => {
    const user = userEvent.setup();
    render(<ManagerActionsPanel {...baseProps({ ...manager, completionConfirm: SO_000100_CONFIRM })} />);

    await user.click(screen.getByRole('button', { name: 'Mark picking complete' }));

    // Mutation "delete the call": completing on the first click fails here.
    expect(completePicking).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Before you complete picking')).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      'Not everything will be picked. L4L - Pen Black & Rose Gold: 0 of 60. It will be owed at hand-over, or you can remove it from the order first.',
    );

    await user.click(within(dialog).getByRole('button', { name: /Complete picking/ }));
    expect(completePicking).toHaveBeenCalledWith({ id: 'order-1' });
    expect(completePicking).toHaveBeenCalledTimes(1);
  });

  it('"Review short lines" completes nothing, closes the confirm and lands on the first short line\'s fix', async () => {
    const user = userEvent.setup();
    const row = renderLineRow('line-pens');
    try {
      render(<ManagerActionsPanel {...baseProps({ ...manager, completionConfirm: SO_000100_CONFIRM })} />);
      await user.click(screen.getByRole('button', { name: 'Mark picking complete' }));
      await user.click(screen.getByRole('button', { name: 'Review short lines' }));

      expect(completePicking).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(row.fix).toHaveFocus();
      expect(row.row).toHaveAttribute('data-review', 'true');
    } finally {
      row.remove();
    }
  });

  it('is never skipped when stock could not be checked: the confirm says so', async () => {
    const user = userEvent.setup();
    // What the page passes for a failed (or missing) readiness read.
    const failed = describeCompletionConfirm(null, true);
    expect(failed).not.toBeNull();
    render(<ManagerActionsPanel {...baseProps({ ...manager, completionConfirm: failed })} />);

    await user.click(screen.getByRole('button', { name: 'Mark picking complete' }));

    expect(completePicking).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent("Stock couldn't be checked. Picking may come up short.");
  });

  it('with nothing to say, picking completes at once, as before', async () => {
    const user = userEvent.setup();
    render(<ManagerActionsPanel {...baseProps({ ...manager, completionConfirm: null })} />);

    await user.click(screen.getByRole('button', { name: 'Mark picking complete' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(completePicking).toHaveBeenCalledWith({ id: 'order-1' });
  });
});

describe('ManagerActionsPanel — the confirm before an order leaves short (F2-2)', () => {
  const manager = { canApprove: true, viewerRole: 'manager' as const };
  const openSpy = vi.fn();

  beforeEach(() => {
    stageOrder.mockReset();
    stageOrder.mockResolvedValue({ ok: true, data: undefined });
    markInTransit.mockReset();
    markInTransit.mockResolvedValue({ ok: true, data: undefined });
    physicalSignature.mockReset();
    openSpy.mockReset();
    vi.stubGlobal('open', openSpy);
    return () => vi.unstubAllGlobals();
  });

  it.each([
    ['pickup', 'Mark staged for pickup', 'staged_for_pickup'],
    ['delivery', 'Mark staged for delivery', 'staged_for_delivery'],
  ] as const)(
    'staging a %s order with a short line asks first, and stages on "Stage it anyway"',
    async (fulfillmentType, button, target) => {
      const user = userEvent.setup();
      render(
        <ManagerActionsPanel
          {...baseProps({ ...manager, status: 'packing_slip_generated', fulfillmentType, departureLines: SHORT_LINES })}
        />,
      );

      await user.click(screen.getByRole('button', { name: button }));

      // Mutation "delete the call": staging on the first click fails here.
      expect(stageOrder).not.toHaveBeenCalled();
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText('Not everything is picked')).toBeInTheDocument();
      expect(dialog).toHaveTextContent('1 line is short: 0 of 60 L4L - Pen Black & Rose Gold.');
      expect(within(dialog).getByRole('button', { name: 'Fix the order' })).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: 'Stage it anyway' }));
      expect(stageOrder).toHaveBeenCalledWith({ id: 'order-1', target });
    },
  );

  it('"Mark in transit" with a short line asks first, in the plan\'s words, and sends on "Send it anyway"', async () => {
    const user = userEvent.setup();
    render(
      <ManagerActionsPanel
        {...baseProps({
          ...manager,
          status: 'staged_for_delivery',
          fulfillmentType: 'delivery',
          assignedDeliveryUserId: 'driver-1',
          departureLines: SHORT_LINES,
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Mark in transit' }));

    expect(markInTransit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent(
      "1 line is short: 0 of 60 L4L - Pen Black & Rose Gold. Once the order is out for delivery its lines can't be changed, and these units will be owed at hand-over.",
    );
    await user.click(screen.getByRole('button', { name: 'Send it anyway' }));
    expect(markInTransit).toHaveBeenCalledWith({ id: 'order-1' });
  });

  it('"Collect signature" with a short line asks first; the sign page opens only on "Record signature anyway"', async () => {
    const user = userEvent.setup();
    render(
      <ManagerActionsPanel
        {...baseProps({ ...manager, status: 'staged_for_pickup', signatureToken: 'tok-1', departureLines: SHORT_LINES })}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Collect signature' }));

    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('The signature hands the order over, and these units will be owed.');
    await user.click(screen.getByRole('button', { name: 'Record signature anyway' }));
    expect(openSpy).toHaveBeenCalledWith('/orders/sign/tok-1', '_blank', 'noopener,noreferrer');
  });

  it('"Physical signature" with a short line asks first; the signer form opens only on "Record signature anyway"', async () => {
    const user = userEvent.setup();
    render(
      <ManagerActionsPanel {...baseProps({ ...manager, status: 'in_transit', departureLines: SHORT_LINES })} />,
    );

    await user.click(screen.getByRole('button', { name: 'Physical signature' }));

    expect(screen.queryByText('Record a physical signature')).toBeNull();
    const dialog = screen.getByRole('dialog');
    // Out for delivery the lines are final: the way back is "Go back".
    expect(within(dialog).getByRole('button', { name: 'Go back' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Its lines can't be changed now, so these units will be owed at hand-over.");

    await user.click(within(dialog).getByRole('button', { name: 'Record signature anyway' }));
    expect(await screen.findByText('Record a physical signature')).toBeInTheDocument();
    expect(physicalSignature).not.toHaveBeenCalled();
  });

  it('"Fix the order" goes nowhere and lands on the first short line', async () => {
    const user = userEvent.setup();
    const row = renderLineRow('line-pens');
    try {
      render(
        <ManagerActionsPanel
          {...baseProps({ ...manager, status: 'packing_slip_generated', departureLines: SHORT_LINES })}
        />,
      );
      await user.click(screen.getByRole('button', { name: 'Mark staged for pickup' }));
      await user.click(screen.getByRole('button', { name: 'Fix the order' }));

      expect(stageOrder).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(row.fix).toHaveFocus();
    } finally {
      row.remove();
    }
  });

  it('with every line picked, each step runs at once, as before', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <ManagerActionsPanel
        {...baseProps({ ...manager, status: 'packing_slip_generated', departureLines: PICKED_LINES })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Mark staged for pickup' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(stageOrder).toHaveBeenCalledWith({ id: 'order-1', target: 'staged_for_pickup' });
    unmount();

    render(
      <ManagerActionsPanel
        {...baseProps({
          ...manager,
          status: 'staged_for_pickup',
          signatureToken: 'tok-1',
          departureLines: PICKED_LINES,
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Collect signature' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(openSpy).toHaveBeenCalledTimes(1);
  });
});

// Migration 0389, desk check F2: the Collect signature link completes the
// hand-over with no session, so the page holds it back while the viewer owes
// an MFA step-up and hands the panel the words instead.
describe('ManagerActionsPanel — Collect signature held back for MFA (0389, F2)', () => {
  const manager = { canApprove: true, viewerRole: 'manager' as const };
  const openSpy = vi.fn();

  beforeEach(() => {
    openSpy.mockReset();
    vi.mocked(toast.error).mockReset();
    vi.stubGlobal('open', openSpy);
    return () => vi.unstubAllGlobals();
  });

  it('the button stays enabled and says what to do; no sign page opens and no departure confirm is asked', async () => {
    const user = userEvent.setup();
    render(
      <ManagerActionsPanel
        {...baseProps({
          ...manager,
          status: 'staged_for_pickup',
          signatureToken: null,
          handOverMfaMessage: 'Re-authenticate with MFA to collect a signature.',
          departureLines: SHORT_LINES,
        })}
      />,
    );
    const button = screen.getByRole('button', { name: 'Collect signature' });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(toast.error).toHaveBeenCalledWith('Re-authenticate with MFA to collect a signature.');
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('with no link and nothing to say (no token minted), the button is disabled, as before', () => {
    render(<ManagerActionsPanel {...baseProps({ ...manager, status: 'in_transit', signatureToken: null })} />);
    expect(screen.getByRole('button', { name: 'Collect signature' })).toBeDisabled();
  });
});

// React #418 on an order with a needed-by (F2-1 walk, 2026-09-28): the
// approval panel's "Needed by" chip formatted the time with toLocaleString and
// no zone, so the server (UTC on Vercel) printed 9:00 PM and the browser
// (Pacific) 2:00 PM, and hydration failed. The chip prints in the org's zone,
// the same words on the server and in any browser.
describe('ManagerActionsPanel — the needed-by chip hydrates in any zone', () => {
  const runtimeZone = process.env.TZ;
  afterEach(() => {
    if (runtimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = runtimeZone;
    document.body.innerHTML = '';
  });

  it('server in UTC, browser in New York, org in Los Angeles: one time, no hydration error', async () => {
    const ui = (
      <ManagerActionsPanel
        {...baseProps({
          status: 'pending_approval',
          canApprove: true,
          viewerRole: 'manager',
          // 2:00 PM in Los Angeles; 9:00 PM UTC; 5:00 PM in New York.
          neededBy: '2026-09-28T21:00:00Z',
          orgTimeZone: 'America/Los_Angeles',
        })}
      />
    );
    process.env.TZ = 'UTC';
    const html = renderToString(ui);

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    process.env.TZ = 'America/New_York';
    const errors: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args);
    });
    // React's own act (hydrateRoot is not RTL's render): tell React this is
    // a test environment, so the only errors collected are the hydration's.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const wasActEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      await act(async () => {
        hydrateRoot(container, ui, { onRecoverableError: (e) => errors.push(e) });
      });
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
      consoleError.mockRestore();
    }
    // The mismatch itself first: on the old code this is React's "server
    // rendered text didn't match the client" (production's #418).
    expect(errors).toEqual([]);
    expect(html).toContain('Mon, Sep 28, 2:00 PM');
    expect(container.textContent).toContain('Needed by Mon, Sep 28, 2:00 PM');
  });
});

/**
 * Security slice D (migration 0390): the panel offers what the server accepts.
 * Reassign picker and Reopen picking follow the effective orders:approve (as
 * assign_picking and reopen_picking decide them); the picker override stays
 * manager rank (complete_picking, release_picking); Mark in transit needs
 * orders:approve, the driver included (owner decision O3, default), as the
 * phone's order screen already did.
 */
describe('ManagerActionsPanel — approval-class buttons follow orders:approve (0390)', () => {
  it('a manager whose orders:approve was revoked: no Reassign picker or Reopen picking, still the picker override', () => {
    const { unmount } = render(
      <ManagerActionsPanel
        {...baseProps({ canApprove: false, viewerRole: 'manager', assignedPickerId: 'other-picker', assignedPickerName: 'Sam Lee' })}
      />,
    );
    expect(screen.queryByRole('button', { name: /(Assign|Reassign) picker/ })).not.toBeInTheDocument();
    expect(screen.getByText('Mark picking complete')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Release/ })).toBeInTheDocument();
    unmount();
    render(<ManagerActionsPanel {...baseProps({ status: 'picking_complete', canApprove: false, viewerRole: 'manager' })} />);
    expect(screen.queryByRole('button', { name: 'Reopen picking' })).not.toBeInTheDocument();
  });

  it('a staff member granted orders:approve: Assign picker and Reopen picking, no picker override', () => {
    const { unmount } = render(
      <ManagerActionsPanel {...baseProps({ canApprove: true, viewerRole: 'staff', assignedPickerId: 'other-picker' })} />,
    );
    expect(screen.getByRole('button', { name: /Reassign picker/ })).toBeInTheDocument();
    expect(screen.queryByText('Mark picking complete')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Release/ })).not.toBeInTheDocument();
    unmount();
    render(<ManagerActionsPanel {...baseProps({ status: 'picking_complete', canApprove: true, viewerRole: 'staff' })} />);
    expect(screen.getByRole('button', { name: 'Reopen picking' })).toBeInTheDocument();
  });

  it('Assign delivery needs orders:approve AND orders:assign_delivery, as the server and the phone ask', () => {
    const staged = { status: 'staged_for_delivery' as const, fulfillmentType: 'delivery' as const };
    for (const [canApprove, canAssignDelivery, shown] of [
      [true, true, true],
      [true, false, false],
      [false, true, false],
    ] as const) {
      const { unmount } = render(
        <ManagerActionsPanel {...baseProps({ ...staged, canApprove, canAssignDelivery, viewerRole: 'staff' })} />,
      );
      expect(screen.queryByRole('button', { name: /(Assign|Reassign) delivery/ }) !== null, `${canApprove}/${canAssignDelivery}`).toBe(shown);
      unmount();
    }
  });

  it('an assigned staff driver without orders:approve is not offered Mark in transit; an approver is', () => {
    const staged = {
      status: 'staged_for_delivery' as const,
      fulfillmentType: 'delivery' as const,
      assignedDeliveryUserId: 'me',
    };
    const { unmount } = render(<ManagerActionsPanel {...baseProps({ ...staged, canApprove: false, viewerRole: 'staff' })} />);
    expect(screen.queryByRole('button', { name: 'Mark in transit' })).not.toBeInTheDocument();
    unmount();
    render(<ManagerActionsPanel {...baseProps({ ...staged, canApprove: true, viewerRole: 'staff' })} />);
    expect(screen.getByRole('button', { name: 'Mark in transit' })).toBeInTheDocument();
  });
});
