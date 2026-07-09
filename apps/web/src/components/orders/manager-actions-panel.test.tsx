import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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
  setOrderInternalNotesAction: vi.fn(),
  stageOrderAction: vi.fn(),
}));

type PanelProps = React.ComponentProps<typeof ManagerActionsPanel>;

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    orderId: 'order-1',
    status: 'pick_slip_generated',
    internalNotes: null,
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
