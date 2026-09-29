import {
  BOOK_REPORT_COVERS_MAX,
  BOOK_REPORT_FORBIDDEN,
  BOOK_REPORT_MODULE_OFF,
  BOOK_REPORT_NOT_IN_SCOPE,
  BOOK_REPORT_OFFLINE_NEEDS_CONNECTION,
  BOOK_REPORT_TIMEOUT,
  VERIFICATION_SESSION_ENDED_COPY,
  bookReportOfflineAsOf,
  bookReportQueryKey,
  bookReportTooManyText,
  formatReportTime,
  isUuid,
  parseBookOrderOptionsResponse,
  parseBookOrderOrdersResponse,
  parseBookOrderTotalsResponse,
  serializeBookReportQuery,
  type BookOrderOptionsResponse,
  type BookOrderOrdersResponse,
  type BookOrderTotalsResponse,
  type BookReportQuery,
} from '@stockpilot/core';

import { accountEpoch } from './account-epoch';
import { api } from './api';
import { CONNECTION_FAILURE_COPY, REQUEST_TIMED_OUT_COPY } from './connection-copy';

/**
 * BOOK ORDER TOTALS on the phone: thin typed wrappers over the four Bearer
 * routes the web uses (the same BookOrderTotalsService, so the same SQL):
 *
 *   GET /api/v1/reports/book-order-totals                         one page + the summary
 *   GET /api/v1/reports/book-order-totals/items/[id]/orders       one book's orders
 *   GET /api/v1/reports/book-order-totals/options                 filter lists + status labels
 *   GET /api/v1/reports/book-order-totals/covers?ids=...          one page of covers
 *
 * THE RULES THIS MODULE KEEPS (plan 9.3):
 *
 *   1. Totals come only from the API. Nothing here adds, counts or derives a
 *      number; the phone's SQLite cache holds no orders at all.
 *   2. Every request names a CONCRETE warehouse (all or a uuid), never the
 *      default, and the workspace it is for (X-Organization-Id). An answer for
 *      another workspace, another warehouse or another book is refused.
 *   3. A failed read THROWS and is shown as a failure, never as an empty or
 *      zero report; a malformed answer is a failure too (core's strict
 *      parsers).
 *   4. Offline, only an answer for the EXACT same filters and page is shown,
 *      labelled with its generation time. Anything else says the report needs
 *      a connection. Answers are kept in memory for this app session only and
 *      belong to one account: an account change forgets them.
 */

// ── Paths ───────────────────────────────────────────────────────────────────

const BASE = '/api/v1/reports/book-order-totals';

export class BookReportRequestError extends Error {
  constructor(public readonly problem: 'unresolved_warehouse' | 'invalid_id') {
    super(
      problem === 'invalid_id'
        ? 'This link is not valid.'
        : 'Book Order Totals needs a warehouse or all warehouses.',
    );
    this.name = 'BookReportRequestError';
  }
}

function assertResolved(query: BookReportQuery): void {
  if (query.warehouse !== 'all' && !isUuid(query.warehouse)) {
    throw new BookReportRequestError('unresolved_warehouse');
  }
}

/** One page of the report. Always carries `warehouse=` (all or a uuid). */
export function bookReportListPath(query: BookReportQuery): string {
  assertResolved(query);
  return `${BASE}?${serializeBookReportQuery(query)}`;
}

/** One book's orders: the list's filters (never its page) plus the
 *  drill-down's own page. */
export function bookReportOrdersPath(
  itemId: string,
  query: BookReportQuery,
  page: number,
): string {
  assertResolved(query);
  if (!isUuid(itemId)) throw new BookReportRequestError('invalid_id');
  const qs = serializeBookReportQuery({ ...query, page: 1 }, { includePage: false });
  const p = Number.isSafeInteger(page) && page > 1 ? `&page=${page}` : '';
  return `${BASE}/items/${itemId.toLowerCase()}/orders?${qs}${p}`;
}

export const BOOK_REPORT_OPTIONS_PATH = `${BASE}/options`;

/** Covers for one page (1 to 25 ids; anything else is not asked). */
export function bookReportCoversPath(ids: readonly string[]): string | null {
  const clean = [...new Set(ids.filter(isUuid).map((id) => id.toLowerCase()))];
  if (clean.length === 0 || clean.length > BOOK_REPORT_COVERS_MAX) return null;
  return `${BASE}/covers?ids=${clean.join(',')}`;
}

