import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * resolvePublicRequestToken and the organization's public_requests module.
 *
 * The resolution is cached for 60 seconds. A link whose organization has the
 * module off resolves to null (the page's 404), and that answer is cached,
 * as before. A module state that could not be read is not an answer:
 * supabase-js resolves a failed read as `{ data: null, error }`, the shape of
 * "no enabled row", and the resolver throws for it, so nothing is cached and
 * the page reaches its error state with Try again.
 *
 * The cache here is a model of next/cache's unstable_cache: one stored value
 * per key and argument list, and a call that throws stores nothing.
 */

const cache = vi.hoisted(() => ({ stored: new Map<string, unknown>() }));
vi.mock('next/cache', () => ({
  unstable_cache:
    (fn: (...args: unknown[]) => Promise<unknown>, keyParts: string[]) =>
    async (...args: unknown[]) => {
      const key = JSON.stringify([keyParts, args]);
      if (cache.stored.has(key)) return cache.stored.get(key);
      const value = await fn(...args);
      cache.stored.set(key, value);
      return value;
    },
  revalidateTag: vi.fn(),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
const adminRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminRef.current }));

import { ModulesUnavailableError } from '@/lib/modules/module-state';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { resolvePublicRequestToken } from './public-catalog';

const TOKEN = 'a-made-up-link-token-0001';
const ORG = { id: 'org-1', name: 'Org One', logo_url: null, public_request_blurb: null };
const LINK_ROW = {
  id: 'link-1',
  organization_id: 'org-1',
  name: 'General',
  instructions: null,
  active: true,
  expires_at: null,
  available_from: null,
  available_until: null,
  availability_display: 'none',
  books_enabled: true,
  items_enabled: true,
  include_public_pool: false,
  default_max_qty: null,
};
const FAILED = { data: null, error: { message: 'upstream timeout', code: '57014' } };

function world(moduleRead: { data: unknown; error: unknown }, viaLink = true) {
  const stub = makeSupabaseStub({
    'public_request_links.select': { data: viaLink ? LINK_ROW : null, error: null },
    'organizations.select': { data: ORG, error: null },
    'organization_modules.select': moduleRead as never,
  });
  adminRef.current = stub.client;
  return stub;
}

beforeEach(() => {
  cache.stored.clear();
});

describe('resolvePublicRequestToken: the public_requests module', () => {
  it('the module on: the link and its organization', async () => {
    world({ data: { module_id: 'public_requests' }, error: null });
    const resolved = await resolvePublicRequestToken(TOKEN);
    expect(resolved?.org).toEqual(ORG);
    expect(resolved?.link?.id).toBe('link-1');
  });

  it('the module off: null, and that answer is cached as before', async () => {
    world({ data: null, error: null });
    expect(await resolvePublicRequestToken(TOKEN)).toBeNull();
    expect(cache.stored.size).toBe(1);
  });

  it.each([
    ['a link token', true],
    ['an organization token with no links row', false],
  ])(
    'the module state could not be read (%s): the resolver throws, and nothing is cached',
    async (_name, viaLink) => {
      world(FAILED, viaLink);
      await expect(resolvePublicRequestToken(TOKEN)).rejects.toBeInstanceOf(ModulesUnavailableError);
      expect(cache.stored.size).toBe(0);
    },
  );

  it('does not stick: the next request reads the module again and resolves the link', async () => {
    world(FAILED);
    await expect(resolvePublicRequestToken(TOKEN)).rejects.toBeInstanceOf(ModulesUnavailableError);
    world({ data: { module_id: 'public_requests' }, error: null });
    expect((await resolvePublicRequestToken(TOKEN))?.link?.id).toBe('link-1');
  });
});
