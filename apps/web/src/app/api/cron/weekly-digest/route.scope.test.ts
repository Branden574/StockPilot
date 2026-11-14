import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NOT_A_LIST } from '@/test/postgrest-answers';
import { makeSupabaseStub, type MockCall, type QueryResult } from '@/test/supabase-mock';

/**
 * Security invariant: each weekly digest recipient is sent only what they may
 * read.
 *
 * The cron reads with the service role, which bypasses row-level security,
 * and it used to send one org-wide payload to every opted-in member. Any
 * member can opt in, so a staff member scoped to one warehouse was mailed
 * every warehouse's low stock and every open purchase order, and a viewer
 * limited to some categories saw the others. This runs the REAL digest
 * service (only the email renderer and Resend are stubbed) against a service
 * role that answers every row, and checks what each recipient was sent
 * against what the SELECT policies would let them read
 * (inventory_items_select, purchase_orders_select, warehouses_select,
 * cycle_counts_select and cycle_count_lines_select; see services/digest.ts).
 */

vi.mock('@/lib/env', () => ({
  env: { CRON_SECRET: 'test-cron-secret', NEXT_PUBLIC_APP_URL: 'https://stockpilotusa.com' },
}));

const reportErrorMock = vi.fn();
vi.mock('@/lib/error-reporter', () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminHolder.client),
}));

const sendEmailMock = vi.fn(async (_args: { to: string }) => ({ ok: true }));
vi.mock('@/lib/email/resend', () => ({
  sendEmail: (args: { to: string }) => sendEmailMock(args),
}));

/** What the renderer was handed, by recipient name. */
const rendered = new Map<string, Payload>();
vi.mock('@/lib/email/es/families/digest', () => ({
  DIGEST_FROM: 'StockPilot <digest@stockpilotusa.com>',
  renderWeeklyDigestHtml: vi.fn((payload: Payload, opts: { recipientName?: string | null }) => {
    rendered.set(String(opts.recipientName), payload);
    return '<html>digest</html>';
  }),
  weeklyDigestSubject: vi.fn(() => 'StockPilot weekly digest'),
  weeklyDigestText: vi.fn(() => 'digest text'),
}));

import { GET } from './route';

interface Payload {
  lowStock: Array<{ warehouseName: string; items: Array<{ id: string }> }>;
  openPos: Array<{ id: string }>;
  openCycleCounts: Array<{
    id: string;
    scopeLabel: string;
    warehouseName: string | null;
    totalLines: number;
    countedLines: number;
  }>;
}

const ORG = 'org-1';

