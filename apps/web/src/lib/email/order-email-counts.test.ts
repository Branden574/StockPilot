import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import type { OrderRequestRow } from '@/server/services/order-requests';

/**
 * B9: an order of one unit on one line was emailed as "1 units" and "1
 * lines": in the approved preheader ("Reserved 1 units across 1 lines"), the
 * Contents cell, the packing and cancelled sentences, the plain-text summary,
 * the "+ 1 more lines" note under a long item table, and in the partial
 * delivery, backorder and receipt emails ("The remaining 1 units are
 * backordered", "Delivered: 1 units"). Every count now takes its noun (and
 * verb) from the number. Counts above one read exactly as before, which the
 * registry and family tests pin byte for byte.
 */

// A signed-in requester's footer links the in-app preferences page, so no
// unsubscribe signing value is needed.
vi.mock('@/lib/env', () => ({ env: {} }));

interface SendEmailArgs {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}
const sendEmailMock = vi.fn(async (_args: SendEmailArgs) => ({ ok: true }));
vi.mock('./resend', () => ({ sendEmail: (args: SendEmailArgs) => sendEmailMock(args) }));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

import {
  renderBackorderShippedEmail,
  renderPartialFulfilledEmail,
  renderPartialReceiptEmail,
} from './es/families/fulfillment';
import { sendOrderRequestEmail, type OrderRequestEmailKind } from './order-requests';

const EMAIL = 'requester@school.example';
/** The confirm link's value: any non-empty string. */
const CONFIRM_REF = 'confirm-ref';

/** "1 units", "1 lines", "1 items", but never "11 units" or "2.1 units". */
const ONE_WITH_PLURAL = /(?<![\d.,])1 (?:units|lines|items)\b/;

function makeRow(overrides: Partial<OrderRequestRow> = {}): OrderRequestRow {
  return {
    id: '99999999-8888-7777-6666-555555555555',
    organization_id: 'org-1',
    warehouse_id: 'wh-1',
    status: 'approved',
    source: 'internal',
    requester_user_id: 'req-1',
    requester_email: EMAIL,
    requester_name: 'Jane Teacher',
    fulfillment_type: 'pickup',
    delivery_charter_id: null,
    denied_reason: null,
    packing_slip_generated_at: null,
    approved_at: '2026-07-01T00:00:00Z',
    approved_by: 'appr-1',
    created_at: '2026-06-30T00:00:00Z',
    order_number: 49,
    ...overrides,
  } as OrderRequestRow;
}

function line(n: number, quantity = 1) {
  return {
    item_id: `it-${n}`,
    quantity_picked: null,
    quantity_requested: quantity,
    quantity_fulfilled: 0,
    item: { name: `Safety Goggles ${n}`, sku: `SG-${n}` },
  };
}

function wire(
  lines: unknown[],
  holds: { data: unknown; error: { message: string } | null } = { data: [], error: null },
) {
  adminHolder.client = makeSupabaseStub({
    'order_request_lines.select': { data: lines, error: null },
    'stock_reservations.select': holds as never,
    'warehouses.select.maybeSingle': {
      data: { name: 'Fresno DC', code: 'DCIV', address: { city: 'Fresno' } },
      error: null,
    },
    'user_profiles.select.maybeSingle': { data: { full_name: 'Morgan Diaz' }, error: null },
  }).client;
}

async function send(
  kind: OrderRequestEmailKind,
  row: Partial<OrderRequestRow> = {},
): Promise<SendEmailArgs> {
  sendEmailMock.mockClear();
  await sendOrderRequestEmail({
    kind,
    request: makeRow(row),
    recipientEmail: EMAIL,
    recipientName: 'Jane Teacher',
    appUrl: 'https://app.test',
    ...(kind === 'confirm_request' ? { confirmationToken: CONFIRM_REF } : {}),
  });
  expect(sendEmailMock).toHaveBeenCalledTimes(1);
  return sendEmailMock.mock.calls[0]![0];
}

function expectNoOnePlural(args: { subject: string; html: string; text?: string }) {
  for (const out of [args.subject, args.html, args.text ?? '']) {
    expect(out).not.toMatch(ONE_WITH_PLURAL);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  adminHolder.client = null;
});

