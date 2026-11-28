import {
  VENDOR_RISK_DATA_LEVEL_WORDS,
  VENDOR_RISK_RISK_WORDS,
  VENDOR_RISK_SEVERITY_WORDS,
  type VendorRiskDataLevel,
  type VendorRiskResult,
  type VendorRiskReviewDue,
  type VendorRiskRiskLevel,
  type VendorRiskSeverity,
} from '@stockpilot/core';

import { csvFilename, csvMetaLine, toCsv } from '@/lib/csv';

import { supplierNameAsText } from './reminder-words';
import {
  SUPPLIER_RISK_DUE_REMINDER_NOT_SENT,
  SUPPLIER_RISK_REVIEW_DUE_WORDS,
  SUPPLIER_RISK_SUPPLIER_STATE_WORDS,
  supplierRiskDayOf,
  supplierRiskHardStopWords,
  supplierRiskResultWords,
} from './words';

/**
 * The vendor risk register as CSV, built in the browser from the rows the
 * page already shows (nothing is fetched again). Every cell goes through
 * csvCell (toCsv: the formula guard first, then RFC 4180 quoting): supplier
 * names, the names they were reviewed as and the reviewers' names are typed
 * by people, so a name like =HYPERLINK(...) arrives as text, never as a
 * formula (CONTRACT.md 6.5). No finding, action, answer or reason is in it.
 * "Reviewed on" is the day the review was finished in the organization's zone
 * (`timeZone`), never the UTC day cut from the instant.
 */

export interface SupplierRiskCsvOptions {
  /** The organization's zone (resolved). */
  timeZone: string;
  /**
   * The register was read whole. When it was not (past the pages the server
   * reads), the file's FIRST line says it holds only the first rows.
   */
  complete: boolean;
}

/** The first line of a CSV that does not hold every supplier. */
export function supplierRiskCsvIncompleteLine(shown: number): string {
  return csvMetaLine(
    `This file holds the first ${shown.toLocaleString('en-US')} suppliers only: the register has more than the page could read.`,
  );
}

export interface SupplierRiskCsvRow {
  supplierName: string;
  reviewedAsName: string | null;
  nameChanged: boolean;
  supplierState: 'active' | 'archived' | 'deleted';
  dataLevel: VendorRiskDataLevel | null;
  result: VendorRiskResult | null;
  computedResult: VendorRiskResult | null;
  overridden: boolean;
  residualRisk: VendorRiskRiskLevel | null;
  hardStops: string[];
  openItems: number;
  topOpenSeverity: VendorRiskSeverity | null;
  nextReviewOn: string | null;
  reviewDue: VendorRiskReviewDue;
  dueReminder: 'claimed' | 'sent' | 'not_sent' | null;
  reviewedAt: string | null;
  reviewerName: string | null;
  version: number | null;
}

export const SUPPLIER_RISK_CSV_HEADER = [
  'Supplier',
  'Reviewed as',
  'Supplier state',
  'What they hold',
  'Result',
  'Result the rules gave',
  'Result set by an admin',
  'Risk left',
  'Hard stops',
  'Open items',
  'Most severe open item',
  'Next review',
  'Review due',
  'Due reminder',
  'Reviewed on',
  'Reviewed by',
  'Version',
] as const;

export function supplierRiskRegisterCsv(
  rows: readonly SupplierRiskCsvRow[],
  options: SupplierRiskCsvOptions,
): string {
  const table = toCsv(
    [...SUPPLIER_RISK_CSV_HEADER],
    rows.map((r) => ({
      Supplier: supplierNameAsText(r.supplierName),
      'Reviewed as': r.nameChanged ? supplierNameAsText(r.reviewedAsName) : '',
      'Supplier state': SUPPLIER_RISK_SUPPLIER_STATE_WORDS[r.supplierState],
      'What they hold': r.dataLevel ? VENDOR_RISK_DATA_LEVEL_WORDS[r.dataLevel].label : '',
      Result: r.result ? supplierRiskResultWords(r.result) : 'Not reviewed',
      'Result the rules gave': r.computedResult ? supplierRiskResultWords(r.computedResult) : '',
      'Result set by an admin': r.result ? (r.overridden ? 'Yes' : 'No') : '',
      'Risk left': r.residualRisk ? VENDOR_RISK_RISK_WORDS[r.residualRisk] : '',
      'Hard stops': r.hardStops.map(supplierRiskHardStopWords).join(' | '),
      'Open items': r.result ? r.openItems : '',
      'Most severe open item': r.topOpenSeverity
        ? VENDOR_RISK_SEVERITY_WORDS[r.topOpenSeverity]
        : '',
      'Next review': r.nextReviewOn ?? '',
      'Review due': SUPPLIER_RISK_REVIEW_DUE_WORDS[r.reviewDue],
      'Due reminder': r.dueReminder === 'not_sent' ? SUPPLIER_RISK_DUE_REMINDER_NOT_SENT : '',
      'Reviewed on': supplierRiskDayOf(r.reviewedAt, options.timeZone) ?? '',
      'Reviewed by': r.reviewerName ?? '',
      Version: r.version ?? '',
    })),
  );
  return options.complete ? table : `${supplierRiskCsvIncompleteLine(rows.length)}\n${table}`;
}

export function supplierRiskRegisterCsvFilename(): string {
  return csvFilename('vendor-risk-register');
}
