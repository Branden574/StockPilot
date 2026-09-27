// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Recount items here" on a location's page (F1-3). It starts ONE recount of
 * the items the server listed (every countable item held here, across every
 * page) through the F1-2 recount dialog and service, linked to the open
 * exceptions about them a count can settle. Disabled, with the reason, when
 * nothing here can be counted or more than one recount may hold. A failed
 * read of the exceptions still lets the items be counted, and says the count
 * will not be linked.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
const listItemsRecountTargetsAction = vi.fn();
const listCountAssigneesAction = vi.fn();
const startRecountAction = vi.fn();
vi.mock('@/server/actions/exceptions', () => ({
  listItemsRecountTargetsAction: (...args: unknown[]) => listItemsRecountTargetsAction(...args),
  listCountAssigneesAction: (...args: unknown[]) => listCountAssigneesAction(...args),
  startRecountAction: (...args: unknown[]) => startRecountAction(...args),
}));

import { LocationRecountButton } from './location-recount-button';

const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  listCountAssigneesAction.mockResolvedValue({ ok: true, members: [] });
});

async function renderButton(props: { itemIds?: string[]; problem?: string | null } = {}) {
  await act(async () => {
    render(
      <LocationRecountButton
        itemIds={props.itemIds ?? [A, B]}
        problem={props.problem ?? null}
        timeZone="America/Chicago"
      />,
    );
  });
}

async function open() {
  await act(async () => {
    fireEvent.click(screen.getByTestId('location-recount'));
  });
}

describe('LocationRecountButton', () => {
  it('asks which open exceptions about THESE items a count can settle, says what the count covers, and starts one recount of them', async () => {
    listItemsRecountTargetsAction.mockResolvedValue({
      ok: true,
      canRecount: true,
      recountUnavailableReason: null,
      occurrenceIds: ['o1', 'o2'],
      truncated: false,
    });
    startRecountAction.mockResolvedValue({
      ok: true,
      result: {
        cycleCountId: 'cc-9',
        countNumber: 9,
        reference: 'CC-000009',
        lineCount: 2,
        created: true,
        replay: false,
        assignedTo: null,
        assignmentFailed: false,
        notes: 'Recount: 2 items',
        linked: ['o1', 'o2'],
        linkedExisting: [],
        skipped: [],
      },
    });
    await renderButton();
    await open();
    expect(listItemsRecountTargetsAction).toHaveBeenCalledWith([A, B]);
    await waitFor(() =>
      expect(
        screen.getByText(
          'The count will include the 2 items held here that can be counted. It will be linked to 2 open exceptions about these items.',
        ),
      ).toBeInTheDocument(),
    );
    // What a count covers (item totals, wherever stored), in F1-2's words.
    expect(
      screen.getByText('Counts record each item’s total, wherever it is stored.'),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start recount' }));
    });
    expect(startRecountAction).toHaveBeenCalledTimes(1);
    expect(startRecountAction.mock.calls[0]![0]).toMatchObject({
      itemIds: [A, B],
      occurrenceIds: ['o1', 'o2'],
      assignedTo: null,
    });
    await waitFor(() => expect(screen.getByTestId('recount-result')).toBeInTheDocument());
  });

  it('while it asks, it says so (for these items, not "this item") and Start waits', async () => {
    listItemsRecountTargetsAction.mockReturnValue(new Promise(() => {}));
    await renderButton();
    await open();
    expect(screen.getByText('Checking these items’ open exceptions...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start recount' })).toBeDisabled();
  });

  it('a failed read of the exceptions still lets the items be counted, and says the count will not be linked', async () => {
    listItemsRecountTargetsAction.mockRejectedValue(new TypeError('Failed to fetch'));
    await renderButton({ itemIds: [A] });
    await open();
    await waitFor(() =>
      expect(
        screen.getByText(
          /^The count will include the item held here that can be counted\. Their open exceptions could not be read, so the count will not be linked to them\./,
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Start recount' })).toBeEnabled();
  });

  it('an open list that stopped at its cap says some exceptions may not be linked', async () => {
    listItemsRecountTargetsAction.mockResolvedValue({
      ok: true,
      canRecount: true,
      recountUnavailableReason: null,
      occurrenceIds: [],
      truncated: true,
    });
    await renderButton();
    await open();
    await waitFor(() =>
      expect(screen.getByText(/Some open exceptions may not be linked\./)).toBeInTheDocument(),
    );
  });

  it('names the real reason when the server withholds the recount', async () => {
    listItemsRecountTargetsAction.mockResolvedValue({
      ok: true,
      canRecount: false,
      recountUnavailableReason: 'module_disabled',
      occurrenceIds: [],
      truncated: false,
    });
    await renderButton();
    await open();
    await waitFor(() =>
      expect(screen.getByTestId('recount-blocked')).toHaveTextContent(
        'Cycle Counts is turned off for this organization, so a recount cannot be started.',
      ),
    );
    expect(screen.queryByRole('button', { name: 'Start recount' })).not.toBeInTheDocument();
  });

  it('above the recount cap (or with nothing countable) it is disabled with the reason beside it, and asks nothing', async () => {
    const problem =
      'A recount can include at most 200 items, and 240 items here can be counted. Count this location from Cycle Counts instead.';
    await renderButton({ itemIds: [], problem });
    const button = screen.getByTestId('location-recount');
    expect(button).toBeDisabled();
    expect(screen.getByTestId('location-recount-problem')).toHaveTextContent(problem);
    expect(button).toHaveAttribute(
      'aria-describedby',
      screen.getByTestId('location-recount-problem').id,
    );
    await act(async () => {
      fireEvent.click(button);
    });
    expect(listItemsRecountTargetsAction).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
