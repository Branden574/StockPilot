import { beforeEach, describe, expect, it, vi } from 'vitest';

// Per-file mocks — audit is side-effecting (writes via the admin client +
// reads request headers), so every service test stubs it and asserts on the
// call shape directly, matching returns.test.ts / connections.test.ts.
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));
// checkRateLimit hits the DB via an RPC on the admin client; stub it so
// create() tests run in isolation and can flip `allowed` per test.
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
}));

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { checkRateLimit } from '@/lib/rate-limit';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { audit } from './audit';
import { MaintenanceRequestsService } from './maintenance-requests';

// `maintenance_requests` is `defaultOnFor: []` in the module registry (L4L-
// only for now — 0314's own doc comment), so it is NOT part of
// DEFAULT_MODULE_IDS the way every other service-test module is. Every test
// below that expects success must opt it in explicitly; the module-gate
// tests deliberately build a context WITHOUT it (the `ctxWithout` pattern
// from modules.gate.test.ts, landmine #22).
const ENABLED_MODULES = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'maintenance_requests']);

/**
 * Builds a { stub, ctx } pair against the REAL supabase-mock.ts helpers
 * (makeServiceContext(supabase, overrides), makeSupabaseStub(results)) —
 * NOT the brief sketch's imagined `ctx.chains()/ctx.chainArgs()` methods,
 * which don't exist on this repo's mock. Query-shape assertions read
 * `stub.chains` / `stub.chainArgs` (Maps keyed `${table}.${op}`) directly,
 * per modules.gate.test.ts / returns.test.ts.
 */
function build(
  canned: Parameters<typeof makeSupabaseStub>[0] = {},
  overrides: Parameters<typeof makeServiceContext>[1] = {},
) {
  const stub = makeSupabaseStub(canned);
  const ctx = makeServiceContext(stub.client, { enabledModules: ENABLED_MODULES, ...overrides });
  return { stub, ctx };
}

const VALID = {
  subject: 'AC not working in Room 204',
  description: 'Blowing warm air since yesterday afternoon.',
  priority: 'high',
};

const PROFILE = { full_name: 'Jane Smith', email: 'jane@example.com' };

/** A fully-populated maintenance_requests row, reused across get/update/
 *  archive/cancel/recordDraftOpened/emailInput tests via targeted overrides.
 *  Field names are 0314's actual columns — the SQL migration is ground
 *  truth, not the brief's sketch. */
