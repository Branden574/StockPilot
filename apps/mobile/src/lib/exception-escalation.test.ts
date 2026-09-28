import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ESCALATE_MODULE_OFF_COPY,
  ESCALATE_NOT_PERMITTED_COPY,
  ESCALATE_OFFLINE_COPY,
  ESCALATE_RESOLVED_COPY,
  ESCALATION_IN_PROGRESS_COPY,
  ESCALATION_NOT_LINKED_COPY,
  escalationAlreadyEscalatedCopy,
  escalationDuplicateCopy,
} from '@stockpilot/core';

import { REQUEST_TIMED_OUT_COPY } from './connection-copy';
import * as escalation from './exception-escalation';
import {
  describeEscalateError,
  duplicateOutcome,
  ESCALATE_SERVER_PROBLEM_COPY,
  ESCALATE_TIMEOUT_MS,
  ESCALATE_UNAVAILABLE_COPY,
  ESCALATE_UNCONFIRMED_COPY,
  escalateException,
  escalateFormRoute,
  escalationFormPrefill,
  escalationFormState,
  escalationSectionView,
  escalationSourceLines,
  escalationTarget,
  EscalationAnswerError,
  listedCategory,
  openableRequestId,
  parseEscalation,
  uuidParam,
  type EscalatableOccurrence,
  type EscalationSource,
  type MobileOccurrenceEscalation,
} from './exception-escalation';
import { getException, listExceptions } from './exceptions-api';

/**
 * Escalate to maintenance on the phone (F1-5). The decisions behind the
 * exception screen's MAINTENANCE section and the escalating request form,
 * tested here because the screens cannot render under node (their wiring is
 * pinned in exception-escalation-wiring.test.ts). Each test names the wrong
 * code it fails on.
 */

const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

beforeEach(() => {
  apiMock.api.mockReset();
});

const OCC = '11111111-1111-4111-8111-111111111111';
const REQ = '33333333-3333-4333-8333-333333333333';
const OTHER_REQ = '44444444-4444-4444-8444-444444444444';
const LOC = '55555555-5555-4555-8555-555555555555';

function esc(o: Partial<MobileOccurrenceEscalation> = {}): MobileOccurrenceEscalation {
  return {
    requestId: REQ,
    requestNumber: 14,
    reference: 'MR-2026-000014',
    escalatedAt: '2026-09-27T18:00:00Z',
    escalatedBy: { id: 'u1', label: 'Dana Keeler' },
    visibleToReader: true,
    request: { status: 'saved', draftOpened: false, cancelled: false },
    ...o,
  };
}

function occ(o: Partial<EscalatableOccurrence> = {}): EscalatableOccurrence {
  return { resolvedAt: null, canEscalate: true, escalateUnavailableReason: null, escalation: null, ...o };
}

function source(o: Partial<EscalationSource> = {}): EscalationSource {
  return {
    id: OCC,
    reference: 'EX-000042',
    rule: 'stale_staging',
    facts: { units: 12, locationName: 'Staging', days: 9 },
    item: { name: 'Atlas', sku: 'A1' },
    location: { name: 'Staging', archived: false },
    conditionSince: '2026-09-18T00:00:00Z',
    ...occ(),
    ...o,
  };
}

/** An ApiError-shaped rejection (the real class lives in the mocked ./api). */
function apiError(status: number, message: string, details?: unknown, code?: string) {
  return Object.assign(new Error(message), { status, details, code });
}

// ── Parsing ─────────────────────────────────────────────────────────────────

