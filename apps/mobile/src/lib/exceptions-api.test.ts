import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EXCEPTION_ACT_NOT_PERMITTED_COPY,
  EXCEPTION_ACT_OFFLINE_COPY,
  EXCEPTION_ACT_RESOLVED_COPY,
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
