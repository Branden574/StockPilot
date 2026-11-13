import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  callArgs,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
} from '@/test/supabase-mock';

/**
 * SP-020 — the QR/digital signature path must reach INTERNAL requesters.
 *
 * `OrderRequestsService.create()` writes `requester_email` ONLY for
 * on-behalf-of orders; a member who submits their own order gets
 * `requester_user_id` set and `requester_email`/`requester_name` NULL
 * (order-requests.ts, the p_header create() sends). This route used to build
 * every notice recipient straight off the `requester_email` column, so an
 * internal requester whose delivery was signed for by someone else got
 * NOTHING by email — no completion receipt, no "partially fulfilled" and no
 * "backordered items shipped" notice — while the PAPER signature path
 * (confirmPhysicalSignature -> notifyEmail -> resolveRecipient) resolved the
 * address from `user_profiles` and did email them. Their
 * `email_order_completed` opt-out was never even read, because the read was
 * gated on the always-NULL column.
 *
 * These tests pin the resolved-from-profile behaviour on all three notices,
 * the opt-out, and the signer==requester single-receipt rule.
 */

vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));

vi.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_APP_URL: 'https://stockpilotusa.com' },
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminHolder.client),
}));

interface EmailCall {
  recipientEmail: string;
  recipientName: string | null;
}
const sendOrderRequestEmail = vi.fn(async (_args: EmailCall) => undefined);
vi.mock('@/lib/email/order-requests', () => ({
  sendOrderRequestEmail: (args: EmailCall) => sendOrderRequestEmail(args),
}));

const maybeSendReturnPrompt = vi.fn(async () => undefined);
vi.mock('@/server/email/return-prompt', () => ({
  maybeSendReturnPrompt: () => maybeSendReturnPrompt(),
}));

interface NotifyCall {
  requesterEmail: string | null;
  requesterName: string | null;
  emailOptedOut: boolean;
  provided?: number | null;
  requested?: number | null;
  owed?: number | null;
}
const notifyRequesterBackordered = vi.fn(async (_a: NotifyCall) => undefined);
const notifyRequesterBackorderShipped = vi.fn(async (_a: NotifyCall) => undefined);
const sendPartialReceiptEmail = vi.fn(async (_a: unknown) => undefined);
vi.mock('@/server/lib/order-handover-notify', () => ({
  notifyRequesterBackordered: (a: NotifyCall) => notifyRequesterBackordered(a),
  notifyRequesterBackorderShipped: (a: NotifyCall) => notifyRequesterBackorderShipped(a),
  sendPartialReceiptEmail: (a: unknown) => sendPartialReceiptEmail(a),
}));

vi.mock('@/server/services/integration-events', () => ({
  dispatchEvent: vi.fn(async () => undefined),
}));

vi.mock('@/server/services/order-requests', () => ({
  syncOrderScheduleEvent: vi.fn(async () => undefined),
}));

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { dispatchEvent } from '@/server/services/integration-events';

import { POST } from './route';

const TOKEN = 'a'.repeat(64);
const SIGNATURE =
  'data:image/png;base64,' + 'A'.repeat(80);

/** Internal self-submitted order: user id set, email/name columns NULL. */
const INTERNAL_ORDER = {
  id: 'ord-1',
  organization_id: 'org-1',
  requester_user_id: 'u1',
  requester_name: null,
  requester_email: null,
  fulfillment_type: 'delivery' as const,
};