describe('parseEscalation', () => {
  it('reads the escalation block the server sends', () => {
    expect(
      parseEscalation({
        requestId: REQ,
        requestNumber: 14,
        reference: 'MR-2026-000014',
        escalatedAt: '2026-09-27T18:00:00Z',
        escalatedBy: { id: 'u1', label: 'Dana Keeler' },
        visibleToReader: true,
        request: { status: 'draft_opened', draftOpened: true, cancelled: false },
      }),
    ).toEqual(esc({ request: { status: 'draft_opened', draftOpened: true, cancelled: false } }));
  });

  it('null for an occurrence never escalated, or a block without its number or time (a badge is never guessed)', () => {
    expect(parseEscalation(null)).toBeNull();
    expect(parseEscalation(undefined)).toBeNull();
    expect(parseEscalation({ requestId: REQ, escalatedAt: '2026-09-27T18:00:00Z' })).toBeNull();
    expect(parseEscalation({ requestNumber: 14 })).toBeNull();
    expect(parseEscalation({ requestNumber: 0, escalatedAt: '2026-09-27T18:00:00Z' })).toBeNull();
  });

  // Mutation caught: `draftOpened: r.draftOpened === true` with the request
  // kept on a malformed block ("Email draft not yet opened" on a guess).
  it('keeps the request state only when both flags are real booleans', () => {
    const base = { requestId: REQ, requestNumber: 14, reference: null, escalatedAt: '2026-09-27T18:00:00Z' };
    expect(parseEscalation({ ...base, request: { status: 'saved', draftOpened: 'yes', cancelled: false } })?.request).toBeNull();
    expect(parseEscalation({ ...base, request: { status: 'saved', draftOpened: true } })?.request).toBeNull();
    expect(parseEscalation({ ...base, request: null })?.request).toBeNull();
  });

  // Mutation caught: `visibleToReader: v.visibleToReader !== false` (a list
  // read's null would then link the badge).
  it('visibleToReader is true or false only when the server said so, else null', () => {
    const base = { requestId: REQ, requestNumber: 14, reference: null, escalatedAt: '2026-09-27T18:00:00Z' };
    expect(parseEscalation({ ...base, visibleToReader: true })?.visibleToReader).toBe(true);
    expect(parseEscalation({ ...base, visibleToReader: false })?.visibleToReader).toBe(false);
    expect(parseEscalation({ ...base, visibleToReader: null })?.visibleToReader).toBeNull();
    expect(parseEscalation({ ...base })?.visibleToReader).toBeNull();
    expect(parseEscalation({ ...base, visibleToReader: 'true' })?.visibleToReader).toBeNull();
  });

  it('a request id that is not a uuid (or a deleted request) links nothing', () => {
    const base = { requestNumber: 14, reference: null, escalatedAt: '2026-09-27T18:00:00Z' };
    expect(parseEscalation({ ...base, requestId: '../../admin' })?.requestId).toBeNull();
    expect(parseEscalation({ ...base, requestId: null })?.requestId).toBeNull();
  });
});

describe('the exceptions reads carry the escalation', () => {
  const occurrenceRow = (o: Record<string, unknown> = {}) => ({
    id: OCC,
    number: 42,
    reference: 'EX-000042',
    rule: 'stale_staging',
    itemId: '22222222-2222-4222-8222-222222222222',
    item: { name: 'Atlas', sku: 'A1' },
    locationId: LOC,
    location: { name: 'Staging', kind: 'staging', archived: false },
    facts: {},
    firstSeenAt: '2026-09-24T15:00:00Z',
    lastSeenAt: '2026-09-24T18:00:00Z',
    resolvedAt: null,
    recurrenceIndex: 0,
    canAct: true,
    ...o,
  });

  it('the list parses escalation, canEscalate and the reason', async () => {
    apiMock.api.mockResolvedValueOnce({
      organizationId: 'org-1',
      status: 'open',
      occurrences: [
        occurrenceRow({
          escalation: { requestId: REQ, requestNumber: 14, reference: 'MR-2026-000014', escalatedAt: '2026-09-27T18:00:00Z', visibleToReader: null, request: null },
          canEscalate: false,
          escalateUnavailableReason: 'already_escalated',
        }),
      ],
      truncated: false,
      syncState: null,
    });
    const list = await listExceptions('open');
    const o = list.occurrences[0]!;
    expect(o.escalation?.reference).toBe('MR-2026-000014');
    expect(o.escalation?.visibleToReader).toBeNull();
    expect(o.canEscalate).toBe(false);
    expect(o.escalateUnavailableReason).toBe('already_escalated');
  });

  // Mutation caught: `canEscalate: v.canEscalate !== false` (an older server
  // that sends nothing would be offered the button).
  it('canEscalate is true only when the server said so; an unknown reason is dropped', async () => {
    apiMock.api.mockResolvedValueOnce({
      organizationId: 'org-1',
      status: 'open',
      occurrences: [occurrenceRow(), occurrenceRow({ id: 'b', canEscalate: 'true', escalateUnavailableReason: 'a_future_reason' })],
      truncated: false,
      syncState: null,
    });
    const list = await listExceptions('open');
    expect(list.occurrences.map((o) => o.canEscalate)).toEqual([false, false]);
    expect(list.occurrences.map((o) => o.escalateUnavailableReason)).toEqual([null, null]);
    expect(list.occurrences.map((o) => o.escalation)).toEqual([null, null]);
  });

  it('an escalated timeline event carries the request handle; other events never do', async () => {
    apiMock.api.mockResolvedValueOnce({
      organizationId: 'org-1',
      occurrence: occurrenceRow({ canEscalate: true }),
      timeline: [
        { id: 'e1', kind: 'escalated', at: '2026-09-27T18:00:00Z', actor: { id: 'u1', label: 'Dana' }, maintenanceRequestReference: 'MR-2026-000014' },
        { id: 'e2', kind: 'note', at: '2026-09-27T18:01:00Z', note: 'x', maintenanceRequestReference: 'MR-2026-000099' },
        { id: 'e3', kind: 'escalated', at: '2026-09-27T18:02:00Z' },
      ],
      history: [],
      syncState: null,
      evidence: { status: 'unavailable' },
    });
    const detail = await getException(OCC);
    expect(detail.timeline.map((e) => e.maintenanceRequestReference)).toEqual(['MR-2026-000014', null, null]);
    expect(detail.occurrence.canEscalate).toBe(true);
  });
});

