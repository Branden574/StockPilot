// The review questions were adapted, reworded and reduced, from the grc-assessment skill shown in the Cite-Talk-2026 talk.
/**
 * VENDOR RISK REVIEWS, the rules: from the data level and the answers, the
 * starting risk, how well the answers are evidenced, the hard stops, the risk
 * that is left, the result, and the item each gap makes; the default next
 * review date; the checks the database makes on what is stored.
 *
 * The database applies the same rules (migration 0481: _supplier_risk_evaluate,
 * _supplier_risk_answers_problem, _supplier_risk_default_next_review) and
 * stores its own result, never one sent to it. The case table in
 * supabase/tests/0481_supplier_risk_reviews.test.sql (between the
 * VENDOR RISK CASES markers) is run against both: vendor-risk.parity.test.ts
 * here, the pgTAP file there.
 *
 * THE RULES, version 1 (VENDOR_RISK_RULES_TEXT says them in words for the
 * page). The rules are versioned: a stored review keeps the rules version it
 * was judged under, and the database holds every stored final to it.
 *   - Asked: with "No data of ours", nothing; with staff contact details, the
 *     nine questions of the first three groups; with student data, all
 *     fourteen.
 *   - Out of date: a Yes to the security report or to insurance whose date is
 *     more than 12 months before the review counts as Not shown to us, and
 *     its item says it is out of date. A Yes with no date is not judged.
 *   - Gap: an asked question answered No or Not shown to us (out of date
 *     included). Not shown never counts as a pass. (A preview of an
 *     unfinished review counts an unanswered question as Not shown; the
 *     database stores a result only for a finished review, with every asked
 *     question answered.)
 *   - Starting risk, from the level: none Low, staff Moderate, student High.
 *   - Evidence: not needed when nothing is asked; else, first that holds:
 *       not enough to judge: a key paper (data agreement, breach notice time,
 *         security report) is Not shown, or more than half the answers are
 *         Not shown;
 *       weak: a key paper is No, or there are three gaps or more;
 *       adequate: one or two gaps;
 *       strong: no gap.
 *   - Hard stops, with student data only (the design names "no breach notice"
 *     with no condition; here none applies without student data): no signed
 *     data agreement; no breach notice time; the three school-official
 *     conditions (direct control, use only for the service, no passing on);
 *     the contract does not forbid sale or advertising; it does not forbid AI
 *     training. Each is a No; the same question Not shown is a hard stop not
 *     yet ruled out. Every question of the Student data group is one of them,
 *     so Not shown on any of those is More information needed.
 *   - Risk left: High with a hard stop; else Low when the evidence is strong
 *     or not needed; one step below the starting risk when adequate; the
 *     starting risk when weak or not enough to judge.
 *   - Result, first that holds: a hard stop, Do not use; a hard stop not yet
 *     ruled out, evidence not enough to judge, or more than three gaps, More
 *     information needed; no gap (every asked answer Yes), Approve; else
 *     Approve with conditions (the items are the conditions).
 *
 * Pure: no I/O, no clock. Dates are 'YYYY-MM-DD' strings in the
 * organization's own zone, worked out by the caller.
 */

import {
  isVendorRiskAnswer,
  type VendorRiskItemAnswer,
  isVendorRiskDataLevel,
  VENDOR_RISK_QUESTIONS,
  VENDOR_RISK_RULES_VERSION,
  vendorRiskQuestion,
  vendorRiskQuestionApplies,
  vendorRiskQuestionsFor,
  type VendorRiskAnswer,
  type VendorRiskDataLevel,
  type VendorRiskHardStop,
  type VendorRiskQuestionKey,
  type VendorRiskSeverity,
} from './questions';

/* ─────────────────────────────── the closed lists ─────────────────────────────── */

export const VENDOR_RISK_RESULTS = [
  'approve',
  'approve_with_conditions',
  'more_information',
  'do_not_use',
] as const;
export type VendorRiskResult = (typeof VENDOR_RISK_RESULTS)[number];

export const VENDOR_RISK_EVIDENCE_LEVELS = [
  'not_needed',
  'strong',
  'adequate',
  'weak',
  'insufficient',
] as const;
export type VendorRiskEvidence = (typeof VENDOR_RISK_EVIDENCE_LEVELS)[number];

export const VENDOR_RISK_RISK_LEVELS = ['low', 'moderate', 'high'] as const;
export type VendorRiskRiskLevel = (typeof VENDOR_RISK_RISK_LEVELS)[number];