/** The whole filtered report as a file (iOS share). */
export function bookReportExportPath(
  format: 'csv' | 'pdf',
  photos: boolean,
  query: BookReportQuery,
): string {
  assertResolved(query);
  const qs = serializeBookReportQuery({ ...query, page: 1 }, { includePage: false });
  const photosParam = format === 'pdf' ? `&photos=${photos ? '1' : '0'}` : '';
  return `${BASE}/export?format=${format}${photosParam}&${qs}`;
}

// ── Loaders ─────────────────────────────────────────────────────────────────

/** An answer the phone will not show: for another workspace, warehouse or
 *  book, or one this version cannot read. */
export class BookReportResponseError extends Error {
  constructor(public readonly problem: 'shape' | 'workspace' | 'mismatch') {
    super(
      problem === 'workspace'
        ? 'The server answered for a different workspace.'
        : 'The server sent an answer this version of the app cannot read.',
    );
    this.name = 'BookReportResponseError';
  }
}

function requestedWarehouseId(query: BookReportQuery): string | null {
  return query.warehouse === 'all' ? null : query.warehouse.toLowerCase();
}

function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null)?.toLowerCase() === (b ?? null)?.toLowerCase();
}

/** One page of Book Order Totals for workspace `orgId`. Throws on any failure. */
export async function getBookOrderTotals(
  orgId: string,
  query: BookReportQuery,
  signal?: AbortSignal,
): Promise<BookOrderTotalsResponse> {
  const raw = await api<unknown>(bookReportListPath(query), { orgId, signal });
  let parsed: BookOrderTotalsResponse;
  try {
    parsed = parseBookOrderTotalsResponse(raw);
  } catch {
    throw new BookReportResponseError('shape');
  }
  if (parsed.organizationId !== orgId) throw new BookReportResponseError('workspace');
  if (!sameId(parsed.warehouse.id, requestedWarehouseId(query))) {
    throw new BookReportResponseError('mismatch');
  }
  return parsed;
}

/** One page of the orders behind one book's total. Throws on any failure,
 *  including a 404 for a book outside the caller's scope. */
export async function getBookOrderOrders(
  orgId: string,
  itemId: string,
  query: BookReportQuery,
  page: number,
  signal?: AbortSignal,
): Promise<BookOrderOrdersResponse> {
  const raw = await api<unknown>(bookReportOrdersPath(itemId, query, page), { orgId, signal });
  let parsed: BookOrderOrdersResponse;
  try {
    parsed = parseBookOrderOrdersResponse(raw);
  } catch {
    throw new BookReportResponseError('shape');
  }
  if (parsed.organizationId !== orgId) throw new BookReportResponseError('workspace');
  if (!parsed.found || !parsed.book || !sameId(parsed.book.itemId, itemId)) {
    throw new BookReportResponseError('mismatch');
  }
  if (!sameId(parsed.warehouse.id, requestedWarehouseId(query))) {
    throw new BookReportResponseError('mismatch');
  }
  return parsed;
}

/** The filter lists and status labels for workspace `orgId`. */
export async function getBookOrderOptions(
  orgId: string,
  signal?: AbortSignal,
): Promise<BookOrderOptionsResponse> {
  const raw = await api<unknown>(BOOK_REPORT_OPTIONS_PATH, { orgId, signal });
  let parsed: BookOrderOptionsResponse;
  try {
    parsed = parseBookOrderOptionsResponse(raw);
  } catch {
    throw new BookReportResponseError('shape');
  }
  if (parsed.organizationId !== orgId) throw new BookReportResponseError('workspace');
  return parsed;
}

/** Cover URLs by item id, and the asked books whose cover could not be
 *  loaded (as distinct from books with no cover, which are simply absent). */
export interface BookReportCovers {
  urls: Record<string, string>;
  unresolved: string[];
}

/**
 * Covers for the given books, as { itemId: url }, plus the books whose cover
 * could not be loaded (`unresolved`; an older server sends none). Only ids
 * that were asked for and only string URLs are kept; a book without a cover
 * is absent. The server authorizes each book before it signs anything.
 * Covers never change a number, so a caller treats a failure as
 * "placeholders" saying the cover could not be loaded.
 */
