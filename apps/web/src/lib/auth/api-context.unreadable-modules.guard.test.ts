import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GUARD: a module state the API context could not read is never an answer.
 *
 * withApiContext builds the module set from two reads when get_request_context()
 * gives no usable answer: the organization's enabled `organization_modules`
 * rows and its `organizations.all_modules_comp` flag. supabase-js RESOLVES a
 * failed read as `{ data: null, error }`, so a set built from it looks exactly
 * like an organization that switched every module off.
 * An organization row that reads back absent with no error (row level security
 * hid it) counts as a failed read too: its comp flag was never seen.
 *
 * This guard pins, on both auth paths and for every non-core module, that when
 * one of those reads failed and the module is not known to be on:
 *   - asking about the module throws ModulesUnavailableError, never `false`;
 *   - assertModuleEnabled throws it too, never the 403 `module_disabled`;
 *   - listing the set (spread, Array.from, size, forEach, a copy) throws, so no
 *     route can send an empty or partial list as the organization's modules.
 * And that a module known to be on (a row that was read, a comp that was read)
 * and every core module still answer `true`, and that a module really off
 * still answers `false`.
 */

const refs = vi.hoisted(() => ({
  client: null as unknown,
  /** Made-up values: the client double ignores both. */
  projectUrl: 'https://example.supabase.co',
  publicValue: 'test-public-value',
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: refs.projectUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: refs.publicValue,
  },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => refs.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => refs.client }));

import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

import { NON_CORE_MODULE_IDS } from '@/lib/modules/effective-modules';
import { assertModuleEnabled, isModuleEnabled } from '@/server/services/context';
import {
  LEGACY_ORG_ID,
  legacyContextClient,
  legacyContextWorld,
  legacyPhoneHeaders,
  type LegacyContextWorld,
} from '@/test/legacy-api-context';

import { withApiContext } from './api-context';

const CORE_MODULE_IDS = (Object.values(MODULE_REGISTRY) as Array<{ id: ModuleId; tier: string }>)
  .filter((m) => m.tier === 'core')
  .map((m) => m.id);

let world: LegacyContextWorld;

beforeEach(() => {
  world = legacyContextWorld();
  refs.client = legacyContextClient(world);
});

const bearer = () =>
  new Request('https://app.example.test/api/v1/mobile/snapshot', {
    headers: legacyPhoneHeaders(),
  });
/** A made-up session cookie of the Supabase SSR client's name shape. */
const COOKIE_HEADER_VALUE = ['sb-example', 'auth', 'token=placeholder'].join('-');
const cookie = () =>
  new Request('https://app.example.test/api/v1/me/releases', {
    headers: { cookie: COOKIE_HEADER_VALUE, 'x-organization-id': LEGACY_ORG_ID },
  });

/** What a read of an unknown module state threw: its name, or 'answered'. */
function thrownBy(read: () => unknown): string {
  try {
    read();
    return 'answered';
  } catch (e) {
    return e instanceof Error ? e.name : typeof e;
  }
}

const LISTINGS: Array<[string, (s: Set<ModuleId>) => unknown]> = [
  ['spread', (s) => [...s]],
  ['Array.from', (s) => Array.from(s)],
  ['size', (s) => s.size],
  ['forEach', (s) => s.forEach(() => {})],
  ['values', (s) => s.values()],
  ['keys', (s) => s.keys()],
  ['entries', (s) => s.entries()],
  ['a copy', (s) => new Set(s)],
];

const FAILURES: Array<[string, Partial<LegacyContextWorld>, ModuleId[]]> = [
  // [label, world, the modules known to be on]
  ['the rows read failed (not comped)', { moduleRowsFail: true }, []],
  [
    'the comp flag read failed (rows read)',
    { organizationFail: true, moduleRows: ['orders', 'rentals'] },
    ['orders', 'rentals'],
  ],
  ['both reads failed', { moduleRowsFail: true, organizationFail: true }, []],
  [
    'the organization row read back hidden (rows read)',
    { organizationHidden: true, comped: true, moduleRows: ['orders'] },
    ['orders'],
  ],
];

describe.each([
  ['BEARER (the phone)', bearer],
  ['COOKIE (the web app calling /api/v1)', cookie],
])('withApiContext, legacy reads: %s', (_label, request) => {
  describe.each(FAILURES)('when %s', (_what, failure, knownOn) => {
    beforeEach(() => Object.assign(world, failure));

    it('every non-core module not known to be on is a refusal, never off', async () => {
      const ctx = await withApiContext(request());
      expect(ctx).not.toBeNull();
      const unknown = NON_CORE_MODULE_IDS.filter((id) => !knownOn.includes(id));
      expect(unknown.length).toBeGreaterThan(0);
      for (const id of unknown) {
        expect([id, thrownBy(() => isModuleEnabled(ctx!, id))]).toEqual([
          id,
          'ModulesUnavailableError',
        ]);
        expect([id, thrownBy(() => assertModuleEnabled(ctx!, id))]).toEqual([
          id,
          'ModulesUnavailableError',
        ]);
        expect([id, thrownBy(() => ctx!.enabledModules.has(id))]).toEqual([
          id,
          'ModulesUnavailableError',
        ]);
      }
    });

    it('the set cannot be listed, so no route can send it as the modules', async () => {
      const ctx = await withApiContext(request());
      for (const [how, list] of LISTINGS) {
        expect([how, thrownBy(() => list(ctx!.enabledModules))]).toEqual([
          how,
          'ModulesUnavailableError',
        ]);
      }
    });

    it('a module known to be on and every core module still answer on', async () => {
      const ctx = await withApiContext(request());
      for (const id of [...knownOn, ...CORE_MODULE_IDS]) {
        expect([id, isModuleEnabled(ctx!, id)]).toEqual([id, true]);
        expect(() => assertModuleEnabled(ctx!, id)).not.toThrow();
      }
    });
  });

  it('reads that worked: a module really off answers off, and the set lists', async () => {
    world.moduleRows = ['orders'];
    const ctx = await withApiContext(request());
    expect([...ctx!.enabledModules]).toEqual(['orders']);
    expect(isModuleEnabled(ctx!, 'rentals')).toBe(false);
    expect(() => assertModuleEnabled(ctx!, 'rentals')).toThrow(
      expect.objectContaining({ name: 'ServiceError', code: 'module_disabled' }),
    );
  });

  it('a comp that was read is every non-core module even when the rows read failed', async () => {
    world.moduleRowsFail = true;
    world.comped = true;
    const ctx = await withApiContext(request());
    expect(ctx!.enabledModules.size).toBe(NON_CORE_MODULE_IDS.length);
    for (const id of NON_CORE_MODULE_IDS) expect(isModuleEnabled(ctx!, id)).toBe(true);
  });
});