export const VENDOR_RISK_ITEM_STATUSES = ['open', 'in_progress', 'done', 'accepted'] as const;
export type VendorRiskItemStatus = (typeof VENDOR_RISK_ITEM_STATUSES)[number];
/** The statuses that close an item (the database stamps closed_at for them). */
export const VENDOR_RISK_CLOSED_ITEM_STATUSES: readonly VendorRiskItemStatus[] = [
  'done',
  'accepted',
];

/* ─────────────────────────────── the rules' numbers ─────────────────────────────── */

export const VENDOR_RISK_STARTING_RISK: Readonly<Record<VendorRiskDataLevel, VendorRiskRiskLevel>> =
  {
    none: 'low',
    staff: 'moderate',
    student: 'high',
  };

/** At most this many gaps, none of them a key paper, is "adequate". */
export const VENDOR_RISK_ADEQUATE_MAX_GAPS = 2;
/** More gaps than this can never be "Approve with conditions" (it is More information needed, or Do not use). */
export const VENDOR_RISK_CONDITIONS_MAX_GAPS = 3;

/** The default time to the next review, by level: 12 months, sooner for student data. */
export const VENDOR_RISK_NEXT_REVIEW_MONTHS: Readonly<Record<VendorRiskDataLevel, number>> = {
  none: 12,
  staff: 12,
  student: 6,
};

/** The latest a next review, or an item's due date, may be set: this many years from today. */
export const VENDOR_RISK_MAX_YEARS_AHEAD = 3;
/** A reminder goes this many days before the review date (and one on the day). */
export const VENDOR_RISK_REMINDER_DAYS_BEFORE = 30;

/** Text limits, the database's own (0481's CHECKs and functions). */
export const VENDOR_RISK_NOTE_MAX = 1000;
export const VENDOR_RISK_OVERRIDE_REASON_MIN = 20;
export const VENDOR_RISK_OVERRIDE_REASON_MAX = 2000;
export const VENDOR_RISK_FINDING_MAX = 500;
export const VENDOR_RISK_ACTION_MAX = 1000;
/** The earliest and latest date an answer's date may name. */
export const VENDOR_RISK_ANSWER_DATE_MIN = '2000-01-01';
export const VENDOR_RISK_ANSWER_DATE_MAX = '2100-12-31';

/* ─────────────────────────────────── shapes ─────────────────────────────────── */

/** One answer as the database stores it: answers[question key]. */
export interface VendorRiskAnswerEntry {
  answer: VendorRiskAnswer;
  /** Plain text, 1 to 1000 characters, or absent. */
  note?: string | null;
  /** 'YYYY-MM-DD', only for a question with a date, or absent. Never invented: leave it out when it is not known. */
  date?: string | null;
}
export type VendorRiskAnswers = Partial<Record<VendorRiskQuestionKey, VendorRiskAnswerEntry>>;

/** An item a gap makes, as suggested (the admin may change the action, and adds the owner and due date). */
export interface VendorRiskItemSuggestion {
  questionKey: VendorRiskQuestionKey;
  answer: VendorRiskItemAnswer;
  severity: VendorRiskSeverity;
  finding: string;
  action: string;
}

export interface VendorRiskEvaluation {
  rulesVersion: typeof VENDOR_RISK_RULES_VERSION;
  level: VendorRiskDataLevel;
  /** The questions asked at this level, in order. */
  asked: VendorRiskQuestionKey[];
  /** Asked and not answered yet (counted as Not shown). */
  missing: VendorRiskQuestionKey[];
  complete: boolean;
  /** Asked and answered No or Not shown (or not answered, or out of date), in order. */
  gaps: VendorRiskQuestionKey[];
  /** Answered Yes with a date too long before the review: counted as Not shown, in order. */
  outOfDate: VendorRiskQuestionKey[];
  notShownCount: number;
  startingRisk: VendorRiskRiskLevel;
  evidence: VendorRiskEvidence;
  residualRisk: VendorRiskRiskLevel;
  /** Hard stops that apply, in question order. */
  hardStops: VendorRiskHardStop[];
  /** Hard stops not yet ruled out: the question was Not shown. */
  pendingHardStops: VendorRiskHardStop[];
  result: VendorRiskResult;
  /** One item for each gap, in question order. */
  items: VendorRiskItemSuggestion[];
}

/* ──────────────────────────────────── rules ──────────────────────────────────── */

/** The answer given to a question, or null when there is none (or it is not one of the three). */
function answerOf(
  answers: VendorRiskAnswers | null | undefined,
  key: VendorRiskQuestionKey,
): VendorRiskAnswer | null {
  const entry = answers?.[key] as unknown;
  if (entry === null || typeof entry !== 'object') return null;
  const a = (entry as { answer?: unknown }).answer;
  return isVendorRiskAnswer(a) ? a : null;
}

