import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fix wave I6: PostHog must never initialize (and must opt out an
 * already-loaded singleton) while the current route is a public share
 * surface — `/m/<token>` (maintenance request share links) or
 * `/r/<token>` (public order-request links) — because pageview/autocapture
 * would ship `window.location.href`, which carries the raw token, to a
 * third-party vendor (GC 27). `NEXT_PUBLIC_POSTHOG_KEY` is unset in prod
 * today, so none of this fires yet — this suite proves the PATH guard
 * itself, independent of whether the key happens to be set.
 */

const { pathnameRef, envMock, posthogMock } = vi.hoisted(() => ({
  pathnameRef: { value: '/dashboard' as string | null },
  envMock: { NEXT_PUBLIC_POSTHOG_KEY: 'phc_test_key' },
  posthogMock: {
    __loaded: false,
    init: vi.fn(),
    opt_out_capturing: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.value,
}));
vi.mock('@/lib/env.client', () => ({ env: envMock }));
vi.mock('posthog-js', () => ({ default: posthogMock }));

import { PostHogProvider } from './posthog-provider';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('PostHogProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    posthogMock.__loaded = false;
    pathnameRef.value = '/dashboard';
    envMock.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
  });

  it('initializes normally on an ordinary route when a key is configured', async () => {
    render(<PostHogProvider>{null}</PostHogProvider>);
    await flush();
    expect(posthogMock.init).toHaveBeenCalledWith(
      'phc_test_key',
      expect.objectContaining({ capture_pageview: true, autocapture: true }),
    );
  });

  it('MUTATION GUARD — never initializes on a maintenance share path (/m/<token>), even with a key configured', async () => {
    pathnameRef.value = '/m/abcdef0123456789';
    render(<PostHogProvider>{null}</PostHogProvider>);
    await flush();
    expect(posthogMock.init).not.toHaveBeenCalled();
  });

  it('MUTATION GUARD — never initializes on a public order-request share path (/r/<token>)', async () => {
    pathnameRef.value = '/r/abcdef0123456789';
    render(<PostHogProvider>{null}</PostHogProvider>);
    await flush();
    expect(posthogMock.init).not.toHaveBeenCalled();
  });

  it('opts out an already-loaded singleton when the current path is a share path', async () => {
    posthogMock.__loaded = true;
    pathnameRef.value = '/m/abcdef0123456789';
    render(<PostHogProvider>{null}</PostHogProvider>);
    await flush();
    expect(posthogMock.opt_out_capturing).toHaveBeenCalled();
    expect(posthogMock.init).not.toHaveBeenCalled();
  });

  it('does nothing at all — no init, no opt-out call — when no key is configured, regardless of path', async () => {
    envMock.NEXT_PUBLIC_POSTHOG_KEY = '';
    pathnameRef.value = '/m/abcdef0123456789';
    render(<PostHogProvider>{null}</PostHogProvider>);
    await flush();
    expect(posthogMock.init).not.toHaveBeenCalled();
    expect(posthogMock.opt_out_capturing).not.toHaveBeenCalled();
  });
});
