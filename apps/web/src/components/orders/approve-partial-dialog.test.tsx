import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PARTIAL_PREVIEW_ITEM_MOVED_COPY,
  PARTIAL_PREVIEW_NOTE,
  previewPartialFulfilment,
  type ActionResult,
  type OrderReadinessResult,
  type PartialPreview,
} from '@stockpilot/core';

import { readOrderReadinessAction } from '@/server/actions/order-readiness';
import { approveOrderPartialAction, resumeFulfillmentAction } from '@/server/actions/order-requests';
import {
  orderReadinessFacts,
  READINESS_FAILED,
  readinessOk,
  visibleItemFacts,
} from '@/test/order-readiness-facts';

import { ApprovePartialDialog } from './approve-partial-dialog';
import { ManagerActionsPanel } from './manager-actions-panel';

/**
 * APPROVE PARTIAL AND RESUME, WITH A PREVIEW (F2-3), through the REAL panel
 * and the REAL dialog; only the server actions are faked.
 *
 * Call-site pins: each test clicks the real button. Deleting the dialog's
 * opening from a button (committing on the first click, as before F2-3) makes
 * the action run at once and the test fails; deleting the re-read makes the
 * message lose its number; echoing the preview instead of the re-read ("2
 * fewer than shown" never appears) fails the stale-stock test.
 */

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

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

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
vi.mock('@/server/actions/order-readiness', () => ({ readOrderReadinessAction: vi.fn() }));

const approvePartial = vi.mocked(approveOrderPartialAction);
const resume = vi.mocked(resumeFulfillmentAction);
const reread = vi.mocked(readOrderReadinessAction);

const ORDER = '0f0f0f0f-0000-4000-8000-000000000001';
const TZ = 'America/Los_Angeles';
const OK: ActionResult<void> = { ok: true, data: undefined };

/**
 * A pending order: Maus I on two lines (25 + 15 = 40) with 36 free, and a
 * notebook (10) fully covered. approve_partial would hold 36 + 10 = 46 of 50.
 */
function pendingResult(): OrderReadinessResult {
  return readinessOk(
    orderReadinessFacts(
      ORDER,
      'pending_approval',
      [
        { lineId: 'L1', itemId: 'maus', requested: 25 },
        { lineId: 'L2', itemId: 'maus', requested: 15 },
        { lineId: 'L3', itemId: 'note', requested: 10 },
      ],
      [
        visibleItemFacts('maus', { name: 'Maus I', here: { rack: 36 } }),
        visibleItemFacts('note', { name: 'Notebook', here: { rack: 10 } }),
      ],
    ),
  );
}

/** The order after approve_partial, as readiness reads it: `heldOwn` per item. */
function approvedResult(held: { maus: number; note: number }): OrderReadinessResult {
  return readinessOk(
    orderReadinessFacts(
      ORDER,
      'approved',
      [
        { lineId: 'L1', itemId: 'maus', requested: 25 },
        { lineId: 'L2', itemId: 'maus', requested: 15 },
        { lineId: 'L3', itemId: 'note', requested: 10 },
      ],
      [
        visibleItemFacts('maus', {
          name: 'Maus I',
          here: { rack: 36 },
          heldOwn: held.maus,
          heldOtherOrders: 36 - held.maus,
        }),
        visibleItemFacts('note', { name: 'Notebook', here: { rack: 10 }, heldOwn: held.note }),
      ],
    ),
  );
}

/** A backordered order: 8 of Maus I still owed, 5 free again. */
function backorderedResult(): OrderReadinessResult {
  return readinessOk(
    orderReadinessFacts(
      ORDER,
      'backordered',
      [{ lineId: 'L1', itemId: 'maus', requested: 20, fulfilled: 12 }],
      [visibleItemFacts('maus', { name: 'Maus I', here: { rack: 5 } })],
    ),
  );
}

