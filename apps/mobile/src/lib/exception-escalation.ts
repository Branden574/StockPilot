import {
  ESCALATE_AAL2_REQUIRED_COPY,
  ESCALATE_MFA_REQUIRED_COPY,
  ESCALATE_MODULE_OFF_COPY,
  ESCALATE_NOT_PERMITTED_COPY,
  ESCALATE_OFFLINE_COPY,
  ESCALATE_RESOLVED_COPY,
  ESCALATE_SERVER_PROBLEM_COPY,
  ESCALATE_TOO_MANY_COPY,
  ESCALATION_BUSY_COPY,
  ESCALATION_CHANGED_COPY,
  ESCALATION_IN_PROGRESS_ELSEWHERE_COPY,
  ESCALATION_LINK_FAILED_COPY,
  escalateDisabledReason,
  escalationAlreadyEscalatedCopy,
  escalationBadgeCopy,
  escalationDuplicateCopy,
  escalationFailureCopy,
  escalationInProgressCopy,
  escalationOpenRequestLabel,
  escalationPrefill,
  escalationRequestStateCopy,
  escalationSourceLines as coreEscalationSourceLines,
  type EscalateUnavailableReason,
  type EscalationHolder,
  type EscalationPrefill,
  type EscalationSavedRequest,
  type ExceptionRule,
  type MaintenancePriority,
} from '@stockpilot/core';

import { api } from './api';

/**
 * Escalating an exception to maintenance, on the phone (F1-5, migration 0376;
 * Outlook rule 3). The native twin of the web's "Escalate to maintenance",
 * over the Bearer route:
 *
 *   POST /api/v1/exceptions/[id]/escalate  {subject, description, priority?, category?}
 *
 * and the `escalation`, `canEscalate` and `escalateUnavailableReason` fields
 * of GET /api/v1/exceptions and /api/v1/exceptions/[id].
 *
 * THE RULES THIS MODULE KEEPS (owner decisions, 2026-09-27):
 *
 *   1. EXPLICIT. A person taps "Escalate to maintenance" on the exception,
 *      reviews the prefilled form and taps Save. That saves ONE maintenance
 *      request linked to the exception; a second attempt opens the linked one.
 *   2. NOTHING IS SENT. The email composer (Outlook, the default mail app, or
 *      copy) opens only when the person taps it on the request's screen. This
 *      module never opens a composer and never says "sent" or "ticket".
 *   3. ONLINE ONLY. There is no outbox kind and nothing is kept to try later,
 *      so an offline replay can never create a request or open a composer.
 *      Offline, the action is disabled with core's words, which say so.
 *   4. Escalating neither acknowledges nor resolves the exception.
 *   5. The item and the location come from the exception on the SERVER; the
 *      phone sends only the four fields a person fills in.
 *   6. Every sentence the web also shows comes from core
 *      (warehouse/exception-escalation.ts), the failure sentences included
 *      (busy, in progress and who holds it, what became of a request that
 *      was saved, a server problem). The words here are the phone's own
 *      states only (a lost answer, an answer that could not be read).
 *
 * No native imports, so exceptions-api.ts and the node tests can load it.
 */

// ── Shapes (mirrors of the server's) ────────────────────────────────────────

/** What a reader who can open the linked request sees of it. Only what
 *  StockPilot records: a draft opened (or not yet), or the request was
 *  cancelled. Never "sent". */
export interface MobileEscalationRequestView {
  status: string;
  draftOpened: boolean;
  cancelled: boolean;
}

/** An occurrence's escalation (mirror of OccurrenceEscalation,
 *  apps/web/src/server/services/exception-occurrences.ts). */
