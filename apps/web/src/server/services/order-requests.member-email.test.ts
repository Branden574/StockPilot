import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * Docket S36 (integrator decision 2026-11-01 on #440, with its precision): an
 * email to a member's OWN address (their profile's: the order kept none,
 * requester_email NULL, requester_user_id set) follows the current-member rule
 * of 0422 and createNotification: an accepted membership of the order's
 * organization, not an Act-as seat, on an account that is not disabled. A read
 * that fails sends nothing and is reported. An address the order recorded for
 * an outside person (on-behalf, public link, portal) is emailed as before.
 *
 * Before, a member removed from the organization, or who left it, stopped
 * getting the notices and pushes about their old orders but kept getting the
 * emails: the three hand-over emails (order-handover-notify.ts :139, :210,
 * :282 at af14d9dd7) and every status email (resolveRecipient).
 *
 * Here the paper hand-over runs for real with only the database and the mail
 * transport stubbed: confirmPhysicalSignature -> resolveRequesterContact ->
 * notifyRequesterBackordered / notifyRequesterBackorderShipped (and, for an
 * exchange replacement, the replacement email) -> the transport.
 */

const h = vi.hoisted(() => ({
  admin: null as unknown,
  sendEmail: vi.fn(async (_a: { to: string; subject: string }) => ({ ok: true })),
  sendReturnUpdateEmail: vi.fn(async (_admin: unknown, _a: { to: string; event: string }) => ({
    sent: true,
  })),
  sendOrderRequestEmail: vi.fn(async (_a: { kind: string; recipientEmail: string }) => ({
    ok: true,
  })),
  reportError: vi.fn(async (_err: unknown, _ctx: { tag: string }) => {}),
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.admin }));
vi.mock('@/lib/email/resend', () => ({
  sendEmail: (a: { to: string; subject: string }) => h.sendEmail(a),
}));
vi.mock('@/server/email/return-update', () => ({
  sendReturnUpdateEmail: (admin: unknown, a: { to: string; event: string }) =>
    h.sendReturnUpdateEmail(admin, a),
}));
vi.mock('@/lib/email/order-requests', () => ({
  sendOrderRequestEmail: (a: { kind: string; recipientEmail: string }) =>
    h.sendOrderRequestEmail(a),
}));
vi.mock('@/lib/error-reporter', () => ({
  reportError: (err: unknown, ctx: { tag: string }) => h.reportError(err, ctx),
  isNextControlFlowError: () => false,
}));
vi.mock('@/server/email/return-prompt', () => ({
  maybeSendReturnPrompt: vi.fn(async () => ({ sent: false, reason: 'no_requester_email' })),
}));
vi.mock('@/server/lib/order-secrets', () => ({
  resolveReturnToken: vi.fn(async () => 'tok-orig'),
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => {}) }));

import { OrderRequestsService } from './order-requests';

const ORG = 'org-test';
const REQUESTER = 'requester-1';
const MANAGER = 'mgr-1';
const ACCEPTED_AT = '2026-01-05T00:00:00Z';
const PROFILE = { email: 'reggie@example.com', full_name: 'Reggie Requester', disabled_at: null };
const READ_ERROR = { message: 'canceling statement due to statement timeout', code: '57014' };

/** A member's own order: the order keeps no address (SP-020). */
const OWN = {
  id: 'ord-1',
  organization_id: ORG,
  order_number: 49,
  status: 'approved',
  source: 'internal',
  customer_id: null,
  requester_user_id: REQUESTER,
  requester_email: null,
  requester_name: null,
  requester_deleted_at: null,
  replacement_for_return_id: null,
};
/** An on-behalf-of order: create() records the outside address and no requester id (0413:1171-1173). */
const ON_BEHALF = {
  ...OWN,
  requester_user_id: null,
  requester_email: 'guest@example.com',
  requester_name: 'Guest Example',
};
/** A portal order: the buyer's sign-in AND the buyer's address (portal.ts); the buyer is never a member. */
const PORTAL = {
  ...OWN,
  source: 'portal',
  customer_id: 'cust-1',
  requester_user_id: 'portal-buyer',
  requester_email: 'buyer@example.com',
  requester_name: 'Buyer Example',
};

function member(userId: string) {
  return {
    organization_id: ORG,
    user_id: userId,
    accepted_at: ACCEPTED_AT,
    impersonation_expires_at: null,
  };
}