/** The date given beside an answer when it is a real calendar date, else null. */
function dateOf(
  answers: VendorRiskAnswers | null | undefined,
  key: VendorRiskQuestionKey,
): string | null {
  const entry = answers?.[key] as unknown;
  if (entry === null || typeof entry !== 'object') return null;
  const d = (entry as { date?: unknown }).date;
  return typeof d === 'string' && parseVendorRiskDate(d) ? d : null;
}

export interface VendorRiskEvaluateOptions {
  /**
   * The day of the review, 'YYYY-MM-DD' in the organization's zone (for a
   * finished review, the day it was finished). The dates beside the answers
   * are judged against it; without it they are not judged.
   */
  reviewedOn?: string | null;
}

const RISK_STEP_DOWN: Readonly<Record<VendorRiskRiskLevel, VendorRiskRiskLevel>> = {
  high: 'moderate',
  moderate: 'low',
  low: 'low',
};

/**
 * The rules, applied. Answers to questions not asked at this level are
 * ignored here (the database refuses them: vendorRiskAnswersProblem).
 */
export function evaluateVendorRisk(
  level: VendorRiskDataLevel,
  answers: VendorRiskAnswers | null | undefined,
  options: VendorRiskEvaluateOptions = {},
): VendorRiskEvaluation {
  const asked = vendorRiskQuestionsFor(level);
  const missing: VendorRiskQuestionKey[] = [];
  const gaps: VendorRiskQuestionKey[] = [];
  const outOfDate: VendorRiskQuestionKey[] = [];
  const hardStops: VendorRiskHardStop[] = [];
  const pendingHardStops: VendorRiskHardStop[] = [];
  const items: VendorRiskItemSuggestion[] = [];
  const reviewedOn = options.reviewedOn ?? null;
  if (reviewedOn !== null && !parseVendorRiskDate(reviewedOn)) {
    throw new RangeError(`not a date: ${reviewedOn}`);
  }
  let notShown = 0;
  let keyNotShown = false;
  let keyNo = false;

  for (const q of asked) {
    const given = answerOf(answers, q.key);
    if (given === null) missing.push(q.key);
    // Not answered counts as Not shown: never as a pass.
    let a: VendorRiskAnswer = given ?? 'not_shown';
    let stale = false;
    if (a === 'yes' && q.date?.maxAgeMonths && reviewedOn !== null) {
      const d = dateOf(answers, q.key);
      if (d !== null && d < addVendorRiskMonths(reviewedOn, -q.date.maxAgeMonths)) {
        a = 'not_shown';
        stale = true;
        outOfDate.push(q.key);
      }
    }
    if (a === 'yes') continue;
    gaps.push(q.key);
    if (a === 'not_shown') {
      notShown += 1;
      if (q.keyEvidence) keyNotShown = true;
    } else if (q.keyEvidence) {
      keyNo = true;
    }
    if (level === 'student' && q.hardStop) {
      (a === 'no' ? hardStops : pendingHardStops).push(q.hardStop);
    }
    const severity = level === 'student' ? q.severity.student : q.severity.staff;
    items.push({
      questionKey: q.key,
      answer: stale ? 'out_of_date' : a,
      // A question asked at this level always has a severity for it.
      severity: severity ?? q.severity.student,
      finding: stale ? (q.finding.out_of_date ?? q.finding.not_shown) : q.finding[a],
      action: q.action,
    });
  }

  const n = asked.length;
  let evidence: VendorRiskEvidence;
  if (n === 0) evidence = 'not_needed';
  else if (keyNotShown || notShown * 2 > n) evidence = 'insufficient';
  else if (keyNo || gaps.length > VENDOR_RISK_ADEQUATE_MAX_GAPS) evidence = 'weak';
  else if (gaps.length > 0) evidence = 'adequate';
  else evidence = 'strong';

  const startingRisk = VENDOR_RISK_STARTING_RISK[level];
  let residualRisk: VendorRiskRiskLevel;
  if (hardStops.length > 0) residualRisk = 'high';
  else if (evidence === 'strong' || evidence === 'not_needed') residualRisk = 'low';
  else if (evidence === 'adequate') residualRisk = RISK_STEP_DOWN[startingRisk];
  else residualRisk = startingRisk;

  let result: VendorRiskResult;
  if (hardStops.length > 0) result = 'do_not_use';
  else if (
    pendingHardStops.length > 0 ||
    evidence === 'insufficient' ||
    gaps.length > VENDOR_RISK_CONDITIONS_MAX_GAPS
  )
    result = 'more_information';
  else if (gaps.length === 0) result = 'approve';
  else result = 'approve_with_conditions';

  return {
    rulesVersion: VENDOR_RISK_RULES_VERSION,
    level,
    asked: asked.map((q) => q.key),
    missing,
    complete: missing.length === 0,
    gaps,
    outOfDate,
    notShownCount: notShown,
    startingRisk,
    evidence,
    residualRisk,
    hardStops,
    pendingHardStops,
    result,
    items,
  };
}

