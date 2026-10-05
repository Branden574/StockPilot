// @vitest-environment happy-dom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CASE_TABLE_STEPS, RECEIVING_CHECKLIST_COPY as C } from '@stockpilot/core';

/**
 * F4-1: each receipt card says where its checklist stands (core
 * receiptChecklistState) and offers Record, Continue or View (core
 * receiptChecklistAction): text chips, never colour alone; a failed read is
 * "didn't load" on every card, never "not recorded"; Record only for someone
 * who may record, on a posted or reversed receipt, while a version is live.
 */

const startReceivingCheckAction = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('@/server/actions/receiving', () => ({ reverseReceiptAction: vi.fn() }));
vi.mock('@/server/actions/receiving-checklist', () => ({ startReceivingCheckAction }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ReceiptHistory, type ReceiptChecklists } from './receipt-history';

const receipt = (id: string, status: string, receivedAt: string) => ({
  id,
  organization_id: 'org',
  purchase_order_id: 'po-1',
  warehouse_id: 'wh',
  receipt_number: `R-${id}`,
  status: status as 'posted',
  reversed_receipt_id: null,
  reversal_reason: null,
  notes: null,
  received_by: 'u',
  received_at: receivedAt,
  received_by_name: 'Pat',
  idempotency_key: null,
  created_at: receivedAt,
  updated_at: receivedAt,
});

const V1 = {
  id: 'v1',
  versionNumber: 1,
  title: 'T',
  steps: [...CASE_TABLE_STEPS],
  publishedAt: '2026-10-01T00:00:00Z',
  retiredAt: null,
};
const RECEIPTS = [
  receipt('a', 'posted', '2026-10-02T00:00:00Z'),
  receipt('b', 'posted', '2026-10-03T00:00:00Z'),
  receipt('c', 'posted', '2026-10-04T00:00:00Z'),
  receipt('d', 'reversal', '2026-10-05T00:00:00Z'),
  receipt('e', 'posted', '2026-09-01T00:00:00Z'),
];
const run = (id: string, receiptId: string, over: Record<string, unknown> = {}) => ({
  id,
  receiptId,
  versionId: 'v1',
  status: 'in_progress' as const,
  results: {},
  startedAt: '2026-10-02T01:00:00Z',
  startedByName: 'Pat',
  completedAt: null,
  completedByName: null,
  ...over,
});
const CHECKS: ReceiptChecklists = {
  ok: true,
  versions: [V1],
  runs: [
    run('run-a', 'a', {
      status: 'completed',
      completedAt: 'x',
      completedByName: 'Sam',
      results: { s1: { value: 'fail', note: 'n' }, s2: { value: 'fail', note: 'n' } },
    }),
    run('run-b', 'b'),
  ],
};

function cardOf(number: string) {
  return screen.getByText(number).closest('.rounded-xl') as HTMLElement;
}

function renderHistory(checklists: ReceiptChecklists | undefined, canRecordChecklist: boolean) {
  return render(
    <ReceiptHistory
      receipts={RECEIPTS}
      lines={[]}
      items={{}}
      canReverse={false}
      checklists={checklists}
      canRecordChecklist={canRecordChecklist}
      poId="po-1"
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  startReceivingCheckAction.mockResolvedValue({
    ok: true,
    data: { runId: 'run-c', created: true, versionNumber: 1 },
  });
});

// Desk check F10(a): staff and viewers no longer see Receive items, so the
// empty Receipts card names it only to someone it is offered to.
describe('no receipts yet', () => {
  it('names Receive items only where the page offers it', () => {
    const view = render(
      <ReceiptHistory receipts={[]} lines={[]} items={{}} canReverse={false} canReceive />,
    );
    expect(screen.getByText(/No receipts yet\./).textContent).toContain('Receive items');
    view.unmount();
    render(
      <ReceiptHistory receipts={[]} lines={[]} items={{}} canReverse={false} canReceive={false} />,
    );
    const empty = screen.getByText(/No receipts yet\./);
    expect(empty.textContent).toBe('No receipts yet.');
  });
});

describe('receipt cards: checklist chips and actions', () => {
  it('reads each state in words, and offers what the person may do', () => {
    renderHistory(CHECKS, true);
    const a = within(cardOf('R-a'));
    expect(a.getByText(C.chipFailed(2))).toBeTruthy();
    expect(a.getByRole('link', { name: C.viewChecklist }).getAttribute('href')).toBe(
      '/dashboard/purchase-orders/receiving-checks/run-a',
    );
    const b = within(cardOf('R-b'));
    expect(b.getByText(C.chipInProgress)).toBeTruthy();
    expect(b.getByRole('link', { name: C.continueChecklist }).getAttribute('href')).toBe(
      '/dashboard/purchase-orders/receiving-checks/run-b',
    );
    const c = within(cardOf('R-c'));
    expect(c.getByText(C.chipNotRecorded)).toBeTruthy();
    expect(c.getByRole('button', { name: C.recordChecklist })).toBeTruthy();
    // A reversal row has no checklist; a receipt from before any checklist is never nagged.
    expect(within(cardOf('R-d')).queryByTestId('receipt-checklist-chip')).toBeNull();
    expect(within(cardOf('R-d')).queryByRole('button', { name: C.recordChecklist })).toBeNull();
    expect(within(cardOf('R-e')).queryByTestId('receipt-checklist-chip')).toBeNull();
    // Desk check F4 (core receiptChecklistAction, the phone's rule too): it
    // had no checklist to follow, so it is never offered one.
    expect(within(cardOf('R-e')).queryByRole('button', { name: C.recordChecklist })).toBeNull();
  });

  // Desk check F4: one rule for web and phone (core receiptChecklistAction).
  // A receipt received after the organization's first checklist, while none
  // was on, has no chip (never nagged) but is offered Record once one is on;
  // one received before the first checklist is offered nothing.
  it('Record for a receipt from a gap after the first checklist, never for one from before it', () => {
    const versions = [
      { ...V1, retiredAt: '2026-10-02T00:00:00Z' },
      { ...V1, id: 'v2', versionNumber: 2, publishedAt: '2026-10-04T00:00:00Z', retiredAt: null },
    ];
    const gap = { ok: true as const, versions, runs: [] };
    const view = render(
      <ReceiptHistory
        receipts={[receipt('g', 'posted', '2026-10-03T00:00:00Z'), RECEIPTS[4]!]}
        lines={[]}
        items={{}}
        canReverse={false}
        checklists={gap}
        canRecordChecklist
        poId="po-1"
      />,
    );
    expect(within(cardOf('R-g')).queryByTestId('receipt-checklist-chip')).toBeNull();
    expect(within(cardOf('R-g')).getByRole('button', { name: C.recordChecklist })).toBeTruthy();
    expect(within(cardOf('R-e')).queryByRole('button', { name: C.recordChecklist })).toBeNull();
    view.unmount();
    // Someone who may not record is offered nothing on either.
    render(
      <ReceiptHistory
        receipts={[receipt('g', 'posted', '2026-10-03T00:00:00Z')]}
        lines={[]}
        items={{}}
        canReverse={false}
        checklists={gap}
        canRecordChecklist={false}
        poId="po-1"
      />,
    );
    expect(screen.queryByRole('button', { name: C.recordChecklist })).toBeNull();
  });

  it('someone who may not record sees the chips and View, never Record or Continue', () => {
    renderHistory(CHECKS, false);
    expect(screen.queryByRole('button', { name: C.recordChecklist })).toBeNull();
    expect(screen.queryByRole('link', { name: C.continueChecklist })).toBeNull();
    expect(within(cardOf('R-b')).getByRole('link', { name: C.viewChecklist })).toBeTruthy();
    expect(within(cardOf('R-c')).getByText(C.chipNotRecorded)).toBeTruthy();
  });

  // Mutation caught: a failed read rendered as "not recorded".
  it('a failed read says "didn\'t load" on every card, never "not recorded", and offers nothing', () => {
    renderHistory({ ok: false }, true);
    expect(screen.getAllByText(C.chipUnavailable)).toHaveLength(RECEIPTS.length);
    expect(screen.queryByText(C.chipNotRecorded)).toBeNull();
    expect(screen.queryByRole('button', { name: C.recordChecklist })).toBeNull();
  });

  it('without the checklist reads at all, the cards are as before', () => {
    renderHistory(undefined, true);
    expect(screen.queryAllByTestId('receipt-checklist-chip')).toHaveLength(0);
  });

  it('Record starts the run and opens it', async () => {
    const user = userEvent.setup();
    renderHistory(CHECKS, true);
    await user.click(within(cardOf('R-c')).getByRole('button', { name: C.recordChecklist }));
    expect(startReceivingCheckAction).toHaveBeenCalledWith('c', 'po-1');
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith('/dashboard/purchase-orders/receiving-checks/run-c'),
    );
  });

  it('a refused start is said on the card, and nothing opens', async () => {
    startReceivingCheckAction.mockResolvedValue({
      ok: false,
      error: { code: 'conflict', message: C.noChecklist },
    });
    const user = userEvent.setup();
    renderHistory(CHECKS, true);
    await user.click(within(cardOf('R-c')).getByRole('button', { name: C.recordChecklist }));
    expect((await within(cardOf('R-c')).findByRole('alert')).textContent).toBe(C.noChecklist);
    expect(router.push).not.toHaveBeenCalled();
  });

  // Mutation caught: the start awaited bare (the card's button stayed busy).
  it('a start whose reply never comes back is said on the card, and Record works again', async () => {
    startReceivingCheckAction.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    renderHistory(CHECKS, true);
    await user.click(within(cardOf('R-c')).getByRole('button', { name: C.recordChecklist }));
    expect((await within(cardOf('R-c')).findByRole('alert')).textContent).toBe(C.didNotGoThrough);
    const again = within(cardOf('R-c')).getByRole('button', { name: C.recordChecklist });
    expect(again).not.toBeDisabled();
    await user.click(again);
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith('/dashboard/purchase-orders/receiving-checks/run-c'),
    );
  });
});
