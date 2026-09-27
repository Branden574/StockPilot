import {
  EXCEPTION_FIRST_CHECK_PENDING_COPY,
  LOCATION_HOLDINGS_TRUNCATED_COPY,
  LOCATION_NO_OPEN_ISSUES_COPY,
  VERIFICATION_SESSION_ENDED_COPY,
  can,
  formatStockQuantity,
  isRecountUnavailableReason,
  locationRecountProblem,
  locationRecountProblemOf,
  parseItemVerificationSummary,
  recountDisabledReason,
  verificationRefusalCopy,
  type ItemVerificationSummary,
  type LocationRowVerificationCopy,
  type LocationVerificationTotals,
  type Permission,
  type RecountUnavailableReason,
  type Role,
  type VerificationIssue,
  type VerificationSubject,
} from '@stockpilot/core';

import { api } from './api';
import { CONNECTION_FAILURE_COPY, REQUEST_TIMED_OUT_COPY } from './connection-copy';
import { exceptionTimeLabel } from './exceptions-api';

/**
 * "Last physical count" on the phone (F1-3): thin typed wrappers over the two
 * Bearer routes the web reads through the same VerificationService,
 *
 *   GET /api/v1/items/[id]/verification       (the item card, the occurrence detail)
 *   GET /api/v1/locations/[id]/verification   (the location screen, 50 rows a page)
 *
 * The shapes mirror the server's (apps/web/src/server/services/verification.ts)
 * field for field; the words come from @stockpilot/core (verificationSummaryCopy,
 * locationRowVerificationCopy, ...), so the phone and the browser say the same
 * thing about the same item.
 *
 * THE RULES THIS MODULE KEEPS:
 *
 *   1. A failed read THROWS and is shown as "Couldn't load verification",
 *      never as an answer. An empty summary reads as "No physical count on
 *      record.", an empty holdings list as "nothing here", no chips as
 *      "nothing wrong": none of those may stand in for a read that failed. A
 *      response without the shape the screens need is a failure too.
 *   2. Every request names the workspace it is FOR (X-Organization-Id), and an
 *      answer for any other workspace is refused, so a switch made while a
 *      request was out never paints another workspace's facts.
 *   3. Nothing here is cached across screens. A screen keeps what it last
 *      loaded while it is open and shows it "as of" that time when a refresh
 *      fails or the phone goes offline (verificationFailure / verificationView).
 */

// ── Shapes (mirrors of the server's) ────────────────────────────────────────

/** An open exception as a chip (core verificationIssueChipCopy words it). */
export interface MobileVerificationIssue extends VerificationIssue {
  /** "EX-000042". */
  reference: string | null;
  itemId: string;
}

export interface MobileItemVerification {
  organizationId: string;
  itemId: string;
  summary: ItemVerificationSummary;
  /** Open exceptions about the item, any location. */
  openIssues: MobileVerificationIssue[];
  openIssuesTruncated: boolean;
  /** When the exceptions were last checked; null before the org's first
   *  check (never read as "no issues"). */
  checkedAt: string | null;
  /** The reader may start a count (the item must also be countable). */
  canCount: boolean;
  countUnavailableReason: RecountUnavailableReason | null;
  /** The org's time zone; null from a server that sent none. */
  timeZone: string | null;
}

export interface MobileLocationVerificationRow {
  itemId: string;
  name: string;
  sku: string | null;
  /** Units of this item at this location. */
  quantity: number;
  /** Null: the server could not match a summary, or this build cannot read
   *  the one it sent. Worded "Couldn't load verification", never "Not counted". */
  summary: ItemVerificationSummary | null;
  /** Open exceptions about this item here, or about the item itself. */
  issues: MobileVerificationIssue[];
}

export interface MobileLocation {
  id: string;
  name: string;
  kind: string | null;
  type: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  archived: boolean;
}

