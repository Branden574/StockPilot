import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

/**
 * THE CROSS-SURFACE PARITY TEST — the real one.
 *
 * WHAT IT REPLACES. `apps/mobile/src/lib/delivery-request-actions.test.ts` had
 * a block called "parity with the web surface" whose one test claimed the phone
 * produced a body "byte-identical to what the shared core builder produces".
 * It imported no web code. It hand-assembled a web-shaped input inside the
 * MOBILE suite — reading the mobile fixture's already-populated fields — and
 * then compared core against core in a single process. Two genuine divergences
 * were sitting in the branch the whole time and it passed:
 *
 *   1. the org timezone default (web UTC, mobile Pacific): the same order
 *      stated two different needed-by times, and after 16:00 Pacific two
 *      different DATES, in mail to the same warehouse;
 *   2. the requester-email fallback operator (web `||`, mobile `??`): an
 *      empty-string column named a reachable contact on one surface and no
 *      contact at all on the other.
 *
 * Neither could be seen, because the fixture never exercised the fallback and
 * the "web" input was written by hand rather than produced by web.
 *
 * WHY IT LIVES IN THE WEB SUITE. Mobile's vitest cannot reach `apps/web` at
 * all. Web can reach `@stockpilot/core`, and core is now where the phone's
 * mapping lives (`buildDeliveryRequestInput`, re-exported verbatim by
 * `apps/mobile/src/lib/delivery-request-actions.ts`) — so this is the one
 * process in the repo that can hold both mappings at once.
 *
 * WHAT IS ACTUALLY DRIVEN. Only the database is stubbed. Every transformation
 * between a row and the builder's input is the real shipped code, on both
 * sides:
 *
 *   web    order_requests row + user_profiles row
 *            -> OrderRequestsService.get()          (real service)
 *          organizations.timezone
 *            -> getCachedOrgTimezone()              (real helper)
 *          both -> the real order detail PAGE, rendered, props captured
 *            -> deliveryRequestInputFromProps()     (real button mapping)
 *
 *   phone  the same row
 *            -> core buildDeliveryRequestInput()    (what the phone runs)
 *
 * and the two `DeliveryRequestInput`s are compared field by field.
 *
 * WHAT IT DOES NOT COVER, stated so the name does not overclaim again: the
 * display LABEL each surface computes for a requester with no name of their own
 * (web's `requesterDisplay`, mobile's `resolveRequesterLabel`). Those are
 * surface-owned wordings — "(team member)", "External requester · Clovis" — and
 * they are fed in here rather than compared. The last test in this file pins
 * that boundary explicitly, with the one row shape where the two would differ.
 */

// ── The order page's harness. Only the database and the page's unrelated
// children are mocked; the page itself is the real module. ────────────────

const orderGet = vi.fn();
const attachmentsList = vi.fn(async () => []);
const returnableLinesForOrder = vi.fn(async () => []);
const checkModuleAccessMock = vi.fn(async () => ({ enabled: true, canManage: false }));
const getWarehouseAccessMock = vi.fn(async () => ({
  hasAllAccess: true,
  writableIds: [] as string[],
}));
const cachedOrgTimezone = vi.fn(async (_orgId: string) => 'UNSET');

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});

vi.mock('@/components/orders/add-items-dialog', () => ({ AddItemsDialog: () => null }));
vi.mock('@/components/orders/cancel-order-button', () => ({ CancelOrderButton: () => null }));
vi.mock('@/components/orders/manager-actions-panel', () => ({ ManagerActionsPanel: () => null }));
vi.mock('@/components/orders/order-line-actions', () => ({ OrderLineActions: () => null }));
vi.mock('@/components/orders/delivery-location-share', () => ({ DeliveryLocationShare: () => null }));
vi.mock('@/components/returns/create-return-dialog', () => ({ CreateReturnDialog: () => null }));
vi.mock('@/components/orders/order-attachments-panel', () => ({ OrderAttachmentsPanel: () => null }));
vi.mock('@/components/orders/order-realtime-refresh', () => ({ OrderRealtimeRefresh: () => null }));
vi.mock('@/components/orders/order-timeline', () => ({ OrderTimeline: () => null }));
vi.mock('@/components/orders/shipping-panel', () => ({ ShippingPanel: () => null }));
vi.mock('@/components/orders/status-badge', () => ({ OrderStatusBadge: () => null }));
vi.mock('@/components/maintenance/report-problem-button', () => ({ ReportProblemButton: () => null }));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/onboarding/help-tip', () => ({ HelpTip: () => null }));

