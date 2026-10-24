import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared export limiter's 429. Exports are never cached anywhere, answers
 * or refusals (lib/reports/export-errors.ts); the limiter's refusal carried
 * only retry-after (review nit, 2026-09-29), so it now says no-store too.
 */

const admin = vi.hoisted(() => ({ throws: false }));

vi.mock('./rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    // The 2026-07-21 outage class: an unset service-role key throws here.
    if (admin.throws) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
    return {
      from: () => ({
        insert: () => Promise.resolve({ error: null }),
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      }),
    };
  },
}));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

import { insertAuditRowReported } from '@/server/services/audit';

import { exportRateLimited } from './export-rate-limit';
import { checkRateLimit } from './rate-limit';

beforeEach(() => {
  vi.clearAllMocks();
  admin.throws = false;
});

describe('exportRateLimited', () => {
  it('under the limit: null (the export proceeds)', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 1000,
    });
    await expect(exportRateLimited('user-1', 'org-1')).resolves.toBeNull();
  });

  it('over the limit: 429 rate_limited with retry-after, never cached', async () => {
    vi.mocked(checkRateLimit)
      .mockResolvedValueOnce({ allowed: false, count: 41, resetAt: Date.now() + 90_000 })
      .mockResolvedValue({ allowed: false, count: 2, resetAt: Date.now() + 90_000 });
    const res = await exportRateLimited('user-1', 'org-1');
    expect(res?.status).toBe(429);
    expect(await res!.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(res!.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(res!.headers.get('cache-control')).toBe('no-store');
  });
});

describe('exportRateLimited: the trip row', () => {
  // Mutation caught: the bare `void createAdminClient().from('audit_logs')
  // .insert(...)` it replaced, which nothing kept alive past the 429 and
  // which never reported a lost row (insertAuditRowReported does both,
  // services/audit.test.ts and audit.keepalive.test.ts).
  it('goes through insertAuditRowReported, one row per refusal', async () => {
    vi.mocked(checkRateLimit)
      .mockResolvedValueOnce({ allowed: false, count: 41, resetAt: Date.now() + 90_000 })
      .mockResolvedValue({ allowed: false, count: 2, resetAt: Date.now() + 90_000 });
    await exportRateLimited('user-1', 'org-1');
    expect(insertAuditRowReported).toHaveBeenCalledTimes(1);
    expect(insertAuditRowReported).toHaveBeenCalledWith({
      organization_id: 'org-1',
      user_id: 'user-1',
      event: 'security.export_rate_limited',
      metadata: {},
    });
  });

  // Mutation caught: createAdminClient() called outside any catch, so a
  // missing service key turned the 429 into a thrown error (a 500).
  it('a service client that cannot be made still answers the 429', async () => {
    admin.throws = true;
    vi.mocked(checkRateLimit)
      .mockResolvedValueOnce({ allowed: false, count: 41, resetAt: Date.now() + 90_000 })
      .mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 90_000 });
    const res = await exportRateLimited('user-1', 'org-1');
    expect(res?.status).toBe(429);
  });

  it('no organization: no row', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 41,
      resetAt: Date.now() + 90_000,
    });
    expect((await exportRateLimited('user-1'))?.status).toBe(429);
    expect(insertAuditRowReported).not.toHaveBeenCalled();
  });
});
