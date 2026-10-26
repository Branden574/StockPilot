import { render } from '@testing-library/react';
import posthog, { type PostHogConfig } from 'posthog-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * End to end through the real posthog-js (docket B39 review): with the options
 * PostHogProvider passes, nothing PostHog builds or sends on /signin carries
 * the invite token of /signin?redirect=/invite/<token> or a session that
 * arrived in the fragment, neither in an event nor in the Referer of a request.
 * The provider's own options are taken from its init call; each test starts a
 * named SDK instance with them, plus switches that keep it from loading flags,
 * replay, surveys or scripts and one that lets it capture in a test browser.
 * fetch and sendBeacon are stubbed before the SDK loads, since it keeps its own
 * reference to fetch from then on: no request leaves the process. Placeholder
 * key and tokens.
 */

const { fetchStub, sendBeaconStub, realFetch } = vi.hoisted(() => {
  const realFetch = globalThis.fetch;
  const fetchStub = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
  const sendBeaconStub = vi.fn<Navigator['sendBeacon']>(() => true);
  globalThis.fetch = fetchStub;
  Object.defineProperty(globalThis.navigator, 'sendBeacon', {
    configurable: true,
    value: sendBeaconStub,
  });
  return { fetchStub, sendBeaconStub, realFetch };
});

vi.mock('next/navigation', () => ({ usePathname: () => window.location.pathname }));
vi.mock('@/lib/env.client', () => ({ env: { NEXT_PUBLIC_POSTHOG_KEY: 'phc_placeholder_key' } }));

import { PostHogProvider } from './posthog-provider';

const KEY = 'phc_placeholder_key';
const INGEST = 'https://ingest.example.invalid';
const TOKEN = 'placeholdertoken0000000000000000';
const ACCESS = 'accessplaceholder.payload.signature';
const REFRESH = 'refreshplaceholder';

/** Only what keeps a test SDK quiet; everything else is the provider's. */
const QUIET: Partial<PostHogConfig> = {
  api_host: INGEST,
  advanced_disable_flags: true,
  disable_session_recording: true,
  disable_surveys: true,
  disable_external_dependency_loading: true,
  capture_pageview: false,
  autocapture: false,
  // happy-dom reports navigator.webdriver, which the SDK drops as a bot.
  opt_out_useragent_filter: true,
};

let providerOptions: Partial<PostHogConfig> = {};

beforeAll(async () => {
  const init = vi.spyOn(posthog, 'init').mockImplementation(() => posthog);
  render(<PostHogProvider>{null}</PostHogProvider>);
  await vi.waitFor(() => expect(init).toHaveBeenCalled());
  providerOptions = init.mock.calls[0]?.[1] ?? {};
  init.mockRestore();
});

afterAll(() => {
  globalThis.fetch = realFetch;
  window.history.replaceState(null, '', '/');
});

function onSignInFromInvite(): void {
  window.history.replaceState(
    null,
    '',
    `/signin?redirect=/invite/${TOKEN}#access_token=${ACCESS}&refresh_token=${REFRESH}&token_type=bearer&type=recovery`,
  );
}

describe('PostHog on /signin, through the real SDK', () => {
  it('sends no invite token and no session token on an event built there', () => {
    onSignInFromInvite();
    const instance = posthog.init(KEY, { ...providerOptions, ...QUIET }, 'b39_events');
    const sent: unknown[] = [];
    instance.on('eventCaptured', (event: unknown) => sent.push(event));
    instance.capture('$pageview');

    expect(sent).toHaveLength(1);
    const properties = (sent[0] as { properties: Record<string, unknown> }).properties;
    expect(properties.$current_url).toBe(
      `${window.location.origin}/signin?redirect=/invite/[redacted]`,
    );
    const everything = JSON.stringify(sent);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(ACCESS);
    expect(everything).not.toContain(REFRESH);
  });

  it('empties its queue by fetch when the page goes away, so no Referer carries the address', async () => {
    // A beacon goes by the page's referrer policy, which for a same-origin
    // request such as /ingest is the full address (next.config.ts:
    // strict-origin-when-cross-origin), and the /ingest rewrite forwards it to
    // PostHog. The SDK's fetch asks for the origin only.
    onSignInFromInvite();
    const instance = posthog.init(KEY, { ...providerOptions, ...QUIET }, 'b39_unload');
    fetchStub.mockClear();
    sendBeaconStub.mockClear();
    instance.capture('$pageview');
    window.dispatchEvent(new Event('onpagehide' in window ? 'pagehide' : 'unload'));

    expect(sendBeaconStub).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalled());
    for (const [url, init] of fetchStub.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/ingest\.example\.invalid\//);
      expect(init?.referrerPolicy).toBe('strict-origin');
    }
  });

  it('asks for no more than the origin as the Referer of a script it loads', () => {
    // The SDK loads its remote config as a script from /ingest on every page,
    // before anything else; a script tag also goes by the page's policy.
    onSignInFromInvite();
    const scripts: HTMLScriptElement[] = [];
    function keep<T extends Node>(node: T): T {
      if (node instanceof HTMLScriptElement) scripts.push(node);
      return node;
    }
    // Kept out of the document, so happy-dom never fetches it.
    const append = vi.spyOn(document.body, 'appendChild').mockImplementation(keep);
    const insert = vi.spyOn(document.body, 'insertBefore').mockImplementation(keep);
    try {
      posthog.init(
        KEY,
        {
          ...providerOptions,
          ...QUIET,
          advanced_disable_flags: false,
          disable_external_dependency_loading: false,
        },
        'b39_scripts',
      );
    } finally {
      append.mockRestore();
      insert.mockRestore();
    }

    expect(scripts.map((script) => script.src)).toEqual([`${INGEST}/array/${KEY}/config.js`]);
    expect(scripts[0]?.getAttribute('referrerpolicy')).toBe('strict-origin');
  });
});