interface Scenario {
  status: 'completed' | 'backordered';
  /** quantity_fulfilled BEFORE the hand-over (drives the backorder-shipped notice). */
  priorFulfilled: number;
  totalRequested: number;
  totalFulfilled: number;
  profile?: { email: string; full_name: string | null } | null;
  emailOrderCompleted?: boolean;
  /** How many post-signature status reads fail before one answers. */
  statusReadFailures?: number;
  /** How many post-hand-over line-totals reads fail before one answers. */
  lineTotalsFailures?: number;
  /** The notification_preferences read fails. */
  prefReadFails?: boolean;
  /** The order's number on the row read after the hand-over. */
  orderNumber?: number | null;
  /** S36: whether the requester (u1) is still a current member of org-1 (default yes). */
  requesterIsMember?: boolean;
  /** S36: the current-member read fails. */
  membershipReadFails?: boolean;
  /** S36: the current-member check's disabled_at read (user_profiles) fails. */
  disabledReadFails?: boolean;
  /** S36: the requester's own address read (user_profiles email, full_name) fails. */
  ownAddressReadFails?: boolean;
  /** Returns RX-2: the order is the exchange replacement for this RMA. */
  replacementForReturnId?: string;
}

const READ_ERROR = { message: 'connection reset' };

function buildAdmin(s: Scenario) {
  // The route reads order_request_lines TWICE: first for the prior-shipped
  // total, then for the post-hand-over aggregate. Serve them in order.
  let lineCall = 0;
  const linesResult = (): QueryResult => {
    lineCall += 1;
    if (lineCall === 1) return { data: [{ quantity_fulfilled: s.priorFulfilled }], error: null };
    if (lineCall - 1 <= (s.lineTotalsFailures ?? 0)) return { data: null, error: READ_ERROR };
    return {
      data: [{ quantity_requested: s.totalRequested, quantity_fulfilled: s.totalFulfilled }],
      error: null,
    };
  };
  let statusReads = 0;
  const statusResult = (): QueryResult => {
    statusReads += 1;
    return statusReads <= (s.statusReadFailures ?? 0)
      ? { data: null, error: READ_ERROR }
      : {
          data: {
            ...INTERNAL_ORDER,
            status: s.status,
            order_number: s.orderNumber ?? null,
            ...(s.replacementForReturnId
              ? { replacement_for_return_id: s.replacementForReturnId, source: 'internal' }
              : {}),
          },
          error: null,
        };
  };

  return makeSupabaseStub({
    'order_requests.select.maybeSingle': { data: INTERNAL_ORDER, error: null },
    'order_requests.select.single': statusResult,
    'order_request_lines.select': linesResult,
    'rpc:confirm_order_signature': { data: { id: 'ord-1' }, error: null },
    // Two reads, each able to fail on its own (S36): the current-member
    // check's (disabled_at, a list read) and the requester's own address
    // (email, full_name, a point read).
    'user_profiles.select': (call: MockCall): QueryResult => {
      const columns = String(callArgs(call, 'select')?.[0] ?? '');
      const memberCheck = columns.includes('disabled_at');
      const fails = memberCheck ? s.disabledReadFails : s.ownAddressReadFails;
      if (fails) return { data: null, error: READ_ERROR };
      const row = s.profile === undefined ? { email: 'alice@site.org', full_name: 'Alice' } : s.profile;
      return { data: memberCheck ? (row ? [row] : []) : row, error: null };
    },
    'notification_preferences.select.maybeSingle': s.prefReadFails
      ? { data: null, error: READ_ERROR }
      : { data: { email_order_completed: s.emailOrderCompleted ?? true }, error: null },
    // S36: the requester's own address is used only while they are a current
    // member of the order's organization (server/lib/current-member.ts).
    'organization_members.select': s.membershipReadFails
      ? { data: null, error: READ_ERROR }
      : servedLikePostgrest(
          s.requesterIsMember === false
            ? [
                {
                  organization_id: 'org-1',
                  user_id: 'someone-else',
                  accepted_at: '2026-01-05T00:00:00Z',
                  impersonation_expires_at: null,
                },
              ]
            : [
                {
                  organization_id: 'org-1',
                  user_id: 'u1',
                  accepted_at: '2026-01-05T00:00:00Z',
                  impersonation_expires_at: null,
                },
              ],
        ),
  }).client;
}

/** The tags reportError was called with, in order. */
function reportedTags(): string[] {
  return vi
    .mocked(reportError)
    .mock.calls.map((c) => (c[1] as { tag: string } | undefined)?.tag ?? '');
}

