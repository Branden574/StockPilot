// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The workbench's exchange states (returns RX-2): the REPLACEMENT side with
 * its availability, the approval review (as requested, change, decline with
 * a reason), the short refusal answered with the numbers and "Approve,
 * replacement on backorder", early release with its presets, the drawn
 * cancel warning, and the rail that says each step's state in words.
 */

const runSteps = vi.hoisted(() => vi.fn());
const releaseAction = vi.hoisted(() => vi.fn());
const cancelReplacementAction = vi.hoisted(() => vi.fn());
const declineAction = vi.hoisted(() => vi.fn());
const changeAction = vi.hoisted(() => vi.fn());
const candidatesAction = vi.hoisted(() => vi.fn(async () => ({ ok: true, data: { siblings: [], matches: [] } })));
vi.mock('@/server/actions/returns', () => ({
  runReturnStepsAction: runSteps,
  denyReturnAction: vi.fn(),
  cancelReturnAction: vi.fn(),
  planReturnDispositionsAction: vi.fn(),
  buyReturnLabelAction: vi.fn(),
  releaseReturnReplacementAction: releaseAction,
  cancelReturnReplacementAction: cancelReplacementAction,
  declineReturnReplacementAction: declineAction,
  changeReturnReplacementAction: changeAction,
  prepareReturnReplacementAction: vi.fn(),
  returnExchangeCandidatesAction: candidatesAction,
}));
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push }) }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return { default: ({ href, children }: { href: string; children: React.ReactNode }) => React.createElement('a', { href }, children) };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { ReturnWorkbench } from './return-workbench';

const RET = '11111111-1111-4111-8111-111111111111';
const R31 = '44444444-4444-4444-8444-444444444444';

const ITEM_L = { name: 'Walk New Hire Shirt', sku: 'NH-L', variant: 'Size L', deleted: false, imageUrl: null, thumbUrl: null };

function exchangeLine(over: Record<string, unknown> = {}) {
  return {
    id: 'x1',
    returnLineId: 'l1',
    status: 'requested',
    requestedItemId: 'item-l',
    requestedQuantity: 1,
    requestNote: null,
    requestedByKind: 'staff',
    requestedItem: ITEM_L,
    requestedFree: 14,
    approvedItemId: null,
    approvedQuantity: null,
    approvedItem: null,
    approvedFree: null,
    changedByWarehouse: false,
    revision: 0,
    ...over,
  };
}

function bench(status: string, exchange: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    return: {
      id: RET,
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
        itemId: 'item-m',
        quantity: 1,
        disposition: 'restock',
        applied: false,
        item: { name: 'Walk New Hire Shirt', sku: 'NH-M', variant: 'Size M', deleted: false, imageUrl: null, thumbUrl: null },
        restock: {
          returnLineId: 'l1',
          itemId: 'item-m',
          quantity: 1,
          disposition: 'restock',
          applied: false,
          plan: null,
          case: 'single_source',
          notRecordedReason: null,
          sources: [
            { locationId: R31, name: '31-C', kind: 'rack', type: 'shelf', drawn: 1, restored: 0, remaining: 1, cap: 1, valid: true, reason: null, writable: true },
          ],
          offerOriginal: true,
          offerSourceIds: [],
          preselect: 'original',
        },
        legs: [],
        inboundState: 'Waiting',
      },
    ],
    decisions: [],
    chain: [],
    viewer: { canManageReturns: true, canApproveOrders: true, canReadDecisions: true },
    actions: { primary: null, secondary: [], readOnlyReason: null },
    exchange: {
      kind: 'exchange',
      status: 'requested',
      statusLabel: 'Exchange requested',
      lines: [exchangeLine()],
      replacement: null,
      history: [],
      releasedEarly: false,
      release: null,
      counter: false,
      rail: [
        { id: 'requested', label: 'Requested', state: 'current' },
        { id: 'reserved', label: 'Reserved', state: 'upcoming' },
      ],
      hasApprovedExchange: false,
      createEnabled: true,
      ...exchange,
    },
    ...over,
  } as never;
}

