import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * MED-20: this AI endpoint skipped the `ai` module gate and any permission
 * assert. It burns the org's model quota and serverless time on a multimodal
 * call, and was reachable by any authenticated member of any org — including
 * an org without the AI entitlement, and including a viewer.
 *
 * The extraction library is stubbed, so no test reaches a model.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/books/isbn-ai-extract', () => ({
  aiExtractIsbns: vi.fn().mockResolvedValue({ isbns: [], raw: '' }),
  aiExtractIsbnsFromBuffer: vi.fn().mockResolvedValue({ isbns: [], raw: '' }),
}));

import { POST } from './route';

function buildCtx(opts: {
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
  modules?: ModuleId[];
}) {
  const stub = makeSupabaseStub({});
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: opts.role,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(opts.modules ?? ['ai', 'inventory', 'books']),
  };
}

/**
 * A request whose body would FAIL validation if the gates let it through. Both
 * gates must reject before the multipart parse, so a 403 here proves ordering
 * as well as the gate itself.
 */
function buildRequest(): Request {
  return new Request('https://test.local/api/books/extract-isbns-ai', {
    method: 'POST',
    body: 'not-multipart',
  });
}

describe('POST /api/books/extract-isbns-ai gates (MED-20)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      resetAt: Date.now() + 60_000,
    } as never);
  });

  it('401s without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(buildRequest());
    expect(res.status).toBe(401);
  });

  it('403s module_disabled when the org lacks the ai module', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(
      buildCtx({ role: 'admin', modules: ['inventory', 'books'] }) as never,
    );
    const res = await POST(buildRequest());
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'module_disabled' });
  });

  it('403s forbidden for a viewer even when the ai module is enabled', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'viewer' }) as never);
    const res = await POST(buildRequest());
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'forbidden' });
  });

  it('refuses BEFORE spending the rate-limit budget', async () => {
    // Ordering matters: gating after the limiter would let a viewer consume the
    // caller's budget on every rejected call.
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'viewer' }) as never);
    await POST(buildRequest());
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('lets an items:create role past the gates (fails later on the bad body)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'staff' }) as never);
    const res = await POST(buildRequest());
    // NOT 403 — the gates passed. The 400 comes from the deliberately invalid
    // multipart body, which proves the request got past both asserts.
    expect(res.status).toBe(400);
    expect(checkRateLimit).toHaveBeenCalled();
  });
});
