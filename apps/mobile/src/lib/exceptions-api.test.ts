import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EXCEPTION_ACT_NOT_PERMITTED_COPY,
  EXCEPTION_ACT_OFFLINE_COPY,
  EXCEPTION_ACT_RESOLVED_COPY,
  recountResultSummary,
  recountUnavailableCopy,
} from '@stockpilot/core';

import {
  actOnException,
  clientEventIdFor,
  describeActError,
  describeExceptionsRequestError,
  exceptionActionRoute,
  exceptionSheetSubmit,
  ExceptionsResponseError,
  forgetRememberedExceptions,
  exceptionTimeLabel,
  getException,
  isOfflineState,
  listExceptions,
  newClientEventId,
  offlineAsOfCopy,
  recalledList,
  rememberList,
  requestExceptionCheck,
  describeRecountError,
  getCountLinkedExceptions,
  linkedLineDestination,
  parseCountLinkedExceptions,
  parseRecountResult,
  recountKeyFor,
  startRecount,
} from './exceptions-api';

// ./api reaches for expo-constants, AsyncStorage and the Supabase client at
// import time, none of which exist under node. Same idiom as
// cycle-counts-api.test.ts.
const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

beforeEach(() => {
  apiMock.api.mockReset();
  forgetRememberedExceptions();
});

const ID = '11111111-1111-4111-8111-111111111111';

