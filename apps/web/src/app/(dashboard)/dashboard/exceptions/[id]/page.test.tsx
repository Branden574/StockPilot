// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  countVarianceAcknowledgeHelp,
  ESCALATE_TO_MAINTENANCE_HELP,
  EXCEPTION_ACKNOWLEDGE_HELP,
  EXCEPTION_ACT_NOT_PERMITTED_COPY,
  EXCEPTION_ACT_RESOLVED_COPY,
  EXCEPTION_EVIDENCE_CAP_COPY,
  EXCEPTION_EVIDENCE_LIMITS_COPY,
  EXCEPTION_EVIDENCE_NONE_COPY,
  EXCEPTION_EVIDENCE_NOT_PERMITTED_COPY,
  EXCEPTION_EVIDENCE_PRIVACY_COPY,
  EXCEPTION_EVIDENCE_RESOLVED_COPY,
  EXCEPTION_EVIDENCE_UNAVAILABLE_COPY,
  EXCEPTION_RULES,
  RECOUNT_NONE_LINKED_COPY,
} from '@stockpilot/core';

/**
 * One occurrence (F1-1). What this page must never get wrong:
 *   - a failed read renders "unavailable", never an empty page (pattern #1);
 *     not found and not visible are the same 404;
 *   - Acknowledge and Add note are rendered only for a reader the server says
 *     may act; a viewer, or a reader without warehouse write access, sees why
 *     instead; a resolved occurrence offers neither;
 *   - it reads, never syncs;
 *   - photos (F1-4): everyone who can open it sees them; Add photos only for
 *     a reader who may act on an open exception, under the cap; a failed
 *     photo read is never "No photos yet."; a photo's timeline entries say
 *     who, the two clocks, and the note or the removal's reason;
 *   - escalation (F1-5): Escalate to maintenance only where the server says
 *     so, hidden otherwise; an escalated exception shows "Escalated: MR-..."
 *     to every reader, linked and with what StockPilot records about the
 *     request only for a reader who can open it; the action then opens that
 *     request instead of making another; never "sent" or "ticket".
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
  startExceptionEvidenceUploadAction: vi.fn(),
  finalizeExceptionEvidenceAction: vi.fn(),
  removeExceptionEvidenceAction: vi.fn(),
}));
vi.mock('@/server/services/lib/exception-sync-schedule', () => ({ scheduleExceptionSync }));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(async () => ({ organizationId: 'org-1', role: 'staff' })),
}));
vi.mock('@/lib/dashboard/cached-org', () => ({
  getCachedOrgTimezone: vi.fn(async () => 'America/Los_Angeles'),
}));
// The item's verification card (F1-3) is its own unit
// (item-verification-card.test.tsx). Here: which props the page hands it, and
// that it sits in a Suspense boundary of its own: while `card.suspend` is on
// it never resolves, and only a boundary around it lets the rest of the page
// render.
const card = vi.hoisted(() => ({ suspend: false, never: new Promise<never>(() => {}) }));
vi.mock('@/components/inventory/item-verification-card', async () => {
  const React = await import('react');
  return {
    ItemVerificationCard: (props: { itemId: string; movementsHref: string; excludeIssueId?: string | null }) => {
      if (card.suspend) throw card.never;
      return React.createElement('div', {
        'data-testid': 'verification-card',
        'data-item': props.itemId,
        'data-movements': props.movementsHref,
        'data-exclude': props.excludeIssueId ?? '',
      });
    },
    ItemVerificationCardSkeleton: () =>
      React.createElement('div', { 'data-testid': 'verification-card-loading' }),
  };
});

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
    evidence: NO_PHOTOS,
    ...extra,
  };
}

const NO_PHOTOS = { status: 'ok', photos: [], liveCount: 0, maxPhotos: 8, canAdd: true };

function photo(o: Record<string, unknown> = {}) {
  return {
    id: 'ph-1',
    uploadedBy: { id: 'u1', label: 'Dana Lee' },
    capturedAt: '2026-09-24T17:02:00Z',
    uploadedAt: '2026-09-24T17:40:00Z',
    note: 'Shelf 39-C, bottom row',
    contentType: 'image/jpeg',
    byteSize: 1000,
    url: 'https://files.example.test/ph-1.jpg',
    thumbUrl: 'https://files.example.test/ph-1-thumb.webp',
    canRemove: false,
    ...o,
  };
}

async function renderPage(id = ID) {
  return render(await ExceptionDetailPage({ params: Promise.resolve({ id }) }));
}

// happy-dom never loads an image and reports each one as complete with no
// width, which a browser reports only for a BROKEN image (the Photos panel
// shows a broken one as "could not be loaded"). Model a browser in which the
// photos are still loading.
const imageComplete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');

beforeEach(() => {
  vi.clearAllMocks();
  card.suspend = false;
  Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => false });
});
afterEach(() => {
  if (imageComplete) Object.defineProperty(HTMLImageElement.prototype, 'complete', imageComplete);
  else delete (HTMLImageElement.prototype as { complete?: boolean }).complete;
});

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

  // A count difference's Recount lives in the "What clears this" card at the
  // top (owner decision 2026-09-29, EX-000059); over_reserved keeps its own
  // Recount card where it was.
  it('offers Recount to a reader the server says can start one', async () => {
    get.mockResolvedValue(detail({ ...VARIANCE, canRecount: true }));
    await renderPage();
    const card = screen.getByTestId('count-variance-clears');
    expect(within(card).getByTestId('recount-button')).toBeInTheDocument();
    expect(card).toHaveTextContent('Counts record each item’s total, wherever it is stored.');
    expect(card).toHaveTextContent(RECOUNT_NONE_LINKED_COPY);
    // Only one Recount on the page: it left the actions row for this rule.
    expect(screen.getAllByTestId('recount-button')).toHaveLength(1);
    expect(screen.queryByTestId('recount-card')).not.toBeInTheDocument();
  });

  // Mutation caught: Recount offered on stock:adjust alone (staff).
  it('a reader who cannot start one sees why, and no button', async () => {
    // Staff who may act: the card's sentence says who to ask.
    get.mockResolvedValue(detail({ ...VARIANCE, canRecount: false }));
    await renderPage();
    expect(screen.queryByTestId('recount-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('count-variance-clears')).toHaveTextContent(
      'It clears when a later count of this item matches the stock on record. To close it, ask a manager who can assign counts for a recount. Acknowledging does not clear this.',
    );
  });

  it('a viewer reads what clears it and why they cannot recount, with no Acknowledging sentence', async () => {
    get.mockResolvedValue(detail({ ...VARIANCE, canRecount: false, canAct: false }));
    await renderPage();
    const card = screen.getByTestId('count-variance-clears');
    expect(card).toHaveTextContent('It clears when a later count of this item matches the stock on record.');
    expect(card).toHaveTextContent(
      'Only a manager with permission to assign counts and adjust stock can start a recount.',
    );
    expect(card).not.toHaveTextContent('Acknowledging');
    expect(screen.queryByTestId('recount-button')).not.toBeInTheDocument();
  });

  it('over_reserved keeps its own Recount card and its Recount in the actions row', async () => {
    get.mockResolvedValue(
      detail({
        rule: 'over_reserved',
        facts: { itemName: 'Atlas', promised: 5, onHand: 3 },
        canRecount: true,
      }),
    );
    await renderPage();
    expect(screen.getByTestId('recount-card')).toHaveTextContent(RECOUNT_NONE_LINKED_COPY);
    expect(screen.getAllByTestId('recount-button')).toHaveLength(1);
    expect(screen.queryByTestId('count-variance-clears')).not.toBeInTheDocument();
    expect(screen.getByText(EXCEPTION_RULES.over_reserved.clearedBy)).toBeInTheDocument();
  });

  it('a rule a recount cannot settle has no Recount section', async () => {
    get.mockResolvedValue(detail({ canRecount: false }));
    await renderPage();
    expect(screen.queryByTestId('recount-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('count-variance-clears')).not.toBeInTheDocument();
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
    const card = screen.getByTestId('count-variance-clears');
    const link = within(card).getByRole('link', { name: 'Recount CC-000002: In progress: 1 of 3 counted' });
    expect(link).toHaveAttribute('href', '/dashboard/cycle-counts/cc-2');
    expect(within(card).getByTestId('active-recount')).toBeInTheDocument();
    expect(card).toHaveTextContent(
      'Recount CC-000002 is in progress (1 of 3 counted). When it is posted, this clears if it matches the stock on record, or shows the new numbers if it does not.',
    );
  });

  // Review 2026-09-29: Recount was the filled button while the card said to
  // wait for the linked recount; pressing it then only links that count.
  it('Recount is filled on an open count difference, and outline while a linked recount is in progress', async () => {
    get.mockResolvedValue(detail({ ...VARIANCE, canRecount: true }));
    const { unmount } = await renderPage();
    expect(within(screen.getByTestId('count-variance-clears')).getByTestId('recount-button')).toHaveAttribute(
      'data-variant',
      'default',
    );
    unmount();
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
    expect(within(screen.getByTestId('count-variance-clears')).getByTestId('recount-button')).toHaveAttribute(
      'data-variant',
      'outline',
    );
  });

  // Review 2026-09-29: the Acknowledge help told a manager to recount while
  // the card, for the same row, said the next check would update it.
  it('a posted recount being checked: the card and the Acknowledge step both say the next check', async () => {
    get.mockResolvedValue(
      detail({
        ...VARIANCE,
        canRecount: true,
        recount: {
          cycleCountId: 'cc-2',
          countNumber: 2,
          status: 'completed',
          completedAt: '2026-09-24T18:30:00Z',
          outcome: { kind: 'matched', quantity: 21 },
        },
      }),
    );
    await renderPage();
    const next = 'A newer count of this item was posted and is being checked. This updates at the next check, within 15 minutes.';
    expect(screen.getByTestId('count-variance-clears')).toHaveTextContent(next);
    expect(
      screen.getByText(
        `CC-000001 found 21 where 20 was on record, and posting it changed the stock on record by +1. Acknowledging tells others this is being looked at. It does not clear this exception. ${next}`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/To close it, count it once more with Recount\./)).not.toBeInTheDocument();
    expect(within(screen.getByTestId('count-variance-clears')).getByTestId('recount-button')).toHaveAttribute(
      'data-variant',
      'outline',
    );
  });

  // ── Count differences: what clears them (owner decision 2026-09-29) ──────

  it('a count difference says what clears it at the top, above the facts, and not again at the bottom', async () => {
    get.mockResolvedValue(detail({ ...VARIANCE, canRecount: true }));
    await renderPage();
    const card = screen.getByTestId('count-variance-clears');
    expect(within(card).getByRole('heading', { name: 'What clears this' })).toBeInTheDocument();
    expect(card).toHaveTextContent(
      'CC-000001 found 21 where 20 was on record, and posting it changed the stock on record by +1.',
    );
    expect(card).toHaveTextContent(
      'It clears when a later count of this item matches the stock on record. To close it, count it once more with Recount. Acknowledging does not clear this.',
    );
    // No Confirm in this release: the server sends no countConfirm block.
    expect(card).not.toHaveTextContent(/confirm/i);
    expect(screen.queryByTestId('confirm-unavailable')).not.toBeInTheDocument();
    // Above the facts card.
    const facts = screen.getByText('First seen');
    expect(card.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The bottom card is not repeated for this rule.
    expect(screen.getAllByText('What clears this')).toHaveLength(1);
    expect(screen.queryByText(EXCEPTION_RULES.count_variance.clearedBy)).not.toBeInTheDocument();
    expect(screen.getByText('What can cause this')).toBeInTheDocument();
    // The row sentence is the always-true one.
    expect(screen.getByText('CC-000001 found 21 where 20 was on record (+1)')).toBeInTheDocument();
  });

  it('with Cycle Counts off, it says so instead of offering a recount', async () => {
    get.mockResolvedValue(detail({ ...VARIANCE, canRecount: false, recountUnavailableReason: 'module_disabled' }));
    await renderPage();
    const card = screen.getByTestId('count-variance-clears');
    expect(card).toHaveTextContent(
      'It clears when a later count of this item matches the stock on record. Cycle Counts is turned off for this organization, so it cannot be recounted until it is turned on again. Acknowledging does not clear this.',
    );
    // Said once: the options already say why.
    expect(card).not.toHaveTextContent('so a recount cannot be started');
  });

  it('the Acknowledge step on a count difference says what acknowledging does not do, and is not the filled button', async () => {
    get.mockResolvedValue(detail({ ...VARIANCE, canRecount: true }));
    await renderPage();
    const help = countVarianceAcknowledgeHelp({
      facts: VARIANCE.facts,
      displayed: { kind: 'open' },
      recount: null,
      canRecount: true,
      confirm: null,
    });
    expect(help).toBe(
      'CC-000001 found 21 where 20 was on record, and posting it changed the stock on record by +1. Acknowledging tells others this is being looked at. It does not clear this exception. To close it, count it once more with Recount.',
    );
    expect(screen.getByText(help)).toBeInTheDocument();
    expect(screen.queryByText(EXCEPTION_ACKNOWLEDGE_HELP)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toHaveAttribute('data-variant', 'outline');
  });

  it('other rules keep the Acknowledge help and the filled Acknowledge', async () => {
    get.mockResolvedValue(detail());
    await renderPage();
    expect(screen.getByText(EXCEPTION_ACKNOWLEDGE_HELP)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toHaveAttribute('data-variant', 'default');
  });

  it('a resolved count difference has no top card', async () => {
    get.mockResolvedValue(
      detail({ ...VARIANCE, resolvedAt: '2026-09-24T19:00:00Z', resolvedReason: 'cleared', canAct: false }),
    );
    await renderPage();
    expect(screen.queryByTestId('count-variance-clears')).not.toBeInTheDocument();
  });

  // Before: an unknown reason read "Resolved: Cleared" on the chip and
  // "Resolved: undefined" in the facts and the history.
  it('a reason this build cannot word reads "Resolved", never "Cleared" or "undefined"', async () => {
    get.mockResolvedValue(
      detail(
        { resolvedAt: '2026-09-24T19:00:00Z', resolvedReason: null, canAct: false },
        {
          history: [
            { id: ID, number: 42, reference: 'EX-000042', firstSeenAt: '2026-09-24T15:00:00Z', resolvedAt: '2026-09-24T19:00:00Z', resolvedReason: null, recurrenceIndex: 1, isCurrent: true },
            { id: EARLIER, number: 7, reference: 'EX-000007', firstSeenAt: '2026-09-20T15:00:00Z', resolvedAt: '2026-09-21T15:00:00Z', resolvedReason: 'confirmed', confirmedAs: 'counter', recurrenceIndex: 0, isCurrent: false },
          ],
        },
      ),
    );
    await renderPage();
    expect(screen.getByTestId('occurrence-state')).toHaveTextContent(/^Resolved$/);
    expect(document.body.textContent).not.toMatch(/Cleared|undefined/);
    expect(screen.getByText(/^First seen Sep 20, .*, resolved Sep 21, .*: Confirmed by the counter$/)).toBeInTheDocument();
    expect(screen.getByText(/^First seen Sep 24, .*, resolved Sep 24, [^:]*:\d\d [AP]M$/)).toBeInTheDocument();
  });

  it('a count confirmation reads with who confirmed it, on the chip, the facts and the timeline', async () => {
    get.mockResolvedValue(
      detail(
        {
          ...VARIANCE,
          resolvedAt: '2026-09-24T19:00:00Z',
          resolvedReason: 'confirmed',
          canAct: false,
          confirmation: {
            at: '2026-09-24T19:00:00Z',
            by: { id: 'u1', label: 'Dana Lee' },
            cycleCountId: 'cc-1',
            countNumber: 1,
            quantity: 21,
            as: 'counter',
          },
        },
        {
          timeline: [
            { id: 'e1', kind: 'raised', at: '2026-09-24T15:00:00Z', actor: null, note: null, cycleCount: null, maintenanceRequestId: null, evidenceId: null },
            { id: 'e2', kind: 'count_confirmed', at: '2026-09-24T19:00:00Z', actor: { id: 'u1', label: 'Dana Lee' }, note: 'counted twice on the floor', cycleCount: { id: 'cc-1', countNumber: 1 }, maintenanceRequestId: null, evidenceId: null },
          ],
        },
      ),
    );
    await renderPage();
    expect(screen.getByTestId('occurrence-state')).toHaveTextContent('Resolved: Confirmed by the counter');
    expect(screen.getByText('Count confirmed')).toBeInTheDocument();
    expect(screen.getByText(/^Dana Lee, who counted it, Sep 24, .*, without a second count$/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Count confirmed by Dana Lee, who counted it, without a second count: CC-000001 found 21 where 20 was on record (+1)',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('counted twice on the floor')).toBeInTheDocument();
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
    expect(screen.getByText('Recount CC-000002 closed: Matched the stock on record (21)')).toBeInTheDocument();
  });

  it("shows the item's last physical count card, leaving this exception out of its chips", async () => {
    get.mockResolvedValue(detail());
    await renderPage();
    const c = screen.getByTestId('verification-card');
    expect(c).toHaveAttribute('data-item', 'item-1');
    expect(c).toHaveAttribute('data-movements', '/dashboard/inventory/item-1?tab=movements');
    expect(c).toHaveAttribute('data-exclude', ID);
  });

  it('the card is off the page\'s critical path: while it has not answered, the rest of the page renders around its skeleton', async () => {
    card.suspend = true;
    get.mockResolvedValue(detail());
    await renderPage();
    expect(screen.getByTestId('verification-card-loading')).toBeInTheDocument();
    expect(screen.getByText('What can cause this')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
  });

  it('no card when the reader cannot see the item', async () => {
    get.mockResolvedValue(detail({ item: null }));
    await renderPage();
    expect(screen.queryByTestId('verification-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('verification-card-loading')).not.toBeInTheDocument();
  });

  it("a holding rule's location links to the location page", async () => {
    get.mockResolvedValue(
      detail({
        rule: 'stale_staging',
        locationId: 'loc-1',
        location: { name: 'Staging', kind: 'staging', archived: false },
        facts: { itemName: 'Atlas', units: 4, locationName: 'Staging' },
        conditionSince: '2026-09-20T15:00:00Z',
      }),
    );
    await renderPage();
    expect(screen.getByRole('link', { name: 'Staging' })).toHaveAttribute('href', '/dashboard/locations/loc-1');
  });

  // ── F1-4: photo evidence ──────────────────────────────────────────────────

  it('a reader who may act on an open exception can add photos, with a note, and is told the limits', async () => {
    get.mockResolvedValue(detail());
    await renderPage();
    const panel = screen.getByRole('region', { name: 'Exception photos' });
    expect(panel).toHaveTextContent('Photos (0 of 8)');
    expect(screen.getByRole('button', { name: 'Add photos' })).toBeEnabled();
    expect(screen.getByLabelText(/^Note \(optional, saved with each photo you add\)/)).toBeInTheDocument();
    expect(panel).toHaveTextContent(EXCEPTION_EVIDENCE_NONE_COPY);
    expect(panel).toHaveTextContent(EXCEPTION_EVIDENCE_LIMITS_COPY);
    expect(panel).toHaveTextContent(EXCEPTION_EVIDENCE_PRIVACY_COPY);
  });

  // Mutation caught: the panel rendered without the act gate (a viewer would
  // be offered an upload the server always refuses).
  it('a viewer sees the photos read-only: no Add photos, no note field, no Remove, and why', async () => {
    get.mockResolvedValue(
      detail({ canAct: false }, { evidence: { ...NO_PHOTOS, photos: [photo()], liveCount: 1, canAdd: false } }),
    );
    await renderPage();
    const panel = screen.getByRole('region', { name: 'Exception photos' });
    expect(screen.queryByRole('button', { name: 'Add photos' })).not.toBeInTheDocument();
    expect(panel.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByLabelText(/^Note \(optional, saved/)).not.toBeInTheDocument();
    expect(screen.getByTestId('photos-add-unavailable')).toHaveTextContent(EXCEPTION_EVIDENCE_NOT_PERMITTED_COPY);
    expect(screen.getByAltText('Photo 1')).toHaveAttribute('src', 'https://files.example.test/ph-1-thumb.webp');
    expect(panel).toHaveTextContent('Photos (1 of 8)');
    expect(panel).toHaveTextContent('Shelf 39-C, bottom row');
    expect(panel).toHaveTextContent('Added by Dana Lee');
    expect(panel).toHaveTextContent("Taken 10:02 AM (device's clock) · uploaded 10:40 AM (server's clock)");
    expect(screen.queryByRole('button', { name: 'Remove Photo 1' })).not.toBeInTheDocument();
  });

  it('Remove is offered on the photos the server says this reader may remove, and only those', async () => {
    get.mockResolvedValue(
      detail({}, {
        evidence: {
          ...NO_PHOTOS,
          photos: [photo({ canRemove: true }), photo({ id: 'ph-2', canRemove: false, note: null })],
          liveCount: 2,
        },
      }),
    );
    await renderPage();
    expect(screen.getByRole('button', { name: 'Remove Photo 1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Photo 2' })).not.toBeInTheDocument();
  });

  it('a resolved exception shows its photos but offers neither Add nor Remove', async () => {
    get.mockResolvedValue(
      detail(
        { resolvedAt: '2026-09-24T19:00:00Z', resolvedReason: 'cleared', canAct: true },
        { evidence: { ...NO_PHOTOS, photos: [photo({ canRemove: false })], liveCount: 1, canAdd: false } },
      ),
    );
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Add photos' })).not.toBeInTheDocument();
    expect(screen.getByTestId('photos-add-unavailable')).toHaveTextContent(EXCEPTION_EVIDENCE_RESOLVED_COPY);
    expect(screen.getByAltText('Photo 1')).toBeInTheDocument();
  });

  it('at 8 photos, Add photos is turned off and the cap is stated', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => photo({ id: `ph-${i}` }));
    get.mockResolvedValue(detail({}, { evidence: { ...NO_PHOTOS, photos: eight, liveCount: 8, canAdd: false } }));
    await renderPage();
    expect(screen.getByRole('region', { name: 'Exception photos' })).toHaveTextContent('Photos (8 of 8)');
    expect(screen.getByRole('button', { name: 'Add photos' })).toBeDisabled();
    expect(screen.getByTestId('photos-add-unavailable')).toHaveTextContent(EXCEPTION_EVIDENCE_CAP_COPY);
  });

  // Mutation caught: an unreadable photo block rendered as an empty list.
  it('photos that could not be read say so, never "No photos yet."', async () => {
    get.mockResolvedValue(detail({}, { evidence: { status: 'unavailable' } }));
    await renderPage();
    const card = screen.getByTestId('occurrence-photos');
    expect(card).toHaveTextContent(EXCEPTION_EVIDENCE_UNAVAILABLE_COPY);
    expect(card).not.toHaveTextContent(EXCEPTION_EVIDENCE_NONE_COPY);
    expect(screen.queryByRole('button', { name: 'Add photos' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // The rest of the page is unaffected.
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
  });

  it("a photo's timeline entries: who, the two clocks, and the note or the removal's reason", async () => {
    get.mockResolvedValue(
      detail({}, {
        timeline: [
          { id: 'e1', kind: 'raised', at: '2026-09-24T15:00:00Z', actor: null, note: null, cycleCount: null, maintenanceRequestId: null, evidenceId: null, evidence: null },
          {
            id: 'e2',
            kind: 'evidence_added',
            at: '2026-09-24T17:40:00Z',
            actor: { id: 'u1', label: 'Dana Lee' },
            note: 'Shelf 39-C, bottom row',
            cycleCount: null,
            maintenanceRequestId: null,
            evidenceId: 'ph-1',
            evidence: { capturedAt: '2026-09-24T17:02:00Z', uploadedAt: '2026-09-24T17:40:00Z', removed: true },
          },
          {
            id: 'e3',
            kind: 'evidence_removed',
            at: '2026-09-24T18:00:00Z',
            actor: { id: 'u2', label: 'Sam Reed' },
            note: 'Blurry',
            cycleCount: null,
            maintenanceRequestId: null,
            evidenceId: 'ph-1',
            evidence: { capturedAt: '2026-09-24T17:02:00Z', uploadedAt: '2026-09-24T17:40:00Z', removed: true },
          },
        ],
      }),
    );
    await renderPage();
    const timeline = screen.getByText('Photo added by Dana Lee').closest('ol')!;
    expect(timeline).toHaveTextContent("Taken 10:02 AM (device's clock) · uploaded 10:40 AM (server's clock)");
    expect(timeline).toHaveTextContent('Shelf 39-C, bottom row');
    expect(screen.getByText('Photo removed by Sam Reed')).toBeInTheDocument();
    expect(screen.getByText('Reason: Blurry')).toBeInTheDocument();
  });

  // Mutation caught: the times line built from a missing photo row, which
  // prints "Upload time not available." under an entry that has a time.
  it('when the photos could not be read, a photo entry keeps its headline and guesses no times', async () => {
    get.mockResolvedValue(
      detail({}, {
        evidence: { status: 'unavailable' },
        timeline: [
          {
            id: 'e2',
            kind: 'evidence_added',
            at: '2026-09-24T17:40:00Z',
            actor: { id: 'u1', label: 'Dana Lee' },
            note: null,
            cycleCount: null,
            maintenanceRequestId: null,
            evidenceId: 'ph-1',
            evidence: null,
          },
        ],
      }),
    );
    await renderPage();
    const entry = screen.getByText('Photo added by Dana Lee').closest('li')!;
    expect(entry).not.toHaveTextContent('Upload time not available.');
    expect(entry).not.toHaveTextContent("device's clock");
    expect(entry).toHaveTextContent(/Sep 24/);
  });

  // ── F1-5: escalate to maintenance ────────────────────────────────────────

  const REQ = '44444444-4444-4444-8444-444444444444';

  function escalated(o: Record<string, unknown> = {}) {
    return {
      requestId: REQ,
      requestNumber: 14,
      reference: 'MR-2026-000014',
      escalatedAt: '2026-09-24T17:00:00Z',
      escalatedBy: { id: 'u1', label: 'Dana Lee' },
      requestCancelled: false,
      visibleToReader: true,
      request: { status: 'saved', draftOpened: false, cancelled: false },
      ...o,
    };
  }

  it('a reader the server says may escalate gets "Escalate to maintenance", opening the form for this exception', async () => {
    get.mockResolvedValue(detail({ escalation: null, canEscalate: true, escalateUnavailableReason: null }));
    await renderPage();
    expect(screen.getByRole('link', { name: 'Escalate to maintenance' })).toHaveAttribute(
      'href',
      `/dashboard/maintenance/new?exceptionOccurrenceId=${ID}`,
    );
    expect(screen.getByTestId('escalation-card')).toHaveTextContent(ESCALATE_TO_MAINTENANCE_HELP);
    expect(screen.queryByTestId('escalation-badge')).not.toBeInTheDocument();
  });

  // Mutation caught: the action rendered without canEscalate (the module off,
  // or a reader without maintenance_requests:submit, would be offered a form
  // that always refuses).
  it.each(['module_disabled', 'not_permitted', 'resolved'])(
    'hidden when the server says %s and nothing was escalated',
    async (reason) => {
      get.mockResolvedValue(detail({ escalation: null, canEscalate: false, escalateUnavailableReason: reason }));
      await renderPage();
      expect(screen.queryByRole('link', { name: 'Escalate to maintenance' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('escalation-card')).not.toBeInTheDocument();
    },
  );

  it('escalated, for a reader who can open the request: the badge links to it, the draft state shows, and the action opens it instead of making another', async () => {
    get.mockResolvedValue(
      detail({
        escalation: escalated({ request: { status: 'draft_opened', draftOpened: true, cancelled: false } }),
        canEscalate: false,
        escalateUnavailableReason: 'already_escalated',
      }),
    );
    await renderPage();
    const badge = screen.getByTestId('escalation-badge');
    expect(badge).toHaveTextContent('Escalated: MR-2026-000014');
    expect(badge.querySelector('a')).toHaveAttribute('href', `/dashboard/maintenance/${REQ}`);
    expect(screen.getByTestId('escalation-request-state')).toHaveTextContent('Email draft opened');
    expect(screen.getByTestId('escalation-status')).toHaveTextContent('Dana Lee, Sep 24, 10:00 AM');
    expect(screen.getByRole('link', { name: 'Open MR-2026-000014' })).toHaveAttribute(
      'href',
      `/dashboard/maintenance/${REQ}`,
    );
    expect(screen.queryByRole('link', { name: 'Escalate to maintenance' })).not.toBeInTheDocument();
  });

  it('a draft not opened yet says so, and only that', async () => {
    get.mockResolvedValue(
      detail({ escalation: escalated(), canEscalate: false, escalateUnavailableReason: 'already_escalated' }),
    );
    await renderPage();
    expect(screen.getByTestId('escalation-request-state')).toHaveTextContent('Email draft not yet opened');
  });

  // Mutation caught: the link or the draft line shown on visibleToReader
  // null/false (a reader who cannot open the request would get a 404 link,
  // and be told about a request they may not see).
  it('escalated, for a reader who cannot open the request: the handle only, no link, no draft state, and why no new request', async () => {
    get.mockResolvedValue(
      detail({
        escalation: escalated({ visibleToReader: false, request: null }),
        canEscalate: false,
        escalateUnavailableReason: 'already_escalated',
      }),
    );
    await renderPage();
    const badge = screen.getByTestId('escalation-badge');
    expect(badge).toHaveTextContent('Escalated: MR-2026-000014');
    expect(badge.querySelector('a')).toBeNull();
    expect(screen.queryByTestId('escalation-request-state')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open MR-/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('escalate-unavailable')).toHaveTextContent(
      'Already escalated to MR-2026-000014. A new request can be made only if that one is cancelled.',
    );
  });

  it('a failed request read (visibleToReader null) links nothing and claims nothing', async () => {
    get.mockResolvedValue(
      detail({
        escalation: escalated({ visibleToReader: null, request: null }),
        canEscalate: false,
        escalateUnavailableReason: 'already_escalated',
      }),
    );
    await renderPage();
    expect(screen.getByTestId('escalation-badge').querySelector('a')).toBeNull();
    expect(screen.queryByTestId('escalation-request-state')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open MR-/ })).not.toBeInTheDocument();
  });

  it('a cancelled request the reader can see: the badge says so (once), and Escalate is offered again', async () => {
    get.mockResolvedValue(
      detail({
        escalation: escalated({
          requestCancelled: true,
          request: { status: 'cancelled', draftOpened: false, cancelled: true },
        }),
        canEscalate: true,
        escalateUnavailableReason: null,
      }),
    );
    await renderPage();
    expect(screen.getByTestId('escalation-badge')).toHaveTextContent('Escalated: MR-2026-000014 (request cancelled)');
    expect(screen.getByTestId('escalation-status')).toHaveTextContent('Escalated: MR-2026-000014 (request cancelled)');
    expect(screen.queryByTestId('escalation-request-state')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Escalate to maintenance' })).toBeInTheDocument();
  });

  // The experience review: once the linked request was cancelled, a staff
  // member or viewer who did not make it (and cannot open it) was still told
  // it was live and could not escalate again.
  it('NOT THE REQUESTER, AFTER A CANCEL: the badge says the request was cancelled, links nowhere, and Escalate is offered again', async () => {
    get.mockResolvedValue(
      detail({
        escalation: escalated({ requestCancelled: true, visibleToReader: false, request: null }),
        canEscalate: true,
        escalateUnavailableReason: null,
      }),
    );
    await renderPage();
    const badge = screen.getByTestId('escalation-badge');
    expect(badge).toHaveTextContent('Escalated: MR-2026-000014 (request cancelled)');
    expect(badge.querySelector('a')).toBeNull();
    expect(screen.getByRole('link', { name: 'Escalate to maintenance' })).toHaveAttribute(
      'href',
      `/dashboard/maintenance/new?exceptionOccurrenceId=${ID}`,
    );
    expect(screen.queryByTestId('escalate-unavailable')).not.toBeInTheDocument();
  });

  it('with the module off, the handle still shows but links nowhere (the request page would say not enabled)', async () => {
    get.mockResolvedValue(
      detail({ escalation: escalated(), canEscalate: false, escalateUnavailableReason: 'module_disabled' }),
    );
    await renderPage();
    expect(screen.getByTestId('escalation-badge')).toHaveTextContent('Escalated: MR-2026-000014');
    expect(screen.getByTestId('escalation-badge').querySelector('a')).toBeNull();
    expect(screen.queryByRole('link', { name: /Open MR-|Escalate to maintenance/ })).not.toBeInTheDocument();
  });

  it('escalating neither acknowledges nor resolves: the state stays Open and Acknowledge is still offered', async () => {
    get.mockResolvedValue(
      detail({ escalation: escalated(), canEscalate: false, escalateUnavailableReason: 'already_escalated' }),
    );
    await renderPage();
    expect(screen.getByTestId('occurrence-state')).toHaveTextContent('Open');
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
  });

  // Mutation caught: the timeline built without maintenanceRequestReference.
  it('the escalated timeline entry names the request and who escalated it', async () => {
    get.mockResolvedValue(
      detail({ escalation: escalated(), canEscalate: false, escalateUnavailableReason: 'already_escalated' }, {
        timeline: [
          { id: 'e1', kind: 'raised', at: '2026-09-24T15:00:00Z', actor: null, note: null, cycleCount: null, maintenanceRequestId: null, maintenanceRequestReference: null, evidenceId: null },
          { id: 'e2', kind: 'escalated', at: '2026-09-24T17:00:00Z', actor: { id: 'u1', label: 'Dana Lee' }, note: null, cycleCount: null, maintenanceRequestId: REQ, maintenanceRequestReference: 'MR-2026-000014', evidenceId: null },
        ],
      }),
    );
    await renderPage();
    expect(screen.getByText('Escalated to maintenance request MR-2026-000014 by Dana Lee')).toBeInTheDocument();
  });

  it('never says "sent" or "ticket" about an escalation', async () => {
    get.mockResolvedValue(
      detail({
        escalation: escalated({ request: { status: 'draft_opened', draftOpened: true, cancelled: false } }),
        canEscalate: false,
        escalateUnavailableReason: 'already_escalated',
      }),
    );
    await renderPage();
    expect(screen.getByTestId('escalation-card').textContent).not.toMatch(/\bsent\b|ticket|notified/i);
    expect(screen.getByTestId('escalation-badge').textContent).not.toMatch(/\bsent\b|ticket|notified/i);
  });
});
