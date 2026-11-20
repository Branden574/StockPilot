/**
 * THE REALTIME FAN-OUT, simulated in components (ordering visibility; design
 * 11.2 item 3 and 7.2 item 8; and the refresh fan-out of ordinary events).
 *
 * 20 open Items tabs (10 managers, 10 staff members) and 2 open Place an Order
 * tabs of one organization. Every tab is a real InventoryRealtime with its own
 * router, pathname and session. The action is the real
 * revalidateInventoryViewAction and its real server decision
 * (refreshInventoryViewForCurrentOrg); only the session (withContext) and
 * next/cache are faked, so an expiry here is a real revalidateTag call.
 *
 * 1. A manager toggles 10 rows one by one (10 transactions, one UPDATE event
 *    each, a second apart). Expected and pinned: zero refreshes and zero
 *    actions (so zero Items list cache expiries) on the Items tabs, and on
 *    each Place an Order tab one refresh per burst of toggles, each 1 to 4 s
 *    after the burst's first event (review F1), never the action.
 *
 * 2. The same 10 events as ordinary item UPDATEs (stock moved). Before, every
 *    tab ran the action once per event: 220 actions, 220 expiries of the
 *    org's list cache, 220 page renders. Now:
 *      - actions: 200, one per Items tab per event (the action is still each
 *        Items tab's one render);
 *      - expiries: 100, only the 10 manager Items tabs (staff pages never
 *        read the shared list caches); the 10 staff tabs re-render through
 *        refresh() instead (100), which expires nothing;
 *      - Place an Order: no action; one delayed router.refresh() per burst,
 *        4 per tab (the visibility events' rule), instead of 10 actions that
 *        each re-sent the whole catalog.
 *    Renders: 200 + 8 = 208 (was 220). Expiries: 100 (was 220).
 *
 * 3. Other pages of the dashboard (the realtime listener runs on every
 *    dashboard route): manager Dashboard tabs, manager Books tabs, staff
 *    Orders tabs. Expiries come only from the Books tabs; the rest re-render
 *    without expiring anything.
 *
 * This counts the client's reactions and the server's decisions only. The
 * live measurement (a running web server, the realtime service and server
 * logs of the cache tag) is the integration walk's.
 */
import { act, render, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = { table: string; cb: (payload?: unknown) => void };

const h = vi.hoisted(() => ({
  handlers: [] as Array<{ table: string; cb: (payload?: unknown) => void }>,
  revalidateByTab: new Map<string, number>(),
  refreshByTab: new Map<string, number>(),
  currentTab: { value: '' },
  roleByTab: new Map<string, string>(),
  /** revalidateTag calls the real action made (Items/Books list expiries). */
  expiries: [] as unknown[][],
  /** refresh() calls the real action made (a re-render, nothing expired). */
  serverRefreshes: { value: 0 },
}));

const TabContext = React.createContext<{ id: string; path: string }>({ id: '', path: '' });

vi.mock('next/navigation', async () => {
  const ReactMod = await import('react');
  return {
    useRouter: () => {
      const tab = ReactMod.useContext(TabContext);
      return ReactMod.useMemo(
        () => ({
          refresh: () => h.refreshByTab.set(tab.id, (h.refreshByTab.get(tab.id) ?? 0) + 1),
          push: vi.fn(),
          replace: vi.fn(),
        }),
        [tab.id],
      );
    },
    usePathname: () => ReactMod.useContext(TabContext).path,
  };
});

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: () => {
      const ch: Record<string, unknown> = {
        on: (_evt: string, cfg: { table: string }, cb: (payload?: unknown) => void) => {
          // The tab whose effect is subscribing right now (set below).
          const tab = h.currentTab.value;
          h.handlers.push({
            table: cfg.table,
            cb: (payload?: unknown) => {
              h.currentTab.value = tab;
              cb(payload);
            },
          });
          return ch;
        },
        subscribe: vi.fn(),
      };
      return ch;
    },
    removeChannel: vi.fn(),
  }),
}));

vi.mock('@/lib/supabase/realtime-auth', () => ({
  ensureRealtimeAuth: vi.fn(async () => () => {}),
}));

