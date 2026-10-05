import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { RMAService } from '@/server/services/returns';

import { POST as cancelPOST } from './[id]/cancel/route';
import { POST as denyPOST } from './[id]/deny/route';
import { POST as dispositionsPOST } from './[id]/dispositions/route';
import { GET as workbenchGET } from './[id]/route';
import { POST as stepsPOST } from './[id]/steps/route';
import { GET as listGET } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/server/services/returns', () => ({ RMAService: { forApiContext: vi.fn() } }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

const RET = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';

function ctx() {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager' as const,
    supabase: {} as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['returns' as ModuleId]),
  };
}

function req(url: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init;
  return new Request(`https://test.local${url}`, {
    ...rest,
    ...(json === undefined ? {} : { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' } }),
  }) as unknown as Parameters<typeof listGET>[0];
}

const params = (id = RET) => ({ params: Promise.resolve({ id }) });

function service(methods: Record<string, unknown>) {
  vi.mocked(RMAService.forApiContext).mockReturnValueOnce(methods as unknown as ReturnType<typeof RMAService.forApiContext>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 60_000 });
});

describe('GET /api/v1/returns', () => {
  it('401 without a context, never touching the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await listGET(req('/api/v1/returns'));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
    expect(RMAService.forApiContext).not.toHaveBeenCalled();
  });

  it('reads one page with the parsed filter, the search and the cursor, no-store', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const listPage = vi.fn(async (..._a: unknown[]) => ({ organizationId: 'org-1', rows: [], nextCursor: null }));
    service({ listPage });
    const res = await listGET(req('/api/v1/returns?filter=waiting_for_return&q=RMA-2026&cursor=abc'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(listPage).toHaveBeenCalledWith({ filter: 'waiting_for_return', q: 'RMA-2026', cursor: 'abc' });
    expect(checkRateLimit).toHaveBeenCalledWith('returns-read:u-1', 120, 60_000);
  });

  it('an unknown or exchange-only filter reads as all in RX-1', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const listPage = vi.fn(async (..._a: unknown[]) => ({ rows: [] }));
    service({ listPage });
    await listGET(req('/api/v1/returns?filter=exchanges'));
    expect(listPage).toHaveBeenCalledWith(expect.objectContaining({ filter: 'all' }));
  });

  it('403 for a member without returns:read keeps the reason shape', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    service({
      listPage: vi.fn(async () => {
        throw new ServiceError('forbidden', 'Missing permission: returns:read');
      }),
    });
    const res = await listGET(req('/api/v1/returns'));
    expect(res.status).toBe(403);
  });

  it('429 when rate-limited, with Retry-After', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 121, resetAt: Date.now() + 10_000 });
    const res = await listGET(req('/api/v1/returns'));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});

