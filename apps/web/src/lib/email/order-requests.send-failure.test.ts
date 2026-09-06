import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import type { OrderRequestRow } from '@/server/services/order-requests';

/**
 * SP-046 regression suite.
 *
 * `sendEmail` NEVER throws — on a Resend refusal (rotated API key, a
 * domain block, a 5xx) it resolves `{ ok: false, error }` (see
 * lib/email/resend.ts). `sendOrderRequestEmail` used to drop that
 * result and return `void`, so all three callers — the service's
 * `notifyEmail`, the public submit route and the sign route, each of
 * which wraps the call in a best-effort `try/catch` that only
 * `console.warn`s — could not tell a delivered email from a dead one.
 * `console.*` stays in the Vercel logs; `reportError` is the only path
 * to ERROR_WEBHOOK_URL. Net effect: a total order-email outage was
 * invisible (recurring pattern #28, "a swallowed error is not
 * best-effort, it is unmonitored").
 *
 * This suite pins BOTH halves of the fix at the choke point:
 *   - the SendResult is returned to the caller, and
 *   - a failed send raises reportError('orders.email') here, so no
 *     caller has to remember (pattern #26 — one implementation, not
 *     three copies).
 */

const envState = vi.hoisted(() => ({ UNSUBSCRIBE_SECRET: 'sender-test-secret-0123456789abcdef' }));
vi.mock('@/lib/env', () => ({ env: envState }));

interface SendEmailArgs {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  headers?: Record<string, string>;
}
interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
}
const sendEmailResult = vi.hoisted(() => ({ value: { ok: true, id: 'msg-1' } as SendEmailResult }));
const sendEmailMock = vi.fn(async (_args: SendEmailArgs) => sendEmailResult.value);
vi.mock('./resend', () => ({
  sendEmail: (args: SendEmailArgs) => sendEmailMock(args),
}));

const reportErrorMock = vi.fn(async (_e: unknown, _ctx: unknown) => undefined);
vi.mock('@/lib/error-reporter', () => ({
  reportError: (e: unknown, ctx: unknown) => reportErrorMock(e, ctx),
}));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminHolder.client),
}));

import { sendOrderRequestEmail } from './order-requests';

const EMAIL = 'requester@school.edu';
const APP_URL = 'https://app.test';
const ORDER_ID = '99999999-8888-7777-6666-555555555555';

function makeRow(overrides: Partial<OrderRequestRow> = {}): OrderRequestRow {
  return {
    id: ORDER_ID,
    organization_id: 'org-1',
    warehouse_id: 'wh-1',
    status: 'approved',
    source: 'public_link',
    requester_user_id: null,
    requester_email: EMAIL,
    requester_name: 'Jane Teacher',
    fulfillment_type: 'pickup',
    delivery_charter_id: null,
    denied_reason: null,
    packing_slip_generated_at: null,
    approved_at: '2026-07-01T00:00:00Z',
    created_at: '2026-06-30T00:00:00Z',
    ...overrides,
  } as OrderRequestRow;
}

function wireAdmin(opts: { unsubscribed?: boolean } = {}): void {
  const stub = makeSupabaseStub({
    'public_email_unsubscribes.select.maybeSingle': {
      data: opts.unsubscribed ? { email: EMAIL } : null,
      error: null,
    },
    'order_request_lines.select': {
      data: [
        {
          quantity_picked: 4,
          quantity_requested: 6,
          item: { name: 'Blue Nitrile Gloves — Large', sku: 'GLV-BL-L' },
        },
      ],
      error: null,
    },
    'warehouses.select.maybeSingle': {
      data: { name: 'Fresno DC', code: 'DCIV', address: { city: 'Fresno' } },
      error: null,
    },
    'charters.select.maybeSingle': { data: { name: 'Manchester', code: 'CVW' }, error: null },
    'user_profiles.select.maybeSingle': {
      data: { full_name: 'Morgan Diaz', email: 'morgan@l4l.org' },
      error: null,
    },
  });
  adminHolder.client = stub.client;
}

