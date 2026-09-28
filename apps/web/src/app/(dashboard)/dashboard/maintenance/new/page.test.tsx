import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ESCALATE_TO_MAINTENANCE_HELP,
  ESCALATION_EXCEPTION_UNAVAILABLE_COPY,
  ESCALATION_FORM_NOTE_COPY,
  escalationPrefill,
  MAINTENANCE_CATEGORIES,
  escalationSourceLines,
} from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The New maintenance request page, and its escalation form (F1-5).
 *
 * Escalating (?exceptionOccurrenceId=): the exception is read through the
 * reader's own service (not found and not visible are one 404; a malformed id
 * is a 404 without a read); the form is prefilled by core escalationPrefill
 * from that exception, shows what the request will be linked to, and saves
 * through the escalation client, never the plain one. A failed read offers
 * no form (a plain request would not be linked). An exception that cannot be
 * escalated says why, and one already escalated offers its request only to a
 * reader who can open it.
 *
 * Plain (no exception): unchanged, plus ?locationId= as a related-location
 * deep-link hint (create() re-derives it against the organization).
 */

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const moduleAccess = vi.hoisted(() => ({ current: { enabled: true, canManage: false } }));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => moduleAccess.current),
}));
vi.mock('@/components/dashboard/module-not-enabled', () => ({
  ModuleNotEnabled: () => <div data-testid="module-not-enabled" />,
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(),
}));

const { listCharters, getOccurrence, escalateProps, plainProps } = vi.hoisted(() => ({
  listCharters: vi.fn(),
  getOccurrence: vi.fn(),
  escalateProps: vi.fn(),
  plainProps: vi.fn(),
}));
vi.mock('@/server/services/charters', () => ({
  ChartersService: class {
    list = listCharters;
  },
}));
vi.mock('@/server/services/exception-occurrences', () => ({
  ExceptionOccurrencesService: class {
    get = getOccurrence;
  },
}));
vi.mock('./escalate-request-client', () => ({
  EscalateRequestClient: (props: Record<string, unknown>) => {
    escalateProps(props);
    return <div data-testid="escalate-form" />;
  },
}));
vi.mock('./new-request-client', () => ({
  NewMaintenanceRequestClient: (props: Record<string, unknown>) => {
    plainProps(props);
    return <div data-testid="plain-form" />;
  },
}));

import { reportError } from '@/lib/error-reporter';
import { ServiceError, withContext } from '@/server/services/context';

import NewMaintenanceRequestPage from './page';

const OCC = '11111111-1111-4111-8111-111111111111';
const REQ = '44444444-4444-4444-8444-444444444444';
const LOC = '55555555-5555-4555-8555-555555555555';
const NINE_DAYS_AGO = new Date(Date.now() - 9 * 86_400_000 - 60_000).toISOString();

function occurrence(o: Record<string, unknown> = {}) {
  return {
    id: OCC,
    number: 42,
    reference: 'EX-000042',
    rule: 'stale_staging',
    itemId: 'item-1',
    item: { name: 'Atlas', sku: 'A1' },
    locationId: 'loc-1',
    // Renamed since the check stored its facts: the live name is the one the
    // request names.
    location: { name: 'Staging North', kind: 'staging', archived: false },
    warehouseId: 'wh-1',
    facts: { itemName: 'Atlas', sku: 'A1', units: 12, locationName: 'Staging', locationKind: 'staging' },
    conditionSince: NINE_DAYS_AGO,
    resolvedAt: null,
    escalation: null,
    canEscalate: true,
    escalateUnavailableReason: null,
    ...o,
  };
}

function ctxWith(categories: unknown = undefined, permissions: string[] = ['maintenance_requests:submit', 'items:read']) {
  const stub = makeSupabaseStub({
    'organization_modules.select': {
      data: categories === undefined ? { settings: {} } : { settings: { categories } },
      error: null,
    },
    'user_warehouse_assignments.select': { data: { charter_id: null, warehouse_id: null }, error: null },
  });
  return makeServiceContext(stub.client, { role: 'staff', permissions: new Set(permissions) });
}

