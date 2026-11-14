import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * checkRateLimit tells a caller when it could not answer (`failed: true`),
 * apart from a count it refused, and keeps every caller's `allowed` as it was:
 * a closed bucket refuses and an open one allows when the limiter cannot
 * answer.
 */

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ rpc: h.rpc }),
}));

import { checkRateLimit } from './rate-limit';

beforeEach(() => {
  h.rpc.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('checkRateLimit — a count, or could not answer', () => {
  it('a count the limiter answered carries no failed flag, allowed or refused', async () => {
    h.rpc.mockResolvedValueOnce({
      data: [{ allowed: true, count: 1, reset_at: '2026-01-01T00:00:00Z' }],
      error: null,
    });
    const allowed = await checkRateLimit('k', 5, 60_000, 'closed');
    expect(allowed).toMatchObject({ allowed: true, count: 1 });
    expect(allowed.failed).toBeUndefined();

    h.rpc.mockResolvedValueOnce({
      data: [{ allowed: false, count: 5, reset_at: '2026-01-01T00:00:00Z' }],
      error: null,
    });
    const refused = await checkRateLimit('k', 5, 60_000, 'closed');
    expect(refused).toMatchObject({ allowed: false, count: 5 });
    expect(refused.failed).toBeUndefined();
  });

  it.each([
    ['an error answer', () => h.rpc.mockResolvedValue({ data: null, error: { message: 'x' } })],
    ['no row', () => h.rpc.mockResolvedValue({ data: [], error: null })],
    ['a throw', () => h.rpc.mockRejectedValue(new Error('fetch failed'))],
  ])('%s: failed, refused when closed and allowed when open', async (_name, arrange) => {
    arrange();
    expect(await checkRateLimit('k', 5, 60_000, 'closed')).toMatchObject({
      allowed: false,
      failed: true,
    });
    expect(await checkRateLimit('k', 5, 60_000, 'open')).toMatchObject({
      allowed: true,
      failed: true,
    });
  });
});