export async function getBookReportCovers(
  orgId: string,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<BookReportCovers> {
  const path = bookReportCoversPath(ids);
  if (!path) return { urls: {}, unresolved: [] };
  const raw = await api<unknown>(path, { orgId, signal });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BookReportResponseError('shape');
  }
  const o = raw as { organizationId?: unknown; covers?: unknown; unresolved?: unknown };
  if (o.organizationId !== orgId) throw new BookReportResponseError('workspace');
  if (!o.covers || typeof o.covers !== 'object' || Array.isArray(o.covers)) {
    throw new BookReportResponseError('shape');
  }
  const asked = new Set(ids.map((id) => id.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [id, url] of Object.entries(o.covers as Record<string, unknown>)) {
    if (asked.has(id.toLowerCase()) && typeof url === 'string' && /^https?:\/\//.test(url)) {
      out[id.toLowerCase()] = url;
    }
  }
  const unresolved = Array.isArray(o.unresolved)
    ? [
        ...new Set(
          o.unresolved
            .filter((id): id is string => typeof id === 'string')
            .map((id) => id.toLowerCase())
            .filter((id) => asked.has(id) && !(id in out)),
        ),
      ]
    : [];
  return { urls: out, unresolved };
}

// ── Only the newest answer, for the workspace and account on screen ─────────

/**
 * True when an answer may replace what is on screen: it is the newest
 * request (a sequence token), it belongs to the workspace still active, and
 * the signed-in account has not changed since it was asked for. An answer
 * from before a workspace switch or a sign-out is dropped whenever it lands.
 */
export function isCurrentBookReportAnswer(
  answer: { organizationId: string },
  ctx: {
    isNewestRequest: boolean;
    activeOrgId: string | null;
    epochAtRequest: number;
    currentEpoch?: number;
  },
): boolean {
  const epochNow = ctx.currentEpoch ?? accountEpoch();
  return (
    ctx.isNewestRequest &&
    ctx.activeOrgId !== null &&
    answer.organizationId === ctx.activeOrgId &&
    ctx.epochAtRequest === epochNow
  );
}

// ── Remembered answers (offline honesty) ────────────────────────────────────

/** The key an answer is remembered under: the account, the workspace, every
 *  filter (the concrete warehouse included) and the page. */
export function bookReportAnswerKey(
  userId: string | null | undefined,
  orgId: string | null | undefined,
  query: BookReportQuery,
): string | null {
  if (!userId || !orgId) return null;
  return `${userId}\u0000${orgId}\u0000list\u0000${bookReportQueryKey(query)}`;
}

/** The same for one book's orders: the list's filters without the list's
 *  page, the book's item id and the drill-down's page. */
export function bookReportOrdersKey(
  userId: string | null | undefined,
  orgId: string | null | undefined,
  itemId: string | null | undefined,
  query: BookReportQuery,
  page: number,
): string | null {
  if (!userId || !orgId || !itemId) return null;
  const filters = serializeBookReportQuery({ ...query, page: 1 }, { includePage: false });
  return `${userId}\u0000${orgId}\u0000orders\u0000${itemId.toLowerCase()}\u0000${filters}\u0000vpage=${page}`;
}

/** At most this many answers are kept (they are small; this bounds a long
 *  session of paging). */
const REMEMBER_MAX = 40;

const remembered = new Map<string, { epoch: number; data: unknown }>();

/** Keep an answer for this app session, for this account only. */
export function rememberBookReport<T>(key: string | null, data: T): void {
  if (!key) return;
  const epoch = accountEpoch();
  for (const [k, v] of remembered) if (v.epoch !== epoch) remembered.delete(k);
  remembered.delete(key);
  remembered.set(key, { epoch, data });
  while (remembered.size > REMEMBER_MAX) {
    const oldest = remembered.keys().next().value;
    if (oldest === undefined) break;
    remembered.delete(oldest);
  }
}

/** The answer kept for exactly this key, by this account, or null. */
export function recallBookReport<T>(key: string | null): T | null {
  if (!key) return null;
  const hit = remembered.get(key);
  if (!hit) return null;
  if (hit.epoch !== accountEpoch()) {
    remembered.delete(key);
    return null;
  }
  return hit.data as T;
}

/** Covers kept for the session (per workspace), so a remembered answer shown
 *  offline still has its pictures when the image cache has them. A book that
 *  was asked about and has no cover is kept as '' (asked, none), so paging
 *  back does not ask again. */
const coverMemo = new Map<string, { epoch: number; url: string }>();
const COVER_MEMO_MAX = 500;

function coverKey(orgId: string, itemId: string): string {
  return `${orgId}\u0000${itemId.toLowerCase()}`;
}

export function rememberBookReportCovers(
  orgId: string,
  covers: Record<string, string>,
  asked: readonly string[] = [],
  unresolved: readonly string[] = [],
): void {
  const epoch = accountEpoch();
  const byId = new Map(Object.entries(covers).map(([id, url]) => [id.toLowerCase(), url]));
  // A cover that could not be loaded is not "asked, none": leave it out so
  // the next visit asks again.
  const failed = new Set(unresolved.map((x) => x.toLowerCase()));
  for (const id of new Set([...asked.map((x) => x.toLowerCase()), ...byId.keys()])) {
    if (failed.has(id) && !byId.has(id)) continue;
    const k = coverKey(orgId, id);
    coverMemo.delete(k);
    coverMemo.set(k, { epoch, url: byId.get(id) ?? '' });
  }
  while (coverMemo.size > COVER_MEMO_MAX) {
    const oldest = coverMemo.keys().next().value;
    if (oldest === undefined) break;
    coverMemo.delete(oldest);
  }
}

/** The cover URL kept for a book, or null (none, not asked yet, or kept by
 *  another account). */
export function recallBookReportCover(orgId: string | null, itemId: string): string | null {
  if (!orgId) return null;
  const hit = coverMemo.get(coverKey(orgId, itemId));
  if (!hit || hit.epoch !== accountEpoch()) return null;
  return hit.url || null;
}

/** True when every one of these books was already asked about this session. */
export function bookReportCoversKnown(orgId: string, itemIds: readonly string[]): boolean {
  const epoch = accountEpoch();
  return itemIds.every((id) => coverMemo.get(coverKey(orgId, id))?.epoch === epoch);
}

/** Forget everything (tests; an account change does it by epoch). */
export function forgetBookReportMemory(): void {
  remembered.clear();
  coverMemo.clear();
  optionsMemo.clear();
  optionsInFlight.clear();
}

// ── Filter options: once per account, workspace and epoch ───────────────────

const optionsMemo = new Map<string, BookOrderOptionsResponse>();
const optionsInFlight = new Map<string, Promise<BookOrderOptionsResponse>>();

export function bookReportOptionsKey(userId: string, orgId: string, epoch: number): string {
  return `${userId}\u0000${orgId}\u0000${epoch}`;
}

/** The options already loaded for this account and workspace, or null. */
export function peekBookReportOptions(
  userId: string | null,
  orgId: string | null,
): BookOrderOptionsResponse | null {
  if (!userId || !orgId) return null;
  return optionsMemo.get(bookReportOptionsKey(userId, orgId, accountEpoch())) ?? null;
}

/**
 * The warehouse and category lists and the organization's status labels,
 * loaded when the report first opens and held for the session. One request
 * at a time per key; a failure is not remembered (Retry asks again), and an
 * answer that lands after the account changed is not kept.
 */
export function loadBookReportOptions(
  ids: { userId: string; orgId: string },
  loader: (orgId: string) => Promise<BookOrderOptionsResponse> = (orgId) =>
    getBookOrderOptions(orgId),
): Promise<BookOrderOptionsResponse> {
  const epoch = accountEpoch();
  const key = bookReportOptionsKey(ids.userId, ids.orgId, epoch);
  const known = optionsMemo.get(key);
  if (known) return Promise.resolve(known);
  const running = optionsInFlight.get(key);
  if (running) return running;
  const run = loader(ids.orgId)
    .then((answer) => {
      if (accountEpoch() === epoch) {
        for (const k of optionsMemo.keys()) if (!k.endsWith(`\u0000${epoch}`)) optionsMemo.delete(k);
        optionsMemo.set(key, answer);
      }
      return answer;
    })
    .finally(() => {
      optionsInFlight.delete(key);
    });
  optionsInFlight.set(key, run);
  return run;
}

// ── What a failure says ─────────────────────────────────────────────────────

export type BookReportSubject = 'report' | 'orders' | 'export';

export interface BookReportErrorView {
  /** Why, in words (the screen's headline says what did not load). */
  detail: string;
  /** Try again can help. */
  retry: boolean;
  /** A refresh that failed this way may keep the answer already on screen,
   *  labelled "as of" its time. A refusal may not. */
  keepShown: boolean;
  /** The drill-down's 404: the only words are "This book isn't in your
   *  report scope." */
  notFound: boolean;
}

/** The phone cannot step up in place: a session reaches AAL2 at sign-in. */
export const BOOK_REPORT_PHONE_AAL2 =
  'Your account uses an authenticator app, and this session did not sign in with it. Sign out and sign back in with your code to open this report.';
export const BOOK_REPORT_PHONE_MFA_REQUIRED =
  'Your organization requires two-step verification for this report. Set it up on the web, then sign in again.';
export const BOOK_REPORT_EXPORT_FORBIDDEN = "You don't have access to export reports.";
export const BOOK_REPORT_WORKSPACE_MISMATCH =
  'The server answered for a different workspace. Go back, check the workspace in the menu, and try again.';
export const BOOK_REPORT_UNREADABLE =
  'The server sent an answer this version of the app cannot read. Try again, or update the app.';
export const BOOK_REPORT_SERVER_PROBLEM = 'The server had a problem. Try again in a moment.';
export const BOOK_REPORT_FILTERS_INVALID =
  'These filters could not be used. Reset the filters and try again.';

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function view(
  detail: string,
  retry: boolean,
  keepShown: boolean,
  notFound = false,
): BookReportErrorView {
  return { detail, retry, keepShown, notFound };
}

/** 'Too many exports. Try again in 12 minutes.' */
export function exportRetryText(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds === null || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return 'Too many exports in the last hour. Wait a few minutes and try again.';
  }
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many exports in the last hour. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/**
 * Why a Book Order Totals request failed, in words. Keyed on the HTTP status
 * and the routes' app-authored code and `details.reason`, never on message
 * text (the one exception: a 400's own message, which the route writes for
 * people). A failure is never worded as "no orders".
 */
export function describeBookReportError(e: unknown, subject: BookReportSubject): BookReportErrorView {
  if (e instanceof BookReportResponseError) {
    if (e.problem === 'workspace') return view(BOOK_REPORT_WORKSPACE_MISMATCH, true, false);
    return view(BOOK_REPORT_UNREADABLE, true, true);
  }
  if (e instanceof BookReportRequestError) {
    return view(e.message, false, false);
  }
  const status = isObj(e) && typeof e.status === 'number' ? e.status : null;
  const code = isObj(e) && typeof e.code === 'string' ? e.code : null;
  const details = isObj(e) ? e.details : undefined;
  const reason = isObj(details) && typeof details.reason === 'string' ? details.reason : null;

  if (status === 404) {
    return code === 'not_found'
      ? view(BOOK_REPORT_NOT_IN_SCOPE, false, false, true)
      : view('The server does not offer this report yet. Try again later.', true, false);
  }
  if (status === 403 && reason === 'aal2_required') return view(BOOK_REPORT_PHONE_AAL2, false, false);
  if (status === 403 && reason === 'mfa_required') {
    return view(BOOK_REPORT_PHONE_MFA_REQUIRED, false, false);
  }
  if (status === 403 && code === 'module_disabled') return view(BOOK_REPORT_MODULE_OFF, false, false);
  if (status === 403) {
    return view(subject === 'export' ? BOOK_REPORT_EXPORT_FORBIDDEN : BOOK_REPORT_FORBIDDEN, false, false);
  }
  if (status === 401) return view(VERIFICATION_SESSION_ENDED_COPY, true, false);
  if (status === 400) {
    if (reason === 'too_many_rows' && isObj(details)) {
      const count = typeof details.count === 'number' ? details.count : null;
      const limit = typeof details.limit === 'number' ? details.limit : null;
      if (count !== null && limit !== null) {
        return view(bookReportTooManyText(count, limit), false, false);
      }
    }
    const message = e instanceof Error && /\s/.test(e.message) ? e.message : null;
    return view(message ?? BOOK_REPORT_FILTERS_INVALID, false, false);
  }
  if (status === 429) {
    const retryAfter =
      isObj(e) && typeof e.retryAfterSeconds === 'number' ? e.retryAfterSeconds : null;
    return subject === 'export'
      ? view(exportRetryText(retryAfter), true, true)
      : view('Too many requests. Wait a moment and try again.', true, true);
  }
  if (status === 503 && reason === 'timeout') return view(BOOK_REPORT_TIMEOUT, true, true);
  if (status !== null && status >= 500) return view(BOOK_REPORT_SERVER_PROBLEM, true, true);
  if (status === null && e instanceof Error && e.name === 'ReportExportError' && e.message) {
    // The download helper's own sentences (timed out, stopped, no storage,
    // the account changed, the connection): written for people.
    return view(e.message, true, true);
  }
  if (status === null) {
    const timedOut = e instanceof Error && e.message === REQUEST_TIMED_OUT_COPY;
    return view(timedOut ? REQUEST_TIMED_OUT_COPY : CONNECTION_FAILURE_COPY, true, true);
  }
  return view(BOOK_REPORT_SERVER_PROBLEM, true, true);
}

// ── What a screen shows (loading, the answer, the failure, or offline) ──────

/** Anything the report answered: every answer carries its generation time
 *  (org-local, from SQL). */
export interface HasGeneratedAt {
  generatedAtLocal: string;
}

export type StoredBookReport<T> =
  | { key: string; kind: 'ready'; data: T; banner: string | null }
  | { key: string; kind: 'error'; error: BookReportErrorView };

export type BookReportView<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; data: T; banner: string | null; offline: boolean }
  | { kind: 'error'; error: BookReportErrorView; offline: boolean };

