// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The security events of a sign-in alert (part 3): a sign-in from a new
 * country, and a member's "this was not me". Each is phishing / flagged, in
 * every organization the account really belongs to (an accepted membership
 * that is not a support act-as seat, at most 5), found on the server from the
 * account id, never from a request. The place is the sign-in's (the alert's),
 * not the reader's, and no address is hashed. Never throws.
 */

const h = vi.hoisted(() => ({
  members: { data: [] as unknown[] | null, error: null as unknown },
  calls: [] as Array<[string, ...unknown[]]>,
  throwOnFrom: false,
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (h.throwOnFrom) throw new Error('down');
      h.calls.push(['from', table]);
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'not', 'limit', 'order']) {
        chain[m] = (...args: unknown[]) => {
          h.calls.push([m, ...args]);
          return chain;
        };
      }
      chain.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve({ data: h.members.data, error: h.members.error }).then(ok, bad);
      return chain;
    },
  }),
}));
const reportError = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import { recordSecurityEvent } from '@/server/security/events';
import { clientPlaceFromHeaders, clientSourceHash } from '@/lib/client-ip';

import { recordSignInAlertEvent, recordSignInAlertsHeldEvent } from './sign-in-alert-events';

const USER = '11111111-1111-4111-8111-111111111111';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const recorded = vi.mocked(recordSecurityEvent);

