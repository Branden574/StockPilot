import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BOOK_REPORT_FORBIDDEN,
  BOOK_REPORT_MODULE_OFF,
  BOOK_REPORT_NOT_IN_SCOPE,
  BOOK_REPORT_OFFLINE_NEEDS_CONNECTION,
  BOOK_REPORT_TIMEOUT,
  DEFAULT_BOOK_REPORT_QUERY,
  DEFAULT_BOOK_REPORT_STATUS_GROUPS,
  VERIFICATION_SESSION_ENDED_COPY,
  bookReportOfflineAsOf,
  type BookReportQuery,
} from '@stockpilot/core';

import {
  BOOK_A,
  BOOK_B,
  ORG,
  OTHER_ORG,
  USER,
  W1,
  W2,
  optionsAnswer,
  ordersAnswer,
  totalsAnswer,
} from './__fixtures__/book-order-totals';
import { accountEpoch, endAccountEpoch } from './account-epoch';
import {
  BOOK_REPORT_EXPORT_FORBIDDEN,
  BOOK_REPORT_PHONE_AAL2,
  BOOK_REPORT_PHONE_MFA_REQUIRED,
  BOOK_REPORT_SERVER_PROBLEM,
  BOOK_REPORT_UNREADABLE,
  BOOK_REPORT_WORKSPACE_MISMATCH,
  BookReportRequestError,
  BookReportResponseError,
  bookReportAnswerKey,
  bookReportCoversKnown,
  bookReportCoversPath,
  bookReportExportPath,
  bookReportFailure,
  bookReportListPath,
  bookReportOrdersKey,
  bookReportOrdersPath,
  bookReportRefreshFailedBanner,
  bookReportView,
  describeBookReportError,
  exportRetryText,
  forgetBookReportMemory,
  getBookOrderOptions,
  getBookOrderOrders,
  getBookOrderTotals,
  getBookReportCovers,
  isCurrentBookReportAnswer,
  loadBookReportOptions,
  peekBookReportOptions,
  recallBookReport,
  recallBookReportCover,
  rememberBookReport,
  rememberBookReportCovers,
  type StoredBookReport,
} from './book-order-totals-api';
import { resolveBookReportRequest } from './book-order-totals-view';
import { CONNECTION_FAILURE_COPY, REQUEST_TIMED_OUT_COPY } from './connection-copy';

// ./api reaches for expo-constants, AsyncStorage and the Supabase client at
// import time, none of which exist under node (verification-api.test.ts).
const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

beforeEach(() => {
  apiMock.api.mockReset();
  forgetBookReportMemory();
});

function q(over: Partial<BookReportQuery> = {}): BookReportQuery {
  return {
    ...DEFAULT_BOOK_REPORT_QUERY,
    statusGroups: [...DEFAULT_BOOK_REPORT_STATUS_GROUPS],
    ...over,
  };
}

/** An api() failure as api.ts throws it. */
function apiError(status: number, code?: string, details?: unknown, message = 'refused') {
  return Object.assign(new Error(message), { name: 'ApiError', status, code, details });
}

