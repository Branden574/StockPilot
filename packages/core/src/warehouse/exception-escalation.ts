/**
 * Escalating an exception to a maintenance request (F1-5, migration 0376).
 *
 * ONE source for the web app and the phone: the form's prefill and every
 * sentence the occurrence shows about an escalation, so the two never word
 * the same row differently.
 *
 * HONESTY. StockPilot records only what it can observe (the maintenance
 * table's own comment: "Saved / Email draft opened / Archived / Cancelled
 * ONLY"). Escalating SAVES a maintenance request; it does not send anything.
 * The email to the maintenance team opens only when the person chooses it on
 * the request's review screen, and StockPilot never learns whether it was
 * sent or whether a ticket exists. So the copy says "Escalated: MR-..." (with
 * "(request cancelled)" once that request is cancelled, to every reader), and,
 * to a reader who can open the request, "Email draft opened" or "Email draft
 * not yet opened" (maintenance_requests.outlook_draft_opened_at: see
 * EscalationRequestView.draftOpened for exactly when it is recorded). Never
 * "sent", never "ticket created", never "notified".
 *
 * Escalating neither acknowledges nor resolves the exception: only the
 * system check resolves one, when the condition is gone.
 *
 * ONLINE ONLY. There is no queued escalation: an offline replay can never
 * create a request or open a composer.
 */
import { MAINTENANCE_CATEGORIES } from '../maintenance/constants';
import { sanitizeDescriptionBlock, sanitizeSubjectLine } from '../maintenance/text';
import { formatStockQuantity } from '../inventory/stock-writeoff';

import {
  describeOccurrence,
  EXCEPTION_FACTS_LABEL_MAX,
  EXCEPTION_RULES,
  isHoldingRule,
  type ExceptionRule,
} from './exceptions';

// ── The form's bounds (maintenanceRequestFormSchema is the authority) ─────

/** The shortest subject the request form accepts. */
export const ESCALATION_SUBJECT_MIN = 5;
/** The longest subject the request form accepts. */
export const ESCALATION_SUBJECT_MAX = 120;
/** The shortest description the request form accepts. */
export const ESCALATION_DESCRIPTION_MIN = 10;
/** The prefilled description stays within this many characters: the length
 *  a shortened maintenance email keeps of a description, so the whole
 *  prefill (reference included) survives shortening. */
export const ESCALATION_DESCRIPTION_PREFILL_MAX = 400;
/** The detail sentence's share of it (a label list can run long). */
const DETAIL_MAX = 200;

/** The category the prefill suggests (one of MAINTENANCE_CATEGORIES). */
export const ESCALATION_DEFAULT_CATEGORY: (typeof MAINTENANCE_CATEGORIES)[number] = 'Inventory or equipment';

// ── Prefill ────────────────────────────────────────────────────────────────

export interface EscalationPrefillInput {
  rule: ExceptionRule;
  /** The occurrence's stored facts (describeOccurrence reads them). */
  facts: unknown;
  /** The item's CURRENT name and SKU (live), when readable. */
  itemName: string | null;
  sku: string | null;
  /** The occurrence's location as it reads now (holding rules), if any. */
  locationName: string | null;
  /** "EX-000042" (formatOccurrenceNumber), or null. */
  reference: string | null;
  conditionSince?: string | Date | null;
  asOf?: string | Date;
}

export interface EscalationPrefill {
  subject: string;
  description: string;
  category: (typeof MAINTENANCE_CATEGORIES)[number];
}

const ELLIPSIS = '…';

/** At most `max` UTF-16 units (the unit zod's .max() counts), cut on a code
 *  point boundary, with an ellipsis when cut. */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  let out = '';
  for (const ch of value) {
    if (out.length + ch.length + ELLIPSIS.length > max) break;
    out += ch;
  }
  return `${out.trimEnd()}${ELLIPSIS}`;
}

/** A name as one plain line: controls and line breaks become spaces, runs of
 *  whitespace collapse (the subject refuses a line break outright). */