// ── The exception screen's MAINTENANCE section ─────────────────────────────

describe('escalationSectionView', () => {
  const view = (o: Partial<EscalatableOccurrence>, g: Partial<{ maintenanceEnabled: boolean; canSubmit: boolean; online: boolean }> = {}) =>
    escalationSectionView({ occurrence: occ(o), maintenanceEnabled: true, canSubmit: true, online: true, ...g });

  it('offers the button on an open exception both gates allow, enabled online', () => {
    const v = view({});
    expect(v).toMatchObject({ show: true, offerButton: true, buttonDisabledReason: null, badge: null, note: null });
  });

  // Mutation caught: `online: true` passed to escalateDisabledReason, or the
  // offline check dropped (an offline tap would open a form that cannot save,
  // or worse, a queued attempt).
  it('offline, the button stays but is disabled with the reason', () => {
    const v = view({}, { online: false });
    expect(v.offerButton).toBe(true);
    expect(v.buttonDisabledReason).toBe(ESCALATE_OFFLINE_COPY);
  });

  // Mutation caught: dropping either local gate (the phone's module set or
  // maintenance_requests:submit), or the server's canEscalate.
  it('needs the server hint AND the phone\'s module and permission', () => {
    expect(view({}, { maintenanceEnabled: false })).toMatchObject({ show: false, offerButton: false });
    expect(view({}, { canSubmit: false })).toMatchObject({ show: false, offerButton: false });
    expect(view({ canEscalate: false })).toMatchObject({ show: false, offerButton: false });
    expect(view({ canEscalate: false, escalateUnavailableReason: 'module_disabled' })).toMatchObject({ show: false });
    expect(view({ canEscalate: false, escalateUnavailableReason: 'not_permitted' })).toMatchObject({ show: false });
  });

  // Mutation caught: offering the button on a resolved exception.
  it('a resolved exception is never offered; never escalated, the section is hidden', () => {
    expect(view({ resolvedAt: '2026-09-27T10:00:00Z' })).toMatchObject({ show: false, offerButton: false });
    const escalated = view({ resolvedAt: '2026-09-27T10:00:00Z', canEscalate: false, escalateUnavailableReason: 'resolved', escalation: esc() });
    expect(escalated).toMatchObject({ show: true, offerButton: false, badge: 'Escalated: MR-2026-000014' });
  });

  it('an escalated exception shows the badge, who, when, and what the request records to a reader who can open it', () => {
    const v = view({ canEscalate: false, escalateUnavailableReason: 'already_escalated', escalation: esc() });
    expect(v).toMatchObject({
      show: true,
      badge: 'Escalated: MR-2026-000014',
      escalatedBy: 'Dana Keeler',
      escalatedAt: '2026-09-27T18:00:00Z',
      requestState: 'Email draft not yet opened',
      openRequestId: REQ,
      offerButton: false,
      note: null,
    });
    expect(
      view({ canEscalate: false, escalateUnavailableReason: 'already_escalated', escalation: esc({ request: { status: 'draft_opened', draftOpened: true, cancelled: false } }) })
        .requestState,
    ).toBe('Email draft opened');
  });

  // Mutation caught: linking on visibleToReader !== false (null = not checked,
  // or the check failed: the web does not link then either).
  it('the badge opens the request only when the server confirmed the reader can open it', () => {
    for (const visibleToReader of [false, null] as const) {
      const v = view({ canEscalate: false, escalateUnavailableReason: 'already_escalated', escalation: esc({ visibleToReader, request: null }) });
      expect(v.openRequestId).toBeNull();
      expect(v.requestState).toBeNull();
      expect(v.badge).toBe('Escalated: MR-2026-000014');
      // Everyone else is told a new request needs that one cancelled.
      expect(v.note).toBe(escalationAlreadyEscalatedCopy('MR-2026-000014'));
    }
  });

  it('with the maintenance screens off (here or on the server) the badge stays, as text', () => {
    expect(view({ canEscalate: false, escalateUnavailableReason: 'already_escalated', escalation: esc() }, { maintenanceEnabled: false }).openRequestId).toBeNull();
    expect(view({ canEscalate: false, escalateUnavailableReason: 'module_disabled', escalation: esc() }).openRequestId).toBeNull();
    expect(view({ canEscalate: false, escalateUnavailableReason: 'module_disabled', escalation: esc() }).badge).toBe('Escalated: MR-2026-000014');
  });

  it('a cancelled request the reader can see frees the exception: the button is offered again beside "Request cancelled"', () => {
    const v = view({ canEscalate: true, escalation: esc({ request: { status: 'cancelled', draftOpened: false, cancelled: true } }) });
    expect(v).toMatchObject({ offerButton: true, requestState: 'Request cancelled', openRequestId: REQ, note: null });
  });

  it('a deleted request (no id) shows the badge and links nothing', () => {
    expect(view({ canEscalate: false, escalateUnavailableReason: 'already_escalated', escalation: esc({ requestId: null }) }).openRequestId).toBeNull();
  });
});

