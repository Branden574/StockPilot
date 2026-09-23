import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The order page's live refresher: a change to this order re-renders the page
 * when the tab is visible; a hidden tab refreshes once when it is visible
 * again, instead of a full server render per change nobody is looking at.
 */

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  visibility: { value: 'visible' as DocumentVisibilityState },
  handlers: [] as Array<() => void>,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('@/lib/supabase/realtime-auth', () => ({ ensureRealtimeAuth: vi.fn(async () => () => {}) }));
const channelStub = {
  on: (_event: string, _cfg: unknown, cb: () => void) => {
    h.handlers.push(cb);
    return channelStub;
  },
  subscribe: () => channelStub,
};
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ channel: () => channelStub, removeChannel: () => undefined }),
}));

import { OrderRealtimeRefresh } from './order-realtime-refresh';

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
  h.visibility.value = 'visible';
});

async function mount() {
  render(<OrderRealtimeRefresh orderId="o-1" />);
  await waitFor(() => expect(h.handlers.length).toBe(1));
  return h.handlers[0]!;
}

describe('OrderRealtimeRefresh', () => {
  it('a change to the order refreshes a visible page', async () => {
    const onChange = await mount();
    act(() => onChange());
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('a hidden tab refreshes once when it is visible again, and not again after', async () => {
    const onChange = await mount();
    setVisibility('hidden');
    act(() => {
      onChange();
      onChange();
    });
    expect(h.refresh).not.toHaveBeenCalled();
    act(() => setVisibility('visible'));
    expect(h.refresh).toHaveBeenCalledTimes(1);
    act(() => {
      setVisibility('hidden');
      setVisibility('visible');
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});
