import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NON_CORE_MODULE_IDS } from '@/lib/modules/effective-modules';

import {
  bundleMembership,
  heldMembership,
  holdMembership,
  modulesFromMembership,
  orgRowFromMembership,
  parseRequestContextBundle,
} from './request-context-bundle';

/**
 * Authorization is built from this answer, so the parser is STRICT: anything it
 * does not fully recognise returns null, and null means "resolve the request
 * with the legacy reads". Every test here is a way the answer could be wrong.
 */

const USER = 'u1';
const ORG = 'org-A';
const good = () => ({
  user_id: USER,
  profile: {
    id: USER,
    email: 'u1@example.com',
    full_name: 'Una One',
    avatar_url: null,
    default_organization_id: ORG,
    disabled_at: null,
  },
  memberships: [
    {
      organization_id: ORG,
      role: 'manager',
      organization: {
        id: ORG,
        name: 'Org A',
        logo_url: null,
        terminology: { item: 'Asset' },
        mfa_policy: 'admins_required',
        timezone: 'America/Los_Angeles',
        nav_overrides: null,
        dashboard_layout: null,
        order_status_config: null,
        all_modules_comp: false,
      },
      role_overrides: [{ permission: 'items:delete', granted: false }],
      user_overrides: [{ permission: 'items:delete', granted: true }],
      enabled_modules: ['books', 'orders'],
    },
  ],
});

describe('parseRequestContextBundle', () => {
  it('accepts the documented shape and keeps every field the context is built from', () => {
    const bundle = parseRequestContextBundle(good(), USER);
    expect(bundle?.profile).toEqual(good().profile);
    expect(bundle?.memberships).toHaveLength(1);
    const m = bundle!.memberships[0]!;
    expect(m.role).toBe('manager');
    expect(m.organization?.mfa_policy).toBe('admins_required');
    expect(m.organization?.terminology).toEqual({ item: 'Asset' });
    expect(m.role_overrides).toEqual([{ permission: 'items:delete', granted: false }]);
    expect(m.user_overrides).toEqual([{ permission: 'items:delete', granted: true }]);
    expect(m.enabled_modules).toEqual(['books', 'orders']);
  });

  it('refuses an answer about a different user than the one the proxy verified', () => {
    expect(parseRequestContextBundle(good(), 'someone-else')).toBeNull();
    expect(parseRequestContextBundle({ ...good(), user_id: null }, USER)).toBeNull();
    const otherProfile = good();
    otherProfile.profile.id = 'someone-else';
    expect(parseRequestContextBundle(otherProfile, USER)).toBeNull();
  });

  it('a missing profile row is allowed (the legacy read returns null too), a malformed one is not', () => {
    expect(parseRequestContextBundle({ ...good(), profile: null }, USER)?.profile).toBeNull();
    expect(parseRequestContextBundle({ ...good(), profile: 'x' }, USER)).toBeNull();
  });

  it('never reads a malformed disabled_at as "not disabled"', () => {
    const disabled = good();
    (disabled.profile as Record<string, unknown>).disabled_at = '2026-09-21T10:00:00+00:00';
    expect(parseRequestContextBundle(disabled, USER)?.profile?.disabled_at).toBe(
      '2026-09-21T10:00:00+00:00',
    );
    const odd = good();
    (odd.profile as Record<string, unknown>).disabled_at = 1_758_448_800;
    expect(parseRequestContextBundle(odd, USER)).toBeNull();
    const truthy = good();
    (truthy.profile as Record<string, unknown>).disabled_at = true;
    expect(parseRequestContextBundle(truthy, USER)).toBeNull();
  });

  it.each([
    [
      'an unknown role',
      (b: ReturnType<typeof good>) =>
        ((b.memberships[0] as Record<string, unknown>).role = 'superuser'),
    ],
    [
      'a role that is not a string',
      (b: ReturnType<typeof good>) => ((b.memberships[0] as Record<string, unknown>).role = null),
    ],
    [
      'overrides that are not an array',
      (b: ReturnType<typeof good>) =>
        ((b.memberships[0] as Record<string, unknown>).role_overrides = null),
    ],
    [
      'an override whose granted is not a boolean',
      (b: ReturnType<typeof good>) =>
        ((b.memberships[0] as Record<string, unknown>).user_overrides = [
          { permission: 'items:delete', granted: 'true' },
        ]),
    ],
    [
      'an override with no permission',
      (b: ReturnType<typeof good>) =>
        ((b.memberships[0] as Record<string, unknown>).role_overrides = [{ granted: true }]),
    ],
    [
      'modules that are not strings',
      (b: ReturnType<typeof good>) =>
        ((b.memberships[0] as Record<string, unknown>).enabled_modules = [1, 2]),
    ],
    [
      'an organization row for a DIFFERENT organization',
      (b: ReturnType<typeof good>) =>
        ((b.memberships[0]!.organization as Record<string, unknown>).id = 'org-B'),
    ],
    [
      'memberships that are not an array',
      (b: ReturnType<typeof good>) => ((b as Record<string, unknown>).memberships = {}),
    ],
    // Read loosely, each of these would WIDEN access downstream (no MFA policy = "optional",
    // no comp flag = whatever the caller defaults to, no disabled_at = "active").
    ['an organization with NO mfa_policy key', (b: ReturnType<typeof good>) => delete (b.memberships[0]!.organization as Record<string, unknown>).mfa_policy],
    ['an mfa_policy that is null', (b: ReturnType<typeof good>) => ((b.memberships[0]!.organization as Record<string, unknown>).mfa_policy = null)],
    ['an mfa_policy the app does not know', (b: ReturnType<typeof good>) => ((b.memberships[0]!.organization as Record<string, unknown>).mfa_policy = 'ALL_REQUIRED')],
    ['an mfa_policy that is not a string', (b: ReturnType<typeof good>) => ((b.memberships[0]!.organization as Record<string, unknown>).mfa_policy = 42)],
    ['an organization with NO all_modules_comp key', (b: ReturnType<typeof good>) => delete (b.memberships[0]!.organization as Record<string, unknown>).all_modules_comp],
    ['an all_modules_comp that is not a boolean', (b: ReturnType<typeof good>) => ((b.memberships[0]!.organization as Record<string, unknown>).all_modules_comp = 'true')],
    ['a profile with NO disabled_at key', (b: ReturnType<typeof good>) => delete (b.profile as Record<string, unknown>).disabled_at],
  ])('refuses %s', (_name, mutate) => {
    const b = good();
    mutate(b);
    expect(parseRequestContextBundle(b, USER)).toBeNull();
  });

  it('refuses anything that is not an object', () => {
    for (const raw of [null, undefined, 'x', 1, [], true]) {
      expect(parseRequestContextBundle(raw, USER)).toBeNull();
    }
  });

  it('an organization row hidden by RLS is kept as null, and no membership is invented', () => {
    const hidden = good();
    (hidden.memberships[0] as Record<string, unknown>).organization = null;
    const bundle = parseRequestContextBundle(hidden, USER);
    expect(bundle?.memberships[0]?.organization).toBeNull();
    expect(bundleMembership(bundle, 'org-Z')).toBeNull();
    expect(bundleMembership(null, ORG)).toBeNull();
  });
});

