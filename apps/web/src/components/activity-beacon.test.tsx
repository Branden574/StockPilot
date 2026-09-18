import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The browser half of the "last seen" signal (migration 0352).
 *
 * Two properties are the point of it and both are pinned here:
 *
 *   PERSON-DRIVEN. It fires when someone opens the app, returns to the tab or
 *   the window, or navigates. It has NO timer, so a dashboard left open on an
 *   unattended screen stops reporting. The hourly session renewal cannot tell
 *   that screen from a person; this can.
 *
 *   QUIET. At most one request per five minutes per person per organization,
 *   shared across tabs, and never an error the page can see.
 */

let pathname = '/dashboard';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

import { ActivityBeacon, BEACON_MIN_INTERVAL_MS } from './activity-beacon';

const fetchMock = vi.fn();
const SCOPE = 'user-1:org-1';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}
function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'setTimeout'] });
  vi.setSystemTime(new Date('2026-09-18T12:00:00Z'));
  pathname = '/dashboard';
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  setVisibility('visible');
  setOnline(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ActivityBeacon', () => {
  it('reports once when the app opens, to the beacon route, with no body', async () => {
    render(<ActivityBeacon scope={SCOPE} />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/me/seen', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
    });
  });

  it('stays quiet for five minutes, across navigation, focus and tab returns', async () => {
    const view = render(<ActivityBeacon scope={SCOPE} />);
    await act(async () => {});
    pathname = '/dashboard/inventory';
    view.rerender(<ActivityBeacon scope={SCOPE} />);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports again on the next person-driven moment after the interval', async () => {
    const view = render(<ActivityBeacon scope={SCOPE} />);
    await act(async () => {});
    vi.setSystemTime(Date.now() + BEACON_MIN_INTERVAL_MS + 1000);
    pathname = '/dashboard/orders';
    view.rerender(<ActivityBeacon scope={SCOPE} />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('has NO timer: an open tab nobody touches reports nothing more, however long it sits', async () => {
    render(<ActivityBeacon scope={SCOPE} />);
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares the throttle across tabs through localStorage', async () => {
    render(<ActivityBeacon scope={SCOPE} />);
    await act(async () => {});
    // A second tab of the same person in the same organization.
    render(<ActivityBeacon scope={SCOPE} />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not let one account or organization throttle another on a shared device', async () => {
    render(<ActivityBeacon scope="user-1:org-1" />);
    await act(async () => {});
    render(<ActivityBeacon scope="user-1:org-2" />);
    render(<ActivityBeacon scope="user-2:org-1" />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not report from a hidden tab or while offline', async () => {
    setVisibility('hidden');
    render(<ActivityBeacon scope={SCOPE} />);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();

    setVisibility('visible');
    setOnline(false);
    window.dispatchEvent(new Event('focus'));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries at the next moment when the request never reached the server', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<ActivityBeacon scope={SCOPE} />);
    await act(async () => {});
    window.dispatchEvent(new Event('focus'));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still works when storage is unavailable, throttling in memory instead', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    render(<ActivityBeacon scope={SCOPE} />);
    await act(async () => {});
    window.dispatchEvent(new Event('focus'));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it('removes its listeners when it unmounts', async () => {
    const view = render(<ActivityBeacon scope={SCOPE} />);
    await act(async () => {});
    view.unmount();
    vi.setSystemTime(Date.now() + BEACON_MIN_INTERVAL_MS + 1000);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
