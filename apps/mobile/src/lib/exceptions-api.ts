import {
  EXCEPTION_RULES,
  exceptionActDisabledReason,
  formatOrgDateTime,
  isExceptionRule,
  type ExceptionActionKind,
  type ExceptionCheckNotScheduledReason,
  type ExceptionRule,
  type OccurrenceEventKind,
  type OccurrenceRecountRef,
  type OccurrenceResolvedReason,
} from '@stockpilot/core';

import { api } from './api';

/**
 * The Exception Center on the phone (F1-1): thin typed wrappers over the
 * Bearer routes under /api/v1/exceptions, which call the SAME
 * ExceptionOccurrencesService the web pages render. The shapes below mirror
 * server-only interfaces (apps/web/src/server/services/exception-occurrences.ts)
 * field for field, the same "mirror, don't reach into apps/web" posture every
 * other *-api.ts here follows.
 *
 * THREE RULES THIS MODULE KEEPS:
 *
 *   1. A failed read THROWS. It never resolves to an empty list: an empty
 *      Exceptions list reads as "nothing is wrong", which is the one thing a
 *      failed request must not say. A response that does not have the shape
 *      the screens need is a failure too (parseList / parseDetail).
 *   2. Nothing here syncs. The server's list and detail are stored state;
 *      `syncState.lastSyncedAt` is "Checked at", and a null syncState means
 *      the first check has not run (never "all clear").
 *   3. Offline, the list the screen last loaded in this app session is shown
 *      "as of" when it loaded (rememberList / recalledList). It lives in
 *      memory only, keyed by account and workspace, so it can never be shown
 *      to another account or for another workspace, and it is gone when the
 *      app restarts. Acting needs a connection (core exceptionActDisabledReason).
 */

// ── Shapes (mirrors of the server's) ────────────────────────────────────────

export interface ExceptionPerson {
  id: string | null;
  label: string;
}

export interface MobileExceptionOccurrence {
  id: string;
  number: number;
  reference: string | null;
  rule: ExceptionRule;
  itemId: string;
  item: { name: string; sku: string | null } | null;
  locationId: string | null;
  location: { name: string; kind: string | null; archived: boolean } | null;
  warehouseId: string | null;
  facts: Record<string, unknown>;
  conditionSince: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  presentWhenTrackingBegan: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: ExceptionPerson | null;
  recount: OccurrenceRecountRef | null;
  resolvedAt: string | null;
  resolvedReason: OccurrenceResolvedReason | null;
  previousOccurrenceId: string | null;
  recurrenceIndex: number;
  /** The server's hint that this reader may acknowledge or add a note. The
   *  database re-checks it on every action. */
  canAct: boolean;
}

export interface MobileExceptionSyncState {
  trackingStartedAt: string;
  lastEvaluatedAt: string;
  /** "Checked at". */
  lastSyncedAt: string;
  completeRules: ExceptionRule[];
  failedRules: ExceptionRule[];
  truncatedRules: ExceptionRule[];
  /** Failed or truncated rules this build cannot name: the ones the server
   *  counted (unknown to the server) plus the ones it sent that are unknown
   *  to this build. Unknown is not clean: no all-clear while above 0. */
  unrecognizedUncheckedRules: number;
}

export type ExceptionListStatus = 'open' | 'resolved';

export interface MobileExceptionList {
  organizationId: string;
  status: ExceptionListStatus;
  occurrences: MobileExceptionOccurrence[];
  truncated: boolean;
  syncState: MobileExceptionSyncState | null;
  canCheckNow: boolean;
  /** Open rows neither the server nor this build could word (a newer
   *  build's rule), left out of `occurrences` but COUNTED: a list with any
   *  never shows the all-clear state (core exceptionUnrecognizedCopy). */
  unrecognized: number;
  /** The org's time zone, so the phone prints the clock time the web does;
   *  null from an older server (the device zone is used then). */
  timeZone: string | null;
}

