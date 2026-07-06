import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import type { OrderRequestRow } from '@/server/services/order-requests';

/**
 * sendOrderRequestEmail is the single choke point for every
 * order-request email. This suite pins the public-recipient opt-out
 * contract (migration 0222):
 *   - lifecycle emails to an unsubscribed anonymous recipient are
 *     SKIPPED,
 *   - the confirm_request double-opt-in email is exempt (suppressing it
 *     would silently brick a request the recipient just submitted),
 *   - signed-in requesters are governed by their in-app prefs, not the
 *     public list, and keep the in-app unsubscribe link,
 *   - public recipients get the signed /unsubscribe URL + RFC 8058
 *     one-click headers; with no UNSUBSCRIBE_SECRET the signer fails
 *     closed and the email falls back to the in-app link (no one-click
 *     header advertised for a URL that ignores POSTs).
 */

// vi.hoisted: the factory runs during hoisted imports, before top-level consts.
const envState = vi.hoisted(() => ({ UNSUBSCRIBE_SECRET: 'sender-test-secret-0123456789abcdef' }));
vi.mock('@/lib/env', () => ({ env: envState }));

interface SendEmailArgs {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
}
const sendEmailMock = vi.fn(async (_args: SendEmailArgs) => ({ ok: true }));
vi.mock('./resend', () => ({
  sendEmail: (args: SendEmailArgs) => sendEmailMock(args),
}));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminHolder.client),
}));

import { sendOrderRequestEmail } from './order-requests';

const EMAIL = 'requester@school.edu';
const APP_URL = 'https://app.test';

function makeRow(overrides: Partial<OrderRequestRow> = {}): OrderRequestRow {
  return {
    id: '99999999-8888-7777-6666-555555555555',
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

function wireAdmin(unsubscribed: boolean): SupabaseStub {
  const stub = makeSupabaseStub({
    'public_email_unsubscribes.select.maybeSingle': {
      data: unsubscribed ? { email: EMAIL } : null,
      error: null,
    },
  });
  adminHolder.client = stub.client;
  return stub;
}

describe('sendOrderRequestEmail — public unsubscribe enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.UNSUBSCRIBE_SECRET = 'sender-test-secret-0123456789abcdef';
    adminHolder.client = null;
  });

  it('skips a lifecycle email to an unsubscribed public recipient', async () => {
    const stub = wireAdmin(true);

    await sendOrderRequestEmail({
      kind: 'approved',
      request: makeRow(),
      recipientEmail: EMAIL,
      recipientName: 'Jane Teacher',
      appUrl: APP_URL,
    });

    expect(sendEmailMock).not.toHaveBeenCalled();
    // Lookup runs against the canonical lowercased address.
    expect(stub.chainArgs.get('public_email_unsubscribes.select')).toEqual([
      ['email'],
      ['email', EMAIL],
    ]);
  });

  it('still sends confirm_request to an unsubscribed address (double-opt-in exemption)', async () => {
    wireAdmin(true);

    await sendOrderRequestEmail({
      kind: 'confirm_request',
      request: makeRow({ status: 'pending_confirmation' }),
      recipientEmail: EMAIL,
      recipientName: 'Jane Teacher',
      appUrl: APP_URL,
      confirmationToken: 'ab'.repeat(32),
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('sends to a non-unsubscribed public recipient with the signed one-click headers', async () => {
    wireAdmin(false);

    await sendOrderRequestEmail({
      kind: 'approved',
      request: makeRow(),
      recipientEmail: EMAIL,
      recipientName: 'Jane Teacher',
      appUrl: APP_URL,
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const args = sendEmailMock.mock.calls[0]![0];
    const header = args.headers?.['List-Unsubscribe'] ?? '';
    expect(header).toMatch(
      new RegExp(`^<${APP_URL}/unsubscribe\\?e=${encodeURIComponent(EMAIL).replace('@', '%40')}&t=[0-9a-f]{64}>$`),
    );
    expect(args.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // The footer link in both bodies points at the public page, not the
    // login-gated dashboard prefs that dead-end anonymous recipients.
    expect(args.html).toContain('/unsubscribe?e=');
    expect(args.text).toContain('/unsubscribe?e=');
    expect(args.html).not.toContain('/dashboard/settings/notifications');
  });

  it('signed-in requesters are NOT suppressed by the public list and keep the in-app link', async () => {
    wireAdmin(true); // address is on the public list — must not matter

    await sendOrderRequestEmail({
      kind: 'approved',
      request: makeRow({ requester_user_id: 'user-1' }),
      recipientEmail: EMAIL,
      recipientName: 'Jane Teacher',
      appUrl: APP_URL,
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const args = sendEmailMock.mock.calls[0]![0];
    expect(args.headers?.['List-Unsubscribe']).toBe(
      `<${APP_URL}/dashboard/settings/notifications?email=${encodeURIComponent(EMAIL)}>`,
    );
    // No one-click advertised for a login-gated page that ignores POSTs.
    expect(args.headers?.['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('falls back to the in-app link (no one-click header) when UNSUBSCRIBE_SECRET is unset', async () => {
    envState.UNSUBSCRIBE_SECRET = '';
    wireAdmin(false);

    await sendOrderRequestEmail({
      kind: 'approved',
      request: makeRow(),
      recipientEmail: EMAIL,
      recipientName: 'Jane Teacher',
      appUrl: APP_URL,
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const args = sendEmailMock.mock.calls[0]![0];
    expect(args.headers?.['List-Unsubscribe']).toContain('/dashboard/settings/notifications');
    expect(args.headers?.['List-Unsubscribe-Post']).toBeUndefined();
  });
});
