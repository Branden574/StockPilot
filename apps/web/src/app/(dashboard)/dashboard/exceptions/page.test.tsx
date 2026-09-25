// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Exception Center reads STORED occurrences (F1-1). Three things it must
 * never get wrong, whatever the rendering:
 *   - a failed read renders "unavailable", never an empty list (pattern #1);
 *   - before the org's first check it says the check has not run, and never
 *     shows the all-clear state;
 *   - a rule the last check could not vouch for (failed or truncated) is
 *     named, and the all-clear state is withheld while any is out.
 * And it never syncs: the page is one read.
 */

const { list, forCurrentUser } = vi.hoisted(() => {
  const list = vi.fn();
  return { list, forCurrentUser: vi.fn(async () => ({ list })) };
});
const scheduleExceptionSync = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ notFound: vi.fn() }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/server/services/exception-occurrences', () => ({
  ExceptionOccurrencesService: { forCurrentUser, syncOrg: vi.fn() },
}));
vi.mock('@/server/services/lib/exception-sync-schedule', () => ({ scheduleExceptionSync }));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(async () => ({ organizationId: 'org-1' })),
}));
vi.mock('@/lib/dashboard/cached-org', () => ({
  getCachedOrgTimezone: vi.fn(async () => 'America/Los_Angeles'),
}));

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
    id: 'occ-1',
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
    ...o,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('Exceptions page', () => {
  it('a failed read says unavailable and never renders an empty or all-clear list', async () => {
    list.mockRejectedValue(new Error('read failed'));
    render(await ExceptionsPage());
    expect(screen.getByRole('alert')).toHaveTextContent('Exceptions are unavailable right now.');
    expect(screen.queryByText('Nothing needs attention')).not.toBeInTheDocument();
  });

  it('before the first check, says so and never shows the all-clear state', async () => {
    list.mockResolvedValue(listResult({ syncState: null }));
    render(await ExceptionsPage());
    expect(screen.getByRole('status')).toHaveTextContent(
      'The first check has not run yet. It runs within 15 minutes.',
    );
    expect(screen.queryByText('Nothing needs attention')).not.toBeInTheDocument();
  });

  it('names a rule the last check could not complete and withholds the all-clear', async () => {
    list.mockResolvedValue(
      listResult({ syncState: { ...SYNCED, failedRules: ['over_reserved'] } }),
    );
    render(await ExceptionsPage());
    expect(screen.getByRole('alert')).toHaveTextContent(
      'One check could not complete on the last run: Promised more than is owned. What it would show is unknown, not clean.',
    );
    expect(screen.queryByText('Nothing needs attention')).not.toBeInTheDocument();
  });

  it('with every check complete and nothing open, says nothing needs attention, with Checked at', async () => {
    list.mockResolvedValue(listResult());
    render(await ExceptionsPage());
    expect(screen.getByText('Nothing needs attention')).toBeInTheDocument();
    expect(screen.getByText(/^Checked at /)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders a stored occurrence with its EX number, core wording and tracking-began note', async () => {
    list.mockResolvedValue(listResult({ occurrences: [occurrence()] }));
    render(await ExceptionsPage());
    expect(screen.getByText('EX-000042')).toBeInTheDocument();
    expect(screen.getByText(/labelled 40-C, stock is on 39-C/)).toHaveTextContent(
      'Already present when tracking began',
    );
  });

  it('reads the open list once and never syncs', async () => {
    list.mockResolvedValue(listResult());
    render(await ExceptionsPage());
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ status: 'open' });
    expect(scheduleExceptionSync).not.toHaveBeenCalled();
  });
});
