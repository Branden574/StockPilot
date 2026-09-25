// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A count's linked exceptions on the web count page (F1-2):
 *   - a failed read says unavailable (role="alert"), never nothing: a missing
 *     block on a recount would read as "this count settles no exception";
 *   - a count no exception is linked to renders nothing;
 *   - while the count is open each linked line says where its difference
 *     lands when posted, or that it is not counted yet;
 *   - once closed, what the count came to;
 *   - a reader who may not read exceptions sees nothing (not an error).
 */

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
const listForCount = vi.fn();
vi.mock('@/server/services/exception-occurrences', () => ({
  ExceptionOccurrencesService: class {
    listForCount = listForCount;
  },
}));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(async () => ({ organizationId: 'org-1', role: 'staff' })),
}));
const reportError = vi.fn();
vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

import { ServiceError } from '@/server/services/context';

import { LinkedExceptionsBlock, LinkedExceptionsView } from './linked-exceptions-block';

const SYNCED = {
  trackingStartedAt: '2026-09-24T15:00:00Z',
  lastEvaluatedAt: '2026-09-25T18:00:00Z',
  lastSyncedAt: '2026-09-25T18:00:02Z',
  completeRules: [],
  failedRules: [],
  truncatedRules: [],
  unrecognizedUncheckedRules: 0,
};

function occurrence(o: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    number: 1,
    reference: 'EX-000001',
    rule: 'count_variance',
    itemId: 'item-1',
    item: { name: 'QA Chromebook', sku: 'QA-1' },
    locationId: null,
    location: null,
    warehouseId: 'wh-1',
    facts: {
      itemName: 'QA Chromebook',
      sku: 'QA-1',
      cycleCountId: 'cc-1',
      countNumber: 1,
      observedAt: '2026-09-25T17:00:00Z',
      completedAt: '2026-09-25T17:05:00Z',
      expected: 20,
      counted: 21,
      variance: 1,
      countedLocationName: null,
      aiAssisted: false,
      capturedOfflineAt: null,
    },
    conditionSince: '2026-09-25T17:00:00Z',
    firstSeenAt: '2026-09-25T17:10:00Z',
    lastSeenAt: '2026-09-25T18:00:00Z',
    presentWhenTrackingBegan: false,
    acknowledgedAt: null,
    acknowledgedBy: null,
    recount: {
      cycleCountId: 'cc-2',
      countNumber: 2,
      status: 'in_progress',
      completedAt: null,
      outcome: { kind: 'in_progress', counted: 1, total: 1 },
    },
    resolvedAt: null,
    resolvedReason: null,
    previousOccurrenceId: null,
    recurrenceIndex: 0,
    canAct: true,
    canRecount: false,
    ...o,
  };
}

function linked(o: Record<string, unknown> = {}) {
  return {
    cycleCountId: 'cc-2',
    countNumber: 2,
    reference: 'CC-000002',
    status: 'in_progress',
    exceptions: [
      {
        occurrence: occurrence(),
        active: true,
        line: {
          id: 'line-1',
          countedQuantity: 21,
          expectedQuantity: 20,
          countedLocationId: 'loc-1',
          countedLocation: { name: '12-A', kind: 'rack', archived: false },
        },
        outcome: { kind: 'in_progress', counted: 1, total: 1 },
        destination: { kind: 'adds_to_location', location: 'Rack 12-A' },
        reviewLine: 'Counted 21, book 20 (+1): adds to Rack 12-A',
      },
    ],
    unrecognized: 0,
    syncState: SYNCED,
    timeZone: 'America/Los_Angeles',
    ...o,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('LinkedExceptionsView', () => {
  it('a failed read says unavailable, never nothing', () => {
    render(<LinkedExceptionsView linked={null} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Linked exceptions are unavailable right now.');
  });

  it('renders nothing when no exception is linked', () => {
    const { container } = render(
      <LinkedExceptionsView linked={linked({ exceptions: [] }) as never} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('open count: each linked line says where its difference lands', () => {
    render(<LinkedExceptionsView linked={linked() as never} />);
    expect(screen.getByRole('link', { name: /EX-000001/ })).toHaveAttribute(
      'href',
      '/dashboard/exceptions/11111111-1111-4111-8111-111111111111',
    );
    expect(screen.getByTestId('linked-exception-result')).toHaveTextContent(
      'Counted 21, book 20 (+1): adds to Rack 12-A',
    );
    expect(screen.getByTestId('occurrence-state')).toHaveTextContent('Recount in progress (CC-000002)');
  });

  it('open count, line not counted yet: says so', () => {
    const l = linked();
    const x = (l.exceptions as Array<Record<string, unknown>>)[0]!;
    x.reviewLine = null;
    x.destination = null;
    x.line = { id: 'line-1', countedQuantity: null, expectedQuantity: 20, countedLocationId: null, countedLocation: null };
    render(<LinkedExceptionsView linked={l as never} />);
    expect(screen.getByTestId('linked-exception-result')).toHaveTextContent('Not counted yet');
  });

  it('closed count: what it came to', () => {
    const l = linked({ status: 'completed' });
    const x = (l.exceptions as Array<Record<string, unknown>>)[0]!;
    x.outcome = { kind: 'matched', quantity: 21 };
    render(<LinkedExceptionsView linked={l as never} />);
    expect(screen.getByTestId('linked-exception-result')).toHaveTextContent('Matched the book (21)');
  });

  it('counts linked rows this build cannot word, instead of hiding them', () => {
    render(<LinkedExceptionsView linked={linked({ exceptions: [], unrecognized: 2 }) as never} />);
    expect(screen.getByTestId('linked-exceptions')).toHaveTextContent('2 more open exceptions cannot be shown');
  });
});

describe('LinkedExceptionsBlock', () => {
  it('reads the count’s links through the service', async () => {
    listForCount.mockResolvedValue(linked());
    render(await LinkedExceptionsBlock({ cycleCountId: 'cc-2' }));
    expect(listForCount).toHaveBeenCalledWith('cc-2');
    expect(screen.getByTestId('linked-exceptions')).toBeInTheDocument();
  });

  // Mutation caught: the catch returning null (nothing) for every failure.
  it('a failed read is reported and shown as unavailable', async () => {
    listForCount.mockRejectedValue(new ServiceError('internal_error', 'boom'));
    render(await LinkedExceptionsBlock({ cycleCountId: 'cc-2' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Linked exceptions are unavailable right now.');
    expect(reportError).toHaveBeenCalled();
  });

  it('a reader who may not read exceptions sees nothing', async () => {
    listForCount.mockRejectedValue(new ServiceError('forbidden', 'no'));
    const out = await LinkedExceptionsBlock({ cycleCountId: 'cc-2' });
    expect(out).toBeNull();
  });
});
