import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Per-file mocks — audit is side-effecting, matches Task 8/9's own test files.
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

// share_links has NO authenticated write policy (0314) — every write AND
// the anonymous resolver run on the ADMIN client, never ctx.supabase. The
// shared makeSupabaseStub()'s default storage.from() already returns a
// generic, opaque signed URL for createSignedUrl (`https://mock/signed`) —
// unused by this service post fix-wave-C1 (the resolver no longer touches
// Storage at all; see the `resolveMaintenanceShareToken` describe block).
const { createAdminClientMock } = vi.hoisted(() => ({ createAdminClientMock: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: createAdminClientMock,
}));

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { audit } from './audit';
import {
  hashShareToken,
  listResolutionProofProxyPhotos,
  MaintenanceShareLinksService,
  resolveMaintenanceSharePhoto,
  resolveMaintenanceShareToken,
} from './maintenance-share-links';

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

describe('hashShareToken', () => {
  it('is the SHA-256 hex digest of the FULL token — a real hash function, not a slice/prefix (fix wave m6)', () => {
    const token = 'e'.repeat(64);
    const expected = createHash('sha256').update(token).digest('hex');
    expect(hashShareToken(token)).toBe(expected);
    expect(hashShareToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('two tokens sharing the same first 32 hex chars hash to DIFFERENT digests — a slice(0,32) key would collide these onto one rate-limit bucket', () => {
    const shared32 = 'a'.repeat(32);
    const tokenA = `${shared32}${'1'.repeat(32)}`;
    const tokenB = `${shared32}${'2'.repeat(32)}`;
    expect(hashShareToken(tokenA)).not.toBe(hashShareToken(tokenB));
  });

  it('never contains the plaintext token as a substring — the whole point is to avoid persisting a working credential fragment', () => {
    const token = 'b'.repeat(64);
    expect(hashShareToken(token)).not.toContain(token.slice(0, 32));
  });
});

describe('issueLink (rotate-or-create — mig 0330 show-once)', () => {
  it('checks parent visibility via the RLS-scoped ctx client BEFORE touching the admin client (chainArgs-pinned) — requester-own or read_all/manage both pass because RLS itself already encodes that boundary', async () => {
    const { stub, ctx } = build({
      'maintenance_requests.select': { data: { id: REQ_ID, requester_user_id: null }, error: null },
    });
    buildAdmin({
      'maintenance_request_share_links.update': { data: null, error: null },
      'maintenance_request_share_links.insert': { data: null, error: null },
    });

    await new MaintenanceShareLinksService(ctx).issueLink(REQ_ID);

    const args = stub.chainArgs.get('maintenance_requests.select')!;
    expect(args).toContainEqual(['organization_id', ctx.organizationId]);
    expect(args).toContainEqual(['id', REQ_ID]);
  });

  it('not_found when the parent request is not visible to this caller (RLS-scoped select returns null) — never mints a link', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: null, error: null } });
    const adminStub = buildAdmin();

    await expect(new MaintenanceShareLinksService(ctx).issueLink(REQ_ID)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(adminStub.fromCalls).not.toContain('maintenance_request_share_links');
  });

  it('mints a 64-hex-char token from 32 random bytes, an expiry ~180 days out, and inserts on the ADMIN client', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: { id: REQ_ID, requester_user_id: null }, error: null },
    });
    const adminStub = buildAdmin({
      'maintenance_request_share_links.update': { data: null, error: null },
      'maintenance_request_share_links.insert': { data: null, error: null },
    });

    const before = Date.now();
    const res = await new MaintenanceShareLinksService(ctx).issueLink(REQ_ID);
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
    expect(insert.active).toBe(true);
    expect(insert.expires_at).toBe(res.expiresAt);
    expect(insert.created_by).toBe(ctx.userId);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'maintenance_request.share_link_created', entityId: REQ_ID }),
      ctx,
    );
  });

  it('SECURITY PROPERTY (MED-26 a) — the row written to the DB carries token_hash = sha256(returned plaintext), a 64-hex digest, and NO plaintext token under any key', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: { id: REQ_ID, requester_user_id: null }, error: null },
    });
    const adminStub = buildAdmin({
      'maintenance_request_share_links.update': { data: null, error: null },
      'maintenance_request_share_links.insert': { data: null, error: null },
    });

    const res = await new MaintenanceShareLinksService(ctx).issueLink(REQ_ID);

    const insert = adminStub.chainArgs.get('maintenance_request_share_links.insert')![0]![0] as Record<
      string,
      unknown
    >;
    // Literal pin: the at-rest column is the digest of the plaintext the
    // caller got — computed independently here with node:crypto, not by
    // calling the service's own helper.
    expect(insert.token_hash).toBe(createHash('sha256').update(res.token).digest('hex'));
    expect(insert.token_hash).toMatch(/^[0-9a-f]{64}$/);
    // The legacy plaintext column is gone from the payload entirely, and no
    // OTHER key smuggles the plaintext either (a digest of a 256-bit value
    // can never equal its preimage, so a full-payload scan is meaningful).
    expect(insert).not.toHaveProperty('token');
    for (const value of Object.values(insert)) {
      expect(value).not.toBe(res.token);
      expect(String(value)).not.toContain(res.token);
    }
  });

  it('MUTATION GUARD (I2) — mints the token via crypto.getRandomValues on a 32-byte Uint8Array, not a weaker RNG', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: { id: REQ_ID, requester_user_id: null }, error: null },
    });
    buildAdmin({
      'maintenance_request_share_links.update': { data: null, error: null },
      'maintenance_request_share_links.insert': { data: null, error: null },
    });
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');

    await new MaintenanceShareLinksService(ctx).issueLink(REQ_ID);

    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0]![0];
    expect(arg).toBeInstanceOf(Uint8Array);
    expect((arg as Uint8Array).length).toBe(32);
  });

  it('generates a different token on every call (no fixed/predictable value)', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: { id: REQ_ID, requester_user_id: null }, error: null },
    });
    buildAdmin({
      'maintenance_request_share_links.update': { data: null, error: null },
      'maintenance_request_share_links.insert': { data: null, error: null },
    });
    const a = await new MaintenanceShareLinksService(ctx).issueLink(REQ_ID);
    const b = await new MaintenanceShareLinksService(ctx).issueLink(REQ_ID);
    expect(a.token).not.toBe(b.token);
  });

  it('SECURITY PROPERTY (MED-26 d) — always rotates: deactivates any currently-active row BEFORE inserting the fresh one, so the previously-issued plaintext stops resolving', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: { id: REQ_ID, requester_user_id: null }, error: null },
    });
    const adminStub = buildAdmin({
      'maintenance_request_share_links.update': { data: null, error: null },
      'maintenance_request_share_links.insert': { data: null, error: null },
    });

    await new MaintenanceShareLinksService(ctx).issueLink(REQ_ID);

    // The deactivate ran, targeting exactly this org+request's active row.
    const updatePayload = adminStub.chainArgs.get('maintenance_request_share_links.update')![0]![0] as Record<
      string,
      unknown
    >;
    expect(updatePayload.active).toBe(false);
    // Rotation must NOT stamp revoked_at — that column records an explicit
    // revoke() call by a manage-holder (fix wave m3 posture, kept).
    expect(updatePayload).not.toHaveProperty('revoked_at');
    const updateArgs = adminStub.chainArgs.get('maintenance_request_share_links.update')!;
    expect(updateArgs).toContainEqual(['organization_id', ctx.organizationId]);
    expect(updateArgs).toContainEqual(['maintenance_request_id', REQ_ID]);
    expect(updateArgs).toContainEqual(['active', true]);
    // And a fresh row was inserted after it.
    expect(adminStub.chainArgs.has('maintenance_request_share_links.insert')).toBe(true);
  });

  it('a concurrent insert race (23505 against the partial unique index) surfaces as a retryable conflict — the winner\'s plaintext is unrecoverable (hash-at-rest), so it can never be handed back', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: { id: REQ_ID, requester_user_id: null }, error: null },
    });
    buildAdmin({
      'maintenance_request_share_links.update': { data: null, error: null },
      'maintenance_request_share_links.insert': {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      },
    });

    await expect(new MaintenanceShareLinksService(ctx).issueLink(REQ_ID)).rejects.toMatchObject({
      code: 'conflict',
    });
    // The loser never audits a creation it didn't actually perform.
    expect(audit).not.toHaveBeenCalled();
  });

  it('a non-23505 insert failure surfaces as internal_error', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: { id: REQ_ID, requester_user_id: null }, error: null },
    });
    buildAdmin({
      'maintenance_request_share_links.update': { data: null, error: null },
      'maintenance_request_share_links.insert': { data: null, error: { message: 'connection reset' } },
    });
    await expect(new MaintenanceShareLinksService(ctx).issueLink(REQ_ID)).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it('MUTATION GUARD — module gate: rejects when maintenance_requests is disabled for the org, and never reaches the admin client', async () => {
    const { ctx } = build({}, { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS) });
    await expect(new MaintenanceShareLinksService(ctx).issueLink(REQ_ID)).rejects.toMatchObject({
      code: 'module_disabled',
    });
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  describe('fix wave I3 — minting a link is a bigger privilege than merely reading the request', () => {
    it('MUTATION GUARD — a read_all-only holder (can see every request, but does not own this one) is REFUSED — never mints a link', async () => {
      const { ctx } = build(
        {
          'maintenance_requests.select': {
            data: { id: REQ_ID, requester_user_id: 'someone-else' },
            error: null,
          },
        },
        { role: 'viewer', permissions: new Set(['maintenance_requests:read_all']) },
      );
      const adminStub = buildAdmin();

      await expect(new MaintenanceShareLinksService(ctx).issueLink(REQ_ID)).rejects.toMatchObject({
        code: 'forbidden',
      });
      expect(adminStub.fromCalls).not.toContain('maintenance_request_share_links');
    });

    it('the OWNING requester, holding only submit (no manage, no read_all), succeeds', async () => {
      const { ctx } = build(
        {
          'maintenance_requests.select': {
            data: { id: REQ_ID, requester_user_id: 'requester-1' },
            error: null,
          },
        },
        { userId: 'requester-1', role: 'staff', permissions: new Set(['maintenance_requests:submit']) },
      );
      buildAdmin({
        'maintenance_request_share_links.update': { data: null, error: null },
        'maintenance_request_share_links.insert': { data: null, error: null },
      });

      const res = await new MaintenanceShareLinksService(ctx).issueLink(REQ_ID);
      expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('a non-owning requester who only holds submit (not the request\'s own requester) is REFUSED', async () => {
      const { ctx } = build(
        {
          'maintenance_requests.select': {
            data: { id: REQ_ID, requester_user_id: 'someone-else' },
            error: null,
          },
        },
        { userId: 'requester-1', role: 'staff', permissions: new Set(['maintenance_requests:submit']) },
      );
      const adminStub = buildAdmin();

      await expect(new MaintenanceShareLinksService(ctx).issueLink(REQ_ID)).rejects.toMatchObject({
        code: 'forbidden',
      });
      expect(adminStub.fromCalls).not.toContain('maintenance_request_share_links');
    });

    it('a manage holder mints a link for a request they do NOT own', async () => {
      const { ctx } = build(
        {
          'maintenance_requests.select': {
            data: { id: REQ_ID, requester_user_id: 'someone-else' },
            error: null,
          },
        },
        { role: 'manager' },
      );
      buildAdmin({
        'maintenance_request_share_links.update': { data: null, error: null },
        'maintenance_request_share_links.insert': { data: null, error: null },
      });

      const res = await new MaintenanceShareLinksService(ctx).issueLink(REQ_ID);
      expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});

describe('getActiveLinkStatus (token-free render-time read)', () => {
  it('returns { expiresAt } for an active, unexpired link — and the payload carries NO token material (the select asks only for expires_at)', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: { id: REQ_ID, requester_user_id: null }, error: null },
    });
    const futureIso = new Date(Date.now() + 90 * DAY_MS).toISOString();
    const adminStub = buildAdmin({
      'maintenance_request_share_links.select': { data: { expires_at: futureIso }, error: null },
    });

    const res = await new MaintenanceShareLinksService(ctx).getActiveLinkStatus(REQ_ID);
    expect(res).toEqual({ expiresAt: futureIso });

    const args = adminStub.chainArgs.get('maintenance_request_share_links.select')!;
    expect(args).toContainEqual(['organization_id', ctx.organizationId]);
    expect(args).toContainEqual(['maintenance_request_id', REQ_ID]);
    expect(args).toContainEqual(['active', true]);
  });

  it('an expired-but-still-active row reads as null (no link)', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: { id: REQ_ID, requester_user_id: null }, error: null },
    });
    const pastIso = new Date(Date.now() - DAY_MS).toISOString();
    buildAdmin({
      'maintenance_request_share_links.select': { data: { expires_at: pastIso }, error: null },
    });
    await expect(new MaintenanceShareLinksService(ctx).getActiveLinkStatus(REQ_ID)).resolves.toBeNull();
  });

  it('no active row -> null', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: { id: REQ_ID, requester_user_id: null }, error: null },
    });
    buildAdmin({ 'maintenance_request_share_links.select': { data: null, error: null } });
    await expect(new MaintenanceShareLinksService(ctx).getActiveLinkStatus(REQ_ID)).resolves.toBeNull();
  });

  it('same tier as issueLink: a read_all-only non-owner is refused; the owning requester with submit passes', async () => {
    const refused = build(
      {
        'maintenance_requests.select': { data: { id: REQ_ID, requester_user_id: 'someone-else' }, error: null },
      },
      { role: 'viewer', permissions: new Set(['maintenance_requests:read_all']) },
    );
    buildAdmin();
    await expect(
      new MaintenanceShareLinksService(refused.ctx).getActiveLinkStatus(REQ_ID),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const owner = build(
      {
        'maintenance_requests.select': { data: { id: REQ_ID, requester_user_id: 'requester-1' }, error: null },
      },
      { userId: 'requester-1', role: 'staff', permissions: new Set(['maintenance_requests:submit']) },
    );
    buildAdmin({ 'maintenance_request_share_links.select': { data: null, error: null } });
    await expect(
      new MaintenanceShareLinksService(owner.ctx).getActiveLinkStatus(REQ_ID),
    ).resolves.toBeNull();
  });

  it('not_found when the parent request is not visible to this caller', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: null, error: null } });
    const adminStub = buildAdmin();
    await expect(new MaintenanceShareLinksService(ctx).getActiveLinkStatus(REQ_ID)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(adminStub.fromCalls).not.toContain('maintenance_request_share_links');
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

  it('MUTATION GUARD (I7) — a read_all-only ctx (visibility into every request, but not management) is refused too, LITERAL-PINNED to the manage permission string — read_all alone must never satisfy this gate', async () => {
    const { ctx } = build({}, { permissions: new Set(['maintenance_requests:read_all']) });
    const adminStub = buildAdmin();

    await expect(new MaintenanceShareLinksService(ctx).revoke(REQ_ID)).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('maintenance_requests:manage'),
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
  // Fix wave 2 (C1b): `charter_id` is the raw FK column, never an embedded
  // `charters` object — resolveMaintenanceShareToken resolves the site name
  // through a SEPARATE, organization_id-scoped query
  // (resolveOrgScopedCharterName), never through an embed on this row. See
  // the "siteName resolution" describe block below for the tests proving
  // that separation actually holds under a foreign-org charter_id.
  const REQ_ROW = {
    request_number: 42,
    created_at: '2026-08-01T12:00:00Z',
    subject: 'AC not working in Room 204',
    description: 'Blowing warm air since yesterday afternoon.',
    charter_id: 'charter-1',
  };

  it('rejects a malformed token shape before ever touching the admin client', async () => {
    const res = await resolveMaintenanceShareToken('not-a-hex-token!!');
    expect(res).toBeNull();
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it('rejects an UPPERCASE-hex token — the /i flag was dropped (fix wave m7): no token this service ever minted is anything but lowercase', async () => {
    const res = await resolveMaintenanceShareToken('D'.repeat(64));
    expect(res).toBeNull();
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it('unknown token -> null', async () => {
    buildAdmin({ 'maintenance_request_share_links.select': { data: null, error: null } });
    await expect(resolveMaintenanceShareToken(TOKEN)).resolves.toBeNull();
  });

  it('MUTATION GUARD (I1a) + SECURITY PROPERTY (MED-26 b) — the lookup filters on token_hash = sha256(presented plaintext), never on the plaintext itself (chainArgs-pinned, digest computed independently)', async () => {
    const adminStub = buildAdmin({ 'maintenance_request_share_links.select': { data: null, error: null } });
    await resolveMaintenanceShareToken(TOKEN);
    const args = adminStub.chainArgs.get('maintenance_request_share_links.select')!;
    expect(args).toContainEqual(['token_hash', createHash('sha256').update(TOKEN).digest('hex')]);
    // The plaintext never reaches the query as a filter value.
    expect(args).not.toContainEqual(['token', TOKEN]);
    expect(args).not.toContainEqual(['token_hash', TOKEN]);
  });

  it('SECURITY PROPERTY (MED-26 c) — presenting the STORED HASH as if it were a token cannot resolve: the service digests every presented value, so the hash-of-the-hash is what gets compared, never the stored digest itself', async () => {
    // The stored at-rest value for TOKEN:
    const storedHash = createHash('sha256').update(TOKEN).digest('hex');
    const adminStub = buildAdmin({ 'maintenance_request_share_links.select': { data: null, error: null } });

    await resolveMaintenanceShareToken(storedHash);

    const args = adminStub.chainArgs.get('maintenance_request_share_links.select')!;
    // The comparison value is sha256(storedHash) — which can never equal
    // storedHash (a digest has no fixed point reachable here), so a row
    // whose token_hash IS storedHash can never match. If the service ever
    // regressed to comparing the presented value directly, this filter
    // would be ['token_hash', storedHash] and the assertion below trips.
    expect(args).toContainEqual([
      'token_hash',
      createHash('sha256').update(storedHash).digest('hex'),
    ]);
    expect(args).not.toContainEqual(['token_hash', storedHash]);
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

  it('fix wave m4 — a whole-query attachments error returns null, never silently renders as a zero-photo page', async () => {
    buildAdmin({
      'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
      'maintenance_requests.select': { data: REQ_ROW, error: null },
      'maintenance_request_attachments.select': { data: null, error: { message: 'connection reset' } },
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
      ['createdAt', 'description', 'photos', 'requestNumber', 'resolution', 'siteName', 'subject'].sort(),
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

  it('FIX WAVE C1 — never touches Storage to build the page projection: photos carry ONLY a filename, never a storage path or a signed URL', async () => {
    const adminStub = buildAdmin({
      'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
      'maintenance_requests.select': { data: REQ_ROW, error: null },
      'maintenance_request_attachments.select': {
        data: [
          {
            storage_path: 'org-from-link/req-from-link/att-1/master.jpg',
            mime_type: 'image/jpeg',
            safe_filename: 'break-room.jpg',
            kind: 'requester',
          },
        ],
        error: null,
      },
    });
    const createSignedUrl = vi.fn();
    adminStub.client.storage.from = vi.fn(() => ({ createSignedUrl }));

    const res = await resolveMaintenanceShareToken(TOKEN);

    expect(res!.photos).toEqual([{ filename: 'break-room.jpg', kind: 'requester' }]);
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(adminStub.client.storage.from).not.toHaveBeenCalled();

    // Realistic signed-URL shape check (the ORIGINAL version of this test —
    // reviewer M19b — mocked createSignedUrl to return an unrealistic
    // 'https://mock/signed-N' stand-in and passed trivially even though the
    // OLD implementation embedded the real signed URL straight into the
    // response). A genuine Supabase signed URL looks like:
    //   https://xyz.supabase.co/storage/v1/object/sign/maintenance-photos/<org>/<req>/<att>.jpg?token=...
    // Prove none of that shape can appear in the returned value at all.
    const json = JSON.stringify(res);
    expect(json).not.toContain('org-from-link/req-from-link');
    expect(json).not.toContain('maintenance-photos');
    expect(json).not.toContain('storage/v1');
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('fix wave m4 — one malformed attachment row (empty storage_path) is skipped, not fatal, and never shifts other photos\' positions unexpectedly', async () => {
    buildAdmin({
      'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
      'maintenance_requests.select': { data: REQ_ROW, error: null },
      'maintenance_request_attachments.select': {
        data: [
          { storage_path: '', mime_type: 'image/jpeg', safe_filename: 'broken.jpg', kind: 'requester' },
          {
            storage_path: 'org-from-link/req-from-link/att-2/ok.jpg',
            mime_type: 'image/webp',
            safe_filename: 'ok.jpg',
            kind: 'requester',
          },
        ],
        error: null,
      },
    });
    const res = await resolveMaintenanceShareToken(TOKEN);
    expect(res!.photos).toEqual([{ filename: 'ok.jpg', kind: 'requester' }]);
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

  /**
   * Fix wave 2 (C1b — defense in depth at the READ). The OLD implementation
   * embedded `charters!charter_id(name)` straight onto the
   * `maintenance_requests` select: under the ADMIN client, an embed follows
   * the `charter_id` FK regardless of org — the outer
   * `.eq('organization_id', ...)` scopes only the `maintenance_requests`
   * ROW, never the embedded `charters` row it points at. Layer (a)
   * (MaintenanceRequestsService re-deriving charterId against org on every
   * create/update, see maintenance-requests.test.ts's own C1 describe
   * blocks) stops NEW foreign-org attaches, but a row written BEFORE that
   * fix shipped could already carry a foreign-org charter_id — these tests
   * simulate exactly that pre-fix row and prove the READ itself cannot leak
   * it, independent of whether the WRITE side was ever patched.
   */
  describe('siteName resolution is org-scoped at the READ itself, independent of how charter_id got there (fix wave 2 / C1b)', () => {
    it('resolves siteName through a SECOND, organization_id-scoped charters query — chainArgs-pinned so dropping that scoping would be caught even though the mock is otherwise filter-blind', async () => {
      const adminStub = buildAdmin({
        'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
        'maintenance_requests.select': { data: REQ_ROW, error: null },
        'maintenance_request_attachments.select': { data: [], error: null },
        'charters.select': { data: { name: 'Fresno DC4' }, error: null },
      });
      const res = await resolveMaintenanceShareToken(TOKEN);
      expect(res!.siteName).toBe('Fresno DC4');
      const args = adminStub.chainArgs.get('charters.select')!;
      expect(args).toContainEqual(['organization_id', LINK_ORG]);
      expect(args).toContainEqual(['id', REQ_ROW.charter_id]);
    });

    it('C1 FIX — THE anonymous-page cross-tenant leak this closes: even when the maintenance_requests read carries an embedded charter name for a FOREIGN org (the exact shape the OLD `charters!charter_id(name)` embed would still produce for a pre-fix row, since an embed follows the FK regardless of org), the code never reads it — siteName comes ONLY from the org-scoped second query, which correctly finds no row for a charter_id belonging to another org', async () => {
      buildAdmin({
        'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
        'maintenance_requests.select': {
          // Simulates exactly what `charters!charter_id(name)` would still
          // return under the OLD implementation for a charter_id belonging
          // to a DIFFERENT org than `resolved.organizationId` (LINK_ORG) —
          // present on the row as if PostgREST had embedded it, unscoped.
          data: { ...REQ_ROW, charters: { name: 'Some Other Tenant HQ' } },
          error: null,
        },
        'maintenance_request_attachments.select': { data: [], error: null },
        // The org-scoped charters lookup legitimately finds NOTHING for
        // this charter_id under LINK_ORG — it belongs to another org. This
        // is the mechanism that makes the fix work.
        'charters.select': { data: null, error: null },
      });
      const res = await resolveMaintenanceShareToken(TOKEN);
      expect(res!.siteName).toBeNull();
      expect(JSON.stringify(res)).not.toContain('Some Other Tenant HQ');
    });

    it('never queries charters at all when the request has no charter_id', async () => {
      const adminStub = buildAdmin({
        'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
        'maintenance_requests.select': { data: { ...REQ_ROW, charter_id: null }, error: null },
        'maintenance_request_attachments.select': { data: [], error: null },
      });
      const res = await resolveMaintenanceShareToken(TOKEN);
      expect(res!.siteName).toBeNull();
      expect(adminStub.chainArgs.has('charters.select')).toBe(false);
    });
  });

  /**
   * Task 3 brief test 8 / spec §4.2/§12.1. The shipped `fetchValidAttachments`
   * ordered by `sort_order` ALONE — every row defaults `sort_order = 0`, so
   * the tie order between same-sort_order rows rested on unguaranteed
   * Postgres behavior. `created_at` is the new, explicit secondary key; both
   * `.order()` calls are pinned here (chainArgs), in sequence, because this
   * ONE function backs both `resolveMaintenanceShareToken` (the page) and
   * `resolveMaintenanceSharePhoto` (the proxy route) — a wobbling tie order
   * would desync their indices independently, not just within one call.
   */
  describe('fetchValidAttachments ordering tiebreaker (spec §4.2/§12.1)', () => {
    it('orders by sort_order asc THEN created_at asc — chainArgs pins BOTH .order calls, in that sequence', async () => {
      const adminStub = buildAdmin({
        'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
        'maintenance_requests.select': { data: REQ_ROW, error: null },
        'maintenance_request_attachments.select': { data: [], error: null },
      });

      await resolveMaintenanceShareToken(TOKEN);

      const names = adminStub.chains.get('maintenance_request_attachments.select')!;
      const args = adminStub.chainArgs.get('maintenance_request_attachments.select')!;
      const orderIndices = names.reduce<number[]>((acc, n, i) => (n === 'order' ? [...acc, i] : acc), []);
      expect(orderIndices).toHaveLength(2);
      expect(args[orderIndices[0]!]).toEqual(['sort_order', { ascending: true }]);
      expect(args[orderIndices[1]!]).toEqual(['created_at', { ascending: true }]);
    });
  });

  /**
   * Task 3 brief test 9/10 (D2/spec §4.2). `resolution` is gated purely on
   * `resolved_at`; it is null for every request that has never been
   * resolved, and carries the note VERBATIM (no truncation) plus a
   * server-pre-formatted date once resolved — and deliberately NEVER a
   * resolver name (that column isn't even in the select — see the leak
   * guard test below).
   */
  describe('resolution block (D2/spec §4.2)', () => {
    it('a resolved request row (resolved_at + resolution_note) projects { note, resolvedAtDisplay } — the note is a literal round-trip, never truncated or reformatted', async () => {
      buildAdmin({
        'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
        'maintenance_requests.select': {
          data: {
            ...REQ_ROW,
            resolved_at: '2026-08-05T12:00:00Z',
            resolution_note: 'The issue for the leaking roof tile has been resolved.',
          },
          error: null,
        },
        'maintenance_request_attachments.select': { data: [], error: null },
      });
      const res = await resolveMaintenanceShareToken(TOKEN);
      expect(res!.resolution).toEqual({
        note: 'The issue for the leaking roof tile has been resolved.',
        resolvedAtDisplay: 'August 5, 2026',
      });
    });

    it('an unresolved request (resolved_at null) projects resolution: null', async () => {
      buildAdmin({
        'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
        'maintenance_requests.select': { data: { ...REQ_ROW, resolved_at: null, resolution_note: null }, error: null },
        'maintenance_request_attachments.select': { data: [], error: null },
      });
      const res = await resolveMaintenanceShareToken(TOKEN);
      expect(res!.resolution).toBeNull();
    });

    it('MUTATION GUARD (T3-M4) — the resolver name NEVER reaches the projection: resolved_by_name_snapshot is not even selected, so simulating it directly on the row still cannot leak into `resolution` or anywhere else in the response', async () => {
      buildAdmin({
        'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
        'maintenance_requests.select': {
          data: {
            ...REQ_ROW,
            resolved_at: '2026-08-05T12:00:00Z',
            resolution_note: 'Fixed the AC unit.',
            // Simulated future/leaked column — a real row DOES carry this
            // (migration 0317), but resolveMaintenanceShareToken's select
            // never asks for it. If the select ever regressed to `select('*')`
            // or the projection ever spread the raw row, this would surface.
            resolved_by_name_snapshot: 'Jane Q. Manager',
            resolved_by: 'user-jane-uuid',
          },
          error: null,
        },
        'maintenance_request_attachments.select': { data: [], error: null },
      });
      const res = await resolveMaintenanceShareToken(TOKEN);
      expect(res!.resolution).toEqual({ note: 'Fixed the AC unit.', resolvedAtDisplay: 'August 5, 2026' });
      expect(Object.keys(res!.resolution!).sort()).toEqual(['note', 'resolvedAtDisplay']);
      const json = JSON.stringify(res);
      expect(json).not.toContain('Jane Q. Manager');
      expect(json).not.toContain('user-jane-uuid');
    });
  });
});

describe('resolveMaintenanceSharePhoto (the proxy route\'s only data source)', () => {
  const TOKEN = 'f'.repeat(64);
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
  const ATT_ROWS = [
    { storage_path: 'org/req/att-1.jpg', mime_type: 'image/jpeg', safe_filename: 'first.jpg' },
    { storage_path: 'org/req/att-2.webp', mime_type: 'image/webp', safe_filename: 'second.webp' },
  ];

  it('returns the raw storage path + stored mime type for a valid index', async () => {
    buildAdmin({
      'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
      'maintenance_request_attachments.select': { data: ATT_ROWS, error: null },
    });
    await expect(resolveMaintenanceSharePhoto(TOKEN, 0)).resolves.toEqual({
      storagePath: 'org/req/att-1.jpg',
      mimeType: 'image/jpeg',
      filename: 'first.jpg',
    });
    await expect(resolveMaintenanceSharePhoto(TOKEN, 1)).resolves.toEqual({
      storagePath: 'org/req/att-2.webp',
      mimeType: 'image/webp',
      filename: 'second.webp',
    });
  });

  it('an out-of-range index -> null (never a wraparound/negative-index lookup)', async () => {
    buildAdmin({
      'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
      'maintenance_request_attachments.select': { data: ATT_ROWS, error: null },
    });
    await expect(resolveMaintenanceSharePhoto(TOKEN, 2)).resolves.toBeNull();
    await expect(resolveMaintenanceSharePhoto(TOKEN, 999)).resolves.toBeNull();
  });

  it('a negative or non-integer index -> null before any admin-client call', async () => {
    await expect(resolveMaintenanceSharePhoto(TOKEN, -1)).resolves.toBeNull();
    await expect(resolveMaintenanceSharePhoto(TOKEN, 1.5)).resolves.toBeNull();
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it('an unresolved token (unknown/revoked/expired) -> null, same posture as the page projection', async () => {
    buildAdmin({ 'maintenance_request_share_links.select': { data: null, error: null } });
    await expect(resolveMaintenanceSharePhoto(TOKEN, 0)).resolves.toBeNull();

    buildAdmin({
      'maintenance_request_share_links.select': { data: { ...ACTIVE_LINK_ROW, active: false }, error: null },
      'maintenance_request_attachments.select': { data: ATT_ROWS, error: null },
    });
    await expect(resolveMaintenanceSharePhoto(TOKEN, 0)).resolves.toBeNull();

    buildAdmin({
      'maintenance_request_share_links.select': { data: { ...ACTIVE_LINK_ROW, expires_at: pastIso }, error: null },
      'maintenance_request_attachments.select': { data: ATT_ROWS, error: null },
    });
    await expect(resolveMaintenanceSharePhoto(TOKEN, 0)).resolves.toBeNull();
  });

  it('index correspondence: a malformed row is filtered out for BOTH functions identically, so the page\'s photos[i] and photo/i always name the same attachment', async () => {
    const rowsWithOneBroken = [
      { storage_path: '', mime_type: 'image/jpeg', safe_filename: 'broken.jpg' },
      { storage_path: 'org/req/ok.jpg', mime_type: 'image/png', safe_filename: 'ok.jpg' },
    ];
    buildAdmin({
      'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
      'maintenance_request_attachments.select': { data: rowsWithOneBroken, error: null },
    });
    // Index 0 must resolve to 'ok.jpg' (the broken row is filtered OUT, not
    // left as a hole at index 0) — matching resolveMaintenanceShareToken's
    // own m4 test with the identical fixture.
    await expect(resolveMaintenanceSharePhoto(TOKEN, 0)).resolves.toEqual({
      storagePath: 'org/req/ok.jpg',
      mimeType: 'image/png',
      filename: 'ok.jpg',
    });
    await expect(resolveMaintenanceSharePhoto(TOKEN, 1)).resolves.toBeNull();
  });

  it('MUTATION GUARD — the attachments query is scoped by org + request (chainArgs-pinned)', async () => {
    const adminStub = buildAdmin({
      'maintenance_request_share_links.select': { data: ACTIVE_LINK_ROW, error: null },
      'maintenance_request_attachments.select': { data: ATT_ROWS, error: null },
    });
    await resolveMaintenanceSharePhoto(TOKEN, 0);
    const args = adminStub.chainArgs.get('maintenance_request_attachments.select')!;
    expect(args).toContainEqual(['organization_id', LINK_ORG]);
    expect(args).toContainEqual(['maintenance_request_id', LINK_REQ]);
  });
});

/**
 * Task 6's ONLY photo-URL data source. Unlike every other function in this
 * file, this one is called directly with an admin client instance (the
 * resolution email sender's own `admin` param — server/email/maintenance-
 * resolved.ts) rather than through `createAdminClientMock`, so these tests
 * build a plain `makeSupabaseStub()` and pass its `.client` straight in.
 */
describe('listResolutionProofProxyPhotos (Task 6 — the resolution email\'s photo data source; mig 0330: verifies a THREADED plaintext, never reads a token back)', () => {
  const ORG_ID = 'org-from-email';
  const REQ_ID = 'req-from-email';
  const TOKEN = 'a1'.repeat(32);
  const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
  const futureIso = new Date(Date.now() + 30 * DAY_MS).toISOString();
  const pastIso = new Date(Date.now() - DAY_MS).toISOString();

  // 5 rows, 3 of kind='resolution', deliberately NOT contiguous — this is
  // what distinguishes "combined-list index" (what /m/<token>/photo/<n>
  // actually expects) from a locally re-filtered "resolution-only index"
  // (T6-M4's mutation target).
  const MIXED_ATTACHMENTS = [
    { storage_path: 'org/req/0.jpg', mime_type: 'image/jpeg', safe_filename: 'requester-0.jpg', kind: 'requester' },
    { storage_path: 'org/req/1.jpg', mime_type: 'image/jpeg', safe_filename: 'resolution-1.jpg', kind: 'resolution' },
    { storage_path: 'org/req/2.jpg', mime_type: 'image/jpeg', safe_filename: 'requester-2.jpg', kind: 'requester' },
    { storage_path: 'org/req/3.jpg', mime_type: 'image/jpeg', safe_filename: 'resolution-3.jpg', kind: 'resolution' },
    { storage_path: 'org/req/4.jpg', mime_type: 'image/jpeg', safe_filename: 'resolution-4.jpg', kind: 'resolution' },
  ];

  it('no threaded token -> null without a single query (nothing usable to verify)', async () => {
    const stub = makeSupabaseStub({});
    const res = await listResolutionProofProxyPhotos(stub.client, ORG_ID, REQ_ID, null);
    expect(res).toBeNull();
    expect(stub.chainArgs.has('maintenance_request_share_links.select')).toBe(false);
  });

  it('no matching link row (revoked, or rotated since the mint) -> null, never touches the attachments table', async () => {
    const stub = makeSupabaseStub({
      'maintenance_request_share_links.select': { data: null, error: null },
    });
    const res = await listResolutionProofProxyPhotos(stub.client, ORG_ID, REQ_ID, TOKEN);
    expect(res).toBeNull();
    expect(stub.chainArgs.has('maintenance_request_attachments.select')).toBe(false);
  });

  it('SECURITY PROPERTY (MED-26 b/c) — verifies the threaded plaintext by token_hash = sha256(plaintext), scoped org + request + active; the plaintext itself is never a filter value', async () => {
    const stub = makeSupabaseStub({
      'maintenance_request_share_links.select': { data: { expires_at: futureIso }, error: null },
      'maintenance_request_attachments.select': { data: MIXED_ATTACHMENTS, error: null },
    });
    await listResolutionProofProxyPhotos(stub.client, ORG_ID, REQ_ID, TOKEN);
    const args = stub.chainArgs.get('maintenance_request_share_links.select')!;
    expect(args).toContainEqual(['organization_id', ORG_ID]);
    expect(args).toContainEqual(['maintenance_request_id', REQ_ID]);
    expect(args).toContainEqual(['active', true]);
    expect(args).toContainEqual(['token_hash', TOKEN_HASH]);
    expect(args).not.toContainEqual(['token', TOKEN]);
    expect(args).not.toContainEqual(['token_hash', TOKEN]);
  });

  it('an expired link -> null (never a live token handed back)', async () => {
    const stub = makeSupabaseStub({
      'maintenance_request_share_links.select': { data: { expires_at: pastIso }, error: null },
      'maintenance_request_attachments.select': { data: MIXED_ATTACHMENTS, error: null },
    });
    const res = await listResolutionProofProxyPhotos(stub.client, ORG_ID, REQ_ID, TOKEN);
    expect(res).toBeNull();
  });

  it('a whole-query attachments error -> null (never silently zero entries)', async () => {
    const stub = makeSupabaseStub({
      'maintenance_request_share_links.select': { data: { expires_at: futureIso }, error: null },
      'maintenance_request_attachments.select': { data: null, error: { message: 'connection reset' } },
    });
    const res = await listResolutionProofProxyPhotos(stub.client, ORG_ID, REQ_ID, TOKEN);
    expect(res).toBeNull();
  });

  it('an active unexpired link + mixed-kind rows -> the THREADED token echoed back and ONLY the resolution rows, at their COMBINED-list indices (not a re-filtered 0/1/2)', async () => {
    const stub = makeSupabaseStub({
      'maintenance_request_share_links.select': { data: { expires_at: futureIso }, error: null },
      'maintenance_request_attachments.select': { data: MIXED_ATTACHMENTS, error: null },
    });
    const res = await listResolutionProofProxyPhotos(stub.client, ORG_ID, REQ_ID, TOKEN);
    expect(res).toEqual({
      token: TOKEN,
      entries: [
        { index: 1, filename: 'resolution-1.jpg' },
        { index: 3, filename: 'resolution-3.jpg' },
        { index: 4, filename: 'resolution-4.jpg' },
      ],
    });
  });

  it('no kind=\'resolution\' rows -> a real link but an empty entries array (not null — the link itself is still usable)', async () => {
    const stub = makeSupabaseStub({
      'maintenance_request_share_links.select': { data: { expires_at: futureIso }, error: null },
      'maintenance_request_attachments.select': {
        data: [{ storage_path: 'org/req/0.jpg', mime_type: 'image/jpeg', safe_filename: 'requester-0.jpg', kind: 'requester' }],
        error: null,
      },
    });
    const res = await listResolutionProofProxyPhotos(stub.client, ORG_ID, REQ_ID, TOKEN);
    expect(res).toEqual({ token: TOKEN, entries: [] });
  });

  it('reuses the SAME fetchValidAttachments ordering funnel — both .order calls are pinned, in sequence, same as resolveMaintenanceShareToken', async () => {
    const stub = makeSupabaseStub({
      'maintenance_request_share_links.select': { data: { expires_at: futureIso }, error: null },
      'maintenance_request_attachments.select': { data: MIXED_ATTACHMENTS, error: null },
    });
    await listResolutionProofProxyPhotos(stub.client, ORG_ID, REQ_ID, TOKEN);
    const names = stub.chains.get('maintenance_request_attachments.select')!;
    const args = stub.chainArgs.get('maintenance_request_attachments.select')!;
    const orderIndices = names.reduce<number[]>((acc, n, i) => (n === 'order' ? [...acc, i] : acc), []);
    expect(orderIndices).toHaveLength(2);
    expect(args[orderIndices[0]!]).toEqual(['sort_order', { ascending: true }]);
    expect(args[orderIndices[1]!]).toEqual(['created_at', { ascending: true }]);
  });
});