/**
 * The ONE captured surface: exactly the props the real page derives. Only the
 * COMPONENT is replaced — `importOriginal` keeps the real
 * `deliveryRequestInputFromProps`, which is the web mapping under test.
 */
const capturedProps = vi.fn();
vi.mock('@/components/orders/send-delivery-request-button', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/orders/send-delivery-request-button')>();
  return {
    ...actual,
    SendDeliveryRequestButton: (props: Record<string, unknown>) => {
      capturedProps(props);
      return null;
    },
  };
});

vi.mock('@/lib/dashboard/cached-org', () => ({
  getCachedOrgTimezone: (orgId: string) => cachedOrgTimezone(orgId),
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'staff' as const,
    permissions: new Set<string>(['orders:read']),
  })),
}));

vi.mock('@/lib/auth/warehouse', () => ({ getWarehouseAccess: () => getWarehouseAccessMock() }));
vi.mock('@/lib/modules/module-gate', () => ({ checkModuleAccess: () => checkModuleAccessMock() }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    const chain: Record<string, unknown> = {};
    const self = new Proxy(chain, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
        }
        return () => self;
      },
    });
    return { from: () => self };
  }),
}));

vi.mock('@/server/services/order-attachments', () => ({
  ATTACHABLE_ORDER_STATUSES: ['staged_for_pickup', 'in_transit', 'completed'],
  OrderAttachmentsService: { forCurrentUser: vi.fn(async () => ({ list: attachmentsList })) },
}));
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: { forCurrentUser: vi.fn(async () => ({ get: orderGet })) },
}));
vi.mock('@/server/services/returns', () => ({
  RMAService: { forCurrentUser: vi.fn(async () => ({ returnableLinesForOrder })) },
}));

// The admin client behind getCachedOrgTimezone. The REAL helper is imported
// through `importActual` below; only its query is stubbed.
const adminOrgRow = vi.fn<() => { timezone: string | null } | null>(() => ({ timezone: null }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: adminOrgRow(), error: null }) }),
      }),
    }),
  }),
}));

import { deliveryRequestInputFromProps } from '@/components/orders/send-delivery-request-button';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import OrderDetailPage from '@/app/(dashboard)/dashboard/orders/[id]/page';

const ORDER_ID = '11111111-1111-1111-1111-111111111111';

// ── ONE fixture. Both surfaces are driven from exactly these values. ──────

interface RowFixture {
  /** `order_requests` columns, as the database holds them. */
  requesterUserId: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
  requesterOrgLabel: string | null;
  neededBy: string | null;
  notes: string | null;
  /** The joined `user_profiles` row for `requesterUserId`, or null. */
  profile: { full_name: string | null; email: string | null } | null;
  /** RAW `organizations.timezone`. Null models the degraded read (row missing
   *  or query error) — the case where the two surfaces used to disagree. */
  orgTimezone: string | null;
}

function fixture(over: Partial<RowFixture> = {}): RowFixture {
  return {
    requesterUserId: 'u1',
    requesterName: 'Jane Smith',
    requesterEmail: 'jane@cvwest.org',
    requesterOrgLabel: null,
    neededBy: '2026-08-20T17:00:00Z',
    notes: 'Front office, ask for Jane',
    profile: { full_name: 'Jane Smith', email: 'jane@cvwest.org' },
    orgTimezone: 'America/Los_Angeles',
    ...over,
  };
}

const LINE = {
  id: 'L1',
  order_request_id: ORDER_ID,
  item_id: 'i1',
  quantity_requested: 3,
  quantity_fulfilled: 0,
  quantity_picked: 0,
  unit_cost_at_request: 0,
  notes: null,
  item: {
    id: 'i1',
    name: 'Google Chrome Book',
    sku: 'SP-BVK31-LH9',
    quantity_on_hand: 50,
    charter_name: null,
    charter_code: null,
  },
};

