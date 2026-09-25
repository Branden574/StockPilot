// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The recount dialog (F1-2). What it must get right:
 *   - it says what a count covers, and loads "Assign to" from the shared
 *     member source when it opens; a failed member read says so and still
 *     lets the recount start unassigned;
 *   - ONE COUNT PER SELECTION: the idempotency key is minted once for a
 *     selection and resent on every retry of it (a lost answer, a retryable
 *     refusal), and dropped when the server says it stands for another
 *     selection;
 *   - failures show inline with role="alert", with Try again when retrying is
 *     safe;
 *   - the result panel has the three groups (Started, Already being counted,
 *     Skipped) and says when assigning failed.
 */

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
const startRecountAction = vi.fn();
const listCountAssigneesAction = vi.fn();
vi.mock('@/server/actions/exceptions', () => ({
  startRecountAction: (...args: unknown[]) => startRecountAction(...args),
  listCountAssigneesAction: (...args: unknown[]) => listCountAssigneesAction(...args),
}));

import { RecountDialog } from './recount-dialog';

const OCC = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';

function result(o: Record<string, unknown> = {}) {
  return {
    cycleCountId: 'cc-new',
    countNumber: 2,
    reference: 'CC-000002',
    lineCount: 1,
    created: true,
    replay: false,
    assignedTo: null,
    assignmentFailed: false,
    notes: 'Recount: Atlas',
    linked: [OCC],
    linkedExisting: [],
    skipped: [],
    ...o,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listCountAssigneesAction.mockResolvedValue({
    ok: true,
    members: [
      { id: 'u-ana', name: 'Ana' },
      { id: 'u-ben', name: 'Ben' },
    ],
  });
});

async function renderDialog(props: Partial<React.ComponentProps<typeof RecountDialog>> = {}) {
  const onOpenChange = vi.fn();
  const onFinished = vi.fn();
  await act(async () => {
    render(
      <RecountDialog
        open
        onOpenChange={onOpenChange}
        title="Recount 1 exception"
        occurrenceIds={[OCC]}
        timeZone="America/Los_Angeles"
        onFinished={onFinished}
        {...props}
      />,
    );
  });
  return { onOpenChange, onFinished };
}