export interface MobileOccurrenceEscalation {
  /** The linked request; null only if it was deleted. */
  requestId: string | null;
  requestNumber: number;
  /** "MR-2026-000014" (the year from the request's own creation time). */
  reference: string | null;
  escalatedAt: string;
  escalatedBy: { id: string | null; label: string } | null;
  /** Whether the linked request was cancelled, told to EVERY reader of the
   *  exception (the server's computed field): true frees it for a new
   *  escalation, and the badge says so. null when not known. */
  requestCancelled: boolean | null;
  /** Whether THIS reader can open the request. null on list reads, or when
   *  the server's check failed. */
  visibleToReader: boolean | null;
  /** Filled only for a reader who can open the request. */
  request: MobileEscalationRequestView | null;
}

const REASONS: ReadonlySet<string> = new Set<EscalateUnavailableReason>([
  'module_disabled',
  'not_permitted',
  'resolved',
  'already_escalated',
]);

export function isEscalateUnavailableReason(v: unknown): v is EscalateUnavailableReason {
  return typeof v === 'string' && REASONS.has(v);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The occurrence's `escalation` block, or null when it was never escalated
 * (or the block is not one the phone can trust: a badge naming a request is
 * never guessed). The request's state is kept only when BOTH of its flags
 * are real booleans, so "Email draft opened" is never shown on a guess.
 */
export function parseEscalation(v: unknown): MobileOccurrenceEscalation | null {
  if (!isObj(v)) return null;
  const n = v.requestNumber;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) return null;
  if (typeof v.escalatedAt !== 'string') return null;
  const r = v.request;
  const request =
    isObj(r) && typeof r.draftOpened === 'boolean' && typeof r.cancelled === 'boolean'
      ? { status: typeof r.status === 'string' ? r.status : 'unknown', draftOpened: r.draftOpened, cancelled: r.cancelled }
      : null;
  const by = v.escalatedBy;
  return {
    requestId: typeof v.requestId === 'string' && UUID.test(v.requestId) ? v.requestId : null,
    requestNumber: n,
    reference: strOrNull(v.reference),
    escalatedAt: v.escalatedAt,
    escalatedBy: isObj(by) && typeof by.label === 'string' ? { id: strOrNull(by.id), label: by.label } : null,
    requestCancelled: v.requestCancelled === true ? true : v.requestCancelled === false ? false : null,
    visibleToReader: v.visibleToReader === true ? true : v.visibleToReader === false ? false : null,
    request,
  };
}

// ── What the exception screen shows ────────────────────────────────────────

/** The occurrence fields the escalation decisions read. */
export interface EscalatableOccurrence {
  resolvedAt: string | null;
  canEscalate: boolean;
  escalateUnavailableReason: EscalateUnavailableReason | null;
  escalation: MobileOccurrenceEscalation | null;
}

/**
 * The request an escalation links, when THIS reader can open it here: the
 * server confirmed they can (visibleToReader true, read through their own
 * RLS; null means it was not checked or the check failed, so no link) and
 * the maintenance screens are on (here, and not module_disabled on the
 * server; the request screen says "not enabled" otherwise). The web's rule.
 */
export function openableRequestId(o: EscalatableOccurrence, maintenanceEnabled: boolean): string | null {
  const e = o.escalation;
  if (!e || e.requestId === null || e.visibleToReader !== true) return null;
  if (!maintenanceEnabled || o.escalateUnavailableReason === 'module_disabled') return null;
  return e.requestId;
}

export interface EscalationSectionView {
  /** Render the MAINTENANCE section at all. */
  show: boolean;
  /** "Escalated: MR-2026-000014", to every reader of an escalated exception
   *  ("(request cancelled)" once it is). */
  badge: string | null;
  /** Who escalated it (null: the system, or a former member). */
  escalatedBy: string | null;
  escalatedAt: string | null;
  /** "Email draft opened" / "Email draft not yet opened", only for a reader
   *  who can open the request (a cancelled one: the badge says so). */
  requestState: string | null;
  /** The request the badge opens, or null (the badge is then plain text). */
  openRequestId: string | null;
  /** Offer the "Escalate to maintenance" button. */
  offerButton: boolean;
  /** Why the offered button is disabled (offline), or null. */
  buttonDisabledReason: string | null;
  /** Already escalated to a request this reader cannot open here: a new
   *  request can be made only if that one is cancelled. */
  note: string | null;
}

