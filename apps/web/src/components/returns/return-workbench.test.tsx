// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestockOptionsLine, RestockSource } from '@stockpilot/core';

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
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { RestockDestinationPicker } from './restock-destination-picker';
import { ReturnWorkbench } from './return-workbench';

const R31 = '44444444-4444-4444-8444-444444444444';
const R32 = '55555555-5555-4555-8555-555555555555';

function src(locationId: string, name: string, remaining: number, valid = true, reason: string | null = null, over: Partial<RestockSource> = {}): RestockSource {
  return { locationId, name, kind: 'rack', type: 'shelf', drawn: remaining, restored: 0, remaining, cap: remaining, valid, reason, writable: true, ...over };
}

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
    sources: [src(R31, '31-C', 1)],
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
    destinationsUnavailable: false,
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
        src(R31, '31-C', 1),
        src(R32, '32-A', 2),
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
        src(R31, '31-C', 1),
        src(R32, '32-A', 3),
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
      sources: [src(R31, '31-C', 1, false, 'archived')],
    });
    render(<RestockDestinationPicker line={line} choice={{ disposition: 'restock', target: 'staging', locationId: null }} onChange={noop} itemLabel="Shirt" />);
    expect(screen.getByLabelText('Return to original rack: 31-C')).toBeDisabled();
    expect(screen.getByText('Original rack is no longer available: 31-C (archived).')).toBeInTheDocument();
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

  it('received: the process button names the rack while the planned rack is still offered', () => {
    render(<ReturnWorkbench workbench={bench('received', { plan: { disposition: 'restock', target: 'original', locationId: null, basis: 'single_source', seq: 4 } })} />);
    expect(screen.getByRole('button', { name: 'Return to 31-C' })).toBeEnabled();
    expect(screen.getByText('Put it back on 31-C now. StockPilot records it there when you tap this.')).toBeInTheDocument();
  });

  it('received with a failed revalidation: NO destination is chosen, the button stays disabled with the line and the reason, until Staging is chosen (plan 3.5.4, review)', async () => {
    runSteps.mockResolvedValue({ ok: true, data: { ran: [{ step: 'process', outcome: 'done' }], workbench: bench('closed') } });
    const failed = {
      plan: { disposition: 'restock' as const, target: 'original' as const, locationId: null, basis: 'single_source', seq: 4 },
      offerOriginal: false,
      sources: [src(R31, '31-C', 1, false, 'archived')],
    };
    render(<ReturnWorkbench workbench={bench('received', failed)} />);
    expect(screen.getByLabelText('Return to original rack: 31-C')).toBeDisabled();
    // Nothing is preselected: neither the rack nor Staging.
    expect(screen.getByLabelText('Leave in Staging')).not.toBeChecked();
    const process = screen.getByRole('button', { name: 'Process return' });
    expect(process).toBeDisabled();
    expect(
      screen.getAllByText('Walk New Hire Shirt, M: Original rack is no longer available: 31-C (archived). Choose a destination.').length,
    ).toBeGreaterThan(0);
    fireEvent.click(process);
    expect(runSteps).not.toHaveBeenCalled();
    // Choosing Staging is a real choice: the button names it and sends it.
    fireEvent.click(screen.getByLabelText('Leave in Staging'));
    const btn = screen.getByRole('button', { name: 'Leave in Staging' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(runSteps).toHaveBeenCalled());
    expect(runSteps.mock.calls[0]![0]).toMatchObject({
      body: { steps: ['process'], expectedPlanSeq: 4, process: { lines: [{ returnLineId: 'l1', disposition: 'restock', restock: { target: 'staging' } }] } },
    });
  });

  it('two lines, one rack gone: Process return stays disabled and names only the gone line (review)', () => {
    const plan = { disposition: 'restock' as const, target: 'original' as const, locationId: null, basis: 'single_source', seq: 4 };
    const good = { ...opts({ returnLineId: 'l1', plan }) };
    const gone = { ...opts({ returnLineId: 'l2', itemId: 'i2', plan, offerOriginal: false, sources: [src(R32, '32-A', 1, false, 'moved_warehouse')] }) };
    const wb = bench('received', {}, {
      lines: [
        { id: 'l1', orderRequestLineId: 'ol1', itemId: 'i1', quantity: 1, disposition: 'restock', applied: false, item: { name: 'Shirt', sku: null, variant: 'Size M', deleted: false, imageUrl: null, thumbUrl: null }, restock: good, legs: [], inboundState: 'Received' },
        { id: 'l2', orderRequestLineId: 'ol2', itemId: 'i2', quantity: 1, disposition: 'restock', applied: false, item: { name: 'Cap', sku: null, variant: null, deleted: false, imageUrl: null, thumbUrl: null }, restock: gone, legs: [], inboundState: 'Received' },
      ],
    });
    render(<ReturnWorkbench workbench={wb} />);
    expect(screen.getByRole('button', { name: 'Process return' })).toBeDisabled();
    expect(screen.getAllByText('Cap: Original rack is no longer available: 32-A (moved to another warehouse). Choose a destination.').length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Shirt, M: /)).not.toBeInTheDocument();
  });

  it('approved with a planned rack gone: the summary says why, never "goes into Staging" (review)', () => {
    const failed = {
      plan: { disposition: 'restock' as const, target: 'original' as const, locationId: null, basis: 'single_source', seq: 4 },
      offerOriginal: false,
      sources: [src(R31, '31-C', 1, false, 'archived')],
    };
    render(<ReturnWorkbench workbench={bench('approved', failed)} />);
    expect(screen.getAllByText('Walk New Hire Shirt, M: Original rack is no longer available: 31-C (archived). Choose a destination.').length).toBeGreaterThan(0);
    expect(screen.queryByText(/goes into Staging/)).not.toBeInTheDocument();
  });

  it('requested: "What happens" names each line, so two lines never read the same (review)', () => {
    const wb = bench('requested', {}, {
      lines: [
        { id: 'l1', orderRequestLineId: 'ol1', itemId: 'i1', quantity: 1, disposition: 'restock', applied: false, item: { name: 'Shirt', sku: null, variant: 'Size M', deleted: false, imageUrl: null, thumbUrl: null }, restock: opts({ returnLineId: 'l1', case: 'not_recorded', sources: [], offerOriginal: false, preselect: 'staging' }), legs: [], inboundState: 'Waiting' },
        { id: 'l2', orderRequestLineId: 'ol2', itemId: 'i2', quantity: 1, disposition: 'restock', applied: false, item: { name: 'Cap', sku: null, variant: null, deleted: false, imageUrl: null, thumbUrl: null }, restock: opts({ returnLineId: 'l2', case: 'not_recorded', sources: [], offerOriginal: false, preselect: 'staging' }), legs: [], inboundState: 'Waiting' },
      ],
    });
    render(<ReturnWorkbench workbench={wb} />);
    expect(screen.getByText('Nothing moves now. The returned item stays out until the return is processed.')).toBeInTheDocument();
    expect(screen.getByText('When processed, Shirt, M goes into Staging.')).toBeInTheDocument();
    expect(screen.getByText('When processed, Cap goes into Staging.')).toBeInTheDocument();
  });

  it('a destination read that failed: Approve and Change destination are disabled with "Reload", and nothing is sent (review)', () => {
    render(<ReturnWorkbench workbench={bench('requested', null, { destinationsUnavailable: true })} />);
    const approve = screen.getByRole('button', { name: 'Approve return' });
    expect(approve).toBeDisabled();
    expect(screen.getByText("Couldn't load where the returned item goes. Reload.")).toBeInTheDocument();
    fireEvent.click(approve);
    expect(runSteps).not.toHaveBeenCalled();
  });

  it('"Already closed by" names the person from the answer, not the screen\'s stale copy (review)', async () => {
    const after = bench('closed', null);
    (after as unknown as { return: { closedByName: string } }).return.closedByName = 'Dana Keeler';
    runSteps.mockResolvedValue({ ok: true, data: { ran: [{ step: 'process', outcome: 'already' }], workbench: after } });
    render(<ReturnWorkbench workbench={bench('received', { plan: { disposition: 'restock', target: 'original', locationId: null, basis: 'single_source', seq: 4 } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Return to 31-C' }));
    await waitFor(() => expect(toast.message).toHaveBeenCalledWith('Already closed by Dana Keeler.'));
  });

  it('the deny dialog says the requester hears nothing of the reason only on a requester\'s RMA; the header shows an email-only requester (review)', () => {
    const { unmount } = render(<ReturnWorkbench workbench={bench('requested')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(screen.getByText(/The reason is kept on the return. Nobody is notified./)).toBeInTheDocument();
    expect(screen.queryByText(/The requester is told/)).not.toBeInTheDocument();
    unmount();
    const wb = bench('requested');
    const ret = (wb as unknown as { return: Record<string, unknown> }).return;
    ret.source = 'requester';
    ret.requesterEmail = 'pat@example.com';
    render(<ReturnWorkbench workbench={wb} />);
    expect(screen.getByText(/pat@example\.com/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(screen.getByText(/The requester is told the request was declined, never the reason./)).toBeInTheDocument();
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

// Production 2026-10-05: React #418 on /dashboard/returns/[id]. The page
// server-renders the workbench, and History prints relative times
// ("3 minutes ago"). When a minute passes between the server render and
// hydration the browser prints "4 minutes ago", the text no longer matches
// and React throws away the server HTML. The <time> tolerates the drift with
// suppressHydrationWarning, as comment-thread.tsx and notifications-list.tsx do.
describe('ReturnWorkbench hydrates across a clock tick', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('History rendered on the server and hydrated a minute later: no hydration error', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-10-05T16:00:00.000Z');
    vi.setSystemTime(t0);
    // 3.5 minutes before the server render: "3 minutes ago", then "4".
    const at = new Date(t0 - 210_000).toISOString();
    const ui = (
      <ReturnWorkbench
        workbench={bench('approved', {}, { chain: [{ at, kind: 'approved', label: 'Approved', actorName: 'Dana Lee' }] })}
      />
    );
    const html = renderToString(ui);
    expect(html).toContain('3 minutes ago');

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    vi.setSystemTime(t0 + 60_000);
    const errors: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args);
    });
    // The workbench's effects update state while it hydrates; tell React this
    // is a test so the act() below flushes them without a warning.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      await act(async () => {
        hydrateRoot(container, ui, { onRecoverableError: (e) => errors.push(e) });
      });
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = previous;
      consoleError.mockRestore();
    }
    expect(errors).toEqual([]);
    // React keeps the server's words until the next render; the exact time is
    // in the title and the datetime attribute.
    const time = within(container).getByText(/minutes ago/);
    expect(time.tagName).toBe('TIME');
    expect(time.getAttribute('datetime')).toBe(at);
  });
});
