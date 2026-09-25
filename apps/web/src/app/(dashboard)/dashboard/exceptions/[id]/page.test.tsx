// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EXCEPTION_ACT_NOT_PERMITTED_COPY,
  EXCEPTION_ACT_RESOLVED_COPY,
  EXCEPTION_RULES,
} from '@stockpilot/core';

/**
 * One occurrence (F1-1). What this page must never get wrong:
 *   - a failed read renders "unavailable", never an empty page (pattern #1);
 *     not found and not visible are the same 404;
 *   - Acknowledge and Add note are rendered only for a reader the server says
 *     may act; a viewer, or a reader without warehouse write access, sees why
 *     instead; a resolved occurrence offers neither;
 *   - it reads, never syncs.
 */

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
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
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/server/services/exception-occurrences', () => ({
  ExceptionOccurrencesService: class {
    get = get;
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

import ExceptionDetailPage from './page';

const ID = '11111111-1111-4111-8111-111111111111';
const EARLIER = '22222222-2222-4222-8222-222222222222';

const SYNCED = {
  trackingStartedAt: '2026-09-24T15:00:00Z',
  lastEvaluatedAt: '2026-09-24T18:00:00Z',
  lastSyncedAt: '2026-09-24T18:00:02Z',
  completeRules: ['label_mismatch'],
  failedRules: [],
  truncatedRules: [],
};

function occurrence(o: Record<string, unknown> = {}) {
  return {
    id: ID,
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
    previousOccurrenceId: EARLIER,
    recurrenceIndex: 1,
    canAct: true,
    ...o,
  };
}

function detail(o: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    occurrence: occurrence(o),
    timeline: [
      { id: 'e1', kind: 'raised', at: '2026-09-24T15:00:00Z', actor: null, note: null, cycleCount: null, maintenanceRequestId: null, evidenceId: null },
      { id: 'e2', kind: 'note', at: '2026-09-24T16:00:00Z', actor: { id: 'u1', label: 'Dana Lee' }, note: 'checking rack', cycleCount: null, maintenanceRequestId: null, evidenceId: null },
    ],
    history: [
      { id: ID, number: 42, reference: 'EX-000042', firstSeenAt: '2026-09-24T15:00:00Z', resolvedAt: null, resolvedReason: null, recurrenceIndex: 1, isCurrent: true },
      { id: EARLIER, number: 7, reference: 'EX-000007', firstSeenAt: '2026-09-20T15:00:00Z', resolvedAt: '2026-09-21T15:00:00Z', resolvedReason: 'cleared', recurrenceIndex: 0, isCurrent: false },
    ],
    historyTruncated: false,
    syncState: SYNCED,
    ...extra,
  };
}

async function renderPage(id = ID) {
  return render(await ExceptionDetailPage({ params: Promise.resolve({ id }) }));
}

beforeEach(() => vi.clearAllMocks());

