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
 * sent or whether a ticket exists. So the copy says "Escalated: MR-...", and,
 * to a reader who can open the request, "Email draft opened" or "Email draft
 * not yet opened" (maintenance_requests.outlook_draft_opened_at, which the
 * review screen records when a draft really opened). Never "sent", never
 * "ticket created", never "notified".
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

/** What escalating does, and what it does not do. */
export const ESCALATE_TO_MAINTENANCE_HELP =
  'Saves one maintenance request for this exception. The email to the maintenance team opens only if you choose it on the next screen. Escalating does not acknowledge or resolve this exception.';

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

/** Someone (possibly this person, in another tab) is escalating right now. */
export const ESCALATION_IN_PROGRESS_COPY =
  'This exception is being escalated right now. Try again in a minute.';

/** The occurrence resolved, or its claim was taken over, while escalating:
 *  the request that was saved for it has been cancelled. */
export const ESCALATION_NOT_LINKED_COPY =
  'The exception changed while it was being escalated, so the request was cancelled. Reload and try again.';

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

/** "Escalated: MR-2026-000014", the badge beside the occurrence's state on
 *  every surface. Every reader of the occurrence sees it. */
export function escalationBadgeCopy(reference: string | null): string {
  const ref = oneLine(reference);
  return ref ? `Escalated: ${ref}` : 'Escalated to maintenance';
}

/** What a reader who can open the linked request sees of it. */
export interface EscalationRequestView {
  /** maintenance_requests.outlook_draft_opened_at is set: a draft really
   *  opened on some device (recorded after the open, never before). */
  draftOpened: boolean;
  /** cancelled_at is set: the escalation may be made again. */
  cancelled: boolean;
}

/**
 * The line under the badge for a reader who can open the request; null for
 * one who cannot (they are told nothing about the request's state). Only
 * what StockPilot records: a draft opened, or not yet; or the request was
 * cancelled.
 */
export function escalationRequestStateCopy(request: EscalationRequestView | null): string | null {
  if (!request) return null;
  if (request.cancelled) return 'Request cancelled';
  return request.draftOpened ? 'Email draft opened' : 'Email draft not yet opened';
}