async function press(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

describe('RecountDialog', () => {
  it('says what a count covers and offers the org members from the shared source', async () => {
    await renderDialog();
    expect(screen.getByText('Counts record each item’s total, wherever it is stored.')).toBeInTheDocument();
    expect(listCountAssigneesAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText('The assignee gets a notification to start the count.')).toBeInTheDocument();
  });

  it('starts one recount with the selection, unassigned by default, and a key', async () => {
    startRecountAction.mockResolvedValue({ ok: true, result: result() });
    await renderDialog({ itemIds: [ITEM] });
    await press('Start recount');
    expect(startRecountAction).toHaveBeenCalledWith({
      occurrenceIds: [OCC],
      itemIds: [ITEM],
      assignedTo: null,
      idempotencyKey: expect.any(String),
    });
    expect(refresh).toHaveBeenCalled();
  });

  // Mutation caught: a new key minted on every press (a retry after a lost
  // answer would start a second count).
  it('a retryable refusal offers Try again and resends the SAME key', async () => {
    startRecountAction
      .mockResolvedValueOnce({
        error: { message: 'Another recount or check is working on these items right now. Try again in a moment.', reason: 'recount_busy', retryable: true },
      })
      .mockResolvedValueOnce({ ok: true, result: result() });
    await renderDialog();
    await press('Start recount');
    expect(screen.getByRole('alert')).toHaveTextContent('Another recount or check is working');
    await press('Try again');
    const [first, second] = startRecountAction.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(screen.getByTestId('recount-started')).toHaveTextContent('Started CC-000002 (1 item)');
  });

  it('drops the key the server says belongs to another selection', async () => {
    startRecountAction
      .mockResolvedValueOnce({
        error: { message: 'This recount request was already used for a different selection. Refresh and try again.', reason: 'idempotency_conflict' },
      })
      .mockResolvedValueOnce({ ok: true, result: result() });
    await renderDialog();
    await press('Start recount');
    expect(screen.getByRole('alert')).toHaveTextContent('already used for a different selection');
    await press('Start recount');
    const [first, second] = startRecountAction.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);
    expect(second).not.toBe(first);
  });

  it('shows the three result groups, with links to the counts', async () => {
    startRecountAction.mockResolvedValue({
      ok: true,
      result: result({
        linkedExisting: [
          {
            cycleCountId: 'cc-old',
            countNumber: 1,
            reference: 'CC-000001',
            assignedTo: { id: 'u-ana', label: 'Ana' },
            startedAt: '2026-09-24T18:00:00Z',
            itemIds: ['i2'],
            occurrenceIds: ['o2'],
          },
        ],
        skipped: [{ occurrenceId: null, itemId: 'i3', itemName: 'Projector', reason: 'not_countable' }],
      }),
    });
    await renderDialog();
    await press('Start recount');
    expect(screen.getByTestId('recount-started')).toHaveTextContent('Started CC-000002 (1 item)');
    expect(screen.getByTestId('recount-started')).toHaveTextContent('Not assigned to anyone yet.');
    expect(screen.getByRole('link', { name: 'Open the count' })).toHaveAttribute('href', '/dashboard/cycle-counts/cc-new');
    expect(screen.getByTestId('recount-already-counting')).toHaveTextContent(
      'Already being counted in CC-000001 (assigned to Ana, open since Sep 24), linked',
    );
    expect(screen.getByRole('link', { name: /CC-000001/ })).toHaveAttribute('href', '/dashboard/cycle-counts/cc-old');
    expect(screen.getByTestId('recount-skipped')).toHaveTextContent(
      'Skipped: Projector: Rental equipment, kits and archived items are not counted',
    );
  });

  it('says when the count was started unassigned because assigning failed', async () => {
    startRecountAction.mockResolvedValue({
      ok: true,
      result: result({ assignedTo: null, assignmentFailed: true }),
    });
    await renderDialog();
    await press('Start recount');
    expect(screen.getByTestId('recount-started')).toHaveTextContent(
      'It was started unassigned and nobody was notified. Assign it from the count.',
    );
  });

  it('names the assignee from the member list', async () => {
    startRecountAction.mockResolvedValue({ ok: true, result: result({ assignedTo: 'u-ben' }) });
    await renderDialog();
    await press('Start recount');
    expect(screen.getByTestId('recount-started')).toHaveTextContent('Assigned to Ben, who gets a notification.');
  });

  it('Done closes the panel and tells the caller', async () => {
    startRecountAction.mockResolvedValue({ ok: true, result: result() });
    const { onOpenChange, onFinished } = await renderDialog();
    await press('Start recount');
    await press('Done');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onFinished).toHaveBeenCalled();
  });

  it('a failed member read says so and still lets the recount start unassigned', async () => {
    listCountAssigneesAction.mockResolvedValue({ error: { message: 'Something went wrong. Please try again.', reason: null } });
    startRecountAction.mockResolvedValue({ ok: true, result: result() });
    await renderDialog();
    expect(screen.getByTestId('recount-members-failed')).toHaveTextContent('Team members could not be loaded.');
    await press('Start recount');
    expect(startRecountAction).toHaveBeenCalledWith(expect.objectContaining({ assignedTo: null }));
  });

  it('while preparing, Start is disabled; when blocked, it is not offered', async () => {
    await renderDialog({ preparing: true });
    expect(screen.getByRole('button', { name: 'Start recount' })).toBeDisabled();
  });

  it('a blocked recount shows why and offers no Start', async () => {
    await renderDialog({ blocked: 'Only a manager with permission to assign counts and adjust stock can start a recount.' });
    expect(screen.getByTestId('recount-blocked')).toHaveTextContent('Only a manager');
    expect(screen.queryByRole('button', { name: 'Start recount' })).not.toBeInTheDocument();
  });

  it('shows a non-retryable refusal inline and keeps Start', async () => {
    startRecountAction.mockResolvedValue({
      error: { message: 'Only a manager with permission to assign counts and adjust stock can start a recount.', reason: null },
    });
    await renderDialog();
    await press('Start recount');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Only a manager'));
    expect(screen.getByRole('button', { name: 'Start recount' })).toBeEnabled();
  });
});