function resumedResult(heldOwn: number): OrderReadinessResult {
  return readinessOk(
    orderReadinessFacts(
      ORDER,
      'pick_slip_generated',
      [{ lineId: 'L1', itemId: 'maus', requested: 20, fulfilled: 12 }],
      [visibleItemFacts('maus', { name: 'Maus I', here: { rack: 5 }, heldOwn })],
    ),
  );
}

type PanelProps = React.ComponentProps<typeof ManagerActionsPanel>;

function panelProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    orderId: ORDER,
    status: 'pending_approval',
    internalNotes: null,
    neededBy: null,
    orgTimeZone: TZ,
    hasRequesterNote: false,
    fulfillmentType: 'pickup',
    assignedDeliveryUserId: null,
    signatureToken: null,
    hasSignature: false,
    signedByName: null,
    signedAt: null,
    drivers: [],
    canApprove: true,
    viewerRole: 'manager',
    viewerUserId: 'me',
    assignedPickerId: null,
    assignedPickerName: null,
    pickers: [],
    viewerCanPick: true,
    completionConfirm: null,
    departureLines: [],
    stockGates: { approvePartial: 'enabled', resume: 'waiting', notice: null, canRetry: false },
    partialPreview: previewPartialFulfilment(pendingResult(), 'approve_partial'),
    ...overrides,
  };
}

function resumeProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return panelProps({
    status: 'backordered',
    stockGates: { approvePartial: 'hidden', resume: 'enabled', notice: null, canRetry: false },
    partialPreview: previewPartialFulfilment(backorderedResult(), 'resume'),
    ...overrides,
  });
}

beforeEach(() => {
  approvePartial.mockReset();
  resume.mockReset();
  reread.mockReset();
  routerRefresh.mockReset();
  toastMock.error.mockReset();
  toastMock.success.mockReset();
  toastMock.warning.mockReset();
});