export interface MobileLocationVerification {
  organizationId: string;
  location: MobileLocation;
  /** False: the reader's warehouses do not cover this location, so its stock
   *  is not listed (never shown as an empty location). */
  holdingsVisible: boolean;
  /** Open exceptions recorded at this location. */
  openIssues: MobileVerificationIssue[];
  openIssuesTruncated: boolean;
  /** One page of rows, sorted by item name. */
  rows: MobileLocationVerificationRow[];
  page: number;
  pageSize: number;
  pageCount: number;
  totalRows: number;
  /** Across EVERY row, not just this page. Null when holdings are not visible. */
  totals: LocationVerificationTotals | null;
  /** The server stopped reading holdings at its cap: the totals are partial. */
  truncated: boolean;
  checkedAt: string | null;
  canRecount: boolean;
  recountUnavailableReason: RecountUnavailableReason | null;
  /** Why "Recount items here" cannot be pressed for these items, or null. */
  recountProblem: string | null;
  /**
   * The items "Recount items here" counts: every countable row on EVERY page,
   * from the same read as the totals (empty when the reader may not recount
   * or recountProblem is set). Null from a server that does not send it; the
   * phone then gathers the pages itself (gatherRecountItemIds).
   */
  recountItemIds: string[] | null;
  timeZone: string | null;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export type VerificationResponseProblem = 'malformed' | 'workspace' | 'invalid_id';

/** A request not sent (a malformed id) or an answer the screens cannot trust. */
export class VerificationResponseError extends Error {
  readonly problem: VerificationResponseProblem;
  constructor(problem: VerificationResponseProblem = 'malformed') {
    super(
      problem === 'workspace'
        ? 'The server answered for a different workspace.'
        : problem === 'invalid_id'
          ? verificationRefusalCopy('invalid_id', 'item')
          : 'The server sent an unexpected answer.',
    );
    this.name = 'VerificationResponseError';
    this.problem = problem;
  }
}

// ── Parsing (a malformed answer is a failure, never an empty one) ──────────

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** A whole number from 0, or null. */
function whole(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** A quantity from 0, or null. */
function quantity(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Ids compared as uuids (the database answers in lower case). */
function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function fail(): never {
  throw new VerificationResponseError();
}

/** checkedAt is always sent: a timestamp, or null before the first check. A
 *  missing or garbled one is not read as "the first check has not run". */
function parseCheckedAt(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v === 'string' && Number.isFinite(Date.parse(v))) return v;
  return fail();
}

function parseIssue(v: unknown): MobileVerificationIssue {
  if (
    !isObj(v) ||
    typeof v.id !== 'string' ||
    typeof v.itemId !== 'string' ||
    typeof v.rule !== 'string'
  ) {
    return fail();
  }
  return {
    id: v.id,
    number: whole(v.number),
    reference: str(v.reference),
    rule: v.rule,
    itemId: v.itemId,
    locationId: str(v.locationId),
  };
}

/** The issues list must be there: a missing one is not "no open exceptions". */
function parseIssues(v: unknown): MobileVerificationIssue[] {
  if (!Array.isArray(v)) return fail();
  return v.map(parseIssue);
}

/** A list of ids, or null when the server sent none. Anything else fails. */
function idList(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return fail();
  return v as string[];
}

function unavailableReason(v: unknown): RecountUnavailableReason | null {
  return isRecountUnavailableReason(v) ? v : null;
}

export function parseItemVerification(res: unknown): MobileItemVerification {
  if (!isObj(res) || typeof res.organizationId !== 'string' || typeof res.itemId !== 'string') {
    return fail();
  }
  // core's parser returns null for anything it cannot word: that is a failed
  // read here ("Couldn't load verification"), never "never counted".
  const summary = parseItemVerificationSummary(res.summary);
  if (!summary || !sameId(summary.itemId, res.itemId)) return fail();
  return {
    organizationId: res.organizationId,
    itemId: res.itemId,
    summary,
    openIssues: parseIssues(res.openIssues),
    openIssuesTruncated: res.openIssuesTruncated === true,
    checkedAt: parseCheckedAt(res.checkedAt),
    // Anything but an explicit true is "no": the phone never offers a count
    // the server did not say this reader may start.
    canCount: res.canCount === true,
    countUnavailableReason: unavailableReason(res.countUnavailableReason),
    timeZone: str(res.timeZone),
  };
}

function parseRow(v: unknown): MobileLocationVerificationRow {
  if (!isObj(v) || typeof v.itemId !== 'string' || typeof v.name !== 'string') return fail();
  const q = quantity(v.quantity);
  if (q === null) return fail();
  // A row summary this build cannot read is that row's failure, not the page's.
  const parsed = v.summary === null ? null : parseItemVerificationSummary(v.summary);
  return {
    itemId: v.itemId,
    name: v.name,
    sku: str(v.sku),
    quantity: q,
    summary: parsed && sameId(parsed.itemId, v.itemId) ? parsed : null,
    issues: parseIssues(v.issues),
  };
}

const TOTAL_COUNTS = [
  'items',
  'countedHere',
  'countedItemTotal',
  'notCounted',
  'unavailable',
  'hiddenItems',
  'countable',
] as const;

function parseTotals(v: unknown): LocationVerificationTotals {
  if (!isObj(v)) return fail();
  const counts = {} as Record<(typeof TOTAL_COUNTS)[number], number>;
  for (const key of TOTAL_COUNTS) {
    const n = whole(v[key]);
    if (n === null) return fail();
    counts[key] = n;
  }
  const q = quantity(v.quantity);
  const hq = quantity(v.hiddenQuantity);
  if (q === null || hq === null) return fail();
  return { ...counts, quantity: q, hiddenQuantity: hq };
}

export function parseLocationVerification(res: unknown): MobileLocationVerification {
  if (
    !isObj(res) ||
    typeof res.organizationId !== 'string' ||
    !isObj(res.location) ||
    typeof res.location.id !== 'string' ||
    typeof res.location.name !== 'string' ||
    // Never defaulted: false would claim "not in your warehouses", true an
    // empty location.
    typeof res.holdingsVisible !== 'boolean' ||
    !Array.isArray(res.rows)
  ) {
    return fail();
  }
  const page = whole(res.page);
  const pageSize = whole(res.pageSize);
  const pageCount = whole(res.pageCount);
  const totalRows = whole(res.totalRows);
  if (!page || !pageSize || !pageCount || totalRows === null || page > pageCount) return fail();
  const loc = res.location;
  return {
    organizationId: res.organizationId,
    location: {
      id: loc.id as string,
      name: loc.name as string,
      kind: str(loc.kind),
      type: str(loc.type),
      warehouseId: str(loc.warehouseId),
      warehouseName: str(loc.warehouseName),
      archived: loc.archived === true,
    },
    holdingsVisible: res.holdingsVisible,
    openIssues: parseIssues(res.openIssues),
    openIssuesTruncated: res.openIssuesTruncated === true,
    rows: res.rows.map(parseRow),
    page,
    pageSize,
    pageCount,
    totalRows,
    totals: res.holdingsVisible ? parseTotals(res.totals) : null,
    truncated: res.truncated === true,
    checkedAt: parseCheckedAt(res.checkedAt),
    canRecount: res.canRecount === true,
    recountUnavailableReason: unavailableReason(res.recountUnavailableReason),
    recountProblem: str(res.recountProblem),
    recountItemIds: idList(res.recountItemIds),
    timeZone: str(res.timeZone),
  };
}

// ── Requests ────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One item's verification, for the workspace `orgId` (sent as
 * X-Organization-Id, so the answer is for the workspace the screen shows).
 * Throws on any failure, including an answer for another workspace or item.
 */
export async function getItemVerification(
  itemId: string,
  opts: { orgId: string; signal?: AbortSignal },
): Promise<MobileItemVerification> {
  if (!UUID.test(itemId)) throw new VerificationResponseError('invalid_id');
  const res = await api<unknown>(`/api/v1/items/${itemId}/verification`, {
    orgId: opts.orgId,
    signal: opts.signal,
  });
  const parsed = parseItemVerification(res);
  if (parsed.organizationId !== opts.orgId) throw new VerificationResponseError('workspace');
  if (!sameId(parsed.itemId, itemId)) throw new VerificationResponseError();
  return parsed;
}

export function locationVerificationPath(locationId: string, page: number): string {
  return page > 1
    ? `/api/v1/locations/${locationId}/verification?page=${page}`
    : `/api/v1/locations/${locationId}/verification`;
}

/** One page of a location's verification. Throws on any failure. */
export async function getLocationVerification(
  locationId: string,
  opts: { orgId: string; page?: number; signal?: AbortSignal },
): Promise<MobileLocationVerification> {
  if (!UUID.test(locationId)) throw new VerificationResponseError('invalid_id');
  const page =
    opts.page !== undefined && Number.isSafeInteger(opts.page) && opts.page > 1 ? opts.page : 1;
  const res = await api<unknown>(locationVerificationPath(locationId, page), {
    orgId: opts.orgId,
    signal: opts.signal,
  });
  const parsed = parseLocationVerification(res);
  if (parsed.organizationId !== opts.orgId) throw new VerificationResponseError('workspace');
  if (!sameId(parsed.location.id, locationId)) throw new VerificationResponseError();
  return parsed;
}

// ── What a failed read says ─────────────────────────────────────────────────

export interface VerificationErrorView {
  /** The sentence under "Couldn't load verification" (the headline is always
   *  that; this says why, when it is known). */
  detail: string;
  /** Try again can help (a dropped connection, a busy server). */
  retry: boolean;
  /** A refresh that failed this way may keep the last answer on screen "as
   *  of" its time. A refusal (404, 403, 401, another workspace) may not: the
   *  reader may no longer see what was shown. */
  keepShown: boolean;
}

/** 'item' | 'location' (core's: the web card and page word refusals with
 *  the same core verificationRefusalCopy). */
export type { VerificationSubject };

/**
 * Why a verification read failed, in words. Keyed on the HTTP status and the
 * route's app-authored code and `details.reason`, never on message text. The
 * route answers every unexpected failure as a 500 "Couldn't load
 * verification", so the headline already says that; this adds the cause. A
 * refusal (404, 403, 400, 401) reads in core's words, the same the web card
 * and location page show (verificationRefusalCopy,
 * VERIFICATION_SESSION_ENDED_COPY).
 */
export function describeVerificationError(
  e: unknown,
  subject: VerificationSubject,
): VerificationErrorView {
  if (e instanceof VerificationResponseError) {
    if (e.problem === 'workspace') {
      return {
        detail:
          'The server answered for a different workspace. Go back, check the workspace in the menu, and try again.',
        retry: true,
        keepShown: false,
      };
    }
    if (e.problem === 'invalid_id')
      return {
        detail: verificationRefusalCopy('invalid_id', subject),
        retry: false,
        keepShown: false,
      };
    return {
      detail:
        'The server sent an answer this version of the app cannot read. Try again, or update the app.',
      retry: true,
      keepShown: true,
    };
  }
  const status = isObj(e) && typeof e.status === 'number' ? e.status : null;
  const code = isObj(e) && typeof e.code === 'string' ? e.code : null;
  const details = isObj(e) ? e.details : undefined;
  const reason = isObj(details) && typeof details.reason === 'string' ? details.reason : null;
  if (status === 404) {
    // The route's own 404 carries { error: 'not_found' }. A 404 without it
    // never reached the route: a server that does not have it yet.
    return code === 'not_found'
      ? { detail: verificationRefusalCopy('not_found', subject), retry: false, keepShown: false }
      : {
          detail: 'The server does not offer this yet. Try again later.',
          retry: true,
          keepShown: false,
        };
  }
  if (status === 403 && reason === 'aal2_required') {
    // The phone has no in-place step-up; a session reaches AAL2 at sign-in
    // (the same instruction as item-adjust.ts and change-email.tsx).
    return {
      detail: verificationRefusalCopy('aal2_required', subject),
      retry: false,
      keepShown: false,
    };
  }
  if (status === 403 && reason === 'mfa_required') {
    return {
      detail: verificationRefusalCopy('mfa_required', subject),
      retry: false,
      keepShown: false,
    };
  }
  if (status === 403) {
    return {
      detail: verificationRefusalCopy('forbidden', subject),
      retry: false,
      keepShown: false,
    };
  }
  if (status === 401)
    return { detail: VERIFICATION_SESSION_ENDED_COPY, retry: true, keepShown: false };
  if (status === 400) {
    return {
      detail: verificationRefusalCopy('invalid_id', subject),
      retry: false,
      keepShown: false,
    };
  }
  if (status === 429) {
    return {
      detail: 'Too many requests. Wait a moment and try again.',
      retry: true,
      keepShown: true,
    };
  }
  if (status !== null && status >= 500) {
    return {
      detail: 'The server had a problem. Try again in a moment.',
      retry: true,
      keepShown: true,
    };
  }
  if (status === null) {
    // No status: the request never got an answer. api()'s own timeout keeps
    // its sentence; anything else (offline, a dropped connection) is said in
    // the app's words. The error's own message is never shown here: on iOS it
    // is the network layer's text ("fetch failed: UnexpectedException: Could
    // not connect to the server. (at ExpoModulesCore/Promise.swift:56)",
    // simulator walk 2026-09-27).
    const timedOut = e instanceof Error && e.message === REQUEST_TIMED_OUT_COPY;
    return {
      detail: timedOut ? REQUEST_TIMED_OUT_COPY : CONNECTION_FAILURE_COPY,
      retry: true,
      keepShown: true,
    };
  }
  // A status this module does not word: the server's sentence, never a bare
  // code.
  const message =
    e instanceof Error && e.message && !/^[a-z0-9_]+$/.test(e.message) ? e.message : null;
  return {
    detail: message ?? 'Check your connection and try again.',
    retry: true,
    keepShown: true,
  };
}

/** The location screen's "Recount items here" when its items could not be
 *  gathered: why, in the same words as a failed read. */
export function recountGatherFailureCopy(e: unknown): string {
  return `The items here could not be gathered. ${describeVerificationError(e, 'location').detail}`;
}

// ── What a screen shows (loading, the answer, or the failure) ───────────────

/** What a screen last stored for one key (item or location, and workspace). */
export type StoredVerification<T> =
  | { key: string; kind: 'ready'; data: T; receivedAt: string; banner: string | null }
  | { key: string; kind: 'error'; error: VerificationErrorView };

export type VerificationView<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; data: T; receivedAt: string; banner: string | null }
  | { kind: 'error'; error: VerificationErrorView };

