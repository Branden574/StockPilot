import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A notification event re-renders the page only where the page shows
 * notifications. Every event used to router.refresh() whatever page was open,
 * hidden tabs included, although the only server-rendered notifications reader
 * is /dashboard/notifications: a full server render and a router-cache purge
 * per notification, for nothing.
 */

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  pathname: { value: '/dashboard/inventory' },
  visibility: { value: 'visible' as DocumentVisibilityState },
  handlers: [] as Array<(payload?: unknown) => void>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: h.refresh }),
  usePathname: () => h.pathname.value,
}));

vi.mock('@/lib/notifications/live-toast', () => ({ queueLiveNotification: vi.fn() }));
vi.mock('@/lib/supabase/realtime-auth', () => ({ ensureRealtimeAuth: vi.fn(async () => () => {}) }));

function makeBuilder() {
  const builder = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    order: () => builder,
    limit: async () => ({ data: [], error: null, count: 0 }),
  };
  return builder;
}
const channelStub = {
  on: (_event: string, _cfg: unknown, cb: (payload?: unknown) => void) => {
    h.handlers.push(cb);
    return channelStub;
  },
  subscribe: () => channelStub,
};
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => makeBuilder(),
    channel: () => channelStub,
    removeChannel: () => undefined,
  }),
}));

import { NotificationBell } from './notification-bell';

Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  get: () => h.visibility.value,
});
function setVisibility(value: DocumentVisibilityState) {
  h.visibility.value = value;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.length = 0;
  h.pathname.value = '/dashboard/inventory';
  h.visibility.value = 'visible';
});
afterEach(() => {
  vi.useRealTimers();
});

async function mountAndGetHandler() {
  render(<NotificationBell userId="u-1" organizationId="org-1" />);
  await waitFor(() => expect(h.handlers.length).toBeGreaterThan(0));
  return h.handlers[0]!;
}

describe('NotificationBell page refreshes', () => {
  it('on any other page, an event re-renders nothing', async () => {
    const onEvent = await mountAndGetHandler();
    await act(async () => {
      onEvent({ eventType: 'INSERT' });
    });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('on the Notifications page, an event refreshes it', async () => {
    h.pathname.value = '/dashboard/notifications';
    const onEvent = await mountAndGetHandler();
    await act(async () => {
      onEvent({ eventType: 'INSERT' });
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('a hidden Notifications tab refreshes once, when it is visible again', async () => {
    h.pathname.value = '/dashboard/notifications';
    const onEvent = await mountAndGetHandler();
    setVisibility('hidden');
    vi.useFakeTimers();
    await act(async () => {
      onEvent({ eventType: 'INSERT' });
      await vi.advanceTimersByTimeAsync(600);
      onEvent({ eventType: 'UPDATE' });
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(h.refresh).not.toHaveBeenCalled();

    await act(async () => {
      setVisibility('visible');
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);

    // Nothing new since: hiding and showing again costs nothing.
    await act(async () => {
      setVisibility('hidden');
      setVisibility('visible');
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});
