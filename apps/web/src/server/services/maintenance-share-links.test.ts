import { beforeEach, describe, expect, it, vi } from 'vitest';

// Per-file mocks — audit is side-effecting, matches Task 8/9's own test files.
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

// share_links has NO authenticated write policy (0314) — every write AND
// the anonymous resolver run on the ADMIN client, never ctx.supabase. The
// shared makeSupabaseStub()'s default storage.from() already returns a
// generic, opaque signed URL for createSignedUrl (`https://mock/signed`),
// which is exactly what the "storage paths never leak" tests below need —
// no override required unless a test cares about individual call args.
const { createAdminClientMock } = vi.hoisted(() => ({ createAdminClientMock: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: createAdminClientMock,
}));

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { audit } from './audit';
import { MaintenanceShareLinksService, resolveMaintenanceShareToken } from './maintenance-share-links';

// `maintenance_requests` is `defaultOnFor: []` (0314) so it is NOT part of
// DEFAULT_MODULE_IDS — every test expecting success must opt it in
// explicitly (landmine #22, mirrored from Task 8/9's own test files).
const ENABLED_MODULES = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'maintenance_requests']);

const REQ_ID = '11111111-1111-4111-8111-111111111111';
const DAY_MS = 24 * 60 * 60 * 1000;

function build(
  canned: Parameters<typeof makeSupabaseStub>[0] = {},
  overrides: Parameters<typeof makeServiceContext>[1] = {},
) {
  const stub = makeSupabaseStub(canned);
  const ctx = makeServiceContext(stub.client, { enabledModules: ENABLED_MODULES, ...overrides });
  return { stub, ctx };
}

/** Wires a FRESH admin-client stub (the service-role client — separate from
 *  ctx.supabase) and returns it for chainArgs assertions. */