/** The service-role database: the requester a current member of ORG or not. */
function wireAdmin(opts: { requesterIsMember: boolean; membershipFails?: boolean }) {
  const stub = makeSupabaseStub({
    'organization_members.select.maybeSingle': opts.membershipFails
      ? { data: null, error: READ_ERROR }
      : servedLikePostgrest([
          member(MANAGER),
          ...(opts.requesterIsMember ? [member(REQUESTER)] : []),
        ]),
    'user_profiles.select.maybeSingle': { data: PROFILE, error: null },
    'notification_preferences.select.maybeSingle': { data: null, error: null },
    'notifications.insert': { data: { id: 'notif-1' }, error: null },
    // The partial email's per-line table.
    'order_request_lines.select': {
      data: [
        {
          quantity_requested: 5,
          quantity_fulfilled: 2,
          inventory_items: { name: 'Field Radio', sku: 'RAD-1' },
        },
      ],
      error: null,
    },
    // An exchange replacement's RMA (replacement-update.ts loadReplacementEmailFacts).
    'returns.select': {
      data: {
        id: 'rma-1',
        return_number: 'RMA-20261101-TEST01',
        status: 'approved',
        order_request_id: 'orig-1',
        order_request: { order_number: 12 },
      },
      error: null,
    },
    'public_email_unsubscribes.select': { data: [], error: null },
  });
  h.admin = stub.client;
  return stub;
}