describe('order request emails for one unit on one line', () => {
  const kinds: Array<[OrderRequestEmailKind, Partial<OrderRequestRow>]> = [
    ['confirm_request', { status: 'pending_confirmation' as OrderRequestRow['status'] }],
    ['submitted', { status: 'pending' as OrderRequestRow['status'] }],
    ['approved', {}],
    ['denied', { status: 'denied' as OrderRequestRow['status'], denied_reason: 'Over budget' }],
    ['in_transit', { status: 'in_transit' as OrderRequestRow['status'] }],
    ['completed', { status: 'completed' as OrderRequestRow['status'] }],
    ['cancelled', { status: 'cancelled' as OrderRequestRow['status'] }],
    ['packing_slip_generated', { packing_slip_generated_at: '2026-07-02T00:00:00Z' }],
    ['staged_for_delivery', { status: 'staged' as OrderRequestRow['status'] }],
  ];

  it.each(kinds)('%s never says "1 units" or "1 lines"', async (kind, row) => {
    wire([line(1)], { data: [{ item_id: 'it-1', quantity: 1 }], error: null });
    expectNoOnePlural(await send(kind, row));
  });

  it('approved with the unit held: "Reserved 1 unit across 1 line" and the Contents cell', async () => {
    wire([line(1)], { data: [{ item_id: 'it-1', quantity: 1 }], error: null });
    const args = await send('approved');
    expect(args.html).toContain('Reserved 1 unit across 1 line. Ships');
    expect(args.html).toMatch(/1 unit <span[^>]*>&middot; 1 line<\/span>/);
    expect(args.text).toContain('Contents: 1 unit across 1 line');
  });

  it('approved with half of one unit held: "0.5 of 1 unit", never "of 1 units"', async () => {
    // Quantities are numeric(14,4), so a partial hold can owe a single unit.
    wire([line(1)], { data: [{ item_id: 'it-1', quantity: 0.5 }], error: null });
    const args = await send('approved');
    expect(args.html).toContain('Reserved 0.5 of 1 unit. The rest is waiting for stock.');
    expect(args.html).toContain(
      'we’ve reserved 0.5 of 1 unit on this request; the rest is waiting',
    );
    expect(args.text).toContain('Reserved: 0.5 of 1 unit');
    expect(`${args.html}${args.text}`).not.toContain('of 1 units');
  });

  it('approved when the holds could not be read: "1 unit across 1 line"', async () => {
    wire([line(1)], { data: null, error: { message: 'timeout' } });
    const args = await send('approved');
    expect(args.html).toContain('Approved. 1 unit across 1 line from DCIV');
  });

  it('packing: "1 line is being picked" and "your 1 line now"', async () => {
    wire([line(1)]);
    const args = await send('packing_slip_generated', {
      packing_slip_generated_at: '2026-07-02T00:00:00Z',
    });
    expect(args.html).toContain('1 line is being picked and packed at DCIV');
    expect(args.html).toContain('is picking and packing your 1 line now.');
    expect(args.text).toContain('is picking and packing your 1 line now.');
  });

  it('cancelled: "The reserved unit went back to stock", never "All 1 reserved units"', async () => {
    wire([line(1)]);
    const args = await send('cancelled', { status: 'cancelled' as OrderRequestRow['status'] });
    expect(args.html).toContain('The reserved unit went back to stock;');
    expect(args.text).toContain('The reserved unit went back to stock;');
    expect(args.html).not.toContain('All 1 ');
  });

  it('two units on two lines still read in the plural, with every number', async () => {
    wire([line(1), line(2)], {
      data: [
        { item_id: 'it-1', quantity: 1 },
        { item_id: 'it-2', quantity: 1 },
      ],
      error: null,
    });
    const args = await send('approved');
    expect(args.html).toContain('Reserved 2 units across 2 lines. Ships');
    expect(args.text).toContain('Contents: 2 units across 2 lines');
  });

  it('31 lines: the table note says "+ 1 more line"', async () => {
    wire(Array.from({ length: 31 }, (_, i) => line(i + 1)));
    const args = await send('completed', { status: 'completed' as OrderRequestRow['status'] });
    expect(args.html).toContain('+ 1 more line — the full order is available online.');
    expect(args.html).not.toContain('+ 1 more lines');
  });
});

