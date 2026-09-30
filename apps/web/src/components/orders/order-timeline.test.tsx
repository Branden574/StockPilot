import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// F2-2: the order's timeline names a hold by what started it (an approver
// adding items or raising a line tops up the WHOLE order at once, so the label
// says what started it, never that only the new units were held; "Hold
// available stock" is the manual one) and says what was held in core's words.
// No costs, no raw metadata.

const auditRows = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    const chain = (data: unknown) => {
      const self: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'or', 'filter', 'order', 'in']) self[m] = () => self;
      self.then = (resolve: (v: unknown) => void) => resolve({ data, error: null });
      return self;
    };
    return {
      from: (table: string) =>
        table === 'audit_logs' ? chain(auditRows.current) : chain([{ id: 'u1', full_name: 'Dana Diaz', email: 'd@x.test' }]),
      auth: { getUser: async () => ({ data: { user: { email: 'd@x.test' } } }) },
    };
  }),
}));
vi.mock('@/lib/auth/platform-admin', () => ({ isPlatformAdmin: () => false }));
vi.mock('@/components/ui/local-datetime', () => ({ LocalDateTime: () => null }));

import { OrderTimeline } from './order-timeline';

function stockHeld(id: string, after: Record<string, unknown>) {
  return {
    id,
    event: 'order.stock_held',
    created_at: '2026-09-28T17:00:00Z',
    user_id: 'u1',
    metadata: { entity_type: 'order_request', entity_id: 'order-1', after },
  };
}

async function renderTimeline(rows: unknown[]) {
  auditRows.current = rows;
  render(await OrderTimeline({ orderId: 'order-1', organizationId: 'org-1' }));
}

