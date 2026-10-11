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
const cancelReturn = vi.hoisted(() => vi.fn());
const releaseAction = vi.hoisted(() => vi.fn());
const cancelReplacementAction = vi.hoisted(() => vi.fn());
const declineAction = vi.hoisted(() => vi.fn());
const changeAction = vi.hoisted(() => vi.fn());
const candidatesAction = vi.hoisted(() => vi.fn(async () => ({ ok: true, data: { siblings: [], matches: [] } })));
vi.mock('@/server/actions/returns', () => ({
  runReturnStepsAction: runSteps,
  denyReturnAction: vi.fn(),
  cancelReturnAction: cancelReturn,
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
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push }) }));
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

  // RX-2 review fix P23: the approval says what it created.
  it('the approval toast names the replacement order it created and what it reserved', async () => {
    runSteps.mockResolvedValue({
      ok: true,
      data: {
        ran: [{ step: 'approve', outcome: 'done', approval: { status: 'approved', replacement: { orderId: 'repl-1', orderNumber: 104, short: false, lines: [{ held: 1 }] } } }],
        workbench: bench('approved', WAITING),
      },
    });
    render(<ReturnWorkbench workbench={bench('requested', {})} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve return & exchange' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Approved. Replacement order SO-000104 created and 1 reserved.'));
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

  // RX-2 review fix P7: "Change replacement" after a short refusal did
  // nothing visible; it now switches each short line to Change replacement
  // and moves focus to its picker.
  it('short: "Change replacement" switches the short line to Change replacement and moves focus to its picker', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Change replacement' }));
    const side = screen.getByRole('article', { name: /REPLACEMENT for Walk New Hire Shirt, M/ });
    expect(within(side).getByLabelText('Change replacement…')).toBeChecked();
    const picker = within(side).getByRole('group', { name: 'Choose the replacement for Walk New Hire Shirt, M' });
    await waitFor(() => expect(document.activeElement).toBe(picker));
    // The numbers gave way to the choice; approving now needs a new item.
    expect(screen.queryByText('Walk New Hire Shirt, L: 0 available, 1 needed.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve return & exchange' })).toBeDisabled();
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
    // RX-2 review fix P27: the card's undo reads as the action it is.
    fireEvent.click(screen.getByRole('button', { name: 'Add a replacement' }));
    expect(screen.getByRole('button', { name: 'Keep as return only' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Return only' })).toBeNull();
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
    // Re-pinned by fix round 1 (verification L3): this viewer approves the
    // return only, so the button never says "& exchange".
    const approveBtn = screen.getByRole('button', { name: 'Approve return' });
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

  // RX-2 review fixes P19 and P22: a picked or partly handed-over line never
  // reads "reserved 0", and earlier replacements carry the order status
  // words, never a raw code.
  it('the replacement block says picked or handed over, and lists earlier replacements in status words', () => {
    const picked = {
      ...WAITING,
      status: 'ready_for_pickup',
      replacement: { ...WAITING.replacement, status: 'staged_for_pickup', class: 'drawn', held: 0, lines: [{ ...WAITING.replacement.lines[0]!, held: 0, take: null }] },
      history: [{ orderId: 'o-old', orderNumber: 101, status: 'cancelled' }, { orderId: 'o-older', orderNumber: 99, status: 'pick_slip_generated' }],
    };
    const { unmount } = render(<ReturnWorkbench workbench={bench('received', picked)} />);
    const block = screen.getByRole('region', { name: 'Replacement order' });
    expect(within(block).getByText((_, el) => el?.tagName === 'LI' && el.textContent === 'Walk New Hire Shirt, L ×1 · picked')).toBeInTheDocument();
    expect(block.textContent).not.toContain('reserved 0');
    const earlier = within(block).getByText((_, el) => el?.tagName === 'P' && (el.textContent ?? '').startsWith('Earlier replacements:'));
    expect(earlier.textContent).toBe('Earlier replacements: SO-000101 (cancelled), SO-000099 (pick slip)');
    expect(within(earlier).getByRole('link', { name: 'SO-000101' })).toHaveAttribute('href', '/dashboard/orders/o-old');
    expect(earlier.textContent).not.toContain('_');
    unmount();
    const partly = {
      ...WAITING,
      status: 'partly_handed_over',
      replacement: {
        ...WAITING.replacement,
        status: 'backordered',
        class: 'handed_over',
        held: 0,
        lines: [{ ...WAITING.replacement.lines[0]!, label: 'Walk New Hire Shirt, XL', requested: 2, fulfilled: 1, held: 0, take: null }],
      },
    };
    render(<ReturnWorkbench workbench={bench('approved', partly)} />);
    const block2 = screen.getByRole('region', { name: 'Replacement order' });
    expect(
      within(block2).getByText((_, el) => el?.tagName === 'LI' && el.textContent === 'Walk New Hire Shirt, XL ×2 · handed over 1 · reserved 0'),
    ).toBeInTheDocument();
  });

  // RX-2 review fix P18: "Get replacement ready" draws stock and stages the
  // order, so what it does is said under the button first (nothing prints).
  it('Get replacement ready says what it does under the button, and the button points at it', () => {
    render(<ReturnWorkbench workbench={bench('received', { ...WAITING, status: 'ready_to_pick' })} />);
    const button = screen.getByRole('button', { name: 'Get replacement ready' });
    const help = screen.getByText(
      'Makes the pick slip, records the pick, makes the packing slips and stages it. Take the item from the rack shown first. Stops before the signature.',
    );
    expect(button).toHaveAttribute('aria-describedby', help.id);
    expect(help.id).not.toBe('');
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

  // RX-2 review fix (counter taps): Hand over opens the replacement order
  // with the Physical signature dialog ready (the order page honours it once,
  // only when it may); Open replacement opens the page as it is.
  it('Hand over opens the replacement order asking for the physical signature; Open replacement does not', () => {
    const ready = { ...WAITING, status: 'ready_for_pickup', replacement: { ...WAITING.replacement, status: 'staged_for_pickup', class: 'drawn' } };
    const { unmount } = render(<ReturnWorkbench workbench={bench('received', ready)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hand over' }));
    expect(push).toHaveBeenCalledWith('/dashboard/orders/repl-1?sign=physical');
    unmount();
    push.mockClear();
    const unavailable = { ...WAITING, status: 'unavailable' };
    render(<ReturnWorkbench workbench={bench('approved', unavailable)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open replacement' }));
    expect(push).toHaveBeenCalledWith('/dashboard/orders/repl-1');
  });

  // RX-2 review fix (0396 stock S2): the RMA cancel is refused while the
  // replacement is picked or on its way; the screen was stale, so it says the
  // words, closes the confirm and redraws, as for any changed return.
  it('a cancel refused because the replacement is on its way is a stale screen: its words, the confirm closes, the page redraws', async () => {
    cancelReturn.mockResolvedValue({
      ok: false,
      error: {
        code: 'conflict',
        message: 'The replacement is already picked or on its way. Hand it over, or cancel the replacement first.',
        details: { reason: 'replacement_in_progress', detail: 'staged_for_pickup' },
      },
    });
    render(<ReturnWorkbench workbench={bench('approved', WAITING)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel return' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason (required: the exchange was approved)'), { target: { value: 'Customer kept it' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel return' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'The replacement is already picked or on its way. Hand it over, or cancel the replacement first.',
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(refresh).toHaveBeenCalled();
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
    // Re-pinned by fix round 1 (verification L3): after the approval nothing
    // is approved; the words say what needs order approval.
    expect(
      screen.getByText('Changing, cancelling, releasing, preparing or issuing the replacement needs order approval permission.'),
    ).toBeInTheDocument();
  });
});

// RX-2 fix round 1 (independent verification 2026-10-11).
describe('fix round 1: Cancel replacement says what it saw, what happened, and never sticks', () => {
  const CANCELLED = {
    ...WAITING,
    status: 'replacement_cancelled',
    statusLabel: 'Replacement cancelled',
    lines: [exchangeLine({ status: 'cancelled', approvedItemId: 'item-l', approvedQuantity: 1, approvedItem: ITEM_L })],
    replacement: null,
  };
  async function confirmCancelReplacement() {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel replacement' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Reason for cancelling the replacement/), { target: { value: 'Wrong colour' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel replacement' }));
    return dialog;
  }

  // Verification V1: the database refuses a replacement picked or sent since
  // the screen showed it, and the answer's drawn and inTransit are said after
  // the call whatever the screen showed.
  it('sends the replacement status the dialog showed, and after the call says what to do with what was picked or sent', async () => {
    cancelReplacementAction.mockResolvedValue({
      ok: true,
      data: {
        answer: { changed: true, status: 'approved', revision: 2, cancelledOrderId: 'repl-1', drawn: true, inTransit: true },
        workbench: bench('approved', CANCELLED),
      },
    });
    render(<ReturnWorkbench workbench={bench('approved', WAITING)} />);
    await confirmCancelReplacement();
    await waitFor(() => expect(cancelReplacementAction).toHaveBeenCalledTimes(1));
    expect(cancelReplacementAction.mock.calls[0]![0]).toEqual({
      id: RET,
      body: { expectedRevision: 1, reason: 'Wrong colour', shownStatus: 'approved' },
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Replacement cancelled.'));
    const followUp = await screen.findByRole('alert', { name: 'After cancelling the replacement' });
    expect(within(followUp).getByText('The picked items go back to Staging on record. Put them in the staging area.')).toBeInTheDocument();
    expect(within(followUp).getByText('Ask the driver to bring it back.')).toBeInTheDocument();
    fireEvent.click(within(followUp).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('alert', { name: 'After cancelling the replacement' })).toBeNull();
  });

  it('an undrawn cancel says only that it was cancelled', async () => {
    cancelReplacementAction.mockResolvedValue({
      ok: true,
      data: {
        answer: { changed: true, status: 'approved', revision: 2, cancelledOrderId: 'repl-1', drawn: false, inTransit: false },
        workbench: bench('approved', CANCELLED),
      },
    });
    render(<ReturnWorkbench workbench={bench('approved', WAITING)} />);
    await confirmCancelReplacement();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Replacement cancelled.'));
    expect(screen.queryByRole('alert', { name: 'After cancelling the replacement' })).toBeNull();
  });

  // Completeness C-3 (pattern 20): a refusal shows inside the dialog too.
  it('a refusal stays inside the open dialog as an alert, cleared on the next attempt', async () => {
    cancelReplacementAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: 'Another person changed this return. Review it again.', details: { reason: 'return_changed' } },
    });
    render(<ReturnWorkbench workbench={bench('approved', WAITING)} />);
    const dialog = await confirmCancelReplacement();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Another person changed this return. Review it again.');
    expect(refresh).toHaveBeenCalled();
    cancelReplacementAction.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel replacement' }));
    await waitFor(() => expect(within(dialog).queryByText('Another person changed this return. Review it again.')).toBeNull());
  });

  // Completeness C-2: a call that rejects (a network drop, a deploy's
  // server-action skew) never leaves the dialog busy and unclosable.
  it('a call that rejects frees the dialog and says so inside it', async () => {
    cancelReplacementAction.mockRejectedValueOnce(new Error('fetch failed'));
    render(<ReturnWorkbench workbench={bench('approved', WAITING)} />);
    const dialog = await confirmCancelReplacement();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Something went wrong. Try again.');
    expect(within(dialog).getByRole('button', { name: 'Keep it' })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('every other workbench action frees its busy state when the call rejects', async () => {
    runSteps.mockRejectedValueOnce(new Error('fetch failed'));
    render(<ReturnWorkbench workbench={bench('requested', {})} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve return & exchange' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Something went wrong. Try again.'));
    expect(screen.getByRole('button', { name: 'Approve return & exchange' })).toBeEnabled();
  });

  // Verification L3: a viewer who can only decline approves the return.
  it('a decline-only viewer reads "Approve return", never "& exchange"', () => {
    render(
      <ReturnWorkbench
        workbench={bench('requested', {}, { viewer: { canManageReturns: true, canApproveOrders: false, canReadDecisions: true } })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Approve return' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve return & exchange' })).toBeNull();
  });
});

// Verification L1 (the F-C class in Change replacement): a short refusal
// names the picked item by its own row label, the backorder button says
// what it does, and a new pick hides the stale numbers.
describe('fix round 1: Change replacement short refusal', () => {
  const XXL = {
    itemId: 'item-2xl', name: 'Walk New Hire Shirt', sku: 'NH-2XL', variantSize: '2XL', variantKey: '2XL', groupId: 'g1',
    sibling: true, isReturnedItem: false, onHand: 0, held: 0, free: 0,
  };
  const S = { ...XXL, itemId: 'item-s', sku: 'NH-S', variantSize: 'S', variantKey: 'S', onHand: 4, free: 4 };
  it('names the picked short item, says "Change, replacement on backorder", and drops the numbers after a new pick', async () => {
    candidatesAction.mockResolvedValue({
      ok: true,
      data: { orderId: 'o1', orderRequestLineId: 'ol1', returnedItemId: 'item-m', groupId: 'g1', siblings: [XXL, S], matches: [] },
    } as never);
    changeAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message: 'Not in stock.',
        details: { reason: 'replacement_unavailable', detail: [{ itemId: 'item-2xl', needed: 1, available: 0 }] },
      },
    });
    render(<ReturnWorkbench workbench={bench('approved', WAITING)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change replacement' }));
    const change = await screen.findByRole('dialog', { name: 'Change replacement' });
    fireEvent.click(await within(change).findByDisplayValue('item-2xl'));
    fireEvent.change(within(change).getByLabelText('Reason (required)'), { target: { value: 'Wrong size' } });
    fireEvent.click(within(change).getByRole('button', { name: 'Change replacement' }));
    const short = await within(change).findByRole('alert', { name: 'Not in stock' });
    expect(short).toHaveTextContent('Walk New Hire Shirt, 2XL: 0 available, 1 needed.');
    expect(short.textContent).not.toMatch(/^Item:/);
    expect(within(change).getByRole('button', { name: 'Change, replacement on backorder' })).toBeInTheDocument();
    expect(within(change).queryByRole('button', { name: 'Approve, replacement on backorder' })).toBeNull();
    fireEvent.click(within(change).getByDisplayValue('item-s'));
    await waitFor(() => expect(within(change).queryByRole('alert', { name: 'Not in stock' })).toBeNull());
    expect(within(change).queryByRole('button', { name: 'Change, replacement on backorder' })).toBeNull();
  });
});

// RX-2 review fix P17, built in RX-3 (plan 3.10, D28): the 14-day prompt.
describe('the 14-day prompt while the replacement waits for the returned item', () => {
  const DAY = 86_400_000;
  /** Approved `days` whole days ago (and a minute), from this test's clock. */
  const approvedDaysAgo = (days: number) => new Date(Date.now() - days * DAY - 60_000).toISOString();
  const waitingBench = (days: number, exchange: Record<string, unknown> = WAITING, viewer?: Record<string, boolean>) => {
    const b = bench('approved', exchange) as unknown as { return: Record<string, unknown>; viewer: Record<string, boolean> };
    b.return.approvedAt = approvedDaysAgo(days);
    if (viewer) b.viewer = { ...b.viewer, ...viewer };
    return b as never;
  };

  it('from 14 days says how long it has waited and what Cancel replacement and Cancel return do, under the next-step bar, and describes both buttons', () => {
    render(<ReturnWorkbench workbench={waitingBench(15)} />);
    const prompt = screen.getByTestId('still-waiting');
    expect(prompt).toHaveTextContent(
      'Waiting 15 days. Still waiting for the returned item? Cancel replacement frees the reserved items; Cancel return ends the return too.',
    );
    const bar = screen.getByRole('region', { name: 'Next step' });
    expect(bar).toContainElement(prompt);
    for (const name of ['Cancel replacement', 'Cancel return']) {
      expect(within(bar).getByRole('button', { name })).toHaveAttribute('aria-describedby', prompt.id);
    }
    // The other buttons are not described by it.
    expect(within(bar).getByRole('button', { name: 'Receive' })).not.toHaveAttribute('aria-describedby');
  });

  it('says nothing before 14 days', () => {
    render(<ReturnWorkbench workbench={waitingBench(13)} />);
    expect(screen.queryByTestId('still-waiting')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel replacement' })).not.toHaveAttribute('aria-describedby');
  });

  it('when the replacement holds nothing (not in stock), says Cancel replacement cancels the order, not that it frees anything', () => {
    const short = {
      ...WAITING,
      status: 'unavailable',
      statusLabel: 'Replacement unavailable (backordered)',
      replacement: { ...WAITING.replacement, held: 0, short: true, lines: [{ ...WAITING.replacement.lines[0]!, held: 0 }] },
    };
    render(<ReturnWorkbench workbench={waitingBench(20, short)} />);
    expect(screen.getByTestId('still-waiting')).toHaveTextContent(
      'Waiting 20 days. Still waiting for the returned item? Cancel replacement cancels the replacement order; Cancel return ends the return too.',
    );
  });

  it('is not shown to someone who cannot cancel the replacement (no order approval)', () => {
    render(<ReturnWorkbench workbench={waitingBench(30, WAITING, { canApproveOrders: false })} />);
    expect(screen.queryByTestId('still-waiting')).toBeNull();
  });

  it('is gone once the returned item is received', () => {
    const b = bench('received', { ...WAITING, status: 'ready_to_pick' }) as unknown as { return: Record<string, unknown> };
    b.return.approvedAt = approvedDaysAgo(30);
    render(<ReturnWorkbench workbench={b as never} />);
    expect(screen.queryByTestId('still-waiting')).toBeNull();
  });
});