describe('partial delivery, backorder and receipt emails for one unit', () => {
  const urls = {
    manage: 'https://app.test/dashboard/settings/notifications',
    unsubscribe: 'https://app.test/dashboard/settings/notifications',
    support: 'https://app.test/support',
  };

  it('partial: "The remaining unit is backordered", "Delivered: 1 unit"', () => {
    for (const backorderEta of ['within 2 weeks', null]) {
      const r = renderPartialFulfilledEmail({
        orderNumber: '#0049',
        recipientFirstName: 'Jane',
        recipientEmail: EMAIL,
        delivered: 1,
        requested: 2,
        backordered: 1,
        deliveredOn: 'Apr 29',
        backorderEta,
        items: [{ name: 'Goggles', sku: 'SG-1', qtyRequested: 2, qtyFulfilled: 1 }],
        orderUrl: 'https://app.test/dashboard/orders/x',
        urls,
      });
      expectNoOnePlural(r);
      expect(r.html).toContain('The remaining unit is backordered');
      expect(r.text).toContain('The remaining unit is backordered');
      expect(r.text).toContain('Delivered: 1 unit (signed Apr 29)');
      expect(r.text).toMatch(/^Backordered: 1 unit\b/m);
      // The two stat cards' notes under the figure 1.
      expect(r.html).toContain('unit &middot; signed Apr 29');
      expect(r.html).not.toContain('units &middot; signed Apr 29');
    }
  });

  it('back-shipped: "The remaining unit left" and "The last unit is moving."', () => {
    const full = renderBackorderShippedEmail({
      orderNumber: '#0049',
      recipientEmail: EMAIL,
      unitsShipped: 1,
      warehouse: 'DCIV',
      shipDate: 'May 8',
      method: 'ground',
      trackUrl: 'https://app.test/t',
      urls,
    });
    expectNoOnePlural(full);
    expect(full.preheader).toBe('The remaining unit left DCIV May 8 via ground.');
    expect(full.html).toContain('The last unit is moving.');
    const short = renderBackorderShippedEmail({
      orderNumber: '#0049',
      recipientEmail: EMAIL,
      unitsShipped: 1,
      trackUrl: 'https://app.test/t',
      urls,
    });
    expect(short.preheader).toBe('The remaining unit is on the way.');
  });

  it('partial receipt: "Receipt for 1 unit" and "Still pending: 1 unit"', () => {
    for (const destination of ['CVW — Manchester', null]) {
      const r = renderPartialReceiptEmail({
        orderNumber: '#0049',
        signerName: 'M. Okafor',
        signedAt: 'Apr 29, 2:12 PM UTC',
        destination,
        unitsReceived: 1,
        unitsTotal: 2,
        unitsPending: 1,
        appUrl: 'https://app.test',
      });
      expectNoOnePlural(r);
      expect(r.preheader).toMatch(/^Receipt for 1 unit received and signed/);
      expect(r.text).toContain('Still pending: 1 unit');
      expect(r.html).toContain('1 unit');
    }
  });

  it('two or more units keep their numbers and the plural', () => {
    const shipped = renderBackorderShippedEmail({
      orderNumber: '#0049',
      recipientEmail: EMAIL,
      unitsShipped: 8,
      trackUrl: 'https://app.test/t',
      urls,
    });
    expect(shipped.preheader).toBe('The remaining 8 units are on the way.');
    expect(shipped.html).toContain('The last 8 units are moving.');
    const partial = renderPartialFulfilledEmail({
      orderNumber: '#0049',
      recipientEmail: EMAIL,
      delivered: 38,
      requested: 46,
      backordered: 8,
      orderUrl: 'https://app.test/dashboard/orders/x',
      urls,
    });
    expect(partial.text).toContain('The remaining 8 units are backordered');
    expect(partial.text).toContain('Delivered: 38 units');
  });

  it('an order of 31 lines: "+ 1 more line" under the item table and in the text', () => {
    const items = Array.from({ length: 31 }, (_, i) => ({
      name: `Item ${i + 1}`,
      sku: `SKU-${i + 1}`,
      qtyRequested: 2,
      qtyFulfilled: 1,
    }));
    const r = renderPartialFulfilledEmail({
      orderNumber: '#0049',
      recipientEmail: EMAIL,
      delivered: 31,
      requested: 62,
      backordered: 31,
      items,
      orderUrl: 'https://app.test/dashboard/orders/x',
      urls,
    });
    expect(r.html).toContain('+ 1 more line — the full order is available online.');
    expect(r.text).toContain('+ 1 more line');
    expect(r.text).not.toContain('+ 1 more lines');
  });
});
