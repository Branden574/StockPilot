import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared export limiter's 429. Exports are never cached anywhere, answers
 * or refusals (lib/reports/export-errors.ts); the limiter's refusal carried
 * only retry-after (review nit, 2026-09-29), so it now says no-store too.
 */

vi.mock('./rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      insert: () => Promise.resolve({ error: null }),
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
  }),
}));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

import { exportRateLimited } from './export-rate-limit';
import { checkRateLimit } from './rate-limit';

beforeEach(() => vi.clearAllMocks());

describe('exportRateLimited', () => {
  it('under the limit: null (the export proceeds)', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 1000 });
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