/** The `order_requests` row both surfaces read. */
function headerRow(f: RowFixture): Record<string, unknown> {
  return {
    id: ORDER_ID,
    order_number: 42,
    organization_id: 'org-1',
    warehouse_id: 'wh-1',
    status: 'approved',
    fulfillment_type: 'delivery',
    delivery_charter_id: null,
    requester_user_id: f.requesterUserId,
    requester_name: f.requesterName,
    requester_email: f.requesterEmail,
    requester_org_label: f.requesterOrgLabel,
    needed_by: f.neededBy,
    notes: f.notes,
    source: 'internal',
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-01T12:00:00Z',
    approved_at: '2026-08-01T12:00:00Z',
    approved_by: null,
    denied_reason: null,
    internal_notes: null,
    assigned_picker_id: null,
    assigned_delivery_user_id: null,
    signed_at: null,
    completed_at: null,
    cancelled_at: null,
    return_token: null,
  };
}

// ── The WEB side: the real service, the real cache helper, the real page. ──

async function webInputFor(f: RowFixture) {
  const { OrderRequestsService } = await vi.importActual<
    typeof import('@/server/services/order-requests')
  >('@/server/services/order-requests');
  const { getCachedOrgTimezone } = await vi.importActual<
    typeof import('@/lib/dashboard/cached-org')
  >('@/lib/dashboard/cached-org');

  // 1. The REAL service resolves the requester identity off the row + profile.
  const stub = makeSupabaseStub({
    'order_requests.select.maybeSingle': { data: headerRow(f), error: null },
    'order_request_lines.select': { data: [LINE], error: null },
    'stock_reservations.select': { data: [], error: null },
    'warehouses.select.maybeSingle': { data: { name: 'Main DC' }, error: null },
    'user_profiles.select.maybeSingle': { data: f.profile, error: null },
  });
  const service = new (OrderRequestsService as unknown as new (
    ctx: unknown,
  ) => InstanceType<typeof OrderRequestsService>)(
    makeServiceContext(stub.client, {
      organizationId: 'org-1',
      userId: 'u1',
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
  const detail = await service.get(ORDER_ID);

  // 2. The REAL cache helper resolves the org timezone off the raw column.
  adminOrgRow.mockReturnValue(f.orgTimezone === null ? null : { timezone: f.orgTimezone });
  const tz = await getCachedOrgTimezone('org-1');

  // 3. The REAL page derives the button's props from both.
  orderGet.mockResolvedValue(detail);
  cachedOrgTimezone.mockResolvedValue(tz);
  capturedProps.mockClear();
  render(await OrderDetailPage({ params: Promise.resolve({ id: ORDER_ID }) }));
  expect(capturedProps).toHaveBeenCalledTimes(1);
  const props = capturedProps.mock.calls[0]?.[0] as Parameters<
    typeof deliveryRequestInputFromProps
  >[0];

  // 4. The REAL button mapping turns those props into the builder's input.
  return { input: deliveryRequestInputFromProps(props), detail, tz };
}

// ── The PHONE side: core's mapping, which apps/mobile re-exports verbatim. ─

async function phoneInputFor(f: RowFixture, requesterLabel: string | null) {
  const { buildDeliveryRequestInput, DELIVERY_REQUEST_RECIPIENTS } =
    await import('@stockpilot/core');
  return buildDeliveryRequestInput(
    {
      id: ORDER_ID,
      orderNumber: 42,
      warehouseName: 'Main DC',
      requesterName: f.requesterName,
      requesterLabel,
      requesterEmail: f.requesterEmail,
      // Exactly what app/order/[id].tsx stores for this field.
      requesterProfileEmail: f.profile?.email?.trim() || null,
      neededBy: f.neededBy,
      notes: f.notes,
      destination: null,
      orgTimezone: f.orgTimezone,
      lines: [{ itemId: 'i1', name: 'Google Chrome Book', sku: 'SP-BVK31-LH9', requested: 3 }],
    },
    // The ONE branded value both surfaces import. It used to be an object
    // literal here as well as at each surface; the type no longer admits one.
    DELIVERY_REQUEST_RECIPIENTS,
  );
}

/** Drive both surfaces from one row and hand back both inputs. The display
 *  label the phone gets is WEB's own `requesterDisplay`, so the comparison
 *  isolates the shared rule from the surface-owned wording — see the file doc
 *  and the boundary test at the end. */
async function bothInputsFor(f: RowFixture) {
  const web = await webInputFor(f);
  const phone = await phoneInputFor(f, web.detail.requesterDisplay ?? null);
  return { web: web.input, phone, detail: web.detail, tz: web.tz };
}

/**
 * Every ROW-DERIVED field of the builder's input, compared explicitly.
 * `itemMap` is a Map, which `toEqual` compares by entries; lines and
 * destination are structural. Listing them by name means a NEW field added to
 * `DeliveryRequestInput` shows up as an unchecked key here rather than silently
 * escaping the parity claim.
 *
 * `recipients` is deliberately NOT in this list, because the two surfaces
 * attach it at different steps — the phone in its mapping, web inside
 * `storefront-logic.prepareDeliveryRequest` — and neither derives it from the
 * order. It is compared where it actually matters instead: on the finished
 * draft, which is what carries the mandatory CC.
 */
const SHARED_INPUT_FIELDS = [
  'orderId',
  'orderNumber',
  'fulfillmentType',
  'warehouseName',
  'destination',
  'requestedFor',
  'requesterEmail',
  'neededByLocal',
  'orgTimezone',
  'notes',
  'lines',
  'itemMap',
] as const;

/** Compare the two inputs over every shared field, as one assertion so a
 *  failure names the field. */
function expectSameInput(
  web: object,
  phone: object,
  label: Record<string, unknown> = {},
) {
  const pick = (o: object) =>
    Object.fromEntries(
      SHARED_INPUT_FIELDS.map((f) => [f, (o as Record<string, unknown>)[f]]),
    );
  expect({ ...label, input: pick(web) }).toEqual({ ...label, input: pick(phone) });
  // Neither side may carry a row-derived field the other does not: web's input
  // type is core's minus `recipients`, and nothing else.
  expect(Object.keys(web).sort()).toEqual([...SHARED_INPUT_FIELDS].sort());
  expect(Object.keys(phone).sort()).toEqual([...SHARED_INPUT_FIELDS, 'recipients'].sort());
}

beforeEach(() => {
  vi.clearAllMocks();
  attachmentsList.mockResolvedValue([]);
  returnableLinesForOrder.mockResolvedValue([]);
  getWarehouseAccessMock.mockResolvedValue({ hasAllAccess: true, writableIds: [] });
  checkModuleAccessMock.mockResolvedValue({ enabled: true, canManage: false });
});

describe('delivery request — web and the phone map the SAME row to the SAME builder input', () => {
  it('the ordinary order: every row-derived field of the builder input agrees, field by field', async () => {
    const { web, phone } = await bothInputsFor(fixture());
    expectSameInput(web, phone);
  });

  it('and the FINISHED message agrees too — same subject, same body, same To, same mandatory CC', async () => {
    // The input comparison is the diagnostic; this is the claim the feature
    // actually makes. Each surface is prepared the way it really prepares:
    // web through storefront-logic (which attaches web's recipients), the
    // phone through core with mobile's.
    const { prepareDeliveryRequest: webPrepare } = await import(
      '@/components/orders/storefront/storefront-logic'
    );
    const { prepareDeliveryRequest: corePrepare } = await import('@stockpilot/core');

    const { web, phone } = await bothInputsFor(fixture());
    const webDraft = webPrepare(web).draft;
    const phoneDraft = corePrepare(phone).draft;

    expect(webDraft.body).toBe(phoneDraft.body);
    expect(webDraft.subject).toBe(phoneDraft.subject);
    expect(webDraft.to).toBe(phoneDraft.to);
    // THE ACCEPTANCE GATE: the copy to Andrew, identical on both surfaces.
    expect(webDraft.cc).toBe(phoneDraft.cc);
    expect(webDraft.cc).toBe('arosas@cvwest.org');
    expect(webDraft.toName).toBe(phoneDraft.toName);
    expect(webDraft.ccName).toBe(phoneDraft.ccName);
  });

  // ── DEFECT 2 ───────────────────────────────────────────────────────────

  it('DEFECT 2 — the org timezone did not arrive: both surfaces name the SAME zone', async () => {
    // The degraded read: getCachedOrgDashboardRow returns null (org row
    // missing, RLS denial, or a swallowed query error), and mobile's
    // organizations select comes back empty for the same reasons.
    const { web, phone } = await bothInputsFor(fixture({ orgTimezone: null }));
    expect(web.orgTimezone).toBe(phone.orgTimezone);
    expect(web.orgTimezone).toBe('America/Los_Angeles');
    // The value web used to produce here, named so the regression is explicit.
    expect(web.orgTimezone).not.toBe('UTC');
  });

  it('DEFECT 2 — the same needed-by INSTANT is stated as the same time, and the same DATE, on both', async () => {
    const { prepareDeliveryRequest: webPrepare } = await import(
      '@/components/orders/storefront/storefront-logic'
    );
    const { prepareDeliveryRequest: corePrepare } = await import('@stockpilot/core');
    // 6pm Pacific = 1am UTC the NEXT DAY. This instant is why the divergence
    // was not merely cosmetic: the two surfaces dated one delivery differently.
    const f = fixture({ orgTimezone: null, neededBy: '2026-08-19T01:00:00Z' });
    const { web, phone } = await bothInputsFor(f);

    const neededLine = (body: string) => body.split('\n\n').find((b) => b.startsWith('NEEDED BY'));
    const webLine = neededLine(webPrepare(web).draft.body);
    const phoneLine = neededLine(corePrepare(phone).draft.body);

    expect(webLine).toBe(phoneLine);
    expect(webLine).toContain('Aug 18, 2026');
    expect(webLine).not.toContain('Aug 19');
  });

  it('a STORED timezone still wins on both surfaces — including a stored UTC, which is the column default', async () => {
    for (const tz of ['UTC', 'America/New_York']) {
      const { web, phone } = await bothInputsFor(fixture({ orgTimezone: tz }));
      expect(web.orgTimezone).toBe(tz);
      expect(phone.orgTimezone).toBe(tz);
    }
  });

  // ── DEFECT 4 ───────────────────────────────────────────────────────────

  it('DEFECT 4 — an EMPTY requester_email: both surfaces name the same reachable contact', async () => {
    const f = fixture({
      requesterEmail: '',
      profile: { full_name: 'Jane Smith', email: 'jane@cvwest.org' },
    });
    const { web, phone } = await bothInputsFor(f);
    expect(web.requesterEmail).toBe(phone.requesterEmail);
    expect(web.requesterEmail).toBe('jane@cvwest.org');
    // The phone used to produce '' here, which the draft builder then dropped,
    // so DC4 received a request with no way to reply.
    expect(phone.requesterEmail).not.toBe('');
  });

  it('DEFECT 4 — a NULL requester_email (the internal self-submit majority) agrees too', async () => {
    const { web, phone } = await bothInputsFor(fixture({ requesterEmail: null }));
    expect(web.requesterEmail).toBe(phone.requesterEmail);
    expect(web.requesterEmail).toBe('jane@cvwest.org');
  });

  it('DEFECT 4 — with no profile either, both surfaces admit there is no contact', async () => {
    const { web, phone } = await bothInputsFor(fixture({ requesterEmail: '', profile: null }));
    expect(web.requesterEmail).toBe(phone.requesterEmail);
    expect(web.requesterEmail).toBeNull();
  });

  it('the requester NAME follows the same rule on both — the line one above the email that drifted the same way', async () => {
    const { web, phone } = await bothInputsFor(
      fixture({ requesterName: '', profile: { full_name: 'Jane Smith', email: 'jane@x.org' } }),
    );
    expect(web.requestedFor).toBe(phone.requestedFor);
    expect(web.requestedFor).toBe('Jane Smith');
  });

  // ── The whole matrix, so a NEW divergence is caught without a new test ──

  it('across every combination of the two fields that drifted, the two inputs stay identical', async () => {
    const emails = [null, '', 'onbehalf@site.org'] as const;
    const zones = [null, '', 'UTC', 'America/New_York'] as const;
    const profiles = [null, { full_name: 'Jane Smith', email: 'jane@cvwest.org' }] as const;

    let compared = 0;
    for (const requesterEmail of emails) {
      for (const orgTimezone of zones) {
        for (const profile of profiles) {
          // `requesterUserId` stays 'u1' throughout: this action is
          // requester-only on both surfaces, so a row the viewer does not own
          // never reaches either mapping. A NULL profile still models a real
          // state — the linked user_profiles row missing or unreadable.
          const { web, phone } = await bothInputsFor(
            fixture({ requesterEmail, orgTimezone, profile }),
          );
          expectSameInput(web, phone, {
            requesterEmail,
            orgTimezone,
            hasProfile: Boolean(profile),
          });
          compared += 1;
        }
      }
    }
    // The loop must actually run, or it proves nothing.
    expect(compared).toBe(emails.length * zones.length * profiles.length);
  });

  // ── The boundary, named rather than implied ────────────────────────────

  it('WHAT THIS FILE DOES NOT CLAIM: the display LABEL is surface-owned, and the rows where it differs reach NEITHER surface', async () => {
    // Web's `requesterDisplay` and mobile's `resolveRequesterLabel` are
    // different functions with different last-resort wording, and mobile cannot
    // be imported here to compare them. Every test above therefore hands the
    // phone WEB's own label, isolating the shared RULE — the operator that
    // chooses between the column and the label — from the wording.
    //
    // The one row shape where the two labels would actually diverge is an
    // EXTERNAL requester with no name of their own: web renders "External
    // requester" plus the org label, mobile falls back to the email address.
    // That row cannot produce a delivery request on either surface, because
    // both gate the action on the viewer BEING the requester and an external
    // requester has no `requester_user_id` to match. So the gap is closed by
    // the gate, not by luck — and this asserts that rather than assuming it.
    const { OrderRequestsService } = await vi.importActual<
      typeof import('@/server/services/order-requests')
    >('@/server/services/order-requests');

    const f = fixture({
      requesterUserId: null,
      requesterName: null,
      requesterEmail: 'doua@example.org',
      requesterOrgLabel: 'Clovis',
      profile: null,
    });

    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: headerRow(f), error: null },
      'order_request_lines.select': { data: [LINE], error: null },
      'stock_reservations.select': { data: [], error: null },
      'warehouses.select.maybeSingle': { data: { name: 'Main DC' }, error: null },
      'user_profiles.select.maybeSingle': { data: null, error: null },
    });
    const detail = await new (OrderRequestsService as unknown as new (
      ctx: unknown,
    ) => InstanceType<typeof OrderRequestsService>)(
      makeServiceContext(stub.client, {
        organizationId: 'org-1',
        userId: 'u1',
        enabledModules: new Set<ModuleId>(['orders']),
      }),
    ).get(ORDER_ID);

    // The label web would use, and the one mobile's resolveRequesterLabel would
    // use for the same row — different, and neither is wrong.
    expect(detail.requesterDisplay).toBe('External requester · Clovis');

    // WEB refuses the action for this row: requester_user_id is null, so the
    // page's `isOwnRequest` cannot match any viewer.
    orderGet.mockResolvedValue(detail);
    cachedOrgTimezone.mockResolvedValue('America/Los_Angeles');
    capturedProps.mockClear();
    render(await OrderDetailPage({ params: Promise.resolve({ id: ORDER_ID }) }));
    expect(capturedProps).not.toHaveBeenCalled();

    // MOBILE refuses it by the identical rule, asserted in its own suite by
    // 'canRequestDelivery' > a null requester matches no viewer — see
    // apps/mobile/src/lib/delivery-request-actions.test.ts. Cited rather than
    // re-implemented: a copy of the gate here would be the very duplication
    // this file exists to catch.
  });
});
