// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Exception Center list reads STORED occurrences (F1-1). What it must
 * never get wrong:
 *   - a failed read renders "unavailable", never an empty or all-clear list
 *     (pattern #1);
 *   - before the org's first check it says the check has not run, and never
 *     shows the all-clear state;
 *   - a rule the last check could not vouch for (failed or truncated) is
 *     named, and the all-clear state is withheld while any is out;
 *   - it never syncs: one list read per view.
 * Plus the stage-3 rendering: Open and Resolved tabs, state chips, the
 * recurrence badge, "Already present when tracking began", "Checked at" and
 * a manager-only Check now.
 */

const { list, ctor, syncOrg } = vi.hoisted(() => {
  const list = vi.fn();
  const ctor = vi.fn();
  // Any call fails the render: a page view must never run a sync, directly
  // or through the scheduler (owner decision F1 Q9).
  const syncOrg = vi.fn(async () => {
    throw new Error('the Exceptions page must never sync');
  });
  return { list, ctor, syncOrg };
});
const scheduleExceptionSync = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href, 'aria-current': (rest as { 'aria-current'?: string })['aria-current'] }, children),
  };
});
vi.mock('@/server/services/exception-occurrences', () => ({
  ExceptionOccurrencesService: class {
    constructor(ctx: unknown) {
      ctor(ctx);
    }
    list = list;
    static syncOrg = syncOrg;
  },
}));
vi.mock('@/server/actions/exceptions', () => ({
  requestExceptionCheckAction: vi.fn(),
  actOnExceptionAction: vi.fn(),
}));
vi.mock('@/server/services/lib/exception-sync-schedule', () => ({ scheduleExceptionSync }));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(async () => ({ organizationId: 'org-1', role: 'staff' })),
}));
vi.mock('@/lib/dashboard/cached-org', () => ({
  getCachedOrgTimezone: vi.fn(async () => 'America/Los_Angeles'),
}));

import { ServiceError } from '@/server/services/context';

import ExceptionsPage from './page';

const SYNCED = {
  trackingStartedAt: '2026-09-24T15:00:00Z',
  lastEvaluatedAt: '2026-09-24T18:00:00Z',
  lastSyncedAt: '2026-09-24T18:00:02Z',
  completeRules: ['orphaned_stock', 'over_reserved', 'stale_staging', 'long_unplaced', 'label_mismatch'],
  failedRules: [],
  truncatedRules: [],
};

function occurrence(o: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    number: 42,
    reference: 'EX-000042',
    rule: 'label_mismatch',
    itemId: 'item-1',
    item: { name: 'Atlas', sku: 'A1' },
    locationId: null,
    location: null,
    warehouseId: 'wh-1',
    facts: { itemName: 'Atlas', sku: 'A1', label: '40-C', stockOn: ['39-C'] },
    conditionSince: null,
    firstSeenAt: '2026-09-24T15:00:00Z',
    lastSeenAt: '2026-09-24T18:00:00Z',
    presentWhenTrackingBegan: true,
    acknowledgedAt: null,
    acknowledgedBy: null,
    recount: null,
    resolvedAt: null,
    resolvedReason: null,
    previousOccurrenceId: null,
    recurrenceIndex: 0,
    canAct: true,
    ...o,
  };
}

function listResult(o: Record<string, unknown> = {}) {
  return {
    status: 'open',
    occurrences: [],
    truncated: false,
    syncState: SYNCED,
    canCheckNow: false,
    unrecognized: 0,
    timeZone: 'America/Los_Angeles',
    ...o,
  };
}

async function renderPage(tab?: string) {
  return render(await ExceptionsPage({ searchParams: Promise.resolve(tab ? { tab } : {}) }));
}

beforeEach(() => vi.clearAllMocks());

