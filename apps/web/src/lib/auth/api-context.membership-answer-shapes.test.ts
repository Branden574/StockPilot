import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SECURITY TEST: the membership choice over the real PostgREST client
 * (lib/auth/api-context.ts pickActiveMembership, both sign-in paths).
 *
 * The real withApiContext runs on its legacy reads (the one-round-trip context
 * read fails), and its table reads go through the real supabase-js client to
 * a stub fetch, so every answer below is resolved by postgrest-js itself.
 *
 * postgrest-js resolves four gateway answers with no error and no rows: a 404
 * with an empty body (rewritten to 204), a 2xx with an empty body, a 2xx with
 * the body `null`, and a non-2xx whose body is JSON `null`. None of them is a
 * list of rows, so each refuses the request with MembershipUnavailableError,
 * a retryable 5xx, on each of the four reads, and no context is built. An empty
 * list answered with status 200 is "no row", answered as before.
 *
 * Made-up ids and addresses only; the stub fetch answers every request.
 */

const refs = vi.hoisted(() => ({
  client: null as unknown,
  /** Made-up values: the stub fetch answers everything. */
  projectUrl: 'https://example.supabase.co',
  publicValue: 'test-public-value',
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: refs.projectUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: refs.publicValue,
  },
}));
vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: () => refs.client,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => refs.client }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { legacyBearerToken, LEGACY_USER_ID } from '@/test/legacy-api-context';

import { withApiContext } from './api-context';

/** The refusal (lib/auth/membership-unavailable.ts), matched by name and code. */
const REFUSED = { name: 'MembershipUnavailableError', code: 'MEMBERSHIP_UNAVAILABLE' };

const OLDEST = '77777777-0000-4000-8000-00000000000a';
const DEFAULT = '88888888-0000-4000-8000-000000000002';

type ReadKey = 'named' | 'profile' | 'oldest';

const json = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } });

/** The four answers with neither rows nor an error, as a gateway may send them. */
const SHAPES: Array<[string, () => Response]> = [
  ['a 404 with an empty body', () => new Response('', { status: 404 })],
  ['a 2xx with an empty body', () => new Response('', { status: 200 })],
  ['a 2xx with the body null', () => json(200, 'null')],
  ['a non-2xx whose body is null', () => json(502, 'null')],
];

let overrides: Partial<Record<ReadKey, () => Response>>;
let defaultOrg: string | null;
let membershipReads: number;

/** What the stub database answers when nothing is overridden. */
function healthy(url: URL): Response {
  const table = url.pathname.split('/').pop();
  const select = url.searchParams.get('select') ?? '';
  const named = url.searchParams.get('organization_id');
  switch (table) {
    case 'user_profiles':
      return select.includes('default_organization_id')
        ? json(200, JSON.stringify([{ default_organization_id: defaultOrg }]))
        : json(200, JSON.stringify([{ disabled_at: null }]));
    case 'organization_members':
      if (named === `eq.${DEFAULT}`) {
        return json(200, JSON.stringify([{ organization_id: DEFAULT, role: 'manager' }]));
      }
      if (named === `eq.${OLDEST}`) {
        return json(200, JSON.stringify([{ organization_id: OLDEST, role: 'staff' }]));
      }
      if (named) return json(200, '[]');
      return json(200, JSON.stringify([{ organization_id: OLDEST, role: 'staff' }]));
    case 'organizations':
      return json(200, JSON.stringify([{ mfa_policy: 'optional', all_modules_comp: false }]));
    default:
      return json(200, '[]');
  }
}

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const table = url.pathname.split('/').pop();
  const select = url.searchParams.get('select') ?? '';
  let key: ReadKey | null = null;
  if (table === 'user_profiles' && select.includes('default_organization_id')) key = 'profile';
  if (table === 'organization_members') {
    membershipReads += 1;
    key = url.searchParams.get('organization_id') ? 'named' : 'oldest';
  }
  const override = key ? overrides[key] : undefined;
  return override ? override() : healthy(url);
}

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  overrides = {};
  defaultOrg = DEFAULT;
  membershipReads = 0;
  const { createClient } =
    await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
  const real = createClient(refs.projectUrl, refs.publicValue, {
    global: { fetch: stubFetch },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  refs.client = {
    from: (table: string) => real.from(table),
    // The one-round-trip context read fails, so the legacy reads run.
    rpc: async () => ({ data: null, error: { code: 'PGRST301', message: 'unavailable' } }),
    auth: {
      getUser: async () => ({
        data: { user: { id: LEGACY_USER_ID, email: 'member@example.com', factors: [] } },
        error: null,
      }),
    },
  };
});