// ── The org, as the service role reads it ────────────────────────────
const WAREHOUSES: Record<string, string> = { 'wh-a': 'North DC', 'wh-b': 'South DC' };
const item = (
  id: string,
  warehouse_id: string | null,
  charter_id: string | null,
  category_id: string | null,
) => ({
  id,
  sku: id.toUpperCase(),
  name: `Item ${id}`,
  quantity_on_hand: 0,
  reorder_point: 5,
  warehouse_id,
  charter_id,
  category_id,
  warehouse: warehouse_id ? { name: WAREHOUSES[warehouse_id] } : null,
});
const ITEMS = [
  item('a-generic', 'wh-a', null, 'cat-books'),
  item('a-ch1', 'wh-a', 'ch-1', 'cat-sports'),
  item('a-ch2', 'wh-a', 'ch-2', 'cat-books'),
  item('b-books', 'wh-b', null, 'cat-books'),
  item('b-sports', 'wh-b', null, 'cat-sports'),
  item('b-uncategorised', 'wh-b', null, null),
  // No warehouse: no arm of inventory_items_select matches, nobody reads it.
  item('no-warehouse', null, null, 'cat-books'),
];
const po = (id: string, destination_location_id: string | null, destWarehouse: string | null) => ({
  id,
  po_number: id.toUpperCase(),
  status: 'ordered',
  expected_at: '2026-10-20T00:00:00Z',
  destination_location_id,
  destination: destination_location_id ? { warehouse_id: destWarehouse } : null,
  supplier: { name: 'Meridian' },
});
const POS = [
  po('po-to-a', 'loc-a', 'wh-a'),
  po('po-to-b', 'loc-b', 'wh-b'),
  // A destination with no warehouse, and no destination at all: nothing to
  // scope by, so every member holding purchase_orders:read reads them.
  po('po-to-org-level', 'loc-org', null),
  po('po-no-destination', null, null),
];
const COUNTS = [
  {
    id: 'cc-a',
    count_number: 1,
    started_at: '2026-10-01T00:00:00Z',
    warehouse_id: 'wh-a',
    scope: 'warehouse',
    assigned_to: null,
    warehouse: { name: 'North DC' },
  },
  {
    id: 'cc-b',
    count_number: 2,
    started_at: '2026-10-02T00:00:00Z',
    warehouse_id: 'wh-b',
    scope: 'warehouse',
    assigned_to: null,
    warehouse: { name: 'South DC' },
  },
  {
    id: 'cc-all',
    count_number: 3,
    started_at: '2026-10-03T00:00:00Z',
    warehouse_id: null,
    scope: 'all',
    assigned_to: null,
    warehouse: null,
  },
  // A selection with no header warehouse, assigned to the North staff member,
  // whose only line is at South DC.
  {
    id: 'cc-mine-b',
    count_number: 4,
    started_at: '2026-10-04T00:00:00Z',
    warehouse_id: null,
    scope: 'selection',
    assigned_to: 'staff-a',
    warehouse: null,
  },
];
// Each count's lines: the item, and whether it was counted.
const itemFor = (id: string) => ITEMS.find((i) => i.id === id)!;
const line = (cycle_count_id: string, itemId: string, counted: boolean) => {
  const it = itemFor(itemId);
  return {
    cycle_count_id,
    warehouse_id: it.warehouse_id,
    counted_quantity: counted ? 1 : null,
    item: { warehouse_id: it.warehouse_id, charter_id: it.charter_id, category_id: it.category_id },
  };
};
const LINES = [
  line('cc-a', 'a-generic', true),
  line('cc-a', 'a-ch1', false),
  line('cc-a', 'a-ch2', true),
  line('cc-b', 'b-books', true),
  line('cc-b', 'b-sports', false),
  line('cc-all', 'a-generic', true),
  line('cc-all', 'b-books', true),
  line('cc-mine-b', 'b-sports', false),
];

// ── The recipients ───────────────────────────────────────────────────
const MEMBERS: Record<string, { name: string; role: string }> = {
  owner: { name: 'Olive Owner', role: 'owner' },
  manager: { name: 'Mona Manager', role: 'manager' },
  'staff-a': { name: 'Sam StaffA', role: 'staff' },
  'staff-no-po': { name: 'Nia NoPo', role: 'staff' },
  'viewer-books': { name: 'Vic Books', role: 'viewer' },
  'viewer-all-cats': { name: 'Val AllCats', role: 'viewer' },
};
const WAREHOUSE_ASSIGNMENTS = [
  // Staff at North DC for charter ch-1 only: generic stock there and ch-1.
  { id: 'uwa-1', user_id: 'staff-a', warehouse_id: 'wh-a', charter_id: 'ch-1' },
  { id: 'uwa-2', user_id: 'staff-no-po', warehouse_id: 'wh-a', charter_id: null },
  { id: 'uwa-3', user_id: 'viewer-books', warehouse_id: 'wh-b', charter_id: null },
  { id: 'uwa-4', user_id: 'viewer-all-cats', warehouse_id: 'wh-b', charter_id: null },
];
const CATEGORY_ASSIGNMENTS = [{ id: 'uca-1', user_id: 'viewer-books', category_id: 'cat-books' }];
// Viewers lose purchase_orders:read in this org; one viewer is given it back,
// and one staff member has it revoked. The owner keeps it whatever the
// overrides say (has_permission answers true for an owner first).
const ROLE_OVERRIDES = [
  { role: 'viewer', granted: false },
  { role: 'owner', granted: false },
];
const USER_OVERRIDES = [
  { user_id: 'viewer-books', granted: true },
  { user_id: 'staff-no-po', granted: false },
];
const ROLE_DEFAULTS = ['owner', 'admin', 'manager', 'staff', 'viewer'].map((role) => ({ role }));

function inValues(call: MockCall, column: string): unknown[] {
  const i = call.methods.findIndex((m, idx) => m === 'in' && call.args[idx]?.[0] === column);
  return i === -1 ? [] : (call.args[i]?.[1] as unknown[]);
}
function eqValue(call: MockCall, column: string): unknown {
  const i = call.methods.findIndex((m, idx) => m === 'eq' && call.args[idx]?.[0] === column);
  return i === -1 ? undefined : call.args[i]?.[1];
}
const rows = (data: unknown[]): QueryResult => ({ data, error: null });

