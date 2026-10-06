/**
 * The template list prints "next in 4 minutes" and "last ran 3 minutes ago"
 * on the server, and the browser hydrates it a minute later, when the same
 * code says "in 3 minutes" and "4 minutes ago". Without suppressHydrationWarning
 * on the element holding them, React throws error #418 and discards the
 * server HTML (production 2026-10-05, the same class on /dashboard/movements).
 *
 * Its own file: recurring-templates-panel.test.tsx mocks formatRelative to a
 * constant, which would hide the drift.
 */
import { within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

vi.mock('@/server/actions/recurring-pos', () => ({
  setRecurringTemplateEnabledAction: vi.fn(),
  createRecurringTemplateAction: vi.fn(),
  updateRecurringTemplateAction: vi.fn(),
  deleteRecurringTemplateAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { RecurringTemplatesPanel, type RecurringTemplateRow } from './recurring-templates-panel';

const T0 = Date.parse('2026-10-05T21:00:00.000Z');

const TEMPLATE: RecurringTemplateRow = {
  id: 'tpl-1',
  name: 'Weekly Supplies',
  supplier_id: null,
  destination_location_id: null,
  enabled: true,
  cadence: 'weekly',
  custom_days: null,
  send_mode: 'draft',
  max_auto_send_cents: null,
  line_items: [{ itemId: 'item-1', quantityOrdered: 2, unitCost: 10 }],
  notes: null,
  last_run_at: new Date(T0 - 210_000).toISOString(),
  next_run_at: new Date(T0 + 210_000).toISOString(),
};

describe('RecurringTemplatesPanel hydrates across a clock tick', () => {
  it('"next" and "last ran" rendered on the server and hydrated a minute later: no hydration error', async () => {
    const run = await hydrateAcrossClockShift(
      () => (
        <RecurringTemplatesPanel
          initial={[TEMPLATE]}
          items={[]}
          suppliers={[]}
          locations={[]}
          entitled
        />
      ),
      { serverNow: T0, browserNow: T0 + 60_000 },
    );
    try {
      expect(run.html).toContain('in 4 minutes');
      expect(run.html).toContain('last ran 3 minutes ago');
      expect(run.errors).toEqual([]);
      expect(within(run.container).getByText('Weekly Supplies')).toBeInTheDocument();
    } finally {
      run.unmount();
    }
  });
});
