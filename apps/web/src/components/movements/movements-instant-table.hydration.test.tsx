/**
 * Production 2026-10-05 (PR #326 check): /dashboard/movements raised React
 * error #418 with the browser clock an hour behind the server. Each row
 * prints a relative time ("3 minutes ago") on the server, and the browser
 * prints another one when it hydrates. The element holding it carries
 * suppressHydrationWarning, as the other tables with relative times do.
 *
 * Its own file, and the props are cast, so small fixes slice 3 (which adds a
 * timeZone prop and a server-formatted time to this table) rebases without
 * touching it.
 */
import type * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { MovementsInstantTable, type MovementDisplayRow } from './movements-instant-table';

const T0 = Date.parse('2026-10-05T21:00:00.000Z');

const ROWS = [
  {
    id: 'm-1',
    itemName: 'Walk Exchange Tee M',
    itemSku: 'TEE-M',
    movementType: 'receive',
    quantityChange: 1,
    movedQuantity: 1,
    newQuantity: 10,
    createdAt: new Date(T0 - 210_000).toISOString(),
    actorLabel: 'StockPilot Demo',
    actorEmail: null,
    note: null,
    noteEditable: false,
    reason: null,
    reasonHref: null,
  },
] as unknown as MovementDisplayRow[];

describe('MovementsInstantTable hydrates across a clock tick', () => {
  it('the relative time rendered on the server and hydrated a minute later: no hydration error', async () => {
    const props = { rows: ROWS } as React.ComponentProps<typeof MovementsInstantTable>;
    const run = await hydrateAcrossClockShift(() => <MovementsInstantTable {...props} />, {
      serverNow: T0,
      browserNow: T0 + 60_000,
    });
    try {
      expect(run.html).toContain('3 minutes ago');
      expect(run.errors).toEqual([]);
    } finally {
      run.unmount();
    }
  });

  it('a browser clock an hour behind the server (the production repro): no hydration error', async () => {
    const props = { rows: ROWS } as React.ComponentProps<typeof MovementsInstantTable>;
    const run = await hydrateAcrossClockShift(() => <MovementsInstantTable {...props} />, {
      serverNow: T0,
      browserNow: T0 - 3_600_000,
    });
    try {
      expect(run.errors).toEqual([]);
    } finally {
      run.unmount();
    }
  });
});