/** The result in force: the admin's override when there is one, else the computed result. */
export function vendorRiskResultInForce(
  computed: VendorRiskResult,
  override: VendorRiskResult | null | undefined,
): VendorRiskResult {
  return override ?? computed;
}

/** The follow-up questions for the vendor: one for each gap, in question order. */
export function vendorRiskFollowUps(
  level: VendorRiskDataLevel,
  answers: VendorRiskAnswers | null | undefined,
  options: VendorRiskEvaluateOptions = {},
): string[] {
  return evaluateVendorRisk(level, answers, options).gaps.map(
    (k) => vendorRiskQuestion(k)!.followUp,
  );
}

/**
 * The follow-up questions as plain text to paste into an email to the vendor,
 * or null when there is nothing to ask. The supplier's name is the caller's
 * text: the result is plain text, never markup.
 */
export function vendorRiskFollowUpEmail(
  supplierName: string,
  level: VendorRiskDataLevel,
  answers: VendorRiskAnswers | null | undefined,
  options: VendorRiskEvaluateOptions = {},
): string | null {
  const asks = vendorRiskFollowUps(level, answers, options);
  if (asks.length === 0) return null;
  const name = supplierName.trim() || 'your company';
  return [
    `Questions for ${name} about the data of ours you hold`,
    '',
    ...asks.map((a, i) => `${i + 1}. ${a}`),
    '',
    'Thank you. Please send copies of the documents themselves where you can: we record only what we have seen.',
  ].join('\n');
}

/* ─────────────────────────────────── dates ─────────────────────────────────── */

const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

