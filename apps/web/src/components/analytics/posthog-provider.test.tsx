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

  // Performance program 2026-09: `perf_*` events carry route TEMPLATES only,
  // but the SDK decorates every event with `$current_url`, `$pathname`,
  // referrers and titles AFTER our code has handed it over. The `before_send`
  // hook is the only place those can be rewritten, so its wiring is pinned
  // here: nothing else fails if the option is dropped from `init`. The hook is
  // exercised for real (not compared by identity), so swapping in a no-op
  // fails too. Its full behaviour is lib/perf/scrub.test.ts's business.
  it('MUTATION GUARD — wires a before_send hook that templates perf events and leaves product events alone', async () => {
    render(<PostHogProvider>{null}</PostHogProvider>);
    await flush();
    const options = posthogMock.init.mock.calls[0]?.[1] as {
      before_send?: (event: Record<string, unknown>) => Record<string, unknown> | null;
    };
    expect(typeof options.before_send).toBe('function');

    const itemUrl =
      'https://app.stockpilotusa.com/dashboard/inventory/3f2c1a9e-7b4d-4c1e-9a2f-0d5e6f7a8b9c?q=acme';
    const perf = options.before_send?.({
      event: 'perf_navigation',
      properties: { $current_url: itemUrl, $referrer: itemUrl, click_to_useful_ms: 742 },
    });
    expect(perf?.properties).toEqual({
      $current_url: '/dashboard/inventory/[id]',
      $pathname: '/dashboard/inventory/[id]',
      click_to_useful_ms: 742,
    });

    const product = { event: 'item_created', properties: { $current_url: itemUrl } };
    expect(options.before_send?.(product)).toBe(product);
  });

  // Docket B39 review. A link Supabase verified itself lands on /signin with a
  // live session in the fragment, and posthog-js records the fragment in
  // $current_url (and the first and session-entry URLs) unless told not to:
  // the option defaults to off when `defaults` is unset, as here.
  it('MUTATION GUARD — tells the SDK never to record a URL fragment', async () => {
    render(<PostHogProvider>{null}</PostHogProvider>);
    await flush();
    expect(posthogMock.init).toHaveBeenCalledWith(
      'phc_test_key',
      expect.objectContaining({ disable_capture_url_hashes: true }),
    );
  });

  // Docket S22 (owner decision d.4). Whether a visit is recorded is decided by
  // the replay switch in the PostHog project, unless the code says no: the SDK
  // records only when the project says yes AND this option is false, its
  // default. A recording is the page itself, which before_send leaves alone.
  // posthog-provider.sdk.test.tsx proves the project's yes is overruled.
  it('MUTATION GUARD — never records a session, whatever the PostHog project says', async () => {
    render(<PostHogProvider>{null}</PostHogProvider>);
    await flush();
    expect(posthogMock.init).toHaveBeenCalledWith(
      'phc_test_key',
      expect.objectContaining({ disable_session_recording: true }),
    );
  });

  // The path guard below keeps PostHog off a share page, but a credential can
  // sit in another page's URL: the invite page's Sign in link is
  // /signin?redirect=/invite/<token>, and the SDK puts that URL on every event
  // there. The hook takes the token out of product events too; the full
  // behaviour is lib/analytics-before-send.test.ts's business.
  it('MUTATION GUARD — the before_send hook takes a share token out of a product event', async () => {
    render(<PostHogProvider>{null}</PostHogProvider>);
    await flush();
    const options = posthogMock.init.mock.calls[0]?.[1] as {
      before_send?: (event: Record<string, unknown>) => Record<string, unknown> | null;
    };
    const token = 'placeholdertoken0000000000000000';
    const signin = `https://app.example.test/signin?redirect=/invite/${token}`;
    const out = options.before_send?.({
      event: '$pageview',
      properties: { $current_url: signin, $set_once: { $initial_current_url: signin } },
    });
    expect(JSON.stringify(out)).not.toContain(token);
    expect((out?.properties as Record<string, unknown>).$current_url).toBe(
      'https://app.example.test/signin?redirect=/invite/[redacted]',
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

  it.each(['/i/', '/invite/', '/orders/sign/', '/returns/request/'])(
    'MUTATION GUARD — never initializes on %s<token>: the path itself is a credential',
    async (prefix) => {
      pathnameRef.value = `${prefix}abcdef0123456789abcdef0123456789`;
      render(<PostHogProvider>{null}</PostHogProvider>);
      await flush();
      expect(posthogMock.init).not.toHaveBeenCalled();
    },
  );

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