describe('escalateFormRoute', () => {
  it('opens the request form for this exception, with its location as a hint', () => {
    expect(escalateFormRoute({ id: OCC, locationId: LOC })).toEqual({
      pathname: '/maintenance/new',
      params: { exceptionOccurrenceId: OCC, locationId: LOC },
    });
    expect(escalateFormRoute({ id: OCC, locationId: null })).toEqual({
      pathname: '/maintenance/new',
      params: { exceptionOccurrenceId: OCC },
    });
  });
});

// ── The escalating form ────────────────────────────────────────────────────

describe('uuidParam', () => {
  it('a well-formed uuid, the first of a repeated key, else null', () => {
    expect(uuidParam(OCC)).toBe(OCC);
    expect(uuidParam([OCC, REQ])).toBe(OCC);
    expect(uuidParam('not-a-uuid')).toBeNull();
    expect(uuidParam('')).toBeNull();
    expect(uuidParam(undefined)).toBeNull();
  });
});

describe('escalationTarget', () => {
  // Mutation caught: a malformed exception param read as "no exception" (an
  // ordinary request, not linked to anything, where the person meant to
  // escalate).
  it('no param: an ordinary request; a uuid: escalate it; anything else: refused', () => {
    expect(escalationTarget(undefined)).toEqual({ kind: 'request' });
    expect(escalationTarget(OCC)).toEqual({ kind: 'escalate', occurrenceId: OCC });
    expect(escalationTarget([OCC])).toEqual({ kind: 'escalate', occurrenceId: OCC });
    expect(escalationTarget('abc')).toEqual({ kind: 'malformed' });
    expect(escalationTarget('')).toEqual({ kind: 'malformed' });
  });
});

