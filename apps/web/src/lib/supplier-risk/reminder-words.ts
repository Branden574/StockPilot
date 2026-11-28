import { parseVendorRiskDate, VENDOR_RISK_HIDDEN_CHARACTERS } from '@stockpilot/core';

/**
 * The words of the daily vendor review reminder (app/api/cron/supplier-risk-reminders),
 * an in-app notice (and its push) to an organization's owners and admins.
 *
 * The supplier's name is text a manager typed, so it is never the title: the
 * title is fixed words, and the body carries the name as plain text, its
 * hidden characters taken out (core's VENDOR_RISK_HIDDEN_CHARACTERS and every
 * other control or format character), its line breaks and runs of spaces one
 * space, cut to SUPPLIER_RISK_NOTICE_NAME_MAX characters. Never a finding, an
 * answer or a reason (CONTRACT.md 7.3).
 */

/** Where every reminder opens: the risk register (the phone maps it to its Suppliers screen). */
export const SUPPLIER_RISK_REMINDER_LINK = '/dashboard/suppliers/risk';
export const SUPPLIER_RISK_REMINDER_TYPE = 'supplier_risk.review_due';
/** The most characters of a supplier's name a notice carries. */
export const SUPPLIER_RISK_NOTICE_NAME_MAX = 120;

function charClass(ranges: readonly (readonly [number, number])[]): string {
  const u = (cp: number) => `\\u{${cp.toString(16).toUpperCase()}}`;
  return ranges.map(([lo, hi]) => (lo === hi ? u(lo) : `${u(lo)}-${u(hi)}`)).join('');
}

// A line break, a tab and their kind: where one stood, one space stands.
const BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/gu;
// core's hidden characters, and every other control, format, private-use or
// half-of-a-pair character.
const UNSEEN = new RegExp(
  `[${charClass(VENDOR_RISK_HIDDEN_CHARACTERS)}\\p{Cc}\\p{Cf}\\p{Co}\\p{Cs}]`,
  'gu',
);

/**
 * A supplier's name as a SENTENCE carries it (a notice's body, the questions
 * to copy for the vendor, a link's label): line breaks and runs of spaces one
 * space, core's hidden characters and every other control, format and
 * direction character out, cut to SUPPLIER_RISK_NOTICE_NAME_MAX characters.
 * '' when nothing is left. On screen, a name stands as typed inside <bdi>.
 */
export function supplierNameAsText(name: string | null | undefined): string {
  if (typeof name !== 'string') return '';
  const clean = name.replace(BREAKS, ' ').replace(UNSEEN, '').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(clean);
  if (chars.length <= SUPPLIER_RISK_NOTICE_NAME_MAX) return clean;
  return chars.slice(0, SUPPLIER_RISK_NOTICE_NAME_MAX).join('').trimEnd();
}

/** A supplier's name as a notice's body carries it; 'a supplier' when nothing is left. */
export function supplierNameForNotice(name: string | null | undefined): string {
  return supplierNameAsText(name) || 'a supplier';
}

/** 'YYYY-MM-DD' as "December 24, 2026" (the day itself, never shifted by a zone). */
export function supplierRiskDayWords(isoDay: string): string {
  const p = parseVendorRiskDate(isoDay);
  if (!p) return isoDay;
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export interface SupplierRiskReminderWords {
  title: string;
  body: string;
}

/**
 * The notice for one review. `kind` 'due_soon': 1 to 30 days away; 'due': the
 * day itself or past (overdue when the next review date is before the
 * organization's today).
 */
export function supplierRiskReminderWords(args: {
  kind: 'due' | 'due_soon';
  supplierName: string | null | undefined;
  nextReviewOn: string;
  orgToday: string;
}): SupplierRiskReminderWords {
  const name = supplierNameForNotice(args.supplierName);
  const on = supplierRiskDayWords(args.nextReviewOn);
  const open = 'Open the risk register to review it.';
  if (args.kind === 'due_soon') {
    return {
      title: 'Vendor review due soon',
      body: `The vendor review of ${name} is due on ${on}. ${open}`,
    };
  }
  if (args.nextReviewOn < args.orgToday) {
    return {
      title: 'Vendor review overdue',
      body: `The vendor review of ${name} is overdue: it was due on ${on}. ${open}`,
    };
  }
  return {
    title: 'Vendor review due',
    body: `The vendor review of ${name} is due today. ${open}`,
  };
}