// ── the membership carried on the context it produced ───────────────────────
//
// withContext() reads the org row and modules from the membership that resolved
// requireOrgContext() instead of asking get_request_context() twice more (a
// Server Action does not memoize). These pin what may and may not travel.

describe('holdMembership / heldMembership', () => {
  const held = () => parseRequestContextBundle(good(), USER)!.memberships[0]!;
  const ctxFor = (organizationId: string, role: string) =>
    ({ organizationId, role }) as { organizationId: string; role: 'manager' };

  it('hands back the membership for the organization and role the context carries', () => {
    const m = held();
    const ctx = holdMembership(ctxFor(ORG, 'manager'), m);
    expect(heldMembership(ctx)).toBe(m);
  });

  it('refuses a membership for another organization or another role', () => {
    expect(heldMembership(holdMembership(ctxFor('org-B', 'manager'), held()))).toBeNull();
    expect(heldMembership(holdMembership(ctxFor(ORG, 'admin'), held()))).toBeNull();
  });

  it('attaches nothing for a null membership (the legacy reads ran)', () => {
    const ctx = holdMembership(ctxFor(ORG, 'manager'), null);
    expect(heldMembership(ctx)).toBeNull();
    expect(Object.getOwnPropertySymbols(ctx)).toEqual([]);
  });

  it('never travels in a copy or a serialization of the context', () => {
    const ctx = holdMembership(ctxFor(ORG, 'manager'), held());
    // A spread (what a page does to pass the context along) drops it...
    expect(heldMembership({ ...ctx })).toBeNull();
    // ...and so does anything that serializes it toward a client component.
    expect(JSON.stringify(ctx)).toBe(JSON.stringify({ organizationId: ORG, role: 'manager' }));
    expect(Object.keys(ctx)).toEqual(['organizationId', 'role']);
  });
});

