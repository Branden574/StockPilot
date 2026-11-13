import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which customer a signed-in portal account opens (resolvePortalContext).
 *
 * An account can be mapped to customers of several organizations. The order:
 *   1. an accepted mapping before one that is only invited;
 *   2. among accepted mappings, the EARLIEST acceptance first, so a later
 *      acceptance never takes the place of an earlier one;
 *   3. among invited mappings, the newest invitation first.
 * When the account has an accepted mapping, the first ACCEPTED mapping in
 * that order whose organization has the portal module on and a plan that
 * includes it is opened; an accepted mapping whose organization fails that
 * check, or has no portal module row at all, does not hide the next accepted
 * one, and an invitation is never opened in its place. Only an account with
 * no accepted mapping opens an invitation: the newest, alone, which is then
 * stamped accepted.
 *
 * The service-role client below is an in-memory stand-in that applies the
 * filters the service asks for and records every update. Made-up people and
 * organizations only.
 */

type Row = Record<string, unknown>;

const { adminRef, authUser } = vi.hoisted(() => ({
  adminRef: { current: null as unknown },
  authUser: { current: null as { id: string } | null },
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminRef.current }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: authUser.current }, error: null }) },
    from: () => {
      const q: Record<string, unknown> = {};
      const self = () => q;
      q.select = self;
      q.eq = self;
      q.maybeSingle = async () => ({ data: { disabled_at: null }, error: null });
      return q;
    },
  }),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/server/services/returns', () => ({
  pendingReturnQuantitiesByLine: vi.fn(async () => new Map<string, number>()),
}));

import { PORTAL_MAPPINGS_TRIED_MAX, resolvePortalContext } from './portal';

const ACCOUNT = '0a000000-0000-4000-8000-000000000001';
const ORG_NORTH = '0b000000-0000-4000-8000-000000000001';
const ORG_SOUTH = '0b000000-0000-4000-8000-000000000002';
const ORG_EAST = '0b000000-0000-4000-8000-000000000003';
const CUST_NORTH = '0c000000-0000-4000-8000-000000000001';
const CUST_SOUTH = '0c000000-0000-4000-8000-000000000002';
const CUST_EAST = '0c000000-0000-4000-8000-000000000003';

const BUSINESS = { plan: null, access_tier: 'business' };
const NO_PLAN = { plan: null };

interface Mapping {
  customerId: string;
  orgId: string;
  name: string;
  acceptedAt: string | null;
  invitedAt: string;
  /** The customer's status; active unless named. */
  status?: string;
}

function mappingRow(m: Mapping): Row {
  return {
    customer_id: m.customerId,
    user_id: ACCOUNT,
    email: 'buyer@example.test',
    accepted_at: m.acceptedAt,
    invited_at: m.invitedAt,
    customer: {
      id: m.customerId,
      name: m.name,
      status: m.status ?? 'active',
      organization_id: m.orgId,
      price_list_id: null,
    },
  };
}

interface OrgSetup {
  id: string;
  name: string;
  /** true/false: a b2b_portal module row, enabled or not; null: no row at all. */
  portal: boolean | null;
  billing?: Row;
}

function makeAdmin(db: Record<string, Row[]>) {
  const updates: Array<{ table: string; patch: Row; rows: Row[] }> = [];
  /** One entry per request the service sends, by table. */
  const requests: string[] = [];

  function chain(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    const rows = () => (db[table] ?? []).filter((r) => preds.every((p) => p(r)));
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        preds.push((r) => r[col] === val);
        return builder;
      },
      is: (col: string, val: unknown) => {
        preds.push((r) => (r[col] ?? null) === val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        preds.push((r) => vals.includes(r[col]));
        return builder;
      },
      update: (p: Row) => {
        patch = p;
        return builder;
      },
      maybeSingle: async () => {
        requests.push(table);
        return { data: rows()[0] ?? null, error: null };
      },
      then: (resolve: (v: { data: Row[] | null; error: null }) => unknown) => {
        requests.push(table);
        if (patch) {
          const hit = rows();
          for (const r of hit) Object.assign(r, patch);
          updates.push({ table, patch, rows: hit });
          return Promise.resolve({ data: null, error: null }).then(resolve);
        }
        return Promise.resolve({ data: rows(), error: null }).then(resolve);
      },
    };
    return builder;
  }

  return { client: { from: (table: string) => chain(table) }, updates, requests };
}

