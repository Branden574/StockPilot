/**
 * Regression guard for SP-049: the realtime channel must survive re-renders.
 *
 * `tables` used to be an inline default parameter (`tables = [...]`), which
 * evaluates to a BRAND NEW array on every call, and it sat in the effect's
 * dependency list. The component re-renders on every client navigation
 * (usePathname) and on every RSC refresh — including the ones it triggers
 * itself — so the effect tore down (removeChannel + auth-listener
 * unsubscribe + clearTimeout of the pending throttled refresh) and re-joined
 * the org channel on each one. Two visible costs: a blind window while the
 * new channel re-authed and re-joined, and a DROPPED trailing refresh, which
 * left the page showing stale stock until some unrelated event arrived.
 */
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  // The realtime nudge. Resolves true = "invalidated", which in a real
  // Server Action means Next re-renders the page into the action's response.
  revalidate: vi.fn(async (): Promise<boolean> => true),
  visibility: { value: 'visible' as DocumentVisibilityState },
  pathname: { value: '/dashboard/inventory' },
  channel: vi.fn(),
  removeChannel: vi.fn(),
  handlers: [] as Array<() => void>,
  subscribe: vi.fn(),
  authUnsub: vi.fn(),
}));

vi.mock('next/navigation', () => {
  const router = { refresh: h.refresh, push: vi.fn(), replace: vi.fn() };
  return {
    useRouter: () => router,
    usePathname: () => h.pathname.value,
  };
});

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: (...args: unknown[]) => {
      h.channel(...args);
      const ch: Record<string, unknown> = {
        on: (_evt: string, _cfg: unknown, cb: () => void) => {
          h.handlers.push(cb);
          return ch;
        },
        subscribe: h.subscribe,
      };
      return ch;
    },
    removeChannel: h.removeChannel,
  }),
}));

vi.mock('@/lib/supabase/realtime-auth', () => ({
  ensureRealtimeAuth: vi.fn(async () => h.authUnsub),
}));

vi.mock('@/server/actions/revalidate-inventory-view', () => ({
  revalidateInventoryViewAction: () => h.revalidate(),
}));

import { InventoryRealtime } from './inventory-realtime';

Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  get: () => h.visibility.value,
});