describe('orgRowFromMembership / modulesFromMembership', () => {
  it('read the organization row and the effective module set off the membership', () => {
    const m = parseRequestContextBundle(good(), USER)!.memberships[0]!;
    expect(orgRowFromMembership(m)).toEqual({
      terminology: { item: 'Asset' },
      mfa_policy: 'admins_required',
      logo_url: null,
      timezone: 'America/Los_Angeles',
      nav_overrides: null,
      dashboard_layout: null,
      order_status_config: null,
      all_modules_comp: false,
    });
    expect([...modulesFromMembership(m)!].sort()).toEqual(['books', 'orders']);
  });

  it('a comped organization gets every non-core module, through the one rule', () => {
    const b = good();
    b.memberships[0]!.organization.all_modules_comp = true;
    const m = parseRequestContextBundle(b, USER)!.memberships[0]!;
    for (const id of NON_CORE_MODULE_IDS) expect(modulesFromMembership(m)!.has(id)).toBe(true);
  });

  it('answer null when RLS hid the organization, so the caller takes the legacy read', () => {
    const hidden = good();
    (hidden.memberships[0] as Record<string, unknown>).organization = null;
    const m = parseRequestContextBundle(hidden, USER)!.memberships[0]!;
    expect(orgRowFromMembership(m)).toBeNull();
    expect(modulesFromMembership(m)).toBeNull();
    expect(orgRowFromMembership(null)).toBeNull();
    expect(modulesFromMembership(null)).toBeNull();
  });
});

// ── the loader ───────────────────────────────────────────────────────────────

const rpc = vi.fn();
let headerUserId: string | null = USER;
vi.mock('next/headers', () => ({
  headers: vi.fn(
    async () => new Headers(headerUserId ? { 'x-stockpilot-user-id': headerUserId } : {}),
  ),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ rpc }) }));

async function freshLoader() {
  vi.resetModules();
  return (await import('./request-context-bundle')).loadRequestContextBundle;
}

describe('loadRequestContextBundle', () => {
  beforeEach(() => {
    rpc.mockReset();
    headerUserId = USER;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('asks once, with GET, and returns the parsed answer', async () => {
    rpc.mockResolvedValue({ data: good(), error: null });
    const load = await freshLoader();
    const bundle = await load();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_request_context', undefined, { get: true });
    expect(bundle?.memberships[0]?.organization_id).toBe(ORG);
  });

  it('returns null (legacy reads) when the function is missing or fails, and logs only the code', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'secret detail' } });
    const load = await freshLoader();
    expect(await load()).toBeNull();
    const logged = JSON.stringify((console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).toContain('PGRST202');
    expect(logged).not.toContain('secret detail');
  });

  it('returns null when the client throws, when the answer is malformed, and when it is about someone else', async () => {
    rpc.mockRejectedValueOnce(new Error('network'));
    expect(await (await freshLoader())()).toBeNull();
    rpc.mockResolvedValueOnce({ data: { nope: true }, error: null });
    expect(await (await freshLoader())()).toBeNull();
    rpc.mockResolvedValueOnce({ data: { ...good(), user_id: 'someone-else' }, error: null });
    expect(await (await freshLoader())()).toBeNull();
  });

  it('compares the answer with the PROXY HEADER, not with itself', async () => {
    // Fully self-consistent answers about ANOTHER user: only the header can tell.
    const theirs = good();
    theirs.user_id = 'someone-else';
    theirs.profile.id = 'someone-else';
    rpc.mockResolvedValueOnce({ data: theirs, error: null });
    expect(await (await freshLoader())()).toBeNull();
    rpc.mockResolvedValueOnce({ data: { ...good(), user_id: 'someone-else', profile: null }, error: null });
    expect(await (await freshLoader())()).toBeNull();
    // ... and the same answer IS accepted when the header names that user.
    headerUserId = 'someone-else';
    rpc.mockResolvedValueOnce({ data: theirs, error: null });
    expect((await (await freshLoader())())?.profile?.id).toBe('someone-else');
  });

  it('never calls the database without a proxy-verified user', async () => {
    headerUserId = null;
    expect(await (await freshLoader())()).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('REQUEST_CONTEXT_RPC=off is the switch back to the legacy reads', async () => {
    vi.stubEnv('REQUEST_CONTEXT_RPC', 'off');
    rpc.mockResolvedValue({ data: good(), error: null });
    expect(await (await freshLoader())()).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});