describe('OrderTimeline — stock held (F2-2)', () => {
  it('names the hold by what started it, and says what was held and what is still short', async () => {
    await renderTimeline([
      stockHeld('a', {
        trigger: 'lines_added',
        held: [{ itemId: 'i1', added: 8 }],
        stillShort: [{ itemId: 'i2', quantity: 6 }],
        hiddenHeldItems: 0,
        hiddenShortItems: 0,
      }),
      stockHeld('b', { trigger: 'line_raised', held: [{ itemId: 'i1', added: 1 }], stillShort: [], hiddenHeldItems: 0, hiddenShortItems: 0 }),
      stockHeld('c', {
        trigger: 'manual',
        held: [{ itemId: 'i1', added: 2 }, { itemId: 'i2', added: 3 }],
        stillShort: [],
        hiddenHeldItems: 0,
        hiddenShortItems: 0,
      }),
    ]);

    // What started it, not a claim that only the added or raised units were
    // held: the top-up holds anything on the order not yet held.
    expect(screen.getByText('Stock held after items were added')).toBeInTheDocument();
    expect(
      screen.getByText('Held 8 more units for this order. 6 units are still short: there is no free stock to hold for them.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Stock held after a quantity was raised')).toBeInTheDocument();
    expect(screen.queryByText(/for added items|for a raised quantity/)).toBeNull();
    expect(screen.getByText('Held 1 more unit for this order.')).toBeInTheDocument();
    expect(screen.getByText('Stock held')).toBeInTheDocument();
    expect(screen.getByText('Held 5 more units for this order.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/cost|itemId|\{/i);
  });

  it("items the holder couldn't see are counted, never numbered", async () => {
    await renderTimeline([
      stockHeld('a', { trigger: 'manual', held: [], stillShort: [], hiddenHeldItems: 1, hiddenShortItems: 1 }),
    ]);
    expect(
      screen.getByText("Stock was held for 1 item that isn't visible to you. 1 item that isn't visible to you is still short."),
    ).toBeInTheDocument();
  });

  it('an entry it cannot read is described without numbers, never guessed', async () => {
    await renderTimeline([stockHeld('a', { trigger: 'surprise', held: 'nope' })]);

    expect(screen.getByText('Stock held')).toBeInTheDocument();
    expect(screen.getByText('Stock was held for this order.')).toBeInTheDocument();
  });
});

// F2-4: a needed-by change reads as core's label, both dates in the ORG's zone
// (the page's, never the server's UTC), and the reason the approver gave, as
// OrderRequestsService.reviseNeededBy writes it (metadata from, to, reason).
describe('OrderTimeline — needed-by date changed (F2-4)', () => {
  function revised(id: string, md: Record<string, unknown>) {
    return {
      id,
      event: 'order_request.needed_by_revised',
      created_at: '2026-09-29T17:00:00Z',
      user_id: 'u1',
      metadata: { entity_type: 'order_request', entity_id: 'order-1', ...md },
    };
  }

  async function renderIn(rows: unknown[], timeZone?: string) {
    auditRows.current = rows;
    render(await OrderTimeline({ orderId: 'order-1', organizationId: 'org-1', timeZone }));
  }

  it("says what changed, from and to, in the org's zone, with the reason", async () => {
    await renderIn(
      [
        revised('a', {
          from: '2026-10-01T21:00:00.000Z',
          to: '2026-10-03T21:00:00.000Z',
          reason: 'The school pushed the event back',
          schedule: 'moved',
          event_id: 'ev-1',
        }),
      ],
      'America/New_York',
    );

    expect(screen.getByText('Needed-by date changed')).toBeInTheDocument();
    // 21:00Z is 5:00 PM in New York (the zone passed), not 9:00 PM UTC.
    expect(screen.getByText('Thu, Oct 1, 5:00 PM → Sat, Oct 3, 5:00 PM')).toBeInTheDocument();
    expect(screen.getByText('Reason: The school pushed the event back')).toBeInTheDocument();
    // Internal ids and the Schedule outcome's code are not shown.
    expect(document.body.textContent).not.toMatch(/ev-1|moved\b|\{/);
  });

  it('an order that had no date: "Set to"; with no zone, core\'s default', async () => {
    await renderIn([revised('a', { from: null, to: '2026-10-03T21:00:00.000Z', reason: 'First date' })]);
    expect(screen.getByText('Set to Sat, Oct 3, 2:00 PM')).toBeInTheDocument();
  });

  it('an entry it cannot read says only the label and the reason, never a guessed date', async () => {
    await renderIn([revised('a', { from: 'soon', to: 42, reason: 'Moved' })], 'America/Los_Angeles');
    expect(screen.getByText('Needed-by date changed')).toBeInTheDocument();
    expect(screen.getByText('Reason: Moved')).toBeInTheDocument();
    expect(screen.queryByText(/→|Set to/)).toBeNull();
  });
});

// F2-5: draft POs made for what the order was short read as core's label and
// say which drafts, for how many items and units, as
// OrderReadinessService.draftShortfallPos writes the entry (purchase_order_ids,
// po_numbers, lines {item_id, quantity, purchase_order_id}; never a cost).
describe('OrderTimeline — draft PO created for the shortfall (F2-5)', () => {
  function drafted(id: string, md: Record<string, unknown>) {
    return {
      id,
      event: 'order_request.shortfall_po_drafted',
      created_at: '2026-09-30T17:00:00Z',
      user_id: 'u1',
      metadata: { entity_type: 'order_request', entity_id: 'order-1', ...md },
    };
  }

  it("names the drafts, how many items and units, and that drafts are not sent", async () => {
    await renderTimeline([
      drafted('a', {
        purchase_order_ids: ['po-1', 'po-2'],
        po_numbers: ['PO-2026-0050', 'PO-2026-0051'],
        lines: [
          { item_id: 'i1', quantity: 8, purchase_order_id: 'po-1' },
          { item_id: 'i2', quantity: 2.5, purchase_order_id: 'po-1' },
          { item_id: 'i3', quantity: 5, purchase_order_id: 'po-2' },
        ],
      }),
      drafted('b', {
        purchase_order_ids: ['po-3'],
        po_numbers: ['PO-2026-0052'],
        lines: [{ item_id: 'i4', quantity: 1, purchase_order_id: 'po-3' }],
      }),
    ]);

    expect(screen.getAllByText('Draft PO created for the shortfall')).toHaveLength(2);
    expect(
      screen.getByText('2 draft POs for 3 items, 15.5 units: PO-2026-0050, PO-2026-0051. Drafts are not sent.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Draft PO-2026-0052 for 1 item, 1 unit. Drafts are not sent.')).toBeInTheDocument();
    // No ids, costs or raw metadata.
    expect(document.body.textContent).not.toMatch(/po-1|i1\b|cost|\{/i);
  });

  it('an entry it cannot read says only the label, never a guessed number', async () => {
    await renderTimeline([drafted('a', { po_numbers: 'PO-1', lines: [{ item_id: 'i1', quantity: 'many' }] })]);
    expect(screen.getByText('Draft PO created for the shortfall')).toBeInTheDocument();
    expect(screen.queryByText(/Drafts are not sent/)).toBeNull();
  });
});