describe('Exceptions list page', () => {
  // Mutation caught: the catch returning an empty result (the all-clear
  // state, or an empty list).
  it('a failed read says unavailable and never renders an empty or all-clear list', async () => {
    list.mockRejectedValue(new ServiceError('internal_error', 'read failed'));
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('Exceptions are unavailable right now.');
    expect(screen.queryByText('Nothing needs attention')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Checked at/)).not.toBeInTheDocument();
  });

  it('a failed read of the Resolved tab is unavailable too, not "nothing resolved"', async () => {
    list.mockRejectedValue(new Error('boom'));
    await renderPage('resolved');
    expect(screen.getByRole('alert')).toHaveTextContent('Exceptions are unavailable right now.');
    expect(screen.queryByText(/Nothing was resolved/)).not.toBeInTheDocument();
  });

  it('before the first check, says so and never shows the all-clear state', async () => {
    list.mockResolvedValue(listResult({ syncState: null }));
    await renderPage();
    expect(screen.getByRole('status')).toHaveTextContent(
      'The first check has not run yet. It runs within 15 minutes.',
    );
    expect(screen.queryByText('Nothing needs attention')).not.toBeInTheDocument();
  });

  it('names a rule the last check could not complete and withholds the all-clear', async () => {
    list.mockResolvedValue(listResult({ syncState: { ...SYNCED, failedRules: ['over_reserved'] } }));
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'One check could not complete on the last run: Promised more than is owned. What it would show is unknown, not clean.',
    );
    expect(screen.queryByText('Nothing needs attention')).not.toBeInTheDocument();
  });

  it('a failed rule this build cannot name still withholds the all-clear', async () => {
    list.mockResolvedValue(listResult({ syncState: { ...SYNCED, unrecognizedUncheckedRules: 1 } }));
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'One check could not complete on the last run: 1 check this version cannot name.',
    );
    expect(screen.queryByText('Nothing needs attention')).not.toBeInTheDocument();
  });

  it('open rows of a rule this build cannot word are counted, and the all-clear is withheld', async () => {
    // After a rollback, rows a newer build wrote (count_variance) are still
    // open. Mutation caught: rendering the all-clear because every row the
    // list could word was filtered out.
    list.mockResolvedValue(listResult({ unrecognized: 2 }));
    await renderPage();
    expect(screen.getByTestId('exceptions-unrecognized')).toHaveTextContent(
      '2 more open exceptions cannot be shown in this version. Update the app, or reload the page, to see them.',
    );
    expect(screen.queryByText('Nothing needs attention')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open (2)' })).toBeInTheDocument();
  });

  it('with every check complete and nothing open, says nothing needs attention, with Checked at', async () => {
    list.mockResolvedValue(listResult());
    await renderPage();
    expect(screen.getByText('Nothing needs attention')).toBeInTheDocument();
    expect(screen.getByText(/^Checked at Sep 24, 11:00 AM\./)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders an occurrence with its EX number, core wording, state chip and tracking-began note, linking to its page', async () => {
    list.mockResolvedValue(listResult({ occurrences: [occurrence()] }));
    await renderPage();
    const link = screen.getByRole('link', { name: /EX-000042/ });
    expect(link).toHaveAttribute('href', '/dashboard/exceptions/11111111-1111-4111-8111-111111111111');
    expect(within(link).getByText(/labelled 40-C, stock is on 39-C/)).toBeInTheDocument();
    expect(within(link).getByTestId('occurrence-state')).toHaveTextContent('Open');
    expect(within(link).getByText('Already present when tracking began')).toBeInTheDocument();
  });

  it('shows the acknowledged state, the recurrence badge and a first-seen date after tracking began', async () => {
    list.mockResolvedValue(
      listResult({
        occurrences: [
          occurrence({
            presentWhenTrackingBegan: false,
            firstSeenAt: '2026-09-24T17:00:00Z',
            acknowledgedAt: '2026-09-24T17:30:00Z',
            acknowledgedBy: { id: 'u1', label: 'Dana Lee' },
            recurrenceIndex: 1,
          }),
        ],
      }),
    );
    await renderPage();
    expect(screen.getByTestId('occurrence-state')).toHaveTextContent('Acknowledged');
    expect(screen.getByText('Recurred (2nd time)')).toBeInTheDocument();
    expect(screen.getByText('First seen Sep 24, 10:00 AM')).toBeInTheDocument();
  });

  it('says "for at least N days" for a Staging holding', async () => {
    list.mockResolvedValue(
      listResult({
        occurrences: [
          occurrence({
            rule: 'stale_staging',
            locationId: 'loc-1',
            facts: { itemName: 'Atlas', units: 4, locationName: 'Staging' },
            conditionSince: new Date(Date.now() - 9 * 86_400_000 - 60_000).toISOString(),
          }),
        ],
      }),
    );
    await renderPage();
    expect(screen.getByText(/in Staging for at least 9 days/)).toBeInTheDocument();
  });

  it('reads the open list once and never syncs', async () => {
    list.mockResolvedValue(listResult());
    await renderPage();
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ status: 'open' });
    expect(scheduleExceptionSync).not.toHaveBeenCalled();
    // Mutation caught: a bounded wait on ExceptionOccurrencesService.syncOrg
    // before the read (the plan's original page-view sync, which Q9 removed).
    expect(syncOrg).not.toHaveBeenCalled();
  });

  it('the Resolved tab reads the resolved list and shows each row\'s reason and time', async () => {
    list.mockResolvedValue(
      listResult({
        status: 'resolved',
        occurrences: [
          occurrence({ resolvedAt: '2026-09-24T19:00:00Z', resolvedReason: 'cleared', presentWhenTrackingBegan: false }),
        ],
      }),
    );
    await renderPage('resolved');
    expect(list).toHaveBeenCalledWith({ status: 'resolved' });
    expect(screen.getByTestId('occurrence-state')).toHaveTextContent('Resolved: Cleared');
    expect(screen.getByText('Resolved Sep 24, 12:00 PM')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Resolved, last 30 days' })).toHaveAttribute('aria-current', 'page');
  });

  it('an empty Resolved tab says nothing was resolved in the window', async () => {
    list.mockResolvedValue(listResult({ status: 'resolved' }));
    await renderPage('resolved');
    expect(screen.getByText('Nothing was resolved in the last 30 days.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing needs attention')).not.toBeInTheDocument();
  });

  it('offers Check now only when the server says the reader may ask for one', async () => {
    list.mockResolvedValue(listResult());
    const first = await renderPage();
    expect(screen.queryByRole('button', { name: /Check now/ })).not.toBeInTheDocument();
    first.unmount();
    list.mockResolvedValue(listResult({ canCheckNow: true }));
    await renderPage();
    expect(screen.getByRole('button', { name: /Check now/ })).toBeInTheDocument();
  });

  it('a reader without items:read gets a 404, not an empty list', async () => {
    list.mockRejectedValue(new ServiceError('forbidden', 'nope'));
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  // ── F1-2: multi-select recount ────────────────────────────────────────────

  const VARIANCE = {
    rule: 'count_variance',
    facts: {
      itemName: 'QA Chromebook',
      sku: 'QA-1',
      cycleCountId: 'cc-1',
      countNumber: 1,
      observedAt: '2026-09-24T17:00:00Z',
      completedAt: '2026-09-24T17:05:00Z',
      expected: 20,
      counted: 21,
      variance: 1,
      countedLocationName: null,
      aiAssisted: false,
      capturedOfflineAt: null,
    },
    item: { name: 'QA Chromebook', sku: 'QA-1' },
  };

  // Mutation caught: offering checkboxes on every row, or to every reader.
  it('a manager who can recount gets checkboxes on the recountable rows only', async () => {
    list.mockResolvedValue(
      listResult({
        canRecount: true,
        occurrences: [
          occurrence({ id: 'a0000000-0000-4000-8000-000000000001', reference: 'EX-000001', ...VARIANCE, canRecount: true }),
          occurrence({ id: 'a0000000-0000-4000-8000-000000000002', reference: 'EX-000002', canRecount: false }),
        ],
      }),
    );
    await renderPage();
    const boxes = screen.getAllByTestId('recount-checkbox');
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toHaveAccessibleName('Select EX-000001 to recount');
    expect(screen.getByTestId('recount-hint')).toBeInTheDocument();
  });

  it('a reader who cannot recount sees the list without checkboxes', async () => {
    list.mockResolvedValue(
      listResult({
        canRecount: false,
        occurrences: [occurrence({ reference: 'EX-000001', ...VARIANCE, canRecount: false })],
      }),
    );
    await renderPage();
    expect(screen.queryByTestId('recount-checkbox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recount-hint')).not.toBeInTheDocument();
  });

  it('a row with a recount in progress says how far it has got', async () => {
    list.mockResolvedValue(
      listResult({
        occurrences: [
          occurrence({
            reference: 'EX-000001',
            ...VARIANCE,
            recount: {
              cycleCountId: 'cc-2',
              countNumber: 2,
              status: 'in_progress',
              completedAt: null,
              outcome: { kind: 'in_progress', counted: 0, total: 1 },
            },
          }),
        ],
      }),
    );
    await renderPage();
    expect(screen.getByTestId('occurrence-state')).toHaveTextContent('Recount in progress (CC-000002)');
    expect(screen.getByTestId('recount-note')).toHaveTextContent('In progress: 0 of 1 counted');
  });

  it('a posted recount waiting for the check reads Re-checking with what it found', async () => {
    list.mockResolvedValue(
      listResult({
        occurrences: [
          occurrence({
            reference: 'EX-000001',
            ...VARIANCE,
            recount: {
              cycleCountId: 'cc-2',
              countNumber: 2,
              status: 'completed',
              // After the last applied evaluation (18:00).
              completedAt: '2026-09-24T18:30:00Z',
              outcome: { kind: 'matched', quantity: 21 },
            },
          }),
        ],
      }),
    );
    await renderPage();
    expect(screen.getByTestId('occurrence-state')).toHaveTextContent('Re-checking');
    expect(screen.getByTestId('recount-note')).toHaveTextContent('Matched the book (21)');
  });
});
