import 'server-only';

import { z } from 'zod';

import {
  isAdminRole,
  isUuid,
  isVendorRiskAnswer,
  parseVendorRiskDate,
  VENDOR_RISK_ACT_AS_REFUSAL,
  VENDOR_RISK_ACT_AS_REFUSAL_WORDS,
  VENDOR_RISK_ACTION_MAX,
  VENDOR_RISK_ANSWERS,
  VENDOR_RISK_DATA_LEVELS,
  VENDOR_RISK_EVIDENCE_LEVELS,
  VENDOR_RISK_FINDING_MAX,
  VENDOR_RISK_ITEM_ANSWERS,
  VENDOR_RISK_ITEM_STATUSES,
  VENDOR_RISK_NOTE_MAX,
  VENDOR_RISK_OVERRIDE_REASON_MAX,
  VENDOR_RISK_QUESTION_KEYS,
  VENDOR_RISK_REFUSAL_WORDS,
  VENDOR_RISK_RESULTS,
  VENDOR_RISK_RISK_LEVELS,
  VENDOR_RISK_SEVERITIES,
  vendorRiskAnswersProblem,
  vendorRiskOverrideReasonOk,
  vendorRiskQuestion,
  vendorRiskTextOk,
  type VendorRiskAnswerEntry,
  type VendorRiskAnswers,
  type VendorRiskDataLevel,
  type VendorRiskEvidence,
  type VendorRiskItemAnswer,
  type VendorRiskItemStatus,
  type VendorRiskQuestionKey,
  type VendorRiskRefusal,
  type VendorRiskResult,
  type VendorRiskReviewDue,
  type VendorRiskRiskLevel,
  type VendorRiskSeverity,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';

import { audit } from './audit';
import {
  assertModuleEnabled,
  mfaGateError,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

/**
 * VENDOR RISK REVIEWS (part 7 of the security tools): the reads and writes of
 * an organization's reviews of its suppliers (the app's word for a vendor),
 * for its owners and admins.
 *
 * THE GATE, in the order the sign-in alerts service asks it
 * (assertMaySeeSignInAlerts), with the module first as every supplier service
 * does: the Suppliers module is on (assertModuleEnabled: module_disabled, or
 * the could-not-check error when its state could not be read); the
 * authenticator step (mfaGateError); the role (owners and admins, core
 * isAdminRole). Every read and every write asks it before anything is read.
 * Only then the database's own function, which checks the role and the
 * authenticator rule again (migration 0481), with the context's own
 * organization and nothing from the request.
 *
 * Read through the member's own client, never the service client: the two
 * tables have row security with no policy and no grant to any API role, so the
 * only way in is the eleven functions of 0481 (CONTRACT.md). Their refusals
 * come back as SQLSTATE and a word in the hint; refusalOf turns each into the
 * error the page reads, with core's words (VENDOR_RISK_REFUSAL_WORDS).
 *
 * COULD NOT CHECK IS NEVER NOTHING. Migration 0481 may not be live where this
 * code runs: a function that is missing (PGRST202, 42883), or any read that
 * fails for a reason that is not a refusal, answers `could_not_check`, which
 * the pages show as such. It is never read as "no reviews" or "not reviewed".
 *
 * A SUPPORT (ACT-AS) SEAT may read and never write. The writes read the
 * caller's own membership first (seat()): a support seat is refused here,
 * and a membership that could not be read refuses too (nothing is sent). The
 * database refuses such a seat again (42501 supplier_risk_act_as_read_only).
 *
 * THE AUDIT LOG gets an entry for a draft saved, a review finished, a result
 * overridden, a draft discarded, an item changed and a risk accepted. Never
 * an answer, a note, a finding, an action or a reason: audit_logs is read by
 * anyone holding activity_logs:read, which can be given to a member who is
 * not an admin (CONTRACT.md 6.4). A reason is recorded by its length only.
 * Who changed an item and why a risk was accepted are on the item itself.
 */

/* ─────────────────────────────── words ─────────────────────────────── */

export const SUPPLIER_RISK_FORBIDDEN = 'Only owners and admins can see vendor reviews.';
export const SUPPLIER_RISK_COULD_NOT_CHECK =
  'Vendor reviews could not be checked just now. Try again in a minute.';
export const SUPPLIER_RISK_NOTHING_SAVED =
  'Vendor reviews could not be reached just now. Nothing was saved. Try again in a minute.';
export const SUPPLIER_RISK_SEAT_UNKNOWN =
  'We could not check whether this session may change vendor reviews. Nothing was saved. Try again in a minute.';
export const SUPPLIER_RISK_BUSY = 'Someone else is saving this review. Try again.';
export const SUPPLIER_RISK_DRAFT_MOVED =
  'This draft was changed in another window, or by another admin, after you opened it. Nothing was finished. Reload the page to see the latest answers, then finish again.';
export const SUPPLIER_RISK_MFA_REQUIRED =
  'Multi-factor authentication required. Enroll in MFA before performing this action.';
export const SUPPLIER_RISK_AAL2_REQUIRED =
  'Re-authenticate with MFA before performing this action.';
/** A request the schema refused (a Server Action's answer): nothing was asked. */
export const SUPPLIER_RISK_INVALID_REQUEST =
  'This could not be read. Reload the page and try again.';

/* ─────────────────────────────── shapes ─────────────────────────────── */

/** A read's answer: the value, or that it could not be checked (never "nothing"). */
export type SupplierRiskRead<T> = { state: 'ok'; value: T } | { state: 'could_not_check' };

export type SupplierRiskSeat = 'member' | 'support' | 'unknown';
export type SupplierState = 'active' | 'archived' | 'deleted';
export type SupplierDueReminder = 'claimed' | 'sent' | 'not_sent';

export interface SupplierRiskRegisterRow {
  supplierId: string;
  /** Today's name (a deleted supplier: the newest review's). */
  supplierName: string;
  /** The name on the current review. */
  reviewedAsName: string | null;
  /** Today's name is not the name reviewed. */
  nameChanged: boolean;
  supplierState: SupplierState;
  supplierArchivedAt: string | null;
  reviewId: string | null;
  version: number | null;
  dataLevel: VendorRiskDataLevel | null;
  result: VendorRiskResult | null;
  computedResult: VendorRiskResult | null;
  overridden: boolean;
  startingRisk: VendorRiskRiskLevel | null;
  evidence: VendorRiskEvidence | null;
  residualRisk: VendorRiskRiskLevel | null;
  /** The hard stops of the current review, as the database names them (shown, never hidden). */
  hardStops: string[];
  reviewedAt: string | null;
  reviewerName: string | null;
  reviewerAccountDeleted: boolean;
  nextReviewOn: string | null;
  reviewDue: VendorRiskReviewDue;
  dueReminder: SupplierDueReminder | null;
  openItems: number;
  topOpenSeverity: VendorRiskSeverity | null;
  draftReviewId: string | null;
  draftUpdatedAt: string | null;
}

export interface SupplierRiskHistoryRow {
  reviewId: string;
  version: number;
  status: 'draft' | 'final';
  isCurrent: boolean;
  dataLevel: VendorRiskDataLevel | null;
  result: VendorRiskResult | null;
  computedResult: VendorRiskResult | null;
  overridden: boolean;
  residualRisk: VendorRiskRiskLevel | null;
  reviewedAt: string | null;
  reviewerName: string | null;
  nextReviewOn: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SupplierRiskItem {
  id: string;
  reviewId: string;
  questionKey: string;
  answer: VendorRiskItemAnswer | null;
  severity: VendorRiskSeverity | null;
  finding: string;
  action: string;
  ownerUserId: string | null;
  ownerName: string | null;
  /** False: the owner is no longer a current owner or admin (say so beside the name). */
  ownerIsAdmin: boolean;
  dueOn: string | null;
  status: VendorRiskItemStatus;
  closedAt: string | null;
  changedByName: string | null;
  changedAt: string | null;
  acceptedByName: string | null;
  acceptedReason: string | null;
}

export interface SupplierRiskReview {
  id: string;
  supplierId: string;
  /** The supplier's name as reviewed. */
  supplierName: string;
  supplierState: SupplierState | null;
  version: number;
  status: 'draft' | 'final';
  isCurrent: boolean;
  rulesVersion: number | null;
  dataLevel: VendorRiskDataLevel | null;
  answers: VendorRiskAnswers;
  startingRisk: VendorRiskRiskLevel | null;
  evidence: VendorRiskEvidence | null;
  residualRisk: VendorRiskRiskLevel | null;
  hardStops: string[];
  computedResult: VendorRiskResult | null;
  overrideResult: VendorRiskResult | null;
  overrideReason: string | null;
  result: VendorRiskResult | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  reviewedOn: string | null;
  nextReviewOn: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  items: SupplierRiskItem[];
}

/** A current owner or admin, for the item owner picker. */
export interface SupplierRiskPerson {
  userId: string;
  name: string;
}

export interface SupplierRiskFinishResult {
  reviewId: string;
  version: number;
  computedResult: VendorRiskResult | null;
  result: VendorRiskResult | null;
  overridden: boolean;
  nextReviewOn: string | null;
  items: number;
}

/* ─────────────────────────── the request's shapes ─────────────────────────── */

const ISO_DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const daySchema = z
  .string()
  .regex(ISO_DAY)
  .refine((d) => parseVendorRiskDate(d) !== null, 'Not a date');

/**
 * Generous bounds (code units, not characters): the exact rules are core's
 * (vendorRiskTextOk, vendorRiskOverrideReasonOk), applied in the service with
 * their own words, and the database's again.
 */
const answerEntrySchema = z
  .object({
    answer: z.enum(VENDOR_RISK_ANSWERS),
    note: z
      .string()
      .max(VENDOR_RISK_NOTE_MAX * 4)
      .nullable()
      .optional(),
    date: daySchema.nullable().optional(),
  })
  .strict();

export const supplierRiskAnswersSchema = z
  .object(
    Object.fromEntries(
      VENDOR_RISK_QUESTION_KEYS.map((k) => [k, answerEntrySchema.optional()]),
    ) as Record<VendorRiskQuestionKey, z.ZodOptional<typeof answerEntrySchema>>,
  )
  .strict();

export const supplierRiskDraftSchema = z
  .object({
    supplierId: z.string().uuid(),
    dataLevel: z.enum(VENDOR_RISK_DATA_LEVELS),
    answers: supplierRiskAnswersSchema,
  })
  .strict();
export type SupplierRiskDraftInput = z.infer<typeof supplierRiskDraftSchema>;

const finishItemSchema = z
  .object({
    questionKey: z.enum(VENDOR_RISK_QUESTION_KEYS),
    finding: z
      .string()
      .min(1)
      .max(VENDOR_RISK_FINDING_MAX * 4),
    action: z
      .string()
      .min(1)
      .max(VENDOR_RISK_ACTION_MAX * 4),
    ownerUserId: z.string().uuid().nullable(),
    dueOn: daySchema.nullable(),
  })
  .strict();

export const supplierRiskFinishSchema = z
  .object({
    supplierId: z.string().uuid(),
    dataLevel: z.enum(VENDOR_RISK_DATA_LEVELS),
    answers: supplierRiskAnswersSchema,
    nextReviewOn: daySchema.nullable(),
    overrideResult: z.enum(VENDOR_RISK_RESULTS).nullable(),
    overrideReason: z
      .string()
      .max(VENDOR_RISK_OVERRIDE_REASON_MAX * 4)
      .nullable(),
    items: z.array(finishItemSchema).max(VENDOR_RISK_QUESTION_KEYS.length),
    /** The open draft's updated_at when the page read it, or null when there was none. */
    draftUpdatedAt: z.string().max(64).nullable(),
  })
  .strict();
export type SupplierRiskFinishInput = z.infer<typeof supplierRiskFinishSchema>;

export const supplierRiskDiscardSchema = z.object({ supplierId: z.string().uuid() }).strict();

export const supplierRiskItemUpdateSchema = z
  .object({
    reviewId: z.string().uuid(),
    itemId: z.string().uuid(),
    status: z.enum(VENDOR_RISK_ITEM_STATUSES),
    ownerUserId: z.string().uuid().nullable(),
    dueOn: daySchema.nullable(),
    /** The new action, or null to keep it. */
    action: z
      .string()
      .min(1)
      .max(VENDOR_RISK_ACTION_MAX * 4)
      .nullable(),
    /** Why the risk is accepted (only with accepted), or null to keep the reason given. */
    reason: z
      .string()
      .min(1)
      .max(VENDOR_RISK_OVERRIDE_REASON_MAX * 4)
      .nullable(),
  })
  .strict();
export type SupplierRiskItemUpdateInput = z.infer<typeof supplierRiskItemUpdateSchema>;

/* ─────────────────────────────── the gate ─────────────────────────────── */

/**
 * The module first, then the step-up, then the role: owners and admins only.
 * Throws module_disabled (or the could-not-check error for a module state
 * that was not read), the authenticator refusal, or forbidden.
 */
export function assertMayUseSupplierRisk(ctx: ServiceContext): void {
  assertModuleEnabled(ctx, 'suppliers');
  if (ctx.mfaRequired && !ctx.mfaSatisfied) {
    throw mfaGateError(ctx);
  }
  if (!isAdminRole(ctx.role)) {
    throw new ServiceError('forbidden', SUPPLIER_RISK_FORBIDDEN);
  }
}

/* ─────────────────────────── the database's answers ─────────────────────────── */

type RpcError = { code?: string | null; hint?: string | null; message?: string | null };
type RpcAnswer = { data: unknown; error: RpcError | null };

/** A function that is not there (0481 not applied): could not check, never nothing. */
const MISSING_FUNCTION_CODES = new Set(['PGRST202', '42883']);

function isRefusalWord(word: string): word is VendorRiskRefusal {
  return Object.prototype.hasOwnProperty.call(VENDOR_RISK_REFUSAL_WORDS, word);
}

/**
 * A refusal from one of 0481's functions, as the error the page reads; null
 * when the error is not one of them. The word is read from the hint only
 * (every 0481 refusal, and the step-up gate's, sets it); the error's own
 * text is never read into an answer.
 */
export function supplierRiskRefusalOf(error: RpcError): ServiceError | null {
  const code = error.code ?? '';
  const word = (error.hint ?? '').trim();
  if (code === '42501') {
    if (word === 'mfa_required') {
      return new ServiceError('forbidden', SUPPLIER_RISK_MFA_REQUIRED, { reason: 'mfa_required' });
    }
    if (word === 'aal2_required') {
      return new ServiceError('forbidden', SUPPLIER_RISK_AAL2_REQUIRED, {
        reason: 'aal2_required',
      });
    }
    if (word === VENDOR_RISK_ACT_AS_REFUSAL) {
      return new ServiceError('forbidden', VENDOR_RISK_ACT_AS_REFUSAL_WORDS, {
        reason: VENDOR_RISK_ACT_AS_REFUSAL,
      });
    }
    return new ServiceError('forbidden', SUPPLIER_RISK_FORBIDDEN);
  }
  if (code === '22023' && isRefusalWord(word)) {
    return new ServiceError('validation_error', VENDOR_RISK_REFUSAL_WORDS[word], { refusal: word });
  }
  if (code === '55P03') {
    return new ServiceError('conflict', SUPPLIER_RISK_BUSY, { reason: 'busy', retryable: true });
  }
  return null;
}

/** A refusal of core's list, with its words, for a check made here before the database is asked. */
function refused(word: VendorRiskRefusal, field?: string): ServiceError {
  return new ServiceError('validation_error', VENDOR_RISK_REFUSAL_WORDS[word], {
    refusal: word,
    ...(field ? { field } : {}),
  });
}

function report(
  fn: string,
  code: string | null,
  organizationId: string,
  level: 'error' | 'warning',
): void {
  void reportError(new Error(`${fn} failed (${code || 'no code'})`), {
    tag: 'supplier-risk',
    organizationId,
    level,
    extra: { fn, code: code || null },
  });
}

/* ─────────────────────────────── parsing ─────────────────────────────── */

const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const bool = (v: unknown): boolean => v === true;

function oneOf<T extends string>(list: readonly T[], v: unknown): T | null {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;
}

function intOf(v: unknown): number | null {
  const n = typeof v === 'string' && /^[0-9]{1,9}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function day(v: unknown): string | null {
  return typeof v === 'string' && parseVendorRiskDate(v.slice(0, 10)) ? v.slice(0, 10) : null;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
}

const REVIEW_DUE = ['not_reviewed', 'overdue', 'due_today', 'due_soon', 'scheduled'] as const;
const DUE_REMINDER = ['claimed', 'sent', 'not_sent'] as const;
const SUPPLIER_STATES = ['active', 'archived', 'deleted'] as const;

function registerRowOf(raw: Record<string, unknown>): SupplierRiskRegisterRow | null {
  const supplierId = text(raw.supplier_id);
  const supplierName = typeof raw.supplier_name === 'string' ? raw.supplier_name : null;
  const supplierState = oneOf(SUPPLIER_STATES, raw.supplier_state);
  if (!supplierId || supplierName === null || !supplierState) return null;
  return {
    supplierId,
    supplierName,
    reviewedAsName: typeof raw.reviewed_as_name === 'string' ? raw.reviewed_as_name : null,
    nameChanged: bool(raw.name_changed),
    supplierState,
    supplierArchivedAt: text(raw.supplier_archived_at),
    reviewId: text(raw.review_id),
    version: intOf(raw.version),
    dataLevel: oneOf(VENDOR_RISK_DATA_LEVELS, raw.data_level),
    result: oneOf(VENDOR_RISK_RESULTS, raw.result),
    computedResult: oneOf(VENDOR_RISK_RESULTS, raw.computed_result),
    overridden: bool(raw.overridden),
    startingRisk: oneOf(VENDOR_RISK_RISK_LEVELS, raw.starting_risk),
    evidence: oneOf(VENDOR_RISK_EVIDENCE_LEVELS, raw.evidence),
    residualRisk: oneOf(VENDOR_RISK_RISK_LEVELS, raw.residual_risk),
    hardStops: stringList(raw.hard_stops),
    reviewedAt: text(raw.reviewed_at),
    reviewerName: text(raw.reviewer_name),
    reviewerAccountDeleted: bool(raw.reviewer_account_deleted),
    nextReviewOn: day(raw.next_review_on),
    // A review whose state is not one of the five is read as overdue, never as
    // scheduled: the page then asks for a look rather than hiding it.
    reviewDue:
      oneOf(REVIEW_DUE, raw.review_due) ?? (text(raw.review_id) ? 'overdue' : 'not_reviewed'),
    dueReminder: oneOf(DUE_REMINDER, raw.due_reminder),
    openItems: intOf(raw.open_items) ?? 0,
    topOpenSeverity: oneOf(VENDOR_RISK_SEVERITIES, raw.top_open_severity),
    draftReviewId: text(raw.draft_review_id),
    draftUpdatedAt: text(raw.draft_updated_at),
  };
}

function historyRowOf(raw: Record<string, unknown>): SupplierRiskHistoryRow | null {
  const reviewId = text(raw.review_id);
  const version = intOf(raw.version);
  const status = oneOf(['draft', 'final'] as const, raw.status);
  if (!reviewId || version === null || !status) return null;
  return {
    reviewId,
    version,
    status,
    isCurrent: bool(raw.is_current),
    dataLevel: oneOf(VENDOR_RISK_DATA_LEVELS, raw.data_level),
    result: oneOf(VENDOR_RISK_RESULTS, raw.result),
    computedResult: oneOf(VENDOR_RISK_RESULTS, raw.computed_result),
    overridden: bool(raw.overridden),
    residualRisk: oneOf(VENDOR_RISK_RISK_LEVELS, raw.residual_risk),
    reviewedAt: text(raw.reviewed_at),
    reviewerName: text(raw.reviewer_name),
    nextReviewOn: day(raw.next_review_on),
    createdAt: text(raw.created_at),
    updatedAt: text(raw.updated_at),
  };
}

function answersOf(raw: unknown): VendorRiskAnswers {
  const out: VendorRiskAnswers = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const q = vendorRiskQuestion(key);
    if (!q || value === null || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    if (!isVendorRiskAnswer(v.answer)) continue;
    const entry: VendorRiskAnswerEntry = { answer: v.answer };
    if (typeof v.note === 'string') entry.note = v.note;
    if (typeof v.date === 'string') entry.date = v.date;
    out[q.key] = entry;
  }
  return out;
}

function itemOf(raw: unknown): SupplierRiskItem | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = text(r.id);
  const reviewId = text(r.review_id);
  const questionKey = text(r.question_key);
  const status = oneOf(VENDOR_RISK_ITEM_STATUSES, r.status);
  if (!id || !reviewId || !questionKey || !status) return null;
  return {
    id,
    reviewId,
    questionKey,
    answer: oneOf(VENDOR_RISK_ITEM_ANSWERS, r.answer),
    severity: oneOf(VENDOR_RISK_SEVERITIES, r.severity),
    finding: typeof r.finding === 'string' ? r.finding : '',
    action: typeof r.action === 'string' ? r.action : '',
    ownerUserId: text(r.owner_user_id),
    ownerName: text(r.owner_name),
    ownerIsAdmin: bool(r.owner_is_admin),
    dueOn: day(r.due_on),
    status,
    closedAt: text(r.closed_at),
    changedByName: text(r.changed_by_name),
    changedAt: text(r.changed_at),
    acceptedByName: text(r.accepted_by_name),
    acceptedReason: text(r.accepted_reason),
  };
}

function reviewOf(raw: unknown): SupplierRiskReview | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = text(r.id);
  const supplierId = text(r.supplier_id);
  const version = intOf(r.version);
  const status = oneOf(['draft', 'final'] as const, r.status);
  if (!id || !supplierId || version === null || !status) return null;
  return {
    id,
    supplierId,
    supplierName: typeof r.supplier_name === 'string' ? r.supplier_name : '',
    supplierState: oneOf(SUPPLIER_STATES, r.supplier_state),
    version,
    status,
    isCurrent: bool(r.is_current),
    rulesVersion: intOf(r.rules_version),
    dataLevel: oneOf(VENDOR_RISK_DATA_LEVELS, r.data_level),
    answers: answersOf(r.answers),
    startingRisk: oneOf(VENDOR_RISK_RISK_LEVELS, r.starting_risk),
    evidence: oneOf(VENDOR_RISK_EVIDENCE_LEVELS, r.evidence),
    residualRisk: oneOf(VENDOR_RISK_RISK_LEVELS, r.residual_risk),
    hardStops: stringList(r.hard_stops),
    computedResult: oneOf(VENDOR_RISK_RESULTS, r.computed_result),
    overrideResult: oneOf(VENDOR_RISK_RESULTS, r.override_result),
    overrideReason: text(r.override_reason),
    result: oneOf(VENDOR_RISK_RESULTS, r.result),
    reviewerName: text(r.reviewer_name),
    reviewedAt: text(r.reviewed_at),
    reviewedOn: day(r.reviewed_on),
    nextReviewOn: day(r.next_review_on),
    createdAt: text(r.created_at),
    updatedAt: text(r.updated_at),
    items: Array.isArray(r.items)
      ? r.items.map(itemOf).filter((i): i is SupplierRiskItem => i !== null)
      : [],
  };
}

/** The answers as the database stores them: no empty note or date, nothing else. */
function answersForDatabase(
  answers: z.infer<typeof supplierRiskAnswersSchema>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of VENDOR_RISK_QUESTION_KEYS) {
    const entry = answers[key];
    if (!entry) continue;
    const kept: Record<string, unknown> = { answer: entry.answer };
    if (typeof entry.note === 'string' && entry.note.length > 0) kept.note = entry.note;
    if (typeof entry.date === 'string' && entry.date.length > 0) kept.date = entry.date;
    out[key] = kept;
  }
  return out;
}

/** The same instant, however the two were written (microseconds kept when both have them). */
export function sameInstant(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || ta !== tb) return false;
  const frac = (s: string) => (/\.(\d+)/.exec(s)?.[1] ?? '').padEnd(6, '0');
  return frac(a) === frac(b);
}