let admin: ReturnType<typeof makeAdmin>;

function seed(mappings: Mapping[], orgs: OrgSetup[]) {
  admin = makeAdmin({
    customer_users: mappings.map(mappingRow),
    organization_modules: orgs
      .filter((o) => o.portal !== null)
      .map((o) => ({
        organization_id: o.id,
        module_id: 'b2b_portal',
        enabled: o.portal,
        settings: null,
      })),
    organizations: orgs.map((o) => ({
      id: o.id,
      name: o.name,
      logo_url: null,
      ...(o.billing ?? BUSINESS),
    })),
  });
  adminRef.current = admin.client;
}

function requestsTo(table: string): number {
  return admin.requests.filter((t) => t === table).length;
}

function stamped(): string[] {
  return admin.updates
    .filter((u) => u.table === 'customer_users' && 'accepted_at' in u.patch)
    .flatMap((u) => u.rows.map((r) => r.customer_id as string));
}

beforeEach(() => {
  authUser.current = { id: ACCOUNT };
});

describe('resolvePortalContext: which of several accepted mappings opens', () => {
  it('opens the mapping accepted first, though the other was invited and accepted later', async () => {
    seed(
      [
        {
          customerId: CUST_NORTH,
          orgId: ORG_NORTH,
          name: 'North Academy',
          invitedAt: '2026-03-01T00:00:00.000000+00:00',
          acceptedAt: '2026-03-02T00:00:00.000000+00:00',
        },
        {
          customerId: CUST_SOUTH,
          orgId: ORG_SOUTH,
          name: 'South Academy',
          invitedAt: '2026-09-01T00:00:00.000000+00:00',
          acceptedAt: '2026-09-02T00:00:00.000000+00:00',
        },
      ],
      [
        { id: ORG_NORTH, name: 'North Supply', portal: true },
        { id: ORG_SOUTH, name: 'South Supply', portal: true },
      ],
    );
    const ctx = await resolvePortalContext();
    expect(ctx).toMatchObject({
      customerId: CUST_NORTH,
      organizationId: ORG_NORTH,
      orgName: 'North Supply',
    });
    expect(stamped()).toEqual([]);
  });

  it('orders by acceptance, not by invitation: an earlier acceptance of a later invite still opens', async () => {
    seed(
      [
        {
          customerId: CUST_NORTH,
          orgId: ORG_NORTH,
          name: 'North Academy',
          invitedAt: '2026-01-01T00:00:00.000000+00:00',
          acceptedAt: '2026-08-01T00:00:00.000000+00:00',
        },
        {
          customerId: CUST_SOUTH,
          orgId: ORG_SOUTH,
          name: 'South Academy',
          invitedAt: '2026-02-01T00:00:00.000000+00:00',
          acceptedAt: '2026-02-02T00:00:00.000000+00:00',
        },
      ],
      [
        { id: ORG_NORTH, name: 'North Supply', portal: true },
        { id: ORG_SOUTH, name: 'South Supply', portal: true },
      ],
    );
    expect((await resolvePortalContext())?.customerId).toBe(CUST_SOUTH);
  });

  it('compares acceptance times as times, not as text', async () => {
    seed(
      [
        {
          customerId: CUST_NORTH,
          orgId: ORG_NORTH,
          name: 'North Academy',
          invitedAt: '2026-05-01T00:00:00+00:00',
          // 2026-05-01T09:00Z, written with an offset that sorts first as text.
          acceptedAt: '2026-05-01T01:00:00-08:00',
        },
        {
          customerId: CUST_SOUTH,
          orgId: ORG_SOUTH,
          name: 'South Academy',
          invitedAt: '2026-05-01T00:00:00+00:00',
          acceptedAt: '2026-05-01T05:00:00+00:00',
        },
      ],
      [
        { id: ORG_NORTH, name: 'North Supply', portal: true },
        { id: ORG_SOUTH, name: 'South Supply', portal: true },
      ],
    );
    expect((await resolvePortalContext())?.customerId).toBe(CUST_SOUTH);
  });
});