/**
 * The exception screen's MAINTENANCE section, as the web's Maintenance card
 * decides it. Shown when the exception was escalated, or when this reader
 * may escalate it; hidden otherwise (the module off, no
 * maintenance_requests:submit, or a resolved exception never escalated).
 *
 * The gates are the web's: the server's hint (canEscalate: the
 * maintenance_requests module, maintenance_requests:submit, an open
 * exception, no linked request that is not cancelled) AND this phone's own
 * view of the module and the permission. The database re-checks everything.
 * Offline the button is DISABLED with the reason: nothing is kept to try
 * later.
 */
export function escalationSectionView(input: {
  occurrence: EscalatableOccurrence;
  maintenanceEnabled: boolean;
  canSubmit: boolean;
  online: boolean;
}): EscalationSectionView {
  const o = input.occurrence;
  const e = o.escalation;
  const openRequestId = openableRequestId(o, input.maintenanceEnabled);
  const offerButton = o.resolvedAt === null && o.canEscalate && input.maintenanceEnabled && input.canSubmit;
  return {
    show: e !== null || offerButton,
    badge: e ? escalationBadgeCopy(e.reference, e.requestCancelled) : null,
    escalatedBy: e?.escalatedBy?.label ?? null,
    escalatedAt: e?.escalatedAt ?? null,
    requestState: e ? escalationRequestStateCopy(e.request) : null,
    openRequestId,
    offerButton,
    buttonDisabledReason: offerButton ? escalateDisabledReason({ reason: null, online: input.online }) : null,
    note:
      !offerButton && e && o.escalateUnavailableReason === 'already_escalated' && openRequestId === null
        ? escalationAlreadyEscalatedCopy(e.reference)
        : null,
  };
}

/** The native route the exception's "Escalate to maintenance" opens: the
 *  request form, told which exception it escalates (and its location, a hint
 *  only; the server takes both from the exception). */
export function escalateFormRoute(occurrence: { id: string; locationId: string | null }): {
  pathname: '/maintenance/new';
  params: { exceptionOccurrenceId: string; locationId?: string };
} {
  return {
    pathname: '/maintenance/new',
    params: occurrence.locationId
      ? { exceptionOccurrenceId: occurrence.id, locationId: occurrence.locationId }
      : { exceptionOccurrenceId: occurrence.id },
  };
}

// ── The request form, escalating ───────────────────────────────────────────

/**
 * One id from the route's search params (expo-router hands a repeated key as
 * an array): a well-formed uuid, else null. A deep-link HINT only; the
 * server re-checks every id against this organization.
 */
export function uuidParam(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && UUID.test(s) ? s : null;
}

/**
 * What the request form was opened for: an ordinary request (no exception
 * param), escalating one exception, or a malformed exception param. The last
 * is never a silent fall back to an ordinary, unlinked request (the web
 * answers 404 for it too).
 */
export function escalationTarget(
  param: string | string[] | undefined,
): { kind: 'request' } | { kind: 'escalate'; occurrenceId: string } | { kind: 'malformed' } {
  if (param === undefined) return { kind: 'request' };
  const id = uuidParam(param);
  return id ? { kind: 'escalate', occurrenceId: id } : { kind: 'malformed' };
}

/** The request form opened with an exception param that is not an id. */
export const ESCALATE_BAD_LINK_COPY = 'This exception is not available to you, or it no longer exists.';

/** The request form's launch params, as the route hands them (a repeated key
 *  arrives as an array). */
export interface RequestFormParams {
  itemId?: string | string[];
  orderRequestId?: string | string[];
  rentalId?: string | string[];
  charterId?: string | string[];
  subject?: string | string[];
  exceptionOccurrenceId?: string | string[];
  locationId?: string | string[];
}

