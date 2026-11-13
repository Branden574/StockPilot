import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest, type QueryResult } from '@/test/supabase-mock';

/**
 * Docket S36 (integrator decision 2026-11-01 on #440): the "your maintenance
 * request was marked resolved" email goes to requester_email_snapshot, which
 * is the filer's OWN address: the 0362 guard fills it from the caller's
 * profile on every insert (caller_profile_name_email), and only a member with
 * maintenance_requests:submit files a request. So it follows the
 * current-member rule of 0422 and createNotification: it goes only while the
 * requester is an accepted member of the request's organization, not an
 * Act-as seat, on an account that is not disabled, the same audience as the
 * in-app notices. The check runs before the one-shot claim, so a skipped send
 * never burns the marker.
 */

const sendEmailMock = vi.hoisted(() => vi.fn(async (_a: { to: string }) => ({ ok: true })));
vi.mock('@/lib/email/resend', () => ({ sendEmail: sendEmailMock }));

const reportErrorMock = vi.hoisted(() => vi.fn(async (_err: unknown, _ctx: unknown) => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError: reportErrorMock }));

import { maybeSendMaintenanceResolvedEmail } from './maintenance-resolved';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = 'org-test';
const APP_URL = 'https://app.example.com';

const RESOLVED_ROW = {
  id: REQUEST_ID,
  organization_id: ORG_ID,
  status: 'resolved',
  resolved_at: '2026-08-06T21:41:00.000Z',
  resolved_by: 'resolver-1',
  resolved_by_name_snapshot: 'Dana Keeler',
  resolution_note: 'The roof tile has been replaced and the leak is fixed.',
  requester_user_id: 'requester-1',
  requester_email_snapshot: 'reggie@example.com',
  requester_name_snapshot: 'Reggie Requester',
  request_number: 123,
  created_at: '2026-01-01T00:00:00.000Z',
  subject: 'Leaking roof tile in Hall B',
  resolution_email_sent_at: null,
};

function membersOf(...userIds: string[]) {
  return servedLikePostgrest(
    userIds.map((user_id) => ({
      organization_id: ORG_ID,
      user_id,
      accepted_at: '2026-01-05T00:00:00Z',
      impersonation_expires_at: null,
    })),
  );
}

function makeStub(membership: QueryResult | ReturnType<typeof servedLikePostgrest>) {
  return makeSupabaseStub({
    'maintenance_requests.select': { data: RESOLVED_ROW, error: null },
    'maintenance_requests.update': { data: { id: REQUEST_ID }, error: null },
    'organizations.select': { data: null, error: null },
    'organization_modules.select': { data: { settings: {} }, error: null },
    'maintenance_request_share_links.select': { data: null, error: null },
    'maintenance_request_attachments.select': { data: null, error: null, count: 0 },
    'user_profiles.select': { data: [{ disabled_at: null }], error: null },
    'organization_members.select': membership,
  });
}

beforeEach(() => vi.clearAllMocks());

describe('maybeSendMaintenanceResolvedEmail: the requester must still be a member (S36)', () => {
  it('a current member: the email goes to their own address (control)', async () => {
    const stub = makeStub(membersOf('resolver-1', 'requester-1'));
    const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, {
      appUrl: APP_URL,
    });
    expect(res).toEqual({ sent: true });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0]![0].to).toBe('reggie@example.com');
  });

  it('a requester removed from the organization, or who left it: nothing claimed, nothing sent', async () => {
    const stub = makeStub(membersOf('resolver-1'));
    const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, {
      appUrl: APP_URL,
    });
    expect(res).toEqual({ sent: false, reason: 'requester_not_member' });
    expect(sendEmailMock).not.toHaveBeenCalled();
    // The one-shot marker is not burned.
    expect(stub.chainArgs.has('maintenance_requests.update')).toBe(false);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('a membership read that fails: nothing claimed, nothing sent, reported once', async () => {
    const stub = makeStub({ data: null, error: { message: 'connection reset' } });
    const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, {
      appUrl: APP_URL,
    });
    expect(res).toEqual({ sent: false, reason: 'error' });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(stub.chainArgs.has('maintenance_requests.update')).toBe(false);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0]![1]).toMatchObject({
      tag: 'maintenance_resolved.email.requester_member_check',
      extra: { requestId: REQUEST_ID, organizationId: ORG_ID, userId: 'requester-1' },
    });
  });
});