describe('resolvePortalContext: an accepted mapping whose organization cannot open the portal does not hide the next accepted one', () => {
  // North comes first in the order (accepted first) and was also invited
  // last, so it is first by acceptance and by invitation alike.
  const twoAccepted: Mapping[] = [
    {
      customerId: CUST_NORTH,
      orgId: ORG_NORTH,
      name: 'North Academy',
      invitedAt: '2026-03-01T00:00:00+00:00',
      acceptedAt: '2026-03-02T00:00:00+00:00',
    },
    {
      customerId: CUST_SOUTH,
      orgId: ORG_SOUTH,
      name: 'South Academy',
      invitedAt: '2026-01-01T00:00:00+00:00',
      acceptedAt: '2026-04-02T00:00:00+00:00',
    },
  ];

  it('opens the next accepted mapping when the first one’s portal module is off', async () => {
    seed(twoAccepted, [
      { id: ORG_NORTH, name: 'North Supply', portal: false },
      { id: ORG_SOUTH, name: 'South Supply', portal: true },
    ]);
    const ctx = await resolvePortalContext();
    expect(ctx).toMatchObject({ customerId: CUST_SOUTH, orgName: 'South Supply' });
    expect(stamped()).toEqual([]);
  });

  it('opens the next accepted mapping when the first one’s organization has no portal module row', async () => {
    seed(twoAccepted, [
      { id: ORG_NORTH, name: 'North Supply', portal: null },
      { id: ORG_SOUTH, name: 'South Supply', portal: true },
    ]);
    expect((await resolvePortalContext())?.customerId).toBe(CUST_SOUTH);
  });

  it('opens the next accepted mapping when the first one’s plan does not include the portal', async () => {
    seed(twoAccepted, [
      { id: ORG_NORTH, name: 'North Supply', portal: true, billing: NO_PLAN },
      { id: ORG_SOUTH, name: 'South Supply', portal: true },
    ]);
    expect((await resolvePortalContext())?.customerId).toBe(CUST_SOUTH);
  });

  it('goes on past several such accepted mappings, in order, to the next accepted one', async () => {
    seed(
      [
        ...twoAccepted,
        {
          customerId: CUST_EAST,
          orgId: ORG_EAST,
          name: 'East Academy',
          invitedAt: '2026-10-01T00:00:00+00:00',
          acceptedAt: '2026-10-02T00:00:00+00:00',
        },
      ],
      [
        { id: ORG_NORTH, name: 'North Supply', portal: false },
        { id: ORG_SOUTH, name: 'South Supply', portal: null },
        { id: ORG_EAST, name: 'East Supply', portal: true },
      ],
    );
    expect((await resolvePortalContext())?.customerId).toBe(CUST_EAST);
    expect(stamped()).toEqual([]);
  });

  it('never passes an accepted mapping over to an invitation: a newer invitation elsewhere is neither opened nor stamped', async () => {
    seed(
      [
        twoAccepted[0]!,
        {
          customerId: CUST_EAST,
          orgId: ORG_EAST,
          name: 'East Academy',
          invitedAt: '2026-10-01T00:00:00+00:00',
          acceptedAt: null,
        },
      ],
      [
        { id: ORG_NORTH, name: 'North Supply', portal: false },
        { id: ORG_EAST, name: 'East Supply', portal: true },
      ],
    );
    expect(await resolvePortalContext()).toBeNull();
    expect(stamped()).toEqual([]);
    expect(admin.updates).toEqual([]);
  });

  it('with only invitations, tries the newest alone: an older invitation is not opened when the newest cannot be', async () => {
    seed(
      [
        {
          customerId: CUST_NORTH,
          orgId: ORG_NORTH,
          name: 'North Academy',
          invitedAt: '2026-09-01T00:00:00+00:00',
          acceptedAt: null,
        },
        {
          customerId: CUST_SOUTH,
          orgId: ORG_SOUTH,
          name: 'South Academy',
          invitedAt: '2026-03-01T00:00:00+00:00',
          acceptedAt: null,
        },
      ],
      [
        { id: ORG_NORTH, name: 'North Supply', portal: false },
        { id: ORG_SOUTH, name: 'South Supply', portal: true },
      ],
    );
    expect(await resolvePortalContext()).toBeNull();
    expect(stamped()).toEqual([]);
  });

  it('is not a portal user when no mapping’s organization can open the portal, and stamps nothing', async () => {
    seed(
      [
        twoAccepted[0]!,
        {
          customerId: CUST_SOUTH,
          orgId: ORG_SOUTH,
          name: 'South Academy',
          invitedAt: '2026-04-01T00:00:00+00:00',
          acceptedAt: null,
        },
      ],
      [
        { id: ORG_NORTH, name: 'North Supply', portal: null },
        { id: ORG_SOUTH, name: 'South Supply', portal: false },
      ],
    );
    expect(await resolvePortalContext()).toBeNull();
    expect(stamped()).toEqual([]);
  });
});

