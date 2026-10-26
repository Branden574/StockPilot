/**
 * THE REALTIME FAN-OUT OF SHOW AND HIDE, simulated in components (ordering
 * visibility; design 11.2 item 3 and 7.2 item 8).
 *
 * 20 open Items tabs and 2 open Place an Order tabs of one organization; a
 * manager toggles 10 rows one by one (10 transactions, one UPDATE event each,
 * a second apart). Every tab is a real InventoryRealtime with its own router
 * and pathname. Expected and pinned: zero refreshes and zero
 * revalidateInventoryViewAction calls (so zero Items list cache expiries) on
 * the Items tabs, and on each Place an Order tab one refresh per burst of
 * toggles, each 1 to 4 s after the burst's first event (review F1), never the
 * action.
 *
 * The comparable baseline is the same 10 events as ordinary item UPDATEs
 * (what every tab did with an item UPDATE before this filter): every tab runs
 * the action once per toggle, 220 calls.
 *
 * This counts the client's reactions only. The live measurement (a running
 * web server, the realtime service and server logs of the cache tag) is the
 * integration walk's.
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

vi.mock('@/server/actions/revalidate-inventory-view', () => ({
  revalidateInventoryViewAction: async () => {
    const tab = h.currentTab.value;
    h.revalidateByTab.set(tab, (h.revalidateByTab.get(tab) ?? 0) + 1);
    return true;
  },
}));

import { InventoryRealtime } from './inventory-realtime';

const ITEMS_TABS = Array.from({ length: 20 }, (_, i) => ({
  id: `items-${i}`,
  path: '/dashboard/inventory',
}));
const ORDER_TABS = Array.from({ length: 2 }, (_, i) => ({
  id: `order-${i}`,
  path: '/dashboard/orders/new',
}));
const TABS = [...ITEMS_TABS, ...ORDER_TABS];

/** Mounts each tab in turn so each subscription knows whose it is. */
async function openTabs() {
  for (const tab of TABS) {
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

  it('baseline: the same 10 events as ordinary item UPDATEs run the action on every tab (220 calls)', async () => {
    await openTabs();
    vi.useFakeTimers();
    for (let n = 0; n < 10; n++) {
      await act(async () => {
        deliver(h.handlers, toggleEvent(n, false));
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    expect(
      sum(
        h.revalidateByTab,
        TABS.map((t) => t.id),
      ),
    ).toBe(220);
  });
});