export interface MobileExceptionEvent {
  id: string;
  kind: OccurrenceEventKind;
  at: string;
  /** null = the system. */
  actor: ExceptionPerson | null;
  note: string | null;
  cycleCount: { id: string; countNumber: number | null } | null;
}

export interface MobileExceptionHistoryEntry {
  id: string;
  number: number;
  reference: string | null;
  firstSeenAt: string;
  resolvedAt: string | null;
  resolvedReason: OccurrenceResolvedReason | null;
  recurrenceIndex: number;
  isCurrent: boolean;
}

export interface MobileExceptionDetail {
  organizationId: string;
  occurrence: MobileExceptionOccurrence;
  timeline: MobileExceptionEvent[];
  history: MobileExceptionHistoryEntry[];
  historyTruncated: boolean;
  syncState: MobileExceptionSyncState | null;
  /** The org's time zone (see MobileExceptionList.timeZone). */
  timeZone: string | null;
}

export interface ExceptionCheckResult {
  scheduled: boolean;
  /** Why not, when not scheduled (core exceptionCheckNowCopy words it). */
  reason: ExceptionCheckNotScheduledReason | null;
  lastSyncedAt: string | null;
  retryAfterSeconds: number;
}

// ── Parsing (a malformed answer is a failure, never an empty list) ─────────

/** Thrown when a response does not have the shape the screens need. */
export class ExceptionsResponseError extends Error {
  constructor() {
    super('The server sent an unexpected answer. Pull down to try again.');
    this.name = 'ExceptionsResponseError';
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function rules(v: unknown): ExceptionRule[] {
  return Array.isArray(v) ? v.filter(isExceptionRule) : [];
}

/** A non-negative whole count from the server, or 0. */
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Distinct rule names in the lists that this build does not know. */
function unknownRuleNames(...lists: unknown[]): number {
  const names = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const r of list) if (typeof r === 'string' && !isExceptionRule(r)) names.add(r);
  }
  return names.size;
}

function parseSyncState(v: unknown): MobileExceptionSyncState | null {
  if (v === null || v === undefined) return null;
  if (!isObj(v) || typeof v.lastSyncedAt !== 'string') throw new ExceptionsResponseError();
  return {
    trackingStartedAt: strOrNull(v.trackingStartedAt) ?? v.lastSyncedAt,
    lastEvaluatedAt: strOrNull(v.lastEvaluatedAt) ?? v.lastSyncedAt,
    lastSyncedAt: v.lastSyncedAt,
    completeRules: rules(v.completeRules),
    failedRules: rules(v.failedRules),
    truncatedRules: rules(v.truncatedRules),
    // A rule the server did not know it left out and counted; one it sent
    // that this (older) build does not know is dropped here, so it is counted
    // here. The two never overlap.
    unrecognizedUncheckedRules:
      count(v.unrecognizedUncheckedRules) + unknownRuleNames(v.failedRules, v.truncatedRules),
  };
}

function person(v: unknown): ExceptionPerson | null {
  if (!isObj(v) || typeof v.label !== 'string') return null;
  return { id: strOrNull(v.id), label: v.label };
}

/** One occurrence, or null when its rule is one this build does not know (a
 *  newer server's rule): such a row cannot be worded safely, so it is left
 *  out rather than rendered with the wrong words. */