describe('resolvePortalContext: the reads are bounded', () => {
  const ORG_BASE = '0d000000-0000-4000-8000-0000000000';
  const CUST_BASE = '0e000000-0000-4000-8000-0000000000';
  const pad = (i: number) => String(i).padStart(2, '0');

  /** n accepted mappings, each in its own organization, accepted in order 1..n. */
  function manyAccepted(n: number, portalOn: (i: number) => boolean | null) {
    const mappings: Mapping[] = [];
    const orgs: OrgSetup[] = [];
    for (let i = 1; i <= n; i += 1) {
      mappings.push({
        customerId: `${CUST_BASE}${pad(i)}`,
        orgId: `${ORG_BASE}${pad(i)}`,
        name: `Academy ${i}`,
        invitedAt: `2026-01-${pad(i)}T00:00:00+00:00`,
        acceptedAt: `2026-02-${pad(i)}T00:00:00+00:00`,
      });
      orgs.push({ id: `${ORG_BASE}${pad(i)}`, name: `Supply ${i}`, portal: portalOn(i) });
    }
    seed(mappings, orgs);
  }

  it('reads each gate table once, however many mappings the account has', async () => {
    for (const n of [2, 5, 20]) {
      manyAccepted(n, () => false);
      expect(await resolvePortalContext()).toBeNull();
      expect(requestsTo('customer_users')).toBe(1);
      expect(requestsTo('organization_modules')).toBe(1);
      expect(requestsTo('organizations')).toBe(1);
    }
  });

  it('opens a later mapping in the order with the same two gate reads', async () => {
    manyAccepted(6, (i) => (i === 5 ? true : i % 2 === 0 ? null : false));
    expect((await resolvePortalContext())?.customerId).toBe(`${CUST_BASE}05`);
    expect(requestsTo('organization_modules')).toBe(1);
    expect(requestsTo('organizations')).toBe(1);
  });

  it('a single mapping makes the same reads as before: one of each table, nothing else', async () => {
    manyAccepted(1, () => true);
    expect((await resolvePortalContext())?.customerId).toBe(`${CUST_BASE}01`);
    expect(admin.requests.slice().sort()).toEqual([
      'customer_users',
      'organization_modules',
      'organizations',
    ]);
  });

  it('the earliest acceptance is always considered, however many mappings there are', async () => {
    manyAccepted(40, (i) => i === 1);
    expect((await resolvePortalContext())?.customerId).toBe(`${CUST_BASE}01`);
  });

  it(`considers only the first ${PORTAL_MAPPINGS_TRIED_MAX} accepted mappings in the order`, async () => {
    const last = PORTAL_MAPPINGS_TRIED_MAX;
    manyAccepted(last + 1, (i) => i === last || i === last + 1);
    expect((await resolvePortalContext())?.customerId).toBe(`${CUST_BASE}${pad(last)}`);
    manyAccepted(last + 1, (i) => i === last + 1);
    expect(await resolvePortalContext()).toBeNull();
  });
});