/**
 * What the request form is FOR, as a key the screen mounts its form under.
 *
 * expo-router REUSES the request screen when a link to /maintenance/new
 * arrives while it is on top (a notification or a web link, rewritten by
 * web-path-rewrite): the route stays and only its params change. Without a
 * key the form kept everything it held; the simulator walk (2026-09-27)
 * found a plain New request form turned into the escalation form with the
 * plain request's subject still in it (the prefill never writes over typed
 * text), so Save would have escalated with an unrelated subject.
 *
 *   - Escalating: the exception, and nothing else. The server takes the item
 *     and the location from the exception, so a second link for the SAME
 *     exception (from the web, with or without the location hint) is the
 *     same form, and what was typed stays.
 *   - A plain request: every launch param, because its related records ride
 *     on Save. What was typed for one launch never rides with another's.
 *   - A malformed exception param: refused (the screen's gate).
 */
export function requestFormKey(params: RequestFormParams): string {
  const target = escalationTarget(params.exceptionOccurrenceId);
  if (target.kind === 'escalate') return `escalate:${target.occurrenceId}`;
  if (target.kind === 'malformed') return 'malformed';
  return `request:${JSON.stringify([
    params.itemId ?? null,
    params.orderRequestId ?? null,
    params.rentalId ?? null,
    params.charterId ?? null,
    params.subject ?? null,
    params.locationId ?? null,
  ])}`;
}

/** The form the screen shows, and whether it replaced one that held unsaved
 *  input (what the person entered, never the prefill). */
export interface RequestFormSlot {
  key: string;
  replacedUnsaved: boolean;
}

/**
 * The slot for the form the route now asks for. The same form keeps its slot.
 * A new one says it replaced unsaved input only when the form it replaced
 * held some (`unsavedKey`, the key of the form holding unsaved input, or
 * null: none, or its request was saved). Nothing entered on the old form is
 * carried into the new one: a plain draft is never sent as an escalation.
 */
export function nextRequestFormSlot(slot: RequestFormSlot, key: string, unsavedKey: string | null): RequestFormSlot {
  if (slot.key === key) return slot;
  return { key, replacedUnsaved: unsavedKey !== null && unsavedKey === slot.key };
}

/** Said on a form that a link opened in place of one holding unsaved input. */
export const REQUEST_FORM_REPLACED_COPY =
  'A link opened this form in place of the request you were filling in. What you entered there was not saved and is not part of this request.';

/** The occurrence fields the prefill and the linked-exception card read. */
export interface EscalationSource extends EscalatableOccurrence {
  id: string;
  reference: string | null;
  rule: ExceptionRule;
  facts: Record<string, unknown>;
  item: { name: string; sku: string | null } | null;
  location: { name: string; archived: boolean } | null;
  conditionSince: string | null;
}

/** The form's prefill, from core (the web uses the same words). */
export function escalationFormPrefill(o: EscalationSource, asOf: Date = new Date()): EscalationPrefill {
  return escalationPrefill({
    rule: o.rule,
    facts: o.facts,
    itemName: o.item?.name ?? null,
    sku: o.item?.sku ?? null,
    locationName: o.location?.name ?? null,
    reference: o.reference,
    conditionSince: o.conditionSince,
    asOf: o.resolvedAt ?? asOf,
  });
}

/** The linked-exception card's lines: the reference and rule, the item, and
 *  the location when the condition is at one. Core's, so the web's card says
 *  the same words. */
export function escalationSourceLines(o: Pick<EscalationSource, 'reference' | 'rule' | 'item' | 'location'>): {
  heading: string;
  item: string | null;
  location: string | null;
} {
  return coreEscalationSourceLines(o);
}

/** Escalating is not offered for this exception, and the server gave no
 *  reason (an older server). Never offered on a guess. */
export const ESCALATE_UNAVAILABLE_COPY = 'Escalating is not available for this exception.';

export type EscalationLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; occurrence: EscalationSource }
  | { kind: 'error'; message: string };

