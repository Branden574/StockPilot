import {
  addVendorRiskDays,
  addVendorRiskMonths,
  parseVendorRiskDate,
  VENDOR_RISK_ANSWER_DATE_MAX,
  VENDOR_RISK_ANSWER_DATE_MIN,
  VENDOR_RISK_REFUSAL_WORDS,
  type VendorRiskAnswer,
  type VendorRiskQuestion,
} from '@stockpilot/core';

/**
 * What the review form says beside a date (REVIEW-0481 round 3, follow-up 2).
 * Two days are used, as the database uses them:
 *   - `utcToday`, the UTC day: a date beside the security report or the
 *     insurance may be at most one day later (later is refused,
 *     answer_date_in_future), so the date input allows nothing later;
 *   - `orgToday`, the organization's day (the review's day): a Yes dated more
 *     than 12 months before it counts as Not shown to us (out of date).
 * The data agreement's date is kept and never judged: a date after today is
 * only a warning.
 */

export type SupplierRiskDateIssue =
  'missing' | 'future' | 'out_of_date' | 'after_today' | 'bad' | null;

/** The latest day a judged date input allows: tomorrow in UTC. */
export function supplierRiskLatestEvidenceDay(utcToday: string): string {
  return addVendorRiskDays(utcToday, 1);
}

export function supplierRiskDateIssue(
  q: Pick<VendorRiskQuestion, 'date'>,
  entry: { answer: VendorRiskAnswer | null; date: string },
  days: { orgToday: string; utcToday: string },
): SupplierRiskDateIssue {
  if (!q.date) return null;
  const judged = q.date.maxAgeMonths !== null;
  const date = entry.date;
  if (!date) return judged && entry.answer === 'yes' ? 'missing' : null;
  if (
    !parseVendorRiskDate(date) ||
    date < VENDOR_RISK_ANSWER_DATE_MIN ||
    date > VENDOR_RISK_ANSWER_DATE_MAX
  ) {
    return 'bad';
  }
  if (judged && date > supplierRiskLatestEvidenceDay(days.utcToday)) return 'future';
  if (!judged) return date > days.orgToday ? 'after_today' : null;
  if (
    entry.answer === 'yes' &&
    q.date.maxAgeMonths !== null &&
    date < addVendorRiskMonths(days.orgToday, -q.date.maxAgeMonths)
  ) {
    return 'out_of_date';
  }
  return null;
}

export function supplierRiskDateIssueWords(issue: SupplierRiskDateIssue): string | null {
  switch (issue) {
    case 'missing':
      return 'Give the date on the document. It is needed to finish the review.';
    case 'future':
      return 'This date is in the future. Give the date printed on the document.';
    case 'out_of_date':
      return 'This date is more than 12 months before today, so the document counts as Not shown to us (out of date). Ask the vendor for a newer one.';
    case 'after_today':
      return 'This date is after today. Check that it is the day the agreement was signed.';
    case 'bad':
      return VENDOR_RISK_REFUSAL_WORDS.answer_bad_date;
    default:
      return null;
  }
}

/** The issues that stop a save (a draft) or a finish; the others are said and allowed. */
export function supplierRiskDateIssueBlocks(
  issue: SupplierRiskDateIssue,
  finishing: boolean,
): boolean {
  if (issue === 'future' || issue === 'bad') return true;
  return finishing && issue === 'missing';
}
