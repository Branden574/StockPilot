import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The phone's sync when the organization's module state cannot be read.
 *
 * The real withApiContext runs here, on its legacy reads (the one-round-trip
 * context read fails), with the real route behind it. A 200 is an instruction
 * the phone acts on: it stores `enabledModules` and redraws its navigation
 * from it, and it stores the counts and kits it was sent. So the snapshot
 * refuses as soon as the context is built, before its rate-limit slot and
 * every read: a 500 with the fixed sentence, reported under its own tag as a
 * warning. The phone keeps everything it has and tries again on its next
 * tick (sync.ts pullSnapshot).
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

import { reportError } from '@/lib/error-reporter';
import { ModulesUnavailableError } from '@/lib/modules/module-state';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  legacyContextClient,
  legacyContextWorld,
  legacyPhoneHeaders,
  routeWork,
  type LegacyContextWorld,
} from '@/test/legacy-api-context';

import { GET } from './route';

let world: LegacyContextWorld;

beforeEach(() => {
  vi.clearAllMocks();
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
  it.each<[string, Partial<LegacyContextWorld>]>([
    ['the rows read failed', { moduleRowsFail: true }],
    ['the comp flag read failed', { organizationFail: true, moduleRows: ['orders'] }],
    ['the organization row read back hidden', { organizationHidden: true, moduleRows: ['orders'] }],
  ])(
    '%s: a 500 with the fixed sentence, its own tag at warning level, and no read after it',
    async (_what, failure) => {
      Object.assign(world, failure);
      const res = await pull();
      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        error: 'internal_error',
        message: 'Your access could not be checked. Please try again.',
      });
      expect(body).not.toHaveProperty('enabledModules');
      // Refused before the rate-limit slot and before any of the route's reads.
      expect(checkRateLimit).not.toHaveBeenCalled();
      expect(routeWork(world)).toEqual([]);
      // Reported once, under its own tag, as a warning: never as uncaught.
      expect(reportError).toHaveBeenCalledTimes(1);
      const [err, context] = vi.mocked(reportError).mock.calls[0]!;
      expect(err).toBeInstanceOf(ModulesUnavailableError);
      expect(context).toEqual(
        expect.objectContaining({ tag: 'mobile.snapshot.module_state', level: 'warning' }),
      );
    },
  );

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
