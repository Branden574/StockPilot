import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { lookupUpc } from '@/lib/upc-lookup';
import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * MED-20 on the UPC endpoint. Two gates, deliberately NOT the same shape:
 *
 *   • permission (items:create) gates the whole endpoint — it spends money on
 *     every call (UPCitemdb + a model call) and exists to pre-fill a new item.
 *   • the `ai` module gates the AI DESCRIPTION FALLBACK ONLY. Gating the whole
 *     endpoint on `ai` would break plain barcode enrichment for every org that
 *     has not bought the AI module, which is a functional regression rather
 *     than a security fix. The assertion below pins that distinction so a
 *     future "tighten it up" edit cannot quietly break non-AI orgs — or
 *     quietly let them reach a model.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/upc-lookup', () => ({
  lookupUpc: vi.fn(),
  buildAiDescriptionPrompt: vi.fn(() => 'prompt'),
}));
// Present a model key while keeping the rest of env real, so `enableAiFallback`
// varies with the MODULE GATE alone — the axis under test. The key never
// reaches a provider: lookupUpc (the only thing that would call describeWithAi)
// is stubbed.
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, GEMINI_API_KEY: 'test-key' } };
});

import { GET } from './route';

function buildCtx(opts: {
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
  modules?: ModuleId[];
}) {
  // No local barcode match, so the request proceeds to the external path.
  const stub = makeSupabaseStub({ 'inventory_items.select': { data: null, error: null } });
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: opts.role,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(opts.modules ?? ['ai', 'inventory']),
  };
}

function buildRequest(): Parameters<typeof GET>[0] {
  return new Request(
    'https://test.local/api/v1/items/upc-lookup?upc=012345678905',
  ) as unknown as Parameters<typeof GET>[0];
}

describe('GET /api/v1/items/upc-lookup gates (MED-20)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      resetAt: Date.now() + 60_000,
    } as never);
    vi.mocked(lookupUpc).mockResolvedValue({
      source: 'upcitemdb',
      enrichment: {
        name: 'Widget',
        description: 'A widget',
        brand: 'Acme',
        modelNumber: null,
        imageUrl: null,
      },
    } as never);
  });

  it('401s without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(buildRequest());
    expect(res.status).toBe(401);
  });

  it('403s forbidden for a viewer', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'viewer' }) as never);
    const res = await GET(buildRequest());
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'forbidden' });
  });

  it('refuses a viewer BEFORE spending the rate-limit budget or calling out', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'viewer' }) as never);
    await GET(buildRequest());
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(lookupUpc).not.toHaveBeenCalled();
  });

  it('allows an items:create role and enables the AI fallback when the module is on', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'staff' }) as never);
    const res = await GET(buildRequest());
    expect(res.status).toBe(200);
    expect(vi.mocked(lookupUpc).mock.calls[0]![1]).toMatchObject({
      enableAiFallback: true,
    });
  });

  it('still serves the non-AI lookup when the org lacks the ai module, with the fallback OFF', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(
      buildCtx({ role: 'staff', modules: ['inventory'] }) as never,
    );
    const res = await GET(buildRequest());
    // NOT a 403 — plain barcode enrichment must keep working.
    expect(res.status).toBe(200);
    // But no model call is permitted for an org without the entitlement.
    const opts = vi.mocked(lookupUpc).mock.calls[0]![1] as {
      enableAiFallback: boolean;
      describeWithAi?: unknown;
    };
    expect(opts.enableAiFallback).toBe(false);
    expect(opts.describeWithAi).toBeUndefined();
  });
});