function buildAdmin(canned: Parameters<typeof makeSupabaseStub>[0] = {}) {
  const adminStub = makeSupabaseStub(canned);
  createAdminClientMock.mockReturnValue(adminStub.client);
  return adminStub;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureActiveLink', () => {
  it('checks parent visibility via the RLS-scoped ctx client BEFORE touching the admin client (chainArgs-pinned) — requester-own or read_all/manage both pass because RLS itself already encodes that boundary', async () => {
    const { stub, ctx } = build({
      'maintenance_requests.select': { data: { id: REQ_ID }, error: null },
    });
    buildAdmin({
      'maintenance_request_share_links.select': { data: null, error: null },
      'maintenance_request_share_links.insert': { data: null, error: null },
    });

    await new MaintenanceShareLinksService(ctx).ensureActiveLink(REQ_ID);

    const args = stub.chainArgs.get('maintenance_requests.select')!;
    expect(args).toContainEqual(['organization_id', ctx.organizationId]);
    expect(args).toContainEqual(['id', REQ_ID]);
  });

  it('not_found when the parent request is not visible to this caller (RLS-scoped select returns null) — never mints a link', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: null, error: null } });
    const adminStub = buildAdmin();

    await expect(new MaintenanceShareLinksService(ctx).ensureActiveLink(REQ_ID)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(adminStub.fromCalls).not.toContain('maintenance_request_share_links');
  });

  it('mints a 64-hex-char token from 32 random bytes, an expiry ~180 days out, and inserts on the ADMIN client', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: { id: REQ_ID }, error: null } });
    const adminStub = buildAdmin({
      'maintenance_request_share_links.select': { data: null, error: null },
      'maintenance_request_share_links.insert': { data: null, error: null },
    });

    const before = Date.now();
    const res = await new MaintenanceShareLinksService(ctx).ensureActiveLink(REQ_ID);
    const after = Date.now();

    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.url).toBe(`https://stockpilotusa.com/m/${res.token}`);

    const days = (new Date(res.expiresAt).getTime() - before) / DAY_MS;
    expect(days).toBeGreaterThan(179);
    expect(days).toBeLessThan(181);
    expect(new Date(res.expiresAt).getTime()).toBeGreaterThanOrEqual(before + 179 * DAY_MS);
    expect(new Date(res.expiresAt).getTime()).toBeLessThanOrEqual(after + 181 * DAY_MS);

    const insert = adminStub.chainArgs.get('maintenance_request_share_links.insert')![0]![0] as Record<
      string,
      unknown
    >;
    expect(insert.organization_id).toBe(ctx.organizationId);
    expect(insert.maintenance_request_id).toBe(REQ_ID);
    expect(insert.token).toBe(res.token);
    expect(insert.active).toBe(true);
    expect(insert.expires_at).toBe(res.expiresAt);
    expect(insert.created_by).toBe(ctx.userId);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'maintenance_request.share_link_created', entityId: REQ_ID }),
      ctx,
    );
  });

  it('generates a different token on every call (no fixed/predictable value)', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: { id: REQ_ID }, error: null } });
    buildAdmin({
      'maintenance_request_share_links.select': { data: null, error: null },
      'maintenance_request_share_links.insert': { data: null, error: null },
    });
    const a = await new MaintenanceShareLinksService(ctx).ensureActiveLink(REQ_ID);
    const b = await new MaintenanceShareLinksService(ctx).ensureActiveLink(REQ_ID);
    expect(a.token).not.toBe(b.token);
  });

  it('reuses an existing active, unexpired row — no new insert, no audit', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: { id: REQ_ID }, error: null } });
    const futureIso = new Date(Date.now() + 90 * DAY_MS).toISOString();
    const adminStub = buildAdmin({
      'maintenance_request_share_links.select': {
        data: { token: 'a'.repeat(64), expires_at: futureIso },
        error: null,
      },
    });

    const res = await new MaintenanceShareLinksService(ctx).ensureActiveLink(REQ_ID);

    expect(res).toEqual({
      token: 'a'.repeat(64),
      url: `https://stockpilotusa.com/m/${'a'.repeat(64)}`,
      expiresAt: futureIso,
    });
    expect(adminStub.chainArgs.has('maintenance_request_share_links.insert')).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it('deactivates a stale (expired-but-still-active) row before minting a fresh one — the partial unique index on (maintenance_request_id) WHERE active allows only ONE active row, so a stale row must be cleared or the insert 23505s', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: { id: REQ_ID }, error: null } });
    const pastIso = new Date(Date.now() - DAY_MS).toISOString();
    const adminStub = buildAdmin({
      'maintenance_request_share_links.select': { data: { token: 'b'.repeat(64), expires_at: pastIso }, error: null },
      'maintenance_request_share_links.update': { data: null, error: null },
      'maintenance_request_share_links.insert': { data: null, error: null },
    });

    const res = await new MaintenanceShareLinksService(ctx).ensureActiveLink(REQ_ID);

    expect(res.token).not.toBe('b'.repeat(64));
    const updateArgs = adminStub.chainArgs.get('maintenance_request_share_links.update')![0]![0] as Record<
      string,
      unknown
    >;
    expect(updateArgs.active).toBe(false);
    expect(updateArgs.revoked_at).toEqual(expect.any(String));
    expect(adminStub.chainArgs.has('maintenance_request_share_links.insert')).toBe(true);
  });

  it('a concurrent insert race (23505 against the partial unique index) hands back the WINNING row instead of an opaque internal_error', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: { id: REQ_ID }, error: null } });
    const winnerIso = new Date(Date.now() + 180 * DAY_MS).toISOString();

    // makeSupabaseStub takes one result PER key; a canned value may be a
    // function, so use a call counter to return successive values for the
    // two `maintenance_request_share_links.select` calls this path makes
    // (the initial "no existing row" check, then the post-23505 re-fetch).
    let selectCall = 0;
    const adminStub = makeSupabaseStub({
      'maintenance_request_share_links.select': () => {
        selectCall += 1;
        return selectCall === 1
          ? { data: null, error: null }
          : { data: { token: 'c'.repeat(64), expires_at: winnerIso }, error: null };
      },
      'maintenance_request_share_links.insert': {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      },
    });
    createAdminClientMock.mockReturnValue(adminStub.client);

    const res = await new MaintenanceShareLinksService(ctx).ensureActiveLink(REQ_ID);
    expect(res).toEqual({
      token: 'c'.repeat(64),
      url: `https://stockpilotusa.com/m/${'c'.repeat(64)}`,
      expiresAt: winnerIso,
    });
    // The loser never audits a creation it didn't actually perform.
    expect(audit).not.toHaveBeenCalled();
  });

  it('a non-23505 insert failure surfaces as internal_error', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: { id: REQ_ID }, error: null } });
    buildAdmin({
      'maintenance_request_share_links.select': { data: null, error: null },
      'maintenance_request_share_links.insert': { data: null, error: { message: 'connection reset' } },
    });
    await expect(new MaintenanceShareLinksService(ctx).ensureActiveLink(REQ_ID)).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it('MUTATION GUARD — module gate: rejects when maintenance_requests is disabled for the org, and never reaches the admin client', async () => {
    const { ctx } = build({}, { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS) });
    await expect(new MaintenanceShareLinksService(ctx).ensureActiveLink(REQ_ID)).rejects.toMatchObject({
      code: 'module_disabled',
    });
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });
});