// The real action, counted per tab. It runs synchronously up to its session
// read, so withContext below sees the tab that called it.
vi.mock('@/server/actions/revalidate-inventory-view', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/actions/revalidate-inventory-view')>();
  return {
    revalidateInventoryViewAction: (view?: unknown) => {
      const tab = h.currentTab.value;
      h.revalidateByTab.set(tab, (h.revalidateByTab.get(tab) ?? 0) + 1);
      return real.revalidateInventoryViewAction(view);
    },
  };
});

vi.mock('@/server/services/context', async (importOriginal) => {
  const { ROLE_PERMISSIONS } = await import('@stockpilot/core');
  return {
    ...(await importOriginal<typeof import('@/server/services/context')>()),
    withContext: () => {
      const tab = h.currentTab.value;
      const role = (h.roleByTab.get(tab) ?? 'manager') as keyof typeof ROLE_PERMISSIONS;
      return Promise.resolve({
        organizationId: 'org-1',
        userId: tab,
        role,
        permissions: new Set(ROLE_PERMISSIONS[role]),
      });
    },
  };
});

vi.mock('next/cache', () => ({
  revalidateTag: (...args: unknown[]) => {
    h.expiries.push(args);
  },
  refresh: () => {
    h.serverRefreshes.value += 1;
  },
  unstable_cache: (fn: unknown) => fn,
}));

import { InventoryRealtime } from './inventory-realtime';

type Tab = { id: string; path: string; role: 'manager' | 'staff' };

const ITEMS_TABS: Tab[] = Array.from({ length: 20 }, (_, i) => ({
  id: `items-${i}`,
  path: '/dashboard/inventory',
  role: i < 10 ? 'manager' : 'staff',
}));
const ORDER_TABS: Tab[] = Array.from({ length: 2 }, (_, i) => ({
  id: `order-${i}`,
  path: '/dashboard/orders/new',
  role: 'manager',
}));
const TABS = [...ITEMS_TABS, ...ORDER_TABS];

/** Mounts each tab in turn so each subscription knows whose it is. */
async function openTabs(tabs: Tab[] = TABS) {
  for (const tab of tabs) {
    h.roleByTab.set(tab.id, tab.role);
    h.currentTab.value = tab.id;
    const before = h.handlers.length;
    render(
      <TabContext.Provider value={tab}>
        <InventoryRealtime organizationId="org-1" />
      </TabContext.Provider>,
    );
    await waitFor(() => expect(h.handlers.length).toBe(before + 5));
  }
}

function deliver(handlers: Handler[], payload: unknown) {
  for (const handler of handlers) if (handler.table === 'inventory_items') handler.cb(payload);
}

function toggleEvent(n: number, visibilityOnly: boolean) {
  const second = String(n).padStart(2, '0');
  return {
    schema: 'public',
    table: 'inventory_items',
    eventType: 'UPDATE',
    commit_timestamp: `2026-10-26T15:00:${second}.500Z`,
    new: visibilityOnly
      ? {
          id: `row-${n}`,
          updated_at: '2026-10-20T09:00:00.000000+00:00',
          order_catalog_visibility_changed_at: `2026-10-26T15:00:${second}.400000+00:00`,
        }
      : { id: `row-${n}`, updated_at: `2026-10-26T15:00:${second}.400000+00:00` },
  };
}

const sum = (map: Map<string, number>, ids: string[]) =>
  ids.reduce((n, id) => n + (map.get(id) ?? 0), 0);