/** Offline with nothing on screen yet. No Try again: nothing can be asked
 *  offline, and the screen asks again by itself when the phone reconnects. */
export const VERIFICATION_OFFLINE_COPY =
  'You are offline. This needs a connection, and loads again when you reconnect.';

/** The key a screen stores its answer under: the subject and the workspace. */
export function verificationKey(
  subjectId: string | null | undefined,
  orgId: string | null | undefined,
  page = 1,
): string | null {
  return subjectId && orgId ? `${orgId}\u0000${subjectId}\u0000${page}` : null;
}

/**
 * What to store after a read failed. A refresh that failed for a reason that
 * does not take the answer away (a dropped connection, a busy server) keeps
 * the answer on screen with "Could not refresh. Showing this as of <time>."
 * Anything else is the failure itself.
 */
export function verificationFailure<T>(
  prev: StoredVerification<T> | null,
  key: string,
  e: unknown,
  subject: VerificationSubject,
  timeZoneOf: (data: T) => string | null,
): StoredVerification<T> {
  const error = describeVerificationError(e, subject);
  if (prev && prev.key === key && prev.kind === 'ready' && error.keepShown) {
    return {
      ...prev,
      banner: `Could not refresh. Showing this as of ${exceptionTimeLabel(prev.receivedAt, timeZoneOf(prev.data))}.`,
    };
  }
  return { key, kind: 'error', error };
}

