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

import { PORTAL_MAPPINGS_TRIED_MAX, readPortalGates, resolvePortalContext } from './portal';

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

/** PostgREST's row cap for one read (supabase/config.toml `max_rows`). */
const MAX_ROWS = 1000;

type OrderSpec = { column: string; ascending: boolean; nullsFirst: boolean };

/** A column ending in `_at` is a time and is compared as one. */
function compareValues(column: string, a: unknown, b: unknown): number {
  if (column.endsWith('_at')) return Date.parse(String(a)) - Date.parse(String(b));
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * `failTables`: reads of these tables come back the way PostgREST reports a
 * failure, `{ data: null, error: { message } }`.
 *
 * Reads behave as PostgREST's do: rows come back in the order they are
 * stored unless the read names an order (ASC puts a missing value last and
 * DESC first, unless `nullsFirst` says otherwise), at most `.limit()` rows and
 * never more than MAX_ROWS. A filter on an embedded column (`customer.status`)
 * drops the row when the embed is `!inner`, and otherwise empties the embed.
 */
function makeAdmin(db: Record<string, Row[]>, failTables: readonly string[] = []) {
  const failed = { data: null, error: { message: 'read failed' } };
  const updates: Array<{ table: string; patch: Row; rows: Row[] }> = [];
  /** One entry per request the service sends, by table. */
  const requests: string[] = [];
  /** One entry per `.in()` filter the service builds: table, column, values. */
  const inLists: Array<{ table: string; column: string; values: unknown[] }> = [];
  /** One entry per `.limit()` the service sets: table, row count. */
  const limits: Array<{ table: string; count: number }> = [];

  function chain(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    const embedFilters: Array<{ alias: string; column: string; val: unknown }> = [];
    const orders: OrderSpec[] = [];
    let selected = '';
    let limit: number | null = null;
    let patch: Row | null = null;
    const rows = () => (db[table] ?? []).filter((r) => preds.every((p) => p(r)));
    const readRows = () => {
      let out = rows().map((r) => ({ ...r }));
      for (const f of embedFilters) {
        const inner = new RegExp(`(^|[\\s,])${f.alias}:[a-z_]+!inner\\(`).test(selected);
        const hit = (r: Row) => (r[f.alias] as Row | null)?.[f.column] === f.val;
        out = inner ? out.filter(hit) : out.map((r) => (hit(r) ? r : { ...r, [f.alias]: null }));
      }
      if (orders.length > 0) {
        out.sort((a, b) => {
          for (const o of orders) {
            const va = a[o.column] ?? null;
            const vb = b[o.column] ?? null;
            if (va === null || vb === null) {
              if (va === vb) continue;
              return (va === null) === o.nullsFirst ? -1 : 1;
            }
            const c = compareValues(o.column, va, vb);
            if (c !== 0) return o.ascending ? c : -c;
          }
          return 0;
        });
      }
      return out.slice(0, Math.min(limit ?? MAX_ROWS, MAX_ROWS));
    };
    const builder: Record<string, unknown> = {
      select: (columns?: string) => {
        selected = columns ?? '';
        return builder;
      },
      eq: (col: string, val: unknown) => {
        const dot = col.indexOf('.');
        if (dot > 0) {
          embedFilters.push({ alias: col.slice(0, dot), column: col.slice(dot + 1), val });
          return builder;
        }
        preds.push((r) => r[col] === val);
        return builder;
      },
      order: (column: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}) => {
        const ascending = opts.ascending ?? true;
        orders.push({ column, ascending, nullsFirst: opts.nullsFirst ?? !ascending });
        return builder;
      },
      limit: (count: number) => {
        limits.push({ table, count });
        limit = count;
        return builder;
      },
      is: (col: string, val: unknown) => {
        preds.push((r) => (r[col] ?? null) === val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        inLists.push({ table, column: col, values: [...vals] });
        preds.push((r) => vals.includes(r[col]));
        return builder;
      },
      update: (p: Row) => {
        patch = p;
        return builder;
      },
      maybeSingle: async () => {
        requests.push(table);
        if (failTables.includes(table)) return failed;
        return { data: readRows()[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => {
        requests.push(table);
        if (!patch && failTables.includes(table)) return Promise.resolve(failed).then(resolve);
        if (patch) {
          const hit = rows();
          for (const r of hit) Object.assign(r, patch);
          updates.push({ table, patch, rows: hit });
          return Promise.resolve({ data: null, error: null }).then(resolve);
        }
        return Promise.resolve({ data: readRows(), error: null }).then(resolve);
      },
    };
    return builder;
  }

  return {
    client: { from: (table: string) => chain(table) },
    updates,
    requests,
    inLists,
    limits,
  };
}

let admin: ReturnType<typeof makeAdmin>;

function seed(mappings: Mapping[], orgs: OrgSetup[], failTables: readonly string[] = []) {
  admin = makeAdmin(
    {
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
    },
    failTables,
  );
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

  const DAY_MS = 86_400_000;
  const START = Date.UTC(2026, 0, 1);
  /** Mapping i's customer. Ids fall as i rises, so the id tie-break alone
   *  would pick the LAST acceptance: only the time order picks the first. */
  const cust = (i: number) => `${CUST_BASE}${pad(100 - i)}`;

  /** n accepted mappings, each in its own organization, accepted in order 1..n
   *  (one a day from 2026-01-01, every one a real date); stored in that order,
   *  or latest acceptance first. */
  function manyAccepted(
    n: number,
    portalOn: (i: number) => boolean | null,
    storedLatestFirst = false,
  ): Mapping[] {
    const mappings: Mapping[] = [];
    const orgs: OrgSetup[] = [];
    for (let i = 1; i <= n; i += 1) {
      mappings.push({
        customerId: cust(i),
        orgId: `${ORG_BASE}${pad(i)}`,
        name: `Academy ${i}`,
        invitedAt: new Date(START + (i - 1) * DAY_MS).toISOString(),
        acceptedAt: new Date(START + (i - 1) * DAY_MS + 3_600_000).toISOString(),
      });
      orgs.push({ id: `${ORG_BASE}${pad(i)}`, name: `Supply ${i}`, portal: portalOn(i) });
    }
    seed(storedLatestFirst ? [...mappings].reverse() : mappings, orgs);
    return mappings;
  }

  /** A customer id for the k-th of many mappings (k from 0). */
  const bulkCust = (k: number) => `0f000000-0000-4000-8000-${String(k).padStart(12, '0')}`;

  /** n invitations, none accepted, all to customers of North, invited one a
   *  minute from 2026-01-01 and stored in that order (the newest last). */
  function manyInvitations(n: number): Mapping[] {
    return Array.from({ length: n }, (_, k) => ({
      customerId: bulkCust(k),
      orgId: ORG_NORTH,
      name: `Invited Academy ${k}`,
      invitedAt: new Date(START + k * 60_000).toISOString(),
      acceptedAt: null,
    }));
  }

  it('the mappings read asks for as many rows as are tried, and no more', async () => {
    manyAccepted(3, () => true);
    await resolvePortalContext();
    expect(admin.limits.filter((l) => l.table === 'customer_users')).toEqual([
      { table: 'customer_users', count: PORTAL_MAPPINGS_TRIED_MAX },
    ]);
  });

  it('an accepted mapping stored after more invitations than one read returns still opens', async () => {
    seed(
      [
        ...manyInvitations(MAX_ROWS + 4),
        {
          customerId: CUST_SOUTH,
          orgId: ORG_SOUTH,
          name: 'South Academy',
          invitedAt: '2025-06-01T00:00:00+00:00',
          acceptedAt: '2025-06-02T00:00:00+00:00',
        },
      ],
      [
        { id: ORG_NORTH, name: 'North Supply', portal: true },
        { id: ORG_SOUTH, name: 'South Supply', portal: true },
      ],
    );
    expect((await resolvePortalContext())?.customerId).toBe(CUST_SOUTH);
    expect(stamped()).toEqual([]);
  });

  it('with only invitations, more than one read returns, the newest is the one tried and stamped', async () => {
    const invitations = manyInvitations(MAX_ROWS + 5);
    const newest = invitations[invitations.length - 1]!.customerId;
    seed(invitations, [{ id: ORG_NORTH, name: 'North Supply', portal: true }]);
    expect((await resolvePortalContext())?.customerId).toBe(newest);
    expect(stamped()).toEqual([newest]);
  });

  it('with more accepted mappings than the bound, stored latest first, the earliest acceptance opens', async () => {
    manyAccepted(
      PORTAL_MAPPINGS_TRIED_MAX + 5,
      (i) => i === 1 || i > PORTAL_MAPPINGS_TRIED_MAX,
      true,
    );
    expect((await resolvePortalContext())?.customerId).toBe(cust(1));
    manyAccepted(PORTAL_MAPPINGS_TRIED_MAX + 5, (i) => i > PORTAL_MAPPINGS_TRIED_MAX, true);
    expect(await resolvePortalContext()).toBeNull();
  });

  it('archived customers take no place in the bounded read: a later accepted active mapping opens', async () => {
    const archived: Mapping[] = Array.from({ length: PORTAL_MAPPINGS_TRIED_MAX + 2 }, (_, k) => ({
      customerId: bulkCust(k),
      orgId: ORG_NORTH,
      name: `Archived Academy ${k}`,
      invitedAt: new Date(START + k * 60_000).toISOString(),
      acceptedAt: new Date(START + k * 60_000 + 1_000).toISOString(),
      status: 'archived',
    }));
    seed(
      [
        ...archived,
        {
          customerId: CUST_SOUTH,
          orgId: ORG_SOUTH,
          name: 'South Academy',
          invitedAt: '2026-06-01T00:00:00+00:00',
          acceptedAt: '2026-06-02T00:00:00+00:00',
        },
      ],
      [
        { id: ORG_NORTH, name: 'North Supply', portal: true },
        { id: ORG_SOUTH, name: 'South Supply', portal: true },
      ],
    );
    expect((await resolvePortalContext())?.customerId).toBe(CUST_SOUTH);
  });

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
    expect((await resolvePortalContext())?.customerId).toBe(cust(5));
    expect(requestsTo('organization_modules')).toBe(1);
    expect(requestsTo('organizations')).toBe(1);
  });

  it('a single mapping makes the same reads as before: one of each table, nothing else', async () => {
    manyAccepted(1, () => true);
    expect((await resolvePortalContext())?.customerId).toBe(cust(1));
    expect(admin.requests.slice().sort()).toEqual([
      'customer_users',
      'organization_modules',
      'organizations',
    ]);
  });

  it('every fixture time is a real date, and acceptances rise with i', () => {
    const accepted = manyAccepted(40, () => true).map((m) => Date.parse(m.acceptedAt ?? ''));
    expect(accepted.every(Number.isFinite)).toBe(true);
    expect(accepted.every((t, k) => k === 0 || t > accepted[k - 1]!)).toBe(true);
  });

  it('the earliest acceptance is always considered, however many mappings there are', async () => {
    manyAccepted(40, (i) => i === 1);
    expect((await resolvePortalContext())?.customerId).toBe(cust(1));
  });

  it(`sends no .in() list longer than ${PORTAL_MAPPINGS_TRIED_MAX} values, however many mappings`, async () => {
    for (const n of [2, PORTAL_MAPPINGS_TRIED_MAX, PORTAL_MAPPINGS_TRIED_MAX + 1, 40]) {
      manyAccepted(n, () => false);
      expect(await resolvePortalContext()).toBeNull();
      const gateLists = admin.inLists.filter(
        (l) => l.table === 'organization_modules' || l.table === 'organizations',
      );
      expect(gateLists.map((l) => l.table).sort()).toEqual([
        'organization_modules',
        'organizations',
      ]);
      for (const l of admin.inLists) {
        expect(l.values.length).toBeLessThanOrEqual(PORTAL_MAPPINGS_TRIED_MAX);
      }
      for (const l of gateLists) {
        expect(l.values.length).toBe(Math.min(n, PORTAL_MAPPINGS_TRIED_MAX));
      }
    }
  });

  it(`considers only the first ${PORTAL_MAPPINGS_TRIED_MAX} accepted mappings in the order`, async () => {
    const last = PORTAL_MAPPINGS_TRIED_MAX;
    manyAccepted(last + 1, (i) => i === last || i === last + 1);
    expect((await resolvePortalContext())?.customerId).toBe(cust(last));
    manyAccepted(last + 1, (i) => i === last + 1);
    expect(await resolvePortalContext()).toBeNull();
  });
});

describe('resolvePortalContext: equal times and failed reads', () => {
  const tied = (first: 'north' | 'south'): Mapping[] => {
    const north: Mapping = {
      customerId: CUST_NORTH,
      orgId: ORG_NORTH,
      name: 'North Academy',
      invitedAt: '2026-03-01T00:00:00+00:00',
      acceptedAt: '2026-05-01T12:00:00+00:00',
    };
    // The same instant, written with another offset.
    const south: Mapping = {
      customerId: CUST_SOUTH,
      orgId: ORG_SOUTH,
      name: 'South Academy',
      invitedAt: '2026-04-01T00:00:00+00:00',
      acceptedAt: '2026-05-01T04:00:00-08:00',
    };
    return first === 'north' ? [north, south] : [south, north];
  };
  const bothOn: OrgSetup[] = [
    { id: ORG_NORTH, name: 'North Supply', portal: true },
    { id: ORG_SOUTH, name: 'South Supply', portal: true },
  ];

  it('two equal acceptances: the lower customer id opens, whatever order the rows are read in', async () => {
    for (const first of ['north', 'south'] as const) {
      for (let run = 0; run < 3; run += 1) {
        seed(tied(first), bothOn);
        expect((await resolvePortalContext())?.customerId).toBe(CUST_NORTH);
      }
    }
  });

  it('a failed module read opens nothing and stamps nothing, for several organizations', async () => {
    seed(tied('north'), bothOn, ['organization_modules']);
    expect(await resolvePortalContext()).toBeNull();
    expect(admin.updates).toEqual([]);
  });

  it('a failed organization read opens nothing and stamps nothing, for several organizations', async () => {
    seed(tied('south'), bothOn, ['organizations']);
    expect(await resolvePortalContext()).toBeNull();
    expect(admin.updates).toEqual([]);
  });

  it('a failed gate read for a single invitation neither opens nor stamps it', async () => {
    seed(
      [
        {
          customerId: CUST_EAST,
          orgId: ORG_EAST,
          name: 'East Academy',
          invitedAt: '2026-10-01T00:00:00+00:00',
          acceptedAt: null,
        },
      ],
      [{ id: ORG_EAST, name: 'East Supply', portal: true }],
      ['organization_modules'],
    );
    expect(await resolvePortalContext()).toBeNull();
    expect(admin.updates).toEqual([]);
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

describe('readPortalGates: the gate read holds its own bound', () => {
  const orgId = (k: number) => `0d100000-0000-4000-8000-${String(k).padStart(12, '0')}`;

  it(`reads at most ${PORTAL_MAPPINGS_TRIED_MAX} distinct organizations, the first given, when handed more`, async () => {
    const ids = Array.from({ length: PORTAL_MAPPINGS_TRIED_MAX + 5 }, (_, k) => orgId(k));
    seed(
      [],
      ids.map((id, k) => ({ id, name: `Supply ${k}`, portal: true })),
    );
    const gates = await readPortalGates(admin.client as never, ids);
    expect([...gates.keys()]).toEqual(ids.slice(0, PORTAL_MAPPINGS_TRIED_MAX));
    for (const id of ids.slice(PORTAL_MAPPINGS_TRIED_MAX)) expect(gates.has(id)).toBe(false);
    expect(admin.inLists.map((l) => [l.table, l.values]).sort()).toEqual([
      ['organization_modules', ids.slice(0, PORTAL_MAPPINGS_TRIED_MAX)],
      ['organizations', ids.slice(0, PORTAL_MAPPINGS_TRIED_MAX)],
    ]);
    for (const id of ids.slice(0, PORTAL_MAPPINGS_TRIED_MAX)) {
      expect(gates.get(id)?.moduleRow).toBeTruthy();
      expect(gates.get(id)?.org).toBeTruthy();
    }
  });

  it('counts distinct organizations: a repeated id takes no place in the bound', async () => {
    const ids = Array.from({ length: PORTAL_MAPPINGS_TRIED_MAX }, (_, k) => orgId(k));
    seed(
      [],
      ids.map((id, k) => ({ id, name: `Supply ${k}`, portal: true })),
    );
    const gates = await readPortalGates(admin.client as never, [ids[0]!, ...ids, ids[1]!]);
    expect([...gates.keys()]).toEqual(ids);
  });
});