/** "Couldn't refresh. Showing this report as of 10:42 AM for these filters." */
export function bookReportRefreshFailedBanner(generatedAtLocal: string): string {
  return `Couldn't refresh. Showing this report as of ${formatReportTime(generatedAtLocal)} for these filters.`;
}

/**
 * What to store after a read failed. A refresh of the SAME key that failed
 * for a reason that does not take the answer away (a dropped connection, a
 * busy server) keeps it on screen with its time. Anything else is the
 * failure itself: never zeros, never an empty report.
 */
export function bookReportFailure<D extends { answer: HasGeneratedAt }>(
  prev: StoredBookReport<D> | null,
  key: string,
  e: unknown,
  subject: BookReportSubject,
): StoredBookReport<D> {
  const error = describeBookReportError(e, subject);
  if (prev && prev.key === key && prev.kind === 'ready' && error.keepShown) {
    return { ...prev, banner: bookReportRefreshFailedBanner(prev.data.answer.generatedAtLocal) };
  }
  return { key, kind: 'error', error };
}

/**
 * What the screen shows now. Only an answer for THIS key (account,
 * workspace, every filter, page) is ever shown. Offline nothing is asked:
 * the answer for this key (on screen, or remembered this session) is shown
 * "as of" its time, or the screen says the report needs a connection. A
 * different page or filter is never substituted.
 */
export function bookReportView<D extends { answer: HasGeneratedAt }>(
  stored: StoredBookReport<D> | null,
  key: string | null,
  offline: boolean,
  recall: (key: string | null) => D | null = recallBookReport,
): BookReportView<D> {
  const mine = stored && key !== null && stored.key === key ? stored : null;
  if (offline) {
    const data = mine?.kind === 'ready' ? mine.data : recall(key);
    if (data) {
      return {
        kind: 'ready',
        data,
        banner: bookReportOfflineAsOf(data.answer.generatedAtLocal),
        offline: true,
      };
    }
    return {
      kind: 'error',
      error: view(BOOK_REPORT_OFFLINE_NEEDS_CONNECTION, false, false),
      offline: true,
    };
  }
  if (!mine) return { kind: 'loading' };
  if (mine.kind === 'error') return { kind: 'error', error: mine.error, offline: false };
  return { kind: 'ready', data: mine.data, banner: mine.banner, offline: false };
}