export interface EscalationFormState {
  /** Show the form's fields and Save: the exception loaded and the server
   *  says it may be escalated. Otherwise only the linked-exception card, with
   *  why (the web shows no form either: a plain request would not be linked). */
  showForm: boolean;
  saveEnabled: boolean;
  /** Why Save is disabled (offline), or why there is no form; null when
   *  neither (or while loading online). */
  reason: string | null;
  /** Already escalated to a request this reader can open: open it instead. */
  openExisting: { requestId: string; label: string } | null;
}

/**
 * The escalating form's state. Reasons reconnecting would not change come
 * first (core's order), then the offline one. The form never escalates an
 * exception it has not shown.
 */
export function escalationFormState(input: {
  load: EscalationLoad;
  online: boolean;
  saving: boolean;
  maintenanceEnabled: boolean;
}): EscalationFormState {
  const { load, online } = input;
  const offlineReason = online ? null : ESCALATE_OFFLINE_COPY;
  if (load.kind !== 'ready') {
    return { showForm: false, saveEnabled: false, reason: offlineReason, openExisting: null };
  }
  const o = load.occurrence;
  if (o.resolvedAt !== null) {
    return { showForm: false, saveEnabled: false, reason: ESCALATE_RESOLVED_COPY, openExisting: null };
  }
  if (!o.canEscalate) {
    const requestId =
      o.escalateUnavailableReason === 'already_escalated' ? openableRequestId(o, input.maintenanceEnabled) : null;
    return {
      showForm: false,
      saveEnabled: false,
      reason: o.escalateUnavailableReason
        ? escalateDisabledReason({ reason: o.escalateUnavailableReason, reference: o.escalation?.reference ?? null, online })
        : ESCALATE_UNAVAILABLE_COPY,
      openExisting: requestId
        ? { requestId, label: escalationOpenRequestLabel(o.escalation?.reference ?? null) }
        : null,
    };
  }
  return { showForm: true, saveEnabled: online && !input.saving, reason: offlineReason, openExisting: null };
}

/**
 * The category to show selected and to send: the chosen one only while the
 * organization's list has it. The prefill suggests "Inventory or equipment";
 * an organization that configured other names never gets it (the web's
 * rule), and a value that is not on screen is never sent.
 */
export function listedCategory(categories: readonly string[], selected: string | null): string | null {
  return selected !== null && categories.includes(selected) ? selected : null;
}

// ── The request ────────────────────────────────────────────────────────────

/** The four fields a person fills in; nothing else is sent. */
export interface EscalationFields {
  subject: string;
  description: string;
  priority: MaintenancePriority;
  category: string | null;
}

/** The request the escalation saved and linked. */
export interface EscalationCreated {
  id: string;
  requestNumber: number;
  /** "MR-2026-000014". */
  reference: string | null;
  createdAt: string;
}

/** The escalation can take longer than a read: it claims the exception,
 *  saves the request (which notifies exactly as the request form does) and
 *  links it. A lost answer is safe to retry (see describeEscalateError). */
export const ESCALATE_TIMEOUT_MS = 45_000;

/** The server said it saved the request, but its answer could not be read. */
export const ESCALATION_ANSWER_UNREADABLE_COPY =
  'The request was saved, but the answer could not be read. Go back to the exception and pull down to see it.';

/** Thrown for a 2xx answer without the request's id: it WAS saved. */
export class EscalationAnswerError extends Error {
  constructor() {
    super(ESCALATION_ANSWER_UNREADABLE_COPY);
    this.name = 'EscalationAnswerError';
  }
}

export function parseEscalationCreated(res: unknown): EscalationCreated {
  if (!isObj(res) || typeof res.id !== 'string' || !UUID.test(res.id)) throw new EscalationAnswerError();
  const n = res.requestNumber;
  return {
    id: res.id,
    requestNumber: typeof n === 'number' && Number.isSafeInteger(n) ? n : 0,
    reference: strOrNull(res.reference),
    createdAt: strOrNull(res.createdAt) ?? '',
  };
}