function oneLine(value: string | null | undefined): string {
  return typeof value === 'string' ? sanitizeSubjectLine(value) : '';
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * `Inventory issue: <item> (<SKU>)`, at most 120 characters. When too long,
 * the item name is shortened first so the SKU (the identifier the
 * maintenance team searches by) survives; a SKU too long for that is cut
 * with the rest.
 */
export function escalationSubject(itemName: string | null, sku: string | null): string {
  const prefix = 'Inventory issue: ';
  const name = oneLine(itemName) || 'Item';
  const code = oneLine(sku);
  const skuPart = code ? ` (${code})` : '';
  const whole = `${prefix}${name}${skuPart}`;
  if (whole.length <= ESCALATION_SUBJECT_MAX) return whole;
  const room = ESCALATION_SUBJECT_MAX - prefix.length - skuPart.length;
  if (room >= 12) return `${prefix}${clip(name, room)}${skuPart}`;
  return clip(whole, ESCALATION_SUBJECT_MAX);
}

/**
 * The detail sentence for the description: describeOccurrence's detail,
 * with the units first for a holding rule ("5 units in Staging for at least
 * 9 days"). Numbers and place names only: no person, no cost, no link.
 */
function escalationDetail(input: EscalationPrefillInput): string {
  const d = describeOccurrence(input.rule, input.facts, {
    itemName: input.itemName,
    conditionSince: input.conditionSince ?? null,
    ...(input.asOf !== undefined ? { asOf: input.asOf } : {}),
  });
  if (isHoldingRule(input.rule) && d.units !== null) {
    return `${formatStockQuantity(d.units)} ${d.units === 1 ? 'unit' : 'units'} ${d.detail}`;
  }
  return d.detail;
}

/** Where the condition is: the occurrence's own location for a holding
 *  rule, else the counted location a count_variance row recorded. */
function escalationLocation(input: EscalationPrefillInput): string | null {
  const f = record(input.facts);
  const name =
    oneLine(input.locationName) ||
    oneLine(str(f.locationName)) ||
    (input.rule === 'count_variance' ? oneLine(str(f.countedLocationName)) : '');
  return name ? clip(name, EXCEPTION_FACTS_LABEL_MAX) : null;
}

/**
 * The request form's prefill for an escalation. The person may edit every
 * word before saving; the server takes the item and the location from the
 * occurrence itself, never from the form.
 *
 *   subject:     `Inventory issue: <item> (<SKU>)`, 5 to 120 characters.
 *   description: `<rule title>: <detail>. Location: <name>. Ref EX-000042.`
 *                The short, specific part first, so it survives when the
 *                email is shortened. No person's name, no cost, no link.
 */
export function escalationPrefill(input: EscalationPrefillInput): EscalationPrefill {
  const sentences: string[] = [];
  const title = EXCEPTION_RULES[input.rule]?.label ?? 'Inventory exception';
  const detail = clip(oneLine(escalationDetail(input)).replace(/[.\s]+$/, ''), DETAIL_MAX);
  sentences.push(`${title}: ${detail}.`);
  const location = escalationLocation(input);
  if (location) sentences.push(`Location: ${location}.`);
  const reference = oneLine(input.reference);
  if (reference) sentences.push(`Ref ${reference}.`);
  let description = sanitizeDescriptionBlock(sentences.join(' '));
  if (description.length < ESCALATION_DESCRIPTION_MIN) {
    description = `${description} Inventory exception.`.trim();
  }
  return {
    subject: escalationSubject(input.itemName ?? str(record(input.facts).itemName), input.sku ?? str(record(input.facts).sku)),
    description,
    category: ESCALATION_DEFAULT_CATEGORY,
  };
}

// ── Copy: the action ───────────────────────────────────────────────────────

/** The button, on the web and the phone. */
export const ESCALATE_TO_MAINTENANCE_LABEL = 'Escalate to maintenance';

/** What escalating does, and what it does not do. Shown under the button on
 *  the exception and on the escalation form, so it names no screen: the
 *  email choice is on the request's screen, after Save. */
export const ESCALATE_TO_MAINTENANCE_HELP =
  'Saves one maintenance request for this exception. After it is saved, the email to the maintenance team opens only if you choose it. Escalating does not acknowledge or resolve this exception.';

/** Why Escalate is not offered: the organization has no maintenance requests. */
export const ESCALATE_MODULE_OFF_COPY = 'Maintenance requests are not turned on for this organization.';

/** Why Escalate is not offered to this reader. */
export const ESCALATE_NOT_PERMITTED_COPY =
  'You can view this exception. Escalating it needs permission to submit maintenance requests.';

/** Why Escalate is disabled on a resolved occurrence. */
export const ESCALATE_RESOLVED_COPY = 'This exception is resolved, so it can no longer be escalated.';

/** Why Escalate is disabled while the phone is offline. Nothing is queued. */
export const ESCALATE_OFFLINE_COPY =
  'You are offline. Escalating needs a connection, and it is not saved to try later.';

/** Someone is escalating right now, and who is not known (an older server,
 *  or the name could not be read). */
export const ESCALATION_IN_PROGRESS_COPY =
  'This exception is being escalated right now. Try again in a minute.';

/** Who holds the escalation under way: this person (another tab, another
 *  device), or someone else, by name when it could be read. */
export type EscalationHolder = { self: true } | { self: false; label: string | null };

/**
 * Someone is escalating this exception right now (the claim, under 2
 * minutes old). Names who, so the person refused knows whom to ask; a
 * holder who could not be named reads as ESCALATION_IN_PROGRESS_COPY.
 */
export function escalationInProgressCopy(holder: EscalationHolder | null): string {
  if (holder?.self === true) {
    return 'You are already escalating this exception, in another tab or on another device. Try again in a minute.';
  }
  const label = holder ? oneLine(holder.label) : '';
  return label ? `${label} is escalating this exception right now. Try again in a minute.` : ESCALATION_IN_PROGRESS_COPY;
}

/** This person is escalating ANOTHER exception right now: one at a time. */
export const ESCALATION_IN_PROGRESS_ELSEWHERE_COPY =
  'You are escalating another exception right now. Try again in a minute.';

/** The row was held by something else (a check, another escalation) past
 *  the wait. Retrying is safe. */
export const ESCALATION_BUSY_COPY = 'This exception is busy. Try again in a moment.';

/** The occurrence resolved, or its claim was taken over, while escalating,
 *  so the request could not be linked. Says nothing about that request:
 *  escalationSavedRequestCopy says what became of it. */
export const ESCALATION_CHANGED_COPY =
  'The exception changed while it was being escalated. Reload and try again.';

/** The database refused the link for a reason this build does not name
 *  (never "the exception changed": that is not known). */
export const ESCALATION_LINK_FAILED_COPY = 'The request could not be linked to this exception.';

/** Too many escalations from this person in a minute. */
export const ESCALATE_TOO_MANY_COPY = 'Too many requests. Wait a moment and try again.';

/** The server failed in a way that leaves it unknown whether a request was
 *  saved (or linked). Never "try again" alone: a retry could save a second
 *  request. The web and the phone both say this for a server problem. */
export const ESCALATE_SERVER_PROBLEM_COPY =
  'The server had a problem, so it is not known whether the request was saved. Check your maintenance requests before trying again.';

/** The session is not verified with the authenticator app this account
 *  uses (the phone has no in-place step-up). Nothing was saved. */
export const ESCALATE_AAL2_REQUIRED_COPY =
  'Your account uses an authenticator app, and this session did not sign in with it. Sign out and sign back in with your code, then escalate again. Nothing was saved.';

/** The organization requires two-factor authentication and this account
 *  has none. Nothing was saved. */
export const ESCALATE_MFA_REQUIRED_COPY =
  'Your organization requires two-factor authentication. Set it up on the web, then sign in again. Nothing was saved.';

/** A request this escalation saved before it failed, and what became of it:
 *  cancelled (as its requester), or left as saved because the cancel failed
 *  (for example, the maintenance module was turned off meanwhile). */
export interface EscalationSavedRequest {
  reference: string | null;
  cancelled: boolean;
}

/** The sentence about a request an escalation saved but did not link. Only
 *  what happened: "cancelled" only when the cancel succeeded. */
export function escalationSavedRequestCopy(saved: EscalationSavedRequest): string {
  const ref = oneLine(saved.reference);
  if (saved.cancelled) {
    return ref ? `The request saved for it (${ref}) was cancelled.` : 'The request saved for it was cancelled.';
  }
  return ref
    ? `The request saved for it (${ref}) is not linked to this exception and could not be cancelled. Check your maintenance requests.`
    : 'The request saved for it is not linked to this exception and could not be cancelled. Check your maintenance requests.';
}

/** A failed escalation's message: why (`base`), then what became of a
 *  request it had saved, when it had saved one. */
export function escalationFailureCopy(base: string, saved: EscalationSavedRequest | null): string {
  return saved ? `${base} ${escalationSavedRequestCopy(saved)}` : base;
}

/** The escalation form's note under the linked exception (web and phone):
 *  what the form does not carry, so nobody expects it on the request. */
export const ESCALATION_FORM_NOTE_COPY =
  'The item and the location come from the exception, not from this form. Photos on the exception are not copied to the request; you can add photos on the request after it is saved.';

/** The escalation form could not read its exception, so it offers no form
 *  (a plain request would not be linked to the exception). */
export const ESCALATION_EXCEPTION_UNAVAILABLE_COPY =
  'This exception could not be loaded, so it cannot be escalated right now. Reload the page to try again.';

/**
 * The action on an exception already escalated to a request this reader can
 * open: it opens that request instead of making another ("Open
 * MR-2026-000014").
 */
export function escalationOpenRequestLabel(reference: string | null): string {
  const ref = oneLine(reference);
  return ref ? `Open ${ref}` : 'Open the maintenance request';
}

/** The answer to an Escalate that found a request already linked (the 409):
 *  the client opens that request instead. */
export function escalationDuplicateCopy(reference: string | null): string {
  const ref = oneLine(reference);
  return ref
    ? `This exception is already escalated to ${ref}. Opening that request.`
    : 'This exception is already escalated. Opening that request.';
}

export type EscalateUnavailableReason = 'module_disabled' | 'not_permitted' | 'resolved' | 'already_escalated';

/**
 * Why Escalate is unavailable, or null when it is available. Order matters,
 * as for acknowledging: reasons that reconnecting would not change come
 * before the offline one. `module_disabled` is usually a reason to HIDE the
 * button rather than explain it (most organizations do not use maintenance
 * requests); the surfaces decide.
 */
export function escalateDisabledReason(input: {
  reason: EscalateUnavailableReason | null;
  reference?: string | null;
  online: boolean;
}): string | null {
  switch (input.reason) {
    case 'module_disabled':
      return ESCALATE_MODULE_OFF_COPY;
    case 'not_permitted':
      return ESCALATE_NOT_PERMITTED_COPY;
    case 'resolved':
      return ESCALATE_RESOLVED_COPY;
    case 'already_escalated':
      return escalationAlreadyEscalatedCopy(input.reference ?? null);
    default:
      return input.online ? null : ESCALATE_OFFLINE_COPY;
  }
}

/** Why Escalate is not offered again: a request that is not cancelled is
 *  already linked. */
export function escalationAlreadyEscalatedCopy(reference: string | null): string {
  const ref = oneLine(reference);
  return ref
    ? `Already escalated to ${ref}. A new request can be made only if that one is cancelled.`
    : 'Already escalated. A new request can be made only if that one is cancelled.';
}

// ── Copy: the occurrence ───────────────────────────────────────────────────

/**
 * "Escalated: MR-2026-000014", the badge beside the occurrence's state on
 * every surface (the lists, the exception, the item and location chips).
 * Every reader of the occurrence sees it: the handle is a copy on the
 * occurrence. `cancelled` true (the escalation_request_cancelled computed
 * field, answered to every reader) adds "(request cancelled)": a new
 * escalation may then be made.
 */
export function escalationBadgeCopy(reference: string | null, cancelled?: boolean | null): string {
  const ref = oneLine(reference);
  const badge = ref ? `Escalated: ${ref}` : 'Escalated to maintenance';
  return cancelled === true ? `${badge} (request cancelled)` : badge;
}

/** What a reader who can open the linked request sees of it. */
export interface EscalationRequestView {
  /**
   * maintenance_requests.outlook_draft_opened_at is set: the request's
   * screen recorded that the person opened the email draft. On the phone it
   * is recorded after the Outlook or mail app opened. On the web it is
   * recorded when an Outlook tab opened, and also when a blocked pop-up fell
   * back to the email app, which the browser cannot confirm opened (the
   * maintenance module's existing rule; the words say "opened", nothing
   * about sending).
   */
  draftOpened: boolean;
  /** cancelled_at is set: the escalation may be made again. */
  cancelled: boolean;
}

/**
 * The line under the badge for a reader who can open the request; null for
 * one who cannot (they are told nothing about the email). Only what
 * StockPilot records: a draft opened, or not yet. Null for a cancelled
 * request: the badge already says "(request cancelled)", to every reader.
 */
export function escalationRequestStateCopy(request: EscalationRequestView | null): string | null {
  if (!request || request.cancelled) return null;
  return request.draftOpened ? 'Email draft opened' : 'Email draft not yet opened';
}

/**
 * The linked-exception card on the escalation form (web and phone): the
 * reference and rule, the item with its SKU, and the location when the
 * condition is at one ("(archived)" when that location was archived since).
 */
export function escalationSourceLines(o: {
  reference: string | null;
  rule: ExceptionRule;
  item: { name: string; sku: string | null } | null;
  location: { name: string; archived: boolean } | null;
}): { heading: string; item: string | null; location: string | null } {
  const rule = EXCEPTION_RULES[o.rule]?.label ?? 'Inventory exception';
  const ref = oneLine(o.reference);
  return {
    heading: ref ? `${ref} · ${rule}` : rule,
    item: o.item ? `${o.item.name}${o.item.sku ? ` (${o.item.sku})` : ''}` : null,
    location: o.location ? `${o.location.name}${o.location.archived ? ' (archived)' : ''}` : null,
  };
}
