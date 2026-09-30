// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Acknowledge and Add note (F1-1). The page renders this only for a reader
 * the server says may act; these tests pin what the form itself sends and how
 * it fails:
 *   - Acknowledge sends the optional note and a client event id;
 *   - a failed submission shows inline (role="alert", pattern #20) and a
 *     retry of the SAME action and note reuses its client event id, so a
 *     request whose answer was lost is a replay, not a second note;
 *   - a retry with a different note or action is a NEW request with a new
 *     id, so an edited note is never dropped as a "replay";
 *   - a successful submission refreshes the page and mints a new id;
 *   - Add note needs text;
 *   - on a count difference whose page offers Confirm (count differences
 *     R2), Confirm this count instead opens the confirm dialog with the note
 *     typed here; nowhere else.
 */

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const actOnExceptionAction = vi.fn();
const confirmExceptionCountAction = vi.fn();
vi.mock('@/server/actions/exceptions', () => ({
  actOnExceptionAction: (...args: unknown[]) => actOnExceptionAction(...args),
  confirmExceptionCountAction: (...args: unknown[]) => confirmExceptionCountAction(...args),
}));

import type { CountConfirmBlock } from '@stockpilot/core';

import { ConfirmCountProvider } from './confirm-count-dialog';
import { OccurrenceActions } from './occurrence-actions';

const ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
});

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

describe('OccurrenceActions', () => {
  it('acknowledges with the optional note and a client event id, then refreshes', async () => {
    actOnExceptionAction.mockResolvedValue({ ok: true });
    render(<OccurrenceActions occurrenceId={ID} acknowledged={false} />);
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: '  checking rack  ' } });
    await click('Acknowledge');
    expect(actOnExceptionAction).toHaveBeenCalledWith(ID, {
      action: 'acknowledge',
      note: 'checking rack',
      clientEventId: expect.any(String),
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a failure shows inline, and the retry reuses the same client event id', async () => {
    actOnExceptionAction.mockResolvedValueOnce({ error: { message: 'Could not save.', reason: null } });
    render(<OccurrenceActions occurrenceId={ID} acknowledged={false} />);
    await click('Acknowledge');
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save.');
    expect(refresh).not.toHaveBeenCalled();

    actOnExceptionAction.mockResolvedValueOnce({ ok: true });
    await click('Acknowledge');
    const first = actOnExceptionAction.mock.calls[0]![1].clientEventId;
    const second = actOnExceptionAction.mock.calls[1]![1].clientEventId;
    expect(second).toBe(first);
  });

  it('after a failure, an EDITED note (or another action) is a new request with a new id', async () => {
    // The first Acknowledge committed but its answer was lost. The reader
    // types a note and presses Acknowledge again: that must not be sent as
    // a replay of the note-less request, or the server answers "ok" and the
    // note is never stored. Mutation caught: one id for every attempt.
    actOnExceptionAction.mockResolvedValueOnce({ error: { message: 'Something went wrong.', reason: null } });
    render(<OccurrenceActions occurrenceId={ID} acknowledged={false} />);
    await click('Acknowledge');
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'checking rack 17' } });
    actOnExceptionAction.mockResolvedValueOnce({ error: { message: 'Something went wrong.', reason: null } });
    await click('Acknowledge');
    actOnExceptionAction.mockResolvedValueOnce({ ok: true });
    await click('Add note');
    const ids = actOnExceptionAction.mock.calls.map((c) => (c[1] as { clientEventId: string }).clientEventId);
    expect(new Set(ids).size).toBe(3);
    expect(actOnExceptionAction.mock.calls[1]![1]).toMatchObject({ action: 'acknowledge', note: 'checking rack 17' });
  });

  it('a conflict answer drops the id, so pressing again sends a fresh request', async () => {
    actOnExceptionAction.mockResolvedValueOnce({
      error: { message: 'This could not be saved as sent. Please try again.', reason: 'client_event_id_conflict' },
    });
    render(<OccurrenceActions occurrenceId={ID} acknowledged={false} />);
    await click('Acknowledge');
    expect(screen.getByRole('alert')).toHaveTextContent('This could not be saved as sent. Please try again.');
    actOnExceptionAction.mockResolvedValueOnce({ ok: true });
    await click('Acknowledge');
    const [a, b] = actOnExceptionAction.mock.calls.map((c) => (c[1] as { clientEventId: string }).clientEventId);
    expect(b).not.toBe(a);
  });

  it('after a success the next submission gets a new client event id', async () => {
    actOnExceptionAction.mockResolvedValue({ ok: true });
    render(<OccurrenceActions occurrenceId={ID} acknowledged />);
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'one' } });
    await click('Add note');
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'two' } });
    await click('Add note');
    const a = actOnExceptionAction.mock.calls[0]![1].clientEventId;
    const b = actOnExceptionAction.mock.calls[1]![1].clientEventId;
    expect(a).not.toBe(b);
  });

  it('Add note needs text, and an acknowledged row offers only Add note', () => {
    render(<OccurrenceActions occurrenceId={ID} acknowledged />);
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: 'Add note' })).toBeEnabled();
  });

  // ── Count differences R2: Confirm this count instead ──────────────────

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
    postedBy: { id: 'u-dana', label: 'Dana Lee' },
    readerIsCounter: true,
    otherCount: null,
  };

  function onPage(ui: React.ReactElement, offered: boolean) {
    return render(
      <ConfirmCountProvider
        occurrenceId={ID}
        reference="EX-000059"
        confirm={BLOCK}
        offered={offered}
        recountAbility="can"
        recountNumber={null}
      >
        {ui}
      </ConfirmCountProvider>,
    );
  }

  it('on a count difference the page offers Confirm for, Confirm this count instead carries the typed note into the dialog', async () => {
    confirmExceptionCountAction.mockResolvedValue({ ok: true, replay: false, reference: 'EX-000059' });
    onPage(<OccurrenceActions occurrenceId={ID} acknowledged={false} rule="count_variance" ackHelp="help" />, true);
    fireEvent.change(screen.getByLabelText(/Note \(optional when acknowledging\)/), {
      target: { value: 'Items recounted' },
    });
    await click('Confirm this count instead');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('Items recounted');
    // It confirms; it never acknowledges.
    await click('Confirm and close');
    expect(confirmExceptionCountAction).toHaveBeenCalledWith(ID, {
      cycleCountId: CC,
      countedQuantity: 2,
      note: 'Items recounted',
    });
    expect(actOnExceptionAction).not.toHaveBeenCalled();
  });

  it('is not offered where the page does not offer Confirm, on another rule, or once acknowledged', () => {
    const { unmount } = onPage(
      <OccurrenceActions occurrenceId={ID} acknowledged={false} rule="count_variance" ackHelp="help" />,
      false,
    );
    expect(screen.queryByRole('button', { name: 'Confirm this count instead' })).not.toBeInTheDocument();
    unmount();
    const other = onPage(<OccurrenceActions occurrenceId={ID} acknowledged={false} rule="over_reserved" />, true);
    expect(screen.queryByRole('button', { name: 'Confirm this count instead' })).not.toBeInTheDocument();
    other.unmount();
    onPage(<OccurrenceActions occurrenceId={ID} acknowledged rule="count_variance" ackHelp="help" />, true);
    expect(screen.queryByRole('button', { name: 'Confirm this count instead' })).not.toBeInTheDocument();
  });

  it('refuses a note over 1,000 characters before sending it', () => {
    render(<OccurrenceActions occurrenceId={ID} acknowledged={false} />);
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'x'.repeat(1001) } });
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeDisabled();
  });
});
