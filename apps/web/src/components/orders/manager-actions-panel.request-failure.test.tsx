import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RETURNS_COPY } from '@stockpilot/core';

import { requestFailedMessage } from '@/lib/request-failure';
import {
  offline,
  outOfDate,
  recordEscapedRejections,
  signInRedirect,
} from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40: every order step on the order page (approve, generate the pick slip,
// claim, release, complete, stage, notes, the needed-by suggestion...) set
// `busy`, awaited its action with no catch and cleared `busy` only when it
// answered. A step that got no answer (offline, a server error, a deploy)
// left every button on the panel disabled, since they all wait on `busy`,
// with no message, until the page was reloaded.
// ---------------------------------------------------------------------------

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));
const routerRefresh = vi.hoisted(() => vi.fn());
// The real unstable_rethrow stays, so isControlFlow recognises a redirect.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
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
vi.mock('@/server/actions/returns', () => ({ releaseReturnReplacementAction: vi.fn() }));

import { toast } from 'sonner';

import {
  approveOrderRequestAction,
  claimPickingAction,
  closePartialAction,
  completePickingAction,
  confirmPhysicalSignatureAction,
  denyOrderRequestAction,
  generatePackingSlipsAction,
  generatePickSlipAction,
  markInTransitAction,
  releasePickingAction,
  reopenPickingAction,
  setOrderInternalNotesAction,
  setOrderNeededByAction,
  stageOrderAction,
  suggestNeededByAction,
} from '@/server/actions/order-requests';
import { releaseReturnReplacementAction } from '@/server/actions/returns';

import { ManagerActionsPanel } from './manager-actions-panel';

type PanelProps = React.ComponentProps<typeof ManagerActionsPanel>;

function props(overrides: Partial<PanelProps> = {}): PanelProps {
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

const manager = { canApprove: true, viewerRole: 'manager' as const };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ManagerActionsPanel when an order step gets no answer', () => {
  const STEPS = [
    {
      name: 'Approve',
      overrides: { ...manager, status: 'pending_approval' as const },
      action: approveOrderRequestAction,
      what: 'approve the request',
    },
    {
      name: 'Generate pick slip',
      overrides: { ...manager, status: 'approved' as const },
      action: generatePickSlipAction,
      what: 'generate the pick slip',
    },
    {
      name: 'Claim picking',
      overrides: {},
      action: claimPickingAction,
      what: 'claim picking',
    },
    {
      name: 'Mark picking complete',
      overrides: { assignedPickerId: 'me', assignedPickerName: 'Picker One' },
      action: completePickingAction,
      what: 'complete picking',
    },
    {
      name: 'Release',
      overrides: { assignedPickerId: 'me', assignedPickerName: 'Picker One' },
      action: releasePickingAction,
      what: 'release picking',
    },
    {
      name: 'Generate packing slips',
      overrides: { ...manager, status: 'picking_complete' as const },
      action: generatePackingSlipsAction,
      what: 'generate the packing slips',
    },
    {
      name: 'Mark staged for pickup',
      overrides: { ...manager, status: 'packing_slip_generated' as const },
      action: stageOrderAction,
      what: 'stage the order',
    },
  ];

  for (const step of STEPS) {
    it(`${step.name} says the step was not done, and the panel's buttons work again`, async () => {
      vi.mocked(step.action).mockRejectedValueOnce(offline());
      render(<ManagerActionsPanel {...props(step.overrides)} />);
      const button = screen.getByRole('button', { name: new RegExp(step.name) });
      fireEvent.click(button);
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), step.what)),
      );
      expect(screen.getByRole('button', { name: new RegExp(step.name) })).toBeEnabled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(routerRefresh).not.toHaveBeenCalled();
    });
  }

  it('Save notes says the notes were not saved and keeps the typed text', async () => {
    vi.mocked(setOrderInternalNotesAction).mockRejectedValueOnce(offline());
    render(<ManagerActionsPanel {...props({ ...manager, status: 'approved' })} />);
    fireEvent.change(screen.getByLabelText('Internal notes'), {
      target: { value: 'Call ahead' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save notes/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'save the internal notes'),
      ),
    );
    expect(screen.getByLabelText('Internal notes')).toHaveValue('Call ahead');
    expect(screen.getByRole('button', { name: /Save notes/ })).toBeEnabled();
  });

  it('the deadline suggestion comes back to its button when the read gets no answer', async () => {
    vi.mocked(suggestNeededByAction).mockRejectedValueOnce(offline());
    render(
      <ManagerActionsPanel
        {...props({ ...manager, status: 'pending_approval', hasRequesterNote: true })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Suggest deadline from note/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'suggest a deadline'),
      ),
    );
    expect(screen.getByRole('button', { name: /Suggest deadline from note/ })).toBeEnabled();
  });

  it('applying the suggested deadline says it was not set, and Apply works again', async () => {
    vi.mocked(suggestNeededByAction).mockResolvedValueOnce({
      ok: true,
      data: { iso: '2026-11-03T17:00:00.000Z' },
    } as never);
    vi.mocked(setOrderNeededByAction).mockRejectedValueOnce(offline());
    render(
      <ManagerActionsPanel
        {...props({ ...manager, status: 'pending_approval', hasRequesterNote: true })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Suggest deadline from note/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'set the needed-by date'),
      ),
    );
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });
});