describe('GET /api/v1/returns/[id]', () => {
  it('400 for a bad id before any auth or read', async () => {
    const res = await workbenchGET(req('/api/v1/returns/nope'), params('nope'));
    expect(res.status).toBe(400);
    expect(withApiContext).not.toHaveBeenCalled();
  });

  it('answers the workbench, no-store', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    service({ workbench: vi.fn(async () => ({ organizationId: 'org-1', return: { id: RET }, actions: { primary: 'receive' } })) });
    const res = await workbenchGET(req(`/api/v1/returns/${RET}`), params());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect((await res.json()).actions.primary).toBe('receive');
  });

  it('404 for a missing or foreign RMA alike', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    service({
      workbench: vi.fn(async () => {
        throw new ServiceError('not_found', "This return isn't available.");
      }),
    });
    const res = await workbenchGET(req(`/api/v1/returns/${RET}`), params());
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/returns/[id]/steps', () => {
  const body = {
    steps: ['approve'],
    expectedRevision: 0,
    expectedPlanSeq: null,
    approve: { lines: [{ returnLineId: LINE, disposition: 'restock', restock: { target: 'original' } }] },
    receiveNow: true,
  };

  it('runs the steps and answers ran plus the workbench', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const runSteps = vi.fn(async (..._a: unknown[]) => ({ ran: [{ step: 'approve', outcome: 'done' }], workbench: { return: { id: RET } } }));
    service({ runSteps });
    const res = await stepsPOST(req(`/api/v1/returns/${RET}/steps`, { method: 'POST', json: body }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ organizationId: 'org-1', ran: [{ step: 'approve', outcome: 'done' }] });
    expect(runSteps.mock.calls[0]![0]).toBe(RET);
    expect(runSteps.mock.calls[0]![1]).toMatchObject({ steps: ['approve'], receiveNow: true, expectedRevision: 0 });
    expect(checkRateLimit).toHaveBeenCalledWith('returns-write:u-1', 60, 60_000);
  });

  it('400 for steps out of order, before the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const res = await stepsPOST(req(`/api/v1/returns/${RET}/steps`, { method: 'POST', json: { steps: ['process', 'receive'] } }), params());
    expect(res.status).toBe(400);
    expect(RMAService.forApiContext).not.toHaveBeenCalled();
  });

  it('a step-up refusal keeps details.reason aal2_required (MFA before writes)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    service({
      runSteps: vi.fn(async () => {
        throw new ServiceError('forbidden', 'Re-authenticate with MFA before performing this action.', { reason: 'aal2_required' });
      }),
    });
    const res = await stepsPOST(req(`/api/v1/returns/${RET}/steps`, { method: 'POST', json: body }), params());
    expect(res.status).toBe(403);
    expect((await res.json()).details).toEqual({ reason: 'aal2_required' });
  });

  it('a busy database is a retryable 409 the client resends as is', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    service({
      runSteps: vi.fn(async () => {
        throw new ServiceError('conflict', 'Busy. Try again.', { reason: 'busy', retryable: true });
      }),
    });
    const res = await stepsPOST(req(`/api/v1/returns/${RET}/steps`, { method: 'POST', json: body }), params());
    expect(res.status).toBe(409);
    expect((await res.json()).details).toEqual({ reason: 'busy', retryable: true });
  });

  it('an internal error answers reason failed and no raw text', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    service({
      runSteps: vi.fn(async () => {
        throw new ServiceError('internal_error', 'permission denied for table return_decisions');
      }),
    });
    const res = await stepsPOST(req(`/api/v1/returns/${RET}/steps`, { method: 'POST', json: body }), params());
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.details).toEqual({ reason: 'failed' });
    expect(JSON.stringify(json)).not.toMatch(/return_decisions/);
  });
});

describe('POST deny, cancel, dispositions', () => {
  it('deny needs a reason (400 before the service), then answers the transition', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const bad = await denyPOST(req(`/api/v1/returns/${RET}/deny`, { method: 'POST', json: { reason: '  ' } }), params());
    expect(bad.status).toBe(400);
    expect(RMAService.forApiContext).not.toHaveBeenCalled();

    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const deny = vi.fn(async (..._a: unknown[]) => ({ changed: true, status: 'denied' }));
    service({ deny });
    const res = await denyPOST(req(`/api/v1/returns/${RET}/deny`, { method: 'POST', json: { reason: 'Not ours' } }), params());
    expect(res.status).toBe(200);
    expect(deny).toHaveBeenCalledWith(RET, 'Not ours');
  });

  it('cancel passes the revision and the optional reason; a stale revision is 409', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const cancel = vi.fn(async (..._a: unknown[]) => ({ changed: true, status: 'cancelled' }));
    service({ cancel });
    await cancelPOST(req(`/api/v1/returns/${RET}/cancel`, { method: 'POST', json: { expectedRevision: 1, reason: 'Duplicate' } }), params());
    expect(cancel).toHaveBeenCalledWith(RET, { expectedRevision: 1, reason: 'Duplicate' });

    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    service({
      cancel: vi.fn(async () => {
        throw new ServiceError('conflict', 'Another person changed this return. Review it again.', { reason: 'return_changed', detail: '2' });
      }),
    });
    const res = await cancelPOST(req(`/api/v1/returns/${RET}/cancel`, { method: 'POST', json: { expectedRevision: 0 } }), params());
    expect(res.status).toBe(409);
    expect((await res.json()).details).toMatchObject({ reason: 'return_changed' });
  });

  it('dispositions refuses a source without its rack before the service; a guessed rack answers the one generic 400', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const bad = await dispositionsPOST(
      req(`/api/v1/returns/${RET}/dispositions`, {
        method: 'POST',
        json: { lines: [{ returnLineId: LINE, disposition: 'restock', restock: { target: 'source' } }] },
      }),
      params(),
    );
    expect(bad.status).toBe(400);

    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    service({
      planDispositions: vi.fn(async () => {
        throw new ServiceError('validation_error', "That rack isn't one this item was picked from.", { reason: 'restock_location_not_offered' });
      }),
    });
    const res = await dispositionsPOST(
      req(`/api/v1/returns/${RET}/dispositions`, {
        method: 'POST',
        json: { lines: [{ returnLineId: LINE, disposition: 'restock', restock: { target: 'source', locationId: LINE } }] },
      }),
      params(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).details).toEqual({ reason: 'restock_location_not_offered' });
  });
});
