import {
  clockWords,
  resolveOrgTimezone,
  VENDOR_RISK_HARD_STOP_WORDS,
  VENDOR_RISK_RESULT_WORDS,
  vendorRiskTextOk,
  zonedParts,
  zoneShortName,
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

/** The history's events (0481's admin-only record), in words; a newer one keeps the database's word. */
export const SUPPLIER_RISK_EVENT_WORDS: Readonly<Record<string, string>> = {
  draft_discarded: 'Draft discarded',
  review_finished: 'Review finished',
  result_overridden: 'Result set by an admin',
  item_changed: 'Item changed',
  risk_accepted: 'Risk accepted',
};

export function supplierRiskEventWords(event: string): string {
  return Object.prototype.hasOwnProperty.call(SUPPLIER_RISK_EVENT_WORDS, event)
    ? SUPPLIER_RISK_EVENT_WORDS[event]!
    : event;
}

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

/*
 * TIMES on the vendor risk pages are in the ORGANIZATION's zone (its stored
 * organizations.timezone, resolved by core's resolveOrgTimezone), never the
 * server's (UTC on Vercel) or the browser's: a review finished at 5 PM in Los
 * Angeles on the 27th reads the 27th. The words are built from core's
 * zonedParts and clockWords with the zone as an argument, never from the
 * runtime's own zone or its locale strings, so a page rendered on the server
 * and hydrated in a browser in another zone draws the same text (no hydration
 * mismatch). A calendar DAY the database keeps as a date (a due date, the next
 * review, the day a review was finished) is never moved by a zone:
 * supplierRiskDay.
 */

/** The calendar day ('YYYY-MM-DD') an instant falls on in the organization's zone; null for none. */
export function supplierRiskDayOf(
  iso: string | null | undefined,
  timeZone: string | null | undefined,
): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const p = zonedParts(t, resolveOrgTimezone(timeZone));
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** An instant as the day it falls on in the organization's zone ("November 27, 2026"), or an em dash. */
export function supplierRiskWhen(
  iso: string | null | undefined,
  timeZone: string | null | undefined,
): string {
  const day = supplierRiskDayOf(iso, timeZone);
  return day ? supplierRiskDayWords(day) : '—';
}

/** An instant with its clock and zone ("November 27, 2026, 5:30 PM PST"), or an em dash. */
export function supplierRiskMoment(
  iso: string | null | undefined,
  timeZone: string | null | undefined,
): string {
  const day = supplierRiskDayOf(iso, timeZone);
  if (!day || !iso) return '—';
  const t = Date.parse(iso);
  const zone = resolveOrgTimezone(timeZone);
  const p = zonedParts(t, zone);
  return `${supplierRiskDayWords(day)}, ${clockWords(p.hour, p.minute, '12h')} ${zoneShortName(t, zone)}`;
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