/** Every recipientEmail sendOrderRequestEmail was called with, in order. */
function sentTo(): string[] {
  return sendOrderRequestEmail.mock.calls.map((c) => c[0].recipientEmail);
}

function request(signerEmail = 'bob@site.org') {
  return new Request('https://test.local/api/orders/sign', {
    method: 'POST',
    body: JSON.stringify({
      token: TOKEN,
      signerName: 'Bob Signer',
      signerEmail,
      signatureDataUrl: SIGNATURE,
    }),
  }) as never;
}

describe('POST /api/orders/sign — internal requester contact resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emails BOTH the internal requester (resolved from user_profiles) and the signer on completion', async () => {
    adminHolder.client = buildAdmin({
      status: 'completed',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 5,
    });

    const res = await POST(request());
    expect(res.status).toBe(200);

    const recipients = sentTo();
    expect(recipients).toContain('alice@site.org');
    expect(recipients).toContain('bob@site.org');
    expect(recipients).toHaveLength(2);
    // Name must come from the profile too, not stay null.
    const alice = sendOrderRequestEmail.mock.calls
      .map((c) => c[0])
      .find((a) => a.recipientEmail === 'alice@site.org');
    expect(alice?.recipientName).toBe('Alice');
  });

  it('honors the internal requester email_order_completed opt-out (signer still gets a receipt)', async () => {
    adminHolder.client = buildAdmin({
      status: 'completed',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 5,
      emailOrderCompleted: false,
    });

    await POST(request());

    const recipients = sentTo();
    expect(recipients).toEqual(['bob@site.org']);
  });

  it('sends exactly ONE receipt when the internal requester signs for herself', async () => {
    adminHolder.client = buildAdmin({
      status: 'completed',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 5,
    });

    // Same person, different casing — must not produce two receipts.
    await POST(request('Alice@Site.org'));

    const recipients = sentTo();
    expect(recipients).toHaveLength(1);
  });

  it('passes the resolved requester email to the partial-fulfilled (backordered) notice', async () => {
    adminHolder.client = buildAdmin({
      status: 'backordered',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 2,
    });

    await POST(request());

    expect(notifyRequesterBackordered).toHaveBeenCalledTimes(1);
    const args = notifyRequesterBackordered.mock.calls[0]?.[0] as NotifyCall;
    expect(args.requesterEmail).toBe('alice@site.org');
    expect(args.requesterName).toBe('Alice');
    expect(args.emailOptedOut).toBe(false);
  });

  it('passes the resolved requester email to the backorder-shipped notice', async () => {
    adminHolder.client = buildAdmin({
      status: 'completed',
      priorFulfilled: 2,
      totalRequested: 5,
      totalFulfilled: 5,
    });

    await POST(request());

    expect(notifyRequesterBackorderShipped).toHaveBeenCalledTimes(1);
    const args = notifyRequesterBackorderShipped.mock.calls[0]?.[0] as NotifyCall;
    expect(args.requesterEmail).toBe('alice@site.org');
  });

  it('reads the opt-out for an internal requester even though requester_email is NULL', async () => {
    const admin = buildAdmin({
      status: 'completed',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 5,
    });
    adminHolder.client = admin;

    await POST(request());

    expect(admin.from.mock.calls.map((c: unknown[]) => c[0])).toContain(
      'notification_preferences',
    );
  });

  it('still works for an EXTERNAL (on-behalf-of) requester whose email column is set', async () => {
    const external = { ...INTERNAL_ORDER, requester_user_id: null, requester_email: 'ext@x.com', requester_name: 'Ext' };
    adminHolder.client = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: external, error: null },
      'order_requests.select.single': { data: { ...external, status: 'completed' }, error: null },
      'order_request_lines.select': { data: [], error: null },
      'rpc:confirm_order_signature': { data: { id: 'ord-1' }, error: null },
    }).client;

    await POST(request());

    const recipients = sentTo();
    expect(recipients).toContain('ext@x.com');
    expect(recipients).toContain('bob@site.org');
  });

  // A3: a requester who deleted their account (0388 requester_deleted_at) is
  // never emailed again, not even at the address the order kept (O-A3-6).
  // Before A3 the kept requester_email was used first, so the deleted
  // person still got the receipt and the backorder notices.
  it('a requester who deleted their account gets nothing; the signer still gets a receipt', async () => {
    const deleted = {
      ...INTERNAL_ORDER,
      requester_user_id: null,
      requester_email: 'gone@x.com',
      requester_name: 'Gone',
      requester_deleted_at: '2026-10-04T12:00:00.000Z',
    };
    const admin = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: deleted, error: null },
      'order_requests.select.single': { data: { ...deleted, status: 'completed' }, error: null },
      'order_request_lines.select': { data: [{ quantity_fulfilled: 2 }], error: null },
      'rpc:confirm_order_signature': { data: { id: 'ord-1' }, error: null },
    });
    adminHolder.client = admin.client;

    const res = await POST(request());
    expect(res.status).toBe(200);

    expect(sentTo()).toEqual(['bob@site.org']);
    expect(notifyRequesterBackorderShipped).toHaveBeenCalledTimes(1);
    expect((notifyRequesterBackorderShipped.mock.calls[0]?.[0] as NotifyCall).requesterEmail).toBeNull();
    // The route asks for the marker with the order.
    const firstSelect = admin.chainArgsAll.get('order_requests.select')?.[0]?.[0]?.[0];
    expect(String(firstSelect)).toContain('requester_deleted_at');
    expect(admin.fromCalls).not.toContain('user_profiles');
  });

  // A3 desk check F-1 sweep: the phone pre-fills the signer email with the
  // address the order kept (old bundles included), and the signer receipt goes
  // to whatever address is submitted. When that address is the deleted
  // requester's kept one, no receipt goes out either.
  const deletedOrder = {
    ...INTERNAL_ORDER,
    requester_user_id: null,
    requester_email: 'gone@x.com',
    requester_name: 'Gone',
    requester_deleted_at: '2026-10-04T12:00:00.000Z',
  };

  it("no completion receipt to the deleted requester's kept address when it is the signer email", async () => {
    adminHolder.client = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: deletedOrder, error: null },
      'order_requests.select.single': { data: { ...deletedOrder, status: 'completed' }, error: null },
      'order_request_lines.select': { data: [{ quantity_fulfilled: 0 }], error: null },
      'rpc:confirm_order_signature': { data: { id: 'ord-1' }, error: null },
    }).client;

    const res = await POST(request('Gone@X.com'));
    expect(res.status).toBe(200);
    expect(sentTo()).toEqual([]);
  });

  it("no partial receipt to the deleted requester's kept address when it is the signer email", async () => {
    let lineCall = 0;
    adminHolder.client = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: deletedOrder, error: null },
      'order_requests.select.single': { data: { ...deletedOrder, status: 'backordered' }, error: null },
      'order_request_lines.select': (): QueryResult => {
        lineCall += 1;
        return lineCall === 1
          ? { data: [{ quantity_fulfilled: 0 }], error: null }
          : { data: [{ quantity_requested: 5, quantity_fulfilled: 2 }], error: null };
      },
      'rpc:confirm_order_signature': { data: { id: 'ord-1' }, error: null },
    }).client;

    const res = await POST(request('gone@x.com'));
    expect(res.status).toBe(200);
    expect(sendPartialReceiptEmail).not.toHaveBeenCalled();
    expect((notifyRequesterBackordered.mock.calls[0]?.[0] as NotifyCall).requesterEmail).toBeNull();
  });

  it('another signer on a deleted requester\'s order still gets the partial receipt', async () => {
    let lineCall = 0;
    adminHolder.client = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: deletedOrder, error: null },
      'order_requests.select.single': { data: { ...deletedOrder, status: 'backordered' }, error: null },
      'order_request_lines.select': (): QueryResult => {
        lineCall += 1;
        return lineCall === 1
          ? { data: [{ quantity_fulfilled: 0 }], error: null }
          : { data: [{ quantity_requested: 5, quantity_fulfilled: 2 }], error: null };
      },
      'rpc:confirm_order_signature': { data: { id: 'ord-1' }, error: null },
    }).client;

    await POST(request('bob@site.org'));
    expect(sendPartialReceiptEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'bob@site.org' }),
    );
  });
});