describe('escalationFormState', () => {
  const state = (load: Parameters<typeof escalationFormState>[0]['load'], g: Partial<{ online: boolean; saving: boolean; maintenanceEnabled: boolean }> = {}) =>
    escalationFormState({ load, online: true, saving: false, maintenanceEnabled: true, ...g });

  // Mutation caught: showing the form before the exception loaded (a person
  // could save without seeing what they escalate).
  it('no form until the exception has loaded; offline says so', () => {
    expect(state({ kind: 'loading' })).toEqual({ showForm: false, saveEnabled: false, reason: null, openExisting: null });
    expect(state({ kind: 'loading' }, { online: false }).reason).toBe(ESCALATE_OFFLINE_COPY);
    expect(state({ kind: 'error', message: 'x' })).toMatchObject({ showForm: false, saveEnabled: false });
  });

  it('an exception that may be escalated shows the form; Save is enabled online and not while saving', () => {
    expect(state({ kind: 'ready', occurrence: source() })).toEqual({ showForm: true, saveEnabled: true, reason: null, openExisting: null });
    expect(state({ kind: 'ready', occurrence: source() }, { saving: true }).saveEnabled).toBe(false);
  });

  // Mutation caught: `online: true`, or saveEnabled ignoring the connection.
  it('offline, Save is disabled with the reason, and the typed form stays', () => {
    expect(state({ kind: 'ready', occurrence: source() }, { online: false })).toEqual({
      showForm: true,
      saveEnabled: false,
      reason: ESCALATE_OFFLINE_COPY,
      openExisting: null,
    });
  });

  it('resolved: no form, and why', () => {
    expect(state({ kind: 'ready', occurrence: source({ resolvedAt: '2026-09-27T10:00:00Z', canEscalate: true }) })).toMatchObject({
      showForm: false,
      saveEnabled: false,
      reason: ESCALATE_RESOLVED_COPY,
    });
  });

  it('already escalated: no form; the request opens for a reader who can open it', () => {
    const linked = source({ canEscalate: false, escalateUnavailableReason: 'already_escalated', escalation: esc() });
    expect(state({ kind: 'ready', occurrence: linked })).toEqual({
      showForm: false,
      saveEnabled: false,
      reason: escalationAlreadyEscalatedCopy('MR-2026-000014'),
      openExisting: { requestId: REQ, label: 'Open MR-2026-000014' },
    });
    const hidden = source({ canEscalate: false, escalateUnavailableReason: 'already_escalated', escalation: esc({ visibleToReader: false, request: null }) });
    expect(state({ kind: 'ready', occurrence: hidden }).openExisting).toBeNull();
    expect(state({ kind: 'ready', occurrence: linked }, { maintenanceEnabled: false }).openExisting).toBeNull();
  });

  it('not permitted or the module off: no form, core\'s reason; no reason from the server: never offered', () => {
    expect(state({ kind: 'ready', occurrence: source({ canEscalate: false, escalateUnavailableReason: 'not_permitted' }) }).reason).toBe(ESCALATE_NOT_PERMITTED_COPY);
    expect(state({ kind: 'ready', occurrence: source({ canEscalate: false, escalateUnavailableReason: 'module_disabled' }) }).reason).toBe(ESCALATE_MODULE_OFF_COPY);
    expect(state({ kind: 'ready', occurrence: source({ canEscalate: false }) })).toMatchObject({
      showForm: false,
      reason: ESCALATE_UNAVAILABLE_COPY,
    });
  });
});

describe('listedCategory', () => {
  // Mutation caught: sending the suggested category to an organization whose
  // list does not have it (the web leaves it out; the chip would not show).
  it('the chosen category only while the organization lists it', () => {
    expect(listedCategory(['Plumbing', 'Inventory or equipment'], 'Inventory or equipment')).toBe('Inventory or equipment');
    expect(listedCategory(['Plumbing', 'Electrical'], 'Inventory or equipment')).toBeNull();
    expect(listedCategory(['Plumbing'], null)).toBeNull();
  });
});

describe('the prefill and the linked-exception card', () => {
  it('comes from core: subject names the item and SKU, the description carries the reference, the category is suggested', () => {
    const p = escalationFormPrefill(source(), new Date('2026-09-27T12:00:00Z'));
    expect(p.subject).toBe('Inventory issue: Atlas (A1)');
    expect(p.description).toMatch(/Ref EX-000042\.$/);
    expect(p.description).toContain('Location: Staging.');
    expect(p.category).toBe('Inventory or equipment');
    expect(p.description).not.toContain('Atlas');
  });

  it('the card names the exception, its rule, item and location', () => {
    expect(escalationSourceLines(source())).toEqual({
      heading: 'EX-000042 · Sitting in Staging',
      item: 'Atlas (A1)',
      location: 'Staging',
    });
    expect(escalationSourceLines(source({ item: null, location: { name: 'Rack 9', archived: true }, reference: null }))).toEqual({
      heading: 'Sitting in Staging',
      item: null,
      location: 'Rack 9 (archived)',
    });
  });
});