/** A manager recording the paper signature (the RPC answers the whole row). */
function paperService(
  row: Record<string, unknown>,
  lines: { prior: number; requested: number; fulfilled: number },
) {
  let lineReads = 0;
  const stub = makeSupabaseStub({
    // The order, read in the active organization before the function (S39).
    'order_requests.select': servedLikePostgrest([row]),
    'order_request_lines.select': () => {
      lineReads += 1;
      return lineReads === 1
        ? { data: [{ quantity_fulfilled: lines.prior }], error: null }
        : {
            data: [{ quantity_requested: lines.requested, quantity_fulfilled: lines.fulfilled }],
            error: null,
          };
    },
    'rpc:confirm_physical_signature': { data: row, error: null },
    // resolveRecipient reads the profile with the caller's client.
    'user_profiles.select.maybeSingle': { data: PROFILE, error: null },
  });
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      organizationId: ORG,
      role: 'manager',
      userId: MANAGER,
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

/** Let the deferred tail work (defer() runs fire-and-forget in vitest) finish. */
async function flushDeferred(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** Every address a requester email of these paths went to. */
function requesterEmailsTo(): string[] {
  return [
    ...h.sendEmail.mock.calls.map((c) => c[0].to),
    ...h.sendReturnUpdateEmail.mock.calls.map((c) => c[1].to),
  ];
}

function memberCheckReports(tag: string) {
  return h.reportError.mock.calls.filter(([, ctx]) => ctx?.tag === tag);
}

const PATHS: Array<{
  name: string;
  status: 'backordered' | 'completed';
  lines: { prior: number; requested: number; fulfilled: number };
  replacement?: boolean;
}> = [
  {
    name: 'a partial hand-over (order-handover-notify.ts :210 at af14d9dd7)',
    status: 'backordered',
    lines: { prior: 0, requested: 5, fulfilled: 2 },
  },
  {
    name: 'backordered items shipped (:282)',
    status: 'completed',
    lines: { prior: 2, requested: 5, fulfilled: 5 },
  },
  {
    name: "an exchange replacement's partial hand-over (:139, the backordered edge)",
    status: 'backordered',
    lines: { prior: 0, requested: 5, fulfilled: 2 },
    replacement: true,
  },
];

beforeEach(() => vi.clearAllMocks());

describe.each(PATHS)('paper hand-over, $name', ({ status, lines, replacement }) => {
  const asRow = (row: Record<string, unknown>) => ({
    ...row,
    status,
    ...(replacement ? { replacement_for_return_id: 'rma-1' } : {}),
  });

  it("emails a member at their own address while they are a current member of the order's organization", async () => {
    wireAdmin({ requesterIsMember: true });
    await paperService(asRow(OWN), lines).confirmPhysicalSignature('ord-1', 'Dock Signer');
    await flushDeferred();
    expect(requesterEmailsTo()).toContain('reggie@example.com');
  });

  it('sends nothing to their own address once they were removed from the organization or left it', async () => {
    wireAdmin({ requesterIsMember: false });
    await paperService(asRow(OWN), lines).confirmPhysicalSignature('ord-1', 'Dock Signer');
    await flushDeferred();
    expect(requesterEmailsTo()).toEqual([]);
    expect(h.sendOrderRequestEmail).not.toHaveBeenCalled();
    // A former member is an expected recipient to drop, not an error.
    expect(memberCheckReports('orders.physical_signature.requester_member_check')).toEqual([]);
  });

  it('sends nothing when the membership cannot be read, and reports it once', async () => {
    wireAdmin({ requesterIsMember: true, membershipFails: true });
    await paperService(asRow(OWN), lines).confirmPhysicalSignature('ord-1', 'Dock Signer');
    await flushDeferred();
    expect(requesterEmailsTo()).toEqual([]);
    expect(memberCheckReports('orders.physical_signature.requester_member_check')).toHaveLength(1);
  });

  it('an outside address the order recorded (on-behalf) is emailed as before', async () => {
    wireAdmin({ requesterIsMember: false });
    await paperService(asRow(ON_BEHALF), lines).confirmPhysicalSignature('ord-1', 'Dock Signer');
    await flushDeferred();
    expect(requesterEmailsTo()).toContain('guest@example.com');
  });

  it('a portal order (the buyer signed in, never a member) is emailed at the address the order recorded', async () => {
    wireAdmin({ requesterIsMember: false });
    await paperService(asRow(PORTAL), lines).confirmPhysicalSignature('ord-1', 'Dock Signer');
    await flushDeferred();
    expect(requesterEmailsTo()).toContain('buyer@example.com');
  });
});

/** The private sender every status change goes through. */
async function statusEmail(
  service: OrderRequestsService,
  row: Record<string, unknown>,
): Promise<void> {
  await (
    service as unknown as {
      notifyEmail: (r: unknown, k: 'approved') => Promise<void>;
    }
  ).notifyEmail(row, 'approved');
}

function statusService(ctxOrganizationId = ORG) {
  const stub = makeSupabaseStub({
    'user_profiles.select.maybeSingle': { data: PROFILE, error: null },
  });
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      organizationId: ctxOrganizationId,
      role: 'manager',
      userId: MANAGER,
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

function statusEmailsTo(): string[] {
  return h.sendOrderRequestEmail.mock.calls.map((c) => c[0].recipientEmail);
}

describe('order status emails (resolveRecipient)', () => {
  it("a current member's own order: emailed at their profile address", async () => {
    wireAdmin({ requesterIsMember: true });
    await statusEmail(statusService(), OWN);
    expect(statusEmailsTo()).toEqual(['reggie@example.com']);
  });

  it('a former member: nothing to their own address', async () => {
    wireAdmin({ requesterIsMember: false });
    await statusEmail(statusService(), OWN);
    expect(statusEmailsTo()).toEqual([]);
    expect(memberCheckReports('order-requests.email.requester_member_check')).toEqual([]);
  });

  it('the membership cannot be read: nothing sent, reported once', async () => {
    wireAdmin({ requesterIsMember: true, membershipFails: true });
    await statusEmail(statusService(), OWN);
    expect(statusEmailsTo()).toEqual([]);
    const reports = memberCheckReports('order-requests.email.requester_member_check');
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      level: 'warning',
      extra: { orderId: 'ord-1', organizationId: ORG, userId: REQUESTER },
    });
  });

  it("is decided against the order's own organization, not the active one", async () => {
    // A member of the order's organization, acting from another workspace
    // (the S39 class): the requester is still a current member of the order's.
    wireAdmin({ requesterIsMember: true });
    await statusEmail(statusService('org-elsewhere'), OWN);
    expect(statusEmailsTo()).toEqual(['reggie@example.com']);
  });

  it('addresses the order recorded are emailed as before: on-behalf, and a portal buyer who is never a member', async () => {
    wireAdmin({ requesterIsMember: false });
    await statusEmail(statusService(), ON_BEHALF);
    await statusEmail(statusService(), PORTAL);
    expect(statusEmailsTo()).toEqual(['guest@example.com', 'buyer@example.com']);
  });
});
