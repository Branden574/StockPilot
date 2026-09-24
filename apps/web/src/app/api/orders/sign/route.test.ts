import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

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
      : { data: { ...INTERNAL_ORDER, status: s.status }, error: null };
  };

  return makeSupabaseStub({
    'order_requests.select.maybeSingle': { data: INTERNAL_ORDER, error: null },
    'order_requests.select.single': statusResult,
    'order_request_lines.select': linesResult,
    'rpc:confirm_order_signature': { data: { id: 'ord-1' }, error: null },
    'user_profiles.select.maybeSingle': {
      data: s.profile === undefined ? { email: 'alice@site.org', full_name: 'Alice' } : s.profile,
      error: null,
    },
    'notification_preferences.select.maybeSingle': s.prefReadFails
      ? { data: null, error: READ_ERROR }
      : { data: { email_order_completed: s.emailOrderCompleted ?? true }, error: null },
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
    expect(await res.json()).toEqual({ ok: true, data: { id: 'ord-1' } });
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