// The other steps: four ask in a dialog first (Deny, Reopen picking, Physical
// signature, Close as delivered-partial, and Release before return is
// received on an exchange replacement), two are buttons on the panel (Mark
// staged for delivery, Mark in transit). A dialog keeps the reason inside it
// (a toast sits outside the dialog), stays open with what was typed and can
// be closed; a step on the panel gives its buttons back. A page older than
// the server says to reload, and a redirect to sign-in says nothing.
describe('ManagerActionsPanel: the steps that ask first, and staging and in transit', () => {
  // A redirect handled by the page leaves nothing behind (see recordEscapedRejections).
  const escaped = recordEscapedRejections();

  interface Step {
    name: string;
    overrides: Partial<PanelProps>;
    action: (...args: never[]) => unknown;
    what: string;
    /** Opens the dialog and fills it in; null for a step on the panel. */
    open: ((user: UserEvent) => Promise<HTMLElement>) | null;
    /** The button that sends it (inside the dialog when there is one). */
    send: string;
    /** The dialog's button that closes it without sending. */
    close?: string;
  }

  async function openDialog(user: UserEvent, opener: string) {
    await user.click(screen.getByRole('button', { name: opener }));
    return screen.findByRole('dialog');
  }

  const STEPS: Step[] = [
    {
      name: 'Deny',
      overrides: { ...manager, status: 'pending_approval' },
      action: denyOrderRequestAction,
      what: 'deny the request',
      open: async (user) => {
        const dialog = await openDialog(user, 'Deny');
        await user.type(within(dialog).getByLabelText('Reason'), 'Out of season');
        return dialog;
      },
      send: 'Deny request',
      close: 'Cancel',
    },
    {
      name: 'Reopen picking',
      overrides: { ...manager, status: 'packing_slip_generated' },
      action: reopenPickingAction,
      what: 'reopen picking',
      open: async (user) => {
        const dialog = await openDialog(user, 'Reopen picking');
        await user.type(within(dialog).getByLabelText('Reason'), 'Miscount on line 2');
        return dialog;
      },
      send: 'Reopen picking',
      close: 'Cancel',
    },
    {
      name: 'Physical signature',
      overrides: { ...manager, status: 'staged_for_pickup' },
      action: confirmPhysicalSignatureAction,
      what: 'record the signature',
      open: async (user) => {
        const dialog = await openDialog(user, 'Physical signature');
        await user.type(within(dialog).getByLabelText("Signer's name"), 'Pat Example');
        return dialog;
      },
      send: 'Record signature',
      close: 'Cancel',
    },
    {
      name: 'Close as delivered-partial',
      overrides: { ...manager, status: 'backordered' },
      action: closePartialAction,
      what: 'close the order',
      open: (user) => openDialog(user, 'Close as delivered-partial'),
      send: 'Close order',
      close: 'Cancel',
    },
    {
      name: 'Release before return is received',
      overrides: {
        ...manager,
        status: 'approved',
        replacement: {
          returnId: 'return-1',
          returnNumber: 'RMA-0001',
          waitingForReturn: true,
          canReleaseEarly: true,
          driverLine: null,
        },
      },
      action: releaseReturnReplacementAction,
      what: 'release the replacement',
      open: async (user) => {
        const dialog = await openDialog(user, RETURNS_COPY.releaseBeforeReturn);
        await user.click(
          within(dialog).getByRole('button', { name: RETURNS_COPY.releasePresetInPerson }),
        );
        return dialog;
      },
      send: RETURNS_COPY.releaseBeforeReturn,
      close: 'Keep waiting',
    },
    {
      name: 'Mark staged for delivery',
      overrides: { ...manager, status: 'packing_slip_generated', fulfillmentType: 'delivery' },
      action: stageOrderAction,
      what: 'stage the order',
      open: null,
      send: 'Mark staged for delivery',
    },
    {
      name: 'Mark in transit',
      overrides: {
        ...manager,
        status: 'staged_for_delivery',
        fulfillmentType: 'delivery',
        assignedDeliveryUserId: 'driver-1',
      },
      action: markInTransitAction,
      what: 'mark the order on the way',
      open: null,
      send: 'Mark in transit',
    },
  ];

  /** Opens the step (and its dialog) and presses send; the dialog or null. */
  async function run(user: UserEvent, step: Step) {
    render(<ManagerActionsPanel {...props(step.overrides)} />);
    const dialog = step.open ? await step.open(user) : null;
    await user.click((dialog ? within(dialog) : screen).getByRole('button', { name: step.send }));
    return dialog;
  }

  for (const [row, error] of [
    ['no answer', offline],
    ['a page older than the server', outOfDate],
  ] as const) {
    for (const step of STEPS) {
      it(`${step.name}, ${row}: says the step was not done where the person is looking, and works again`, async () => {
        vi.mocked(step.action).mockRejectedValueOnce(error());
        const user = userEvent.setup();
        const dialog = await run(user, step);
        const sentence = requestFailedMessage(error(), step.what);
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith(sentence));
        expect(toast.success).not.toHaveBeenCalled();
        expect(routerRefresh).not.toHaveBeenCalled();
        if (!dialog) {
          expect(screen.getByRole('button', { name: step.send })).toBeEnabled();
          return;
        }
        // Inside the dialog, which stays open with what was typed, and can be
        // closed; opened again, it starts clean.
        expect(within(dialog).getByRole('alert')).toHaveTextContent(sentence);
        expect(within(dialog).getByRole('button', { name: step.send })).toBeEnabled();
        await user.click(within(dialog).getByRole('button', { name: step.close! }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        const again = await step.open!(user);
        expect(within(again).queryByRole('alert')).toBeNull();
      });
    }
  }

  for (const step of STEPS) {
    it(`${step.name}, answered with a redirect: says nothing, and nothing is left to escape`, async () => {
      vi.mocked(step.action).mockRejectedValueOnce(signInRedirect());
      const user = userEvent.setup();
      await run(user, step);
      await waitFor(() => expect(step.action).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(escaped, 'the redirect is handled, never left to escape').toEqual([]);
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(routerRefresh).not.toHaveBeenCalled();
    });
  }

  it('a refusal in a dialog is said inside it too', async () => {
    vi.mocked(denyOrderRequestAction).mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: 'This request was already approved.' },
    } as never);
    const user = userEvent.setup();
    const dialog = await run(user, STEPS[0]!);
    await waitFor(() =>
      expect(within(dialog!).getByRole('alert')).toHaveTextContent(
        'This request was already approved.',
      ),
    );
    expect(toast.error).toHaveBeenCalledWith('This request was already approved.');
  });
});
