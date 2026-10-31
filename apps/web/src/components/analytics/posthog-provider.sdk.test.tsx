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
 * surveys or scripts and one that lets it capture in a test browser. Session
 * replay is not among them: whether it records is the provider's own setting
 * (docket S22), and the last describe block turns it on in the project.
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

/**
 * Every script the SDK asks for, kept out of the document so happy-dom never
 * fetches it. With `defaults` unset the SDK puts scripts in the body.
 */
function interceptScripts(): { scripts: HTMLScriptElement[]; restore: () => void } {
  const scripts: HTMLScriptElement[] = [];
  function keep<T extends Node>(node: T): T {
    if (node instanceof HTMLScriptElement) scripts.push(node);
    return node;
  }
  const append = vi.spyOn(document.body, 'appendChild').mockImplementation(keep);
  const insert = vi.spyOn(document.body, 'insertBefore').mockImplementation(keep);
  return {
    scripts,
    restore: () => {
      append.mockRestore();
      insert.mockRestore();
    },
  };
}

const projectAnswers = window as unknown as {
  _POSTHOG_REMOTE_CONFIG?: Record<string, { config: Record<string, unknown> }>;
};

/**
 * The PostHog project's answer for each key, as the config script PostHog
 * serves would leave it. The SDK applies it during init, before anything else.
 * Returns the cleanup. Each test uses keys of its own, since the SDK also
 * keeps the answer per key.
 */
function projectSays(keys: readonly string[], config: Record<string, unknown>): () => void {
  const answers = (projectAnswers._POSTHOG_REMOTE_CONFIG ??= {});
  for (const key of keys) answers[key] = { config: { hasFeatureFlags: false, ...config } };
  return () => {
    for (const key of keys) delete answers[key];
  };
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
    const { scripts, restore } = interceptScripts();
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
      restore();
    }

    expect(scripts.map((script) => script.src)).toEqual([`${INGEST}/array/${KEY}/config.js`]);
    expect(scripts[0]?.getAttribute('referrerpolicy')).toBe('strict-origin');
  });
});

/*
 * What the PostHog project can switch on by itself, with no code change. Each
 * test starts two instances fed the same project answer: one with the
 * provider's options, and a control with the provider's switch for that
 * feature taken out. The control proves the harness sees the feature at work,
 * so the provider's test cannot pass for want of it.
 */
describe('PostHog when the PostHog project switches a feature on, through the real SDK', () => {
  // Docket S22 (owner decision d.4). A recording is the page itself: its text,
  // its links (a requester's return link among them) and, if the project
  // turns body capture on, the responses. before_send leaves it alone.
  it('never asks for the session recorder, even when the project turns replay on', async () => {
    const providerKey = 'phc_placeholder_replay_provider';
    const controlKey = 'phc_placeholder_replay_control';
    const providerHost = 'https://provider.ingest.example.invalid';
    const controlHost = 'https://control.ingest.example.invalid';
    // The SDK asks for /static/<version>/lazy-recorder.js first, the ?v= form
    // only after a load error, and the project can name another script.
    const recorderFrom = (host: string) => (script: HTMLScriptElement) =>
      script.src.startsWith(`${host}/static/`) && /recorder/.test(script.src);

    const forget = projectSays([providerKey, controlKey], {
      sessionRecording: { endpoint: '/s/' },
    });
    const { scripts, restore } = interceptScripts();
    try {
      posthog.init(
        providerKey,
        {
          ...providerOptions,
          ...QUIET,
          api_host: providerHost,
          disable_external_dependency_loading: false,
          // Last, so nothing above can stand in for the provider's own value.
          disable_session_recording: providerOptions.disable_session_recording,
        },
        's22_replay_provider',
      );
      posthog.init(
        controlKey,
        {
          ...providerOptions,
          ...QUIET,
          api_host: controlHost,
          disable_external_dependency_loading: false,
          disable_session_recording: false,
        },
        's22_replay_control',
      );

      await vi.waitFor(() => expect(scripts.some(recorderFrom(controlHost))).toBe(true));
      expect(scripts.filter(recorderFrom(providerHost)).map((script) => script.src)).toEqual([]);
    } finally {
      restore();
      forget();
    }
  });
});
