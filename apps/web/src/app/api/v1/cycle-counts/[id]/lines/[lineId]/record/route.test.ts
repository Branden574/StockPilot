import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/server/services/cycle-counts', () => ({ CycleCountsService: vi.fn() }));

/**
 * POST /api/v1/cycle-counts/[id]/lines/[lineId]/record — the route every phone
 * records through, online and on offline replay (Phase 0 S5-C, 0369).
 *
 *   - capturedAt + clientSentAt are skew-corrected onto the server clock and
 *     passed to recordCount; an unreadable pair is DROPPED, never a 400 (the
 *     phone's drain treats a 400 as final and would discard the count);
 *   - an old bundle sends neither: an online record, as before;
 *   - aiScanId is passed through unchanged (omitted stays undefined, so a
 *     manual recount keeps the line's AI-scan link);
 *   - a record that timed out behind an in-flight post is a retryable 503.
 */

const CC = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const SCAN = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-09-24T18:00:00.000Z');

function ctx() {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'staff' as const,
    supabase: makeSupabaseStub({}).client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['cycle_counts']),
  };
}

function request(body: unknown) {
  return {
    req: new Request(`https://test.local/api/v1/cycle-counts/${CC}/lines/${LINE}/record`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof POST>[0],
    params: { params: Promise.resolve({ id: CC, lineId: LINE }) },
  };
}

function mockRecord(impl: (input: unknown) => Promise<void> = async () => {}) {
  const recordCount = vi.fn(impl);
  vi.mocked(CycleCountsService).mockImplementation(function () {
    return { recordCount } as unknown as InstanceType<typeof CycleCountsService>;
  });
  return recordCount;
}

describe('POST /api/v1/cycle-counts/[id]/lines/[lineId]/record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.mocked(withApiContext).mockResolvedValue(ctx());
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: NOW + 60_000,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the skew-corrected capture time to recordCount', async () => {
    const recordCount = mockRecord();
    // Phone clock 3 h behind; counted 40 minutes before this send.
    const { req, params } = request({
      countedQuantity: 20,
      capturedAt: '2026-09-24T14:20:00.000Z',
      clientSentAt: '2026-09-24T15:00:00.000Z',
    });
    const res = await POST(req, params);
    expect(res.status).toBe(200);
    expect(recordCount).toHaveBeenCalledWith(
      expect.objectContaining({ countedQuantity: 20, capturedAt: '2026-09-24T17:20:00.000Z' }),
    );
  });

  // The resolved capture is LATE by everything that happens before the route
  // reads its clock (the error is never early), and the 2026-09-22 stalls put
  // seconds into the auth read alone. Mutation: read Date.now() after
  // withApiContext, and the capture lands 5 s late (17:20:05).
  it('measures against the clock at ARRIVAL, not after a slow auth read', async () => {
    const recordCount = mockRecord();
    vi.mocked(withApiContext).mockImplementation(async () => {
      vi.setSystemTime(NOW + 5_000);
      return ctx();
    });
    const { req, params } = request({
      countedQuantity: 20,
      capturedAt: '2026-09-24T14:20:00.000Z',
      clientSentAt: '2026-09-24T15:00:00.000Z',
    });
    const res = await POST(req, params);
    expect(res.status).toBe(200);
    expect(recordCount).toHaveBeenCalledWith(
      expect.objectContaining({ capturedAt: '2026-09-24T17:20:00.000Z' }),
    );
  });

  it('an old bundle (no capture keys) is an online record: no capturedAt at all', async () => {
    const recordCount = mockRecord();
    const { req, params } = request({ countedQuantity: 7 });
    const res = await POST(req, params);
    expect(res.status).toBe(200);
    const input = recordCount.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('capturedAt' in input).toBe(false);
  });

  it.each([
    ['an unparseable capturedAt', { capturedAt: 'not-a-date', clientSentAt: '2026-09-24T15:00:00.000Z' }],
    ['a numeric capturedAt', { capturedAt: 12345, clientSentAt: '2026-09-24T15:00:00.000Z' }],
    ['capturedAt without clientSentAt', { capturedAt: '2026-09-24T14:20:00.000Z' }],
    ['a null pair', { capturedAt: null, clientSentAt: null }],
  ])('%s is DROPPED, never a 400 (the drain would discard the count)', async (_label, extra) => {
    const recordCount = mockRecord();
    const { req, params } = request({ countedQuantity: 9, ...extra });
    const res = await POST(req, params);
    expect(res.status).toBe(200);
    expect(recordCount).toHaveBeenCalledTimes(1);
    const input = recordCount.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.countedQuantity).toBe(9);
    expect('capturedAt' in input).toBe(false);
  });

  it('aiScanId is undefined when omitted (a manual recount keeps the scan link)', async () => {
    const recordCount = mockRecord();
    const { req, params } = request({ countedQuantity: 3 });
    await POST(req, params);
    const input = recordCount.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.aiScanId).toBeUndefined();
  });

  it('aiScanId is passed through when given, and an explicit null stays null', async () => {
    const recordCount = mockRecord();
    const a = request({ countedQuantity: 3, aiScanId: SCAN });
    await POST(a.req, a.params);
    const b = request({ countedQuantity: 3, aiScanId: null });
    await POST(b.req, b.params);
    expect((recordCount.mock.calls[0]?.[0] as Record<string, unknown>).aiScanId).toBe(SCAN);
    expect((recordCount.mock.calls[1]?.[0] as Record<string, unknown>).aiScanId).toBeNull();
  });

  it('a record that waited too long behind a post is a retryable 503, not a 4xx', async () => {
    mockRecord(async () => {
      throw new ServiceError('internal_error', 'cycle_count_record_busy (55P03): lock timeout', {
        retryable: true,
      });
    });
    const { req, params } = request({ countedQuantity: 3 });
    const res = await POST(req, params);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('internal_error');
    // The raw database text never reaches the client (S13).
    expect(body.message).not.toContain('55P03');
  });

  it('an ordinary internal error is still a 500 and a refusal still a 409', async () => {
    mockRecord(async () => {
      throw new ServiceError('internal_error', 'boom');
    });
    const a = request({ countedQuantity: 3 });
    expect((await POST(a.req, a.params)).status).toBe(500);
    mockRecord(async () => {
      throw new ServiceError('validation_error', 'nope');
    });
    const b = request({ countedQuantity: 3 });
    expect((await POST(b.req, b.params)).status).toBe(409);
  });

  it('a bad countedQuantity is still refused (only the capture keys are lenient)', async () => {
    const recordCount = mockRecord();
    const { req, params } = request({ countedQuantity: -1, capturedAt: 'garbage' });
    const res = await POST(req, params);
    expect(res.status).toBe(400);
    expect(recordCount).not.toHaveBeenCalled();
  });
});