describe('Exception detail page', () => {
  it('a failed read says unavailable, never an empty page', async () => {
    get.mockRejectedValue(new ServiceError('internal_error', 'read failed'));
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('Exceptions are unavailable right now.');
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
  });

  it('not found (or not visible) is a 404', async () => {
    get.mockRejectedValue(new ServiceError('not_found', 'Exception not found.'));
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('a malformed id is a 404 without a read', async () => {
    await expect(renderPage('not-an-id')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(get).not.toHaveBeenCalled();
  });

  it('renders the condition, causes, what clears it, the timeline and the recurrence chain', async () => {
    get.mockResolvedValue(detail());
    await renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Atlas');
    expect(screen.getByText('labelled 40-C, stock is on 39-C')).toBeInTheDocument();
    expect(screen.getByTestId('occurrence-state')).toHaveTextContent('Open');
    expect(screen.getByText('Recurred (2nd time)')).toBeInTheDocument();
    expect(screen.getByText(/^Already present when tracking began, Sep 24/)).toBeInTheDocument();
    for (const e of EXCEPTION_RULES.label_mismatch.explanations) expect(screen.getByText(e)).toBeInTheDocument();
    expect(screen.getByText(EXCEPTION_RULES.label_mismatch.clearedBy)).toBeInTheDocument();
    expect(screen.getByText('Raised by the system check')).toBeInTheDocument();
    expect(screen.getByText('Note from Dana Lee')).toBeInTheDocument();
    expect(screen.getByText('checking rack')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'EX-000007' })).toHaveAttribute('href', `/dashboard/exceptions/${EARLIER}`);
    expect(screen.getByText('(this one)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit label' })).toHaveAttribute('href', '/dashboard/inventory/item-1');
    expect(screen.getByText(/^Checked at /)).toBeInTheDocument();
  });

  it('a reader the server says may act gets Acknowledge and Add note', async () => {
    get.mockResolvedValue(detail());
    await renderPage();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeInTheDocument();
  });

  it('once acknowledged, only Add note is offered', async () => {
    get.mockResolvedValue(
      detail({ acknowledgedAt: '2026-09-24T17:00:00Z', acknowledgedBy: { id: 'u1', label: 'Dana Lee' } }),
    );
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeInTheDocument();
    expect(screen.getByText(/^Dana Lee, Sep 24/)).toBeInTheDocument();
  });

  // Mutation caught: rendering the actions without checking canAct (a viewer
  // would see buttons that always fail).
  it('a viewer (or a reader without write access) sees no actions, and is told why', async () => {
    get.mockResolvedValue(detail({ canAct: false }));
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add note' })).not.toBeInTheDocument();
    expect(screen.getByTestId('act-unavailable')).toHaveTextContent(EXCEPTION_ACT_NOT_PERMITTED_COPY);
  });

  it('a resolved occurrence offers no actions and shows its reason', async () => {
    get.mockResolvedValue(
      detail({ resolvedAt: '2026-09-24T19:00:00Z', resolvedReason: 'cleared', canAct: false }),
    );
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(screen.getByTestId('act-unavailable')).toHaveTextContent(EXCEPTION_ACT_RESOLVED_COPY);
    expect(screen.getByTestId('occurrence-state')).toHaveTextContent('Resolved: Cleared');
  });

  it('before the first check it says so', async () => {
    get.mockResolvedValue(detail({}, { syncState: null }));
    await renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('The first check has not run yet.');
  });

  it('reads once and never syncs', async () => {
    get.mockResolvedValue(detail());
    await renderPage();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(ID);
    expect(scheduleExceptionSync).not.toHaveBeenCalled();
  });

  // ── F1-2: recount ─────────────────────────────────────────────────────────

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

  it('offers Recount to a reader the server says can start one', async () => {
    get.mockResolvedValue(detail({ ...VARIANCE, canRecount: true }));
    await renderPage();
    expect(screen.getByTestId('recount-button')).toBeInTheDocument();
    expect(screen.getByTestId('recount-card')).toHaveTextContent(
      'Counts record each item’s total, wherever it is stored.',
    );
  });

  // Mutation caught: Recount offered on stock:adjust alone (staff).
  it('a reader who cannot start one sees why, and no button', async () => {
    get.mockResolvedValue(detail({ ...VARIANCE, canRecount: false }));
    await renderPage();
    expect(screen.queryByTestId('recount-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('recount-card')).toHaveTextContent(
      'Only a manager with permission to assign counts and adjust stock can start a recount.',
    );
  });

  it('a rule a recount cannot settle has no Recount section', async () => {
    get.mockResolvedValue(detail({ canRecount: false }));
    await renderPage();
    expect(screen.queryByTestId('recount-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recount-button')).not.toBeInTheDocument();
  });

  it('shows the linked recount and how far it has got, linking to the count', async () => {
    get.mockResolvedValue(
      detail({
        ...VARIANCE,
        canRecount: true,
        recount: {
          cycleCountId: 'cc-2',
          countNumber: 2,
          status: 'in_progress',
          completedAt: null,
          outcome: { kind: 'in_progress', counted: 1, total: 3 },
        },
      }),
    );
    await renderPage();
    const link = screen.getByRole('link', { name: 'Recount CC-000002: In progress: 1 of 3 counted' });
    expect(link).toHaveAttribute('href', '/dashboard/cycle-counts/cc-2');
  });

  it('a closed recount in the timeline says what it found', async () => {
    get.mockResolvedValue(
      detail({ ...VARIANCE }, {
        timeline: [
          { id: 'e1', kind: 'raised', at: '2026-09-24T15:00:00Z', actor: null, note: null, cycleCount: null, maintenanceRequestId: null, evidenceId: null },
          { id: 'e2', kind: 'recount_linked', at: '2026-09-24T16:00:00Z', actor: { id: 'u1', label: 'Dana Lee' }, note: null, cycleCount: { id: 'cc-2', countNumber: 2 }, maintenanceRequestId: null, evidenceId: null },
          { id: 'e3', kind: 'recount_closed', at: '2026-09-24T17:00:00Z', actor: null, note: null, cycleCount: { id: 'cc-2', countNumber: 2, outcome: { kind: 'matched', quantity: 21 } }, maintenanceRequestId: null, evidenceId: null },
        ],
      }),
    );
    await renderPage();
    expect(screen.getByText('Recount CC-000002 linked by Dana Lee')).toBeInTheDocument();
    expect(screen.getByText('Recount CC-000002 closed: Matched the book (21)')).toBeInTheDocument();
  });
});