/**
 * Escalate one occurrence. Online only: this is a direct request, never
 * queued. Sends ONLY the four fields a person fills in; the item and the
 * location come from the occurrence on the server.
 */
export async function escalateException(occurrenceId: string, fields: EscalationFields): Promise<EscalationCreated> {
  if (!UUID.test(occurrenceId)) throw new Error('That exception id is not valid.');
  const res = await api<unknown>(`/api/v1/exceptions/${occurrenceId}/escalate`, {
    method: 'POST',
    body: {
      subject: fields.subject,
      description: fields.description,
      priority: fields.priority,
      category: fields.category,
    },
    timeoutMs: ESCALATE_TIMEOUT_MS,
  });
  return parseEscalationCreated(res);
}

// ── Errors ─────────────────────────────────────────────────────────────────

/** No answer (offline mid-send, a dropped connection, the timeout). The
 *  request may have reached the server, and a retry is safe: an exception
 *  that was escalated answers with its request, which opens. */
export const ESCALATE_UNCONFIRMED_COPY =
  'The server did not answer, so it is not known whether the request was saved. Try again in a moment: if this exception was escalated, its request opens instead of a new one.';

/** A 5xx: the server may have saved a request it could not link or confirm
 *  (core's words; the web says the same). */
export { ESCALATE_SERVER_PROBLEM_COPY, ESCALATE_TOO_MANY_COPY };

export const ESCALATE_NOT_AVAILABLE_COPY = 'This exception is no longer available to you.';

export interface EscalateErrorView {
  message: string;
  /** Already escalated (the 409): the linked request's id and handle. It is
   *  opened only for a reader who can open it (duplicateOutcome). */
  duplicate: { requestId: string; reference: string | null } | null;
  /** Sending the same thing again may work (busy, in progress, no answer). */
  retryable: boolean;
}

/** `details.holder` from a 409 escalation_in_progress: who is escalating
 *  (this person, or a coworker by name). Anything else names nobody. */
function parseHolder(v: unknown): EscalationHolder | null {
  if (!isObj(v)) return null;
  if (v.self === true) return { self: true };
  if (v.self === false) return { self: false, label: strOrNull(v.label) };
  return null;
}

/** `details.savedRequest`: a request the server saved before the refusal,
 *  and whether it cancelled it. Only a real boolean counts: "cancelled" is
 *  never said on a guess. */
function parseSavedRequest(v: unknown): EscalationSavedRequest | null {
  if (!isObj(v) || typeof v.cancelled !== 'boolean') return null;
  return { reference: strOrNull(v.reference), cancelled: v.cancelled };
}

/**
 * What a failed escalation means, keyed on the HTTP status and the route's
 * app-authored `details` (never on message text). Words from core wherever
 * the web shows the same state; a refusal after the request was saved says
 * what became of it (core escalationFailureCopy, as the server's message
 * does).
 */
