import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeSupabaseStub, servedLikePostgrest, type MockCall } from '@/test/supabase-mock';

/**
 * POST /api/v1/exceptions/[id]/escalate (F1-5) runs the REAL
 * ExceptionEscalationService and MaintenanceRequestsService over a stubbed
 * client, so every status below is the services' own answer through the
 * exceptions routes' one error shape. withApiContext is the one
 * cookie-or-Bearer resolver.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => undefined) }));
const limiter = vi.hoisted(() => ({ allowed: true, calls: [] as unknown[][] }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async (...args: unknown[]) => {
    limiter.calls.push(args);
    return { allowed: limiter.allowed, count: 1, resetAt: Date.now() + 60_000 };
  }),
}));
vi.mock('@/server/services/maintenance-notify', () => ({ notifyMaintenanceEvent: vi.fn(async () => undefined) }));
vi.mock('@/server/services/maintenance-share-links', () => ({
  MaintenanceShareLinksService: class {},
  maintenanceShareLinksEnabled: vi.fn(async () => false),
}));
vi.mock('@/server/email/maintenance-resolved', () => ({ maybeSendMaintenanceResolvedEmail: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => ({})) }));

import { withApiContext } from '@/lib/auth/api-context';

import { POST as ESCALATE } from './[id]/escalate/route';

const ORG = '0a0a0a0a-0000-4000-8000-000000000001';
const OCC = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const REQ = '44444444-4444-4444-8444-444444444444';
const OTHER_REQ = '55555555-5555-4555-8555-555555555555';

const BODY = {
  subject: 'Inventory issue: Chromebook charger (CB-65)',
  description: 'Label will not lead to the stock: labelled 40-C, stock is on 39-C. Ref EX-000042.',
};

function ctxWith(opts: { claim?: unknown; modules?: Set<ModuleId> } = {}) {
  const user = makeSupabaseStub({
    'exception_occurrences.select.maybeSingle': {
      data: {
        id: OCC,
        item_id: ITEM,
        location_id: null,
        resolved_at: null,
        maintenance_request_id: null,
        escalation_number: null,
        escalation_request_created_at: null,
      },
      error: null,
    },
    'rpc:exception_escalation_claim': (opts.claim as never) ?? { data: { state: 'claimed' }, error: null },
    'rpc:exception_escalation_finish': (call: MockCall) =>
      (call.args[0]?.[0] as { p_request_id: string | null }).p_request_id === null
        ? { data: { state: 'released' }, error: null }
        : { data: { state: 'linked', id: REQ, number: 14, createdAt: '2026-09-27T12:00:01Z' }, error: null },
    'user_profiles.select': { data: { full_name: 'Pat Lee', email: 'pat@example.test' }, error: null },
    'inventory_items.select': servedLikePostgrest([{ id: ITEM, organization_id: ORG }]),
    'maintenance_requests.insert.single': {
      data: { id: REQ, request_number: 14, created_at: '2026-09-27T12:00:01Z' },
      error: null,
    },
  });
  const ctx = {
    organizationId: ORG,
    userId: 'u-1',
    role: 'staff',
    supabase: user.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: opts.modules ?? new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'maintenance_requests']),
  };
  vi.mocked(withApiContext).mockResolvedValueOnce(ctx as never);
  return { user };
}

const post = (body: unknown, raw = false) =>
  new Request(`https://t.local/api/v1/exceptions/${OCC}/escalate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
    body: raw ? (body as string) : JSON.stringify(body),
  }) as never;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  limiter.allowed = true;
  limiter.calls = [];
});

describe('POST /api/v1/exceptions/[id]/escalate', () => {
  it('401 without a session', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect((await ESCALATE(post(BODY), params(OCC))).status).toBe(401);
  });

  it('201 with the saved request: id, number, handle and time, and nothing else', async () => {
    const { user } = ctxWith();
    const res = await ESCALATE(post(BODY), params(OCC));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: REQ,
      requestNumber: 14,
      reference: 'MR-2026-000014',
      createdAt: '2026-09-27T12:00:01Z',
    });
    expect(user.rpcCalls.map((c) => c.name)).toEqual(['exception_escalation_claim', 'exception_escalation_finish']);
  });

  it('409 DUPLICATE: an occurrence already escalated answers the linked request\'s id, number and handle', async () => {
    const { user } = ctxWith({
      claim: { data: { state: 'linked', id: OTHER_REQ, number: 9, createdAt: '2026-03-01T00:00:00Z' }, error: null },
    });
    const res = await ESCALATE(post(BODY), params(OCC));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'conflict',
      message: 'This exception is already escalated to MR-2026-000009. Opening that request.',
      details: { reason: 'already_escalated', requestId: OTHER_REQ, requestNumber: 9, reference: 'MR-2026-000009' },
    });
    expect(user.chainsAll.get('maintenance_requests.insert')).toBeUndefined();
  });

  it('403 module_disabled when the organization has no maintenance requests', async () => {
    const { user } = ctxWith({ modules: new Set<ModuleId>(DEFAULT_MODULE_IDS) });
    const res = await ESCALATE(post(BODY), params(OCC));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('module_disabled');
    expect(user.rpcCalls).toEqual([]);
  });

  it('409 escalation_in_progress carries retryable', async () => {
    ctxWith({
      claim: { data: null, error: { code: 'P0001', message: 'escalation_in_progress', hint: 'escalation_in_progress' } },
    });
    const res = await ESCALATE(post(BODY), params(OCC));
    expect(res.status).toBe(409);
    expect((await res.json()).details).toEqual({ reason: 'escalation_in_progress', retryable: true });
  });

  it('400 for a bad id, bad JSON, or a subject the form refuses', async () => {
    ctxWith();
    expect((await ESCALATE(post(BODY), params('nope'))).status).toBe(400);
    ctxWith();
    expect((await ESCALATE(post('{nope', true), params(OCC))).status).toBe(400);
    ctxWith();
    const res = await ESCALATE(post({ ...BODY, subject: 'abc' }), params(OCC));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/at least 5 characters/);
  });

  it('429 past 10 escalations a minute per person, before any work', async () => {
    const { user } = ctxWith();
    limiter.allowed = false;
    const res = await ESCALATE(post(BODY), params(OCC));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(user.rpcCalls).toEqual([]);
    expect(limiter.calls[0]?.slice(0, 3)).toEqual(['exceptions-escalate:u-1', 10, 60_000]);
  });
});
