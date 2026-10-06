import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * "Send preview now" (notification settings): the preview must flag a purchase
 * order overdue by the same rule as the Monday email, in the organization's
 * zone (services/digest.ts, core isPastExpectedDay). On main the read took no
 * zone and compared the stored midnight with the server's clock, so a preview
 * sent on the evening before a purchase order's expected day in Los Angeles
 * (or on the day itself in Sydney) flagged it overdue.
 */

const { getDigestDataMock, getCachedOrgTimezoneMock, renderMock, sendEmailMock, supabaseHolder } =
  vi.hoisted(() => ({
    getDigestDataMock: vi.fn(),
    getCachedOrgTimezoneMock: vi.fn(),
    renderMock: vi.fn(() => '<html>preview</html>'),
    sendEmailMock: vi.fn(async () => ({ ok: true })),
    supabaseHolder: { client: null as unknown },
  }));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    organizationName: 'Harbour',
    userId: 'user-1',
    email: 'me@harbour.test',
    fullName: 'Mel',
    role: 'owner',
  })),
}));
vi.mock('@/lib/dashboard/cached-org', () => ({ getCachedOrgTimezone: getCachedOrgTimezoneMock }));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: 'https://stockpilotusa.com' } }));
vi.mock('@/lib/email/es/families/digest', () => ({
  DIGEST_FROM: 'StockPilot <digest@stockpilotusa.com>',
  renderWeeklyDigestHtml: renderMock,
  weeklyDigestPreviewSubject: vi.fn(() => '[Preview] StockPilot weekly digest'),
  weeklyDigestText: vi.fn(() => 'digest text'),
}));
vi.mock('@/lib/email/resend', () => ({ sendEmail: sendEmailMock }));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => supabaseHolder.client) }));
vi.mock('@/server/services/digest', () => ({
  applySectionOptIns: vi.fn((payload: unknown) => payload),
  getDigestData: getDigestDataMock,
}));

import { sendDigestPreviewAction } from './digest';

const EMPTY = {
  lowStock: [],
  lowStockTotal: 0,
  outOfStockTotal: 0,
  openPos: [],
  openPosTotal: 0,
  overduePosTotal: 0,
  openCycleCounts: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  supabaseHolder.client = makeSupabaseStub({
    'user_profiles.select': {
      data: [
        {
          digest_section_low_stock: true,
          digest_section_open_pos: true,
          digest_section_cycle_counts: true,
        },
      ],
      error: null,
    },
  }).client;
  getDigestDataMock.mockResolvedValue(EMPTY);
  getCachedOrgTimezoneMock.mockResolvedValue('Australia/Sydney');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sendDigestPreviewAction', () => {
  it("reads the preview's purchase orders in the organization's zone, as of now", async () => {
    vi.setSystemTime(new Date('2026-10-13T08:00:00.000Z')); // Tue Oct 13, 7 PM in Sydney
    const res = await sendDigestPreviewAction();
    expect(res.ok).toBe(true);
    expect(getCachedOrgTimezoneMock).toHaveBeenCalledWith('org-1');
    expect(getDigestDataMock).toHaveBeenCalledTimes(1);
    const [client, orgId, clock] = getDigestDataMock.mock.calls[0]! as [
      unknown,
      string,
      { timeZone: string; now: Date },
    ];
    expect(client).toBe(supabaseHolder.client);
    expect(orgId).toBe('org-1');
    expect(clock.timeZone).toBe('Australia/Sydney');
    expect(clock.now.toISOString()).toBe('2026-10-13T08:00:00.000Z');
    // The footer's send time is stated in the same zone.
    expect(renderMock).toHaveBeenCalledWith(
      EMPTY,
      expect.objectContaining({ timeZone: 'Australia/Sydney', preview: true }),
    );
  });
});
