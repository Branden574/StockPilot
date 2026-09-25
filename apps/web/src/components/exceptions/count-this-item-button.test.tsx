// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Count this item" (F1-2). When it opens it asks which of the item's open
 * exceptions a recount can settle. Review finding: a REJECTED action (a
 * dropped connection, a deploy that no longer has the action) left the dialog
 * on "Checking this item's open exceptions..." with Start disabled until the
 * page was reloaded. And a manager in an org with Cycle Counts turned off was
 * told "Only a manager ...".
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
const listItemRecountTargetsAction = vi.fn();
const listCountAssigneesAction = vi.fn();
const startRecountAction = vi.fn();
vi.mock('@/server/actions/exceptions', () => ({
  listItemRecountTargetsAction: (...args: unknown[]) => listItemRecountTargetsAction(...args),
  listCountAssigneesAction: (...args: unknown[]) => listCountAssigneesAction(...args),
  startRecountAction: (...args: unknown[]) => startRecountAction(...args),
}));

import { CountThisItemButton } from './count-this-item-button';

const ITEM = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  listCountAssigneesAction.mockResolvedValue({ ok: true, members: [] });
});

async function open() {
  await act(async () => {
    render(<CountThisItemButton itemId={ITEM} timeZone="America/Los_Angeles" />);
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId('count-this-item'));
  });
}

describe('CountThisItemButton', () => {
  // Mutation caught: no catch around the targets read.
  it('a rejected read of the item\'s exceptions still lets the item be counted, and says so', async () => {
    listItemRecountTargetsAction.mockRejectedValue(new TypeError('Failed to fetch'));
    await open();
    await waitFor(() =>
      expect(screen.getByText(/open exceptions could not be read, so the count will not be linked/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Checking this item/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start recount' })).toBeEnabled();
  });

  it('names the real reason a recount is withheld', async () => {
    listItemRecountTargetsAction.mockResolvedValue({
      ok: true,
      canRecount: false,
      recountUnavailableReason: 'module_disabled',
      occurrenceIds: [],
    });
    await open();
    await waitFor(() =>
      expect(screen.getByTestId('recount-blocked')).toHaveTextContent(
        'Cycle Counts is turned off for this organization, so a recount cannot be started.',
      ),
    );
  });

  it('links the item\'s open exceptions it was told about', async () => {
    listItemRecountTargetsAction.mockResolvedValue({
      ok: true,
      canRecount: true,
      recountUnavailableReason: null,
      occurrenceIds: ['o1'],
    });
    await open();
    await waitFor(() =>
      expect(screen.getByText('The count will be linked to this item’s open exception.')).toBeInTheDocument(),
    );
  });
});
