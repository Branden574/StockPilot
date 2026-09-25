import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/v1/exceptions/recount (F1-2): cookie or Bearer through
 * withApiContext(req), a rate limit, a loose body check, and the service's
 * refusals as status codes the phone already maps (403, 404, 409 with
 * `details.reason` and `details.retryable`). The service itself is tested in
 * exception-recount.test.ts; here it is a stand-in.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
const checkRateLimit = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
);
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit }));
const start = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/exception-recount', () => ({
  ExceptionRecountService: vi.fn(function (this: { start: typeof start }) {
    this.start = start;
  }),
}));

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';

import { POST } from './route';

const CTX = { organizationId: 'org-1', userId: 'u-1', role: 'manager' };
const OCC = '11111111-1111-4111-8111-111111111111';

const RESULT = {
  cycleCountId: 'cc-1',
  countNumber: 31,
  reference: 'CC-000031',
  lineCount: 1,
  created: true,
  replay: false,
  assignedTo: null,
  assignmentFailed: false,
  notes: 'Recount: Atlas',
  linked: [OCC],
  linkedExisting: [],
  skipped: [],
};

const req = (body: unknown, headers: Record<string, string> = { authorization: 'Bearer t' }) =>
  new Request('https://t.local/api/v1/exceptions/recount', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withApiContext).mockResolvedValue(CTX as never);
});

describe('POST /api/v1/exceptions/recount', () => {
  it('401 without a session, and nothing starts', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(req({ occurrenceIds: [OCC] }));
    expect(res.status).toBe(401);
    expect(start).not.toHaveBeenCalled();
  });

  it('serves a Bearer caller and a cookie caller alike, handing the request to withApiContext', async () => {
    start.mockResolvedValue(RESULT);
    for (const headers of [{ authorization: 'Bearer t' }, { cookie: 'sb-x-auth-token=abc' }] as Array<Record<string, string>>) {
      const r = req({ occurrenceIds: [OCC], idempotencyKey: 'tap-1', assignedTo: null }, headers);
      const res = await POST(r);
      expect(res.status).toBe(201);
      expect(vi.mocked(withApiContext)).toHaveBeenLastCalledWith(r);
    }
    expect(start).toHaveBeenLastCalledWith({
      occurrenceIds: [OCC],
      itemIds: null,
      assignedTo: null,
      idempotencyKey: 'tap-1',
    });
  });

  it('201 when a count was started, 200 for a replay or when nothing new was needed', async () => {
    start.mockResolvedValueOnce(RESULT);
    expect((await POST(req({ occurrenceIds: [OCC] }))).status).toBe(201);
    start.mockResolvedValueOnce({ ...RESULT, created: false, replay: true, lineCount: null });
    const replay = await POST(req({ occurrenceIds: [OCC] }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replay: true, cycleCountId: 'cc-1' });
  });

  it('400 for a body that is not JSON or not lists of ids', async () => {
    expect((await POST(req('{nope'))).status).toBe(400);
    expect((await POST(req({ occurrenceIds: 'x' }))).status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it('429 past the rate limit, with Retry-After', async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false, count: 21, resetAt: Date.now() + 30_000 });
    const res = await POST(req({ occurrenceIds: [OCC] }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
  });

  it('maps the service refusals: 403, 404, 409 with the reason, and retryable', async () => {
    const cases: Array<[ServiceError, number, Record<string, unknown>]> = [
      [new ServiceError('forbidden', 'Only a manager…'), 403, { error: 'forbidden' }],
      [new ServiceError('module_disabled', 'off'), 403, { error: 'module_disabled' }],
      [
        new ServiceError('not_found', 'An exception…', { reason: 'occurrence_not_found' }),
        404,
        { details: { reason: 'occurrence_not_found' } },
      ],
      [
        new ServiceError('conflict', 'used', { reason: 'idempotency_conflict' }),
        409,
        { details: { reason: 'idempotency_conflict' } },
      ],
      [
        new ServiceError('conflict', 'busy', { reason: 'recount_busy', retryable: true }),
        409,
        { details: { reason: 'recount_busy', retryable: true } },
      ],
      [new ServiceError('internal_error', 'relation secret'), 500, { error: 'internal_error' }],
    ];
    for (const [err, status, body] of cases) {
      start.mockRejectedValueOnce(err);
      const res = await POST(req({ occurrenceIds: [OCC] }));
      expect(res.status).toBe(status);
      const json = await res.json();
      expect(json).toMatchObject(body);
      expect(JSON.stringify(json)).not.toMatch(/secret/);
    }
  });
});
