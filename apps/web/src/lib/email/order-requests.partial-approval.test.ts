import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import type { OrderRequestRow } from '@/server/services/order-requests';

/**
 * L86 (migration 0396): approve_partial holds only what is free, but the
 * approved email said "we’ve reserved every unit on this request" either way.
 * It now reads the order's active holds and says every unit only when every
 * unit is held, "N of M units ... the rest is waiting for stock" when only part
 * is, "Nothing is reserved yet; your order is waiting for stock." when nothing
 * is (approve_partial approves even then), and neither when the holds could
 * not be read. The requester's in-app notification and push make the same
 * distinction in the database (_notify_order_request_changes, 0396 suite
 * A1-A5).
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
const sendEmailMock = vi.fn(async (_args: SendEmailArgs) => ({ ok: true }));
vi.mock('./resend', () => ({ sendEmail: (args: SendEmailArgs) => sendEmailMock(args) }));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

import { heldState, heldSummary, sendOrderRequestEmail, type OrderRequestEmailKind } from './order-requests';

const EMAIL = 'requester@school.edu';

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

// Two lines: 6 gloves (item A) and 2 goggles (item B), nothing fulfilled yet.
const LINES = [
  {
    item_id: 'it-a',
    quantity_picked: null,
    quantity_requested: 6,
    quantity_fulfilled: 0,
    item: { name: 'Blue Nitrile Gloves — Large', sku: 'GLV-BL-L' },
  },
  {
    item_id: 'it-b',
    quantity_picked: null,
    quantity_requested: 2,
    quantity_fulfilled: 0,
    item: { name: 'Safety Goggles', sku: 'SG-01' },
  },
];

function wire(holds: { data: unknown; error: { message: string } | null }): SupabaseStub {
  const stub = makeSupabaseStub({
    'order_request_lines.select': { data: LINES, error: null },
    'stock_reservations.select': holds as never,
    'warehouses.select.maybeSingle': {
      data: { name: 'Fresno DC', code: 'DCIV', address: { city: 'Fresno' } },
      error: null,
    },
    'user_profiles.select.maybeSingle': { data: { full_name: 'Morgan Diaz', email: 'morgan@l4l.org' }, error: null },
  });
  adminHolder.client = stub.client;
  return stub;
}

async function send(kind: OrderRequestEmailKind = 'approved'): Promise<SendEmailArgs> {
  await sendOrderRequestEmail({
    kind,
    request: makeRow(kind === 'in_transit' ? { status: 'in_transit' } : {}),
    recipientEmail: EMAIL,
    recipientName: 'Jane Teacher',
    appUrl: 'https://app.test',
  });
  expect(sendEmailMock).toHaveBeenCalled();
  return sendEmailMock.mock.calls.at(-1)![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  adminHolder.client = null;
});

describe('heldSummary', () => {
  it('compares what each item still owes with its active holds', () => {
    expect(heldSummary(LINES, [{ item_id: 'it-a', quantity: 6 }, { item_id: 'it-b', quantity: 2 }])).toEqual({
      owedUnits: 8,
      heldUnits: 8,
      partly: false,
    });
    expect(heldSummary(LINES, [{ item_id: 'it-a', quantity: 4 }, { item_id: 'it-b', quantity: 2 }])).toEqual({
      owedUnits: 8,
      heldUnits: 6,
      partly: true,
    });
  });

  it('adds two lines of one item and their holds before comparing (per item, not per line)', () => {
    const two = [
      { item_id: 'it-p', quantity_requested: 6, quantity_fulfilled: 0 },
      { item_id: 'it-p', quantity_requested: 6, quantity_fulfilled: 0 },
    ];
    expect(heldSummary(two, [{ item_id: 'it-p', quantity: 6 }, { item_id: 'it-p', quantity: 4 }])).toEqual({
      owedUnits: 12,
      heldUnits: 10,
      partly: true,
    });
    expect(heldSummary(two, [{ item_id: 'it-p', quantity: 6 }, { item_id: 'it-p', quantity: 6 }]).partly).toBe(false);
  });

  it('names the four states the approved email tells apart', () => {
    expect(heldState(null)).toBe('unknown');
    expect(heldState(heldSummary(LINES, [{ item_id: 'it-a', quantity: 6 }, { item_id: 'it-b', quantity: 2 }]))).toBe('all');
    expect(heldState(heldSummary(LINES, [{ item_id: 'it-a', quantity: 4 }, { item_id: 'it-b', quantity: 2 }]))).toBe('part');
    expect(heldState(heldSummary(LINES, []))).toBe('none');
    // A hold of 0 units holds nothing.
    expect(heldState(heldSummary(LINES, [{ item_id: 'it-a', quantity: 0 }]))).toBe('none');
  });

  it('owes nothing for what was already fulfilled, and never counts more held than owed', () => {
    expect(
      heldSummary(
        [{ item_id: 'it-a', quantity_requested: 6, quantity_fulfilled: 4 }],
        [{ item_id: 'it-a', quantity: 5 }],
      ),
    ).toEqual({ owedUnits: 2, heldUnits: 2, partly: false });
  });
});

describe('the approved email says what is held (L86)', () => {
  it('every unit held: "we’ve reserved every unit", the grid and preheader count every unit', async () => {
    wire({ data: [{ item_id: 'it-a', quantity: 6 }, { item_id: 'it-b', quantity: 2 }], error: null });
    const args = await send();
    expect(args.html).toContain('we’ve reserved every unit on this request.');
    expect(args.html).toContain('Reserved 8 units across 2 lines.');
    expect(args.html).toContain('your order is reserved and moving to packing');
    expect(args.html).not.toContain('the rest is waiting for stock');
    expect(args.text).toContain('we’ve reserved every unit on this request.');
    expect(args.text).not.toContain('Reserved: ');
  });

  it('part held: "6 of 8 units ... the rest is waiting for stock", in the HTML, the text and the preheader', async () => {
    wire({ data: [{ item_id: 'it-a', quantity: 4 }, { item_id: 'it-b', quantity: 2 }], error: null });
    const args = await send();
    expect(args.html).toContain('we’ve reserved 6 of 8 units on this request; the rest is waiting for stock.');
    expect(args.html).toContain('6 of 8 units');
    expect(args.html).toContain('Reserved 6 units across 2 lines.');
    expect(args.html).toContain('part of your order is reserved and moving to packing');
    expect(args.html).not.toContain('every unit');
    expect(args.text).toContain('we’ve reserved 6 of 8 units on this request; the rest is waiting for stock.');
    expect(args.text).toContain('Reserved: 6 of 8 units');
  });

  it('nothing held: says nothing is reserved yet and the order is waiting for stock, never "0 of 8" or "packing has started"', async () => {
    // approve_partial approves even when nothing is free (production has one
    // such order): every count would read 0, and packing has nothing to pack.
    wire({ data: [], error: null });
    const args = await send();
    expect(args.subject).toMatch(/ is approved — waiting for stock$/);
    expect(args.html).toContain('your request is approved. Nothing is reserved yet; your order is waiting for stock.');
    expect(args.html).toContain('Approved. Nothing is reserved yet; your order is waiting for stock.');
    expect(args.html).toContain('It is waiting for stock.');
    expect(args.html).toContain('your order is approved and waiting for stock');
    expect(args.html).toContain('8 units');
    expect(args.html).not.toMatch(/reserved 0|Reserved 0|0 of 8|every unit|part of your order|Packing starts now|packing has started/i);
    expect(args.text).toContain('your request is approved. Nothing is reserved yet; your order is waiting for stock.');
    expect(args.text).toContain('Reserved: nothing yet (waiting for stock)');
    expect(args.text).not.toMatch(/0 of 8|Reserved 0|every unit|packing has started/i);
  });

  it('holds not readable: claims neither every unit nor part', async () => {
    wire({ data: null, error: { message: 'canceling statement due to statement timeout' } });
    const args = await send();
    expect(args.html).toContain('your request is approved. You’ll get another note the moment it leaves the dock.');
    expect(args.html).not.toContain('every unit');
    expect(args.html).not.toContain('the rest is waiting for stock');
    expect(args.text).toContain('your request is approved.');
  });

  it('reads the holds for the approved email only', async () => {
    const stub = wire({ data: [], error: null });
    await send('in_transit');
    expect(stub.fromCalls).not.toContain('stock_reservations');
    vi.clearAllMocks();
    const stub2 = wire({ data: [], error: null });
    await send('approved');
    expect(stub2.fromCalls).toContain('stock_reservations');
    expect(stub2.chainArgs.get('stock_reservations.select')).toEqual([
      ['item_id, quantity'],
      ['order_request_id', '99999999-8888-7777-6666-555555555555'],
      ['released_at', null],
    ]);
  });
});
