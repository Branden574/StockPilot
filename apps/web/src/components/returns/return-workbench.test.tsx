// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestockOptionsLine } from '@stockpilot/core';

const runSteps = vi.hoisted(() => vi.fn());
const planAction = vi.hoisted(() => vi.fn());
vi.mock('@/server/actions/returns', () => ({
  runReturnStepsAction: runSteps,
  denyReturnAction: vi.fn(async () => ({ ok: true, data: { changed: true } })),
  cancelReturnAction: vi.fn(async () => ({ ok: true, data: { changed: true } })),
  planReturnDispositionsAction: planAction,
  buyReturnLabelAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return { default: ({ href, children }: { href: string; children: React.ReactNode }) => React.createElement('a', { href }, children) };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { RestockDestinationPicker } from './restock-destination-picker';
import { ReturnWorkbench } from './return-workbench';

const R31 = '44444444-4444-4444-8444-444444444444';
const R32 = '55555555-5555-4555-8555-555555555555';

function opts(over: Partial<RestockOptionsLine> = {}): RestockOptionsLine {
  return {
    returnLineId: 'l1',
    itemId: 'i1',
    quantity: 1,
    disposition: 'restock',
    applied: false,
    plan: null,
    case: 'single_source',
    notRecordedReason: null,
    sources: [{ locationId: R31, name: '31-C', kind: 'rack', type: 'shelf', drawn: 1, restored: 0, remaining: 1, valid: true, reason: null }],
    offerOriginal: true,
    offerSourceIds: [],
    preselect: 'original',
    ...over,
  };
}

function bench(status: string, line: Partial<RestockOptionsLine> | null = {}, over: Record<string, unknown> = {}) {
  const restock = line === null ? null : opts(line);
  return {
    organizationId: 'org-1',
    return: {
      id: '11111111-1111-4111-8111-111111111111',
      returnNumber: 'RMA-1',
      status,
      source: 'internal',
      reasonCode: null,
      notes: null,
      denialReason: null,
      orderRequestId: 'o1',
      orderNumber: 103,
      warehouseId: 'w1',
      warehouseName: 'Main',
      requesterName: null,
      requesterEmail: null,
      createdAt: '2026-10-01T00:00:00Z',
      approvedAt: null,
      receivedAt: null,
      closedAt: null,
      deniedAt: null,
      requestedByName: null,
      approvedByName: null,
      receivedByName: null,
      closedByName: null,
      deniedByName: null,
    },
    revision: status === 'requested' ? 0 : 1,
    planSeq: 4,
    createdOnCounter: false,
    lines: [
      {
        id: 'l1',
        orderRequestLineId: 'ol1',
        itemId: 'i1',
        quantity: 1,
        disposition: 'restock',
        applied: status === 'closed',
        item: { name: 'Walk New Hire Shirt', sku: 'NH-M', variant: 'Size M', deleted: false, imageUrl: null, thumbUrl: null },
        restock: status === 'closed' ? null : restock,
        legs: [],
        inboundState: status === 'received' ? 'Received' : 'Waiting',
      },
    ],
    decisions: [],
    chain: [],
    viewer: { canManageReturns: true, canApproveOrders: true, canReadDecisions: true },
    actions: { primary: null, secondary: [], readOnlyReason: null },
    ...over,
  } as never;
}

beforeEach(() => vi.clearAllMocks());

describe('RestockDestinationPicker (C1 to C4)', () => {
  const noop = () => undefined;
  it('C1 offers the original rack and Staging as radio buttons', () => {
    render(<RestockDestinationPicker line={opts()} choice={{ disposition: 'restock', target: 'original', locationId: null }} onChange={noop} itemLabel="Shirt" />);
    const group = screen.getByRole('radiogroup', { name: /RETURNED ITEM DESTINATION for Shirt/ });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(within(group).getByLabelText('Return to original rack: 31-C')).toBeChecked();
    expect(within(group).getByLabelText('Leave in Staging')).not.toBeChecked();
  });

  it('C2 names every rack with its quantity', () => {
    const line = opts({
      case: 'full_remainder',
      quantity: 3,
      sources: [
        { locationId: R31, name: '31-C', kind: 'rack', type: 'shelf', drawn: 1, restored: 0, remaining: 1, valid: true, reason: null },
        { locationId: R32, name: '32-A', kind: 'rack', type: 'shelf', drawn: 2, restored: 0, remaining: 2, valid: true, reason: null },
      ],
    });
    render(<RestockDestinationPicker line={line} choice={{ disposition: 'restock', target: 'original', locationId: null }} onChange={noop} itemLabel="Shirt" />);
    expect(screen.getByLabelText('Return to original racks: 31-C ×1 · 32-A ×2')).toBeInTheDocument();
  });

  it('C3 lists each actual source with "up to N", only those with room enabled', () => {
    const onChange = vi.fn();
    const line = opts({
      case: 'partial',
      quantity: 2,
      offerOriginal: false,
      preselect: 'staging',
      offerSourceIds: [R32],
      sources: [
        { locationId: R31, name: '31-C', kind: 'rack', type: 'shelf', drawn: 1, restored: 0, remaining: 1, valid: true, reason: null },
        { locationId: R32, name: '32-A', kind: 'rack', type: 'shelf', drawn: 3, restored: 0, remaining: 3, valid: true, reason: null },
      ],
    });
    render(<RestockDestinationPicker line={line} choice={{ disposition: 'restock', target: 'staging', locationId: null }} onChange={onChange} itemLabel="Shirt" />);
    expect(screen.getByLabelText(/one of the original racks: 31-C/)).toBeDisabled();
    const ok = screen.getByLabelText(/one of the original racks: 32-A/);
    expect(ok).toBeEnabled();
    fireEvent.click(ok);
    expect(onChange).toHaveBeenCalledWith({ disposition: 'restock', target: 'source', locationId: R32 });
  });

  it('C4 explains the original location was not recorded; Staging stays one tap away', () => {
    const line = opts({ case: 'not_recorded', notRecordedReason: 'no_draw', sources: [], offerOriginal: false, preselect: 'staging' });
    render(<RestockDestinationPicker line={line} choice={{ disposition: 'restock', target: 'staging', locationId: null }} onChange={noop} itemLabel="Shirt" />);
    expect(screen.getByLabelText(/was not recorded for this historical order/)).toBeDisabled();
    expect(screen.getByLabelText('Leave in Staging')).toBeChecked();
  });

  it('a rack that failed revalidation is disabled with its reason', () => {
    const line = opts({
      offerOriginal: false,
      sources: [{ locationId: R31, name: '31-C', kind: 'rack', type: 'shelf', drawn: 1, restored: 0, remaining: 1, valid: false, reason: 'archived' }],
    });
    render(<RestockDestinationPicker line={line} choice={{ disposition: 'restock', target: 'staging', locationId: null }} onChange={noop} itemLabel="Shirt" />);
    expect(screen.getByLabelText('Return to original rack: 31-C')).toBeDisabled();
    expect(screen.getByText('Original rack is no longer available. (archived)')).toBeInTheDocument();
  });

  it('scrap hides the destination group (brief 10); "Damaged" only adds "Inspect before choosing."', () => {
    render(
      <RestockDestinationPicker line={opts()} choice={{ disposition: 'scrap', target: null, locationId: null }} onChange={noop} reasonCode="damaged" itemLabel="Shirt" />,
    );
    expect(screen.queryByRole('radiogroup', { name: /DESTINATION/ })).not.toBeInTheDocument();
    expect(screen.getByText('Inspect before choosing.')).toBeInTheDocument();
  });
});

describe('ReturnWorkbench states', () => {
  it('requested: Approve return, Deny, Cancel; the switch turns it into "Approve and receive" and sends receiveNow', async () => {
    runSteps.mockResolvedValue({ ok: true, data: { ran: [{ step: 'approve', outcome: 'done' }], workbench: bench('received') } });
    render(<ReturnWorkbench workbench={bench('requested')} />);
    expect(screen.getByRole('button', { name: 'Approve return' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel return' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve and receive' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve and receive' }));
    await waitFor(() => expect(runSteps).toHaveBeenCalled());
    expect(runSteps.mock.calls[0]![0]).toMatchObject({
      body: {
        steps: ['approve'],
        expectedRevision: 0,
        receiveNow: true,
        approve: { lines: [{ returnLineId: 'l1', disposition: 'restock', restock: { target: 'original' } }] },
      },
    });
  });

  it('approved: Receive is primary; Change destination and Cancel are secondary', () => {
    render(<ReturnWorkbench workbench={bench('approved')} />);
    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change destination' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel return' })).toBeInTheDocument();
  });

  it('received: the process button names the rack; a rack no longer offered keeps it disabled until Staging is chosen', () => {
    render(<ReturnWorkbench workbench={bench('received', { plan: { disposition: 'restock', target: 'original', locationId: null, basis: 'single_source', seq: 4 } })} />);
    expect(screen.getByRole('button', { name: 'Return to 31-C' })).toBeEnabled();
    expect(screen.getByText('Put it back on 31-C now. StockPilot records it there when you tap this.')).toBeInTheDocument();
  });

  it('received with a failed revalidation: Staging preselected, the rack disabled, processing goes to Staging in the same call', async () => {
    runSteps.mockResolvedValue({ ok: true, data: { ran: [{ step: 'process', outcome: 'done' }], workbench: bench('closed') } });
    const failed = {
      plan: { disposition: 'restock' as const, target: 'original' as const, locationId: null, basis: 'single_source', seq: 4 },
      offerOriginal: false,
      sources: [{ locationId: R31, name: '31-C', kind: 'rack', type: 'shelf', drawn: 1, restored: 0, remaining: 1, valid: false, reason: 'archived' }],
    };
    render(<ReturnWorkbench workbench={bench('received', failed)} />);
    expect(screen.getByLabelText('Return to original rack: 31-C')).toBeDisabled();
    const btn = screen.getByRole('button', { name: 'Leave in Staging' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(runSteps).toHaveBeenCalled());
    expect(runSteps.mock.calls[0]![0]).toMatchObject({
      body: { steps: ['process'], expectedPlanSeq: 4, process: { lines: [{ returnLineId: 'l1', disposition: 'restock', restock: { target: 'staging' } }] } },
    });
  });

  it('closed, denied and cancelled offer nothing; a reader without returns:manage sees why', () => {
    const { unmount } = render(<ReturnWorkbench workbench={bench('closed', null)} />);
    expect(screen.getByText('No further steps for this return.')).toBeInTheDocument();
    unmount();
    render(
      <ReturnWorkbench
        workbench={bench('approved', {}, { viewer: { canManageReturns: false, canApproveOrders: false, canReadDecisions: true } })}
      />,
    );
    expect(screen.getByText("You don't have permission to manage returns.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Receive' })).not.toBeInTheDocument();
  });
});