function orgStub(overrides: Record<string, QueryResult | ((call: MockCall) => QueryResult)> = {}) {
  return makeSupabaseStub({
    'user_profiles.select': rows(
      Object.entries(MEMBERS).map(([id, m]) => ({
        id,
        email: `${id}@acme.test`,
        full_name: m.name,
        digest_section_low_stock: true,
        digest_section_open_pos: true,
        digest_section_cycle_counts: true,
        organization_members: [
          {
            organization_id: ORG,
            accepted_at: '2026-01-01T00:00:00Z',
            organizations: { id: ORG, name: 'Acme' },
          },
        ],
      })),
    ),
    'user_profiles.select.maybeSingle': rows([{ email_digest_optin: true, disabled_at: null }]),
    'organization_members.select.maybeSingle': (call) => {
      const userId = String(eqValue(call, 'user_id'));
      return rows([
        { user_id: userId, accepted_at: '2026-01-01T00:00:00Z', role: MEMBERS[userId]!.role },
      ]);
    },
    'inventory_items.select': rows(ITEMS),
    'purchase_orders.select': rows(POS),
    'cycle_counts.select': rows(COUNTS),
    'cycle_count_lines.select': (call) =>
      rows(LINES.filter((l) => inValues(call, 'cycle_count_id').includes(l.cycle_count_id))),
    'user_warehouse_assignments.select': (call) =>
      rows(WAREHOUSE_ASSIGNMENTS.filter((r) => inValues(call, 'user_id').includes(r.user_id))),
    'user_category_assignments.select': (call) =>
      rows(CATEGORY_ASSIGNMENTS.filter((r) => inValues(call, 'user_id').includes(r.user_id))),
    'user_permission_overrides.select': (call) =>
      rows(USER_OVERRIDES.filter((r) => inValues(call, 'user_id').includes(r.user_id))),
    'role_permission_overrides.select': rows(ROLE_OVERRIDES),
    'role_default_permissions.select': rows(ROLE_DEFAULTS),
    'idempotency_keys.insert': rows([{ id: 'claim' }]),
    ...overrides,
  });
}

const request = () =>
  new Request('https://test.local/api/cron/weekly-digest', {
    headers: { authorization: 'Bearer test-cron-secret' },
  });

function sentTo(name: string) {
  const p = rendered.get(name);
  if (!p) throw new Error(`${name} was sent no digest`);
  return {
    items: p.lowStock.flatMap((g) => g.items.map((i) => i.id)).sort(),
    warehouses: p.lowStock.map((g) => g.warehouseName),
    pos: p.openPos.map((x) => x.id).sort(),
    counts: p.openCycleCounts.map((c) => `${c.id}: ${c.scopeLabel}`),
    countLines: p.openCycleCounts.map((c) => `${c.id} ${c.countedLines}/${c.totalLines}`),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rendered.clear();
});

