// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CountConfirmBlock, RecountAbility } from '@stockpilot/core';

/**
 * Confirm this count on the web (count differences R2, 0386). What the dialog
 * must get right:
 *   - it shows the numbers the server sent and sends back exactly the count
 *     and the counted number it showed (a count posted in between is then
 *     refused as count_changed, never confirmed unseen), with the trimmed
 *     note or none;
 *   - pressed twice while sending, it sends once, and it cannot be closed
 *     while a send is in flight;
 *   - a refusal shows inline with role="alert" (pattern #20), in core's words
 *     by `reason`, never by message text; a refusal of the reader or of the
 *     request keeps the action's own words;
 *   - no answer keeps the payload, so pressing again resends the same one
 *     (the server answers a replay of a confirm that landed);
 *   - on success it closes, says "Count confirmed. EX-... is closed." in a
 *     role="status" line that survives the refresh, moves focus there, and
 *     refreshes the page;
 *   - focus starts on the note, never on Confirm and close; Cancel sends
 *     nothing and returns focus to the button that opened it;
 *   - Confirm this count instead carries the note typed in the Acknowledge
 *     step; nothing is offered where the page says Confirm is not.
 */

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const confirmExceptionCountAction = vi.fn();
vi.mock('@/server/actions/exceptions', () => ({
  confirmExceptionCountAction: (...args: unknown[]) => confirmExceptionCountAction(...args),
}));

import {
  ConfirmCountButton,
  ConfirmCountInsteadButton,
  ConfirmCountProvider,
  ConfirmCountStatus,
} from './confirm-count-dialog';

const OCC = '11111111-1111-4111-8111-111111111111';
const CC = '33333333-3333-4333-8333-333333333333';

const BLOCK: CountConfirmBlock = {
  state: 'confirmable',
  canConfirm: true,
  unavailableReason: null,
  cycleCountId: CC,
  countNumber: 35,
  counted: 2,
  onRecordBefore: 100,
  onRecordNow: 2,
  countedBy: { id: 'u-dana', label: 'Dana Lee' },
  postedBy: { id: 'u-sam', label: 'Sam Ortiz' },
  readerIsCounter: true,
  otherCount: null,
};

function Harness({
  offered = true,
  confirm = BLOCK,
  recountAbility = 'can',
  recountNumber = null,
  insteadNote,
}: {
  offered?: boolean;
  confirm?: CountConfirmBlock | null;
  recountAbility?: RecountAbility;
  recountNumber?: number | null;
  insteadNote?: string;
}) {
  return (
    <ConfirmCountProvider
      occurrenceId={OCC}
      reference="EX-000059"
      confirm={confirm}
      offered={offered}
      recountAbility={recountAbility}
      recountNumber={recountNumber}
    >
      <ConfirmCountStatus />
      <ConfirmCountButton />
      {insteadNote !== undefined ? <ConfirmCountInsteadButton note={insteadNote} /> : null}
    </ConfirmCountProvider>
  );
}

async function openDialog(props: React.ComponentProps<typeof Harness> = {}) {
  render(<Harness {...props} />);
  const opener = screen.getByRole('button', { name: 'Confirm this count' });
  opener.focus();
  await act(async () => {
    fireEvent.click(opener);
  });
  return { dialog: screen.getByRole('dialog'), opener };
}

