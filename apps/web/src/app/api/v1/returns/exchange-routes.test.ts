import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { RMAService } from '@/server/services/returns';

import { GET as orderCandidatesGET } from '../orders/[id]/exchange-candidates/route';
import { GET as candidatesGET } from './[id]/candidates/route';
import { POST as cancelReplacementPOST } from './[id]/replacement/cancel/route';
import { POST as declinePOST } from './[id]/replacement/decline/route';
import { GET as exchangeSwitchGET } from './exchange-switch/route';
import { POST as preparePOST } from './[id]/replacement/prepare/route';
import { POST as releasePOST } from './[id]/replacement/release/route';
import { POST as changePOST } from './[id]/replacement/route';

/**
 * The exchange routes (returns RX-2): Bearer or cookie (withApiContext
 * answers both), per-user limits, `private, no-store`, core's body schemas
 * before the service, one ServiceError shape whose details.reason is the
 * database hint, and the whole workbench in every write answer.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/server/services/returns', () => ({ RMAService: { forApiContext: vi.fn() } }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

const RET = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const XLINE = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const ORDER = '55555555-5555-4555-8555-555555555555';

function ctx() {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager' as const,
    supabase: {} as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['returns' as ModuleId, 'orders' as ModuleId]),
  };
}

type Req = Parameters<typeof changePOST>[0];
function req(url: string, init: { method?: string; json?: unknown; bearer?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (init.json !== undefined) headers['Content-Type'] = 'application/json';
  if (init.bearer) headers.Authorization = 'Bearer t';
  return new Request(`https://test.local${url}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  }) as unknown as Req;
}

const params = (id = RET) => ({ params: Promise.resolve({ id }) });

function service(methods: Record<string, unknown>) {
  vi.mocked(RMAService.forApiContext).mockReturnValueOnce(methods as unknown as ReturnType<typeof RMAService.forApiContext>);
}

const workbench = vi.fn(async () => ({ marker: 'workbench' }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 60_000 });
});

describe('POST /api/v1/returns/[id]/replacement (change or issue)', () => {
  const BODY = { expectedRevision: 1, lines: [{ exchangeLineId: XLINE, itemId: ITEM }], reason: 'Navy instead', whenShort: 'refuse' };

  it.each([[true], [false]])('bearer %s: parses, calls once, answers the change and the workbench, no-store', async (bearer) => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const changeReplacement = vi.fn(async () => ({ changed: true, mode: 'substitute' }));
    service({ changeReplacement, workbench });
    const res = await changePOST(req(`/api/v1/returns/${RET}/replacement`, { method: 'POST', json: BODY, bearer }), params());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ organizationId: 'org-1', answer: { changed: true, mode: 'substitute' }, workbench: { marker: 'workbench' } });
    expect(changeReplacement).toHaveBeenCalledWith(RET, expect.objectContaining({ reason: 'Navy instead', whenShort: 'refuse' }));
    expect(checkRateLimit).toHaveBeenCalledWith('returns-write:u-1', 60, 60_000);
  });

  it('400 without a reason, before the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const res = await changePOST(req(`/api/v1/returns/${RET}/replacement`, { method: 'POST', json: { ...BODY, reason: ' ' } }), params());
    expect(res.status).toBe(400);
    expect(RMAService.forApiContext).not.toHaveBeenCalled();
  });

  it('a short replacement answers the numbers first (400 replacement_unavailable with the detail)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    service({
      changeReplacement: vi.fn(async () => {
        throw new ServiceError('validation_error', 'The replacement is not in stock.', {
          reason: 'replacement_unavailable',
          detail: [{ itemId: ITEM, needed: 1, available: 0 }],
        });
      }),
      workbench,
    });
    const res = await changePOST(req(`/api/v1/returns/${RET}/replacement`, { method: 'POST', json: BODY }), params());
    expect(res.status).toBe(400);
    expect((await res.json()).details).toEqual({ reason: 'replacement_unavailable', detail: [{ itemId: ITEM, needed: 1, available: 0 }] });
    expect(workbench).not.toHaveBeenCalled();
  });

  it('401 without a context; 400 for a bad id before auth', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect((await changePOST(req(`/api/v1/returns/${RET}/replacement`, { method: 'POST', json: BODY }), params())).status).toBe(401);
    expect((await changePOST(req('/api/v1/returns/x/replacement', { method: 'POST', json: BODY }), params('x'))).status).toBe(400);
  });
});

describe('POST /replacement/cancel, /release, /prepare', () => {
  it('cancel needs a reason; a handed-over replacement is a 409 with its reason', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    expect((await cancelReplacementPOST(req(`/api/v1/returns/${RET}/replacement/cancel`, { method: 'POST', json: {} }), params())).status).toBe(400);
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    service({
      cancelReplacement: vi.fn(async () => {
        throw new ServiceError('conflict', 'The replacement was already handed over.', { reason: 'replacement_handed_over' });
      }),
      workbench,
    });
    const res = await cancelReplacementPOST(
      req(`/api/v1/returns/${RET}/replacement/cancel`, { method: 'POST', json: { reason: 'Wrong colour', expectedRevision: 1 } }),
      params(),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).details).toEqual({ reason: 'replacement_handed_over' });
  });

  it('release answers the release and the workbench; a reason over 500 characters is refused before the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const releaseEarly = vi.fn(async () => ({ changed: true, orderId: ORDER }));
    service({ releaseEarly, workbench });
    const ok = await releasePOST(
      req(`/api/v1/returns/${RET}/replacement/release`, {
        method: 'POST',
        json: { orderId: ORDER, reason: 'Customer is completing an in-person exchange today.' },
      }),
      params(),
    );
    expect(ok.status).toBe(200);
    expect(releaseEarly).toHaveBeenCalledWith(RET, { orderId: ORDER, reason: 'Customer is completing an in-person exchange today.' });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const long = await releasePOST(
      req(`/api/v1/returns/${RET}/replacement/release`, { method: 'POST', json: { orderId: ORDER, reason: 'x'.repeat(501) } }),
      params(),
    );
    expect(long.status).toBe(400);
  });

  // Desk check F7: the release names the replacement the caller saw, and the
  // replacement cancel the revision; either missing is refused before the
  // service, and a stale one is the database's 409 return_changed.
  it('release without the shown order and cancel without the revision are refused before the service', async () => {
    const releaseEarly = vi.fn();
    const cancelReplacement = vi.fn();
    service({ releaseEarly, cancelReplacement, workbench });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const noOrder = await releasePOST(req(`/api/v1/returns/${RET}/replacement/release`, { method: 'POST', json: { reason: 'x' } }), params());
    expect(noOrder.status).toBe(400);
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const noRevision = await cancelReplacementPOST(req(`/api/v1/returns/${RET}/replacement/cancel`, { method: 'POST', json: { reason: 'x' } }), params());
    expect(noRevision.status).toBe(400);
    expect(releaseEarly).not.toHaveBeenCalled();
    expect(cancelReplacement).not.toHaveBeenCalled();
  });

  // Desk check F9: "Close as return only" after a replacement cancel.
  it('decline (Close as return only) takes the revision and a reason; either missing is refused before the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const declineReplacement = vi.fn(async () => ({ changed: true, status: 'closed', revision: 2, declined: 1 }));
    service({ declineReplacement, workbench });
    const ok = await declinePOST(
      req(`/api/v1/returns/${RET}/replacement/decline`, { method: 'POST', json: { expectedRevision: 2, reason: 'Refund instead' } }),
      params(),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect((await ok.json()).answer).toEqual({ changed: true, status: 'closed', revision: 2, declined: 1 });
    expect(declineReplacement).toHaveBeenCalledWith(RET, { expectedRevision: 2, reason: 'Refund instead' });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const noRevision = await declinePOST(
      req(`/api/v1/returns/${RET}/replacement/decline`, { method: 'POST', json: { reason: 'Refund instead' } }),
      params(),
    );
    expect(noRevision.status).toBe(400);
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const noReason = await declinePOST(
      req(`/api/v1/returns/${RET}/replacement/decline`, { method: 'POST', json: { expectedRevision: 2, reason: ' ' } }),
      params(),
    );
    expect(noReason.status).toBe(400);
    expect(declineReplacement).toHaveBeenCalledTimes(1);
  });

  it('prepare takes an empty body and answers the steps; an unknown field is refused', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const prepareReplacement = vi.fn(async () => ({ orderId: ORDER, ran: [{ step: 'pick_slip', outcome: 'done' }], status: 'staged_for_pickup' }));
    service({ prepareReplacement, workbench });
    const res = await preparePOST(req(`/api/v1/returns/${RET}/replacement/prepare`, { method: 'POST', json: {} }), params());
    expect(res.status).toBe(200);
    expect((await res.json()).answer.ran).toEqual([{ step: 'pick_slip', outcome: 'done' }]);
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const bad = await preparePOST(req(`/api/v1/returns/${RET}/replacement/prepare`, { method: 'POST', json: { sign: true } }), params());
    expect(bad.status).toBe(400);
  });

  it('an MFA step-up refusal keeps aal2_required', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    service({
      releaseEarly: vi.fn(async () => {
        throw new ServiceError('forbidden', 'Verify with your authenticator to continue.', { reason: 'aal2_required' });
      }),
      workbench,
    });
    const res = await releasePOST(
      req(`/api/v1/returns/${RET}/replacement/release`, { method: 'POST', json: { orderId: ORDER, reason: 'x' } }),
      params(),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).details).toEqual({ reason: 'aal2_required' });
  });
});

// Desk check F9: the phone reads the kill switch when its create sheet opens.
describe('GET /api/v1/returns/exchange-switch', () => {
  it('answers the kill switch, no-store, for a signed-in member; 401 signed out', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const on = await exchangeSwitchGET(req('/api/v1/returns/exchange-switch'));
    expect(on.status).toBe(200);
    expect(on.headers.get('cache-control')).toBe('private, no-store');
    expect(await on.json()).toEqual({ organizationId: 'org-1', exchangesEnabled: true });
    vi.stubEnv('RETURNS_EXCHANGE_CREATE', 'off');
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const off = await exchangeSwitchGET(req('/api/v1/returns/exchange-switch'));
    expect((await off.json()).exchangesEnabled).toBe(false);
    vi.unstubAllEnvs();
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const signedOut = await exchangeSwitchGET(req('/api/v1/returns/exchange-switch'));
    expect(signedOut.status).toBe(401);
  });
});

describe('GET candidates (RMA and order)', () => {
  it('reads the line and the query from the URL, no-store, read limits', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const candidates = vi.fn(async () => ({ orderId: ORDER, siblings: [], matches: [] }));
    service({ candidates });
    const res = await candidatesGET(req(`/api/v1/returns/${RET}/candidates?line=${LINE}&q=navy`), params());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(candidates).toHaveBeenCalledWith(RET, { line: LINE, q: 'navy' });
    expect(checkRateLimit).toHaveBeenCalledWith('returns-read:u-1', 120, 60_000);
  });

  it('a missing or bad line is 400 before the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    expect((await candidatesGET(req(`/api/v1/returns/${RET}/candidates`), params())).status).toBe(400);
    expect(RMAService.forApiContext).not.toHaveBeenCalled();
  });

  it('the create sheet asks by order before the RMA exists', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx());
    const candidatesForOrder = vi.fn(async () => ({ orderId: ORDER, siblings: [], matches: [] }));
    service({ candidatesForOrder });
    const res = await orderCandidatesGET(req(`/api/v1/orders/${ORDER}/exchange-candidates?line=${LINE}`), params(ORDER));
    expect(res.status).toBe(200);
    expect(candidatesForOrder).toHaveBeenCalledWith(ORDER, { line: LINE, q: '' });
    expect((await orderCandidatesGET(req('/api/v1/orders/x/exchange-candidates?line=1'), params('x'))).status).toBe(400);
  });
});
