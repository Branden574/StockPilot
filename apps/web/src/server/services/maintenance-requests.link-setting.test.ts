import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * resolve() asks maintenanceShareLinksEnabled (the real reader here, not a
 * mock) before it creates a share link for the resolution email. When the
 * settings read returns an error, no link is created and the email is still
 * scheduled, with no link in it; the resolution itself commits as always.
 */

vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));
const reportErrorMock = vi.hoisted(() => vi.fn(async (_err: unknown, _ctx: unknown) => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError: reportErrorMock }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
}));
const { createAdminClientMock } = vi.hoisted(() => ({ createAdminClientMock: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: createAdminClientMock,
}));
vi.mock('@/server/services/maintenance-notify', () => ({
  notifyMaintenanceEvent: vi.fn(async () => undefined),
}));

// Only the link writer is replaced; maintenanceShareLinksEnabled stays real.
const issueLinkMock = vi.hoisted(() =>
  vi.fn(async (_id: string) => ({
    token: 'tok-example-0002',
    url: 'https://app.example.com/m/tok-example-0002',
    expiresAt: '2027-01-01T00:00:00Z',
  })),
);
vi.mock('@/server/services/maintenance-share-links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/maintenance-share-links')>()),
  MaintenanceShareLinksService: class {
    issueLink = issueLinkMock;
  },
}));

const sendResolvedMock = vi.hoisted(() =>
  vi.fn(async (_admin: unknown, _requestId: string, _opts: { appUrl: string; shareToken?: string | null }) => ({
    sent: true as const,
  })),
);
vi.mock('@/server/email/maintenance-resolved', () => ({
  maybeSendMaintenanceResolvedEmail: sendResolvedMock,
}));

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { MaintenanceRequestsService } from './maintenance-requests';

const ENABLED_MODULES = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'maintenance_requests']);
const ORG_ID = 'org-example';

const RESOLVE_HEADER = {
  archived_at: null,
  cancelled_at: null,
  resolved_at: null,
  requester_user_id: 'requester-1',
  request_number: 42,
  created_at: '2026-08-01T12:00:00Z',
  subject: 'Hallway light out',
};
const NOTE_INPUT = { note: 'Replaced the hallway light fixture and tested it.' };

function build(settingsRead: QueryResult) {
  const stub = makeSupabaseStub({
    'maintenance_requests.select': { data: RESOLVE_HEADER, error: null },
    'user_profiles.select': { data: { full_name: 'Dana Keeler', email: 'dana@example.com' }, error: null },
    'maintenance_request_attachments.select': { data: null, error: null, count: 2 },
    'maintenance_requests.update': { data: { id: 'r1' }, error: null },
    'organization_modules.select': settingsRead,
  });
  const ctx = makeServiceContext(stub.client, {
    organizationId: ORG_ID,
    enabledModules: ENABLED_MODULES,
    permissions: new Set(['maintenance_requests:manage']),
  });
  return { stub, ctx };
}

beforeEach(() => {
  vi.clearAllMocks();
  createAdminClientMock.mockReturnValue(makeSupabaseStub({}).client);
});

describe('resolve(): the share-link setting', () => {
  it('a settings read that returns an error: no link is created, the email is scheduled without one, the read is reported', async () => {
    const { stub, ctx } = build({ data: null, error: { message: 'connection reset', code: '08006' } });
    await expect(new MaintenanceRequestsService(ctx).resolve('r1', NOTE_INPUT)).resolves.toBeUndefined();
    expect(stub.chainArgs.has('maintenance_requests.update')).toBe(true);
    expect(issueLinkMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(sendResolvedMock).toHaveBeenCalledTimes(1));
    expect(sendResolvedMock.mock.calls[0]![2]).toMatchObject({ shareToken: null });
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'maintenance.share_links.setting_read', organizationId: ORG_ID }),
    );
  });

  it('no settings row (never configured): the link is created and handed to the email', async () => {
    const { ctx } = build({ data: null, error: null });
    await new MaintenanceRequestsService(ctx).resolve('r1', NOTE_INPUT);
    expect(issueLinkMock).toHaveBeenCalledWith('r1');
    await vi.waitFor(() => expect(sendResolvedMock).toHaveBeenCalledTimes(1));
    expect(sendResolvedMock.mock.calls[0]![2]).toMatchObject({ shareToken: 'tok-example-0002' });
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('the key set to false: no link is created', async () => {
    const { ctx } = build({ data: { settings: { includeShareLinksInEmail: false } }, error: null });
    await new MaintenanceRequestsService(ctx).resolve('r1', NOTE_INPUT);
    expect(issueLinkMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(sendResolvedMock).toHaveBeenCalledTimes(1));
    expect(sendResolvedMock.mock.calls[0]![2]).toMatchObject({ shareToken: null });
  });
});
