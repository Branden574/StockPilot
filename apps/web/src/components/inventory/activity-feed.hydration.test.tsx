/**
 * An item's Movements and Activity tabs server-render the feed (item-detail
 * hands ItemActivityPanel its first page), and each row prints a relative
 * time. A minute between the server render and hydration changes the words
 * and React throws error #418; the <time> carries suppressHydrationWarning.
 *
 * Its own file, so small fixes slice 3 (which also edits activity-feed.test.tsx)
 * rebases without touching it.
 */
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

import type { ActivityEvent } from '@/server/services/activity';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/movements', () => ({
  editMovementNoteAction: vi.fn(async () => ({ ok: true as const, data: { note: null } })),
}));

import { ActivityFeed } from './activity-feed';

const T0 = Date.parse('2026-10-05T21:00:00.000Z');

const EVENT: ActivityEvent = {
  id: 'a1',
  kind: 'audit',
  type: 'inventory.item.updated',
  createdAt: new Date(T0 - 210_000).toISOString(),
  delta: null,
  previousQuantity: null,
  quantityAfter: null,
  movedQuantity: null,
  fromLocationId: null,
  toLocationId: null,
  referenceType: null,
  referenceId: null,
  referenceLabel: null,
  reason: null,
  notes: null,
  noteEditable: false,
  actor: 'Dana Lee',
  actorEmail: null,
  metadata: null,
};

describe('ActivityFeed hydrates across a clock tick', () => {
  it('the relative time rendered on the server and hydrated a minute later: no hydration error', async () => {
    const run = await hydrateAcrossClockShift(() => <ActivityFeed events={[EVENT]} />, {
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
});
