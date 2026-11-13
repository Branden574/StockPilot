import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The phone's sync when the organization's module state cannot be read.
 *
 * The real withApiContext runs here, on its legacy reads (the one-round-trip
 * context read fails), with the real route behind it. A 200 is an instruction
 * the phone acts on: it stores `enabledModules` and redraws its navigation
 * from it, and it stores the counts and kits it was sent. So the snapshot
 * answers a refusal, 500 `snapshot_uncaught`, the same answer it gives when
 * the caller's permissions cannot be read, and the phone keeps everything it
 * has and tries again on its next tick (sync.ts pullSnapshot).
 */

const refs = vi.hoisted(() => ({
  client: null as unknown,
  /** Made-up values: the client double ignores both. */
  projectUrl: 'https://example.supabase.co',
  publicValue: 'test-public-value',
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: refs.projectUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: refs.publicValue,
  },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => refs.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => refs.client }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000 })),
}));

import {
  legacyContextClient,
  legacyContextWorld,
  legacyPhoneHeaders,
  type LegacyContextWorld,
} from '@/test/legacy-api-context';

import { GET } from './route';

let world: LegacyContextWorld;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  world = legacyContextWorld({ role: 'admin' });
  refs.client = legacyContextClient(world);
});

const pull = () =>
  GET(
    new NextRequest('https://app.example.test/api/v1/mobile/snapshot', {
      headers: legacyPhoneHeaders(),
    }),
  );

describe('GET /api/v1/mobile/snapshot with the module state unreadable', () => {
  it('the rows read failed: a 500 refusal, and no module list is sent', async () => {
    world.moduleRowsFail = true;
    const res = await pull();
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'internal_error', code: 'snapshot_uncaught' });
    expect(body).not.toHaveProperty('enabledModules');
  });

  it('the comp flag read failed: a 500 refusal, and no module list is sent', async () => {
    world.organizationFail = true;
    world.moduleRows = ['orders'];
    const res = await pull();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error', code: 'snapshot_uncaught' });
  });

  it('reads that worked: a 200 that lists exactly the enabled modules (core behaviour)', async () => {
    world.moduleRows = ['orders'];
    const res = await pull();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabledModules: string[] };
    expect(body.enabledModules).toEqual(['orders']);
  });

  it('a comp that was read still lists every non-core module when the rows read failed', async () => {
    world.moduleRowsFail = true;
    world.comped = true;
    const res = await pull();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabledModules: string[] };
    expect(body.enabledModules).toContain('rentals');
    expect(body.enabledModules).toContain('cycle_counts');
    expect(body.enabledModules).toContain('bundles');
  });
});
