import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The procedures list signs one poster per procedure through
 * ProcedureVideosService.signedUrls. On a cold cache every path is a storage
 * request; they now wait for a signing slot (at most 20 in flight) and a
 * failed sign is reported with a count instead of only logged per path.
 */

const { createSignedUrl, reportError } = vi.hoisted(() => ({
  createSignedUrl: vi.fn(),
  reportError: vi.fn(async (_err: unknown, _context: unknown) => {}),
}));
vi.mock('next/cache', () => ({ unstable_cache: vi.fn((fn: unknown) => fn) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl }) } }),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import type { ServiceContext } from './context';
import { ProcedureVideosService } from './procedure-videos';

const ctx = { organizationId: 'org-1' } as unknown as ServiceContext;

beforeEach(() => {
  createSignedUrl.mockReset();
  reportError.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('ProcedureVideosService.signedUrls', () => {
  it('keeps at most 20 signing requests in flight and reports the paths it could not sign', async () => {
    let inFlight = 0;
    let peak = 0;
    createSignedUrl.mockImplementation(async (path: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return path.endsWith('0.jpg')
        ? { data: null, error: { message: 'Bad Gateway' } }
        : { data: { signedUrl: `https://signed/${path}` }, error: null };
    });
    const paths = Array.from({ length: 120 }, (_, i) => `org-1/procedures/p${i}/poster${i}.jpg`);

    const map = await new ProcedureVideosService(ctx).signedUrls(paths);

    expect(createSignedUrl).toHaveBeenCalledTimes(120);
    expect(peak).toBe(20);
    expect(map.size).toBe(108);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tag: 'procedure_videos.sign_failed',
      organizationId: 'org-1',
      extra: { requested: 120, failed: 12 },
    });
  });

  it('reports nothing when every path signs', async () => {
    createSignedUrl.mockImplementation(async (path: string) => ({
      data: { signedUrl: `https://signed/${path}` },
      error: null,
    }));
    const map = await new ProcedureVideosService(ctx).signedUrls(['org-1/a.jpg', 'org-1/b.jpg']);
    expect(map.size).toBe(2);
    expect(reportError).not.toHaveBeenCalled();
  });
});
