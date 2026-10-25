import { render } from '@testing-library/react';
import posthog from 'posthog-js';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * End to end through the real posthog-js (docket B39 review): with the options
 * PostHogProvider passes, an event built on /signin carries neither the invite
 * token of /signin?redirect=/invite/<token> nor a session that arrived in the
 * fragment. The provider's own options are taken from its init call; the test
 * adds only switches that keep the SDK from loading flags, replay, surveys or
 * scripts, and one that lets it capture in a test browser. Every request is
 * stubbed and none leaves the process. Placeholder key and tokens.
 */

vi.mock('next/navigation', () => ({ usePathname: () => window.location.pathname }));
vi.mock('@/lib/env.client', () => ({ env: { NEXT_PUBLIC_POSTHOG_KEY: 'phc_placeholder_key' } }));

import { PostHogProvider } from './posthog-provider';

const TOKEN = 'placeholdertoken0000000000000000';
const ACCESS = 'accessplaceholder.payload.signature';
const REFRESH = 'refreshplaceholder';

afterAll(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('PostHog on /signin, through the real SDK', () => {
  it('sends no invite token and no session token on an event built there', async () => {
    window.history.replaceState(
      null,
      '',
      `/signin?redirect=/invite/${TOKEN}#access_token=${ACCESS}&refresh_token=${REFRESH}&token_type=bearer&type=recovery`,
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: vi.fn(() => true),
    });

    // The provider's options, from its own init call.
    const init = vi.spyOn(posthog, 'init').mockImplementation(() => undefined);
    render(<PostHogProvider>{null}</PostHogProvider>);
    await vi.waitFor(() => expect(init).toHaveBeenCalled());
    const [, options] = init.mock.calls[0]!;
    init.mockRestore();

    posthog.init('phc_placeholder_key', {
      ...options,
      api_host: 'https://ingest.example.invalid',
      advanced_disable_flags: true,
      disable_session_recording: true,
      disable_surveys: true,
      disable_external_dependency_loading: true,
      capture_pageview: false,
      autocapture: false,
      // happy-dom reports navigator.webdriver, which the SDK drops as a bot.
      opt_out_useragent_filter: true,
    });
    const sent: unknown[] = [];
    posthog.on('eventCaptured', (event: unknown) => sent.push(event));
    posthog.capture('$pageview');

    expect(sent).toHaveLength(1);
    const properties = (sent[0] as { properties: Record<string, unknown> }).properties;
    expect(properties.$current_url).toBe(
      `${window.location.origin}/signin?redirect=/invite/[redacted]`,
    );
    const everything = JSON.stringify(sent);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(ACCESS);
    expect(everything).not.toContain(REFRESH);
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).toMatch(/^https:\/\/ingest\.example\.invalid\//);
    }
  });
});
