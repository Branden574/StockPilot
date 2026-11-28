// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  VENDOR_RISK_ANSWER_DATE_MAX,
  vendorRiskQuestion,
  type VendorRiskQuestion,
} from '@stockpilot/core';

import {
  supplierRiskDateIssue,
  supplierRiskDateIssueBlocks,
  supplierRiskDateIssueWords,
  supplierRiskLatestEvidenceDay,
} from './dates';
import {
  SUPPLIER_RISK_CSV_HEADER,
  supplierRiskRegisterCsv,
  type SupplierRiskCsvRow,
} from './register-csv';
import {
  SUPPLIER_RISK_NOTICE_NAME_MAX,
  supplierNameForNotice,
  supplierRiskReminderWords,
} from './reminder-words';
import { sortSupplierRiskRegister, supplierRiskTextProblem } from './words';

/**
 * Security invariant: the vendor risk pages' pure helpers.
 *   - The register CSV: every cell through the formula guard, so a name a
 *     person typed (=HYPERLINK(...), +, -, @) arrives as text; no finding,
 *     action, answer or reason is a column.
 *   - The reminder notice: a supplier's name is plain text in the body only
 *     (never the title), hidden characters and breaks out, cut to 120.
 *   - The evidence dates (REVIEW-0481 round 3, follow-up 2): a judged date
 *     later than tomorrow in UTC is "in the future" and blocks a save; one
 *     more than 12 months before the organization's today is said plainly
 *     to count as Not shown; the data agreement's date after today is only a
 *     warning; a Yes without its date blocks a finish, not a draft.
 *   - The register's order: active first, overdue first.
 */

function csvRow(over: Partial<SupplierRiskCsvRow> = {}): SupplierRiskCsvRow {
  return {
    supplierName: 'Example Supply Co',
    reviewedAsName: null,
    nameChanged: false,
    supplierState: 'active',
    dataLevel: 'staff',
    result: 'approve',
    computedResult: 'approve',
    overridden: false,
    residualRisk: 'low',
    hardStops: [],
    openItems: 0,
    topOpenSeverity: null,
    nextReviewOn: '2027-11-27',
    reviewDue: 'scheduled',
    dueReminder: null,
    reviewedAt: '2026-11-27T10:00:00Z',
    reviewerName: 'Avery Example',
    version: 1,
    ...over,
  };
}

/** The cells of a CSV the guard wrote (no cell here holds a comma or a quote unless quoted). */
function cells(csv: string): string[][] {
  return csv.split('\n').map((line) => {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') {
        out.push(cur);
        cur = '';
      } else cur += c;
    }
    out.push(cur);
    return out;
  });
}