export function describeEscalateError(e: unknown): EscalateErrorView {
  if (e instanceof EscalationAnswerError) return { message: e.message, duplicate: null, retryable: false };
  const status = isObj(e) && typeof e.status === 'number' ? e.status : null;
  const details = isObj(e) ? e.details : undefined;
  const reason = isObj(details) && typeof details.reason === 'string' ? details.reason : null;
  const code = isObj(e) && typeof e.code === 'string' ? e.code : null;
  const retryableFlag = isObj(details) && details.retryable === true;
  const message = e instanceof Error && e.message && !/^[a-z0-9_]+$/.test(e.message) ? e.message : null;
  const saved = isObj(details) ? parseSavedRequest(details.savedRequest) : null;
  const say = (base: string) => escalationFailureCopy(base, saved);

  if (status === 409) {
    if (reason === 'already_escalated') {
      const requestId = isObj(details) && typeof details.requestId === 'string' && UUID.test(details.requestId)
        ? details.requestId
        : null;
      const reference = isObj(details) ? strOrNull(details.reference) : null;
      return requestId
        ? { message: escalationDuplicateCopy(reference), duplicate: { requestId, reference }, retryable: false }
        : { message: say(ESCALATION_CHANGED_COPY), duplicate: null, retryable: false };
    }
    if (reason === 'escalation_in_progress') {
      const holder = isObj(details) ? parseHolder(details.holder) : null;
      return { message: escalationInProgressCopy(holder), duplicate: null, retryable: true };
    }
    if (reason === 'escalation_in_progress_elsewhere') {
      return { message: ESCALATION_IN_PROGRESS_ELSEWHERE_COPY, duplicate: null, retryable: true };
    }
    if (reason === 'occurrence_resolved') return { message: say(ESCALATE_RESOLVED_COPY), duplicate: null, retryable: false };
    if (reason === 'escalation_not_claimed' || reason === 'request_not_eligible') {
      return { message: say(ESCALATION_CHANGED_COPY), duplicate: null, retryable: false };
    }
    if (reason === 'busy') return { message: say(ESCALATION_BUSY_COPY), duplicate: null, retryable: true };
    if (reason === 'not_linked') return { message: say(ESCALATION_LINK_FAILED_COPY), duplicate: null, retryable: false };
    // The maintenance create limit (no reason): the server's own sentence.
    return {
      message: message ?? say(ESCALATION_BUSY_COPY),
      duplicate: null,
      retryable: retryableFlag,
    };
  }
  if (status === 403) {
    // The MFA gate comes first on the server (assertPermission): word it as
    // the phone's other flows do, never as a missing permission.
    if (reason === 'aal2_required') return { message: ESCALATE_AAL2_REQUIRED_COPY, duplicate: null, retryable: false };
    if (reason === 'mfa_required') return { message: ESCALATE_MFA_REQUIRED_COPY, duplicate: null, retryable: false };
    return {
      message: say(
        reason === 'module_disabled' || code === 'module_disabled' ? ESCALATE_MODULE_OFF_COPY : ESCALATE_NOT_PERMITTED_COPY,
      ),
      duplicate: null,
      retryable: false,
    };
  }
  if (status === 404) return { message: say(ESCALATE_NOT_AVAILABLE_COPY), duplicate: null, retryable: false };
  if (status === 429) return { message: ESCALATE_TOO_MANY_COPY, duplicate: null, retryable: true };
  if (status !== null && status >= 500) {
    return { message: ESCALATE_SERVER_PROBLEM_COPY, duplicate: null, retryable: false };
  }
  if (status === 400) {
    return { message: message ?? 'Check the form and try again.', duplicate: null, retryable: false };
  }
  if (status === null) {
    // Never reached the server, or the answer was lost (api() words its own
    // timeout; any other network failure has no status).
    return { message: ESCALATE_UNCONFIRMED_COPY, duplicate: null, retryable: true };
  }
  return { message: message ?? 'Could not escalate this exception.', duplicate: null, retryable: false };
}


/**
 * After a 409 already_escalated: open the linked request only when this
 * reader can open it, read from the exception again (`fresh`, null when that
 * read failed). Anyone else stays, told a new request can be made only if
 * that one is cancelled: sending them to a request they cannot open would
 * end on an error. The web's rule.
 */
export function duplicateOutcome(
  duplicate: { requestId: string; reference: string | null },
  fresh: EscalatableOccurrence | null,
  maintenanceEnabled: boolean,
): { kind: 'open'; requestId: string; message: string } | { kind: 'stay'; message: string } {
  if (fresh && openableRequestId(fresh, maintenanceEnabled) === duplicate.requestId) {
    return { kind: 'open', requestId: duplicate.requestId, message: escalationDuplicateCopy(duplicate.reference) };
  }
  return { kind: 'stay', message: escalationAlreadyEscalatedCopy(duplicate.reference) };
}