// L87: the sign page's words follow the status the hand-over left.
describe('POST /api/orders/sign — answers the resulting status (L87)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a hand-over that completes the order answers completed', async () => {
    adminHolder.client = buildAdmin({
      status: 'completed',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 5,
    });
    const res = await POST(request());
    expect(await res.json()).toEqual({ ok: true, data: { id: 'ord-1', status: 'completed' } });
  });

  it('a hand-over that leaves units owed answers backordered', async () => {
    adminHolder.client = buildAdmin({
      status: 'backordered',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 2,
    });
    const res = await POST(request());
    expect(await res.json()).toEqual({ ok: true, data: { id: 'ord-1', status: 'backordered' } });
  });
});

// L91: the three hand-over notices printed "Order #XXXXXXXX" because this
// path never passed the order number they accept; the app names it SO-000049.
describe('POST /api/orders/sign — hand-over notices name the order by its number (L91)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the partly-fulfilled notice and the signer receipt get SO-000049', async () => {
    adminHolder.client = buildAdmin({
      status: 'backordered',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 2,
      orderNumber: 49,
    });

    await POST(request());

    expect(notifyRequesterBackordered).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: 'SO-000049' }),
    );
    expect(sendPartialReceiptEmail).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: 'SO-000049' }),
    );
  });

  it('the backorder-shipped notice gets SO-000049', async () => {
    adminHolder.client = buildAdmin({
      status: 'completed',
      priorFulfilled: 2,
      totalRequested: 5,
      totalFulfilled: 5,
      orderNumber: 49,
    });

    await POST(request());

    expect(notifyRequesterBackorderShipped).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: 'SO-000049' }),
    );
  });

  it('an order without a number passes none (the notices fall back to the short id)', async () => {
    adminHolder.client = buildAdmin({
      status: 'backordered',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 2,
      orderNumber: null,
    });

    await POST(request());

    expect(notifyRequesterBackordered).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: null }),
    );
  });
});