function parseOccurrence(v: unknown): MobileExceptionOccurrence | null {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.itemId !== 'string') {
    throw new ExceptionsResponseError();
  }
  if (!isExceptionRule(v.rule)) return null;
  const item = isObj(v.item) && typeof v.item.name === 'string'
    ? { name: v.item.name, sku: strOrNull(v.item.sku) }
    : null;
  const location = isObj(v.location) && typeof v.location.name === 'string'
    ? { name: v.location.name, kind: strOrNull(v.location.kind), archived: v.location.archived === true }
    : null;
  const rc = isObj(v.recount) && typeof v.recount.cycleCountId === 'string'
    ? {
        cycleCountId: v.recount.cycleCountId,
        countNumber: typeof v.recount.countNumber === 'number' ? v.recount.countNumber : null,
        status: typeof v.recount.status === 'string' ? v.recount.status : 'unknown',
        completedAt: strOrNull(v.recount.completedAt),
      }
    : null;
  const reason = v.resolvedReason;
  return {
    id: v.id,
    number: typeof v.number === 'number' ? v.number : 0,
    reference: strOrNull(v.reference),
    rule: v.rule,
    itemId: v.itemId,
    item,
    locationId: strOrNull(v.locationId),
    location,
    warehouseId: strOrNull(v.warehouseId),
    facts: isObj(v.facts) ? v.facts : {},
    conditionSince: strOrNull(v.conditionSince),
    firstSeenAt: strOrNull(v.firstSeenAt) ?? '',
    lastSeenAt: strOrNull(v.lastSeenAt) ?? '',
    presentWhenTrackingBegan: v.presentWhenTrackingBegan === true,
    acknowledgedAt: strOrNull(v.acknowledgedAt),
    acknowledgedBy: person(v.acknowledgedBy),
    recount: rc,
    resolvedAt: strOrNull(v.resolvedAt),
    resolvedReason:
      reason === 'cleared' || reason === 'reclassified' || reason === 'subject_gone' ? reason : null,
    previousOccurrenceId: strOrNull(v.previousOccurrenceId),
    recurrenceIndex: typeof v.recurrenceIndex === 'number' ? v.recurrenceIndex : 0,
    // Anything but an explicit true is "no": the phone never offers an action
    // the server did not say this reader may take.
    canAct: v.canAct === true,
  };
}

export function parseExceptionList(res: unknown): MobileExceptionList {
  if (!isObj(res) || !Array.isArray(res.occurrences) || typeof res.organizationId !== 'string') {
    throw new ExceptionsResponseError();
  }
  const occurrences: MobileExceptionOccurrence[] = [];
  // Rows this build cannot word are left out but COUNTED: an older bundle
  // must never read a list of only newer-rule rows as "Nothing needs
  // attention". The server counts the rows IT could not word the same way.
  let unrecognized = count(res.unrecognized);
  for (const row of res.occurrences) {
    const o = parseOccurrence(row);
    if (o) occurrences.push(o);
    else unrecognized += 1;
  }
  return {
    organizationId: res.organizationId,
    status: res.status === 'resolved' ? 'resolved' : 'open',
    occurrences,
    truncated: res.truncated === true,
    syncState: parseSyncState(res.syncState),
    canCheckNow: res.canCheckNow === true,
    unrecognized,
    timeZone: strOrNull(res.timeZone),
  };
}

const EVENT_KINDS: ReadonlySet<string> = new Set<OccurrenceEventKind>([
  'raised',
  'acknowledged',
  'note',
  'recount_linked',
  'recount_closed',
  'resolved',
  'evidence_added',
  'evidence_removed',
  'escalated',
]);