const BASE_ROW = {
  id: 'r1',
  request_number: 42,
  created_at: '2026-08-01T12:00:00Z',
  updated_at: '2026-08-01T12:00:00Z',
  subject: 'Broken chair',
  description: 'Chair leg snapped in the break room.',
  status: 'saved',
  priority: 'normal',
  category: null,
  requester_user_id: 'user-test',
  requester_name_snapshot: 'Jane Smith',
  requester_email_snapshot: 'jane@example.com',
  requester_phone_snapshot: null,
  charter_id: null,
  warehouse_id: null,
  building: null,
  room_or_area: null,
  department: null,
  access_instructions: null,
  related_item_id: null,
  related_order_request_id: null,
  related_rental_id: null,
  related_location_id: null,
  local_owner_user_id: null,
  outlook_draft_opened_at: null,
  outlook_draft_open_count: 0,
  archived_at: null,
  cancelled_at: null,
  charters: null,
  maintenance_request_attachments: [{ count: 0 }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('create', () => {
  it('inserts with org + requester from the CONTEXT and snapshots name/email from the PROFILE, never the body', async () => {
    const { stub, ctx } = build({
      'user_profiles.select': { data: PROFILE, error: null },
      'maintenance_requests.insert': {
        data: { id: 'r1', request_number: 1, created_at: '2026-08-05T16:15:00Z' },
        error: null,
      },
    });
    const res = await new MaintenanceRequestsService(ctx).create(VALID);
    expect(res).toEqual({ id: 'r1', requestNumber: 1, createdAt: '2026-08-05T16:15:00Z' });

    // Pin the INSERT shape via the mock's call recording — the mock ignores
    // filters entirely, so asserting on the *returned* row proves nothing
    // about what was actually sent (test-hygiene landmine #37).
    const insert = stub.chainArgs.get('maintenance_requests.insert')![0]![0] as Record<string, unknown>;
    expect(insert.organization_id).toBe(ctx.organizationId);
    expect(insert.requester_user_id).toBe(ctx.userId);
    expect(insert.requester_name_snapshot).toBe('Jane Smith');
    expect(insert.requester_email_snapshot).toBe('jane@example.com');
    expect(insert.status).toBe('saved');
    // Client cannot set these through create() — no field in the form
    // schema even maps to them, so the insert object never carries a key.
    expect(insert.local_owner_user_id).toBeUndefined();
    expect(insert.outlook_draft_open_count).toBeUndefined();
  });

  it('honors a client-supplied requesterPhone — contact info, not an identity claim (user_profiles has no phone column; 0001_init.sql)', async () => {
    const { stub, ctx } = build({
      'user_profiles.select': { data: PROFILE, error: null },
      'maintenance_requests.insert': {
        data: { id: 'r1', request_number: 1, created_at: '2026-08-05T16:15:00Z' },
        error: null,
      },
    });
    await new MaintenanceRequestsService(ctx).create({ ...VALID, requesterPhone: '555-0101' });
    const insert = stub.chainArgs.get('maintenance_requests.insert')![0]![0] as Record<string, unknown>;
    expect(insert.requester_phone_snapshot).toBe('555-0101');
  });

  it('falls back to the profile email when full_name is blank', async () => {
    const { stub, ctx } = build({
      'user_profiles.select': { data: { full_name: null, email: 'noname@example.com' }, error: null },
      'maintenance_requests.insert': {
        data: { id: 'r1', request_number: 1, created_at: '2026-08-05T16:15:00Z' },
        error: null,
      },
    });
    await new MaintenanceRequestsService(ctx).create(VALID);
    const insert = stub.chainArgs.get('maintenance_requests.insert')![0]![0] as Record<string, unknown>;
    expect(insert.requester_name_snapshot).toBe('noname@example.com');
  });

  it('falls back all the way to "Unknown requester" when no profile row exists (0314 NOT NULL guard)', async () => {
    const { stub, ctx } = build({
      'user_profiles.select': { data: null, error: null },
      'maintenance_requests.insert': {
        data: { id: 'r1', request_number: 1, created_at: '2026-08-05T16:15:00Z' },
        error: null,
      },
    });
    await new MaintenanceRequestsService(ctx).create(VALID);
    const insert = stub.chainArgs.get('maintenance_requests.insert')![0]![0] as Record<string, unknown>;
    expect(insert.requester_name_snapshot).toBe('Unknown requester');
    expect(insert.requester_email_snapshot).toBeNull();
  });

  it('MUTATION GUARD: a forged requester identity field is REJECTED — maintenanceRequestFormSchema is .strict() and has no requesterName/requesterEmail field at all, so there is no path for either to reach the snapshot', async () => {
    const { ctx } = build({
      'user_profiles.select': { data: PROFILE, error: null },
      'maintenance_requests.insert': {
        data: { id: 'r1', request_number: 1, created_at: '2026-08-05T16:15:00Z' },
        error: null,
      },
    });
    const svc = new MaintenanceRequestsService(ctx);
    await expect(svc.create({ ...VALID, requesterEmail: 'forged@evil.example' })).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(svc.create({ ...VALID, requesterName: 'FORGED NAME' })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('MUTATION GUARD: rejects when the module is disabled (ctxWithout pattern — landmine #22)', async () => {
    const { ctx } = build({}, { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS) });
    await expect(new MaintenanceRequestsService(ctx).create(VALID)).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });

  it('rejects without the submit permission', async () => {
    const { ctx } = build({}, { permissions: new Set([]) });
    await expect(new MaintenanceRequestsService(ctx).create(VALID)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects invalid input (schema validation)', async () => {
    const { ctx } = build({});
    await expect(
      new MaintenanceRequestsService(ctx).create({ subject: 'AC', description: 'too short', priority: 'high' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('rate-limits creation with a closed-mode per-user bucket', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 20, resetAt: Date.now() });
    const { ctx } = build({});
    await expect(new MaintenanceRequestsService(ctx).create(VALID)).rejects.toMatchObject({ code: 'conflict' });
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.stringContaining('maintenance:create:'),
      20,
      60 * 60 * 1000,
      'closed',
    );
  });

  it('audits maintenance_request.created with allow-listed metadata (no description/subject copy)', async () => {
    const { ctx } = build({
      'user_profiles.select': { data: PROFILE, error: null },
      'maintenance_requests.insert': {
        data: { id: 'r1', request_number: 1, created_at: '2026-08-05T16:15:00Z' },
        error: null,
      },
    });
    await new MaintenanceRequestsService(ctx).create(VALID);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'maintenance_request.created', entityType: 'maintenance_request', entityId: 'r1' }),
      ctx,
    );
    const payload = vi.mocked(audit).mock.calls[0]![0];
    expect(JSON.stringify(payload)).not.toContain('Blowing warm air');
    expect(JSON.stringify(payload)).not.toContain(VALID.subject);
  });
});

describe('list', () => {
  it("scope 'mine' pins a requester_user_id filter in the query chain", async () => {
    const { stub, ctx } = build({ 'maintenance_requests.select': { data: [], error: null } });
    await new MaintenanceRequestsService(ctx).list({ scope: 'mine' });
    expect(stub.chainArgs.get('maintenance_requests.select')).toContainEqual(['requester_user_id', ctx.userId]);
    expect(stub.chainArgs.get('maintenance_requests.select')).toContainEqual(['organization_id', ctx.organizationId]);
  });

  it("scope 'all' without read_all/manage throws forbidden", async () => {
    const { ctx } = build({}, { permissions: new Set(['maintenance_requests:submit']) });
    await expect(new MaintenanceRequestsService(ctx).list({ scope: 'all' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it("scope 'all' WITH read_all succeeds", async () => {
    const { ctx } = build(
      { 'maintenance_requests.select': { data: [], error: null } },
      { permissions: new Set(['maintenance_requests:read_all']) },
    );
    await expect(new MaintenanceRequestsService(ctx).list({ scope: 'all' })).resolves.toEqual([]);
  });

  it('search by typed handle parses MR-2026-000123 to the bigint 123', async () => {
    const { stub, ctx } = build(
      { 'maintenance_requests.select': { data: [], error: null } },
      { permissions: new Set(['maintenance_requests:submit', 'maintenance_requests:read_all']) },
    );
    await new MaintenanceRequestsService(ctx).list({ scope: 'all', q: 'MR-2026-000123' });
    expect(stub.chainArgs.get('maintenance_requests.select')).toContainEqual(['request_number', 123]);
  });

  it('free-text search sanitizes commas/parens/percent/asterisk before building the .or() clause', async () => {
    const { stub, ctx } = build(
      { 'maintenance_requests.select': { data: [], error: null } },
      { permissions: new Set(['maintenance_requests:read_all']) },
    );
    await new MaintenanceRequestsService(ctx).list({ scope: 'all', q: 'a,b(c)d%e*f' });
    const orCall = stub.chainArgs
      .get('maintenance_requests.select')!
      .find((args) => typeof args[0] === 'string' && (args[0] as string).includes('.ilike.'));
    // The term's own special characters are replaced with spaces — only the
    // three field-separator commas .or() itself needs remain.
    expect(orCall![0]).toBe(
      'subject.ilike.%a b c d e f%,description.ilike.%a b c d e f%,requester_name_snapshot.ilike.%a b c d e f%',
    );
  });

  it("status 'active' excludes archived/cancelled JS-SIDE (never PostgREST not.in — pattern #23 drops NULL rows)", async () => {
    const rows = [
      { ...BASE_ROW, id: 'a', status: 'saved' },
      { ...BASE_ROW, id: 'b', status: 'draft_opened' },
      { ...BASE_ROW, id: 'c', status: 'archived' },
      { ...BASE_ROW, id: 'd', status: 'cancelled' },
    ];
    const { ctx } = build({ 'maintenance_requests.select': { data: rows, error: null } });
    const result = await new MaintenanceRequestsService(ctx).list({ scope: 'mine', status: 'active' });
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('MUTATION GUARD: rejects when the module is disabled', async () => {
    const { ctx } = build({}, { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS) });
    await expect(new MaintenanceRequestsService(ctx).list({ scope: 'mine' })).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });

  it('maps a row including nested charter name and attachment count', async () => {
    const { ctx } = build({
      'maintenance_requests.select': {
        data: [{ ...BASE_ROW, charters: { name: 'Fresno DC4' }, maintenance_request_attachments: [{ count: 3 }] }],
        error: null,
      },
    });
    const [row] = await new MaintenanceRequestsService(ctx).list({ scope: 'mine' });
    expect(row!.siteName).toBe('Fresno DC4');
    expect(row!.photoCount).toBe(3);
    expect(row!.draftOpened).toBe(false);
  });
});

describe('get', () => {
  it('throws not_found when RLS/organization scoping returns no row', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: null, error: null } });
    await expect(new MaintenanceRequestsService(ctx).get('missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('maps every detail field off the real 0314 column names', async () => {
    const { ctx } = build({
      'maintenance_requests.select': {
        data: { ...BASE_ROW, requester_phone_snapshot: '555-0101', outlook_draft_open_count: 2 },
        error: null,
      },
    });
    const detail = await new MaintenanceRequestsService(ctx).get('r1');
    expect(detail.requesterPhone).toBe('555-0101');
    expect(detail.outlookDraftOpenCount).toBe(2);
    expect(detail.archivedAt).toBeNull();
    expect(detail.cancelledAt).toBeNull();
  });
});

describe('update', () => {
  it('requester edits an allowed field on their OWN pre-archive request', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'maintenance_requests.update': { data: null, error: null },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await new MaintenanceRequestsService(ctx).update('r1', { subject: 'Broken chair leg — urgent' });
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.subject).toBe('Broken chair leg — urgent');
    expect(patch.updated_at).toBeTruthy();
  });

  it('forbids editing a request that is not the caller\'s own and the caller lacks manage', async () => {
    const { ctx } = build(
      { 'maintenance_requests.select': { data: { ...BASE_ROW, requester_user_id: 'other-user' }, error: null } },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await expect(
      new MaintenanceRequestsService(ctx).update('r1', { subject: 'Someone else\'s request' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('blocks a requester (non-manager) from editing their own ARCHIVED request', async () => {
    const { ctx } = build(
      {
        'maintenance_requests.select': {
          data: { ...BASE_ROW, archived_at: '2026-01-01T00:00:00Z', status: 'archived' },
          error: null,
        },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await expect(
      new MaintenanceRequestsService(ctx).update('r1', { subject: 'Still broken please fix' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a manage-holder MAY edit another user\'s archived request', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_requests.select': {
          data: { ...BASE_ROW, requester_user_id: 'other-user', archived_at: '2026-01-01T00:00:00Z', status: 'archived' },
          error: null,
        },
        'maintenance_requests.update': { data: null, error: null },
      },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await new MaintenanceRequestsService(ctx).update('r1', { category: 'Electrical' });
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.category).toBe('Electrical');
  });

  it('rejects an invalid patch', async () => {
    const { ctx } = build(
      { 'maintenance_requests.select': { data: BASE_ROW, error: null } },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await expect(new MaintenanceRequestsService(ctx).update('r1', { subject: 'AB' })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });
});

describe('archive', () => {
  it('requires manage — forbidden otherwise', async () => {
    const { ctx } = build({}, { permissions: new Set(['maintenance_requests:submit']) });
    await expect(new MaintenanceRequestsService(ctx).archive('r1')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('MUTATION GUARD (status lockstep, plan C1): sets status="archived" AND archived_at TOGETHER in one write', async () => {
    const { stub, ctx } = build(
      { 'maintenance_requests.update': { data: null, error: null } },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await new MaintenanceRequestsService(ctx).archive('r1');
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    // Both assertions in the SAME object, from the SAME write — a mutation
    // that sets archived_at without status (or vice versa) fails this.
    expect(patch.status).toBe('archived');
    expect(patch.archived_at).toBeTruthy();
    expect(patch.updated_at).toBeTruthy();
  });

  it('audits maintenance_request.archived', async () => {
    const { ctx } = build(
      { 'maintenance_requests.update': { data: null, error: null } },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await new MaintenanceRequestsService(ctx).archive('r1');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'maintenance_request.archived', entityId: 'r1' }),
      ctx,
    );
  });

  it('MUTATION GUARD: rejects when the module is disabled', async () => {
    const { ctx } = build(
      {},
      { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS), permissions: new Set(['maintenance_requests:manage']) },
    );
    await expect(new MaintenanceRequestsService(ctx).archive('r1')).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });
});

describe('cancel', () => {
  it('the requester cancels their OWN pre-archive request (ownership path, not manage)', async () => {
    const { stub, ctx } = build(
      { 'maintenance_requests.select': { data: BASE_ROW, error: null }, 'maintenance_requests.update': { data: null, error: null } },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await new MaintenanceRequestsService(ctx).cancel('r1');
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.status).toBe('cancelled');
    expect(patch.cancelled_at).toBeTruthy();
  });

  it('a manage-holder cancels someone ELSE\'s request', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_requests.select': { data: { ...BASE_ROW, requester_user_id: 'other-user' }, error: null },
        'maintenance_requests.update': { data: null, error: null },
      },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await new MaintenanceRequestsService(ctx).cancel('r1');
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.status).toBe('cancelled');
  });

  it('forbids a non-owner, non-manager from cancelling', async () => {
    const { ctx } = build(
      { 'maintenance_requests.select': { data: { ...BASE_ROW, requester_user_id: 'other-user' }, error: null } },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await expect(new MaintenanceRequestsService(ctx).cancel('r1')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('cannot cancel an already-archived request', async () => {
    const { ctx } = build(
      {
        'maintenance_requests.select': {
          data: { ...BASE_ROW, archived_at: '2026-01-01T00:00:00Z', status: 'archived' },
          error: null,
        },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await expect(new MaintenanceRequestsService(ctx).cancel('r1')).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('assignLocalOwner', () => {
  it('requires manage — forbidden otherwise', async () => {
    const { ctx } = build({}, { permissions: new Set(['maintenance_requests:submit']) });
    await expect(new MaintenanceRequestsService(ctx).assignLocalOwner('r1', 'u2')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('sets local_owner_user_id and audits owner_assigned', async () => {
    const { stub, ctx } = build(
      { 'maintenance_requests.update': { data: null, error: null } },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await new MaintenanceRequestsService(ctx).assignLocalOwner('r1', 'u2');
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.local_owner_user_id).toBe('u2');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'maintenance_request.owner_assigned', entityId: 'r1' }),
      ctx,
    );
  });

  it('can clear the local owner with null', async () => {
    const { stub, ctx } = build(
      { 'maintenance_requests.update': { data: null, error: null } },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await new MaintenanceRequestsService(ctx).assignLocalOwner('r1', null);
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.local_owner_user_id).toBeNull();
  });
});

describe('addNote / listNotes', () => {
  it('addNote requires manage — forbidden otherwise', async () => {
    const { ctx } = build({}, { permissions: new Set(['maintenance_requests:submit']) });
    await expect(new MaintenanceRequestsService(ctx).addNote('r1', 'Called facilities.')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('addNote inserts a note scoped to org + request and audits note_added', async () => {
    const { stub, ctx } = build(
      { 'maintenance_request_notes.insert': { data: { id: 'note1' }, error: null } },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    const res = await new MaintenanceRequestsService(ctx).addNote('r1', '  Called facilities.  ');
    expect(res).toEqual({ id: 'note1' });
    const insert = stub.chainArgs.get('maintenance_request_notes.insert')![0]![0] as Record<string, unknown>;
    expect(insert.organization_id).toBe(ctx.organizationId);
    expect(insert.maintenance_request_id).toBe('r1');
    expect(insert.author_user_id).toBe(ctx.userId);
    expect(insert.body).toBe('Called facilities.');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'maintenance_request.note_added', entityId: 'r1' }),
      ctx,
    );
  });

  it('addNote rejects an empty/whitespace-only body', async () => {
    const { ctx } = build({}, { permissions: new Set(['maintenance_requests:manage']) });
    await expect(new MaintenanceRequestsService(ctx).addNote('r1', '   ')).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('addNote rejects a body over 4,000 characters (0314 CHECK)', async () => {
    const { ctx } = build({}, { permissions: new Set(['maintenance_requests:manage']) });
    await expect(new MaintenanceRequestsService(ctx).addNote('r1', 'x'.repeat(4001))).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('listNotes requires manage — forbidden otherwise (requester never sees internal notes)', async () => {
    const { ctx } = build({}, { permissions: new Set(['maintenance_requests:submit']) });
    await expect(new MaintenanceRequestsService(ctx).listNotes('r1')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('listNotes maps rows in chronological order', async () => {
    const { ctx } = build(
      {
        'maintenance_request_notes.select': {
          data: [{ id: 'n1', author_user_id: 'u2', body: 'Called facilities.', created_at: '2026-08-01T00:00:00Z' }],
          error: null,
        },
      },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    const notes = await new MaintenanceRequestsService(ctx).listNotes('r1');
    expect(notes).toEqual([
      { id: 'n1', authorUserId: 'u2', body: 'Called facilities.', createdAt: '2026-08-01T00:00:00Z' },
    ]);
  });
});

describe('recordDraftOpened', () => {
  it('stamps first-open time once, increments the count, moves saved -> draft_opened, audits draft OPENED (never sent)', async () => {
    const { stub, ctx } = build({
      'maintenance_requests.select': { data: BASE_ROW, error: null },
      'maintenance_requests.update': { data: null, error: null },
    });
    const res = await new MaintenanceRequestsService(ctx).recordDraftOpened('r1');
    expect(res.openCount).toBe(1);
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.status).toBe('draft_opened');
    expect(patch.outlook_draft_open_count).toBe(1);
    expect(patch.outlook_draft_opened_at).toBeTruthy();
    const evt = vi.mocked(audit).mock.calls[0]![0];
    expect(evt.event).toBe('maintenance_request.draft_opened');
    expect(JSON.stringify(evt)).not.toMatch(/\bsent\b|\bticket\b/i);
  });

  it('a SECOND open keeps the original outlook_draft_opened_at and just increments the count', async () => {
    const FIRST_OPEN = '2026-08-01T13:00:00Z';
    const { stub, ctx } = build({
      'maintenance_requests.select': {
        data: { ...BASE_ROW, status: 'draft_opened', outlook_draft_opened_at: FIRST_OPEN, outlook_draft_open_count: 1 },
        error: null,
      },
      'maintenance_requests.update': { data: null, error: null },
    });
    const res = await new MaintenanceRequestsService(ctx).recordDraftOpened('r1');
    expect(res.openCount).toBe(2);
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.outlook_draft_opened_at).toBe(FIRST_OPEN);
    expect(patch.outlook_draft_open_count).toBe(2);
    expect(patch.status).toBe('draft_opened');
  });

  it('MUTATION GUARD: rejects when the module is disabled', async () => {
    const { ctx } = build({}, { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS) });
    await expect(new MaintenanceRequestsService(ctx).recordDraftOpened('r1')).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });
});

describe('emailInput', () => {
  it('snapshots the related item SERVER-side and builds the app URL from the APP_URL convention, never window.location', async () => {
    const { ctx } = build({
      'maintenance_requests.select': {
        data: { ...BASE_ROW, subject: 'AC broken', related_item_id: 'i1', maintenance_request_attachments: [{ count: 2 }] },
        error: null,
      },
      'inventory_items.select': {
        data: { id: 'i1', name: 'HVAC unit', sku: 'HVAC-1', model_number: 'ACX' },
        error: null,
      },
      'organizations.select': { data: { timezone: 'America/Los_Angeles' }, error: null },
    });
    const input = await new MaintenanceRequestsService(ctx).emailInput('r1', { shareUrl: null });
    expect(input.requestNumber).toBe('MR-2026-000042');
    expect(input.relatedItem).toEqual({
      name: 'HVAC unit',
      sku: 'HVAC-1',
      modelNumber: 'ACX',
      url: expect.stringMatching(/^https:\/\/.+\/dashboard\/inventory\/i1$/),
    });
    expect(input.photoCount).toBe(2);
    expect(audit).not.toHaveBeenCalled();
  });

  it('snapshots the related order via requester_name (0044_order_requests.sql — real column, not "requested_for")', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: { ...BASE_ROW, related_order_request_id: 'o1' }, error: null },
      'order_requests.select': {
        data: { id: 'o1', order_number: 49, requester_name: 'Ms. Rivera' },
        error: null,
      },
      'organizations.select': { data: { timezone: null }, error: null },
    });
    const input = await new MaintenanceRequestsService(ctx).emailInput('r1', { shareUrl: null });
    expect(input.relatedOrder).toEqual({
      handle: 'SO-000049',
      requestedFor: 'Ms. Rivera',
      url: expect.stringMatching(/\/dashboard\/orders\/o1$/),
    });
  });

  it('snapshots the related rental via rental_lines -> inventory_items (0131_rentals.sql — real table is rental_lines, not rental_items)', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: { ...BASE_ROW, related_rental_id: 'rent1' }, error: null },
      'rentals.select': {
        data: {
          id: 'rent1',
          borrower_name: 'Coach Alvarez',
          rental_lines: [{ inventory_items: { name: 'Pop-up canopy' } }],
        },
        error: null,
      },
      'organizations.select': { data: { timezone: null }, error: null },
    });
    const input = await new MaintenanceRequestsService(ctx).emailInput('r1', { shareUrl: null });
    expect(input.relatedRental).toEqual({
      itemNames: ['Pop-up canopy'],
      borrowerName: 'Coach Alvarez',
      url: expect.stringMatching(/\/dashboard\/rentals\/rent1$/),
    });
  });

  it('falls back to the ORG_TIMEZONE_DEFAULT when the org has no timezone set', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: BASE_ROW, error: null },
      'organizations.select': { data: { timezone: null }, error: null },
    });
    const input = await new MaintenanceRequestsService(ctx).emailInput('r1', { shareUrl: null });
    expect(typeof input.submittedAtDisplay).toBe('string');
    expect(input.submittedAtDisplay.length).toBeGreaterThan(0);
  });

  it('passes the shareUrl straight through', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: BASE_ROW, error: null },
      'organizations.select': { data: { timezone: null }, error: null },
    });
    const input = await new MaintenanceRequestsService(ctx).emailInput('r1', {
      shareUrl: 'https://stockpilotusa.com/r/abc',
    });
    expect(input.shareUrl).toBe('https://stockpilotusa.com/r/abc');
  });
});