/**
 * What the screen shows now. Only an answer for THIS key is ever shown (one
 * for another item, page or workspace is not shown under this heading).
 * Offline nothing is asked: the answer on screen stays with its time, or the
 * screen says it needs a connection.
 */
export function verificationView<T>(
  stored: StoredVerification<T> | null,
  key: string | null,
  offline: boolean,
  timeZoneOf: (data: T) => string | null,
): VerificationView<T> {
  const mine = stored && key !== null && stored.key === key ? stored : null;
  if (offline) {
    if (mine?.kind === 'ready') {
      return {
        kind: 'ready',
        data: mine.data,
        receivedAt: mine.receivedAt,
        banner: `You are offline. Showing this as of ${exceptionTimeLabel(mine.receivedAt, timeZoneOf(mine.data))}.`,
      };
    }
    return {
      kind: 'error',
      error: { detail: VERIFICATION_OFFLINE_COPY, retry: false, keepShown: false },
    };
  }
  if (!mine) return { kind: 'loading' };
  if (mine.kind === 'error') return { kind: 'error', error: mine.error };
  return { kind: 'ready', data: mine.data, receivedAt: mine.receivedAt, banner: mine.banner };
}

// ── Words the screens add (the verification words themselves are core's) ──

/** "Checked at Sep 27, 10:40 AM." under the chips, or that the first check
 *  has not run (never an all-clear). */