// ── The request ────────────────────────────────────────────────────────────

describe('escalateException', () => {
  // Mutation caught: sending the form's other fields, or any item, location,
  // warehouse or site id (the server takes those from the exception).
  it('POSTs only the four fields a person fills in, with the longer timeout', async () => {
    apiMock.api.mockResolvedValueOnce({ id: REQ, requestNumber: 14, reference: 'MR-2026-000014', createdAt: '2026-09-27T18:00:00Z' });
    const res = await escalateException(OCC, { subject: 'Inventory issue: Atlas (A1)', description: 'Stale in Staging.', priority: 'normal', category: null });
    expect(res).toEqual({ id: REQ, requestNumber: 14, reference: 'MR-2026-000014', createdAt: '2026-09-27T18:00:00Z' });
    expect(apiMock.api).toHaveBeenCalledTimes(1);
    const [path, opts] = apiMock.api.mock.calls[0] as [string, { method: string; body: Record<string, unknown>; timeoutMs: number }];
    expect(path).toBe(`/api/v1/exceptions/${OCC}/escalate`);
    expect(opts.method).toBe('POST');
    expect(Object.keys(opts.body).sort()).toEqual(['category', 'description', 'priority', 'subject']);
    expect(opts.timeoutMs).toBe(ESCALATE_TIMEOUT_MS);
  });

  it('a bad id never reaches the server', async () => {
    await expect(escalateException('nope', { subject: 'x', description: 'y', priority: 'normal', category: null })).rejects.toThrow();
    expect(apiMock.api).not.toHaveBeenCalled();
  });

  // Mutation caught: a 2xx without the id read as a failure to retry (it WAS
  // saved), or as success with an undefined id (router.replace to
  // /maintenance/undefined).
  it('a 2xx it cannot read says the request was saved', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true });
    await expect(escalateException(OCC, { subject: 'x', description: 'y', priority: 'normal', category: null })).rejects.toBeInstanceOf(EscalationAnswerError);
    expect(describeEscalateError(new EscalationAnswerError())).toEqual({
      message: 'The request was saved, but the answer could not be read. Go back to the exception and pull down to see it.',
      duplicate: null,
      retryable: false,
    });
  });
});

describe('describeEscalateError', () => {
  it('already escalated (409 with the id): the linked request, in core\'s words', () => {
    const v = describeEscalateError(
      apiError(409, 'x', { reason: 'already_escalated', requestId: REQ, requestNumber: 14, reference: 'MR-2026-000014' }),
    );
    expect(v).toEqual({ message: escalationDuplicateCopy('MR-2026-000014'), duplicate: { requestId: REQ, reference: 'MR-2026-000014' }, retryable: false });
    // Without a usable id, nothing to open.
    expect(describeEscalateError(apiError(409, 'x', { reason: 'already_escalated', requestId: 'nope' })).duplicate).toBeNull();
  });

  it('the other refusals', () => {
    expect(describeEscalateError(apiError(409, 'x', { reason: 'escalation_in_progress', retryable: true }))).toEqual({
      message: ESCALATION_IN_PROGRESS_COPY,
      duplicate: null,
      retryable: true,
    });
    expect(describeEscalateError(apiError(409, 'x', { reason: 'occurrence_resolved' })).message).toBe(ESCALATE_RESOLVED_COPY);
    expect(describeEscalateError(apiError(409, 'x', { reason: 'escalation_not_claimed' })).message).toBe(ESCALATION_NOT_LINKED_COPY);
    expect(describeEscalateError(apiError(409, 'x', { reason: 'request_not_eligible' })).message).toBe(ESCALATION_NOT_LINKED_COPY);
    expect(describeEscalateError(apiError(409, 'This exception is busy. Try again in a moment.', { reason: 'busy', retryable: true }))).toEqual({
      message: 'This exception is busy. Try again in a moment.',
      duplicate: null,
      retryable: true,
    });
    // The maintenance create limit (a 409 with the server's sentence).
    expect(describeEscalateError(apiError(409, 'You have submitted too many requests recently.')).message).toBe(
      'You have submitted too many requests recently.',
    );
    expect(describeEscalateError(apiError(403, 'module_disabled', { reason: 'module_disabled' }, 'module_disabled')).message).toBe(ESCALATE_MODULE_OFF_COPY);
    expect(describeEscalateError(apiError(403, 'x', undefined, 'module_disabled')).message).toBe(ESCALATE_MODULE_OFF_COPY);
    expect(describeEscalateError(apiError(403, 'x', undefined, 'forbidden')).message).toBe(ESCALATE_NOT_PERMITTED_COPY);
    expect(describeEscalateError(apiError(404, 'x')).message).toBe('This exception is no longer available to you.');
    expect(describeEscalateError(apiError(429, 'rate_limited')).retryable).toBe(true);
    expect(describeEscalateError(apiError(400, 'Describe the issue in a few words (at least 5 characters).')).message).toBe(
      'Describe the issue in a few words (at least 5 characters).',
    );
  });

  // Mutation caught: a 5xx or a lost answer worded as "nothing was saved"
  // (the server may have saved a request it could not confirm).
  it('a 5xx or no answer never claims nothing was saved', () => {
    expect(describeEscalateError(apiError(500, 'internal_error'))).toEqual({
      message: ESCALATE_SERVER_PROBLEM_COPY,
      duplicate: null,
      retryable: false,
    });
    expect(describeEscalateError(new Error(REQUEST_TIMED_OUT_COPY))).toEqual({
      message: ESCALATE_UNCONFIRMED_COPY,
      duplicate: null,
      retryable: true,
    });
    expect(describeEscalateError(new TypeError('Network request failed')).message).toBe(ESCALATE_UNCONFIRMED_COPY);
  });
});