describe('Approve partial opens the preview (F2-3)', () => {
  it('opens the preview INSTEAD of approving: per item, duplicate lines combined, the backorder and the note', async () => {
    const user = userEvent.setup();
    render(<ManagerActionsPanel {...panelProps()} />);
    // The dialog is the button's popup.
    expect(screen.getByRole('button', { name: 'Approve partial' })).toHaveAttribute('aria-haspopup', 'dialog');

    await user.click(screen.getByRole('button', { name: 'Approve partial' }));

    // Mutation "delete the call" (commit on the first click): fails here.
    expect(approvePartial).not.toHaveBeenCalled();
    expect(reread).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('data-action', 'approve_partial');
    expect(within(dialog).getByRole('heading', { name: 'Approve partial' })).toBeInTheDocument();
    expect(within(dialog).getByTestId('approve-partial-summary')).toHaveTextContent(
      "Approve what's available: holds 46 of 50 units now. The other 4 ship when they arrive.",
    );
    // Per ITEM, never per line: Maus I's two lines are one row.
    const rows = within(dialog).getAllByTestId('approve-partial-item');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Maus I (2 lines)');
    expect(rows[0]).toHaveTextContent('Holds 36 of 40');
    expect(rows[1]).toHaveTextContent('Notebook');
    expect(rows[1]).toHaveTextContent('Holds 10 of 10');
    // Each row is spoken whole: what it holds and what ships later.
    expect(within(rows[0]!).getByText('Maus I (2 lines), holds 36 of 40, 4 to ship when they arrive')).toHaveClass(
      'sr-only',
    );
    expect(within(dialog).getByTestId('approve-partial-note')).toHaveTextContent(PARTIAL_PREVIEW_NOTE);
    expect(within(dialog).getByTestId('approve-partial-checked-at')).toHaveTextContent(
      'Checked at 10:42 AM. Stock can change after this.',
    );
    expect(within(dialog).getByTestId('approve-partial-confirm')).toHaveTextContent('Approve partial');
  });

  it('Confirm calls the existing action once, THEN reads readiness again, and says what was held from that read', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    approvePartial.mockImplementation(async (input) => {
      calls.push(`approve:${input.id}`);
      return OK;
    });
    reread.mockImplementation(async (input) => {
      calls.push(`reread:${input.id}`);
      return approvedResult({ maus: 36, note: 10 });
    });
    render(<ManagerActionsPanel {...panelProps()} />);

    await user.click(screen.getByRole('button', { name: 'Approve partial' }));
    // The live region is there, empty, before anything is committed.
    expect(screen.getByTestId('approve-partial-status')).toBeEmptyDOMElement();
    await user.click(within(screen.getByRole('dialog')).getByTestId('approve-partial-confirm'));

    expect(calls).toEqual([`approve:${ORDER}`, `reread:${ORDER}`]);
    expect(approvePartial).toHaveBeenCalledWith({ id: ORDER });
    const result = await screen.findByTestId('approve-partial-result');
    expect(result).toHaveTextContent('Approved. Holding 46 of 50 units.');
    // Announced: inside the live region that was there before it was filled.
    expect(result.parentElement).toHaveAttribute('role', 'status');
    expect(result.parentElement).toHaveAttribute('data-testid', 'approve-partial-status');
    // It describes the dialog now.
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-describedby', result.id);
    expect(result).toHaveAttribute('data-tone', 'success');
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    // The dialog stays until closed, so the result is read; then it closes.
    await user.click(within(screen.getByRole('dialog')).getByTestId('approve-partial-close'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stock changed after the preview: the message is the RE-READ, with the difference, never the preview echoed', async () => {
    const user = userEvent.setup();
    approvePartial.mockResolvedValue(OK);
    // Another session held 2 of Maus I between the preview and the commit.
    reread.mockResolvedValue(approvedResult({ maus: 34, note: 10 }));
    render(<ManagerActionsPanel {...panelProps()} />);

    await user.click(screen.getByRole('button', { name: 'Approve partial' }));
    await user.click(within(screen.getByRole('dialog')).getByTestId('approve-partial-confirm'));

    const result = await screen.findByTestId('approve-partial-result');
    expect(result).toHaveTextContent(
      'Approved. Holding 44 of 50 units, 2 fewer than shown because stock changed after you looked.',
    );
    expect(result).toHaveAttribute('data-tone', 'warning');
  });

  it('a re-read that fails claims no number', async () => {
    const user = userEvent.setup();
    approvePartial.mockResolvedValue(OK);
    reread.mockResolvedValue(READINESS_FAILED);
    render(<ManagerActionsPanel {...panelProps()} />);

    await user.click(screen.getByRole('button', { name: 'Approve partial' }));
    await user.click(within(screen.getByRole('dialog')).getByTestId('approve-partial-confirm'));

    const result = await screen.findByTestId('approve-partial-result');
    expect(result).toHaveTextContent("Approved. What is held now couldn't be checked. Check again on the order.");
    expect(result.textContent).not.toMatch(/\d/);
  });

  it('a re-read that never answers claims no number either', async () => {
    const user = userEvent.setup();
    approvePartial.mockResolvedValue(OK);
    reread.mockRejectedValue(new Error('network'));
    render(<ManagerActionsPanel {...panelProps()} />);

    await user.click(screen.getByRole('button', { name: 'Approve partial' }));
    await user.click(within(screen.getByRole('dialog')).getByTestId('approve-partial-confirm'));

    expect(await screen.findByTestId('approve-partial-result')).toHaveTextContent(
      "Approved. What is held now couldn't be checked. Check again on the order.",
    );
  });

  it('a refusal stays in the dialog as an alert (pattern #20), announced once, reads nothing again, and refreshes the order behind', async () => {
    const user = userEvent.setup();
    approvePartial.mockResolvedValueOnce({
      ok: false,
      error: { code: 'validation_error', message: 'No stock is available yet.' },
    });
    render(<ManagerActionsPanel {...panelProps()} />);

    await user.click(screen.getByRole('button', { name: 'Approve partial' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByTestId('approve-partial-confirm'));

    const alert = await within(dialog).findByTestId('approve-partial-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('No stock is available yet.');
    // The inline alert is the one announcement: no toast beside it.
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(reread).not.toHaveBeenCalled();
    // The order behind the dialog is read again, so it shows where it is now.
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('approve-partial-result')).toBeNull();
    // Still open, the preview still shown, and the order still pending:
    // Confirm available again.
    expect(within(dialog).getByTestId('approve-partial-summary')).toBeInTheDocument();
    expect(within(dialog).getByTestId('approve-partial-confirm')).toBeEnabled();
  });

  it('refused because the order moved on: once the refresh shows it, Close replaces Confirm', async () => {
    const user = userEvent.setup();
    approvePartial.mockResolvedValueOnce({
      ok: false,
      error: { code: 'validation_error', message: 'This request is no longer pending approval' },
    });
    const { rerender } = render(<ManagerActionsPanel {...panelProps()} />);

    await user.click(screen.getByRole('button', { name: 'Approve partial' }));
    await user.click(within(screen.getByRole('dialog')).getByTestId('approve-partial-confirm'));
    await screen.findByTestId('approve-partial-error');
    expect(routerRefresh).toHaveBeenCalledTimes(1);

    // The refresh lands: another approver had approved it.
    rerender(
      <ManagerActionsPanel
        {...panelProps({
          status: 'approved',
          partialPreview: null,
          stockGates: { approvePartial: 'hidden', resume: 'waiting', notice: null, canRetry: false },
        })}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByTestId('approve-partial-confirm')).toBeNull();
    expect(within(dialog).getByTestId('approve-partial-close')).toBeEnabled();
    // The server's sentence already says why; core's is not added to it.
    expect(within(dialog).getByTestId('approve-partial-error')).toHaveTextContent('This request is no longer pending approval');
    expect(within(dialog).queryByTestId('approve-partial-moved-on')).toBeNull();
    await user.click(within(dialog).getByTestId('approve-partial-close'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(approvePartial).toHaveBeenCalledTimes(1);
  });

  it('the order moved on while the preview was open (no confirm yet): says so, and offers only Close', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ManagerActionsPanel {...panelProps()} />);
    await user.click(screen.getByRole('button', { name: 'Approve partial' }));
    rerender(<ManagerActionsPanel {...panelProps({ status: 'approved', partialPreview: null })} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('approve-partial-moved-on')).toHaveTextContent(
      'This order is no longer waiting for approval.',
    );
    expect(within(dialog).queryByTestId('approve-partial-confirm')).toBeNull();
    expect(within(dialog).getByTestId('approve-partial-close')).toBeInTheDocument();
    expect(approvePartial).not.toHaveBeenCalled();
  });

  it("a server error shows core's sentence, never the database's text", async () => {
    const user = userEvent.setup();
    approvePartial.mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal_error', message: 'canceling statement due to lock timeout' },
    });
    render(<ManagerActionsPanel {...panelProps()} />);
    await user.click(screen.getByRole('button', { name: 'Approve partial' }));
    await user.click(within(screen.getByRole('dialog')).getByTestId('approve-partial-confirm'));
    const alert = await screen.findByTestId('approve-partial-error');
    expect(alert).toHaveTextContent('The order could not be updated. Try again.');
    expect(alert).not.toHaveTextContent(/lock timeout/);
  });

  it('an action that never answers says to check the order, and stays open', async () => {
    const user = userEvent.setup();
    approvePartial.mockRejectedValueOnce(new Error('fetch failed'));
    render(<ManagerActionsPanel {...panelProps()} />);

    await user.click(screen.getByRole('button', { name: 'Approve partial' }));
    await user.click(within(screen.getByRole('dialog')).getByTestId('approve-partial-confirm'));

    expect(await screen.findByTestId('approve-partial-error')).toHaveTextContent(
      "The request didn't finish. Check the order before trying again.",
    );
    expect(reread).not.toHaveBeenCalled();
    // Whether it went through is unknown: the order behind is read again.
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('Cancel commits nothing', async () => {
    const user = userEvent.setup();
    render(<ManagerActionsPanel {...panelProps()} />);

    await user.click(screen.getByRole('button', { name: 'Approve partial' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(approvePartial).not.toHaveBeenCalled();
    expect(reread).not.toHaveBeenCalled();
  });

  it('cannot be dismissed while the commit is in flight', async () => {
    const user = userEvent.setup();
    let finish!: (r: ActionResult<void>) => void;
    approvePartial.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    reread.mockResolvedValue(approvedResult({ maus: 36, note: 10 }));
    render(<ManagerActionsPanel {...panelProps()} />);

    await user.click(screen.getByRole('button', { name: 'Approve partial' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByTestId('approve-partial-confirm'));
    expect(within(dialog).getByTestId('approve-partial-confirm')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    finish(OK);
    expect(await screen.findByTestId('approve-partial-result')).toHaveTextContent('Approved. Holding 46 of 50 units.');
  });

  it('the result survives the page moving on: the preview was snapshot when the dialog opened', async () => {
    const user = userEvent.setup();
    approvePartial.mockResolvedValue(OK);
    let answer!: (r: OrderReadinessResult) => void;
    reread.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { rerender } = render(<ManagerActionsPanel {...panelProps()} />);

    await user.click(screen.getByRole('button', { name: 'Approve partial' }));
    await user.click(within(screen.getByRole('dialog')).getByTestId('approve-partial-confirm'));
    // The commit revalidated the page: the order is approved now, and the
    // page passes no preview any more.
    rerender(
      <ManagerActionsPanel
        {...panelProps({
          status: 'approved',
          partialPreview: null,
          stockGates: { approvePartial: 'hidden', resume: 'waiting', notice: null, canRetry: false },
        })}
      />,
    );
    // Still the preview it was opened with, still in flight: nothing to close.
    expect(screen.getByTestId('approve-partial-summary')).toHaveTextContent(
      "Approve what's available: holds 46 of 50 units now. The other 4 ship when they arrive.",
    );
    expect(screen.getByTestId('approve-partial-confirm')).toBeDisabled();
    expect(screen.queryByTestId('approve-partial-close')).toBeNull();
    answer(approvedResult({ maus: 34, note: 10 }));

    expect(await screen.findByTestId('approve-partial-result')).toHaveTextContent(
      'Approved. Holding 44 of 50 units, 2 fewer than shown because stock changed after you looked.',
    );
  });

  it('each opening starts afresh: a new preview, never the last result', async () => {
    const user = userEvent.setup();
    approvePartial.mockResolvedValue(OK);
    reread.mockResolvedValue(approvedResult({ maus: 36, note: 10 }));
    const { rerender } = render(<ManagerActionsPanel {...panelProps()} />);

    await user.click(screen.getByRole('button', { name: 'Approve partial' }));
    await user.click(within(screen.getByRole('dialog')).getByTestId('approve-partial-confirm'));
    await screen.findByTestId('approve-partial-result');
    await user.click(within(screen.getByRole('dialog')).getByTestId('approve-partial-close'));

    // (A second pending order on the same panel, say after a refresh.)
    rerender(<ManagerActionsPanel {...panelProps()} />);
    await user.click(screen.getByRole('button', { name: 'Approve partial' }));
    expect(screen.queryByTestId('approve-partial-result')).toBeNull();
    expect(screen.getByTestId('approve-partial-summary')).toBeInTheDocument();
  });
});

describe('Resume fulfillment opens the preview (F2-3)', () => {
  it('opens the preview INSTEAD of resuming: what is still owed, what is free now', async () => {
    const user = userEvent.setup();
    render(<ManagerActionsPanel {...resumeProps()} />);

    await user.click(screen.getByRole('button', { name: 'Resume fulfillment' }));

    // Mutation "delete the call": resuming on the first click fails here.
    expect(resume).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('data-action', 'resume');
    expect(within(dialog).getByTestId('approve-partial-summary')).toHaveTextContent(
      "Resume what's available: holds 5 of 8 units now. The other 3 ship when they arrive.",
    );
    expect(within(dialog).getAllByTestId('approve-partial-item')).toHaveLength(1);
    expect(within(dialog).getByTestId('approve-partial-item')).toHaveTextContent('Holds 5 of 8');
  });

  it('Confirm calls the existing resume, then reads again: "Resumed. A new pick slip is ready." with what is held', async () => {
    const user = userEvent.setup();
    resume.mockResolvedValue(OK);
    reread.mockResolvedValue(resumedResult(4));
    render(<ManagerActionsPanel {...resumeProps()} />);

    await user.click(screen.getByRole('button', { name: 'Resume fulfillment' }));
    await user.click(within(screen.getByRole('dialog')).getByTestId('approve-partial-confirm'));

    expect(resume).toHaveBeenCalledWith({ id: ORDER });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(approvePartial).not.toHaveBeenCalled();
    expect(reread).toHaveBeenCalledWith({ id: ORDER });
    expect(await screen.findByTestId('approve-partial-result')).toHaveTextContent(
      'Resumed. A new pick slip is ready. Holding 4 of 8 units, 1 fewer than shown because stock changed after you looked.',
    );
  });
});

describe('ApprovePartialDialog: a preview that cannot be shown', () => {
  it("says why in core's words and offers no confirm", () => {
    const moved: PartialPreview = {
      state: 'unavailable',
      action: 'approve_partial',
      reason: 'item_moved',
      message: PARTIAL_PREVIEW_ITEM_MOVED_COPY,
    };
    render(
      <ApprovePartialDialog
        orderId={ORDER}
        orderStatus="pending_approval"
        preview={moved}
        timeZone={TZ}
        open
        onOpenChange={() => {}}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Approve partial' })).toBeInTheDocument();
    expect(within(dialog).getByTestId('approve-partial-unavailable')).toHaveTextContent(PARTIAL_PREVIEW_ITEM_MOVED_COPY);
    expect(within(dialog).queryByTestId('approve-partial-confirm')).toBeNull();
    expect(within(dialog).queryByTestId('approve-partial-items')).toBeNull();
  });

  it("Resume never opens with Approve partial's preview (a preview for the other action is no preview)", async () => {
    const user = userEvent.setup();
    render(
      <ManagerActionsPanel
        {...resumeProps({ partialPreview: previewPartialFulfilment(pendingResult(), 'approve_partial') })}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Resume fulfillment' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('data-action', 'resume');
    expect(within(dialog).getByRole('heading', { name: 'Resume fulfillment' })).toBeInTheDocument();
    expect(within(dialog).getByTestId('approve-partial-unavailable')).toHaveTextContent(
      "Stock couldn't be checked, so what would be held can't be shown. Try again.",
    );
    expect(within(dialog).queryByTestId('approve-partial-confirm')).toBeNull();
  });

  it('the panel opens it with "stock could not be checked" when the page passed no preview for that action', async () => {
    const user = userEvent.setup();
    render(<ManagerActionsPanel {...panelProps({ partialPreview: null })} />);

    await user.click(screen.getByRole('button', { name: 'Approve partial' }));

    expect(approvePartial).not.toHaveBeenCalled();
    expect(screen.getByTestId('approve-partial-unavailable')).toHaveTextContent(
      "Stock couldn't be checked, so what would be held can't be shown. Try again.",
    );
    expect(screen.queryByTestId('approve-partial-confirm')).toBeNull();
  });

  it("the words never name the recorded quantity with the accounting jargon, and carry no percentage", async () => {
    const user = userEvent.setup();
    approvePartial.mockResolvedValue(OK);
    reread.mockResolvedValue(approvedResult({ maus: 34, note: 10 }));
    render(<ManagerActionsPanel {...panelProps()} />);

    await user.click(screen.getByRole('button', { name: 'Approve partial' }));
    const before = screen.getByRole('dialog').textContent ?? '';
    await user.click(within(screen.getByRole('dialog')).getByTestId('approve-partial-confirm'));
    await screen.findByTestId('approve-partial-result');
    const after = screen.getByRole('dialog').textContent ?? '';
    for (const text of [before, after]) {
      expect(text).not.toMatch(/\bbook\b|%|guarantee|verified/i);
    }
  });
});