beforeEach(() => {
  h.members = { data: [], error: null };
  h.calls = [];
  h.throwOnFrom = false;
  recorded.mockClear();
  reportError.mockClear();
  vi.stubEnv('VERCEL', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('recordSignInAlertEvent', () => {
  it('a new country: phishing / flagged / sign_in_new_country in each organization of the account', async () => {
    h.members.data = [{ organization_id: ORG_A }, { organization_id: ORG_B }];
    await recordSignInAlertEvent({
      reason: 'sign_in_new_country',
      userId: USER,
      source: 'phone',
      place: { country: 'MX', city: 'Tijuana' },
    });
    expect(recorded).toHaveBeenCalledTimes(2);
    expect(recorded.mock.calls.map((c) => c[0])).toEqual([
      { category: 'phishing', outcome: 'flagged', reason: 'sign_in_new_country', source: 'phone', organizationId: ORG_A },
      { category: 'phishing', outcome: 'flagged', reason: 'sign_in_new_country', source: 'phone', organizationId: ORG_B },
    ]);
  });

  it('the organizations are the account’s real memberships, read on the server: accepted, not act-as, at most 5', async () => {
    h.members.data = [{ organization_id: ORG_A }];
    await recordSignInAlertEvent({
      reason: 'sign_in_not_me',
      userId: USER,
      source: 'web',
      place: { country: null, city: null },
    });
    expect(h.calls).toEqual([
      ['from', 'organization_members'],
      ['select', 'organization_id'],
      ['eq', 'user_id', USER],
      ['not', 'accepted_at', 'is', null],
      ['is', 'impersonation_expires_at', null],
      ['limit', 5],
    ]);
  });

  it('the place handed to the recorder is the sign-in’s, and it names no address (so no source hash)', async () => {
    h.members.data = [{ organization_id: ORG_A }];
    await recordSignInAlertEvent({
      reason: 'sign_in_not_me',
      userId: USER,
      source: 'web',
      place: { country: 'BR', city: 'São Paulo' },
    });
    const headers = recorded.mock.calls[0]![1]!;
    expect(clientPlaceFromHeaders(headers)).toEqual({ country: 'BR', city: 'São Paulo' });
    expect(clientSourceHash(headers)).toBeNull();
    expect(headers.get('x-forwarded-for')).toBeNull();
    expect(headers.get('x-real-ip')).toBeNull();
  });

  it('a city the tables would refuse is not handed on; the country is', async () => {
    h.members.data = [{ organization_id: ORG_A }];
    await recordSignInAlertEvent({
      reason: 'sign_in_new_country',
      userId: USER,
      source: 'web',
      place: { country: 'US', city: 'Springfield (East)' },
    });
    expect(clientPlaceFromHeaders(recorded.mock.calls[0]![1]!)).toEqual({ country: 'US', city: null });
  });

  it('an account in no organization: one event with no organization', async () => {
    await recordSignInAlertEvent({
      reason: 'sign_in_new_country',
      userId: USER,
      source: 'web',
      place: { country: 'MX', city: null },
    });
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(recorded.mock.calls[0]![0]).toEqual({
      category: 'phishing',
      outcome: 'flagged',
      reason: 'sign_in_new_country',
      source: 'web',
      organizationId: null,
    });
  });

  it('a membership read that fails: one event with no organization, and the failure is reported with its code only', async () => {
    h.members = { data: null, error: { code: '57014', message: 'timeout for user 1111' } };
    await recordSignInAlertEvent({
      reason: 'sign_in_not_me',
      userId: USER,
      source: 'web',
      place: { country: null, city: null },
    });
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(recorded.mock.calls[0]![0]).toMatchObject({ organizationId: null });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toEqual({
      tag: 'security.sign_in_alert_event_organizations',
      level: 'warning',
      extra: { code: '57014' },
    });
    expect(JSON.stringify(reportError.mock.calls)).not.toContain(USER);
  });

  it('never throws, even when the client cannot be made', async () => {
    h.throwOnFrom = true;
    await expect(
      recordSignInAlertEvent({
        reason: 'sign_in_not_me',
        userId: USER,
        source: 'web',
        place: { country: null, city: null },
      }),
    ).resolves.toBeUndefined();
  });

  it('off Vercel the place headers name nothing, as every other place there', async () => {
    vi.stubEnv('VERCEL', '');
    h.members.data = [{ organization_id: ORG_A }];
    await recordSignInAlertEvent({
      reason: 'sign_in_new_country',
      userId: USER,
      source: 'web',
      place: { country: 'MX', city: 'Tijuana' },
    });
    expect(clientPlaceFromHeaders(recorded.mock.calls[0]![1]!)).toEqual({ country: null, city: null });
  });
});

describe('recordSignInAlertsHeldEvent: a sign-in turned away by the daily ceiling on alert rows', () => {
  it('password_guessing / flagged / sign_in_alerts_held in each organization of the account', async () => {
    h.members.data = [{ organization_id: ORG_A }, { organization_id: ORG_B }];
    await recordSignInAlertsHeldEvent({
      userId: USER,
      source: 'phone',
      place: { country: 'MX', city: 'Tijuana' },
    });
    expect(recorded.mock.calls.map((c) => c[0])).toEqual([
      { category: 'password_guessing', outcome: 'flagged', reason: 'sign_in_alerts_held', source: 'phone', organizationId: ORG_A },
      { category: 'password_guessing', outcome: 'flagged', reason: 'sign_in_alerts_held', source: 'phone', organizationId: ORG_B },
    ]);
  });

  it('the organizations are read the same way: the account’s own, accepted, not act-as, at most 5', async () => {
    h.members.data = Array.from({ length: 9 }, (_, i) => ({
      organization_id: `0000000${i}-0000-4000-8000-000000000000`,
    }));
    await recordSignInAlertsHeldEvent({ userId: USER, source: 'web', place: { country: null, city: null } });
    expect(recorded).toHaveBeenCalledTimes(5);
    expect(h.calls).toContainEqual(['from', 'organization_members']);
    expect(h.calls).toContainEqual(['eq', 'user_id', USER]);
    expect(h.calls).toContainEqual(['not', 'accepted_at', 'is', null]);
    expect(h.calls).toContainEqual(['is', 'impersonation_expires_at', null]);
    expect(h.calls).toContainEqual(['limit', 5]);
  });

  it('an account in no organization, or whose memberships cannot be read: one event with no organization', async () => {
    await recordSignInAlertsHeldEvent({ userId: USER, source: 'web', place: { country: 'MX', city: null } });
    h.members = { data: null, error: { code: '57014', message: 'timeout' } };
    await recordSignInAlertsHeldEvent({ userId: USER, source: 'web', place: { country: 'MX', city: null } });
    expect(recorded.mock.calls.map((c) => c[0].organizationId)).toEqual([null, null]);
  });

  it('carries the sign-in’s place and no address', async () => {
    await recordSignInAlertsHeldEvent({ userId: USER, source: 'web', place: { country: 'MX', city: 'Tijuana' } });
    const headers = recorded.mock.calls[0]![1]!;
    expect(clientPlaceFromHeaders(headers)).toEqual({ country: 'MX', city: 'Tijuana' });
    expect(clientSourceHash(headers)).toBeNull();
  });

  it('never throws', async () => {
    h.throwOnFrom = true;
    await expect(
      recordSignInAlertsHeldEvent({ userId: USER, source: 'web', place: { country: 'MX', city: null } }),
    ).resolves.toBeUndefined();
  });
});