describe('duplicateOutcome (after a 409 already_escalated)', () => {
  const dup = { requestId: REQ, reference: 'MR-2026-000014' };
  const linked = (e: Partial<MobileOccurrenceEscalation> = {}) =>
    occ({ canEscalate: false, escalateUnavailableReason: 'already_escalated', escalation: esc(e) });

  it('opens the request for a reader who can open it', () => {
    expect(duplicateOutcome(dup, linked(), true)).toEqual({ kind: 'open', requestId: REQ, message: escalationDuplicateCopy('MR-2026-000014') });
  });

  // Mutation caught: always opening the 409's request (a reader who cannot
  // open it would land on an error).
  it('anyone else stays, told a new request needs that one cancelled', () => {
    const stay = { kind: 'stay', message: escalationAlreadyEscalatedCopy('MR-2026-000014') };
    expect(duplicateOutcome(dup, linked({ visibleToReader: false, request: null }), true)).toEqual(stay);
    expect(duplicateOutcome(dup, linked({ visibleToReader: null }), true)).toEqual(stay);
    expect(duplicateOutcome(dup, null, true)).toEqual(stay);
    expect(duplicateOutcome(dup, linked({ requestId: OTHER_REQ }), true)).toEqual(stay);
    expect(duplicateOutcome(dup, linked(), false)).toEqual(stay);
  });
});

describe('openableRequestId', () => {
  it('only a confirmed-visible request, with the maintenance screens on', () => {
    expect(openableRequestId(occ({ escalation: esc() }), true)).toBe(REQ);
    expect(openableRequestId(occ({ escalation: esc() }), false)).toBeNull();
    expect(openableRequestId(occ({ escalation: esc({ visibleToReader: null }) }), true)).toBeNull();
    expect(openableRequestId(occ({ escalation: null }), true)).toBeNull();
  });
});

// ── Honesty ────────────────────────────────────────────────────────────────

describe('wording', () => {
  // Owner rule: never "sent" or "ticket created"; never "book" for the
  // recorded quantity. Every sentence this module exports.
  it('no exported sentence claims a send, a ticket or a notification', () => {
    const sentences = Object.values(escalation as Record<string, unknown>).filter((v): v is string => typeof v === 'string');
    expect(sentences.length).toBeGreaterThan(4);
    for (const s of sentences) {
      expect(s).not.toMatch(/\bsent\b|\bsend\b|ticket|notified|emailed|delivered|\bbook\b/i);
    }
    for (const s of [
      escalationSectionView({ occurrence: occ({ escalation: esc() }), maintenanceEnabled: true, canSubmit: true, online: false }),
    ].flatMap((v) => [v.badge, v.requestState, v.note, v.buttonDisabledReason])) {
      if (s) expect(s).not.toMatch(/\bsent\b|ticket/i);
    }
  });
});
