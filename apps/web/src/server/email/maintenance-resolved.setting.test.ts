import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest, type QueryResult } from '@/test/supabase-mock';

/**
 * The resolution email embeds proof photos through the request's share link
 * only while the organization's includeShareLinksInEmail setting is on. A row
 * or key that was never written means ON; a key set to false means OFF; a
 * settings read that returns an error means OFF and is reported. With the
 * setting off the email still goes, with the photo count and no link.
 */

const sendEmailMock = vi.hoisted(() =>
  vi.fn(async (_a: { to: string; html: string; text: string }) => ({ ok: true })),
);
vi.mock('@/lib/email/resend', () => ({ sendEmail: sendEmailMock }));

const reportErrorMock = vi.hoisted(() => vi.fn(async (_err: unknown, _ctx: unknown) => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError: reportErrorMock }));

const SHARE_TOKEN = 'tok-example-0001';
const listProofMock = vi.hoisted(() =>
  vi.fn(async (_admin: unknown, _org: string, _req: string, token: string | null) =>
    token ? { token, entries: [{ index: 0, filename: 'after.jpg' }] } : null,
  ),
);
vi.mock('@/server/services/maintenance-share-links', () => ({
  listResolutionProofProxyPhotos: listProofMock,
}));

import { maybeSendMaintenanceResolvedEmail } from './maintenance-resolved';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = 'org-example';
const APP_URL = 'https://app.example.com';
const PHOTO_URL = `${APP_URL}/m/${SHARE_TOKEN}/photo/0`;

const RESOLVED_ROW = {
  id: REQUEST_ID,
  organization_id: ORG_ID,
  status: 'resolved',
  resolved_at: '2026-08-06T21:41:00.000Z',
  resolved_by: 'resolver-1',
  resolved_by_name_snapshot: 'Dana Keeler',
  resolution_note: 'The hallway light fixture was replaced.',
  requester_user_id: 'requester-1',
  requester_email_snapshot: 'reggie@example.com',
  requester_name_snapshot: 'Reggie Requester',
  request_number: 123,
  created_at: '2026-01-01T00:00:00.000Z',
  subject: 'Hallway light out',
  resolution_email_sent_at: null,
};

function makeStub(settingsRead: QueryResult) {
  return makeSupabaseStub({
    'maintenance_requests.select': { data: RESOLVED_ROW, error: null },
    'maintenance_requests.update': { data: { id: REQUEST_ID }, error: null },
    'organizations.select': { data: null, error: null },
    'organization_modules.select': settingsRead,
    'maintenance_request_attachments.select': { data: null, error: null, count: 1 },
    'user_profiles.select': { data: [{ disabled_at: null }], error: null },
    'organization_members.select': servedLikePostgrest([
      {
        organization_id: ORG_ID,
        user_id: 'requester-1',
        accepted_at: '2026-01-05T00:00:00Z',
        impersonation_expires_at: null,
      },
    ]),
  });
}

async function send(settingsRead: QueryResult) {
  const stub = makeStub(settingsRead);
  const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, {
    appUrl: APP_URL,
    shareToken: SHARE_TOKEN,
  });
  return { res, stub };
}

function sentEmail() {
  expect(sendEmailMock).toHaveBeenCalledTimes(1);
  return sendEmailMock.mock.calls[0]![0];
}

beforeEach(() => vi.clearAllMocks());

describe('maybeSendMaintenanceResolvedEmail: the share-link setting', () => {
  it('a settings read that returns an error: the email goes without the link, and the read is reported once without the settings', async () => {
    const { res } = await send({ data: null, error: { message: 'connection reset', code: '08006' } });
    expect(res).toEqual({ sent: true });
    const email = sentEmail();
    expect(email.html).not.toContain(`/m/${SHARE_TOKEN}`);
    expect(email.text).not.toContain(`/m/${SHARE_TOKEN}`);
    expect(listProofMock).not.toHaveBeenCalled();
    const reports = reportErrorMock.mock.calls.filter(
      ([, c]) => (c as { tag?: string }).tag === 'maintenance_resolved.email.share_links_setting_read',
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({ organizationId: ORG_ID, extra: { requestId: REQUEST_ID } });
    expect(JSON.stringify(reports[0]![1])).not.toContain('includeShareLinksInEmail');
  });

  it('no settings row: on (never configured), the photo rides the link', async () => {
    const { res } = await send({ data: null, error: null });
    expect(res).toEqual({ sent: true });
    expect(sentEmail().html).toContain(PHOTO_URL);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('the key set to false: the email goes without the link', async () => {
    const { res } = await send({ data: { settings: { includeShareLinksInEmail: false } }, error: null });
    expect(res).toEqual({ sent: true });
    expect(sentEmail().html).not.toContain(`/m/${SHARE_TOKEN}`);
    expect(listProofMock).not.toHaveBeenCalled();
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('the key set to true: the photo rides the link', async () => {
    await send({ data: { settings: { includeShareLinksInEmail: true } }, error: null });
    expect(sentEmail().html).toContain(PHOTO_URL);
  });

  it('a row without the key: on (never configured), the photo rides the link', async () => {
    await send({ data: { settings: { categories: ['Facilities'] } }, error: null });
    expect(sentEmail().html).toContain(PHOTO_URL);
  });
});