function occurrence(o: Record<string, unknown> = {}) {
  return {
    id: ID,
    number: 42,
    reference: 'EX-000042',
    rule: 'label_mismatch',
    itemId: '22222222-2222-4222-8222-222222222222',
    item: { name: 'Atlas', sku: 'A1' },
    locationId: null,
    location: null,
    warehouseId: 'wh-1',
    facts: { label: '40-C', stockOn: ['39-C'] },
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

const SYNC = {
  trackingStartedAt: '2026-09-24T15:00:00Z',
  lastEvaluatedAt: '2026-09-24T18:00:00Z',
  lastSyncedAt: '2026-09-24T18:00:02Z',
  completeRules: ['label_mismatch'],
  failedRules: [],
  truncatedRules: [],
};

function listBody(o: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    status: 'open',
    occurrences: [occurrence()],
    truncated: false,
    syncState: SYNC,
    canCheckNow: false,
    ...o,
  };
}

/** An ApiError-shaped rejection (the real class lives in the mocked ./api). */
function apiError(status: number, message: string, details?: unknown) {
  return Object.assign(new Error(message), { status, details });
}

describe('listExceptions', () => {
  it('reads the stored list for the tab through the Bearer route', async () => {
    apiMock.api.mockResolvedValueOnce(listBody());
    const list = await listExceptions('resolved');
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/exceptions?status=resolved', { signal: undefined });
    expect(list.occurrences).toHaveLength(1);
    expect(list.syncState?.lastSyncedAt).toBe('2026-09-24T18:00:02Z');
  });

  // Mutation caught: a catch that returns { occurrences: [] } — an empty list
  // reads as "nothing is wrong".
  it('a failed read throws; it never resolves to an empty list', async () => {
    apiMock.api.mockRejectedValueOnce(apiError(500, 'The server had a problem. Try again in a moment.'));
    await expect(listExceptions('open')).rejects.toThrow('The server had a problem');
  });

  it('an answer without the list shape is a failure, not an empty list', async () => {
    apiMock.api.mockResolvedValueOnce({ organizationId: 'org-1' });
    await expect(listExceptions('open')).rejects.toBeInstanceOf(ExceptionsResponseError);
    apiMock.api.mockResolvedValueOnce('<html>challenge</html>');
    await expect(listExceptions('open')).rejects.toBeInstanceOf(ExceptionsResponseError);
  });

  it('keeps syncState null before the first check (never read as all clear)', async () => {
    apiMock.api.mockResolvedValueOnce(listBody({ occurrences: [], syncState: null }));
    const list = await listExceptions('open');
    expect(list.syncState).toBeNull();
  });

  it('leaves out a rule this build cannot word, keeps the rest, and COUNTS what it left out', async () => {
    // A phone on an older bundle once a newer server writes rows of a rule it
    // does not know (as count_variance was before F1-2): if those are the only
    // open rows, an uncounted drop reads as all clear.
    // Mutation caught: dropping unknown rows without counting them.
    apiMock.api.mockResolvedValueOnce(
      listBody({ occurrences: [occurrence(), occurrence({ id: 'x', rule: 'a_future_rule' })] }),
    );
    const list = await listExceptions('open');
    expect(list.occurrences.map((o) => o.id)).toEqual([ID]);
    expect(list.unrecognized).toBe(1);
  });

  it('adds the rows the server itself could not word (a web rollback)', async () => {
    apiMock.api.mockResolvedValueOnce(
      listBody({ occurrences: [occurrence({ id: 'x', rule: 'a_future_rule' })], unrecognized: 2 }),
    );
    const list = await listExceptions('open');
    expect(list.occurrences).toEqual([]);
    expect(list.unrecognized).toBe(3);
  });

  it('an unchecked rule this build cannot name counts as unchecked, never as clean', async () => {
    apiMock.api.mockResolvedValueOnce(
      listBody({
        occurrences: [],
        syncState: {
          ...SYNC,
          failedRules: ['a_future_rule', 'stale_staging'],
          truncatedRules: ['a_future_rule'],
          unrecognizedUncheckedRules: 1,
        },
      }),
    );
    const list = await listExceptions('open');
    expect(list.syncState?.failedRules).toEqual(['stale_staging']);
    // One the server counted, plus a_future_rule (sent, unknown here), once.
    expect(list.syncState?.unrecognizedUncheckedRules).toBe(2);
  });

  it('carries the org time zone (null from an older server)', async () => {
    apiMock.api.mockResolvedValueOnce(listBody({ timeZone: 'America/Los_Angeles' }));
    expect((await listExceptions('open')).timeZone).toBe('America/Los_Angeles');
    apiMock.api.mockResolvedValueOnce(listBody());
    expect((await listExceptions('open')).timeZone).toBeNull();
  });

  it('offers an action only when the server said this reader may act', async () => {
    apiMock.api.mockResolvedValueOnce(
      listBody({ occurrences: [occurrence({ canAct: 'yes' }), occurrence({ id: 'b', canAct: undefined })] }),
    );
    const list = await listExceptions('open');
    expect(list.occurrences.map((o) => o.canAct)).toEqual([false, false]);
  });
});

describe('getException', () => {
  it('reads one occurrence with its timeline and history', async () => {
    apiMock.api.mockResolvedValueOnce({
      organizationId: 'org-1',
      occurrence: occurrence(),
      timeline: [
        { id: 'e1', kind: 'raised', at: '2026-09-24T15:00:00Z', actor: null, note: null, cycleCount: null },
        { id: 'e2', kind: 'future_kind', at: '2026-09-24T15:01:00Z', actor: null },
      ],
      history: [{ id: ID, number: 42, reference: 'EX-000042', firstSeenAt: 'x', isCurrent: true }],
      historyTruncated: false,
      syncState: SYNC,
    });
    const d = await getException(ID);
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/exceptions/${ID}`);
    expect(d.timeline.map((e) => e.kind)).toEqual(['raised']);
    expect(d.history[0]!.isCurrent).toBe(true);
  });

  it('refuses a malformed id without asking the server', async () => {
    await expect(getException('not-an-id')).rejects.toBeInstanceOf(ExceptionsResponseError);
    expect(apiMock.api).not.toHaveBeenCalled();
  });

  it('a 404 propagates so the screen can say it is not available', async () => {
    apiMock.api.mockRejectedValueOnce(apiError(404, 'Exception not found.'));
    await expect(getException(ID)).rejects.toMatchObject({ status: 404 });
  });
});

describe('actOnException', () => {
  it('posts the action, the note and the client event id', async () => {
    apiMock.api.mockResolvedValueOnce({ occurrence: occurrence({ acknowledgedAt: '2026-09-24T19:00:00Z' }) });
    const o = await actOnException(ID, { action: 'acknowledge', note: 'checking rack', clientEventId: 'ce-1' });
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/exceptions/${ID}/act`, {
      method: 'POST',
      body: { action: 'acknowledge', note: 'checking rack', clientEventId: 'ce-1' },
    });
    expect(o.acknowledgedAt).toBe('2026-09-24T19:00:00Z');
  });

  it('a refusal propagates', async () => {
    apiMock.api.mockRejectedValueOnce(apiError(403, 'You do not have permission to act on this exception.'));
    await expect(
      actOnException(ID, { action: 'note', note: 'x', clientEventId: 'ce-2' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('describeActError', () => {
  it('maps by status and the app-authored reason, never by message text', () => {
    expect(describeActError(apiError(409, 'x', { reason: 'occurrence_resolved' }))).toBe(
      'This exception has already been resolved. Pull down to refresh.',
    );
    expect(describeActError(apiError(403, 'x'))).toBe('You do not have permission to act on this exception.');
    expect(describeActError(apiError(404, 'x'))).toBe('This exception is no longer available to you.');
    expect(describeActError(apiError(429, 'x'))).toBe('Too many requests. Wait a moment and try again.');
    expect(describeActError(apiError(400, 'x', { reason: 'note_required' }))).toBe('Add a note.');
    expect(describeActError(apiError(502, '<html>'))).toBe('The server had a problem. Try again in a moment.');
    // A dropped connection (no status): the client's own sentence.
    expect(describeActError(new Error('Request timed out. Check your connection and try again.'))).toBe(
      'Request timed out. Check your connection and try again.',
    );
  });
});

describe('requestExceptionCheck', () => {
  it('returns at once with whether a check was scheduled', async () => {
    apiMock.api.mockResolvedValueOnce({ scheduled: false, reason: 'already_requested', lastSyncedAt: 'x', retryAfterSeconds: 42 });
    await expect(requestExceptionCheck()).resolves.toEqual({
      scheduled: false,
      reason: 'already_requested',
      lastSyncedAt: 'x',
      retryAfterSeconds: 42,
    });
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/exceptions/check-now', { method: 'POST' });
  });
});

describe('exceptionSheetSubmit (the Acknowledge and Note sheets)', () => {
  const base = { mode: 'acknowledge' as const, note: '', submitting: false, online: true, canAct: true, resolved: false };

  it('acknowledging needs no note; a note needs text', () => {
    expect(exceptionSheetSubmit(base)).toEqual({ enabled: true, reason: null });
    expect(exceptionSheetSubmit({ ...base, mode: 'note' })).toEqual({ enabled: false, reason: null });
    expect(exceptionSheetSubmit({ ...base, mode: 'note', note: 'checking rack' }).enabled).toBe(true);
  });

  // Mutation caught: the sheet ignoring the live network state.
  it('offline disables both sheets, with the reason', () => {
    for (const mode of ['acknowledge', 'note'] as const) {
      expect(exceptionSheetSubmit({ ...base, mode, note: 'x', online: false })).toEqual({
        enabled: false,
        reason: EXCEPTION_ACT_OFFLINE_COPY,
      });
    }
  });

  it('a reader without permission, or a resolved row, never gets an enabled submit', () => {
    expect(exceptionSheetSubmit({ ...base, canAct: false })).toEqual({
      enabled: false,
      reason: EXCEPTION_ACT_NOT_PERMITTED_COPY,
    });
    expect(exceptionSheetSubmit({ ...base, resolved: true })).toEqual({
      enabled: false,
      reason: EXCEPTION_ACT_RESOLVED_COPY,
    });
  });

  it('refuses a note over 1,000 characters and a double submit', () => {
    expect(exceptionSheetSubmit({ ...base, note: 'x'.repeat(1001) }).enabled).toBe(false);
    expect(exceptionSheetSubmit({ ...base, note: 'x'.repeat(1000) }).enabled).toBe(true);
    expect(exceptionSheetSubmit({ ...base, submitting: true }).enabled).toBe(false);
  });
});

describe('the offline "as of" list', () => {
  const list = {
    organizationId: 'org-1',
    status: 'open' as const,
    occurrences: [],
    truncated: false,
    syncState: null,
    canCheckNow: false,
    canRecount: false,
    recountUnavailableReason: null,
    unrecognized: 0,
    timeZone: null,
  };

  it('is kept per account, workspace and tab', () => {
    rememberList('user-1', 'org-1', list, new Date('2026-09-24T18:00:00Z'));
    expect(recalledList('user-1', 'org-1', 'open')?.receivedAt).toBe('2026-09-24T18:00:00.000Z');
    expect(recalledList('user-2', 'org-1', 'open')).toBeNull();
    expect(recalledList('user-1', 'org-2', 'open')).toBeNull();
    expect(recalledList('user-1', 'org-1', 'resolved')).toBeNull();
  });

  it('never keeps an answer for another workspace than the one asked about', () => {
    rememberList('user-1', 'org-2', list);
    expect(recalledList('user-1', 'org-2', 'open')).toBeNull();
  });

  it('says it is offline and when the list is from', () => {
    expect(offlineAsOfCopy('2026-09-24T18:00:00Z')).toMatch(/^You are offline\. Showing the list as of .+\.$/);
    expect(offlineAsOfCopy('2026-09-24T18:00:00Z', 'America/Los_Angeles')).toBe(
      'You are offline. Showing the list as of Sep 24, 11:00 AM.',
    );
  });
});

describe('exceptionTimeLabel', () => {
  it('prints the ORG\'s clock time when the server sent its zone, whatever the device zone is', () => {
    // The web page prints formatOrgDateTime(iso, same options, orgZone).
    // Mutation caught: ignoring the zone (the device zone differs by hours).
    expect(exceptionTimeLabel('2026-09-24T23:42:00Z', 'America/Los_Angeles')).toBe('Sep 24, 4:42 PM');
    expect(exceptionTimeLabel('2026-09-24T23:42:00Z', 'America/New_York')).toBe('Sep 24, 7:42 PM');
  });

  it('falls back to the device zone without one, and an em dash for a bad value', () => {
    const iso = '2026-09-24T23:42:00Z';
    expect(exceptionTimeLabel(iso, null)).toBe(
      new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    );
    expect(exceptionTimeLabel(null, 'America/Los_Angeles')).toBe('—');
    expect(exceptionTimeLabel('nope', 'America/Los_Angeles')).toBe('—');
  });
});

describe('describeExceptionsRequestError', () => {
  it('never shows a bare code: a 429 and a 5xx are worded by status', () => {
    // The mobile api() falls back to the body's `error` code as the message
    // when there is no `message` (older servers). Mutation caught: showing
    // e.message as is.
    expect(describeExceptionsRequestError(apiError(429, 'rate_limited'), 'x')).toBe(
      'Too many requests. Wait a moment and try again.',
    );
    expect(describeExceptionsRequestError(apiError(500, 'internal_error'), 'x')).toBe(
      'The server had a problem. Try again in a moment.',
    );
    expect(describeExceptionsRequestError(apiError(400, 'validation_error'), 'Fallback.')).toBe('Fallback.');
    expect(describeExceptionsRequestError(apiError(403, 'Only a manager can run a check now.'), 'x')).toBe(
      'Only a manager can run a check now.',
    );
    expect(describeExceptionsRequestError('weird', 'Fallback.')).toBe('Fallback.');
  });
});

describe('clientEventIdFor (the act request id belongs to the payload)', () => {
  it('reuses the last id only for a resend of the same action and note', () => {
    const last = { action: 'acknowledge' as const, note: null, id: 'k-1' };
    expect(clientEventIdFor(last, 'acknowledge', null)).toBe('k-1');
    // An edited note, or the other action, is a NEW request. Mutation
    // caught: one id per sheet opening (the edited note was dropped as a
    // replay of the lost first request).
    expect(clientEventIdFor(last, 'acknowledge', 'checking rack 17')).not.toBe('k-1');
    expect(clientEventIdFor(last, 'note', null)).not.toBe('k-1');
    expect(clientEventIdFor(null, 'note', 'x')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a conflict answer is worded, never shown as a code', () => {
    expect(describeActError(apiError(409, 'This could not be saved as sent. Please try again.', { reason: 'client_event_id_conflict' }))).toBe(
      'This could not be saved as sent. Please try again.',
    );
  });
});

describe('isOfflineState', () => {
  it('only a definite "not connected" or "not reachable" is offline; unknown is online', () => {
    expect(isOfflineState({ isConnected: false })).toBe(true);
    expect(isOfflineState({ isConnected: true, isInternetReachable: false })).toBe(true);
    expect(isOfflineState({ isConnected: true, isInternetReachable: true })).toBe(false);
    expect(isOfflineState({})).toBe(false);
    expect(isOfflineState(null)).toBe(false);
  });
});

describe('small helpers', () => {
  it('routes put-away to Staging and the rest to the item', () => {
    expect(exceptionActionRoute('put_away', 'i1')).toBe('/staging');
    expect(exceptionActionRoute('open_item', 'i1')).toBe('/item/i1');
    expect(exceptionActionRoute('edit_label', 'i1')).toBe('/item/i1');
  });

  it('mints a distinct uuid-shaped client event id each time', () => {
    const a = newClientEventId();
    const b = newClientEventId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});

// ── F1-2: recounts ─────────────────────────────────────────────────────────

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
};

describe('recount fields on the list and the detail', () => {
  it('reads canRecount (only an explicit true) on rows and on the list', async () => {
    apiMock.api.mockResolvedValueOnce(
      listBody({
        canRecount: true,
        occurrences: [
          occurrence({ ...VARIANCE, canRecount: true }),
          occurrence({ id: 'b', ...VARIANCE, canRecount: 'yes' }),
        ],
      }),
    );
    const list = await listExceptions('open');
    expect(list.canRecount).toBe(true);
    expect(list.occurrences.map((o) => o.canRecount)).toEqual([true, false]);
    apiMock.api.mockResolvedValueOnce(listBody());
    expect((await listExceptions('open')).canRecount).toBe(false);
  });

  // Review finding (F1-2): the phone said "Only a manager..." when Recount
  // was withheld because Cycle Counts is off.
  it('reads why Recount is withheld, and only a reason it knows', async () => {
    apiMock.api.mockResolvedValueOnce(
      listBody({
        canRecount: false,
        recountUnavailableReason: 'module_disabled',
        occurrences: [
          occurrence({ ...VARIANCE, recountUnavailableReason: 'module_disabled' }),
          occurrence({ id: 'b', ...VARIANCE, recountUnavailableReason: 'a_future_reason' }),
        ],
      }),
    );
    const list = await listExceptions('open');
    expect(list.recountUnavailableReason).toBe('module_disabled');
    expect(list.occurrences.map((o) => o.recountUnavailableReason)).toEqual(['module_disabled', null]);
    expect(recountUnavailableCopy(list.occurrences[0]!.recountUnavailableReason)).toBe(
      'Cycle Counts is turned off for this organization, so a recount cannot be started.',
    );
    apiMock.api.mockResolvedValueOnce(listBody());
    expect((await listExceptions('open')).recountUnavailableReason).toBeNull();
  });

  it('reads the recount outcome, and never makes one up', async () => {
    apiMock.api.mockResolvedValueOnce(
      listBody({
        occurrences: [
          occurrence({
            ...VARIANCE,
            recount: {
              cycleCountId: 'cc-2',
              countNumber: 2,
              status: 'in_progress',
              completedAt: null,
              outcome: { kind: 'in_progress', counted: 1, total: 3 },
            },
          }),
          occurrence({
            id: 'b',
            ...VARIANCE,
            recount: { cycleCountId: 'cc-3', countNumber: 3, status: 'completed', completedAt: '2026-09-24T19:00:00Z', outcome: { kind: 'matched' } },
          }),
          // An older server without outcomes: only what the status says.
          occurrence({
            id: 'c',
            ...VARIANCE,
            recount: { cycleCountId: 'cc-4', countNumber: 4, status: 'in_progress', completedAt: null },
          }),
        ],
      }),
    );
    const [a, b, c] = (await listExceptions('open')).occurrences;
    expect(a!.recount?.outcome).toEqual({ kind: 'in_progress', counted: 1, total: 3 });
    expect(b!.recount?.outcome).toEqual({ kind: 'unavailable' });
    expect(c!.recount?.outcome).toEqual({ kind: 'in_progress', counted: null, total: null });
  });

  it('asks for one item\'s exceptions with itemId, and refuses a malformed one without a request', async () => {
    apiMock.api.mockResolvedValueOnce(listBody());
    await listExceptions('open', { itemId: '22222222-2222-4222-8222-222222222222' });
    expect(apiMock.api).toHaveBeenCalledWith(
      '/api/v1/exceptions?status=open&itemId=22222222-2222-4222-8222-222222222222',
      { signal: undefined },
    );
    apiMock.api.mockClear();
    await expect(listExceptions('open', { itemId: 'x&status=resolved' })).rejects.toBeInstanceOf(ExceptionsResponseError);
    expect(apiMock.api).not.toHaveBeenCalled();
  });

  it('a closed recount in the timeline carries its outcome', async () => {
    apiMock.api.mockResolvedValueOnce({
      organizationId: 'org-1',
      occurrence: occurrence(VARIANCE),
      timeline: [
        { id: 'e1', kind: 'recount_closed', at: '2026-09-24T19:00:00Z', actor: null, note: null, cycleCount: { id: 'cc-2', countNumber: 2, outcome: { kind: 'matched', quantity: 21 } } },
        { id: 'e2', kind: 'recount_linked', at: '2026-09-24T18:00:00Z', actor: null, note: null, cycleCount: { id: 'cc-2', countNumber: 2 } },
      ],
      history: [],
      syncState: SYNC,
    });
    const d = await getException(ID);
    expect(d.timeline[0]!.cycleCount).toEqual({ id: 'cc-2', countNumber: 2, outcome: { kind: 'matched', quantity: 21 } });
    expect(d.timeline[1]!.cycleCount?.outcome).toBeNull();
  });
});

describe('startRecount', () => {
  const body = {
    cycleCountId: 'cc-new',
    countNumber: 2,
    reference: 'CC-000002',
    lineCount: 1,
    created: true,
    replay: false,
    assignedTo: 'u-staff',
    assignmentFailed: false,
    notes: 'Recount: QA Chromebook',
    linked: [ID],
    linkedExisting: [
      { cycleCountId: 'cc-1', countNumber: 1, reference: 'CC-000001', assignedTo: { id: 'u1', label: 'Ana' }, startedAt: '2026-09-24T18:00:00Z', itemIds: ['i1'], occurrenceIds: ['o1'] },
    ],
    skipped: [{ occurrenceId: null, itemId: 'i2', itemName: 'Projector', reason: 'not_countable' }],
  };

  it('posts the selection, the assignee and the key, and reads the answer', async () => {
    apiMock.api.mockResolvedValueOnce(body);
    const res = await startRecount({ occurrenceIds: [ID], itemIds: [], assignedTo: 'u-staff', idempotencyKey: 'k-1' });
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/exceptions/recount', {
      method: 'POST',
      body: { occurrenceIds: [ID], itemIds: [], assignedTo: 'u-staff', idempotencyKey: 'k-1' },
    });
    expect(res).toMatchObject({
      cycleCountId: 'cc-new',
      countNumber: 2,
      created: true,
      assignedTo: 'u-staff',
      linkedExisting: [{ cycleCountId: 'cc-1', assignedTo: { id: 'u1', label: 'Ana' }, itemIds: ['i1'], occurrenceIds: ['o1'] }],
      skipped: [{ itemId: 'i2', itemName: 'Projector', reason: 'not_countable' }],
    });
  });

  // Mutation caught: a malformed answer read as "nothing started".
  it('an answer it cannot trust is a failure (the count may exist)', () => {
    expect(() => parseRecountResult({ cycleCountId: 'cc' })).toThrow(ExceptionsResponseError);
    expect(() => parseRecountResult({ ...body, linkedExisting: [{ countNumber: 1 }] })).toThrow(ExceptionsResponseError);
    expect(() => parseRecountResult({ ...body, skipped: [{ reason: 'resolved' }] })).toThrow(ExceptionsResponseError);
  });

  it('keeps an item skipped for a reason this build does not know, with the generic words', () => {
    const res = parseRecountResult({ ...body, skipped: [{ occurrenceId: null, itemId: 'i9', itemName: 'X', reason: 'a_future_reason' }] });
    expect(res.skipped).toEqual([
      { itemId: 'i9', itemName: 'X', reason: 'not_countable', occurrenceId: null, occurrenceReference: null },
    ]);
  });

  // Review finding (F1-2): a skipped EXCEPTION must be worded as the
  // exception, so the phone keeps which one it was.
  it('keeps which exception a skip names, so the sheet words it as the exception', () => {
    const res = parseRecountResult({
      ...body,
      skipped: [{ occurrenceId: 'o7', occurrenceReference: 'EX-000007', itemId: 'i2', itemName: 'Chromebook', reason: 'resolved' }],
    });
    expect(res.skipped).toEqual([
      { itemId: 'i2', itemName: 'Chromebook', reason: 'resolved', occurrenceId: 'o7', occurrenceReference: 'EX-000007' },
    ]);
    expect(recountResultSummary(res).skipped).toEqual(['Not linked: EX-000007 (Chromebook): Already resolved']);
  });

  // Review finding (F1-2): the retry of a link-only recount (a lost answer)
  // read "No count was started." The server replays the first answer; the
  // phone must carry its links through.
  it('a replay of a link-only recount still names the count it was linked to', () => {
    const res = parseRecountResult({
      ...body,
      cycleCountId: null,
      countNumber: null,
      reference: null,
      lineCount: 0,
      created: false,
      replay: true,
      assignedTo: null,
      linked: [],
      skipped: [],
    });
    const summary = recountResultSummary(res, { timeZone: 'America/Los_Angeles' });
    expect(summary.alreadyCounting.map((a) => a.text)).toEqual([
      'Already being counted in CC-000001 (assigned to Ana, open since Sep 24), linked',
    ]);
    expect(summary.nothing).toBeNull();
  });
});

describe('recountKeyFor', () => {
  // Mutation caught: a new key on every send (a retry after a lost answer
  // would start a second count).
  it('reuses the key for the same selection in any order, and mints one for another', () => {
    const first = recountKeyFor(null, ['b', 'a'], []);
    expect(recountKeyFor(first, ['a', 'b'], [])).toBe(first);
    expect(recountKeyFor(first, ['a'], []).key).not.toBe(first.key);
    expect(recountKeyFor(first, ['a', 'b'], ['i']).key).not.toBe(first.key);
    // After a conflict the caller passes null: a fresh key.
    expect(recountKeyFor(null, ['a', 'b'], []).key).not.toBe(first.key);
  });
});

describe('describeRecountError', () => {
  it('maps by status and details, never by message text', () => {
    expect(describeRecountError(apiError(409, 'x', { reason: 'idempotency_conflict' }))).toMatchObject({ retryable: false, dropKey: true });
    expect(
      describeRecountError(apiError(409, 'Another recount or check is working on these items right now. Try again in a moment.', { reason: 'recount_busy', retryable: true })),
    ).toEqual({
      message: 'Another recount or check is working on these items right now. Try again in a moment.',
      retryable: true,
      dropKey: false,
    });
    expect(describeRecountError(apiError(409, 'An exception in this recount is already linked to another recount in progress. Refresh to see it.', { reason: 'recount_already_linked' }))).toMatchObject({ retryable: false, dropKey: false });
    expect(describeRecountError(apiError(403, 'forbidden')).message).toMatch(/Only a manager/);
    expect(describeRecountError(apiError(500, 'internal_error'))).toMatchObject({ retryable: true });
    expect(describeRecountError(apiError(429, 'rate_limited'))).toMatchObject({ retryable: true });
    // No status: the request may not have arrived; the same key is safe.
    expect(describeRecountError(new Error('Network request failed'))).toMatchObject({ retryable: true, dropKey: false });
  });
});

describe('a count\'s linked exceptions', () => {
  const CC = '33333333-3333-4333-8333-333333333333';
  const answer = {
    organizationId: 'org-1',
    cycleCountId: CC,
    status: 'in_progress',
    exceptions: [
      {
        occurrence: occurrence(VARIANCE),
        active: true,
        line: { id: 'l1', countedQuantity: 21, expectedQuantity: 20, countedLocationId: 'loc-1', countedLocation: { name: '12-A', kind: 'rack', archived: false } },
        outcome: { kind: 'in_progress', counted: 1, total: 1 },
        destination: { kind: 'adds_to_location', location: 'Rack 12-A' },
        reviewLine: 'Counted 21, book 20 (+1): adds to Rack 12-A',
      },
      { occurrence: occurrence({ id: 'z', rule: 'a_future_rule' }), active: true, line: null, outcome: { kind: 'unavailable' }, reviewLine: null },
    ],
    unrecognized: 1,
  };

  it('reads the links, and counts the ones it cannot word', async () => {
    apiMock.api.mockResolvedValueOnce(answer);
    const res = await getCountLinkedExceptions(CC);
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/cycle-counts/${CC}/exceptions`);
    expect(res.exceptions).toHaveLength(1);
    expect(res.exceptions[0]).toMatchObject({
      active: true,
      line: { id: 'l1', countedQuantity: 21, expectedQuantity: 20, countedLocationId: 'loc-1' },
      reviewLine: 'Counted 21, book 20 (+1): adds to Rack 12-A',
    });
    expect(res.unrecognized).toBe(2);
  });

  it('a malformed answer or id is a failure, never "no linked exceptions"', async () => {
    expect(() => parseCountLinkedExceptions({ organizationId: 'org-1' })).toThrow(ExceptionsResponseError);
    await expect(getCountLinkedExceptions('nope')).rejects.toBeInstanceOf(ExceptionsResponseError);
  });

  // Mutation caught: showing the server's destination for a line the phone
  // has counted differently (or not yet synced).
  it('shows the server\'s destination only while it describes the line the phone holds', () => {
    const link = {
      line: { id: 'l1', countedQuantity: 21, expectedQuantity: 20, countedLocationId: 'loc-1' },
      reviewLine: 'Counted 21, book 20 (+1): adds to Rack 12-A',
      outcome: { kind: 'in_progress', counted: 1, total: 1 } as const,
    };
    const clean = { counted: 21, localDirty: false, drafting: false, countedLocationId: 'loc-1' };
    const open = 'in_progress';
    expect(linkedLineDestination(link, clean, open)).toEqual({ kind: 'review', text: 'Counted 21, book 20 (+1): adds to Rack 12-A' });
    const pending = { kind: 'pending', text: 'Where the difference lands shows once this count syncs.' };
    expect(linkedLineDestination(link, { ...clean, localDirty: true }, open)).toEqual(pending);
    expect(linkedLineDestination(link, { ...clean, drafting: true }, open)).toEqual(pending);
    expect(linkedLineDestination(link, { ...clean, counted: 22 }, open)).toEqual(pending);
    expect(linkedLineDestination(link, { ...clean, countedLocationId: 'loc-2' }, open)).toEqual(pending);
    expect(linkedLineDestination(link, { ...clean, counted: null }, open)).toBeNull();
    expect(linkedLineDestination({ line: null, reviewLine: null, outcome: link.outcome }, clean, open)).toEqual(pending);
  });

  // Review finding (F1-2): a cancelled or posted recount opened from history
  // read "Counted 21, book 20 (+1): adds to Rack 12-A", saying stock would
  // change when nothing more will. Mutation caught: ignore the status.
  it('a closed count says what it came to, never where a difference lands', () => {
    const line = { id: 'l1', countedQuantity: 21, expectedQuantity: 20, countedLocationId: 'loc-1' };
    const phone = { counted: 21, localDirty: false, drafting: false, countedLocationId: 'loc-1' };
    expect(
      linkedLineDestination(
        { line, reviewLine: 'Counted 21, book 20 (+1): adds to Rack 12-A', outcome: { kind: 'cancelled' } },
        phone,
        'canceled',
      ),
    ).toEqual({ kind: 'review', text: 'Cancelled before it was posted' });
    expect(
      linkedLineDestination(
        { line, reviewLine: null, outcome: { kind: 'corrected', from: 20, to: 21, delta: 1 } },
        phone,
        'completed',
      ),
    ).toEqual({ kind: 'review', text: 'Book corrected from 20 to 21 (+1)' });
    // Even with a local edit left over, a closed count's result is the answer.
    expect(
      linkedLineDestination(
        { line, reviewLine: null, outcome: { kind: 'matched', quantity: 21 } },
        { ...phone, localDirty: true },
        'completed',
      ),
    ).toEqual({ kind: 'review', text: 'Matched the book (21)' });
  });
});

