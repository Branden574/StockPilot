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
// listTimelineEvents (fix wave Important 1) reads audit_logs on the ADMIN
// client, separate from ctx.supabase — same mock seam maintenance-share-
// links.test.ts uses for ITS admin-client writes.
const { createAdminClientMock } = vi.hoisted(() => ({ createAdminClientMock: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: createAdminClientMock,
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

/** Wires a FRESH admin-client stub (the service-role client — separate from
 *  ctx.supabase) for listTimelineEvents' chainArgs assertions. Same helper
 *  shape as maintenance-share-links.test.ts's own buildAdmin. */
function buildAdmin(canned: Parameters<typeof makeSupabaseStub>[0] = {}) {
  const adminStub = makeSupabaseStub(canned);
  createAdminClientMock.mockReturnValue(adminStub.client);
  return adminStub;
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

/** Valid-shaped UUID stand-ins for assignLocalOwner's userId param — I2
 *  adds real uuidSchema validation there, so unlike every other id in this
 *  file ('r1', 'note1', ...), these two specifically must parse as UUIDs. */
const VALID_USER_UUID = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG_USER_UUID = '33333333-3333-4333-8333-333333333333';

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

/** Task 17 / binding constraint 2: the "Report a problem" launch points on
 *  item/order/rental detail pages deep-link into the new-request form with
 *  a query-string id — a HINT the form threads straight into create()'s
 *  input as relatedItemId/relatedOrderRequestId/relatedRentalId. Those
 *  columns' only DB constraint is a bare FK to the target table (0314:125-
 *  128) — it proves the row exists SOMEWHERE, never that it belongs to
 *  THIS org. A crafted deep-link (or a hand-edited form POST) carrying a
 *  foreign-org or fabricated id must never attach that record; it must
 *  degrade gracefully instead — no throw, no cross-org attach, request
 *  still saves. relatedLocationId has no UI producer yet but shares the
 *  exact same insert path, so it gets the same guard.
 *
 *  Fix wave 2 (C1): charterId/warehouseId (0314:117-118) are the SAME
 *  shape — bare cross-org FKs, reachable through the new-request page's own
 *  `?charterId=` deep-link param (readUuidParam only checks UUID shape) —
 *  so they get the identical describe-block treatment below.
 */
describe('create — related-record ids are re-derived against THIS org, never trusted verbatim', () => {
  const ITEM_UUID = '44444444-4444-4444-8444-444444444444';
  const ORDER_UUID = '55555555-5555-4555-8555-555555555555';
  const RENTAL_UUID = '66666666-6666-4666-8666-666666666666';
  const LOCATION_UUID = '77777777-7777-4777-8777-777777777777';
  const CHARTER_UUID = '88888888-8888-4888-8888-888888888888';
  const WAREHOUSE_UUID = '99999999-9999-4999-8999-999999999999';

  it('attaches relatedItemId when the item exists in THIS org, and the org filter is genuinely applied (not just the returned row)', async () => {
    const { stub, ctx } = build({
      'user_profiles.select': { data: PROFILE, error: null },
      'inventory_items.select': { data: { id: ITEM_UUID }, error: null },
      'maintenance_requests.insert': {
        data: { id: 'r1', request_number: 1, created_at: '2026-08-05T16:15:00Z' },
        error: null,
      },
    });
    await new MaintenanceRequestsService(ctx).create({ ...VALID, relatedItemId: ITEM_UUID });
    const insert = stub.chainArgs.get('maintenance_requests.insert')![0]![0] as Record<string, unknown>;
    expect(insert.related_item_id).toBe(ITEM_UUID);
    // I4: without this recorded, the test above would still pass even if the
    // org filter were dropped entirely from the existence check.
    expect(stub.chainArgs.get('inventory_items.select')).toContainEqual(['organization_id', ctx.organizationId]);
    expect(stub.chainArgs.get('inventory_items.select')).toContainEqual(['id', ITEM_UUID]);
  });

  it('MUTATION SELF-CHECK: a well-formed relatedItemId from another org (or a nonexistent one) is DROPPED — never attached, no throw, the request still saves', async () => {
    const { stub, ctx } = build({
      'user_profiles.select': { data: PROFILE, error: null },
      // Not found under THIS org's filter — the mock ignores filters when
      // deciding what to return, so this canned "not found" stands in for
      // "exists, but in a different org" exactly as well as "never existed".
      'inventory_items.select': { data: null, error: null },
      'maintenance_requests.insert': {
        data: { id: 'r1', request_number: 1, created_at: '2026-08-05T16:15:00Z' },
        error: null,
      },
    });
    const res = await new MaintenanceRequestsService(ctx).create({ ...VALID, relatedItemId: ITEM_UUID });
    expect(res.id).toBe('r1');
    const insert = stub.chainArgs.get('maintenance_requests.insert')![0]![0] as Record<string, unknown>;
    expect(insert.related_item_id).toBeNull();
  });

  it('the audit event reflects what was ACTUALLY attached, not what the client requested — has_related_item is false when the id was dropped', async () => {
    const { ctx } = build({
      'user_profiles.select': { data: PROFILE, error: null },
      'inventory_items.select': { data: null, error: null },
      'maintenance_requests.insert': {
        data: { id: 'r1', request_number: 1, created_at: '2026-08-05T16:15:00Z' },
        error: null,
      },
    });
    await new MaintenanceRequestsService(ctx).create({ ...VALID, relatedItemId: ITEM_UUID });
    const payload = vi.mocked(audit).mock.calls[0]![0] as { extra: Record<string, unknown> };
    expect(payload.extra.has_related_item).toBe(false);
  });

  it('attaches relatedOrderRequestId when it exists in THIS org, drops it when it does not', async () => {
    const inOrg = build({
      'user_profiles.select': { data: PROFILE, error: null },
      'order_requests.select': { data: { id: ORDER_UUID }, error: null },
      'maintenance_requests.insert': { data: { id: 'r1', request_number: 1, created_at: 't' }, error: null },
    });
    await new MaintenanceRequestsService(inOrg.ctx).create({ ...VALID, relatedOrderRequestId: ORDER_UUID });
    expect(
      (inOrg.stub.chainArgs.get('maintenance_requests.insert')![0]![0] as Record<string, unknown>)
        .related_order_request_id,
    ).toBe(ORDER_UUID);

    const foreign = build({
      'user_profiles.select': { data: PROFILE, error: null },
      'order_requests.select': { data: null, error: null },
      'maintenance_requests.insert': { data: { id: 'r2', request_number: 2, created_at: 't' }, error: null },
    });
    await new MaintenanceRequestsService(foreign.ctx).create({ ...VALID, relatedOrderRequestId: ORDER_UUID });
    expect(
      (foreign.stub.chainArgs.get('maintenance_requests.insert')![0]![0] as Record<string, unknown>)
        .related_order_request_id,
    ).toBeNull();
  });

  it('attaches relatedRentalId when it exists in THIS org, drops it when it does not', async () => {
    const inOrg = build({
      'user_profiles.select': { data: PROFILE, error: null },
      'rentals.select': { data: { id: RENTAL_UUID }, error: null },
      'maintenance_requests.insert': { data: { id: 'r1', request_number: 1, created_at: 't' }, error: null },
    });
    await new MaintenanceRequestsService(inOrg.ctx).create({ ...VALID, relatedRentalId: RENTAL_UUID });
    expect(
      (inOrg.stub.chainArgs.get('maintenance_requests.insert')![0]![0] as Record<string, unknown>)
        .related_rental_id,
    ).toBe(RENTAL_UUID);

    const foreign = build({
      'user_profiles.select': { data: PROFILE, error: null },
      'rentals.select': { data: null, error: null },
      'maintenance_requests.insert': { data: { id: 'r2', request_number: 2, created_at: 't' }, error: null },
    });
    await new MaintenanceRequestsService(foreign.ctx).create({ ...VALID, relatedRentalId: RENTAL_UUID });
    expect(
      (foreign.stub.chainArgs.get('maintenance_requests.insert')![0]![0] as Record<string, unknown>)
        .related_rental_id,
    ).toBeNull();
  });

  it('attaches relatedLocationId when it exists in THIS org, drops it when it does not (no UI producer yet, but the same insert path)', async () => {
    const inOrg = build({
      'user_profiles.select': { data: PROFILE, error: null },
      'locations.select': { data: { id: LOCATION_UUID }, error: null },
      'maintenance_requests.insert': { data: { id: 'r1', request_number: 1, created_at: 't' }, error: null },
    });
    await new MaintenanceRequestsService(inOrg.ctx).create({ ...VALID, relatedLocationId: LOCATION_UUID });
    expect(
      (inOrg.stub.chainArgs.get('maintenance_requests.insert')![0]![0] as Record<string, unknown>)
        .related_location_id,
    ).toBe(LOCATION_UUID);

    const foreign = build({
      'user_profiles.select': { data: PROFILE, error: null },
      'locations.select': { data: null, error: null },
      'maintenance_requests.insert': { data: { id: 'r2', request_number: 2, created_at: 't' }, error: null },
    });
    await new MaintenanceRequestsService(foreign.ctx).create({ ...VALID, relatedLocationId: LOCATION_UUID });
    expect(
      (foreign.stub.chainArgs.get('maintenance_requests.insert')![0]![0] as Record<string, unknown>)
        .related_location_id,
    ).toBeNull();
  });

  // Fix wave 2 (C1a). charterId/warehouseId are NOT "related StockPilot
  // records" (brief §8) — they are the request's own site/warehouse
  // columns — but the vulnerability shape is identical: a bare cross-org FK
  // (0314:117-118), reachable via the new-request page's `?charterId=`
  // deep-link param, which only UUID-shape-validates before handing it to
  // the form as a default the Site <select> keeps in RHF state even when
  // it renders blank. THE LEAK this closes: a foreign-org charterId
  // persisting onto charter_id, later read back by
  // maintenance-share-links.ts's ADMIN-client embed and rendered on the
  // UNAUTHENTICATED /m/[token] page (C1's other half — see
  // maintenance-share-links.test.ts for that layer's own tests).
  it('MUTATION SELF-CHECK (C1): attaches charterId when it exists in THIS org, drops a FOREIGN-org charterId to null — never attached, no throw, the request still saves', async () => {
    const inOrg = build({
      'user_profiles.select': { data: PROFILE, error: null },
      'charters.select': { data: { id: CHARTER_UUID }, error: null },
      'maintenance_requests.insert': { data: { id: 'r1', request_number: 1, created_at: 't' }, error: null },
    });
    await new MaintenanceRequestsService(inOrg.ctx).create({ ...VALID, charterId: CHARTER_UUID });
    expect(
      (inOrg.stub.chainArgs.get('maintenance_requests.insert')![0]![0] as Record<string, unknown>).charter_id,
    ).toBe(CHARTER_UUID);
    // I4: without these recorded, this test would still pass even if the
    // org filter were dropped entirely from resolveRelatedId's lookup.
    expect(inOrg.stub.chainArgs.get('charters.select')).toContainEqual(['organization_id', inOrg.ctx.organizationId]);
    expect(inOrg.stub.chainArgs.get('charters.select')).toContainEqual(['id', CHARTER_UUID]);

    const foreign = build({
      'user_profiles.select': { data: PROFILE, error: null },
      // Not found under THIS org's filter — stands in for "exists, but in a
      // different org" exactly as well as "never existed" (the mock
      // ignores filters when deciding what to return), matching every
      // other cross-org test in this describe block.
      'charters.select': { data: null, error: null },
      'maintenance_requests.insert': { data: { id: 'r2', request_number: 2, created_at: 't' }, error: null },
    });
    const res = await new MaintenanceRequestsService(foreign.ctx).create({ ...VALID, charterId: CHARTER_UUID });
    expect(res.id).toBe('r2');
    expect(
      (foreign.stub.chainArgs.get('maintenance_requests.insert')![0]![0] as Record<string, unknown>).charter_id,
    ).toBeNull();
  });

  it('MUTATION SELF-CHECK (C1): attaches warehouseId when it exists in THIS org, drops a FOREIGN-org warehouseId to null', async () => {
    const inOrg = build({
      'user_profiles.select': { data: PROFILE, error: null },
      'warehouses.select': { data: { id: WAREHOUSE_UUID }, error: null },
      'maintenance_requests.insert': { data: { id: 'r1', request_number: 1, created_at: 't' }, error: null },
    });
    await new MaintenanceRequestsService(inOrg.ctx).create({ ...VALID, warehouseId: WAREHOUSE_UUID });
    expect(
      (inOrg.stub.chainArgs.get('maintenance_requests.insert')![0]![0] as Record<string, unknown>).warehouse_id,
    ).toBe(WAREHOUSE_UUID);

    const foreign = build({
      'user_profiles.select': { data: PROFILE, error: null },
      'warehouses.select': { data: null, error: null },
      'maintenance_requests.insert': { data: { id: 'r2', request_number: 2, created_at: 't' }, error: null },
    });
    await new MaintenanceRequestsService(foreign.ctx).create({ ...VALID, warehouseId: WAREHOUSE_UUID });
    expect(
      (foreign.stub.chainArgs.get('maintenance_requests.insert')![0]![0] as Record<string, unknown>).warehouse_id,
    ).toBeNull();
  });

  it('never queries a related-record table at all when no id was supplied — VALID alone stays a single-round-trip create', async () => {
    const { stub, ctx } = build({
      'user_profiles.select': { data: PROFILE, error: null },
      'maintenance_requests.insert': { data: { id: 'r1', request_number: 1, created_at: 't' }, error: null },
    });
    await new MaintenanceRequestsService(ctx).create(VALID);
    expect(stub.chainArgs.has('inventory_items.select')).toBe(false);
    expect(stub.chainArgs.has('order_requests.select')).toBe(false);
    expect(stub.chainArgs.has('rentals.select')).toBe(false);
    expect(stub.chainArgs.has('locations.select')).toBe(false);
    // Fix wave 2 (C1): charterId/warehouseId join the same no-op-when-absent
    // contract — VALID carries neither, so neither table is even queried.
    expect(stub.chainArgs.has('charters.select')).toBe(false);
    expect(stub.chainArgs.has('warehouses.select')).toBe(false);
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

  // Was "rejects when the module is disabled" (asserted `module_disabled`).
  // Fix wave 1 (controller adjudication on 0314 Q3): list() is a READ, and
  // 0314's own SELECT-policy comment says history stays visible after a
  // disable — that made the old assertion's MEANING wrong, not just its
  // code path. Re-pointed to prove the opposite: this is now the pin that
  // keeps the SQL comment true.
  it('READ-GATE PIN (0314 Q3): succeeds with the module DISABLED — request history stays visible after a disable', async () => {
    const { ctx } = build(
      { 'maintenance_requests.select': { data: [], error: null } },
      { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS) },
    );
    await expect(new MaintenanceRequestsService(ctx).list({ scope: 'mine' })).resolves.toEqual([]);
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
  it('throws not_found when RLS/organization scoping returns no row, and pins the org + id filters behind it', async () => {
    const { stub, ctx } = build({ 'maintenance_requests.select': { data: null, error: null } });
    await expect(new MaintenanceRequestsService(ctx).get('missing')).rejects.toMatchObject({ code: 'not_found' });
    // I3: without these two recorded filters, this test would still pass
    // even if get() dropped its org/id scoping entirely — the mock ignores
    // filters and just returns whatever `data` was canned regardless of
    // what was actually asked for.
    expect(stub.chainArgs.get('maintenance_requests.select')).toContainEqual(['organization_id', ctx.organizationId]);
    expect(stub.chainArgs.get('maintenance_requests.select')).toContainEqual(['id', 'missing']);
  });

  it('I1: an unauthorized employee (no read_all/manage, not the requester) cannot view someone else\'s request — not_found, not forbidden', async () => {
    const { ctx } = build(
      { 'maintenance_requests.select': { data: { ...BASE_ROW, requester_user_id: 'other-user' }, error: null } },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    // not_found, never forbidden: an unauthorized caller must not learn
    // that a foreign request even exists.
    await expect(new MaintenanceRequestsService(ctx).get('r1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('I1: a read_all holder CAN view a request that is not their own', async () => {
    const { ctx } = build(
      { 'maintenance_requests.select': { data: { ...BASE_ROW, requester_user_id: 'other-user' }, error: null } },
      { permissions: new Set(['maintenance_requests:read_all']) },
    );
    await expect(new MaintenanceRequestsService(ctx).get('r1')).resolves.toMatchObject({ id: 'r1' });
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

  it('READ-GATE PIN (0314 Q3): succeeds with the module DISABLED — request history stays visible after a disable', async () => {
    const { ctx } = build(
      { 'maintenance_requests.select': { data: BASE_ROW, error: null } },
      { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS) },
    );
    await expect(new MaintenanceRequestsService(ctx).get('r1')).resolves.toMatchObject({ id: 'r1' });
  });
});

describe('update', () => {
  it('requester edits an allowed field on their OWN pre-archive request, pinning the org + id filters on the write', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await new MaintenanceRequestsService(ctx).update('r1', { subject: 'Broken chair leg — urgent' });
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.subject).toBe('Broken chair leg — urgent');
    expect(patch.updated_at).toBeTruthy();
    // I3: the org + id filters that scope this write — without them
    // recorded, this test would still pass even if update() dropped its
    // org/id `.eq()` scoping entirely.
    expect(stub.chainArgs.get('maintenance_requests.update')).toContainEqual(['organization_id', ctx.organizationId]);
    expect(stub.chainArgs.get('maintenance_requests.update')).toContainEqual(['id', 'r1']);
  });

  it('I1: a caller with no view access to someone else\'s request gets not_found before update() even reaches its own gate', async () => {
    const { ctx } = build(
      { 'maintenance_requests.select': { data: { ...BASE_ROW, requester_user_id: 'other-user' }, error: null } },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    // Was 'forbidden' pre-I1: get()'s own read-scope check (no read_all/
    // manage, not the requester) now fires first and reports not_found —
    // an unauthorized caller must not learn a foreign request even exists.
    await expect(
      new MaintenanceRequestsService(ctx).update('r1', { subject: 'Someone else\'s request' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a read_all holder who is not the requester and lacks manage can VIEW but not EDIT — forbidden from update()\'s own gate', async () => {
    const { ctx } = build(
      { 'maintenance_requests.select': { data: { ...BASE_ROW, requester_user_id: 'other-user' }, error: null } },
      { permissions: new Set(['maintenance_requests:read_all']) },
    );
    // read_all satisfies get()'s I1 view check, so the rejection here
    // proves update()'s OWN isManager/isRequester decision is still reached
    // and still enforced — not just subsumed by get()'s broader gate.
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
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
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

  it('C2 PHANTOM-SUCCESS GUARD: a zero-row update throws conflict instead of reporting a false success', async () => {
    const { ctx } = build(
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'maintenance_requests.update': { data: null, error: null },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await expect(
      new MaintenanceRequestsService(ctx).update('r1', { subject: 'Still trying to fix it' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // A phantom success would have audited a write that never happened.
    expect(audit).not.toHaveBeenCalled();
  });

  it('I4 MUTATION GUARD: rejects when the module is disabled', async () => {
    const { ctx } = build({}, { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS), permissions: new Set(['maintenance_requests:manage']) });
    await expect(new MaintenanceRequestsService(ctx).update('r1', { subject: 'x' })).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });
});

/**
 * Fix wave 1 (controller re-adjudication of Task 17's "not reachable through
 * any shipped UI" call): the shipped PATCH route
 * (api/v1/maintenance-requests/[id]/route.ts) forwards its body straight to
 * update() with NO re-parse of its own — MaintenanceRequestsService.update()
 * owns the schema AND the field allow-list per that route's own doc comment.
 * So ANY Bearer-token holder who can PATCH their own (or, as a manager, any)
 * request can reach these four fields directly — no crafted deep-link
 * required, unlike create()'s query-string vector. Before this fix, update()
 * wrote relatedItemId/relatedOrderRequestId/relatedRentalId/relatedLocationId
 * straight through COLUMN_FOR_FIELD with no org check at all, so a
 * well-formed foreign-org (or fabricated) uuid persisted verbatim. These
 * tests assert on the RECORDED update payload (stub.chainArgs), never the
 * return value — update() returns void, and a test that only checked
 * "resolves" would pass whether or not the id was actually scrubbed
 * (test-hygiene landmine #37, same rationale as the create() describe block
 * above).
 */
describe('update — related-record ids are re-derived against THIS org, never trusted verbatim (fix wave 1)', () => {
  const ITEM_UUID = '44444444-4444-4444-8444-444444444444';
  const ORDER_UUID = '55555555-5555-4555-8555-555555555555';
  const RENTAL_UUID = '66666666-6666-4666-8666-666666666666';
  const LOCATION_UUID = '77777777-7777-4777-8777-777777777777';
  const CHARTER_UUID = '88888888-8888-4888-8888-888888888888';
  const WAREHOUSE_UUID = '99999999-9999-4999-8999-999999999999';

  it('a FOREIGN-org relatedItemId is dropped to null in the persisted patch — no throw, the rest of the patch still applies', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        // Not found under THIS org's filter — stands in for "exists, but in
        // a different org" exactly as well as "never existed" (the mock
        // ignores filters when deciding what to return), matching the
        // identical create()-side test's own comment.
        'inventory_items.select': { data: null, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await new MaintenanceRequestsService(ctx).update('r1', {
      subject: 'Still broken please fix',
      relatedItemId: ITEM_UUID,
    });
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.related_item_id).toBeNull();
    // The rest of the patch is unaffected by the dropped related id.
    expect(patch.subject).toBe('Still broken please fix');
  });

  it('a VALID same-org relatedItemId persists unchanged, and the org filter is genuinely applied (not just the returned row)', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'inventory_items.select': { data: { id: ITEM_UUID }, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await new MaintenanceRequestsService(ctx).update('r1', { relatedItemId: ITEM_UUID });
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.related_item_id).toBe(ITEM_UUID);
    // I4: without these recorded, this test would still pass even if the
    // org filter were dropped entirely from resolveRelatedId's lookup.
    expect(stub.chainArgs.get('inventory_items.select')).toContainEqual(['organization_id', ctx.organizationId]);
    expect(stub.chainArgs.get('inventory_items.select')).toContainEqual(['id', ITEM_UUID]);
  });

  it('a FOREIGN-org relatedOrderRequestId is dropped to null (same guard, order_requests table)', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'order_requests.select': { data: null, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await new MaintenanceRequestsService(ctx).update('r1', { relatedOrderRequestId: ORDER_UUID });
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.related_order_request_id).toBeNull();
  });

  it('a VALID same-org relatedRentalId persists unchanged (same guard, rentals table)', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'rentals.select': { data: { id: RENTAL_UUID }, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await new MaintenanceRequestsService(ctx).update('r1', { relatedRentalId: RENTAL_UUID });
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.related_rental_id).toBe(RENTAL_UUID);
  });

  it('relatedLocationId gets the identical guard (no UI producer yet, but the same update path)', async () => {
    const foreign = build(
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'locations.select': { data: null, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await new MaintenanceRequestsService(foreign.ctx).update('r1', { relatedLocationId: LOCATION_UUID });
    expect(
      (foreign.stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>)
        .related_location_id,
    ).toBeNull();

    const inOrg = build(
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'locations.select': { data: { id: LOCATION_UUID }, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await new MaintenanceRequestsService(inOrg.ctx).update('r1', { relatedLocationId: LOCATION_UUID });
    expect(
      (inOrg.stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>)
        .related_location_id,
    ).toBe(LOCATION_UUID);
  });

  it('an UNKNOWN (nonexistent) relatedItemId degrades to null without throwing', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'inventory_items.select': { data: null, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await expect(
      new MaintenanceRequestsService(ctx).update('r1', { relatedItemId: ITEM_UUID }),
    ).resolves.toBeUndefined();
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.related_item_id).toBeNull();
  });

  it('never queries a related-record table when the patch carries none of the four related-id fields — a plain field edit stays scoped', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await new MaintenanceRequestsService(ctx).update('r1', { subject: 'Broken chair leg — urgent' });
    expect(stub.chainArgs.has('inventory_items.select')).toBe(false);
    expect(stub.chainArgs.has('order_requests.select')).toBe(false);
    expect(stub.chainArgs.has('rentals.select')).toBe(false);
    expect(stub.chainArgs.has('locations.select')).toBe(false);
    // Fix wave 2 (C1): charterId/warehouseId join the same no-op-when-absent
    // contract.
    expect(stub.chainArgs.has('charters.select')).toBe(false);
    expect(stub.chainArgs.has('warehouses.select')).toBe(false);
  });

  // Fix wave 2 (C1a) — PATCH is the WIDER exposure than create()'s
  // deep-link: this route forwards the body with no re-parse of its own
  // (see the route's own doc comment), so any Bearer-token holder patching
  // their own (or, as a manager, any) request could already carry a
  // foreign-org charterId/warehouseId straight through, no crafted deep-link
  // required.
  it('MUTATION SELF-CHECK (C1): a FOREIGN-org charterId is dropped to null in the persisted patch — no throw, the rest of the patch still applies', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'charters.select': { data: null, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await new MaintenanceRequestsService(ctx).update('r1', {
      subject: 'Still broken please fix',
      charterId: CHARTER_UUID,
    });
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.charter_id).toBeNull();
    expect(patch.subject).toBe('Still broken please fix');
  });

  it('a VALID same-org charterId persists unchanged, and the org filter is genuinely applied (not just the returned row)', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'charters.select': { data: { id: CHARTER_UUID }, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await new MaintenanceRequestsService(ctx).update('r1', { charterId: CHARTER_UUID });
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.charter_id).toBe(CHARTER_UUID);
    expect(stub.chainArgs.get('charters.select')).toContainEqual(['organization_id', ctx.organizationId]);
    expect(stub.chainArgs.get('charters.select')).toContainEqual(['id', CHARTER_UUID]);
  });

  it('MUTATION SELF-CHECK (C1): a FOREIGN-org warehouseId is dropped to null; a VALID same-org warehouseId persists unchanged', async () => {
    const foreign = build(
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'warehouses.select': { data: null, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await new MaintenanceRequestsService(foreign.ctx).update('r1', { warehouseId: WAREHOUSE_UUID });
    expect(
      (foreign.stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>).warehouse_id,
    ).toBeNull();

    const inOrg = build(
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'warehouses.select': { data: { id: WAREHOUSE_UUID }, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await new MaintenanceRequestsService(inOrg.ctx).update('r1', { warehouseId: WAREHOUSE_UUID });
    expect(
      (inOrg.stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>).warehouse_id,
    ).toBe(WAREHOUSE_UUID);
  });
});

describe('archive', () => {
  it('requires manage — forbidden otherwise', async () => {
    const { ctx } = build({}, { permissions: new Set(['maintenance_requests:submit']) });
    await expect(new MaintenanceRequestsService(ctx).archive('r1')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('MUTATION GUARD (status lockstep, plan C1): sets status="archived" AND archived_at TOGETHER in one write, pinning the org + id filters', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_requests.select': { data: { cancelled_at: null }, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await new MaintenanceRequestsService(ctx).archive('r1');
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    // Both assertions in the SAME object, from the SAME write — a mutation
    // that sets archived_at without status (or vice versa) fails this.
    expect(patch.status).toBe('archived');
    expect(patch.archived_at).toBeTruthy();
    expect(patch.updated_at).toBeTruthy();
    // I3: the org + id filters that scope this write.
    expect(stub.chainArgs.get('maintenance_requests.update')).toContainEqual(['organization_id', ctx.organizationId]);
    expect(stub.chainArgs.get('maintenance_requests.update')).toContainEqual(['id', 'r1']);
  });

  it('audits maintenance_request.archived', async () => {
    const { ctx } = build(
      {
        'maintenance_requests.select': { data: { cancelled_at: null }, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await new MaintenanceRequestsService(ctx).archive('r1');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'maintenance_request.archived', entityId: 'r1' }),
      ctx,
    );
  });

  it('M1: refuses to archive an already-CANCELLED request instead of stamping both closed states on one row', async () => {
    const { ctx } = build(
      {
        'maintenance_requests.select': { data: { cancelled_at: '2026-01-01T00:00:00Z' }, error: null },
        // A SUCCEEDING update fixture, deliberately: without it the mock's
        // zero-row default lets the generic C2 guard throw the same
        // 'conflict' this test expects, masking deletion of the specific
        // already-cancelled guard (re-review mutation T survived on that).
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await expect(new MaintenanceRequestsService(ctx).archive('r1')).rejects.toMatchObject({ code: 'conflict' });
    expect(audit).not.toHaveBeenCalled();
  });

  it('archive on a stale/foreign id throws not_found (no existence check existed before this fix)', async () => {
    const { ctx } = build(
      { 'maintenance_requests.select': { data: null, error: null } },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await expect(new MaintenanceRequestsService(ctx).archive('missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('C2 PHANTOM-SUCCESS GUARD: a zero-row update (stale/foreign id at write time) throws instead of reporting a false success', async () => {
    const { ctx } = build(
      {
        'maintenance_requests.select': { data: { cancelled_at: null }, error: null },
        'maintenance_requests.update': { data: null, error: null },
      },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await expect(new MaintenanceRequestsService(ctx).archive('r1')).rejects.toMatchObject({ code: 'conflict' });
    // A phantom success would have audited a write that never happened.
    expect(audit).not.toHaveBeenCalled();
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
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
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
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await new MaintenanceRequestsService(ctx).cancel('r1');
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.status).toBe('cancelled');
  });

  it('I1: a caller with no view access to someone else\'s request gets not_found before cancel() even reaches its own gate', async () => {
    const { ctx } = build(
      { 'maintenance_requests.select': { data: { ...BASE_ROW, requester_user_id: 'other-user' }, error: null } },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    // Was 'forbidden' pre-I1 — see the identical note on update()'s test.
    await expect(new MaintenanceRequestsService(ctx).cancel('r1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a read_all holder who is not the requester and lacks manage can VIEW but not CANCEL — forbidden from cancel()\'s own gate', async () => {
    const { ctx } = build(
      { 'maintenance_requests.select': { data: { ...BASE_ROW, requester_user_id: 'other-user' }, error: null } },
      { permissions: new Set(['maintenance_requests:read_all']) },
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

  it('C2 PHANTOM-SUCCESS GUARD: a zero-row update throws conflict instead of reporting a false success', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: BASE_ROW, error: null },
      'maintenance_requests.update': { data: null, error: null },
    });
    await expect(new MaintenanceRequestsService(ctx).cancel('r1')).rejects.toMatchObject({ code: 'conflict' });
    expect(audit).not.toHaveBeenCalled();
  });

  it('I4 MUTATION GUARD: rejects when the module is disabled', async () => {
    const { ctx } = build({}, { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS), permissions: new Set(['maintenance_requests:manage']) });
    await expect(new MaintenanceRequestsService(ctx).cancel('r1')).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });
});

describe('assignLocalOwner', () => {
  it('requires manage — forbidden otherwise', async () => {
    const { ctx } = build({}, { permissions: new Set(['maintenance_requests:submit']) });
    await expect(new MaintenanceRequestsService(ctx).assignLocalOwner('r1', VALID_USER_UUID)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('sets local_owner_user_id and audits owner_assigned, pinning the org + id filters on the write', async () => {
    const { stub, ctx } = build(
      {
        'organization_members.select': { data: { id: 'm1' }, error: null },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await new MaintenanceRequestsService(ctx).assignLocalOwner('r1', VALID_USER_UUID);
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.local_owner_user_id).toBe(VALID_USER_UUID);
    // I3: the org + id filters that scope this write.
    expect(stub.chainArgs.get('maintenance_requests.update')).toContainEqual(['organization_id', ctx.organizationId]);
    expect(stub.chainArgs.get('maintenance_requests.update')).toContainEqual(['id', 'r1']);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'maintenance_request.owner_assigned', entityId: 'r1' }),
      ctx,
    );
  });

  it('can clear the local owner with null (no uuid/membership check needed to clear)', async () => {
    const { stub, ctx } = build(
      { 'maintenance_requests.update': { data: { id: 'r1' }, error: null } },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await new MaintenanceRequestsService(ctx).assignLocalOwner('r1', null);
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.local_owner_user_id).toBeNull();
  });

  it('I2: rejects a garbage (non-uuid) userId with validation_error, never an opaque DB error', async () => {
    const { ctx } = build({}, { permissions: new Set(['maintenance_requests:manage']) });
    await expect(new MaintenanceRequestsService(ctx).assignLocalOwner('r1', 'not-a-uuid')).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('I2: rejects a well-formed uuid that is not an accepted member of THIS organization (cross-org tampering guard)', async () => {
    const { ctx } = build(
      { 'organization_members.select': { data: null, error: null } },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await expect(
      new MaintenanceRequestsService(ctx).assignLocalOwner('r1', OTHER_ORG_USER_UUID),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('C2 PHANTOM-SUCCESS GUARD: a zero-row update throws not_found instead of reporting a false success', async () => {
    const { ctx } = build(
      {
        'organization_members.select': { data: { id: 'm1' }, error: null },
        'maintenance_requests.update': { data: null, error: null },
      },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await expect(
      new MaintenanceRequestsService(ctx).assignLocalOwner('r1', VALID_USER_UUID),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(audit).not.toHaveBeenCalled();
  });

  it('MUTATION GUARD: rejects when the module is disabled', async () => {
    const { ctx } = build(
      {},
      { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS), permissions: new Set(['maintenance_requests:manage']) },
    );
    await expect(new MaintenanceRequestsService(ctx).assignLocalOwner('r1', null)).rejects.toMatchObject({
      code: 'module_disabled',
    });
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
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'maintenance_request_notes.insert': { data: { id: 'note1' }, error: null },
      },
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

  it('addNote M3: rejects a foreign/stale parent id with not_found, not an opaque insert error', async () => {
    const { ctx } = build(
      {
        'maintenance_requests.select': { data: null, error: null },
        'maintenance_request_notes.insert': { data: { id: 'note1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    await expect(new MaintenanceRequestsService(ctx).addNote('missing', 'Called facilities.')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('addNote MUTATION GUARD: rejects when the module is disabled', async () => {
    const { ctx } = build(
      {},
      { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS), permissions: new Set(['maintenance_requests:manage']) },
    );
    await expect(new MaintenanceRequestsService(ctx).addNote('r1', 'Called facilities.')).rejects.toMatchObject({
      code: 'module_disabled',
    });
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

  it('listNotes maps rows in chronological order and pins the org + maintenance_request_id filters', async () => {
    const { stub, ctx } = build(
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
    // I3: without these two recorded filters, this test would still pass
    // even if listNotes() dropped its org/parent scoping entirely.
    expect(stub.chainArgs.get('maintenance_request_notes.select')).toContainEqual([
      'organization_id',
      ctx.organizationId,
    ]);
    expect(stub.chainArgs.get('maintenance_request_notes.select')).toContainEqual(['maintenance_request_id', 'r1']);
  });

  it('listNotes READ-GATE PIN (0314 Q3): succeeds with the module DISABLED — notes are part of request history too', async () => {
    const { ctx } = build(
      { 'maintenance_request_notes.select': { data: [], error: null } },
      {
        enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS),
        permissions: new Set(['maintenance_requests:manage']),
      },
    );
    await expect(new MaintenanceRequestsService(ctx).listNotes('r1')).resolves.toEqual([]);
  });
});

describe('recordDraftOpened', () => {
  it('stamps first-open time once, increments the count, moves saved -> draft_opened, audits draft OPENED (never sent), pins org + id filters', async () => {
    const { stub, ctx } = build({
      'maintenance_requests.select': { data: BASE_ROW, error: null },
      'maintenance_requests.update': { data: { id: 'r1' }, error: null },
    });
    const res = await new MaintenanceRequestsService(ctx).recordDraftOpened('r1');
    expect(res.openCount).toBe(1);
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.status).toBe('draft_opened');
    expect(patch.outlook_draft_open_count).toBe(1);
    expect(patch.outlook_draft_opened_at).toBeTruthy();
    // I3: the org + id filters that scope this write.
    expect(stub.chainArgs.get('maintenance_requests.update')).toContainEqual(['organization_id', ctx.organizationId]);
    expect(stub.chainArgs.get('maintenance_requests.update')).toContainEqual(['id', 'r1']);
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
      'maintenance_requests.update': { data: { id: 'r1' }, error: null },
    });
    const res = await new MaintenanceRequestsService(ctx).recordDraftOpened('r1');
    expect(res.openCount).toBe(2);
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.outlook_draft_opened_at).toBe(FIRST_OPEN);
    expect(patch.outlook_draft_open_count).toBe(2);
    expect(patch.status).toBe('draft_opened');
  });

  it('C1 AUTHZ GUARD: a read_all-only member (neither requester nor manage-holder) cannot record a draft-open — forbidden', async () => {
    const { ctx } = build(
      { 'maintenance_requests.select': { data: { ...BASE_ROW, requester_user_id: 'other-user' }, error: null } },
      { permissions: new Set(['maintenance_requests:read_all']) },
    );
    // read_all satisfies get()'s I1 view check (canReadAll), so this proves
    // recordDraftOpened()'s OWN explicit manage-vs-requester decision is the
    // thing doing the blocking here — get()'s broader gate would let this
    // caller straight through.
    await expect(new MaintenanceRequestsService(ctx).recordDraftOpened('r1')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('C1 CLOSED-STATE GUARD: the requester cannot record a draft-open on their OWN archived request', async () => {
    const { ctx } = build(
      {
        'maintenance_requests.select': {
          data: { ...BASE_ROW, archived_at: '2026-01-01T00:00:00Z', status: 'archived' },
          error: null,
        },
        // Succeeding update fixture on purpose — see the M1 archive test:
        // without it, deleting the closed-state guard still throws the same
        // 'conflict' via the generic C2 zero-row guard (mutation G survived).
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await expect(new MaintenanceRequestsService(ctx).recordDraftOpened('r1')).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('a manage-holder MAY record a draft-open on an archived request (closed-state guard is requester-only, mirrors RLS)', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_requests.select': {
          data: { ...BASE_ROW, requester_user_id: 'other-user', archived_at: '2026-01-01T00:00:00Z', status: 'archived' },
          error: null,
        },
        'maintenance_requests.update': { data: { id: 'r1' }, error: null },
      },
      { permissions: new Set(['maintenance_requests:manage']) },
    );
    const res = await new MaintenanceRequestsService(ctx).recordDraftOpened('r1');
    expect(res.openCount).toBe(1);
    const patch = stub.chainArgs.get('maintenance_requests.update')![0]![0] as Record<string, unknown>;
    expect(patch.status).toBe('archived');
  });

  it('C2 PHANTOM-SUCCESS GUARD: a zero-row update throws conflict instead of returning an openCount that was never persisted', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: BASE_ROW, error: null },
      'maintenance_requests.update': { data: null, error: null },
    });
    await expect(new MaintenanceRequestsService(ctx).recordDraftOpened('r1')).rejects.toMatchObject({
      code: 'conflict',
    });
    // Audit only fires AFTER the row-count guard — a phantom mutation must
    // never be recorded as though it happened.
    expect(audit).not.toHaveBeenCalled();
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
    const { stub, ctx } = build({
      'maintenance_requests.select': {
        data: { ...BASE_ROW, subject: 'AC broken', related_item_id: 'i1', maintenance_request_attachments: [{ count: 2 }] },
        error: null,
      },
      'inventory_items.select': {
        data: {
          id: 'i1',
          name: 'HVAC unit',
          sku: 'HVAC-1',
          barcode: '012345678905',
          model_number: 'ACX',
          locations: { name: 'Room 204 Closet', warehouses: { name: 'Fresno Distribution Center' } },
        },
        error: null,
      },
      'organizations.select': { data: { timezone: 'America/Los_Angeles' }, error: null },
    });
    const input = await new MaintenanceRequestsService(ctx).emailInput('r1', { shareUrl: null });
    expect(input.requestNumber).toBe('MR-2026-000042');
    // Master brief §8's full item field list (audit Q6: NO asset tag — no
    // such column/key exists anywhere in this object).
    expect(input.relatedItem).toEqual({
      name: 'HVAC unit',
      sku: 'HVAC-1',
      barcode: '012345678905',
      modelNumber: 'ACX',
      warehouseName: 'Fresno Distribution Center',
      locationName: 'Room 204 Closet',
      url: expect.stringMatching(/^https:\/\/.+\/dashboard\/inventory\/i1$/),
    });
    expect(input.photoCount).toBe(2);
    expect(audit).not.toHaveBeenCalled();
    // I3: the related-item org filter — without it recorded, this test
    // would still pass even if emailInput() dropped its org scoping on the
    // inventory_items lookup entirely.
    expect(stub.chainArgs.get('inventory_items.select')).toContainEqual(['organization_id', ctx.organizationId]);
    expect(stub.chainArgs.get('inventory_items.select')).toContainEqual(['id', 'i1']);
  });

  it('MUTATION SELF-CHECK: an item with no primary location degrades to null warehouse/location — never throws, never [object Object]', async () => {
    const { ctx } = build({
      'maintenance_requests.select': {
        data: { ...BASE_ROW, related_item_id: 'i1' },
        error: null,
      },
      'inventory_items.select': {
        data: { id: 'i1', name: 'Loose HVAC unit', sku: null, barcode: null, model_number: null, locations: null },
        error: null,
      },
      'organizations.select': { data: { timezone: null }, error: null },
    });
    const input = await new MaintenanceRequestsService(ctx).emailInput('r1', { shareUrl: null });
    expect(input.relatedItem).toEqual({
      name: 'Loose HVAC unit',
      sku: null,
      barcode: null,
      modelNumber: null,
      warehouseName: null,
      locationName: null,
      url: expect.stringMatching(/^https:\/\/.+\/dashboard\/inventory\/i1$/),
    });
  });

  it('snapshots the related order via requester_name (0044_order_requests.sql — real column, not "requested_for"), plus §8\'s delivery site + relevant item names (fix wave 2 / I2)', async () => {
    const { stub, ctx } = build({
      'maintenance_requests.select': { data: { ...BASE_ROW, related_order_request_id: 'o1' }, error: null },
      'order_requests.select': {
        data: {
          id: 'o1',
          order_number: 49,
          requester_name: 'Ms. Rivera',
          charters: { name: 'Fresno Learning Center' },
          order_request_lines: [
            { inventory_items: { name: 'Copy paper' } },
            { inventory_items: { name: 'Dry erase markers' } },
          ],
        },
        error: null,
      },
      'organizations.select': { data: { timezone: null }, error: null },
    });
    const input = await new MaintenanceRequestsService(ctx).emailInput('r1', { shareUrl: null });
    expect(input.relatedOrder).toEqual({
      handle: 'SO-000049',
      requestedFor: 'Ms. Rivera',
      deliverySiteName: 'Fresno Learning Center',
      itemNames: ['Copy paper', 'Dry erase markers'],
      totalItemCount: 2,
      url: expect.stringMatching(/\/dashboard\/orders\/o1$/),
    });
    // I3-style filter pin: this is still the ONE order_requests query (an
    // extended embed, not a second round trip) — org + id scoping intact.
    expect(stub.chainArgs.get('order_requests.select')).toContainEqual(['organization_id', ctx.organizationId]);
    expect(stub.chainArgs.get('order_requests.select')).toContainEqual(['id', 'o1']);
  });

  it('MUTATION SELF-CHECK (I2): an order with no delivery charter and no lines degrades to null site / empty item list — never throws, never [object Object]', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: { ...BASE_ROW, related_order_request_id: 'o1' }, error: null },
      'order_requests.select': {
        data: { id: 'o1', order_number: 49, requester_name: 'Ms. Rivera', charters: null, order_request_lines: [] },
        error: null,
      },
      'organizations.select': { data: { timezone: null }, error: null },
    });
    const input = await new MaintenanceRequestsService(ctx).emailInput('r1', { shareUrl: null });
    expect(input.relatedOrder).toEqual({
      handle: 'SO-000049',
      requestedFor: 'Ms. Rivera',
      deliverySiteName: null,
      itemNames: [],
      totalItemCount: 0,
      url: expect.stringMatching(/\/dashboard\/orders\/o1$/),
    });
  });

  it('MUTATION GUARD (I2): a line whose item was deleted (inventory_items null) is skipped, never rendered as a blank/undefined name', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: { ...BASE_ROW, related_order_request_id: 'o1' }, error: null },
      'order_requests.select': {
        data: {
          id: 'o1',
          order_number: 49,
          requester_name: 'Ms. Rivera',
          charters: null,
          order_request_lines: [{ inventory_items: null }, { inventory_items: { name: 'Copy paper' } }],
        },
        error: null,
      },
      'organizations.select': { data: { timezone: null }, error: null },
    });
    const input = await new MaintenanceRequestsService(ctx).emailInput('r1', { shareUrl: null });
    expect(input.relatedOrder?.itemNames).toEqual(['Copy paper']);
  });

  it('MUTATION GUARD (I2): the item-name list is capped at MAX_RELATED_ORDER_ITEM_NAMES (10) — a 15-line order still hands the builder exactly 10 names', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: { ...BASE_ROW, related_order_request_id: 'o1' }, error: null },
      'order_requests.select': {
        data: {
          id: 'o1',
          order_number: 49,
          requester_name: 'Ms. Rivera',
          charters: null,
          order_request_lines: Array.from({ length: 15 }, (_, i) => ({
            inventory_items: { name: `Item ${i + 1}` },
          })),
        },
        error: null,
      },
      'organizations.select': { data: { timezone: null }, error: null },
    });
    const input = await new MaintenanceRequestsService(ctx).emailInput('r1', { shareUrl: null });
    expect(input.relatedOrder?.itemNames).toHaveLength(10);
    expect(input.relatedOrder?.itemNames).toEqual(Array.from({ length: 10 }, (_, i) => `Item ${i + 1}`));
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

  it('READ-GATE PIN (0314 Q3): succeeds with the module DISABLED — renders text off data get() already exposes post-disable', async () => {
    const { ctx } = build(
      {
        'maintenance_requests.select': { data: BASE_ROW, error: null },
        'organizations.select': { data: { timezone: null }, error: null },
      },
      { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS) },
    );
    await expect(new MaintenanceRequestsService(ctx).emailInput('r1', { shareUrl: null })).resolves.toMatchObject({
      requestNumber: expect.any(String),
    });
  });
});

describe('listTimelineEvents (fix wave Important 1 — audit-log-driven activity rows)', () => {
  it('a viewer who cannot see the request never reaches the admin audit read — get() throws not_found FIRST, and the admin client is never even constructed', async () => {
    const { ctx } = build(
      { 'maintenance_requests.select': { data: { ...BASE_ROW, requester_user_id: 'other-user' }, error: null } },
      { permissions: new Set(['maintenance_requests:submit']) },
    );
    await expect(new MaintenanceRequestsService(ctx).listTimelineEvents('r1')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it('scopes the admin audit read by BOTH entity_id (via metadata->>entity_id) and organization_id (chainArgs-pinned) — MUTATION GUARD: dropping either filter is exactly the "unscoped admin read" this pins against', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: BASE_ROW, error: null } });
    const adminStub = buildAdmin({ 'audit_logs.select': { data: [], error: null } });

    await new MaintenanceRequestsService(ctx).listTimelineEvents('r1');

    const args = adminStub.chainArgs.get('audit_logs.select')!;
    expect(args).toContainEqual(['organization_id', ctx.organizationId]);
    expect(args).toContainEqual(['metadata->>entity_id', 'eq', 'r1']);
  });

  it('the query itself is narrowed to only the two allow-listed maintenance_request.* event kinds', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: BASE_ROW, error: null } });
    const adminStub = buildAdmin({ 'audit_logs.select': { data: [], error: null } });

    await new MaintenanceRequestsService(ctx).listTimelineEvents('r1');

    const args = adminStub.chainArgs.get('audit_logs.select')!;
    expect(args).toContainEqual(['event', ['maintenance_request.attachment_added', 'maintenance_request.owner_assigned']]);
  });

  it('MUTATION GUARD — an arbitrary, non-allow-listed event returned by the query (the mock stub does not itself apply .in()/.filter()) is dropped by the JS-side re-filter and never reaches the caller', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: BASE_ROW, error: null } });
    buildAdmin({
      'audit_logs.select': {
        data: [
          { event: 'maintenance_request.attachment_added', created_at: '2026-08-01T01:00:00.000Z', metadata: { attachment_id: 'att1' } },
          // Not on the allow-list — must never survive to the returned array.
          { event: 'maintenance_request.note_added', created_at: '2026-08-01T02:00:00.000Z', metadata: {} },
        ],
        error: null,
      },
    });

    const events = await new MaintenanceRequestsService(ctx).listTimelineEvents('r1');
    expect(events).toHaveLength(1);
    expect(events.map((e) => e.event)).toEqual(['maintenance_request.attachment_added']);
  });

  it('maps event/created_at/metadata straight through for both allow-listed kinds, in the order the query returned them', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: BASE_ROW, error: null } });
    buildAdmin({
      'audit_logs.select': {
        data: [
          {
            event: 'maintenance_request.attachment_added',
            created_at: '2026-08-01T01:00:00.000Z',
            metadata: { attachment_id: 'att1', byte_size: 1024 },
          },
          {
            event: 'maintenance_request.owner_assigned',
            created_at: '2026-08-02T00:00:00.000Z',
            metadata: { local_owner_user_id: 'mgr-1' },
          },
        ],
        error: null,
      },
    });

    const events = await new MaintenanceRequestsService(ctx).listTimelineEvents('r1');
    expect(events).toEqual([
      {
        event: 'maintenance_request.attachment_added',
        createdAt: '2026-08-01T01:00:00.000Z',
        extra: { attachment_id: 'att1', byte_size: 1024 },
      },
      {
        event: 'maintenance_request.owner_assigned',
        createdAt: '2026-08-02T00:00:00.000Z',
        extra: { local_owner_user_id: 'mgr-1' },
      },
    ]);
  });

  it('a query error surfaces as internal_error', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: BASE_ROW, error: null } });
    buildAdmin({ 'audit_logs.select': { data: null, error: { message: 'boom' } } });
    await expect(new MaintenanceRequestsService(ctx).listTimelineEvents('r1')).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('a read_all-only viewer of a request they do not own can still read its timeline (same boundary as get())', async () => {
    const { ctx } = build(
      { 'maintenance_requests.select': { data: { ...BASE_ROW, requester_user_id: 'other-user' }, error: null } },
      { permissions: new Set(['maintenance_requests:read_all']) },
    );
    buildAdmin({ 'audit_logs.select': { data: [], error: null } });
    await expect(new MaintenanceRequestsService(ctx).listTimelineEvents('r1')).resolves.toEqual([]);
  });
});