export function verificationCheckedAtCopy(
  checkedAt: string | null,
  timeZone: string | null,
): string {
  return checkedAt
    ? `Checked at ${exceptionTimeLabel(checkedAt, timeZone)}.`
    : EXCEPTION_FIRST_CHECK_PENDING_COPY;
}

export const VERIFICATION_ISSUES_TRUNCATED_COPY = 'More open exceptions exist than are shown here.';

/** The holdings read stopped at the server's cap (core's words, the web's). */
export { LOCATION_HOLDINGS_TRUNCATED_COPY };

/** "Open issues here" with none, after a check has run, when nothing here is
 *  hidden from the reader (core locationOpenIssuesEmptyCopy picks the words). */
export { LOCATION_NO_OPEN_ISSUES_COPY };

export const LOCATION_WORKSPACE_UNAVAILABLE =
  'Your workspace could not be loaded, so this location cannot be shown. Check your connection and try again.';

/** The same labels as the web location page (location-verification.tsx):
 *  Staging and Unplaced are system locations, not places on a shelf. */
const KIND_LABEL: Record<string, string> = {
  rack: 'Rack',
  crate: 'Crate',
  area: 'Area',
  staging: 'System location',
  unplaced: 'System location',
};

/** A site's type (a location with no kind is a site). */
const TYPE_LABEL: Record<string, string> = {
  warehouse: 'Warehouse',
  room: 'Room',
  shelf: 'Shelf',
  bin: 'Bin',
  vehicle: 'Vehicle',
  jobsite: 'Job site',
  other: 'Other',
};