const WAITING = {
  status: 'waiting_for_return',
  statusLabel: 'Replacement reserved. Waiting for returned item',
  lines: [exchangeLine({ status: 'approved', approvedItemId: 'item-l', approvedQuantity: 1, approvedItem: ITEM_L })],
  replacement: {
    orderId: 'repl-1',
    orderNumber: 104,
    status: 'approved',
    fulfillmentType: 'pickup',
    live: true,
    class: 'undrawn',
    owed: 1,
    held: 1,
    short: false,
    lines: [{ orderLineId: 'ol9', itemId: 'item-l', label: 'Walk New Hire Shirt, L', item: ITEM_L, requested: 1, fulfilled: 0, held: 1, take: 'Take Walk New Hire Shirt, L ×1 from 12-B (3 on hand)' }],
  },
  hasApprovedExchange: true,
  rail: [
    { id: 'requested', label: 'Requested', state: 'done' },
    { id: 'reserved', label: 'Reserved', state: 'done' },
    { id: 'gate', label: 'Waiting for return', state: 'current' },
  ],
};

beforeEach(() => vi.clearAllMocks());

describe('a requested exchange', () => {
  it('shows the REPLACEMENT side with its availability and approves "as requested" in one step', async () => {
    runSteps.mockResolvedValue({ ok: true, data: { ran: [{ step: 'approve', outcome: 'done' }], workbench: bench('approved', WAITING) } });
    render(<ReturnWorkbench workbench={bench('requested', {})} />);
    const side = screen.getByRole('article', { name: /REPLACEMENT for Walk New Hire Shirt, M/ });
    expect(within(side).getByText('Walk New Hire Shirt, L')).toBeInTheDocument();
    expect(within(side).getByText('Available: 14')).toBeInTheDocument();
    expect(screen.getByText('Exchange')).toBeInTheDocument();
    // "What happens when you approve" names the replacement and the wait.
    expect(screen.getByText('A replacement order is created for Walk New Hire Shirt, L ×1 and 1 is reserved.')).toBeInTheDocument();
    expect(screen.getByText('Picking waits until Walk New Hire Shirt, M is received.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve return & exchange' }));
    await waitFor(() => expect(runSteps).toHaveBeenCalledTimes(1));
    const body = (runSteps.mock.calls[0]![0] as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({
      steps: ['approve'],
      approve: { exchange: [{ action: 'approve', exchangeLineId: 'x1' }], replacement: { whenShort: 'refuse' } },
    });
  });

  it('declining needs a reason before the approval can go', async () => {
    runSteps.mockResolvedValue({ ok: true, data: { ran: [{ step: 'approve', outcome: 'done' }], workbench: bench('approved', { status: 'declined' }) } });
    render(<ReturnWorkbench workbench={bench('requested', {})} />);
    fireEvent.click(screen.getByLabelText('Decline the exchange, return only'));
    const approveBtn = screen.getByRole('button', { name: 'Approve return & exchange' });
    expect(approveBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for declining the exchange (required)'), { target: { value: 'Out of that style' } });
    expect(approveBtn).not.toBeDisabled();
    fireEvent.click(approveBtn);
    await waitFor(() => expect(runSteps).toHaveBeenCalled());
    expect((runSteps.mock.calls[0]![0] as { body: { approve: { exchange: unknown[] } } }).body.approve.exchange).toEqual([
      { action: 'decline', exchangeLineId: 'x1', reason: 'Out of that style' },
    ]);
  });

  it('short: the numbers first, then "Approve, replacement on backorder" resends with backorder', async () => {
    runSteps.mockResolvedValueOnce({
      ok: true,
      data: {
        ran: [{ step: 'approve', outcome: 'refused', reason: 'replacement_unavailable', message: 'The replacement is not in stock.', detail: [{ itemId: 'item-l', needed: 1, available: 0 }] }],
        workbench: bench('requested', {}),
      },
    });
    render(<ReturnWorkbench workbench={bench('requested', {})} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve return & exchange' }));
    expect(await screen.findByText('Walk New Hire Shirt, L: 0 available, 1 needed.')).toBeInTheDocument();
    runSteps.mockResolvedValueOnce({ ok: true, data: { ran: [{ step: 'approve', outcome: 'done' }], workbench: bench('approved', { ...WAITING, status: 'unavailable' }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve, replacement on backorder' }));
    await waitFor(() => expect(runSteps).toHaveBeenCalledTimes(2));
    expect((runSteps.mock.calls[1]![0] as { body: { approve: { replacement: unknown } } }).body.approve.replacement).toEqual({ whenShort: 'backorder' });
  });

  // Desk check F6: the original delivery site is not one the warehouse serves.
  it('a refused delivery site asks where the replacement goes, then sends the approval again with the choice', async () => {
    runSteps.mockResolvedValueOnce({
      ok: true,
      data: {
        ran: [{ step: 'approve', outcome: 'refused', reason: 'replacement_site_not_available', message: 'Choose a delivery site this warehouse serves.' }],
        workbench: bench('requested', { deliverySites: [{ id: 'site-2', name: 'West Campus' }] }),
      },
    });
    render(<ReturnWorkbench workbench={bench('requested', { deliverySites: [{ id: 'site-2', name: 'West Campus' }] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve return & exchange' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Where does the replacement go?')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Deliver to West Campus')).toBeInTheDocument();
    const send = within(dialog).getByRole('button', { name: 'Send again' });
    expect(send).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText('Pickup instead'));
    runSteps.mockResolvedValueOnce({ ok: true, data: { ran: [{ step: 'approve', outcome: 'done' }], workbench: bench('approved', WAITING) } });
    fireEvent.click(send);
    await waitFor(() => expect(runSteps).toHaveBeenCalledTimes(2));
    expect((runSteps.mock.calls[1]![0] as { body: { approve: { replacement: unknown } } }).body.approve.replacement).toEqual({
      whenShort: 'refuse',
      fulfillmentType: 'pickup',
      deliveryCharterId: null,
    });
  });

  it('a return-only line can get "Add a replacement" while exchanges are on; not while the switch is off', () => {
    const plain = { kind: 'return', status: 'none', lines: [], rail: [] };
    const { unmount } = render(<ReturnWorkbench workbench={bench('requested', plain)} />);
    expect(screen.getByRole('button', { name: 'Add a replacement' })).toBeInTheDocument();
    unmount();
    render(<ReturnWorkbench workbench={bench('requested', { ...plain, createEnabled: false })} />);
    expect(screen.queryByRole('button', { name: 'Add a replacement' })).toBeNull();
  });
});

// RX-2 review fix P1: a viewer with Manage returns but not order approval can
// still approve the RETURN of a requested exchange, declining the exchange
// (the database asks for order approval only to approve or add one).
describe('a returns manager without order approval', () => {
  const NO_ORDERS = { viewer: { canManageReturns: true, canApproveOrders: false, canReadDecisions: true } };

  it('sees the review: only the decline is open, it starts there, says why, and the approval sends exactly it', async () => {
    runSteps.mockResolvedValue({ ok: true, data: { ran: [{ step: 'approve', outcome: 'done' }], workbench: bench('approved', { status: 'declined' }, NO_ORDERS) } });
    render(<ReturnWorkbench workbench={bench('requested', {}, NO_ORDERS)} />);
    const side = screen.getByRole('article', { name: /REPLACEMENT for Walk New Hire Shirt, M/ });
    expect(within(side).getByLabelText('Approve as requested. Needs order approval permission.')).toBeDisabled();
    expect(within(side).getByLabelText('Change replacement. Needs order approval permission.')).toBeDisabled();
    expect(within(side).getByLabelText('Decline the exchange, return only')).toBeChecked();
    expect(
      screen.getByText(
        'Approving the replacement needs order approval permission. You can still approve the return: choose Decline the exchange, return only.',
      ),
    ).toBeInTheDocument();
    const approveBtn = screen.getByRole('button', { name: 'Approve return & exchange' });
    expect(approveBtn).toBeDisabled();
    fireEvent.change(within(side).getByLabelText('Reason for declining the exchange (required)'), { target: { value: 'No order approval here' } });
    expect(approveBtn).not.toBeDisabled();
    fireEvent.click(approveBtn);
    await waitFor(() => expect(runSteps).toHaveBeenCalledTimes(1));
    expect((runSteps.mock.calls[0]![0] as { body: { approve: { exchange: unknown[] } } }).body.approve.exchange).toEqual([
      { action: 'decline', exchangeLineId: 'x1', reason: 'No order approval here' },
    ]);
  });

  it('is never offered Add a replacement (it creates an order)', () => {
    render(<ReturnWorkbench workbench={bench('requested', { kind: 'return', status: 'none', lines: [], rail: [] }, NO_ORDERS)} />);
    expect(screen.queryByRole('button', { name: 'Add a replacement' })).toBeNull();
  });
});

// RX-2 review fix P4: after a stop nothing reads "next", and the empty
// replacement block says why there is no order.
describe('an exchange that ended before any replacement', () => {
  it('declined: the later steps were not reached, and no replacement order because it was declined', () => {
    render(
      <ReturnWorkbench
        workbench={bench('approved', {
          status: 'declined',
          statusLabel: 'Exchange declined',
          lines: [exchangeLine({ status: 'declined' })],
          rail: [
            { id: 'requested', label: 'Requested', state: 'done' },
            { id: 'reserved', label: 'Declined', state: 'stopped' },
            { id: 'gate', label: 'Waiting for return', state: 'skipped' },
            { id: 'picking', label: 'Picking', state: 'skipped' },
          ],
        })}
      />,
    );
    const rail = screen.getByRole('list', { name: 'Replacement progress' });
    expect(rail.textContent).toContain('Waiting for return · not reached');
    expect(rail.textContent).not.toContain('· next');
    expect(screen.getByText('No replacement order: the exchange was declined.')).toBeInTheDocument();
    expect(screen.queryByText(/One is created when the exchange is approved/)).toBeNull();
  });

  it('cancelled with the return: says so; a still-requested exchange keeps "not yet"', () => {
    const { unmount } = render(
      <ReturnWorkbench workbench={bench('cancelled', { status: 'cancelled', statusLabel: 'Exchange cancelled', lines: [exchangeLine()] })} />,
    );
    expect(screen.getByText('No replacement order: the exchange was cancelled with the return.')).toBeInTheDocument();
    unmount();
    render(<ReturnWorkbench workbench={bench('requested', {})} />);
    expect(screen.getByText('No replacement order yet. One is created when the exchange is approved.')).toBeInTheDocument();
  });
});

describe('an approved exchange waiting for the returned item', () => {
  it('the rail says each state in words; the take line shows before preparing', () => {
    render(<ReturnWorkbench workbench={bench('approved', WAITING)} />);
    const rail = screen.getByRole('list', { name: 'Replacement progress' });
    expect(within(rail).getByText('Waiting for return')).toBeInTheDocument();
    expect(rail.textContent).toContain('Waiting for return · now');
    expect(rail.textContent).toContain('Requested · done');
    expect(screen.getByText('Take Walk New Hire Shirt, L ×1 from 12-B (3 on hand)')).toBeInTheDocument();
  });

  it('release early: a preset fills the reason and the action sends it', async () => {
    releaseAction.mockResolvedValue({
      ok: true,
      data: { answer: { changed: true, notNeeded: false }, workbench: bench('approved', { ...WAITING, status: 'ready_to_pick', releasedEarly: true }) },
    });
    render(<ReturnWorkbench workbench={bench('approved', WAITING)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Release replacement before return is received' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Swap at delivery: the driver collects the returned item.' }));
    expect(within(dialog).getByLabelText('Reason for releasing early (required)')).toHaveValue(
      'Swap at delivery: the driver collects the returned item.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Release before return is received' }));
    await waitFor(() =>
      // Desk check F7: the release names the replacement the workbench shows.
      expect(releaseAction).toHaveBeenCalledWith({ id: RET, orderId: 'repl-1', reason: 'Swap at delivery: the driver collects the returned item.' }),
    );
  });

  // Desk check F9: after a replacement cancel the exchange can end for good,
  // so a closed RMA stops inviting "Issue a new replacement".
  it('a cancelled replacement on a closed RMA: Close as return only asks a reason and sends the revision', async () => {
    const cancelled = {
      ...WAITING,
      status: 'replacement_cancelled',
      statusLabel: 'Replacement cancelled: issue a new one or close as return only',
      lines: [exchangeLine({ status: 'cancelled', approvedItemId: 'item-l', approvedQuantity: 1, approvedItem: ITEM_L })],
      replacement: { ...WAITING.replacement, status: 'cancelled', live: false, class: 'none' },
    };
    declineAction.mockResolvedValue({
      ok: true,
      data: {
        answer: { changed: true, status: 'closed', revision: 2, declined: 1 },
        workbench: bench('closed', { ...cancelled, status: 'declined', statusLabel: 'Exchange declined' }),
      },
    });
    render(<ReturnWorkbench workbench={bench('closed', cancelled, { revision: 2 })} />);
    // The pill's words come from core's exchangeLineStatusLabel (simulator finding SIM-1).
    expect(within(screen.getByRole('article', { name: /^REPLACEMENT for / })).getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issue a new replacement' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close as return only' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('No new replacement is issued. The return goes on as a return only.')).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Close as return only' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason for keeping the return only (required)'), {
      target: { value: 'The requester wants a refund instead' },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(declineAction).toHaveBeenCalledWith({ id: RET, body: { expectedRevision: 2, reason: 'The requester wants a refund instead' } }),
    );
  });

  // Desk check F6 (verifier): the change and the re-issue ask where the
  // replacement goes after a refused delivery site, as the approval does, and
  // send the same change again with the choice.
  it('a change refused for its delivery site asks where it goes, then sends the same change with the site', async () => {
    const sites = { deliverySites: [{ id: 'site-2', name: 'West Campus' }] };
    changeAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: 'Choose a delivery site this warehouse serves.', details: { reason: 'replacement_site_not_available' } },
    });
    render(<ReturnWorkbench workbench={bench('approved', { ...WAITING, ...sites })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change replacement' }));
    const change = await screen.findByRole('dialog', { name: 'Change replacement' });
    fireEvent.change(within(change).getByLabelText('Reason (required)'), { target: { value: 'Wrong size' } });
    fireEvent.click(within(change).getByRole('button', { name: 'Change replacement' }));
    await waitFor(() => expect(changeAction).toHaveBeenCalledTimes(1));
    const first = (changeAction.mock.calls[0]![0] as { id: string; body: Record<string, unknown> });
    expect(first).toEqual({
      id: RET,
      body: { expectedRevision: 1, lines: [{ exchangeLineId: 'x1', itemId: 'item-l', quantity: 1 }], reason: 'Wrong size', whenShort: 'refuse' },
    });

    const site = await screen.findByRole('dialog', { name: 'Where does the replacement go?' });
    const send = within(site).getByRole('button', { name: 'Send again' });
    expect(send).toBeDisabled();
    fireEvent.click(within(site).getByLabelText('Deliver to West Campus'));
    changeAction.mockResolvedValueOnce({ ok: true, data: { workbench: bench('approved', { ...WAITING, ...sites }) } });
    fireEvent.click(send);
    await waitFor(() => expect(changeAction).toHaveBeenCalledTimes(2));
    expect((changeAction.mock.calls[1]![0] as { body: Record<string, unknown> }).body).toEqual({
      ...first.body,
      replacement: { fulfillmentType: 'delivery', deliveryCharterId: 'site-2' },
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Replacement changed.'));
    // Both dialogs close: the site dialog never stays on screen behind the
    // change (the two are sibling elements whose keys must differ).
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(site.isConnected).toBe(false);
  });

  it('a re-issue refused for its delivery site asks where it goes, then issues it again with the choice', async () => {
    const cancelled = {
      ...WAITING,
      status: 'replacement_cancelled',
      statusLabel: 'Replacement cancelled: issue a new one or close as return only',
      lines: [exchangeLine({ status: 'cancelled', approvedItemId: 'item-l', approvedQuantity: 1, approvedItem: ITEM_L })],
      replacement: { ...WAITING.replacement, status: 'cancelled', live: false, class: 'none' },
      deliverySites: [{ id: 'site-2', name: 'West Campus' }],
    };
    changeAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: 'Choose a delivery site this warehouse serves.', details: { reason: 'replacement_site_not_available' } },
    });
    render(<ReturnWorkbench workbench={bench('closed', cancelled, { revision: 2 })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Issue a new replacement' }));
    const issue = await screen.findByRole('dialog', { name: 'Issue a new replacement' });
    fireEvent.change(within(issue).getByLabelText('Reason (required)'), { target: { value: 'Send the right size' } });
    fireEvent.click(within(issue).getByRole('button', { name: 'Issue a new replacement' }));
    await waitFor(() => expect(changeAction).toHaveBeenCalledTimes(1));
    const first = (changeAction.mock.calls[0]![0] as { body: Record<string, unknown> }).body;
    expect(first).toEqual({
      expectedRevision: 2,
      lines: [{ exchangeLineId: 'x1', itemId: 'item-l', quantity: 1 }],
      reason: 'Send the right size',
      whenShort: 'refuse',
    });

    const site = await screen.findByRole('dialog', { name: 'Where does the replacement go?' });
    fireEvent.click(within(site).getByLabelText('Pickup instead'));
    changeAction.mockResolvedValueOnce({ ok: true, data: { workbench: bench('closed', { ...WAITING, status: 'ready_to_pick' }, { revision: 3 }) } });
    fireEvent.click(within(site).getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(changeAction).toHaveBeenCalledTimes(2));
    expect((changeAction.mock.calls[1]![0] as { body: Record<string, unknown> }).body).toEqual({
      ...first,
      replacement: { fulfillmentType: 'pickup', deliveryCharterId: null },
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('New replacement issued.'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(site.isConnected).toBe(false);
  });

  // The screen shows no live replacement (its read failed): the release sends
  // nothing and says so outside the dialog, never a silent click.
  it('release early with no live replacement shown sends nothing and says why', async () => {
    render(<ReturnWorkbench workbench={bench('approved', { ...WAITING, replacement: null })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Release replacement before return is received' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Customer is completing an in-person exchange today.' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Release before return is received' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Another person changed this return. Review it again.'));
    expect(releaseAction).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a picked replacement: the cancel confirm says the items go back to Staging on record', async () => {
    const drawn = { ...WAITING, status: 'in_progress', replacement: { ...WAITING.replacement, status: 'picking_complete', class: 'drawn' } };
    render(<ReturnWorkbench workbench={bench('received', drawn)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel replacement' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('The picked items go back to Staging on record. Put them in the staging area.')).toBeInTheDocument();
    // RX-2 review fix P2: what happens, in core's words (nothing reserved
    // after a pick, so nothing is said to be freed).
    expect(
      within(dialog).getByText(
        'The replacement order is cancelled. The return itself does not change: afterwards, issue a new replacement or close it as a return only.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel replacement' })).toBeDisabled();
  });

  // RX-2 review fix P2: one set of words for what happens to the replacement
  // (core exchangeActionConsequences), never "The return stays open." (the
  // RMA may be closed).
  it('Cancel replacement, Change and Issue say what happens to the replacement in core\'s words', async () => {
    const { unmount } = render(<ReturnWorkbench workbench={bench('approved', WAITING)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel replacement' }));
    const cancel = await screen.findByRole('dialog');
    expect(
      within(cancel).getByText(
        'The replacement order is cancelled and its reserved items are freed. The return itself does not change: afterwards, issue a new replacement or close it as a return only.',
      ),
    ).toBeInTheDocument();
    expect(within(cancel).queryByText(/stays open/)).toBeNull();
    unmount();
    render(<ReturnWorkbench workbench={bench('approved', WAITING)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change replacement' }));
    const change = await screen.findByRole('dialog', { name: 'Change replacement' });
    expect(
      within(change).getByText('The current replacement order is cancelled and a new one is created and reserved in the same step.'),
    ).toBeInTheDocument();
  });

  it('a replacement out for delivery: the cancel confirm also asks the driver to bring it back', async () => {
    const out = { ...WAITING, status: 'out_for_delivery', replacement: { ...WAITING.replacement, status: 'in_transit', class: 'drawn', fulfillmentType: 'delivery' } };
    render(<ReturnWorkbench workbench={bench('received', out)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel replacement' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Ask the driver to bring it back.')).toBeInTheDocument();
  });

  it('Cancel return names what happens to the replacement: cancelled too, part sent, or all sent', async () => {
    const { unmount } = render(<ReturnWorkbench workbench={bench('approved', WAITING)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel return' }));
    let dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('The return closes as cancelled. Its replacement order SO-000104 is cancelled too and the reserved items are freed.'),
    ).toBeInTheDocument();
    unmount();
    const partly = {
      ...WAITING,
      status: 'partly_handed_over',
      replacement: {
        ...WAITING.replacement,
        status: 'backordered',
        class: 'handed_over',
        lines: [{ ...WAITING.replacement.lines[0]!, requested: 2, fulfilled: 1, held: 0 }],
      },
    };
    const second = render(<ReturnWorkbench workbench={bench('approved', partly)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel return' }));
    dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(
        'The return closes as cancelled. What was already handed over stays handed over; the rest of the replacement is never sent.',
      ),
    ).toBeInTheDocument();
    second.unmount();
    const all = {
      ...WAITING,
      status: 'handed_over_return_open',
      replacement: { ...WAITING.replacement, status: 'completed', class: 'handed_over', lines: [{ ...WAITING.replacement.lines[0]!, fulfilled: 1, held: 0 }] },
    };
    render(<ReturnWorkbench workbench={bench('approved', all)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel return' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('The return closes as cancelled. The replacement was already handed over and stays as it is.')).toBeInTheDocument();
  });

  it('cancelling the RMA after an approved exchange needs a reason', async () => {
    render(<ReturnWorkbench workbench={bench('approved', WAITING)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel return' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Reason (required: the exchange was approved)')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel return' })).toBeDisabled();
  });

  it('a viewer without order approval sees why the replacement actions are missing', () => {
    render(
      <ReturnWorkbench
        workbench={bench('received', { ...WAITING, status: 'ready_to_pick' }, { viewer: { canManageReturns: true, canApproveOrders: false, canReadDecisions: true } })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Get replacement ready' })).toBeNull();
    expect(screen.getByText('Approving the replacement needs order approval permission.')).toBeInTheDocument();
  });
});