type Path = 'phone' | 'cookie';
const PATHS: Path[] = ['phone', 'cookie'];

function request(path: Path, orgHeader: string | null): Request {
  const headers: Record<string, string> =
    path === 'phone'
      ? { authorization: `Bearer ${legacyBearerToken()}` }
      : { cookie: 'sb-example-auth-token=made-up-cookie' };
  if (orgHeader !== null) headers['x-organization-id'] = orgHeader;
  return new Request('https://app.example.test/api/v1/example', { headers });
}

async function servedIn(path: Path, orgHeader: string | null): Promise<string | null> {
  return (await withApiContext(request(path, orgHeader)))?.organizationId ?? null;
}

describe.each(PATHS)('answers the real client resolves as lists (%s path)', (path) => {
  it('a member naming an organization, or naming none: that organization, or the default', async () => {
    expect(await servedIn(path, OLDEST)).toBe(OLDEST);
    expect(await servedIn(path, null)).toBe(DEFAULT);
  });

  it('an empty list at 200 for the named organization: null (401)', async () => {
    overrides.named = () => json(200, '[]');
    expect(await servedIn(path, DEFAULT)).toBeNull();
  });

  it('an empty list at 200 for the profile: no default, the oldest membership', async () => {
    overrides.profile = () => json(200, '[]');
    expect(await servedIn(path, null)).toBe(OLDEST);
  });

  it('a profile whose default is null: the oldest membership', async () => {
    defaultOrg = null;
    expect(await servedIn(path, null)).toBe(OLDEST);
  });

  it('an empty list at 200 for the default membership: the oldest membership', async () => {
    overrides.named = () => json(200, '[]');
    expect(await servedIn(path, null)).toBe(OLDEST);
  });

  it('an empty list at 200 for the oldest membership: null (401)', async () => {
    defaultOrg = null;
    overrides.oldest = () => json(200, '[]');
    expect(await servedIn(path, null)).toBeNull();
  });

  it('a header in braces or without hyphens: null (401), and no membership read', async () => {
    expect(await servedIn(path, `{${DEFAULT}}`)).toBeNull();
    expect(await servedIn(path, DEFAULT.replace(/-/g, ''))).toBeNull();
    expect(membershipReads).toBe(0);
  });
});

describe.each(PATHS)('answers with neither rows nor an error (%s path)', (path) => {
  it.each(SHAPES)(
    'the membership in the named organization, %s: refused with a retry',
    async (_s, shape) => {
      overrides.named = shape;
      await expect(withApiContext(request(path, DEFAULT))).rejects.toMatchObject(REFUSED);
    },
  );

  it.each(SHAPES)(
    'the profile default organization, %s: refused with a retry',
    async (_s, shape) => {
      overrides.profile = shape;
      await expect(withApiContext(request(path, null))).rejects.toMatchObject(REFUSED);
    },
  );

  it.each(SHAPES)(
    'the membership in the default organization, %s: refused with a retry',
    async (_s, shape) => {
      overrides.named = shape;
      await expect(withApiContext(request(path, null))).rejects.toMatchObject(REFUSED);
    },
  );

  it.each(SHAPES)('the oldest membership, %s: refused with a retry', async (_s, shape) => {
    defaultOrg = null;
    overrides.oldest = shape;
    await expect(withApiContext(request(path, null))).rejects.toMatchObject(REFUSED);
  });
});
