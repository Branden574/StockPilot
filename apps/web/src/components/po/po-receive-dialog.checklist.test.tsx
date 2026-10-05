// @vitest-environment happy-dom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RECEIVING_CHECKLIST_COPY } from '@stockpilot/core';

/**
 * F4-1: the Posted panel. With a live checklist AND a person who may record
 * it, a successful post shows "Receipt R-… posted." with Record checklist and
 * Done in place of the form; Record starts the run and opens its page; a
 * start failure says the receipt is posted, in place. Otherwise the post
 * closes the dialog with a toast exactly as before (pinned). Once posted, the
 * dialog holds no unsaved work.
 */

const postReceiptAction = vi.hoisted(() => vi.fn());
const startReceivingCheckAction = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('@/server/actions/receiving', () => ({ postReceiptAction }));
vi.mock('@/server/actions/receiving-checklist', () => ({ startReceivingCheckAction }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast }));

import { getUnsavedSources, resetUnsavedSourcesForTests } from '@/lib/unsaved-work';

import { PoReceiveDialog } from './po-receive-dialog';

const LINES = [
  {
    id: 'l1',
    name: 'Shirt',
    sku: 'S1',
    quantityOrdered: 10,
    quantityReceived: 0,
    trackingType: 'none' as const,
  },
];

async function postOne(props: Partial<React.ComponentProps<typeof PoReceiveDialog>> = {}) {
  const user = userEvent.setup();
  render(
    <PoReceiveDialog poId="po-1" poNumber="PO-1" warehouseId="wh-1" lines={LINES} {...props} />,
  );
  await user.click(screen.getByRole('button', { name: /receive items/i }));
  await user.type(screen.getAllByRole('spinbutton')[0]!, '2');
  await user.click(screen.getByRole('button', { name: /post receipt/i }));
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetUnsavedSourcesForTests();
  postReceiptAction.mockResolvedValue({
    ok: true,
    data: { receiptId: 'rcpt-1', receiptNumber: 'R-1' },
  });
  startReceivingCheckAction.mockResolvedValue({
    ok: true,
    data: { runId: 'run-1', created: true, versionNumber: 2 },
  });
});

describe('PoReceiveDialog: the Posted panel', () => {
  it('appears after a post when a checklist is live and the person may record it', async () => {
    await postOne({
      checklist: { versionNumber: 2, title: 'Delivery checks' },
      canRecordChecklist: true,
    });
    expect(await screen.findByText(RECEIVING_CHECKLIST_COPY.postedTitle('R-1'))).toBeTruthy();
    expect(screen.getByText(RECEIVING_CHECKLIST_COPY.postedBody)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: RECEIVING_CHECKLIST_COPY.recordChecklist }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: RECEIVING_CHECKLIST_COPY.done })).toBeTruthy();
    // Re-pinned by desk check F1 (was: no toast on this path): the toast says
    // the receipt posted here too, so a person who looks away still learns it.
    expect(toast.success).toHaveBeenCalledWith('Receipt R-1 posted against PO-1.');
    expect(router.refresh).toHaveBeenCalled();
    // The receipt is saved: a reload loses nothing now.
    expect(getUnsavedSources()).toEqual([]);
  });

  it('Record checklist starts the run for this receipt and opens its page', async () => {
    const user = await postOne({
      checklist: { versionNumber: 2, title: 'T' },
      canRecordChecklist: true,
    });
    await user.click(
      await screen.findByRole('button', { name: RECEIVING_CHECKLIST_COPY.recordChecklist }),
    );
    expect(startReceivingCheckAction).toHaveBeenCalledWith('rcpt-1', 'po-1');
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith('/dashboard/purchase-orders/receiving-checks/run-1'),
    );
  });

  it('a start that fails says, in place, that the receipt is posted', async () => {
    startReceivingCheckAction.mockResolvedValue({
      ok: false,
      error: { code: 'internal_error', message: 'x' },
    });
    const user = await postOne({
      checklist: { versionNumber: 2, title: 'T' },
      canRecordChecklist: true,
    });
    await user.click(
      await screen.findByRole('button', { name: RECEIVING_CHECKLIST_COPY.recordChecklist }),
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      RECEIVING_CHECKLIST_COPY.startFailedAfterPostWeb,
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  // Mutation caught: the start awaited bare (a dropped connection left the
  // button spinning for good).
  it('a start whose reply never comes back says so in place, and Record checklist works again', async () => {
    startReceivingCheckAction.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const user = await postOne({
      checklist: { versionNumber: 2, title: 'T' },
      canRecordChecklist: true,
    });
    await user.click(
      await screen.findByRole('button', { name: RECEIVING_CHECKLIST_COPY.recordChecklist }),
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      `${RECEIVING_CHECKLIST_COPY.didNotGoThrough} ${RECEIVING_CHECKLIST_COPY.startFailedAfterPostWeb}`,
    );
    const again = screen.getByRole('button', { name: RECEIVING_CHECKLIST_COPY.recordChecklist });
    expect(again).not.toBeDisabled();
    await user.click(again);
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith('/dashboard/purchase-orders/receiving-checks/run-1'),
    );
  });

  it('a checklist turned off in between says so too', async () => {
    startReceivingCheckAction.mockResolvedValue({
      ok: false,
      error: { code: 'conflict', message: 'x', details: { reason: 'no_checklist' } },
    });
    const user = await postOne({
      checklist: { versionNumber: 2, title: 'T' },
      canRecordChecklist: true,
    });
    await user.click(
      await screen.findByRole('button', { name: RECEIVING_CHECKLIST_COPY.recordChecklist }),
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      `${RECEIVING_CHECKLIST_COPY.noChecklist} ${RECEIVING_CHECKLIST_COPY.startFailedAfterPostWeb}`,
    );
  });

  // Desk check F1: with nothing left to receive (the page passes receivable
  // false), the dialog shows no button, but an open panel is never cut off.
  it('not receivable and not open: no Receive items button', () => {
    render(
      <PoReceiveDialog
        poId="po-1"
        poNumber="PO-1"
        warehouseId="wh-1"
        lines={LINES}
        receivable={false}
      />,
    );
    expect(screen.queryByRole('button', { name: /receive items/i })).toBeNull();
  });

  // Pinned: today's path, unchanged, whenever the panel would not apply.
  it.each([
    ['no checklist is live', { checklist: null, canRecordChecklist: true }],
    [
      'the person may not record it',
      { checklist: { versionNumber: 2, title: 'T' }, canRecordChecklist: false },
    ],
    ['neither prop is passed', {}],
  ])('%s: the post closes the dialog with a toast, as before', async (_l, props) => {
    await postOne(props);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Receipt R-1 posted against PO-1.'),
    );
    expect(screen.queryByText(RECEIVING_CHECKLIST_COPY.postedTitle('R-1'))).toBeNull();
    expect(
      screen.queryByRole('button', { name: RECEIVING_CHECKLIST_COPY.recordChecklist }),
    ).toBeNull();
    expect(startReceivingCheckAction).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalled();
  });
});