function daysInMonth(y: number, m: number): number {
  // m is 1..12. Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 'YYYY-MM-DD' to [y, m, d] when it is a real calendar date, else null. */
export function parseVendorRiskDate(s: unknown): [number, number, number] | null {
  if (typeof s !== 'string') return null;
  const m = ISO_DATE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return [y, mo, d];
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * A date plus whole months, as Postgres adds an interval of months to a date:
 * the same day of the month, or the month's last day when it has fewer
 * (2026-08-31 plus 6 months is 2027-02-28).
 */
export function addVendorRiskMonths(fromIsoDate: string, months: number): string {
  const p = parseVendorRiskDate(fromIsoDate);
  if (!p) throw new RangeError(`not a date: ${fromIsoDate}`);
  const [y, m, d] = p;
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return iso(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** A date plus whole days. */
export function addVendorRiskDays(fromIsoDate: string, days: number): string {
  const p = parseVendorRiskDate(fromIsoDate);
  if (!p) throw new RangeError(`not a date: ${fromIsoDate}`);
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** The default next review date for a review finished on `reviewedOn` (the organization's today). */
export function vendorRiskDefaultNextReview(
  level: VendorRiskDataLevel,
  reviewedOn: string,
): string {
  return addVendorRiskMonths(reviewedOn, VENDOR_RISK_NEXT_REVIEW_MONTHS[level]);
}

/** May a next review be set to this date, on this day? After today, and at most three years ahead. */
export function vendorRiskNextReviewAllowed(nextOn: string, today: string): boolean {
  if (!parseVendorRiskDate(nextOn) || !parseVendorRiskDate(today)) return false;
  return nextOn > today && nextOn <= addVendorRiskMonths(today, VENDOR_RISK_MAX_YEARS_AHEAD * 12);
}

/** May an item's due date be set to this date, on this day? Today or later, at most three years ahead. */
export function vendorRiskDueDateAllowed(dueOn: string, today: string): boolean {
  if (!parseVendorRiskDate(dueOn) || !parseVendorRiskDate(today)) return false;
  return dueOn >= today && dueOn <= addVendorRiskMonths(today, VENDOR_RISK_MAX_YEARS_AHEAD * 12);
}

/**
 * Where a review stands against its next review date on `today`: overdue,
 * due today, due within 30 days, or scheduled.
 */
export type VendorRiskReviewDue =
  'not_reviewed' | 'overdue' | 'due_today' | 'due_soon' | 'scheduled';
export function vendorRiskReviewDue(
  nextReviewOn: string | null,
  today: string,
): VendorRiskReviewDue {
  if (!nextReviewOn) return 'not_reviewed';
  if (nextReviewOn < today) return 'overdue';
  if (nextReviewOn === today) return 'due_today';
  if (nextReviewOn <= addVendorRiskDays(today, VENDOR_RISK_REMINDER_DAYS_BEFORE)) return 'due_soon';
  return 'scheduled';
}

/* ──────────────────────────── what the database refuses ──────────────────────────── */

/**
 * The rule for every text the database stores (a note, a reason, a finding, an
 * action): min to max characters; at least one that is not a space, tab or
 * line break; no control character but tab and line breaks; none of the
 * invisible or direction-changing characters (U+200B to U+200F, U+2028,
 * U+2029, U+202A to U+202E, U+2066 to U+2069, U+FEFF). The database's
 * _supplier_risk_text_ok is the same rule.
 */
const FORBIDDEN_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/u;
export function vendorRiskTextOk(text: unknown, min: number, max: number): boolean {
  if (typeof text !== 'string') return false;
  const len = Array.from(text).length;
  if (len < min || len > max) return false;
  if (!/[^ \t\r\n]/.test(text)) return false;
  return !FORBIDDEN_CHARS.test(text);
}

/**
 * A reason (an override's, or a risk accepted): the text rule with 1 to 2000
 * characters, at least 20 once spaces, tabs and line breaks at the ends are
 * trimmed, and not one character repeated (at least two different characters
 * that are not a space, tab or line break).
 */
export function vendorRiskOverrideReasonOk(text: unknown): boolean {
  if (!vendorRiskTextOk(text, 1, VENDOR_RISK_OVERRIDE_REASON_MAX)) return false;
  const t = text as string;
  if (
    Array.from(t.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')).length < VENDOR_RISK_OVERRIDE_REASON_MIN
  )
    return false;
  return new Set(Array.from(t).filter((c) => !/[ \t\r\n]/.test(c))).size >= 2;
}

export const VENDOR_RISK_ANSWER_PROBLEMS = [
  'bad_data_level',
  'answers_not_an_object',
  'answer_unknown_question',
  'answer_not_applicable',
  'answer_bad_shape',
  'answer_bad_value',
  'answer_bad_note',
  'answer_date_not_allowed',
  'answer_bad_date',
  'answers_incomplete',
] as const;
export type VendorRiskAnswerProblem = (typeof VENDOR_RISK_ANSWER_PROBLEMS)[number];

const ENTRY_FIELDS = new Set(['answer', 'note', 'date']);

/** Keys in the order Postgres keeps a jsonb object's keys: shorter first, then by character. */
function jsonbKeyOrder(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * What the database would refuse in these answers (the same code), or null
 * when it takes them. `final`: a finished review must answer every question
 * asked at its level. With several problems, the code names one of them.
 */
export function vendorRiskAnswersProblem(
  level: unknown,
  answers: unknown,
  final: boolean,
): VendorRiskAnswerProblem | null {
  if (!isVendorRiskDataLevel(level)) return 'bad_data_level';
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers))
    return 'answers_not_an_object';
  const obj = answers as Record<string, unknown>;
  for (const key of Object.keys(obj).sort(jsonbKeyOrder)) {
    const q = vendorRiskQuestion(key);
    if (!q) return 'answer_unknown_question';
    if (!vendorRiskQuestionApplies(q, level)) return 'answer_not_applicable';
    const v = obj[key];
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'answer_bad_shape';
    const entry = v as Record<string, unknown>;
    if (Object.keys(entry).some((f) => !ENTRY_FIELDS.has(f))) return 'answer_bad_shape';
    if (!isVendorRiskAnswer(entry.answer)) return 'answer_bad_value';
    if (
      entry.note !== undefined &&
      entry.note !== null &&
      !vendorRiskTextOk(entry.note, 1, VENDOR_RISK_NOTE_MAX)
    ) {
      return 'answer_bad_note';
    }
    if (entry.date !== undefined && entry.date !== null) {
      if (!q.date) return 'answer_date_not_allowed';
      if (
        !parseVendorRiskDate(entry.date) ||
        (entry.date as string) < VENDOR_RISK_ANSWER_DATE_MIN ||
        (entry.date as string) > VENDOR_RISK_ANSWER_DATE_MAX
      ) {
        return 'answer_bad_date';
      }
    }
  }
  if (
    final &&
    VENDOR_RISK_QUESTIONS.some((q) => vendorRiskQuestionApplies(q, level) && !(q.key in obj))
  ) {
    return 'answers_incomplete';
  }
  return null;
}