export function parseExceptionDetail(res: unknown): MobileExceptionDetail {
  if (!isObj(res) || typeof res.organizationId !== 'string' || !Array.isArray(res.timeline)) {
    throw new ExceptionsResponseError();
  }
  const occurrence = parseOccurrence(res.occurrence);
  // The list leaves an unknown rule out; a detail of one cannot be shown.
  if (!occurrence) throw new ExceptionsResponseError();
  const timeline: MobileExceptionEvent[] = [];
  for (const e of res.timeline) {
    if (!isObj(e) || typeof e.id !== 'string' || typeof e.at !== 'string') {
      throw new ExceptionsResponseError();
    }
    if (typeof e.kind !== 'string' || !EVENT_KINDS.has(e.kind)) continue;
    timeline.push({
      id: e.id,
      kind: e.kind as OccurrenceEventKind,
      at: e.at,
      actor: person(e.actor),
      note: strOrNull(e.note),
      cycleCount:
        isObj(e.cycleCount) && typeof e.cycleCount.id === 'string'
          ? {
              id: e.cycleCount.id,
              countNumber: typeof e.cycleCount.countNumber === 'number' ? e.cycleCount.countNumber : null,
            }
          : null,
    });
  }
  const history: MobileExceptionHistoryEntry[] = Array.isArray(res.history)
    ? res.history.filter(isObj).flatMap((h) =>
        typeof h.id === 'string'
          ? [
              {
                id: h.id,
                number: typeof h.number === 'number' ? h.number : 0,
                reference: strOrNull(h.reference),
                firstSeenAt: strOrNull(h.firstSeenAt) ?? '',
                resolvedAt: strOrNull(h.resolvedAt),
                resolvedReason:
                  h.resolvedReason === 'cleared' ||
                  h.resolvedReason === 'reclassified' ||
                  h.resolvedReason === 'subject_gone'
                    ? h.resolvedReason
                    : null,
                recurrenceIndex: typeof h.recurrenceIndex === 'number' ? h.recurrenceIndex : 0,
                isCurrent: h.isCurrent === true,
              },
            ]
          : [],
      )
    : [];
  return {
    organizationId: res.organizationId,
    occurrence,
    timeline,
    history,
    historyTruncated: res.historyTruncated === true,
    syncState: parseSyncState(res.syncState),
    timeZone: strOrNull(res.timeZone),
  };
}

// ── Requests ───────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function exceptionListPath(status: ExceptionListStatus): string {
  return `/api/v1/exceptions?status=${status}`;
}

/** The stored Open or Resolved list. Throws on any failure. */
export async function listExceptions(
  status: ExceptionListStatus,
  opts: { signal?: AbortSignal } = {},
): Promise<MobileExceptionList> {
  const res = await api<unknown>(exceptionListPath(status), { signal: opts.signal });
  return parseExceptionList(res);
}

/** One occurrence with its timeline and recurrence history. Throws on any
 *  failure (404 = not found or not visible to this account). */
export async function getException(id: string): Promise<MobileExceptionDetail> {
  if (!UUID.test(id)) throw new ExceptionsResponseError();
  const res = await api<unknown>(`/api/v1/exceptions/${id}`);
  return parseExceptionDetail(res);
}

/**
 * Acknowledge an occurrence or add a note. `clientEventId` belongs to the
 * PAYLOAD (see clientEventIdFor): reused only on a resend of the same action
 * and note, so a request that reached the server but whose answer was lost
 * adds nothing the second time, while an edited note is a new request.
 */
export async function actOnException(
  id: string,
  input: { action: 'acknowledge' | 'note'; note: string | null; clientEventId: string },
): Promise<MobileExceptionOccurrence> {
  const res = await api<unknown>(`/api/v1/exceptions/${id}/act`, {
    method: 'POST',
    body: { action: input.action, note: input.note, clientEventId: input.clientEventId },
  });
  const occurrence = isObj(res) ? parseOccurrence(res.occurrence) : null;
  if (!occurrence) throw new ExceptionsResponseError();
  return occurrence;
}

/** A manager's "Check now". Returns at once; the check runs on the server
 *  afterwards. */
export async function requestExceptionCheck(): Promise<ExceptionCheckResult> {
  const res = await api<unknown>('/api/v1/exceptions/check-now', { method: 'POST' });
  if (!isObj(res) || typeof res.scheduled !== 'boolean') throw new ExceptionsResponseError();
  return {
    scheduled: res.scheduled,
    reason:
      res.reason === 'recently_checked' || res.reason === 'already_requested' ? res.reason : null,
    lastSyncedAt: strOrNull(res.lastSyncedAt),
    retryAfterSeconds: typeof res.retryAfterSeconds === 'number' ? res.retryAfterSeconds : 0,
  };
}

/**
 * The idempotency key for one act submission. THE KEY BELONGS TO THE
 * PAYLOAD: the last attempt's key is reused only when the same action and
 * (trimmed) note are sent again, which is a resend after a lost answer;
 * anything else gets a fresh key. One key per sheet opening (as before) meant
 * a lost answer, an edited note and a second tap closed the sheet as "saved"
 * while the edit was dropped as a replay.
 */