describe('revoke', () => {
  it('sets active=false + revoked_at (row-confirmed) and audits share_link_revoked', async () => {
    const { ctx } = build({}, { role: 'admin' });
    const adminStub = buildAdmin({
      'maintenance_request_share_links.update': { data: { id: 'link-1' }, error: null },
    });

    await new MaintenanceShareLinksService(ctx).revoke(REQ_ID);

    const updateArgs = adminStub.chainArgs.get('maintenance_request_share_links.update')![0]![0] as Record<
      string,
      unknown
    >;
    expect(updateArgs.active).toBe(false);
    expect(updateArgs.revoked_at).toEqual(expect.any(String));
    const filterArgs = adminStub.chainArgs.get('maintenance_request_share_links.update')!;
    expect(filterArgs).toContainEqual(['organization_id', ctx.organizationId]);
    expect(filterArgs).toContainEqual(['maintenance_request_id', REQ_ID]);
    expect(filterArgs).toContainEqual(['active', true]);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'maintenance_request.share_link_revoked', entityId: REQ_ID }),
      ctx,
    );
  });

  it('MUTATION GUARD — no fail-open: a zero-row update result (nothing was active) throws not_found and never audits', async () => {
    const { ctx } = build({}, { role: 'admin' });
    buildAdmin({ 'maintenance_request_share_links.update': { data: null, error: null } });

    await expect(new MaintenanceShareLinksService(ctx).revoke(REQ_ID)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it('MUTATION GUARD — requires maintenance_requests:manage (a submit-only role is rejected)', async () => {
    const { ctx } = build({}, { role: 'staff' }); // staff holds submit but not manage (0314)
    const adminStub = buildAdmin();
    await expect(new MaintenanceShareLinksService(ctx).revoke(REQ_ID)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(adminStub.fromCalls).not.toContain('maintenance_request_share_links');
  });

  it('MUTATION GUARD — module gate: rejects when maintenance_requests is disabled', async () => {
    const { ctx } = build({}, { role: 'admin', enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS) });
    await expect(new MaintenanceShareLinksService(ctx).revoke(REQ_ID)).rejects.toMatchObject({
      code: 'module_disabled',
    });
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });
});

describe('resolveMaintenanceShareToken', () => {
  const TOKEN = 'd'.repeat(64);
  const LINK_ORG = 'org-from-link';
  const LINK_REQ = 'req-from-link';
  const futureIso = new Date(Date.now() + 30 * DAY_MS).toISOString();
  const pastIso = new Date(Date.now() - DAY_MS).toISOString();

  const ACTIVE_LINK_ROW = {
    maintenance_request_id: LINK_REQ,
    organization_id: LINK_ORG,
    active: true,
    expires_at: futureIso,
  };
  const REQ_ROW = {
    request_number: 42,
    created_at: '2026-08-01T12:00:00Z',
    subject: 'AC not working in Room 204',
    description: 'Blowing warm air since yesterday afternoon.',
    charters: { name: 'Fresno DC4' },
  };

  it('rejects a malformed token shape before ever touching the admin client', async () => {
    const res = await resolveMaintenanceShareToken('not-a-hex-token!!');
    expect(res).toBeNull();
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it('unknown token -> null', async () => {
    buildAdmin({ 'maintenance_request_share_links.select': { data: null, error: null } });
    await expect(resolveMaintenanceShareToken(TOKEN)).resolves.toBeNull();
  });

  it('MUTATION GUARD — inactive (revoked) link -> null, indistinguishable from unknown, even though the parent request/attachments queries WOULD otherwise resolve to real data', async () => {
    // The downstream request/attachments queries are stubbed with valid data
    // on purpose: if the `active` check were ever dropped, this test would
    // catch it by getting a real (non-null) object back instead of null.
    buildAdmin({
      'maintenance_request_share_links.select': { data: { ...ACTIVE_LINK_ROW, active: false }, error: null },
      'maintenance_requests.select': { data: REQ_ROW, error: null },
      'maintenance_request_attachments.select': { data: [], error: null },
    });
    await expect(resolveMaintenanceShareToken(TOKEN)).resolves.toBeNull();
  });

  it('MUTATION GUARD — expired link -> null, indistinguishable from unknown/inactive, even though the parent request/attachments queries WOULD otherwise resolve to real data', async () => {
    // Same isolation as the inactive-link guard above: dropping the expiry
    // check would otherwise leak a real object here, not just skip a no-op.
    buildAdmin({
      'maintenance_request_share_links.select': { data: { ...ACTIVE_LINK_ROW, expires_at: pastIso }, error: null },
      'maintenance_requests.select': { data: REQ_ROW, error: null },
      'maintenance_request_attachments.select': { data: [], error: null },
    });
    await expect(resolveMaintenanceShareToken(TOKEN)).resolves.toBeNull();
  });

  it('a valid active link whose parent request no longer resolves in-org -> null (never a partial object)', async () => {
    buildAdmin({
      'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
      'maintenance_requests.select': { data: null, error: null },
    });
    await expect(resolveMaintenanceShareToken(TOKEN)).resolves.toBeNull();
  });

  it('returns ONLY the allow-listed keys — an extra/future column on the row never leaks (pins the projection against schema drift)', async () => {
    buildAdmin({
      'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
      'maintenance_requests.select': {
        data: {
          ...REQ_ROW,
          // Simulated future/sensitive columns. If the service ever regresses
          // to `select('*')` + delete-keys, or a fresh column gets added and
          // the allow-list isn't updated, one of these will show up in the
          // response and this test catches it.
          requester_email_snapshot: 'jane@example.com',
          requester_phone_snapshot: '555-0100-SECRET',
          requester_name_snapshot: 'Jane Smith',
          local_owner_user_id: 'owner-1',
          access_instructions: 'call the office first — SECRET',
          building: 'Main Building',
        },
        error: null,
      },
      'maintenance_request_attachments.select': { data: [], error: null },
    });

    const res = await resolveMaintenanceShareToken(TOKEN);
    expect(res).not.toBeNull();
    expect(Object.keys(res!).sort()).toEqual(
      ['createdAt', 'description', 'photos', 'requestNumber', 'siteName', 'subject'].sort(),
    );

    const json = JSON.stringify(res);
    expect(json).not.toContain('jane@example.com');
    expect(json).not.toContain('555-0100-SECRET');
    expect(json).not.toContain('Jane Smith');
    expect(json).not.toContain('owner-1');
    expect(json).not.toContain('SECRET');
  });

  it('scopes BOTH the request and the attachments queries by the resolved link\'s own organization_id + maintenance_request_id (chainArgs-pinned) — the only client input is the token, so this proves no cross-request/cross-org leak is even reachable', async () => {
    const adminStub = buildAdmin({
      'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
      'maintenance_requests.select': { data: REQ_ROW, error: null },
      'maintenance_request_attachments.select': { data: [], error: null },
    });

    await resolveMaintenanceShareToken(TOKEN);

    const reqArgs = adminStub.chainArgs.get('maintenance_requests.select')!;
    expect(reqArgs).toContainEqual(['id', LINK_REQ]);
    expect(reqArgs).toContainEqual(['organization_id', LINK_ORG]);

    const attArgs = adminStub.chainArgs.get('maintenance_request_attachments.select')!;
    expect(attArgs).toContainEqual(['maintenance_request_id', LINK_REQ]);
    expect(attArgs).toContainEqual(['organization_id', LINK_ORG]);
  });

  it('mints signed photo URLs at view time — storage paths never appear anywhere in the returned value', async () => {
    let call = 0;
    const createSignedUrl = vi.fn(async () => {
      call += 1;
      return { data: { signedUrl: `https://mock/signed-${call}` }, error: null };
    });
    const adminStub = buildAdmin({
      'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
      'maintenance_requests.select': { data: REQ_ROW, error: null },
      'maintenance_request_attachments.select': {
        data: [
          {
            storage_path: 'org-from-link/req-from-link/att-1/master.jpg',
            thumbnail_path: 'org-from-link/req-from-link/att-1/master-thumb.webp',
            safe_filename: 'break-room.jpg',
          },
        ],
        error: null,
      },
    });
    adminStub.client.storage.from = vi.fn(() => ({ createSignedUrl }));

    const res = await resolveMaintenanceShareToken(TOKEN);

    expect(res!.photos).toEqual([
      { url: 'https://mock/signed-1', thumbUrl: 'https://mock/signed-2', filename: 'break-room.jpg' },
    ]);
    expect(createSignedUrl).toHaveBeenNthCalledWith(1, 'org-from-link/req-from-link/att-1/master.jpg', 3600);
    expect(createSignedUrl).toHaveBeenNthCalledWith(
      2,
      'org-from-link/req-from-link/att-1/master-thumb.webp',
      3600,
    );

    const json = JSON.stringify(res);
    expect(json).not.toContain('org-from-link/req-from-link');
    expect(json).not.toContain('maintenance-photos');
  });

  it('one broken photo never breaks the page — a failed sign is skipped, not thrown', async () => {
    const createSignedUrl = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'object not found' } }) // photo 1 master fails
      .mockResolvedValueOnce({ data: { signedUrl: 'https://mock/signed-ok' }, error: null }) // photo 2 master ok
      .mockResolvedValueOnce({ data: null, error: { message: 'thumb missing' } }); // photo 2 thumb fails -> null, not thrown
    const adminStub = buildAdmin({
      'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
      'maintenance_requests.select': { data: REQ_ROW, error: null },
      'maintenance_request_attachments.select': {
        data: [
          { storage_path: 'p/broken.jpg', thumbnail_path: null, safe_filename: 'broken.jpg' },
          { storage_path: 'p/ok.jpg', thumbnail_path: 'p/ok-thumb.webp', safe_filename: 'ok.jpg' },
        ],
        error: null,
      },
    });
    adminStub.client.storage.from = vi.fn(() => ({ createSignedUrl }));

    const res = await resolveMaintenanceShareToken(TOKEN);
    expect(res!.photos).toEqual([{ url: 'https://mock/signed-ok', thumbUrl: null, filename: 'ok.jpg' }]);
  });

  it('is NOT module-gated — a disabled module must not break a link that was already emailed (no assertModuleEnabled call is even possible here: there is no ServiceContext)', async () => {
    // No enabledModules concept reaches this function at all — its only
    // parameter is the token. Proven simply by the happy path succeeding
    // with no ctx/module wiring anywhere in this test.
    buildAdmin({
      'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
      'maintenance_requests.select': { data: REQ_ROW, error: null },
      'maintenance_request_attachments.select': { data: [], error: null },
    });
    await expect(resolveMaintenanceShareToken(TOKEN)).resolves.not.toBeNull();
  });
});