async function renderPage(searchParams: Record<string, string>) {
  return render(await NewMaintenanceRequestPage({ searchParams: Promise.resolve(searchParams) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  moduleAccess.current = { enabled: true, canManage: false };
  listCharters.mockResolvedValue([]);
  vi.mocked(withContext).mockResolvedValue(ctxWith() as never);
});

describe('escalating an exception (?exceptionOccurrenceId=)', () => {
  it('the linked-exception lines are core\'s, the same words as the phone (an archived location says so)', async () => {
    getOccurrence.mockResolvedValue({
      occurrence: occurrence({ location: { name: 'Staging North', kind: 'staging', archived: true } }),
    });
    await renderPage({ exceptionOccurrenceId: OCC });
    const linked = screen.getByTestId('escalation-linked-exception');
    const lines = escalationSourceLines({
      reference: 'EX-000042',
      rule: 'stale_staging',
      item: { name: 'Atlas', sku: 'A1' },
      location: { name: 'Staging North', archived: true },
    });
    expect(within(linked).getByTestId('escalation-linked-heading')).toHaveTextContent(lines.heading);
    expect(within(linked).getByTestId('escalation-linked-item')).toHaveTextContent(lines.item!);
    expect(within(linked).getByTestId('escalation-linked-location')).toHaveTextContent('Staging North (archived)');
  });

  it('prefills the form from the exception, shows what it links to, and saves through the escalation client', async () => {
    getOccurrence.mockResolvedValue({ occurrence: occurrence() });
    await renderPage({ exceptionOccurrenceId: OCC });

    expect(getOccurrence).toHaveBeenCalledWith(OCC);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Escalate to maintenance');
    expect(screen.getByText(ESCALATE_TO_MAINTENANCE_HELP)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Back to the exception' })).toHaveAttribute(
      'href',
      `/dashboard/exceptions/${OCC}`,
    );

    const linked = screen.getByTestId('escalation-linked-exception');
    expect(linked).toHaveTextContent('EX-000042');
    expect(linked).toHaveTextContent('Atlas (A1)');
    expect(linked).toHaveTextContent('Staging North');
    expect(linked).toHaveTextContent(ESCALATION_FORM_NOTE_COPY);

    expect(screen.getByTestId('escalate-form')).toBeInTheDocument();
    expect(screen.queryByTestId('plain-form')).toBeNull();
    const props = escalateProps.mock.calls[0]![0] as {
      occurrenceId: string;
      defaults: Record<string, unknown>;
      categories: string[];
    };
    expect(props.occurrenceId).toBe(OCC);
    const expected = escalationPrefill({
      rule: 'stale_staging',
      facts: occurrence().facts,
      itemName: 'Atlas',
      sku: 'A1',
      locationName: 'Staging North',
      reference: 'EX-000042',
      conditionSince: NINE_DAYS_AGO,
    });
    expect(props.defaults).toEqual({
      subject: expected.subject,
      description: expected.description,
      priority: 'normal',
      category: 'Inventory or equipment',
    });
    expect(props.defaults.subject).toBe('Inventory issue: Atlas (A1)');
    expect(props.defaults.description).toContain('Location: Staging North.');
    expect(props.defaults.description).toContain('Ref EX-000042.');
    // No site, warehouse or related ids ride in the defaults: the server
    // takes the item and location from the exception.
    for (const key of ['charterId', 'warehouseId', 'relatedItemId', 'relatedLocationId']) {
      expect(props.defaults).not.toHaveProperty(key);
    }
    expect(props.categories).toEqual([...MAINTENANCE_CATEGORIES]);
    // The plain form's site picker is not read for an escalation.
    expect(listCharters).not.toHaveBeenCalled();
  });

  it('the suggested category only when the organization lists it', async () => {
    vi.mocked(withContext).mockResolvedValue(ctxWith(['Facilities', 'Other']) as never);
    getOccurrence.mockResolvedValue({ occurrence: occurrence() });
    await renderPage({ exceptionOccurrenceId: OCC });
    const props = escalateProps.mock.calls[0]![0] as { defaults: Record<string, unknown>; categories: string[] };
    expect(props.defaults).not.toHaveProperty('category');
    expect(props.categories).toEqual(['Facilities', 'Other']);
  });

  it('a malformed exception id is a 404 without a read, never a plain request', async () => {
    await expect(renderPage({ exceptionOccurrenceId: 'not-an-id' })).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(renderPage({ exceptionOccurrenceId: '' })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(getOccurrence).not.toHaveBeenCalled();
    expect(plainProps).not.toHaveBeenCalled();
  });

  it.each(['not_found', 'forbidden'])('an exception the reader cannot see (%s) is a 404', async (code) => {
    getOccurrence.mockRejectedValue(new ServiceError(code as 'not_found', 'Exception not found.'));
    await expect(renderPage({ exceptionOccurrenceId: OCC })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  // Mutation caught: a failed read falling back to the plain form (the
  // request would be saved unlinked, and the exception never escalated).
  it('a failed read offers no form, says so, and is reported', async () => {
    getOccurrence.mockRejectedValue(new ServiceError('internal_error', 'read failed'));
    await renderPage({ exceptionOccurrenceId: OCC });
    expect(screen.getByRole('alert')).toHaveTextContent(ESCALATION_EXCEPTION_UNAVAILABLE_COPY);
    expect(screen.queryByTestId('escalate-form')).toBeNull();
    expect(screen.queryByTestId('plain-form')).toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(ServiceError),
      expect.objectContaining({ tag: 'maintenance.escalate_form_read' }),
    );
  });

  it('a resolved exception says it can no longer be escalated, and offers no form', async () => {
    getOccurrence.mockResolvedValue({
      occurrence: occurrence({ resolvedAt: '2026-09-27T12:00:00Z', canEscalate: false, escalateUnavailableReason: 'resolved' }),
    });
    await renderPage({ exceptionOccurrenceId: OCC });
    expect(screen.getByTestId('escalation-not-available')).toHaveTextContent(
      'This exception is resolved, so it can no longer be escalated.',
    );
    expect(screen.queryByTestId('escalate-form')).toBeNull();
  });

  const ESCALATION = {
    requestId: REQ,
    requestNumber: 14,
    reference: 'MR-2026-000014',
    escalatedAt: '2026-09-27T12:00:00Z',
    escalatedBy: { id: 'u1', label: 'Dana Lee' },
    visibleToReader: true,
    request: { status: 'saved', draftOpened: false, cancelled: false },
  };

  it('already escalated, and the reader can open the request: no form, and the request is offered instead', async () => {
    getOccurrence.mockResolvedValue({
      occurrence: occurrence({ escalation: ESCALATION, canEscalate: false, escalateUnavailableReason: 'already_escalated' }),
    });
    await renderPage({ exceptionOccurrenceId: OCC });
    expect(screen.queryByTestId('escalate-form')).toBeNull();
    expect(screen.getByTestId('escalation-not-available')).toHaveTextContent(
      'Already escalated to MR-2026-000014. A new request can be made only if that one is cancelled.',
    );
    expect(screen.getByRole('link', { name: 'Open MR-2026-000014' })).toHaveAttribute(
      'href',
      `/dashboard/maintenance/${REQ}`,
    );
  });

  // Mutation caught: the Open link offered without visibleToReader (a 404).
  it('already escalated, and the reader cannot open the request: why, and no link', async () => {
    getOccurrence.mockResolvedValue({
      occurrence: occurrence({
        escalation: { ...ESCALATION, visibleToReader: false, request: null },
        canEscalate: false,
        escalateUnavailableReason: 'already_escalated',
      }),
    });
    await renderPage({ exceptionOccurrenceId: OCC });
    expect(screen.getByTestId('escalation-not-available')).toHaveTextContent('Already escalated to MR-2026-000014.');
    expect(screen.queryByRole('link', { name: /Open MR-/ })).toBeNull();
  });

  it('the module off: the page says not enabled and reads nothing', async () => {
    moduleAccess.current = { enabled: false, canManage: false };
    await renderPage({ exceptionOccurrenceId: OCC });
    expect(screen.getByTestId('module-not-enabled')).toBeInTheDocument();
    expect(getOccurrence).not.toHaveBeenCalled();
  });

  it('a reader without maintenance_requests:submit is sent to the list before any read', async () => {
    vi.mocked(withContext).mockResolvedValue(ctxWith(undefined, ['items:read']) as never);
    await expect(renderPage({ exceptionOccurrenceId: OCC })).rejects.toThrow('NEXT_REDIRECT /dashboard/maintenance');
    expect(getOccurrence).not.toHaveBeenCalled();
  });
});

describe('a plain request', () => {
  it('is unchanged: the plain form, with ?locationId= as a related-location hint', async () => {
    await renderPage({ itemId: 'item-x', locationId: LOC, subject: 'Shelf is loose' });
    expect(screen.getByTestId('plain-form')).toBeInTheDocument();
    expect(screen.queryByTestId('escalate-form')).toBeNull();
    const props = plainProps.mock.calls[0]![0] as { defaults: Record<string, unknown> };
    expect(props.defaults).toMatchObject({ subject: 'Shelf is loose', relatedLocationId: LOC });
    // A malformed item id is dropped (the same rule as before).
    expect(props.defaults.relatedItemId).toBeUndefined();
    expect(getOccurrence).not.toHaveBeenCalled();
    expect(listCharters).toHaveBeenCalledTimes(1);
  });

  it('a malformed locationId is dropped', async () => {
    await renderPage({ locationId: 'nope' });
    const props = plainProps.mock.calls[0]![0] as { defaults: Record<string, unknown> };
    expect(props.defaults.relatedLocationId).toBeUndefined();
  });
});