export function clientEventIdFor(
  last: { action: 'acknowledge' | 'note'; note: string | null; id: string } | null,
  action: 'acknowledge' | 'note',
  note: string | null,
): string {
  return last && last.action === action && last.note === note ? last.id : newClientEventId();
}

/** A fresh idempotency key for one act submission. */
export function newClientEventId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Replay identity, not a secret: Math.random is enough.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * The sentence for a failed act. Keyed on HTTP status and the route's
 * app-authored `details.reason` (never on message text). The server's own
 * message is already a sentence and is used where it is the most specific.
 */
export function describeActError(e: unknown): string {
  const status = isObj(e) && typeof e.status === 'number' ? e.status : null;
  const details = isObj(e) ? e.details : undefined;
  const reason = isObj(details) && typeof details.reason === 'string' ? details.reason : null;
  const message = e instanceof Error && e.message ? e.message : null;
  if (status === 409 && reason === 'occurrence_resolved') {
    return 'This exception has already been resolved. Pull down to refresh.';
  }
  if (status === 409 && reason === 'client_event_id_conflict') {
    return 'This could not be saved as sent. Please try again.';
  }
  if (status === 403) return 'You do not have permission to act on this exception.';
  if (status === 404) return 'This exception is no longer available to you.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status === 400 && reason === 'note_required') return 'Add a note.';
  if (status === 400 && reason === 'note_too_long') return 'Notes can be at most 1,000 characters.';
  if (status !== null && status >= 500) return 'The server had a problem. Try again in a moment.';
  return message ?? 'Could not save. Check your connection and try again.';
}

/**
 * The sentence for a failed list read or Check now. Keyed on the HTTP status
 * first: a 429 or a 5xx is worded here, because a server answer without a
 * message would otherwise surface its bare code ("rate_limited",
 * "internal_error") as the text on screen. Otherwise the server's own
 * sentence, and a fallback when there is none.
 */
export function describeExceptionsRequestError(e: unknown, fallback: string): string {
  const status = isObj(e) && typeof e.status === 'number' ? e.status : null;
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status !== null && status >= 500) return 'The server had a problem. Try again in a moment.';
  const message = e instanceof Error && e.message ? e.message : null;
  // A lone snake_case token is a code, not a sentence.
  if (!message || /^[a-z0-9_]+$/.test(message)) return fallback;
  return message;
}

// ── Where each action goes on the phone ────────────────────────────────────

/** The native route for an action kind: the item screen for opening an item
 *  or editing its label, the Staging worklist for a put-away. */
export function exceptionActionRoute(kind: ExceptionActionKind, itemId: string): string {
  return kind === 'put_away' ? '/staging' : `/item/${itemId}`;
}

/** The actions a rule offers, in core's order. */
export function exceptionActionsFor(rule: ExceptionRule): readonly ExceptionActionKind[] {
  return EXCEPTION_RULES[rule].actions;
}

// ── Offline "as of" (memory only, this app session) ────────────────────────

export interface RememberedList {
  list: MobileExceptionList;
  /** When the phone received it (the "as of" time). */
  receivedAt: string;
}

const remembered = new Map<string, RememberedList>();
const rememberedDetail = new Map<string, { detail: MobileExceptionDetail; receivedAt: string }>();

function listKey(userId: string, orgId: string, status: ExceptionListStatus): string {
  return `${userId}\u0000${orgId}\u0000${status}`;
}

/** Keep the last list this account loaded for this workspace. A list for any
 *  other workspace than the one asked about is never kept. */
export function rememberList(
  userId: string | null,
  orgId: string | null,
  list: MobileExceptionList,
  receivedAt: Date = new Date(),
): void {
  if (!userId || !orgId || list.organizationId !== orgId) return;
  remembered.set(listKey(userId, orgId, list.status), { list, receivedAt: receivedAt.toISOString() });
}

export function recalledList(
  userId: string | null,
  orgId: string | null,
  status: ExceptionListStatus,
): RememberedList | null {
  if (!userId || !orgId) return null;
  return remembered.get(listKey(userId, orgId, status)) ?? null;
}