describe('paths: every request names a concrete warehouse, never "default"', () => {
  it('the list path carries warehouse=all or the uuid (and wview when following the view)', () => {
    expect(bookReportListPath(q({ warehouse: 'all' }))).toBe(
      '/api/v1/reports/book-order-totals?warehouse=all',
    );
    expect(bookReportListPath(q({ warehouse: W1, warehouseFromView: true, page: 3 }))).toBe(
      `/api/v1/reports/book-order-totals?warehouse=${W1}&wview=1&page=3`,
    );
  });

  it('refuses to build a request for the unresolved default', () => {
    expect(() => bookReportListPath(q())).toThrow(BookReportRequestError);
    expect(() => bookReportOrdersPath(BOOK_A, q(), 1)).toThrow(BookReportRequestError);
    expect(() => bookReportExportPath('csv', false, q())).toThrow(BookReportRequestError);
  });

  it("the drill-down path keeps the list's filters but never the list's page", () => {
    const listQuery = q({ warehouse: W1, warehouseFromView: true, range: '30d', page: 7, q: 'hobbit' });
    expect(bookReportOrdersPath(BOOK_A, listQuery, 1)).toBe(
      `/api/v1/reports/book-order-totals/items/${BOOK_A}/orders?range=30d&warehouse=${W1}&wview=1&q=hobbit`,
    );
    expect(bookReportOrdersPath(BOOK_A, listQuery, 2)).toMatch(/&page=2$/);
    expect(bookReportOrdersPath(BOOK_A, listQuery, 2)).not.toMatch(/page=7/);
    expect(() => bookReportOrdersPath('not-a-uuid', listQuery, 1)).toThrow(BookReportRequestError);
  });

  it('the export path names the format, photos for a PDF, and the whole filter set without a page', () => {
    const exportQuery = q({ warehouse: 'all', page: 4, sort: 'title' });
    expect(bookReportExportPath('csv', false, exportQuery)).toBe(
      '/api/v1/reports/book-order-totals/export?format=csv&warehouse=all&sort=title',
    );
    expect(bookReportExportPath('pdf', true, exportQuery)).toBe(
      '/api/v1/reports/book-order-totals/export?format=pdf&photos=1&warehouse=all&sort=title',
    );
    expect(bookReportExportPath('pdf', false, exportQuery)).toContain('photos=0');
  });

  it('covers are asked for 1 to 25 real ids only', () => {
    expect(bookReportCoversPath([])).toBeNull();
    expect(bookReportCoversPath(['nope'])).toBeNull();
    expect(bookReportCoversPath([BOOK_A, BOOK_A, BOOK_B])).toBe(
      `/api/v1/reports/book-order-totals/covers?ids=${BOOK_A},${BOOK_B}`,
    );
    const many = Array.from({ length: 26 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(bookReportCoversPath(many)).toBeNull();
  });
});

describe('warehouse view (plan gap 1)', () => {
  it('following the view, the list, drill-down and export all carry warehouse=W1&wview=1', () => {
    const request = resolveBookReportRequest(q(), W1);
    expect(bookReportListPath(request)).toContain(`warehouse=${W1}&wview=1`);
    expect(bookReportOrdersPath(BOOK_A, request, 1)).toContain(`warehouse=${W1}&wview=1`);
    expect(bookReportExportPath('csv', false, request)).toContain(`warehouse=${W1}&wview=1`);
  });

  it('following the view with "All warehouses" sends warehouse=all', () => {
    expect(bookReportListPath(resolveBookReportRequest(q(), null))).toContain('warehouse=all');
  });

  it('an explicit "All warehouses" stays all when the view changes later', () => {
    const explicit = q({ warehouse: 'all' });
    const a = resolveBookReportRequest(explicit, W1);
    const b = resolveBookReportRequest(explicit, W2);
    expect(bookReportListPath(a)).toBe(bookReportListPath(b));
    expect(bookReportListPath(a)).toContain('warehouse=all');
    expect(bookReportAnswerKey(USER, ORG, a)).toBe(bookReportAnswerKey(USER, ORG, b));
  });

  it('while following the view, a view change is a different request (the screen reloads)', () => {
    const a = resolveBookReportRequest(q(), W1);
    const b = resolveBookReportRequest(q(), W2);
    expect(bookReportAnswerKey(USER, ORG, a)).not.toBe(bookReportAnswerKey(USER, ORG, b));
  });
});

describe('loaders parse strictly and refuse answers for another workspace', () => {
  it('getBookOrderTotals sends the workspace it is for and returns the parsed answer', async () => {
    apiMock.api.mockResolvedValueOnce(totalsAnswer());
    const res = await getBookOrderTotals(ORG, q({ warehouse: 'all' }));
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/reports/book-order-totals?warehouse=all', {
      orgId: ORG,
      signal: undefined,
    });
    expect(res.summary.copies).toBe('34');
    expect(res.rows.map((r) => [r.name, r.copies, r.orders])).toEqual([
      ['Book A', '30', 3],
      ['Book B', '4', 1],
    ]);
  });

  it('an answer for another workspace is refused', async () => {
    apiMock.api.mockResolvedValueOnce(totalsAnswer({ organizationId: OTHER_ORG }));
    await expect(getBookOrderTotals(ORG, q({ warehouse: 'all' }))).rejects.toMatchObject({
      problem: 'workspace',
    });
  });

  it('an answer for another warehouse is refused', async () => {
    apiMock.api.mockResolvedValueOnce(totalsAnswer({ warehouse: { id: W2, source: 'explicit' } }));
    await expect(getBookOrderTotals(ORG, q({ warehouse: W1 }))).rejects.toMatchObject({
      problem: 'mismatch',
    });
  });

  it('a malformed answer is a failure, never an empty report', async () => {
    apiMock.api.mockResolvedValueOnce(totalsAnswer({ summary: undefined }));
    await expect(getBookOrderTotals(ORG, q({ warehouse: 'all' }))).rejects.toBeInstanceOf(
      BookReportResponseError,
    );
    apiMock.api.mockResolvedValueOnce(
      totalsAnswer({ rows: [{ ...(totalsAnswer().rows as object[])[0], copies: 30 }] }),
    );
    await expect(getBookOrderTotals(ORG, q({ warehouse: 'all' }))).rejects.toMatchObject({
      problem: 'shape',
    });
  });

  it('getBookOrderOrders keeps openable, and refuses another book', async () => {
    apiMock.api.mockResolvedValueOnce(ordersAnswer());
    const res = await getBookOrderOrders(ORG, BOOK_A, q({ warehouse: 'all' }), 1);
    expect(res.rows[0]!.openable).toBe(false);
    expect(res.totals.copies).toBe('30');
    apiMock.api.mockResolvedValueOnce(ordersAnswer());
    await expect(getBookOrderOrders(ORG, BOOK_B, q({ warehouse: 'all' }), 1)).rejects.toMatchObject({
      problem: 'mismatch',
    });
  });

  it("the drill-down's 404 reaches the screen as the route's refusal", async () => {
    apiMock.api.mockRejectedValueOnce(apiError(404, 'not_found'));
    const e = await getBookOrderOrders(ORG, BOOK_A, q({ warehouse: 'all' }), 1).catch((x) => x);
    expect(describeBookReportError(e, 'orders')).toMatchObject({
      detail: BOOK_REPORT_NOT_IN_SCOPE,
      notFound: true,
      retry: false,
    });
  });

  it('covers name the asked books whose cover could not be loaded (an older server sends none)', async () => {
    apiMock.api.mockResolvedValueOnce({
      organizationId: ORG,
      covers: {},
      unresolved: [BOOK_A.toUpperCase(), 'not-asked', 7],
    });
    expect(await getBookReportCovers(ORG, [BOOK_A, BOOK_B])).toEqual({
      urls: {},
      unresolved: [BOOK_A.toLowerCase()],
    });
    apiMock.api.mockResolvedValueOnce({ organizationId: ORG, covers: {} });
    expect((await getBookReportCovers(ORG, [BOOK_A])).unresolved).toEqual([]);
  });

  it('getBookOrderOptions parses the lists and the organization words', async () => {
    apiMock.api.mockResolvedValueOnce(optionsAnswer());
    const res = await getBookOrderOptions(ORG);
    expect(res.warehouses.map((w) => w.status)).toEqual(['active', 'archived']);
    expect(res.statusLabels.completed).toBe('Handed over');
  });

  it('covers keep only asked-for ids with URLs', async () => {
    apiMock.api.mockResolvedValueOnce({
      organizationId: ORG,
      covers: { [BOOK_A]: 'https://x.supabase.co/a.jpg?token=t', [BOOK_B]: 42, other: 'https://x/o.jpg' },
    });
    expect(await getBookReportCovers(ORG, [BOOK_A, BOOK_B])).toEqual({
      urls: { [BOOK_A]: 'https://x.supabase.co/a.jpg?token=t' },
      unresolved: [],
    });
    apiMock.api.mockResolvedValueOnce({ organizationId: OTHER_ORG, covers: {} });
    await expect(getBookReportCovers(ORG, [BOOK_A])).rejects.toMatchObject({ problem: 'workspace' });
  });
});