/** "Rack", "Crate", "System location", "Warehouse", ... or "Location". */
export function locationKindLabel(kind: string | null, type: string | null): string {
  return (kind && KIND_LABEL[kind]) || (type && TYPE_LABEL[type]) || 'Location';
}

/** "12 here" (a row's units at this location). */
export function locationRowQuantityCopy(q: number): string {
  return `${formatStockQuantity(q)} here`;
}

/**
 * Whether the words may link a cycle count ("CC-000031", "Being counted in
 * CC-000045"): the web's rule (lib/verification/count-page-access.ts, the
 * count pages' own gate), cycle_counts:read or stock:adjust. A display hint;
 * before the role is known, the count is named as plain text.
 */
export function canOpenCountScreen(
  role: Role | string | null | undefined,
  permissions: ReadonlySet<Permission> | undefined,
): boolean {
  if (!role) return false;
  const ctx = { role: role as Role, permissions };
  return can(ctx, 'cycle_counts:read') || can(ctx, 'stock:adjust');
}

/** What VoiceOver reads for a location row, in the order the row shows it. */
export function locationRowAccessibilityLabel(
  row: Pick<MobileLocationVerificationRow, 'name' | 'sku' | 'quantity'>,
  copy: LocationRowVerificationCopy,
  issueChips: readonly string[],
): string {
  return [
    row.sku ? `${row.name}, ${row.sku}` : row.name,
    locationRowQuantityCopy(row.quantity),
    copy.count,
    copy.movementsSince,
    copy.beingCounted?.text ?? null,
    copy.notCountable,
    ...issueChips,
  ]
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .join('. ');
}

// ── "Recount items here" ────────────────────────────────────────────────────

