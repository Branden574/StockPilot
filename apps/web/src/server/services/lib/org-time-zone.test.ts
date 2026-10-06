import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

const { getOrgRowForRequestMock, reportErrorMock } = vi.hoisted(() => ({
  getOrgRowForRequestMock: vi.fn(),
  reportErrorMock: vi.fn(),
}));

vi.mock('@/lib/dashboard/request-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dashboard/request-cache')>()),
  getOrgRowForRequest: getOrgRowForRequestMock,
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: reportErrorMock }));

import { orgTimeZoneFor } from './org-time-zone';

/**
 * The organization's zone for a service that decides a DAY in it (a purchase
 * order is overdue once the organization's date is after its expected day).
 * Never null, never a throw: a failed read is the documented default zone
 * (core resolveOrgTimezone), reported, as the calendar page does.
 */

const TAG = 'test.org_timezone';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('orgTimeZoneFor', () => {
  it("on the request's own cookie session, takes the request-cached org row and reads nothing itself", async () => {
    getOrgRowForRequestMock.mockResolvedValue({ timezone: 'Australia/Sydney' });
    const stub = makeSupabaseStub({});
    const ctx = { ...makeServiceContext(stub.client), cookieClient: stub.client };
    expect(await orgTimeZoneFor(ctx as never, TAG)).toBe('Australia/Sydney');
    expect(getOrgRowForRequestMock).toHaveBeenCalledWith('org-test');
    expect(stub.fromCalls).toEqual([]);
  });

  it('with any other client (a phone Bearer call, a cron), reads organizations.timezone through that client', async () => {
    const stub = makeSupabaseStub({
      'organizations.select': { data: [{ timezone: 'America/Chicago' }], error: null },
    });
    // A cookie client that is NOT the context's client must not lend its cache.
    const other = makeSupabaseStub({}).client;
    const ctx = { ...makeServiceContext(stub.client), cookieClient: other };
    expect(await orgTimeZoneFor(ctx as never, TAG)).toBe('America/Chicago');
    expect(getOrgRowForRequestMock).not.toHaveBeenCalled();
    expect(stub.chainArgs.get('organizations.select')).toEqual([['timezone'], ['id', 'org-test']]);
  });

  it('a failed read is the documented default zone, reported with the caller’s tag', async () => {
    const stub = makeSupabaseStub({
      'organizations.select': { data: null, error: { message: 'permission denied' } },
    });
    expect(await orgTimeZoneFor(makeServiceContext(stub.client) as never, TAG)).toBe(
      'America/Los_Angeles',
    );
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0]![1]).toMatchObject({
      tag: TAG,
      level: 'warning',
      organizationId: 'org-test',
    });

    getOrgRowForRequestMock.mockRejectedValue(new Error('getOrgRowForRequest: timeout'));
    const cookie = makeSupabaseStub({}).client;
    expect(
      await orgTimeZoneFor({ ...makeServiceContext(cookie), cookieClient: cookie } as never, TAG),
    ).toBe('America/Los_Angeles');
    expect(reportErrorMock).toHaveBeenCalledTimes(2);
  });

  it('a missing row, an empty zone or one this runtime does not know is the default zone, not an error', async () => {
    for (const data of [[], [{ timezone: null }], [{ timezone: '' }], [{ timezone: 'Mars/Olympus_Mons' }]]) {
      const stub = makeSupabaseStub({ 'organizations.select': { data, error: null } });
      expect(await orgTimeZoneFor(makeServiceContext(stub.client) as never, TAG), JSON.stringify(data)).toBe(
        'America/Los_Angeles',
      );
    }
    expect(reportErrorMock).not.toHaveBeenCalled();
  });
});