export function rememberDetail(
  userId: string | null,
  orgId: string | null,
  detail: MobileExceptionDetail,
  receivedAt: Date = new Date(),
): void {
  if (!userId || !orgId || detail.organizationId !== orgId) return;
  rememberedDetail.set(`${userId}\u0000${orgId}\u0000${detail.occurrence.id}`, {
    detail,
    receivedAt: receivedAt.toISOString(),
  });
}

export function recalledDetail(
  userId: string | null,
  orgId: string | null,
  id: string,
): { detail: MobileExceptionDetail; receivedAt: string } | null {
  if (!userId || !orgId) return null;
  return rememberedDetail.get(`${userId}\u0000${orgId}\u0000${id}`) ?? null;
}

/** Test seam: forget everything remembered. */
export function forgetRememberedExceptions(): void {
  remembered.clear();
  rememberedDetail.clear();
}

// ── Time labels (the org's time zone) ──────────────────────────────────────

const TIME_LABEL_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/**
 * "Sep 24, 3:42 PM" in the ORG's time zone, as the web page prints it
 * (formatOrgDateTime, the same options), so "Checked at", first seen and the
 * timeline name the same clock time on both surfaces. `timeZone` comes from
 * the server with the list or detail; without it (an older server) the
 * device's zone is used. An em dash for a bad value.
 */
export function exceptionTimeLabel(iso: string | null | undefined, timeZone?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  if (timeZone) return formatOrgDateTime(d, TIME_LABEL_OPTIONS, timeZone);
  return d.toLocaleString('en-US', TIME_LABEL_OPTIONS);
}

/** The offline banner over a remembered list. */
export function offlineAsOfCopy(receivedAt: string, timeZone?: string | null): string {
  return `You are offline. Showing the list as of ${exceptionTimeLabel(receivedAt, timeZone)}.`;
}

/** Offline with nothing remembered: say so, never show an empty list. */
export const EXCEPTIONS_OFFLINE_NOTHING_LOADED_COPY =
  'You are offline. Exceptions need a connection to load. Reconnect and pull down to try again.';

/** The network state from expo-network, read defensively: only a definite
 *  "not connected" or "not reachable" counts as offline, the same rule
 *  sync.ts isOnline() applies. Unknown reads as online (the request then
 *  succeeds or fails on its own). */
export function isOfflineState(state: { isConnected?: boolean | null; isInternetReachable?: boolean | null } | null | undefined): boolean {
  if (!state) return false;
  return state.isConnected === false || state.isInternetReachable === false;
}

// ── The Acknowledge and Note sheets ────────────────────────────────────────

/** Longest note the server accepts, in characters, after trimming. */
export const EXCEPTION_NOTE_MAX = 1000;

export type ExceptionSheetMode = 'acknowledge' | 'note';

/**
 * Whether a sheet's submit button is enabled, and the reason shown when it is
 * not. The reason comes from core exceptionActDisabledReason (resolved, not
 * permitted, offline) so the sheet and the detail screen's buttons say the
 * same thing; the sheet adds only its own field rules. `online` is the LIVE
 * network state: turning on airplane mode with a sheet open disables it.
 */
export function exceptionSheetSubmit(input: {
  mode: ExceptionSheetMode;
  note: string;
  submitting: boolean;
  online: boolean;
  canAct: boolean;
  resolved: boolean;
}): { enabled: boolean; reason: string | null } {
  const reason = exceptionActDisabledReason({
    resolved: input.resolved,
    canAct: input.canAct,
    online: input.online,
  });
  if (reason) return { enabled: false, reason };
  const trimmed = input.note.trim();
  if (Array.from(trimmed).length > EXCEPTION_NOTE_MAX) {
    return { enabled: false, reason: 'Notes can be at most 1,000 characters.' };
  }
  if (input.mode === 'note' && trimmed === '') return { enabled: false, reason: null };
  return { enabled: !input.submitting, reason: null };
}
