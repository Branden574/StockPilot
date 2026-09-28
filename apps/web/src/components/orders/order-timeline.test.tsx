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