describe('the register CSV', () => {
  it('direction marks and other invisible characters leave a name, as on the page', () => {
    const csv = supplierRiskRegisterCsv(
      [
        csvRow({
          supplierName: 'Example\u202E Supplies\u200B',
          reviewedAsName: 'Old\u2066 Name',
          nameChanged: true,
        }),
      ],
      { timeZone: 'UTC', complete: true },
    );
    const row = cells(csv)[1];
    expect(row?.[0]).toBe('Example Supplies');
    expect(row?.[1]).toBe('Old Name');
    expect(csv).not.toMatch(/[\u202E\u200B\u2066]/);
  });

  it('a formula in a typed name arrives as text', () => {
    const csv = supplierRiskRegisterCsv(
      [
        csvRow({ supplierName: '=HYPERLINK("https://example.test","Open")' }),
        csvRow({
          supplierName: '+1 Supplies',
          reviewerName: '@Avery',
          reviewedAsName: '-Old Name',
          nameChanged: true,
        }),
      ],
      { timeZone: 'UTC', complete: true },
    );
    const [header, a, b] = cells(csv);
    expect(header).toEqual([...SUPPLIER_RISK_CSV_HEADER]);
    expect(a?.[0]).toBe('\'=HYPERLINK("https://example.test","Open")');
    expect(b?.[0]).toBe("'+1 Supplies");
    expect(b?.[1]).toBe("'-Old Name");
    expect(b?.[15]).toBe("'@Avery");
    for (const row of cells(csv)) {
      for (const cell of row) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
    }
  });

  it('carries no finding, action, answer or reason: only the register columns', () => {
    expect(SUPPLIER_RISK_CSV_HEADER.join(' ')).not.toMatch(/finding|action|answer|reason|note/i);
  });

  it('a supplier never reviewed says so, and "Reviewed as" only when the name changed', () => {
    const [, row] = cells(
      supplierRiskRegisterCsv(
        [
          csvRow({
            result: null,
            computedResult: null,
            reviewDue: 'not_reviewed',
            reviewedAsName: 'Old Co',
          }),
        ],
        { timeZone: 'UTC', complete: true },
      ),
    );
    expect(row?.[4]).toBe('Not reviewed');
    expect(row?.[1]).toBe('');
  });

  it('"Reviewed on" is the day in the organization zone, never the UTC day cut from the instant (S3)', () => {
    const [, tokyo] = cells(
      supplierRiskRegisterCsv([csvRow({ reviewedAt: '2026-11-27T16:30:00Z' })], {
        timeZone: 'Asia/Tokyo',
        complete: true,
      }),
    );
    expect(tokyo?.[14]).toBe('2026-11-28');
    const [, pacific] = cells(
      supplierRiskRegisterCsv([csvRow({ reviewedAt: '2026-11-28T03:00:00Z' })], {
        timeZone: 'America/Los_Angeles',
        complete: true,
      }),
    );
    expect(pacific?.[14]).toBe('2026-11-27');
  });
});

describe('a register cut at what the page could read (S7)', () => {
  it('the CSV says so on its first line, then the header', () => {
    const csv = supplierRiskRegisterCsv([csvRow(), csvRow()], {
      timeZone: 'UTC',
      complete: false,
    });
    const [first, header] = csv.split('\n');
    expect(first).toBe(
      '"# This file holds the first 2 suppliers only: the register has more than the page could read."',
    );
    expect(header).toBe(SUPPLIER_RISK_CSV_HEADER.join(','));
  });

  it('a complete register: the header is the first line', () => {
    const csv = supplierRiskRegisterCsv([csvRow()], { timeZone: 'UTC', complete: true });
    expect(csv.split('\n')[0]).toBe(SUPPLIER_RISK_CSV_HEADER.join(','));
  });
});

describe('the reminder notice', () => {
  it("the supplier's name is plain text in the body, never the title", () => {
    const w = supplierRiskReminderWords({
      kind: 'due',
      supplierName: 'Example Supply Co',
      nextReviewOn: '2026-11-20',
      orgToday: '2026-11-27',
    });
    expect(w.title).toBe('Vendor review overdue');
    expect(w.body).toBe(
      'The vendor review of Example Supply Co is overdue: it was due on November 20, 2026. Open the risk register to review it.',
    );
  });

  it('hidden characters, breaks and runs of spaces are taken out of the name', () => {
    expect(supplierNameForNotice('Example\u200b Supply\u202e\n\nCo\u2028  Ltd')).toBe(
      'Example Supply Co Ltd',
    );
    expect(supplierNameForNotice('\u200b\u200d')).toBe('a supplier');
    expect(supplierNameForNotice(null)).toBe('a supplier');
  });

  it(`a long name is cut to ${SUPPLIER_RISK_NOTICE_NAME_MAX} characters`, () => {
    expect(Array.from(supplierNameForNotice('x'.repeat(500)))).toHaveLength(
      SUPPLIER_RISK_NOTICE_NAME_MAX,
    );
  });
});