async function press(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

function typeNote(value: string) {
  fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value } });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Confirm this count (web dialog)', () => {
  it('shows the numbers the server sent, the consequence, the note and the buttons, with focus on the note', async () => {
    const { dialog } = await openDialog();
    expect(within(dialog).getByRole('heading', { name: 'Confirm this count?' })).toBeInTheDocument();
    const numbers = within(dialog).getByTestId('confirm-count-numbers');
    expect(within(numbers).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Counted in CC-000035: 2',
      'On record before the count: 100',
      'On record now: 2',
    ]);
    expect(numbers).toHaveTextContent('Counted by Dana Lee, posted by Sam Ortiz.');
    // The numbers and the consequence are the dialog's description: a screen
    // reader says what is being confirmed as it opens.
    const consequence =
      'Confirming records that 2 is right. It closes EX-000059 now, without a second count. If a later count does not match the stock on record, a new exception opens.';
    expect(within(dialog).getByText(consequence)).toBeInTheDocument();
    const description = within(dialog).getByTestId('confirm-count-description');
    expect(description).toContainElement(numbers);
    expect(description).toContainElement(within(dialog).getByText(consequence));
    expect(dialog).toHaveAttribute('aria-describedby', description.id);
    expect(description.id).not.toBe('');
    const note = within(dialog).getByLabelText('Note (optional)');
    expect(note).toHaveAttribute('placeholder', 'How you checked, for example counted twice on the floor');
    expect(within(dialog).getByText('0 / 1,000')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Confirm and close' })).toBeEnabled();
    // Focus starts on the note, never on Confirm and close.
    await waitFor(() => expect(document.activeElement).toBe(note));
    expect(confirmExceptionCountAction).not.toHaveBeenCalled();
  });

  // Mutation caught: the payload built from the typed note only (no count),
  // or from the row's facts instead of the block the dialog showed.
  it('sends exactly the count and the number it showed, with the trimmed note, then closes, says so and refreshes', async () => {
    confirmExceptionCountAction.mockResolvedValue({ ok: true, replay: false, reference: 'EX-000059' });
    await openDialog();
    typeNote('  counted twice on the floor  ');
    await press('Confirm and close');
    expect(confirmExceptionCountAction).toHaveBeenCalledTimes(1);
    expect(confirmExceptionCountAction).toHaveBeenCalledWith(OCC, {
      cycleCountId: CC,
      countedQuantity: 2,
      note: 'counted twice on the floor',
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/^Count confirmed\. EX-000059 is closed\.$/);
    expect(refresh).toHaveBeenCalledTimes(1);
    // The button that opened it goes with the resolved row: focus lands on
    // the success line.
    await waitFor(() => expect(document.activeElement).toBe(status));
  });

  it('a blank note is sent as none', async () => {
    confirmExceptionCountAction.mockResolvedValue({ ok: true, replay: false, reference: 'EX-000059' });
    await openDialog();
    typeNote('   ');
    await press('Confirm and close');
    expect(confirmExceptionCountAction).toHaveBeenCalledWith(OCC, { cycleCountId: CC, countedQuantity: 2, note: null });
  });

  // Mutation caught: the in-flight guard on `pending` state alone (two clicks
  // before the re-render both send).
  it('pressed twice while sending, it sends once, says Confirming..., and cannot be closed until it answers', async () => {
    const answer = deferred<unknown>();
    confirmExceptionCountAction.mockReturnValue(answer.promise);
    const { dialog } = await openDialog();
    const confirm = within(dialog).getByRole('button', { name: 'Confirm and close' });
    await act(async () => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(confirmExceptionCountAction).toHaveBeenCalledTimes(1);
    const busy = within(dialog).getByRole('button', { name: 'Confirming...' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(within(dialog).getByLabelText('Note (optional)')).toBeDisabled();
    // Escape and the close button do not close it while the send is in flight.
    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });
    await press('Close');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => {
      answer.resolve({ ok: true, replay: false, reference: 'EX-000059' });
    });
    expect(confirmExceptionCountAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Count confirmed. EX-000059 is closed.');
  });

  it.each([
    [
      'stock_moved',
      {},
      'The stock on record changed after this count, so it can no longer be confirmed. Count it once more with Recount.',
    ],
    [
      'stock_moved',
      { recountAbility: 'not_permitted' as const },
      'The stock on record changed after this count, so it can no longer be confirmed. Ask a manager who can assign counts for a recount.',
    ],
    ['count_changed', {}, 'A newer count of this item was posted. Refresh to see its numbers before confirming.'],
    ['occurrence_resolved', {}, 'This exception has already been resolved. Refresh to see how.'],
    [
      'recount_in_progress',
      { recountNumber: 40 },
      'Confirm this count is not offered while recount CC-000040 is in progress. Its result will settle this, or a manager can cancel it.',
    ],
    [
      'count_in_progress',
      {},
      'Another count in progress has recorded a different number for this item. This exception shows its numbers when that count is posted.',
    ],
    [
      'already_confirmed',
      {},
      'This count was already confirmed on an earlier exception, so it cannot be confirmed again. Count it once more with Recount.',
    ],
    ['not_countable', {}, 'This item can no longer be counted, so this exception closes at the next check.'],
    ['not_counter', {}, 'Only Dana Lee, who counted it, or a manager can confirm this count.'],
    ['busy', {}, 'A check is running. Try again in a moment.'],
    ['unavailable', {}, 'Confirming is unavailable right now. Reload to try again.'],
    ['unknown', {}, 'This count could not be confirmed. Refresh and try again.'],
    // A reason a later server adds still reads sensibly.
    ['some_future_reason', {}, 'This count could not be confirmed. Refresh and try again.'],
  ])('a %s refusal shows inline in core\'s words, and the dialog stays open', async (reason, props, words) => {
    confirmExceptionCountAction.mockResolvedValue({
      error: { message: 'server words that must not be shown', reason },
    });
    const { dialog } = await openDialog(props);
    await press('Confirm and close');
    expect(within(dialog).getByRole('alert')).toHaveTextContent(new RegExp(`^${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByTestId('confirm-count-status')).toHaveTextContent(/^$/);
  });

  it.each([
    ['not_permitted', 'You do not have permission to confirm this count.'],
    ['rate_limited', 'Too many requests. Wait a moment and try again.'],
    ['note_too_long', 'Notes can be at most 1,000 characters.'],
    [null, 'You do not have write access to this warehouse.'],
    [null, 'Something went wrong. Please try again.'],
  ])('a refusal of the reader or the request (%s) keeps the action\'s words', async (reason, message) => {
    confirmExceptionCountAction.mockResolvedValue({ error: { message, reason } });
    const { dialog } = await openDialog();
    await press('Confirm and close');
    expect(within(dialog).getByRole('alert')).toHaveTextContent(message);
  });

  // Mutation caught: the note cleared, or the count dropped, after a failure
  // (the resend would then not be a replay of a confirm that landed).
  it('no answer: says so, keeps the payload, and pressing again resends the same one', async () => {
    confirmExceptionCountAction
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({ ok: true, replay: true, reference: 'EX-000059' });
    const { dialog } = await openDialog();
    typeNote('counted twice');
    await press('Confirm and close');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Could not reach the server. Try again.');
    expect(within(dialog).getByLabelText('Note (optional)')).toHaveValue('counted twice');
    await press('Confirm and close');
    expect(confirmExceptionCountAction).toHaveBeenCalledTimes(2);
    expect(confirmExceptionCountAction.mock.calls[1]).toEqual(confirmExceptionCountAction.mock.calls[0]);
    expect(screen.getByRole('status')).toHaveTextContent('Count confirmed. EX-000059 is closed.');
  });

  it('Cancel sends nothing and returns focus to the button that opened it', async () => {
    const { opener } = await openDialog();
    await press('Cancel');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(confirmExceptionCountAction).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(screen.getByTestId('confirm-count-status')).toHaveTextContent(/^$/);
  });

  it('refuses a note over 1,000 characters before sending it', async () => {
    const { dialog } = await openDialog();
    typeNote('x'.repeat(1001));
    expect(within(dialog).getByText('1,001 / 1,000')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Note (optional)')).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByRole('button', { name: 'Confirm and close' })).toBeDisabled();
    await press('Confirm and close');
    expect(confirmExceptionCountAction).not.toHaveBeenCalled();
  });

  it('Confirm this count instead opens the same dialog with the note typed in the Acknowledge step', async () => {
    confirmExceptionCountAction.mockResolvedValue({ ok: true, replay: false, reference: 'EX-000059' });
    render(<Harness insteadNote="Items recounted" />);
    await press('Confirm this count instead');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Note (optional)')).toHaveValue('Items recounted');
    await press('Confirm and close');
    expect(confirmExceptionCountAction).toHaveBeenCalledWith(OCC, {
      cycleCountId: CC,
      countedQuantity: 2,
      note: 'Items recounted',
    });
  });

  it('nothing is offered where the page says Confirm is not, or with no block from the server', () => {
    const { unmount } = render(<Harness offered={false} insteadNote="x" />);
    expect(screen.queryByRole('button', { name: 'Confirm this count' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm this count instead' })).not.toBeInTheDocument();
    unmount();
    render(<Harness confirm={null} insteadNote="x" />);
    expect(screen.queryByRole('button', { name: 'Confirm this count' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm this count instead' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('outside a page that offers it, the buttons render nothing', () => {
    render(
      <>
        <ConfirmCountButton />
        <ConfirmCountInsteadButton note="x" />
        <ConfirmCountStatus />
      </>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