const utcToday = (): string => new Date().toISOString().slice(0, 10);

/* ─────────────────────────────── the service ─────────────────────────────── */

export class SupplierRiskService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new SupplierRiskService(await withContext());
  }

  /** A read's answer: refusals thrown, any other failure could_not_check (reported). */
  private async settleRead(
    fn: string,
    call: PromiseLike<RpcAnswer>,
  ): Promise<SupplierRiskRead<unknown>> {
    let answer: RpcAnswer;
    try {
      answer = await call;
    } catch {
      report(fn, 'threw', this.ctx.organizationId, 'error');
      return { state: 'could_not_check' };
    }
    if (answer.error) {
      const refusal = supplierRiskRefusalOf(answer.error);
      if (refusal) throw refusal;
      const code = answer.error.code ?? null;
      report(
        fn,
        code,
        this.ctx.organizationId,
        MISSING_FUNCTION_CODES.has(code ?? '') ? 'warning' : 'error',
      );
      return { state: 'could_not_check' };
    }
    return { state: 'ok', value: answer.data };
  }

  /** A write's answer: the data, or the error the action answers (nothing is retried here). */
  private async settleWrite(fn: string, call: PromiseLike<RpcAnswer>): Promise<unknown> {
    let answer: RpcAnswer;
    try {
      answer = await call;
    } catch {
      report(fn, 'threw', this.ctx.organizationId, 'error');
      throw new ServiceError('internal_error', `${fn} threw`);
    }
    if (answer.error) {
      const refusal = supplierRiskRefusalOf(answer.error);
      if (refusal) throw refusal;
      const code = answer.error.code ?? null;
      if (MISSING_FUNCTION_CODES.has(code ?? '')) {
        report(fn, code, this.ctx.organizationId, 'warning');
        throw new ServiceError('conflict', SUPPLIER_RISK_NOTHING_SAVED, {
          reason: 'could_not_check',
          retryable: true,
        });
      }
      report(fn, code, this.ctx.organizationId, 'error');
      throw new ServiceError('internal_error', `${fn} failed (${code || 'no code'})`);
    }
    return answer.data;
  }

  /**
   * Is the caller on a support (act-as) seat in this organization? Their own
   * membership row, read with their own client. 'unknown' when it could not
   * be read: the pages then show no write control, and the writes refuse.
   */
  async seat(): Promise<SupplierRiskSeat> {
    assertMayUseSupplierRisk(this.ctx);
    try {
      const { data, error } = await this.ctx.supabase
        .from('organization_members')
        .select('impersonation_expires_at')
        .eq('organization_id', this.ctx.organizationId)
        .eq('user_id', this.ctx.userId)
        .not('accepted_at', 'is', null)
        .limit(2);
      if (error || !Array.isArray(data) || data.length !== 1) return 'unknown';
      const expires = (data[0] as { impersonation_expires_at?: unknown }).impersonation_expires_at;
      return expires == null ? 'member' : 'support';
    } catch {
      return 'unknown';
    }
  }

  /** A write refuses a support seat, and a seat that could not be read, before anything is sent. */
  private async assertMayWrite(): Promise<void> {
    const seat = await this.seat();
    if (seat === 'support') {
      throw new ServiceError('forbidden', VENDOR_RISK_ACT_AS_REFUSAL_WORDS, {
        reason: VENDOR_RISK_ACT_AS_REFUSAL,
      });
    }
    if (seat === 'unknown') {
      throw new ServiceError('conflict', SUPPLIER_RISK_SEAT_UNKNOWN, {
        reason: 'could_not_check',
        retryable: true,
      });
    }
  }

  /** The register: every active supplier, and every archived or deleted one with a review. */
  async register(): Promise<SupplierRiskRead<SupplierRiskRegisterRow[]>> {
    assertMayUseSupplierRisk(this.ctx);
    const read = await this.settleRead(
      'supplier_risk_register',
      this.ctx.supabase.rpc('supplier_risk_register', {
        p_organization_id: this.ctx.organizationId,
      }),
    );
    if (read.state !== 'ok') return read;
    if (!Array.isArray(read.value)) {
      report('supplier_risk_register', 'not_a_list', this.ctx.organizationId, 'error');
      return { state: 'could_not_check' };
    }
    return {
      state: 'ok',
      value: (read.value as Array<Record<string, unknown>>)
        .map(registerRowOf)
        .filter((r): r is SupplierRiskRegisterRow => r !== null),
    };
  }

  /** Every version of this organization's reviews of one supplier, newest first. */
  async history(supplierId: string): Promise<SupplierRiskRead<SupplierRiskHistoryRow[]>> {
    assertMayUseSupplierRisk(this.ctx);
    if (!isUuid(supplierId)) return { state: 'ok', value: [] };
    const read = await this.settleRead(
      'supplier_risk_history',
      this.ctx.supabase.rpc('supplier_risk_history', {
        p_organization_id: this.ctx.organizationId,
        p_supplier_id: supplierId,
      }),
    );
    if (read.state !== 'ok') return read;
    if (!Array.isArray(read.value)) {
      report('supplier_risk_history', 'not_a_list', this.ctx.organizationId, 'error');
      return { state: 'could_not_check' };
    }
    return {
      state: 'ok',
      value: (read.value as Array<Record<string, unknown>>)
        .map(historyRowOf)
        .filter((r): r is SupplierRiskHistoryRow => r !== null),
    };
  }

  /** One version, with its items; null when there is no such review in this organization. */
  async review(reviewId: string): Promise<SupplierRiskRead<SupplierRiskReview | null>> {
    assertMayUseSupplierRisk(this.ctx);
    if (!isUuid(reviewId)) return { state: 'ok', value: null };
    const read = await this.settleRead(
      'supplier_risk_review',
      this.ctx.supabase.rpc('supplier_risk_review', {
        p_organization_id: this.ctx.organizationId,
        p_review_id: reviewId,
      }),
    );
    if (read.state !== 'ok') return read;
    if (read.value === null) return { state: 'ok', value: null };
    const review = reviewOf(read.value);
    if (!review) {
      report('supplier_risk_review', 'unreadable', this.ctx.organizationId, 'error');
      return { state: 'could_not_check' };
    }
    return { state: 'ok', value: review };
  }

  /**
   * The current owners and admins (accepted, not a support seat, account not
   * disabled), by name: the only people an item may be given to.
   */
  async ownersAndAdmins(): Promise<SupplierRiskRead<SupplierRiskPerson[]>> {
    assertMayUseSupplierRisk(this.ctx);
    try {
      const { data, error } = await this.ctx.supabase
        .from('organization_members')
        .select('user_id, role, user:user_id (id, email, full_name, disabled_at)')
        .eq('organization_id', this.ctx.organizationId)
        .not('accepted_at', 'is', null)
        .is('impersonation_expires_at', null)
        .order('created_at', { ascending: true })
        .limit(1000);
      if (error || !Array.isArray(data)) {
        report(
          'organization_members',
          error?.code ?? 'not_a_list',
          this.ctx.organizationId,
          'error',
        );
        return { state: 'could_not_check' };
      }
      const people: SupplierRiskPerson[] = [];
      for (const raw of data as Array<Record<string, unknown>>) {
        const userId = text(raw.user_id);
        if (!userId || !isAdminRole(raw.role as never)) continue;
        const userField = Array.isArray(raw.user) ? raw.user[0] : raw.user;
        const user = (userField && typeof userField === 'object' ? userField : {}) as Record<
          string,
          unknown
        >;
        if (user.disabled_at != null) continue;
        const name =
          text(typeof user.full_name === 'string' ? user.full_name.trim() : null) ??
          text(user.email) ??
          'Unknown';
        people.push({ userId, name });
      }
      return { state: 'ok', value: people };
    } catch {
      report('organization_members', 'threw', this.ctx.organizationId, 'error');
      return { state: 'could_not_check' };
    }
  }

  /** Save the organization's one draft of this supplier's review. Answers may be partial. */
  async saveDraft(
    input: SupplierRiskDraftInput,
  ): Promise<{ reviewId: string; version: number | null; updatedAt: string | null }> {
    assertMayUseSupplierRisk(this.ctx);
    await this.assertMayWrite();
    const problem = vendorRiskAnswersProblem(input.dataLevel, input.answers, false, {
      utcToday: utcToday(),
    });
    if (problem) throw refused(problem);
    const answers = answersForDatabase(input.answers);
    const data = await this.settleWrite(
      'supplier_risk_draft_save',
      this.ctx.supabase.rpc('supplier_risk_draft_save', {
        p_organization_id: this.ctx.organizationId,
        p_supplier_id: input.supplierId,
        p_data_level: input.dataLevel,
        p_answers: answers,
      }),
    );
    const row = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const reviewId = text(row.review_id);
    if (!reviewId) {
      report('supplier_risk_draft_save', 'unreadable', this.ctx.organizationId, 'error');
      throw new ServiceError(
        'internal_error',
        'supplier_risk_draft_save answered without a review',
      );
    }
    const version = intOf(row.version);
    void audit(
      {
        event: 'supplier.risk_draft_saved',
        entityType: 'supplier',
        entityId: input.supplierId,
        extra: {
          review_id: reviewId,
          version,
          data_level: input.dataLevel,
          answered: Object.keys(answers).length,
        },
      },
      this.ctx,
    );
    return { reviewId, version, updatedAt: text(row.updated_at) };
  }

  /**
   * Finish the review: the open draft (or a new version) becomes the current
   * review, and the database works out the result from the answers. The draft
   * must be the one the page read (CONTRACT.md 6.9): when it was saved again,
   * or saved or discarded elsewhere, since then, nothing is sent.
   */
  async finish(input: SupplierRiskFinishInput): Promise<SupplierRiskFinishResult> {
    assertMayUseSupplierRisk(this.ctx);
    await this.assertMayWrite();
    const problem = vendorRiskAnswersProblem(input.dataLevel, input.answers, true, {
      utcToday: utcToday(),
    });
    if (problem) throw refused(problem);
    if (input.overrideResult === null && input.overrideReason !== null)
      throw refused('bad_override');
    if (input.overrideResult !== null && !vendorRiskOverrideReasonOk(input.overrideReason)) {
      throw refused('bad_override_reason', 'overrideReason');
    }
    for (const item of input.items) {
      if (!vendorRiskTextOk(item.finding, 1, VENDOR_RISK_FINDING_MAX))
        throw refused('bad_item_text', `finding:${item.questionKey}`);
      if (!vendorRiskTextOk(item.action, 1, VENDOR_RISK_ACTION_MAX))
        throw refused('bad_item_text', `action:${item.questionKey}`);
    }

    const history = await this.history(input.supplierId);
    if (history.state !== 'ok') {
      throw new ServiceError('conflict', SUPPLIER_RISK_NOTHING_SAVED, {
        reason: 'could_not_check',
        retryable: true,
      });
    }
    const draftNow = history.value.find((r) => r.status === 'draft') ?? null;
    if (!sameInstant(draftNow?.updatedAt ?? null, input.draftUpdatedAt)) {
      throw new ServiceError('conflict', SUPPLIER_RISK_DRAFT_MOVED, { reason: 'draft_moved' });
    }

    const data = await this.settleWrite(
      'supplier_risk_finalise',
      this.ctx.supabase.rpc('supplier_risk_finalise', {
        p_organization_id: this.ctx.organizationId,
        p_supplier_id: input.supplierId,
        p_data_level: input.dataLevel,
        p_answers: answersForDatabase(input.answers),
        p_next_review_on: input.nextReviewOn,
        p_override_result: input.overrideResult,
        p_override_reason: input.overrideResult === null ? null : input.overrideReason,
        p_items: input.items.map((i) => ({
          question_key: i.questionKey,
          finding: i.finding,
          action: i.action,
          owner_user_id: i.ownerUserId,
          due_on: i.dueOn,
        })),
      }),
    );
    const row = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const reviewId = text(row.review_id);
    const version = intOf(row.version);
    if (!reviewId || version === null) {
      report('supplier_risk_finalise', 'unreadable', this.ctx.organizationId, 'error');
      throw new ServiceError('internal_error', 'supplier_risk_finalise answered without a review');
    }
    const computedResult = oneOf(VENDOR_RISK_RESULTS, row.computed_result);
    const result = oneOf(VENDOR_RISK_RESULTS, row.result);
    const overrideResult = oneOf(VENDOR_RISK_RESULTS, row.override_result);
    const overridden = overrideResult !== null;
    const items = intOf(row.items) ?? input.items.length;
    void audit(
      {
        event: 'supplier.risk_review_finished',
        entityType: 'supplier',
        entityId: input.supplierId,
        extra: {
          review_id: reviewId,
          version,
          superseded_review_id: text(row.superseded_review_id),
          data_level: input.dataLevel,
          computed_result: computedResult,
          result,
          overridden,
          items,
        },
      },
      this.ctx,
    );
    if (overridden) {
      void audit(
        {
          event: 'supplier.risk_review_overridden',
          entityType: 'supplier',
          entityId: input.supplierId,
          extra: {
            review_id: reviewId,
            version,
            computed_result: computedResult,
            override_result: overrideResult,
            // The reason is on the review, read by owners and admins only; the
            // log keeps its length, never its words.
            reason_length: Array.from(input.overrideReason ?? '').length,
          },
        },
        this.ctx,
      );
    }
    return {
      reviewId,
      version,
      computedResult,
      result,
      overridden,
      nextReviewOn: day(row.next_review_on),
      items,
    };
  }

  /** Delete this organization's draft of the supplier's review (true when there was one). */
  async discardDraft(supplierId: string): Promise<boolean> {
    assertMayUseSupplierRisk(this.ctx);
    await this.assertMayWrite();
    if (!isUuid(supplierId)) throw refused('supplier_not_found');
    const data = await this.settleWrite(
      'supplier_risk_draft_discard',
      this.ctx.supabase.rpc('supplier_risk_draft_discard', {
        p_organization_id: this.ctx.organizationId,
        p_supplier_id: supplierId,
      }),
    );
    const discarded = data === true;
    if (discarded) {
      void audit(
        { event: 'supplier.risk_draft_discarded', entityType: 'supplier', entityId: supplierId },
        this.ctx,
      );
    }
    return discarded;
  }

  /**
   * Change one item of the current review: its status, owner, due date,
   * action, and (for Risk accepted) why. The item is read first, in this
   * organization, for the audit entry's before.
   */
  async updateItem(input: SupplierRiskItemUpdateInput): Promise<SupplierRiskItem> {
    assertMayUseSupplierRisk(this.ctx);
    await this.assertMayWrite();
    if (input.action !== null && !vendorRiskTextOk(input.action, 1, VENDOR_RISK_ACTION_MAX)) {
      throw refused('bad_item_text', 'action');
    }
    if (
      input.reason !== null &&
      (input.status !== 'accepted' || !vendorRiskOverrideReasonOk(input.reason))
    ) {
      throw refused('bad_item_reason', 'reason');
    }

    const current = await this.review(input.reviewId);
    if (current.state !== 'ok') {
      throw new ServiceError('conflict', SUPPLIER_RISK_NOTHING_SAVED, {
        reason: 'could_not_check',
        retryable: true,
      });
    }
    const before = current.value?.items.find((i) => i.id === input.itemId) ?? null;
    if (!current.value || !before) throw refused('item_not_found');
    if (!current.value.isCurrent) throw refused('item_not_current');
    if (input.status === 'accepted' && before.status !== 'accepted' && input.reason === null) {
      throw refused('bad_item_reason', 'reason');
    }

    const data = await this.settleWrite(
      'supplier_risk_item_update',
      this.ctx.supabase.rpc('supplier_risk_item_update', {
        p_organization_id: this.ctx.organizationId,
        p_item_id: input.itemId,
        p_status: input.status,
        p_owner_user_id: input.ownerUserId,
        p_due_on: input.dueOn,
        p_action: input.action,
        p_reason: input.reason,
      }),
    );
    const after = itemOf(data);
    if (!after) {
      report('supplier_risk_item_update', 'unreadable', this.ctx.organizationId, 'error');
      throw new ServiceError(
        'internal_error',
        'supplier_risk_item_update answered without the item',
      );
    }
    void audit(
      {
        event: 'supplier.risk_item_changed',
        entityType: 'supplier',
        entityId: current.value.supplierId,
        before: { status: before.status, owner_user_id: before.ownerUserId, due_on: before.dueOn },
        after: { status: after.status, owner_user_id: after.ownerUserId, due_on: after.dueOn },
        extra: {
          review_id: input.reviewId,
          item_id: input.itemId,
          question_key: before.questionKey,
          action_changed: input.action !== null && input.action !== before.action,
        },
      },
      this.ctx,
    );
    if (input.status === 'accepted' && input.reason !== null) {
      void audit(
        {
          event: 'supplier.risk_accepted',
          entityType: 'supplier',
          entityId: current.value.supplierId,
          extra: {
            review_id: input.reviewId,
            item_id: input.itemId,
            question_key: before.questionKey,
            severity: before.severity,
            // Who accepted it and why are on the item; the log keeps the
            // reason's length, never its words.
            reason_length: Array.from(input.reason).length,
          },
        },
        this.ctx,
      );
    }
    return after;
  }
}