describe('POST /api/orders/sign — reads after the signature is recorded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const completed: Scenario = {
    status: 'completed',
    priorFulfilled: 0,
    totalRequested: 5,
    totalFulfilled: 5,
  };

  it('status read fails twice: the signer still gets 200, it is reported, and nothing is guessed', async () => {
    adminHolder.client = buildAdmin({ ...completed, statusReadFailures: 2 });

    const res = await POST(request());

    expect(res.status).toBe(200);
    // L87: the status could not be read, so none is claimed.
    expect(await res.json()).toEqual({ ok: true, data: { id: 'ord-1', status: null } });
    expect(reportError).toHaveBeenCalledWith(
      READ_ERROR,
      expect.objectContaining({ tag: 'orders.sign.post_status_read', level: 'warning' }),
    );
    // Unknown status: no receipt, no return prompt, no completion event.
    expect(sendOrderRequestEmail).not.toHaveBeenCalled();
    expect(maybeSendReturnPrompt).not.toHaveBeenCalled();
    expect(notifyRequesterBackordered).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('status read fails once and the retry answers: the follow-ups run as normal', async () => {
    adminHolder.client = buildAdmin({ ...completed, statusReadFailures: 1 });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(reportedTags()).not.toContain('orders.sign.post_status_read');
    expect(sentTo().sort()).toEqual(['alice@site.org', 'bob@site.org']);
    expect(maybeSendReturnPrompt).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).toHaveBeenCalledWith('org-1', 'order.completed', expect.anything());
  });

  it('preference read fails: the requester gets NO email (fail closed), the signer still does', async () => {
    adminHolder.client = buildAdmin({ ...completed, prefReadFails: true });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(sentTo()).toEqual(['bob@site.org']);
    expect(reportedTags()).toContain('orders.sign.pref_read');
  });

  it('preference read fails on a backorder: the notice goes out with email suppressed', async () => {
    adminHolder.client = buildAdmin({
      status: 'backordered',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 2,
      prefReadFails: true,
    });

    await POST(request());

    const args = notifyRequesterBackordered.mock.calls[0]?.[0] as NotifyCall;
    expect(args.emailOptedOut).toBe(true);
  });

  it('line totals read fails twice on a backorder: the requester is still told, without counts', async () => {
    adminHolder.client = buildAdmin({
      status: 'backordered',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 2,
      lineTotalsFailures: 2,
    });

    const res = await POST(request());

    expect(res.status).toBe(200);
    // The one message the requester gets about the fork is not dropped; it
    // carries no counts rather than "0 of 0".
    expect(notifyRequesterBackordered).toHaveBeenCalledTimes(1);
    expect(notifyRequesterBackordered.mock.calls[0]?.[0]).toMatchObject({
      requesterEmail: 'alice@site.org',
      provided: null,
      requested: null,
      owed: null,
      emailOptedOut: false,
    });
    // The signer's receipt IS its counts, so it is not sent without them.
    expect(sendPartialReceiptEmail).not.toHaveBeenCalled();
    expect(reportedTags()).toContain('orders.sign.line_totals_read');
    // The status change itself is still announced; it carries no counts.
    expect(dispatchEvent).toHaveBeenCalledWith(
      'org-1',
      'order.status_changed',
      expect.objectContaining({ status: 'backordered' }),
    );
  });

  it('line totals read fails once and the retry answers: the notice carries the counts', async () => {
    adminHolder.client = buildAdmin({
      status: 'backordered',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 2,
      lineTotalsFailures: 1,
    });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(reportedTags()).not.toContain('orders.sign.line_totals_read');
    expect(notifyRequesterBackordered.mock.calls[0]?.[0]).toMatchObject({
      provided: 2,
      requested: 5,
      owed: 3,
    });
    // Signer (bob) is not the requester (alice), so the receipt goes out.
    expect(sendPartialReceiptEmail).toHaveBeenCalledWith(
      expect.objectContaining({ unitsReceived: 2, unitsTotal: 5, unitsPending: 3 }),
    );
  });

  it('line totals read fails twice on a completed backorder: the shipped notice omits the count', async () => {
    adminHolder.client = buildAdmin({
      status: 'completed',
      priorFulfilled: 2,
      totalRequested: 5,
      totalFulfilled: 5,
      lineTotalsFailures: 2,
    });

    await POST(request());

    expect(notifyRequesterBackorderShipped).toHaveBeenCalledTimes(1);
    const args = notifyRequesterBackorderShipped.mock.calls[0]?.[0] as unknown as {
      unitsShipped: number | null;
    };
    expect(args.unitsShipped).toBeNull();
    expect(reportedTags()).toContain('orders.sign.line_totals_read');
  });
});

