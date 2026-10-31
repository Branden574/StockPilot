import { render } from '@testing-library/react';
import posthog, { type BeforeSendFn, type PostHogConfig } from 'posthog-js';
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

/** The provider's before_send, after a hook that keeps every event it is handed. */
function beforeSendKeeping(seen: unknown[]): BeforeSendFn[] {
  const own = providerOptions.before_send;
  const keep: BeforeSendFn = (event) => {
    seen.push(event);
    return event;
  };
  return [keep, ...(Array.isArray(own) ? own : own ? [own] : [])];
}

/**
 * The bodies of the requests sent to a path on a host, since the last
 * mockClear. A batch sent as the page goes away is base64 form data (data=...).
 */
function sentTo(host: string, path: string): unknown[] {
  return fetchStub.mock.calls
    .filter(([url]) => String(url).startsWith(`${host}${path}`))
    .map(([, init]) => {
      const body = String(init?.body);
      return JSON.parse(
        body.startsWith('data=')
          ? Buffer.from(decodeURIComponent(body.slice('data='.length)), 'base64').toString('utf8')
          : body,
      ) as unknown;
    });
}

/**
 * Runs one of the SDK's own extension scripts, of the installed version (the
 * file PostHog serves under /static/<version>/), and tells each waiting
 * script tag that it loaded.
 */
