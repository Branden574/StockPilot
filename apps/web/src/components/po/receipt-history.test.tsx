/**
 * A purchase order's page server-renders its receipt history, and each
 * receipt prints a relative time beside the viewer's exact time. A minute
 * between the server render and hydration changes the relative words and
 * React throws error #418; the <time> carries suppressHydrationWarning. The
 * exact time is LocalDateTime, rendered only in the browser, so the server's
 * zone never reaches the screen.
 */
import { within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift, inZone, BROWSER_ZONE } from '@/test/hydration';

import type { ReceiptLineRow, ReceiptRow } from '@/server/services/receiving';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/receiving', () => ({ reverseReceiptAction: vi.fn() }));

import { ReceiptHistory } from './receipt-history';

const T0 = Date.parse('2026-10-05T21:00:00.000Z');
const RECEIVED_AT = new Date(T0 - 210_000).toISOString();

const RECEIPT: ReceiptRow = {
  id: 'rcpt-1',
  organization_id: 'org-1',
  purchase_order_id: 'po-1',
  warehouse_id: 'wh-1',
  receipt_number: 'RCV-000123',
  status: 'posted',
  reversed_receipt_id: null,
  reversal_reason: null,
  notes: null,
  received_by: 'u-1',
  received_at: RECEIVED_AT,
  received_by_name: 'Dana Lee',
  idempotency_key: null,
  created_at: RECEIVED_AT,
  updated_at: RECEIVED_AT,
};

const LINE: ReceiptLineRow = {
  id: 'rl-1',
  receipt_id: 'rcpt-1',
  purchase_order_line_id: 'pol-1',
  item_id: 'item-1',
  qty_received_base: 4,
  qty_accepted_base: 4,
  qty_rejected_base: 0,
  base_uom: 'each',
  unit_cost: 2,
  notes: null,
  created_at: RECEIVED_AT,
};

describe('ReceiptHistory hydrates across a clock tick', () => {
  it('the relative time rendered on the server and hydrated a minute later: no hydration error', async () => {
    const run = await hydrateAcrossClockShift(
      () => (
        <ReceiptHistory
          receipts={[RECEIPT]}
          lines={[LINE]}
          items={{ 'item-1': { name: 'Laptop stand', sku: 'LS-1' } }}
          canReverse={false}
        />
      ),
      { serverNow: T0, browserNow: T0 + 60_000 },
    );
    try {
      expect(run.html).toContain('3 minutes ago');
      expect(run.errors).toEqual([]);
      // The exact time is the viewer's, printed after hydration.
      const exact = inZone(BROWSER_ZONE, () =>
        new Date(RECEIVED_AT).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }),
      );
      expect(within(run.container).getByText(exact, { exact: false })).toBeInTheDocument();
    } finally {
      run.unmount();
    }
  });
});