describe('only the newest answer, for the workspace and account on screen', () => {
  const answer = { organizationId: ORG };
  it('accepts the newest answer for the active workspace in the same account', () => {
    const epoch = accountEpoch();
    expect(
      isCurrentBookReportAnswer(answer, { isNewestRequest: true, activeOrgId: ORG, epochAtRequest: epoch }),
    ).toBe(true);
  });
  it('drops an older request, another workspace, or an answer from before a sign-out', () => {
    const epoch = accountEpoch();
    expect(
      isCurrentBookReportAnswer(answer, { isNewestRequest: false, activeOrgId: ORG, epochAtRequest: epoch }),
    ).toBe(false);
    expect(
      isCurrentBookReportAnswer(answer, {
        isNewestRequest: true,
        activeOrgId: OTHER_ORG,
        epochAtRequest: epoch,
      }),
    ).toBe(false);
    expect(
      isCurrentBookReportAnswer(answer, { isNewestRequest: true, activeOrgId: null, epochAtRequest: epoch }),
    ).toBe(false);
    endAccountEpoch();
    expect(
      isCurrentBookReportAnswer(answer, { isNewestRequest: true, activeOrgId: ORG, epochAtRequest: epoch }),
    ).toBe(false);
  });
});

describe('remembered answers: the key and offline honesty', () => {
  const base = q({ warehouse: 'all' });

  it('the key includes the account, the workspace, every filter and the page', () => {
    const k = bookReportAnswerKey(USER, ORG, base)!;
    expect(k).toContain(USER);
    expect(k).toContain(ORG);
    expect(bookReportAnswerKey(USER, ORG, { ...base, page: 2 })).not.toBe(k);
    expect(bookReportAnswerKey(USER, OTHER_ORG, base)).not.toBe(k);
    expect(bookReportAnswerKey('someone-else', ORG, base)).not.toBe(k);
    expect(bookReportAnswerKey(USER, ORG, { ...base, q: 'x' })).not.toBe(k);
    expect(bookReportAnswerKey(USER, ORG, { ...base, warehouse: W1 })).not.toBe(k);
    expect(bookReportAnswerKey(null, ORG, base)).toBeNull();
    expect(bookReportAnswerKey(USER, null, base)).toBeNull();
  });

  it('the drill-down key is the item id, the filters without the list page, and its own page', () => {
    const k = bookReportOrdersKey(USER, ORG, BOOK_A, { ...base, page: 5 }, 1)!;
    expect(k).toBe(bookReportOrdersKey(USER, ORG, BOOK_A, { ...base, page: 1 }, 1));
    expect(bookReportOrdersKey(USER, ORG, BOOK_A, base, 2)).not.toBe(k);
    expect(bookReportOrdersKey(USER, ORG, BOOK_B, base, 1)).not.toBe(k);
  });

  it('an answer is kept for this account only', () => {
    const k = bookReportAnswerKey(USER, ORG, base);
    rememberBookReport(k, { answer: { generatedAtLocal: '2026-09-28 10:42' } });
    expect(recallBookReport(k)).not.toBeNull();
    endAccountEpoch();
    expect(recallBookReport(k)).toBeNull();
  });

  type D = { answer: { generatedAtLocal: string } };
  const ready = (key: string): StoredBookReport<D> => ({
    key,
    kind: 'ready',
    data: { answer: { generatedAtLocal: '2026-09-28 10:42' } },
    banner: null,
  });

  it('offline shows only the exact key, labelled with its time', () => {
    const k1 = bookReportAnswerKey(USER, ORG, base)!;
    const v = bookReportView(ready(k1), k1, true, () => null);
    expect(v).toMatchObject({ kind: 'ready', offline: true, banner: bookReportOfflineAsOf('2026-09-28 10:42') });
    expect(v.kind === 'ready' && v.banner).toBe(
      "You're offline. Showing this report as of 10:42 AM for these filters.",
    );
  });

  it('offline, a different page (or filter) says it needs a connection, never another answer', () => {
    const k1 = bookReportAnswerKey(USER, ORG, base)!;
    const k2 = bookReportAnswerKey(USER, ORG, { ...base, page: 2 })!;
    const v = bookReportView(ready(k1), k2, true, () => null);
    expect(v).toMatchObject({
      kind: 'error',
      offline: true,
      error: { detail: BOOK_REPORT_OFFLINE_NEEDS_CONNECTION, retry: false },
    });
  });

  it('offline, an answer remembered this session for the exact key is shown', () => {
    const k2 = bookReportAnswerKey(USER, ORG, { ...base, page: 2 })!;
    rememberBookReport(k2, { answer: { generatedAtLocal: '2026-09-28 09:05' } });
    const v = bookReportView<D>(null, k2, true);
    expect(v).toMatchObject({ kind: 'ready', banner: bookReportOfflineAsOf('2026-09-28 09:05') });
  });

  it('online with nothing for this key is loading, never an old answer', () => {
    const k1 = bookReportAnswerKey(USER, ORG, base)!;
    const k2 = bookReportAnswerKey(USER, ORG, { ...base, page: 2 })!;
    expect(bookReportView(ready(k1), k2, false, () => null)).toEqual({ kind: 'loading' });
  });

  it('a refresh that failed on the connection keeps the answer, labelled as of its time', () => {
    const k1 = bookReportAnswerKey(USER, ORG, base)!;
    const next = bookReportFailure(ready(k1), k1, new Error('fetch failed'), 'report');
    expect(next).toMatchObject({
      kind: 'ready',
      banner: bookReportRefreshFailedBanner('2026-09-28 10:42'),
    });
  });

  it('a refusal replaces the answer (the reader may no longer see it)', () => {
    const k1 = bookReportAnswerKey(USER, ORG, base)!;
    const next = bookReportFailure(ready(k1), k1, apiError(403, 'forbidden'), 'report');
    expect(next).toMatchObject({ kind: 'error', error: { detail: BOOK_REPORT_FORBIDDEN } });
  });
});