describe('sendOrderRequestEmail — delivery failures are reported, not swallowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.UNSUBSCRIBE_SECRET = 'sender-test-secret-0123456789abcdef';
    sendEmailResult.value = { ok: true, id: 'msg-1' };
    adminHolder.client = null;
  });

  it('reports a Resend failure to the error webhook and hands ok=false back', async () => {
    wireAdmin();
    sendEmailResult.value = { ok: false, error: 'Resend 401 invalid api key' };

    const result = await sendOrderRequestEmail({
      kind: 'approved',
      request: makeRow(),
      recipientEmail: EMAIL,
      recipientName: 'Jane Teacher',
      appUrl: APP_URL,
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    // Asserted BEFORE the return value on purpose: the monitoring gap
    // is the finding. Against the unfixed module this line is the one
    // that fails.
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = reportErrorMock.mock.calls[0]!;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Resend 401');
    expect(ctx).toEqual(
      expect.objectContaining({
        tag: 'orders.email',
        level: 'error',
        organizationId: 'org-1',
        extra: expect.objectContaining({ kind: 'approved', orderId: ORDER_ID }),
      }),
    );
    // error-reporter convention: no PII on the payload. The recipient
    // address must never ride out to a Slack webhook.
    expect(JSON.stringify(ctx)).not.toContain(EMAIL);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Resend 401');
  });

  it('masks the recipient address Resend echoes back in its error body', async () => {
    // A Resend 422 quotes the offending `to` value. That body is the
    // only useful alert detail, but ERROR_WEBHOOK_URL is typically a
    // Slack channel and the reporter redacts TOKENS, not addresses.
    wireAdmin();
    sendEmailResult.value = {
      ok: false,
      error: `{"statusCode":422,"message":"Invalid \`to\` field: ${EMAIL}","name":"validation_error"}`,
    };

    await sendOrderRequestEmail({
      kind: 'approved',
      request: makeRow(),
      recipientEmail: EMAIL,
      recipientName: 'Jane Teacher',
      appUrl: APP_URL,
    });

    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [err] = reportErrorMock.mock.calls[0]!;
    const message = (err as Error).message;
    expect(message).not.toContain(EMAIL);
    expect(message).toContain('[email]');
    // The diagnosable part survives the masking.
    expect(message).toContain('422');
  });

  it('stays silent and returns ok on a successful send', async () => {
    wireAdmin();

    const result = await sendOrderRequestEmail({
      kind: 'approved',
      request: makeRow(),
      recipientEmail: EMAIL,
      recipientName: 'Jane Teacher',
      appUrl: APP_URL,
    });

    expect(result.ok).toBe(true);
    expect(result.id).toBe('msg-1');
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('a deliberate suppression is ok+skipped, never an alert', async () => {
    // The public unsubscribe list (migration 0222) is a CHOICE, not a
    // failure — it must not page anyone.
    wireAdmin({ unsubscribed: true });

    const result = await sendOrderRequestEmail({
      kind: 'approved',
      request: makeRow(),
      recipientEmail: EMAIL,
      recipientName: 'Jane Teacher',
      appUrl: APP_URL,
    });

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, skipped: true, skipReason: 'unsubscribed' });
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('the ES_LATENT_ORDER_EMAILS=0 kill-switch is ok+skipped, never an alert', async () => {
    wireAdmin();
    const prior = process.env.ES_LATENT_ORDER_EMAILS;
    process.env.ES_LATENT_ORDER_EMAILS = '0';
    try {
      const result = await sendOrderRequestEmail({
        kind: 'staged_for_delivery',
        request: makeRow(),
        recipientEmail: EMAIL,
        recipientName: 'Jane Teacher',
        appUrl: APP_URL,
      });

      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, skipped: true, skipReason: 'kill_switch' });
      expect(reportErrorMock).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env.ES_LATENT_ORDER_EMAILS;
      else process.env.ES_LATENT_ORDER_EMAILS = prior;
    }
  });
});
