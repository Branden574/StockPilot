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
 *   - Add note needs text.
 */

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const actOnExceptionAction = vi.fn();
vi.mock('@/server/actions/exceptions', () => ({
  actOnExceptionAction: (...args: unknown[]) => actOnExceptionAction(...args),
}));

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

  it('refuses a note over 1,000 characters before sending it', () => {
    render(<OccurrenceActions occurrenceId={ID} acknowledged={false} />);
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'x'.repeat(1001) } });
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeDisabled();
  });
});