describe('covers kept for the session', () => {
  it('a cover that could not be loaded is not kept, so the next visit asks again', () => {
    rememberBookReportCovers(ORG, {}, [BOOK_A, BOOK_B], [BOOK_A]);
    expect(bookReportCoversKnown(ORG, [BOOK_B])).toBe(true);
    expect(bookReportCoversKnown(ORG, [BOOK_A])).toBe(false);
    forgetBookReportMemory();
  });
  it('remembers asked books, with or without a cover, for this account only', () => {
    rememberBookReportCovers(ORG, { [BOOK_A]: 'https://x/a.jpg' }, [BOOK_A, BOOK_B]);
    expect(recallBookReportCover(ORG, BOOK_A)).toBe('https://x/a.jpg');
    expect(recallBookReportCover(ORG, BOOK_B)).toBeNull();
    expect(bookReportCoversKnown(ORG, [BOOK_A, BOOK_B])).toBe(true);
    expect(recallBookReportCover(OTHER_ORG, BOOK_A)).toBeNull();
    endAccountEpoch();
    expect(bookReportCoversKnown(ORG, [BOOK_A])).toBe(false);
    expect(recallBookReportCover(ORG, BOOK_A)).toBeNull();
  });
});

describe('filter options: once per account, workspace and epoch', () => {
  it('is fetched once (concurrent callers share the request) and then peeked', async () => {
    const loader = vi.fn(async () => (await import('@stockpilot/core')).parseBookOrderOptionsResponse(optionsAnswer()));
    const [a, b] = await Promise.all([
      loadBookReportOptions({ userId: USER, orgId: ORG }, loader),
      loadBookReportOptions({ userId: USER, orgId: ORG }, loader),
    ]);
    expect(a).toBe(b);
    await loadBookReportOptions({ userId: USER, orgId: ORG }, loader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(peekBookReportOptions(USER, ORG)).toBe(a);
    expect(peekBookReportOptions(USER, OTHER_ORG)).toBeNull();
  });

  it('a failure is not remembered: Retry asks again', async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce((await import('@stockpilot/core')).parseBookOrderOptionsResponse(optionsAnswer()));
    await expect(loadBookReportOptions({ userId: USER, orgId: ORG }, loader)).rejects.toThrow('down');
    await expect(loadBookReportOptions({ userId: USER, orgId: ORG }, loader)).resolves.toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('another account (a new epoch) loads its own', async () => {
    const loader = vi.fn(async () => (await import('@stockpilot/core')).parseBookOrderOptionsResponse(optionsAnswer()));
    await loadBookReportOptions({ userId: USER, orgId: ORG }, loader);
    endAccountEpoch();
    expect(peekBookReportOptions(USER, ORG)).toBeNull();
    await loadBookReportOptions({ userId: USER, orgId: ORG }, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('describeBookReportError: every refusal in words, never as zeros', () => {
  it.each([
    [apiError(403, 'forbidden', { reason: 'aal2_required' }), BOOK_REPORT_PHONE_AAL2],
    [apiError(403, 'forbidden', { reason: 'mfa_required' }), BOOK_REPORT_PHONE_MFA_REQUIRED],
    [apiError(403, 'forbidden'), BOOK_REPORT_FORBIDDEN],
    [apiError(403, 'module_disabled'), BOOK_REPORT_MODULE_OFF],
    [apiError(401, 'unauthenticated'), VERIFICATION_SESSION_ENDED_COPY],
    [apiError(503, 'internal_error', { reason: 'timeout' }), BOOK_REPORT_TIMEOUT],
    [apiError(500, 'internal_error'), BOOK_REPORT_SERVER_PROBLEM],
    [new BookReportResponseError('workspace'), BOOK_REPORT_WORKSPACE_MISMATCH],
    [new BookReportResponseError('shape'), BOOK_REPORT_UNREADABLE],
    [new Error('fetch failed: UnexpectedException'), CONNECTION_FAILURE_COPY],
    [new Error(REQUEST_TIMED_OUT_COPY), REQUEST_TIMED_OUT_COPY],
  ])('%s', (e, detail) => {
    expect(describeBookReportError(e, 'report').detail).toBe(detail);
  });

  it('refusals are not kept on screen; transient failures are', () => {
    expect(describeBookReportError(apiError(403, 'forbidden'), 'report').keepShown).toBe(false);
    expect(describeBookReportError(apiError(401), 'report').keepShown).toBe(false);
    expect(describeBookReportError(apiError(500), 'report').keepShown).toBe(true);
    expect(describeBookReportError(apiError(503, 'x', { reason: 'timeout' }), 'report').keepShown).toBe(true);
    expect(describeBookReportError(new Error('offline'), 'report').keepShown).toBe(true);
  });

  it('an export refused for permission says export', () => {
    expect(describeBookReportError(apiError(403, 'forbidden'), 'export').detail).toBe(
      BOOK_REPORT_EXPORT_FORBIDDEN,
    );
  });

  it('too_many_rows is worded with the counts (core words)', () => {
    const e = apiError(400, 'validation_error', { reason: 'too_many_rows', count: 21340, limit: 20000 });
    expect(describeBookReportError(e, 'export').detail).toBe(
      'Too many books for one file (21,340; the limit is 20,000). Narrow the filters.',
    );
  });

  it("a 400 otherwise reads the route's own sentence", () => {
    const e = apiError(400, 'validation_error', { reason: 'invalid_warehouse' }, 'That warehouse is not one you can see.');
    expect(describeBookReportError(e, 'report')).toMatchObject({
      detail: 'That warehouse is not one you can see.',
      retry: false,
    });
  });

  it('429 on an export says when to try again', () => {
    const e = Object.assign(apiError(429, 'rate_limited'), { retryAfterSeconds: 610 });
    expect(describeBookReportError(e, 'export').detail).toBe(exportRetryText(610));
    expect(exportRetryText(610)).toBe('Too many exports in the last hour. Try again in 11 minutes.');
    expect(exportRetryText(null)).toMatch(/Wait a few minutes/);
  });

  it("a 404 without the route's code is a server that does not have the report yet", () => {
    expect(describeBookReportError(apiError(404), 'report')).toMatchObject({ notFound: false, retry: true });
  });

  it("the download helper's own sentences are shown as written", () => {
    const e = Object.assign(new Error('The file took too long to prepare. Narrow the filters and try again.'), {
      name: 'ReportExportError',
      status: null,
    });
    expect(describeBookReportError(e, 'export').detail).toBe(
      'The file took too long to prepare. Narrow the filters and try again.',
    );
  });
});