function setVisibility(value: DocumentVisibilityState) {
  h.visibility.value = value;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  h.refresh.mockClear();
  h.revalidate.mockReset();
  h.revalidate.mockImplementation(async () => true);
  h.visibility.value = 'visible';
  h.channel.mockClear();
  h.removeChannel.mockClear();
  h.subscribe.mockClear();
  h.authUnsub.mockClear();
  h.handlers.length = 0;
  h.pathname.value = '/dashboard/inventory';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('InventoryRealtime', () => {
  it('does not tear down and re-join the channel when the parent re-renders with the same props', async () => {
    const { rerender } = render(<InventoryRealtime organizationId="org-1" />);
    await waitFor(() => expect(h.channel).toHaveBeenCalledTimes(1));

    // Simulates the RSC refresh / client navigation re-render of
    // (dashboard)/layout.tsx, which re-emits <InventoryRealtime> with
    // identical props.
    rerender(<InventoryRealtime organizationId="org-1" />);
    rerender(<InventoryRealtime organizationId="org-1" />);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.removeChannel).not.toHaveBeenCalled();
    expect(h.authUnsub).not.toHaveBeenCalled();
    expect(h.channel).toHaveBeenCalledTimes(1);
    expect(h.subscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps the trailing throttled refresh scheduled across a re-render', async () => {
    const { rerender } = render(<InventoryRealtime organizationId="org-1" />);
    await waitFor(() => expect(h.handlers.length).toBeGreaterThan(0));

    vi.useFakeTimers();
    const nudge = h.handlers[h.handlers.length - 1]!;
    nudge(); // leading edge -> immediate refresh
    nudge(); // inside the 250ms window -> schedules the trailing refresh
    await vi.advanceTimersByTimeAsync(0);
    expect(h.revalidate).toHaveBeenCalledTimes(1);

    // The RSC response for the leading refresh lands and re-renders the
    // layout. That must NOT cancel the pending trailing refresh.
    rerender(<InventoryRealtime organizationId="org-1" />);
    await vi.advanceTimersByTimeAsync(300);

    expect(h.revalidate).toHaveBeenCalledTimes(2);
    // Both refreshes were the action's own re-render; no second render.
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('still re-subscribes when the watched table set actually changes', async () => {
    const { rerender } = render(
      <InventoryRealtime organizationId="org-1" tables={['inventory_items']} />,
    );
    await waitFor(() => expect(h.channel).toHaveBeenCalledTimes(1));

    // A DIFFERENT list, passed inline: the join key changes, so the effect
    // must re-run. (Same list passed inline must not — asserted below.)
    rerender(<InventoryRealtime organizationId="org-1" tables={['stock_movements']} />);
    await waitFor(() => expect(h.channel).toHaveBeenCalledTimes(2));

    rerender(<InventoryRealtime organizationId="org-1" tables={['stock_movements']} />);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.channel).toHaveBeenCalledTimes(2);
  });

  it('subscribes to every default table exactly once', async () => {
    render(<InventoryRealtime organizationId="org-1" />);
    await waitFor(() => expect(h.handlers.length).toBe(5));
    expect(h.channel).toHaveBeenCalledWith('org:org-1:inventory');
  });
});

/**
 * One render per refresh (2026-09-22). revalidateInventoryViewAction calls
 * revalidateTag(tag, { expire: 0 }); in next 16.3.5 that marks the path
 * revalidated, so the action handler renders the current page INTO the
 * action's response and the client router applies it as a RefreshAll
 * navigation. The old code then called router.refresh() on top, rendering the
 * whole page twice per event: one rpc/adjust_stock by another user caused 5
 * full re-renders of the owner's Inventory tab in ~1.3 s, each wiping the
 * client router cache (slow Back).
 */
describe('InventoryRealtime refreshes', () => {
  async function mountAndGetNudge() {
    render(<InventoryRealtime organizationId="org-1" />);
    await waitFor(() => expect(h.handlers.length).toBe(5));
    return h.handlers[0]!;
  }

  it('success: the action IS the refresh, so router.refresh() is never called on top of it', async () => {
    const nudge = await mountAndGetNudge();

    nudge();
    // Leading edge: the action starts synchronously, not after the throttle.
    expect(h.revalidate).toHaveBeenCalledTimes(1);
    await act(async () => {});

    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('failure: a rejected action (network, a tab one deployment behind) falls back to router.refresh()', async () => {
    h.revalidate.mockImplementation(async () => {
      throw new Error('Failed to find Server Action');
    });
    const nudge = await mountAndGetNudge();

    nudge();
    await act(async () => {});

    expect(h.revalidate).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('an action that resolved WITHOUT invalidating (no org context) also falls back to router.refresh()', async () => {
    // No invalidation means Next rendered nothing into the response, so
    // without this the page would keep showing the old stock.
    h.revalidate.mockImplementation(async () => false);
    const nudge = await mountAndGetNudge();

    nudge();
    await act(async () => {});

    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('hidden tab: 0 refreshes while hidden, then exactly 1 when it becomes visible', async () => {
    const nudge = await mountAndGetNudge();
    vi.useFakeTimers();

    setVisibility('hidden');
    nudge();
    nudge();
    await vi.advanceTimersByTimeAsync(1000);
    nudge();
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.revalidate).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.revalidate).toHaveBeenCalledTimes(1);
    expect(h.refresh).not.toHaveBeenCalled();

    // Nothing changed since: hiding and showing again costs nothing.
    setVisibility('hidden');
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.revalidate).toHaveBeenCalledTimes(1);
  });

  it('hidden tab whose returning refresh fails still refreshes exactly once, via router.refresh()', async () => {
    h.revalidate.mockImplementation(async () => {
      throw new Error('offline');
    });
    const nudge = await mountAndGetNudge();

    setVisibility('hidden');
    nudge();
    await act(async () => {});
    expect(h.refresh).not.toHaveBeenCalled();

    setVisibility('visible');
    await act(async () => {});
    expect(h.revalidate).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('a trailing refresh that comes due while the tab is hidden waits for it to be visible', async () => {
    const nudge = await mountAndGetNudge();
    vi.useFakeTimers();

    nudge(); // leading edge, visible
    nudge(); // schedules the trailing refresh
    await vi.advanceTimersByTimeAsync(0);
    expect(h.revalidate).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(300);
    expect(h.revalidate).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.revalidate).toHaveBeenCalledTimes(2);
  });

  it('one refresh at a time: a burst during a slow (stalled) refresh earns exactly ONE more, after it', async () => {
    let finish!: (v: boolean) => void;
    h.revalidate.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const nudge = await mountAndGetNudge();
    vi.useFakeTimers();

    nudge(); // leading edge: starts the slow refresh
    for (let i = 0; i < 20; i++) {
      nudge();
      await vi.advanceTimersByTimeAsync(200); // 4 s of events during the stall
    }
    expect(h.revalidate).toHaveBeenCalledTimes(1);

    finish(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.revalidate).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2000);
    expect(h.revalidate).toHaveBeenCalledTimes(2);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('a refresh that never settles does not stop live updates: after 15 s the lock is released', async () => {
    // A navigation discards the pending router action but not our promise, and
    // a fetch can hang (half-open connection after a laptop wakes). The old
    // one-action-per-event code recovered from that by itself; the lock must too.
    h.revalidate.mockImplementationOnce(() => new Promise<boolean>(() => {}));
    const nudge = await mountAndGetNudge();
    vi.useFakeTimers();

    nudge(); // starts the refresh that will never settle
    await vi.advanceTimersByTimeAsync(5_000);
    nudge(); // during the stall: only remembered
    expect(h.revalidate).toHaveBeenCalledTimes(1);
    expect(h.refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000); // watchdog: 15 s after the start
    // No render is coming from the stalled action, so we refresh ourselves,
    // and the event remembered during the stall is honoured.
    expect(h.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.revalidate).toHaveBeenCalledTimes(2);

    // Live updates still work afterwards.
    await vi.advanceTimersByTimeAsync(1_000);
    nudge();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.revalidate).toHaveBeenCalledTimes(3);
  });

  it('a late answer from an abandoned refresh changes nothing', async () => {
    let finishLate!: (v: boolean) => void;
    h.revalidate.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishLate = resolve;
        }),
    );
    let finishSecond!: (v: boolean) => void;
    h.revalidate.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishSecond = resolve;
        }),
    );
    const nudge = await mountAndGetNudge();
    vi.useFakeTimers();

    nudge();
    await vi.advanceTimersByTimeAsync(15_000); // abandoned; router.refresh fallback
    expect(h.refresh).toHaveBeenCalledTimes(1);
    nudge(); // second refresh starts and holds the lock
    await vi.advanceTimersByTimeAsync(300);
    expect(h.revalidate).toHaveBeenCalledTimes(2);

    finishLate(true); // the abandoned one answers now: must not release the lock
    await vi.advanceTimersByTimeAsync(0);
    nudge();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.revalidate).toHaveBeenCalledTimes(2); // still one at a time

    finishSecond(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.revalidate).toHaveBeenCalledTimes(3); // the remembered event runs
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('stops listening for visibility once unmounted', async () => {
    const { unmount } = render(<InventoryRealtime organizationId="org-1" />);
    await waitFor(() => expect(h.handlers.length).toBe(5));
    const nudge = h.handlers[0]!;

    setVisibility('hidden');
    nudge();
    unmount();
    setVisibility('visible');
    await act(async () => {});

    expect(h.revalidate).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