describe('resolvePortalContext: what stays as it was', () => {
  it('opens an accepted mapping before a newer invitation, and does not stamp the invitation', async () => {
    seed(
      [
        {
          customerId: CUST_NORTH,
          orgId: ORG_NORTH,
          name: 'North Academy',
          invitedAt: '2026-03-01T00:00:00+00:00',
          acceptedAt: '2026-03-02T00:00:00+00:00',
        },
        {
          customerId: CUST_SOUTH,
          orgId: ORG_SOUTH,
          name: 'South Academy',
          invitedAt: '2026-11-01T00:00:00+00:00',
          acceptedAt: null,
        },
      ],
      [
        { id: ORG_NORTH, name: 'North Supply', portal: true },
        { id: ORG_SOUTH, name: 'South Supply', portal: true },
      ],
    );
    expect((await resolvePortalContext())?.customerId).toBe(CUST_NORTH);
    expect(stamped()).toEqual([]);
  });

  it('with only invitations, opens the newest and stamps it accepted', async () => {
    seed(
      [
        {
          customerId: CUST_NORTH,
          orgId: ORG_NORTH,
          name: 'North Academy',
          invitedAt: '2026-03-01T00:00:00+00:00',
          acceptedAt: null,
        },
        {
          customerId: CUST_SOUTH,
          orgId: ORG_SOUTH,
          name: 'South Academy',
          invitedAt: '2026-06-01T00:00:00+00:00',
          acceptedAt: null,
        },
      ],
      [
        { id: ORG_NORTH, name: 'North Supply', portal: true },
        { id: ORG_SOUTH, name: 'South Supply', portal: true },
      ],
    );
    expect((await resolvePortalContext())?.customerId).toBe(CUST_SOUTH);
    expect(stamped()).toEqual([CUST_SOUTH]);
    const south = admin.updates[0]!.rows[0]!;
    expect(typeof south.accepted_at).toBe('string');
  });

  it('a single accepted mapping resolves to the same context as before', async () => {
    seed(
      [
        {
          customerId: CUST_NORTH,
          orgId: ORG_NORTH,
          name: 'North Academy',
          invitedAt: '2026-03-01T00:00:00+00:00',
          acceptedAt: '2026-03-02T00:00:00+00:00',
        },
      ],
      [{ id: ORG_NORTH, name: 'North Supply', portal: true }],
    );
    expect(await resolvePortalContext()).toEqual({
      userId: ACCOUNT,
      email: 'buyer@example.test',
      customerId: CUST_NORTH,
      customerName: 'North Academy',
      organizationId: ORG_NORTH,
      orgName: 'North Supply',
      orgLogoUrl: null,
      priceListId: null,
      pricingMode: 'no_charge',
    });
  });

  it('an archived customer is passed over, though its mapping was accepted first', async () => {
    seed(
      [
        {
          customerId: CUST_NORTH,
          orgId: ORG_NORTH,
          name: 'North Academy',
          invitedAt: '2026-03-01T00:00:00+00:00',
          acceptedAt: '2026-03-02T00:00:00+00:00',
          status: 'archived',
        },
        {
          customerId: CUST_SOUTH,
          orgId: ORG_SOUTH,
          name: 'South Academy',
          invitedAt: '2026-04-01T00:00:00+00:00',
          acceptedAt: '2026-04-02T00:00:00+00:00',
        },
      ],
      [
        { id: ORG_NORTH, name: 'North Supply', portal: true },
        { id: ORG_SOUTH, name: 'South Supply', portal: true },
      ],
    );
    expect((await resolvePortalContext())?.customerId).toBe(CUST_SOUTH);
  });

  it('no signed-in account is not a portal user', async () => {
    authUser.current = null;
    seed([], []);
    expect(await resolvePortalContext()).toBeNull();
  });
});