describe('GET /api/cron/weekly-digest — what each recipient is sent', () => {
  it('sends owners and managers every warehouse, and nobody the item with no warehouse', async () => {
    adminHolder.client = orgStub().client;
    const res = await GET(request());
    expect(await res.json()).toMatchObject({ ok: true, sent: 6, failed: 0 });

    for (const name of ['Olive Owner', 'Mona Manager']) {
      const got = sentTo(name);
      expect(got.items).toEqual([
        'a-ch1',
        'a-ch2',
        'a-generic',
        'b-books',
        'b-sports',
        'b-uncategorised',
      ]);
      expect(got.warehouses).toEqual(['North DC', 'South DC']);
      expect(got.pos).toEqual(['po-no-destination', 'po-to-a', 'po-to-b', 'po-to-org-level']);
      expect(got.counts).toEqual([
        'cc-a: North DC',
        'cc-b: South DC',
        'cc-all: All warehouses',
        'cc-mine-b: Selected items',
      ]);
      // Every line of every count.
      expect(got.countLines).toEqual(['cc-a 2/3', 'cc-b 1/2', 'cc-all 2/2', 'cc-mine-b 0/1']);
    }
  });

  it("sends a staff member scoped to one warehouse and one charter only that warehouse's generic and charter stock", async () => {
    adminHolder.client = orgStub().client;
    await GET(request());

    const got = sentTo('Sam StaffA');
    // Generic stock at North DC, and its ch-1 stock; not ch-2, not South DC.
    expect(got.items).toEqual(['a-ch1', 'a-generic']);
    expect(got.warehouses).toEqual(['North DC']);
    // POs into North DC, plus the two no purchase order can be scoped by.
    expect(got.pos).toEqual(['po-no-destination', 'po-to-a', 'po-to-org-level']);
    // Cycle counts follow her warehouses (cycle_counts_select): North DC's
    // count, the no-warehouse count with a North DC line, and the one
    // assigned to her; not South DC's.
    expect(got.counts).toEqual([
      'cc-a: North DC',
      'cc-all: All warehouses',
      'cc-mine-b: Selected items',
    ]);
    // Totals count only the lines she may read (cycle_count_lines_select):
    // North DC lines of items she can open (generic and ch-1, not ch-2); none
    // of her own count's South DC line.
    expect(got.countLines).toEqual(['cc-a 1/2', 'cc-all 1/1', 'cc-mine-b 0/0']);
  });

  it('sends a viewer the counts of her warehouse with only the lines of the categories she may read', async () => {
    adminHolder.client = orgStub().client;
    await GET(request());

    expect(sentTo('Vic Books').counts).toEqual([
      'cc-b: South DC',
      'cc-all: All warehouses',
      'cc-mine-b: Selected items',
    ]);
    expect(sentTo('Vic Books').countLines).toEqual(['cc-b 1/1', 'cc-all 1/1', 'cc-mine-b 0/0']);
    expect(sentTo('Val AllCats').countLines).toEqual(['cc-b 1/2', 'cc-all 1/1', 'cc-mine-b 0/1']);
  });

  it('reads the all-warehouses flag at send time: every count, lines still by assignment', async () => {
    const stub = orgStub({
      'organization_members.select.maybeSingle': (call) => {
        const userId = String(eqValue(call, 'user_id'));
        return rows([
          {
            user_id: userId,
            accepted_at: '2026-01-01T00:00:00Z',
            role: MEMBERS[userId]!.role,
            all_warehouses: userId === 'staff-a',
          },
        ]);
      },
    });
    adminHolder.client = stub.client;
    await GET(request());

    // The re-read before each send asks for the flag.
    const membershipReads = stub.chainArgsAll.get('organization_members.select') ?? [];
    expect(
      membershipReads.some((args) => args.some((a) => String(a[0]).includes('all_warehouses'))),
    ).toBe(true);
    const got = sentTo('Sam StaffA');
    expect(got.counts).toEqual([
      'cc-a: North DC',
      'cc-b: Warehouse unavailable',
      'cc-all: All warehouses',
      'cc-mine-b: Selected items',
    ]);
    // Lines follow her assignment rows (North DC, ch-1), as my_warehouse_ids.
    expect(got.countLines).toEqual(['cc-a 1/2', 'cc-b 0/0', 'cc-all 1/1', 'cc-mine-b 0/0']);
    // Without the flag in the answer, she reads as not having it.
    expect(sentTo('Nia NoPo').counts).toEqual(['cc-a: North DC', 'cc-all: All warehouses']);
  });

  it('sends a category-limited viewer only those categories, and an unlimited viewer every category', async () => {
    adminHolder.client = orgStub().client;
    await GET(request());

    expect(sentTo('Vic Books').items).toEqual(['b-books']);
    // A viewer with no category rows reads every category, an item with no
    // category included.
    expect(sentTo('Val AllCats').items).toEqual(['b-books', 'b-sports', 'b-uncategorised']);
  });

  it('follows purchase_orders:read: user override over role override over the default, owner always', async () => {
    adminHolder.client = orgStub().client;
    await GET(request());

    // The viewer role lost the permission; this viewer was given it back.
    expect(sentTo('Vic Books').pos).toEqual(['po-no-destination', 'po-to-b', 'po-to-org-level']);
    // The other viewer has only the role override: no purchase orders.
    expect(sentTo('Val AllCats').pos).toEqual([]);
    // A staff member whose own permission was revoked: none either.
    expect(sentTo('Nia NoPo').pos).toEqual([]);
    expect(sentTo('Nia NoPo').items).toEqual(['a-ch1', 'a-ch2', 'a-generic']);
    // An owner reads purchase orders whatever an override says.
    expect(sentTo('Olive Owner').pos).toHaveLength(4);
  });

  it('reads the role at send time, with the check before each send', async () => {
    adminHolder.client = orgStub({
      // The manager was made staff (no assignments) after the pull.
      'organization_members.select.maybeSingle': (call) => {
        const userId = String(eqValue(call, 'user_id'));
        const role = userId === 'manager' ? 'staff' : MEMBERS[userId]!.role;
        return rows([{ user_id: userId, accepted_at: '2026-01-01T00:00:00Z', role }]);
      },
    }).client;
    await GET(request());

    const got = sentTo('Mona Manager');
    expect(got.items).toEqual([]);
    expect(got.pos).toEqual(['po-no-destination', 'po-to-org-level']);
  });

  it('sends nobody in the org a digest when what decides their view cannot be read', async () => {
    adminHolder.client = orgStub({
      'user_warehouse_assignments.select': {
        data: null,
        error: { message: 'canceling statement due to statement timeout', code: '57014' },
      },
    }).client;
    const res = await GET(request());

    expect(await res.json()).toMatchObject({ ok: true, sent: 0, failed: 6 });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'cron.weekly-digest.org' }),
    );
    // The report carries the read's own text, not the generic sentence a
    // ServiceError('internal_error') shows (docket S27 review).
    const orgReport = reportErrorMock.mock.calls.find(
      ([, context]) => (context as { tag?: string }).tag === 'cron.weekly-digest.org',
    );
    expect((orgReport?.[0] as Error).message).toBe('canceling statement due to statement timeout');
  });

  /**
   * docket S27: an answer with no error that is not a list (postgrest-js
   * resolves an empty body with data null) was read as "no rows", and every
   * one of these widened a digest: the viewer whose role lost
   * purchase_orders:read, the staff member with their own revoke and the
   * viewer limited to some categories were each sent what the organization
   * took away. Such an answer is a failed read: nobody in the organization is
   * sent a digest, nothing is claimed (a re-run the same week delivers), and
   * the organization's failure is reported once.
   */
  describe('an answer that is not a list sends nobody in the org a digest', () => {
    async function expectOrgSkipped(read: string, answer: unknown, table: string, status: number) {
      const stub = orgStub({ [read]: answer as QueryResult });
      adminHolder.client = stub.client;
      const res = await GET(request());

      expect(await res.json()).toMatchObject({ ok: true, sent: 0, failed: 6 });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(rendered.size).toBe(0);
      expect(stub.chainsAll.has('idempotency_keys.insert')).toBe(false);
      const reports = reportErrorMock.mock.calls.filter(
        ([, context]) => (context as { tag?: string }).tag === 'cron.weekly-digest.org',
      );
      expect(reports).toHaveLength(1);
      // What the reporter emits is the error's message (error-reporter-core
      // logs and posts `message` only), so the report itself names the table
      // and the status: a ServiceError's message is the generic sentence.
      expect((reports[0]?.[0] as Error).message).toBe(
        `${table} answered no list (status ${status})`,
      );
      expect(reports[0]?.[1]).toEqual({ tag: 'cron.weekly-digest.org', extra: { orgId: ORG } });
    }

    it.each(NOT_A_LIST)(
      '%s from the role override read: the viewer whose role lost purchase orders is not sent them',
      async (_shape, answer) => {
        await expectOrgSkipped(
          'role_permission_overrides.select',
          answer,
          'role_permission_overrides',
          answer.status,
        );
      },
    );

    it.each(NOT_A_LIST)(
      '%s from the member override read: the staff member with their own revoke is not sent them',
      async (_shape, answer) => {
        await expectOrgSkipped(
          'user_permission_overrides.select',
          answer,
          'user_permission_overrides',
          answer.status,
        );
      },
    );

    it.each(NOT_A_LIST)(
      '%s from the category read: the viewer limited to some categories is not sent every category',
      async (_shape, answer) => {
        await expectOrgSkipped(
          'user_category_assignments.select',
          answer,
          'user_category_assignments',
          answer.status,
        );
      },
    );

    it.each(NOT_A_LIST)('%s from the warehouse assignment read', async (_shape, answer) => {
      await expectOrgSkipped(
        'user_warehouse_assignments.select',
        answer,
        'user_warehouse_assignments',
        answer.status,
      );
    });

    it.each(NOT_A_LIST)('%s from the role default read', async (_shape, answer) => {
      await expectOrgSkipped(
        'role_default_permissions.select',
        answer,
        'role_default_permissions',
        answer.status,
      );
    });
  });
});
