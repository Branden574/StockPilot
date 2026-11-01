import { describe, expect, it } from 'vitest';

import type { DigestPayload } from '@/server/services/digest';

import {
  digestAsOfLabel,
  renderWeeklyDigestHtml,
  weeklyDigestPreviewSubject,
  weeklyDigestSubject,
  weeklyDigestText,
} from './digest';

/**
 * The weekly digest's dates in the ORGANIZATION's zone (small fixes slice 8,
 * item G; found by #335). The subject's dateline, the "As of" pill, the plain
 * text's dateline and a cycle count's "started" day were formatted with no
 * zone, so in the server's: UTC on Vercel. The cron runs Mondays at 14:00
 * UTC, which is already Tuesday from UTC+10 east (Sydney in daylight time:
 * 1 AM Tuesday), so such an organization got Monday's date on Tuesday's
 * digest; and a preview sent after 5 PM in Los Angeles (now 01:00 UTC the
 * next day) carried tomorrow's date.
 */

const SYDNEY = 'Australia/Sydney';
const LA = 'America/Los_Angeles';
// The cron's run: Monday Oct 12, 2026, 14:00 UTC = Tuesday Oct 13, 1:00 AM in Sydney.
const RUN = new Date('2026-10-12T14:00:00.000Z');
// A preview at 6 PM on Monday Oct 12 in Los Angeles = 01:00 UTC on Tuesday.
const EVENING_PREVIEW = new Date('2026-10-13T01:00:00.000Z');

function payload(startedAt: string): DigestPayload {
  return {
    lowStock: [],
    lowStockTotal: 0,
    outOfStockTotal: 0,
    openPos: [],
    openPosTotal: 0,
    overduePosTotal: 0,
    openCycleCounts: [
      {
        id: 'cc-1',
        countNumber: 42,
        scopeLabel: 'Main Warehouse',
        warehouseName: 'Main Warehouse',
        startedAt,
        totalLines: 10,
        countedLines: 4,
      },
    ],
  };
}

const OPTS = {
  orgName: 'Harbour',
  appUrl: 'https://stockpilotusa.com',
  settingsUrl: 'https://stockpilotusa.com/s',
};

describe("the digest's dates are the organization's", () => {
  it("the subject: Tuesday in Sydney, not UTC's Monday", () => {
    expect(weeklyDigestSubject(RUN, SYDNEY)).toContain('Tuesday, October 13, 2026');
    expect(weeklyDigestSubject(RUN, LA)).toContain('Monday, October 12, 2026');
  });

  it("a preview sent at 6 PM in Los Angeles carries that day, not UTC's tomorrow", () => {
    expect(weeklyDigestPreviewSubject(EVENING_PREVIEW, LA)).toContain('Monday, October 12, 2026');
    expect(weeklyDigestPreviewSubject(EVENING_PREVIEW, SYDNEY)).toContain(
      'Tuesday, October 13, 2026',
    );
  });

  it('the "As of" pill', () => {
    expect(digestAsOfLabel(RUN, SYDNEY)).toBe('As of Oct 13');
    expect(digestAsOfLabel(EVENING_PREVIEW, LA)).toBe('As of Oct 12');
  });

  it('the email: its title, pill and a cycle count started at 1:30 AM Monday in Sydney (Sunday in UTC)', () => {
    const html = renderWeeklyDigestHtml(payload('2026-10-11T14:30:00.000Z'), {
      ...OPTS,
      now: RUN,
      timeZone: SYDNEY,
    });
    expect(html).toContain('Tuesday, October 13, 2026');
    expect(html).toContain('As of Oct 13');
    expect(html).toContain('started Oct 12');
    expect(html).not.toContain('started Oct 11');
    expect(html).not.toContain('As of Oct 12');
  });

  it("the plain text: its dateline and the started day, at the run's moment", () => {
    const text = weeklyDigestText(payload('2026-10-11T14:30:00.000Z'), {
      ...OPTS,
      now: RUN,
      timeZone: SYDNEY,
    });
    expect(text).toContain('Harbour · Tuesday, October 13, 2026');
    expect(text).toContain('10/12/2026');
    expect(text).not.toContain('10/11/2026');
  });

  it("a missing zone is the documented default (Los Angeles), not the server's", () => {
    expect(weeklyDigestSubject(EVENING_PREVIEW, null)).toContain('Monday, October 12, 2026');
    expect(digestAsOfLabel(EVENING_PREVIEW, undefined)).toBe('As of Oct 12');
  });
});