/**
 * Docket S36 (integrator decision 2026-11-01 on #440, with its precision): a
 * member's OWN address (their profile's; the order kept none) is used only
 * while they are a current member of the order's organization, the rule 0422
 * and createNotification apply to every notice and push. That covers every
 * hand-over email to the requester's own address: the partial hand-over
 * (order-handover-notify.ts :210), backordered items shipped (:282), a
 * replacement's partial hand-over (:139) and the completion receipt. An
 * address the order recorded is emailed whoever placed the order (the
 * on-behalf and deleted-requester tests above).
 */
describe('POST /api/orders/sign — a requester who is no longer a member (S36)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const former = { requesterIsMember: false } as const;

  it('a partial hand-over: no address for the requester notice (:210); another signer still gets the receipt', async () => {
    adminHolder.client = buildAdmin({
      status: 'backordered',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 2,
      ...former,
    });

    const res = await POST(request());
    expect(res.status).toBe(200);

    expect(notifyRequesterBackordered).toHaveBeenCalledTimes(1);
    expect((notifyRequesterBackordered.mock.calls[0]?.[0] as NotifyCall).requesterEmail).toBeNull();
    expect(sendPartialReceiptEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'bob@site.org' }),
    );
    // An expected recipient to drop, not an error.
    expect(reportedTags()).not.toContain('orders.sign.requester_member_check');
  });

  it('an exchange replacement handed over in part: no address for its email either (:139)', async () => {
    adminHolder.client = buildAdmin({
      status: 'backordered',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 2,
      replacementForReturnId: 'rma-1',
      ...former,
    });

    await POST(request());

    expect(notifyRequesterBackordered).toHaveBeenCalledWith(
      expect.objectContaining({ requesterEmail: null, replacementForReturnId: 'rma-1' }),
    );
  });

  it('the remainder handed over: no address for backordered items shipped (:282); only the signer gets a completion receipt', async () => {
    adminHolder.client = buildAdmin({
      status: 'completed',
      priorFulfilled: 2,
      totalRequested: 5,
      totalFulfilled: 5,
      ...former,
    });

    await POST(request());

    expect(notifyRequesterBackorderShipped).toHaveBeenCalledTimes(1);
    expect(
      (notifyRequesterBackorderShipped.mock.calls[0]?.[0] as NotifyCall).requesterEmail,
    ).toBeNull();
    expect(sentTo()).toEqual(['bob@site.org']);
  });

  it('a completed hand-over: no completion receipt to their own address', async () => {
    adminHolder.client = buildAdmin({
      status: 'completed',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 5,
      ...former,
    });

    await POST(request());

    expect(sentTo()).toEqual(['bob@site.org']);
  });

  // The sign page fills the signer email with the requester's own address
  // (orders/sign/[token]/page.tsx), and the server cannot tell an accepted
  // default from a typed one: as for a deleted requester's kept address (A3),
  // the withheld address gets no signer receipt either, or the requester
  // notice would only have changed its name.
  it('their own address entered as the signer email gets no receipt on a completed hand-over', async () => {
    adminHolder.client = buildAdmin({
      status: 'completed',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 5,
      ...former,
    });

    const res = await POST(request('Alice@Site.org'));
    expect(res.status).toBe(200);

    expect(sentTo()).toEqual([]);
  });

  it('their own address entered as the signer email gets no partial receipt', async () => {
    adminHolder.client = buildAdmin({
      status: 'backordered',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 2,
      ...former,
    });

    await POST(request('alice@site.org'));

    expect(sendPartialReceiptEmail).not.toHaveBeenCalled();
    expect((notifyRequesterBackordered.mock.calls[0]?.[0] as NotifyCall).requesterEmail).toBeNull();
  });

  // Review of round 2 (security lens): the two refusals above compare the
  // signer email with the withheld address, which comes from a profile read
  // of its own. When that read failed, the address was unknown, the refusal
  // lapsed, and the receipt went to the address the sign page had offered:
  // the former member's own. With the address unknown, no signer receipt
  // goes out at all. A receipt lost to a read error is acceptable (every
  // email here is best-effort); one to a former member's own address is not.
  /** The requester's own profile: the address the sign page offers as the
   *  default signer email (the read of it fails in these tests). */
  const OWN = { email: 'former@example.com', full_name: 'Former Requester' };

  it('their own address cannot be read: no completion receipt to it, and the failed read is reported', async () => {
    adminHolder.client = buildAdmin({
      status: 'completed',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 5,
      profile: OWN,
      ...former,
      ownAddressReadFails: true,
    });

    const res = await POST(request(OWN.email));
    expect(res.status).toBe(200);

    expect(sentTo()).toEqual([]);
    expect(reportedTags()).toEqual(['orders.sign.requester_member_check']);
  });

  it('their own address cannot be read: no partial receipt to it either', async () => {
    adminHolder.client = buildAdmin({
      status: 'backordered',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 2,
      profile: OWN,
      ...former,
      ownAddressReadFails: true,
    });

    await POST(request(OWN.email));

    expect(sendPartialReceiptEmail).not.toHaveBeenCalled();
    expect((notifyRequesterBackordered.mock.calls[0]?.[0] as NotifyCall).requesterEmail).toBeNull();
  });

  it('their own address cannot be read: any other signer email loses its receipt too (it cannot be told apart)', async () => {
    adminHolder.client = buildAdmin({
      status: 'completed',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 5,
      profile: OWN,
      ...former,
      ownAddressReadFails: true,
    });

    await POST(request('dock.signer@example.com'));

    expect(sentTo()).toEqual([]);
  });

  it('both profile reads fail, so the member check cannot answer either: no receipt, each failed read reported', async () => {
    adminHolder.client = buildAdmin({
      status: 'completed',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 5,
      profile: OWN,
      disabledReadFails: true,
      ownAddressReadFails: true,
    });

    await POST(request(OWN.email));

    expect(sentTo()).toEqual([]);
    expect(reportedTags()).toEqual([
      'orders.sign.requester_member_check',
      'orders.sign.requester_member_check',
    ]);
  });

  it('a current member whose address read fails: the signer still gets the receipt, and the failed read is reported', async () => {
    const member = { email: 'member@example.com', full_name: 'Member Requester' };
    adminHolder.client = buildAdmin({
      status: 'completed',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 5,
      profile: member,
      ownAddressReadFails: true,
    });

    await POST(request(member.email));

    // No requester email (no address), and the signer's receipt as always.
    expect(sentTo()).toEqual([member.email]);
    expect(reportedTags()).toEqual(['orders.sign.requester_member_check']);
  });

  it('a membership read that fails: no requester address (fail closed), reported once', async () => {
    adminHolder.client = buildAdmin({
      status: 'backordered',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 2,
      membershipReadFails: true,
    });

    await POST(request());

    expect((notifyRequesterBackordered.mock.calls[0]?.[0] as NotifyCall).requesterEmail).toBeNull();
    expect(reportedTags().filter((t) => t === 'orders.sign.requester_member_check')).toHaveLength(
      1,
    );
  });

  it('a current member is still reached at their own address (control)', async () => {
    adminHolder.client = buildAdmin({
      status: 'backordered',
      priorFulfilled: 0,
      totalRequested: 5,
      totalFulfilled: 2,
    });

    await POST(request());

    expect((notifyRequesterBackordered.mock.calls[0]?.[0] as NotifyCall).requesterEmail).toBe(
      'alice@site.org',
    );
  });

  it('a portal order (the buyer signed in, never a member) keeps the address it recorded', async () => {
    const portal = {
      ...INTERNAL_ORDER,
      source: 'portal',
      requester_user_id: 'portal-buyer',
      requester_email: 'buyer@example.com',
      requester_name: 'Buyer Example',
    };
    adminHolder.client = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: portal, error: null },
      'order_requests.select.single': { data: { ...portal, status: 'completed' }, error: null },
      'order_request_lines.select': { data: [{ quantity_fulfilled: 0 }], error: null },
      'rpc:confirm_order_signature': { data: { id: 'ord-1' }, error: null },
      'notification_preferences.select.maybeSingle': { data: null, error: null },
      'organization_members.select': servedLikePostgrest([]),
    }).client;

    await POST(request());

    expect(sentTo()).toEqual(['buyer@example.com', 'bob@site.org']);
  });
});

// S31: without the service-role key the route answered the setting's name
// ("Server is missing SUPABASE_SERVICE_ROLE_KEY ..."), to the public signing
// page and the phone. It says the feature is not set up now, and the report
// names the setting.
describe('POST /api/orders/sign — a server without the service-role key (S31)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers 500 with the not-set-up sentence, never the setting, reported as a warning', async () => {
    const missing = new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    vi.mocked(createAdminClient).mockImplementationOnce(() => {
      throw missing;
    });
    const res = await POST(request());
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'This feature is not set up yet.' },
    });
    expect(text).not.toMatch(/SUPABASE|KEY/);
    expect(reportError).toHaveBeenCalledWith(missing, {
      tag: 'orders.sign.admin_client',
      level: 'warning',
    });
  });
});