async function serveExtension(
  scripts: readonly HTMLScriptElement[],
  kind: 'logs' | 'conversations',
): Promise<void> {
  if (kind === 'logs') await import('posthog-js/dist/logs.js');
  else await import('posthog-js/dist/conversations.js');
  for (const script of scripts) {
    if (script.src.includes(`/static/`) && script.src.includes(`/${kind}.js`)) {
      script.onload?.call(script, new Event('load'));
    }
  }
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

  // Docket S28. Console log capture (PostHog's Logs product) sends its records
  // to /i/v1/logs itself, never through capture(), and stamps each with the
  // page address after its own hook has run.
  it('sends no console log record, even when the project turns console log capture on', async () => {
    onSignInFromInvite();
    const providerKey = 'phc_placeholder_logs_provider';
    const controlKey = 'phc_placeholder_logs_control';
    const providerHost = 'https://logs-provider.ingest.example.invalid';
    const controlHost = 'https://logs-control.ingest.example.invalid';
    const line = 'placeholder console line';
    const providerSaw: unknown[] = [];
    const controlSaw: unknown[] = [];

    const forget = projectSays([providerKey, controlKey], { logs: { captureConsoleLogs: true } });
    // Kept out of the test output, and given back after: the SDK wraps the
    // console's methods for as long as the page lives.
    const consoleMethods = (['debug', 'log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(window.console, level).mockImplementation(() => {}),
    );
    const { scripts, restore } = interceptScripts();
    try {
      const provider = posthog.init(
        providerKey,
        {
          ...providerOptions,
          ...QUIET,
          api_host: providerHost,
          disable_external_dependency_loading: false,
          before_send: beforeSendKeeping(providerSaw),
          logs: providerOptions.logs,
        },
        's28_logs_provider',
      );
      const control = posthog.init(
        controlKey,
        {
          ...providerOptions,
          ...QUIET,
          api_host: controlHost,
          disable_external_dependency_loading: false,
          before_send: beforeSendKeeping(controlSaw),
          logs: undefined,
        },
        's28_logs_control',
      );
      // Both ask for the logs script: no client option refuses the project's
      // console capture.
      await vi.waitFor(() =>
        expect(scripts.some((script) => script.src.startsWith(`${controlHost}/static/`))).toBe(
          true,
        ),
      );
      await serveExtension(scripts, 'logs');

      fetchStub.mockClear();
      window.console.info(line);
      provider.capture('s28_probe');
      control.capture('s28_probe');
      // What either holds goes out when the page goes away.
      window.dispatchEvent(new Event('onpagehide' in window ? 'pagehide' : 'unload'));

      // The control: the line goes out with the page address in url.full, token
      // and all, and its before_send, which saw the probe event, never saw it.
      await vi.waitFor(() => expect(sentTo(controlHost, '/i/v1/logs')).not.toEqual([]));
      const records = (
        sentTo(controlHost, '/i/v1/logs') as {
          resourceLogs: {
            scopeLogs: {
              logRecords: {
                body: { stringValue?: string };
                attributes: { key: string; value: { stringValue?: string } }[];
              }[];
            }[];
          }[];
        }[]
      ).flatMap((payload) =>
        payload.resourceLogs.flatMap((resource) =>
          resource.scopeLogs.flatMap((scope) => scope.logRecords),
        ),
      );
      const record = records.find((r) => r.body.stringValue?.includes(line));
      expect(record?.attributes.find((a) => a.key === 'url.full')?.value.stringValue).toBe(
        `${window.location.origin}/signin?redirect=/invite/${TOKEN}`,
      );
      expect(controlSaw.some((event) => (event as { event?: string }).event === 's28_probe')).toBe(
        true,
      );
      expect(JSON.stringify(controlSaw)).not.toContain(line);

      // The provider: nothing goes to the logs endpoint at all.
      expect(sentTo(providerHost, '/i/v1/logs')).toEqual([]);
      expect(providerSaw.some((event) => (event as { event?: string }).event === 's28_probe')).toBe(
        true,
      );
    } finally {
      restore();
      for (const method of consoleMethods) method.mockRestore();
      forget();
    }
  });

  // Docket S28. Conversations (PostHog's chat) posts a new ticket with the
  // page address in session_context.current_url, never through capture(). Its
  // script keeps one chat per page, the first to load, so the provider's
  // instance is checked before the control's loads it.
  it('sends no Conversations message, even when the project turns Conversations on', async () => {
    onSignInFromInvite();
    const providerKey = 'phc_placeholder_chat_provider';
    const controlKey = 'phc_placeholder_chat_control';
    const providerHost = 'https://chat-provider.ingest.example.invalid';
    const controlHost = 'https://chat-control.ingest.example.invalid';
    const message = 'placeholder chat message';
    const chatFrom = (host: string) => (script: HTMLScriptElement) =>
      script.src.startsWith(`${host}/static/`) && /\/conversations\.js/.test(script.src);
    const providerSaw: unknown[] = [];
    const controlSaw: unknown[] = [];

    const forget = projectSays([providerKey, controlKey], {
      conversations: { enabled: true, token: 'placeholder_conversations_token' },
    });
    const { scripts, restore } = interceptScripts();
    try {
      // The provider: the chat never loads, so a message goes nowhere.
      const provider = posthog.init(
        providerKey,
        {
          ...providerOptions,
          ...QUIET,
          api_host: providerHost,
          disable_external_dependency_loading: false,
          before_send: beforeSendKeeping(providerSaw),
          disable_conversations: providerOptions.disable_conversations,
        },
        's28_chat_provider',
      );
      expect(scripts.filter(chatFrom(providerHost)).map((script) => script.src)).toEqual([]);
      expect(provider.conversations?.getUnavailableReason()).toBe('disabled_by_config');
      fetchStub.mockClear();
      expect(await provider.conversations?.sendMessage(message)).toBeNull();
      expect(sentTo(providerHost, '/api/conversations/')).toEqual([]);
      expect(JSON.stringify(providerSaw)).not.toContain(message);

      // The control: the message goes out with the page address, token and all,
      // and its before_send, which saw the chat's own events, never saw it.
      const control = posthog.init(
        controlKey,
        {
          ...providerOptions,
          ...QUIET,
          api_host: controlHost,
          disable_external_dependency_loading: false,
          before_send: beforeSendKeeping(controlSaw),
          disable_conversations: false,
        },
        's28_chat_control',
      );
      await vi.waitFor(() => expect(scripts.some(chatFrom(controlHost))).toBe(true));
      await serveExtension(scripts, 'conversations');
      await vi.waitFor(() => expect(control.conversations?.isAvailable()).toBe(true));
      fetchStub.mockClear();
      await control.conversations?.sendMessage(message).catch(() => null);

      const sent = sentTo(controlHost, '/api/conversations/') as {
        message?: string;
        session_context?: { current_url?: string };
      }[];
      expect(sent).toHaveLength(1);
      expect(sent[0]?.message).toBe(message);
      expect(sent[0]?.session_context?.current_url).toBe(
        `${window.location.origin}/signin?redirect=/invite/${TOKEN}`,
      );
      expect(controlSaw.length).toBeGreaterThan(0);
      expect(JSON.stringify(controlSaw)).not.toContain(message);
    } finally {
      restore();
      forget();
    }
  });
});