describe('the evidence dates: the UTC day and the organization day', () => {
  const report = vendorRiskQuestion('security_report') as VendorRiskQuestion;
  const agreement = vendorRiskQuestion('data_agreement') as VendorRiskQuestion;
  const days = { orgToday: '2026-11-27', utcToday: '2026-11-28' };

  it('the latest a judged date input allows is tomorrow in UTC', () => {
    expect(supplierRiskLatestEvidenceDay('2026-12-31')).toBe('2027-01-01');
  });

  it('a judged date later than tomorrow in UTC is in the future, and blocks a save', () => {
    const issue = supplierRiskDateIssue(report, { answer: 'yes', date: '2026-11-30' }, days);
    expect(issue).toBe('future');
    expect(supplierRiskDateIssueWords(issue)).toBe(
      'This date is in the future. Give the date printed on the document.',
    );
    expect(supplierRiskDateIssueBlocks(issue, false)).toBe(true);
    // Tomorrow in UTC is allowed (the database allows one day).
    expect(supplierRiskDateIssue(report, { answer: 'yes', date: '2026-11-29' }, days)).toBeNull();
  });

  it('a Yes dated more than 12 months before today is said to count as Not shown (out of date)', () => {
    const issue = supplierRiskDateIssue(report, { answer: 'yes', date: '2025-11-26' }, days);
    expect(issue).toBe('out_of_date');
    expect(supplierRiskDateIssueWords(issue)).toMatch(/more than 12 months before today/);
    expect(supplierRiskDateIssueBlocks(issue, true)).toBe(false);
    expect(supplierRiskDateIssue(report, { answer: 'yes', date: '2025-11-27' }, days)).toBeNull();
  });

  it('a Yes without its date blocks a finish and not a draft', () => {
    const issue = supplierRiskDateIssue(report, { answer: 'yes', date: '' }, days);
    expect(issue).toBe('missing');
    expect(supplierRiskDateIssueBlocks(issue, false)).toBe(false);
    expect(supplierRiskDateIssueBlocks(issue, true)).toBe(true);
    expect(supplierRiskDateIssue(report, { answer: 'no', date: '' }, days)).toBeNull();
  });

  it("the data agreement's date after today is a warning only", () => {
    const issue = supplierRiskDateIssue(agreement, { answer: 'yes', date: '2026-12-01' }, days);
    expect(issue).toBe('after_today');
    expect(supplierRiskDateIssueBlocks(issue, true)).toBe(false);
  });

  it('a date outside what the database keeps is refused', () => {
    expect(supplierRiskDateIssue(agreement, { answer: 'yes', date: '1999-12-31' }, days)).toBe(
      'bad',
    );
    expect(VENDOR_RISK_ANSWER_DATE_MAX > '2100').toBe(true);
  });
});

describe('the register order and the text rule', () => {
  it('active first, then overdue, due today, due soon, never reviewed, scheduled', () => {
    const row = (
      supplierName: string,
      reviewDue: string,
      supplierState = 'active',
      nextReviewOn: string | null = null,
    ) =>
      ({ supplierName, reviewDue, supplierState, nextReviewOn }) as Parameters<
        typeof sortSupplierRiskRegister
      >[0][number];
    const sorted = sortSupplierRiskRegister([
      row('E', 'scheduled', 'active', '2027-01-01'),
      row('A', 'overdue', 'archived', '2026-01-01'),
      row('D', 'not_reviewed'),
      row('B', 'overdue', 'active', '2026-10-01'),
      row('C', 'due_soon', 'active', '2026-12-01'),
    ]);
    expect(sorted.map((r) => r.supplierName)).toEqual(['B', 'C', 'D', 'E', 'A']);
  });

  it('says which part of a text the database would refuse', () => {
    expect(supplierRiskTextProblem('Seen in the contract', 100)).toBeNull();
    expect(supplierRiskTextProblem('   ', 100)).toBe('blank');
    expect(supplierRiskTextProblem('x'.repeat(101), 100)).toBe('too_long');
    expect(supplierRiskTextProblem('Seen\u200b', 100)).toBe('hidden');
  });
});
