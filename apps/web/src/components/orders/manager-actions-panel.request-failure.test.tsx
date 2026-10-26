import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

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
vi.mock('next/navigation', () => ({
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
  completePickingAction,
  generatePackingSlipsAction,
  generatePickSlipAction,
  releasePickingAction,
  setOrderInternalNotesAction,
  setOrderNeededByAction,
  stageOrderAction,
  suggestNeededByAction,
} from '@/server/actions/order-requests';

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
        expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(step.what)),
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
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('save the internal notes')),
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
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('suggest a deadline')),
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
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('set the needed-by date')),
    );
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });
});
