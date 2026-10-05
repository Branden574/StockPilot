import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import type { OrderRequestRow } from '@/server/services/order-requests';

/**
 * Returns RX-2 at the order email choke point: an exchange replacement order
 * never gets the ordinary order emails (they would say "We received your
 * order" and link a tracker no replacement has). sendOrderRequestEmail hands
 * every kind for a replacement to the replacement sender, and nothing else
 * changes for an ordinary order.
 */

const envState = vi.hoisted(() => ({ UNSUBSCRIBE_SECRET: 'sender-test-secret-0123456789abcdef' }));
vi.mock('@/lib/env', () => ({ env: envState }));

const sendEmailMock = vi.hoisted(() => vi.fn(async (_args: unknown) => ({ ok: true, id: 'msg-1' })));
vi.mock('./resend', () => ({ sendEmail: sendEmailMock }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

const adminHolder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

const replacementSend = vi.hoisted(() => vi.fn(async (_admin: unknown, _args: unknown): Promise<'sent' | 'skipped' | 'failed'> => 'sent'));
vi.mock('@/server/email/replacement-update', () => ({ sendReplacementOrderEmail: replacementSend }));

import { sendOrderRequestEmail } from './order-requests';

const EMAIL = 'pat@example.com';

function row(overrides: Partial<OrderRequestRow> = {}): OrderRequestRow {
  return {
    id: 'ord-1',
    organization_id: 'org-1',
    warehouse_id: 'wh-1',
    status: 'in_transit',
    source: 'internal',
    requester_user_id: null,
    requester_email: EMAIL,
    requester_name: 'Pat',
    fulfillment_type: 'delivery',
    delivery_charter_id: null,
    denied_reason: null,
    packing_slip_generated_at: null,
    approved_at: '2026-10-05T00:00:00Z',
    created_at: '2026-10-05T00:00:00Z',
    ...overrides,
  } as OrderRequestRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  adminHolder.client = makeSupabaseStub({
    'public_email_unsubscribes.select.maybeSingle': { data: null, error: null },
    'order_request_lines.select': { data: [], error: null },
    'warehouses.select.maybeSingle': { data: { name: 'DC4' }, error: null },
  }).client;
});

describe('sendOrderRequestEmail and the exchange replacement (RX-2)', () => {
  it.each(['submitted', 'approved', 'cancelled', 'denied', 'packing_slip_generated', 'staged_for_delivery', 'in_transit', 'completed'] as const)(
    '%s for a replacement goes to the replacement sender only',
    async (kind) => {
      replacementSend.mockResolvedValueOnce(kind === 'in_transit' ? 'sent' : 'skipped');
      const result = await sendOrderRequestEmail({
        kind,
        request: row({ replacement_for_return_id: 'rma-1' }),
        recipientEmail: EMAIL,
        recipientName: 'Pat',
        appUrl: 'https://app.test',
      });
      expect(replacementSend).toHaveBeenCalledTimes(1);
      expect(replacementSend.mock.calls[0]![1]).toMatchObject({ kind, to: EMAIL });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(result).toEqual(kind === 'in_transit' ? { ok: true } : { ok: true, skipped: true, skipReason: 'replacement' });
    },
  );

  it('a failed replacement send is reported as not ok', async () => {
    replacementSend.mockResolvedValueOnce('failed');
    const result = await sendOrderRequestEmail({
      kind: 'in_transit',
      request: row({ replacement_for_return_id: 'rma-1' }),
      recipientEmail: EMAIL,
      recipientName: null,
      appUrl: 'https://app.test',
    });
    expect(result.ok).toBe(false);
  });

  it('an ordinary order never touches the replacement sender', async () => {
    await sendOrderRequestEmail({
      kind: 'in_transit',
      request: row({ replacement_for_return_id: null }),
      recipientEmail: EMAIL,
      recipientName: 'Pat',
      appUrl: 'https://app.test',
    });
    expect(replacementSend).not.toHaveBeenCalled();
  });
});
