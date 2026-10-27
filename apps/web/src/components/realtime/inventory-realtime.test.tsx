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
  handlers: [] as Array<(payload?: unknown) => void>,
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
        on: (_evt: string, _cfg: unknown, cb: (payload?: unknown) => void) => {
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

import {
  markOwnVisibilityWrite,
  resetOrderingTabSignalForTests,
  setOrderingTabWarehouse,
} from '@/lib/orders/ordering-tab-signal';

import {
  InventoryRealtime,
  isVisibilityOnlyEvent,
  visibilityEventRule,
} from './inventory-realtime';

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
  resetOrderingTabSignalForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it('one transaction, two events (item UPDATE + movement INSERT, same commit): ONE refresh', async () => {
    const nudge = await mountAndGetNudge();
    const onMovement = h.handlers[1]!;
    vi.useFakeTimers();

    // adjust_stock: both events carry the transaction's commit_timestamp and
    // arrive together (lab check 2026-09-22).
    nudge({ commit_timestamp: '2026-09-22T23:28:42.875Z' });
    onMovement({ commit_timestamp: '2026-09-22T23:28:42.875Z' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(h.revalidate).toHaveBeenCalledTimes(1);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('a NEW transaction that lands while a refresh runs still earns its one rerun', async () => {
    let finish!: (v: boolean) => void;
    h.revalidate.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const nudge = await mountAndGetNudge();
    const onMovement = h.handlers[1]!;
    vi.useFakeTimers();

    nudge({ commit_timestamp: 't1' });
    onMovement({ commit_timestamp: 't1' });
    // t2 committed after the running refresh started: it may not have read it.
    nudge({ commit_timestamp: 't2' });
    onMovement({ commit_timestamp: 't2' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.revalidate).toHaveBeenCalledTimes(1);

    finish(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.revalidate).toHaveBeenCalledTimes(2);

    // Late echoes of either transaction add nothing.
    nudge({ commit_timestamp: 't1' });
    onMovement({ commit_timestamp: 't2' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.revalidate).toHaveBeenCalledTimes(2);
  });

  it('an event without a commit timestamp is never dropped', async () => {
    const nudge = await mountAndGetNudge();
    vi.useFakeTimers();

    nudge({ commit_timestamp: 't1' });
    await vi.advanceTimersByTimeAsync(1000);
    nudge({});
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.revalidate).toHaveBeenCalledTimes(2);
  });

  it('a hidden tab that saw one transaction refreshes once on return, and its late echo adds nothing', async () => {
    const nudge = await mountAndGetNudge();
    const onMovement = h.handlers[1]!;
    vi.useFakeTimers();

    setVisibility('hidden');
    nudge({ commit_timestamp: 't1' });
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.revalidate).toHaveBeenCalledTimes(1);

    onMovement({ commit_timestamp: 't1' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.revalidate).toHaveBeenCalledTimes(1);
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

/**
 * ORDERING VISIBILITY (0413; design 7.2 item 8): Show or Hide writes only
 * order_catalog_visible and its stamp and keeps updated_at, so every open
 * Items, Books and Orders tab would otherwise get an UPDATE event per toggled
 * row and call revalidateInventoryViewAction, which expires the org's Items
 * list cache and re-renders the page, for a change none of them shows. A
 * visibility-only event (the stamp later than updated_at) is dropped outside
 * Place an Order and Manage order items; on those two it is router.refresh()
 * (the writer already expired the catalog), never the list-busting action.
 */
const HIDE = (over: Record<string, unknown> = {}) => ({
  schema: 'public',
  table: 'inventory_items',
  eventType: 'UPDATE',
  commit_timestamp: '2026-10-26T15:00:05.200Z',
  new: {
    id: 'i-1',
    order_catalog_visible: false,
    updated_at: '2026-10-26T14:00:00.000000+00:00',
    order_catalog_visibility_changed_at: '2026-10-26T15:00:05.123456+00:00',
  },
  ...over,
});

describe('isVisibilityOnlyEvent', () => {
  it('true when the last write to the row was the visibility write (stamp later than updated_at)', () => {
    expect(isVisibilityOnlyEvent(HIDE())).toBe(true);
  });

  it('reads the database text form too (space separator, short offset, any fraction)', () => {
    expect(
      isVisibilityOnlyEvent(
        HIDE({
          new: {
            updated_at: '2026-10-26 14:00:00+00',
            order_catalog_visibility_changed_at: '2026-10-26 15:00:05.1+00',
          },
        }),
      ),
    ).toBe(true);
    expect(
      isVisibilityOnlyEvent(
        HIDE({
          new: {
            updated_at: '2026-10-26T07:00:00-07:00',
            order_catalog_visibility_changed_at: '2026-10-26T14:00:00.001Z',
          },
        }),
      ),
    ).toBe(true);
  });

  it('false for an ordinary write after a hide (updated_at moved past the stamp)', () => {
    expect(
      isVisibilityOnlyEvent(
        HIDE({
          new: {
            updated_at: '2026-10-26T15:10:00.000000+00:00',
            order_catalog_visibility_changed_at: '2026-10-26T15:00:05.123456+00:00',
          },
        }),
      ),
    ).toBe(false);
  });

  it('a tie at millisecond precision counts as ordinary (the safe direction)', () => {
    expect(
      isVisibilityOnlyEvent(
        HIDE({
          new: {
            updated_at: '2026-10-26T15:00:05.123001+00:00',
            order_catalog_visibility_changed_at: '2026-10-26T15:00:05.123999+00:00',
          },
        }),
      ),
    ).toBe(false);
  });

  it('false when a field is missing or unreadable, never visibility-only by guess', () => {
    expect(isVisibilityOnlyEvent(undefined)).toBe(false);
    expect(isVisibilityOnlyEvent({})).toBe(false);
    expect(isVisibilityOnlyEvent(HIDE({ new: { updated_at: '2026-10-26T14:00:00Z' } }))).toBe(
      false,
    );
    expect(
      isVisibilityOnlyEvent(
        HIDE({
          new: { updated_at: null, order_catalog_visibility_changed_at: '2026-10-26T15:00:05Z' },
        }),
      ),
    ).toBe(false);
    expect(
      isVisibilityOnlyEvent(
        HIDE({
          new: {
            updated_at: 'yesterday',
            order_catalog_visibility_changed_at: '2026-10-26T15:00:05Z',
          },
        }),
      ),
    ).toBe(false);
    // A timestamp without a zone is not read as one.
    expect(
      isVisibilityOnlyEvent(
        HIDE({
          new: {
            updated_at: '2026-10-26 14:00:00',
            order_catalog_visibility_changed_at: '2026-10-26 15:00:05',
          },
        }),
      ),
    ).toBe(false);
  });

  it('false for an insert, a delete, or another table', () => {
    expect(isVisibilityOnlyEvent(HIDE({ eventType: 'INSERT' }))).toBe(false);
    expect(isVisibilityOnlyEvent(HIDE({ eventType: 'DELETE' }))).toBe(false);
    expect(isVisibilityOnlyEvent(HIDE({ table: 'stock_movements' }))).toBe(false);
  });
});

describe('visibilityEventRule', () => {
  it.each([
    ['/dashboard/orders/new', 'refresh'],
    ['/dashboard/orders/manage-items', 'refresh'],
    ['/dashboard/inventory', 'drop'],
    ['/dashboard/books', 'drop'],
    ['/dashboard/orders', 'drop'],
    ['/dashboard/orders/0a000000-0000-4000-8000-000000000001', 'drop'],
    ['/dashboard/orders/newest', 'drop'],
    ['/dashboard', 'drop'],
    [null, 'drop'],
  ] as const)('%s -> %s', (path, rule) => {
    expect(visibilityEventRule(path)).toBe(rule);
  });
});

describe('InventoryRealtime and visibility-only events', () => {
  async function mount(path: string) {
    h.pathname.value = path;
    render(<InventoryRealtime organizationId="org-1" />);
    await waitFor(() => expect(h.handlers.length).toBe(5));
    return h.handlers[0]!; // inventory_items
  }

  it('Items: dropped, no action, no refresh, so no Items list expiry', async () => {
    const onItem = await mount('/dashboard/inventory');
    vi.useFakeTimers();
    onItem(HIDE());
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.revalidate).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('Place an Order: one router.refresh(), never the list-busting action', async () => {
    const onItem = await mount('/dashboard/orders/new');
    vi.useFakeTimers();
    onItem(HIDE());
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  // Review F1: every open ordering tab used to refresh at once on the first
  // event, each render missing the catalog entry the write had just expired.
  it('Place an Order: the refresh waits a random 1 to 4 s, so one tab rebuilds and the others read its entry', async () => {
    const onItem = await mount('/dashboard/orders/new');
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    onItem(HIDE({ commit_timestamp: 'j1' }));
    await vi.advanceTimersByTimeAsync(999);
    expect(h.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);

    vi.mocked(Math.random).mockReturnValue(0.999);
    onItem(HIDE({ commit_timestamp: 'j2' }));
    await vi.advanceTimersByTimeAsync(3990);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it('Place an Order: events while the delayed refresh waits share it', async () => {
    const onItem = await mount('/dashboard/orders/new');
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    for (let n = 0; n < 5; n++) {
      onItem(HIDE({ commit_timestamp: `s${n}`, new: { ...HIDE().new, id: `i-${n}` } }));
      await vi.advanceTimersByTimeAsync(400);
    }
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("Place an Order: a Show or Hide in another warehouse is dropped; the tab's own warehouse refreshes", async () => {
    setOrderingTabWarehouse('wh-north');
    const onItem = await mount('/dashboard/orders/new');
    vi.useFakeTimers();
    onItem(HIDE({ commit_timestamp: 'w1', new: { ...HIDE().new, warehouse_id: 'wh-south' } }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.revalidate).not.toHaveBeenCalled();

    onItem(HIDE({ commit_timestamp: 'w2', new: { ...HIDE().new, warehouse_id: 'WH-NORTH' } }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('Place an Order: an event without a warehouse, or a page that has not said its warehouse, still refreshes', async () => {
    const onItem = await mount('/dashboard/orders/new');
    vi.useFakeTimers();
    onItem(HIDE({ commit_timestamp: 'u1', new: { ...HIDE().new, warehouse_id: 'wh-south' } }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    setOrderingTabWarehouse('wh-north');
    onItem(HIDE({ commit_timestamp: 'u2' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it('an ordinary event while the delayed refresh waits runs the action at once, and the wait is dropped', async () => {
    const onItem = await mount('/dashboard/orders/new');
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    onItem(HIDE({ commit_timestamp: 'o1' }));
    onItem({
      ...HIDE(),
      commit_timestamp: 'o2',
      new: { updated_at: '2026-10-26T16:00:00Z', order_catalog_visibility_changed_at: null },
    });
    await vi.advanceTimersByTimeAsync(5000);
    // The action's re-render read both commits.
    expect(h.revalidate).toHaveBeenCalledTimes(1);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  // Review F2: the save's Server Action response already carried the page.
  it("Manage order items: this tab's own write is not refreshed again; another manager's is, at once", async () => {
    const onItem = await mount('/dashboard/orders/manage-items');
    vi.useFakeTimers();
    markOwnVisibilityWrite(['I-OWN'], Date.now() + 3000);
    onItem(HIDE({ commit_timestamp: 'm1', new: { ...HIDE().new, id: 'i-own' } }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.refresh).not.toHaveBeenCalled();

    onItem(HIDE({ commit_timestamp: 'm2', new: { ...HIDE().new, id: 'i-theirs' } }));
    await vi.advanceTimersByTimeAsync(300);
    expect(h.refresh).toHaveBeenCalledTimes(1);

    // Once the mark runs out the same id refreshes like any other.
    await vi.advanceTimersByTimeAsync(3000);
    onItem(HIDE({ commit_timestamp: 'm3', new: { ...HIDE().new, id: 'i-own' } }));
    await vi.advanceTimersByTimeAsync(300);
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it('a 500-row hide is one transaction: one refresh per ordering tab', async () => {
    const onItem = await mount('/dashboard/orders/manage-items');
    vi.useFakeTimers();
    for (let i = 0; i < 500; i++) onItem(HIDE({ new: { ...HIDE().new, id: `i-${i}` } }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  it('an ordinary event is unchanged on an ordering page: it still runs the action', async () => {
    const onItem = await mount('/dashboard/orders/new');
    vi.useFakeTimers();
    onItem({
      ...HIDE(),
      commit_timestamp: 't-ordinary',
      new: {
        updated_at: '2026-10-26T16:00:00Z',
        order_catalog_visibility_changed_at: '2026-10-26T15:00:05Z',
      },
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.revalidate).toHaveBeenCalledTimes(1);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('a visibility event then an ordinary one in the same window: the trailing refresh is the action', async () => {
    // Manage order items refreshes a visibility-only event at once (only the
    // storefront waits), so the ordinary event that follows is the trailing
    // refresh.
    const onItem = await mount('/dashboard/orders/manage-items');
    vi.useFakeTimers();
    onItem(HIDE({ commit_timestamp: 't1' }));
    onItem({
      ...HIDE(),
      commit_timestamp: 't2',
      new: { updated_at: '2026-10-26T16:00:00Z', order_catalog_visibility_changed_at: null },
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.revalidate).toHaveBeenCalledTimes(1);
  });

  it('a hidden ordering tab refreshes once on return, with router.refresh()', async () => {
    const onItem = await mount('/dashboard/orders/new');
    vi.useFakeTimers();
    setVisibility('hidden');
    onItem(HIDE());
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.refresh).not.toHaveBeenCalled();
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  it('other tables keep their behaviour on every page (stock_movements still refreshes Items)', async () => {
    await mount('/dashboard/inventory');
    const onMovement = h.handlers[1]!;
    vi.useFakeTimers();
    onMovement({ table: 'stock_movements', eventType: 'INSERT', commit_timestamp: 't9', new: {} });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.revalidate).toHaveBeenCalledTimes(1);
  });
});
