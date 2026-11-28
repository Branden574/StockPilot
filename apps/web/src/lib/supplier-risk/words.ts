import {
  VENDOR_RISK_HARD_STOP_WORDS,
  VENDOR_RISK_RESULT_WORDS,
  vendorRiskTextOk,
  type VendorRiskResult,
  type VendorRiskReviewDue,
} from '@stockpilot/core';

import { supplierRiskDayWords } from './reminder-words';

/**
 * The vendor risk pages' own words and orderings, beside core's (core's words
 * are the rules' and the database's; these are the pages'). Pure: safe in a
 * client component.
 */

export const SUPPLIER_RISK_REVIEW_DUE_WORDS: Readonly<Record<VendorRiskReviewDue, string>> = {
  not_reviewed: 'Not reviewed',
  overdue: 'Overdue',
  due_today: 'Due today',
  due_soon: 'Due within 30 days',
  scheduled: 'Scheduled',
};

/** The register's order: overdue first, then due today, due soon, never reviewed, scheduled. */
const DUE_RANK: Readonly<Record<VendorRiskReviewDue, number>> = {
  overdue: 0,
  due_today: 1,
  due_soon: 2,
  not_reviewed: 3,
  scheduled: 4,
};

export const SUPPLIER_RISK_DUE_REMINDER_NOT_SENT = 'The due reminder could not be sent.';
export const SUPPLIER_RISK_NOT_REVIEWED = 'Not reviewed';
export const SUPPLIER_RISK_COULD_NOT_CHECK_CELL = 'Could not check';
export const SUPPLIER_RISK_OWNER_NOT_ADMIN = 'no longer an owner or admin';
export const SUPPLIER_RISK_SUPPLIER_STATE_WORDS = {
  active: 'Active',
  archived: 'Archived',
  deleted: 'Deleted',
} as const;

export interface SupplierRiskSortable {
  supplierName: string;
  supplierState: 'active' | 'archived' | 'deleted';
  reviewDue: VendorRiskReviewDue;
  nextReviewOn: string | null;
}

/** Overdue first; archived and deleted suppliers after every active one; then by date, then by name. */
export function sortSupplierRiskRegister<T extends SupplierRiskSortable>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const sa = a.supplierState === 'active' ? 0 : 1;
    const sb = b.supplierState === 'active' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const da = DUE_RANK[a.reviewDue] ?? 9;
    const db = DUE_RANK[b.reviewDue] ?? 9;
    if (da !== db) return da - db;
    const na = a.nextReviewOn ?? '9999-12-31';
    const nb = b.nextReviewOn ?? '9999-12-31';
    if (na !== nb) return na < nb ? -1 : 1;
    return a.supplierName.localeCompare(b.supplierName, 'en', { sensitivity: 'base' });
  });
}

/** A result's words, or the database's own word for one core does not know (never hidden). */
export function supplierRiskResultWords(result: VendorRiskResult | string | null): string {
  if (!result) return '';
  return (VENDOR_RISK_RESULT_WORDS as Record<string, string>)[result] ?? result;
}

/** A hard stop's words, or the database's own word for one core does not know (never hidden). */
export function supplierRiskHardStopWords(stop: string): string {
  return (VENDOR_RISK_HARD_STOP_WORDS as Record<string, string>)[stop] ?? stop;
}

/** The badge tone of a result: never green for anything but Approve. */
export function supplierRiskResultTone(
  result: VendorRiskResult | string | null,
): 'success' | 'warning' | 'destructive' | 'secondary' {
  if (result === 'approve') return 'success';
  if (result === 'do_not_use') return 'destructive';
  if (result === 'approve_with_conditions' || result === 'more_information') return 'warning';
  return 'secondary';
}

/** A day as words, or an em dash for none. */
export function supplierRiskDay(isoDay: string | null | undefined): string {
  return isoDay ? supplierRiskDayWords(isoDay) : '—';
}

/** A moment as its day in words (UTC day of the instant is not used: the browser's own day is). */
export function supplierRiskWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export type SupplierRiskTextProblem = 'too_long' | 'blank' | 'hidden' | null;

/**
 * What is wrong with a text the database will store, in core's text rule
 * (vendorRiskTextOk), so the page can say which field holds it: too long,
 * nothing but spaces, or a hidden character (pasted text often holds one).
 */
export function supplierRiskTextProblem(text: string, max: number): SupplierRiskTextProblem {
  if (vendorRiskTextOk(text, 1, max)) return null;
  if (Array.from(text).length > max) return 'too_long';
  if (text.trim() === '') return 'blank';
  return 'hidden';
}

export function supplierRiskTextProblemWords(
  problem: SupplierRiskTextProblem,
  max: number,
): string | null {
  if (problem === 'too_long') return `At most ${max.toLocaleString('en-US')} characters.`;
  if (problem === 'blank') return 'Write something, or leave it empty.';
  if (problem === 'hidden')
    return 'This holds a hidden character (pasted text often does). Delete it and type the words again.';
  return null;
}
