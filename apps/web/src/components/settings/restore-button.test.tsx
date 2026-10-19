/**
 * Settings > Recovery (CONFLICTS D13): a row's exact delete time (the tooltip
 * on "Deleted 3 days ago") was formatted by the server component, in the
 * server's zone (UTC on Vercel), so an evening delete in Los Angeles showed as
 * the next morning. DeletedAtTooltip adds it once hydrated, in the viewer's
 * zone, with no hydration error.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BROWSER_ZONE, hydrateAcrossClockShift, inZone } from '@/test/hydration';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/recovery', () => ({
  restoreDeletedAction: vi.fn(async () => ({ ok: true, data: null })),
}));

import { restoreDeletedAction } from '@/server/actions/recovery';

import { DeletedAtTooltip, formatDeletedAtExact, RestoreButton } from './restore-button';

// 7:30 PM on Oct 5 in Los Angeles; 02:30 on Oct 6 in UTC.
const DELETED_AT = '2026-10-06T02:30:00.000Z';
const T0 = Date.parse('2026-10-08T03:00:00.000Z');

describe('DeletedAtTooltip', () => {
  it("shows the viewer's exact time once hydrated, never the server's", async () => {
    const serverText = inZone('UTC', () => formatDeletedAtExact(DELETED_AT));
    const viewerText = inZone(BROWSER_ZONE, () => formatDeletedAtExact(DELETED_AT));
    expect(serverText).not.toBe(viewerText);
    const run = await hydrateAcrossClockShift(
      () => <DeletedAtTooltip iso={DELETED_AT}>Deleted 2 days ago</DeletedAtTooltip>,
      { serverNow: T0, browserNow: T0 + 60_000 },
    );
    try {
      expect(run.errors).toEqual([]);
      expect(run.html).not.toContain(serverText);
      const span = run.container.querySelector('span');
      expect(span?.textContent).toBe('Deleted 2 days ago');
      expect(span?.getAttribute('title')).toBe(viewerText);
    } finally {
      run.unmount();
    }
  });
});

describe('RestoreButton', () => {
  it('restores at once (no confirm, as today) and refreshes', async () => {
    render(<RestoreButton entity="categories" id="c1" label="Paper" />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(restoreDeletedAction).toHaveBeenCalledWith({ entity: 'categories', id: 'c1' });
  });
});