beforeEach(() => {
  h.handlers.length = 0;
  h.revalidateByTab.clear();
  h.refreshByTab.clear();
  h.roleByTab.clear();
  h.expiries.length = 0;
  h.serverRefreshes.value = 0;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Show and Hide fan-out: 20 Items tabs, 2 Place an Order tabs, 10 toggles', () => {
  it('Items tabs: 0 refreshes and 0 actions; each ordering tab: one delayed refresh per burst, no action', async () => {
    await openTabs();
    vi.useFakeTimers();
    // The storefront's refresh waits 1 + random() * 3 s (review F1); 0.5
    // makes it 2.5 s, so toggles a second apart share refreshes: those at 0,
    // 1 and 2 s refresh at 2.5 s, 3-5 at 5.5 s, 6-8 at 8.5 s, 9 at 11.5 s.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    for (let n = 0; n < 10; n++) {
      await act(async () => {
        deliver(h.handlers, toggleEvent(n, true));
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    const items = ITEMS_TABS.map((t) => t.id);
    expect(sum(h.revalidateByTab, items)).toBe(0);
    expect(sum(h.refreshByTab, items)).toBe(0);
    for (const tab of ORDER_TABS) {
      expect(h.refreshByTab.get(tab.id) ?? 0).toBe(4);
      expect(h.revalidateByTab.get(tab.id) ?? 0).toBe(0);
    }
    vi.mocked(Math.random).mockRestore();
  });

  it('ordinary item UPDATEs: 200 actions (was 220), 100 list expiries (was 220), storefront tabs never run the action', async () => {
    await openTabs();
    vi.useFakeTimers();
    // The storefront's refresh waits 1 + random() * 3 s; 0.5 makes it 2.5 s,
    // so events a second apart share refreshes, as in the toggle case above.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    for (let n = 0; n < 10; n++) {
      await act(async () => {
        deliver(h.handlers, toggleEvent(n, false));
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    const items = ITEMS_TABS.map((t) => t.id);
    const managers = ITEMS_TABS.filter((t) => t.role === 'manager').map((t) => t.id);
    const staff = ITEMS_TABS.filter((t) => t.role === 'staff').map((t) => t.id);

    // Every Items tab still re-renders once per event, through the action.
    expect(sum(h.revalidateByTab, items)).toBe(200);
    expect(sum(h.refreshByTab, items)).toBe(0);
    for (const id of items) expect(h.revalidateByTab.get(id)).toBe(10);
    // Only the managers' tabs expire the list cache, always the session's
    // organization; the staff tabs re-render with refresh().
    expect(h.expiries).toHaveLength(managers.length * 10);
    expect(
      h.expiries.every(
        ([tag, profile]) =>
          tag === 'inventory-list-org-1' && JSON.stringify(profile) === '{"expire":0}',
      ),
    ).toBe(true);
    expect(h.serverRefreshes.value).toBe(staff.length * 10);

    // Place an Order: the delayed router.refresh(), never the action.
    for (const tab of ORDER_TABS) {
      expect(h.revalidateByTab.get(tab.id) ?? 0).toBe(0);
      expect(h.refreshByTab.get(tab.id) ?? 0).toBe(4);
    }
    vi.mocked(Math.random).mockRestore();
  });

  it('other dashboard pages re-render without expiring; only Items and Books tabs of managers expire', async () => {
    const fleet: Tab[] = [
      ...Array.from({ length: 4 }, (_, i): Tab => ({
        id: `dash-${i}`,
        path: '/dashboard',
        role: 'manager',
      })),
      ...Array.from({ length: 2 }, (_, i): Tab => ({
        id: `books-${i}`,
        path: '/dashboard/books',
        role: 'manager',
      })),
      ...Array.from({ length: 2 }, (_, i): Tab => ({
        id: `orders-${i}`,
        path: '/dashboard/orders',
        role: 'staff',
      })),
      {
        id: 'item-page',
        path: '/dashboard/inventory/00000000-0000-4000-8000-000000000001',
        role: 'manager',
      },
    ];
    await openTabs(fleet);
    vi.useFakeTimers();
    for (let n = 0; n < 10; n++) {
      await act(async () => {
        deliver(h.handlers, toggleEvent(n, false));
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    // One action per tab per event (each tab's one render), as before.
    expect(
      sum(
        h.revalidateByTab,
        fleet.map((t) => t.id),
      ),
    ).toBe(90);
    // Was 90 expiries (every tab); now the 2 Books tabs' 20.
    expect(h.expiries).toHaveLength(20);
    expect(h.serverRefreshes.value).toBe(70);
    expect(
      sum(
        h.refreshByTab,
        fleet.map((t) => t.id),
      ),
    ).toBe(0);
  });
});