/**
 * Whether the location screen offers "Recount items here", and why it is
 * disabled. Only for a reader the server says may start one (a manager who can
 * start counts; plan section 5), and only where stock is listed. Disabled, with
 * the reason, when nothing here can be counted or too many items can (the
 * server's recountProblem), when the totals are partial (core
 * locationRecountProblemOf, the web page's rule too), or offline (core
 * recountDisabledReason, fed the LIVE network state).
 */
export function locationRecountState(
  v: Pick<
    MobileLocationVerification,
    'holdingsVisible' | 'canRecount' | 'recountProblem' | 'truncated' | 'totals'
  >,
  online: boolean,
): { show: boolean; disabledReason: string | null } {
  if (!v.holdingsVisible || !v.canRecount || !v.totals)
    return { show: false, disabledReason: null };
  const problem = locationRecountProblemOf(v);
  return {
    show: true,
    disabledReason: problem ?? recountDisabledReason({ canRecount: true, online }),
  };
}

/** Pages read to gather a recount's items. 20 pages is 1,000 rows. */
export const RECOUNT_GATHER_MAX_PAGES = 20;

export const RECOUNT_GATHER_TOO_MANY_PAGES_COPY =
  'Too many items are held here to gather them on the phone. Recount them from this location on the web, or count this location from Cycle Counts.';

export const RECOUNT_GATHER_CHANGED_COPY =
  'The stock here changed while the items were being gathered. Try again.';

export type GatheredRecountItems = { ok: true; itemIds: string[] } | { ok: false; message: string };

/**
 * Every item at the location that can be counted, for "Recount items here".
 *
 * The server sends them (recountItemIds: every countable row on every page,
 * from the same read as the totals), and that list is used as it came. From a
 * server that does not send it, the rows come a page at a time, so every page
 * is read (the one on screen is reused when there is only one) and the result
 * must agree with the server's own total of countable items: an item that
 * moved while the pages were read could otherwise be left out without anyone
 * knowing. Any disagreement refuses with the reason; a failed page read throws.
 */
export async function gatherRecountItemIds(
  current: MobileLocationVerification,
  fetchPage: (page: number) => Promise<MobileLocationVerification>,
): Promise<GatheredRecountItems> {
  if (!current.holdingsVisible || !current.totals)
    return { ok: false, message: RECOUNT_GATHER_CHANGED_COPY };
  // The server's own list, from the same read as the totals: nothing to
  // gather, and nothing can change between pages.
  if (current.recountItemIds !== null) {
    const ids = [...new Set(current.recountItemIds)];
    const listProblem = locationRecountProblem(ids.length);
    return listProblem ? { ok: false, message: listProblem } : { ok: true, itemIds: ids };
  }
  const expected = current.totals.countable;
  const problem = locationRecountProblem(expected);
  if (problem) return { ok: false, message: problem };
  if (current.pageCount > RECOUNT_GATHER_MAX_PAGES) {
    return { ok: false, message: RECOUNT_GATHER_TOO_MANY_PAGES_COPY };
  }
  const pages: MobileLocationVerification[] = [];
  if (current.pageCount === 1) {
    pages.push(current);
  } else {
    // One at a time: each page is a full read on the server.
    for (let p = 1; p <= current.pageCount; p += 1) pages.push(await fetchPage(p));
  }
  const ids = new Set<string>();
  for (const page of pages) {
    if (
      page.organizationId !== current.organizationId ||
      page.location.id !== current.location.id ||
      !page.holdingsVisible ||
      !page.totals ||
      page.totals.countable !== expected ||
      page.totalRows !== current.totalRows ||
      page.pageCount !== current.pageCount
    ) {
      return { ok: false, message: RECOUNT_GATHER_CHANGED_COPY };
    }
    for (const row of page.rows) if (row.summary?.item.countable === true) ids.add(row.itemId);
  }
  // `expected` passed locationRecountProblem above, so this is also at most
  // RECOUNT_MAX_ITEMS items.
  if (ids.size !== expected) return { ok: false, message: RECOUNT_GATHER_CHANGED_COPY };
  return { ok: true, itemIds: [...ids] };
}
