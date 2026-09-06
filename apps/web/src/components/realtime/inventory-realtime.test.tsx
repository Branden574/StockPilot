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
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
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
  revalidateInventoryViewAction: vi.fn(async () => undefined),
}));

import { InventoryRealtime } from './inventory-realtime';

beforeEach(() => {
  h.refresh.mockClear();
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
    expect(h.refresh).toHaveBeenCalledTimes(1);

    // The RSC response for the leading refresh lands and re-renders the
    // layout. That must NOT cancel the pending trailing refresh.
    rerender(<InventoryRealtime organizationId="org-1" />);
    await vi.advanceTimersByTimeAsync(300);

    expect(h.refresh).toHaveBeenCalledTimes(2);
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
